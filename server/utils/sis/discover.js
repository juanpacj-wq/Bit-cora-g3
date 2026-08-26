// Sondeo de la PRIMERA fecha con datos de GEC32 en el SIS (D-029 / E3, extraído a su propio módulo
// en D-061 / C3). Vivía dentro de carbon-scraper.js; se movió TAL CUAL (mismo cuerpo, misma firma)
// porque su único consumidor es el CLI de backfill y mezclarla con el scraper horario obligaba a
// cargar todo el núcleo de escritura para un sondeo de solo lectura.
//
// D-061: este archivo es el punto de entrada de la v2 (calibración por K sondeos en una ventana de
// W días, que L05 implementa). Acá NO se cambia la heurística: el movimiento es a costo cero para
// que el diff de la v2 se lea limpio. carbon-scraper.js re-exporta el símbolo para no romper
// imports existentes.

import { fetchPeriod, periodoBounds, extraerCarbonValidado } from './sis-client.js';
import { fechaBogotaStr } from '../turno.js';

const TIMEOUT_MS = 30000; // corta el fetch si el SIS no responde (mismo tope que el scraper).

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
