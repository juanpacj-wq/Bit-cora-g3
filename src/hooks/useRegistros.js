import { useState, useCallback } from 'react';
import { api } from './useApi';

export function useRegistros() {
  const [registros, setRegistros] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getActivos = useCallback(async ({ planta_id, bitacora_id, estado } = {}) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (planta_id) qs.set('planta_id', planta_id);
      if (bitacora_id) qs.set('bitacora_id', bitacora_id);
      if (estado) qs.set('estado', estado);
      const { registros: r } = await api.get(`/api/registros/activos?${qs}`);
      setRegistros(r || []);
      return r || [];
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const crear = useCallback(async (registro) => {
    const { registro: r } = await api.post('/api/registros', registro);
    return r;
  }, []);

  const actualizar = useCallback(async (id, campos) => {
    const { registro: r } = await api.put(`/api/registros/${id}`, campos);
    return r;
  }, []);

  const eliminar = useCallback(async (id) => {
    await api.del(`/api/registros/${id}`);
  }, []);

  return { registros, loading, error, getActivos, crear, actualizar, eliminar, setRegistros };
}
