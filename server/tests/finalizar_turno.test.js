// D-040: finalización de turno REVERTIBLE por sesion_activa.turno_finalizado_en (fuente única) +
// fix del bug de reaparición (/abrir des-finalizaba) + write-gate 409 SOLO en bitácoras genéricas.
// D-030: corre contra la BD productiva → opera SOLO sobre TEST_PLANTA y usuarios test_*. El cleanup
// borra registros (genéricos + CIET) de esos usuarios en la planta de test; nunca toca GEC3/GEC32.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, TEST_PLANTA, TEST_TAG } from './helpers.js';
import { periodoFromFechaBogota, turnoFromPeriodo, ventanaActual } from '../utils/turno.js';

let ctx;
let BIT_GEN, TIPO_GEN, GEN_SESION, GEN_UID;
let DISP_BID;

const CARGO_TO_KEY = {
  'Ingeniero Jefe de Turno': 'jdt',
  'Ingeniero de Operación': 'ingOp',
  'Gerente de Producción': 'gerente',
  'Ingeniero Químico': 'ingQuim',
};

const turnoAhora = () => turnoFromPeriodo(periodoFromFechaBogota(new Date()));

// Registro genérico válido: la bitácora elegida tiene definicion_campos NULL → solo detalle.
function genBody(tag = TEST_TAG) {
  return {
    bitacora_id: BIT_GEN,
    planta_id: TEST_PLANTA,
    fecha_evento: new Date().toISOString(),
    turno: turnoAhora(),
    detalle: `${tag} finalizar-turno`,
    tipo_evento_id: TIPO_GEN,
  };
}

async function setFinalizado(uid, val) {
  const db = await getDB();
  await db.request()
    .input('u', sql.Int, uid)
    .input('v', sql.DateTime2, val ? new Date() : null)
    .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en=@v WHERE usuario_id=@u AND activa=1`);
}

// D-040 persistencia por ventana: setea turno_finalizado_en a un instante ARBITRARIO (para simular
// una finalización de un turno pasado / stale).
async function setFinalizadoAt(uid, date) {
  const db = await getDB();
  await db.request()
    .input('u', sql.Int, uid)
    .input('v', sql.DateTime2, date)
    .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en=@v WHERE usuario_id=@u AND activa=1`);
}

async function colFinalizado(uid) {
  const db = await getDB();
  const r = await db.request().input('u', sql.Int, uid)
    .query(`SELECT turno_finalizado_en FROM bitacora.sesion_activa WHERE usuario_id=@u AND activa=1`);
  return r.recordset[0]?.turno_finalizado_en ?? null;
}

// Baseline (max registro_id) y conteo de CIETs de un tipo emitidos por un usuario después de ese id.
// El CIET no lleva TEST_TAG en detalle, así que contamos por (tipo, creado_por, registro_id > baseline).
async function cietMaxId(uid, tipoNombre) {
  const db = await getDB();
  const r = await db.request().input('u', sql.Int, uid).input('t', sql.VarChar(100), tipoNombre)
    .query(`
      SELECT ISNULL(MAX(ra.registro_id),0) AS maxId
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id=ra.tipo_evento_id
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id=ra.bitacora_id
      WHERE b.codigo='CIET' AND te.nombre=@t AND ra.creado_por=@u`);
  return r.recordset[0].maxId;
}
async function cietCountSince(uid, tipoNombre, sinceId) {
  const db = await getDB();
  const r = await db.request()
    .input('u', sql.Int, uid).input('t', sql.VarChar(100), tipoNombre).input('s', sql.Int, sinceId)
    .query(`
      SELECT COUNT(*) AS n
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id=ra.tipo_evento_id
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id=ra.bitacora_id
      WHERE b.codigo='CIET' AND te.nombre=@t AND ra.creado_por=@u AND ra.registro_id>@s`);
  return r.recordset[0].n;
}

