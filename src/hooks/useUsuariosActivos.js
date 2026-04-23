import { useState, useEffect, useRef } from 'react';
import { api } from './useApi';

export function useUsuariosActivos(ready, sesionId) {
  const [usuarios, setUsuarios] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    if (!ready || !sesionId) return;
    unmountedRef.current = false;
    retryRef.current = 0;

    api.get('/api/auth/usuarios-activos')
      .then(({ usuarios: u }) => { if (!unmountedRef.current) setUsuarios(u || []); })
      .catch(() => {});

    const connect = () => {
      if (unmountedRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/usuarios-activos?sesion_id=${sesionId}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'snapshot') setUsuarios(msg.usuarios || []);
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
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      try { wsRef.current?.close(); } catch {}
    };
  }, [ready, sesionId]);

  return { usuarios, connected };
}
