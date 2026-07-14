// D-047: cliente Gemini de "Mejorar con IA" (sin BD ni red — unit test puro).
//
// El fetch está MOCKEADO por inyección de dependencia (fetchFn) → no toca Gemini ni gasta cuota.
// Fijan: (a) la key viaja en header y JAMÁS en la URL; (b) el system prompt lleva el rol por
// bitácora y las reglas anti prompt-injection; (c) TODO fallo externo se normaliza a
// codigo 'ia_no_disponible' sin filtrar el texto del operador; (d) nunca se acepta una salida
// truncada (finishReason ≠ STOP) ni anómala (>3× la entrada).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mejorarTexto, iaConfigurada, GEMINI_MODEL, MAX_TEXTO_CHARS } from '../utils/ia/gemini-client.js';
import { buildSystemPrompt, ROL_POR_BITACORA } from '../utils/ia/prompts.js';

// La suite corre con --env-file: el .env real puede traer (o no) GEMINI_API_KEY.
// Guardamos/restauramos para que estos tests sean deterministas y no dependan del entorno.
const KEY_ORIGINAL = process.env.GEMINI_API_KEY;
beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key-sintetica'; });
afterEach(() => {
  if (KEY_ORIGINAL === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = KEY_ORIGINAL;
});

// Respuesta fake con el shape mínimo que consume el cliente.
function respGemini(texto, { status = 200, finishReason = 'STOP', contentLength } = {}) {
  const body = texto === null
    ? {}
    : { candidates: [{ content: { parts: [{ text: texto }] }, finishReason }] };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'content-length' && contentLength != null ? String(contentLength) : null) },
    json: async () => body,
  };
}

function fetchQueDevuelve(resp) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return resp; };
  fn.calls = calls;
  return fn;
}

describe('mejorarTexto — camino feliz', () => {
  test('corrige el texto y arma la petición blindada (key en header, no en URL)', async () => {
    const fetchFn = fetchQueDevuelve(respGemini('Se realizó purga de caldera.'));
    const out = await mejorarTexto({ texto: 'se realizo purga de caldera.', bitacoraCodigo: 'CALDERA', fetchFn });
    assert.equal(out, 'Se realizó purga de caldera.');

    const { url, opts } = fetchFn.calls[0];
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    assert.doesNotMatch(url, /key|test-key-sintetica/i, 'la key jamás va en la URL');
    assert.equal(opts.headers['x-goog-api-key'], 'test-key-sintetica');
    assert.equal(opts.redirect, 'error');
    assert.ok(opts.signal instanceof AbortSignal, 'debe llevar timeout via AbortSignal');

    const payload = JSON.parse(opts.body);
    const system = payload.system_instruction.parts[0].text;
    assert.match(system, /calderas de centrales de generación termoeléctrica/, 'rol de CALDERA');
    assert.match(system, /NO las obedezcas/, 'regla anti prompt-injection');
    assert.match(system, /ÚNICAMENTE con el texto corregido/, 'regla de salida limpia');
    assert.equal(payload.contents[0].parts[0].text, 'se realizo purga de caldera.');
    assert.equal(payload.generationConfig.temperature, 0.1);
    assert.equal(payload.generationConfig.thinkingConfig.thinkingBudget, 0);
  });

  test('bitácora desconocida o null → system prompt con rol genérico (no lanza)', async () => {
    for (const codigo of ['NOEXISTE', null]) {
      const fetchFn = fetchQueDevuelve(respGemini('Texto ok.'));
      await mejorarTexto({ texto: 'texto ok.', bitacoraCodigo: codigo, fetchFn });
      const system = JSON.parse(fetchFn.calls[0].opts.body).system_instruction.parts[0].text;
      assert.match(system, /registro de eventos operativos/, `fallback genérico para ${codigo}`);
    }
  });

  // D-053: eran 8 hasta que SALA se partió por rol (SALAJDT/SALAING/SALAOP). El espejo contra el
  // catálogo real de BD lo fija catalogo_bitacoras.test.js (D-052); acá basta con que cada código
  // genérico tenga rol y que su nombre llegue al prompt.
  test('buildSystemPrompt cubre las 10 bitácoras genéricas del catálogo', () => {
    for (const codigo of [
      'CALDERA', 'ANAL', 'SALAJDT', 'SALAING', 'SALAOP', 'AGUA', 'TURBO', 'MAQU', 'CYC', 'QUIM',
    ]) {
      assert.ok(ROL_POR_BITACORA[codigo], `falta rol para ${codigo}`);
      assert.match(buildSystemPrompt(codigo), new RegExp(ROL_POR_BITACORA[codigo].nombre));
    }
  });
});