async function limpiar() {
  const db = await getDB();
  const inUids = Object.values(ctx.usuarios).map((u) => u.usuario_id).join(',');
  // El test 2 llama POST /api/bitacora/abrir → inserta en sesion_bitacora. Hay que borrar esas
  // filas o su FK (sesion_bitacora.sesion_id → sesion_activa) bloquea el DELETE de sesion_activa
  // que hacen OTROS tests (p.ej. conformacion_turno purga sesiones test viejas) → suite roja.
  await db.request().query(
    `DELETE FROM bitacora.sesion_bitacora WHERE sesion_id IN
       (SELECT sesion_id FROM bitacora.sesion_activa WHERE usuario_id IN (${inUids}))`);
  // Registros genéricos + CIET creados por usuarios de test EN la planta de test.
  await db.request().query(
    `DELETE FROM bitacora.registro_activo WHERE creado_por IN (${inUids}) AND planta_id='${TEST_PLANTA}'`);
  await db.request().input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE planta_id=@p`);
  await db.request().query(
    `UPDATE bitacora.sesion_activa SET turno_finalizado_en=NULL WHERE usuario_id IN (${inUids})`);
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  DISP_BID = ctx.bitByCodigo.DISP;
  assert.ok(DISP_BID, 'DISP bitacora_id debe existir');

  // Bitácora genérica (no MAND/DISP/COMB) creable por algún cargo de test, con un tipo_evento.
  const db = await getDB();
  const cargos = Object.keys(CARGO_TO_KEY).map((n) => `'${n}'`).join(',');
  const r = await db.request().query(`
    SELECT TOP 1 c.nombre AS cargo, b.bitacora_id, te.tipo_evento_id
    FROM lov_bit.cargo c
    JOIN lov_bit.cargo_bitacora_permiso p ON p.cargo_id=c.cargo_id AND p.puede_crear=1
    JOIN lov_bit.bitacora b ON b.bitacora_id=p.bitacora_id
      AND b.activa=1 AND b.codigo NOT IN ('MAND','DISP','COMB')
    JOIN lov_bit.tipo_evento te ON te.bitacora_id=b.bitacora_id
    WHERE c.nombre IN (${cargos})
    ORDER BY c.nombre, b.bitacora_id, te.tipo_evento_id`);
  assert.ok(r.recordset.length > 0, 'debe existir bitácora genérica creable por un cargo de test');
  BIT_GEN = r.recordset[0].bitacora_id;
  TIPO_GEN = r.recordset[0].tipo_evento_id;
  const key = CARGO_TO_KEY[r.recordset[0].cargo];
  GEN_SESION = ctx.sesiones[key];
  GEN_UID = ctx.usuarios[key].usuario_id;

  await limpiar();
});

after(async () => {
  await limpiar();
  await cleanupTestRegistros();
});

test('1. finalizar marca turno_finalizado_en y emite 1 CIET Finalización de turno', async () => {
  await setFinalizado(GEN_UID, false);
  const base = await cietMaxId(GEN_UID, 'Finalización de turno');
  const { status, data } = await call('POST', '/api/bitacora/finalizar', { sesion_id: GEN_SESION });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.turno_finalizado_en != null, 'respuesta debe traer turno_finalizado_en no-nulo');
  assert.ok((await colFinalizado(GEN_UID)) != null, 'la columna debe quedar no-nula');
  assert.equal(await cietCountSince(GEN_UID, 'Finalización de turno', base), 1);
});

test('2. REGRESIÓN: tras finalizar, /abrir NO des-finaliza ni reaparece en preview-masivo', async () => {
  await setFinalizado(GEN_UID, true);
  // Dos /abrir sobre la MISMA bitácora: el 2º entra por WHEN MATCHED (el path que reseteaba
  // finalizada_en en el bug original). Con D-040 la finalización vive en otra columna → intacta.
  const a1 = await call('POST', '/api/bitacora/abrir', { sesion_id: GEN_SESION, body: { bitacora_id: BIT_GEN } });
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  const a2 = await call('POST', '/api/bitacora/abrir', { sesion_id: GEN_SESION, body: { bitacora_id: BIT_GEN } });
  assert.equal(a2.status, 200, JSON.stringify(a2.data));
  assert.ok((await colFinalizado(GEN_UID)) != null, 'ver bitácoras NO debe des-finalizar el turno');

  const { status, data } = await call(
    'GET', `/api/cierre/preview-masivo?planta_id=${TEST_PLANTA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  const ids = (data.ingenieros_no_finalizados || []).map((i) => i.usuario_id);
  assert.ok(!ids.includes(GEN_UID), `el usuario finalizado NO debe reaparecer como pendiente: ${JSON.stringify(ids)}`);
});

