// D-065 · Router de cumplimiento de la rotación (superficie C). Solo consulta.
// Montado por auth/app.js (L04) como /api/rotacion/cumplimiento, tras requireEntra (D-037), ANTES de
// /api/rotacion para que Express no lo engulla. Exige sesión de app; sin gate por flag: la vista es
// de consulta y la ve cualquier rol, incluido el observador (D-059).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { diasEntre } from '../utils/rotacion/patron.js';
import { consultarCumplimiento, RANGO_MAX_DIAS } from '../utils/rotacion/cumplimiento.js';
import { resolverTurnoAbierto } from '../utils/turno-entidad.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// Los SEIS códigos del motor (C1 + decisión D1 del GATE-O1). Se mapean a 400 con su slug; NUNCA
// llegan crudos a la respuesta (D-032). Cualquier otro error sube a expressErrorHandler.
const MENSAJES_MOTOR = {
  fecha_invalida: 'La fecha no es válida. Usa el formato YYYY-MM-DD con una fecha real.',
  patron_invalido: 'El patrón de rotación configurado para un rol no es válido. Revisa la configuración anual.',
  vector_invalido: 'El vector del patrón de rotación de un rol no es válido. Revisa la configuración anual.',
  desfase_imposible: 'La combinación de grupos del patrón no existe en la malla. Revisa la configuración anual.',
  desfase_ambiguo: 'La combinación de grupos del patrón es ambigua. Revisa la configuración anual.',
  turno_invalido: 'El turno debe ser 1 o 2.',
};

const RE_PLANTA = /^[A-Za-z0-9_-]{1,10}$/;

function resp400(res, codigo, mensaje) {
  return sendJSON(res, 400, { error: codigo, codigo, mensaje });
}

// GET /api/rotacion/cumplimiento?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&planta_id=GEC3  (contrato C6)
// Rango inclusivo de fechas operativas (día Bogotá), máximo RANGO_MAX_DIAS → 400 rango_excesivo.
// Turnos cerrados salen de rotacion_cumplimiento (congelado: true); el turno ABIERTO de la planta
// se deriva en vivo (congelado: false).
router.get('/', asyncH(async (req, res) => {
  const { desde, hasta, planta_id } = req.query;

  if (typeof desde !== 'string' || typeof hasta !== 'string' || !desde || !hasta) {
    return resp400(res, 'rango_requerido', 'desde y hasta son requeridos en formato YYYY-MM-DD (Bogotá).');
  }
  let dias;
  try {
    dias = diasEntre(desde, hasta) + 1;
  } catch (err) {
    if (err?.message === 'fecha_invalida') return resp400(res, 'fecha_invalida', MENSAJES_MOTOR.fecha_invalida);
    throw err;
  }
  if (dias < 1) {
    return resp400(res, 'rango_invalido', 'hasta debe ser igual o posterior a desde.');
  }
  if (dias > RANGO_MAX_DIAS) {
    return resp400(res, 'rango_excesivo', `El rango no puede superar ${RANGO_MAX_DIAS} días.`);
  }
  if (typeof planta_id !== 'string' || !RE_PLANTA.test(planta_id)) {
    return resp400(res, 'planta_invalida', 'planta_id es requerido.');
  }

  const pool = await getDB();
  // Data-driven (convención 12/28): existe en el catálogo o no; sin allowlist de plantas en el endpoint.
  const planta = await pool.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT planta_id FROM lov_bit.planta WHERE planta_id = @p`);
  if (!planta.recordset[0]) {
    return resp400(res, 'planta_invalida', 'La planta indicada no existe.');
  }
  const plantaCanonica = planta.recordset[0].planta_id;

  try {
    const turnoAbierto = await resolverTurnoAbierto(pool, plantaCanonica);
    const { filas, resumen } = await consultarCumplimiento(pool, {
      desde, hasta, planta_id: plantaCanonica, turnoAbierto,
    });
    return sendJSON(res, 200, { filas, resumen });
  } catch (err) {
    const codigo = err?.message;
    if (codigo && Object.hasOwn(MENSAJES_MOTOR, codigo)) return resp400(res, codigo, MENSAJES_MOTOR[codigo]);
    throw err;
  }
}));

export default router;
