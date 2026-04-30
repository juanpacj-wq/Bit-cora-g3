import { useCallback, useMemo } from 'react';
import { api } from './useApi';

const STORAGE_KEY = 'bitacoras_auth';

function getSesionId() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { sesion } = JSON.parse(raw);
    return sesion?.sesion_id ?? null;
  } catch {
    return null;
  }
}

// useApi.api hace `throw new Error(data.error)` y descarta el body — para los 409
// del flujo DISP necesitamos el `vigente` (mismo_estado / fecha_anterior_a_vigente)
// y el `n_menos_1` (mismo_estado_que_anterior). Wrapper local que adjunta el body
// al Error para que el modal pueda construir popups específicos.
async function requestWithBody(url, { method = 'POST', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const sid = getSesionId();
  if (sid != null) headers['X-Sesion-Id'] = String(sid);
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.mensaje || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function useDisponibilidad(dispBitacoraId) {
  const getEstado = useCallback(
    (planta_id, { historial_limit = 20, historial_offset = 0 } = {}) => {
      const qs = new URLSearchParams({
        planta_id,
        historial_limit: String(historial_limit),
        historial_offset: String(historial_offset),
      });
      return api.get(`/api/disponibilidad?${qs.toString()}`);
    },
    []
  );

  const crear = useCallback(
    ({ planta_id, evento, codigo, fecha_inicio_estado, detalle }) => {
      if (!dispBitacoraId) throw new Error('bitacora_id de DISP no resuelto');
      return requestWithBody('/api/registros', {
        method: 'POST',
        body: {
          bitacora_id: dispBitacoraId,
          planta_id,
          fecha_evento: fecha_inicio_estado,
          detalle: detalle || null,
          campos_extra: { evento, codigo, fecha_inicio_estado },
        },
      });
    },
    [dispBitacoraId]
  );

  const editar = useCallback(
    (registro_id, { evento, codigo, fecha_inicio_estado, detalle }) => {
      const campos_extra = {};
      if (evento !== undefined) campos_extra.evento = evento;
      if (codigo !== undefined) campos_extra.codigo = codigo;
      if (fecha_inicio_estado !== undefined) campos_extra.fecha_inicio_estado = fecha_inicio_estado;
      const body = { campos_extra };
      if (detalle !== undefined) body.detalle = detalle || null;
      if (fecha_inicio_estado !== undefined) body.fecha_evento = fecha_inicio_estado;
      return requestWithBody(`/api/registros/${registro_id}`, { method: 'PUT', body });
    },
    []
  );

  const deshacer = useCallback(
    (planta_id) =>
      requestWithBody('/api/disponibilidad/deshacer', {
        method: 'POST',
        body: { planta_id },
      }),
    []
  );

  return useMemo(
    () => ({ getEstado, crear, editar, deshacer }),
    [getEstado, crear, editar, deshacer]
  );
}
