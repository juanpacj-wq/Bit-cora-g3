// D-049 — write-gate "solo el autor" en bitácoras genéricas: PUT/DELETE /api/registros/:id exigen
// autoría (creado_por) + puede_crear vigente + misma planta. Se ELIMINÓ el bypass histórico de
// puede_cerrar_turno con el que JdT/IngOp editaban/borraban registros ajenos en bitácoras donde solo
// tienen puede_ver (el caso del hallazgo: JdT borrando el registro de un operador en su bitácora).
// También cubre el espejo advisory `puede_editar` del GET /activos (lo que pinta la grilla).
// D-058 E6 (tests 6-7) suma la cara opuesta: el asiento REFLEJADO desde Operación 24h no se edita ni
// se borra en su destino NI SIQUIERA por su autor — que es el mismo del origen (RN-02.c), justo a
// quien esta política autoriza. Es una RESTRICCIÓN sobre D-049, nunca un bypass.
// D-063 L04 (tests 8-10) generaliza el marcador: la copia de DISP es igual de intocable, el 403 nombra
// el origen REAL (payload C4) y `origen_lote_id` a secas ya NO marca nada (el marcador es uno solo:
// `campos_extra.origen_bitacora`).
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
    -- D-065 (GATE-O2): rotacion_control y rotacion_cumplimiento referencian turno_unidad por FK.
    DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id=@p;
    DELETE FROM bitacora.rotacion_control WHERE planta_id=@p;
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
// (MAND) y por `reflejo_disponibilidad` (DISP, D-063 L01) sobre la planta-fixture 'TSR'. Lo que
// estos tests prueban es el GATE, que lo único que mira es el marcador universal
// `campos_extra.origen_bitacora` (D-063, contrato C3) — así que la marca es fixture suficiente y el
// test no depende de que MAND o DISP corran en esta planta.
//
// El caso es el que SIN el cambio pasaba: quien edita es el AUTOR, y el autor de la copia es el
// autor del origen (RN-02.c), justo a quien D-049 autoriza.
//
// `campos_extra` se recibe COMPLETO (objeto o string JSON) para poder sembrar los tres shapes que
// importan: copia MAND (C2 viejo), copia DISP (C2 nuevo) y el "solo puntero" sin marcador (test 10).
async function marcarComoReflejado(registro_id, campos_extra) {
  const db = await getDB();
  const campos = typeof campos_extra === 'string' ? campos_extra : JSON.stringify(campos_extra);
  await db.request()
    .input('id', sql.Int, registro_id)
    .input('ce', sql.NVarChar(sql.MAX), campos)
    .query(`UPDATE bitacora.registro_activo SET campos_extra = @ce WHERE registro_id = @id`);
}

// Shapes de `campos_extra` de una copia, tal cual los escribe `utils/reflejo-sala.js` (contrato C2).
const copiaMand = (lote_id) => ({ origen_bitacora: 'MAND', origen_lote_id: lote_id });
const copiaDisp = (disponibilidad_id) => ({ origen_bitacora: 'DISP', origen_disponibilidad_id: disponibilidad_id });

// El rótulo del origen sale del catálogo por `codigo`, no de un literal (D-052): el test lo lee de
// la misma fuente que el backend, así que un rename del seed no lo pone rojo.
async function nombreBitacora(codigo) {
  const db = await getDB();
  const r = await db.request()
    .input('codigo', sql.VarChar(20), codigo)
    .query(`SELECT nombre FROM lov_bit.bitacora WHERE codigo = @codigo`);
  return r.recordset[0]?.nombre ?? null;
}

