// D-063 · L01 — Reflejo de DISPONIBILIDAD hacia las bitácoras de Sala (REQ-02 §3.4), a nivel de
// MÓDULO: se prueba `utils/reflejo-sala.js` con una transacción directa, sin HTTP. Los enganches
// en los endpoints (POST/PUT de registros, deshacer) los prueba `disponibilidad_reflejo_http` (L02).
//
// Aislamiento (D-030/D-055/D-058 E4): la suite corre contra la BD PRODUCTIVA. Todo se siembra en la
// planta-fixture `TSR` (`TEST_PLANTA_REFLEJO`, la única que SÍ refleja; `activa = 0`), NUNCA en
// GEC3/GEC32, y cada DELETE lleva su acotador de fixture léxicamente junto al statement. El origen
// se siembra con `insertNuevoEstado` (la tabla base, D-041) dentro de la misma transacción que el
// reflejo, igual que lo hará el endpoint.
//
// Fechas DETERMINÍSTICAS para el `turno` narrativo (no dependen de la hora de la corrida):
//   T1 → 2026-02-15 15:30 UTC = 10:30 Bogotá → periodo 11 → turno 1
//   T2 → 2026-02-15 01:30 UTC = 20:30 Bogotá del 14 → periodo 21 → turno 2

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';

import { initDB, getDB } from '../db.js';
import {
  crearReflejoDisponibilidad,
  actualizarReflejoDisponibilidad,
  anularReflejoDisponibilidad,
  TIPO_ESPEJO_DISP,
  CLAVE_ORIGEN_DISP,
} from '../utils/reflejo-sala.js';
import { asientoDisponibilidad } from '../utils/asientos/index.js';
import { insertNuevoEstado } from '../utils/notificador.js';
import { resolverTurnoAbierto, resolverOAbrirTurnoAbierto } from '../utils/turno-entidad.js';
import {
  TEST_PLANTA,
  TEST_PLANTA_REFLEJO,
  TEST_TAG,
  setupSesionReflejo,
  deactivateSyntheticSessions,
} from './helpers.js';

const FECHA_T1 = new Date('2026-02-15T15:30:00.000Z');
const FECHA_T2 = new Date('2026-02-15T01:30:00.000Z');

// Espejo local del catálogo cerrado de `routes/registros.js` (no se exporta): solo sirve para que
// el origen sembrado tenga un `codigo` coherente con su `estado`. El reflejo no lo mira.
const CODIGO_POR_EVENTO = { 'En Servicio': 1, 'En Reserva': 0, Indisponible: -1, Mantenimiento: -1 };

const SNAPSHOTS = { ingenieros_snapshot: '[]', jdts_snapshot: '[]', jefes_snapshot: '[]' };

let db;
let usuario_id;

// Limpieza de la planta-fixture del reflejo, copiada de `sala_de_mando_batch` y ampliada con
// `disponibilidad_estado` (el ORIGEN de este flujo). Acotada a `TEST_PLANTA_REFLEJO` y SIN
// parámetro de planta: imposible apuntarla a GEC3/GEC32 por error. Barre TODA la planta y no solo
// Sala, porque una copia mal dirigida tiene que quedar limpia igual.
async function cleanReflejo() {
  assert.equal(TEST_PLANTA_REFLEJO, 'TSR', 'cleanReflejo solo puede correr sobre la planta-fixture');
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

// Ejecuta `fn(tx)` en una transacción propia: commit si termina, rollback + rethrow si lanza. Es la
// composición que hacen los handlers de DISP, sin el HTTP.
async function enTx(fn) {
  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// Siembra un origen REAL en `disponibilidad_estado` (TSR) y lo refleja en la MISMA transacción.
async function sembrarYReflejar({ evento, fecha, detalle = null, creado_por = usuario_id } = {}) {
  return enTx(async (tx) => {
    const origen = await insertNuevoEstado(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      estado: evento,
      codigo: CODIGO_POR_EVENTO[evento],
      fecha_inicio_estado: fecha,
      detalle,
      creado_por,
    });
    const res = await crearReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: origen.disponibilidad_id,
      evento,
      detalle,
      fecha_inicio_estado: fecha,
      creado_por,
      snapshots: SNAPSHOTS,
    });
    return { origen, res };
  });
}

