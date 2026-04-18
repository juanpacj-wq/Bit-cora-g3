import { useState, useEffect, useRef, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './useApi';

const STORAGE_KEY = 'bitacoras_auth';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [sesion, setSesion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const heartbeatRef = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { user: u, sesion: s } = JSON.parse(raw);
        if (u) setUser(u);
        if (s) setSesion(s);
      }
    } catch {}
  }, []);

  useEffect(() => {
    const payload = JSON.stringify({ user, sesion });
    if (user || sesion) localStorage.setItem(STORAGE_KEY, payload);
    else localStorage.removeItem(STORAGE_KEY);
  }, [user, sesion]);

  useEffect(() => {
    if (!sesion?.sesion_id) return;
    heartbeatRef.current = setInterval(() => {
      api.post('/api/auth/heartbeat', { sesion_id: sesion.sesion_id }, { skipAuth: true }).catch(() => {});
    }, 60000);
    return () => clearInterval(heartbeatRef.current);
  }, [sesion?.sesion_id]);

  const logout = useCallback(async () => {
    if (sesion?.sesion_id) {
      try { await api.post('/api/auth/logout', { sesion_id: sesion.sesion_id }, { skipAuth: true }); } catch {}
    }
    setUser(null); setSesion(null);
    localStorage.removeItem(STORAGE_KEY);
  }, [sesion?.sesion_id]);

  useEffect(() => {
    setUnauthorizedHandler(() => { logout(); });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (email, password) => {
    setLoading(true); setError(null);
    try {
      const { usuario } = await api.post('/api/auth/login', { email, password }, { skipAuth: true });
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

  return { user, sesion, loading, error, login, selectContext, logout };
}
