// AUD-06: prueba aislada (sin red ni BD) de la decisión del gate del backdoor de test.
// bypassHabilitado() es lógica pura: true solo si AUTH_TEST_BYPASS==='1' y NODE_ENV!=='production'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bypassHabilitado } from '../middleware/auth.js';

test('bypass on en dev (sin NODE_ENV) → habilitado', () => {
  assert.equal(bypassHabilitado({ AUTH_TEST_BYPASS: '1' }), true);
});

test('bypass on con NODE_ENV=development → habilitado', () => {
  assert.equal(bypassHabilitado({ AUTH_TEST_BYPASS: '1', NODE_ENV: 'development' }), true);
});

test('bypass on + NODE_ENV=production → deshabilitado (fail-closed)', () => {
  assert.equal(bypassHabilitado({ AUTH_TEST_BYPASS: '1', NODE_ENV: 'production' }), false);
});

test('bypass off (var ausente) → deshabilitado', () => {
  assert.equal(bypassHabilitado({}), false);
});

test('bypass off (valor distinto de "1") → deshabilitado', () => {
  assert.equal(bypassHabilitado({ AUTH_TEST_BYPASS: '0' }), false);
  assert.equal(bypassHabilitado({ AUTH_TEST_BYPASS: 'true', NODE_ENV: 'development' }), false);
});
