import { useState, useEffect, useRef, useCallback } from 'react';
import { parseHash, buildHash } from '../routing/appRoute';

// D-035: capa de sincronización hash ↔ estado. El hook NO escribe el hash por su cuenta al
// montar (eso lo decide el dashboard, dueño del estado); solo LEE el hash actual, se suscribe a
// cambios externos (back/forward del navegador, edición manual de la URL) y expone `navigate`
// para que el dashboard empuje su estado a la URL.
//
// Guarda anti-loop: `lastWritten` recuerda el último hash que escribimos nosotros. Aunque
// pushState/replaceState NO disparan `hashchange`, sí lo hace una edición manual; el ref evita
// re-procesar un cambio que originamos nosotros.
export function useAppRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const lastWritten = useRef(window.location.hash);

  useEffect(() => {
    const onChange = () => {
      const h = window.location.hash;
      if (h === lastWritten.current) return; // cambio propio → ignorar
      lastWritten.current = h;
      setRoute(parseHash(h));
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);

  // navigate(next, { replace }): escribe el hash canónico de `next`.
  // - replace=false (default): pushState → entra en el historial (navegación de usuario: cambio
  //   de sección). back/forward funcionan.
  // - replace=true: replaceState → no inunda el historial (cambios de subestado: fecha/planta).
  const navigate = useCallback((next, { replace = false } = {}) => {
    const hash = buildHash(next);
    if (hash === window.location.hash) return; // no-op: ya estamos ahí
    lastWritten.current = hash;
    const url = window.location.pathname + window.location.search + hash;
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setRoute(parseHash(hash));
  }, []);

  return { route, navigate };
}
