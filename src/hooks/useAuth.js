import { useState, useEffect, useRef, useCallback } from 'react';

const STORAGE_KEY = 'bitacoras_auth';

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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
      postJSON('/api/auth/heartbeat', { sesion_id: sesion.sesion_id }).catch(() => {});
    }, 60000);
    return () => clearInterval(heartbeatRef.current);
  }, [sesion?.sesion_id]);

  const login = useCallback(async (email, password) => {
    setLoading(true); setError(null);
    try {
      const { usuario } = await postJSON('/api/auth/login', { email, password });
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
      const { sesion: s } = await postJSON('/api/auth/select-context', {
        usuario_id: user.usuario_id, planta_id, cargo_id,
      });
      setSesion(s);
      return s;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, [user]);

  const logout = useCallback(async () => {
    if (sesion?.sesion_id) {
      try { await postJSON('/api/auth/logout', { sesion_id: sesion.sesion_id }); } catch {}
    }
    setUser(null); setSesion(null);
    localStorage.removeItem(STORAGE_KEY);
  }, [sesion?.sesion_id]);

  return { user, sesion, loading, error, login, selectContext, logout };
}
