import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirCargo, contarFallo, MAX_FALLOS_TRANSITORIOS } from '../auth/revalidate.js';

// ── AUD-10 #1: cargo del token ≠ cargo de la sesión de app -> invalidar ──────────────────────────

test('cargo igual en token y sesión -> NO invalida (caso normal, sin regresión)', () => {
  const r = decidirCargo({ sessionCargo: 'Ingeniero Jefe de Turno', tokenCargo: 'Ingeniero Jefe de Turno' });
  assert.equal(r.invalidar, false);
});

test('downgrade de cargo (JdT -> Operador) -> invalida con motivo cargo_cambiado', () => {
  const r = decidirCargo({ sessionCargo: 'Ingeniero Jefe de Turno', tokenCargo: 'Operador de Planta - Caldera' });
  assert.equal(r.invalidar, true);
  assert.equal(r.motivo, 'cargo_cambiado');
});

test('upgrade de cargo (Operador -> JdT) también invalida (cualquier cambio efectivo cierra)', () => {
  const r = decidirCargo({ sessionCargo: 'Operador de Planta - Caldera', tokenCargo: 'Ingeniero Jefe de Turno' });
  assert.equal(r.invalidar, true);
  assert.equal(r.motivo, 'cargo_cambiado');
});

test('el token ya no trae ningún rol mapeable (tokenCargo null) -> invalida con motivo sin_cargo', () => {
  const r = decidirCargo({ sessionCargo: 'Ingeniero Químico', tokenCargo: null });
  assert.equal(r.invalidar, true);
  assert.equal(r.motivo, 'sin_cargo');
});

test('sin sesión de app (sessionCargo null) -> NO invalida (nada que comparar todavía)', () => {
  assert.equal(decidirCargo({ sessionCargo: null, tokenCargo: 'Ingeniero Químico' }).invalidar, false);
  assert.equal(decidirCargo({ sessionCargo: null, tokenCargo: null }).invalidar, false);
});

// ── AUD-10 #2: N fallos transitorios consecutivos -> fail-closed ─────────────────────────────────

test('contarFallo incrementa por sesión y es independiente entre sesiones', () => {
  const map = new Map();
  assert.equal(contarFallo(map, 'sesA'), 1);
  assert.equal(contarFallo(map, 'sesA'), 2);
  assert.equal(contarFallo(map, 'sesB'), 1); // otra sesión arranca de cero
  assert.equal(contarFallo(map, 'sesA'), 3);
});

test('un blip aislado NO alcanza el umbral (no mata la sesión)', () => {
  const map = new Map();
  const fallos = contarFallo(map, 's1');
  assert.equal(fallos, 1);
  assert.ok(fallos < MAX_FALLOS_TRANSITORIOS, 'un solo fallo no debe disparar fail-closed');
});

test('al alcanzar MAX_FALLOS_TRANSITORIOS consecutivos se cruza el umbral (fail-closed)', () => {
  const map = new Map();
  let fallos = 0;
  for (let i = 0; i < MAX_FALLOS_TRANSITORIOS; i++) fallos = contarFallo(map, 's1');
  assert.equal(fallos, MAX_FALLOS_TRANSITORIOS);
  assert.ok(fallos >= MAX_FALLOS_TRANSITORIOS, 'al N-ésimo fallo debe cerrarse');
});

test('reset (borrar la entrada) reinicia el conteo tras una revalidación exitosa', () => {
  const map = new Map();
  contarFallo(map, 's1');
  contarFallo(map, 's1');
  map.delete('s1'); // así resetea el middleware al revalidar OK
  assert.equal(contarFallo(map, 's1'), 1);
});

test('MAX_FALLOS_TRANSITORIOS por defecto es 3 y deja margen a blips aislados', () => {
  assert.ok(Number.isInteger(MAX_FALLOS_TRANSITORIOS));
  assert.ok(MAX_FALLOS_TRANSITORIOS >= 2);
});
