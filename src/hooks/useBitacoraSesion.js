import { useEffect, useCallback, useState } from 'react';
import { api } from './useApi';

// F2: marca al usuario como participante de una bitácora abriendo (o reabriendo) sesion_bitacora.
// Idempotente del lado del server (UPSERT). No hace nada al desmontar — la finalización es
// explícita vía /api/bitacora/finalizar (F3 dispara CIET) o el turno-sweeper de F4.
//
// D-054: `sesion_id` NO viaja en el body (el server lo deriva de la cookie, nunca del cliente) —
// está acá porque la presencia es de la PAREJA (sesión, bitácora): `sesion_bitacora` tiene UNIQUE
// (sesion_id, bitacora_id) y cada unidad es una fila `sesion_activa` distinta. Con dep solo en
// `bitacora_id`, un cambio de unidad en caliente sin cambiar de pestaña no re-disparaba el POST y
// el usuario quedaba SIN registrar en la bitácora de la unidad nueva. Antes esto lo tapaba el
// `setActiveBitacora(null)` del camino por LoginScreen — un acoplamiento implícito y frágil del que
// ya no depende la correctitud.
export function useBitacoraSesion(bitacora_id, sesion_id) {
  useEffect(() => {
    if (!bitacora_id || !sesion_id) return;
    api.post('/api/bitacora/abrir', { bitacora_id }).catch(() => {});
  }, [bitacora_id, sesion_id]);
}

// F4/D-040: hook para el botón "Finalizar turno" del header. Llama a /api/bitacora/finalizar,
// que (tras D-040) marca sesion_activa.turno_finalizado_en y emite CIET. Devuelve
// { turno_finalizado_en, evento_ciet }.
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

// D-040: simétrico a useFinalizarTurno para el botón "Revertir finalización". Llama a
// /api/bitacora/revertir-turno (self-service, limpia turno_finalizado_en + CIET 'reapertura').
export function useRevertirTurno() {
  const [loading, setLoading] = useState(false);
  const revertir = useCallback(async () => {
    setLoading(true);
    try {
      return await api.post('/api/bitacora/revertir-turno');
    } finally {
      setLoading(false);
    }
  }, []);
  return { revertir, loading };
}
