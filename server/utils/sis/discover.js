// Sondeo de la PRIMERA fecha con datos de GEC32 en el SIS (D-029 / E3, extraído a su propio módulo
// en D-061 / C3). Vivía dentro de carbon-scraper.js; se movió TAL CUAL (mismo cuerpo, misma firma)
// porque su único consumidor es el CLI de backfill y mezclarla con el scraper horario obligaba a
// cargar todo el núcleo de escritura para un sondeo de solo lectura.
//
// D-061 / L05 — v2 CALIBRADA. La v1 declaraba "sin datos" con UN solo sondeo por candidato, así que
// una parada larga de la unidad se leía como "acá el SIS todavía no existía" y el backfill arrancaba
// años tarde. Ahora un candidato es "sin datos" SOLO si los `sondeosPorVentana` sondeos repartidos
// uniformemente en [candidato, candidato + ventanaDias) salen todos vacíos (fetch OK con energiaMw=0,
// tolvas en 0 y fuera de servicio, o fetch fallido). Con los valores por defecto (K=6, W=60) los
// sondeos abarcan 50 días: una parada más corta que eso no puede vaciar una ventana entera, que es
// justo la propiedad que la v1 no tenía.
//
// Estrategia: ancla → coarse anual hacia atrás → fino mensual (rejilla hacia adelante) → barrido
// diario ascendente → confirmación de que los `ventanaDias` previos al día hallado están vacíos.
// Todos los sondeos se loguean y se memorizan: la rejilla se solapa entre fases y un sondeo cuesta
// ~13 s contra el SIS real.

import { fetchPeriod, periodoBounds, extraerCarbonValidado } from './sis-client.js';
import { fechaBogotaStr } from '../turno.js';

const TIMEOUT_MS = 30000; // corta el fetch si el SIS no responde (mismo tope que el scraper).
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONFIRMACIONES = 40; // tope duro del lazo de confirmación (cada vuelta retrocede >=1 día).

export function addDays(fecha, n) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// Desplazamientos (en días) de los K sondeos de una ventana de W días, repartidos uniformemente y
// en orden ascendente: K=6, W=60 → [0, 10, 20, 30, 40, 50]. El primero siempre es el candidato.
// Se deduplican para que K > W no sondee dos veces el mismo día.
export function offsetsVentana(sondeosPorVentana = 6, ventanaDias = 60) {
  const k = Math.max(1, Math.trunc(sondeosPorVentana));
  const w = Math.max(1, Math.trunc(ventanaDias));
  const out = [];
  for (let i = 0; i < k; i++) {
    const off = Math.round((i * w) / k);
    if (!out.includes(off)) out.push(off);
  }
  return out;
}

