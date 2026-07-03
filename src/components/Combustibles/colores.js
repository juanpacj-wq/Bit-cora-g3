// D-033: tokens del heatmap de Combustibles (look "Blueprint Heatmap").
// Mismo patrón que Disponibilidad/colores.js: los hex viven acá para los estilos
// dinámicos (tinte por celda) y se comparten con la leyenda del header, de modo que
// leyenda y tinte SIEMPRE coincidan (el blueprint original los tenía desincronizados).
// La rampa se tematiza por unidad (temaHeatmap): azul = GEC3, verde = GEC32.

// Fallback del tope físico por tipo de combustible si el catálogo no trae cantidad_max
// (D-034: el máximo real es data-driven, viene de lov_bit.combustible.cantidad_max y se
// pasa a tint() como argumento). Escala FIJA por tipo (no dinámica): un mismo tono = la
// misma carga en cualquier fecha → comparable día a día. El heatmap aplica a los 3 tipos.
export const HEATMAP_MAX_FALLBACK = { ALIMENTADOR: 25, CALIZA: 40, ACPM: 25000 };
export const HEATMAP_MAX_TON = HEATMAP_MAX_FALLBACK.ALIMENTADOR;

// Rampas de 5 tramos (bajo → alto). Único origen de verdad: las consume tint() y la leyenda.
export const HEATMAP_RAMP = ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa'];
export const HEATMAP_RAMP_VERDE = ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399'];

// Tema del heatmap por unidad: rampa (leyenda y tint comparten esta misma referencia,
// garantía D-033) y acento (--accent del CSS: focus de celdas y botón Hoy). GEC32 = verde;
// cualquier otra planta (GEC3, TST, undefined) cae al azul actual.
export function temaHeatmap(plantaId) {
  if (plantaId === 'GEC32') return { rampa: HEATMAP_RAMP_VERDE, accent: '#059669' };
  return { rampa: HEATMAP_RAMP, accent: '#2563eb' };
}

// Color de fondo del heatmap para un valor de celda. Vacío / 0 / no-finito → sin tinte.
// t se normaliza contra `max` (cantidad_max del combustible, D-034) y se clipea a [0,1],
// luego cae en uno de 5 tramos de `ramp` (rampa del tema por unidad).
export function tint(val, max = HEATMAP_MAX_TON, ramp = HEATMAP_RAMP) {
  if (val === '' || val === null || val === undefined) return 'transparent';
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n === 0) return 'transparent';
  const tope = Number.isFinite(max) && max > 0 ? max : HEATMAP_MAX_TON;
  const t = Math.min(n / tope, 1);
  if (t < 0.2) return ramp[0];
  if (t < 0.4) return ramp[1];
  if (t < 0.6) return ramp[2];
  if (t < 0.8) return ramp[3];
  return ramp[4];
}
