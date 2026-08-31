#!/usr/bin/env node
// D-064 (L05) — Relleno del mes en curso para el asiento del despacho económico (RQ-05.14, CA-5).
//
// El barrido de `utils/despacho-xm/sweeper.js` asienta lo que va llegando de aquí en adelante, pero
// solo mira los últimos dos días. Este CLI es la pasada de una sola vez que deja el MES EN CURSO
// completo: recorre día por día y le pide el asiento a `crearAsientoDespacho` a los que les falta.
//
// ── Qué garantiza y qué NO ──────────────────────────────────────────────────────────────────────
// GARANTIZA que no duplica y que no pisa: el creador es idempotente por `campos_extra.clave_asiento`
// contra `registro_activo` Y `registro_historico` (contrato C3), así que un día ya asentado —incluso
// uno ya archivado por el cierre de turno— se reporta como "ya existía" y no se toca. Por eso el
// relleno es resumible: si se corta a mitad del mes, se vuelve a lanzar el MISMO comando completo.
//
// NO garantiza que el despacho de cada día haya llegado de verdad. Esa es la suposición de fondo y
// conviene decirla con todas las letras:
//
//   · La hora real de detección de los días ya pasados NUNCA se guardó. `#refreshTomorrow()` del
//     dashboard solo prendía un flag en memoria y logueaba; la tabla `dashboard.despacho_recibido`
//     existe recién desde D-064. Para esos días el relleno usa las **15:00 Bogotá** y marca la fila
//     con `hora_estimada: true` en `campos_extra`. Es una CONVENCIÓN, no una medición, y esa marca
//     es lo único que lo distingue después: no se pinta en el front y no cambia el texto del
//     asiento (CA-2 vale igual), así que quien tiene que notarlo es quien audita la BD y quien lee
//     esta salida — por eso el resumen lo dice día por día y en el total.
//   · RN-05.d dice que sin evidencia no se inventa un día, y el sweeper lo cumple al pie de la
//     letra: solo asienta el hecho que LEE. Este CLI, por defecto, hace algo distinto y deliberado:
//     asienta todos los días del mes hasta hoy, porque XM publica el despacho económico todos los
//     días —no solo hábiles— y porque la persona que lo corre sabe que su planta operó ese mes. La
//     evidencia acá la aporta esa persona, no la tabla, y por eso el asiento queda marcado como
//     estimado. Si prefieres la lectura estricta —solo lo que tiene fila en el dashboard— corre con
//     `--solo-con-hecho`: los días sin hecho se OMITEN y quedan sin renglón.
//   · Y al revés, que también muerde: la ausencia de una fila en `despacho_recibido` NO prueba que
//     el despacho no llegó (GATE-O1 §5, D2: hay una ventana conocida en la que el hecho se pierde).
//     No razones "no hay fila ⇒ no hubo despacho".
//
// Cuando SÍ hay hora real, gana la real: el día se asienta con la hora medida y
// `hora_estimada: false`. El relleno nunca inventa una hora para un día del que sí hay dato.
//
// ── El alcance es el mes en curso, y nada más ───────────────────────────────────────────────────
// Reconstruir meses anteriores está fuera de alcance (REQ-05 §7) y el CLI no lo parametriza a
// propósito: el rango sale del calendario, del 1 del mes hasta HOY (Bogotá). Ojo con el borde: el
// asiento del día 1 lleva `fecha_evento` del ÚLTIMO día del mes anterior —la detección ocurrió esa
// tarde— así que ese renglón sale en el libro F03 del mes ANTERIOR. Es correcto: el libro ordena por
// la hora de calendario del evento (D-058, gotcha (b)), no por el día que el despacho anuncia.
//
// ── Concurrencia con el barrido ─────────────────────────────────────────────────────────────────
// El sweeper revisa `[hoy-2, hoy+1]` cada 5 minutos, así que se solapa con los últimos días de este
// rango. `existeAsiento` corre dentro de la transacción del creador pero sin lock de rango, y son
// dos procesos distintos: si los dos pidieran la MISMA fecha en el mismo instante, el asiento podría
// salir duplicado (dos renglones idénticos en el libro — feo, recuperable). Es la sospecha 2 del
// cierre de L04 y no está reproducida. La vía barata para evitarla: correr esto con el servicio
// detenido, o con el sweeper apagado (`DESPACHO_XM_SWEEPER_ENABLED=0` en el unit systemd).
//
// ── Uso ─────────────────────────────────────────────────────────────────────────────────────────
// Desde `Bit-cora-g3/server`, con acceso a la BD:
//
//   Ensayo (no escribe una sola fila):
//     node --env-file=../.env scripts/relleno-asiento-despacho.js --confirm-db PortalG3_dev --dry-run
//   Dev, de verdad:
//     node --env-file=../.env scripts/relleno-asiento-despacho.js --confirm-db PortalG3_dev
//   Producción:
//     DB_NAME=PortalG3 node --env-file=../.env scripts/relleno-asiento-despacho.js --confirm-db PortalG3
//
//   La variable del entorno PREVALECE sobre la del `--env-file`, y `DB_NAME_PROD` del `.env` no la
//   lee nadie: es inerte (convención 35 de CLAUDE.md). Por eso prod se elige con `DB_NAME=PortalG3`
//   delante del comando y `--confirm-db` tiene que repetirlo exacto.
//
//   Opciones: `--dry-run` (reporta sin escribir) · `--solo-con-hecho` (lectura estricta de RN-05.d)
//   · `--log RUTA` (además de stdout, apila cada línea en un archivo).
//
// ── Guardrails ──────────────────────────────────────────────────────────────────────────────────
// `--confirm-db` es obligatorio y tiene que coincidir EXACTO con `process.env.DB_NAME`: es lo que
// evita rellenar un mes entero de asientos en la base equivocada. Se valida ANTES de abrir el pool.
// Un día que falle no se lleva por delante a los otros: se loguea y se sigue, como hace el tick.
//
// Y la lección de D-061 sobre los backfill: "terminado" NO es que el proceso salga con 0. Al cerrar,
// el CLI le vuelve a PREGUNTAR A LA BD qué días del mes tienen asiento —una consulta aparte, no el
// acumulador del bucle— y nombra los que falten. Ese es el número que hay que mirar.

