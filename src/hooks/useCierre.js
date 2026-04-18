import { useState, useCallback } from 'react';
import { api } from './useApi';

export function useCierre() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const cerrarBitacora = useCallback(async (bitacora_id, planta_id) => {
    setLoading(true); setError(null);
    try {
      return await api.post('/api/cierre/bitacora', { bitacora_id, planta_id });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const cierreMasivo = useCallback(async (planta_id) => {
    setLoading(true); setError(null);
    try {
      return await api.post('/api/cierre/masivo', { planta_id });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, cerrarBitacora, cierreMasivo };
}
