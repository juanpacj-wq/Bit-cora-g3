// D-058 E8 — Consulta unificada de las cuatro fuentes y armado del día en tres bloques.
//
// Prueba `utils/f03-datos.js` como DATOS, no como `.xlsx`: acá vive toda la lógica delicada de
// REQ-06 (horas canónicas por fuente, doble tabla por antigüedad, el T2 partido por medianoche) y
// se puede verificar sin abrir un ZIP. El escritor ya tiene sus 18 tests puros en `f03_libro`.
//
// Aislamiento (D-030/D-055): la suite corre contra la BD PRODUCTIVA. Todo lo que se siembra va a
// las plantas-fixture `TSR` (la de E4/E5, `activa = 0`) y `TST`, NUNCA a GEC3/GEC32, y cada
// `DELETE` lleva su acotador de fixture léxicamente junto al statement. Las filas de
// `registro_historico` se siembran con `registro_id` NEGATIVO: la columna no es IDENTITY (preserva
// el id original) y un id positivo inventado podría colisionar mañana con el que IDENTITY le asigne
// a una fila real, rompiendo el archivado del cierre.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sql from 'mssql';

import { initDB, getDB } from '../db.js';
import { armarMes, PLANTAS_F03, BLOQUES } from '../utils/f03-datos.js';
import { fechaBogotaStr } from '../utils/turno.js';
import {
  TEST_PLANTA,
  TEST_PLANTA_REFLEJO,
  TEST_TAG,
  setupSesionReflejo,
  deactivateSyntheticSessions,
} from './helpers.js';

// Mes histórico y determinista: 28 días (2026 no es bisiesto), muy anterior a la operación real y
// fuera de cualquier ventana de turno viva. El día 15 es el "día de trabajo" de casi todos los
// casos; los demás quedan vacíos a propósito.
const MES = '2026-02';
const DIA = '2026-02-15';

let db;
let usuario_id;
let personas;       // tres usuarios sintéticos SIN sesión, para el encabezado (ver `usuarioFixture`)
let tiposMand;      // { AUTH, PRUEBA, REDESP } → tipo_evento_id
let tipoSala;       // { SALAJDT, SALAING, SALAOP } → tipo_evento_id de 'Evento General'
let cargos;         // { 'Ingeniero Jefe de Turno': id, … }
let idHistorico = -90000;

before(async () => {
  await initDB();
  db = await getDB();
  const sesion = await setupSesionReflejo();
  usuario_id = sesion.usuario_id;
  // La PK de `conformacion_turno` es (fecha, planta, turno, usuario_id): un bloque con jefe E
  // ingeniero necesita DOS usuarios distintos, y el caso de las dos unidades necesita un tercero.
  personas = [
    await usuarioFixture('test_f03_a'),
    await usuarioFixture('test_f03_b'),
    await usuarioFixture('test_f03_c'),
  ];

  const te = await db.request().query(`
    SELECT b.codigo, te.nombre, te.tipo_evento_id
    FROM lov_bit.tipo_evento te
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo IN ('MAND', 'SALAJDT', 'SALAING', 'SALAOP')
  `);
  const buscar = (codigo, nombre) =>
    te.recordset.find((r) => r.codigo === codigo && r.nombre === nombre)?.tipo_evento_id;
  // Nombres LITERALES del catálogo (D-058 E1/E3): 'Autorización' con tilde, 'Pruebas' en plural.
  tiposMand = {
    AUTH: buscar('MAND', 'Autorización'),
    PRUEBA: buscar('MAND', 'Pruebas'),
    REDESP: buscar('MAND', 'Redespacho'),
  };
  tipoSala = {
    SALAJDT: buscar('SALAJDT', 'Evento General'),
    SALAING: buscar('SALAING', 'Evento General'),
    SALAOP: buscar('SALAOP', 'Evento General'),
  };
  const c = await db.request().query(`SELECT cargo_id, nombre FROM lov_bit.cargo`);
  cargos = Object.fromEntries(c.recordset.map((row) => [row.nombre, row.cargo_id]));

  await limpiarFixtures();
});

