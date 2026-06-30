// AUD-06: X-Sesion-Id solo lo usa el backdoor de test (bypass). Fuera de ese gate (p.ej. en
// producción) no se anuncia como header permitido. Mismo criterio que bypassHabilitado() en
// middleware/auth.js; se evalúa inline para no acoplar http.js con la cadena de import de la BD.
const bypassActivo = process.env.AUTH_TEST_BYPASS === '1' && process.env.NODE_ENV !== 'production';
const ALLOW_HEADERS = bypassActivo
  ? 'Content-Type, Authorization, X-Sesion-Id'
  : 'Content-Type, Authorization';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
};

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(payload));
}
