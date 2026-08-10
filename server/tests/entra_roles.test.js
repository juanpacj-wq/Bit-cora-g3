import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCargo, ROLE_TO_CARGO, PRECEDENCE } from '../utils/entra-roles.js';

// Mapeo 1:1 — los 14 App Roles deben mapear a los 14 cargos sembrados en db.js
// (D-038: +admin; D-059: +USUARIO_CONSULTA).
test('ROLE_TO_CARGO cubre los 14 App Roles y todos están en PRECEDENCE', () => {
  assert.equal(Object.keys(ROLE_TO_CARGO).length, 14);
  for (const role of Object.keys(ROLE_TO_CARGO)) {
    assert.ok(PRECEDENCE.includes(role), `${role} debe estar en PRECEDENCE`);
  }
  assert.equal(PRECEDENCE.length, 14);
});

// D-038: rol ADMIN.
test('ADMINISTRADOR_DEBUGGING → cargo Administrador y Debugging', () => {
  const r = resolveCargo(['ADMINISTRADOR_DEBUGGING']);
  assert.equal(r.role, 'ADMINISTRADOR_DEBUGGING');
  assert.equal(r.cargoNombre, 'Administrador y Debugging');
});

test('multi-rol → Admin gana sobre cualquier otro rol (máxima precedencia)', () => {
  assert.equal(resolveCargo(['OPERADOR_PLANTA_CALDERA', 'ADMINISTRADOR_DEBUGGING']).role, 'ADMINISTRADOR_DEBUGGING');
  assert.equal(resolveCargo(['ADMINISTRADOR_DEBUGGING', 'JEFE_DE_TURNO']).role, 'ADMINISTRADOR_DEBUGGING');
  assert.equal(resolveCargo(['GERENTE_PRODUCCION', 'ADMINISTRADOR_DEBUGGING']).role, 'ADMINISTRADOR_DEBUGGING');
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

// D-059: USUARIO_CONSULTA es la MÍNIMA precedencia — cualquier otro rol (incluso Gerente,
// también solo-lectura) gana si coexisten.
test('USUARIO_CONSULTA → cargo USUARIO DE CONSULTA, y pierde ante cualquier otro rol', () => {
  const solo = resolveCargo(['USUARIO_CONSULTA']);
  assert.equal(solo.role, 'USUARIO_CONSULTA');
  assert.equal(solo.cargoNombre, 'USUARIO DE CONSULTA');
  assert.equal(resolveCargo(['USUARIO_CONSULTA', 'GERENTE_PRODUCCION']).role, 'GERENTE_PRODUCCION');
  assert.equal(resolveCargo(['USUARIO_CONSULTA', 'OPERADOR_PLANTA_TURBOGRUPO']).role, 'OPERADOR_PLANTA_TURBOGRUPO');
  assert.equal(PRECEDENCE[PRECEDENCE.length - 1], 'USUARIO_CONSULTA', 'debe ser el ÚLTIMO en PRECEDENCE');
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
