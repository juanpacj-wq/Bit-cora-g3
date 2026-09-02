// Tests de lógica pura del endurecimiento (BIT-AUDSEG): NO tocan BD ni red.
// Cubren: rate limiter (AUD-20), check de Origin/CSRF (AUD-19), reflejo CORS por allowlist (AUD-16)
// y la clasificación 413/400 de los errores de express.json en errores.js (AUD-15/34/35).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitCheck, csrfOriginAllowed, corsHeadersFor, ALLOWED_ORIGINS } from '../utils/http.js';
import { clasificarError } from '../utils/errores.js';
import { csrfMiddleware, MUTADORES } from '../routes/_middleware.js';

// ── AUD-15/34/35: el tope de body lo enforcea express.json (limit '1mb'); su error se clasifica ──
// parseBody (lector de stream del if-chain) fue eliminado en E11. El límite hoy vive en el body
// parser global; acá verificamos que errores.js mapee sus errores a 413/400.
test('clasificarError mapea entity.too.large (express.json) a 413', () => {
  const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
  assert.deepEqual(clasificarError(err), { status: 413, codigo: 'cuerpo_demasiado_grande' });
});

test('clasificarError mapea entity.parse.failed (express.json) a 400', () => {
  const err = Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
  assert.deepEqual(clasificarError(err), { status: 400, codigo: 'cuerpo_invalido' });
});

// ── AUD-20: rate limiter ────────────────────────────────────────────────────
test('rateLimitCheck permite bajo el límite y bloquea al excederlo', () => {
  const map = new Map();
  const opts = { max: 3, windowMs: 1000 };
  const now = 1000;
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimitCheck(map, 'ip', now, opts).allowed, true, `req ${i + 1} debe pasar`);
  }
  assert.equal(rateLimitCheck(map, 'ip', now, opts).allowed, false, 'la 4ta debe bloquearse');
});

test('rateLimitCheck reinicia la cuenta tras la ventana', () => {
  const map = new Map();
  const opts = { max: 1, windowMs: 1000 };
  let now = 1000;
  assert.equal(rateLimitCheck(map, 'ip', now, opts).allowed, true);
  assert.equal(rateLimitCheck(map, 'ip', now, opts).allowed, false);
  now += 1000; // avanza una ventana completa
  const r = rateLimitCheck(map, 'ip', now, opts);
  assert.equal(r.allowed, true);
  assert.equal(r.count, 1);
});

test('rateLimitCheck aísla por key (endpoint/ip)', () => {
  const map = new Map();
  const opts = { max: 1, windowMs: 1000 };
  assert.equal(rateLimitCheck(map, 'a', 0, opts).allowed, true);
  assert.equal(rateLimitCheck(map, 'b', 0, opts).allowed, true);
  assert.equal(rateLimitCheck(map, 'a', 0, opts).allowed, false);
});

test('rateLimitCheck devuelve retryAfterMs no negativo', () => {
  const map = new Map();
  const r = rateLimitCheck(map, 'ip', 500, { max: 1, windowMs: 1000 });
  assert.ok(r.retryAfterMs >= 0 && r.retryAfterMs <= 1000);
});

// ── AUD-19: check de Origin / CSRF ──────────────────────────────────────────
test('csrfOriginAllowed: same-origin permitido', () => {
  assert.equal(csrfOriginAllowed('https://bitacora.local', 'bitacora.local', []), true);
});

test('csrfOriginAllowed: same-origin con puerto permitido', () => {
  assert.equal(csrfOriginAllowed('http://localhost:5174', 'localhost:5174', []), true);
});

test('csrfOriginAllowed: origen ajeno bloqueado', () => {
  assert.equal(csrfOriginAllowed('https://evil.example', 'bitacora.local', []), false);
});

test('csrfOriginAllowed: allowlist permite un origen distinto al host', () => {
  assert.equal(csrfOriginAllowed('https://amigo.com', 'bitacora.local', ['https://amigo.com']), true);
});

test('csrfOriginAllowed: Origin ausente se permite (server-to-server)', () => {
  assert.equal(csrfOriginAllowed('', 'bitacora.local', []), true);
  assert.equal(csrfOriginAllowed(undefined, 'bitacora.local', []), true);
});

test('csrfOriginAllowed: Origin malformado se bloquea', () => {
  assert.equal(csrfOriginAllowed('no-es-url', 'bitacora.local', []), false);
});

