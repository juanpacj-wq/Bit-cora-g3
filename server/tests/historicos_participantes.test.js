// D-050: unit tests puros (sin BD) de la derivación de participantes y del escape de LIKE.
// No importar routes/historicos.js acá: ese módulo arrastra db.js, que abre el pool al importarse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { participantesVisibles } from '../utils/participantes.js';
import { escapeLike } from '../utils/sql-like.js';
import { construirRangoAnios, DISP_ANIO_MIN } from '../utils/notificador.js';

const u = (usuario_id, nombre_completo) => ({ usuario_id, nombre_completo });

test('participantes = ingenieros menos quienes aparecen en jdts/jefes', () => {
  const r = participantesVisibles({
    ingenieros_snapshot: JSON.stringify([u(1, 'Operador Uno'), u(2, 'JdT Dos'), u(3, 'Jefe Tres'), u(4, 'IngQuim Cuatro')]),
    jdts_snapshot: JSON.stringify([u(2, 'JdT Dos')]),
    jefes_snapshot: JSON.stringify([u(3, 'Jefe Tres')]),
  });
  assert.deepEqual(r, [u(1, 'Operador Uno'), u(4, 'IngQuim Cuatro')]);
});

test('usuario en jdts Y jefes a la vez se excluye una sola vez sin duplicar', () => {
  const r = participantesVisibles({
    ingenieros_snapshot: JSON.stringify([u(5, 'Multi Rol'), u(6, 'Operador')]),
    jdts_snapshot: JSON.stringify([u(5, 'Multi Rol')]),
    jefes_snapshot: JSON.stringify([u(5, 'Multi Rol')]),
  });
  assert.deepEqual(r, [u(6, 'Operador')]);
});

test('snapshots vacíos, NULL o ausentes → []', () => {
  assert.deepEqual(participantesVisibles({}), []);
  assert.deepEqual(participantesVisibles({ ingenieros_snapshot: null }), []);
  assert.deepEqual(participantesVisibles({ ingenieros_snapshot: '[]', jdts_snapshot: '[]', jefes_snapshot: '[]' }), []);
  assert.deepEqual(participantesVisibles(), []);
});

test('JSON inválido en cualquier snapshot degrada a [] sin lanzar', () => {
  assert.deepEqual(participantesVisibles({ ingenieros_snapshot: '{corrupto' }), []);
  // Exclusiones corruptas no borran a los ingenieros válidos.
  const r = participantesVisibles({
    ingenieros_snapshot: JSON.stringify([u(1, 'Operador')]),
    jdts_snapshot: '{corrupto',
    jefes_snapshot: 'no-json',
  });
  assert.deepEqual(r, [u(1, 'Operador')]);
});

test('acepta snapshots ya parseados (arrays) además de strings JSON', () => {
  const r = participantesVisibles({
    ingenieros_snapshot: [u(1, 'A'), u(2, 'B')],
    jdts_snapshot: [u(2, 'B')],
    jefes_snapshot: [],
  });
  assert.deepEqual(r, [u(1, 'A')]);
});

test('entradas sin usuario_id se descartan; no muta los inputs', () => {
  const ingenieros = [u(1, 'A'), { nombre_completo: 'Sin Id' }, null];
  const jdts = [u(9, 'JdT')];
  const r = participantesVisibles({ ingenieros_snapshot: ingenieros, jdts_snapshot: jdts, jefes_snapshot: null });
  assert.deepEqual(r, [u(1, 'A')]);
  assert.equal(ingenieros.length, 3);
  assert.deepEqual(jdts, [u(9, 'JdT')]);
});

test('ids de tipo mixto (string vs número) se excluyen igual — blindaje snapshots prod viejos', () => {
  const r = participantesVisibles({
    ingenieros_snapshot: JSON.stringify([{ usuario_id: '2', nombre_completo: 'JdT String' }, u(3, 'Operador')]),
    jdts_snapshot: JSON.stringify([u(2, 'JdT String')]),      // número 2 vs string "2"
    jefes_snapshot: JSON.stringify([{ usuario_id: '3', nombre_completo: 'Operador' }]), // string "3" vs número 3
  });
  assert.deepEqual(r, [], 'la exclusión no depende del tipo del usuario_id');
});

// D-051 blindaje: rango del selector de años clamped a [DISP_ANIO_MIN, anioActual] — una fila
// corrupta (año typo 0026) no puede inflar el payload del dashboard.
test('construirRangoAnios: casos típicos y degradación con datos corruptos', () => {
  assert.deepEqual(construirRangoAnios(2024, 2026), [2026, 2025, 2024], 'rango contiguo desc');
  assert.deepEqual(construirRangoAnios(null, 2026), [2026], 'sin registros → solo año actual');
  assert.deepEqual(construirRangoAnios(undefined, 2026), [2026]);
  assert.deepEqual(construirRangoAnios(2026, 2026), [2026]);
  // Typo bajo (año 26 tecleado en datetime-local) → clamp al piso de dominio, no ~2000 entradas.
  const clampeado = construirRangoAnios(26, 2026);
  assert.equal(clampeado[0], 2026);
  assert.equal(clampeado[clampeado.length - 1], DISP_ANIO_MIN);
  assert.equal(clampeado.length, 2026 - DISP_ANIO_MIN + 1);
  // MIN futuro (fila corrupta post-fechada) → nunca un rango vacío ni invertido.
  assert.deepEqual(construirRangoAnios(2030, 2026), [2026]);
});

test('escapeLike escapa %, _, [ y \\ — el texto matchea literal', () => {
  assert.equal(escapeLike('100%'), '100\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('x[1]'), 'x\\[1]');
  assert.equal(escapeLike('c\\d'), 'c\\\\d');
  assert.equal(escapeLike('Juan Pérez'), 'Juan Pérez');
});
