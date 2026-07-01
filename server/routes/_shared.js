// Helpers compartidos por los routers de dominio (AUD-34/35). Consolidan piezas que vivían como
// estado/funciones module-level del if-chain (server.js) para que los routers Express las reusen.

import express from 'express';
import { CORS_HEADERS, rateLimitCheck } from '../utils/http.js';

// Body parser JSON para routers con mutadores (POST/PUT/DELETE). Mismo tope que parseBody del
// if-chain (AUD-15: 1 MB). Se monta por router — NO global — mientras el legacyHandler siga
// leyendo el stream crudo con parseBody para las rutas aún no migradas.
export const jsonBody = express.json({ limit: '1mb' });

// AUD-20: rate limiter en memoria (Map<`${tag}:${ip}`, {count, resetAt}>). UNA sola instancia
// compartida por server.js y todos los routers, para que el conteo sea global por endpoint/IP.
const _rateLimitMap = new Map();

function clientIp(req) {
  // `trust proxy` está activo en el wrapper Express; respetamos X-Forwarded-For si llega.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconocida';
}

// Aplica rate limiting a un endpoint sensible. Devuelve true si pasa; si excede responde 429
// (con Retry-After) y devuelve false — el handler debe `return` sin seguir.
export function aplicarRateLimit(req, res, tag, { max, windowMs }) {
  const r = rateLimitCheck(_rateLimitMap, `${tag}:${clientIp(req)}`, Date.now(), { max, windowMs });
  if (!r.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)),
      ...CORS_HEADERS,
    });
    res.end(JSON.stringify({
      error: 'Demasiadas solicitudes. Espera unos segundos e intenta de nuevo.',
      codigo: 'rate_limit',
    }));
    return false;
  }
  return true;
}