after(async () => {
  await limpiarFixtures();
  await deactivateSyntheticSessions();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

// Usuario sintético SIN sesión y SIN login posible (`activo = 0`, sin `azure_oid`): solo existe
// para poder poblar `conformacion_turno`/`turno_participante`, que tienen FK a `lov_bit.usuario`.
// `es_sintetico = 1` va EXPLÍCITO —el barrido de `db.js` que marca los `test_%` solo corre en el
// arranque, así que un usuario creado a mitad de corrida quedaría en 0 hasta el próximo restart
// (mismo motivo por el que `setupSesionReflejo` lo setea a mano)—, y es lo que los mantiene fuera
// del encabezado en el camino de producción (D-044).
async function usuarioFixture(username) {
  await db.request()
    .input('username', sql.VarChar(50), username)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET es_sintetico = 1, activo = 0
      WHEN NOT MATCHED THEN INSERT
        (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo, es_sintetico)
        VALUES (@username, @username, NULL, '!disabled!', 0, 0, 0, 1);
    `);
  const r = await db.request()
    .input('username', sql.VarChar(50), username)
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = @username`);
  return r.recordset[0].usuario_id;
}

// Instante UTC de una hora de pared Bogotá. Offset puro -5h (D-020): nada de `new Date(str)` con la
// TZ de la máquina.
function instante(fecha, hora) {
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
}

async function insertarRegistro({
  tipo_evento_id, planta, fecha_evento, detalle, campos_extra = null, turno = 1, historico = false,
}) {
  const rq = db.request()
    .input('te', sql.Int, tipo_evento_id)
    .input('planta', sql.VarChar(10), planta)
    .input('fecha_evento', sql.DateTime2, fecha_evento)
    .input('turno', sql.TinyInt, turno)
    .input('detalle', sql.NVarChar(sql.MAX), detalle)
    .input('campos_extra', sql.NVarChar(sql.MAX), campos_extra)
    .input('usuario', sql.Int, usuario_id);
  if (!historico) {
    const r = await rq.query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      OUTPUT INSERTED.registro_id
      SELECT te.bitacora_id, @planta, @fecha_evento, @turno, @detalle, @campos_extra, @te,
             'borrador', '[]', '[]', '[]', @usuario
      FROM lov_bit.tipo_evento te WHERE te.tipo_evento_id = @te
    `);
    return r.recordset[0].registro_id;
  }
  const registro_id = idHistorico--;
  await rq
    .input('registro_id', sql.Int, registro_id)
    .query(`
      INSERT INTO bitacora.registro_historico
        (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra,
         tipo_evento_id, estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot,
         creado_por, creado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
      SELECT @registro_id, te.bitacora_id, @planta, @fecha_evento, @turno, @detalle, @campos_extra,
             @te, 'cerrado', '[]', '[]', '[]', @usuario, @fecha_evento, @usuario, @fecha_evento,
             CAST(DATEADD(HOUR, -5, @fecha_evento) AS DATE)
      FROM lov_bit.tipo_evento te WHERE te.tipo_evento_id = @te
    `);
  return registro_id;
}

// Siembra un lote de MAND: una fila por periodo, todas con el mismo `lote_id` y la misma metadata
// (así vive el lote desde D-056, sin tabla propia). `hora` en `null` reproduce las filas que migró
// `F32.A1`: la clave `hora_llamada` NO EXISTE en el JSON, no es `null`.
async function seedLote({
  tipo = 'AUTH', planta = TEST_PLANTA_REFLEJO, fecha = DIA, hora, periodos, valor_mw = 100,
  detalle = null, funcionariocnd = 'CND Test', historico = false, fecha_evento = null,
}) {
  const lote_id = randomUUID();
  const horaLlamada = hora ? instante(fecha, hora).toISOString() : null;
  const evento = fecha_evento ?? (hora ? instante(fecha, hora) : instante(fecha, '12:00'));
  for (const periodo of periodos) {
    const campos = { periodo, valor_mw, funcionariocnd, lote_id };
    if (horaLlamada) campos.hora_llamada = horaLlamada;
    await insertarRegistro({
      tipo_evento_id: tiposMand[tipo],
      planta,
      fecha_evento: evento,
      detalle,
      campos_extra: JSON.stringify(campos),
      turno: periodo >= 7 && periodo <= 18 ? 1 : 2,
      historico,
    });
  }
  return lote_id;
}

// `campos_extra` arbitrario (objeto o string JSON) para sembrar cualquier shape de copia (contrato
// C2 de D-063: MAND `{ origen_bitacora:'MAND', origen_lote_id }`, DISP `{ origen_bitacora:'DISP',
// origen_disponibilidad_id }`). `origen_lote_id` se conserva como atajo del shape MAND.
async function seedSala({
  bitacora = 'SALAJDT', planta = TEST_PLANTA_REFLEJO, fecha = DIA, hora, detalle,
  origen_lote_id = null, campos_extra = null, historico = false,
}) {
  const extra = campos_extra ?? (origen_lote_id ? { origen_bitacora: 'MAND', origen_lote_id } : null);
  return insertarRegistro({
    tipo_evento_id: tipoSala[bitacora],
    planta,
    fecha_evento: instante(fecha, hora),
    detalle,
    campos_extra: extra == null ? null : (typeof extra === 'string' ? extra : JSON.stringify(extra)),
    turno: 1,
    historico,
  });
}

// Devuelve el `disponibilidad_id` sembrado: es el PUNTERO que lleva la copia DISP (C2).
async function seedDisponibilidad({ planta = TEST_PLANTA_REFLEJO, fecha = DIA, hora, estado, detalle = null }) {
  const r = await db.request()
    .input('planta', sql.VarChar(10), planta)
    .input('estado', sql.VarChar(20), estado)
    .input('inicio', sql.DateTime2, instante(fecha, hora))
    // `fecha_fin_estado` siempre poblado: el índice único filtrado permite UN solo vigente por
    // planta, y estos son estados históricos de fixture, no el vigente de nadie.
    .input('fin', sql.DateTime2, instante(fecha, '23:59'))
    .input('detalle', sql.NVarChar(sql.MAX), detalle)
    .input('usuario', sql.Int, usuario_id)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, fecha_fin_estado, detalle, creado_por)
      OUTPUT INSERTED.disponibilidad_id
      VALUES (@planta, @estado, 0, @inicio, @fin, @detalle, @usuario)
    `);
  return r.recordset[0].disponibilidad_id;
}

async function seedConformacion({
  planta = TEST_PLANTA_REFLEJO, fecha_operativa, turno, nombre, cargo, persona = 0,
}) {
  await db.request()
    .input('fecha', sql.Date, fecha_operativa)
    .input('planta', sql.VarChar(10), planta)
    .input('turno', sql.TinyInt, turno)
    .input('usuario', sql.Int, personas[persona])
    .input('nombre', sql.VarChar(200), nombre)
    .input('cargo_id', sql.Int, cargos[cargo])
    .input('cargo', sql.VarChar(100), cargo)
    .input('inicio', sql.DateTime2, instante(fecha_operativa, '06:00'))
    .query(`
      INSERT INTO bitacora.conformacion_turno
        (fecha_operativa, planta_id, turno, usuario_id, usuario_nombre, cargo_id, cargo_nombre,
         inicio_sesion, fin_sesion, duracion_min)
      VALUES (@fecha, @planta, @turno, @usuario, @nombre, @cargo_id, @cargo, @inicio, @inicio, 0)
    `);
}

// Cabecera de turno + presencia viva: la fuente del encabezado cuando el turno NO cerró (D-045).
async function seedParticipante({
  planta = TEST_PLANTA_REFLEJO, fecha_operativa, turno, nombre, cargo, persona = 0,
}) {
  const tu = await db.request()
    .input('fecha', sql.Date, fecha_operativa)
    .input('planta', sql.VarChar(10), planta)
    .input('turno', sql.TinyInt, turno)
    .input('inicio', sql.DateTime2, instante(fecha_operativa, '06:00'))
    .input('fin', sql.DateTime2, instante(fecha_operativa, '18:00'))
    .input('usuario', sql.Int, usuario_id)
    .query(`
      INSERT INTO bitacora.turno_unidad
        (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal, creado_por)
      OUTPUT INSERTED.turno_unidad_id
      VALUES (@fecha, @planta, @turno, 'ABIERTO', @inicio, @fin, @usuario)
    `);
  await db.request()
    .input('turno_id', sql.Int, tu.recordset[0].turno_unidad_id)
    .input('usuario', sql.Int, personas[persona])
    .input('cargo_id', sql.Int, cargos[cargo])
    .input('nombre', sql.VarChar(200), nombre)
    .input('cargo', sql.VarChar(100), cargo)
    .input('ingreso', sql.DateTime2, instante(fecha_operativa, '06:00'))
    .query(`
      INSERT INTO bitacora.turno_participante
        (turno_id, usuario_id, cargo_id, usuario_nombre, cargo_nombre, primer_ingreso)
      VALUES (@turno_id, @usuario, @cargo_id, @nombre, @cargo, @ingreso)
    `);
}

// Todo el DML de limpieza va acotado por planta-FIXTURE, con el acotador léxicamente junto al
// statement (D-055): `@fixture` y `@fixture2` están ligados a TEST_PLANTA_REFLEJO y TEST_PLANTA.
async function limpiarFixtures() {
  await db.request()
    .input('fixture', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('fixture2', sql.VarChar(10), TEST_PLANTA)
    .query(`
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
        WHERE tu.planta_id IN (@fixture, @fixture2);
      -- D-065 (GATE-O2): rotacion_control y rotacion_cumplimiento referencian turno_unidad por FK.
      DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.rotacion_control WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.turno_unidad WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.conformacion_turno WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.disponibilidad_estado WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.registro_activo WHERE planta_id IN (@fixture, @fixture2);
      DELETE FROM bitacora.registro_historico WHERE planta_id IN (@fixture, @fixture2);
    `);
}

// ── Lecturas de conveniencia ─────────────────────────────────────────────────────────────────

const soloFixture = { plantas: [TEST_PLANTA_REFLEJO], incluirSinteticos: true };

const dia = (dias, fecha) => dias.find((d) => d.fecha === fecha);
const filasDe = (dias, fecha, i) => dia(dias, fecha).bloques[i].filas;
const todasLasFilas = (dias) => dias.flatMap((d) => d.bloques.flatMap((b) => b.filas));

// ── Bloques y medianoche ─────────────────────────────────────────────────────────────────────

describe('D-058 E8 — asignación a bloques', () => {
  test('E8.1 un evento del T2 a las 03:15 cae en el bloque 00:00-06:00 de ESE día, una sola vez en el mes', async () => {
    await limpiarFixtures();
    // El T2 arrancó el 14 a las 18:00 y el sistema lo fecha por su día de inicio (D-045). El libro
    // lo PARTE por medianoche: este evento pertenece a la hoja del 15, no a la del 14 (criterio 6b).
    await seedLote({ hora: '03:15', periodos: [4], valor_mw: 90, funcionariocnd: 'CND Madrugada' });

    const dias = await armarMes(db, { mes: MES, ...soloFixture });
    const filas = filasDe(dias, DIA, 0);
    assert.equal(filas.length, 1, 'el evento va al primer bloque del día de calendario');
    assert.equal(filas[0].hora, '03:15');
    assert.match(filas[0].asiento, /autorizando TSR a generar 90 MW en el P4\./);

    assert.equal(filasDe(dias, '2026-02-14', 2).length, 0, 'no aparece en la hoja del día en que arrancó el turno');
    const apariciones = todasLasFilas(dias).filter((f) => f.asiento === filas[0].asiento);
    assert.equal(apariciones.length, 1, 'aparece EXACTAMENTE una vez en todo el libro');
  });

  test('E8.2 los bordes de bloque son cerrados por abajo y abiertos por arriba (05:59 · 06:00 · 18:30)', async () => {
    await limpiarFixtures();
    await seedSala({ hora: '05:59', detalle: 'Relevo de madrugada' });
    await seedSala({ hora: '06:00', detalle: 'Entrada del turno diurno' });
    await seedSala({ hora: '18:30', detalle: 'Entrada del turno nocturno' });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.deepEqual(bloques.map((b) => b.filas.length), [1, 1, 1]);
    assert.match(bloques[0].filas[0].asiento, /Relevo de madrugada/);
    assert.match(bloques[1].filas[0].asiento, /turno diurno/);
    assert.match(bloques[2].filas[0].asiento, /turno nocturno/);
    // Los literales de TURNO: se calcaron del formato controlado, espacios incluidos.
    assert.deepEqual(bloques.map((b) => b.turno_literal), ['00:00-06:00', '06:00 - 18:00', '18:00 - 00:00']);
  });

  test('E8.3 orden ASCENDENTE por hora dentro del bloque (al revés que el listado en pantalla)', async () => {
    await limpiarFixtures();
    await seedSala({ hora: '16:40', detalle: 'Tercero' });
    await seedSala({ hora: '08:05', detalle: 'Primero' });
    await seedSala({ hora: '12:00', detalle: 'Segundo' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.deepEqual(filas.map((f) => f.hora), ['08:05', '12:00', '16:40']);
  });
});

// ── La hora canónica de cada fuente ───────────────────────────────────────────────────────────

describe('D-058 E8 — hora canónica por fuente', () => {
  test('E8.4 la hora de MAND es hora_llamada, NUNCA fecha_evento', async () => {
    await limpiarFixtures();
    // Llamada de las 16:38, digitada a las 20:05: la fila va en las 16:38 (D-056) y por lo tanto en
    // el bloque del T1, no en el del T2 al que pertenecería el instante de la escritura.
    await seedLote({
      hora: '16:38', periodos: [17, 18, 19], valor_mw: 150,
      fecha_evento: instante(DIA, '20:05'),
    });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.equal(bloques[2].filas.length, 0, 'no va al bloque del instante en que se digitó');
    assert.equal(bloques[1].filas.length, 1);
    assert.equal(bloques[1].filas[0].hora, '16:38');
    assert.match(bloques[1].filas[0].asiento, /150 MW del P17 al P19\./);
  });

  test('E8.5 un lote SIN hora_llamada (migrado por F32.A1) cae en el bloque de su primer periodo', async () => {
    await limpiarFixtures();
    // La clave `hora_llamada` no existe en el JSON. El periodo 3 es la hora Bogotá 02:00 → primer
    // bloque, aunque `fecha_evento` (20:05) caiga en el tercero.
    await seedLote({
      hora: null, periodos: [3, 4], valor_mw: 90,
      fecha_evento: instante(DIA, '20:05'),
    });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.deepEqual(bloques.map((b) => b.filas.length), [1, 0, 0]);
    assert.equal(bloques[0].filas[0].hora, '02:00', 'P3 → 02:00, dato real del registro');
  });

  test('E8.6 Disponibilidad entra por fecha_inicio_estado, con su plantilla', async () => {
    await limpiarFixtures();
    await seedDisponibilidad({ hora: '20:14', estado: 'Indisponible', detalle: 'Falla en el ventilador.' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 2);
    assert.equal(filas.length, 1);
    assert.equal(filas[0].hora, '20:14');
    assert.equal(filas[0].asiento, 'TSR F/L indisponible. Falla en el ventilador.');
  });
});

// ── Qué entra y qué no ────────────────────────────────────────────────────────────────────────

describe('D-058 E8 — fuentes incluidas y excluidas', () => {
  test('E8.7 un lote es UN renglón y dos lotes del mismo periodo son DOS renglones', async () => {
    await limpiarFixtures();
    await seedLote({ hora: '09:10', periodos: [10, 11], valor_mw: 120, funcionariocnd: 'Primero' });
    await seedLote({ hora: '09:40', periodos: [10, 11], valor_mw: 140, funcionariocnd: 'Segundo' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2, 'dos autorizaciones del mismo periodo → dos renglones (criterio 7)');
    assert.match(filas[0].asiento, /\(Primero\).*120 MW del P10 al P11\./);
    assert.match(filas[1].asiento, /\(Segundo\).*140 MW del P10 al P11\./);
  });

  test('E8.8 el asiento REFLEJADO en las bitácoras de Sala no aparece (nada se triplica)', async () => {
    await limpiarFixtures();
    const lote_id = await seedLote({ hora: '10:00', periodos: [11], valor_mw: 80 });
    // Las dos copias que E4 crearía para ese lote, más un evento tecleado a mano en Sala.
    await seedSala({ bitacora: 'SALAJDT', hora: '10:00', detalle: 'Copia reflejada', origen_lote_id: lote_id });
    await seedSala({ bitacora: 'SALAING', hora: '10:00', detalle: 'Copia reflejada', origen_lote_id: lote_id });
    await seedSala({ bitacora: 'SALAJDT', hora: '10:30', detalle: 'Evento propio del turno' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2, 'el original + el evento propio; ninguna copia');
    assert.equal(filas.filter((f) => /Copia reflejada/.test(f.asiento)).length, 0);
    assert.match(filas[0].asiento, /autorizando TSR a generar 80 MW/);
    assert.equal(filas[1].asiento, 'TSR — Evento propio del turno');
  });

  // D-063 L04 (CA-6): la copia DISP también es un asiento reflejado, y el libro ya lee el estado desde
  // la tabla base `disponibilidad_estado` (fuente 2). Con la exclusión vieja por `origen_lote_id` las
  // dos copias DISP entraban como texto literal de Sala y el estado salía TRES veces. Las copias se
  // siembran con el shape C2 (`origen_bitacora:'DISP'` + puntero al `disponibilidad_id` real) y el
  // estado vive en la misma planta-fixture; toda la limpieza DISP va por `limpiarFixtures` acotada
  // por planta-fixture (D-041: tabla base, nunca la vista).
  test('E8.8b (D-063) la copia DISP en Sala tampoco aparece: el estado sale UNA sola vez, desde la tabla base', async () => {
    await limpiarFixtures();
    const disponibilidad_id = await seedDisponibilidad({
      hora: '14:20', estado: 'Mantenimiento', detalle: 'Parada programada.',
    });
    const copia = { origen_bitacora: 'DISP', origen_disponibilidad_id: disponibilidad_id };
    await seedSala({ bitacora: 'SALAJDT', hora: '14:20', detalle: 'Copia DISP reflejada', campos_extra: copia });
    await seedSala({ bitacora: 'SALAING', hora: '14:20', detalle: 'Copia DISP reflejada', campos_extra: copia });
    await seedSala({ bitacora: 'SALAING', hora: '15:00', detalle: 'Evento propio del turno' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2, 'el estado (desde disponibilidad_estado) + el evento propio; ninguna copia');
    assert.equal(filas.filter((f) => /Copia DISP reflejada/.test(f.asiento)).length, 0,
      'ninguna copia DISP de Sala llega al libro');
    assert.equal(filas[0].hora, '14:20');
    assert.equal(filas[0].asiento, 'TSR F/L en mantenimiento programado. Parada programada.',
      'el renglón es el del ESTADO, armado por el motor desde la tabla base');
    assert.equal(filas[1].asiento, 'TSR — Evento propio del turno');
  });

  test('E8.8c (D-063) copias MAND y DISP conviven en Sala y ninguna se cuela: cada evento sale UNA vez', async () => {
    await limpiarFixtures();
    const lote_id = await seedLote({ hora: '10:00', periodos: [11], valor_mw: 80 });
    const disponibilidad_id = await seedDisponibilidad({ hora: '10:30', estado: 'En Reserva' });
    const copiaDisp = { origen_bitacora: 'DISP', origen_disponibilidad_id: disponibilidad_id };
    for (const bitacora of ['SALAJDT', 'SALAING']) {
      await seedSala({ bitacora, hora: '10:00', detalle: 'Copia MAND', origen_lote_id: lote_id });
      await seedSala({ bitacora, hora: '10:30', detalle: 'Copia DISP', campos_extra: copiaDisp });
    }

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.deepEqual(filas.map((f) => f.hora), ['10:00', '10:30'], 'dos originales, cero copias');
    assert.match(filas[0].asiento, /autorizando TSR a generar 80 MW/);
    assert.equal(filas[1].asiento, 'TSR disponible en reserva, sin generar.');
    assert.equal(filas.filter((f) => /^TSR — Copia/.test(f.asiento)).length, 0);
  });

  test('E8.9 SALAOP no es una de las cuatro fuentes', async () => {
    await limpiarFixtures();
    await seedSala({ bitacora: 'SALAOP', hora: '11:00', detalle: 'Bitácora del operador de sala' });
    await seedSala({ bitacora: 'SALAING', hora: '11:05', detalle: 'Bitácora del ingeniero' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 1);
    assert.match(filas[0].asiento, /Bitácora del ingeniero/);
  });

  test('E8.10 la planta de test nunca se exporta (RN-06.g)', async () => {
    await limpiarFixtures();
    await seedSala({ planta: TEST_PLANTA, hora: '13:00', detalle: `${TEST_TAG} evento de planta de test` });

    // Con las plantas POR DEFECTO, o sea el camino de producción.
    const dias = await armarMes(db, { mes: MES });
    assert.equal(
      todasLasFilas(dias).filter((f) => f.asiento.includes(TEST_TAG)).length, 0,
      'ninguna fila de TST llega al libro',
    );
    assert.ok(!PLANTAS_F03.includes(TEST_PLANTA), 'TST fuera del alcance del libro');
    assert.ok(!PLANTAS_F03.includes(TEST_PLANTA_REFLEJO), 'TSR fuera del alcance del libro');
  });

  test('E8.11 el mes con el día de HOY une registro_activo e histórico sin duplicar días', async () => {
    await limpiarFixtures();
    // RN-06.d: el día en curso vive en `registro_activo` y los cerrados en `registro_historico`.
    const hoyBogota = fechaBogotaStr(Date.now());
    const mesEnCurso = hoyBogota.slice(0, 7);
    const diaCerrado = `${mesEnCurso}-01`;

    await seedSala({ fecha: hoyBogota, hora: '09:00', detalle: 'Vive en registro_activo' });
    await seedSala({ fecha: diaCerrado, hora: '09:00', detalle: 'Vive en el histórico', historico: true });

    const dias = await armarMes(db, { mes: mesEnCurso, ...soloFixture });
    assert.equal(new Set(dias.map((d) => d.fecha)).size, dias.length, 'ningún día duplicado');
    assert.equal(
      todasLasFilas(dias).filter((f) => /Vive en registro_activo/.test(f.asiento)).length, 1,
      'el día de hoy sale completo',
    );
    assert.equal(
      todasLasFilas(dias).filter((f) => /Vive en el histórico/.test(f.asiento)).length, 1,
      'el día cerrado sale del histórico',
    );
  });
});

// ── Encabezado de cada bloque ─────────────────────────────────────────────────────────────────

describe('D-058 E8 — encabezado JEFE / INGENIERO DE TURNO', () => {
  test('E8.12 turno CERRADO → los nombres salen de conformacion_turno', async () => {
    await limpiarFixtures();
    await seedConformacion({ fecha_operativa: DIA, turno: 1, nombre: 'Ana Torres', cargo: 'Ingeniero Jefe de Turno', persona: 0 });
    await seedConformacion({ fecha_operativa: DIA, turno: 1, nombre: 'Luis Zapata', cargo: 'Ingeniero de Operación', persona: 1 });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.equal(bloques[1].jefe, 'Ana Torres');
    assert.equal(bloques[1].ingenieros, 'Luis Zapata');
  });

  test('E8.13 turno ABIERTO (sin conformación) → los nombres salen de turno_participante', async () => {
    await limpiarFixtures();
    await seedParticipante({ fecha_operativa: DIA, turno: 1, nombre: 'Ana Torres', cargo: 'Ingeniero Jefe de Turno' });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.equal(bloques[1].jefe, 'Ana Torres', 'la presencia viva completa lo que el cierre todavía no congeló');
  });

  test('E8.14 unión DEDUPLICADA de las dos unidades: el mismo JdT da UN nombre', async () => {
    await limpiarFixtures();
    // La MISMA persona (mismo `usuario_id`, mismo nombre) fue JdT de las DOS unidades.
    for (const planta of [TEST_PLANTA_REFLEJO, TEST_PLANTA]) {
      await seedConformacion({ planta, fecha_operativa: DIA, turno: 1, nombre: 'Ana Torres', cargo: 'Ingeniero Jefe de Turno', persona: 0 });
    }
    await seedConformacion({ planta: TEST_PLANTA_REFLEJO, fecha_operativa: DIA, turno: 1, nombre: 'Luis Zapata', cargo: 'Ingeniero de Operación', persona: 1 });
    await seedConformacion({ planta: TEST_PLANTA, fecha_operativa: DIA, turno: 1, nombre: 'Jose Saavedra', cargo: 'Ingeniero de Operación', persona: 2 });

    const dias = await armarMes(db, {
      mes: MES, plantas: [TEST_PLANTA_REFLEJO, TEST_PLANTA], incluirSinteticos: true,
    });
    const bloque = dia(dias, DIA).bloques[1];
    assert.equal(bloque.jefe, 'Ana Torres', 'un solo nombre, sin etiquetar la unidad');
    assert.equal(bloque.ingenieros, 'Jose Saavedra - Luis Zapata', 'unidos por guion corto, como el papel');
  });

  test('E8.15 el bloque 00:00-06:00 del día F toma el turno 2 del día F-1', async () => {
    await limpiarFixtures();
    await seedConformacion({ fecha_operativa: '2026-02-14', turno: 2, nombre: 'Ana Torres', cargo: 'Ingeniero Jefe de Turno' });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.equal(bloques[0].jefe, 'Ana Torres', 'la cola del T2 que arrancó ayer');
    assert.equal(bloques[1].jefe, '');
    assert.equal(bloques[2].jefe, '');
  });

  test('E8.16 sin conformación ni presencia, la celda va EN BLANCO (no se inventa un nombre)', async () => {
    await limpiarFixtures();
    await seedSala({ hora: '09:00', detalle: 'Turno sin registro de personal' });

    const bloques = dia(await armarMes(db, { mes: MES, ...soloFixture }), DIA).bloques;
    assert.equal(bloques[1].filas.length, 1);
    assert.equal(bloques[1].jefe, '');
    assert.equal(bloques[1].ingenieros, '');
  });

  test('E8.17 los usuarios sintéticos quedan fuera del encabezado en el camino de producción', async () => {
    await limpiarFixtures();
    await seedConformacion({ fecha_operativa: DIA, turno: 1, nombre: 'Fixture Sintetico', cargo: 'Ingeniero Jefe de Turno' });

    // Sin el escape hatch — que es lo único que hace producción (D-044).
    const dias = await armarMes(db, { mes: MES, plantas: [TEST_PLANTA_REFLEJO] });
    assert.equal(dia(dias, DIA).bloques[1].jefe, '', 'un fixture jamás se nombra en el formato controlado');
  });
});

// ── Forma del mes ─────────────────────────────────────────────────────────────────────────────

describe('D-058 E8 — forma del resultado', () => {
  test('E8.18 un mes sin eventos devuelve todos sus días con los tres bloques vacíos', async () => {
    await limpiarFixtures();
    const dias = await armarMes(db, { mes: MES, ...soloFixture });

    assert.equal(dias.length, 28, 'febrero de 2026 tiene 28 días y todos llevan hoja (RQ-06.8)');
    assert.equal(dias[0].fecha, '2026-02-01');
    assert.equal(dias[27].fecha, '2026-02-28');
    for (const d of dias) {
      assert.equal(d.bloques.length, BLOQUES.length);
      for (const b of d.bloques) {
        assert.deepEqual(b.filas, []);
        assert.equal(b.jefe, '');
        assert.equal(b.ingenieros, '');
      }
    }
  });

  test('E8.19 un mes de 31 días trae 31 hojas y ninguna repetida', async () => {
    const dias = await armarMes(db, { mes: '2026-01', ...soloFixture });
    assert.equal(dias.length, 31);
    assert.equal(new Set(dias.map((d) => d.fecha)).size, 31);
  });

  test('E8.20 un mes mal formado se rechaza en el módulo, no se adivina', async () => {
    for (const mes of [undefined, '', '2026', '2026-13', '2026-00', '2026-1', 'abc']) {
      await assert.rejects(() => armarMes(db, { mes }), TypeError, `debería rechazar ${mes}`);
    }
  });

  test('E8.21 la lectura no escribe nada (RN-06.f)', async () => {
    await limpiarFixtures();
    await seedLote({ hora: '09:00', periodos: [10], valor_mw: 100 });
    const antes = await conteos();
    await armarMes(db, { mes: MES, ...soloFixture });
    assert.deepEqual(await conteos(), antes, 'armarMes es de solo lectura');
  });
});

async function conteos() {
  const r = await db.request()
    .input('fixture', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM bitacora.registro_activo WHERE planta_id = @fixture)       AS activos,
        (SELECT COUNT(*) FROM bitacora.registro_historico WHERE planta_id = @fixture)    AS historicos,
        (SELECT COUNT(*) FROM bitacora.disponibilidad_estado WHERE planta_id = @fixture) AS disp,
        (SELECT COUNT(*) FROM bitacora.conformacion_turno WHERE planta_id = @fixture)    AS conformacion
    `);
  return r.recordset[0];
}