// Las COPIAS de un estado: por `campos_extra.origen_disponibilidad_id`, nunca por `registro_id`
// (D-055 (c)). Trae el `bitacora_id` del tipo de evento aparte del de la fila: compararlos ES el
// guard de coherencia de D-053. Orden por código: SALAING, SALAJDT.
async function copiasDe(disponibilidad_id) {
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('id', sql.NVarChar(20), String(disponibilidad_id))
    .query(`
      SELECT ra.registro_id, ra.bitacora_id, ra.detalle, ra.fecha_evento, ra.turno, ra.turno_id,
             ra.estado, ra.creado_por, ra.modificado_por, ra.modificado_en, ra.tipo_evento_id,
             ra.campos_extra,
             b.codigo AS bitacora_codigo,
             te.nombre AS tipo_nombre, te.bitacora_id AS tipo_bitacora_id, te.seleccionable
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.planta_id = @p
        AND JSON_VALUE(ra.campos_extra, '$.${CLAVE_ORIGEN_DISP}') = @id
      ORDER BY b.codigo
    `);
  return r.recordset;
}

// Cuántas filas de Sala (las tres bitácoras) tiene una planta. Sirve para afirmar AUSENCIA.
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

async function contar(tabla, planta_id) {
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT COUNT(*) AS n FROM bitacora.${tabla} WHERE planta_id = @p`);
  return r.recordset[0].n;
}

function parseCampos(row) {
  return JSON.parse(row.campos_extra);
}

// La forma que TODAS las copias comparten, viva o anulada: dos destinos, tipo espejo coherente con
// su bitácora (D-053), no seleccionable, borrador, planta del origen.
function assertFormaDeCopias(copias, { disponibilidad_id, creado_por }) {
  assert.equal(copias.length, 2, 'una copia en SALAJDT y otra en SALAING');
  assert.deepEqual(copias.map((c) => c.bitacora_codigo), ['SALAING', 'SALAJDT']);
  for (const c of copias) {
    assert.equal(c.tipo_nombre, TIPO_ESPEJO_DISP);
    assert.equal(c.tipo_bitacora_id, c.bitacora_id, 'el tipo espejo es el de SU bitácora (guard D-053)');
    assert.equal(c.seleccionable, false, 'el tipo espejo no se elige a mano (F34.A1)');
    assert.equal(c.estado, 'borrador');
    assert.equal(c.creado_por, creado_por, 'la copia la firma el autor del ORIGEN (RN-02.c)');
    const campos = parseCampos(c);
    assert.equal(campos.origen_bitacora, 'DISP');
    assert.equal(campos[CLAVE_ORIGEN_DISP], disponibilidad_id);
    assert.equal(typeof campos[CLAVE_ORIGEN_DISP], 'number', 'el puntero es NÚMERO, no string (C2)');
  }
}

before(async () => {
  // `initDB()` resuelve los live bindings (`USUARIO_SISTEMA_ID`) que `resolverOAbrirTurnoAbierto` →
  // `abrirTurnoSiFalta` exige para abrir la cabecera de "crear ×3". Con `SKIP_INITDB=1` son dos
  // SELECT sin DDL (metodología v2: ningún lote es dueño de `db.js`); sin el flag corre el arranque
  // completo, como en `f03_datos`.
  await initDB();
  db = await getDB();
  const sesion = await setupSesionReflejo();
  usuario_id = sesion.usuario_id;
  await cleanReflejo();
});

after(async () => {
  await cleanReflejo();
  await deactivateSyntheticSessions();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L01 · crear (CA-1)', () => {
  test('crear ×1 — dos copias (SALAJDT + SALAING, ninguna en SALAOP) con el texto del motor y el campos_extra exacto de C2', async () => {
    await cleanReflejo();
    // Precondición de la fixture: sin cabecera ABIERTA en TSR el `turno_id` tiene que quedar NULL.
    // Una residual es un residuo de otro test (E4.4 la borra en su `finally`), no un dato del caso.
    const abierto = await resolverTurnoAbierto(db, TEST_PLANTA_REFLEJO);
    assert.equal(abierto, null,
      `TSR tiene una cabecera ABIERTA residual (#${abierto?.turno_unidad_id}): otro test no la limpió`);

    const detalle = `${TEST_TAG} falla en bomba de alimentación`;
    const { origen, res } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1, detalle });
    const esperado = asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'Indisponible', detalle });

    assert.deepEqual(res, { copias: 2, asiento: esperado });
    assert.equal(esperado, `TSR F/L indisponible. ${detalle}.`, 'plantilla de DISP del motor, sin prefijos manuales');

    const copias = await copiasDe(origen.disponibilidad_id);
    assertFormaDeCopias(copias, { disponibilidad_id: origen.disponibilidad_id, creado_por: usuario_id });
    for (const c of copias) {
      assert.equal(c.detalle, esperado, 'el detalle de la copia ES la salida del motor');
      assert.deepEqual(parseCampos(c), { origen_bitacora: 'DISP', [CLAVE_ORIGEN_DISP]: origen.disponibilidad_id },
        'C2: exactamente dos claves en una copia viva');
      assert.equal(c.fecha_evento.getTime(), FECHA_T1.getTime(), 'fecha_evento = fecha_inicio_estado (narrativa)');
      assert.equal(c.turno, 1, '10:30 Bogotá → T1');
      assert.equal(c.turno_id, null, 'sin turno abierto en la unidad → NULL (RN-02.d)');
      assert.equal(c.modificado_por, null);
    }
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 2, 'SALAOP no recibe copia (RQ-02.3)');
    await cleanReflejo();
  });

  test('crear ×2 — una fecha del T2 (cruza medianoche) da turno 2; la fecha admite string ISO y el detalle puede faltar', async () => {
    await cleanReflejo();
    const { origen, res } = await sembrarYReflejar({ evento: 'En Reserva', fecha: FECHA_T2.toISOString(), detalle: null });
    assert.equal(res.copias, 2);
    assert.equal(res.asiento, 'TSR disponible en reserva, sin generar.', 'sin detalle: la frase termina en el dato duro');

    const copias = await copiasDe(origen.disponibilidad_id);
    assertFormaDeCopias(copias, { disponibilidad_id: origen.disponibilidad_id, creado_por: usuario_id });
    for (const c of copias) {
      assert.equal(c.detalle, res.asiento);
      assert.equal(c.fecha_evento.getTime(), FECHA_T2.getTime());
      assert.equal(c.turno, 2, '20:30 Bogotá → T2');
    }
    await cleanReflejo();
  });

  test('crear ×3 — con turno ABIERTO en la unidad, turno_id es el puntero de archivado (D-045), no el turno de la fecha', async () => {
    await cleanReflejo();
    const abierto = await resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO);
    assert.ok(abierto?.turno_unidad_id, 'la fixture necesita un turno ABIERTO para este caso');
    try {
      // La fecha del estado es de FEBRERO: su turno narrativo no es el abierto de hoy. El puntero
      // de archivado tiene que ser el ABIERTO igual, porque es el único que va a cerrar la copia.
      const { origen } = await sembrarYReflejar({ evento: 'Mantenimiento', fecha: FECHA_T1 });
      const copias = await copiasDe(origen.disponibilidad_id);
      assert.equal(copias.length, 2);
      for (const c of copias) {
        assert.equal(c.turno_id, abierto.turno_unidad_id, 'la copia se archiva con el turno ABIERTO');
        assert.equal(c.turno, 1, 'el turno narrativo sigue saliendo de la fecha');
      }
    } finally {
      // Los registros primero: `registro_activo.turno_id` tiene FK a `turno_unidad`.
      await cleanReflejo();
      await db.request()
        .input('id', sql.Int, abierto.turno_unidad_id)
        .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE turno_id = @id; DELETE FROM bitacora.rotacion_control WHERE turno_id = @id; DELETE FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L01 · actualizar (CA-2)', () => {
  test('actualizar ×1 — cambiar evento + fecha + detalle regenera texto, fecha y turno en las DOS; tipo y turno_id intactos; sello de quien editó', async () => {
    await cleanReflejo();
    const { origen } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1, detalle: `${TEST_TAG} antes` });
    const antes = await copiasDe(origen.disponibilidad_id);
    assert.equal(antes.length, 2);

    const detalleNuevo = `${TEST_TAG} después`;
    const res = await enTx((tx) => actualizarReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: origen.disponibilidad_id,
      evento: 'Mantenimiento',
      detalle: detalleNuevo,
      fecha_inicio_estado: FECHA_T2,
      modificado_por: usuario_id,
    }));
    const esperado = asientoDisponibilidad({ planta_id: TEST_PLANTA_REFLEJO, evento: 'Mantenimiento', detalle: detalleNuevo });
    assert.deepEqual(res, { copias: 2, asiento: esperado });

    const despues = await copiasDe(origen.disponibilidad_id);
    assertFormaDeCopias(despues, { disponibilidad_id: origen.disponibilidad_id, creado_por: usuario_id });
    for (const [i, c] of despues.entries()) {
      assert.equal(c.registro_id, antes[i].registro_id, 'se actualiza la MISMA fila, no se reemplaza');
      assert.equal(c.detalle, esperado, 'texto regenerado por el motor');
      assert.equal(c.fecha_evento.getTime(), FECHA_T2.getTime(), 'la copia se mueve con la fecha del origen');
      assert.equal(c.turno, 2, 'turno narrativo recalculado');
      assert.equal(c.tipo_evento_id, antes[i].tipo_evento_id, 'tipo_evento_id NO se toca');
      assert.equal(c.turno_id, antes[i].turno_id, 'turno_id (puntero de archivado) NO se toca');
      assert.equal(c.modificado_por, usuario_id, 'sello de quien editó');
      assert.ok(c.modificado_en instanceof Date, 'modificado_en sellado');
      assert.deepEqual(parseCampos(c), parseCampos(antes[i]), 'campos_extra intacto');
    }
    await cleanReflejo();
  });

  test('actualizar ×2 — una segunda llamada idéntica alcanza las 2 filas pero NO re-sella modificado_en (CASE contra el valor anterior)', async () => {
    await cleanReflejo();
    const { origen } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1, detalle: `${TEST_TAG} x` });
    const edicion = {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: origen.disponibilidad_id,
      evento: 'En Servicio',
      detalle: `${TEST_TAG} y`,
      fecha_inicio_estado: FECHA_T2,
      modificado_por: usuario_id,
    };
    const r1 = await enTx((tx) => actualizarReflejoDisponibilidad(tx, edicion));
    assert.equal(r1.copias, 2);
    const primera = await copiasDe(origen.disponibilidad_id);
    for (const c of primera) assert.ok(c.modificado_en instanceof Date, 'la primera edición sí sella');

    // Un instante después, sin cambios: `copias` sigue siendo 2 (el UPDATE alcanza las filas) pero
    // el sello no se mueve — igual que en el origen, donde solo se sellan las celdas afectadas.
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await enTx((tx) => actualizarReflejoDisponibilidad(tx, edicion));
    assert.equal(r2.copias, 2);
    const segunda = await copiasDe(origen.disponibilidad_id);
    for (const [i, c] of segunda.entries()) {
      assert.equal(c.modificado_en.getTime(), primera[i].modificado_en.getTime(), 'sin cambios → sin re-sello');
      assert.equal(c.detalle, primera[i].detalle);
    }
    await cleanReflejo();
  });

  test('actualizar ×3 — un id sin copias (ya archivadas o anterior a D-063) devuelve copias 0 sin lanzar', async () => {
    await cleanReflejo();
    const res = await enTx((tx) => actualizarReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: 2147483000,
      evento: 'En Servicio',
      detalle: null,
      fecha_inicio_estado: FECHA_T1,
      modificado_por: usuario_id,
    }));
    assert.equal(res.copias, 0, 'rowsAffected = 0 NO es error');
    assert.equal(res.asiento, 'TSR E/L en servicio.');
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 0, 'y no fabrica copias (RQ-02.13)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L01 · anular (CA-3)', () => {
  test('anular ×1 — marca `anulado` con las 4 claves + sello, conserva detalle y puntero, y NO borra la fila', async () => {
    await cleanReflejo();
    const detalle = `${TEST_TAG} se anula`;
    const { origen } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1, detalle });
    const antes = await copiasDe(origen.disponibilidad_id);
    const t0 = Date.now();

    const res = await enTx((tx) => anularReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: origen.disponibilidad_id,
      anulado_por: { usuario_id, nombre_completo: 'Test JdT Reflejo', cargo: 'Ingeniero Jefe de Turno' },
    }));
    assert.deepEqual(res, { copias: 2 });

    const despues = await copiasDe(origen.disponibilidad_id);
    assert.equal(despues.length, 2, 'la copia anulada sigue existiendo (RQ-02.12: el turno se cuenta completo)');
    assertFormaDeCopias(despues, { disponibilidad_id: origen.disponibilidad_id, creado_por: usuario_id });
    for (const [i, c] of despues.entries()) {
      assert.equal(c.registro_id, antes[i].registro_id);
      assert.equal(c.detalle, antes[i].detalle, 'detalle intacto');
      assert.equal(c.fecha_evento.getTime(), antes[i].fecha_evento.getTime());
      assert.equal(c.modificado_por, usuario_id, 'sello de quien deshizo');
      assert.ok(c.modificado_en instanceof Date);

      const campos = parseCampos(c);
      assert.deepEqual(Object.keys(campos).sort(), ['anulado', CLAVE_ORIGEN_DISP, 'origen_bitacora'].sort(),
        'C2 anulada: origen + anulado, nunca otras claves');
      assert.equal(typeof campos.anulado, 'object', '`anulado` es un OBJETO (JSON_QUERY), no un string escapado');
      assert.deepEqual(Object.keys(campos.anulado).sort(), ['cargo', 'en', 'nombre', 'por']);
      assert.equal(campos.anulado.por, usuario_id);
      assert.equal(campos.anulado.nombre, 'Test JdT Reflejo');
      assert.equal(campos.anulado.cargo, 'Ingeniero Jefe de Turno');
      const en = new Date(campos.anulado.en);
      assert.ok(!Number.isNaN(en.getTime()), '`en` es una fecha ISO parseable');
      assert.ok(en.getTime() >= t0 - 1000 && en.getTime() <= Date.now() + 1000, '`en` es el ahora del servidor');
      // CA-20 (L07 / H10) — el MISMO instante en los dos sitios, no dos relojes. Antes `en` venía
      // de `new Date()` (la app) y `modificado_en` de `SYSUTCDATETIME()` (el motor) en el mismo
      // UPDATE: con deriva entre ambos, el tooltip de la copia anulada y la auditoría de la fila
      // mostraban horas distintas para el mismo deshacer. Se compara al milisegundo porque eso es
      // lo que un `Date` de JS distingue.
      assert.equal(en.getTime(), c.modificado_en.getTime(),
        '`anulado.en` y `modificado_en` son el mismo instante (un solo @en bindeado a los dos)');
    }
    await cleanReflejo();
  });

  test('anular ×2 — una segunda anulación no alcanza ninguna fila (copias 0) y `anulado.en` queda idéntico', async () => {
    await cleanReflejo();
    const { origen } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1 });
    const args = {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: origen.disponibilidad_id,
      anulado_por: { usuario_id, nombre_completo: 'Primero', cargo: null },
    };
    assert.deepEqual(await enTx((tx) => anularReflejoDisponibilidad(tx, args)), { copias: 2 });
    const primera = await copiasDe(origen.disponibilidad_id);

    await new Promise((r) => setTimeout(r, 20));
    const r2 = await enTx((tx) => anularReflejoDisponibilidad(tx, {
      ...args, anulado_por: { usuario_id, nombre_completo: 'Segundo', cargo: 'Otro' },
    }));
    assert.deepEqual(r2, { copias: 0 }, 'idempotente por SQL: el predicado `anulado.en IS NULL` no alcanza nada');

    const segunda = await copiasDe(origen.disponibilidad_id);
    for (const [i, c] of segunda.entries()) {
      assert.equal(c.campos_extra, primera[i].campos_extra, 'campos_extra byte a byte igual');
      assert.equal(parseCampos(c).anulado.en, parseCampos(primera[i]).anulado.en);
      assert.equal(parseCampos(c).anulado.nombre, 'Primero', 'el primer deshacer es el que consta');
      assert.equal(c.modificado_en.getTime(), primera[i].modificado_en.getTime(), 'tampoco se re-sella');
    }
    await cleanReflejo();
  });

  test('anular ×3 — nombre/cargo ausentes quedan en null; un id sin copias devuelve copias 0 sin lanzar', async () => {
    await cleanReflejo();
    const { origen } = await sembrarYReflejar({ evento: 'En Reserva', fecha: FECHA_T2 });
    const res = await enTx((tx) => anularReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: String(origen.disponibilidad_id), // el id llega a veces como string: se normaliza
      anulado_por: { usuario_id },
    }));
    assert.deepEqual(res, { copias: 2 });
    for (const c of await copiasDe(origen.disponibilidad_id)) {
      const { anulado } = parseCampos(c);
      assert.equal(anulado.por, usuario_id);
      assert.equal(anulado.nombre, null);
      assert.equal(anulado.cargo, null);
    }

    const sinCopias = await enTx((tx) => anularReflejoDisponibilidad(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      disponibilidad_id: 2147483000,
      anulado_por: { usuario_id },
    }));
    assert.deepEqual(sinCopias, { copias: 0 }, 'rowsAffected = 0 NO es error');
    await cleanReflejo();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('D-063 L01 · guardas (CA-4)', () => {
  test('guardas ×1 — TEST_PLANTA no refleja: las tres devuelven { copias: 0, omitido } sin tocar la BD (RN-02.e)', async () => {
    const antes = await contarSala(TEST_PLANTA);
    const comun = { planta_id: TEST_PLANTA, disponibilidad_id: 1, evento: 'Indisponible', detalle: null, fecha_inicio_estado: FECHA_T1 };
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      assert.deepEqual(
        await crearReflejoDisponibilidad(tx, { ...comun, creado_por: usuario_id, snapshots: SNAPSHOTS }),
        { copias: 0, omitido: 'planta_de_test' },
      );
      assert.deepEqual(
        await actualizarReflejoDisponibilidad(tx, { ...comun, modificado_por: usuario_id }),
        { copias: 0, omitido: 'planta_de_test' },
      );
      assert.deepEqual(
        await anularReflejoDisponibilidad(tx, { planta_id: TEST_PLANTA, disponibilidad_id: 1, anulado_por: { usuario_id } }),
        { copias: 0, omitido: 'planta_de_test' },
      );
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    assert.equal(await contarSala(TEST_PLANTA), antes, 'ni una fila de Sala en TST');
  });

  test('guardas ×2 — entradas inválidas lanzan TypeError ANTES de escribir: estado sin plantilla, sin id, sin autor, fecha inválida', async () => {
    await cleanReflejo();
    const ok = {
      planta_id: TEST_PLANTA_REFLEJO, disponibilidad_id: 1, evento: 'Indisponible',
      detalle: null, fecha_inicio_estado: FECHA_T1, creado_por: usuario_id, snapshots: SNAPSHOTS,
    };
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      await assert.rejects(crearReflejoDisponibilidad(tx, { ...ok, evento: 'Disponible' }),
        { name: 'TypeError', message: /estado desconocido/ }, 'lo lanza el motor: no existe plantilla para "Disponible"');
      await assert.rejects(crearReflejoDisponibilidad(tx, { ...ok, disponibilidad_id: undefined }),
        { name: 'TypeError', message: /disponibilidad_id/ });
      await assert.rejects(crearReflejoDisponibilidad(tx, { ...ok, disponibilidad_id: 'abc' }),
        { name: 'TypeError', message: /disponibilidad_id/ });
      await assert.rejects(crearReflejoDisponibilidad(tx, { ...ok, creado_por: undefined }),
        { name: 'TypeError', message: /creado_por/ });
      await assert.rejects(crearReflejoDisponibilidad(tx, { ...ok, fecha_inicio_estado: 'x' }),
        { name: 'TypeError', message: /fecha_inicio_estado/ });
      await assert.rejects(actualizarReflejoDisponibilidad(tx, { ...ok, creado_por: undefined, modificado_por: undefined }),
        { name: 'TypeError', message: /modificado_por/ });
      await assert.rejects(actualizarReflejoDisponibilidad(tx, { ...ok, modificado_por: usuario_id, evento: 'Disponible' }),
        { name: 'TypeError', message: /estado desconocido/ });
      await assert.rejects(anularReflejoDisponibilidad(tx, { planta_id: TEST_PLANTA_REFLEJO, disponibilidad_id: 1, anulado_por: {} }),
        { name: 'TypeError', message: /anulado_por/ });
      await assert.rejects(anularReflejoDisponibilidad(tx, { planta_id: TEST_PLANTA_REFLEJO, disponibilidad_id: 0, anulado_por: { usuario_id } }),
        { name: 'TypeError', message: /disponibilidad_id/ });
    } finally {
      await tx.rollback();
    }
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), 0, 'ninguna validación fallida dejó filas');
  });

  test('guardas ×3 — atomicidad (RQ-02.9): si el reflejo falla, el estado de DISP tampoco queda', async () => {
    await cleanReflejo();
    // Reproduce la composición del endpoint —origen + reflejo en UNA transacción— y le inyecta una
    // falla REAL en el INSERT de la copia: `creado_por` inexistente viola la FK a lov_bit.usuario.
    // No se simula con un throw temprano a propósito: lo que hay que probar es que un error de SQL a
    // mitad del reflejo se propaga y revierte TAMBIÉN el origen.
    const tx = new sql.Transaction(db);
    await tx.begin();
    let fallo = null;
    try {
      const origen = await insertNuevoEstado(tx, {
        planta_id: TEST_PLANTA_REFLEJO, estado: 'Indisponible', codigo: -1,
        fecha_inicio_estado: FECHA_T1, detalle: 'atomicidad', creado_por: usuario_id,
      });
      await crearReflejoDisponibilidad(tx, {
        planta_id: TEST_PLANTA_REFLEJO,
        disponibilidad_id: origen.disponibilidad_id,
        evento: 'Indisponible',
        detalle: 'atomicidad',
        fecha_inicio_estado: FECHA_T1,
        creado_por: 2147483000, // no existe → viola la FK dentro del reflejo
        snapshots: SNAPSHOTS,
      });
      await tx.commit();
    } catch (e) {
      fallo = e;
      await tx.rollback();
    }

    assert.ok(fallo, 'el reflejo NO puede tragarse el error: eso dejaría un origen sin copias');
    assert.equal(await contar('disponibilidad_estado', TEST_PLANTA_REFLEJO), 0, 'el origen se revirtió');
    assert.equal(await contar('registro_activo', TEST_PLANTA_REFLEJO), 0, 'ni el origen ni las copias: o los tres lados o ninguno');
    await cleanReflejo();
  });

  // --- D-063 L07 (H14 del /code-review de la O1) — CA-21 -------------------------------------
  test('guardas ×4 — un solo normalizador de id: las coerciones raras lanzan ANTES de escribir y el id en texto equivale al número (CA-21)', async () => {
    await cleanReflejo();
    const { origen } = await sembrarYReflejar({ evento: 'Indisponible', fecha: FECHA_T1 });
    const salaAntes = await contarSala(TEST_PLANTA_REFLEJO);
    assert.equal(salaAntes, 2, 'la siembra dejó las dos copias que vamos a custodiar');

    // `Number(v)` + `Number.isInteger` aceptaba TODOS los de la primera fila: `true` → 1,
    // `'1e2'` → 100, `[7]` → 7, `' 12 '` → 12. No son "el id 1" ni "el id 100": son entradas que
    // habrían salido a buscar las copias de OTRO estado y, al no encontrarlas, habrían devuelto
    // `copias: 0` — que el contrato C1 considera un resultado NORMAL. Por eso el fallo tiene que
    // ser ruidoso y temprano, no un cero silencioso.
    const basura = [
      true, false, '1e2', [7], ' 12 ', '12 ', '+12', '0x10',
      '-3', -3, 0, '0', '', 'abc', 1.5, NaN, Infinity, {}, null, undefined,
      Number.MAX_SAFE_INTEGER + 2, String(Number.MAX_SAFE_INTEGER + 2),
    ];

    const base = {
      planta_id: TEST_PLANTA_REFLEJO,
      evento: 'Indisponible',
      detalle: null,
      fecha_inicio_estado: FECHA_T1,
      creado_por: usuario_id,
      modificado_por: usuario_id,
      snapshots: SNAPSHOTS,
    };

    for (const v of basura) {
      let etiqueta;
      try {
        etiqueta = JSON.stringify(v) ?? String(v);
      } catch {
        etiqueta = Object.prototype.toString.call(v);
      }
      const esperado = { name: 'TypeError', message: /disponibilidad_id inválido/ };
      // Las TRES entradas del módulo comparten el normalizador: si una se quedara con el `Number()`
      // viejo, este bucle la delata (hasta L07 el bloque vivía duplicado en dos sitios).
      await assert.rejects(
        enTx((tx) => crearReflejoDisponibilidad(tx, { ...base, disponibilidad_id: v })),
        esperado, `crear con ${etiqueta}`);
      await assert.rejects(
        enTx((tx) => actualizarReflejoDisponibilidad(tx, { ...base, disponibilidad_id: v })),
        esperado, `actualizar con ${etiqueta}`);
      await assert.rejects(
        enTx((tx) => anularReflejoDisponibilidad(tx, {
          planta_id: TEST_PLANTA_REFLEJO, disponibilidad_id: v, anulado_por: { usuario_id },
        })),
        esperado, `anular con ${etiqueta}`);
    }

    // "ANTES de escribir" no es una figura retórica: ni una fila más, ni una menos, ni una anulada.
    assert.equal(await contarSala(TEST_PLANTA_REFLEJO), salaAntes, 'ninguna coerción escribió ni borró en Sala');
    for (const c of await copiasDe(origen.disponibilidad_id)) {
      assert.equal(parseCampos(c).anulado, undefined, 'ninguna coerción alcanzó a anular una copia');
      assert.equal(c.modificado_en, null, 'ni a sellarla: la copia sigue como nació');
    }

    // `'2542'` ≡ 2542. El texto es la forma en la que llegan los bodies y algunos drivers, y es la
    // que viaja al predicado (`String(id)`), así que las dos tienen que alcanzar las MISMAS copias.
    assert.deepEqual(
      await enTx((tx) => anularReflejoDisponibilidad(tx, {
        planta_id: TEST_PLANTA_REFLEJO,
        disponibilidad_id: String(origen.disponibilidad_id),
        anulado_por: { usuario_id },
      })),
      { copias: 2 }, 'el id en TEXTO alcanza las dos copias');

    // `disponibilidad_estado` solo admite UN vigente por planta (UQ_disp_estado_vigente_por_planta),
    // así que cada origen nuevo va tras su limpieza.
    await cleanReflejo();
    const segundo = await sembrarYReflejar({ evento: 'En Reserva', fecha: FECHA_T2 });
    assert.deepEqual(
      await enTx((tx) => anularReflejoDisponibilidad(tx, {
        planta_id: TEST_PLANTA_REFLEJO,
        disponibilidad_id: segundo.origen.disponibilidad_id,
        anulado_por: { usuario_id },
      })),
      { copias: 2 }, 'el id en NÚMERO alcanza las dos copias: misma ruta, mismo resultado');

    // Y crear con el id en texto guarda el puntero como NÚMERO (contrato C2), no como string: la
    // normalización pasa por el mismo sitio en las tres funciones.
    await cleanReflejo();
    const tercero = await enTx(async (tx) => {
      const o = await insertNuevoEstado(tx, {
        planta_id: TEST_PLANTA_REFLEJO, estado: 'En Servicio', codigo: CODIGO_POR_EVENTO['En Servicio'],
        fecha_inicio_estado: FECHA_T1, detalle: null, creado_por: usuario_id,
      });
      await crearReflejoDisponibilidad(tx, {
        ...base, evento: 'En Servicio', disponibilidad_id: String(o.disponibilidad_id),
      });
      return o;
    });
    assertFormaDeCopias(await copiasDe(tercero.disponibilidad_id), {
      disponibilidad_id: tercero.disponibilidad_id, creado_por: usuario_id,
    });

    await cleanReflejo();
  });
});
