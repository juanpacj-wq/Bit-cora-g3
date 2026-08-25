#!/usr/bin/env node
// CLI de backfill/reparación del carbón GEC32 desde el SIS (D-029 E7 reducido, motivado por D-060).
//
// Recorre un rango de días y COMPLETA los que sis_scrape_log no da por cerrados (completo=1 y
// ultimo_periodo=24), pidiendo al SIS solo los periodos que faltan (ultimo_periodo+1..24) salvo
// --full. Reutiliza scrapeDia (regla de ownership: nunca pisa celdas editadas por un humano).
//
// Uso (desde Bit-cora-g3/server, con acceso HTTP al SIS 192.168.18.201 y a la BD):
//   node --env-file=../.env scripts/backfill-carbon-gec32.js --confirm-db PortalG3_dev [--from YYYY-MM-DD]
//        [--to YYYY-MM-DD] [--dry-run] [--full] [--solo-parciales] [--throttle-ms 1500]
//   --solo-parciales: salta los días SIN fila en sis_scrape_log (el backend no corría ese día; llenarlos
//   cuesta 24 fetch/día) y completa solo los que ya tienen datos parciales — la pasada rápida del P24.
//   Para prod: DB_NAME=PortalG3 node --env-file=../.env scripts/backfill-carbon-gec32.js --confirm-db PortalG3 ...
//   (la variable del entorno prevalece sobre --env-file; DB_NAME_PROD del .env NO la lee nadie).
//
// Guardrails: --confirm-db debe coincidir con process.env.DB_NAME (evita correr contra la BD
// equivocada); --to por defecto es hoy-2 y nunca puede ser >= hoy (ayer lo completa el sweeper a
// las 00:02 y así no competimos con su tick). Resumible: re-ejecutar salta lo ya cerrado.

import { parseArgs } from 'node:util';
import { getDB } from '../db.js';
import { scrapeDia, leerScrapeLog } from '../utils/sis/carbon-scraper.js';
import { necesitaCatchup, periodoDesdeDe } from '../utils/sis/sis-sweeper-helpers.js';
import { fechaBogotaStr } from '../utils/turno.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const BACKOFF_MS = 15_000; // pausa tras un día fallido (hipo de red/BD/SIS) antes de seguir.

function addDays(fecha, n) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function salir(msg, code = 2) {
  console.error(`[backfill] ${msg}`);
  process.exit(code);
}

const { values: args } = parseArgs({
  options: {
    'confirm-db': { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'solo-parciales': { type: 'boolean', default: false },
    'throttle-ms': { type: 'string', default: '1500' },
  },
  strict: true,
});

const dbName = process.env.DB_NAME || '';
if (!args['confirm-db'] || args['confirm-db'] !== dbName) {
  salir(`--confirm-db debe ser exactamente el DB_NAME activo ("${dbName}"). Recibido: "${args['confirm-db'] ?? ''}".`);
}
const throttleMs = Number(args['throttle-ms']);
if (!Number.isFinite(throttleMs) || throttleMs < 0) salir(`--throttle-ms inválido: ${args['throttle-ms']}`);

const hoy = fechaBogotaStr(new Date());
const to = args.to ?? addDays(hoy, -2);
if (!RE_FECHA.test(to)) salir(`--to inválido: ${to}`);
if (to >= hoy) salir(`--to (${to}) debe ser anterior a hoy (${hoy}); ayer lo completa el sweeper.`);

const pool = await getDB();
try {
  let from = args.from;
  if (!from) {
    const r = await pool.request().query(
      `SELECT CONVERT(varchar(10), MIN(fecha), 120) AS f FROM bitacora.sis_scrape_log WHERE planta_id='GEC32'`
    );
    from = r.recordset[0]?.f ?? null;
    if (!from) salir('sis_scrape_log no tiene días de GEC32; pasa --from explícito.');
  }
  if (!RE_FECHA.test(from)) salir(`--from inválido: ${from}`);
  if (from > to) salir(`--from (${from}) es posterior a --to (${to}).`);

  console.log(`[backfill] BD=${dbName} rango=${from}..${to} dry-run=${args['dry-run']} full=${args.full} ` +
    `solo-parciales=${args['solo-parciales']} throttle=${throttleMs}ms`);

  const tot = { dias: 0, saltados: 0, sinLog: 0, procesados: 0, errores: 0, creados: 0, actualizados: 0, eliminados: 0, incompletos: [] };
  const t0 = Date.now();
  const dormir = (ms) => new Promise((res) => setTimeout(res, ms));
  const nDias = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  for (let fecha = from; fecha <= to; fecha = addDays(fecha, 1)) {
    tot.dias++;
    // TODO el día va dentro del try (también la lectura del log previo): un hipo de red/BD cuenta
    // el día como fallido y se sigue con el siguiente tras un backoff — la corrida es resumible,
    // nunca debe morir con un stack trace a mitad de un rango largo.
    try {
      const row = await leerScrapeLog(pool, fecha);
      if (!args.full && !necesitaCatchup(row)) { tot.saltados++; continue; }
      if (!row && args['solo-parciales']) { tot.sinLog++; continue; }
      const periodoDesde = args.full ? 1 : periodoDesdeDe(row);
      const estado = row ? `ok=${row.periodos_ok} err=${row.periodos_error} ultimo=${row.ultimo_periodo ?? '-'} completo=${row.completo ? 1 : 0}` : 'sin log';
      if (args['dry-run']) {
        console.log(`[backfill] ${fecha}: ${estado} → pediría periodos ${periodoDesde}..24`);
        tot.procesados++;
        continue;
      }
      const r = await scrapeDia(pool, {
        fecha, scrape_tipo: 'backfill', soloHoy: false, periodoDesde,
        log: (...a) => console.log('[backfill]  ', ...a),
      });
      tot.procesados++;
      tot.creados += r.creados; tot.actualizados += r.actualizados; tot.eliminados += r.eliminados;
      tot.errores += r.periodos_error;
      if (!r.completo) tot.incompletos.push(fecha);
      const pct = Math.round(100 * tot.dias / nDias);
      console.log(`[backfill] ${fecha}: ${estado} → desde=${r.desde} ok=${r.periodos_ok} err=${r.periodos_error} ` +
        `ultimo=${r.ultimo_periodo} completo=${r.completo ? 1 : 0} +${r.creados}/~${r.actualizados}/-${r.eliminados} (${pct}%)`);
      if (r.periodos_error > 0) await dormir(BACKOFF_MS); // el SIS falló en algún periodo: respiro.
    } catch (err) {
      tot.errores++;
      tot.incompletos.push(fecha);
      console.error(`[backfill] ${fecha}: FALLÓ — ${err.message} (sigo en ${BACKOFF_MS / 1000}s)`);
      await dormir(BACKOFF_MS);
    }
    if (throttleMs > 0 && fecha < to) await dormir(throttleMs);
  }

  const seg = Math.round((Date.now() - t0) / 1000);
  console.log(`[backfill] FIN en ${seg}s — días=${tot.dias} saltados(ya 24/24)=${tot.saltados} sin-log-omitidos=${tot.sinLog} procesados=${tot.procesados} ` +
    `creados=${tot.creados} actualizados=${tot.actualizados} eliminados=${tot.eliminados} errores=${tot.errores}`);
  if (tot.incompletos.length) console.log(`[backfill] días que siguen incompletos: ${tot.incompletos.join(', ')}`);
} finally {
  await pool.close();
}
