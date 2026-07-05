// Helpers compartidos por los routers de dominio (AUD-34/35). Consolidan piezas que vivían como
// estado/funciones module-level del if-chain (server.js) para que los routers Express las reusen.

import { CORS_HEADERS, rateLimitCheck } from '../utils/http.js';

// D-026: cache lazy del bitacora_id de DISP. Lo usan el router de disponibilidad (E8) y la rama
// DISP de registros (E10) para devolver shape compat (registro.bitacora_id). Movido de server.js.
let _dispBitacoraId = null;
export async function getDispBitacoraId(db) {
  if (_dispBitacoraId != null) return _dispBitacoraId;
  const r = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'`);
  _dispBitacoraId = r.recordset[0]?.bitacora_id ?? null;
  return _dispBitacoraId;
}

// AUD-20: rate limiter en memoria (Map<`${tag}:${ip}`, {count, resetAt}>). UNA sola instancia
// compartida por server.js y todos los routers, para que el conteo sea global por endpoint/IP.
const _rateLimitMap = new Map();

function clientIp(req) {
  // `trust proxy` está activo en el wrapper Express; respetamos X-Forwarded-For si llega.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconocida';
}

function responder429(res, retryAfterMs) {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify({
    error: 'Demasiadas solicitudes. Espera unos segundos e intenta de nuevo.',
    codigo: 'rate_limit',
  }));
}

// Aplica rate limiting a un endpoint sensible. Devuelve true si pasa; si excede responde 429
// (con Retry-After) y devuelve false — el handler debe `return` sin seguir.
export function aplicarRateLimit(req, res, tag, { max, windowMs }) {
  const r = rateLimitCheck(_rateLimitMap, `${tag}:${clientIp(req)}`, Date.now(), { max, windowMs });
  if (!r.allowed) { responder429(res, r.retryAfterMs); return false; }
  return true;
}

// D-047: tope GLOBAL (todas las IPs comparten el contador) para endpoints que consumen una
// cuota externa compartida (free tier de Gemini). Misma semántica que aplicarRateLimit.
export function aplicarRateLimitGlobal(req, res, tag, { max, windowMs }) {
  const r = rateLimitCheck(_rateLimitMap, `${tag}:*`, Date.now(), { max, windowMs });
  if (!r.allowed) { responder429(res, r.retryAfterMs); return false; }
  return true;
}
