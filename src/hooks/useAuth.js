import { useState, useEffect, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './useApi';

const STORAGE_KEY = 'bitacoras_auth';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [sesion, setSesion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  // F9: bootstrap simplificado — leemos sessionStorage y listo. Si la sesión fue invalidada
  // (logout en otra pestaña, sweeper de turno, server caído), el primer request autenticado
  // retorna 401 y el unauthorizedHandler dispara logout(). No hay endpoint resume ni heartbeat.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { user: u, sesion: s } = JSON.parse(raw);
        if (u) setUser(u);
        if (s) setSesion(s);
      }
    } catch {
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (user || sesion) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user, sesion }));
    }
  }, [user, sesion]);

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