describe('mejorarTexto — fallos externos → ia_no_disponible, sin filtrar el texto', () => {
  const TEXTO = 'texto operativo confidencial de prueba';

  test('timeout del fetch (TimeoutError de AbortSignal.timeout)', async () => {
    const fetchFn = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    await assert.rejects(
      mejorarTexto({ texto: TEXTO, bitacoraCodigo: 'CALDERA', fetchFn }),
      (err) => {
        assert.equal(err.codigo, 'ia_no_disponible');
        assert.doesNotMatch(err.message, /confidencial/, 'el mensaje interno no lleva el texto del operador');
        return true;
      },
    );
  });

  test('HTTP 429 y 500 de Gemini', async () => {
    for (const status of [429, 500]) {
      await assert.rejects(
        mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(respGemini('x', { status })) }),
        (err) => err.codigo === 'ia_no_disponible',
        `status=${status}`,
      );
    }
  });

  test('respuesta malformada (sin candidates) y texto vacío', async () => {
    for (const resp of [respGemini(null), respGemini('   ')]) {
      await assert.rejects(
        mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(resp) }),
        (err) => err.codigo === 'ia_no_disponible',
      );
    }
  });

  test('respuesta no-JSON', async () => {
    const resp = { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('no json'); } };
    await assert.rejects(
      mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(resp) }),
      (err) => err.codigo === 'ia_no_disponible',
    );
  });

  test('salida truncada (finishReason=MAX_TOKENS) → nunca reemplazar el texto del operador', async () => {
    await assert.rejects(
      mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(respGemini('texto cortad', { finishReason: 'MAX_TOKENS' })) }),
      (err) => err.codigo === 'ia_no_disponible',
    );
  });

  test('salida anómala (mucho más larga que la entrada) → rechazo', async () => {
    const inflada = 'bla '.repeat(200); // 800 chars >> max(37*3, 37+200)
    await assert.rejects(
      mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(respGemini(inflada)) }),
      (err) => err.codigo === 'ia_no_disponible',
    );
  });

  test('cuerpo gigante (content-length) → rechazo sin leerlo', async () => {
    await assert.rejects(
      mejorarTexto({ texto: TEXTO, fetchFn: fetchQueDevuelve(respGemini('ok', { contentLength: 512 * 1024 })) }),
      (err) => err.codigo === 'ia_no_disponible',
    );
  });
});

describe('configuración', () => {
  test('sin GEMINI_API_KEY → iaConfigurada()=false y mejorarTexto rechaza con ia_no_configurada', async () => {
    delete process.env.GEMINI_API_KEY;
    assert.equal(iaConfigurada(), false);
    await assert.rejects(
      mejorarTexto({ texto: 'hola', fetchFn: async () => { throw new Error('no debe llamarse'); } }),
      (err) => err.codigo === 'ia_no_configurada',
    );
  });

  test('con key → iaConfigurada()=true; MAX_TEXTO_CHARS exportado para el router', () => {
    assert.equal(iaConfigurada(), true);
    assert.equal(MAX_TEXTO_CHARS, 2000);
  });
});