import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { getDB } from '../db.js';
import { crearAsientoDespacho, PLANTAS_DESPACHO } from '../utils/despacho-xm/asiento.js';
import { leerDespachosRecibidos } from '../utils/despacho-xm/lector.js';
import {
  claveAsientoDespacho, esHoraEstimada, BITACORAS_ASIENTO_SISTEMA,
} from '../utils/asientos/sistema.js';
import { fechaBogotaStr } from '../utils/turno.js';

// La convención del relleno (RQ-05.14): 3 de la tarde, la hora a la que XM publica. Bogotá.
export const HORA_ESTIMADA_BOGOTA = 15;

// Colombia no tiene horario de verano, así que el offset es una constante y no una tabla.
const OFFSET_BOGOTA_H = 5;

const ISO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

// ── Piezas puras ────────────────────────────────────────────────────────────────────────────────

/**
 * Los días del mes de `hoy`, del 1 hasta `hoy` inclusive, como `'YYYY-MM-DD'`.
 * @param {string} hoy  día Bogotá, `'YYYY-MM-DD'`.
 * @throws {TypeError} si la fecha no tiene la forma, o si el día no existe en ese mes.
 *
 * Nunca devuelve un día futuro: el rango termina en `hoy`. El despacho de MAÑANA —que se detecta
 * hoy a las 15:00— es trabajo del sweeper, no del relleno.
 */
export function diasDelMesHasta(hoy) {
  const m = ISO_FECHA.exec(String(hoy ?? '').trim());
  if (!m) {
    throw new TypeError(`diasDelMesHasta: 'hoy' tiene que ser 'YYYY-MM-DD' (llegó ${JSON.stringify(hoy)})`);
  }
  const [, anio, mes, dia] = m;
  // Round-trip contra `Date.UTC`, igual que `utils/asientos/sistema.js`: la forma sola no alcanza,
  // porque `Date` rueda una fecha que no existe a otra sin avisar (`2026-02-30` → 2 de marzo).
  const d = new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia)));
  if (d.getUTCFullYear() !== Number(anio) || d.getUTCMonth() !== Number(mes) - 1
      || d.getUTCDate() !== Number(dia)) {
    throw new TypeError(`diasDelMesHasta: ${hoy} no es un día que exista`);
  }
  const dias = [];
  for (let i = 1; i <= Number(dia); i += 1) {
    dias.push(`${anio}-${mes}-${String(i).padStart(2, '0')}`);
  }
  return dias;
}

