import { SESION_TTL_MIN } from './snapshots.js';

const INTERVAL_MS = 2 * 60_000;

let timer = null;

// Si se escala a múltiples instancias, mover a SQL Agent Job y deprecar este módulo.
export async function sweepSesionesInactivas(db) {
  const r = await db.request().query(`
    UPDATE bitacora.sesion_activa
    SET activa = 0
    WHERE activa = 1
      AND ultima_actividad < DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
  `);
  return r.rowsAffected?.[0] ?? 0;
}

export function startSweeper(db) {
  if (timer) return;
  const tick = async () => {
    try {
      const n = await sweepSesionesInactivas(db);
      if (n > 0) console.log(`[sesion-sweeper] ${n} sesiones expiradas marcadas activa=0`);
    } catch (err) {
      console.error('[sesion-sweeper]', err);
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, INTERVAL_MS);
}

export function stopSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
