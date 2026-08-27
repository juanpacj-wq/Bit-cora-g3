// Job de scrape manual del SIS (D-061 / C9). UN solo trabajo a la vez, en memoria del proceso.
//
// Por qué es asíncrono: un día son 24 periodos y el SIS tarda ~13 s por periodo (medido
// 2026-08-26), así que un solo día son ~5 min. nginx corta a los 60 s y el navegador mucho antes:
// un endpoint que esperara al scrape devolvería 504 SIEMPRE, con el trabajo igual corriendo por
// detrás y sin forma de saber cómo le fue. Por eso POST /sis/scrape responde 202 con el estado
// inicial y quien quiera seguirlo consulta GET /sis/estado.
//
// Mutex: la corrida entera va bajo withSisLock (sis-lock.js). El tick horario del sweeper y este
// job son dos caminos del MISMO proceso que le piden el mismo día al SIS y escriben las mismas
// celdas de consumo_combustible y la misma fila de sis_scrape_log. El que llegue segundo NO espera
// (409 acá, tick omitido allá): encolar convertiría un 409 honesto en un request colgado minutos.
//
// Lo que este módulo NO garantiza:
//   - **No persiste.** Un restart del backend borra el job: `estadoScrapeJob()` vuelve a `null`
//     aunque el scrape haya terminado bien. La verdad persistente de qué se scrapeó y cómo salió
//     es `bitacora.sis_scrape_log` (una fila por planta+fecha), NO este estado en memoria.
//   - **No es un histórico:** solo vive el ÚLTIMO job. Arrancar otro pisa el anterior ya terminado.
//   - **Es de PROCESO:** con varias instancias del backend cada una tendría su job y su lock, igual
//     que sis-lock.js. Hoy hay una sola (despliegue unificado), así que alcanza.

import { scrapeDia } from './carbon-scraper.js';
import { estadoSisLock, withSisLock } from './sis-lock.js';
import { fechaBogotaStr } from '../turno.js';
import { mensajeUsuario } from '../errores.js';

// Estado del módulo: el único job (o null si nunca corrió ninguno) + un contador para los ids.
// La secuencia NO se reinicia en los tests a propósito: dos jobs con el mismo reloj inyectado
// tendrían el mismo id si dependiera solo de la hora.
let job = null;
let secuencia = 0;

// Tope de seguridad de la iteración por si alguien llama sin validar el rango (el endpoint ya
// corta en 31 días). Sin él, un `to` mal formado podría dar una lista interminable.
const MAX_DIAS_GUARDA = 366;

