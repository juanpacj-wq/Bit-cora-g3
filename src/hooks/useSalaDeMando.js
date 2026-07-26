import { useCallback, useState } from 'react';
import { api } from './useApi';

// Hook de Operación 24h (MAND). D-056: la grilla dejó de ser un espejo persistente y pasó a ser un
// formulario de captura append-only, así que el pivote `GET /api/sala-de-mando` (que devolvía "un
// valor por celda") desapareció junto con `getGrilla`. Quedan el batch de captura y el listado del
// día agrupado por lote; D-057 le suma al listado la CORRECCIÓN y el BORRADO, siempre por lote
// (nunca por celda suelta: la unidad de sentido es la llamada al CND).
export function useSalaDeMando() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // `fecha` es opcional: el backend usa hoy Bogotá por defecto.
  const getLotes = useCallback(async (planta_id, fecha) => {
    const qs = new URLSearchParams({ planta_id });
    if (fecha) qs.set('fecha', fecha);
    return await api.get(`/api/sala-de-mando/lotes?${qs}`);
  }, []);

  const guardarBatch = useCallback(async ({ planta_id, fecha, filas }) => {
    setLoading(true); setError(null);
    try {
      const r = await api.post('/api/sala-de-mando/guardar', { planta_id, fecha, filas });
      // Aviso al consumidor de counts (useBitacoraCounts) que refresque inmediatamente.
      // Fallback redundante al broadcast WS — garantiza que el badge MAND se actualice
      // sin esperar al snapshot del WebSocket.
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  // D-057 — corrección por lote. El `tipo` NO viaja: es inmutable (decisión 11), y equivocarse de
  // tipo se arregla eliminando el lote y volviéndolo a registrar en la grilla.
  const editarLote = useCallback(async (lote_id, { planta_id, hora, detalle, funcionariocnd, periodos }) => {
    setLoading(true); setError(null);
    try {
      const r = await api.put(`/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}`, {
        planta_id, hora, detalle, funcionariocnd, periodos,
      });
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      // El error se propaga TAL CUAL: `e.errores` (el arreglo de validaciones del backend) y
      // `e.codigo` son lo que el modal necesita para pintar celda por celda. Envolverlo lo perdería.
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  // `planta_id` va por query string, no en el body: un DELETE no lleva body fiable (fetch lo permite,
  // pero proxies e intermediarios pueden descartarlo).
  const eliminarLote = useCallback(async (lote_id, planta_id) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ planta_id });
      const r = await api.del(`/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}?${qs}`);
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, getLotes, guardarBatch, editarLote, eliminarLote };
}
