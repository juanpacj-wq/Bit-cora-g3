import { useState, useCallback } from 'react';
import { api } from './useApi';

export function useHistoricos() {
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const buscar = useCallback(async (filtros = {}) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      Object.entries(filtros).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      });
      const result = await api.get(`/api/historicos?${qs}`);
      setData(result.data || []);
      setTotal(result.total || 0);
      setPage(result.page || 1);
      setLimit(result.limit || 50);
      return result;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const getResumen = useCallback(async (planta_id, fecha) => {
    const qs = new URLSearchParams({ planta_id, fecha });
    const { resumen } = await api.get(`/api/historicos/resumen?${qs}`);
    return resumen || [];
  }, []);

  const getById = useCallback(async (id) => {
    const { registro } = await api.get(`/api/historicos/${id}`);
    return registro;
  }, []);

  return { data, total, page, limit, loading, error, buscar, getResumen, getById };
}
