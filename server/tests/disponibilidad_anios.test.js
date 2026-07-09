// D-051: los años del selector de AÑO viajan en la respuesta de GET /api/disponibilidad y
// reflejan AL INSTANTE un registro retro-fechado (el endpoint /anios se retiró; su fetch
// solo-al-montar era la causa de que el selector no se actualizara sin F5).
// Aislamiento D-030: DISP solo sobre TEST_PLANTA; limpieza vía cleanDispTestPlanta().
// NOTA: `anios` es global (MIN sobre todas las plantas) — los asserts no asumen nada sobre los
// datos reales de GEC3/GEC32: comparan contra el baseline capturado antes de sembrar.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { DISP_ANIO_MIN } from '../utils/notificador.js';
import {
  setupSessions, cleanupTestRegistros, cleanDispTestPlanta, call, TEST_PLANTA, TEST_TAG,
} from './helpers.js';

let ctx;
let DISP_BITACORA_ID;
let aniosBaseline;

const ANIO_ACTUAL = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric' }).format(new Date())
);
const ANIO_RETRO = ANIO_ACTUAL - 1;

const getDisp = () =>
  call('GET', `/api/disponibilidad?planta_id=${TEST_PLANTA}`, { sesion_id: ctx.sesiones.jdt });

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  DISP_BITACORA_ID = ctx.bitByCodigo.DISP;
  assert.ok(DISP_BITACORA_ID, 'DISP bitacora_id debe existir');
  await cleanDispTestPlanta();
});

after(async () => {
  await cleanDispTestPlanta();
  await cleanupTestRegistros();
});

test('GET /api/disponibilidad incluye anios: contiguo, descendente y arranca en el año actual', async () => {
  const { status, data } = await getDisp();
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(Array.isArray(data.anios) && data.anios.length >= 1, 'anios debe ser array no vacío');
  assert.equal(data.anios[0], ANIO_ACTUAL, 'el primer año es el actual (desc)');
  for (let i = 1; i < data.anios.length; i++) {
    assert.equal(data.anios[i], data.anios[i - 1] - 1, 'rango contiguo descendente');
  }
  aniosBaseline = data.anios;
});

test('crear un registro retro-fechado extiende anios EN LA MISMA respuesta (sin F5)', async () => {
  const fechaRetro = new Date(Date.UTC(ANIO_RETRO, 5, 15, 15, 0, 0)); // 15-jun año pasado
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: ctx.sesiones.jdt,
    body: {
      bitacora_id: DISP_BITACORA_ID,
      planta_id: TEST_PLANTA,
      fecha_evento: fechaRetro.toISOString(),
      campos_extra: { evento: 'En Servicio', fecha_inicio_estado: fechaRetro.toISOString() },
      detalle: `${TEST_TAG} anios retro`,
    },
  });
  assert.equal(status, 201, JSON.stringify(data));

  // El PRIMER GET posterior ya trae el año retro — es lo que el dashboard refetchea al guardar.
  const res = await getDisp();
  assert.equal(res.status, 200);
  assert.ok(res.data.anios.includes(ANIO_RETRO), `anios debe incluir ${ANIO_RETRO} al instante`);
  assert.equal(res.data.anios[0], ANIO_ACTUAL, 'sigue arrancando en el año actual');
  for (let i = 1; i < res.data.anios.length; i++) {
    assert.equal(res.data.anios[i], res.data.anios[i - 1] - 1, 'sigue contiguo tras extender');
  }
});

test('al eliminar el registro retro, anios vuelve al baseline (rango recalculado, no cacheado)', async () => {
  await cleanDispTestPlanta();
  const { status, data } = await getDisp();
  assert.equal(status, 200);
  assert.deepEqual(data.anios, aniosBaseline, 'anios debe volver exactamente al baseline');
});

// ---- Blindaje pre-redespliegue (auditoría 2026-07-09) ----

test('write-guard: POST DISP con año < piso (1999) → 422, el dato corrupto no entra', async () => {
  const fechaBajoPiso = new Date(Date.UTC(DISP_ANIO_MIN - 1, 5, 15, 15, 0, 0));
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: ctx.sesiones.jdt,
    body: {
      bitacora_id: DISP_BITACORA_ID,
      planta_id: TEST_PLANTA,
      fecha_evento: fechaBajoPiso.toISOString(),
      campos_extra: { evento: 'En Servicio', fecha_inicio_estado: fechaBajoPiso.toISOString() },
      detalle: `${TEST_TAG} anios bajo piso`,
    },
  });
  assert.equal(status, 422, JSON.stringify(data));
  assert.match(data.error, new RegExp(String(DISP_ANIO_MIN)), 'el mensaje menciona el piso');
  // No dejó rastro: anios sigue en el baseline.
  const res = await getDisp();
  assert.deepEqual(res.data.anios, aniosBaseline);
});

test('read-clamp: una fila corrupta preexistente (año 1990) NO infla anios — piso y tamaño acotados', async () => {
  // INSERT directo a la TABLA BASE (D-041) en TEST_PLANTA, bypass deliberado del write-guard:
  // simula el dato corrupto que pudiera existir en prod ANTES de este blindaje. Fila CERRADA
  // (fecha_fin_estado NOT NULL) para no chocar con UQ_disp_estado_vigente_por_planta.
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('creado_por', sql.Int, ctx.usuarios.jdt.usuario_id)
    .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} fila corrupta 1990`)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, fecha_fin_estado, detalle, creado_por)
      VALUES (@p, 'En Servicio', 1, '1990-06-15T12:00:00', '1990-06-16T12:00:00', @detalle, @creado_por)
    `);

  const { status, data } = await getDisp();
  assert.equal(status, 200);
  assert.equal(data.anios[data.anios.length - 1], DISP_ANIO_MIN, 'el rango se clampa al piso');
  assert.ok(!data.anios.includes(1990), 'el año corrupto no aparece');
  assert.equal(data.anios[0], ANIO_ACTUAL);
  assert.equal(data.anios.length, ANIO_ACTUAL - DISP_ANIO_MIN + 1, 'tamaño acotado (~27), no ~37');

  await cleanDispTestPlanta();
  const res = await getDisp();
  assert.deepEqual(res.data.anios, aniosBaseline, 'limpiada la fila, anios vuelve al baseline');
});

test('el endpoint retirado GET /api/disponibilidad/anios ya no existe (404)', async () => {
  const { status } = await call('GET', '/api/disponibilidad/anios', { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 404);
});
