// D-063 · L02 — Reflejo de DISPONIBILIDAD hacia las bitácoras de Sala, a nivel de ENDPOINT (HTTP).
//
// L01 probó el MÓDULO (`utils/reflejo-sala.js`) con una transacción directa; acá se prueba que los
// tres handlers lo llaman de verdad y en el lugar correcto: `POST /api/registros` (rama DISP) crea
// las copias (RQ-02.10), `PUT /api/registros/:id` (rama DISP) las reescribe (RQ-02.11) y
// `POST /api/disponibilidad/deshacer` las ANULA sin borrarlas (RQ-02.12), todo dentro de la
// transacción del ORIGEN. Más los bordes que solo se ven por HTTP: la copia es de solo lectura en su
// destino (403 `asiento_reflejado`), el reflejo no es retroactivo (RQ-02.13) y `TEST_PLANTA` no
// refleja (RN-02.e).
//
// Aislamiento (D-030/D-055/D-058 E4): la suite corre contra la BD PRODUCTIVA. Todo se siembra en la
// planta-fixture `TSR` (`TEST_PLANTA_REFLEJO`, la única que SÍ refleja), NUNCA en GEC3/GEC32, y cada
// DELETE lleva su acotador de fixture léxicamente junto al statement.
//
// **TSR se ENCIENDE mientras corre este archivo** y se apaga en el `after()`. Es la única forma de
// probar el camino HTTP: `TSR` se siembra con `activa = 0` (así no aparece en el selector de unidad
// del login) y el POST/PUT de DISP exigen `activa = 1` (`plantaCheck`, "planta_id no es operativa").
// El módulo de L01 no pasa por ese check y por eso a él le bastaba la planta apagada. El contrato C6
// pone el cinturón: `zzz_session_leak_guard` —el último test de la suite— falla si TSR quedó
// encendida, y la apaga igual en su `after()`.
//
// UN SOLO USUARIO: `setupSesionReflejo()` usa un username FIJO (`test_reflejo_jdt`) y la siembra
// desactiva las otras sesiones del mismo usuario (sesión única, D-035), así que una segunda sesión
// con otro cargo mataría a la primera. Los casos "sin importar quién" se prueban con el mismo JdT
// (que es quien tiene `puede_crear` en DISP por la matriz); queda constancia en el cierre de L02.
//
// Fechas DETERMINÍSTICAS (no dependen de la hora de la corrida) y estrictamente pasadas, que es lo
// único que la rama DISP exige (`fecha_inicio_estado <= now`):
//   T_A → 2026-02-10 15:30 UTC = 10:30 Bogotá → periodo 11 → turno 1
//   T_B → 2026-02-11 15:30 UTC = 10:30 Bogotá → periodo 11 → turno 1
//   T_C → 2026-02-12 01:30 UTC = 20:30 Bogotá del 11 → periodo 21 → turno 2

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sql from 'mssql';

import { initDB, getDB } from '../db.js';
import { asientoDisponibilidad } from '../utils/asientos/index.js';
import { CLAVE_ORIGEN_DISP, TIPO_ESPEJO_DISP } from '../utils/reflejo-sala.js';
import { resolverOAbrirTurnoAbierto, resolverTurnoParaEscritura, cerrarTurno } from '../utils/turno-entidad.js';
import {
  TEST_PLANTA,
  TEST_PLANTA_REFLEJO,
  TEST_TAG,
  call,
  setupSesionReflejo,
  deactivateSyntheticSessions,
} from './helpers.js';

const DIR = dirname(fileURLToPath(import.meta.url));   // server/tests
const SERVER = join(DIR, '..');                        // server

const T_A = new Date('2026-02-10T15:30:00.000Z');
const T_B = new Date('2026-02-11T15:30:00.000Z');
const T_C = new Date('2026-02-12T01:30:00.000Z');

// Espejo local del catálogo cerrado de `routes/registros.js` (no se exporta). Solo sirve para que un
// estado sembrado por SQL directo tenga un `codigo` coherente con su `estado`; el reflejo no lo mira.
const CODIGO_POR_EVENTO = { 'En Servicio': 1, 'En Reserva': 0, Indisponible: -1, Mantenimiento: -1 };

let db;
let sesion;
let DISP_BITACORA_ID;
let SALAJDT_ID;
let NOMBRE_DISP;
let NOMBRE_SESION;
let CARGO_SESION;

// ── Fixture: encender / apagar / limpiar TSR ────────────────────────────────────────────────────

async function encenderTSR() {
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`UPDATE lov_bit.planta SET activa = 1 WHERE planta_id = @p`);
}

async function apagarTSR() {
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`UPDATE lov_bit.planta SET activa = 0 WHERE planta_id = @p`);
}

