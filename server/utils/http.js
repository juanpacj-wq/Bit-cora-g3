// AUD-06: X-Sesion-Id solo lo usa el backdoor de test (bypass). Fuera de ese gate (p.ej. en
// producción) no se anuncia como header permitido. Mismo criterio que bypassHabilitado() en
// middleware/auth.js; se evalúa inline para no acoplar http.js con la cadena de import de la BD.
const bypassActivo = process.env.AUTH_TEST_BYPASS === '1' && process.env.NODE_ENV !== 'production';
const ALLOW_HEADERS = bypassActivo
  ? 'Content-Type, Authorization, X-Sesion-Id'
  : 'Content-Type, Authorization';

// AUD-15: tope de tamaño del body para parseBody. Sin esto, `data += chunk` acumulaba sin
// límite y un POST muy grande podía agotar la memoria del proceso (DoS). 1 MB es holgado para
// el batch más grande del sistema (MAND: 24 periodos × 3 tipos × 2 plantas; COMB: 24 × 10
// combustibles). Exportado para que el test lo referencie sin hardcodear.
export const MAX_BODY_BYTES = 1_000_000;

// AUD-16: CORS allowlist-driven. `CORS_ALLOWED_ORIGINS` es un CSV de orígenes permitidos
// (ej. "https://bitacora.gecelca.com,https://otro.host").
//  - Si NO está seteada: se conserva el comportamiento actual (Access-Control-Allow-Origin: '*')
//    + un warn en producción. Así no se rompen despliegues que aún no definen la env.
//  - Si está seteada: se refleja el Origin del request SOLO si está en la allowlist; si no, la
//    respuesta no lleva ACAO. El front es same-origin (no necesita ACAO) y el consumidor cross-repo
//    (dashboard-gen-gec3) llama server-to-server sin navegador, así que tampoco depende de CORS.
export const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('  ⚠  CORS abierto (Access-Control-Allow-Origin: *) — define CORS_ALLOWED_ORIGINS para restringir orígenes en producción.');
}

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
};

// Devuelve los headers CORS apropiados para el `origin` del request (reflejo controlado por la
// allowlist). Úsalo en el preflight y donde tengas el request a mano; el resto cae al estático.
export function corsHeadersFor(origin) {
  if (ALLOWED_ORIGINS.length === 0) {
    // Sin allowlist configurada: comportamiento histórico (wildcard).
    return { 'Access-Control-Allow-Origin': '*', ...CORS_BASE };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', ...CORS_BASE };
  }
  // Origen ausente o no permitido: sin ACAO. El front same-origin no lo requiere.
  return { Vary: 'Origin', ...CORS_BASE };
}

// Headers CORS estáticos por defecto. Compat: lo importa errores.js (responderError) y es el
// fallback de sendJSON. Refleja la política sin un origin concreto: '*' si la allowlist está
// vacía; sin ACAO si está activa.
export const CORS_HEADERS = corsHeadersFor(undefined);

// AUD-19: ¿el Origin de un mutador es de confianza? Confiamos si es same-origin (su host coincide
// con el Host del request: el propio front) o si está en la allowlist de CORS. El llamador solo
// invoca esto cuando HAY header Origin; Origin ausente (server-to-server, p.ej. el dashboard
// cross-repo o curl) se permite aguas arriba para no romper integraciones server-side. Pura.
function esLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function csrfOriginAllowed(origin, host, allowedOrigins = ALLOWED_ORIGINS) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    // DEV ONLY: detrás del proxy de Vite con changeOrigin:true, el Host se reescribe al target
    // (localhost:3002) mientras el navegador sigue mandando Origin localhost:5174. Ambos son
    // loopback del MISMO equipo, así que en entornos NO productivos lo tratamos como same-origin
    // (si no, todo POST del front de dev daría 403). En producción NO aplica: front y back comparten
    // host real, así que `o.host === host` ya basta y este atajo queda inerte.
    if (process.env.NODE_ENV !== 'production') {
      let hostName = '';
      try { hostName = new URL(`http://${host}`).hostname; } catch { /* host inválido */ }
      if (esLoopback(o.hostname) && esLoopback(hostName)) return true;
    }
  } catch {
    // origin malformado → no es de confianza
  }
  return false;
}

// AUD-20: rate limiter en memoria, ventana fija. Pura y testeable: muta `map`
// (Map<key, {count, resetAt}>) y devuelve si la request cabe en la ventana actual. Limpia
// entradas vencidas cuando el map crece, para no acumular memoria por keys/IP efímeras.
export function rateLimitCheck(map, key, now, { max, windowMs }) {
  if (map.size > 5000) {
    for (const [k, v] of map) { if (now >= v.resetAt) map.delete(k); }
  }
  let entry = map.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    map.set(key, entry);
  }
  entry.count += 1;
  return {
    allowed: entry.count <= max,
    count: entry.count,
    resetAt: entry.resetAt,
    retryAfterMs: Math.max(0, entry.resetAt - now),
  };
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      // AUD-15: medir bytes reales y cortar si excede el tope.
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error('Cuerpo de la petición demasiado grande');
        err.code = 'cuerpo_demasiado_grande';
        req.destroy();
        return reject(err);
      }
      data += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

export function sendJSON(res, status, payload, corsHeaders = CORS_HEADERS) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify(payload));
}
