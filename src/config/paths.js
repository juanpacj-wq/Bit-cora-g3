// Prefijo de despliegue. Vite llena `import.meta.env.BASE_URL` con el valor de `base`
// (ver vite.config.js): en prod bajo el reverse proxy es '/bitacora/'; en dev es '/'.
// Centralizar acá el sub-path hace que el MISMO código sirva en cualquier ruta sin editar
// las ~40 llamadas al backend.
//
// El backend compara rutas por string exacto (`/api/...`, `/auth/...`, `/ws/...`) y nginx
// QUITA el prefijo antes de proxiar (barra final en proxy_pass). Por eso acá solo lo
// anteponemos al construir la URL; el backend nunca ve `/bitacora`.
const P = import.meta.env.BASE_URL.replace(/\/+$/, ''); // '/bitacora' en prod, '' en dev

// Antepone el sub-path a una ruta que empieza con '/', ej. withBase('/api/me').
export const withBase = (p) => `${P}${p}`;

// URL absoluta de WebSocket (mismo host, esquema auto ws/wss) bajo el sub-path.
// Ej. wsUrl('/ws/usuarios-activos?sesion_id=1').
export const wsUrl = (p) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${P}${p}`;

// Asset estático de public/ bajo el sub-path, ej. asset('/gecelca3-logo.png').
// Necesario porque Vite NO reescribe con `base` los string literals de src= en JSX
// (solo imports y URLs de index.html); respeta URLs externas http(s).
export const asset = (p) => (/^https?:\/\//.test(p) ? p : `${P}${p.startsWith('/') ? p : `/${p}`}`);
