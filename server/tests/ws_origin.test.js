import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originPermitido } from '../utils/ws-usuarios-activos.js';

// AUD-21 — pruebas de la lógica pura de allowlist de Origin (sin red/BD).

test('same-origin (host del Origin == Host del request) → permitido', () => {
  assert.equal(
    originPermitido('https://bitacora.gecelca.com', 'bitacora.gecelca.com', undefined),
    true,
  );
  // con puerto explícito en ambos
  assert.equal(
    originPermitido('http://localhost:3002', 'localhost:3002', undefined),
    true,
  );
});

test('Origin de otro host sin estar en allowlist → rechazado', () => {
  assert.equal(
    originPermitido('https://evil.example.com', 'bitacora.gecelca.com', undefined),
    false,
  );
  // mismo nombre, distinto puerto = distinto host → rechazado
  assert.equal(
    originPermitido('http://localhost:9999', 'localhost:3002', undefined),
    false,
  );
});

test('Origin en WS_ALLOWED_ORIGINS → permitido (origin completo)', () => {
  assert.equal(
    originPermitido('http://localhost:5174', 'localhost:3002', 'http://localhost:5174'),
    true,
  );
});

test('WS_ALLOWED_ORIGINS acepta host pelado y listas CSV con espacios', () => {
  assert.equal(
    originPermitido('http://localhost:5174', 'localhost:3002', 'foo.com, localhost:5174'),
    true,
  );
  assert.equal(
    originPermitido('https://app.gecelca.com', 'bitacora.gecelca.com', 'https://app.gecelca.com , other.com'),
    true,
  );
});

test('Origin no listado aunque haya allowlist → rechazado', () => {
  assert.equal(
    originPermitido('https://evil.example.com', 'bitacora.gecelca.com', 'http://localhost:5174,app.gecelca.com'),
    false,
  );
});

test('Origin ausente → permitido (decisión AUD-21: los navegadores siempre envían Origin; ausente = cliente no-browser, no es vector CSWSH)', () => {
  assert.equal(originPermitido(undefined, 'bitacora.gecelca.com', undefined), true);
  assert.equal(originPermitido('', 'bitacora.gecelca.com', 'http://localhost:5174'), true);
});

test('Origin presente pero malformado → rechazado', () => {
  assert.equal(originPermitido('not-a-url', 'bitacora.gecelca.com', undefined), false);
});
