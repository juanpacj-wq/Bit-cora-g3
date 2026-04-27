import sql from 'mssql';
import { ventanaTurno } from './turno.js';
import { registrarEventoCierre } from './ciet.js';

const INTERVAL_MS = 60_000;

let timer = null;

// F4: finaliza automáticamente las sesion_bitacora cuya ventana de turno ya terminó.
// NO modifica sesion_activa.activa — el usuario sigue logueado y puede reabrir bitácoras
// del turno nuevo sin re-login (preguntas3.md punto H: el sweeper finaliza turnos pero
// el cierre del JdT/IngOp queda pendiente para que el JdT lo haga).
// Hace la finalización y la emisión de CIET en una transacción por sesion_bitacora — si
// algo falla en una, las demás siguen procesándose en su propia transacción.
export async function sweepTurnosVencidos(pool) {
  const ahora = new Date();
  // Listamos candidatos primero (sin lock) — la transacción individual hace su propia
  // verificación y aplica el UPDATE solo si sigue NULL. Idempotente.
  const r = await pool.request().query(`
    SELECT sb.sesion_bitacora_id, sb.sesion_id, sb.bitacora_id, sb.abierta_en,
           sa.usuario_id, sa.planta_id, sa.turno, c.nombre AS cargo_nombre,
           u.nombre_completo
    FROM bitacora.sesion_bitacora sb
    INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
    INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
    INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
    WHERE sa.activa = 1 AND sb.finalizada_en IS NULL
  `);

  let finalizadas = 0;
  // Agrupamos por (sesion_id) para emitir UN solo CIET por sesión-usuario aunque tenga
  // varias bitácoras abiertas. campos_extra.bitacora_origen queda null en ese caso (es una
  // finalización global por agotamiento de turno).
  const porSesion = new Map();
  for (const row of r.recordset) {
    const { inicio, fin } = ventanaTurno(row.turno, row.abierta_en);
    if (ahora < fin) continue; // ventana aún no termina
    if (!porSesion.has(row.sesion_id)) porSesion.set(row.sesion_id, { row, ids: [] });
    porSesion.get(row.sesion_id).ids.push(row.sesion_bitacora_id);
  }

  for (const { row, ids } of porSesion.values()) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // UPDATE solo las que siguen NULL (idempotente entre runs concurrentes).
      const idsCsv = ids.join(',');
      const upd = await new sql.Request(transaction).query(`
        UPDATE bitacora.sesion_bitacora
        SET finalizada_en = GETDATE()
        WHERE sesion_bitacora_id IN (${idsCsv}) AND finalizada_en IS NULL
      `);
      const n = upd.rowsAffected[0] || 0;
      if (n > 0) {
        await registrarEventoCierre(transaction, {
          tipo: 'finalizacion',
          sesion: {
            usuario_id: row.usuario_id,
            planta_id: row.planta_id,
            turno: row.turno,
            cargo_nombre: row.cargo_nombre,
          },
          forzado: true,
          motivo: 'sweeper',
        });
        finalizadas += n;
      }
      await transaction.commit();
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      console.error(`[turno-sweeper] error finalizando sesion ${row.sesion_id}:`, err.message);
    }
  }

  return finalizadas;
}

export function startTurnoSweeper(pool) {
  if (timer) return;
  const tick = async () => {
    try {
      const n = await sweepTurnosVencidos(pool);
      if (n > 0) console.log(`[turno-sweeper] ${n} sesion_bitacora finalizadas por agotamiento de turno`);
    } catch (err) {
      console.error('[turno-sweeper]', err);
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, INTERVAL_MS);
}

export function stopTurnoSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
