// Router de la cabecera de turno (D-045). Montado bajo /api/turno tras requireEntra; exige sesión de
// app (loadAppSession). E6 aporta POST /cerrar (cierre unificado atómico, reemplaza el cierre masivo;
// el front migra en E8). E7 agregará /actual, /extender; E9 /seguimiento.

import express from 'express';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { puedeCerrarTurno, plantaMatch } from '../middleware/permissions.js';
import { resolverTurnoAbierto, cerrarTurno } from '../utils/turno-entidad.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

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
  return sendJSON(res, 200, {
    turno_id: turnoAbierto.turno_unidad_id,
    cerrado: !!resultado.cerrado,
    conformados: resultado.conformados,
    archivados: resultado.archivados,
    sucesor_id: resultado.sucesor?.turno_unidad_id ?? null,
  });
}));

export default router;
