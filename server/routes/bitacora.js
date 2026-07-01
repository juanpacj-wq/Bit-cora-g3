// Router de participación en bitácoras (E10, AUD-34/35). abrir / finalizar / finalizar-forzado /
// usuarios-en-bitacora / counts. Montado bajo /api/bitacora tras requireEntra; todas exigen sesión
// de app (loadAppSession).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora, puedeCerrarTurno, plantaMatch } from '../middleware/permissions.js';
import { registrarEventoCierre } from '../utils/ciet.js';
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

// POST /api/bitacora/finalizar (F2/F3) — finaliza TODAS las sesion_bitacora del usuario + 1 CIET.
router.post('/finalizar', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const pool = await getDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await new sql.Request(transaction)
      .input('usuario_id', sql.Int, sesion.usuario_id)
      .query(`
        DECLARE @afectadas TABLE (sesion_bitacora_id INT, sesion_id INT, bitacora_id INT);

        UPDATE sb SET finalizada_en = SYSUTCDATETIME()
        OUTPUT inserted.sesion_bitacora_id, inserted.sesion_id, inserted.bitacora_id INTO @afectadas
        FROM bitacora.sesion_bitacora sb
        INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
        WHERE sa.usuario_id = @usuario_id AND sb.finalizada_en IS NULL;

        SELECT a.sesion_bitacora_id, a.sesion_id, a.bitacora_id,
               b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo
        FROM @afectadas a
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = a.bitacora_id;
      `);

    let evento_ciet = null;
    if (result.recordset.length > 0) {
      evento_ciet = await registrarEventoCierre(transaction, {
        tipo: 'finalizacion',
        sesion,
        forzado: false,
      });
    }

    await transaction.commit();
    return sendJSON(res, 200, { finalizadas: result.recordset, evento_ciet });
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

      const upd = await new sql.Request(transaction)
        .input('usuario_id', sql.Int, usuario_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .query(`
          UPDATE sb SET finalizada_en = SYSUTCDATETIME()
          FROM bitacora.sesion_bitacora sb
          INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
          WHERE sa.usuario_id = @usuario_id AND sa.planta_id = @planta_id
            AND sb.finalizada_en IS NULL;
        `);

      if ((upd.rowsAffected[0] || 0) > 0) {
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
