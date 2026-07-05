// Router de participación en bitácoras (E10, AUD-34/35). abrir / finalizar / finalizar-forzado /
// usuarios-en-bitacora / counts. Montado bajo /api/bitacora tras requireEntra; todas exigen sesión
// de app (loadAppSession).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora, puedeCerrarTurno, plantaMatch } from '../middleware/permissions.js';
import { registrarEventoCierre } from '../utils/ciet.js';
import { ventanaActual } from '../utils/turno.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// POST /api/bitacora/abrir { bitacora_id }  (F2, idempotente UPSERT en sesion_bitacora)
router.post('/abrir', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const { bitacora_id } = req.body || {};
  if (!bitacora_id) return sendJSON(res, 400, { error: 'bitacora_id es requerido' });
  const db = await getDB();
  // AUD-24: validar existencia + puede_ver antes de tocar sesion_bitacora.
  const existe = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`SELECT 1 AS ok FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id AND activa = 1`);
  if (!existe.recordset[0]) {
    return sendJSON(res, 404, { error: 'Bitácora no encontrada' });
  }
  if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para abrir esta bitácora' });
  }
  const result = await db.request()
    .input('sesion_id', sql.Int, sesion.sesion_id)
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`
      MERGE bitacora.sesion_bitacora AS t
      USING (VALUES (@sesion_id, @bitacora_id)) AS s(sesion_id, bitacora_id)
        ON t.sesion_id = s.sesion_id AND t.bitacora_id = s.bitacora_id
      WHEN MATCHED THEN UPDATE SET finalizada_en = NULL, abierta_en = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (sesion_id, bitacora_id) VALUES (s.sesion_id, s.bitacora_id);

      SELECT sesion_bitacora_id, sesion_id, bitacora_id, abierta_en, finalizada_en
      FROM bitacora.sesion_bitacora
      WHERE sesion_id = @sesion_id AND bitacora_id = @bitacora_id;
    `);
  return sendJSON(res, 200, { sesion_bitacora: result.recordset[0] });
}));

