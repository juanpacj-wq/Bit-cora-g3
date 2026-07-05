import { useState, useCallback } from 'react';
import { api } from './useApi';

// D-045 E9 — seguimiento de turnos: lista por unidad+rango (GET /api/turno/seguimiento) + detalle de
// participantes por turno (cerrado → conformación congelada; vivo → turno_participante). Sin estado
// persistido; la vista lo consulta bajo demanda.
export function useSeguimientoTurnos() {
  const [turnos, setTurnos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const cargar = useCallback(async ({ planta, desde, hasta } = {}) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (planta) qs.set('planta', planta);
      if (desde) qs.set('desde', desde);
      if (hasta) qs.set('hasta', hasta);
      const r = await api.get(`/api/turno/seguimiento?${qs.toString()}`);
      setTurnos(r.turnos || []);
    } catch (e) {
      setError(e.message); setTurnos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const cargarParticipantes = useCallback(async (turnoId) => {
    return api.get(`/api/turno/seguimiento/${turnoId}/participantes`);
  }, []);

  return { turnos, loading, error, cargar, cargarParticipantes };
}
