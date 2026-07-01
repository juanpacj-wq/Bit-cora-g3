// Router de cierre de bitácoras (E6, AUD-34/35). Preview + cierre individual/masivo por turno.
// Montado bajo /api/cierre tras requireEntra. Todas las rutas exigen sesión de app (loadAppSession)
// y cargos con puede_cerrar_turno para las de mutación. El body JSON lo parsea express.json global.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { mensajeUsuario } from '../utils/errores.js';
import { plantaMatch, puedeCerrarTurno } from '../middleware/permissions.js';
import { ventanaTurno } from '../utils/turno.js';
import { registrarEventoCierre } from '../utils/ciet.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);  // req.sesion garantizado en todos los handlers

// GET /api/cierre/preview?planta_id=&bitacora_id=
router.get('/preview', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  const bitacora_id = req.query.bitacora_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
  }
  const db = await getDB();
  const reqQ = db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('bitacora_id', sql.Int, bitacora_id ? parseInt(bitacora_id, 10) : null);
  const result = await reqQ.query(`
    SELECT r.bitacora_id, b.nombre AS bitacora_nombre,
           SUM(CASE WHEN LEN(LTRIM(RTRIM(ISNULL(r.detalle, '')))) = 0 THEN 1 ELSE 0 END) AS incompletos,
           COUNT(*) AS total
    FROM bitacora.registro_activo r
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
      AND b.oculta = 0
      AND b.codigo NOT IN ('DISP','MAND')
      AND (@bitacora_id IS NULL OR r.bitacora_id = @bitacora_id)
    GROUP BY r.bitacora_id, b.nombre
  `);
  return sendJSON(res, 200, { preview: result.recordset });
}));

// F4: GET /api/cierre/preview-masivo?planta_id=
// Devuelve lo que el JdT/IngOp necesita para mostrar el modal antes de cerrar masivo:
//   - bitácoras con borradores (excluye bitácoras ocultas — CIET — desde F10)
//   - ingenieros con sesion_bitacora abierta (finalizada_en IS NULL) y la lista de
//     bitácoras donde están participando.
router.get('/preview-masivo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
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

  const usersRes = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT sa.usuario_id, u.nombre_completo,
             STRING_AGG(CAST(sb.bitacora_id AS VARCHAR(20)), ',') AS bitacoras_csv
      FROM bitacora.sesion_bitacora sb
      INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
      INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      WHERE sa.planta_id = @planta_id
        AND sa.activa = 1
        AND sb.finalizada_en IS NULL
      GROUP BY sa.usuario_id, u.nombre_completo
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

// POST /api/cierre/bitacora
router.post('/bitacora', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
  const { bitacora_id, planta_id } = req.body || {};
  if (!bitacora_id || !planta_id) {
    return sendJSON(res, 400, { error: 'bitacora_id y planta_id son requeridos' });
  }
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede cerrar bitácoras de otra planta' });
  }
  const cerrado_por = sesion.usuario_id;
  const pool = await getDB();
  // F13.3: DISP no se cierra por turno (envía al histórico al llegar un nuevo registro).
  // F16: MAND tampoco — el cierre es automático vía sweeper diario. Devolvemos 400 con
  // mensaje específico para que el frontend pueda gatear el botón sin ambigüedad.
  const codigoRes = await pool.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`SELECT codigo FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id`);
  const codigo = codigoRes.recordset[0]?.codigo;
  if (codigo === 'MAND') {
    return sendJSON(res, 400, {
      error: 'mand_cierre_individual_no_permitido',
      mensaje: 'MAND no acepta cierre individual — el cierre es automático al finalizar el día.',
    });
  }
  if (codigo === 'DISP') {
    return sendJSON(res, 422, {
      error: 'bitacora_no_cerrable',
      mensaje: 'La bitácora DISP no se cierra por turno',
    });
  }
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // F4: cierre cronológico. Identificamos el turno del registro más antiguo y solo
    // movemos los registros que caen en su ventana. Los registros del turno siguiente
    // permanecen como borrador hasta que el JdT/IngOp los cierre con un nuevo click.
    // UPDLOCK + HOLDLOCK previene que dos JdTs cierren el mismo turno simultáneamente.
    const oldest = await new sql.Request(transaction)
      .input('bitacora_id', sql.Int, bitacora_id)
      .input('planta_id', sql.VarChar(10), planta_id)
      .query(`
        SELECT TOP 1 fecha_evento, turno
        FROM bitacora.registro_activo WITH (UPDLOCK, HOLDLOCK)
        WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
        ORDER BY fecha_evento ASC, registro_id ASC
      `);

    let registros_cerrados = 0;
    if (oldest.recordset.length > 0) {
      const { fecha_evento, turno } = oldest.recordset[0];
      const { inicio, fin } = ventanaTurno(turno, fecha_evento);

      const insResult = await new sql.Request(transaction)
        .input('bitacora_id', sql.Int, bitacora_id)
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
        .input('bitacora_id', sql.Int, bitacora_id)
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('inicio', sql.DateTime2, inicio)
        .input('fin', sql.DateTime2, fin)
        .query(`
          DELETE FROM bitacora.registro_activo
          WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
            AND fecha_evento >= @inicio AND fecha_evento < @fin;
        `);
    }

    // F3: registrar evento CIET 'cierre' (de F3) — auditoría de la operación incluso si
    // el cierre fue vacío (no había borradores). El JdT/IngOp ejecutó el cierre deliberadamente.
    await registrarEventoCierre(transaction, {
      tipo: 'cierre',
      sesion,
      bitacora_origen_id: bitacora_id,
      forzado: false,
    });

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    return sendJSON(res, 200, { registros_cerrados });
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}));

// POST /api/cierre/masivo
router.post('/masivo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
  const { planta_id } = req.body || {};
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede cerrar bitácoras de otra planta' });
  }
  const cerrado_por = sesion.usuario_id;
  const pool = await getDB();
  // F4/F10: excluimos bitácoras ocultas (CIET) del listado para evitar recursión (cada
  // cierre genera un CIET nuevo; absorberlo en el masivo siguiente emite otro CIET).
  // CIET se cierra explícitamente vía /api/cierre/bitacora si un DBA lo necesita.
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
      // F4: cierre cronológico por bitácora. Mismo patrón que /api/cierre/bitacora.
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
        const { fecha_evento, turno } = oldest.recordset[0];
        const { inicio, fin } = ventanaTurno(turno, fecha_evento);

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
