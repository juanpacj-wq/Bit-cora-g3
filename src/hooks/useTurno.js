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
  // D-054: planta cuyo estado de turno tenemos cargado. `null` = aún ninguna (primer pase), lo que
  // preserva el `initialTurno` sembrado por /api/me. Ver el efecto de abajo.
  const plantaCargadaRef = useRef(null);

  // D-054: el catch NO limpia el estado a propósito. `refetch` también lo dispara cada mensaje del
  // WS, así que un blip de red borraría un estado válido y el header pasaría a "Turno cerrado"
  // bloqueando escrituras sin que nada haya cerrado. La invalidación correcta es por IDENTIDAD (la
  // planta cambió), y esa vive en el efecto de abajo: determinista y sin castigar fallos
  // transitorios. Ante un fallo, conservar lo último conocido de ESTA unidad es lo correcto.
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
    // D-054: invalidar ANTES de pedir, pero SOLO si el estado que tenemos es de OTRA unidad.
    // `plantaId` es parte de la identidad de este estado: con el cambio en caliente el hook no se
    // desmonta, así que mientras viaja el refetch de la unidad nueva, `null` ("sin dato") es la
    // única respuesta honesta — mostrar el turno de la unidad anterior es peor que no mostrar nada,
    // porque se ve consistente. Los consumidores tratan `null` como "sin turno abierto" (seguro).
    //
    // El guard `!== null` es load-bearing: en el PRIMER pase no se limpia, para no pisar el
    // `initialTurno` sembrado desde /api/me (D-045 E8) — esa siembra es justo lo que hace reaparecer
    // el modal de transición al recargar en pleno bloqueo, sin esperar al fetch.
    if (plantaCargadaRef.current !== null && plantaCargadaRef.current !== plantaId) {
      setTurno(null);
    }
    plantaCargadaRef.current = plantaId;
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

  // D-045 (reabrir) — des-cierra el turno de la ventana vigente cuando la unidad quedó sin turno abierto.
  const reabrir = useCallback(async () => {
    if (!plantaId) return null;
    setAccionando(true);
    try {
      const r = await api.post('/api/turno/reabrir', { planta_id: plantaId });
      await refetch();
      return r;
    } finally {
      setAccionando(false);
    }
  }, [plantaId, refetch]);

  return {
    estado: turno?.estado ?? null,
    turno: turno?.turno ?? null,
    bloqueo: !!turno?.bloqueo,
    puedeDecidir: !!turno?.puede_decidir,
    extendido: !!turno?.extendido,
    finNominal: turno?.fin_nominal ?? null,
    accionando,
    cerrar,
    extender,
    reabrir,
    refetch,
  };
}
