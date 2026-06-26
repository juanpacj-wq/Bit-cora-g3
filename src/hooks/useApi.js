// Login Entra ID: la autenticación viaja en la cookie httpOnly de sesión (no más X-Sesion-Id en
// sessionStorage, que era exfiltrable por XSS). `credentials:'include'` adjunta la cookie en cada
// request (same-origin vía proxy Vite en dev / mismo host en prod). `skipAuth` ya no inyecta nada;
// solo sirve para que un 401 esperado (ej. el bootstrap GET /api/me) NO dispare el logout global.
let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(url, { method = 'GET', body, skipAuth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !skipAuth && unauthorizedHandler) {
    try { unauthorizedHandler(); } catch {}
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (Array.isArray(data?.errores)) err.errores = data.errores;
    err.status = res.status;
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
