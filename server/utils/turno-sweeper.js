import sql from 'mssql';
import { ventanaTurno, fechaBogotaStr } from './turno.js';
import { registrarEventoCierre } from './ciet.js';
import { buildConformacionSnapshot, persistConformacionSnapshot } from './conformacion-snapshot.js';

const INTERVAL_MS = 60_000;

let timer = null;

// F4: finaliza automáticamente las sesion_bitacora cuya ventana de turno ya terminó.
// Login Entra (cambio de conducta vs. F2): además EXPULSA la sesión de app (sesion_activa.activa=0)
// a fin de turno. La cookie de login Entra NO se toca — el usuario sigue autenticado; al volver en
// el turno siguiente, abrir la página reactiva sesion_activa vía select-context. Son dos sesiones
// separadas (cookie Entra = identidad; sesion_activa = participación en el turno). Ver ADR e
// invariante en CLAUDE.md (la convención "TTL ninguno / activa=1 hasta logout" quedó superada).
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
      // AUD-41 (BIT-AUDSEG-2026-001): lista parametrizada (@id0,@id1,...) en vez de CSV concatenado.
      // `ids` siempre trae >=1 (se pobló al agrupar por sesión), pero guardamos el caso vacío igual.
      const reqUpd = new sql.Request(transaction);
      const placeholdersUpd = ids.map((id, i) => {
        reqUpd.input('id' + i, sql.Int, id);
        return '@id' + i;
      }).join(',');
      if (placeholdersUpd.length === 0) { await transaction.commit(); continue; }
      const upd = await reqUpd.query(`
        UPDATE bitacora.sesion_bitacora
        SET finalizada_en = SYSUTCDATETIME()
        WHERE sesion_bitacora_id IN (${placeholdersUpd}) AND finalizada_en IS NULL
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

  // Q3=d conformacion-turno-2026-05: tras finalizar las sesion_bitacora del turno vencido,
  // recopilar (planta, turno, fecha_operativa) únicos y disparar el snapshot de conformación.
  // Cada conformación en su propio error boundary — fallo en una no rompe las demás ni
  // afecta el cierre de sesion_bitacora ya commiteado arriba. PK natural en conformacion_turno
  // garantiza idempotencia frente a ticks repetidos del sweeper.
  const conformacionesAEjecutar = new Map();
  for (const { row } of porSesion.values()) {
    const { inicio } = ventanaTurno(row.turno, row.abierta_en);
    const fechaOperativa = fechaBogotaStr(inicio);
    const key = `${row.planta_id}|${row.turno}|${fechaOperativa}`;
    if (!conformacionesAEjecutar.has(key)) {
      conformacionesAEjecutar.set(key, {
        planta_id: row.planta_id,
        turno: row.turno,
        fecha_operativa: fechaOperativa,
      });
    }
  }

  for (const args of conformacionesAEjecutar.values()) {
    try {
      const filas = await buildConformacionSnapshot(pool, args);
      const { insertadas, skipped } = await persistConformacionSnapshot(pool, filas);
      if (insertadas > 0 || skipped > 0) {
        console.log(`[turno-sweeper] conformacion ${args.planta_id} T${args.turno} ${args.fecha_operativa}: insertadas=${insertadas}, skipped=${skipped}`);
      }
    } catch (err) {
      console.error(`[turno-sweeper] error conformacion ${args.planta_id} T${args.turno} ${args.fecha_operativa}:`, err.message);
    }
  }

  // Expulsión de sesión de app a fin de turno (login Entra). Se hace DESPUÉS de la conformación
  // (que filtra por la ventana de inicio_sesion y usa cerrada_en, no por activa). Recorre TODAS
  // las sesiones activas — no solo las que tenían sesion_bitacora abierta — y cierra aquellas
  // cuya ventana de turno (según su inicio_sesion) ya terminó. Las reactivadas en el turno
  // vigente tienen inicio_sesion fresco → su ventana no venció → no se expulsan.
  try {
    const activas = await pool.request().query(
      `SELECT sesion_id, turno, inicio_sesion FROM bitacora.sesion_activa WHERE activa = 1`
    );
    const expirados = [];
    for (const s of activas.recordset) {
      const { fin } = ventanaTurno(s.turno, s.inicio_sesion);
      if (ahora >= fin) expirados.push(s.sesion_id);
    }
    if (expirados.length > 0) {
      // AUD-41: lista parametrizada (@id0,@id1,...) en vez de CSV concatenado.
      const reqExp = pool.request();
      const placeholdersExp = expirados.map((id, i) => {
        reqExp.input('id' + i, sql.Int, id);
        return '@id' + i;
      }).join(',');
      await reqExp.query(`
        UPDATE bitacora.sesion_activa
           SET activa = 0, cerrada_en = SYSUTCDATETIME()
         WHERE activa = 1 AND sesion_id IN (${placeholdersExp})
      `);
      console.log(`[turno-sweeper] ${expirados.length} sesion_activa expulsadas a fin de turno`);
    }
  } catch (err) {
    console.error('[turno-sweeper] error expulsando sesiones a fin de turno:', err.message);
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
