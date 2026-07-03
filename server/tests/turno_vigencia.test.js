// D-040 (persistencia por ventana de turno): `finalizacionVigente` acota la finalización a la
// ventana [inicio, fin) del turno actual — persiste dentro del turno (re-login / cambio de unidad
// ida y vuelta) y expira sola al arrancar el siguiente. Test PURO: sin BD ni servidor, instantes
// UTC fijos. Bogotá = UTC-5 sin DST → construimos instantes por wallclock Bogotá con offset -05:00.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizacionVigente, ventanaActual } from '../utils/turno.js';

const bog = (s) => new Date(`${s}-05:00`); // s = 'YYYY-MM-DDTHH:mm:ss' (wallclock Bogotá)

test('null / vacío / inválido → false (turno vivo)', () => {
  const ahora = bog('2026-07-03T10:00:00');
  assert.equal(finalizacionVigente(null, ahora), false);
  assert.equal(finalizacionVigente(undefined, ahora), false);
  assert.equal(finalizacionVigente('', ahora), false);
  assert.equal(finalizacionVigente('no-es-fecha', ahora), false);
});

test('mismo turno T1 → true', () => {
  // finalizó 08:00, ahora 16:00 — ambos en T1 [06:00, 18:00)
  assert.equal(finalizacionVigente(bog('2026-07-03T08:00:00'), bog('2026-07-03T16:00:00')), true);
});

test('finalización T1 evaluada en el T2 siguiente → false (expiró al cambiar de turno)', () => {
  assert.equal(finalizacionVigente(bog('2026-07-03T08:00:00'), bog('2026-07-03T20:00:00')), false);
});

test('T2 cruza medianoche: finalizó 23:00, ahora 02:00 del día siguiente → true (mismo turno)', () => {
  // T2 = [2026-07-03 18:00, 2026-07-04 06:00); ambos instantes caen dentro.
  assert.equal(finalizacionVigente(bog('2026-07-03T23:00:00'), bog('2026-07-04T02:00:00')), true);
});

test('finalización T2 evaluada en el T1 siguiente → false', () => {
  assert.equal(finalizacionVigente(bog('2026-07-03T23:00:00'), bog('2026-07-04T08:00:00')), false);
});

test('mismo número de turno pero otra fecha operativa (T1 de ayer vs T1 de hoy) → false', () => {
  assert.equal(finalizacionVigente(bog('2026-07-02T10:00:00'), bog('2026-07-03T10:00:00')), false);
});

test('borde: inicio inclusivo, fin exclusivo (T1)', () => {
  const ahora = bog('2026-07-03T10:00:00'); // T1
  const { inicio, fin } = ventanaActual(ahora);
  assert.equal(finalizacionVigente(inicio, ahora), true);                       // t == inicio → vigente
  assert.equal(finalizacionVigente(new Date(fin.getTime() - 1), ahora), true);  // justo antes del fin
  assert.equal(finalizacionVigente(fin, ahora), false);                         // t == fin → NO (exclusivo)
});