/**
 * El instante de detección que se le inventa a un día sin hora real: las 15:00 Bogotá del día
 * ANTERIOR, ya en UTC.
 *
 * El día anterior no es un detalle: el despacho del día D lo publica XM la tarde del día D-1, y eso
 * es lo que el renglón cuenta ("se recibe HOY el despacho de MAÑANA"). Fecharlo el mismo día D
 * pondría el asiento un día tarde en el libro.
 *
 * `Date.UTC` normaliza el día 0 al último del mes anterior, así que el día 1 del mes no necesita un
 * caso aparte. La suma de las 5 horas es la única conversión de zona de este archivo — la de los
 * días con hora REAL ya la hizo el lector (contrato C4) y no se vuelve a tocar.
 */
export function detectadoEnEstimado(fecha_despacho) {
  const m = ISO_FECHA.exec(String(fecha_despacho ?? '').trim());
  if (!m) {
    throw new TypeError(
      `detectadoEnEstimado: la fecha tiene que ser 'YYYY-MM-DD' (llegó ${JSON.stringify(fecha_despacho)})`,
    );
  }
  const [, anio, mes, dia] = m;
  return new Date(Date.UTC(
    Number(anio), Number(mes) - 1, Number(dia) - 1, HORA_ESTIMADA_BOGOTA + OFFSET_BOGOTA_H, 0, 0, 0,
  ));
}

// ── Lo que dice la BD ───────────────────────────────────────────────────────────────────────────

/**
 * Los asientos del mes que YA existen, mirando `registro_activo` y `registro_historico`.
 * @returns {Promise<Map<string, {hora_estimada: boolean}>>} indexado por `clave_asiento`.
 *
 * Es una consulta de SOLO LECTURA y es la que responde "¿quedó algún día sin asiento?" — la lección
 * de D-061: un backfill no está terminado porque el proceso salga con 0, sino porque la BD lo diga.
 *
 * El flag NO se interpreta en SQL: se trae crudo y lo normaliza `esHoraEstimada`, el mismo predicado
 * que usó el escritor (R5 del gate de la O1). Dos tablas de verdad para el mismo booleano es
 * exactamente el fallo que ese arreglo cerró.
 */
export async function clavesPresentes(pool, { mes, plantas = PLANTAS_DESPACHO } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(mes ?? ''))) {
    throw new TypeError(`clavesPresentes: 'mes' tiene que ser 'YYYY-MM' (llegó ${JSON.stringify(mes)})`);
  }
  const unidades = Array.isArray(plantas) ? plantas.filter(Boolean) : [];
  if (unidades.length === 0) throw new TypeError('clavesPresentes: `plantas` no puede quedar vacía');

  // Las plantas SÍ se bindean (son un parámetro, y en tests son las fixtures); los códigos de las
  // bitácoras se interpolan porque son la constante congelada de L02, no un dato de entrada.
  const req = pool.request().input('patron', sql.NVarChar(200), `DESPACHO_XM|${mes}-%`);
  const marcas = unidades.map((p, i) => {
    req.input(`p${i}`, sql.VarChar(10), p);
    return `@p${i}`;
  }).join(', ');
  const codigos = BITACORAS_ASIENTO_SISTEMA.map((c) => `'${c}'`).join(', ');

  // `ISJSON(...) = 1` antes de cada `JSON_VALUE`: en modo lax `JSON_VALUE` LANZA sobre un
  // `campos_extra` malformado (RequestError 13609) y no hay CHECK que lo impida — una sola fila
  // corrupta en cualquier parte de la tabla dejaría este reporte sin poder correr nunca.
  const r = await req.query(`
    SELECT DISTINCT
           JSON_VALUE(ra.campos_extra, '$.clave_asiento') AS clave,
           JSON_VALUE(ra.campos_extra, '$.hora_estimada') AS hora_estimada
    FROM bitacora.registro_activo ra
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
    WHERE b.codigo IN (${codigos}) AND ra.planta_id IN (${marcas})
      AND ra.campos_extra IS NOT NULL AND ISJSON(ra.campos_extra) = 1
      AND JSON_VALUE(ra.campos_extra, '$.clave_asiento') LIKE @patron
    UNION
    SELECT DISTINCT
           JSON_VALUE(rh.campos_extra, '$.clave_asiento') AS clave,
           JSON_VALUE(rh.campos_extra, '$.hora_estimada') AS hora_estimada
    FROM bitacora.registro_historico rh
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = rh.bitacora_id
    WHERE b.codigo IN (${codigos}) AND rh.planta_id IN (${marcas})
      AND rh.campos_extra IS NOT NULL AND ISJSON(rh.campos_extra) = 1
      AND JSON_VALUE(rh.campos_extra, '$.clave_asiento') LIKE @patron
  `);

  const presentes = new Map();
  for (const row of r.recordset) {
    if (!row.clave) continue;
    // `esHoraEstimada` espera el `campos_extra`, no el valor suelto: se le arma el objeto mínimo
    // para que la normalización sea la misma que aplicó el escritor.
    const estimada = esHoraEstimada({ hora_estimada: row.hora_estimada });
    // Si un día apareciera con las dos marcas (no debería: las 4 filas comparten `campos_extra`),
    // gana `true` — reportar de más que una hora es convención es el error barato.
    const previo = presentes.get(row.clave)?.hora_estimada ?? false;
    presentes.set(row.clave, { hora_estimada: estimada || previo });
  }
  return presentes;
}