// 'YYYY-MM-DD' + 1 día con aritmética UTC pura (convención de TZ: nunca hora local del proceso).
function sumarDia(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

// Días del rango [from, to] inclusive. La comparación lexicográfica vale porque ambos vienen en
// YYYY-MM-DD con padding.
function listarDias(from, to) {
  const dias = [];
  let cur = from;
  for (let i = 0; cur <= to && i < MAX_DIAS_GUARDA; i++) {
    dias.push(cur);
    cur = sumarDia(cur);
  }
  return dias;
}

// Texto de error apto para viajar en el cuerpo de GET /sis/estado.
// Los errores de DOMINIO (los lanza el propio scraper o el mutex) son textos nuestros, sin
// internals, y son justo lo que hay que leer para entender qué pasó. Cualquier otro —típicamente
// de la BD— pasa por el saneador central: nunca `err.message` crudo hacia el cliente (D-032).
// El detalle técnico completo se loguea server-side en el llamador.
function textoError(err) {
  const msg = String(err?.message || '');
  if (err?.codigo || /^scrapeDia:/.test(msg)) return msg;
  return mensajeUsuario(err);
}

// Copia defensiva del estado (mismo criterio que estadoSisLock): quien la lea no puede mutar el
// job en curso, y el snapshot que devolvió el 202 no cambia bajo los pies de quien lo serializa.
function snapshot(j) {
  if (!j) return null;
  return {
    id: j.id,
    estado: j.estado,
    planta_id: j.planta_id,
    from: j.from,
    to: j.to,
    dias_total: j.dias_total,
    dias_hechos: j.dias_hechos,
    dia_actual: j.dia_actual,
    iniciado_en: j.iniciado_en,
    terminado_en: j.terminado_en,
    iniciado_por: { ...j.iniciado_por },
    resultados: j.resultados.map((r) => ({ ...r })),
    error: j.error,
  };
}

// Corre el rango día por día. NUNCA lanza por un día fallido: lo anota en resultados[].error y
// sigue con el siguiente — un rango de 20 días no puede perderse porque el tercero reventó.
async function correrDias(j, { pool, dias, hoy, scrapeFn, log }) {
  for (const fecha of dias) {
    j.dia_actual = fecha;
    try {
      // soloHoy solo para el día en curso: de un día pasado siempre se piden los 24 periodos.
      const r = await scrapeFn(pool, {
        fecha,
        planta_id: j.planta_id,
        scrape_tipo: 'manual',
        soloHoy: fecha === hoy,
        concurrencia: 1,
      });
      const resumen = {
        fecha,
        periodos_ok: Number(r?.periodos_ok ?? 0),
        periodos_error: Number(r?.periodos_error ?? 0),
        completo: !!r?.completo,
        creados: Number(r?.creados ?? 0),
        actualizados: Number(r?.actualizados ?? 0),
        eliminados: Number(r?.eliminados ?? 0),
      };
      j.resultados.push(resumen);
      log(`día ${fecha} · ${j.planta_id}: ${JSON.stringify(resumen)}`);
    } catch (err) {
      j.resultados.push({
        fecha,
        periodos_ok: 0,
        periodos_error: 0,
        completo: false,
        creados: 0,
        actualizados: 0,
        eliminados: 0,
        error: textoError(err),
      });
      console.error(`[sis-job] día ${fecha} falló:`, err);
    }
    j.dias_hechos++;
  }
}

/**
 * Arranca el scrape manual de [from, to] sobre `planta_id` y devuelve el estado INICIAL del job.
 * No espera al trabajo: vuelve apenas lo lanzó (el llamador responde 202 con esto).
 *
 * Lanza `Error` con `.codigo='scrape_en_curso'` si ya hay un job en curso o si el mutex del SIS
 * está tomado por otro (el sweeper). El llamador lo traduce a 409.
 */
export function iniciarScrapeJob({
  pool,
  planta_id,
  from,
  to,
  usuario,
  scrapeFn = scrapeDia,
  ahora = () => new Date(),
  log = (...a) => console.log('[sis-job]', ...a),
} = {}) {
  const enCurso = job !== null && job.estado === 'en_curso';
  const lock = estadoSisLock();
  if (enCurso || lock.ocupado) {
    const err = new Error(enCurso
      ? `scrape_en_curso: ya hay un scrape manual de ${job.from}..${job.to} en curso`
      : `scrape_en_curso: el SIS está ocupado (${lock.motivo})`);
    err.codigo = 'scrape_en_curso';
    throw err;
  }

  const instante = ahora();
  const dias = listarDias(from, to);
  const hoy = fechaBogotaStr(instante);

  job = {
    id: `sis-${instante.getTime().toString(36)}-${++secuencia}`,
    estado: 'en_curso',
    planta_id,
    from,
    to,
    dias_total: dias.length,
    dias_hechos: 0,
    dia_actual: null,
    iniciado_en: instante.toISOString(),
    terminado_en: null,
    iniciado_por: {
      usuario_id: usuario?.usuario_id ?? null,
      nombre_completo: usuario?.nombre_completo ?? null,
    },
    resultados: [],
    error: null,
  };
  // Referencia estable: si alguien arranca otro job cuando este termine, el cierre de abajo debe
  // marcar EL SUYO, no el que quedó en la variable del módulo.
  const actual = job;

  log(`inicio ${actual.id} · ${planta_id} ${from}..${to} (${dias.length} día(s))`);

  // SIN await a propósito: acá está la asincronía del contrato C7 (202 y no 504).
  // El lock se toma de forma SÍNCRONA dentro de esta llamada (withSisLock marca `ocupado` antes de
  // su primer await), así que cuando esta función retorna ya no hay ventana para que el tick del
  // sweeper se cuele entre la validación de arriba y la toma del mutex.
  withSisLock(`scrape manual ${from}..${to}`, () => correrDias(actual, { pool, dias, hoy, scrapeFn, log }))
    .then(() => { actual.estado = 'terminado'; })
    .catch((err) => {
      // correrDias captura por día, así que acá solo caen fallas ANTES del primer día (el mutex
      // tomado en una carrera). Si alcanzó a hacer días, el job igual terminó: lo que no se pudo
      // hacer ya quedó anotado en resultados[].
      actual.estado = actual.resultados.length > 0 ? 'terminado' : 'error';
      actual.error = textoError(err);
      console.error(`[sis-job] ${actual.id} abortado:`, err);
    })
    .finally(() => {
      actual.dia_actual = null;
      actual.terminado_en = ahora().toISOString();
      log(`fin ${actual.id} · ${actual.estado} · ${actual.dias_hechos}/${actual.dias_total} día(s)`);
    });

  return snapshot(actual);
}

// Foto del último job (o null si el proceso nunca corrió ninguno).
export function estadoScrapeJob() {
  return snapshot(job);
}

// Solo para tests: olvida el job. Producción nunca lo llama.
export function _resetScrapeJobParaTests() {
  job = null;
}