// Contrato C4 (D-063): el 403 del PUT/DELETE sobre una copia trae `codigo` estable, el `codigo` del
// origen, su nombre vigente y un `mensaje` que lo nombra (para que el autor sepa a dónde ir).
function assertPayloadAsientoReflejado(resp, { origen, nombre, metodo }) {
  const ctxMsg = `${metodo}: ${JSON.stringify(resp.data)}`;
  assert.equal(resp.status, 403, `${metodo} esperaba 403, fue ${resp.status} ${ctxMsg}`);
  assert.equal(resp.data.codigo, 'asiento_reflejado', ctxMsg);
  assert.equal(typeof resp.data.error, 'string', ctxMsg);
  assert.equal(resp.data.origen_bitacora, origen, `origen_bitacora debe ser ${origen} — ${ctxMsg}`);
  assert.equal(resp.data.origen_bitacora_nombre, nombre, `origen_bitacora_nombre debe salir del catálogo — ${ctxMsg}`);
  assert.equal(typeof resp.data.mensaje, 'string', ctxMsg);
  assert.ok(resp.data.mensaje.includes(nombre), `el mensaje debe nombrar "${nombre}" — ${ctxMsg}`);
}

test('6. D-058 E6: el AUTOR de un asiento reflejado NO puede editarlo ni borrarlo en su destino → 403 asiento_reflejado', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(id, copiaMand(`${TEST_TAG}-lote-e6`));
  const nombreMand = await nombreBitacora('MAND');
  assert.ok(nombreMand, 'PRECONDICIÓN: MAND existe en el catálogo');

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.ingOp,
    body: { detalle: `${TEST_TAG} el autor intenta reescribir su copia` },
  });
  assert.equal(put.status, 403, `PUT esperaba 403, fue ${put.status} ${JSON.stringify(put.data)}`);
  assert.equal(put.data.codigo, 'asiento_reflejado',
    'el motivo NO puede ser solo_autor: quien pide ES el autor, y el mensaje tiene que decirle dónde corregirlo');
  // D-063: la copia MAND sigue igual que antes, ahora con el payload C4 (origen + nombre real).
  assertPayloadAsientoReflejado(put, { origen: 'MAND', nombre: nombreMand, metodo: 'PUT' });

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.ingOp });
  assert.equal(del.status, 403, `DELETE esperaba 403, fue ${del.status} ${JSON.stringify(del.data)}`);
  assert.equal(del.data.codigo, 'asiento_reflejado');
  assertPayloadAsientoReflejado(del, { origen: 'MAND', nombre: nombreMand, metodo: 'DELETE' });

  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor`,
    'la copia queda intacta: solo la mueve la corrección del lote de origen');
});

test('7. D-058 E6: GET /activos da puede_editar=false al asiento reflejado y true al tecleado a mano por el MISMO usuario', async () => {
  const idReflejado = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(idReflejado, copiaMand(`${TEST_TAG}-lote-e6b`));
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
  const nombreMand = await nombreBitacora('MAND');
  assert.equal(filaReflejada.origen_bitacora_nombre, nombreMand,
    'el origen se rotula con el nombre vigente del catálogo');
  assert.equal(filaPropia.origen_bitacora_nombre, null, 'una fila sin origen no trae rótulo');
});

// ── D-063 L04 — el marcador es UNIVERSAL: la copia DISP es tan intocable como la de MAND ─────────
//
// Antes de D-063 el gate miraba `origen_lote_id`, el PUNTERO de MAND. Una copia DISP lleva otro
// puntero (`origen_disponibilidad_id`) y con ese predicado quedaba EDITABLE para su autor en su
// destino — exactamente lo que RQ-02.5/6 prohíbe. El marcador pasa a ser `origen_bitacora` (C3) y
// el 403 nombra el origen real (C4): a quien intenta editar la copia hay que mandarlo a
// Disponibilidad, no a Operación 24h. El `origen_disponibilidad_id` del fixture es un INT cualquiera:
// el gate no lo resuelve (no hay FK posible, D-055 (c)), solo lee el marcador.

test('8. D-063: la copia DISP es de solo lectura para su AUTOR → 403 asiento_reflejado con origen DISP y su nombre real', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(id, copiaDisp(987654));
  const nombreDisp = await nombreBitacora('DISP');
  const nombreMand = await nombreBitacora('MAND');
  assert.ok(nombreDisp && nombreMand, 'PRECONDICIÓN: DISP y MAND existen en el catálogo');

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.ingOp,
    body: { detalle: `${TEST_TAG} el autor intenta reescribir la copia DISP` },
  });
  assertPayloadAsientoReflejado(put, { origen: 'DISP', nombre: nombreDisp, metodo: 'PUT' });
  assert.ok(!put.data.mensaje.includes(nombreMand),
    `el mensaje NO puede mandar al operador a ${nombreMand}: el origen es ${nombreDisp} — ${put.data.mensaje}`);

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.ingOp });
  assertPayloadAsientoReflejado(del, { origen: 'DISP', nombre: nombreDisp, metodo: 'DELETE' });
  assert.ok(!del.data.mensaje.includes(nombreMand),
    `el mensaje NO puede mandar al operador a ${nombreMand}: el origen es ${nombreDisp} — ${del.data.mensaje}`);

  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor`,
    'la copia DISP queda intacta: solo la mueve editar/deshacer el estado en Disponibilidad');
});

