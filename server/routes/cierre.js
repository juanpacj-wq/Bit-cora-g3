// Router de cierre de turno (E6, AUD-34/35). Preview + cierre MASIVO por turno — único cierre
// que existe (D-042: el cierre individual por bitácora fue eliminado). Montado bajo /api/cierre
// tras requireEntra. Todas las rutas exigen sesión de app (loadAppSession) y cargos con
// puede_cerrar_turno para las de mutación. El body JSON lo parsea express.json global.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { mensajeUsuario } from '../utils/errores.js';
import { plantaMatch, puedeCerrarTurno } from '../middleware/permissions.js';
import { ventanaTurno, periodoFromFechaBogota, turnoFromPeriodo } from '../utils/turno.js';

// Robustez del cierre cronológico: el turno de la ventana se DERIVA de la hora Bogotá del registro
// más antiguo, NO de la columna `turno` guardada. Un registro con `turno` corrupto (p.ej. turno=2 a
// las 09:37) hacía que ventanaTurno calculara una franja [18:00–06:00] que no contenía a NINGÚN
// borrador → el cierre cerraba 0 registros en silencio ("no pasa nada" al cerrar turno). El cierre
// solo opera sobre bitácoras genéricas, donde el turno SIEMPRE debe coincidir con la hora (lo valida
// el POST de registros), así que derivarlo es idéntico para datos válidos y robusto ante corruptos.
function turnoDeFecha(fecha_evento) {
  return turnoFromPeriodo(periodoFromFechaBogota(fecha_evento));
}
import { registrarEventoCierre } from '../utils/ciet.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);  // req.sesion garantizado en todos los handlers

// F4: GET /api/cierre/preview-masivo?planta_id=
// Devuelve lo que el JdT/IngOp necesita para mostrar el modal antes de cerrar el turno:
//   - bitácoras con borradores (excluye bitácoras ocultas — CIET — desde F10; y DISP/MAND,
//     que tienen su propio ciclo de vida y no se cierran por turno).
//   - ingenieros con sesion_bitacora abierta (finalizada_en IS NULL) y la lista de
//     bitácoras donde están participando.
router.get('/preview-masivo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar el turno' });
  }
  const planta_id = req.query.planta_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
  }
  const db = await getDB();

  const bitsRes = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT r.bitacora_id, b.nombre, COUNT(*) AS registros_borrador
      FROM bitacora.registro_activo r
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
      WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
        AND b.oculta = 0
        AND b.codigo NOT IN ('DISP','MAND')
      GROUP BY r.bitacora_id, b.nombre
      ORDER BY b.nombre
    `);

  // D-040: FIX DEL BUG. El criterio de "no finalizado" pasa a ser sesion_activa.turno_finalizado_en
  // (fuente única), NO sesion_bitacora.finalizada_en — que /abrir reseteaba en cada apertura, haciendo
  // reaparecer al ingeniero como pendiente con solo VER una bitácora. bitacoras_abiertas sigue siendo
  // informativo (lo pinta el modal) vía OUTER APPLY a la presencia por-bitácora.
  const usersRes = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT sa.usuario_id, u.nombre_completo,
             COALESCE(pres.bitacoras, '') AS bitacoras_csv
      FROM bitacora.sesion_activa sa
      INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      OUTER APPLY (
        SELECT STRING_AGG(CONVERT(VARCHAR(10), sb.bitacora_id), ',') AS bitacoras
        FROM bitacora.sesion_bitacora sb
        WHERE sb.sesion_id = sa.sesion_id AND sb.finalizada_en IS NULL
      ) pres
      WHERE sa.planta_id = @planta_id
        AND sa.activa = 1
        AND sa.turno_finalizado_en IS NULL
      ORDER BY u.nombre_completo
    `);

  const ingenieros_no_finalizados = usersRes.recordset.map((row) => ({
    usuario_id: row.usuario_id,
    nombre_completo: row.nombre_completo,
    bitacoras_abiertas: row.bitacoras_csv
      ? row.bitacoras_csv.split(',').map((s) => parseInt(s, 10))
      : [],
  }));

  return sendJSON(res, 200, {
    bitacoras_pendientes: bitsRes.recordset,
    ingenieros_no_finalizados,
  });
}));