test('csrfOriginAllowed: DEV tolera loopback↔loopback (proxy Vite); PROD estricto', () => {
  // Dev: el proxy de Vite (changeOrigin) reescribe Host a :3002 mientras el navegador manda
  // Origin :5174; ambos loopback → se permite (si no, todo POST del front de dev daría 403).
  assert.equal(csrfOriginAllowed('http://localhost:5174', 'localhost:3002', []), true);
  assert.equal(csrfOriginAllowed('http://127.0.0.1:5174', 'localhost:3002', []), true);
  // Loopback vs no-loopback NO se tolera ni en dev.
  assert.equal(csrfOriginAllowed('http://localhost:5174', 'bitacora.local', []), false);
  // En producción el atajo no aplica.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(csrfOriginAllowed('http://localhost:5174', 'localhost:3002', []), false);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ── AUD-16: reflejo CORS según allowlist ────────────────────────────────────
test('corsHeadersFor refleja según la allowlist activa o cae a wildcard', () => {
  if (ALLOWED_ORIGINS.length === 0) {
    // Sin CORS_ALLOWED_ORIGINS: comportamiento histórico (wildcard).
    assert.equal(corsHeadersFor('https://x.com')['Access-Control-Allow-Origin'], '*');
  } else {
    const ok = ALLOWED_ORIGINS[0];
    assert.equal(corsHeadersFor(ok)['Access-Control-Allow-Origin'], ok);
    assert.equal(corsHeadersFor('https://nope.invalid')['Access-Control-Allow-Origin'], undefined);
  }
});

// ── AUD-19 · la LISTA de verbos mutadores (GATE-O3 de D-065, hallazgo H-L07-1) ──────────────────
// El chequeo de Origin de csrfMiddleware se aplica a una lista escrita a mano. Un verbo que no esté
// ahí nace SIN la defensa same-origin aunque el endpoint sea normal: fue lo que pasó con `PATCH`
// cuando D-065 estrenó `PATCH /api/rotacion/patrones/:id`. Lo único que lo tapaba era que
// `Access-Control-Allow-Methods` no anuncia PATCH, o sea el preflight del navegador — una defensa
// de otra cosa. Este caso fija la lista para que agregar un verbo sin cubrirlo salga rojo.
function correrCsrf(method, origin) {
  const req = { method, headers: origin ? { origin, host: 'bitacora.local' } : { host: 'bitacora.local' } };
  const res = {
    status: null, cuerpo: null,
    writeHead(status) { this.status = status; return this; },
    end(body) { this.cuerpo = body; },
  };
  let paso = false;
  csrfMiddleware(req, res, () => { paso = true; });
  return { paso, status: res.status, codigo: res.cuerpo ? JSON.parse(res.cuerpo).codigo : null };
}

test('csrfMiddleware rechaza un Origin ajeno en TODOS los verbos mutadores, PATCH incluido', () => {
  assert.deepEqual(MUTADORES, ['POST', 'PUT', 'PATCH', 'DELETE'],
    'la lista de verbos mutadores es la fuente única del chequeo de Origin (AUD-19)');
  for (const m of MUTADORES) {
    const r = correrCsrf(m, 'https://evil.example.com');
    assert.equal(r.paso, false, `${m} con Origin ajeno no debe pasar al router`);
    assert.equal(r.status, 403, `${m} con Origin ajeno debe salir 403`);
    assert.equal(r.codigo, 'origen_no_permitido', `${m} debe traer el slug estable (D-032)`);
  }
});

test('csrfMiddleware deja pasar GET y los mutadores same-origin o sin Origin', () => {
  assert.equal(correrCsrf('GET', 'https://evil.example.com').paso, true, 'un GET no muta: no se filtra acá');
  for (const m of MUTADORES) {
    assert.equal(correrCsrf(m, null).paso, true, `${m} sin Origin (server-to-server) se permite`);
    assert.equal(correrCsrf(m, 'https://bitacora.local').paso, true, `${m} same-origin pasa`);
  }
});

test('csrfMiddleware ↔ Access-Control-Allow-Methods: todo verbo mutador se anuncia en el preflight', () => {
  // Las dos mitades del mismo contrato (CR3-3). Si un verbo está en MUTADORES pero no en
  // Access-Control-Allow-Methods, el preflight del navegador lo bloquea en un despliegue
  // cross-origin y el endpoint nunca se alcanza, sin rastro server-side.
  const anunciados = corsHeadersFor(undefined)['Access-Control-Allow-Methods']
    .split(',').map((m) => m.trim());
  for (const m of MUTADORES) {
    assert.ok(anunciados.includes(m), `${m} muta estado pero no se anuncia en el preflight: ${anunciados.join(', ')}`);
  }
  assert.ok(anunciados.includes('OPTIONS'), 'el preflight tiene que anunciarse a sí mismo');
});
