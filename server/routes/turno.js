// Router de la cabecera de turno (D-045). Montado bajo /api/turno tras requireEntra; exige sesión de
// app (loadAppSession). E6 aporta POST /cerrar (cierre unificado atómico, reemplaza el cierre masivo;
// el front migra en E8). E7 agrega GET /actual y POST /extender + broadcast WS. E9 /seguimiento.

import express from 'express';
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

export default router;
