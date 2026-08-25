import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  necesitaCatchup, periodoDesdeDe, msHastaProximaMarca, MIN_DELAY_MS,
} from '../utils/sis/sis-sweeper-helpers.js';

// D-060: helpers puros del sweeper del SIS (sin BD, sin red, sin timers). Fijan la regla que
// hacía falta para que el periodo 24 se cargue: un día está cerrado SOLO con 24/24, la repesca
// arranca en ultimo_periodo+1 cuando lo previo es contiguo, y el tick se alinea a HH:02.

test('necesitaCatchup: sin fila ⇒ true', () => {
  assert.equal(necesitaCatchup(null), true);
  assert.equal(necesitaCatchup(undefined), true);
});

test('necesitaCatchup: completo=0 ⇒ true (aunque ultimo sea 24)', () => {
  assert.equal(necesitaCatchup({ completo: false, ultimo_periodo: 24, periodos_error: 1 }), true);
  assert.equal(necesitaCatchup({ completo: 0, ultimo_periodo: 24, periodos_error: 0 }), true);
});

test('necesitaCatchup: completo=1 con ultimo=23 (el flag mentiroso pre-D-060) ⇒ true', () => {
  assert.equal(necesitaCatchup({ completo: true, ultimo_periodo: 23, periodos_error: 0 }), true);
  assert.equal(necesitaCatchup({ completo: 1, ultimo_periodo: 15, periodos_error: 0 }), true);
});

test('necesitaCatchup: completo=1 con ultimo=24 ⇒ false (día cerrado)', () => {
  assert.equal(necesitaCatchup({ completo: true, ultimo_periodo: 24, periodos_error: 0 }), false);
  assert.equal(necesitaCatchup({ completo: 1, ultimo_periodo: 24, periodos_error: 0 }), false);
});

test('periodoDesdeDe: contiguo sin errores ⇒ ultimo+1; el caso típico 23 ⇒ 24', () => {
  assert.equal(periodoDesdeDe({ periodos_error: 0, ultimo_periodo: 23 }), 24);
  assert.equal(periodoDesdeDe({ periodos_error: 0, ultimo_periodo: 9 }), 10);
});

test('periodoDesdeDe: sin fila, con errores, ultimo NULL/0/24 ⇒ 1 (día completo)', () => {
  assert.equal(periodoDesdeDe(null), 1);
  assert.equal(periodoDesdeDe({ periodos_error: 2, ultimo_periodo: 23 }), 1);
  assert.equal(periodoDesdeDe({ periodos_error: 0, ultimo_periodo: null }), 1);
  assert.equal(periodoDesdeDe({ periodos_error: 0, ultimo_periodo: 0 }), 1);
  assert.equal(periodoDesdeDe({ periodos_error: 0, ultimo_periodo: 24 }), 1);
});

test('msHastaProximaMarca: 10:59:30 ⇒ 150 s hasta las 11:02', () => {
  const now = new Date('2026-08-25T15:59:30Z'); // 10:59:30 Bogotá
  assert.equal(msHastaProximaMarca(now, 2), 150_000);
});

test('msHastaProximaMarca: justo en la marca 10:02:00 ⇒ una hora completa', () => {
  const now = new Date('2026-08-25T15:02:00Z');
  assert.equal(msHastaProximaMarca(now, 2), 3_600_000);
});

test('msHastaProximaMarca: pasada la marca (10:02:30) ⇒ hasta las 11:02', () => {
  const now = new Date('2026-08-25T15:02:30Z');
  assert.equal(msHastaProximaMarca(now, 2), 3_600_000 - 30_000);
});

test('msHastaProximaMarca: a 30 s de la marca ⇒ respeta el mínimo de 60 s', () => {
  const now = new Date('2026-08-25T15:01:30Z');
  assert.equal(msHastaProximaMarca(now, 2), MIN_DELAY_MS);
});

test('msHastaProximaMarca: default = minuto 2', () => {
  const now = new Date('2026-08-25T15:00:00Z');
  assert.equal(msHastaProximaMarca(now), 120_000);
});
