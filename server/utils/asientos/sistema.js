// D-064 — Asientos que escribe el SISTEMA, no una persona. Hoy hay uno solo: la llegada del
// despacho económico que XM publica para el día siguiente (REQ-05).
//
// Módulo PURO: sin BD, sin reloj, sin red. Ni siquiera importa de `./index.js`.
//
// ── Por qué vive APARTE del motor de D-058 ──────────────────────────────────────────────────
// El motor de `index.js` normaliza: le pone punto final a la frase y, en Sala, le antepone la
// unidad al renglón salvo que el texto ya la nombre (`UNIDAD_YA_NOMBRADA`, `formato.js:19`). Este
// asiento no puede pasar por ahí, y lo comprobamos corriéndolo: el regex NO matchea
// `"Se recibe del XM…"`, así que `asientoLiteralSala` publicaría `GEC3 — Se recibe del XM…` — un
// prefijo de unidad en la única frase del sistema que nombra a las DOS unidades a la vez
// (RQ-05.5). Ampliar el regex tampoco es opción: de él depende que el 40 % de los eventos libres
// de Sala no salgan con el prefijo duplicado, y ensancharlo para un caso lo vuelve frágil para
// los otros. Módulo aparte = el motor de D-058 no cambia de forma para nadie.
//
// ── Por qué el marcador es `origen_sistema` y NO `origen_bitacora` ──────────────────────────
// `origen_bitacora` es el marcador universal de las COPIAS REFLEJADAS de MAND/DISP (D-063), y el
// libro F03 excluye del renglón toda fila que lo lleve (`eventosSala`, en `f03-datos.js`:
// `JSON_VALUE(campos_extra,'$.origen_bitacora') IS NULL`). Este asiento no es una copia: es un
// registro ORIGINAL de Sala (RQ-05.9). Marcarlo con esa clave lo borraría del libro, que es justo
// el único lugar donde tiene que aparecer.
//
// ── El texto es una frase FIJA, no una plantilla ────────────────────────────────────────────
// `G3.0` / `G3.2` es una excepción deliberada a la convención `GEC3`/`GEC32` de
// `FORMATO-ASIENTOS-OPERACION.md` §4: está calcado del F03 real (REQ-05 §3.2, recorte en
// `docs/requerimientos/formatos/2026-07-F03-asiento-despacho-dia-siguiente.png`). No se normaliza
// ni se parametriza por planta, y va SIN punto final, como está en el papel.

// El valor del marcador. Único, estable, y NO es `origen_bitacora` (ver cabecera).
export const ORIGEN_DESPACHO_XM = 'DESPACHO_XM';

// Las dos bitácoras de Sala que reciben el asiento. Mismo par que `BITACORAS_REFLEJO`
// (`utils/reflejo-sala.js`), repetido a propósito: este módulo es puro y no importa de nadie, y
// el par es un dato del dominio, no una dependencia.
export const BITACORAS_ASIENTO_SISTEMA = ['SALAJDT', 'SALAING'];

// El nombre del tipo de evento que siembra la migración F36.A1 (contrato C6). El escritor resuelve
// su `tipo_evento_id` por `(bitacora_id, nombre)`, NUNCA por un id fijo.
export const TIPO_EVENTO_DESPACHO_XM = 'Despacho económico';

// `YYYY-MM-DD` estricto. No acepta `2026-7-4` ni `14/07/2026`: la única forma en que entra una
// fecha a este módulo es la del contrato C4 (`fecha_despacho`, tal como la devuelve el lector).
const ISO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

// Valida y devuelve `[AAAA, MM, DD]` ya normalizados. Lanza si la fecha no existe.
//
// La forma sola NO alcanza, y esta es la trampa que motivó el `@throws` del contrato: en JS
// `new Date('2026-02-30')` no lanza, rueda al 2 de marzo (medido). Validar con `Date` produciría
// un asiento con la fecha EQUIVOCADA y ninguna excepción. Por eso son dos controles: regex para
// la forma, y round-trip contra `Date.UTC` para que el día exista de verdad en ese mes.
//
// Un asiento con la fecha mal es peor que ningún asiento: el renglón queda en el libro mensual,
// que es un documento firmado, y nadie lo va a contrastar contra XM tres meses después.
//
// Normaliza UNA sola vez para los tres productores (texto, clave y `campos_extra`): si la clave y
// el texto pudieran derivar de fechas distintas, la idempotencia de RQ-05.13 se rompería en
// silencio — se buscaría una clave y se escribiría otra.
function partesDeFecha(fecha_despacho, quien) {
  const crudo = String(fecha_despacho ?? '').trim();
  const m = ISO_FECHA.exec(crudo);
  if (!m) {
    throw new TypeError(
      `${quien}: la fecha del despacho tiene que ser 'YYYY-MM-DD' (llegó ${JSON.stringify(fecha_despacho)})`,
    );
  }

  const [, anio, mes, dia] = m;
  const d = new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia)));
  const existe = d.getUTCFullYear() === Number(anio)
    && d.getUTCMonth() === Number(mes) - 1
    && d.getUTCDate() === Number(dia);
  if (!existe) {
    throw new TypeError(`${quien}: ${crudo} no es un día que exista (el calendario rodaría a otra fecha)`);
  }

  return [anio, mes, dia];
}

/**
 * El texto literal del asiento (RQ-05.4). SIN punto final y SIN prefijo de unidad.
 * @param {string} fecha_despacho  'YYYY-MM-DD' — el día que anuncia (el siguiente), no el de hoy.
 * @returns {string} `Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA`
 * @throws {TypeError} si la fecha no es 'YYYY-MM-DD' válida.
 *
 * No acepta un `Date`: un `Date` no sabe de qué día Bogotá es, y ahí es donde se cuelan los
 * corrimientos de medianoche. La conversión a día Bogotá va una sola vez, en el lector.
 */
