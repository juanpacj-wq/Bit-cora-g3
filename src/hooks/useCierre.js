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

  const previewCierre = useCallback(async (planta_id, bitacora_id) => {
    const qs = new URLSearchParams({ planta_id });
    if (bitacora_id != null) qs.set('bitacora_id', String(bitacora_id));
    const { preview } = await api.get(`/api/cierre/preview?${qs}`);
    return preview || [];
  }, []);

  return { loading, error, cerrarBitacora, cierreMasivo, previewCierre };
}
