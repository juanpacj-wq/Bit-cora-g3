// D-049 — write-gate "solo el autor" en bitácoras genéricas: PUT/DELETE /api/registros/:id exigen
// autoría (creado_por) + puede_crear vigente + misma planta. Se ELIMINÓ el bypass histórico de
// puede_cerrar_turno con el que JdT/IngOp editaban/borraban registros ajenos en bitácoras donde solo
// tienen puede_ver (el caso del hallazgo: JdT borrando el registro de un operador en su bitácora).
// También cubre el espejo advisory `puede_editar` del GET /activos (lo que pinta la grilla).
// D-058 E6 (tests 6-7) suma la cara opuesta: el asiento REFLEJADO desde Operación 24h no se edita ni
// se borra en su destino NI SIQUIERA por su autor — que es el mismo del origen (RN-02.c), justo a
// quien esta política autoriza. Es una RESTRICCIÓN sobre D-049, nunca un bypass.
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

// ── D-058 E6 — el asiento REFLEJADO es de solo lectura en su destino (RQ-02.5/6) ────────────────
//
// La copia se marca acá a mano (UPDATE del `campos_extra`, acotado por PK) en vez de generarla con
// el reflejo real: 'TST' NO refleja por RN-02.e, y el reflejo de verdad ya está cubierto por E4/E5
// sobre la planta-fixture 'TSR'. Lo que estos dos tests prueban es el GATE, que lo único que mira es
// `campos_extra.origen_lote_id` — así que la marca es fixture suficiente y el test no depende de que
// MAND corra en esta planta.
//
// El caso es el que SIN el cambio pasaba: quien edita es el AUTOR, y el autor de la copia es el
// autor del origen (RN-02.c), justo a quien D-049 autoriza.
async function marcarComoReflejado(registro_id, lote_id) {
  const db = await getDB();
  const campos = JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: lote_id });
  await db.request()
    .input('id', sql.Int, registro_id)
    .input('ce', sql.NVarChar(sql.MAX), campos)
    .query(`UPDATE bitacora.registro_activo SET campos_extra = @ce WHERE registro_id = @id`);
}

test('6. D-058 E6: el AUTOR de un asiento reflejado NO puede editarlo ni borrarlo en su destino → 403 asiento_reflejado', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(id, `${TEST_TAG}-lote-e6`);

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.ingOp,
    body: { detalle: `${TEST_TAG} el autor intenta reescribir su copia` },
  });
  assert.equal(put.status, 403, `PUT esperaba 403, fue ${put.status} ${JSON.stringify(put.data)}`);
  assert.equal(put.data.codigo, 'asiento_reflejado',
    'el motivo NO puede ser solo_autor: quien pide ES el autor, y el mensaje tiene que decirle dónde corregirlo');

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.ingOp });
  assert.equal(del.status, 403, `DELETE esperaba 403, fue ${del.status} ${JSON.stringify(del.data)}`);
  assert.equal(del.data.codigo, 'asiento_reflejado');

  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor`,
    'la copia queda intacta: solo la mueve la corrección del lote de origen');
});

test('7. D-058 E6: GET /activos da puede_editar=false al asiento reflejado y true al tecleado a mano por el MISMO usuario', async () => {
  const idReflejado = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(idReflejado, `${TEST_TAG}-lote-e6b`);
  const idPropio = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  const r = await call('GET',
    `/api/registros/activos?planta_id=${TEST_PLANTA}&bitacora_id=${BIT_SALAING}`,
    { sesion_id: ctx.sesiones.ingOp });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const filaReflejada = r.data.registros.find((x) => x.registro_id === idReflejado);
  const filaPropia = r.data.registros.find((x) => x.registro_id === idPropio);
  assert.ok(filaReflejada && filaPropia, 'el usuario ve las dos filas');
  // El contraste ES el test: mismo autor, misma bitácora, misma planta, mismo cargo — lo único que
  // cambia es el origen. Si el espejo SQL se desalineara del helper, esto se pondría rojo antes de
  // que la grilla ofreciera un lápiz que el PUT rechaza.
  assert.equal(filaReflejada.puede_editar, false, 'asiento reflejado → puede_editar=false');
  assert.equal(filaPropia.puede_editar, true, 'registro tecleado a mano por su autor → puede_editar=true');

  // El rótulo del chip sale del catálogo por `codigo`, no de un literal del front (D-052).
  const db = await getDB();
  const nombreMand = (await db.request()
    .query(`SELECT nombre FROM lov_bit.bitacora WHERE codigo = 'MAND'`)).recordset[0]?.nombre;
  assert.equal(filaReflejada.origen_bitacora_nombre, nombreMand,
    'el origen se rotula con el nombre vigente del catálogo');
  assert.equal(filaPropia.origen_bitacora_nombre, null, 'una fila sin origen no trae rótulo');
});
