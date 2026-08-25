// Sweeper horario del scraper de carbón GEC32 (D-029 / E4, corregido en D-060). Cada hora
// (a HH:02 Bogotá) completa AYER si le falta algo y re-scrapea el día de HOY (Bogotá) desde el SIS
// interno vía scrapeDia(), persistiendo con la regla de ownership.
//
// Por qué "ayer" en CADA tick (D-060): el periodo 24 de un día (23:00→00:00) solo es legible cuando
// ya es el día siguiente, y en ese momento "hoy" es otro. Antes la repesca de ayer corría solo en el
// primer tick tras un reinicio y gateada por `completo`, que el horizonte de "hoy" dejaba en 1 con
// ultimo_periodo=23 → el P24 nunca se pedía (41 días sin P24 en prod). Ahora: si el log de ayer no
// dice 24/24, se completa desde ultimo_periodo+1 (normalmente 1 solo fetch a las 00:02).
//
// Resiliencia: un SIS inalcanzable NO debe romper el proceso. scrapeDia() ya tolera fetch
// fallidos por periodo (los cuenta como periodos_error y sigue); aquí además cada bloque va envuelto
// en try/catch y el tick SIEMPRE reprograma en finally. Patrón de mand-sweeper.js (let timer,
// tick con try/catch + reprograma en finally, start/stop), salvo que el próximo tick se alinea a la
// hora de pared (msHastaProximaMarca) en vez de un intervalo fijo que deriva.

import { scrapeDia, leerScrapeLog } from './carbon-scraper.js';
import { necesitaCatchup, periodoDesdeDe, msHastaProximaMarca } from './sis-sweeper-helpers.js';
import { fechaBogotaStr } from '../turno.js';

export { necesitaCatchup, periodoDesdeDe, msHastaProximaMarca } from './sis-sweeper-helpers.js';

const CATCHUP_MS = 10_000;     // primer tick poco después del arranque.

let timer = null;

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

export function startSisSweeper(pool) {
  if (timer) return;
  console.log('[sis-sweeper] iniciado');

  const tick = async () => {
    try {
      const hoy = hoyBogota();
      const ayer = ayerBogotaDe(hoy);

      // 1) AYER: completar lo que falte (P24 tras medianoche; o más si hubo reinicio/errores).
      try {
        const logAyer = await leerScrapeLog(pool, ayer);
        if (necesitaCatchup(logAyer)) {
          const r = await scrapeDia(pool, {
            fecha: ayer, scrape_tipo: 'horario', soloHoy: false, periodoDesde: periodoDesdeDe(logAyer),
          });
          console.log(`[sis-sweeper] catchup ayer ${ayer}: ${JSON.stringify(r)}`);
        }
      } catch (err) {
        console.error('[sis-sweeper] catchup ayer', err.message);
      }

      // 2) HOY: periodos ya cerrados (1..hora actual).
      const r = await scrapeDia(pool, { fecha: hoy, scrape_tipo: 'horario' });
      console.log(`[sis-sweeper] hoy ${hoy}: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[sis-sweeper]', err.message);
    } finally {
      timer = setTimeout(tick, msHastaProximaMarca(new Date()));
    }
  };

  timer = setTimeout(tick, CATCHUP_MS);
}

export function stopSisSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
