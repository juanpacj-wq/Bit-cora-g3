// Núcleo del scraper de carbón GEC32 (D-029 / E3). Extrae un día del SIS interno y lo
// persiste en bitacora.consumo_combustible aplicando la REGLA DE OWNERSHIP ("operador gana"):
// el SIS escribe un valor sombra (valor_sis) y solo pisa la cantidad real si la celda no fue
// editada por un humano. Una fila es SIS-owned ⇔
//   creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA).
// Cualquier otra combinación = humano-owned → el SIS NO toca cantidad/modificado_por, solo la
// sombra valor_sis. Tabla completa en _CONTEXTO-BASE.md.
//
// El sweeper horario (E4), el backfill (E7) y el scrape manual (D-061) consumen scrapeDia().
// El sondeo de la fecha de inicio vive en ./discover.js (D-061 / C3) y se importa SOLO desde ahí:
// ver la nota de compat más abajo.
//
// D-061: scrapeDia() dejó de ser "solo GEC32". `planta_id` es un parámetro (default 'GEC32', la
// única planta con SIS hoy) y `concurrencia` pide hasta 6 periodos en paralelo — el SIS tarda
// ~13 s por periodo, así que un día pasa de ~5,2 min a ~1,3 min con concurrencia=4. Sigue sin
// tocar GEC3 por defecto ni contratos cross-repo.

import sql from 'mssql';
import { fetchPeriod, periodoBounds, extraerCarbonValidado } from './sis-client.js';
import { fechaBogotaStr } from '../turno.js';
import * as dbBindings from '../../db.js';

// D-061 L11 (H55): acá vivía un re-export de compat del sondeo del backfill, puesto por L01 "para
// no romper" a quien lo importara de este módulo. Se retira, y el motivo es que dejó de ser compat:
// L10 le cambió el valor de retorno de `'YYYY-MM-DD' | null` a `{ fecha, motivo, sondeos }` (C3
// enmendado), así que el nombre viejo entregaba la forma nueva y un `if (!inicio) bail()` recibía un
// objeto SIEMPRE truthy — un backfill que arranca desde una fecha inventada, sin un solo error.
// Verificado antes de retirarlo: el único consumidor —el CLI `backfill-carbon-gec32.js`— ya importa
// de `./discover.js`, así que no había nada que romper y sí una trampa dormida que cerrar. Quien
// necesite el sondeo lo importa de su módulo, que es donde está documentado el contrato.

// Planta por DEFECTO — hoy la única con SIS (GEC3 no tiene). Ya no gobierna las escrituras: todas
// usan el `planta_id` que llega por parámetro; esta constante solo alimenta los defaults.
const PLANTA_ID = 'GEC32';
const TIMEOUT_MS = 30000; // corta el fetch si el SIS no responde (resiliencia del sweeper).

// Hora Bogotá (0..23) del instante dado — el periodo p cubre [p-1 .. p)h, así que con hora=H los
// periodos COMPLETADOS hoy son 1..H. Reusa el shift puro -5h de turno.js.
//
// D-060: H nunca vale 24 → el P24 (23:00→00:00) de un día SOLO es legible cuando ya es "mañana".
// Por eso el día en curso jamás llega a 24/24 y quien debe completarlo es la repesca de "ayer"
// del sweeper (sis-sweeper.js), no este horizonte. No "arreglar" esto sumando 1.
function horaBogotaActual(d = new Date()) {
  const col = new Date(d.getTime() - 5 * 3600 * 1000);
  return col.getUTCHours();
}

// Resumen previo de (planta, fecha) en sis_scrape_log, o null si nunca se scrapeó ese día.
export async function leerScrapeLog(pool, fecha, planta_id = PLANTA_ID) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('f', sql.Date, fecha)
    .query(`SELECT periodos_ok, periodos_error, ultimo_periodo, completo
            FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`);
  return r.recordset[0] ?? null;
}

// ¿El log previo cubre 1..(periodoDesde-1) sin huecos? Solo entonces es válido scrapear a partir
// de periodoDesde y acumular sobre lo ya persistido. Un log con errores o con ultimo_periodo
// distinto no garantiza contigüidad → el llamador cae a 1 (auto-sanador).
export function logContiguoHasta(row, periodoDesde) {
  if (periodoDesde <= 1) return true;
  if (!row) return false;
  return Number(row.periodos_error) === 0 && Number(row.ultimo_periodo) === periodoDesde - 1;
}

