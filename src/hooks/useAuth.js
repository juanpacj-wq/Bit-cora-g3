import { useState, useEffect, useRef, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './useApi';

const STORAGE_KEY = 'bitacoras_auth';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [sesion, setSesion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const heartbeatRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const { user: u, sesion: s } = JSON.parse(raw);
        let refreshed = s;
        if (s?.sesion_id) {
          try {
            const { sesion: fresca } = await api.post('/api/auth/resume', { sesion_id: s.sesion_id }, { skipAuth: true });
            if (fresca) refreshed = fresca;  // adopta la sesión enriquecida con puede_cerrar_turno, cargo_nombre, etc.
          } catch {
            if (!cancelled) { sessionStorage.removeItem(STORAGE_KEY); }
            return;
          }
        }
        if (cancelled) return;
        if (u) setUser(u);
        if (refreshed) setSesion(refreshed);
      } catch {
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (user || sesion) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user, sesion }));
    }
  }, [user, sesion]);

  // F2: heartbeat desactivado — la sesión queda activa hasta logout o cierre por sweeper de F4.
  // F9 elimina este useEffect y el endpoint /api/auth/heartbeat.
  // useEffect(() => {
  //   if (!sesion?.sesion_id) return;
  //   heartbeatRef.current = setInterval(() => {
  //     api.post('/api/auth/heartbeat', { sesion_id: sesion.sesion_id }, { skipAuth: true }).catch(() => {});
  //   }, 60000);
  //   return () => clearInterval(heartbeatRef.current);
  // }, [sesion?.sesion_id]);

  // F2: pagehide beacon desactivado — cerrar la pestaña ya NO desloguea. F3 sustituye esta
  // mecánica defensiva por un popup explícito "¿Finalizar turno antes de cerrar sesión?".
  // useEffect(() => {
  //   if (!sesion?.sesion_id) return;
  //   const onPageHide = () => {
  //     try {
  //       const blob = new Blob([JSON.stringify({ sesion_id: sesion.sesion_id })], { type: 'application/json' });
  //       navigator.sendBeacon('/api/auth/logout', blob);
  //     } catch {}
  //   };
  //   window.addEventListener('pagehide', onPageHide);
  //   return () => window.removeEventListener('pagehide', onPageHide);
  // }, [sesion?.sesion_id]);

  const logout = useCallback(async () => {
    if (sesion?.sesion_id) {
      try { await api.post('/api/auth/logout', { sesion_id: sesion.sesion_id }, { skipAuth: true }); } catch {}
    }
    setUser(null); setSesion(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, [sesion?.sesion_id]);

  useEffect(() => {
    setUnauthorizedHandler(() => { logout(); });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (username, password) => {
    setLoading(true); setError(null);
    try {
      const { usuario } = await api.post('/api/auth/login', { username, password }, { skipAuth: true });
      setUser(usuario);
      return usuario;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const selectContext = useCallback(async (planta_id, cargo_id) => {
    if (!user) throw new Error('No hay usuario autenticado');
    setLoading(true); setError(null);
    try {
      const { sesion: s } = await api.post('/api/auth/select-context', {
        usuario_id: user.usuario_id, planta_id, cargo_id,
      }, { skipAuth: true });
      setSesion(s);
      return s;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, [user]);

  return { user, sesion, loading, error, ready, login, selectContext, logout };
}
