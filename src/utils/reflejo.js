// D-063 L06 (RQ-02.12) — Vocabulario del ASIENTO REFLEJADO, en un solo módulo.
//
// Estos helpers los comparten la grilla de Sala (`RegistroRow` en `BitacorasGecelca3.jsx`) y la
// tabla de Históricos (`components/historicos/HistoricoTable.jsx`). En la O1 nacieron dentro de
// `HistoricoTable.jsx` (era el único territorio del lote que los necesitaba) y quedaron con DOS
// parsers de `campos_extra` y TRES formateadores `dd/mm/aaaa HH:mm` en el repo (GATE-O1 H4/H11).
// Un predicado copiado es exactamente el drift que persigue `guard_marcador_reflejo.test.js`:
// acá viven una vez y las dos vistas los importan. Módulo PURO — sin React salvo `ChipAnulado`,
// sin fetch, sin estado.
import { createElement as h } from 'react';
import { Ban } from 'lucide-react';

// `campos_extra` llega como string JSON (`GET /activos`, `v_historico_busqueda`), como objeto (ya
// parseado por quien llama) o null. El contrato C2 dice que SIEMPRE es un objeto JSON, así que
// cualquier otra forma —array (`[1]`), número (`7`), string suelta (`'x'`), JSON roto— es dato
// corrupto y vale `{}`: nunca explota y nunca marca una fila por accidente. Sustituye a las dos
// versiones de la O1, que diferían justo en ese borde (la de la grilla devolvía el array/número
// tal cual y `{...[1]}` habría inventado la clave `'0'`).
export function parseCamposExtra(ce) {
  if (!ce) return {};
  if (typeof ce === 'object') return Array.isArray(ce) ? {} : ce;
  try {
    const v = JSON.parse(ce);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Marcador UNIVERSAL (D-063 C3): una fila es asiento reflejado ⇔ `origen_bitacora` es una cadena
// no vacía ('MAND' | 'DISP'). El puntero al origen (`origen_lote_id` / `origen_disponibilidad_id`)
// es dato del backend, NUNCA criterio del front: un `origen_lote_id` suelto no marca nada.
// Anulado ⇔ `anulado` es un objeto (lo escribe "deshacer" en Disponibilidad: quién y cuándo).
export function estadoReflejo(camposExtra) {
  const campos = parseCamposExtra(camposExtra);
  const reflejado = typeof campos.origen_bitacora === 'string' && campos.origen_bitacora.trim() !== '';
  const a = campos.anulado;
  const anulado = a && typeof a === 'object' && !Array.isArray(a) ? a : null;
  return { reflejado, anulado };
}

// `dd/mm/aaaa HH:mm` en Bogotá explícito (D-020), armado por partes para no depender del literal
// que cada ICU mete entre fecha y hora (es-CO devuelve "27/08/2026, 15:15"). `hourCycle:'h23'`
// evita el "24:05" de medianoche que da `hour12:false` en algunos Node.
const FECHA_HORA_BOGOTA_FMT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function fechaHoraBogota(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = {};
  for (const { type, value } of FECHA_HORA_BOGOTA_FMT.formatToParts(d)) p[type] = value;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// Tooltip del chip "Anulado": quién deshizo (nombre, o "usuario <id>" si el snapshot no lo trae),
// su cargo si lo hay y cuándo en Bogotá. Mismo texto en la grilla y en Históricos.
export function tituloAnulado(anulado) {
  const a = anulado || {};
  const quien = a.nombre || (a.por != null ? `usuario ${a.por}` : 'un usuario');
  const cargo = a.cargo ? ` (${a.cargo})` : '';
  const cuando = fechaHoraBogota(a.en);
  return `Deshecho por ${quien}${cargo}${cuando ? ` el ${cuando}` : ''}`;
}

// Tooltip del chip de ORIGEN, honesto en los dos estados (GATE-O1 H9). La promesa "se actualiza
// sola" solo vale mientras el evento de origen existe: en una copia ANULADA el origen ya se
// deshizo, no hay nada allá que corregir y esta fila se queda como constancia del turno. Prometer
// lo contrario mandaba al operador a buscar en Disponibilidad un evento que ya no está.
// El nombre del origen lo resuelve el backend del catálogo (D-052): acá nunca se hardcodea.
export function tituloOrigen(origenNombre, anulado) {
  const donde = `Asiento generado en ${origenNombre}.`;
  return anulado
    ? `${donde} Su evento se deshizo allá; esta copia se conserva como constancia del turno.`
    : `${donde} Corrígelo allá y esta copia se actualiza sola.`;
}

// El detalle de una copia anulada se conserva (no se borra) tachado y atenuado. Las clases viven
// acá para que la grilla y Históricos no las deletreen cada una por su lado.
export const CLASES_DETALLE_ANULADO = 'line-through text-gray-400';
export const CLASES_DETALLE_VIVO = 'text-gray-700';

// Chip "Anulado" (hermano del chip de origen de D-058, en rojo suave). `compacto` usa el tamaño de
// los badges de la tabla de Históricos y muestra siempre el rótulo; sin él, el tamaño de los chips
// de la grilla (rótulo oculto en pantallas angostas, como "Bloqueado").
export function ChipAnulado({ anulado, compacto = false }) {
  const tamano = compacto ? 'px-2 py-0.5 rounded-md' : 'px-2.5 py-1.5 rounded-lg';
  return h(
    'span',
    {
      className: `inline-flex items-center gap-1.5 ${tamano} text-xs font-medium text-red-700 bg-red-50`,
      title: tituloAnulado(anulado),
    },
    h(Ban, { size: 14 }),
    h('span', { className: compacto ? '' : 'hidden sm:inline' }, 'Anulado'),
  );
}