// Resuelve el id del usuario SISTEMA: prefiere el live binding de db.js (server en marcha);
// si no está inicializado (p.ej. test que corre el scraper en su propio proceso), lo consulta.
async function resolverSistemaId(pool) {
  if (dbBindings.USUARIO_SISTEMA_ID) return dbBindings.USUARIO_SISTEMA_ID;
  const r = await pool.request().query(
    `SELECT usuario_id FROM lov_bit.usuario WHERE username = 'SISTEMA'`
  );
  const id = r.recordset[0]?.usuario_id ?? null;
  if (!id) throw new Error('carbon-scraper: usuario SISTEMA no existe (F16.A3 no aplicado)');
  return id;
}

// Mapa { k: { id, max } } para las 8 tolvas (ALIM_1..ALIM_8) de la planta pedida. Tolva k → ALIM_k.
// AUD-14: incluye `cantidad_max` (D-034) para validar el valor del SIS contra el tope físico
// antes de escribirlo (paridad con el límite que el POST humano ya aplica). `max=null` = sin tope.
//
// D-061: es además el guard de "esta planta no tiene SIS", y por eso corre ANTES del primer fetch.
// Matchea por `LIKE 'ALIM[_]%'` + el sufijo NUMÉRICO del código (NO por la columna `orden`, que no
// interviene): GEC3 usa ALIM_A..ALIM_F, así que no entra ninguno y la corrida se corta acá.
// Descubrirlo después de los fetch serían ~5 min de red tirados y un sis_scrape_log que afirma
// haber leído un día de una planta donde no se escribió una sola celda.
async function resolverAlimMap(pool, plantaId) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), plantaId)
    .query(`SELECT combustible_id, codigo, cantidad_max FROM lov_bit.combustible
            WHERE planta_id = @p AND codigo LIKE 'ALIM[_]%'`);
  const map = {};
  for (const row of r.recordset) {
    const m = /^ALIM_(\d+)$/.exec(row.codigo);
    if (m) map[Number(m[1])] = { id: row.combustible_id, max: row.cantidad_max ?? null };
  }
  for (let k = 1; k <= 8; k++) {
    if (!map[k]) throw new Error(`scrapeDia: planta sin catálogo ALIM_1..8: ${plantaId}`);
  }
  return map;
}

// SIS-owned ⇔ creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA).
function esSisOwned(row, sistemaId) {
  if (!row) return false;
  return row.creado_por === sistemaId &&
    (row.modificado_por === null || row.modificado_por === sistemaId);
}

