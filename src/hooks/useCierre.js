import { useState, useCallback } from 'react';
import { api } from './useApi';

// D-045: insumo del popup de cierre + finalización forzada. El cierre en sí lo hace useTurno.cerrar
// (POST /api/turno/cerrar, cabecera D-045); este hook solo aporta el preview de pendientes
// (GET /api/cierre/preview-masivo, aún vigente) y el POST /api/bitacora/finalizar-forzado.
export function useCierre() {
  const [preview, setPreview] = useState(null); // null | 'loading' | { bitacoras_pendientes, ingenieros_no_finalizados }

  const cargarPreview = useCallback(async (planta_id) => {
    setPreview('loading');
    try {
      const r = await api.get(`/api/cierre/preview-masivo?planta_id=${encodeURIComponent(planta_id)}`);
      setPreview(r);
      return r;
    } catch (e) {
      const vacio = { bitacoras_pendientes: [], ingenieros_no_finalizados: [], error: e.message };
      setPreview(vacio);
      return vacio;
    }
  }, []);

  const finalizarForzado = useCallback(async (usuarios) => {
    if (!Array.isArray(usuarios) || usuarios.length === 0) return { finalizados: [] };
    return api.post('/api/bitacora/finalizar-forzado', { usuarios });
  }, []);

  const limpiar = useCallback(() => setPreview(null), []);

  return { preview, cargarPreview, finalizarForzado, limpiar };
}
