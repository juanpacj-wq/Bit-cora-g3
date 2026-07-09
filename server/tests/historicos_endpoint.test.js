// D-050: GET /api/historicos — filtro creado_por (LIKE escapado), derivado `participantes`
// (ingenieros − jdts/jefes) y campos_extra aún expuesto (la columna se quitó SOLO de la UI).
// Requiere el server corriendo en localhost:3002 con AUTH_TEST_BYPASS=1 (patrón auth_middleware).
// Aislamiento D-030: filas SOLO en TEST_PLANTA, con registro_id NEGATIVO (la PK real viene de una
// IDENTITY positiva → cero colisión) y detalle tagueado para que cleanupTestRegistros las borre.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import {
  setupSessions, cleanupTestRegistros, call, firstTipoEvento, TEST_PLANTA, TEST_TAG,
} from './helpers.js';

let ctx;
let bitId;
let tipoEventoId;

const RID_PARTICIPANTES = -905001;
const RID_JDT = -905002;
const RID_QUIM = -905003;

const snap = (...usuarios) =>
  JSON.stringify(usuarios.map((u) => ({ usuario_id: u.usuario_id, nombre_completo: u.nombre_completo })));

async function seedHistorico({ registro_id, creado_por, ingenieros, jdts, jefes, campos_extra = null }) {
  const db = await getDB();
  await db.request()
    .input('rid', sql.Int, registro_id)
    .input('bid', sql.Int, bitId)
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('te', sql.Int, tipoEventoId)
    .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} historico endpoint`)
    .input('campos', sql.NVarChar(sql.MAX), campos_extra)
    .input('ing', sql.NVarChar(sql.MAX), ingenieros)
    .input('jdts', sql.NVarChar(sql.MAX), jdts)
    .input('jefes', sql.NVarChar(sql.MAX), jefes)
    .input('creado_por', sql.Int, creado_por)
    .query(`
      INSERT INTO bitacora.registro_historico
        (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
         cerrado_por, cerrado_en, fecha_cierre_operativo)
      VALUES (@rid, @bid, @p, SYSUTCDATETIME(), 1, @detalle, @campos, @te,
              'cerrado', @ing, @jdts, @jefes, @creado_por, SYSUTCDATETIME(),
              @creado_por, SYSUTCDATETIME(), CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE))
    `);
}

// Residuo de corridas anteriores abortadas: el tag es por-run (timestamp), así que se barre
// además por (TEST_PLANTA + id negativo) — rango imposible para datos reales.
async function cleanSeeds() {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`DELETE FROM bitacora.registro_historico WHERE planta_id = @p AND registro_id < 0`);
}

// Filtros base que acotan TODA búsqueda a las filas de esta corrida.
const base = `planta_id=${TEST_PLANTA}&busqueda=${encodeURIComponent(TEST_TAG)}`;

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  await cleanSeeds();
  bitId = ctx.bitByCodigo.CALDERA;
  tipoEventoId = await firstTipoEvento(bitId);

  const { jdt, ingOp, gerente, ingQuim } = ctx.usuarios;
  // El snapshot de ingenieros trae de todo (así se capturaba): un JdT, un jefe y dos "de a pie".
  await seedHistorico({
    registro_id: RID_PARTICIPANTES,
    creado_por: ingOp.usuario_id,
    ingenieros: snap(jdt, ingOp, ingQuim, gerente),
    jdts: snap(jdt),
    jefes: snap(gerente),
    campos_extra: JSON.stringify({ periodo: 5, valor_mw: 120 }),
  });
  await seedHistorico({
    registro_id: RID_JDT,
    creado_por: jdt.usuario_id,
    ingenieros: '[]',
    jdts: snap(jdt),
    jefes: snap(gerente),
  });
  await seedHistorico({
    registro_id: RID_QUIM,
    creado_por: ingQuim.usuario_id,
    ingenieros: snap(ingQuim),
    jdts: '[]',
    jefes: '[]',
  });
});

after(async () => {
  await cleanSeeds();
  await cleanupTestRegistros();
});

test('GET /api/historicos sin sesión devuelve 401', async () => {
  const { status } = await call('GET', `/api/historicos?${base}`);
  assert.equal(status, 401);
});

test('las filas salen con participantes derivado y snapshots crudos intactos', async () => {
  const { status, data } = await call('GET', `/api/historicos?${base}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.total, 3);
  for (const row of data.data) {
    assert.ok(Array.isArray(row.participantes), 'participantes debe ser array');
    assert.ok('ingenieros_snapshot' in row && 'jdts_snapshot' in row && 'jefes_snapshot' in row);
  }
});

test('participantes excluye a quienes aparecen en jdts/jefes', async () => {
  const { data } = await call('GET', `/api/historicos?${base}`, { sesion_id: ctx.sesiones.jdt });
  const row = data.data.find((r) => r.registro_id === RID_PARTICIPANTES);
  assert.ok(row, 'debe estar la fila sembrada');
  const ids = row.participantes.map((u) => u.usuario_id).sort();
  const esperados = [ctx.usuarios.ingOp.usuario_id, ctx.usuarios.ingQuim.usuario_id].sort();
  assert.deepEqual(ids, esperados, 'solo IngOp e IngQuim (JdT y jefe tienen columna propia)');
});

test('campos_extra sigue expuesto en la API (se quitó SOLO de la UI)', async () => {
  const { data } = await call('GET', `/api/historicos?${base}`, { sesion_id: ctx.sesiones.jdt });
  const row = data.data.find((r) => r.registro_id === RID_PARTICIPANTES);
  assert.ok(row.campos_extra, 'campos_extra debe seguir en la respuesta');
  assert.equal(JSON.parse(row.campos_extra).periodo, 5);
});

test('filtro creado_por matchea por nombre parcial', async () => {
  const { data } = await call('GET', `/api/historicos?${base}&creado_por=${encodeURIComponent('Ing Op')}`,
    { sesion_id: ctx.sesiones.jdt });
  assert.equal(data.total, 1);
  assert.equal(data.data[0].registro_id, RID_PARTICIPANTES);
  assert.equal(data.data[0].creado_por_nombre, 'Test Ing Op');
});

test('wildcards LIKE del usuario matchean literal (no como comodín)', async () => {
  // Sin escape, '%' matchearía las 3 filas y 'Ing_Op' matchearía 'Ing Op' (el _ es comodín).
  const pct = await call('GET', `/api/historicos?${base}&creado_por=${encodeURIComponent('%')}`,
    { sesion_id: ctx.sesiones.jdt });
  assert.equal(pct.data.total, 0, "'%' literal no existe en ningún nombre");
  const under = await call('GET', `/api/historicos?${base}&creado_por=${encodeURIComponent('Ing_Op')}`,
    { sesion_id: ctx.sesiones.jdt });
  assert.equal(under.data.total, 0, "'_' debe ser literal, no comodín de un carácter");
});

test('input desmedido en creado_por (1000 chars) → 200 con 0 resultados, nunca 500', async () => {
  // Blindaje pre-redespliegue: sin el cap de longitud, el input escapado desborda el NVarChar(400)
  // del parámetro y el driver revienta en 500. Con el cap, degrada a una búsqueda sin matches.
  const gigante = 'x'.repeat(1000);
  const { status, data } = await call('GET', `/api/historicos?${base}&creado_por=${encodeURIComponent(gigante)}`,
    { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.total, 0);
});

test('GET /api/historicos/:id incluye participantes', async () => {
  const { status, data } = await call('GET', `/api/historicos/${RID_PARTICIPANTES}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(Array.isArray(data.registro.participantes));
  assert.equal(data.registro.participantes.length, 2);
});
