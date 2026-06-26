// Sweeper horario del scraper de carbón GEC32 (D-029 / E4). Cada hora re-scrapea el día de
// HOY (Bogotá) desde el SIS interno vía scrapeDia() y persiste con la regla de ownership.
//
// Resiliencia: un SIS inalcanzable NO debe romper el proceso. scrapeDia() ya tolera fetch
// fallidos por periodo (los cuenta como periodos_error y sigue); aquí además el tick entero
// va envuelto en try/catch y SIEMPRE reprograma en finally. Patrón idéntico a mand-sweeper.js
// (INTERVAL_MS, let timer, tick con try/catch + reprograma en finally, start/stop).
//
// Catchup al arranque: un primer tick ~10s después de iniciar (para no competir con el boot
// del server), que además re-scrapea AYER una vez si su sis_scrape_log no quedó completo.

import sql from 'mssql';
import { scrapeDia } from './carbon-scraper.js';
import { fechaBogotaStr } from '../turno.js';

const INTERVAL_MS = 3_600_000; // 1 hora.
const CATCHUP_MS = 10_000;     // primer tick poco después del arranque.
const PLANTA_ID = 'GEC32';

let timer = null;
let primerTick = true;

function hoyBogota() {
  return fechaBogotaStr(new Date());
}

// 'YYYY-MM-DD' menos 1 día (UTC-safe).
function ayerBogotaDe(fechaStr) {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ¿El sis_scrape_log de (GEC32, fecha) quedó incompleto (o no existe)? → vale la pena re-scrapear.
async function ayerIncompleto(pool, fecha) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('f', sql.Date, fecha)
    .query(`SELECT completo FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`);
  const row = r.recordset[0];
  return !row || row.completo === false || row.completo === 0;
}

export function startSisSweeper(pool) {
  if (timer) return;
  console.log('[sis-sweeper] iniciado');

  const tick = async () => {
    try {
      const hoy = hoyBogota();

      // Catchup de AYER al primer tick: solo si su log no quedó completo (evita re-trabajo).
      if (primerTick) {
        const ayer = ayerBogotaDe(hoy);
        try {
          if (await ayerIncompleto(pool, ayer)) {
            const r = await scrapeDia(pool, { fecha: ayer, scrape_tipo: 'horario', soloHoy: false });
            console.log(`[sis-sweeper] catchup ayer ${ayer}: ${JSON.stringify(r)}`);
          }
        } catch (err) {
          console.error('[sis-sweeper] catchup ayer', err.message);
        }
        primerTick = false;
      }

      const r = await scrapeDia(pool, { fecha: hoy, scrape_tipo: 'horario' });
      console.log(`[sis-sweeper] hoy ${hoy}: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[sis-sweeper]', err.message);
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, CATCHUP_MS);
}

export function stopSisSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  primerTick = true;
}
