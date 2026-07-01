// Router de conformación de turno (E3, AUD-34/35). Consulta + trigger manual del snapshot.
// Montado bajo /api/conformacion-turno tras requireEntra. Ambas exigen sesión de app.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { responderError } from '../utils/errores.js';
import { puedeVerConformacion, puedeTriggerConformacion } from '../middleware/permissions.js';
import { ventanaTurno } from '../utils/turno.js';
import { buildConformacionSnapshot, persistConformacionSnapshot } from '../utils/conformacion-snapshot.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/conformacion-turno?fecha=&turno=&planta_id=
// Auth requerida; cualquier cargo con sesión activa puede ver (puedeVerConformacion=true).
router.get('/', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeVerConformacion(sesion)) return sendJSON(res, 403, { error: 'No autorizado' });

  const fecha = req.query.fecha;
  const turno = parseInt(req.query.turno, 10);
  const planta_id = req.query.planta_id;

  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD (Bogotá)' });
  }
  if (![1, 2].includes(turno)) {
    return sendJSON(res, 400, { error: 'turno debe ser 1 o 2' });
  }
  if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id debe ser GEC3 o GEC32' });
  }

  const db = await getDB();
  const r = await db.request()
    .input('fecha', sql.Date, fecha)
    .input('turno', sql.TinyInt, turno)
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT
        fecha_operativa, planta_id, turno,
        usuario_id, usuario_nombre,
        cargo_id, cargo_nombre,
        inicio_sesion, fin_sesion,
        inicio_sesion_bogota, fin_sesion_bogota,
        duracion_min, fin_inferido,
        snapshot_en, snapshot_en_bogota
      FROM bitacora.conformacion_turno
      WHERE fecha_operativa = @fecha
        AND turno = @turno
        AND planta_id = @planta_id
      ORDER BY inicio_sesion ASC
    `);

  return sendJSON(res, 200, {
    fecha_operativa: fecha,
    planta_id,
    turno,
    filas: r.recordset,
    total: r.recordset.length,
  });
}));

// POST /api/conformacion-turno/trigger?force=true  (QA + recovery)
// Permisos restrictivos vía puedeTriggerConformacion. Por defecto rechaza turnos cuya ventana no
// cerró — bypass con ?force=true. Idempotencia natural vía PK de conformacion_turno.
router.post('/trigger', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeTriggerConformacion(sesion)) {
    return sendJSON(res, 403, { error: 'Solo Ingeniero Jefe de Turno, Ingeniero de Operación o Jefe de Planta pueden disparar el snapshot manual' });
  }

  const { fecha_operativa, planta_id, turno } = req.body || {};

  if (!fecha_operativa || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_operativa)) {
    return sendJSON(res, 400, { error: 'fecha_operativa requerida en formato YYYY-MM-DD (Bogotá)' });
  }
  if (![1, 2].includes(turno)) {
    return sendJSON(res, 400, { error: 'turno debe ser 1 o 2' });
  }
  if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id debe ser GEC3 o GEC32' });
  }

  const forceQuery = req.query.force === 'true';
  // Mediodía Bogotá para evitar el shift -5h de colombiaParts con string 'YYYY-MM-DD'.
  const fechaRef = new Date(`${fecha_operativa}T12:00:00.000-05:00`);
  const { fin: ventanaFin } = ventanaTurno(turno, fechaRef);
  if (!forceQuery && new Date() < ventanaFin) {
    return sendJSON(res, 400, {
      error: 'La ventana del turno aún no cerró. Use ?force=true si quieres disparar sobre un turno en curso (snapshot puede ser incompleto).',
      ventana_fin: ventanaFin.toISOString(),
    });
  }

  try {
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, { fecha_operativa, planta_id, turno });
    const { insertadas, skipped } = await persistConformacionSnapshot(db, filas);
    return sendJSON(res, 200, {
      fecha_operativa, planta_id, turno,
      insertadas, skipped,
      filas_resultado: filas.length,
      force: forceQuery,
      disparado_por: { usuario_id: sesion.usuario_id, nombre: sesion.nombre_completo },
    });
  } catch (err) {
    return responderError(res, err, 'POST /api/conformacion-turno/trigger');
  }
}));

export default router;
