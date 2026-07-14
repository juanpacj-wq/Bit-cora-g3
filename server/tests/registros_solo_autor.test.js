// D-049 — write-gate "solo el autor" en bitácoras genéricas: PUT/DELETE /api/registros/:id exigen
// autoría (creado_por) + puede_crear vigente + misma planta. Se ELIMINÓ el bypass histórico de
// puede_cerrar_turno con el que JdT/IngOp editaban/borraban registros ajenos en bitácoras donde solo
// tienen puede_ver (el caso del hallazgo: JdT borrando el registro de un operador en su bitácora).
// También cubre el espejo advisory `puede_editar` del GET /activos (lo que pinta la grilla).
// Corre contra la BD productiva → SOLO TEST_PLANTA ('TST', D-030) y usuarios test_* (es_sintetico=1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import {
  setupSessions, call, TEST_PLANTA, TEST_TAG, firstTipoEvento, deactivateSyntheticSessions,
} from './helpers.js';
import { periodoFromFechaBogota, turnoFromPeriodo } from '../utils/turno.js';

const turnoAhora = () => turnoFromPeriodo(periodoFromFechaBogota(new Date()));

let ctx, BIT_SALAING, TIPO_SALAING, BIT_QUIM, TIPO_QUIM;

// Igual que registros_turno_id: limpiar registros de los usuarios test en TST y desmontar las
// cabeceras turno_unidad que el POST genérico abre en el borde (abrirTurnoSiFalta) — rompiendo
// primero las FKs turno_id para no violar integridad.
async function limpiar() {
  const db = await getDB();
  const inUids = Object.values(ctx.usuarios).map((u) => u.usuario_id).join(',');
  await db.request().query(
    `DELETE FROM bitacora.registro_activo WHERE creado_por IN (${inUids}) AND planta_id='${TEST_PLANTA}'`);
  await db.request().input('p', sql.VarChar(10), TEST_PLANTA).query(`
    UPDATE ra SET turno_id=NULL FROM bitacora.registro_activo ra
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=ra.turno_id WHERE tu.planta_id=@p;
    UPDATE sa SET turno_id=NULL FROM bitacora.sesion_activa sa
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=sa.turno_id WHERE tu.planta_id=@p;
    DELETE tp FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=tp.turno_id WHERE tu.planta_id=@p;
    DELETE FROM bitacora.turno_unidad WHERE planta_id=@p;
  `);
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  // SALAING: bitácora genérica donde el IngOp (su dueño) y el ADMIN tienen AMBOS puede_crear → prueba
  // que ni siquiera un cargo con permiso de creación puede tocar lo ajeno.
  //
  // Por qué el ADMIN y no el JdT (D-053): hasta D-053 el fixture era SALA, la ÚNICA bitácora del
  // catálogo donde dos cargos operativos compartían puede_crear (JdT + IngOp). El split le dio a cada
  // rol la suya, así que ese fixture DEJÓ DE EXISTIR: con el JdT, el test pasaría por la rama "sin
  // permiso" y colapsaría en un duplicado del test 3 — verde, pero sin probar lo que dice probar.
  // El ADMIN es hoy el único cargo con puede_crear en TODAS las bitácoras (D-039), así que restituye
  // el caso y además fija la afirmación más fuerte de D-049: NADIE tiene excepción, tampoco el admin.
  // NO cambies el ADMIN por un cargo sin puede_crear en esta bitácora: reintroducirías el falso verde.
  //
  // QUIM: solo IngQuímico crea; JdT solo la ve → reproduce EXACTO el hallazgo original de D-049
  // (JdT editando/borrando en la bitácora de un operador).
  BIT_SALAING = ctx.bitByCodigo.SALAING;
  BIT_QUIM = ctx.bitByCodigo.QUIM;
  assert.ok(BIT_SALAING && BIT_QUIM, 'bitácoras SALAING y QUIM deben existir');
  TIPO_SALAING = await firstTipoEvento(BIT_SALAING);
  TIPO_QUIM = await firstTipoEvento(BIT_QUIM);
  await limpiar();
});

after(async () => {
  await limpiar();
  await deactivateSyntheticSessions();
});

async function crearRegistro(sesion_id, bitacora_id, tipo_evento_id) {
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id,
    body: {
      bitacora_id, planta_id: TEST_PLANTA, fecha_evento: new Date().toISOString(),
      turno: turnoAhora(), detalle: `${TEST_TAG} solo-autor`, tipo_evento_id,
    },
  });
  assert.equal(status, 201, JSON.stringify(data));
  return data.registro.registro_id;
}

