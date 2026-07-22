import { useCallback, useState } from 'react';
import { api } from './useApi';

// Hook de Operación 24h (MAND). D-056: la grilla dejó de ser un espejo persistente y pasó a ser un
// formulario de captura append-only, así que el pivote `GET /api/sala-de-mando` (que devolvía "un
// valor por celda") desapareció junto con `getGrilla`. Quedan dos operaciones: el batch de captura
// y el listado del día en solo lectura, agrupado por lote.
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

  return { loading, error, getLotes, guardarBatch };
}
