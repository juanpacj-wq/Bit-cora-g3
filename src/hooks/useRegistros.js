import { useState, useCallback } from 'react';

async function req(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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
      const { registros: r } = await req(`/api/registros/activos?${qs}`);
      setRegistros(r || []);
      return r || [];
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const crear = useCallback(async (registro) => {
    const { registro: r } = await req('/api/registros', 'POST', registro);
    return r;
  }, []);

  const actualizar = useCallback(async (id, campos) => {
    const { registro: r } = await req(`/api/registros/${id}`, 'PUT', campos);
    return r;
  }, []);

  const eliminar = useCallback(async (id) => {
    await req(`/api/registros/${id}`, 'DELETE');
  }, []);

  return { registros, loading, error, getActivos, crear, actualizar, eliminar, setRegistros };
}