test('9. D-063: GET /activos da puede_editar=false a la copia DISP y la rotula con el nombre real de DISP', async () => {
  const idCopiaDisp = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  await marcarComoReflejado(idCopiaDisp, copiaDisp(987655));
  const idPropio = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);

  const r = await call('GET',
    `/api/registros/activos?planta_id=${TEST_PLANTA}&bitacora_id=${BIT_SALAING}`,
    { sesion_id: ctx.sesiones.ingOp });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const filaCopia = r.data.registros.find((x) => x.registro_id === idCopiaDisp);
  const filaPropia = r.data.registros.find((x) => x.registro_id === idPropio);
  assert.ok(filaCopia && filaPropia, 'el usuario ve las dos filas');
  // Mismo contraste que el test 7, ahora con el espejo SQL por `origen_bitacora`: si volviera a
  // `origen_lote_id`, la copia DISP saldría con lápiz y esto se pondría rojo.
  assert.equal(filaCopia.puede_editar, false, 'copia DISP → puede_editar=false');
  assert.equal(filaPropia.puede_editar, true, 'registro propio → puede_editar=true');
  assert.equal(filaCopia.origen_bitacora_nombre, await nombreBitacora('DISP'),
    'el chip rotula con el nombre vigente de DISP en el catálogo');
  assert.equal(filaPropia.origen_bitacora_nombre, null);
});

test('10. D-063: `origen_lote_id` SIN `origen_bitacora` ya NO marca: la fila es editable por su autor (el marcador es uno solo)', async () => {
  const id = await crearRegistro(ctx.sesiones.ingOp, BIT_SALAING, TIPO_SALAING);
  // Solo el puntero, sin marcador. Ningún escritor real produce este shape (reflejo-sala.js siempre
  // escribe los dos); el test fija que el PUNTERO no es el MARCADOR, ni en el helper ni en el espejo.
  await marcarComoReflejado(id, { origen_lote_id: `${TEST_TAG}-solo-puntero` });

  const r = await call('GET',
    `/api/registros/activos?planta_id=${TEST_PLANTA}&bitacora_id=${BIT_SALAING}`,
    { sesion_id: ctx.sesiones.ingOp });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const fila = r.data.registros.find((x) => x.registro_id === id);
  assert.ok(fila, 'el autor ve su fila');
  assert.equal(fila.puede_editar, true, 'sin origen_bitacora no es copia → el autor puede editar');
  assert.equal(fila.origen_bitacora_nombre, null, 'sin origen no hay rótulo');

  const put = await call('PUT', `/api/registros/${id}`, {
    sesion_id: ctx.sesiones.ingOp,
    body: { detalle: `${TEST_TAG} solo-autor editado (puntero sin marcador)` },
  });
  assert.equal(put.status, 200, `PUT esperaba 200, fue ${put.status} ${JSON.stringify(put.data)}`);
  assert.equal(await detalleActual(id), `${TEST_TAG} solo-autor editado (puntero sin marcador)`);

  const del = await call('DELETE', `/api/registros/${id}`, { sesion_id: ctx.sesiones.ingOp });
  assert.equal(del.status, 200, `DELETE esperaba 200, fue ${del.status} ${JSON.stringify(del.data)}`);
});
