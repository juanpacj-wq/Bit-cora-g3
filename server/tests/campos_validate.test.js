// AUD-39 (BIT-AUDSEG-2026-001): validación de campos_extra sin BD.
// Cubre: clave extra descartada (anti mass-assignment), campo declarado conservado,
// string sobre-largo rechazado, y tope de bytes del JSON total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCamposExtra } from '../utils/campos.js';

test('AUD-39: clave extra no declarada se descarta', () => {
  const def = [{ campo: 'observacion', tipo: 'text' }];
  const input = { observacion: 'ok', es_admin: true, __proto__pollute: 1, otraCosa: 'x' };
  const r = validateCamposExtra(def, input);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['observacion']);
  assert.equal(r.data.observacion, 'ok');
  assert.equal('es_admin' in r.data, false);
  assert.equal('otraCosa' in r.data, false);
});

test('AUD-39: campos declarados (text/int/float/select) se conservan y normalizan', () => {
  const def = [
    { campo: 'observacion', tipo: 'text' },
    { campo: 'edad', tipo: 'int' },
    { campo: 'temp', tipo: 'float' },
    { campo: 'estado', tipo: 'select', opciones: ['A', 'B'] },
  ];
  const input = { observacion: 'hola', edad: '42', temp: '3.5', estado: 'B', extra: 'fuera' };
  const r = validateCamposExtra(def, input);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.data.observacion, 'hola');
  assert.equal(r.data.edad, 42);          // string → int
  assert.equal(r.data.temp, 3.5);         // string → float
  assert.equal(r.data.estado, 'B');
  assert.equal('extra' in r.data, false); // no declarado → descartado
});

test('AUD-39: string sobre-largo es rechazado', () => {
  const def = [{ campo: 'observacion', tipo: 'text' }];
  const input = { observacion: 'x'.repeat(5001) };
  const r = validateCamposExtra(def, input);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length >= 1, true);
  assert.match(r.errors.join(' '), /excede 5000 caracteres/);
});

test('AUD-39: string en el límite (5000) se acepta', () => {
  const def = [{ campo: 'observacion', tipo: 'text' }];
  const input = { observacion: 'x'.repeat(5000) };
  const r = validateCamposExtra(def, input);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.data.observacion.length, 5000);
});

test('AUD-39: requerido faltante produce error', () => {
  const def = [{ campo: 'obligatorio', tipo: 'text', requerido: true }];
  const r = validateCamposExtra(def, {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /obligatorio es requerido/);
});

test('definición nula → passthrough sin data', () => {
  const r = validateCamposExtra(null, { lo: 'que sea' });
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
});
