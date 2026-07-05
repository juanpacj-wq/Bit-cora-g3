// D-047: cliente Gemini para "Mejorar con IA". La API key vive SOLO acá (server-side).
// INVARIANTE: nunca loguear ni propagar el contenido del texto del operador (ni la key).
// `fetchFn` es inyectable para tests unitarios (patrón DI de sis-client, sin tocar la red).

import { buildSystemPrompt } from './prompts.js';

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
export const MAX_TEXTO_CHARS = 2000; // fuente única del tope de entrada (la importa el router)
const TIMEOUT_MS = 12_000;
const MAX_RESPUESTA_BYTES = 256 * 1024; // el JSON real pesa ~1-3 KB; defensa ante cuerpos gigantes

// Fail-fast al cargar (patrón validarSisHost): el modelo es lo único interpolado en la URL,
// solo charset seguro para que un env malicioso/typo no altere la ruta.
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
export const GEMINI_MODEL = (() => {
  const m = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  if (!MODEL_RE.test(m)) throw new Error(`GEMINI_MODEL inválido: ${m}`);
  return m;
})();

// La key se lee en CALL-TIME (no al cargar): la feature es opcional/degradable y los tests la togglean.
export function iaConfigurada() {
  return !!process.env.GEMINI_API_KEY;
}

// Todo fallo del servicio externo se normaliza a codigo 'ia_no_disponible' (rama en clasificarError).
function errIA(detalle) {
  const err = new Error(`[ia] ${detalle}`);
  err.codigo = 'ia_no_disponible';
  return err;
}

export async function mejorarTexto({ texto, bitacoraCodigo, fetchFn = fetch }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('[ia] GEMINI_API_KEY no configurada');
    err.codigo = 'ia_no_configurada';
    throw err;
  }

  const payload = {
    system_instruction: { parts: [{ text: buildSystemPrompt(bitacoraCodigo) }] },
    contents: [{ role: 'user', parts: [{ text: texto }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 }, // flash-lite: sin "thinking" → rápido y barato
    },
  };

  let resp;
  try {
    resp = await fetchFn(`${GEMINI_HOST}/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // key en header, jamás en URL
      body: JSON.stringify(payload),
      redirect: 'error', // no seguir 30x
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // sin e.message (puede traer la URL); e.cause.code sí es seguro y es lo que ops necesita
    // para diagnosticar (SELF_SIGNED_CERT_IN_CHAIN = falta la CA corporativa, ENOTFOUND = DNS…).
    const causa = e?.cause?.code || e?.cause?.name;
    throw errIA(`fetch falló: ${e?.name || 'Error'}${causa ? ` (${causa})` : ''}`);
  }
  if (!resp.ok) throw errIA(`HTTP ${resp.status}`);

  const cl = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(cl) && cl > MAX_RESPUESTA_BYTES) throw errIA(`respuesta demasiado grande: ${cl} bytes`);

  let data;
  try {
    data = await resp.json();
  } catch {
    throw errIA('respuesta no-JSON');
  }

  const cand = data?.candidates?.[0];
  const out = cand?.content?.parts?.[0]?.text;
  if (typeof out !== 'string' || !out.trim()) throw errIA('respuesta sin texto');
  // Salida truncada por maxOutputTokens u otro finishReason ≠ STOP: NUNCA reemplazar el texto
  // del operador con un texto cortado o filtrado.
  if (cand.finishReason && cand.finishReason !== 'STOP') throw errIA(`finishReason=${cand.finishReason}`);

  const corregido = out.trim();
  // Anomalía: una "corrección" no puede crecer mucho (el prompt prohíbe agregar contenido).
  if (corregido.length > Math.max(texto.length * 3, texto.length + 200)) {
    throw errIA(`respuesta anómala: ${texto.length}ch → ${corregido.length}ch`);
  }
  return corregido;
}
