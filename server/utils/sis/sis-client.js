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

import { parseXls } from "./xls-parser.js";

export const SIS_HOST = process.env.SIS_HOST || "http://192.168.18.201";
export const SIS_SERVER = "NEWSYNCBASE";
export const TAGS = [
  "DCS_20HFY10FU013", "DCS_20HFY20FU013", "DCS_20HFY30FU013", "DCS_20HFY40FU013",
  "DCS_20HFY50FU013", "DCS_20HFY60FU013", "DCS_20HFY70FU013", "DCS_20HFY80FU013",
  "DCS_20CFE01CE21", "DCS_20HBK10CT659_AVG", "DCS_20HBK10CT651_AVG", "DCS_MPAFLOW",
];

const num = (v) => (typeof v === "number" ? v : 0);
const round3 = (x) => +x.toFixed(3);

export function buildUrl(f1, h1, f2, h2) {
  const tags = TAGS.map((t) => `<tg n='${t}'/>`).join("");
  const params =
    `<Data><Action>GETDATASERIAL</Action><PROTOCOL><p><a>h</a>` +
    `<t1>${f1} ${h1}:00:00</t1><t2>${f2} ${h2}:00:00</t2>` +
    `<ts>1</ts><sis server='${SIS_SERVER}'>${tags}</sis></p></PROTOCOL>` +
    `<BTIME>${f1} ${h1}:00:00</BTIME><ETIME>${f2} ${h2}:00:00</ETIME><TS>1</TS></Data>`;
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
    const resp = await fetch(buildUrl(f1, h1, f2, h2), signal ? { signal } : undefined);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const parsed = parseXls(buf);
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
    const raw = num(lastRow[i + 1]);
    tolvasVal.push(raw > 0.5 && enServicio ? round3(raw) : 0);
  }
  const energiaMw = round3(num(lastRow[9]));
  const totalCarbon = round3(tolvasVal.reduce((a, b) => a + b, 0));
  return { enServicio, tolvasVal, energiaMw, totalCarbon };
}
