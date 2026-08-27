// Sondeo de la PRIMERA fecha con datos de GEC32 en el SIS (D-029 / E3, extraído a su propio módulo
// en D-061 / C3). Vivía dentro de carbon-scraper.js; se movió TAL CUAL (mismo cuerpo, misma firma)
// porque su único consumidor es el CLI de backfill y mezclarla con el scraper horario obligaba a
// cargar todo el núcleo de escritura para un sondeo de solo lectura.
//
// D-061 / L05 — v2 CALIBRADA. La v1 declaraba "sin datos" con UN solo sondeo por candidato, así que
// una parada larga de la unidad se leía como "acá el SIS todavía no existía" y el backfill arrancaba
// años tarde. Ahora un candidato es "sin datos" SOLO si los `sondeosPorVentana` sondeos repartidos
// uniformemente en [candidato, candidato + ventanaDias) salen todos vacíos (fetch OK con energiaMw=0,
// tolvas en 0 y fuera de servicio). Con los valores por defecto (K=6, W=60) los sondeos abarcan
// 50 días: una parada más corta que eso no puede vaciar una ventana entera, que es justo la
// propiedad que la v1 no tenía.
//
// D-061 / L10 — ENDURECIDA (H28/H29/H30 del code-review de la O2). Tres cosas que la v2 hacía mal y
// que en una corrida real (~50-100 fetch de ~13 s contra el SIS) podían devolver una fecha
// equivocada SIN decirlo:
//   1. Un fetch que FALLÓ se memorizaba como "vacío" para el resto de la corrida. Un bache de red
//      que tumbara los 6 sondeos de una ventana la certificaba como pre-inicio, y la fase de
//      confirmación releía esa mentira en la caché en vez de volver a preguntar. Ahora hay TRES
//      estados por sondeo (datos / vacío / error): solo los dos primeros se memorizan, y un error
//      no cuenta como vacío — se reintenta y, si insiste, el sondeo entero termina diciendo
//      `motivo: 'error-de-sondeo'`.
//   2. La ventana del ancla se degeneraba a UN sondeo: los offsets que pasaban el techo se
//      descartaban, así que para el candidato = techo quedaba K=1 (la debilidad de la v1). Ahora,
//      cuando la ventana no cabe hacia adelante, se extiende HACIA ATRÁS desde el techo: misma
//      regla (K sondeos en W días), solo cambia la dirección.
//   3. "Alcancé el tope de retroceso" se devolvía igual que "encontré el inicio" — una fecha
//      truncada que el CLI imprimía como respuesta. Ahora el valor de retorno es
//      `{ fecha, motivo, sondeos }` con `motivo` de vocabulario cerrado, y el retroceso del coarse
//      avanza 365 días POR VUELTA (antes retrocedía desde `v.primera`, que podía ser el candidato
//      + 50 días: `maxYearsBack = 10` alcanzaba ~8,6 años y la etiqueta `(-Na)` del log mentía).
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

// Vocabulario cerrado de `motivo` (D-061 / C3 enmendado por L10). Quien agregue uno tiene que
// agregarlo también a `explicarDescubrimiento`, que es lo que el operador termina leyendo.
export const MOTIVOS = ['hallada', 'tope-alcanzado', 'sin-datos', 'error-de-sondeo'];

// Un día que el SIS no pudo responder dos veces seguidas. No se propaga fuera del módulo:
// `discoverEarliestDate` lo traduce a `motivo: 'error-de-sondeo'`.
class SondeoIndecidible extends Error {
  constructor(fecha) {
    super(`sondeo indecidible en ${fecha}`);
    this.name = 'SondeoIndecidible';
    this.fecha = fecha;
  }
}

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

