const STORAGE_KEY = 'bitacoras_auth';

function getSesionIdFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { sesion } = JSON.parse(raw);
    return sesion?.sesion_id ?? null;
  } catch {
    return null;
  }
}

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(url, { method = 'GET', body, skipAuth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!skipAuth) {
    const sesion_id = getSesionIdFromStorage();
    if (sesion_id != null) headers['X-Sesion-Id'] = String(sesion_id);
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !skipAuth && unauthorizedHandler) {
    try { unauthorizedHandler(); } catch {}
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (url, opts) => request(url, { ...opts, method: 'GET' }),
  post: (url, body, opts) => request(url, { ...opts, method: 'POST', body }),
  put: (url, body, opts) => request(url, { ...opts, method: 'PUT', body }),
  del: (url, opts) => request(url, { ...opts, method: 'DELETE' }),
};
