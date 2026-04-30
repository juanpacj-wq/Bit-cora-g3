import { useState, useEffect, useCallback, useRef } from 'react';
import { api, setUnauthorizedHandler } from './useApi';

const STORAGE_KEY = 'bitacoras_auth';

// F13.4: persist síncrono. El efecto de antes corría DESPUÉS de los useEffects de los hijos
// (React: child effects first, then parent), entonces el Dashboard disparaba su fetch leyendo
// sessionStorage viejo y obtenía 401. Cualquier mutación de user/sesion debe escribir storage
// inmediatamente para que el siguiente request use el id correcto.
function persistAuth(user, sesion) {
  try {
    if (user || sesion) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user, sesion }));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

export function useAuth() {
  const [user, setUser] = useState(null);
  const [sesion, setSesion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  // Cache local para evitar leer sessionStorage en cada persist (sincronización con state).
  const userRef = useRef(null);
  const sesionRef = useRef(null);

  // F9: bootstrap simplificado — leemos sessionStorage y listo. Si la sesión fue invalidada
  // (logout en otra pestaña, sweeper de turno, server caído), el primer request autenticado
  // retorna 401 y el unauthorizedHandler dispara logout(). No hay endpoint resume ni heartbeat.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { user: u, sesion: s } = JSON.parse(raw);
        if (u) { setUser(u); userRef.current = u; }
        if (s) { setSesion(s); sesionRef.current = s; }
      }
    } catch {
    } finally {
      setReady(true);
    }
  }, []);

  const logout = useCallback(async () => {
    const sid = sesionRef.current?.sesion_id;
    if (sid) {
      try { await api.post('/api/auth/logout', { sesion_id: sid }, { skipAuth: true }); } catch {}
    }
    userRef.current = null;
    sesionRef.current = null;
    persistAuth(null, null);
    setUser(null);
    setSesion(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { logout(); });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (username, password) => {
    setLoading(true); setError(null);
    try {
      const { usuario } = await api.post('/api/auth/login', { username, password }, { skipAuth: true });
      userRef.current = usuario;
      persistAuth(usuario, sesionRef.current);
      setUser(usuario);
      return usuario;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  const selectContext = useCallback(async (planta_id, cargo_id) => {
    const currentUser = userRef.current;
    if (!currentUser) throw new Error('No hay usuario autenticado');
    setLoading(true); setError(null);
    try {
      const { sesion: s } = await api.post('/api/auth/select-context', {
        usuario_id: currentUser.usuario_id, planta_id, cargo_id,
      }, { skipAuth: true });
      sesionRef.current = s;
      persistAuth(currentUser, s);
      setSesion(s);
      return s;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return { user, sesion, loading, error, ready, login, selectContext, logout };
}
