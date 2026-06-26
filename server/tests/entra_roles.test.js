import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCargo, ROLE_TO_CARGO, PRECEDENCE } from '../utils/entra-roles.js';

// Mapeo 1:1 — los 12 App Roles deben mapear a los 12 cargos sembrados en db.js.
test('ROLE_TO_CARGO cubre los 12 App Roles y todos están en PRECEDENCE', () => {
  assert.equal(Object.keys(ROLE_TO_CARGO).length, 12);
  for (const role of Object.keys(ROLE_TO_CARGO)) {
    assert.ok(PRECEDENCE.includes(role), `${role} debe estar en PRECEDENCE`);
  }
  assert.equal(PRECEDENCE.length, 12);
});

test('rol único → su cargo', () => {
  assert.equal(resolveCargo(['INGENIERO_QUIMICO']).cargoNombre, 'Ingeniero Químico');
  assert.equal(resolveCargo(['OPERADOR_PLANTA_CALDERA']).cargoNombre, 'Operador de Planta - Caldera');
  assert.equal(resolveCargo(['COORDINADOR_CARBON_MAQUINARIA']).cargoNombre, 'Coordinador de carbón y maquinaria');
});

test('multi-rol → gana el de mayor precedencia (JdT sobre operador)', () => {
  const r = resolveCargo(['OPERADOR_PLANTA_CALDERA', 'JEFE_DE_TURNO']);
  assert.equal(r.role, 'JEFE_DE_TURNO');
  assert.equal(r.cargoNombre, 'Ingeniero Jefe de Turno');
});

test('multi-rol → un rol operativo gana sobre Gerente (solo lectura)', () => {
  const r = resolveCargo(['GERENTE_PRODUCCION', 'INGENIERO_OPERACION']);
  assert.equal(r.role, 'INGENIERO_OPERACION');
});

test('orden de precedencia: IngOp sobre IngQuímico sobre Coordinador', () => {
  assert.equal(resolveCargo(['INGENIERO_QUIMICO', 'INGENIERO_OPERACION']).role, 'INGENIERO_OPERACION');
  assert.equal(resolveCargo(['COORDINADOR_CARBON_MAQUINARIA', 'INGENIERO_QUIMICO']).role, 'INGENIERO_QUIMICO');
});

test('sin rol conocido → null (el caller responde 403)', () => {
  assert.equal(resolveCargo([]), null);
  assert.equal(resolveCargo(['ROL_DESCONOCIDO']), null);
  assert.equal(resolveCargo(undefined), null);
  assert.equal(resolveCargo(null), null);
});

test('roles desconocidos se ignoran si hay al menos uno conocido', () => {
  const r = resolveCargo(['ROL_X', 'OPERADOR_PLANTA_TURBOGRUPO', 'ROL_Y']);
  assert.equal(r.cargoNombre, 'Operador de Planta - Turbogrupo');
});