// Limpieza de la planta-fixture del reflejo, copiada de `reflejo_disponibilidad` (L01). Acotada a
// `TEST_PLANTA_REFLEJO` y SIN parámetro de planta: imposible apuntarla a GEC3/GEC32 por error. Barre
// TODA la planta y no solo Sala, porque una copia mal dirigida tiene que quedar limpia igual, y
// `registro_activo` incluye los CIET que emiten el deshacer y el cierre de turno.
async function limpiarTSR() {
  assert.equal(TEST_PLANTA_REFLEJO, 'TSR', 'limpiarTSR solo puede correr sobre la planta-fixture');
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.evento_dashboard WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE planta_id = @p;
      DELETE FROM bitacora.mand_cierre_log WHERE planta_id = @p;
      DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @p;
    `);
}

// Desmonta las cabeceras de turno de TSR (las abre este archivo; el sweeper nunca toca TSR: solo
// transiciona GEC3/GEC32). Rompe primero las FK `turno_id` para no violar integridad, igual que
// `registros_solo_autor`. `conformacion_turno` entra porque `cerrarTurno` la congela.
async function borrarTurnosTSR() {
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      UPDATE ra SET turno_id = NULL FROM bitacora.registro_activo ra
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = ra.turno_id WHERE tu.planta_id = @p;
      UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
      DELETE FROM bitacora.conformacion_turno WHERE planta_id = @p;
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
}

// ── Llamadas HTTP del flujo ─────────────────────────────────────────────────────────────────────

async function postDisp({ evento, fecha, detalle, planta_id = TEST_PLANTA_REFLEJO }) {
  return call('POST', '/api/registros', {
    sesion_id: sesion.sesion_id,
    body: {
      bitacora_id: DISP_BITACORA_ID,
      planta_id,
      fecha_evento: fecha.toISOString(),
      campos_extra: { evento, fecha_inicio_estado: fecha.toISOString() },
      detalle,
    },
  });
}

async function putDisp(disponibilidad_id, { evento, fecha, detalle }) {
  const campos_extra = {};
  if (evento !== undefined) campos_extra.evento = evento;
  if (fecha !== undefined) campos_extra.fecha_inicio_estado = fecha.toISOString();
  return call('PUT', `/api/registros/${disponibilidad_id}`, {
    sesion_id: sesion.sesion_id,
    body: { campos_extra, detalle },
  });
}

async function deshacer(planta_id = TEST_PLANTA_REFLEJO) {
  return call('POST', '/api/disponibilidad/deshacer', {
    sesion_id: sesion.sesion_id,
    body: { planta_id },
  });
}

// ── Lecturas de la BD ───────────────────────────────────────────────────────────────────────────

// Las COPIAS VIVAS de un estado: por `campos_extra.origen_disponibilidad_id`, nunca por
// `registro_id` (D-055 (c)). Orden por código de bitácora: SALAING, SALAJDT.
async function copiasDe(disponibilidad_id, planta_id = TEST_PLANTA_REFLEJO) {
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('id', sql.NVarChar(20), String(disponibilidad_id))
    .query(`
      SELECT ra.registro_id, ra.bitacora_id, ra.detalle, ra.fecha_evento, ra.turno, ra.turno_id,
             ra.estado, ra.campos_extra, ra.tipo_evento_id, ra.creado_por, ra.modificado_por,
             ra.ingenieros_snapshot, ra.jdts_snapshot, ra.jefes_snapshot,
             b.codigo AS bitacora_codigo, te.nombre AS tipo_nombre
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.planta_id = @p
        AND JSON_VALUE(ra.campos_extra, '$.${CLAVE_ORIGEN_DISP}') = @id
      ORDER BY b.codigo
    `);
  return r.recordset;
}

// Las copias ya ARCHIVADAS por el cierre de turno.
async function copiasHistoricoDe(disponibilidad_id) {
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('id', sql.NVarChar(20), String(disponibilidad_id))
    .query(`
      SELECT rh.registro_id, rh.detalle, rh.campos_extra, rh.turno_id, rh.estado,
             b.codigo AS bitacora_codigo
      FROM bitacora.registro_historico rh
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = rh.bitacora_id
      WHERE rh.planta_id = @p
        AND JSON_VALUE(rh.campos_extra, '$.${CLAVE_ORIGEN_DISP}') = @id
      ORDER BY b.codigo
    `);
  return r.recordset;
}

// Filas de las TRES bitácoras de Sala de una planta. Sirve para afirmar AUSENCIA (RQ-02.13, RN-02.e).
async function contarSala(planta_id) {
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT COUNT(*) AS n
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.planta_id = @p AND b.codigo IN ('SALAJDT', 'SALAING', 'SALAOP')
    `);
  return r.recordset[0].n;
}

async function origenDe(disponibilidad_id) {
  const r = await db.request()
    .input('id', sql.Int, disponibilidad_id)
    .query(`
      SELECT disponibilidad_id, planta_id, estado, detalle, fecha_inicio_estado, fecha_fin_estado,
             jdts_snapshot, jefes_planta_snapshot, ingenieros_snapshot, creado_por
      FROM bitacora.disponibilidad_estado WHERE disponibilidad_id = @id
    `);
  return r.recordset[0] ?? null;
}

