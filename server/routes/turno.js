// Router de la cabecera de turno (D-045). Montado bajo /api/turno tras requireEntra; exige sesión de
// app (loadAppSession). E6 aporta POST /cerrar (cierre unificado atómico, reemplaza el cierre masivo;
// el front migra en E8). E7 agrega GET /actual y POST /extender + broadcast WS. E9 /seguimiento.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { puedeCerrarTurno, plantaMatch } from '../middleware/permissions.js';
import { resolverTurnoAbierto, cerrarTurno, extenderTurno, estadoTurnoActual } from '../utils/turno-entidad.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { broadcastTurnoTransicion } from '../utils/ws-turno-transicion.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/turno/actual — estado del turno de la unidad de la sesión, para el header y el fallback del
// modal (E8). `puede_decidir` = el cargo puede cerrar/extender (JdT/IngOp). No gateado por rol: cualquier
// sesión ve el estado de su propia unidad (informativo para quien no puede decidir).
router.get('/actual', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const pool = await getDB();
  const estado = await estadoTurnoActual(pool, sesion.planta_id);
  return sendJSON(res, 200, { ...estado, puede_decidir: puedeCerrarTurno(sesion) });
}));

// POST /api/turno/cerrar { planta_id } — cierre de turno MANUAL. Sella la cabecera ABIERTO de la
// unidad, congela conformación desde turno_participante, archiva los registros del turno y activa el
// sucesor, atómicamente (cerrarTurno). Gated puede_cerrar_turno + plantaMatch. Reemplaza
// POST /api/cierre/masivo (que sigue vivo hasta que E8 migre el front).
router.post('/cerrar', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar el turno' });
  }
  const { planta_id } = req.body || {};
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede cerrar el turno de otra planta' });
  }

  const pool = await getDB();
  const turnoAbierto = await resolverTurnoAbierto(pool, planta_id);
  if (!turnoAbierto) {
    return sendJSON(res, 409, { error: 'No hay un turno abierto en esta unidad', codigo: 'sin_turno_abierto' });
  }

  const resultado = await cerrarTurno(pool, turnoAbierto.turno_unidad_id, {
    motivo: 'MANUAL',
    cerrado_por: sesion.usuario_id,
    cargo_nombre: sesion.cargo_nombre,
  });

  broadcastConteoBitacoras(planta_id).catch(() => {});
  // E7: avisar a la planta que el turno se cerró (el modal de E8 lo consume; el header refresca estado).
  broadcastTurnoTransicion(planta_id, { estado: 'CERRADO', bloqueo: false, motivo: 'MANUAL' });
  return sendJSON(res, 200, {
    turno_id: turnoAbierto.turno_unidad_id,
    cerrado: !!resultado.cerrado,
    conformados: resultado.conformados,
    archivados: resultado.archivados,
    sucesor_id: resultado.sucesor?.turno_unidad_id ?? null,
  });
}));

// POST /api/turno/extender { planta_id, detalle? } — corre fin_nominal al próximo umbral (extendido=1,
// veces_extendido+1) + CIET 'Extensión de turno'. Gated puede_cerrar_turno + plantaMatch. Al extender,
// el bloqueo se levanta (fin_nominal ahora futuro) hasta el próximo umbral. Avisa por WS a la planta.
router.post('/extender', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden extender el turno' });
  }
  const { planta_id, detalle } = req.body || {};
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede extender el turno de otra planta' });
  }

  const pool = await getDB();
  const turnoAbierto = await resolverTurnoAbierto(pool, planta_id);
  if (!turnoAbierto) {
    return sendJSON(res, 409, { error: 'No hay un turno abierto en esta unidad', codigo: 'sin_turno_abierto' });
  }

  const row = await extenderTurno(pool, turnoAbierto.turno_unidad_id, {
    por_usuario: sesion.usuario_id,
    cargo_nombre: sesion.cargo_nombre,
    detalle: detalle || null,
  });
  if (!row) {
    return sendJSON(res, 409, { error: 'El turno ya no está abierto', codigo: 'sin_turno_abierto' });
  }

  // El bloqueo se levanta: fin_nominal corrió al próximo umbral.
  broadcastTurnoTransicion(planta_id, { estado: 'ABIERTO', bloqueo: false });
  return sendJSON(res, 200, {
    turno_id: row.turno_unidad_id,
    extendido: !!row.extendido,
    veces_extendido: row.veces_extendido,
    fin_nominal: row.fin_nominal,
  });
}));

