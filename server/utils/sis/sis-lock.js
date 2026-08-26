// Mutex de proceso para el SIS (D-061 / C2). Existe porque DOS caminos del MISMO proceso pueden
// pedirle el mismo día al SIS a la vez: el tick horario del sweeper (sis-sweeper.js, HH:02 Bogotá)
// y el scrape manual disparado desde la UI (sis-job.js, L04). Sin él se solapan sobre las mismas
// celdas de bitacora.consumo_combustible y sobre la misma fila de sis_scrape_log, con dos
// transacciones escribiendo resúmenes que se pisan.
//
// Es un mutex SIN COLA a propósito: el que llega con el lock tomado NO espera — falla al instante
// con `codigo='sis_ocupado'`. El sweeper usa ese error para omitir su tick (vuelve en una hora) y
// el endpoint manual para responder 409. Encolar sería peor: el SIS tarda ~13 s por periodo, así
// que una cola convierte un 409 honesto en un request colgado varios minutos.
//
// Qué NO cubre: es de PROCESO, no de base de datos. El CLI de backfill
// (server/scripts/backfill-carbon-gec32.js) corre en otro proceso y este lock no lo ve; su
// exclusión frente al sweeper es de diseño y por rango de fechas (`--to ≤ hoy-2`, D-060).
// Tampoco sobrevive a un restart: al arrancar, el lock está libre.

// Estado del módulo. `desde` es ISO UTC (TZ canónica: se guarda UTC, se presenta en Bogotá).
let estado = { ocupado: false, motivo: null, desde: null };

// Foto del lock. Copia defensiva: quien la lea no puede mutar el estado interno.
export function estadoSisLock() {
  return { ocupado: estado.ocupado, motivo: estado.motivo, desde: estado.desde };
}

// Toma el lock, ejecuta `fn` y lo libera SIEMPRE (aunque `fn` lance). Si ya estaba tomado lanza
// de inmediato un Error con `.codigo='sis_ocupado'` y `.motivo` = el motivo del dueño actual.
export async function withSisLock(motivo, fn) {
  if (estado.ocupado) {
    const err = new Error(`sis_ocupado: hay un scrape en curso (${estado.motivo})`);
    err.codigo = 'sis_ocupado';
    err.motivo = estado.motivo;
    err.desde = estado.desde;
    throw err;
  }
  estado = { ocupado: true, motivo: String(motivo ?? ''), desde: new Date().toISOString() };
  try {
    return await fn();
  } finally {
    estado = { ocupado: false, motivo: null, desde: null };
  }
}

// Solo para tests: devuelve el módulo a "libre" sin ejecutar nada. Producción nunca lo llama.
export function _resetSisLockParaTests() {
  estado = { ocupado: false, motivo: null, desde: null };
}
