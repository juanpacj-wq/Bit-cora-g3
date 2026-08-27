#!/usr/bin/env node
// CLI de backfill/reparación del carbón GEC32 desde el SIS (D-029 E7 reducido, motivado por D-060;
// paralelizado y con descubrimiento de la fecha de inicio en D-061 / C10).
//
// Recorre un rango de días y COMPLETA los que sis_scrape_log no da por cerrados (completo=1 y
// ultimo_periodo=24), pidiendo al SIS solo los periodos que faltan (ultimo_periodo+1..24) salvo
// --full. Reutiliza scrapeDia (regla de ownership: nunca pisa celdas editadas por un humano).
//
// Uso (desde Bit-cora-g3/server, con acceso HTTP al SIS 192.168.18.201 y a la BD):
//   node --env-file=../.env scripts/backfill-carbon-gec32.js --confirm-db PortalG3_dev [--from YYYY-MM-DD]
//        [--to YYYY-MM-DD] [--dry-run] [--full] [--solo-parciales] [--throttle-ms 1500]
//        [--concurrencia 1..6] [--log RUTA]
//   --solo-parciales: salta los días SIN fila en sis_scrape_log (el backend no corría ese día; llenarlos
//   cuesta 24 fetch/día) y completa solo los que ya tienen datos parciales — la pasada rápida del P24.
//   --from auto: sondea el SIS con discoverEarliestDate, imprime "fecha de inicio = YYYY-MM-DD" y
//   SALE CON CÓDIGO 3 salvo que venga --confirm-from con esa misma fecha. El sondeo cuesta decenas
//   de fetch de ~13 s: es una calibración, no algo para poner en un cron.
//   --concurrencia N: cuántos periodos se le piden al SIS a la vez (1..6, default 1). Solo acelera la
//   RED; la escritura del día sigue siendo una transacción y cuesta ~12 s contra dev pase lo que pase.
//   OJO: con N>1 un periodo intermedio fallido deja el día no reanudable por ultimo_periodo, así que
//   la siguiente pasada vuelve a pedirlo completo (resumible igual, solo más caro).
//   --confirm-from YYYY-MM-DD: con --from auto es lo que habilita la escritura; con un --from
//   explícito es un doble chequeo (repetir la corrida larga sin volver a pagar el sondeo).
//   --log RUTA: además de stdout, va apilando cada línea en ese archivo (para corridas largas en
//   background; se crea el directorio si falta).
//   Para prod: DB_NAME=PortalG3 node --env-file=../.env scripts/backfill-carbon-gec32.js --confirm-db PortalG3 ...
//   (la variable del entorno prevalece sobre --env-file; DB_NAME_PROD del .env NO la lee nadie).
//
// Guardrails: --confirm-db debe coincidir con process.env.DB_NAME (evita correr contra la BD
// equivocada); --to por defecto es hoy-2 y nunca puede ser >= hoy (ayer lo completa el sweeper a
// las 00:02 y así no competimos con su tick). Resumible: re-ejecutar salta lo ya cerrado.

import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sql from 'mssql';
import { getDB } from '../db.js';
import { scrapeDia, leerScrapeLog } from '../utils/sis/carbon-scraper.js';
import { discoverEarliestDate } from '../utils/sis/discover.js';
import { necesitaCatchup, periodoDesdeDe } from '../utils/sis/sis-sweeper-helpers.js';
import { fechaBogotaStr } from '../utils/turno.js';

const PLANTA_ID = 'GEC32'; // única planta con SIS; el CLI no la parametriza (el job manual sí, D-061 C7).
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const BACKOFF_MS = 15_000; // pausa tras un día fallido (hipo de red/BD/SIS) antes de seguir.

function addDays(fecha, n) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --log: toda línea va a stdout/stderr Y al archivo. appendFileSync por línea a propósito — una
// corrida de horas en background tiene que dejar rastro aunque el proceso muera de golpe.
let rutaLog = null;
function alArchivo(msg) {
  if (!rutaLog) return;
  try { appendFileSync(rutaLog, msg + '\n'); } catch { /* el log es auxiliar: no aborta la corrida */ }
}
function linea(msg) { process.stdout.write(msg + '\n'); alArchivo(msg); }
function lineaErr(msg) { process.stderr.write(msg + '\n'); alArchivo(msg); }