/**
 * El estado del mes tal como lo ve la BD: qué días tienen asiento, cuáles no, y cuántos con hora
 * estimada. Es el cierre de toda corrida y lo que hay que mirar para decir "terminó".
 */
export async function verificarMes(pool, { hoy, plantas = PLANTAS_DESPACHO } = {}) {
  const dias = diasDelMesHasta(hoy);
  const mes = dias[0].slice(0, 7);
  const presentes = await clavesPresentes(pool, { mes, plantas });

  const faltantes = [];
  let estimados = 0;
  let reales = 0;
  for (const fecha of dias) {
    const hit = presentes.get(claveAsientoDespacho(fecha));
    if (!hit) { faltantes.push(fecha); continue; }
    if (hit.hora_estimada) estimados += 1; else reales += 1;
  }
  return { mes, dias: dias.length, con_asiento: dias.length - faltantes.length, faltantes, estimados, reales };
}

// ── El recorrido ────────────────────────────────────────────────────────────────────────────────

/**
 * Recorre el mes de `hoy` y crea los asientos que faltan.
 *
 * @param {object} opciones
 * @param {sql.ConnectionPool} opciones.pool
 * @param {string}   [opciones.hoy]       día Bogotá; por defecto el de ahora.
 * @param {string[]} [opciones.plantas]   inyectable SOLO para tests (D-061): sin esto la suite
 *   escribiría un mes entero de asientos en GEC3/GEC32, y corre sobre la BD productiva (D-030).
 * @param {boolean}  [opciones.dryRun]    reporta sin escribir una sola fila.
 * @param {boolean}  [opciones.soloConHecho]  omite los días sin fila en `despacho_recibido`.
 * @returns {Promise<object>} resumen del RECORRIDO (lo que hizo esta corrida). El estado del mes lo
 *   dice `verificarMes`, que es otra consulta: no se deduce de estos contadores.
 */
