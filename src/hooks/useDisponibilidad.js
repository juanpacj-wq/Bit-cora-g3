import { useCallback, useMemo } from 'react';
import { api } from './useApi';

// useApi.api hace `throw new Error(data.error)` y descarta el body — para los 409
// del flujo DISP necesitamos el `vigente` (mismo_estado / fecha_anterior_a_vigente)
// y el `n_menos_1` (mismo_estado_que_anterior). Wrapper local que adjunta el body
// al Error para que el modal pueda construir popups específicos. Autenticación por cookie
// Entra (credentials:'include'), igual que useApi.
// Etiqueta amigable cuando el backend está caído / la red no tiene ruta (fetch rechaza con un
// TypeError crudo). `.body.mensaje` es lo que lee CambiarEstadoModal.buildPopup en su rama default.
const MSG_SIN_CONEXION_DISP = 'No se pudo contactar al servidor. Verifica tu conexión a la red corporativa e intenta de nuevo.';

async function requestWithBody(url, { method = 'POST', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error(MSG_SIN_CONEXION_DISP);
    err.status = 0;
    err.codigo = 'sin_conexion';
    err.body = { error: MSG_SIN_CONEXION_DISP, codigo: 'sin_conexion', mensaje: MSG_SIN_CONEXION_DISP };
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `data.error`/`data.mensaje` ya vienen saneados por el backend para los 5xx; los 409 de DISP
    // traen además `codigo`/`vigente`/`n_menos_1` que buildPopup usa para popups específicos.
    const err = new Error(data.error || data.mensaje || `Error ${res.status}`);
    err.status = res.status;
    err.codigo = data.codigo;
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

  // D-024/D-026: acumulado histórico por estado (tiempo_ms) + `ahora` (reloj del server).
  // Sin desde/hasta → ventana = toda la historia de la planta. Alimenta el panel de
  // acumulados; el estado vigente crece en vivo client-side reusando el tick de TiempoEnEstado.
  const getMetricas = useCallback(
    (planta_id) =>
      api.get(`/api/disponibilidad/metricas?planta_id=${encodeURIComponent(planta_id)}`),
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
    () => ({ getEstado, getMetricas, crear, editar, deshacer }),
    [getEstado, getMetricas, crear, editar, deshacer]
  );
}
