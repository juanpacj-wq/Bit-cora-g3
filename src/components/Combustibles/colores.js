// D-033: tokens del heatmap de Combustibles (look "Blueprint Heatmap").
// Mismo patrón que Disponibilidad/colores.js: los hex viven acá para los estilos
// dinámicos (tinte por celda) y se comparten con la leyenda del header, de modo que
// leyenda y tinte SIEMPRE coincidan (el blueprint original los tenía desincronizados).

// Fallback del máximo operativo de carga de carbón por alimentador y periodo. 25 Ton es el
// tope físico por celda (0 = mínimo). Desde D-034 el máximo real es data-driven: viene de
// lov_bit.combustible.cantidad_max y se pasa a tint() como argumento; esta constante solo
// aplica si el catálogo no trae el dato. Escala FIJA (no dinámica): un mismo tono = la misma
// carga en cualquier fecha → comparable día a día.
export const HEATMAP_MAX_TON = 25;

// Rampa de 5 tramos (bajo → alto). Único origen de verdad: lo consume tint() y la leyenda.
export const HEATMAP_RAMP = ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa'];

// Color de fondo del heatmap para un valor de celda. Vacío / 0 / no-finito → sin tinte.
// t se normaliza contra `max` (cantidad_max del alimentador, D-034) y se clipea a [0,1],
// luego cae en uno de 5 tramos.
export function tint(val, max = HEATMAP_MAX_TON) {
  if (val === '' || val === null || val === undefined) return 'transparent';
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n === 0) return 'transparent';
  const tope = Number.isFinite(max) && max > 0 ? max : HEATMAP_MAX_TON;
  const t = Math.min(n / tope, 1);
  if (t < 0.2) return HEATMAP_RAMP[0];
  if (t < 0.4) return HEATMAP_RAMP[1];
  if (t < 0.6) return HEATMAP_RAMP[2];
  if (t < 0.8) return HEATMAP_RAMP[3];
  return HEATMAP_RAMP[4];
}
