// Login Entra ID: la autenticación viaja en la cookie httpOnly de sesión (no más X-Sesion-Id en
// sessionStorage, que era exfiltrable por XSS). `credentials:'include'` adjunta la cookie en cada
// request (same-origin vía proxy Vite en dev / mismo host en prod). `skipAuth` ya no inyecta nada;
// solo sirve para que un 401 esperado (ej. el bootstrap GET /api/me) NO dispare el logout global.
import { withBase } from '../config/paths';

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

// Etiqueta amigable para "no se pudo siquiera contactar al servidor". `fetch` rechaza con un
// TypeError crudo ("Failed to fetch" / "NetworkError…") cuando el backend está caído o la red no
// tiene ruta — texto técnico e incomprensible. Lo traducimos a un Error con codigo estable.
const MSG_SIN_CONEXION = 'No se pudo contactar al servidor. Verifica tu conexión a la red corporativa e intenta de nuevo.';
function errorSinConexion() {
  const err = new Error(MSG_SIN_CONEXION);
  err.codigo = 'sin_conexion';
  err.status = 0;
  err.body = { error: MSG_SIN_CONEXION, codigo: 'sin_conexion', mensaje: MSG_SIN_CONEXION };
  return err;
}

async function request(url, { method = 'GET', body, skipAuth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    // withBase antepone el sub-path de despliegue (/bitacora en prod, '' en dev) a las rutas
    // /api/... que pasan todos los consumidores. Punto único: no se prefija en cada call site.
    res = await fetch(withBase(url), {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw errorSinConexion();
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !skipAuth && unauthorizedHandler) {
    try { unauthorizedHandler(); } catch {}
  }
  if (!res.ok) {
    // `data.error` ya viene saneado por el backend (texto apto para usuario final). Adjuntamos
    // `codigo` (slug estable) y `body` para que los consumidores puedan ramificar sin parsear texto.
    const err = new Error(data.error || data.mensaje || `Error ${res.status}`);
    if (Array.isArray(data?.errores)) err.errores = data.errores;
    err.status = res.status;
    err.codigo = data.codigo;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (url, opts) => request(url, { ...opts, method: 'GET' }),
  post: (url, body, opts) => request(url, { ...opts, method: 'POST', body }),
  put: (url, body, opts) => request(url, { ...opts, method: 'PUT', body }),
  del: (url, opts) => request(url, { ...opts, method: 'DELETE' }),
};
