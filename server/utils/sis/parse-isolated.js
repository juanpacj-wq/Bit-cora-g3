// AUD-08 — Ejecuta parseXls en un worker_thread con timeout + tope de memoria.
//
// Defensa en profundidad sobre el endurecimiento del parser: aunque un .xls hostil pasara los
// chequeos estructurales, NO puede colgar el event loop (corre en otro hilo) ni reventar la memoria
// del proceso (heap acotado por resourceLimits), y si tarda de más se TERMINA (timeout). El parseo
// del SIS no es ruta caliente (lo dispara el sweeper periódico), así que el costo de arrancar un
// worker por archivo es irrelevante.
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./xls-parser-worker.js', import.meta.url);
const DEFAULT_TIMEOUT_MS = Number(process.env.SIS_PARSE_TIMEOUT_MS || 10_000);
const DEFAULT_MAX_HEAP_MB = Number(process.env.SIS_PARSE_MAX_HEAP_MB || 256);

/**
 * Parsea un .xls en un worker aislado. Resuelve con el resultado de parseXls, o rechaza con:
 *   - el Error acotado que lanzó el parser (input inválido),
 *   - Error('sis_parse_timeout') si excede timeoutMs (se termina el worker),
 *   - Error('sis_parse_worker_exit_<code>') si el worker muere (p.ej. OOM por el tope de heap).
 * @param {Buffer} buf
 * @param {{ timeoutMs?: number, maxHeapMb?: number, workerUrl?: URL|string }} [opts]
 */
export function parseXlsIsolated(buf, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxHeapMb = DEFAULT_MAX_HEAP_MB, workerUrl = WORKER_URL } = opts;
  return new Promise((resolve, reject) => {
    // Copia los bytes a un ArrayBuffer PROPIO y transferible (no compartir el del pool de Buffers).
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    let worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: ab,
        transferList: [ab],
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
      });
    } catch (e) {
      return reject(e);
    }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('sis_parse_timeout')), timeoutMs);
    worker.on('message', (m) => {
      if (m && m.ok) finish(resolve, m.result);
      else finish(reject, new Error((m && m.error) || 'sis_parse_error'));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => { if (code !== 0) finish(reject, new Error('sis_parse_worker_exit_' + code)); });
  });
}
