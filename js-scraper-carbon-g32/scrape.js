"use strict";

const path = require("path");
const { parseXls } = require("./xls");
const { writeXlsx } = require("./xlsx-write");

// AUD-17 (BIT-AUDSEG-2026-001): IP del SIS configurable por env (mirror de
// server/utils/sis/sis-client.js). Default conservado para no romper la corrida diaria.
const SIS_HOST = process.env.SIS_HOST || "http://192.168.18.201";
const SERVER = "NEWSYNCBASE";
const TAGS = [
  "DCS_20HFY10FU013", "DCS_20HFY20FU013", "DCS_20HFY30FU013", "DCS_20HFY40FU013",
  "DCS_20HFY50FU013", "DCS_20HFY60FU013", "DCS_20HFY70FU013", "DCS_20HFY80FU013",
  "DCS_20CFE01CE21", "DCS_20HBK10CT659_AVG", "DCS_20HBK10CT651_AVG", "DCS_MPAFLOW",
];

// AUD-25 (BIT-AUDSEG-2026-001): escape de entidades XML + validación de formato dentro de
// buildUrl (mirror de server/utils/sis/sis-client.js; mantener en sync).
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&apos;"
  );
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-4])$/; // 00..24

function buildUrl(f1, h1, f2, h2) {
  for (const [k, v] of [["f1", f1], ["f2", f2]]) {
    if (!RE_FECHA.test(String(v))) throw new Error(`buildUrl: ${k} no es una fecha YYYY-MM-DD: ${v}`);
  }
  for (const [k, v] of [["h1", h1], ["h2", h2]]) {
    if (!RE_HORA.test(String(v))) throw new Error(`buildUrl: ${k} fuera de rango 00..24: ${v}`);
  }
  const srv = escapeXml(SERVER);
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

// Fecha/hora actual en America/Bogota (UTC-5, sin DST) sin dependencias.
function nowBogota() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10), minute: get("minute") };
}

const num = (v) => (typeof v === "number" ? v : 0);

const TIMEOUT_MS = 30000;
const MAX_XLS_BYTES = 10 * 1024 * 1024;

async function fetchPeriod(f1, h1, f2, h2) {
  // AUD-08/26: timeout (el standalone no tenía), redirect:'error' (anti-SSRF) y tope de descarga.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(buildUrl(f1, h1, f2, h2), { signal: ac.signal, redirect: "error" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_XLS_BYTES) throw new Error(`respuesta SIS demasiado grande: ${buf.length} bytes`);
    const parsed = parseXls(buf);
    return { status: resp.status, bytes: buf.length, ...parsed };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const { date, hour, minute } = nowBogota();
  const fechaCompact = date.replace(/-/g, "");
  const lastClosed = Math.max(hour, 1); // periodos cerrados 1..hour
  console.log(`Fecha (America/Bogota): ${date}  hora actual: ${String(hour).padStart(2, "0")}:${minute}`);
  console.log(`Extrayendo periodos 1..${lastClosed}\n`);

  const results = [];
  for (let i = 0; i < lastClosed; i++) {
    const h1 = String(i).padStart(2, "0");
    const periodo = i + 1;
    let h2, f2;
    if (periodo === 24) { h2 = "00"; const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); f2 = d.toISOString().slice(0, 10); }
    else { h2 = String(periodo).padStart(2, "0"); f2 = date; }
    try {
      const r = await fetchPeriod(date, h1, f2, h2);
      const lr = r.lastRow;
      const tolvasRaw = []; for (let c = 1; c <= 8; c++) tolvasRaw.push(num(lr[c]));
      const energiaMw = num(lr[9]);
      const v659 = num(lr[10]), v651 = num(lr[11]), mpaflow = num(lr[12]);
      const enServicio = v659 > 400 && v651 > 400 && mpaflow > 140;
      const tolvasVal = tolvasRaw.map((t) => (t > 0.5 && enServicio ? t : 0));
      const totalCarbon = +tolvasVal.reduce((a, b) => a + b, 0).toFixed(3);
      console.log(`  periodo ${String(periodo).padStart(2, "0")}  OK  HTTP ${r.status}  ${r.bytes} bytes  filas=${r.maxRow}  carbon=${totalCarbon} t/h  servicio=${enServicio ? "SI" : "NO"}`);
      results.push({ periodo: String(periodo).padStart(2, "0"), tolvasRaw, tolvasVal, energiaMw, v659, v651, mpaflow, enServicio, totalCarbon, http: r.status, bytes: r.bytes });
    } catch (e) {
      console.log(`  periodo ${String(periodo).padStart(2, "0")}  ERROR  ${e.message}`);
      results.push({ periodo: String(periodo).padStart(2, "0"), error: e.message });
    }
  }

  const header = ["Periodo"]
    .concat([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `Tolva${i} raw (t/h)`))
    .concat([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `Tolva${i} validada (t/h)`))
    .concat(["Energia bruta (MW)", "HBK10CT659_AVG", "HBK10CT651_AVG", "MPAFLOW", "En servicio", "Total carbon validado (t/h)", "HTTP", "Bytes", "Error"]);

  const rows = [header];
  for (const r of results) {
    if (r.error) { rows.push([r.periodo].concat(Array(header.length - 3).fill("")).concat(["", "", r.error])); continue; }
    const round = (x, d = 3) => +x.toFixed(d);
    rows.push(
      [r.periodo]
        .concat(r.tolvasRaw.map((x) => round(x)))
        .concat(r.tolvasVal.map((x) => round(x)))
        .concat([round(r.energiaMw), round(r.v659, 2), round(r.v651, 2), round(r.mpaflow, 2), r.enServicio ? "SI" : "NO", r.totalCarbon, r.http, r.bytes, ""])
    );
  }

  // AUD-28: `fechaCompact` son solo dígitos (sin traversal). writeXlsx además valida que la ruta
  // quede contenida en el repo raíz (padre del scraper) antes de escribir.
  const out = path.join(__dirname, "..", `scraping_ge32_js_${fechaCompact}.xlsx`);
  writeXlsx(out, "GE32 SIS", rows);
  console.log(`\nArchivo generado: ${path.resolve(out)}`);
})();
