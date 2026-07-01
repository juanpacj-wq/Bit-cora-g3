// Router de eventos-dashboard (E4, AUD-34/35). Borde del contrato cross-repo con dashboard-gen-gec3.
// Montado bajo /api/eventos-dashboard tras requireEntra.
//   - GET '/' es PÚBLICO (está en la allowlist de _middleware.js): el dashboard lo consume sin
//     cookie de usuario; su gate es un token de servicio OPCIONAL (AUD-18). Por eso NO usa loadAppSession.
//   - DELETE '/:id' SÍ exige sesión de app + puede_cerrar_turno (lo usa MAND para cancelar celdas).

import express from 'express';
import crypto from 'node:crypto';
import sql from 'mssql';
import { getDB, TEST_PLANTA_ID } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { puedeCerrarTurno } from '../middleware/permissions.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();

// GET /api/eventos-dashboard?planta_id=&fecha=&tipo=
// `tipo` opcional — sin él retorna todos los tipos (AUTH+REDESP+PRUEBA) activos para esa (planta,
// fecha). tipo='DISP' lee de bitacora.disponibilidad_dashboard (semántica distinta: sin periodo,
// sin fecha; 1 fila por planta con el estado vigente).
router.get('/', asyncH(async (req, res) => {
  // AUD-18: gate OPCIONAL y no-rompedor. Sin DASHBOARD_API_TOKEN → abierto (comportamiento actual).
  // Con el token seteado → se exige X-Dashboard-Token igual (comparación en tiempo constante).
  const dashboardToken = process.env.DASHBOARD_API_TOKEN;
  if (dashboardToken) {
    const provisto = req.headers['x-dashboard-token'];
    const esperado = Buffer.from(dashboardToken);
    const recibido = Buffer.from(typeof provisto === 'string' ? provisto : '');
    const ok = recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
    if (!ok) {
      return sendJSON(res, 401, { error: 'Token de servicio inválido o ausente' });
    }
  }
  const planta_id = req.query.planta_id;
  const fecha = req.query.fecha;
  const tipo = req.query.tipo;

  // D-030: la planta de test reservada nunca debe filtrarse al dashboard productivo. Este endpoint
  // es el único borde del contrato cross-repo, así que la tratamos como inexistente acá.
  if (planta_id === TEST_PLANTA_ID) {
    return sendJSON(res, 200, { eventos: [] });
  }

  if (tipo === 'DISP') {
    if (!planta_id) {
      return sendJSON(res, 400, { error: 'planta_id es requerido para tipo=DISP' });
    }
    const db = await getDB();
    const r = await db.request()
      .input('p', sql.VarChar(10), planta_id)
      .query(`
        SELECT planta_id, evento, codigo, fecha_inicio_estado,
               jdts_snapshot, jefes_snapshot, actualizado_en
        FROM bitacora.disponibilidad_dashboard
        WHERE planta_id = @p
      `);
    const row = r.recordset[0] || null;
    return sendJSON(res, 200, { eventos: row ? [row] : [] });
  }

  if (!planta_id || !fecha) {
    return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
  }
  const db = await getDB();
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, new Date(fecha))
    .input('tipo', sql.VarChar(10), tipo || null)
    .query(`
      SELECT e.evento_id, e.registro_origen_id, e.planta_id, e.fecha, e.periodo,
             e.valor_mw, e.tipo, e.jdts_snapshot, e.jefes_snapshot, e.activa, e.creado_en
      FROM bitacora.evento_dashboard e
      WHERE e.planta_id = @planta_id AND e.fecha = @fecha AND e.activa = 1
        AND (@tipo IS NULL OR e.tipo = @tipo)
      ORDER BY e.periodo, e.tipo
    `);
  return sendJSON(res, 200, { eventos: result.recordset });
}));

// DELETE /api/eventos-dashboard/:id — opera sobre cualquier tipo (F7 lo usa para vaciar celdas MAND).
router.delete('/:id(\\d+)', loadAppSession, asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden anular eventos' });
  }
  const evento_id = parseInt(req.params.id, 10);
  const db = await getDB();
  const result = await db.request()
    .input('evento_id', sql.Int, evento_id)
    .input('planta_id', sql.VarChar(10), sesion.planta_id)
    .query(`
      UPDATE bitacora.evento_dashboard
      SET activa = 0
      WHERE evento_id = @evento_id AND planta_id = @planta_id
    `);
  if (!result.rowsAffected[0]) {
    return sendJSON(res, 404, { error: 'Evento no encontrado' });
  }
  return sendJSON(res, 200, { ok: true });
}));

export default router;
