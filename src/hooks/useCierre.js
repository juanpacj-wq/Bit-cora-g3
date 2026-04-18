import { useState, useCallback } from 'react';

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function useCierre() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const cerrarBitacora = useCallback(async (bitacora_id, planta_id, cerrado_por) => {
    setLoading(true); setError(null);
    try {
      return await postJSON('/api/cierre/bitacora', { bitacora_id, planta_id, cerrado_por });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const cierreMasivo = useCallback(async (planta_id, cerrado_por) => {
    setLoading(true); setError(null);
    try {
      return await postJSON('/api/cierre/masivo', { planta_id, cerrado_por });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, cerrarBitacora, cierreMasivo };
}