function salir(msg, code = 2) {
  lineaErr(`[backfill] ${msg}`);
  process.exit(code);
}

const { values: args } = parseArgs({
  options: {
    'confirm-db': { type: 'string' },
    from: { type: 'string' },
    'confirm-from': { type: 'string' },
    to: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'solo-parciales': { type: 'boolean', default: false },
    'throttle-ms': { type: 'string', default: '1500' },
    concurrencia: { type: 'string', default: '1' },
    log: { type: 'string' },
  },
  strict: true,
});

if (args.log !== undefined) {
  if (!args.log) salir('--log necesita una ruta.');
  const abs = resolve(args.log);
  try { mkdirSync(dirname(abs), { recursive: true }); } catch (err) { salir(`--log: no pude crear el directorio (${err.code ?? 'error'}).`); }
  rutaLog = abs;
  try { appendFileSync(rutaLog, ''); } catch (err) { salir(`--log: no pude escribir en ${abs} (${err.code ?? 'error'}).`); }
}

const dbName = process.env.DB_NAME || '';
if (!args['confirm-db'] || args['confirm-db'] !== dbName) {
  salir(`--confirm-db debe ser exactamente el DB_NAME activo ("${dbName}"). Recibido: "${args['confirm-db'] ?? ''}".`);
}
const throttleMs = Number(args['throttle-ms']);
if (!Number.isFinite(throttleMs) || throttleMs < 0) salir(`--throttle-ms inválido: ${args['throttle-ms']}`);

// Mismo tope que scrapeDia (C1): más paralelismo no acelera —el cuello es el SIS— y sí lo castiga.
const concurrencia = Number(args.concurrencia);
if (!Number.isInteger(concurrencia) || concurrencia < 1 || concurrencia > 6) {
  salir(`--concurrencia inválida (entero 1..6): ${args.concurrencia}`);
}
if (args['confirm-from'] !== undefined && !RE_FECHA.test(args['confirm-from'])) {
  salir(`--confirm-from inválido: ${args['confirm-from']}`);
}

const hoy = fechaBogotaStr(new Date());
const to = args.to ?? addDays(hoy, -2);
if (!RE_FECHA.test(to)) salir(`--to inválido: ${to}`);
if (to >= hoy) salir(`--to (${to}) debe ser anterior a hoy (${hoy}); ayer lo completa el sweeper.`);

