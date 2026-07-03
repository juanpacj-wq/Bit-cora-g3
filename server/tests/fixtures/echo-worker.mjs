// Fixture de test (AUD-08): worker que devuelve metadatos del buffer recibido, para verificar el
// plumbing de parseXlsIsolated (transferencia del buffer + resolve) sin depender de un .xls real.
import { parentPort, workerData } from 'node:worker_threads';
const buf = Buffer.from(workerData);
parentPort.postMessage({ ok: true, result: { bytes: buf.length, first: buf.length ? buf[0] : null } });
