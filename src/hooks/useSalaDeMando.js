import { useCallback, useState } from 'react';
import { api } from './useApi';

// F6: hook para Sala de Mando. Encapsula el round-trip GET grilla + POST/PUT/DELETE celda.
// La validación cruzada con email (preguntas2.md C, REDESP) la hace el componente antes
// de llamar a `crearCelda` o `actualizarCelda` — este hook solo despacha la API.
export function useSalaDeMando() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getGrilla = useCallback(async (planta_id, fecha) => {
    const qs = new URLSearchParams({ planta_id, fecha });
    return await api.get(`/api/sala-de-mando?${qs}`);
  }, []);

  const crearCelda = useCallback(async ({ bitacora_id, planta_id, tipo_evento_id, periodo, valor_mw, detalle, funcionariocnd, fecha }) => {
    setLoading(true); setError(null);
    try {
      // F6: la fecha del registro es el día seleccionado a la hora del periodo (P1=00:00,
      // P7=06:00, etc.). Esto deja que el cierre cronológico (F4) lo agrupe correctamente
      // por turno aunque el usuario llene la grilla a otra hora del día.
      const fechaPeriodo = buildFechaParaPeriodo(fecha, periodo);
      return await api.post('/api/registros', {
        bitacora_id,
        planta_id,
        fecha_evento: fechaPeriodo,
        tipo_evento_id,
        detalle: detalle || null,
        campos_extra: {
          periodo,
          valor_mw: parseFloat(valor_mw),
          ...(funcionariocnd ? { funcionariocnd } : {}),
        },
      });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const actualizarCelda = useCallback(async (registro_id, { valor_mw, detalle, funcionariocnd, periodo }) => {
    setLoading(true); setError(null);
    try {
      const campos_extra = { periodo };
      if (valor_mw !== undefined) campos_extra.valor_mw = parseFloat(valor_mw);
      if (funcionariocnd !== undefined) campos_extra.funcionariocnd = funcionariocnd || null;
      return await api.put(`/api/registros/${registro_id}`, {
        ...(detalle !== undefined ? { detalle: detalle || null } : {}),
        campos_extra,
      });
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const eliminarCelda = useCallback(async (registro_id) => {
    setLoading(true); setError(null);
    try {
      return await api.del(`/api/registros/${registro_id}`);
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return { loading, error, getGrilla, crearCelda, actualizarCelda, eliminarCelda };
}

// Devuelve un ISO-like local string para `fecha` (YYYY-MM-DD) a la hora correspondiente al
// periodo (1..24 → 00:00..23:00). Mantiene el offset del cliente; el servidor lo persiste.
function buildFechaParaPeriodo(fecha, periodo) {
  const hora = (periodo - 1).toString().padStart(2, '0');
  return `${fecha}T${hora}:00:00`;
}
