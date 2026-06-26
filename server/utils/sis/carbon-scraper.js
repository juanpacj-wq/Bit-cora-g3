// Núcleo del scraper de carbón GEC32 (D-029 / E3). Extrae un día del SIS interno y lo
// persiste en bitacora.consumo_combustible aplicando la REGLA DE OWNERSHIP ("operador gana"):
// el SIS escribe un valor sombra (valor_sis) y solo pisa la cantidad real si la celda no fue
// editada por un humano. Una fila es SIS-owned ⇔
//   creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA).
// Cualquier otra combinación = humano-owned → el SIS NO toca cantidad/modificado_por, solo la
// sombra valor_sis. Tabla completa en _CONTEXTO-BASE.md.
//
// El sweeper horario (E4) y el backfill (E7) consumen scrapeDia(). discoverEarliestDate() es
// el sondeo para el backfill; su heurística se CALIBRA en E7 (acá queda parametrizable).
// Solo GEC32. No toca GEC3 ni contratos cross-repo.

import sql from 'mssql';
import { fetchPeriod, periodoBounds, extraerCarbonValidado } from './sis-client.js';
import { fechaBogotaStr } from '../turno.js';
import * as dbBindings from '../../db.js';

const PLANTA_ID = 'GEC32';
const TIMEOUT_MS = 30000; // corta el fetch si el SIS no responde (resiliencia del sweeper).

