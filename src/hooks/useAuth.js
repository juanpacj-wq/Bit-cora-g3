import { useState, useEffect, useCallback, useRef } from 'react';
import { api, setUnauthorizedHandler } from './useApi';
import { withBase } from '../config/paths';

const STORAGE_KEY = 'bitacoras_auth';

// AUD-27 (BIT-AUDSEG-2026-001): el backend devuelve la logoutUrl del front-channel logout de
// Microsoft, pero no confiamos ciegamente en ella antes de un redirect top-level (defensa ante
// open-redirect si el valor se corrompiera). Aceptamos solo: (a) rutas relativas que empiecen con
// '/' (y no '//', que el navegador trata como protocol-relative externo), o (b) URLs absolutas
// cuyo host esté en la allowlist de Microsoft. Si no valida, caemos a '/'.
const LOGOUT_HOST_ALLOWLIST = new Set(['login.microsoftonline.com', 'login.microsoft.com']);

function safeLogoutUrl(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return '/';
  // Relativa: debe empezar con un único '/' (descarta '//host' protocol-relative).
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  try {
    const u = new URL(candidate);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && LOGOUT_HOST_ALLOWLIST.has(u.hostname)) {
      return candidate;
    }
  } catch {}
  return '/';
}

// Login Entra ID: la IDENTIDAD ya no se persiste como token (vive en la cookie httpOnly). Solo
// guardamos en sessionStorage los campos NO secretos de la sesión de app que algunos componentes
// leen rápido en el primer render (cargo/planta/turno/sesion_id para WS). La fuente de verdad es
// GET /api/me (cookie). persistAuth se mantiene síncrono (F13.4) para que el siguiente request no
// lea storage viejo.
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
  // Última planta usada (la devuelve /api/me) para que reentrar en un turno nuevo sea de un clic.
  const [ultimaPlanta, setUltimaPlanta] = useState(null);
  const userRef = useRef(null);
  const sesionRef = useRef(null);

  // Bootstrap: consultamos /api/me. La cookie Entra autentica; si está viva, recuperamos la
  // identidad y la sesión de app vigente (sesion=null si el turno ya la expulsó → el usuario verá
  // la selección de planta). skipAuth: un 401 acá es esperado (no logueado) y NO debe disparar el
  // logout global.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await api.get('/api/me', { skipAuth: true });
        if (cancel) return;
        if (r?.authenticated && r.user) {
          userRef.current = r.user;
          sesionRef.current = r.sesion || null;
          setUser(r.user);
          setSesion(r.sesion || null);
          setUltimaPlanta(r.ultimaPlanta || null);
          persistAuth(r.user, r.sesion || null);
        } else {
          persistAuth(null, null);
        }
      } catch {
        persistAuth(null, null);
      } finally {
        if (!cancel) setReady(true);
      }
    })();
    return () => { cancel = true; };
  }, []);

  // Inicia el login OIDC: navegación top-level a la ruta del backend (Microsoft → /auth/redirect).
  const loginWithMicrosoft = useCallback(() => {
    window.location.href = withBase('/auth/login');
  }, []);

  // Cleanup de cliente sin tocar la cookie Entra ni la BD (cerrar pestaña / "salir sin finalizar").
  const logoutLocal = useCallback(() => {
    userRef.current = null;
    sesionRef.current = null;
    persistAuth(null, null);
    setUser(null);
    setSesion(null);
  }, []);

  // D-035 "Operar otra unidad": limpia la sesión de app conservando la identidad Entra (user), y
  // además MATA la sesión de app server-side (`activa=0`) sin tocar la cookie Entra — para que una
  // misma persona no quede iniciada en 2 unidades al tiempo. El render cae naturalmente en
  // LoginScreen paso "planta"; al elegir la nueva unidad, select-context crea/activa una sesión
  // limpia (y de paso desactiva cualquier otra activa del usuario). El kill es best-effort: la
  // transición de UI se hace de inmediato (estado de cliente) y no se bloquea por la red.
  const clearSesion = useCallback(() => {
    sesionRef.current = null;
    persistAuth(userRef.current, null);
    setSesion(null);
    api.post('/api/auth/cerrar-app', {}, { skipAuth: true }).catch(() => {});
  }, []);

  // Logout explícito: cierra la sesión de app, destruye la cookie y navega al front-channel logout
  // de Microsoft (cierra también la sesión M365 del navegador).
  const logout = useCallback(async () => {
    // Fallback bajo el sub-path (/bitacora/) por si el backend no devuelve logoutUrl; '/' llevaría
    // al dashboard.
    let logoutUrl = withBase('/');
    try {
      const r = await api.post('/api/logout', {}, { skipAuth: true });
      if (r?.logoutUrl) logoutUrl = safeLogoutUrl(r.logoutUrl);
    } catch {}
    logoutLocal();
    window.location.href = logoutUrl;
  }, [logoutLocal]);

  // Un 401 inesperado en cualquier request NO debe arrastrar al usuario al front-channel logout de
  // Microsoft (la página "Cerró la sesión de su cuenta" + cierre de TODA la sesión M365 del
  // navegador). Eso convertía un solo 401 — p.ej. un endpoint consultado antes de elegir planta —
  // en un bucle irrecuperable. Hacemos un logout LOCAL: limpiamos el estado de cliente y volvemos a
  // la pantalla de login (de la que se reentra con un clic, reusando la sesión Entra viva). El
  // logout COMPLETO de Microsoft queda reservado al botón explícito de "Cerrar sesión" (logout()).
  useEffect(() => {
    setUnauthorizedHandler(() => { logoutLocal(); });
    return () => setUnauthorizedHandler(null);
  }, [logoutLocal]);

  // Crea/reactiva la sesión de app para la planta elegida. El cargo lo deriva el backend de los
  // App Roles del token (no se envía). Autenticado por cookie.
  const selectContext = useCallback(async (planta_id) => {
    if (!userRef.current) throw new Error('No hay usuario autenticado');
    setLoading(true); setError(null);
    try {
      const { sesion: s } = await api.post('/api/auth/select-context', { planta_id });
      sesionRef.current = s;
      persistAuth(userRef.current, s);
      setSesion(s);
      return s;
    } catch (e) {
      setError(e.message); throw e;
    } finally { setLoading(false); }
  }, []);

  return {
    user, sesion, loading, error, ready, ultimaPlanta,
    loginWithMicrosoft, selectContext, logout, logoutLocal, clearSesion,
  };
}
