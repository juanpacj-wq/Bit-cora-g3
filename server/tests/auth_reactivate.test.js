import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { periodoFromFechaBogota } from '../utils/turno.js';
import { setupSessions, cleanupTestRegistros, call, makeRegistroPayload, firstTipoEvento, PLANTA_ID, TEST_TAG } from './helpers.js';

// D4 (resuelto 2026-05-13): post F18 los endpoints /api/autorizaciones* quedaron deprecados.
// El sistema escribe en bitacora.evento_dashboard tipo='AUTH' como side-effect del batch
// save de MAND (POST /api/sala-de-mando/guardar) — la bitácora AUTH legacy quedó activa=0.
// Este test cubre los endpoints canónicos GET /api/eventos-dashboard?tipo=AUTH y
// DELETE /api/eventos-dashboard/:id como caja negra: setup INSERTa directamente en BD una
// fila evento_dashboard tipo='AUTH' (paralela a un registro_activo MAND con TEST_TAG para
// que cleanupTestRegistros lo barra), simula DELETE vía endpoint, y simula "reactivación"
// vía UPDATE directo (porque el reactivar como POST está cubierto por sala_de_mando_batch.test.js).

let ctx;
const FECHA_EVENTO = new Date();
const PERIODO = periodoFromFechaBogota(FECHA_EVENTO);
const today = FECHA_EVENTO.toISOString().slice(0, 10);

async function cleanAuthEventoSlot() {
  const db = await getDB();
  await db.request()
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('fecha', sql.Date, new Date(today))
    .input('periodo', sql.TinyInt, PERIODO)
    .query(`
      DELETE FROM bitacora.evento_dashboard
      WHERE planta_id = @planta_id AND fecha = @fecha AND periodo = @periodo AND tipo = 'AUTH'
    `);
}

// Inserta un registro_activo MAND con TEST_TAG + evento_dashboard tipo='AUTH' apuntando a él.
// El registro_activo es el FK source de evento_dashboard.registro_origen_id (NOT NULL).
// cleanupTestRegistros (en after) limpia ambas filas usando TEST_TAG en detalle.
async function insertAuthEvento(valor) {
  const db = await getDB();
  const tipoEventoId = await firstTipoEvento(ctx.bitByCodigo.MAND);
  const payload = makeRegistroPayload({ bitacora_id: ctx.bitByCodigo.MAND, tipo_evento_id: tipoEventoId });
  const empty = '[]';
  const regRes = await db.request()
    .input('bitacora_id', sql.Int, payload.bitacora_id)
    .input('planta_id', sql.VarChar(10), payload.planta_id)
    .input('fecha_evento', sql.DateTime2, new Date(payload.fecha_evento))
    .input('turno', sql.TinyInt, payload.turno)
    .input('detalle', sql.NVarChar(sql.MAX), payload.detalle)
    .input('tipo_evento_id', sql.Int, payload.tipo_evento_id)
    .input('jdts', sql.NVarChar(sql.MAX), empty)
    .input('jefes', sql.NVarChar(sql.MAX), empty)
    .input('ings', sql.NVarChar(sql.MAX), empty)
    .input('creado_por', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, tipo_evento_id,
         jdts_snapshot, jefes_snapshot, ingenieros_snapshot, creado_por)
      OUTPUT INSERTED.registro_id
      VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @tipo_evento_id,
              @jdts, @jefes, @ings, @creado_por);
    `);
  const registro_origen_id = regRes.recordset[0].registro_id;

  const evRes = await db.request()
    .input('reg_id', sql.Int, registro_origen_id)
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('fecha', sql.Date, new Date(today))
    .input('periodo', sql.TinyInt, PERIODO)
    .input('valor', sql.Float, valor)
    .input('jdts', sql.NVarChar(sql.MAX), empty)
    .input('jefes', sql.NVarChar(sql.MAX), empty)
    .query(`
      INSERT INTO bitacora.evento_dashboard
        (registro_origen_id, planta_id, fecha, periodo, valor_mw, jdts_snapshot, jefes_snapshot, tipo, activa)
      OUTPUT INSERTED.evento_id
      VALUES (@reg_id, @planta_id, @fecha, @periodo, @valor, @jdts, @jefes, 'AUTH', 1);
    `);
  return evRes.recordset[0].evento_id;
}

before(async () => {
  ctx = await setupSessions();
  await cleanAuthEventoSlot();
});

after(async () => {
  await cleanupTestRegistros();
  await cleanAuthEventoSlot();
});

test('GET /api/eventos-dashboard?tipo=AUTH lista la fila activa', async () => {
  ctx._eventoId = await insertAuthEvento(100);
  const { status, data } = await call('GET', `/api/eventos-dashboard?planta_id=${PLANTA_ID}&fecha=${today}&tipo=AUTH`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200);
  const ours = (data.eventos || []).filter((e) => e.evento_id === ctx._eventoId);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].tipo, 'AUTH');
  assert.equal(ours[0].activa, true);
  assert.equal(Number(ours[0].valor_mw), 100);
});

test('DELETE /api/eventos-dashboard/:id desactiva la fila (activa=0)', async () => {
  const { status, data } = await call('DELETE', `/api/eventos-dashboard/${ctx._eventoId}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  const db = await getDB();
  const r = await db.request()
    .input('id', sql.Int, ctx._eventoId)
    .query(`SELECT activa FROM bitacora.evento_dashboard WHERE evento_id = @id`);
  assert.equal(r.recordset[0].activa, false);
});

test('GET /api/eventos-dashboard?tipo=AUTH NO lista una fila desactivada', async () => {
  const { status, data } = await call('GET', `/api/eventos-dashboard?planta_id=${PLANTA_ID}&fecha=${today}&tipo=AUTH`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200);
  const ours = (data.eventos || []).filter((e) => e.evento_id === ctx._eventoId);
  assert.equal(ours.length, 0);
});

test('Reactivación: UPDATE activa=1 con nuevo valor → GET la muestra de nuevo', async () => {
  const db = await getDB();
  await db.request()
    .input('id', sql.Int, ctx._eventoId)
    .input('valor', sql.Float, 120)
    .query(`UPDATE bitacora.evento_dashboard SET activa = 1, valor_mw = @valor WHERE evento_id = @id`);

  const { status, data } = await call('GET', `/api/eventos-dashboard?planta_id=${PLANTA_ID}&fecha=${today}&tipo=AUTH`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200);
  const ours = (data.eventos || []).filter((e) => e.evento_id === ctx._eventoId);
  assert.equal(ours.length, 1);
  assert.equal(Number(ours[0].valor_mw), 120);
  assert.ok(TEST_TAG);
});

test('DELETE /api/eventos-dashboard/:id con id inexistente → 404', async () => {
  const { status } = await call('DELETE', `/api/eventos-dashboard/99999999`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 404);
});

test('DELETE /api/eventos-dashboard/:id sin sesión → 401', async () => {
  const { status } = await call('DELETE', `/api/eventos-dashboard/${ctx._eventoId}`);
  assert.equal(status, 401);
});
