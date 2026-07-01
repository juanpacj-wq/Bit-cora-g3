// Middleware transversal del pipeline Express unificado (AUD-34/35, ronda D-037).
//
// D-031 dejó dos modelos de routing: un wrapper Express solo para `/auth` + un if-chain http-nativo
// (`legacyHandler`) para el resto, donde CADA handler decidía si llamaba `loadSession` → la
// autenticación era opt-in y fácil de olvidar (raíz de AUD-05). Esta ronda migra el if-chain a
// routers Express y **cierra la autenticación por defecto** con `requireEntra` global + una allowlist
// pública explícita. Estos middlewares son la base compartida por todos los routers de dominio.

import { corsHeadersFor, csrfOriginAllowed, sendJSON } from '../utils/http.js';
import { bypassHabilitado, loadSession } from '../middleware/auth.js';

// ── Allowlist de rutas públicas (sin identidad) ─────────────────────────────────────────────────
// Único lugar donde una ruta queda expuesta sin autenticación. Todo lo que NO esté aquí exige
// identidad Entra (o el backdoor de test). Mantener MÍNIMA y auditable:
//  - catálogos NO-PII que el LoginScreen necesita antes de tener sesión de app (plantas/cargos/
//    bitácoras/tipos-evento/permisos). NO incluye jdt-actual/jefe: esos devuelven email (PII) y
//    exigen identidad Entra.
//  - eventos-dashboard: borde del contrato cross-repo; su gate es un token de servicio opcional
//    (AUD-18), no la cookie de usuario.
//  - health.
const PUBLIC_EXACT = new Set([
  'GET /health',
  'GET /api/catalogos/plantas',
  'GET /api/catalogos/cargos',
  'GET /api/catalogos/bitacoras',
  'GET /api/eventos-dashboard',
]);

// Rutas públicas con parámetro en el path (solo GET).
const PUBLIC_GET_REGEX = [
  /^\/api\/catalogos\/bitacoras\/\d+\/tipos-evento$/,
  /^\/api\/catalogos\/permisos\/\d+$/,
];

// Pura y testeable: ¿esta (method, pathname) es pública? OPTIONS (preflight CORS) siempre pasa.
export function esRutaPublica(method, pathname) {
  if (method === 'OPTIONS') return true;
  if (PUBLIC_EXACT.has(`${method} ${pathname}`)) return true;
  if (method === 'GET' && PUBLIC_GET_REGEX.some((re) => re.test(pathname))) return true;
  return false;
}

// ── CORS + preflight (global) ───────────────────────────────────────────────────────────────────
// Reemplaza la rama OPTIONS del if-chain (AUD-16). Refleja el Origin según la allowlist de CORS.
export function corsMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(req.headers.origin));
    return res.end();
  }
  const headers = corsHeadersFor(req.headers.origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  next();
}

// ── CSRF para mutadores (global) ────────────────────────────────────────────────────────────────
// Reemplaza la rama CSRF del if-chain (AUD-19). Solo mutadores con header Origin no confiable → 403.
// Origin ausente (server-to-server) se permite aguas arriba para no romper integraciones.
export function csrfMiddleware(req, res, next) {
  const m = req.method;
  if (m === 'POST' || m === 'PUT' || m === 'DELETE') {
    const origin = req.headers.origin;
    if (origin && !csrfOriginAllowed(origin, req.headers.host)) {
      return sendJSON(res, 403, { error: 'Origen no permitido', codigo: 'origen_no_permitido' });
    }
  }
  next();
}

// ── requireEntra (global) — el fix estructural de AUD-05 ────────────────────────────────────────
// Cierra el acceso anónimo POR DEFECTO. Se monta después del authRouter (login/me/logout son
// self-gating) y antes de los routers de datos. Orden de decisión:
//   1. ruta pública explícita → pasa
//   2. backdoor de test (AUTH_TEST_BYPASS + X-Sesion-Id) → pasa (solo no-prod; ver bypassHabilitado)
//   3. identidad Entra en la cookie (req.session.user.oid) → pasa
//   4. si no → 401
// NO carga la sesión de app (sesion_activa): eso lo hace loadAppSession por router, porque no todas
// las rutas autenticadas requieren sesión de app (p.ej. select-context la CREA; jdt-actual/jefe solo
// necesitan identidad Entra).
export function requireEntra(req, res, next) {
  if (esRutaPublica(req.method, req.path)) return next();
  if (bypassHabilitado() && req.headers['x-sesion-id'] != null) return next();
  if (req.session?.user?.oid) return next();
  return sendJSON(res, 401, { error: 'No autenticado', codigo: 'no_autenticado' });
}

// ── loadAppSession (por router) ─────────────────────────────────────────────────────────────────
// Reemplaza el idiom repetido `const sesion = await loadSession(req); if (!sesion) return 401;`.
// Deja la sesión de app vigente en `req.sesion` para el handler.
export function loadAppSession(req, res, next) {
  loadSession(req)
    .then((sesion) => {
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      req.sesion = sesion;
      next();
    })
    .catch(next);
}

// ── asyncH — envuelve un handler async y enruta el throw a expressErrorHandler (D-032) ──────────
// Reemplaza el try/catch global del if-chain: cualquier error del handler cae en next(err) → el
// error-handler de Express lo sanea (sin filtrar internals).
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
