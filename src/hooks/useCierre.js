import { useState, useCallback } from 'react';
import { api } from './useApi';

// Cierre de turno (D-042: masivo es el único cierre — el cierre individual por bitácora fue eliminado).
export function useCierre() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // F4: preview-masivo retorna { bitacoras_pendientes, ingenieros_no_finalizados } para el modal.
  const previewMasivo = useCallback(async (planta_id) => {
    const qs = new URLSearchParams({ planta_id });
    return await api.get(`/api/cierre/preview-masivo?${qs}`);
  }, []);

  // F4: encadena finalizar-forzado (lista de usuarios pendientes) + cierre masivo. La idea:
  // antes de cerrar el turno, se fuerza la finalización de los ingenieros que no clickaron
  // "Finalizar turno". Esto deja CIET 'finalizacion' por cada uno y luego cierra los borradores
  // de cada bitácora.
  const cerrarMasivoConFinalizacionForzada = useCallback(async ({ planta_id, usuarios_pendientes }) => {
    setLoading(true); setError(null);
    try {
      let finalizados = [];
      if (Array.isArray(usuarios_pendientes) && usuarios_pendientes.length > 0) {
        const r = await api.post('/api/bitacora/finalizar-forzado', { usuarios: usuarios_pendientes });
        finalizados = r.finalizados || [];
      }
      const cierre = await api.post('/api/cierre/masivo', { planta_id });
      return { finalizados, ...cierre };
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return {
    loading, error,
    previewMasivo, cerrarMasivoConFinalizacionForzada,
  };
}