test('3. revertir limpia la columna y emite 1 CIET Reapertura de turno', async () => {
  await setFinalizado(GEN_UID, true);
  const base = await cietMaxId(GEN_UID, 'Reapertura de turno');
  const { status, data } = await call('POST', '/api/bitacora/revertir-turno', { sesion_id: GEN_SESION });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.turno_finalizado_en, null);
  assert.equal(await colFinalizado(GEN_UID), null);
  assert.equal(await cietCountSince(GEN_UID, 'Reapertura de turno', base), 1);
});

test('4a. finalizado: POST a bitácora genérica → 409 turno_finalizado', async () => {
  await setFinalizado(GEN_UID, true);
  const { status, data } = await call('POST', '/api/registros', { sesion_id: GEN_SESION, body: genBody() });
  assert.equal(status, 409, JSON.stringify(data));
  assert.equal(data.codigo, 'turno_finalizado', JSON.stringify(data));
});

test('4a2. finalizado: PUT a registro genérico → 409 turno_finalizado', async () => {
  // Se crea el registro con el turno VIVO (POST 201), luego se finaliza y se intenta editar.
  await setFinalizado(GEN_UID, false);
  const creado = await call('POST', '/api/registros', { sesion_id: GEN_SESION, body: genBody() });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const rid = creado.data.registro.registro_id;
  await setFinalizado(GEN_UID, true);
  const { status, data } = await call('PUT', `/api/registros/${rid}`, {
    sesion_id: GEN_SESION, body: { detalle: `${TEST_TAG} editado-finalizado` },
  });
  assert.equal(status, 409, JSON.stringify(data));
  assert.equal(data.codigo, 'turno_finalizado', JSON.stringify(data));
  // limpieza: revertir y borrar el registro creado.
  await setFinalizado(GEN_UID, false);
  await call('DELETE', `/api/registros/${rid}`, { sesion_id: GEN_SESION });
});

test('4a3. finalizado: DELETE a registro genérico → 409 turno_finalizado', async () => {
  await setFinalizado(GEN_UID, false);
  const creado = await call('POST', '/api/registros', { sesion_id: GEN_SESION, body: genBody() });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const rid = creado.data.registro.registro_id;
  await setFinalizado(GEN_UID, true);
  const { status, data } = await call('DELETE', `/api/registros/${rid}`, { sesion_id: GEN_SESION });
  assert.equal(status, 409, JSON.stringify(data));
  assert.equal(data.codigo, 'turno_finalizado', JSON.stringify(data));
  // limpieza: revertir y borrar (ahora sí) el registro creado.
  await setFinalizado(GEN_UID, false);
  await call('DELETE', `/api/registros/${rid}`, { sesion_id: GEN_SESION });
});

test('4b. finalizado: DISP sigue operable (201)', async () => {
  await setFinalizado(ctx.usuarios.jdt.usuario_id, true);
  const fecha = new Date(Date.now() - 3600 * 1000);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: ctx.sesiones.jdt,
    body: {
      bitacora_id: DISP_BID, planta_id: TEST_PLANTA, fecha_evento: fecha.toISOString(),
      campos_extra: { evento: 'En Servicio', fecha_inicio_estado: fecha.toISOString() },
      detalle: `${TEST_TAG} disp-gate`,
    },
  });
  assert.equal(status, 201, JSON.stringify(data));
});

test('4c. finalizado: COMB (/api/combustibles/consumos) NO está gateado por turno_finalizado', async () => {
  await setFinalizado(GEN_UID, true);
  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: GEN_SESION, body: { planta_id: TEST_PLANTA, fecha: '2026-07-03', consumos: [] },
  });
  assert.notEqual(status, 404, 'el endpoint COMB debe existir');
  assert.notEqual(data.codigo, 'turno_finalizado', JSON.stringify(data));
});

test('4d. finalizado: MAND (/api/sala-de-mando/guardar) NO está gateado por turno_finalizado', async () => {
  await setFinalizado(GEN_UID, true);
  const { status, data } = await call('POST', '/api/sala-de-mando/guardar', {
    sesion_id: GEN_SESION, body: { planta_id: TEST_PLANTA, registros: [] },
  });
  assert.notEqual(status, 404, 'el endpoint MAND debe existir');
  assert.notEqual(data.codigo, 'turno_finalizado', JSON.stringify(data));
});

