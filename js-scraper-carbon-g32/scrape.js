"use strict";

const path = require("path");
const { parseXls } = require("./xls");
const { writeXlsx } = require("./xlsx-write");

const SIS_HOST = "http://192.168.18.201";
const SERVER = "NEWSYNCBASE";
const TAGS = [
  "DCS_20HFY10FU013", "DCS_20HFY20FU013", "DCS_20HFY30FU013", "DCS_20HFY40FU013",
  "DCS_20HFY50FU013", "DCS_20HFY60FU013", "DCS_20HFY70FU013", "DCS_20HFY80FU013",
  "DCS_20CFE01CE21", "DCS_20HBK10CT659_AVG", "DCS_20HBK10CT651_AVG", "DCS_MPAFLOW",
];

function buildUrl(f1, h1, f2, h2) {
  const tags = TAGS.map((t) => `<tg n='${t}'/>`).join("");
  const params =
    `<Data><Action>GETDATASERIAL</Action><PROTOCOL><p><a>h</a>` +
    `<t1>${f1} ${h1}:00:00</t1><t2>${f2} ${h2}:00:00</t2>` +
    `<ts>1</ts><sis server='${SERVER}'>${tags}</sis></p></PROTOCOL>` +
    `<BTIME>${f1} ${h1}:00:00</BTIME><ETIME>${f2} ${h2}:00:00</ETIME><TS>1</TS></Data>`;
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

async function fetchPeriod(f1, h1, f2, h2) {
  const resp = await fetch(buildUrl(f1, h1, f2, h2));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const parsed = parseXls(buf);
  return { status: resp.status, bytes: buf.length, ...parsed };
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

  const out = path.join(__dirname, "..", `scraping_ge32_js_${fechaCompact}.xlsx`);
  writeXlsx(out, "GE32 SIS", rows);
  console.log(`\nArchivo generado: ${path.resolve(out)}`);
})();