// Aplica la tabla de ownership a UNA celda dentro de una transacción abierta. Devuelve el
// tipo de escritura para el conteo del resumen: 'insert' | 'update' | 'delete' | 'skip'.
async function aplicarCelda(tx, { plantaId, fecha, periodo, combustibleId, valorSis, sistemaId }) {
  const existente = (await new sql.Request(tx)
    .input('p', sql.VarChar(10), plantaId)
    .input('f', sql.Date, fecha)
    .input('per', sql.TinyInt, periodo)
    .input('cid', sql.Int, combustibleId)
    .query(`
      SELECT consumo_id, cantidad, creado_por, modificado_por
      FROM bitacora.consumo_combustible
      WHERE planta_id=@p AND fecha=@f AND periodo=@per AND combustible_id=@cid
    `)).recordset[0];

  const sisOwned = esSisOwned(existente, sistemaId);

  if (valorSis > 0) {
    if (!existente) {
      // >0, no existe → INSERT (cantidad = sombra, creado_por = SISTEMA).
      await new sql.Request(tx)
        .input('p', sql.VarChar(10), plantaId)
        .input('f', sql.Date, fecha)
        .input('per', sql.TinyInt, periodo)
        .input('cid', sql.Int, combustibleId)
        .input('cant', sql.Decimal(12, 3), valorSis)
        .input('vsis', sql.Decimal(12, 3), valorSis)
        .input('u', sql.Int, sistemaId)
        .query(`
          INSERT INTO bitacora.consumo_combustible
            (planta_id, fecha, periodo, combustible_id, cantidad, creado_por,
             valor_sis, sis_actualizado_en)
          VALUES (@p, @f, @per, @cid, @cant, @u, @vsis, SYSUTCDATETIME())
        `);
      return 'insert';
    }
    if (sisOwned) {
      // >0, SIS-owned → UPDATE cantidad + sombra (sigue SIS-owned: modificado_por = SISTEMA).
      await new sql.Request(tx)
        .input('id', sql.Int, existente.consumo_id)
        .input('cant', sql.Decimal(12, 3), valorSis)
        .input('vsis', sql.Decimal(12, 3), valorSis)
        .input('u', sql.Int, sistemaId)
        .query(`
          UPDATE bitacora.consumo_combustible
          SET cantidad=@cant, valor_sis=@vsis, sis_actualizado_en=SYSUTCDATETIME(),
              modificado_por=@u, modificado_en=SYSUTCDATETIME()
          WHERE consumo_id=@id
        `);
      return 'update';
    }
    // >0, humano-owned → SOLO sombra (no toca cantidad ni modificado_por: operador gana).
    await new sql.Request(tx)
      .input('id', sql.Int, existente.consumo_id)
      .input('vsis', sql.Decimal(12, 3), valorSis)
      .query(`
        UPDATE bitacora.consumo_combustible
        SET valor_sis=@vsis, sis_actualizado_en=SYSUTCDATETIME()
        WHERE consumo_id=@id
      `);
    return 'update';
  }

  // valorSis === 0
  if (!existente) return 'skip';            // =0, no existe → nada.
  if (sisOwned) {
    // =0, SIS-owned → DELETE (el SIS había creado la fila y ahora dice 0).
    // AUD-14 FOLLOW-UP (no abordado en esta ronda): un MITM que reporte enServicio=false o
    // tolvas 0 borra filas SIS-owned sin rastro humano. Pendiente: umbral/confirmación o
    // tombstone (valor_sis=0 sin DELETE) antes de eliminar. No se cambia la lógica aquí aún.
    await new sql.Request(tx)
      .input('id', sql.Int, existente.consumo_id)
      .query(`DELETE FROM bitacora.consumo_combustible WHERE consumo_id=@id`);
    return 'delete';
  }
  // =0, humano-owned → solo sombra a 0 (no toca cantidad/modificado_por).
  await new sql.Request(tx)
    .input('id', sql.Int, existente.consumo_id)
    .query(`
      UPDATE bitacora.consumo_combustible
      SET valor_sis=0, sis_actualizado_en=SYSUTCDATETIME()
      WHERE consumo_id=@id
    `);
  return 'update';
}

// Upsert del resumen del scrape en bitacora.sis_scrape_log (UNIQUE planta_id, fecha).
// IF EXISTS UPDATE ELSE INSERT dentro de la misma transacción → la fila refleja siempre el
// ÚLTIMO scrape de ese (planta, fecha), que es lo que el backfill consulta para resumir.
async function upsertScrapeLog(tx, { plantaId, fecha, scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo }) {
  await new sql.Request(tx)
    .input('p', sql.VarChar(10), plantaId)
    .input('f', sql.Date, fecha)
    .input('tipo', sql.VarChar(20), scrape_tipo)
    .input('ok', sql.TinyInt, periodos_ok)
    .input('err', sql.TinyInt, periodos_error)
    .input('ult', sql.TinyInt, ultimo_periodo)
    .input('comp', sql.Bit, completo ? 1 : 0)
    .query(`
      IF EXISTS (SELECT 1 FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f)
        UPDATE bitacora.sis_scrape_log
        SET scrape_tipo=@tipo, periodos_ok=@ok, periodos_error=@err,
            ultimo_periodo=@ult, completo=@comp, scraped_en=SYSUTCDATETIME()
        WHERE planta_id=@p AND fecha=@f;
      ELSE
        INSERT INTO bitacora.sis_scrape_log
          (planta_id, fecha, scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo)
        VALUES (@p, @f, @tipo, @ok, @err, @ult, @comp);
    `);
}

