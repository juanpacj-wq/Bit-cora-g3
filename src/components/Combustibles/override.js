// D-061 L03 (C11): helpers PUROS de la UI de override SIS en la grilla COMB.
//
// Por qué un módulo aparte y no funciones dentro de ConsumosGrid.jsx: toda la lógica que se puede
// equivocar acá es aritmética de tiempo y armado de texto en zona Bogotá — se prueba sin DOM, sin
// backend y sin React (`override.test.js`, vitest en `environment:'node'`). El componente queda
// con puro cableado de estado y render.
//
// Contexto del dominio: solo GEC32 tiene lecturas del SIS. El scraper escribe las celdas de
// alimentadores como SISTEMA (`sis_owned`); cuando un humano las corrige, el backend marca la
// celda con `es_override` y conserva `valor_sis` para poder revertir. "Vaciar" una celda con
// lectura SIS no la borra: la deja en 0 (override 0), y por eso la grilla debe mostrar `0`.

// Ventana de gracia ("gavela") para cambios sin guardar mientras el auto-refresco está activo:
// pasados 10 min sin guardar, la grilla descarta el buffer y vuelve a leer del server. Sin esto,
// una pestaña abierta con una edición a medias congelaría el refresco de GEC32 indefinidamente y
// el operador vería datos viejos creyéndolos frescos.
export const GAVELA_MS = 600000;

// La celda trae `es_override` calculado por el backend (C4: `!sis_owned && valor_sis !== null &&
// cantidad !== valor_sis`). El front NO lo recalcula: mientras L02 no cierre el campo llega
// `undefined` y eso debe leerse como "sin badge", no como override.
export function esOverride(celda) {
  return celda?.es_override === true;
}

// Texto del tooltip del badge: quién dejó el valor manual, cuándo (Bogotá) y contra qué lectura
// del SIS. `modificado_por`/`modificado_en` mandan cuando existen; si la celda nunca se modificó
// (la creó un humano sobre una lectura posterior del SIS) se cae a `creado_por`/`creado_en`.
export function textoOverride(celda) {
  const nombre = celda?.modificado_por?.nombre_completo
    ?? celda?.creado_por?.nombre_completo
    ?? 'usuario desconocido';
  const cuando = fechaHoraBogota(celda?.modificado_en ?? celda?.creado_en);
  const valorSis = celda?.valor_sis;
  const sis = valorSis === null || valorSis === undefined || !Number.isFinite(Number(valorSis))
    ? '—'
    : String(Number(valorSis));
  // Sin fecha legible se omite el "el …" en vez de imprimir "Invalid Date": el tooltip sigue
  // siendo útil (quién y contra qué valor) aunque el server mande una fecha rota.
  const cuandoTxt = cuando ? ` el ${cuando}` : '';
  return `Editado por ${nombre}${cuandoTxt}. Valor SIS: ${sis} Ton`;
}

// Política de refresco de la grilla. Dos modos excluyentes, y solo en GEC32 viendo HOY (es el
// único caso en que el SIS está escribiendo por debajo mientras alguien mira la pantalla):
//  - `autoRefresco`: sin cambios locales → se puede releer del server sin pisarle nada a nadie.
//  - `gavela`: con cambios locales → NO se refresca (perderíamos la edición), pero se arranca la
//    cuenta regresiva de 10 min para no quedarse pegado en datos viejos.
// Cualquier otra planta, o una fecha pasada, no se refresca solo: el dato histórico no se mueve.
export function politicaRefresco({ plantaId, fecha, hoy, hayCambios } = {}) {
  const enVivo = plantaId === 'GEC32' && !!fecha && !!hoy && fecha === hoy;
  return {
    autoRefresco: enVivo && !hayCambios,
    gavela: enVivo && !!hayCambios,
  };
}

// Milisegundos que le quedan a la gavela. Nunca negativo (el llamador solo pregunta "¿cuánto
// falta?"; el vencimiento se detecta con `=== 0`). Sin `inicioMs` válido no hay gavela corriendo.
export function restanteGavela(inicioMs, ahoraMs) {
  if (!Number.isFinite(inicioMs) || !Number.isFinite(ahoraMs)) return 0;
  return Math.max(0, GAVELA_MS - (ahoraMs - inicioMs));
}

