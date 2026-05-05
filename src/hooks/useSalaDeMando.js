import { useCallback, useState } from 'react';
import { api } from './useApi';

// F17: hook para Sala de Mando. La grilla pasó a un modelo buffer-en-memoria + batch save,
// así que solo expone GET grilla + POST batch. Las operaciones celda-por-celda (POST/PUT/DELETE)
// fueron eliminadas — todo va por `guardarBatch` contra `/api/sala-de-mando/guardar`.
export function useSalaDeMando() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getGrilla = useCallback(async (planta_id, fecha) => {
    const qs = new URLSearchParams({ planta_id, fecha });
    return await api.get(`/api/sala-de-mando?${qs}`);
  }, []);

  const guardarBatch = useCallback(async ({ planta_id, fecha, filas }) => {
    setLoading(true); setError(null);
    try {
      return await api.post('/api/sala-de-mando/guardar', { planta_id, fecha, filas });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, getGrilla, guardarBatch };
}