// GET /api/turno/seguimiento?planta=&desde=&hasta= — ciclo de vida de los turnos de una unidad por
// rango de días (D-045 E9). Cualquier sesión puede consultarlo (solo lo que ya expone el histórico:
// estado, extensión, motivo_cierre, quién cerró, duración real vs nominal, nº de participantes). Sin
// filtros de fecha usa los últimos 14 días Bogotá. `planta` default = la de la sesión.
router.get('/seguimiento', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta = req.query.planta || sesion.planta_id;
  const pool = await getDB();
  const rq = pool.request().input('planta', sql.VarChar(10), planta);
  let where = 'planta_id = @planta';
  if (req.query.desde) { rq.input('desde', sql.Date, req.query.desde); where += ' AND fecha_operativa >= @desde'; }
  if (req.query.hasta) { rq.input('hasta', sql.Date, req.query.hasta); where += ' AND fecha_operativa <= @hasta'; }
  if (!req.query.desde && !req.query.hasta) {
    // Ventana por defecto: últimos 14 días operativos (Bogotá = UTC-5).
    where += " AND fecha_operativa >= CAST(DATEADD(HOUR, -5, DATEADD(DAY, -14, SYSUTCDATETIME())) AS DATE)";
  }
  const r = await rq.query(`
    SELECT * FROM bitacora.v_turno_seguimiento
    WHERE ${where}
    ORDER BY fecha_operativa DESC, turno DESC, planta_id
  `);
  return sendJSON(res, 200, { planta_id: planta, turnos: r.recordset });
}));

// GET /api/turno/seguimiento/:turnoId/participantes — detalle de un turno: si está CERRADO lee la
// conformación congelada (inmutable); si sigue vivo lee turno_participante (presencia en curso). Ambos
// exponen ingreso/fin/presencia (min) y la finalización individual cuando aplica.
router.get('/seguimiento/:turnoId/participantes', asyncH(async (req, res) => {
  const turnoId = Number.parseInt(req.params.turnoId, 10);
  if (!Number.isInteger(turnoId) || turnoId <= 0) {
    return sendJSON(res, 400, { error: 'Identificador de turno inválido' });
  }
  const pool = await getDB();
  const cab = await pool.request().input('id', sql.Int, turnoId)
    .query(`SELECT estado FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
  if (!cab.recordset[0]) return sendJSON(res, 404, { error: 'Turno no encontrado' });
  const cerrado = cab.recordset[0].estado === 'CERRADO';

  let participantes;
  if (cerrado) {
    const r = await pool.request().input('id', sql.Int, turnoId).query(`
      SELECT usuario_id, usuario_nombre, cargo_nombre,
             inicio_sesion, fin_sesion, duracion_min, fin_inferido,
             DATEADD(HOUR, -5, inicio_sesion) AS inicio_bogota,
             DATEADD(HOUR, -5, fin_sesion)    AS fin_bogota,
             CAST(NULL AS DATETIME2) AS finalizado_individual_en
      FROM bitacora.conformacion_turno
      WHERE turno_id = @id
      ORDER BY usuario_nombre
    `);
    participantes = r.recordset;
  } else {
    const r = await pool.request().input('id', sql.Int, turnoId).query(`
      SELECT usuario_id, usuario_nombre, cargo_nombre,
             primer_ingreso AS inicio_sesion, ultimo_egreso AS fin_sesion,
             presencia_acumulada_min AS duracion_min, CAST(0 AS BIT) AS fin_inferido,
             primer_ingreso_bogota AS inicio_bogota, ultimo_egreso_bogota AS fin_bogota,
             finalizado_individual_en
      FROM bitacora.turno_participante
      WHERE turno_id = @id
      ORDER BY usuario_nombre
    `);
    participantes = r.recordset;
  }
  return sendJSON(res, 200, { turno_id: turnoId, cerrado, participantes });
}));

export default router;