// POST /api/cierre/masivo — cierra el turno: archiva al histórico los borradores de TODAS las
// bitácoras genéricas de la planta en una sola acción. Es el ÚNICO cierre del sistema.
router.post('/masivo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar el turno' });
  const { planta_id } = req.body || {};
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede cerrar el turno de otra planta' });
  }
  const cerrado_por = sesion.usuario_id;
  const pool = await getDB();
  // F4/F10: excluimos bitácoras ocultas (CIET) del listado para evitar recursión (cada cierre
  // genera un CIET nuevo; absorberlo en el cierre siguiente emite otro CIET). DISP/MAND quedan
  // fuera: tienen su propio ciclo de vida (DISP archiva al llegar un nuevo estado; MAND se cierra
  // solo vía sweeper diario), así que nunca se tocan por el cierre de turno.
  const listRes = await pool.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT DISTINCT r.bitacora_id, b.nombre
      FROM bitacora.registro_activo r
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
      WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
        AND b.oculta = 0
        AND b.codigo NOT IN ('DISP','MAND')
    `);

  const resumen = [];
  for (const row of listRes.recordset) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // F4: cierre cronológico por bitácora. Identificamos el turno del registro más antiguo y
      // solo movemos los registros que caen en su ventana. Los registros del turno siguiente
      // permanecen como borrador hasta el próximo cierre. UPDLOCK + HOLDLOCK previene que dos
      // JdTs cierren el mismo turno simultáneamente.
      const oldest = await new sql.Request(transaction)
        .input('bitacora_id', sql.Int, row.bitacora_id)
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT TOP 1 fecha_evento, turno
          FROM bitacora.registro_activo WITH (UPDLOCK, HOLDLOCK)
          WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
          ORDER BY fecha_evento ASC, registro_id ASC
        `);

      let registros_cerrados = 0;
      if (oldest.recordset.length > 0) {
        const { fecha_evento } = oldest.recordset[0];
        const { inicio, fin } = ventanaTurno(turnoDeFecha(fecha_evento), fecha_evento);

        const insResult = await new sql.Request(transaction)
          .input('bitacora_id', sql.Int, row.bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .input('cerrado_por', sql.Int, cerrado_por)
          .input('inicio', sql.DateTime2, inicio)
          .input('fin', sql.DateTime2, fin)
          .query(`
            INSERT INTO bitacora.registro_historico
              (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
               modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
            SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                   'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
                   modificado_por, modificado_en, @cerrado_por, SYSUTCDATETIME(), CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)
            FROM bitacora.registro_activo
            WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
              AND fecha_evento >= @inicio AND fecha_evento < @fin;
          `);
        registros_cerrados = insResult.rowsAffected[0] || 0;

        await new sql.Request(transaction)
          .input('bitacora_id', sql.Int, row.bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .input('inicio', sql.DateTime2, inicio)
          .input('fin', sql.DateTime2, fin)
          .query(`
            DELETE FROM bitacora.registro_activo
            WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
              AND fecha_evento >= @inicio AND fecha_evento < @fin;
          `);
      }

      await registrarEventoCierre(transaction, {
        tipo: 'cierre',
        sesion,
        bitacora_origen_id: row.bitacora_id,
        forzado: false,
      });
      await transaction.commit();
      resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, registros_cerrados });
    } catch (err) {
      await transaction.rollback();
      // Va dentro de un 200 (resultado por bitácora); saneamos igual para no filtrar internals.
      console.error(`[ERROR] cierre masivo bitacora=${row.bitacora_id} →`, err);
      resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, error: mensajeUsuario(err) });
    }
  }
  broadcastConteoBitacoras(planta_id).catch(() => {});
  return sendJSON(res, 200, { resumen });
}));

export default router;
