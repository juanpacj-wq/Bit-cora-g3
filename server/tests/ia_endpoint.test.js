// D-047: integración del endpoint POST /api/ia/mejorar-texto contra el server vivo.
// Requiere el server en :3002 con AUTH_TEST_BYPASS=1 (harness `call`).
//
// NO stubbea Gemini: el caso con cuerpo válido es dual-assert (200 si hay GEMINI_API_KEY y el
// servicio responde, o 503 estable si no) y gasta ≤1 request de cuota por corrida — fija el
// contrato "no explota, no filtra internals". El camino feliz DETERMINISTA vive en
// ia_cliente.test.js (fetchFn inyectado, sin red).
//
// Orden importa: el rate limit va de ÚLTIMO porque agota la ventana del minuto para esta IP.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSessions, deactivateSyntheticSessions, call, TEST_PLANTA } from './helpers.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';

describe('D-047 POST /api/ia/mejorar-texto', () => {
  let sesiones;

  before(async () => {
    ({ sesiones } = await setupSessions({ planta: TEST_PLANTA }));
  });

  after(async () => {
    await deactivateSyntheticSessions();
  });

  test('sin sesión → 401 (endpoint cerrado, no está en la allowlist pública)', async () => {
    const r = await call('POST', '/api/ia/mejorar-texto', { body: { texto: 'hola' } });
    assert.equal(r.status, 401, JSON.stringify(r.data));
  });

  test('body sin texto → 400 texto_requerido', async () => {
    const r = await call('POST', '/api/ia/mejorar-texto', { body: {}, sesion_id: sesiones.jdt });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.codigo, 'texto_requerido');
  });

  test('texto de 2001 chars → 400 texto_demasiado_largo (tope de entrada)', async () => {
    const r = await call('POST', '/api/ia/mejorar-texto', {
      body: { texto: 'a'.repeat(2001) },
      sesion_id: sesiones.jdt,
    });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.codigo, 'texto_demasiado_largo');
  });

  test('cuerpo válido → 200 {texto_corregido} o 503 estable — nunca 500 ni internals', async () => {
    const r = await call('POST', '/api/ia/mejorar-texto', {
      body: { texto: 'se realizo prueba de integracion del endpoint', bitacora_codigo: 'CALDERA' },
      sesion_id: sesiones.jdt,
    });
    if (r.status === 200) {
      assert.equal(typeof r.data.texto_corregido, 'string');
      assert.ok(r.data.texto_corregido.trim().length > 0, 'texto_corregido no debe venir vacío');
    } else {
      assert.equal(r.status, 503, `esperaba 200 o 503, llegó ${r.status} ${JSON.stringify(r.data)}`);
      assert.ok(
        ['ia_no_configurada', 'ia_no_disponible'].includes(r.data.codigo),
        `codigo inesperado: ${r.data.codigo}`,
      );
    }
    assert.doesNotMatch(
      JSON.stringify(r.data),
      /googleapis|gemini|x-goog/i,
      'la respuesta no debe filtrar el proveedor ni detalles técnicos',
    );
  });

  test('rate limit por IP: ráfaga termina en 429 rate_limit con Retry-After', async () => {
    // Cuerpos inválidos a propósito: el limiter corre ANTES de validar (cuentan para la ventana)
    // y la validación corta antes de Gemini (no gastan cuota).
    let res;
    for (let i = 0; i < 15; i++) {
      res = await fetch(`${BASE_URL}/api/ia/mejorar-texto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sesion-Id': String(sesiones.jdt) },
        body: JSON.stringify({}),
      });
      if (res.status === 429) break;
    }
    assert.equal(res.status, 429, 'la ráfaga debía toparse con el rate limit por IP (10/min)');
    const data = await res.json();
    assert.equal(data.codigo, 'rate_limit');
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'debe traer Retry-After en segundos');
  });
});