async function detalleActual(registro_id) {
  const db = await getDB();
  const r = await db.request().input('id', sql.Int, registro_id)
    .query(`SELECT detalle FROM bitacora.registro_activo WHERE registro_id=@id`);
  return r.recordset[0]?.detalle ?? null;
}

test('1. El autor edita y elimina su propio borrador (IngOp en SALAING) → 200', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.ingOp,
    body: { detalle: `${TEST_TAG} solo-autor editado por su autor` },
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.ingOp });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(await detalleActual(id), null, 'el registro debe haberse borrado');
});

test('2. No-autor CON puede_crear en la misma bitácora (ADMIN sobre registro de IngOp en SALAING) → 403 solo_autor', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  // Precondición del fixture: si el ADMIN NO tuviera puede_crear acá, este test se degradaría a un
  // duplicado del test 3 sin ponerse rojo. Se asserta explícitamente para que el falso verde sea
  // imposible: el 403 de abajo tiene que venir de la autoría, no de la falta de permiso.
  const db = await getDB();
  const perm = await db.request()
    .input('b', sql.Int, BIT_SALAING)
    .query(`
      SELECT p.puede_crear FROM lov_bit.cargo_bitacora_permiso p
      JOIN lov_bit.cargo c ON c.cargo_id = p.cargo_id
      WHERE c.nombre = 'Administrador y Debugging' AND p.bitacora_id = @b
    `);
  assert.equal(perm.recordset[0]?.puede_crear, true,
    'PRECONDICIÓN: el ADMIN debe tener puede_crear en SALAING, si no este test no prueba nada');

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.admin,
    body: { detalle: `${TEST_TAG} intento ilegítimo` },
  });
  assert.equal(put.status, 403, `PUT esperaba 403, fue ${put.status} ${JSON.stringify(put.data)}`);
  assert.equal(put.data.codigo, 'solo_autor');

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.admin });
  assert.equal(del.status, 403, `DELETE esperaba 403, fue ${del.status} ${JSON.stringify(del.data)}`);
  assert.equal(del.data.codigo, 'solo_autor');

  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor`, 'el registro ajeno queda intacto');
});

test('3. Regresión del bypass puede_cerrar_turno: JdT con SOLO puede_ver (QUIM, registro del IngQuímico) → 403', async () => {
  const id = await crearRegistro(ctx.sesiones.ingQuim, BIT_QUIM, TIPO_QUIM);

  for (const sesionKey of ['jdt', 'ingOp']) {
    const put = await call('PUT', `/api/registros/${id}`, {
      sesion_id: ctx.sesiones[sesionKey],
      body: { detalle: `${TEST_TAG} bypass viejo` },
    });
    assert.equal(put.status, 403, `${sesionKey} PUT esperaba 403, fue ${put.status} ${JSON.stringify(put.data)}`);
    assert.equal(put.data.codigo, 'solo_autor');

    const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones[sesionKey] });
    assert.equal(del.status, 403, `${sesionKey} DELETE esperaba 403, fue ${del.status} ${JSON.stringify(del.data)}`);
    assert.equal(del.data.codigo, 'solo_autor');
  }
  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor`, 'el registro del operador queda intacto');
});

test('4. Cargo sin puede_crear ni cierre (Gerente) sobre registro ajeno → 403', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.gerente,
    body: { detalle: `${TEST_TAG} gerente` },
  });
  assert.equal(put.status, 403, JSON.stringify(put.data));

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.gerente });
  assert.equal(del.status, 403, JSON.stringify(del.data));
});

test('5. GET /activos espeja la política por fila (`puede_editar`): true para el autor, false para el resto', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  const comoAutor = await call('GET',
    `/api/registros/activos?planta_id=${TEST_PLANTA}&bitacora_id=${BIT_SALAING}`,
    { sesion_id: ctx.sesiones.ingOp });
  assert.equal(comoAutor.status, 200, JSON.stringify(comoAutor.data));
  const filaAutor = comoAutor.data.registros.find((r) => r.registro_id === id);
  assert.ok(filaAutor, 'el autor ve su registro');
  assert.equal(filaAutor.puede_editar, true, 'autor → puede_editar=true');

  const comoJdt = await call('GET',
    `/api/registros/activos?planta_id=${TEST_PLANTA}&bitacora_id=${BIT_SALAING}`,
    { sesion_id: ctx.sesiones.jdt });
  assert.equal(comoJdt.status, 200, JSON.stringify(comoJdt.data));
  const filaJdt = comoJdt.data.registros.find((r) => r.registro_id === id);
  assert.ok(filaJdt, 'el JdT sigue VIENDO el registro (puede_ver intacto)');
  assert.equal(filaJdt.puede_editar, false, 'no-autor → puede_editar=false');
});
