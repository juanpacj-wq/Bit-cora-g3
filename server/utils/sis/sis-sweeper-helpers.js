// Helpers PUROS del sweeper del SIS (D-060). Sin BD, sin red, sin timers — para poder fijarlos
// con tests unitarios (sis_sweeper.test.js) sin arrastrar el pool de db.js. Los consumen
// sis-sweeper.js (tick horario) y scripts/backfill-carbon-gec32.js (reparación por CLI).

export const MINUTO_MARCA = 2;        // el tick corre a HH:02 Bogotá (=HH:02 UTC, sin DST).
export const MIN_DELAY_MS = 60_000;   // nunca reprogramar a menos de 1 min.
const HORA_MS = 3_600_000;

// ¿Hay que repescar el día cuyo resumen es `row`? Un día está cerrado SOLO si el log dice
// completo=1 con ultimo_periodo=24. Sin fila, con completo=0 o con cualquier otro ultimo_periodo
// (p.ej. el 23 que dejaba el horizonte de "hoy") → sí. `completo` llega como boolean (mssql BIT)
// o como 0/1 según el camino; se aceptan ambos.
export function necesitaCatchup(row) {
  if (!row) return true;
  const completo = row.completo === true || Number(row.completo) === 1;
  return !completo || Number(row.ultimo_periodo) !== 24;
}

// Primer periodo a pedir para completar un día dado su log: ultimo_periodo+1 si lo previo es
// contiguo y sin errores; si no, 1 (día completo). scrapeDia re-verifica la contigüidad.
export function periodoDesdeDe(row) {
  if (!row) return 1;
  if (Number(row.periodos_error) !== 0) return 1;
  const u = Number(row.ultimo_periodo);
  if (!Number.isInteger(u) || u < 1 || u >= 24) return 1;
  return u + 1;
}

// Milisegundos hasta la próxima marca HH:<minuto>:00 a partir de `now`. Alinear el tick a la
// hora de pared (en vez de setTimeout(1h) tras cada corrida) evita la deriva acumulada que hacía
// caer el último tick del día después de medianoche y perder P23 además de P24 (caso 2026-08-10).
// Colombia no tiene DST, así que el minuto dentro de la hora coincide en UTC y en Bogotá.
export function msHastaProximaMarca(now = new Date(), minuto = MINUTO_MARCA) {
  const msEnHora = now.getTime() % HORA_MS;
  let delta = minuto * 60_000 - msEnHora;
  if (delta <= 0) delta += HORA_MS;
  return Math.max(delta, MIN_DELAY_MS);
}
