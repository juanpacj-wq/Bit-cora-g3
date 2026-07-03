import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildUrl, periodoBounds, extraerCarbonValidado, TAGS, SIS_SERVER,
} from '../utils/sis/sis-client.js';
import { parseXls } from '../utils/sis/xls-parser.js';

// D-029 (E2): cliente SIS + parser .xls. No toca BD ni red — todo es lógica pura, salvo el
// test del parser que depende de un fixture .xls real capturado del SIS (ver nota al final).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sis-period.xls');

test('buildUrl — incluye los 12 tags, el server NEWSYNCBASE y t1/t2 correctos', () => {
  const url = buildUrl('2026-06-03', '00', '2026-06-03', '01');
  const decoded = decodeURIComponent(url.split('params=')[1]);
  for (const t of TAGS) assert.ok(decoded.includes(`<tg n='${t}'/>`), `falta el tag ${t}`);
  assert.equal(TAGS.length, 12, 'deben ser 12 tags');
  assert.ok(decoded.includes(`<sis server='${SIS_SERVER}'>`), 'falta server NEWSYNCBASE');
  assert.ok(decoded.includes('<t1>2026-06-03 00:00:00</t1>'), 't1 incorrecto');
  assert.ok(decoded.includes('<t2>2026-06-03 01:00:00</t2>'), 't2 incorrecto');
});

test('periodoBounds — periodo 1 → 00:00..01:00 mismo día', () => {
  assert.deepEqual(periodoBounds('2026-06-03', 1),
    { f1: '2026-06-03', h1: '00', f2: '2026-06-03', h2: '01' });
});

test('periodoBounds — periodo 24 → 23:00..00:00 del día siguiente', () => {
  assert.deepEqual(periodoBounds('2026-06-03', 24),
    { f1: '2026-06-03', h1: '23', f2: '2026-06-04', h2: '00' });
});

test('periodoBounds — cruce de mes en periodo 24', () => {
  assert.deepEqual(periodoBounds('2026-06-30', 24),
    { f1: '2026-06-30', h1: '23', f2: '2026-07-01', h2: '00' });
});

test('periodoBounds — periodo fuera de rango lanza', () => {
  assert.throws(() => periodoBounds('2026-06-03', 0));
  assert.throws(() => periodoBounds('2026-06-03', 25));
});

test('extraerCarbonValidado — en servicio: tolvas>0.5 suman; <=0.5 quedan en 0', () => {
  // lastRow 1-indexado: [1..8] tolvas, [9] energía, [10] v659, [11] v651, [12] mpaflow.
  const lastRow = [null, 10, 0.3, 5, 0, 2.5, 8, 0.5, 12, 150, 500, 500, 145];
  const r = extraerCarbonValidado(lastRow);
  assert.equal(r.enServicio, true);
  // tolvas validadas: 10, 0(<=0.5), 5, 0, 2.5, 8, 0(=0.5 no supera), 12
  assert.deepEqual(r.tolvasVal, [10, 0, 5, 0, 2.5, 8, 0, 12]);
  assert.equal(r.totalCarbon, 37.5);
  assert.equal(r.energiaMw, 150);
  assert.ok(r.totalCarbon > 0);
});

test('extraerCarbonValidado — fuera de servicio: todas las tolvas en 0', () => {
  // sensores bajos → enServicio false aunque las tolvas traigan lectura.
  const lastRow = [null, 10, 8, 5, 7, 2.5, 8, 9, 12, 150, 100, 100, 50];
  const r = extraerCarbonValidado(lastRow);
  assert.equal(r.enServicio, false);
  assert.deepEqual(r.tolvasVal, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.totalCarbon, 0);
});

test('extraerCarbonValidado — valores no numéricos cuentan como 0', () => {
  const lastRow = [null, 'NaN', null, undefined, 7, 2.5, 8, 9, 12, 'x', 500, 500, 145];
  const r = extraerCarbonValidado(lastRow);
  assert.equal(r.enServicio, true);
  // [1]'NaN'→0, [2]null→0, [3]undefined→0, [4]7, [5]2.5, [6]8, [7]9, [8]12
  assert.deepEqual(r.tolvasVal, [0, 0, 0, 7, 2.5, 8, 9, 12]);
  assert.equal(r.energiaMw, 0); // lastRow[9]='x' → 0
});

// Parser .xls: requiere un fixture binario real del SIS (server/tests/fixtures/sis-period.xls).
// Sin acceso al SIS offline no se puede generar; el test se valida contra el SIS real en E3/E7.
test('parseXls — fixture real devuelve lastRow con 12 valores', { skip: !existsSync(FIXTURE) }, () => {
  const buf = readFileSync(FIXTURE);
  const parsed = parseXls(buf);
  assert.ok(parsed.lastRow, 'parseXls no devolvió lastRow');
  assert.ok(parsed.ncols >= 12, `se esperaban >=12 columnas, hay ${parsed.ncols}`);
  for (let c = 1; c <= 12; c++) {
    assert.equal(typeof parsed.lastRow[c], 'number', `lastRow[${c}] no es numérico`);
  }
});
