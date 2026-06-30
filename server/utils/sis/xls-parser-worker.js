// AUD-08 — Worker thread que ejecuta el parser .xls AISLADO del hilo principal.
//
// El parser (xls-parser.js) procesa bytes de un SIS HTTP plano NO autenticado (vía MITM podría
// llegar un .xls hostil). Ya está endurecido contra cuelgues/OOM, pero corría EN el event loop:
// un caso patológico igual robaba CPU/memoria al proceso. Acá corre en un Worker con tope de heap
// (resourceLimits, desde parse-isolated.js) y con un timeout que lo TERMINA si se pasa — así un
// archivo malicioso no puede degradar el backend; en el peor caso muere este worker.
import { parentPort, workerData } from 'node:worker_threads';
import { parseXls } from './xls-parser.js';

try {
  // workerData es el ArrayBuffer transferido; lo envolvemos en Buffer sin copiar.
  const result = parseXls(Buffer.from(workerData));
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
