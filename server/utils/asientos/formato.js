// D-058 — Convenciones canónicas del texto de los asientos de operación.
// Especificación literal: §4 de `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md`.
//
// Módulo PURO: sin BD, sin reloj, sin red. Entra un dato plano, sale un fragmento de texto.
// Esta es la mitad "vocabulario" del motor; las frases completas viven en `plantillas.js`.
//
// Por qué el vocabulario existe UNA sola vez: el mismo texto lo consumen el listado del día
// (REQ-04 §8.1), el reflejo a las bitácoras de Sala (REQ-02) y el libro mensual F03 (REQ-06).
// Si cada consumidor armara la frase, las tres salidas divergirían — que es exactamente el
// problema documentado en el F03 real de enero: nueve formas de escribir la unidad, cuatro los
// MW y cinco los periodos (§3 del insumo).

// Anti-duplicado del prefijo de unidad en los renglones de Sala: si el texto del ingeniero ya
// arranca nombrando la unidad, no se prefija. Sin esto salen renglones como `GEC3 — G3.0
// sincronizada.` (el 40 % de los eventos libres de enero arranca con la unidad).
// Cubre la nomenclatura del papel además de la canónica: `G3.0`, `G3,0`, `G30`, `UG3.2`, `UG32`…
export const UNIDAD_YA_NOMBRADA = /^\s*(GEC3\b|GEC32\b|U?G\s?3[.,]?[02]\b)/i;

// La unidad se nombra SIEMPRE `GEC3` / `GEC32` (decisión B): el mismo nombre de la BD, de los
// permisos y del contrato cross-repo. Se descarta el `G3.0`/`G3.2` del papel a propósito — dos
// nomenclaturas conviviendo es lo que produjo las nueve variantes de §3(a).
//
// Hoy es la identidad (el `planta_id` ya ES el nombre canónico) y existe como la ÚNICA costura
// donde se decide cómo se nombra una unidad en un asiento. NO valida contra el catálogo ni lanza:
// el motor es puro, así que `'TST'` —o cualquier otra— sale tal cual.
export function unidadCanonica(planta_id) {
  return String(planta_id ?? '').trim();
}

// `150 MW`: entero, con espacio antes de la unidad.
// Es POTENCIA POR PERIODO, no energía: jamás emitir `MWh`. El F03 lo escribe mal en casi todas
// sus filas (§3(b)) y esa confusión es parte de lo que D-058 viene a normalizar.
// `0 MW` SÍ es un valor válido (el redespacho plano a cero del 06/01 es un caso real), así que el
// vacío se descarta ANTES de convertir: `Number(null)` es 0 y publicaría un cero que nadie escribió.
export function potenciaMW(valor) {
  if (valor == null || valor === '') return '';
  const n = Number(valor);
  if (!Number.isFinite(n)) return '';
  return `${Math.round(n)} MW`;
}

// `P20` (suelto) · `P17 al P19` (contiguo) · `P3, P7 y P19` (no contiguos: coma y la última con
// ` y `). Ordena ascendente y deduplica: el orden del arreglo de entrada no es parte del dato.
export function listaPeriodos(nums) {
  const ordenados = periodosOrdenados(nums);
  if (!ordenados.length) return '';
  if (ordenados.length === 1) return `P${ordenados[0]}`;
  if (esContiguo(ordenados)) return `P${ordenados[0]} al P${ordenados[ordenados.length - 1]}`;
  const etiquetas = ordenados.map((n) => `P${n}`);
  return `${etiquetas.slice(0, -1).join(', ')} y ${etiquetas[etiquetas.length - 1]}`;
}

// Tramo preposicional que acompaña a la potencia en la forma compacta.
// El insumo fija solo el caso frecuente —el rango contiguo, `del P17 al P19`—, así que las otras
// dos formas se resuelven acá para que la frase quede bien escrita: `del P3, P7 y P19` sería
// agramatical, y `del P20` chirría frente al `en el periodo 20` que usa el papel.
function tramoPeriodos(ordenados) {
  const lista = listaPeriodos(ordenados);
  if (!lista) return '';
  if (ordenados.length === 1) return `en el ${lista}`;
  return esContiguo(ordenados) ? `del ${lista}` : `en los ${lista}`;
}

// Regla de compactación (§4): si TODAS las celdas del lote comparten el mismo valor → forma
// compacta (`150 MW del P17 al P19`); si difieren → lista con valor por periodo
// (`P17: 109 MW; P18: 134 MW; P19: 164 MW`, calcado del texto real del 27/01).
// Lo decide el sistema con el dato que ya tiene; el operador no elige.
//
// `periodos` = `[{ periodo, valor_mw }]`, tal cual lo agrupa `GET /api/sala-de-mando/lotes`.
export function carga(periodos) {
  const celdas = celdasOrdenadas(periodos);
  if (!celdas.length) return '';
  const valores = new Set(celdas.map((c) => Math.round(c.valor_mw)));
  if (valores.size === 1) {
    return `${potenciaMW(celdas[0].valor_mw)} ${tramoPeriodos(celdas.map((c) => c.periodo))}`.trim();
  }
  return celdas.map((c) => `P${c.periodo}: ${potenciaMW(c.valor_mw)}`).join('; ');
}

function esContiguo(ordenados) {
  return ordenados[ordenados.length - 1] - ordenados[0] === ordenados.length - 1;
}

// El periodo del dominio es 1..24: el `>= 1` descarta el `P0` que produciría un `null` colado
// (`Number(null)` es 0 y pasa el `isInteger`).
function periodosOrdenados(nums) {
  const limpios = (nums ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 1);
  return [...new Set(limpios)].sort((a, b) => a - b);
}

// Las celdas sin periodo entero o sin valor numérico se descartan en silencio: el motor no valida
// —eso ya lo hicieron el endpoint y el CHECK de la BD— pero tampoco emite `NaN MW`… ni un `0 MW`
// inventado a partir de un `null`.
function celdasOrdenadas(periodos) {
  return (periodos ?? [])
    .map((p) => ({
      periodo: Number(p?.periodo),
      valor_mw: p?.valor_mw == null || p?.valor_mw === '' ? NaN : Number(p.valor_mw),
    }))
    .filter((c) => Number.isInteger(c.periodo) && c.periodo >= 1 && Number.isFinite(c.valor_mw))
    .sort((a, b) => a.periodo - b.periodo);
}