// Sondea el SIS hacia atrás para hallar la PRIMERA fecha con datos de GEC32 (la unidad existía /
// reportó sensores ese día). "Hay datos" ⇔ fetch OK y energía != 0, alguna tolva validada > 0 o
// sensores en servicio en el periodo de sondeo. Devuelve 'YYYY-MM-DD' o null si ni el hint ni el
// techo tienen datos (sin ancla no hay desde dónde retroceder).
export async function discoverEarliestDate(pool, {
  hint = null,               // 'YYYY-MM-DD' fecha conocida con datos (acota la búsqueda).
  periodoProbe = 12,         // periodo medio del día a sondear (mediodía).
  techo = fechaBogotaStr(new Date()), // fecha tope (no se sondea más reciente que esto).
  maxYearsBack = 10,         // límite duro de retroceso para no colgar el sondeo.
  sondeosPorVentana = 6,     // K: sondeos por ventana (D-061 C3).
  ventanaDias = 60,          // W: ancho de la ventana en días (D-061 C3).
  fetchFn = (f1, h1, f2, h2) => fetchPeriod(f1, h1, f2, h2, { timeoutMs: TIMEOUT_MS }),
  log = (...a) => console.log('[sis-discover]', ...a),
} = {}) {
  if (!RE_FECHA.test(String(techo))) throw new Error(`discoverEarliestDate: techo inválido: ${techo}`);
  const offsets = offsetsVentana(sondeosPorVentana, ventanaDias);

  // Caché de sondeos: la rejilla de las fases se solapa y un sondeo real cuesta ~13 s.
  const vistos = new Map(); // fecha -> boolean (hay datos)
  const sondearDia = async (fecha) => {
    if (vistos.has(fecha)) return vistos.get(fecha);
    let hay = false;
    let etiqueta;
    try {
      const { f1, h1, f2, h2 } = periodoBounds(fecha, periodoProbe);
      const parsed = await fetchFn(f1, h1, f2, h2);
      const { lastRow, ncols } = parsed ?? {};
      if (!lastRow || (ncols !== undefined && ncols < 12)) {
        etiqueta = 'vacío';
      } else {
        const v = extraerCarbonValidado(lastRow);
        hay = v.energiaMw > 0 || v.tolvasVal.some((t) => t > 0) || v.enServicio;
        etiqueta = hay ? 'datos' : 'vacío';
      }
    } catch (err) {
      etiqueta = `error (${err.message})`; // un fetch fallido cuenta como vacío (contrato C3).
    }
    vistos.set(fecha, hay);
    log(`${fecha} P${periodoProbe} → ${etiqueta}`);
    return hay;
  };

  // Regla del contrato: la ventana [cand, cand+W) está "sin datos" solo si TODOS sus sondeos salen
  // vacíos. Se recorre en orden ascendente y se corta en el primero con datos, que es a la vez el
  // día más temprano de la ventana que sabemos poblado (cota superior del inicio). Los sondeos
  // posteriores al techo no se piden (serían el futuro) y no cuentan como vacíos.
  const ventana = async (cand) => {
    for (const off of offsets) {
      const d = addDays(cand, off);
      if (d > techo) break; // offsets ascendentes: de acá en adelante todo es futuro.
      if (await sondearDia(d)) return { hayDatos: true, primera: d };
    }
    return { hayDatos: false, primera: null };
  };

  // Último día que sondeamos vacío y es anterior a `limite` (la rejilla de la fase mensual lo deja
  // a pocos días). Acota el barrido diario sin volver a pedirle nada al SIS.
  const ultimoVacioAntes = (limite) => {
    let mejor = null;
    for (const [fecha, hay] of vistos) {
      if (!hay && fecha < limite && (mejor === null || fecha > mejor)) mejor = fecha;
    }
    return mejor;
  };

  // Primer día CON datos en [desde, hasta], barriendo día a día hacia adelante. Ascendente y no
  // binaria a propósito: una parada posterior al inicio produce días vacíos y una binaria los
  // tomaría como "todavía no arranca", saltando por encima del inicio real.
  const primerDiaConDatos = async (desde, hasta) => {
    for (let d = desde; d <= hasta; d = addDays(d, 1)) {
      if (await sondearDia(d)) return d;
    }
    return null;
  };

  // (0) Ancla: el primer candidato cuya ventana tenga datos. Sin ancla no hay desde dónde retroceder.
  let conDatos = null;
  for (const cand of [hint, techo]) {
    if (cand === null || cand === undefined) continue;
    if (!RE_FECHA.test(String(cand))) { log(`hint inválido, se ignora: ${cand}`); continue; }
    if (cand > techo) { log(`hint ${cand} es posterior al techo ${techo}, se ignora`); continue; }
    const v = await ventana(cand);
    if (v.hayDatos) { conDatos = v.primera; break; }
  }
  if (!conDatos) {
    log('ni hint ni techo tienen datos — no se puede anclar el sondeo');
    return null;
  }

  // (1) Coarse: retroceder año a año hasta una ventana SIN datos.
  let sinDatos = null;
  for (let y = 1; y <= maxYearsBack; y++) {
    const cand = addDays(conDatos, -365);
    log(`coarse: ventana desde ${cand} (-${y}a)`);
    const v = await ventana(cand);
    if (v.hayDatos) conDatos = v.primera;
    else { sinDatos = cand; break; }
  }
  if (!sinDatos) {
    log(`alcanzado maxYearsBack=${maxYearsBack}; earliest conocido = ${conDatos}`);
    return conDatos;
  }

  // (2) Fino mensual: desde el pre-inicio certificado, avanzar de a media ventana hasta la primera
  // ventana CON datos. Como la caché reusa los sondeos solapados, es un barrido de la rejilla de
  // W/K días hacia adelante: deja `sinDatos` en el último candidato con ventana vacía y `conDatos`
  // en el primer día de rejilla poblado.
  const paso = Math.max(1, Math.round(ventanaDias / 2));
  for (let cand = sinDatos; cand < conDatos; cand = addDays(cand, paso)) {
    log(`fino: ventana desde ${cand} (paso ${paso}d)`);
    const v = await ventana(cand);
    if (v.hayDatos) {
      if (v.primera < conDatos) conDatos = v.primera;
      break;
    }
    sinDatos = cand;
  }

  // (3) Diaria + confirmación: el primer día con datos por encima del último vacío conocido, y se
  // acepta solo si los `ventanaDias` ANTERIORES a ese día están vacíos según la regla del contrato.
  // Si aparecen datos antes, ese día pasa a ser la nueva cota superior y se repite.
  let inicio = conDatos;
  for (let iter = 0; iter < MAX_CONFIRMACIONES; iter++) {
    const lo = ultimoVacioAntes(conDatos) ?? sinDatos;
    log(`diaria: barrido ${addDays(lo, 1)}..${conDatos}`);
    inicio = (await primerDiaConDatos(addDays(lo, 1), conDatos)) ?? conDatos;
    const previa = await ventana(addDays(inicio, -ventanaDias)); // sondea [inicio-W, inicio)
    if (!previa.hayDatos) {
      log(`earliest con datos = ${inicio} (${vistos.size} sondeos)`);
      return inicio;
    }
    log(`confirmación: ${previa.primera} también tiene datos y es anterior a ${inicio} — sigo atrás`);
    conDatos = previa.primera;
  }
  log(`tope de confirmaciones (${MAX_CONFIRMACIONES}) alcanzado; earliest con datos = ${inicio}`);
  return inicio;
}