export async function ejecutarRelleno({
  pool,
  hoy = fechaBogotaStr(new Date()),
  plantas = PLANTAS_DESPACHO,
  dryRun = false,
  soloConHecho = false,
  leerFn = leerDespachosRecibidos,
  crearFn = crearAsientoDespacho,
  log = () => {},
  logError = log,
} = {}) {
  const dias = diasDelMesHasta(hoy);
  const mes = dias[0].slice(0, 7);

  // Las horas REALES que alcanzó a registrar el dashboard. El lector degrada a `[]` si la tabla no
  // existe (contrato C4) —que es el estado normal hasta que el otro repo se despliegue— así que
  // esto NUNCA lanza y el relleno sigue con la convención de las 15:00.
  const hechos = await leerFn(pool, { desde: dias[0], hasta: dias[dias.length - 1] });
  const horaReal = new Map(hechos.map((h) => [h.fecha_despacho, h.detectado_en]));

  // El estado ANTES de tocar nada. En `--dry-run` es la única fuente para decir qué habría pasado;
  // en la corrida real es solo informativo, porque quien decide de verdad es el creador, dentro de
  // su transacción.
  const yaEstaban = await clavesPresentes(pool, { mes, plantas });

  const resumen = {
    mes,
    hoy,
    dias: dias.length,
    dry_run: dryRun,
    solo_con_hecho: soloConHecho,
    hechos_leidos: hechos.length,
    creados: 0,
    creados_con_hora_real: 0,
    creados_con_hora_estimada: 0,
    existentes: 0,
    omitidos: 0,
    fallidos: 0,
    detalle: [],
  };

  for (const fecha of dias) {
    // TODO el día va dentro del try: los productores del asiento LANZAN ante una fecha imposible
    // (hecho 2 del GATE-O1) y la BD puede fallar a mitad de la transacción. En los dos casos se
    // salta ESE día y se sigue — una corrida de relleno nunca debe morir con un stack a mitad del
    // mes, y volver a lanzarla es gratis gracias a la idempotencia.
    try {
      const detectadoReal = horaReal.get(fecha) ?? null;
      const hora_estimada = detectadoReal === null;

      if (hora_estimada && soloConHecho) {
        resumen.omitidos += 1;
        resumen.detalle.push({ fecha, accion: 'omitido', motivo: 'sin hecho en dashboard.despacho_recibido' });
        log(`[relleno] ${fecha}: omitido — sin evidencia de llegada (--solo-con-hecho)`);
        continue;
      }

      const detectado_en = detectadoReal ?? detectadoEnEstimado(fecha);
      const fuente = hora_estimada ? `hora estimada ${HORA_ESTIMADA_BOGOTA}:00` : 'hora real';

      if (dryRun) {
        if (yaEstaban.has(claveAsientoDespacho(fecha))) {
          resumen.existentes += 1;
          resumen.detalle.push({ fecha, accion: 'ya_existe', hora_estimada });
          log(`[relleno] ${fecha}: ya existía — no lo tocaría`);
        } else {
          resumen.creados += 1;
          if (hora_estimada) resumen.creados_con_hora_estimada += 1; else resumen.creados_con_hora_real += 1;
          resumen.detalle.push({ fecha, accion: 'crearia', hora_estimada, detectado_en });
          log(`[relleno] ${fecha}: CREARÍA el asiento (${fuente}, detectado_en=${detectado_en.toISOString()})`);
        }
        continue;
      }

      const r = await crearFn(pool, { fecha_despacho: fecha, detectado_en, hora_estimada, plantas });
      if (r?.creado) {
        resumen.creados += 1;
        if (hora_estimada) resumen.creados_con_hora_estimada += 1; else resumen.creados_con_hora_real += 1;
        resumen.detalle.push({ fecha, accion: 'creado', hora_estimada, detectado_en, filas: r.filas });
        log(`[relleno] ${fecha}: creado (${r.filas} filas, ${fuente}, detectado_en=${detectado_en.toISOString()})`);
      } else {
        resumen.existentes += 1;
        resumen.detalle.push({ fecha, accion: 'ya_existe', motivo: r?.motivo ?? null });
        log(`[relleno] ${fecha}: ya existía — sin cambios`);
      }
    } catch (err) {
      resumen.fallidos += 1;
      resumen.detalle.push({ fecha, accion: 'fallido', error: err?.message ?? String(err) });
      logError(`[relleno] ${fecha}: FALLÓ — ${err?.message ?? err}`);
    }
  }

  return resumen;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

// `--log`: toda línea va a stdout/stderr Y al archivo, una por una. Igual que el backfill de D-061:
// una corrida en background tiene que dejar rastro aunque el proceso muera de golpe.
let rutaLog = null;
function alArchivo(msg) {
  if (!rutaLog) return;
  try { appendFileSync(rutaLog, msg + '\n'); } catch { /* el log es auxiliar: no aborta la corrida */ }
}
function linea(msg) { process.stdout.write(msg + '\n'); alArchivo(msg); }
function lineaErr(msg) { process.stderr.write(msg + '\n'); alArchivo(msg); }

function salir(msg, code = 2) {
  lineaErr(`[relleno] ${msg}`);
  process.exit(code);
}

const USO = 'Uso: node --env-file=../.env scripts/relleno-asiento-despacho.js --confirm-db <DB_NAME> '
  + '[--dry-run] [--solo-con-hecho] [--log RUTA]';

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        'confirm-db': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'solo-con-hecho': { type: 'boolean', default: false },
        log: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    salir(`${err.message}\n${USO}`);
  }

  if (args.log !== undefined) {
    if (!args.log) salir('--log necesita una ruta.');
    const abs = resolve(args.log);
    try { mkdirSync(dirname(abs), { recursive: true }); } catch (err) { salir(`--log: no pude crear el directorio (${err.code ?? 'error'}).`); }
    rutaLog = abs;
    try { appendFileSync(rutaLog, ''); } catch (err) { salir(`--log: no pude escribir en ${abs} (${err.code ?? 'error'}).`); }
  }

  // El guardrail va ANTES de abrir el pool: si la base es la equivocada, el proceso muere sin haber
  // tocado una sola conexión. Es lo que evita rellenar un mes entero donde no era.
  const dbName = process.env.DB_NAME || '';
  if (!args['confirm-db'] || args['confirm-db'] !== dbName) {
    salir(`--confirm-db debe ser exactamente el DB_NAME activo ("${dbName}"). Recibido: "${args['confirm-db'] ?? ''}".`);
  }

  const hoy = fechaBogotaStr(new Date());
  const pool = await getDB();
  try {
    linea(`[relleno] BD=${dbName} mes=${hoy.slice(0, 7)} hasta=${hoy} plantas=${PLANTAS_DESPACHO.join(',')} `
      + `dry-run=${args['dry-run']} solo-con-hecho=${args['solo-con-hecho']}`);

    const antes = await verificarMes(pool, { hoy });
    linea(`[relleno] antes: ${antes.con_asiento}/${antes.dias} días con asiento `
      + `(${antes.reales} con hora real, ${antes.estimados} con hora estimada)`);

    const r = await ejecutarRelleno({
      pool,
      hoy,
      dryRun: args['dry-run'],
      soloConHecho: args['solo-con-hecho'],
      log: linea,
      logError: lineaErr,
    });

    linea(`[relleno] FIN — días=${r.dias} creados=${r.creados} ya-existían=${r.existentes} `
      + `omitidos=${r.omitidos} fallidos=${r.fallidos} (hechos leídos del dashboard: ${r.hechos_leidos})`);
    if (r.creados_con_hora_estimada > 0) {
      linea(`[relleno] OJO: ${r.creados_con_hora_estimada} asiento(s) quedaron con HORA ESTIMADA `
        + `(${HORA_ESTIMADA_BOGOTA}:00 Bogotá, campos_extra.hora_estimada = true). No es una medición: `
        + 'es la convención de RQ-05.14 para los días cuya hora real nunca se guardó.');
    }

    // La verificación de cierre: se la preguntamos a la BD, no a los contadores de arriba. Es la
    // lección de D-061 — "terminado" se comprueba con una consulta, no con un exit 0.
    const despues = await verificarMes(pool, { hoy });
    linea(`[relleno] verificación (consultada a la BD): ${despues.con_asiento}/${despues.dias} días del mes `
      + `con asiento — ${despues.reales} con hora real, ${despues.estimados} con hora estimada`);
    if (despues.faltantes.length > 0) {
      linea(`[relleno] días del mes SIN asiento: ${despues.faltantes.join(', ')}`);
      if (!args['dry-run'] && !args['solo-con-hecho']) {
        lineaErr('[relleno] quedaron días sin asiento pese a no estar en modo ensayo: revisa los FALLÓ de arriba y vuelve a correr el mismo comando.');
        process.exitCode = 1;
      }
    } else {
      linea('[relleno] no queda ningún día del mes sin asiento.');
    }
  } finally {
    await pool.close();
  }
}

// Solo corre si lo invocaron como programa. Sin este guard, importarlo desde un test ejecutaría el
// CLI entero contra la BD — y el test necesita importarlo para poder inyectarle las plantas-fixture.
const esPrincipal = (() => {
  if (!process.argv[1]) return false;
  const invocado = resolve(process.argv[1]);
  const propio = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? invocado.toLowerCase() === propio.toLowerCase()
    : invocado === propio;
})();

if (esPrincipal) await main();
