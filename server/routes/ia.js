// D-047: router de utilidades IA. Un solo endpoint: corrección ortográfica del campo `detalle`
// vía Gemini (server-side; la key jamás llega al front). Montado bajo /api/ia tras requireEntra;
// loadAppSession exige sesión de app (cualquier cargo: es una utilidad de escritura, no toca datos).
// INVARIANTE: nunca loguear el contenido del texto del operador — solo longitudes y bitácora.

import express from 'express';
import { sendJSON } from '../utils/http.js';
import { responderError, ETIQUETAS } from '../utils/errores.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { aplicarRateLimit, aplicarRateLimitGlobal } from './_shared.js';
import { esObservador } from '../middleware/permissions.js';
import { iaConfigurada, mejorarTexto, MAX_TEXTO_CHARS } from '../utils/ia/gemini-client.js';

const router = express.Router();
router.use(loadAppSession);

// POST /api/ia/mejorar-texto  body: { texto, bitacora_codigo? } → { texto_corregido }
router.post('/mejorar-texto', asyncH(async (req, res) => {
  // Rate limit ANTES de validar: el flood con cuerpos inválidos también cuenta, y los tests
  // pueden ejercer el 429 sin gastar cuota de Gemini. Los topes globales protegen el free tier
  // compartido (~15 req/min, ~1000 req/día por instancia).
  if (!aplicarRateLimit(req, res, 'ia-mejorar', { max: 10, windowMs: 60_000 })) return;
  if (!aplicarRateLimitGlobal(req, res, 'ia-global-min', { max: 14, windowMs: 60_000 })) return;
  if (!aplicarRateLimitGlobal(req, res, 'ia-global-dia', { max: 400, windowMs: 86_400_000 })) return;

  // D-059: el observador no escribe en ninguna bitácora — la mejora de texto es una utilidad de
  // escritura, así que se cierra también (y no gasta cuota de Gemini). Va ANTES del check de
  // configuración para que el 403 sea estable con o sin GEMINI_API_KEY.
  if (esObservador(req.sesion)) {
    const msg = 'Tu perfil es de solo consulta: la mejora de texto con IA no está disponible.';
    return sendJSON(res, 403, { error: msg, codigo: 'observador_solo_lectura', mensaje: msg });
  }

  const { texto, bitacora_codigo } = req.body || {};
  if (typeof texto !== 'string' || !texto.trim()) {
    const msg = 'Escribe una descripción antes de mejorarla con IA.';
    return sendJSON(res, 400, { error: msg, codigo: 'texto_requerido', mensaje: msg });
  }
  if (texto.length > MAX_TEXTO_CHARS) {
    const msg = `La descripción supera el máximo de ${MAX_TEXTO_CHARS} caracteres para mejorar con IA.`;
    return sendJSON(res, 400, { error: msg, codigo: 'texto_demasiado_largo', mensaje: msg });
  }
  // Código desconocido/ausente → fallback genérico dentro de buildSystemPrompt (no es un 400):
  // el rol NUNCA viene del cliente, solo este slug corto que se resuelve server-side.
  const codigo = typeof bitacora_codigo === 'string' && bitacora_codigo.length <= 20 ? bitacora_codigo : null;

  // Degradación limpia: sin key el endpoint responde 503 estable y el operador escribe a mano.
  if (!iaConfigurada()) {
    return sendJSON(res, 503, {
      error: ETIQUETAS.ia_no_configurada, codigo: 'ia_no_configurada', mensaje: ETIQUETAS.ia_no_configurada,
    });
  }

  try {
    const texto_corregido = await mejorarTexto({ texto: texto.trim(), bitacoraCodigo: codigo });
    console.log(`[ia] mejora ok bitacora=${codigo || '-'} in=${texto.length}ch out=${texto_corregido.length}ch`);
    return sendJSON(res, 200, { texto_corregido });
  } catch (err) {
    return responderError(res, err, '[POST /api/ia/mejorar-texto]');
  }
}));

export default router;