// Estado sembrado SIN pasar por la API: es el fixture de "estado anterior a D-063" (sin copias), que
// es lo que el reflejo NO debe volver retroactivo (RQ-02.13). Tabla BASE (D-041), planta-fixture.
async function insertDispDirectoTSR({ evento, fecha, detalle }) {
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('e', sql.VarChar(20), evento)
    .input('c', sql.SmallInt, CODIGO_POR_EVENTO[evento])
    .input('i', sql.DateTime2, fecha)
    .input('d', sql.NVarChar(sql.MAX), detalle)
    .input('u', sql.Int, sesion.usuario_id)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, detalle, creado_por)
      OUTPUT INSERTED.disponibilidad_id
      VALUES (@p, @e, @c, @i, @d, @u)
    `);
  return r.recordset[0].disponibilidad_id;
}

const camposDe = (fila) => JSON.parse(fila.campos_extra);

// Siembra por HTTP los dos estados con los que trabajan casi todos los casos: E1 (queda como N-1,
// cerrado por el alta de E2) y E2 (el VIGENTE). Devuelve los ids y el texto esperado de cada uno.
async function sembrarDosEstados() {
  const detalle1 = `${TEST_TAG} falla en bomba de alimentación`;
  const p1 = await postDisp({ evento: 'Indisponible', fecha: T_A, detalle: detalle1 });
  assert.equal(p1.status, 201, `alta E1: ${JSON.stringify(p1.data)}`);

  const detalle2 = `${TEST_TAG} unidad normalizada`;
  const p2 = await postDisp({ evento: 'En Servicio', fecha: T_B, detalle: detalle2 });
  assert.equal(p2.status, 201, `alta E2: ${JSON.stringify(p2.data)}`);
  assert.equal(p2.data.vigente_anterior_movido_id, p1.data.registro.registro_id,
    'el alta de E2 cierra a E1 (cronología DISP)');

  return {
    id1: p1.data.registro.registro_id,
    id2: p2.data.registro.registro_id,
    asiento1: asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'Indisponible', detalle: detalle1 }),
    asiento2: asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'En Servicio', detalle: detalle2 }),
  };
}

// ── Arranque y limpieza del archivo ─────────────────────────────────────────────────────────────

before(async () => {
  // `initDB()` resuelve los live bindings (`USUARIO_SISTEMA_ID`) que `resolverOAbrirTurnoAbierto` →
  // `abrirTurnoSiFalta` y `cerrarTurno` exigen. Con `SKIP_INITDB=1` son dos SELECT sin DDL
  // (metodología v2: ningún lote es dueño de `db.js`); sin el flag corre el arranque completo.
  await initDB();
  db = await getDB();

  sesion = await setupSesionReflejo();
  // El ENCENDIDO va DESPUÉS de la fixture: `setupSesionReflejo` reapaga TSR en cada corrida.
  await encenderTSR();

  const cat = await db.request().query(`
    SELECT codigo, bitacora_id, nombre FROM lov_bit.bitacora
    WHERE codigo IN ('DISP', 'SALAJDT')
  `);
  const porCodigo = new Map(cat.recordset.map((b) => [b.codigo, b]));
  DISP_BITACORA_ID = porCodigo.get('DISP')?.bitacora_id;
  SALAJDT_ID = porCodigo.get('SALAJDT')?.bitacora_id;
  // El rótulo del origen sale del CATÁLOGO, no de un literal (D-052): un rename del seed no puede
  // poner rojo este test, y así se lee de la misma fuente que el backend.
  NOMBRE_DISP = porCodigo.get('DISP')?.nombre ?? null;
  assert.ok(DISP_BITACORA_ID && SALAJDT_ID && NOMBRE_DISP, 'DISP y SALAJDT deben existir en el catálogo');

  // Nombre y cargo REALES de la sesión, para los asserts de `anulado` (H7/H8): leerlos de la BD y no
  // hardcodearlos es lo que hace que el caso distinga "se selló el dato" de "coincide el literal".
  const s = await db.request()
    .input('sid', sql.Int, sesion.sesion_id)
    .query(`
      SELECT u.nombre_completo, c.nombre AS cargo_nombre
      FROM bitacora.sesion_activa sa
      INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      INNER JOIN lov_bit.cargo   c ON c.cargo_id  = sa.cargo_id
      WHERE sa.sesion_id = @sid
    `);
  NOMBRE_SESION = s.recordset[0]?.nombre_completo ?? null;
  CARGO_SESION = s.recordset[0]?.cargo_nombre ?? null;
  assert.ok(NOMBRE_SESION && CARGO_SESION, 'la sesión-fixture debe tener nombre y cargo en la BD');

  await limpiarTSR();
  await borrarTurnosTSR();
});

after(async () => {
  // Todo pase lo que pase, y en este orden: los datos primero, el APAGADO de TSR después (contrato
  // C6) y las sesiones al final. Anidado y no encadenado: un fallo limpiando datos no puede dejar la
  // planta encendida, ni un fallo apagándola dejar una sesión sintética viva en producción.
  try {
    await limpiarTSR();
    await borrarTurnosTSR();
  } finally {
    try {
      await apagarTSR();
    } finally {
      await deactivateSyntheticSessions();
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L02 · crear (CA-10)', () => {
  test('POST DISP → 201 y DOS copias (SALAJDT + SALAING, ninguna en SALAOP) con el texto del motor, el campos_extra de C2 y los snapshots REALES del origen', async () => {
    await limpiarTSR();
    const detalle = `${TEST_TAG} falla en bomba de alimentación`;
    const post = await postDisp({ evento: 'Indisponible', fecha: T_A, detalle });
    assert.equal(post.status, 201, JSON.stringify(post.data));

    const id = post.data.registro.registro_id;
    const copias = await copiasDe(id);
    assert.equal(copias.length, 2, 'una copia en SALAJDT y otra en SALAING');
    assert.deepEqual(copias.map((c) => c.bitacora_codigo), ['SALAING', 'SALAJDT']);
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 2,
      'exactamente dos filas en Sala: SALAOP no recibe copia (fuera de alcance de D-063)');

    const esperado = asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'Indisponible', detalle });
    const origen = await origenDe(id);
    for (const c of copias) {
      assert.equal(c.detalle, esperado, 'el texto lo arma SOLO el motor, sin prefijos manuales (D-058)');
      assert.deepEqual(camposDe(c), { origen_bitacora: 'DISP', [CLAVE_ORIGEN_DISP]: id },
        'contrato C2: exactamente estas dos claves, y el puntero como NÚMERO');
      assert.equal(c.tipo_nombre, TIPO_ESPEJO_DISP);
      assert.equal(c.estado, 'borrador');
      assert.equal(c.creado_por, sesion.usuario_id, 'la copia la firma el autor del ORIGEN (RN-02.c)');
      assert.equal(new Date(c.fecha_evento).toISOString(), T_A.toISOString(),
        'fecha_evento = fecha_inicio_estado (dato narrativo), no el instante de la escritura');
      assert.equal(c.turno, 1, 'turno narrativo derivado de la hora Bogotá del estado');
      assert.equal(c.turno_id, null,
        'sin turno ABIERTO en la unidad el puntero de archivado queda NULL (RN-02.d: DISP no pasa por el gate)');

      // H7 (gate O1): los snapshots de la copia son los del ORIGEN, con el mapeo de nombre hecho en
      // el enganche. Un '[]' acá contra un origen no vacío es exactamente el bug: el origen la llama
      // `jefes_planta_snapshot` y `registro_activo` la llama `jefes_snapshot`.
      assert.equal(c.jdts_snapshot, origen.jdts_snapshot, 'jdts_snapshot: el de la transacción del origen');
      assert.equal(c.jefes_snapshot, origen.jefes_planta_snapshot,
        'H7: `jefes_planta_snapshot` del origen tiene que llegar como `jefes_snapshot` a la copia');
      assert.equal(c.ingenieros_snapshot, origen.ingenieros_snapshot, 'ingenieros_snapshot: el del origen');
    }

    // Que los snapshots del ORIGEN no estén vacíos es lo que le da filo al bloque anterior: contra un
    // origen con '[]' la igualdad se cumpliría sola y el bug H7 pasaría verde. `jdts` lo garantiza la
    // sesión JdT de la fixture; `jefes` sale de `es_jefe_planta = 1`, que es global y no depende de
    // esta planta — si algún día la BD no tuviera ninguno, este caso pierde su verificador de H7.
    assert.notEqual(copias[0].jdts_snapshot, '[]',
      'PRECONDICIÓN: la sesión JdT sobre TSR debe estar viva para que el snapshot tenga contenido');
    assert.notEqual(origen.jefes_planta_snapshot, '[]',
      'PRECONDICIÓN: la BD debe tener al menos un usuario con es_jefe_planta = 1; sin eso el assert de H7 '
      + '(jefes_planta_snapshot → jefes_snapshot) no distingue un mapeo correcto de un "[]" por omisión');
    const jdts = JSON.parse(copias[0].jdts_snapshot);
    assert.ok(jdts.some((u) => u.usuario_id === sesion.usuario_id),
      `la sesión JdT de la fixture (#${sesion.usuario_id}) debe viajar en el jdts_snapshot de la copia`);

    await limpiarTSR();
  });

  test('GET /activos lista las copias con puede_editar=false y el nombre real de DISP; un segundo POST cierra el vigente y agrega otras dos', async () => {
    await limpiarTSR();
    const { id1, id2, asiento1, asiento2 } = await sembrarDosEstados();

    assert.equal((await copiasDe(id1)).length, 2, 'las copias de E1 siguen vivas tras el alta de E2');
    assert.equal((await copiasDe(id2)).length, 2);
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 4, 'cuatro copias en total (dos estados × dos bitácoras)');

    const r = await call(
      'GET',
      `/api/registros/activos?planta_id=${TEST_PLANTA_REFLEJO}&bitacora_id=${SALAJDT_ID}`,
      { sesion_id: sesion.sesion_id },
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const filas = r.data.registros;
    assert.equal(filas.length, 2, 'SALAJDT muestra una copia por estado');
    for (const fila of filas) {
      assert.equal(fila.puede_editar, false,
        'contrato C3: toda fila con `origen_bitacora` sale sin lápiz — el espejo SQL y el helper van juntos (D-049)');
      assert.equal(fila.origen_bitacora_nombre, NOMBRE_DISP,
        'el chip rotula con el nombre VIGENTE de DISP en el catálogo (D-052)');
    }
    assert.deepEqual(filas.map((f) => f.detalle).sort(), [asiento1, asiento2].sort());

    await limpiarTSR();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L02 · editar (CA-11)', () => {
  test('PUT del vigente reescribe las DOS copias (texto, fecha y turno narrativo), no toca tipo_evento_id ni las copias del N-1', async () => {
    await limpiarTSR();
    const { id1, id2, asiento1 } = await sembrarDosEstados();
    const tiposAntes = (await copiasDe(id2)).map((c) => c.tipo_evento_id);

    const detalleNuevo = `${TEST_TAG} normalización confirmada por el CND`;
    const put = await putDisp(id2, { evento: 'Mantenimiento', fecha: T_C, detalle: detalleNuevo });
    assert.equal(put.status, 200, JSON.stringify(put.data));

    const esperado = asientoDisponibilidad({
      planta_id: TEST_PLANTA_REFLEJO, evento: 'Mantenimiento', detalle: detalleNuevo,
    });
    const copias = await copiasDe(id2);
    assert.equal(copias.length, 2, 'editar reescribe, no duplica');
    assert.deepEqual(copias.map((c) => c.tipo_evento_id), tiposAntes,
      'el tipo espejo de DISP es uno solo: editar no lo reapunta');
    for (const c of copias) {
      assert.equal(c.detalle, esperado, 'el texto se REGENERA con el motor, no se le agrega un renglón de corrección');
      assert.equal(new Date(c.fecha_evento).toISOString(), T_C.toISOString());
      assert.equal(c.turno, 2, 'el turno narrativo sigue a la fecha nueva (20:30 Bogotá → turno 2)');
      assert.equal(c.modificado_por, sesion.usuario_id, 'queda sellado quién editó');
      assert.equal(camposDe(c)[CLAVE_ORIGEN_DISP], id2, 'el puntero al origen no se toca');
    }

    for (const c of await copiasDe(id1)) {
      assert.equal(c.detalle, asiento1, 'editar el VIGENTE no toca las copias del N-1');
    }

    await limpiarTSR();
  });

  test('PUT sobre la COPIA en Sala → 403 asiento_reflejado con origen DISP: solo lectura en destino, también para su autor', async () => {
    await limpiarTSR();
    await borrarTurnosTSR();
    // El PUT genérico pasa antes por el write-gate por unidad (D-045/D-046): sin turno ABIERTO en
    // TSR respondería 409 `turno_cerrado` y nunca llegaría al 403 que este caso quiere ver.
    const abierto = await resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO);
    assert.ok(abierto?.turno_unidad_id, 'la fixture necesita un turno ABIERTO para llegar al gate del reflejo');
    try {
      const gate = await resolverTurnoParaEscritura(db, TEST_PLANTA_REFLEJO, { abrir: false });
      assert.equal(gate.estado, 'ABIERTO',
        `el turno recién abierto debe estar ABIERTO (está ${gate.estado}: la corrida cayó en el borde de la ventana)`);

      const detalle = `${TEST_TAG} evento a reflejar`;
      const post = await postDisp({ evento: 'Indisponible', fecha: T_A, detalle });
      assert.equal(post.status, 201, JSON.stringify(post.data));
      const copia = (await copiasDe(post.data.registro.registro_id))[0];
      const esperado = asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'Indisponible', detalle });

      const put = await call('PUT', `/api/registros/${copia.registro_id}`, {
        sesion_id: sesion.sesion_id,
        body: { detalle: `${TEST_TAG} el autor intenta reescribir la copia` },
      });
      assert.equal(put.status, 403, JSON.stringify(put.data));
      assert.equal(put.data.codigo, 'asiento_reflejado');
      assert.equal(put.data.origen_bitacora, 'DISP');
      assert.equal(put.data.origen_bitacora_nombre, NOMBRE_DISP);
      assert.ok(put.data.mensaje.includes(NOMBRE_DISP), `el mensaje nombra el origen: ${put.data.mensaje}`);

      for (const c of await copiasDe(post.data.registro.registro_id)) {
        assert.equal(c.detalle, esperado, 'la copia queda intacta: solo la mueve editar el estado en Disponibilidad');
      }
    } finally {
      // Los registros primero: `registro_activo.turno_id` tiene FK a `turno_unidad`.
      await limpiarTSR();
      await borrarTurnosTSR();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L02 · deshacer (CA-12)', () => {
  test('deshacer ANULA (no borra) las dos copias del vigente, con quién y cuándo, sin tocar las del N-1', async () => {
    await limpiarTSR();
    const { id1, id2, asiento1, asiento2 } = await sembrarDosEstados();

    const antes = new Date();
    const des = await deshacer();
    assert.equal(des.status, 200, JSON.stringify(des.data));
    assert.equal(des.data.copias_anuladas, 2, 'la respuesta reporta cuántas copias alcanzó');
    assert.equal(des.data.revertido.registro_id_eliminado, id2);
    assert.equal(des.data.restaurado.registro_id, id1, 'el N-1 vuelve a ser vigente');

    const copias = await copiasDe(id2);
    assert.equal(copias.length, 2,
      'las copias del estado deshecho SIGUEN VIVAS: se anulan, no se borran (RQ-02.12)');
    for (const c of copias) {
      const campos = camposDe(c);
      assert.equal(campos.origen_bitacora, 'DISP', 'el marcador no se pierde al anular');
      assert.equal(campos[CLAVE_ORIGEN_DISP], id2, 'el puntero al origen tampoco');
      assert.equal(campos.anulado.por, sesion.usuario_id, 'quién deshizo');
      // H8 (gate O1): nombre y cargo REALES de la sesión. La sesión los expone como
      // `nombre_completo`/`cargo_nombre`; un `null` acá sería el enganche pasando `anulado_por:
      // sesion` sin mapear `cargo_nombre` → `cargo`, y ese null queda sellado en la fila para siempre.
      assert.equal(campos.anulado.nombre, NOMBRE_SESION, 'H8: el nombre se congela desde la sesión');
      assert.equal(campos.anulado.cargo, CARGO_SESION, 'H8: el cargo se congela desde `sesion.cargo_nombre`');
      const en = new Date(campos.anulado.en);
      assert.ok(!Number.isNaN(en.getTime()), `anulado.en debe ser una fecha ISO: ${campos.anulado.en}`);
      assert.ok(en.getTime() >= antes.getTime() - 60_000,
        'anulado.en es el instante del deshacer, no una fecha vieja');
      assert.equal(c.detalle, asiento2, 'el `detalle` queda INTACTO: el lector sigue sabiendo qué decía');
      assert.equal(c.modificado_por, sesion.usuario_id);
    }

    for (const c of await copiasDe(id1)) {
      assert.equal(camposDe(c).anulado, undefined,
        'la copia del N-1 restaurado no se toca: nunca dejó de ser cierta');
      assert.equal(c.detalle, asiento1);
    }

    await limpiarTSR();
  });

  test('el segundo deshacer anula las copias del N-1 (copias_anuladas = 2) y el tercero, sin vigente, responde 422 sin_vigente', async () => {
    await limpiarTSR();
    const { id1, id2 } = await sembrarDosEstados();

    const d1 = await deshacer();
    assert.equal(d1.status, 200, JSON.stringify(d1.data));
    assert.equal(d1.data.copias_anuladas, 2);
    const selloPrimero = camposDe((await copiasDe(id2))[0]).anulado.en;

    const d2 = await deshacer();
    assert.equal(d2.status, 200, JSON.stringify(d2.data));
    assert.equal(d2.data.copias_anuladas, 2, 'ahora le toca al N-1, que quedó vigente');
    assert.equal(d2.data.revertido.registro_id_eliminado, id1);
    assert.equal(d2.data.restaurado, null, 'ya no queda N-1 que restaurar: la planta queda sin vigente');
    for (const c of await copiasDe(id1)) {
      assert.equal(camposDe(c).anulado.por, sesion.usuario_id);
    }
    assert.equal(camposDe((await copiasDe(id2))[0]).anulado.en, selloPrimero,
      'idempotencia: el segundo deshacer no repisa el sello del primero (predicado `anulado.en IS NULL`)');

    const d3 = await deshacer();
    assert.equal(d3.status, 422, JSON.stringify(d3.data));
    assert.equal(d3.data.error, 'sin_vigente', 'sin vigente el endpoint responde como siempre');
    assert.equal(d3.data.copias_anuladas, undefined, 'el 422 sale antes de tocar el reflejo');

    await limpiarTSR();
  });

  test('PUT y DELETE sobre una copia ANULADA → 403 asiento_reflejado con el mensaje de constancia, no con el consejo de corregirla en el origen', async () => {
    await limpiarTSR();
    await borrarTurnosTSR();
    const abierto = await resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO);
    assert.ok(abierto?.turno_unidad_id, 'la fixture necesita un turno ABIERTO para llegar al gate del reflejo');
    try {
      const gate = await resolverTurnoParaEscritura(db, TEST_PLANTA_REFLEJO, { abrir: false });
      assert.equal(gate.estado, 'ABIERTO',
        `el turno recién abierto debe estar ABIERTO (está ${gate.estado}: la corrida cayó en el borde de la ventana)`);

      const { id2, asiento2 } = await sembrarDosEstados();
      assert.equal((await deshacer()).data.copias_anuladas, 2);
      const copia = (await copiasDe(id2))[0];
      assert.ok(camposDe(copia).anulado, 'precondición: la copia está anulada');

      // H9 (gate O1): el consejo normal ("corrígelo allá y se actualiza acá solo") es FALSO acá — el
      // estado que generó esta copia ya no existe, así que no hay nada que corregir en el origen.
      for (const [metodo, cuerpo] of [['PUT', { detalle: `${TEST_TAG} intento` }], ['DELETE', undefined]]) {
        const r = await call(metodo, `/api/registros/${copia.registro_id}`, {
          sesion_id: sesion.sesion_id, body: cuerpo,
        });
        const ctx = `${metodo}: ${JSON.stringify(r.data)}`;
        assert.equal(r.status, 403, ctx);
        assert.equal(r.data.codigo, 'asiento_reflejado', ctx);
        assert.equal(r.data.origen_bitacora, 'DISP', ctx);
        assert.ok(r.data.mensaje.includes('quedó anulado al deshacer el evento en'),
          `el mensaje debe explicar la anulación — ${ctx}`);
        assert.ok(r.data.mensaje.includes(NOMBRE_DISP), `el mensaje nombra el origen — ${ctx}`);
        assert.ok(!r.data.mensaje.includes('Corrígelo allá'),
          `el consejo de corregir en el origen es imposible para una copia anulada — ${ctx}`);
        assert.ok(!r.data.mensaje.includes('Elimínalo o deshazlo allá'),
          `el consejo de deshacer en el origen es imposible para una copia anulada — ${ctx}`);
      }

      const despues = await copiasDe(id2);
      assert.equal(despues.length, 2, 'la copia anulada sigue ahí: es la constancia del turno');
      assert.equal(despues[0].detalle, asiento2);
    } finally {
      await limpiarTSR();
      await borrarTurnosTSR();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L02 · no retroactivo y atomicidad (CA-13)', () => {
  test('un estado sembrado por SQL directo (sin copias) se edita y se deshace con normalidad: 0 copias y NINGUNA fabricada', async () => {
    await limpiarTSR();
    const id = await insertDispDirectoTSR({
      evento: 'En Reserva', fecha: T_A, detalle: `${TEST_TAG} estado anterior a D-063`,
    });
    assert.equal((await copiasDe(id)).length, 0, 'precondición: el estado nació sin copias');
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 0);

    // RQ-02.13: el reflejo NO es retroactivo. Corregir un estado viejo procede igual —DISP está
    // exenta de los gates de turno (RN-02.d)— pero no le inventa copias que nunca tuvo.
    const put = await putDisp(id, { evento: 'Indisponible', fecha: T_B, detalle: `${TEST_TAG} corrección` });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal((await copiasDe(id)).length, 0, 'editar un estado sin copias no fabrica ninguna');
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 0);

    const des = await deshacer();
    assert.equal(des.status, 200, JSON.stringify(des.data));
    assert.equal(des.data.copias_anuladas, 0, '`copias = 0` es el caso ESPERADO, no un error');
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 0, 'ni el PUT ni el deshacer agregaron filas a Sala');

    await limpiarTSR();
  });

  test('atomicidad por construcción: los tres enganches viven dentro de la transacción del origen y el catch que los cubre revierte y RE-LANZA', () => {
    // RQ-02.9 — lo que garantiza que un origen nunca quede sin sus copias no es un test de datos
    // (habría que hacer fallar el reflejo a propósito) sino la FORMA del código, y son dos cosas:
    //   (1) la llamada va entre `transaction.begin()` y `transaction.commit()` del ORIGEN, así que
    //       un fallo suyo revierte también el estado; y
    //   (2) el PRIMER `catch` capaz de interceptarla es el del handler, que hace `rollback` y
    //       `throw`. Un `try { await crearReflejo… } catch {}` propio sería justamente ese primer
    //       catch, no re-lanzaría, y dejaría el origen escrito sin copias — la desincronización que
    //       REQ-02 elimina. Por eso el criterio se formula sobre el CATCH y no sobre "hay un try":
    //       el `try` del handler abre legítimamente en la línea siguiente al `begin()`, así que
    //       "no hay try en el medio" sería rojo siempre y no probaría nada.
    const ENGANCHES = [
      { archivo: 'routes/registros.js', llamada: 'crearReflejoDisponibilidad(transaction,' },
      { archivo: 'routes/registros.js', llamada: 'actualizarReflejoDisponibilidad(transaction,' },
      { archivo: 'routes/disponibilidad.js', llamada: 'anularReflejoDisponibilidad(transaction,' },
    ];

    for (const { archivo, llamada } of ENGANCHES) {
      const src = sinComentarios(readFileSync(join(SERVER, archivo), 'utf8'));
      const iLlamada = src.indexOf(llamada);
      assert.notEqual(iLlamada, -1, `${archivo}: no encuentro la llamada ${llamada}`);
      assert.equal(src.indexOf(llamada, iLlamada + 1), -1,
        `${archivo}: hay más de un call site de ${llamada}; este guard audita uno solo`);

      // (1) dentro de la transacción del ORIGEN: begin ANTES, commit DESPUÉS y ningún otro begin en
      // el medio (eso significaría que la llamada cayó en otra transacción).
      const iBegin = src.lastIndexOf('transaction.begin()', iLlamada);
      const iCommit = src.indexOf('transaction.commit()', iLlamada);
      assert.notEqual(iBegin, -1, `${archivo}: ${llamada} no tiene un transaction.begin() antes`);
      assert.notEqual(iCommit, -1, `${archivo}: ${llamada} no tiene un transaction.commit() después`);
      const otroBegin = src.indexOf('transaction.begin()', iBegin + 1);
      assert.ok(otroBegin === -1 || otroBegin > iCommit,
        `${archivo}: hay otro transaction.begin() entre el de la transacción y ${llamada}`);

      // (2) el primer `catch` que puede interceptarla revierte y RE-LANZA. El `[^.\w]` de adelante
      // descarta el `.catch(` de una promesa suelta — p. ej. el
      // `broadcastConteoBitacoras(...).catch(() => {})` que va justo después del commit.
      const resto = src.slice(iLlamada);
      const m = /[^.\w]catch\s*[({]/.exec(resto);
      assert.ok(m, `${archivo}: ${llamada} no tiene ningún catch que la cubra`);
      const manejador = resto.slice(m.index, m.index + 400);
      assert.match(manejador, /rollback/,
        `${archivo}: el primer catch que cubre ${llamada} no revierte la transacción. `
        + 'Si es un try/catch propio del enganche, quítalo (RQ-02.9).');
      assert.match(manejador, /throw/,
        `${archivo}: el primer catch que cubre ${llamada} no re-lanza: se estaría tragando el error `
        + 'y el origen quedaría escrito sin sus copias (RQ-02.9).');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L02 · archivado por turno y RN-02.e (CA-14)', () => {
  test('con turno ABIERTO la copia lleva su turno_id, cerrarTurno la archiva con campos_extra intacto y un deshacer posterior no la toca', async () => {
    await limpiarTSR();
    await borrarTurnosTSR();
    const abierto = await resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO);
    assert.ok(abierto?.turno_unidad_id, 'la fixture necesita un turno ABIERTO para este caso');
    try {
      const detalle = `${TEST_TAG} evento del turno`;
      const post = await postDisp({ evento: 'Indisponible', fecha: T_A, detalle });
      assert.equal(post.status, 201, JSON.stringify(post.data));
      const id = post.data.registro.registro_id;

      const vivas = await copiasDe(id);
      assert.equal(vivas.length, 2);
      for (const c of vivas) {
        assert.equal(c.turno_id, abierto.turno_unidad_id,
          'turno_id es el PUNTERO DE ARCHIVADO: el turno ABIERTO de la unidad (D-045), no el de la fecha');
      }
      const camposAntes = vivas.map((c) => c.campos_extra).sort();

      await cerrarTurno(db, abierto.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: sesion.usuario_id });

      assert.equal((await copiasDe(id)).length, 0, 'el cierre se llevó las copias de registro_activo');
      const hist = await copiasHistoricoDe(id);
      assert.equal(hist.length, 2, 'las dos copias están en registro_historico');
      assert.deepEqual(hist.map((h) => h.campos_extra).sort(), camposAntes,
        'cerrarTurno copia `campos_extra` TAL CUAL: el marcador y el puntero sobreviven al archivado');
      for (const h of hist) {
        assert.equal(h.turno_id, abierto.turno_unidad_id);
        assert.equal(h.estado, 'cerrado');
      }

      // Deshacer DESPUÉS del archivado: `copias = 0` (no queda ninguna viva) y el histórico no se
      // reescribe (RF-032). El deshacer del ORIGEN procede igual: DISP está exenta de los gates de
      // turno y hacerla depender del estado de su reflejo invertiría la jerarquía.
      const des = await deshacer();
      assert.equal(des.status, 200, JSON.stringify(des.data));
      assert.equal(des.data.copias_anuladas, 0, 'no hay copias VIVAS que anular: ya se archivaron');
      for (const h of await copiasHistoricoDe(id)) {
        assert.equal(camposDe(h).anulado, undefined,
          'RF-032: el histórico no se reescribe — la copia archivada no recibe el sello de anulación');
      }
    } finally {
      await limpiarTSR();
      await borrarTurnosTSR();
    }
  });

  test('RN-02.e: la planta-fixture TEST_PLANTA no refleja — POST DISP sobre ella no crea copias y su deshacer responde copias_anuladas = 0', async () => {
    // DISP es cross-planta a propósito, así que la MISMA sesión (sobre TSR) puede postear en 'TST'
    // sin abrir una segunda sesión: `setupSessions` mataría la de esta fixture por sesión única
    // (D-035) y con ella la de las suites vecinas (la lección de D-055).
    const salaAntes = await contarSala(TEST_PLANTA);
    const post = await postDisp({
      evento: 'En Reserva', fecha: T_A, detalle: `${TEST_TAG} rn-02-e`, planta_id: TEST_PLANTA,
    });
    assert.equal(post.status, 201, JSON.stringify(post.data));
    const id = post.data.registro.registro_id;
    try {
      assert.equal((await copiasDe(id, TEST_PLANTA)).length, 0, 'RN-02.e: TEST_PLANTA no refleja');
      assert.equal(await contarSala(TEST_PLANTA), salaAntes, 'ninguna fila nueva en las bitácoras de Sala de TST');

      const des = await deshacer(TEST_PLANTA);
      assert.equal(des.status, 200, JSON.stringify(des.data));
      assert.equal(des.data.copias_anuladas, 0, 'el guard de RN-02.e también corta en el deshacer');
      // El deshacer emitió su CIET en TST: se borra por PK (su `detalle` no lleva el tag, así que
      // `cleanupTestRegistros` no lo alcanzaría y `test:residuos` lo contaría).
      await db.request()
        .input('id', sql.Int, des.data.ciet_registro_id)
        .query(`DELETE FROM bitacora.registro_activo WHERE registro_id = @id`);
    } finally {
      // Red de seguridad acotada a la PK del estado que creó ESTE test: si el deshacer no llegó a
      // correr, el estado no puede quedarse en la fixture.
      await db.request()
        .input('id', sql.Int, id)
        .query(`DELETE FROM bitacora.disponibilidad_estado WHERE disponibilidad_id = @id`);
    }
  });
});

// Quita comentarios de bloque y de línea JS para que el guard léxico de arriba no se deje engañar por
// el texto explicativo (estos mismos archivos documentan el "sin try/catch" en prosa).
//
// D-055: parte con `/\r?\n/`, NUNCA con `.split('\n')`. El repo es CRLF y el `.` de una regex JS no
// matchea `\r`, así que con `\n` a secas el `//.*$` nunca hace match y el strip queda INERTE.
// D-063 (H13 del gate O1): NO se aplica la regla `--` de los comentarios SQL. Acá se auditan archivos
// JS, donde `--` aparece en operadores (`i--`) y dentro de los template literals de SQL; usarla
// truncaría líneas de código y volvería el guard un generador de falsos verdes.
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((linea) => linea.replace(/\/\/.*$/, ''))
    .join('\n');
}
