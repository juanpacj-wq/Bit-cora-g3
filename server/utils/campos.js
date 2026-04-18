function parseJSON(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

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
  const normalized = { ...input };

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
      }
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
