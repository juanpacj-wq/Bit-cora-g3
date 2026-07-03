function parseJSON(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// AUD-39 (BIT-AUDSEG-2026-001): topes de tamaño contra abuso/DoS y mass-assignment.
const MAX_STR_LEN = 5000;          // longitud máxima por string de texto libre
const MAX_JSON_BYTES = 100 * 1024; // tope del JSON serializado completo (100 KB)

export function validateCamposExtra(definicionJSON, camposExtraRaw) {
  const def = parseJSON(definicionJSON);
  if (!def) return { ok: true, data: null, definicion: null, errors: [] };

  let input;
  try {
    input = camposExtraRaw ? (parseJSON(camposExtraRaw) ?? {}) : {};
  } catch {
    return { ok: false, errors: ['campos_extra no es JSON válido'], data: null, definicion: def };
  }

  const errors = [];
  // AUD-39: NO `{ ...input }`. Construimos `normalized` SOLO con los campos declarados en `def`
  // para descartar cualquier clave extra (mass-assignment). Las claves no declaradas se ignoran.
  const normalized = {};

  for (const campo of def) {
    if (campo.tipo === 'auto') continue;
    const v = input[campo.campo];
    if (campo.requerido && (v === undefined || v === null || v === '')) {
      errors.push(`${campo.campo} es requerido`);
      continue;
    }
    if (v === undefined || v === null || v === '') continue;

    if (campo.tipo === 'int') {
      const n = Number.isInteger(v) ? v : parseInt(v, 10);
      if (Number.isNaN(n) || !Number.isFinite(n)) {
        errors.push(`${campo.campo} debe ser entero`);
        continue;
      }
      if (campo.min !== undefined && n < campo.min) errors.push(`${campo.campo} < ${campo.min}`);
      if (campo.max !== undefined && n > campo.max) errors.push(`${campo.campo} > ${campo.max}`);
      normalized[campo.campo] = n;
    } else if (campo.tipo === 'float') {
      const f = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(f) || !Number.isFinite(f)) {
        errors.push(`${campo.campo} debe ser numérico`);
        continue;
      }
      if (campo.min !== undefined && f < campo.min) errors.push(`${campo.campo} < ${campo.min}`);
      if (campo.max !== undefined && f > campo.max) errors.push(`${campo.campo} > ${campo.max}`);
      normalized[campo.campo] = f;
    } else if (campo.tipo === 'select') {
      if (!Array.isArray(campo.opciones) || !campo.opciones.includes(v)) {
        errors.push(`${campo.campo} fuera de opciones`);
        continue;
      }
      normalized[campo.campo] = v;
    } else {
      // Texto libre u otros tipos declarados: tope de longitud para strings.
      if (typeof v === 'string' && v.length > MAX_STR_LEN) {
        errors.push(`${campo.campo} excede ${MAX_STR_LEN} caracteres`);
        continue;
      }
      normalized[campo.campo] = v;
    }
  }

  // AUD-39: tope de bytes del JSON serializado total (defensa adicional ante muchos campos).
  if (errors.length === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    if (bytes > MAX_JSON_BYTES) {
      errors.push(`campos_extra excede ${MAX_JSON_BYTES} bytes`);
    }
  }

  return { ok: errors.length === 0, errors, data: normalized, definicion: def };
}

export function computeCamposAuto(definicion, valores) {
  if (!Array.isArray(definicion)) return valores || {};
  const out = { ...(valores || {}) };
  for (const campo of definicion) {
    if (campo.tipo !== 'auto') continue;
    if ('valor' in campo) {
      out[campo.campo] = campo.valor;
    } else if (campo.regla && typeof campo.regla === 'object') {
      const fuente = definicion.find(c => c.tipo !== 'auto' && c.campo in out);
      if (fuente) out[campo.campo] = campo.regla[out[fuente.campo]] ?? null;
    }
  }
  return out;
}
