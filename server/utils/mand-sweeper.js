import sql from 'mssql';
import { USUARIO_SISTEMA_ID } from '../db.js';
import { registrarCierreMand } from './ciet.js';
import { snapshotJDTsDelDia, snapshotJefesDelDia, snapshotIngenierosDelDia } from './snapshots.js';

const INTERVAL_MS = 60_000;
const PLANTAS = ['GEC3', 'GEC32'];

let timer = null;
let lastFechaCheck = null;

function todayBogota() {
  const d = new Date();
  const shifted = new Date(d.getTime() - 5 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

// F16.C: cierra el día N para una planta. Mueve los registros MAND borrador del día @fecha
// (en zona Bogotá) a registro_historico, soft-deletea sus filas en evento_dashboard, emite
// el CIET 'Cierre de turno' con autor SISTEMA + snapshots agregados del día, y registra el
// cierre en mand_cierre_log para idempotencia. Si la fila ya existe en el log, retorna
// { skipped: true } sin tocar nada.
//
// Diseño:
//   - Idempotencia primaria: bitacora.mand_cierre_log (PK fecha+planta).
//   - Idempotencia defensiva: si no hay registros_activos para (fecha, planta), early return
//     SIN emitir CIET (preguntas: el CIET solo se emite cuando hay al menos 1 registro a
//     cerrar — un día sin uso no produce auditoría).
//   - Atomicidad: histórico INSERT, activo DELETE, evento_dashboard soft-delete, CIET, log
//     dentro de la misma transacción.
export async function cerrarDiaMand(pool, { fecha, planta_id, usuarioCierre = USUARIO_SISTEMA_ID }) {
  if (!usuarioCierre) {
    throw new Error('cerrarDiaMand: usuarioCierre es requerido (USUARIO_SISTEMA_ID no inicializado)');
  }

  // Pre-check del log fuera de transacción para evitar abrir transacción innecesaria.
  const existing = await pool.request()
    .input('f', sql.Date, fecha)
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT 1 AS x FROM bitacora.mand_cierre_log WHERE fecha_cerrada=@f AND planta_id=@p`);
  if (existing.recordset.length > 0) {
    return { skipped: true, reason: 'already_closed', fecha, planta_id };
  }

  // Pre-check de existencia de registros para early return sin CIET (preguntas mand).
  const countRes = await pool.request()
    .input('f', sql.Date, fecha)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT COUNT(*) AS n
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE b.codigo = 'MAND'
        AND ra.planta_id = @p
        AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @f
        AND ra.estado = 'borrador'
    `);
  const total = countRes.recordset[0]?.n || 0;
  if (total === 0) {
    return { skipped: true, reason: 'no_records', fecha, planta_id };
  }

  const bitRes = await pool.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='MAND'`);
  const MAND_BITACORA_ID = bitRes.recordset[0]?.bitacora_id;
  if (!MAND_BITACORA_ID) {
    throw new Error('cerrarDiaMand: bitácora MAND no encontrada');
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const reqFactory = () => new sql.Request(transaction);

    // Snapshots agregados del día completo — capturan toda la guardia que rotó por la grilla.
    const jdts_snapshot = await snapshotJDTsDelDia(reqFactory, { planta_id, fecha });
    const jefes_snapshot = await snapshotJefesDelDia(reqFactory);
    const ingenieros_snapshot = await snapshotIngenierosDelDia(reqFactory, { planta_id, fecha });

    // INSERT histórico (mismo patrón que F4 cierre cronológico — preserva registro_id).
    // fecha_cierre_operativo guarda el día Bogotá del cierre (no del registro).
    const insRes = await new sql.Request(transaction)
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('fecha', sql.Date, fecha)
      .input('cerrado_por', sql.Int, usuarioCierre)
      .query(`
        INSERT INTO bitacora.registro_historico
          (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
           modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
        SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
               modificado_por, modificado_en, @cerrado_por, SYSUTCDATETIME(), @fecha
        FROM bitacora.registro_activo
        WHERE bitacora_id = @mand AND planta_id = @planta_id
          AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = @fecha
          AND estado = 'borrador'
      `);
    const cerrados = insRes.rowsAffected[0] || 0;

    // Soft-delete de las filas evento_dashboard que apuntaban a estos registros.
    await new sql.Request(transaction)
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('fecha', sql.Date, fecha)
      .query(`
        UPDATE ed SET activa = 0
        FROM bitacora.evento_dashboard ed
        INNER JOIN bitacora.registro_historico rh ON rh.registro_id = ed.registro_origen_id
        WHERE rh.bitacora_id = @mand
          AND rh.planta_id = @planta_id
          AND rh.fecha_cierre_operativo = @fecha
          AND ed.activa = 1
      `);

    // DELETE del activo (los IDs ya viven en histórico).
    await new sql.Request(transaction)
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('fecha', sql.Date, fecha)
      .query(`
        DELETE FROM bitacora.registro_activo
        WHERE bitacora_id = @mand AND planta_id = @planta_id
          AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = @fecha
          AND estado = 'borrador'
      `);

    // CIET con autor SISTEMA y snapshots agregados del día.
    await registrarCierreMand(transaction, {
      planta_id,
      fecha,
      turno: null,
      usuarioCierre,
      bitacora_origen_id: MAND_BITACORA_ID,
      jdts_snapshot,
      jefes_snapshot,
      ingenieros_snapshot,
      registros_cerrados: cerrados,
    });

    // Log de idempotencia. Si dos calls concurrentes llegan acá, la PK colisiona y la
    // segunda hace rollback automático — comportamiento correcto.
    await new sql.Request(transaction)
      .input('f', sql.Date, fecha)
      .input('p', sql.VarChar(10), planta_id)
      .input('n', sql.Int, cerrados)
      .query(`
        INSERT INTO bitacora.mand_cierre_log (fecha_cerrada, planta_id, registros_cerrados)
        VALUES (@f, @p, @n)
      `);

    await transaction.commit();
    return { closed: true, registros: cerrados, fecha, planta_id };
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}

// F16.C: el sweeper detecta el cambio de día Bogotá y cierra el día anterior para todas las
// plantas. Resiliente a reinicios — si el server arrancó después de medianoche, el primer
// tick detecta que lastFechaCheck (null) → hoy (nuevo día) y cierra el día anterior.
// Idempotente vía mand_cierre_log: si ya cerró, retorna skipped sin re-trabajo.
export function startMandSweeper(pool) {
  if (timer) return;
  console.log('[mand-sweeper] iniciado');

  const tick = async () => {
    try {
      const hoy = todayBogota();
      if (lastFechaCheck === null) {
        // Primer tick post-reinicio: intentamos cerrar AYER por si quedó pendiente.
        // Bogotá yesterday = hoy - 1 día.
        const yesterday = ayerBogotaDe(hoy);
        for (const planta_id of PLANTAS) {
          try {
            const r = await cerrarDiaMand(pool, { fecha: yesterday, planta_id });
            if (r.closed) {
              console.log(`[mand-sweeper] cierre catch-up ${planta_id} ${yesterday}: ${r.registros} registros`);
            }
          } catch (err) {
            console.error(`[mand-sweeper] error cierre catch-up ${planta_id} ${yesterday}:`, err.message);
          }
        }
        lastFechaCheck = hoy;
      } else if (hoy !== lastFechaCheck) {
        // El día Bogotá cambió. Cerramos lastFechaCheck (el día que terminó) para ambas plantas.
        for (const planta_id of PLANTAS) {
          try {
            const r = await cerrarDiaMand(pool, { fecha: lastFechaCheck, planta_id });
            if (r.closed) {
              console.log(`[mand-sweeper] cierre ${planta_id} ${lastFechaCheck}: ${r.registros} registros`);
            }
          } catch (err) {
            console.error(`[mand-sweeper] error cierre ${planta_id} ${lastFechaCheck}:`, err.message);
          }
        }
        lastFechaCheck = hoy;
      }
    } catch (err) {
      console.error('[mand-sweeper]', err);
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, INTERVAL_MS);
}

export function stopMandSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  lastFechaCheck = null;
}

// Helper interno: 'YYYY-MM-DD' menos 1 día. UTC-safe (Date construye en local pero el
// roundtrip a ISO usa UTC; restamos en ms y reformamos).
function ayerBogotaDe(fechaStr) {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
