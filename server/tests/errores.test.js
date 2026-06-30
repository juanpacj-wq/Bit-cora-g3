// Saneamiento de errores hacia el cliente (sin BD — unit test puro).
//
// Regresión: un fallo de conexión a la BD desde una red sin acceso producía
// `{ error: "Failed to connect to 192.168.17.20\\mssqlg3 in 15000ms" }`, que el frontend mostraba
// tal cual. Era (a) una brecha de seguridad (filtraba host/instancia/puerto) y (b) incomprensible.
// Estos tests fijan que clasificarError/mensajeUsuario nunca expongan el detalle técnico.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { clasificarError, mensajeUsuario, ETIQUETAS, expressErrorHandler } from '../utils/errores.js';

test('error de conexión a la BD (el del screenshot) → 503 db_no_disponible, sin filtrar internals', () => {
  const err = Object.assign(
    new Error('Failed to connect to 192.168.17.20\\mssqlg3 in 15000ms'),
    { name: 'ConnectionError', code: 'ETIMEOUT' },
  );
  const { status, codigo } = clasificarError(err);
  assert.equal(status, 503);
  assert.equal(codigo, 'db_no_disponible');
  const msg = mensajeUsuario(err);
  assert.doesNotMatch(msg, /192\.168|mssqlg3|15000ms|Failed to connect/i, 'no debe filtrar host/instancia/puerto');
  assert.equal(msg, ETIQUETAS.db_no_disponible);
});

test('socket rechazado / red sin ruta → db_no_disponible', () => {
  for (const code of ['ECONNREFUSED', 'ESOCKET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']) {
    const { codigo } = clasificarError(Object.assign(new Error('x'), { code }));
    assert.equal(codigo, 'db_no_disponible', `code=${code}`);
  }
});

test('timeout de request a la BD → 503 db_timeout (distinto de conexión)', () => {
  const err = Object.assign(new Error('Timeout: Request failed'), { name: 'RequestError', code: 'ETIMEOUT' });
  const { status, codigo } = clasificarError(err);
  assert.equal(status, 503);
  assert.equal(codigo, 'db_timeout');
});

test('error SQL (constraint / conversión) → 500 db_error genérico', () => {
  const err = Object.assign(new Error('Violation of UNIQUE KEY constraint UQ_x'), { name: 'RequestError', number: 2627 });
  const { status, codigo } = clasificarError(err);
  assert.equal(status, 500);
  assert.equal(codigo, 'db_error');
  assert.doesNotMatch(mensajeUsuario(err), /UNIQUE|constraint|UQ_/i);
});

test('cuerpo no-JSON (parseBody rechaza) → 400 cuerpo_invalido', () => {
  const { status, codigo } = clasificarError(new SyntaxError('Unexpected token < in JSON at position 0'));
  assert.equal(status, 400);
  assert.equal(codigo, 'cuerpo_invalido');
});

test('error desconocido → 500 error_interno, nunca el mensaje crudo', () => {
  const { status, codigo } = clasificarError(new Error('algún detalle interno sensible'));
  assert.equal(status, 500);
  assert.equal(codigo, 'error_interno');
  assert.doesNotMatch(mensajeUsuario(new Error('algún detalle interno sensible')), /sensible/);
});

test('toda etiqueta es texto amigable en español, no un slug', () => {
  for (const [codigo, texto] of Object.entries(ETIQUETAS)) {
    assert.ok(texto.length > 15 && /\s/.test(texto), `etiqueta ${codigo} parece un slug: "${texto}"`);
  }
});

// ── expressErrorHandler: capa Express (D-032) — integración end-to-end ──────────
// El error-handler real montado de último en auth/app.js. Antes, un error propagado por el
// middleware de express-session (store mssql sin BD) subía al handler por defecto de Express y
// filtraba el host de la BD en HTML. Levantamos un Express mínimo con el MISMO handler exportado.

function levantarApp() {
  const app = express();
  app.get('/boom-conexion', (req, res, next) => {
    next(Object.assign(
      new Error('Failed to connect to 192.168.17.20\\mssqlg3 in 15000ms'),
      { name: 'ConnectionError', code: 'ETIMEOUT' },
    ));
  });
  app.get('/boom-generico', (req, res, next) => next(new Error('detalle interno sensible: secreto=abc')));
  app.get('/ok', (req, res) => res.json({ ok: true }));
  app.use(expressErrorHandler);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('expressErrorHandler: fallo de conexión del store → 503 saneado, sin filtrar el host de BD', async () => {
  const { srv, port } = await levantarApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/boom-conexion`);
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.equal(body.codigo, 'db_no_disponible');
    assert.equal(body.error, ETIQUETAS.db_no_disponible);
    assert.doesNotMatch(JSON.stringify(body), /192\.168|mssqlg3|15000ms|Failed to connect/i,
      'la respuesta NO debe filtrar host/instancia/puerto de la BD');
  } finally { srv.close(); }
});

test('expressErrorHandler: error genérico → 500 error_interno, sin filtrar el detalle', async () => {
  const { srv, port } = await levantarApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/boom-generico`);
    const body = await r.json();
    assert.equal(r.status, 500);
    assert.equal(body.codigo, 'error_interno');
    assert.doesNotMatch(JSON.stringify(body), /sensible|secreto=abc/i);
  } finally { srv.close(); }
});

test('expressErrorHandler: una ruta sin error responde normal (no intercepta el camino feliz)', async () => {
  const { srv, port } = await levantarApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ok`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  } finally { srv.close(); }
});
