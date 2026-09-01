// D-065 · L05 — Router de la toma de control del rol (superficie B). Lo monta L04 en `auth/app.js`
// como `/api/rotacion/control`, tras `requireEntra` (nace cerrado, D-037) y fuera de la allowlist
// pública. Exige sesión de app (`loadAppSession`): el turno, la planta y el cargo salen de
// `req.sesion`; los tres POST van SIN cuerpo y lo que traiga se ignora.
//
// Contrato C5 (`_CONTEXTO-BASE.md §6`):
//   GET  /estado     → 200 { aplica, turno_id, cargo_id, cargo_nombre, principal, soy_principal,
//                            soy_titular, ya_respondi, pila }
//   POST /tomar      → 200 mismo shape · 409 ya_es_principal | turno_cerrado | control_ocupado
//   POST /abandonar  → 200 mismo shape · 409 no_es_principal | titular_no_abandona | turno_cerrado
//   POST /descartar  → 200 mismo shape + { ok: true } · 409 turno_cerrado
// Los 409 de dominio exponen su slug a propósito (convención 16, como los de DISP): el popup de L08
// ramifica por `codigo`. Todo lo inesperado sigue a `expressErrorHandler` vía `asyncH` (D-032).

import express from 'express';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { asyncH, loadAppSession, respTurnoCerrado } from './_middleware.js';
import {
  estadoControl, ejecutarAccion, ErrorControl, CODIGOS_MOTOR, MENSAJES_CONTROL,
} from '../utils/rotacion/control.js';

const router = express.Router();
router.use(loadAppSession);

const MENSAJE_MOTOR = 'La configuración de rotación de tu cargo no es válida. Avisa a quien administra la malla.';

// Traduce los errores de dominio a su HTTP. `turno_cerrado` reusa el 409 canónico de los write-gates
// (mismo slug que D-045/D-046). Los seis códigos del motor (D1 del GATE-O1) salen como 400 con su
// slug, nunca crudos. Cualquier otro error se relanza para que lo sanee el error-handler global.
function responderErrorDominio(res, e) {
  if (e instanceof ErrorControl) {
    if (e.codigo === 'turno_cerrado') return respTurnoCerrado(res);
    return sendJSON(res, 409, { error: e.codigo, codigo: e.codigo, mensaje: MENSAJES_CONTROL[e.codigo] });
  }
  if (CODIGOS_MOTOR.has(e?.message)) {
    return sendJSON(res, 400, { error: e.message, codigo: e.message, mensaje: MENSAJE_MOTOR });
  }
  throw e;
}

// GET /api/rotacion/control/estado — lo que el popup necesita al iniciar sesión. Informativo: con
// el turno cerrado responde 200 con `aplica: false` (el popup simplemente no se ofrece).
router.get('/estado', asyncH(async (req, res) => {
  const pool = await getDB();
  try {
    return sendJSON(res, 200, await estadoControl(pool, req.sesion));
  } catch (e) {
    return responderErrorDominio(res, e);
  }
}));

// Los tres verbos comparten forma: sin cuerpo, transaccionales, devuelven el estado resultante.
const verbo = (accion, extra = {}) => asyncH(async (req, res) => {
  const pool = await getDB();
  try {
    const estado = await ejecutarAccion(pool, req.sesion, accion);
    return sendJSON(res, 200, { ...estado, ...extra });
  } catch (e) {
    return responderErrorDominio(res, e);
  }
});

// POST /tomar — apila al usuario como principal del rol en el turno en curso.
router.post('/tomar', verbo('TOMAR'));
// POST /abandonar — desapila al usuario; el control vuelve al tenedor anterior (o al titular).
router.post('/abandonar', verbo('ABANDONAR'));
// POST /descartar — el "No" del popup: no toca la pila, solo apaga la pregunta en este turno.
router.post('/descartar', verbo('DESCARTAR', { ok: true }));

export default router;
