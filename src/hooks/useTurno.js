import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './useApi';
import { wsUrl } from '../config/paths';

// D-045 E8 — estado del turno de la unidad activa + acciones cerrar/extender. Fuente de verdad = backend
// (NO localStorage): `GET /api/turno/actual` (autoritativo, incluye `bloqueo`/`puede_decidir`/`fin_nominal`)
// + suscripción al WS `turno-transicion` (bloqueo/extensión/cierre por planta, auth por cookie, patrón de
// useBitacoraCounts). `initialTurno` (de `/api/me`) siembra el estado en el primer render para que, al
// recargar en pleno bloqueo, el modal reaparezca sin esperar el fetch. En cada mensaje WS refetchamos el
// estado autoritativo en vez de fiarnos del payload parcial del broadcast.
export function useTurno(ready, sesionId, plantaId, initialTurno = null) {
  const [turno, setTurno] = useState(initialTurno);
  const [accionando, setAccionando] = useState(false);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  const refetch = useCallback(async () => {
    try {
      const t = await api.get('/api/turno/actual');
      if (!unmountedRef.current) setTurno(t);
      return t;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!ready || !sesionId || !plantaId) return;
    unmountedRef.current = false;
    retryRef.current = 0;
    refetch();

    const connect = () => {
      if (unmountedRef.current) return;
      // El server autentica el handshake por la cookie de sesión (resolveWsPlanta) e ignora el query;
      // pasamos sesion_id por paridad con los otros canales (gate de "listo" del lado cliente).
      const ws = new WebSocket(wsUrl(`/ws/turno-transicion?sesion_id=${sesionId}`));
      wsRef.current = ws;
      ws.onopen = () => { retryRef.current = 0; };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'turno-transicion') refetch();
        } catch { /* payload no-JSON: ignorar */ }
      };
      ws.onclose = () => {
        if (unmountedRef.current) return;
        const delay = Math.min(30_000, 1000 * Math.pow(2, retryRef.current++));
        retryTimerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    };
    connect();

    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      try { wsRef.current?.close(); } catch { /* noop */ }
    };
  }, [ready, sesionId, plantaId, refetch]);

  const cerrar = useCallback(async () => {
    if (!plantaId) return null;
    setAccionando(true);
    try {
      const r = await api.post('/api/turno/cerrar', { planta_id: plantaId });
      await refetch();
      return r;
    } finally {
      setAccionando(false);
    }
  }, [plantaId, refetch]);

  const extender = useCallback(async (detalle = null) => {
    if (!plantaId) return null;
    setAccionando(true);
    try {
      const r = await api.post('/api/turno/extender', { planta_id: plantaId, detalle });
      await refetch();
      return r;
    } finally {
      setAccionando(false);
    }
  }, [plantaId, refetch]);

  return {
    estado: turno?.estado ?? null,
    bloqueo: !!turno?.bloqueo,
    puedeDecidir: !!turno?.puede_decidir,
    extendido: !!turno?.extendido,
    finNominal: turno?.fin_nominal ?? null,
    accionando,
    cerrar,
    extender,
    refetch,
  };
}