test('4e. tras revertir, POST a la genérica vuelve a funcionar (201)', async () => {
  await setFinalizado(GEN_UID, false);
  const { status, data } = await call('POST', '/api/registros', { sesion_id: GEN_SESION, body: genBody() });
  assert.notEqual(data.codigo, 'turno_finalizado', JSON.stringify(data));
  assert.equal(status, 201, JSON.stringify(data));
});

test('4f. persistencia por ventana: una finalización de un turno PASADO NO bloquea (201)', async () => {
  // Finalización stale (hace 2 días) → ya expiró: el write-gate la ignora (loadSession la sirve como
  // null y turnoFinalizado es window-aware). Prueba end-to-end de "expira al arrancar el próximo turno".
  await setFinalizadoAt(GEN_UID, new Date(Date.now() - 2 * 24 * 3600 * 1000));
  const { status, data } = await call('POST', '/api/registros', { sesion_id: GEN_SESION, body: genBody() });
  assert.equal(status, 201, JSON.stringify(data));
  assert.notEqual(data.codigo, 'turno_finalizado', JSON.stringify(data));
  await setFinalizado(GEN_UID, false);
});

test('7. reactivación (simula select-context): finalización VIGENTE se preserva, STALE se limpia', async () => {
  // select-context lee la cookie Entra (no alcanzable por el backdoor X-Sesion-Id), así que aquí se
  // ejecuta el MISMO CASE acotado a la ventana que aplica server/routes/sesion.js al reactivar la
  // sesión (branch WHEN MATCHED). Guarda la invariante de "no reabrir dentro del mismo turno".
  const db = await getDB();
  const { inicio, fin } = ventanaActual();
  const reactivar = async () => {
    await db.request()
      .input('u', sql.Int, GEN_UID)
      .input('ini', sql.DateTime2, inicio)
      .input('fin', sql.DateTime2, fin)
      .query(`
        UPDATE bitacora.sesion_activa
           SET turno_finalizado_en = CASE
                 WHEN turno_finalizado_en >= @ini AND turno_finalizado_en < @fin
                 THEN turno_finalizado_en ELSE NULL END
         WHERE usuario_id=@u AND activa=1`);
  };
  // VIGENTE (ahora) → sobrevive la reactivación (re-login / volver a la unidad en el mismo turno).
  await setFinalizado(GEN_UID, true);
  await reactivar();
  assert.ok((await colFinalizado(GEN_UID)) != null, 'una finalización vigente debe sobrevivir la reactivación');
  // STALE (turno pasado) → se limpia (empezó el siguiente turno).
  await setFinalizadoAt(GEN_UID, new Date(Date.now() - 2 * 24 * 3600 * 1000));
  await reactivar();
  assert.equal(await colFinalizado(GEN_UID), null, 'una finalización de un turno pasado debe limpiarse en la reactivación');
  await setFinalizado(GEN_UID, false);
});

test('5. finalizar-forzado marca turno_finalizado_en del objetivo', async () => {
  const target = ctx.usuarios.ingQuim.usuario_id;
  await setFinalizado(target, false);
  const { status, data } = await call('POST', '/api/bitacora/finalizar-forzado', {
    sesion_id: ctx.sesiones.jdt, body: { usuarios: [target] },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok((await colFinalizado(target)) != null, 'el objetivo debe quedar finalizado');
});

test('6a. idempotencia: doble finalizar no duplica CIET', async () => {
  await setFinalizado(GEN_UID, false);
  const base = await cietMaxId(GEN_UID, 'Finalización de turno');
  await call('POST', '/api/bitacora/finalizar', { sesion_id: GEN_SESION });
  await call('POST', '/api/bitacora/finalizar', { sesion_id: GEN_SESION });
  assert.equal(await cietCountSince(GEN_UID, 'Finalización de turno', base), 1);
});

test('6b. idempotencia: doble revertir no duplica CIET', async () => {
  await setFinalizado(GEN_UID, true);
  const base = await cietMaxId(GEN_UID, 'Reapertura de turno');
  await call('POST', '/api/bitacora/revertir-turno', { sesion_id: GEN_SESION });
  await call('POST', '/api/bitacora/revertir-turno', { sesion_id: GEN_SESION });
  assert.equal(await cietCountSince(GEN_UID, 'Reapertura de turno', base), 1);
});
