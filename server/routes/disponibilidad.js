// Router de Disponibilidad (E8, AUD-34/35; D-026). Mini-dashboard: estado completo + métricas
// acumuladas + deshacer. Montado bajo /api/disponibilidad tras requireEntra. (La CREACIÓN de estados
// DISP entra por POST/PUT /api/registros — rama DISP, E10 — no por aquí.)

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora } from '../middleware/permissions.js';
import {
  getEstadoCompleto, getMetricas,
  findVigente, findUltimoCerrado, eliminarPorId, restaurarComoVigente,
} from '../utils/notificador.js';
import { registrarDeshacerDisponibilidad } from '../utils/ciet.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { getDispBitacoraId } from './_shared.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/disponibilidad?planta_id=&historial_limit=20&historial_offset=0
// Permiso: puede_ver=1 en DISP (todos los cargos post-F12.A6). Storage en disponibilidad_estado (D-026).
router.get('/', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  const historial_limit = Math.min(100, Math.max(1, parseInt(req.query.historial_limit || '20', 10)));
  const historial_offset = Math.max(0, parseInt(req.query.historial_offset || '0', 10));

  const db = await getDB();
  const dispBitacoraId = await getDispBitacoraId(db);
  if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Disponibilidad' });
  }

  const out = await getEstadoCompleto(db, { planta_id, historial_limit, historial_offset });
  return sendJSON(res, 200, out);
}));

// GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=  (D-024/D-026)
// Duración acumulada por evento + acumulados disponible/no_disponible en [desde, hasta] (UTC ISO).
router.get('/metricas', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });

  const db = await getDB();
  const plantaCheck = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT 1 AS ok FROM lov_bit.planta WHERE planta_id=@p AND activa=1`);
  if (!plantaCheck.recordset[0]) {
    return sendJSON(res, 400, { error: 'planta_id no es operativa' });
  }

  const dispBitacoraId = await getDispBitacoraId(db);
  if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Disponibilidad' });
  }

  const desdeRaw = req.query.desde;
  const hastaRaw = req.query.hasta;
  const desde = desdeRaw ? new Date(desdeRaw) : null;
  const hasta = hastaRaw ? new Date(hastaRaw) : null;
  if (desdeRaw && Number.isNaN(desde.getTime())) {
    return sendJSON(res, 400, { error: 'desde inválido (ISO 8601 requerido)' });
  }
  if (hastaRaw && Number.isNaN(hasta.getTime())) {
    return sendJSON(res, 400, { error: 'hasta inválido (ISO 8601 requerido)' });
  }
  if (desde && hasta && desde.getTime() > hasta.getTime()) {
    return sendJSON(res, 400, { error: 'desde debe ser <= hasta' });
  }

  const out = await getMetricas(db, { planta_id, desde, hasta });
  return sendJSON(res, 200, out);
}));

// POST /api/disponibilidad/deshacer { planta_id }  (F12/D-026)
// Revierte el último cambio: borra el vigente y restaura el N-1 como vigente (o vacía la planta).
// Emite CIET 'Deshacer disponibilidad'. AUD-11: plantaMatch (solo la propia unidad).
router.post('/deshacer', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const { planta_id } = req.body || {};
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });

  const db = await getDB();
  const dispBitacoraId = await getDispBitacoraId(db);
  if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para deshacer en Disponibilidad' });
  }
  // DISP es cross-planta a propósito: quien tiene puede_crear puede deshacer el último cambio
  // de CUALQUIER planta, sin importar la unidad de su sesión (revierte el guard plantaMatch de
  // AUD-11 solo para DISP; el permiso por cargo sigue vigente).

  const transaction = new sql.Transaction(db);
  await transaction.begin();
  try {
    const vigente = await findVigente(transaction, { planta_id });
    if (!vigente) {
      await transaction.rollback();
      return sendJSON(res, 422, { error: 'sin_vigente', mensaje: `${planta_id} no tiene estado vigente` });
    }
    const nMenos1 = await findUltimoCerrado(transaction, { planta_id });

    // DELETE el vigente (es el que se está deshaciendo).
    await eliminarPorId(transaction, { disponibilidad_id: vigente.disponibilidad_id });

    let restaurado = null;
    if (nMenos1) {
      // Reabrir el N-1: fecha_fin_estado=NULL → pasa a vigente. No movemos filas entre
      // tablas; el row es el mismo, solo cambia su estado en la máquina (cerrado → vigente).
      await restaurarComoVigente(transaction, { disponibilidad_id: nMenos1.disponibilidad_id });
      restaurado = {
        registro_id: nMenos1.disponibilidad_id,
        evento: nMenos1.estado,
        codigo: nMenos1.codigo,
        fecha_inicio_estado: nMenos1.fecha_inicio_estado,
        fecha_fin_estado: null,
        detalle: nMenos1.detalle,
      };
    }

    const ciet = await registrarDeshacerDisponibilidad(transaction, {
      sesion,
      planta_id,
      evento_revertido: vigente.estado,
      fecha_revertida: vigente.fecha_inicio_estado,
    });

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    return sendJSON(res, 200, {
      revertido: { registro_id_eliminado: vigente.disponibilidad_id, evento: vigente.estado },
      restaurado,
      ciet_registro_id: ciet.registro_id,
    });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

export default router;
