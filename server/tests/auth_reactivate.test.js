import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, makeRegistroPayload, firstTipoEvento, PLANTA_ID, TEST_TAG } from './helpers.js';

let ctx;
const PERIODO = 23;
const today = new Date().toISOString().slice(0, 10);

async function cleanAutorizacionSlot() {
  const db = await getDB();
  await db.request()
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('fecha', sql.Date, new Date(today))
    .input('periodo', sql.TinyInt, PERIODO)
    .query(`
      DELETE FROM bitacora.autorizacion_dashboard
      WHERE planta_id = @planta_id AND fecha = @fecha AND periodo = @periodo
    `);
}

before(async () => {
  ctx = await setupSessions();
  await cleanAutorizacionSlot();
});

after(async () => {
  await cleanupTestRegistros();
  await cleanAutorizacionSlot();
});

async function postAuth({ valor }) {
  const tipo_evento_id = await firstTipoEvento(ctx.bitByCodigo.AUTH);
  return call('POST', '/api/registros', {
    sesion_id: ctx.sesiones.jdt,
    body: {
      ...makeRegistroPayload({ bitacora_id: ctx.bitByCodigo.AUTH, tipo_evento_id }),
      campos_extra: { periodo: PERIODO, valor_autorizado_mw: valor },
    },
  });
}

test('AUTH primer POST crea autorizacion', async () => {
  const { status, data } = await postAuth({ valor: 100 });
  assert.equal(status, 201, JSON.stringify(data));
  const db = await getDB();
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('fecha', sql.Date, new Date(today))
    .input('periodo', sql.TinyInt, PERIODO)
    .query(`SELECT autorizacion_id, valor_autorizado_mw, activa FROM bitacora.autorizacion_dashboard WHERE planta_id=@planta_id AND fecha=@fecha AND periodo=@periodo`);
  assert.equal(r.recordset.length, 1);
  assert.equal(r.recordset[0].activa, true);
  assert.equal(Number(r.recordset[0].valor_autorizado_mw), 100);
  ctx._authId = r.recordset[0].autorizacion_id;
});

test('AUTH duplicado con autorizacion activa devuelve 409', async () => {
  const { status, data } = await postAuth({ valor: 120 });
  assert.equal(status, 409);
  assert.match(data.error || '', /autorización vigente/i);
});

test('DELETE /api/autorizaciones/:id desactiva la fila', async () => {
  const { status } = await call('DELETE', `/api/autorizaciones/${ctx._authId}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200);
  const db = await getDB();
  const r = await db.request()
    .input('id', sql.Int, ctx._authId)
    .query(`SELECT activa FROM bitacora.autorizacion_dashboard WHERE autorizacion_id=@id`);
  assert.equal(r.recordset[0].activa, false);
});

test('AUTH reactiva la fila existente con nuevo valor', async () => {
  const { status, data } = await postAuth({ valor: 120 });
  assert.equal(status, 201, JSON.stringify(data));
  const db = await getDB();
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('fecha', sql.Date, new Date(today))
    .input('periodo', sql.TinyInt, PERIODO)
    .query(`SELECT autorizacion_id, valor_autorizado_mw, activa FROM bitacora.autorizacion_dashboard WHERE planta_id=@planta_id AND fecha=@fecha AND periodo=@periodo`);
  assert.equal(r.recordset.length, 1);
  assert.equal(r.recordset[0].autorizacion_id, ctx._authId);
  assert.equal(r.recordset[0].activa, true);
  assert.equal(Number(r.recordset[0].valor_autorizado_mw), 120);
});

test('GET /api/autorizaciones muestra solo la fila activa con valor actualizado', async () => {
  const { status, data } = await call('GET', `/api/autorizaciones?planta_id=${PLANTA_ID}&fecha=${today}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200);
  const ours = (data.autorizaciones || []).filter(a => a.periodo === PERIODO);
  assert.equal(ours.length, 1);
  assert.equal(Number(ours[0].valor_autorizado_mw), 120);
  // silence unused variable lint
  assert.ok(TEST_TAG);
});