// Ejecuta `fn` sobre `items` con un tope de `tope` llamadas en vuelo a la vez y devuelve los
// resultados EN EL ORDEN DE `items` (resultados[i] ⇔ items[i]), no en el orden en que terminaron.
// Es un pool de workers que se reparten un índice compartido; sin dependencias ni timers.
// `fn` NO debe lanzar: un rechazo cortaría a su worker y dejaría el resto del pool a medias, así
// que el llamador captura por ítem y devuelve un centinela.
async function mapaConTope(items, tope, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(tope, items.length));
  await Promise.all(Array.from({ length: n }, () => trabajador()));
  return resultados;
}

// Extrae un día completo de una planta y lo persiste con la regla de ownership.
//   fecha:        'YYYY-MM-DD' (día Bogotá).
//   planta_id:    planta destino (default 'GEC32'). Debe tener catálogo ALIM_1..8; si no, lanza
//                 antes de pedirle nada al SIS.
//   scrape_tipo:  'horario' | 'backfill' | 'manual' (CHECK en sis_scrape_log).
//   soloHoy:      si fecha === hoy Bogotá, limita a los periodos ya completados (1..horaActual).
//                 Para días pasados siempre 1..24. Con soloHoy=false fuerza 1..24 incluso hoy.
//   periodoDesde: primer periodo a pedir (default 1). >1 solo se honra si sis_scrape_log ya cubre
//                 1..periodoDesde-1 sin errores (logContiguoHasta); si no, cae a 1. Permite completar
//                 solo lo que falta (típicamente el P24 de ayer: 1 fetch en vez de 24). D-060.
//   concurrencia: cuántos periodos se le piden al SIS a la vez (entero 1..6; default 1 = secuencial,
//                 idéntico al comportamiento previo). Solo afecta la fase de red: la escritura
//                 sigue siendo una sola transacción, en orden de periodo ascendente.
//   ahora:        reloj inyectable (tests) del que salen "hoy" y la hora Bogotá.
//   fetchFn:      inyección de dependencia para tests (default: fetchPeriod real con timeout).
//   log:          logger opcional (default: console.log con prefijo).
// Devuelve { fecha, periodos_ok, periodos_error, creados, actualizados, eliminados, completo }.
//
// Semántica del log (D-060): `completo` ⇔ el día tiene sus 24 periodos sin errores. NUNCA significa
// "completo hasta la hora actual": para el día en curso con soloHoy queda siempre 0, y así el
// sweeper sabe que aún debe repescarlo mañana (P24). `periodos_ok`/`ultimo_periodo` acumulan lo
// previo cuando se scrapea desde periodoDesde>1.
export async function scrapeDia(pool, {
  fecha,
  planta_id = PLANTA_ID,
  scrape_tipo = 'horario',
  soloHoy = true,
  periodoDesde = 1,
  concurrencia = 1,
  ahora = () => new Date(),
  fetchFn = (f1, h1, f2, h2) => fetchPeriod(f1, h1, f2, h2, { timeoutMs: TIMEOUT_MS }),
  log = (...a) => console.log('[sis-scraper]', ...a),
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    throw new Error(`scrapeDia: fecha inválida (YYYY-MM-DD): ${fecha}`);
  }
  const instante = ahora();
  const hoy = fechaBogotaStr(instante);
  if (fecha > hoy) throw new Error(`scrapeDia: fecha futura no permitida: ${fecha}`);
  if (!Number.isInteger(periodoDesde) || periodoDesde < 1 || periodoDesde > 24) {
    throw new Error(`scrapeDia: periodoDesde fuera de rango 1..24: ${periodoDesde}`);
  }
  // Tope duro en 6: más paralelismo no acelera (el cuello es el SIS) y sí lo castiga.
  if (!Number.isInteger(concurrencia) || concurrencia < 1 || concurrencia > 6) {
    throw new Error(`scrapeDia: concurrencia fuera de rango 1..6: ${concurrencia}`);
  }

  // Cuántos periodos esperamos. Hoy: solo los completados (1..horaActual). Pasado: 24.
  const nEsperado = (fecha === hoy && soloHoy) ? horaBogotaActual(instante) : 24;

  // Desde dónde. Un arranque parcial solo vale si lo previo es contiguo; si no, día completo.
  let desde = periodoDesde;
  if (desde > 1) {
    const previo = await leerScrapeLog(pool, fecha, planta_id);
    if (!logContiguoHasta(previo, desde)) {
      log(`log previo de ${fecha} no cubre 1..${desde - 1} de forma contigua → scrape completo`);
      desde = 1;
    }
  }

  const sistemaId = await resolverSistemaId(pool);
  // ANTES de cualquier fetch: sin catálogo ALIM_1..8 esta planta no tiene dónde escribir (C1).
  const alimMap = await resolverAlimMap(pool, planta_id);

  // 1) FETCH (sin transacción — es red). Un fetch fallido cuenta error y NO aborta el día.
  // Con concurrencia>1 los periodos salen en paralelo con tope, pero las lecturas se ORDENAN por
  // periodo antes de escribir: ni el orden de escritura ni `ultimo_periodo` pueden depender de en
  // qué orden contestó el SIS — si dependieran, dos corridas idénticas dejarían resultados
  // distintos y el "≡ concurrencia=1" del contrato sería falso.
  const periodos = [];
  for (let periodo = desde; periodo <= nEsperado; periodo++) periodos.push(periodo);

  const salidas = await mapaConTope(periodos, concurrencia, async (periodo) => {
    try {
      const { f1, h1, f2, h2 } = periodoBounds(fecha, periodo);
      const parsed = await fetchFn(f1, h1, f2, h2);
      const { tolvasVal } = extraerCarbonValidado(parsed.lastRow);
      return { periodo, tolvasVal };
    } catch (err) {
      log(`fetch falló ${fecha} p${periodo}: ${err.message}`);
      return null; // centinela: periodo con error. Cuenta y NO aborta el día.
    }
  });

  const lecturas = salidas.filter(Boolean).sort((a, b) => a.periodo - b.periodo);
  const periodos_ok = lecturas.length;
  const periodos_error = salidas.length - periodos_ok;
  const ultimoOk = periodos_ok ? lecturas[periodos_ok - 1].periodo : null;

  // Resumen acumulado: lo previo (1..desde-1, ya verificado contiguo) + lo de esta corrida.
  // `completo` ⇔ 24/24 sin errores (D-060). Nunca depende de nEsperado ni de la hora actual.
  const ultimo_periodo = ultimoOk ?? (desde > 1 ? desde - 1 : null);
  const periodos_ok_total = (desde - 1) + periodos_ok;
  const completo = periodos_error === 0 && ultimo_periodo === 24;

  // 2) WRITE (una transacción para todo el día + el log → rollback ante cualquier error).
  let creados = 0, actualizados = 0, eliminados = 0;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const { periodo, tolvasVal } of lecturas) {
      for (let k = 1; k <= 8; k++) {
        const { id: combustibleId, max } = alimMap[k];
        let valorSis = tolvasVal[k - 1];
        // AUD-14: defensa en profundidad antes de tocar la BD. extraerCarbonValidado ya entrega
        // finito y ≥0, pero NO confiamos: un valor no finito/negativo se descarta (no se escribe
        // esa celda) y uno por encima del tope físico (D-034) se clampa a cantidad_max. Así el
        // scraper NUNCA evade la regla de negocio ni mete Infinity/NaN en Decimal(12,3).
        if (!Number.isFinite(valorSis) || valorSis < 0) {
          log(`valor inválido descartado ${fecha} p${periodo} ALIM_${k}: ${valorSis}`);
          continue;
        }
        if (max != null && valorSis > max) {
          log(`valor excede cantidad_max(${max}) ${fecha} p${periodo} ALIM_${k}: ${valorSis} → clamp`);
          valorSis = Number(max);
        }
        const accion = await aplicarCelda(tx, {
          plantaId: planta_id, fecha, periodo, combustibleId, valorSis, sistemaId,
        });
        if (accion === 'insert') creados++;
        else if (accion === 'update') actualizados++;
        else if (accion === 'delete') eliminados++;
      }
    }
    await upsertScrapeLog(tx, {
      plantaId: planta_id, fecha, scrape_tipo, periodos_ok: periodos_ok_total, periodos_error,
      ultimo_periodo, completo,
    });
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }

  const resumen = {
    fecha, periodos_ok: periodos_ok_total, periodos_error, ultimo_periodo,
    desde, creados, actualizados, eliminados, completo,
  };
  log(`día ${fecha} · ${planta_id} (${scrape_tipo}):`, JSON.stringify(resumen));
  return resumen;
}