// Cómo se le cuenta a un humano el resultado del sondeo, y con qué código sale el proceso cuando no
// se escribió nada. Vive acá —y no en el CLI— porque el vocabulario de `motivo` es de este módulo:
// quien agregue un motivo tiene que decir, en la misma edición, cómo se explica. El CLI de backfill
// imprime estas líneas TAL CUAL, prefijadas con `[backfill] `.
//   - `confirmable`: si tiene sentido ofrecer `--confirm-from` para escribir desde esa fecha.
//   - `codigo`: código de salida del CLI cuando no escribe (2 = el sondeo no sirve, 3 = falta
//     confirmar la fecha hallada, 4 = falta confirmar una fecha que además puede no ser el inicio).
export function explicarDescubrimiento({ fecha = null, motivo = null, sondeos = 0 } = {}) {
  switch (motivo) {
    case 'hallada':
      return {
        lineas: [`fecha de inicio = ${fecha} (${sondeos} sondeos)`],
        confirmable: true,
        codigo: 3,
      };
    case 'tope-alcanzado':
      return {
        lineas: [
          `llegué al tope de retroceso SIN certificar el inicio (${sondeos} sondeos).`,
          `el día más antiguo con datos que conozco es ${fecha}, pero puede haber historia más atrás: confírmalo antes de tomarlo como la primera fecha del SIS.`,
        ],
        confirmable: true,
        codigo: 4,
      };
    case 'sin-datos':
      return {
        lineas: ['el sondeo no encontró ninguna fecha con datos (ni el hint ni el techo respondieron).'],
        confirmable: false,
        codigo: 2,
      };
    case 'error-de-sondeo':
      return {
        lineas: [
          `el sondeo se detuvo: el SIS falló dos veces seguidas en el mismo día (${sondeos} sondeos).`,
          'no hay fecha de inicio confiable: revisa la red contra el SIS y repite --from auto.',
        ],
        confirmable: false,
        codigo: 2,
      };
    default:
      return {
        lineas: [`resultado desconocido del sondeo (motivo=${motivo}).`],
        confirmable: false,
        codigo: 2,
      };
  }
}