// 'm:ss' para la cuenta regresiva (10:00 → 0:00). Minutos sin cero de relleno, segundos con dos
// dígitos.
//
// Redondea hacia ARRIBA, no hacia abajo, porque es un contador: entre que la gavela nace y el
// primer latido de 1 s ya se fueron unos milisegundos, y truncando el usuario nunca veía "10:00"
// —arrancaba en 9:59 apenas tecleaba (medido en el humo de render)—. Con ceil, cada segundo que
// se muestra es "lo que falta para ese número" y "0:00" aparece exactamente al vencer, no un
// segundo antes.
export function formatoMMSS(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Chip del estado del scrape SIS del día que se está viendo (fila de `sis_scrape_log`, C4).
// Tres estados: sin fila (o backend viejo que aún no manda `sis`), día completo, día parcial —
// en el parcial importa la hora del último scrape para saber si el sweeper sigue vivo.
export function textoChipSis(sis) {
  if (!sis) return 'SIS · sin lectura';
  if (sis.completo === true) return 'SIS 24/24 ✓';
  const ok = Number.isFinite(Number(sis.periodos_ok)) ? Number(sis.periodos_ok) : 0;
  const hora = horaBogota(sis.scraped_en);
  return hora ? `SIS ${ok}/24 · ${hora}` : `SIS ${ok}/24`;
}

// D-061 L08 (H3/CA-33): identidad de la coordenada que se está leyendo. Cada `refetch` se acuerda
// de con qué (planta, fecha) salió; al volver la respuesta se compara contra la coordenada de
// ahora y, si cambió, se tira. Sin esto, cambiar de fecha mientras vuela el GET de "hoy" deja el
// snapshot de hoy pintado bajo la cabecera de ayer, sin ningún síntoma visible.
export function claveRefetch(plantaId, fecha) {
  return `${plantaId ?? ''}|${fecha ?? ''}`;
}

// ¿El input quedó "vacío"? Es la misma noción que usa la grilla desde D-027: el <input type=number>
// entrega `null` cuando lo borran y `NaN` cuando el texto no parsea, y un 0 tecleado significa
// "esta celda no lleva nada" — no "cero toneladas medidas".
export function esVacioCantidad(cantidad) {
  return cantidad === null || cantidad === undefined || cantidad === ''
    || cantidad === 0 || Number.isNaN(cantidad);
}

// D-061 L08 (H5/CA-34): ¿vaciar/teclear 0 sobre ESTA celda es un no-op?
//
// Desde C6 el backend ya no borra una celda con lectura del SIS que se vacía: la deja viva con
// `cantidad: 0` (el "override 0"). Así que el GET ahora trae celdas en 0 que el snapshot conserva,
// mientras la regla vieja de la grilla las borraba del buffer al teclear 0 → snapshot y buffer
// dejaban de coincidir por un cambio que no cambia nada, y eso encendía Guardar, arrancaba la
// gavela y armaba el `beforeunload` para terminar en "Guardado: 0 nuevos, 0 actualizados".
// Cuando el snapshot ya está en 0, el 0 tecleado debe dejar el buffer igual al snapshot — y con
// eso la celda queda equivalente a la del server (L11/H50, L12/H65) y no queda nada que guardar.
export function esCeroNoOp(cantidad, celdaSnap) {
  if (!esVacioCantidad(cantidad)) return false;
  const c = celdaSnap?.cantidad;
  if (c === null || c === undefined) return false;   // la celda no existe en el snapshot: sí es cambio
  return Number(c) === 0;
}

// D-061 L09 (H24/CA-37): identidad de UNA celda de la grilla dentro del conjunto de "lo que el
// operador tocó". Mismo separador que `claveRefetch` y por el mismo motivo: sin él, (periodo 1,
// combustible 23) y (periodo 12, combustible 3) serían la misma clave.
export function claveCelda(periodo, combustibleId) {
  return `${periodo ?? ''}|${combustibleId ?? ''}`;
}

// D-061 L12 (H73/CA-58): el único clon profundo de la pantalla. El componente tenía su propio
// `deepClone` con este mismo cuerpo; L11 retiró la justificación que las mantenía separadas (la
// comparación por `JSON.stringify` que dependía del orden de claves) y quedaron dos copias sin
// dueño. Son estructuras JSON puras —periodo → combustible → celda—, así que `JSON.parse(
// JSON.stringify(x))` alcanza y además garantiza lo único que importa acá: que el resultado no
// comparta ninguna referencia con el snapshot ni con el buffer previo.
export function clon(x) {
  return JSON.parse(JSON.stringify(x));
}

// D-061 L09 (H24/CA-37): mezcla el snapshot recién leído con lo que el operador tiene a medias.
//
// Es la pieza que le faltaba al refetch preservado de L08. Aquel conservaba el buffer ENTERO
// cuando había una edición en curso, así que las celdas que el SIS creó o cambió mientras el GET
// viajaba quedaban "solo en el snapshot" — y `calcularDiff` las mandaba al POST como si el
// operador las hubiera vaciado. Acá la regla es celda por celda: manda el server, salvo en las
// coordenadas que el operador tocó, donde manda el buffer.
//
// "Tocó" incluye VACIAR: si la clave está en `editadas` y no está en el buffer, la celda tiene que
// desaparecer del resultado aunque el server siga trayéndola — si no, el vaciado se perdería solo.
//
// D-061 L12 (H65/CA-56): `editadas` tiene que venir derivado contra el snapshot VIEJO
// (`coordenadasEditadas(bufferPrev, snapshotViejo)`), que es contra el que el operador editó.
// Derivarlo contra `snapshotNuevo` haría que una celda que el SIS acaba de cambiar pareciera una
// edición del operador y se quedaría anclada al buffer viejo — H24 otra vez, por la puerta de al
// lado. Esta función es, además, la razón por la que la pertenencia se puede derivar: al sembrar el
// resultado desde el snapshot nuevo, deja el buffer difiriendo SOLO donde el operador escribió.
export function reconciliarBuffer(bufferPrev, snapshotNuevo, editadas) {
  const out = clon(snapshotNuevo ?? {});
  for (const clave of editadas ?? []) {
    const { p, cid } = partesClave(clave);
    if (p === null) continue;
    const celdaPrev = bufferPrev?.[p]?.[cid];
    if (celdaPrev === undefined) {
      if (!out[p]) continue;
      delete out[p][cid];
      if (Object.keys(out[p]).length === 0) delete out[p];
    } else {
      if (!out[p]) out[p] = {};
      out[p][cid] = clon(celdaPrev);
    }
  }
  return out;
}

// D-061 L11 (H50/H52 · CA-48/CA-49): ¿esta celda del buffer dice LO MISMO que la del server?
//
// Es la única definición de "cambió" de toda la pantalla, y por eso vive en un solo lugar: la usan
// `calcularDiff` (qué viaja en el POST), `setCelda` (qué coordenada queda marcada como editada) y
// —derivado de ese diff— el "hay cambios sin guardar" que enciende Guardar, la gavela y el
// `beforeunload`. Cuando cada uno tenía su propia idea de "sucio", las tres discrepaban: el botón
// quedaba encendido con un diff vacío y respondía "Sin cambios para guardar" (H52).
//
// Compara SOLO lo que el operador escribe —`cantidad` y `detalle`—, nunca la metadata: un GET que
// vuelve con `modificado_en`/`valor_sis`/`es_override` frescos de una celda editada no es un cambio
// del operador. Dos celdas ausentes son equivalentes (`!b && !s`): teclear y deshacer sobre una
// celda que el server no tiene no deja nada que mandar.
//
// D-061 L12 (H72/CA-55): los dos lados se normalizan ANTES de compararse. Cada campo tiene cuatro
// formas posibles y hasta acá se mezclaban de a pares, en las dos direcciones equivocadas:
//   - `Number()` sobre `cantidad` fundía `null` con `0` (`Number(null) === 0`), así que una celda
//     del snapshot sin cantidad se declaraba igual a un `0` del buffer y la edición se descartaba
//     en silencio: no aparecía en el POST y el operador no se enteraba.
//   - `?? null` sobre `detalle` dejaba `''` y `null` SEPARADOS, así que un `''` del server contra un
//     `null` del buffer marcaba la celda para siempre y la reescribía en cada Guardar.
// Como este predicado gobierna a la vez el botón Guardar, la gavela, el `beforeunload` y el cuerpo
// del POST, un error de coerción acá se propaga a los cuatro de una sola vez.
export function celdaEquivalente(celdaBuffer, celdaSnap) {
  if (!celdaBuffer && !celdaSnap) return true;
  if (!celdaBuffer || !celdaSnap) return false;
  return cantidadNormalizada(celdaBuffer.cantidad) === cantidadNormalizada(celdaSnap.cantidad)
    && detalleNormalizado(celdaBuffer.detalle) === detalleNormalizado(celdaSnap.detalle);
}

// D-061 L12 (H72/CA-55): las TRES formas de "esta celda no lleva cantidad" —clave ausente, `null` y
// cadena vacía— son una sola, y `0` NO es una de ellas: un cero es el "override 0" de C6, un valor
// que el operador puso a propósito y que el server conserva. Un texto que no parsea (`NaN`) también
// cuenta como ausencia, porque es lo que entrega un `<input type=number>` con basura adentro y
// tratarlo como número lo haría distinto de sí mismo.
//
// Lo que NO se normaliza es el número: `'20'` y `20` son el mismo valor porque el driver de MSSQL
// puede entregar un DECIMAL como texto (el mismo motivo por el que `mapCelda` pasa los dos lados de
// `es_override` por `Number`).
function cantidadNormalizada(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// D-061 L12 (H72/CA-55): las tres formas de "esta celda no lleva comentario" —clave ausente, `null`
// y cadena vacía— son una sola. El buffer no siempre trae la clave (una celda nueva nace sin ella)
// y el server puede tener `''` donde el front escribió `null`: sin unificarlas, esa celda queda
// marcada como editada para siempre. Cualquier otro texto se compara tal cual, sin recortar
// espacios: un comentario que empieza con un espacio sigue siendo distinto de uno que no.
function detalleNormalizado(v) {
  if (v === null || v === undefined || v === '') return null;
  return v;
}

// D-061 L12 (H65/CA-56): QUÉ COORDENADAS TIENE EL OPERADOR PENDIENTES, derivado del estado.
//
// Hasta la O4 esto era un conjunto que la grilla acumulaba por eventos: `setCelda` daba de alta y
// de baja, y los demás caminos lo vaciaban. Un conjunto así solo es correcto si TODO camino que
// mueve el mundo se acuerda de depurarlo, y tres olas seguidas encontraron uno que no lo hacía
// (H24 → H50 → H65). Acá la pertenencia no se acumula: se calcula, y por eso no puede quedar vieja.
//
// La definición es una sola línea: una coordenada está pendiente si y solo si su celda del buffer
// NO es equivalente a la del snapshot contra el que se editó. Que eso alcance depende de una
// invariante que sostiene el componente y que es la razón de ser de `reconciliarBuffer`: **el
// buffer solo puede diferir del snapshot donde el operador escribió**. Todo lo que entra al buffer
// entra por `setCelda` (el operador) o por una reconciliación sembrada desde el snapshot (el
// server), así que una escritura del SIS que la grilla haya leído aparece en los dos lados a la vez
// y no produce diferencia. Sin esa invariante, comparar los dos mandaría al POST lo que el SIS
// escribió por debajo — que es exactamente H24, y por lo que L09 introdujo el conjunto explícito.
//
// El "vaciar" del operador (C6) no necesita memoria aparte: una celda ausente del buffer que el
// snapshot SÍ tiene es un vaciado pendiente, y una celda ausente de los dos lados no es nada. Quien
// se acuerda de que la celda existía es el snapshot, no el conjunto.
//
// OJO con el marco de referencia: cuando entra un snapshot nuevo hay que derivar contra el VIEJO,
// que es contra el que el operador editó. Derivar contra el nuevo confundiría "lo cambió el
// operador" con "lo cambió el server", que es de donde salió H24.
export function coordenadasEditadas(buffer, snapshot) {
  const out = new Set();
  recorrerCoordenadas(buffer, snapshot, (clave, b, s) => {
    if (!celdaEquivalente(b, s)) out.add(clave);
    return false;
  });
  return out;
}

// D-061 L12 (H66/H74 · CA-57): ¿hay algo sin guardar? Misma definición que `coordenadasEditadas` —
// no una parecida—, pero corta en la primera coordenada que difiere.
//
// Antes esto se respondía armando el diff entero y ORDENÁNDOLO para mirarle el largo, en cada tecla
// (H74). Y sobre todo: se respondía leyendo un conjunto mutable que el memo del componente no podía
// ver cambiar, así que dependía de una invariante escrita en un comentario ("toda mutación del
// conjunto va acompañada de un `setBuffer`") que un solo camino incumplía (H66). Derivado de
// `(buffer, snapshot)` no hay invariante que recordar: las mismas dos entradas dan la misma
// respuesta que el diff, siempre.
export function hayEdicion(buffer, snapshot) {
  return recorrerCoordenadas(buffer, snapshot, (_clave, b, s) => !celdaEquivalente(b, s));
}

// D-061 L09 (H24/CA-37): qué celdas van en el body del POST. Recorre `editadas`, NO la unión de
// buffer y snapshot: una celda que el operador nunca tocó no puede viajar al server, ni siquiera
// cuando el SIS la cambió por debajo entre el GET y el Guardar. Ese era el camino por el que un
// Guardar inocente borraba —o convertía en override 0 a nombre del operador— una lectura recién
// escrita, que la ownership de D-029 ya no repone.
//
// D-061 L12: el conjunto que recibe ya no se acumula, se deriva (`coordenadasEditadas`). La firma
// no cambia: sigue tomándolo por parámetro para poder probarse con conjuntos armados a mano, y para
// que el componente lo calcule UNA vez por Guardar en vez de una por tecla.
//
// Las tres formas del diff se conservan tal cual las lee el backend (C6):
//   solo en snapshot ⇒ `cantidad: null`  (vaciar: override 0 si hay lectura SIS, DELETE si no)
//   solo en buffer   ⇒ INSERT
//   en ambos, distintas ⇒ UPDATE
// Sale ordenado por periodo y combustible para que el body no dependa del orden en que se tecleó.
export function calcularDiff(buffer, snapshot, editadas) {
  const out = [];
  for (const clave of editadas ?? []) {
    const { p, cid } = partesClave(clave);
    if (p === null) continue;
    const b = buffer?.[p]?.[cid];
    const s = snapshot?.[p]?.[cid];
    if (celdaEquivalente(b, s)) continue;        // se tecleó y quedó igual: no hay nada que mandar
    const periodo = Number(p);
    const combustible_id = Number(cid);
    if (!b) out.push({ periodo, combustible_id, cantidad: null });
    else out.push({ periodo, combustible_id, cantidad: b.cantidad, detalle: b.detalle ?? null });
  }
  out.sort((x, y) => x.periodo - y.periodo || x.combustible_id - y.combustible_id);
  return out;
}

// Caja del popover del override, en px, tal como la deja el CSS: `max-width:280px` y una altura
// de ~110px (dos renglones de texto + el botón Revertir + padding). Se redondea hacia ARRIBA a
// propósito: sobrestimar hace que el popover se voltee un poco antes de lo necesario —molestia
// cero—, mientras que subestimar lo deja recortado contra el borde de `.comb-scroll`, que es
// justo el defecto que esto viene a cerrar.
export const ALTO_TIP = 120;
export const ANCHO_TIP = 280;

// D-061 L09 (H26/CA-39): ¿hacia dónde abre el popover? Se decide MIDIENDO, no por el número de
// periodo ni por el índice de columna.
//
// L08 lo resolvió con `p >= 19` (abre arriba) e `idx >= nAlim - 2` (abre a la izquierda). Eso
// funciona solo si la tabla está sin desplazar: `.comb-scroll` muestra ~10-12 filas de 24, así que
// basta con bajar un poco para que P19 quede pegado al borde SUPERIOR y su popover abra hacia
// arriba contra el `thead` sticky — el mismo recorte de H13, espejado. Y al revés: en una pantalla
// ancha, el popover del último alimentador cabe de sobra hacia la derecha y no hay razón para
// voltearlo.
//
// La función es pura y recibe los dos rects ya medidos (los `DOMRect` del banderín y de
// `.comb-scroll`) para que se pueda probar sin layout: jsdom devuelve ceros en
// `getBoundingClientRect`, y por eso un contenedor degenerado cae al default (abajo-derecha, que
// es lo que dice el CSS base) en vez de inventar una decisión.
//
// Voltea solo cuando el lado por defecto NO alcanza Y el opuesto tiene más aire: contra un
// contenedor más chico que el popover, quedarse donde está es al menos predecible.
//
// D-061 L11 (H54/CA-51): `margenArriba` y `margenIzquierda` son lo que la CABECERA y la PRIMERA
// COLUMNA pegajosas tapan del recuadro. Sin descontarlas, los ~34 px del `thead`
// (`position:sticky; top:0`) contaban como espacio libre y un popover volteado hacia arriba se
// pintaba ENCIMA de los nombres de columna —gana por `z-index:5` contra el `2` del `thead`—, que es
// exactamente el recorte que voltearlo venía a evitar. Entran por parámetro y no se leen del DOM:
// la función sigue siendo pura y probable sin layout; quien mide es el componente.
export function ladoPopover({
  banderin, contenedor, alto = ALTO_TIP, ancho = ANCHO_TIP,
  margenArriba = 0, margenIzquierda = 0,
} = {}) {
  const quieto = { arriba: false, izq: false };
  if (!banderin || !contenedor) return quieto;
  if (!(contenedor.bottom - contenedor.top > 0) || !(contenedor.right - contenedor.left > 0)) {
    return quieto;
  }
  // El popover nace pegado al banderín: hacia abajo crece desde su borde inferior, hacia arriba
  // desde el superior; hacia la derecha desde su borde izquierdo (`left:0`) y hacia la izquierda
  // desde el derecho (`right:0`). Abajo y a la derecha no hay nada pegajoso que descontar.
  const libreAbajo = contenedor.bottom - banderin.bottom;
  const libreArriba = banderin.top - (contenedor.top + margenArriba);
  const libreDerecha = contenedor.right - banderin.left;
  const libreIzquierda = banderin.right - (contenedor.left + margenIzquierda);
  return {
    arriba: libreAbajo < alto && libreArriba > libreAbajo,
    izq: libreDerecha < ancho && libreIzquierda > libreDerecha,
  };
}

// --- internos ---------------------------------------------------------------------------------

// `"3|1"` → `{ p: '3', cid: '1' }`. Se parte por el PRIMER separador (no con `split`) para que un
// id con un '|' adentro no se coma la clave en silencio.
function partesClave(clave) {
  if (typeof clave !== 'string') return { p: null, cid: null };
  const i = clave.indexOf('|');
  if (i <= 0) return { p: null, cid: null };
  return { p: clave.slice(0, i), cid: clave.slice(i + 1) };
}

// Recorre la UNIÓN de coordenadas de `buffer` y `snapshot` —periodo por periodo, combustible por
// combustible— y llama a `fn(clave, celdaBuffer, celdaSnap)` en cada una. Si `fn` devuelve `true`
// corta ahí y el recorrido devuelve `true`; si termina sin que nadie corte, devuelve `false`.
//
// La unión y no solo las claves del buffer: una celda que el operador vació desaparece del buffer y
// sigue estando en el snapshot, y ese vaciado es una edición pendiente que tiene que viajar (C6).
function recorrerCoordenadas(buffer, snapshot, fn) {
  const b = buffer ?? {};
  const s = snapshot ?? {};
  for (const p of new Set([...Object.keys(b), ...Object.keys(s)])) {
    const filaB = b[p] ?? {};
    const filaS = s[p] ?? {};
    for (const cid of new Set([...Object.keys(filaB), ...Object.keys(filaS)])) {
      if (fn(claveCelda(p, cid), filaB[cid], filaS[cid])) return true;
    }
  }
  return false;
}

// Partes de fecha/hora en Bogotá con `timeZone` explícito (convención de TZ del workspace: la BD
// guarda UTC, la presentación fija la zona). Se arma con `formatToParts` en vez de `format()`
// porque el separador y el orden de `es-CO` cambian entre versiones de ICU y el contrato pide
// exactamente 'dd/MM/yyyy HH:mm'.
function partesBogota(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const partes = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const { type, value } of partes) p[type] = value;
  // Con hour12:false algunos ICU devuelven '24' a medianoche (mismo caso que utils/fecha.js).
  if (p.hour === '24') p.hour = '00';
  return p;
}

function fechaHoraBogota(iso) {
  const p = partesBogota(iso);
  if (!p) return null;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

function horaBogota(iso) {
  const p = partesBogota(iso);
  if (!p) return null;
  return `${p.hour}:${p.minute}`;
}
