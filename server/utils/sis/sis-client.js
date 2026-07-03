// Cliente SIS reutilizable (D-029 / E2). Replica buildUrl/fetchPeriod del scraper standalone
// (js-scraper-carbon-g32/scrape.js) en ESM, más helpers de límites de periodo y de validación
// de servicio. NO toca BD. El sweeper (E4) y el backfill (E7) consumen estas funciones.
//
// SIS interno sin auth en http://192.168.18.201 (override por process.env.SIS_HOST).
// Server NEWSYNCBASE. 12 tags en el MISMO orden que el scraper → definen lastRow[1..12]:
//   [1..8]  8 tolvas (alimentadores de carbón)
//   [9]     energía bruta (MW)
//   [10]    HBK10CT659_AVG  (sensor de servicio)
//   [11]    HBK10CT651_AVG  (sensor de servicio)
//   [12]    MPAFLOW         (flujo, sensor de servicio)

import { parseXlsIsolated } from "./parse-isolated.js"; // AUD-08: parseo en worker_thread aislado

// AUD-26 (BIT-AUDSEG-2026-001): SIS_HOST viene de env sin validar → un override malicioso podía
// apuntar el scraper a un destino arbitrario (SSRF), cuyos datos se escriben a la BD como SISTEMA.
// Allowlist: solo http(s) hacia un host INTERNO (loopback o rango privado RFC1918). Se valida al
// cargar el módulo (fail-fast ante misconfig) y se normaliza a origin (sin path).
function validarSisHost(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`SIS_HOST inválido (no es URL): ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`SIS_HOST: esquema no permitido (solo http/https): ${u.protocol}`);
  }
  const host = u.hostname;
  const interno =
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!interno) throw new Error(`SIS_HOST: host fuera del allowlist interno: ${host}`);
  return u.origin;
}

export const SIS_HOST = validarSisHost(process.env.SIS_HOST || "http://192.168.18.201");
export const SIS_SERVER = "NEWSYNCBASE";
export const TAGS = [
  "DCS_20HFY10FU013", "DCS_20HFY20FU013", "DCS_20HFY30FU013", "DCS_20HFY40FU013",
  "DCS_20HFY50FU013", "DCS_20HFY60FU013", "DCS_20HFY70FU013", "DCS_20HFY80FU013",
  "DCS_20CFE01CE21", "DCS_20HBK10CT659_AVG", "DCS_20HBK10CT651_AVG", "DCS_MPAFLOW",
];

// AUD-08/14: solo aceptamos números reales (finitos). `parseFloat("1e999")` → Infinity y
// `NaN` quedaban como "number" y se colaban a la BD; aquí se neutralizan a 0.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round3 = (x) => +x.toFixed(3);
// Tope de descarga del .xls (el real son pocos KB). Defensa adicional ante un cuerpo gigante.
const MAX_XLS_BYTES = 10 * 1024 * 1024;

// AUD-25: escape de entidades XML. Los params (f*/h*) se interpolan en el cuerpo XML; sin escape,
// un valor malicioso podría inyectar markup hacia el SIS. Hoy van saneados aguas arriba, pero
// `buildUrl` no debe confiar en el llamador.
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&apos;"
  );
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-4])$/; // 00..24

export function buildUrl(f1, h1, f2, h2) {
  // AUD-25: validar formato DENTRO de buildUrl (no confiar solo en periodoBounds/scrapeDia).
  for (const [k, v] of [["f1", f1], ["f2", f2]]) {
    if (!RE_FECHA.test(String(v))) throw new Error(`buildUrl: ${k} no es una fecha YYYY-MM-DD: ${v}`);
  }
  for (const [k, v] of [["h1", h1], ["h2", h2]]) {
    if (!RE_HORA.test(String(v))) throw new Error(`buildUrl: ${k} fuera de rango 00..24: ${v}`);
  }
  const srv = escapeXml(SIS_SERVER);
  const tags = TAGS.map((t) => `<tg n='${escapeXml(t)}'/>`).join("");
  const f1e = escapeXml(f1), h1e = escapeXml(h1), f2e = escapeXml(f2), h2e = escapeXml(h2);
  const params =
    `<Data><Action>GETDATASERIAL</Action><PROTOCOL><p><a>h</a>` +
    `<t1>${f1e} ${h1e}:00:00</t1><t2>${f2e} ${h2e}:00:00</t2>` +
    `<ts>1</ts><sis server='${srv}'>${tags}</sis></p></PROTOCOL>` +
    `<BTIME>${f1e} ${h1e}:00:00</BTIME><ETIME>${f2e} ${h2e}:00:00</ETIME><TS>1</TS></Data>`;
  return `${SIS_HOST}/SIS/SisMonitor/JsFrame/TagData/ExportDialog.aspx?params=` +
    encodeURIComponent(params);
}

// Dado fecha (YYYY-MM-DD) y periodo 1..24 devuelve los límites { f1, h1, f2, h2 } a consultar.
// Regla del scraper: h1 = periodo-1; para periodo<24, h2=periodo y mismo día; para periodo=24
// el fin cruza a las 00:00 del día siguiente. El cómputo del día siguiente es aritmética de
// fecha pura en UTC (sin TZ), robusto ante cambios de mes/año.
export function periodoBounds(fecha, periodo) {
  if (!Number.isInteger(periodo) || periodo < 1 || periodo > 24) {
    throw new Error(`periodo fuera de rango 1..24: ${periodo}`);
  }
  const h1 = String(periodo - 1).padStart(2, "0");
  let h2, f2;
  if (periodo === 24) {
    h2 = "00";
    const d = new Date(fecha + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    f2 = d.toISOString().slice(0, 10);
  } else {
    h2 = String(periodo).padStart(2, "0");
    f2 = fecha;
  }
  return { f1: fecha, h1, f2, h2 };
}

// Consulta el SIS para un periodo y devuelve el parseo del .xls.
// opts.signal: AbortSignal externo. opts.timeoutMs: si se da (y no hay signal), arma un
// AbortController interno para no colgar al sweeper si el SIS no responde.
export async function fetchPeriod(f1, h1, f2, h2, opts = {}) {
  let signal = opts.signal;
  let timer = null;
  if (!signal && opts.timeoutMs) {
    const ac = new AbortController();
    signal = ac.signal;
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  }
  try {
    // AUD-26: redirect:'error' → el scraper NO sigue 30x a otro destino (anti-SSRF).
    const fetchOpts = { redirect: "error" };
    if (signal) fetchOpts.signal = signal;
    const resp = await fetch(buildUrl(f1, h1, f2, h2), fetchOpts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // AUD-08: cortar temprano si Content-Length anuncia un cuerpo gigante.
    const cl = Number(resp.headers.get("content-length"));
    if (Number.isFinite(cl) && cl > MAX_XLS_BYTES) {
      throw new Error(`respuesta SIS demasiado grande: ${cl} bytes`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_XLS_BYTES) {
      throw new Error(`respuesta SIS demasiado grande: ${buf.length} bytes`);
    }
    const parsed = await parseXlsIsolated(buf); // AUD-08: fuera del event loop, con timeout + tope de heap
    return { status: resp.status, bytes: buf.length, ...parsed };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Aplica la validación de servicio sobre lastRow (1-indexado por columna del parser).
// enServicio = v659>400 && v651>400 && mpaflow>140. Guardamos el VALIDADO: cada tolva vale
// su lectura (redondeada a 3) solo si está en servicio y supera 0.5 t/h; si no, 0.
export function extraerCarbonValidado(lastRow) {
  const v659 = num(lastRow[10]);
  const v651 = num(lastRow[11]);
  const mpaflow = num(lastRow[12]);
  const enServicio = v659 > 400 && v651 > 400 && mpaflow > 140;
  const tolvasVal = [];
  for (let i = 0; i < 8; i++) {
    // AUD-14: `num` ya garantiza finito; el gate `>0.5` descarta además negativos/ruido. Las
    // tolvas validadas son por construcción finitas y ≥0 antes de tocar la BD.
    const raw = num(lastRow[i + 1]);
    tolvasVal.push(raw > 0.5 && enServicio ? round3(raw) : 0);
  }
  // AUD-14: energía nunca negativa ni no-finita (num → finito, Math.max → ≥0).
  const energiaMw = round3(Math.max(0, num(lastRow[9])));
  const totalCarbon = round3(tolvasVal.reduce((a, b) => a + b, 0));
  return { enServicio, tolvasVal, energiaMw, totalCarbon };
}
