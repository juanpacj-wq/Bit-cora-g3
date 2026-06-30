// Saneamiento de errores hacia el cliente (sin BD — unit test puro).
//
// Regresión: un fallo de conexión a la BD desde una red sin acceso producía
// `{ error: "Failed to connect to 192.168.17.20\\mssqlg3 in 15000ms" }`, que el frontend mostraba
// tal cual. Era (a) una brecha de seguridad (filtraba host/instancia/puerto) y (b) incomprensible.
// Estos tests fijan que clasificarError/mensajeUsuario nunca expongan el detalle técnico.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarError, mensajeUsuario, ETIQUETAS } from '../utils/errores.js';

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