// Conteo por año de las celdas de alimentador de la planta: el cierre de toda corrida y la forma
// más barata de ver hasta dónde llegó un backfill largo sin leer el log entero.
async function conteoPorAnio(pool) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT YEAR(cc.fecha) AS anio, COUNT(*) AS celdas, COUNT(DISTINCT cc.fecha) AS dias
            FROM bitacora.consumo_combustible cc
            JOIN lov_bit.combustible c ON c.combustible_id = cc.combustible_id
            WHERE cc.planta_id = @p AND c.tipo = 'ALIMENTADOR'
            GROUP BY YEAR(cc.fecha) ORDER BY 1`);
  return r.recordset;
}

const pool = await getDB();
let salida = 0;
try {
  let from = args.from;

  if (from === 'auto') {
    // Ancla del sondeo: el día más antiguo que ya scrapeamos (si lo hay) tiene datos por definición.
    const h = await pool.request()
      .input('p', sql.VarChar(10), PLANTA_ID)
      .query(`SELECT CONVERT(varchar(10), MIN(fecha), 120) AS f FROM bitacora.sis_scrape_log WHERE planta_id=@p`);
    const hint = h.recordset[0]?.f ?? null;
    linea(`[backfill] --from auto: sondeando el SIS (techo=${to}${hint ? `, hint=${hint}` : ''}). Esto tarda varios minutos.`);
    const inicio = await discoverEarliestDate(pool, {
      hint, techo: to, log: (...a) => linea(`[sis-discover] ${a.join(' ')}`),
    });
    if (!inicio) salir('el sondeo no encontró ninguna fecha con datos (ni el hint ni el techo respondieron).');
    linea(`[backfill] fecha de inicio = ${inicio}`);
    if (args['confirm-from'] !== inicio) {
      lineaErr(`[backfill] no escribo nada: para correr el backfill desde esa fecha repite el comando con --from auto --confirm-from ${inicio}`);
      salida = 3;
    } else {
      from = inicio;
    }
  } else if (args['confirm-from'] !== undefined && args['confirm-from'] !== from) {
    // Con --from explícito, --confirm-from actúa de doble chequeo (útil para repetir la corrida
    // larga sin volver a pagar los ~15 min del sondeo): si no coinciden, alguien se equivocó.
    salir(`--confirm-from (${args['confirm-from']}) no coincide con --from (${from ?? 'sin valor'}).`);
  }

  if (salida === 0) {
    if (!from) {
      const r = await pool.request()
        .input('p', sql.VarChar(10), PLANTA_ID)
        .query(`SELECT CONVERT(varchar(10), MIN(fecha), 120) AS f FROM bitacora.sis_scrape_log WHERE planta_id=@p`);
      from = r.recordset[0]?.f ?? null;
      if (!from) salir('sis_scrape_log no tiene días de GEC32; pasa --from explícito.');
    }
    if (!RE_FECHA.test(from)) salir(`--from inválido: ${from}`);
    if (from > to) salir(`--from (${from}) es posterior a --to (${to}).`);

    linea(`[backfill] BD=${dbName} rango=${from}..${to} dry-run=${args['dry-run']} full=${args.full} ` +
      `solo-parciales=${args['solo-parciales']} throttle=${throttleMs}ms concurrencia=${concurrencia}`);

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
        const row = await leerScrapeLog(pool, fecha, PLANTA_ID);
        if (!args.full && !necesitaCatchup(row)) { tot.saltados++; continue; }
        if (!row && args['solo-parciales']) { tot.sinLog++; continue; }
        const periodoDesde = args.full ? 1 : periodoDesdeDe(row);
        const estado = row ? `ok=${row.periodos_ok} err=${row.periodos_error} ultimo=${row.ultimo_periodo ?? '-'} completo=${row.completo ? 1 : 0}` : 'sin log';
        if (args['dry-run']) {
          linea(`[backfill] ${fecha}: ${estado} → pediría periodos ${periodoDesde}..24`);
          tot.procesados++;
          continue;
        }
        const r = await scrapeDia(pool, {
          fecha, planta_id: PLANTA_ID, scrape_tipo: 'backfill', soloHoy: false, periodoDesde, concurrencia,
          log: (...a) => linea(`[backfill]   ${a.join(' ')}`),
        });
        tot.procesados++;
        tot.creados += r.creados; tot.actualizados += r.actualizados; tot.eliminados += r.eliminados;
        tot.errores += r.periodos_error;
        if (!r.completo) tot.incompletos.push(fecha);
        const pct = Math.round(100 * tot.dias / nDias);
        linea(`[backfill] ${fecha}: ${estado} → desde=${r.desde} ok=${r.periodos_ok} err=${r.periodos_error} ` +
          `ultimo=${r.ultimo_periodo} completo=${r.completo ? 1 : 0} +${r.creados}/~${r.actualizados}/-${r.eliminados} (${pct}%)`);
        if (r.periodos_error > 0) await dormir(BACKOFF_MS); // el SIS falló en algún periodo: respiro.
      } catch (err) {
        tot.errores++;
        tot.incompletos.push(fecha);
        lineaErr(`[backfill] ${fecha}: FALLÓ — ${err.message} (sigo en ${BACKOFF_MS / 1000}s)`);
        await dormir(BACKOFF_MS);
      }
      if (throttleMs > 0 && fecha < to) await dormir(throttleMs);
    }

    const seg = Math.round((Date.now() - t0) / 1000);
    linea(`[backfill] FIN en ${seg}s — días=${tot.dias} saltados(ya 24/24)=${tot.saltados} sin-log-omitidos=${tot.sinLog} procesados=${tot.procesados} ` +
      `creados=${tot.creados} actualizados=${tot.actualizados} eliminados=${tot.eliminados} errores=${tot.errores}`);
    if (tot.incompletos.length) linea(`[backfill] días que siguen incompletos: ${tot.incompletos.join(', ')}`);

    const porAnio = await conteoPorAnio(pool);
    const totalCeldas = porAnio.reduce((a, r) => a + r.celdas, 0);
    linea(`[backfill] conteo por año (celdas ALIM de ${PLANTA_ID}): total=${totalCeldas}`);
    for (const r of porAnio) linea(`[backfill]   ${r.anio}: ${r.celdas} celdas en ${r.dias} días`);
  }
} finally {
  await pool.close();
}
if (salida) process.exit(salida);
