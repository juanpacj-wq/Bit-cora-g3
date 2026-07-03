import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXlsIsolated } from '../utils/sis/parse-isolated.js';

// AUD-08 — parseo del .xls aislado en worker_thread. Verifica el wrapper (transferencia, resolve,
// propagación de error, timeout) sin depender de un .xls real.
const ECHO = new URL('./fixtures/echo-worker.mjs', import.meta.url);
const HANG = new URL('./fixtures/hang-worker.mjs', import.meta.url);

test('parseXlsIsolated: transfiere el buffer y resuelve con el resultado del worker', async () => {
  const r = await parseXlsIsolated(Buffer.from([7, 8, 9, 10]), { workerUrl: ECHO });
  assert.deepEqual(r, { bytes: 4, first: 7 });
});

test('parseXlsIsolated: error del parser (buffer inválido) → rechaza, NO crashea el proceso', async () => {
  // Buffer < 512 bytes → readCFBStream lanza un Error acotado dentro del worker real.
  await assert.rejects(() => parseXlsIsolated(Buffer.from('no soy un xls')), /header|inválido|CFB/i);
});

test('parseXlsIsolated: worker que no responde → timeout que lo termina', async () => {
  await assert.rejects(
    () => parseXlsIsolated(Buffer.from([1, 2, 3]), { workerUrl: HANG, timeoutMs: 250 }),
    /sis_parse_timeout/,
  );
});
