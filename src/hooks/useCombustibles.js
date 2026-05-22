import { useCallback, useState } from 'react';
import { api } from './useApi';

// D-027: hook del módulo Combustibles → Consumos. Patrón paralelo a useSalaDeMando
// (buffer-en-memoria + batch save), pero el storage es long-format en
// `bitacora.consumo_combustible` con catálogo separado `lov_bit.combustible`.
//
// `getConsumos` devuelve catálogo + celdas pivot (periodo → combustible_id → {cantidad,...}).
// `guardarBatch` consume el endpoint POST que diff-ea contra la BD y devuelve resumen.
export function useCombustibles() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getCatalogo = useCallback(async (planta_id) => {
    return await api.get(`/api/combustibles/catalogo?planta_id=${encodeURIComponent(planta_id)}`);
  }, []);

  const getConsumos = useCallback(async (planta_id, fecha) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ planta_id, fecha });
      return await api.get(`/api/combustibles/consumos?${qs}`);
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  const guardarBatch = useCallback(async ({ planta_id, fecha, celdas }) => {
    setLoading(true); setError(null);
    try {
      return await api.post('/api/combustibles/consumos', { planta_id, fecha, celdas });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, getCatalogo, getConsumos, guardarBatch };
}