// Hora Bogotá actual (0..23) — el periodo p cubre [p-1 .. p)h, así que con hora=H los
// periodos COMPLETADOS hoy son 1..H. Reusa el shift puro -5h de turno.js.
function horaBogotaActual() {
  const d = new Date();
  const col = new Date(d.getTime() - 5 * 3600 * 1000);
  return col.getUTCHours();
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

// Mapa { k: combustible_id } para las 8 tolvas (ALIM_1..ALIM_8) de GEC32. Tolva k → ALIM_k.
async function resolverAlimMap(pool) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT combustible_id, codigo FROM lov_bit.combustible
            WHERE planta_id = @p AND codigo LIKE 'ALIM[_]%'`);
  const map = {};
  for (const row of r.recordset) {
    const m = /^ALIM_(\d+)$/.exec(row.codigo);
    if (m) map[Number(m[1])] = row.combustible_id;
  }
  for (let k = 1; k <= 8; k++) {
    if (!map[k]) throw new Error(`carbon-scraper: falta combustible ALIM_${k} en GEC32`);
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
async function aplicarCelda(tx, { fecha, periodo, combustibleId, valorSis, sistemaId }) {
  const existente = (await new sql.Request(tx)
    .input('p', sql.VarChar(10), PLANTA_ID)
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
        .input('p', sql.VarChar(10), PLANTA_ID)
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
async function upsertScrapeLog(tx, { fecha, scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo }) {
  await new sql.Request(tx)
    .input('p', sql.VarChar(10), PLANTA_ID)
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

// Extrae un día completo de GEC32 y lo persiste con la regla de ownership.
//   fecha:        'YYYY-MM-DD' (día Bogotá).
//   scrape_tipo:  'horario' | 'backfill' | 'manual' (CHECK en sis_scrape_log).
//   soloHoy:      si fecha === hoy Bogotá, limita a los periodos ya completados (1..horaActual).
//                 Para días pasados siempre 1..24. Con soloHoy=false fuerza 1..24 incluso hoy.
//   fetchFn:      inyección de dependencia para tests (default: fetchPeriod real con timeout).
//   log:          logger opcional (default: console.log con prefijo).
// Devuelve { fecha, periodos_ok, periodos_error, creados, actualizados, eliminados, completo }.
export async function scrapeDia(pool, {
  fecha,
  scrape_tipo = 'horario',
  soloHoy = true,
  fetchFn = (f1, h1, f2, h2) => fetchPeriod(f1, h1, f2, h2, { timeoutMs: TIMEOUT_MS }),
  log = (...a) => console.log('[sis-scraper]', ...a),
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    throw new Error(`scrapeDia: fecha inválida (YYYY-MM-DD): ${fecha}`);
  }
  const hoy = fechaBogotaStr(new Date());
  if (fecha > hoy) throw new Error(`scrapeDia: fecha futura no permitida: ${fecha}`);

  // Cuántos periodos esperamos. Hoy: solo los completados (1..horaActual). Pasado: 24.
  const nEsperado = (fecha === hoy && soloHoy) ? horaBogotaActual() : 24;

  const sistemaId = await resolverSistemaId(pool);
  const alimMap = await resolverAlimMap(pool);

  // 1) FETCH (sin transacción — es red). Un fetch fallido cuenta error y NO aborta el día.
  const lecturas = []; // { periodo, tolvasVal } solo de periodos OK
  let periodos_ok = 0, periodos_error = 0, ultimoOk = null;
  for (let periodo = 1; periodo <= nEsperado; periodo++) {
    try {
      const { f1, h1, f2, h2 } = periodoBounds(fecha, periodo);
      const parsed = await fetchFn(f1, h1, f2, h2);
      const { tolvasVal } = extraerCarbonValidado(parsed.lastRow);
      lecturas.push({ periodo, tolvasVal });
      periodos_ok++;
      ultimoOk = periodo;
    } catch (err) {
      periodos_error++;
      log(`fetch falló ${fecha} p${periodo}: ${err.message}`);
    }
  }

  const completo = periodos_error === 0 && ultimoOk === nEsperado && nEsperado > 0;

  // 2) WRITE (una transacción para todo el día + el log → rollback ante cualquier error).
  let creados = 0, actualizados = 0, eliminados = 0;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const { periodo, tolvasVal } of lecturas) {
      for (let k = 1; k <= 8; k++) {
        const accion = await aplicarCelda(tx, {
          fecha, periodo, combustibleId: alimMap[k],
          valorSis: tolvasVal[k - 1], sistemaId,
        });
        if (accion === 'insert') creados++;
        else if (accion === 'update') actualizados++;
        else if (accion === 'delete') eliminados++;
      }
    }
    await upsertScrapeLog(tx, {
      fecha, scrape_tipo, periodos_ok, periodos_error,
      ultimo_periodo: ultimoOk, completo,
    });
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }

  const resumen = { fecha, periodos_ok, periodos_error, creados, actualizados, eliminados, completo };
  log(`día ${fecha} (${scrape_tipo}):`, JSON.stringify(resumen));
  return resumen;
}

// Sondea el SIS hacia atrás para hallar la PRIMERA fecha con datos de GEC32 (la unidad existía
// / reportó sensores ese día). Estrategia coarse→fine: (1) retrocede año a año desde un techo
// hasta encontrar un año SIN datos, (2) búsqueda binaria por día entre el último día CON datos
// conocido y el primer día SIN datos. "Hay datos" ⇔ fetch OK y algún sensor de servicio o
// energía != 0 en el periodo de sondeo.
//
// HEURÍSTICA PENDIENTE DE CALIBRACIÓN EN E7 con sondeos reales: los umbrales (periodoProbe,
// maxYearsBack, techo) quedan parametrizables y todo el recorrido logueado para ajustarlos.
export async function discoverEarliestDate(pool, {
  hint = null,               // 'YYYY-MM-DD' fecha conocida con datos (acota la búsqueda).
  periodoProbe = 12,         // periodo medio del día a sondear (mediodía).
  techo = fechaBogotaStr(new Date()), // fecha tope (no se sondea más reciente que esto).
  maxYearsBack = 10,         // límite duro de retroceso para no colgar el sondeo.
  fetchFn = (f1, h1, f2, h2) => fetchPeriod(f1, h1, f2, h2, { timeoutMs: TIMEOUT_MS }),
  log = (...a) => console.log('[sis-discover]', ...a),
} = {}) {
  const sondear = async (fecha) => {
    try {
      const { f1, h1, f2, h2 } = periodoBounds(fecha, periodoProbe);
      const parsed = await fetchFn(f1, h1, f2, h2);
      const { lastRow, ncols } = parsed;
      if (!lastRow || (ncols !== undefined && ncols < 12)) return false;
      const v = extraerCarbonValidado(lastRow);
      const algunSensor = v.energiaMw > 0 || v.tolvasVal.some((t) => t > 0) || v.enServicio;
      return algunSensor;
    } catch (err) {
      log(`sondeo ${fecha} falló: ${err.message}`);
      return false;
    }
  };

  const addDays = (fecha, n) => {
    const d = new Date(fecha + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const diffDays = (a, b) => Math.round(
    (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000
  );

  // Ancla CON datos: el hint si lo dieron y verifica, si no el techo.
  let conDatos = null;
  if (hint && await sondear(hint)) conDatos = hint;
  if (!conDatos && await sondear(techo)) conDatos = techo;
  if (!conDatos) {
    log('ni hint ni techo tienen datos — no se puede anclar el sondeo');
    return null;
  }

  // (1) Coarse: retroceder año a año hasta un año SIN datos.
  let sinDatos = null;
  for (let y = 1; y <= maxYearsBack; y++) {
    const cand = addDays(conDatos, -365 * y);
    log(`coarse: probando ${cand} (-${y}a)`);
    if (await sondear(cand)) conDatos = cand;
    else { sinDatos = cand; break; }
  }
  if (!sinDatos) {
    log(`alcanzado maxYearsBack=${maxYearsBack}; earliest conocido = ${conDatos}`);
    return conDatos;
  }

  // (2) Fine: binaria por día entre sinDatos (excl.) y conDatos (incl.).
  while (diffDays(sinDatos, conDatos) > 1) {
    const mid = addDays(sinDatos, Math.floor(diffDays(sinDatos, conDatos) / 2));
    log(`fine: probando ${mid} (gap ${diffDays(sinDatos, conDatos)}d)`);
    if (await sondear(mid)) conDatos = mid;
    else sinDatos = mid;
  }
  log(`earliest con datos = ${conDatos}`);
  return conDatos;
}
