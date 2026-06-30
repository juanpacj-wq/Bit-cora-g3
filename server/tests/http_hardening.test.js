// Tests de lógica pura del endurecimiento (BIT-AUDSEG): NO tocan BD ni red.
// Cubren: tope de body (AUD-15), rate limiter (AUD-20), check de Origin/CSRF (AUD-19),
// reflejo CORS por allowlist (AUD-16) y la clasificación 413 en errores.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  MAX_BODY_BYTES, parseBody, rateLimitCheck, csrfOriginAllowed, corsHeadersFor, ALLOWED_ORIGINS,
} from '../utils/http.js';
import { clasificarError } from '../utils/errores.js';

// ── AUD-15: parseBody con tope ──────────────────────────────────────────────
test('MAX_BODY_BYTES es un entero positivo razonable', () => {
  assert.equal(typeof MAX_BODY_BYTES, 'number');
  assert.ok(MAX_BODY_BYTES >= 1000);
});

test('parseBody rechaza body que excede MAX_BODY_BYTES', async () => {
  const req = new EventEmitter();
  req.destroy = () => {};
  const p = parseBody(req);
  req.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)); // 'a' * (límite + 1)
  await assert.rejects(p, (err) => err.code === 'cuerpo_demasiado_grande');
});

test('parseBody parsea JSON válido bajo el límite', async () => {
  const req = new EventEmitter();
  req.destroy = () => {};
  const p = parseBody(req);
  req.emit('data', '{"a":1}');
  req.emit('end');
  assert.deepEqual(await p, { a: 1 });
});

test('parseBody resuelve {} con body vacío', async () => {
  const req = new EventEmitter();
  req.destroy = () => {};
  const p = parseBody(req);
  req.emit('end');
  assert.deepEqual(await p, {});
});

test('clasificarError mapea cuerpo_demasiado_grande a 413', () => {
  const err = Object.assign(new Error('big'), { code: 'cuerpo_demasiado_grande' });
  assert.deepEqual(clasificarError(err), { status: 413, codigo: 'cuerpo_demasiado_grande' });
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