// Sondea el SIS hacia atrás para hallar la PRIMERA fecha con datos de GEC32 (la unidad existía /
// reportó sensores ese día). "Hay datos" ⇔ fetch OK y energía != 0, alguna tolva validada > 0 o
// sensores en servicio en el periodo de sondeo.
//
// Devuelve `{ fecha: 'YYYY-MM-DD'|null, motivo, sondeos }` (D-061 / C3 enmendado por L10):
//   - `hallada`         → `fecha` es el inicio, con su ventana previa confirmada vacía.
//   - `tope-alcanzado`  → `fecha` es el día con datos MÁS ANTIGUO que se alcanzó a ver, pero puede
//                         haber historia más atrás (se agotó `maxYearsBack` o `MAX_CONFIRMACIONES`).
//   - `sin-datos`       → `fecha` null: ni el hint ni el techo respondieron con datos.
//   - `error-de-sondeo` → `fecha` null: el SIS falló dos veces en el mismo día y no hay respuesta
//                         honesta que dar. NUNCA se devuelve una fecha adivinada después de un error.
// `sondeos` cuenta los fetch REALES (los aciertos de caché no cuentan).
//
// `pool` no se usa (el sondeo es solo-red): se conserva porque C3 fija la firma y el CLI ya lo pasa.
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
  const span = offsets[offsets.length - 1]; // cuántos días abarca la ventana de punta a punta.

  // Caché de sondeos DECIDIDOS: la rejilla de las fases se solapa y un sondeo real cuesta ~13 s.
  // Un fetch fallido NO entra acá (H28): no sabe nada del día, y memorizarlo como "vacío" era la
  // forma de convertir un bache de red en una fecha de inicio equivocada.
  const vistos = new Map(); // fecha -> boolean (hay datos)
  let sondeos = 0;          // fetch reales pedidos al SIS (sin contar los aciertos de caché).
  const fin = (fecha, motivo) => ({ fecha, motivo, sondeos });

  // 'datos' | 'vacio' | 'error'. El log conserva el formato de siempre ("<fecha> P<n> → …").
  const sondearDia = async (fecha) => {
    if (vistos.has(fecha)) return vistos.get(fecha) ? 'datos' : 'vacio';
    sondeos++;
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
      log(`${fecha} P${periodoProbe} → error (${err.message})`);
      return 'error';
    }
    vistos.set(fecha, hay);
    log(`${fecha} P${periodoProbe} → ${etiqueta}`);
    return hay ? 'datos' : 'vacio';
  };

  // Un día que hay que decidir sí o sí (el barrido diario): se reintenta UNA vez y, si el SIS vuelve
  // a fallar, se detiene todo. Saltárselo movería la fecha de inicio hacia adelante en silencio.
  const sondearDecidido = async (fecha) => {
    const r = await sondearDia(fecha);
    if (r !== 'error') return r;
    log(`reintento del sondeo de ${fecha}`);
    const r2 = await sondearDia(fecha);
    if (r2 === 'error') throw new SondeoIndecidible(fecha);
    return r2;
  };

  // Regla del contrato: la ventana de K sondeos está "sin datos" solo si TODOS salen vacíos. Se
  // recorre en orden ascendente de fecha y se corta en el primero con datos, que es a la vez el día
  // más temprano de la ventana que sabemos poblado (cota superior del inicio).
  //   · H29: si la ventana no cabe hacia adelante (el candidato está a menos de `span` días del
  //     techo), se extiende hacia ATRÁS desde el techo. Recortarla dejaba el ancla en K=1 y un solo
  //     día de parada en el techo bastaba para no anclar nada.
  //   · H49 (L11): al correr la ventana hacia atrás, la rejilla se desplaza con ella y el día del
  //     CANDIDATO se dejaba de sondear — justo el único día que el llamador tiene motivos para creer
  //     poblado (el `hint` sale de `MIN(fecha)` de `sis_scrape_log`). En una instalación donde el
  //     sweeper lleve pocas semanas de log, el hint cae siempre a menos de `span` del techo, no
  //     aporta nada y `--from auto` muere con exit 2 diciendo que nadie respondió. Ahora el
  //     candidato se mezcla en la rejilla y se recorre todo en orden ascendente: la regla "K sondeos
  //     en W días" no cambia, solo se garantiza que el offset 0 siempre entra (cuesta un sondeo más,
  //     y únicamente cuando la ventana se corrió).
  //   · H28: los sondeos con error no cuentan como vacíos. Si la ventana termina sin datos pero con
  //     errores, se reintentan SOLO los días que fallaron; si alguno insiste, la ventana es
  //     indecidible y el descubrimiento se detiene (nunca se la da por vacía).
  const ventana = async (cand) => {
    const tope = addDays(techo, -span);
    const base = cand > tope ? tope : cand;
    if (base !== cand) {
      log(`ventana de ${cand} no cabe hasta el techo ${techo}: se extiende hacia atrás desde ${base}`);
    }
    // Ascendente y sin repetidos: el corte en el primer día con datos tiene que seguir devolviendo
    // el más TEMPRANO de la ventana (es la cota superior del inicio). Con `base === cand` el
    // candidato ya es el offset 0 y esto no agrega nada.
    const dias = [...new Set([...offsets.map((off) => addDays(base, off)), cand])].sort();
    const fallidos = [];
    for (const d of dias) {
      const r = await sondearDia(d);
      if (r === 'datos') return { hayDatos: true, primera: d };
      if (r === 'error') fallidos.push(d);
    }
    for (const d of fallidos) {
      log(`reintento del sondeo de ${d}`);
      const r = await sondearDia(d);
      if (r === 'datos') return { hayDatos: true, primera: d };
      if (r === 'error') throw new SondeoIndecidible(d);
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
      if (await sondearDecidido(d) === 'datos') return d;
    }
    return null;
  };

  try {
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
      return fin(null, 'sin-datos');
    }

    // (1) Coarse: retroceder año a año hasta una ventana SIN datos. El cursor retrocede desde el
    // CANDIDATO anterior, no desde el día con datos que la ventana rescató: así cada vuelta son
    // 365 días de verdad y `maxYearsBack` vuelve a medir años (H30).
    let sinDatos = null;
    let cursor = conDatos;
    for (let y = 1; y <= maxYearsBack; y++) {
      cursor = addDays(cursor, -365);
      log(`coarse: ventana desde ${cursor} (-${y}a, ${365 * y} d desde el ancla)`);
      const v = await ventana(cursor);
      // Sin `if (v.primera < conDatos)`, a diferencia del fino: acá la ventana arranca 365 días por
      // debajo del ancla y abarca `span` (50 d), así que su día poblado más temprano es SIEMPRE
      // anterior a `conDatos` y la comparación no puede ser falsa. En el fino sí puede: su candidato
      // avanza de a W/2 y la ventana llega a pasarse de la cota superior (H61 — las dos se veían
      // iguales y una estaba muerta).
      if (v.hayDatos) conDatos = v.primera;
      else { sinDatos = cursor; break; }
    }
    if (!sinDatos) {
      log(`alcanzado maxYearsBack=${maxYearsBack}; earliest conocido = ${conDatos}`);
      return fin(conDatos, 'tope-alcanzado');
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
        log(`earliest con datos = ${inicio} (${sondeos} sondeos)`);
        return fin(inicio, 'hallada');
      }
      log(`confirmación: ${previa.primera} también tiene datos y es anterior a ${inicio} — sigo atrás`);
      conDatos = previa.primera;
    }
    log(`tope de confirmaciones (${MAX_CONFIRMACIONES}) alcanzado; earliest con datos = ${inicio}`);
    return fin(inicio, 'tope-alcanzado');
  } catch (err) {
    if (err instanceof SondeoIndecidible) {
      log(`el SIS falló dos veces en ${err.fecha}: no puedo decidir esa ventana, detengo el sondeo`);
      return fin(null, 'error-de-sondeo');
    }
    throw err;
  }
}
