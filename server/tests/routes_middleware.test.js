// AUD-34/35 (D-037) — middleware transversal del pipeline Express unificado. Tests puros (sin BD):
// levantan un Express mínimo con los mismos middlewares exportados y verifican el gate por defecto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { esRutaPublica, requireEntra, corsMiddleware, csrfMiddleware } from '../routes/_middleware.js';

// ── esRutaPublica (pura) ────────────────────────────────────────────────────────────────────────
test('esRutaPublica: catálogos no-PII, eventos-dashboard, health y sus params son públicos', () => {
  assert.equal(esRutaPublica('GET', '/health'), true);
  assert.equal(esRutaPublica('GET', '/api/catalogos/plantas'), true);
  assert.equal(esRutaPublica('GET', '/api/catalogos/cargos'), true);
  assert.equal(esRutaPublica('GET', '/api/catalogos/bitacoras'), true);
  assert.equal(esRutaPublica('GET', '/api/catalogos/bitacoras/12/tipos-evento'), true);
  assert.equal(esRutaPublica('GET', '/api/catalogos/permisos/3'), true);
  assert.equal(esRutaPublica('GET', '/api/eventos-dashboard'), true);
  assert.equal(esRutaPublica('OPTIONS', '/cualquier/cosa'), true); // preflight
});

test('esRutaPublica: rutas de datos/PII NO son públicas', () => {
  assert.equal(esRutaPublica('GET', '/api/catalogos/jdt-actual'), false, 'jdt-actual devuelve PII');
  assert.equal(esRutaPublica('GET', '/api/catalogos/jefe'), false, 'jefe devuelve PII');
  assert.equal(esRutaPublica('GET', '/api/registros/activos'), false);
  assert.equal(esRutaPublica('GET', '/api/historicos'), false);
  assert.equal(esRutaPublica('GET', '/api/historicos/5'), false);
  assert.equal(esRutaPublica('POST', '/api/eventos-dashboard'), false, 'solo GET es público');
  assert.equal(esRutaPublica('POST', '/api/catalogos/plantas'), false, 'solo GET es público');
  // El param debe ser numérico: nada de path traversal por la allowlist.
  assert.equal(esRutaPublica('GET', '/api/catalogos/permisos/3/../registros'), false);
  assert.equal(esRutaPublica('GET', '/api/catalogos/bitacoras/abc/tipos-evento'), false);
});

// ── requireEntra (integración con Express real) ─────────────────────────────────────────────────
function appConGate({ user, bypassHeader } = {}) {
  const app = express();
  // Simula express-session: inyecta req.session según el caso.
  app.use((req, _res, next) => { req.session = user ? { user } : {}; next(); });
  app.use(requireEntra);
  app.get('/health', (req, res) => res.json({ ok: 'publico' }));
  app.get('/api/registros/activos', (req, res) => res.json({ ok: 'privado' }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('requireEntra: ruta pública pasa sin identidad', async () => {
  const { srv, port } = await appConGate();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: 'publico' });
  } finally { srv.close(); }
});

test('requireEntra: ruta privada sin identidad → 401', async () => {
  const { srv, port } = await appConGate();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/registros/activos`);
    const body = await r.json();
    assert.equal(r.status, 401);
    assert.equal(body.codigo, 'no_autenticado');
  } finally { srv.close(); }
});

test('requireEntra: ruta privada con identidad Entra (oid) → pasa', async () => {
  const { srv, port } = await appConGate({ user: { oid: 'OID-123' } });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/registros/activos`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: 'privado' });
  } finally { srv.close(); }
});

test('requireEntra: X-Sesion-Id NO abre el gate salvo con AUTH_TEST_BYPASS (fail-closed)', async () => {
  // En este proceso de test AUTH_TEST_BYPASS no está en '1' → el header debe ignorarse.
  const prev = process.env.AUTH_TEST_BYPASS;
  delete process.env.AUTH_TEST_BYPASS;
  const { srv, port } = await appConGate();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/registros/activos`, { headers: { 'X-Sesion-Id': '1' } });
    assert.equal(r.status, 401, 'sin el flag de bypass, X-Sesion-Id no debe autenticar');
  } finally {
    srv.close();
    if (prev !== undefined) process.env.AUTH_TEST_BYPASS = prev;
  }
});

// ── csrfMiddleware ──────────────────────────────────────────────────────────────────────────────
function appConCsrf() {
  const app = express();
  app.use(csrfMiddleware);
  app.post('/api/x', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('csrfMiddleware: POST con Origin cross-site → 403; sin Origin → pasa', async () => {
  const { srv, port } = await appConCsrf();
  try {
    const cross = await fetch(`http://127.0.0.1:${port}/api/x`, {
      method: 'POST', headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).codigo, 'origen_no_permitido');

    const sinOrigin = await fetch(`http://127.0.0.1:${port}/api/x`, { method: 'POST' });
    assert.equal(sinOrigin.status, 200, 'server-to-server sin Origin se permite');
  } finally { srv.close(); }
});

// ── corsMiddleware ──────────────────────────────────────────────────────────────────────────────
test('corsMiddleware: OPTIONS responde 204 y no cae al handler', async () => {
  const app = express();
  app.use(corsMiddleware);
  app.all('/api/x', (req, res) => res.status(500).json({ noDeberia: true }));
  const { srv, port } = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ srv: s, port: s.address().port }));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/x`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
  } finally { srv.close(); }
});
