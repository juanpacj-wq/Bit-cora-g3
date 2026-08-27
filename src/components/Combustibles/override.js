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
// Cuando el snapshot ya está en 0, el 0 tecleado debe dejar el buffer igual al snapshot.
export function esCeroNoOp(cantidad, celdaSnap) {
  if (!esVacioCantidad(cantidad)) return false;
  const c = celdaSnap?.cantidad;
  if (c === null || c === undefined) return false;   // la celda no existe en el snapshot: sí es cambio
  return Number(c) === 0;
}

// --- internos ---------------------------------------------------------------------------------

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
