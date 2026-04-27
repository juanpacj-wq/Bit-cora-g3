import { useEffect } from 'react';
import { api } from './useApi';

// F2: marca al usuario como participante de una bitácora abriendo (o reabriendo) sesion_bitacora.
// Idempotente del lado del server (UPSERT). No hace nada al desmontar — la finalización es
// explícita vía /api/bitacora/finalizar (F3 dispara CIET) o el sweeper de F4.
export function useBitacoraSesion(bitacora_id) {
  useEffect(() => {
    if (!bitacora_id) return;
    api.post('/api/bitacora/abrir', { bitacora_id }).catch(() => {});
  }, [bitacora_id]);
}