export function asientoDespachoXM(fecha_despacho) {
  const [anio, mes, dia] = partesDeFecha(fecha_despacho, 'asientoDespachoXM');
  return `Se recibe del XM despacho económico de G3.0 y G3.2 para el ${dia}-${mes}-${anio}`;
}

/**
 * La clave de agrupación de RQ-05.10. Determinística: misma fecha → misma clave.
 * @returns {string} `DESPACHO_XM|YYYY-MM-DD`
 * @throws {TypeError} con la misma validación que `asientoDespachoXM`.
 *
 * Lanza a propósito, aunque sea "solo una clave": es la clave con la que se BUSCA antes de
 * escribir (idempotencia, RQ-05.13) y con la que el libro COLAPSA las cuatro filas a un renglón
 * (contrato C5). Una clave a medias no duplicaría el asiento: lo escribiría de nuevo cada vez, y
 * encima imposible de agrupar.
 */
export function claveAsientoDespacho(fecha_despacho) {
  const [anio, mes, dia] = partesDeFecha(fecha_despacho, 'claveAsientoDespacho');
  return `${ORIGEN_DESPACHO_XM}|${anio}-${mes}-${dia}`;
}

/**
 * El `campos_extra` completo de una fila del asiento, listo para `JSON.stringify`.
 * Las cuatro filas (2 bitácoras × 2 plantas) comparten este objeto tal cual.
 * @throws {TypeError} con la misma validación que `asientoDespachoXM`.
 *
 * `hora_estimada` va SIEMPRE presente (`true`/`false`), nunca ausente: es la lección de D-056 (b),
 * donde una clave ausente que alguien leyó como `null` costó caro. Rigor de escritura; la
 * robustez de lectura (ausente → `false`) la ponen los predicados de abajo.
 *
 * Se coacciona con `Boolean` en vez de comparar contra `true` a propósito: si el llamador trae un
 * `1` de una columna BIT, marcar de más es inocuo (el renglón dice "hora estimada" y nadie lo lee
 * como medición), mientras que marcar de menos vende una hora inventada como si fuera medida.
 */
export function camposExtraDespacho({ fecha_despacho, hora_estimada = false } = {}) {
  const [anio, mes, dia] = partesDeFecha(fecha_despacho, 'camposExtraDespacho');
  const fecha = `${anio}-${mes}-${dia}`;
  return {
    origen_sistema: ORIGEN_DESPACHO_XM,
    clave_asiento: `${ORIGEN_DESPACHO_XM}|${fecha}`,
    fecha_despacho: fecha,
    hora_estimada: Boolean(hora_estimada),
  };
}

// Acepta el objeto ya parseado o el string crudo de la columna `campos_extra`. Un JSON inválido
// devuelve `null`, no una excepción: a los predicados de abajo los consultan LECTURAS (el libro
// mensual, la grilla de Sala) que no se pueden caer por una fila con `campos_extra` corrupto — y
// en el histórico, que es append-only, esa fila tampoco se puede arreglar.
function comoObjeto(campos_extra) {
  if (campos_extra == null) return null;
  if (typeof campos_extra === 'object') return Array.isArray(campos_extra) ? null : campos_extra;
  if (typeof campos_extra !== 'string') return null;
  try {
    const parsed = JSON.parse(campos_extra);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ¿Esta fila es un asiento escrito por el sistema? Lee `campos_extra.origen_sistema`.
 * Acepta el objeto o el string crudo; JSON inválido o marcador ausente → `false`, sin lanzar.
 *
 * El predicado es GENÉRICO a propósito (`esAsientoDeSistema`, no `esAsientoDespachoXM`): hoy el
 * único valor posible es `DESPACHO_XM`, y un segundo origen de sistema no debería obligar a
 * editar a sus consumidores. Cualquier marcador no vacío cuenta.
 */
export function esAsientoDeSistema(campos_extra) {
  const obj = comoObjeto(campos_extra);
  if (!obj) return false;
  return typeof obj.origen_sistema === 'string' && obj.origen_sistema.trim() !== '';
}

/**
 * La clave de agrupación de una fila, o `null` si no es un asiento de sistema.
 *
 * También devuelve `null` cuando la fila ES del sistema pero le falta la clave (una fila corrupta,
 * o una futura sin agrupación): así el consumidor cae a su desempate por `registro_id` (C5) y en
 * el peor caso el asiento sale duplicado. Agrupar mal dos filas ajenas sería peor que duplicar
 * una.
 */
export function claveDeAgrupacion(campos_extra) {
  const obj = comoObjeto(campos_extra);
  if (!obj || !esAsientoDeSistema(obj)) return null;
  const clave = obj.clave_asiento;
  return typeof clave === 'string' && clave.trim() !== '' ? clave : null;
}

/**
 * ¿La hora de esta fila es la convención de las 15:00 del relleno del mes (RQ-05.14) y no una
 * medición? Ausente → `false`.
 *
 * Tolera el `'true'`/`'1'` en texto porque el valor puede llegar de un `JSON_VALUE`, que devuelve
 * nvarchar — y ahí `Boolean('false')` daría `true`. Acá, al revés que al escribir, se lee lo que
 * la fila dice y nada más: solo los valores afirmativos conocidos.
 */
export function esHoraEstimada(campos_extra) {
  const obj = comoObjeto(campos_extra);
  if (!obj) return false;
  const v = obj.hora_estimada;
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true' || v.trim() === '1';
  return false;
}
