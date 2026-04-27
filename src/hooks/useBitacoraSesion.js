import { useEffect, useCallback, useState } from 'react';
import { api } from './useApi';

// F2: marca al usuario como participante de una bitácora abriendo (o reabriendo) sesion_bitacora.
// Idempotente del lado del server (UPSERT). No hace nada al desmontar — la finalización es
// explícita vía /api/bitacora/finalizar (F3 dispara CIET) o el turno-sweeper de F4.
export function useBitacoraSesion(bitacora_id) {
  useEffect(() => {
    if (!bitacora_id) return;
    api.post('/api/bitacora/abrir', { bitacora_id }).catch(() => {});
  }, [bitacora_id]);
}

// F4: hook para el botón "Finalizar turno" del header. Llama a /api/bitacora/finalizar
// (F2 endpoint) que finaliza TODAS las sesion_bitacora del usuario actual y emite CIET.
export function useFinalizarTurno() {
  const [loading, setLoading] = useState(false);
  const finalizar = useCallback(async () => {
    setLoading(true);
    try {
      return await api.post('/api/bitacora/finalizar');
    } finally {
      setLoading(false);
    }
  }, []);
  return { finalizar, loading };
}
