import { useState, useEffect, useRef } from 'react';
import { api } from './useApi';
import { wsUrl } from '../config/paths';

export function useBitacoraCounts(ready, sesionId, plantaId) {
  const [counts, setCounts] = useState({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    if (!ready || !sesionId || !plantaId) return;
    unmountedRef.current = false;
    retryRef.current = 0;

    const refetchSnapshot = () => {
      api.get(`/api/bitacora/counts?planta_id=${encodeURIComponent(plantaId)}`)
        .then(({ counts: c }) => { if (!unmountedRef.current) setCounts(c || {}); })
        .catch(() => {});
    };

    refetchSnapshot();

    // Fallback redundante al WS: cuando una mutación local de bitácora ocurre, el cliente
    // emite `bitacora:counts-refresh` y refetchamos por HTTP. Garantiza que el badge se
    // actualice instantáneamente aunque la conexión WS esté caída o el broadcast se pierda.
    window.addEventListener('bitacora:counts-refresh', refetchSnapshot);

    const connect = () => {
      if (unmountedRef.current) return;
      const url = wsUrl(`/ws/conteo-bitacoras?sesion_id=${sesionId}`);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'snapshot') setCounts(msg.counts || {});
        } catch {}
      };
      ws.onclose = () => {
        setConnected(false);
        if (unmountedRef.current) return;
        const delay = Math.min(30_000, 1000 * Math.pow(2, retryRef.current++));
        retryTimerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();

    return () => {
      unmountedRef.current = true;
      window.removeEventListener('bitacora:counts-refresh', refetchSnapshot);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      try { wsRef.current?.close(); } catch {}
    };
  }, [ready, sesionId, plantaId]);

  return { counts, connected };
}