// POST /api/bitacora/finalizar (D-040) — marca la finalización del turno en la SESIÓN DE APP
// (sesion_activa.turno_finalizado_en), fuente única y revertible. Ya NO toca sesion_bitacora
// (esa columna quedó como SOLO presencia por-bitácora; la reseteaba /abrir → causa del bug de
// reaparición). CIET 'finalizacion' solo si hubo cambio (idempotente: doble finalizar no re-emite).
router.post('/finalizar', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const pool = await getDB();
  // D-040 (persistencia por ventana): la finalización se marca en fresco si NO hay una vigente en la
  // ventana del turno actual (NULL o de un turno pasado). Si ya hay una vigente → no-op idempotente.
  const { inicio: ventanaInicio, fin: ventanaFin } = ventanaActual();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await new sql.Request(transaction)
      .input('usuario_id', sql.Int, sesion.usuario_id)
      .input('ventana_inicio', sql.DateTime2, ventanaInicio)
      .input('ventana_fin', sql.DateTime2, ventanaFin)
      .query(`
        UPDATE bitacora.sesion_activa
          SET turno_finalizado_en = SYSUTCDATETIME()
          OUTPUT INSERTED.sesion_id, INSERTED.turno_finalizado_en
          WHERE usuario_id = @usuario_id AND activa = 1
            AND (turno_finalizado_en IS NULL
                 OR turno_finalizado_en < @ventana_inicio
                 OR turno_finalizado_en >= @ventana_fin);
      `);

    const cambio = result.recordset.length > 0;
    // Idempotencia: si ya estaba finalizado, devolvemos el valor vigente de la sesión sin re-emitir CIET.
    const turno_finalizado_en = cambio
      ? result.recordset[0].turno_finalizado_en
      : sesion.turno_finalizado_en;

    let evento_ciet = null;
    if (cambio) {
      // D-045 E4: reflejar la finalización individual en turno_participante del turno vigente (la fila
      // que se congela en la conformación en E6). turno_id se toma de la sesión activa del usuario.
      await new sql.Request(transaction)
        .input('usuario_id', sql.Int, sesion.usuario_id)
        .query(`
          UPDATE tp SET finalizado_individual_en = SYSUTCDATETIME()
          FROM bitacora.turno_participante tp
          INNER JOIN bitacora.sesion_activa sa ON sa.turno_id = tp.turno_id AND sa.usuario_id = tp.usuario_id
          WHERE sa.usuario_id = @usuario_id AND sa.activa = 1 AND sa.turno_id IS NOT NULL;
        `);
      evento_ciet = await registrarEventoCierre(transaction, {
        tipo: 'finalizacion',
        sesion,
        forzado: false,
      });
    }

    await transaction.commit();
    return sendJSON(res, 200, { turno_finalizado_en, evento_ciet });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// POST /api/bitacora/revertir-turno (D-040) — self-service: cualquier ingeniero limpia SU propia
// finalización (turno_finalizado_en → NULL) para volver a registrar. Sin permiso especial. CIET
// 'reapertura' solo si hubo cambio (idempotente: doble revertir no re-emite).
router.post('/revertir-turno', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const pool = await getDB();
  // D-040 (persistencia por ventana): solo se revierte una finalización VIGENTE (dentro de la ventana
  // del turno actual). Un valor de un turno pasado ya cuenta como "abierto" → no-op (no re-emite CIET).
  const { inicio: ventanaInicio, fin: ventanaFin } = ventanaActual();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await new sql.Request(transaction)
      .input('usuario_id', sql.Int, sesion.usuario_id)
      .input('ventana_inicio', sql.DateTime2, ventanaInicio)
      .input('ventana_fin', sql.DateTime2, ventanaFin)
      .query(`
        UPDATE bitacora.sesion_activa
          SET turno_finalizado_en = NULL
          OUTPUT DELETED.turno_finalizado_en AS antes
          WHERE usuario_id = @usuario_id AND activa = 1
            AND turno_finalizado_en >= @ventana_inicio
            AND turno_finalizado_en < @ventana_fin;
      `);

    let evento_ciet = null;
    if (result.recordset.length > 0) {
      // D-045 E4: al revertir la finalización, limpiar también finalizado_individual_en del participante.
      await new sql.Request(transaction)
        .input('usuario_id', sql.Int, sesion.usuario_id)
        .query(`
          UPDATE tp SET finalizado_individual_en = NULL
          FROM bitacora.turno_participante tp
          INNER JOIN bitacora.sesion_activa sa ON sa.turno_id = tp.turno_id AND sa.usuario_id = tp.usuario_id
          WHERE sa.usuario_id = @usuario_id AND sa.activa = 1 AND sa.turno_id IS NOT NULL;
        `);
      evento_ciet = await registrarEventoCierre(transaction, {
        tipo: 'reapertura',
        sesion,
        forzado: false,
      });
    }

    await transaction.commit();
    return sendJSON(res, 200, { turno_finalizado_en: null, evento_ciet });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// POST /api/bitacora/finalizar-forzado { usuarios: [usuario_id, ...] }  (F4, gated puede_cerrar_turno)
router.post('/finalizar-forzado', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden forzar finalización' });
  }
  const { usuarios } = req.body || {};
  if (!Array.isArray(usuarios) || usuarios.length === 0) {
    return sendJSON(res, 400, { error: 'usuarios debe ser un array no vacío de usuario_id' });
  }
  const ids = usuarios.map((u) => parseInt(u, 10)).filter((n) => Number.isInteger(n));
  if (ids.length === 0) return sendJSON(res, 400, { error: 'usuarios contiene IDs inválidos' });

  const pool = await getDB();
  // D-040 (persistencia por ventana): mismo criterio que /finalizar para cada objetivo.
  const { inicio: ventanaInicio, fin: ventanaFin } = ventanaActual();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const finalizados = [];
    for (const usuario_id of ids) {
      const userSesRes = await new sql.Request(transaction)
        .input('usuario_id', sql.Int, usuario_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .query(`
          SELECT TOP 1 sa.usuario_id, sa.planta_id, sa.turno, c.nombre AS cargo_nombre
          FROM bitacora.sesion_activa sa
          INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
          WHERE sa.usuario_id = @usuario_id AND sa.planta_id = @planta_id AND sa.activa = 1
          ORDER BY sa.inicio_sesion DESC
        `);
      const targetSesion = userSesRes.recordset[0];
      if (!targetSesion) continue;

      // D-040: finalización forzada = marcar la SESIÓN DE APP del objetivo, igual que /finalizar.
      // Ya no toca sesion_bitacora (solo presencia). CIET solo si cambió (idempotente).
      const upd = await new sql.Request(transaction)
        .input('usuario_id', sql.Int, usuario_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .input('ventana_inicio', sql.DateTime2, ventanaInicio)
        .input('ventana_fin', sql.DateTime2, ventanaFin)
        .query(`
          UPDATE bitacora.sesion_activa SET turno_finalizado_en = SYSUTCDATETIME()
          WHERE usuario_id = @usuario_id AND planta_id = @planta_id AND activa = 1
            AND (turno_finalizado_en IS NULL
                 OR turno_finalizado_en < @ventana_inicio
                 OR turno_finalizado_en >= @ventana_fin);
        `);

      if ((upd.rowsAffected[0] || 0) > 0) {
        // D-045 E4: reflejar la finalización forzada en turno_participante del objetivo (su turno vigente).
        await new sql.Request(transaction)
          .input('usuario_id', sql.Int, usuario_id)
          .input('planta_id', sql.VarChar(10), sesion.planta_id)
          .query(`
            UPDATE tp SET finalizado_individual_en = SYSUTCDATETIME()
            FROM bitacora.turno_participante tp
            INNER JOIN bitacora.sesion_activa sa ON sa.turno_id = tp.turno_id AND sa.usuario_id = tp.usuario_id
            WHERE sa.usuario_id = @usuario_id AND sa.planta_id = @planta_id AND sa.activa = 1 AND sa.turno_id IS NOT NULL;
          `);
        const ciet = await registrarEventoCierre(transaction, {
          tipo: 'finalizacion',
          sesion: targetSesion,
          forzado: true,
          motivo: 'popup-pendientes',
        });
        finalizados.push({ usuario_id, ciet_registro_id: ciet.registro_id });
      }
    }
    await transaction.commit();
    return sendJSON(res, 200, { finalizados });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// GET /api/bitacora/usuarios-en-bitacora?planta_id=&bitacora_id=  (F2, para el popup de cierre masivo)
router.get('/usuarios-en-bitacora', asyncH(async (req, res) => {
  const planta_id = req.query.planta_id;
  const bitacora_id = req.query.bitacora_id;
  if (!planta_id || !bitacora_id) {
    return sendJSON(res, 400, { error: 'planta_id y bitacora_id son requeridos' });
  }
  const db = await getDB();
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('bitacora_id', sql.Int, parseInt(bitacora_id, 10))
    .query(`
      SELECT DISTINCT
        sb.sesion_bitacora_id, sb.sesion_id, sb.abierta_en,
        sa.usuario_id, sa.cargo_id, sa.turno,
        u.nombre_completo,
        c.nombre AS cargo_nombre
      FROM bitacora.sesion_bitacora sb
      INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
      INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
      WHERE sb.bitacora_id = @bitacora_id
        AND sa.planta_id = @planta_id
        AND sa.activa = 1
        AND sb.finalizada_en IS NULL
      ORDER BY u.nombre_completo
    `);
  return sendJSON(res, 200, { usuarios: result.recordset });
}));

// GET /api/bitacora/counts?planta_id=GEC3  (snapshot inicial de borradores por bitácora)
router.get('/counts', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
  }
  const db = await getDB();
  // F10: excluir bitácoras ocultas (CIET) del conteo.
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT r.bitacora_id, COUNT(*) AS total
      FROM bitacora.registro_activo r
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
      WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
        AND b.oculta = 0
      GROUP BY r.bitacora_id
    `);
  const counts = {};
  for (const row of result.recordset) counts[row.bitacora_id] = row.total;
  return sendJSON(res, 200, { counts });
}));

export default router;
