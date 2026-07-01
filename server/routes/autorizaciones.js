// Router de autorizaciones (E4, AUD-34/35). F9: DEPRECATED — el dashboard ya consume
// /api/eventos-dashboard. Se migra tal cual (con sus warnings) hasta que un release lo borre.
// Montado bajo /api/autorizaciones tras requireEntra; todas exigen sesión de app (loadAppSession).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { puedeCerrarTurno } from '../middleware/permissions.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/autorizaciones?planta_id=&fecha=
// F5: alias filtrado por tipo='AUTH' vía la vista compat `bitacora.autorizacion_dashboard`.
router.get('/', asyncH(async (req, res) => {
  console.warn('[deprecated] GET /api/autorizaciones — usar /api/eventos-dashboard?tipo=AUTH');
  const planta_id = req.query.planta_id;
  const fecha = req.query.fecha;
  if (!planta_id || !fecha) {
    return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
  }
  const db = await getDB();
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, new Date(fecha))
    .query(`
      SELECT a.autorizacion_id, a.registro_origen_id, a.planta_id, a.fecha, a.periodo,
             a.valor_autorizado_mw, a.jdts_snapshot, a.jefes_snapshot, a.activa, a.creado_en
      FROM bitacora.autorizacion_dashboard a
      WHERE a.planta_id = @planta_id AND a.fecha = @fecha AND a.activa = 1
      ORDER BY a.periodo
    `);
  return sendJSON(res, 200, { autorizaciones: result.recordset });
}));

// DELETE /api/autorizaciones/:id  (F9: deprecated — usar DELETE /api/eventos-dashboard/:id)
router.delete('/:id(\\d+)', asyncH(async (req, res) => {
  console.warn('[deprecated] DELETE /api/autorizaciones/:id — usar /api/eventos-dashboard/:id');
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden anular autorizaciones' });
  const autorizacion_id = parseInt(req.params.id, 10);
  const db = await getDB();
  // F5: el id viejo (autorizacion_id) coincide con evento_id porque sp_rename solo cambió
  // el nombre de la columna, no los valores. Filtramos tipo='AUTH' para preservar la
  // semántica del alias (no permitimos borrar REDESP/PRUEBA por aquí).
  const result = await db.request()
    .input('evento_id', sql.Int, autorizacion_id)
    .input('planta_id', sql.VarChar(10), sesion.planta_id)
    .query(`
      UPDATE bitacora.evento_dashboard
      SET activa = 0
      WHERE evento_id = @evento_id AND planta_id = @planta_id AND tipo = 'AUTH'
    `);
  if (!result.rowsAffected[0]) {
    return sendJSON(res, 404, { error: 'Autorización no encontrada' });
  }
  return sendJSON(res, 200, { ok: true });
}));

// GET /api/autorizaciones/:planta_id/:fecha/:periodo  (F9: deprecated — usar /api/eventos-dashboard)
// El original gateaba fecha (YYYY-MM-DD) y periodo (\d+) en el regex de ruta; acá se valida en el
// handler y, si no matchea, se responde 404 (equivalente a "la ruta no matcheó").
router.get('/:planta_id/:fecha/:periodo', asyncH(async (req, res) => {
  const { planta_id, fecha, periodo } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d+$/.test(periodo)) {
    return sendJSON(res, 404, { error: 'No encontrado' });
  }
  console.warn('[deprecated] GET /api/autorizaciones/:p/:f/:per — usar /api/eventos-dashboard');
  const db = await getDB();
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, new Date(fecha))
    .input('periodo', sql.TinyInt, parseInt(periodo, 10))
    .query(`
      SELECT a.*
      FROM bitacora.autorizacion_dashboard a
      WHERE a.planta_id = @planta_id AND a.fecha = @fecha
        AND a.periodo = @periodo AND a.activa = 1
    `);
  if (result.recordset.length === 0) {
    return sendJSON(res, 404, { error: 'Autorización no encontrada' });
  }
  return sendJSON(res, 200, { autorizacion: result.recordset[0] });
}));

export default router;
