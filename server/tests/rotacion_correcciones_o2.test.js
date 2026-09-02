// D-065 · L12 — verificadores de las correcciones de la O2 (`/code-review`, CR2-1 … CR2-15).
//
// Un caso por hallazgo, TODOS bidireccionales: rojo contra el código de la O2, verde con el arreglo.
// El detalle de cada rojo (salida literal) está en `prompts/D-065-rotacion-turnos/cierres/L12.md`.
//
// Reglas de fixture (D-030/D-055): la suite corre contra la BD del `.env`, así que todo lo que se
// escribe va sobre la planta-fixture 'TST', con usuarios `test_rot_l12_*` (`es_sintetico = 1`) y
// oids del namespace `00000000-d065-4012-…`. El patrón que siembra vive en una ventana ENTERA EN EL
// PASADO y sobre cargos que ninguna otra suite usa: un patrón activo que cubra hoy sobre un cargo
// real es exactamente el defecto CR2-5 que este archivo también vigila.
//
// Los módulos que este lote ESTRENA (`nuevoPresupuesto429`) se leen por import de namespace, no por
// import nombrado: un nombre que todavía no existe rompe el enlace del módulo entero en ESM y el
// archivo no cargaría, así que el "rojo previo" saldría como un error de carga en vez de como el
// caso que falla.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import { initDB, getDB, TEST_PLANTA_ID } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { getTurnoColombia, fechaBogotaStr } from '../utils/turno.js';
import { abrirTurnoSiFalta } from '../utils/turno-entidad.js';
import { titularesDeTurno } from '../utils/rotacion/titulares.js';
import { parsearVector } from '../utils/rotacion/patron.js';
import { sincronizarDirectorio, leerDirectorioEntra } from '../utils/graph/directorio.js';
import * as graphCliente from '../utils/graph/cliente.js';
import { call, deactivateSyntheticSessions } from './helpers.js';

const P = TEST_PLANTA_ID;
const HOY = fechaBogotaStr(new Date());

// Cargos de la fixture: reales (los flags de la matriz son los que se prueban) pero SIN patrón en
// ninguna otra suite, para que dos archivos no choquen contra UQ_rotacion_patron_natural_activo.
const CARGO_ROL = 'Operador de Planta - Planta de Agua';
const CARGO_ROL_2 = 'Operador de Planta - Caldera';
const CARGO_GERENTE = 'Gerente de Producción';        // puede_configurar_rotacion = 1
const CARGO_JDT = 'Ingeniero Jefe de Turno';          // puede_configurar_rotacion = 0

// Ventana del patrón-fixture: pasada y propia (CR2-5).
const PATRON = { inicio: '2025-09-01', fin: '2025-10-31' };
const VECTOR_T1 = '1,1,3,3,4,4,2,2';
const VECTOR_T2 = '4,2,2,1,1,3,3,4';
// El formato que F37.A4 fija en la BD. Se repite acá a propósito: el test lo declara por su cuenta,
// así que un cambio en el CHECK que afloje el formato se ve como una diferencia, no como un empate.
const VECTOR_LIKE_ESPERADO = '[1-4],[1-4],[1-4],[1-4],[1-4],[1-4],[1-4],[1-4]';
// El LIKE no basta: SQL Server compara con relleno de blancos ANSI y '1,1,3,3,4,4,2,2 ' le da MATCH.
const VECTOR_LARGO_ESPERADO = 15;

const PREFIJO = 'test_rot_l12_';
const LIKE_MIOS = 'test[_]rot[_]l12[_]%';
const OID = (n) => `00000000-d065-4012-8000-${String(n).padStart(12, '0')}`;

const CUENTAS = {
  gerente: { nombre: 'Test Rot L12 Gerente', cargo: CARGO_GERENTE, oid: OID(1) },
  jdt: { nombre: 'Test Rot L12 JdT', cargo: CARGO_JDT, oid: OID(2) },
};
const PERSONAS = [
  { clave: 'p1', nombre: 'Test Rot L12 Persona 1', oid: OID(11) },
  { clave: 'p2', nombre: 'Test Rot L12 Persona 2', oid: OID(12) },
];

let db;
const uid = {};      // clave → usuario_id
const ses = {};      // clave → sesion_id
const cargo = {};    // rol | rol2 | gerente | jdt → { cargo_id, nombre }
let turnoFixture;    // cabecera ABIERTO de 'TST' (fecha_operativa pasada)
let turnoOpuesto;    // el turno de esa cabecera: a propósito, NO el del reloj

const patronesDe = (cargo_id) => db.request().input('c', sql.Int, cargo_id).query(`
  SELECT rotacion_patron_id, CAST(activo AS BIT) AS activo,
         CONVERT(VARCHAR(10), fecha_inicio, 23) AS fecha_inicio,
         CONVERT(VARCHAR(10), fecha_fin, 23) AS fecha_fin
  FROM bitacora.rotacion_patron WHERE cargo_id = @c ORDER BY rotacion_patron_id
`).then((r) => r.recordset);

const filasDe = (usuario_id) => db.request().input('u', sql.Int, usuario_id).query(`
  SELECT rotacion_asignacion_id, cargo_id, grupo,
         CONVERT(VARCHAR(10), vigente_desde, 23) AS vigente_desde,
         CONVERT(VARCHAR(10), vigente_hasta, 23) AS vigente_hasta
  FROM bitacora.rotacion_asignacion WHERE usuario_id = @u ORDER BY vigente_desde, rotacion_asignacion_id
`).then((r) => r.recordset);

// Barrido de la fixture. Cada DELETE lleva su acotador léxicamente al lado (guard D-055): el
// namespace de oids / el prefijo de username para lo que cuelga de usuarios, y la planta-fixture
// para las cabeceras.
async function limpiarFixture() {
  await db.request().query(`
    DECLARE @u TABLE (usuario_id INT PRIMARY KEY);
    INSERT INTO @u
      SELECT usuario_id FROM lov_bit.usuario
       WHERE username LIKE '${LIKE_MIOS}' OR azure_oid LIKE '00000000-d065-4012-%';
    DELETE FROM bitacora.rotacion_asignacion
      WHERE usuario_id IN (SELECT usuario_id FROM @u) OR creado_por IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.rotacion_patron    WHERE creado_por IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.rotacion_control   WHERE usuario_id IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.turno_participante WHERE usuario_id IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.sesion_activa      WHERE usuario_id IN (SELECT usuario_id FROM @u);
    DELETE FROM lov_bit.usuario             WHERE usuario_id IN (SELECT usuario_id FROM @u);
  `);
  await db.request().input('p', sql.VarChar(10), P).query(`
    DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
    DELETE FROM bitacora.rotacion_control      WHERE planta_id = @p;
    UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
    DELETE tp FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
    DELETE FROM bitacora.conformacion_turno WHERE planta_id = @p;
    DELETE FROM bitacora.turno_unidad       WHERE planta_id = @p;
  `);
}

async function crearUsuario({ nombre, oid, clave }) {
  const r = await db.request()
    .input('nombre', sql.VarChar(200), nombre)
    .input('username', sql.VarChar(50), `${PREFIJO}${clave}`)
    .input('oid', sql.VarChar(64), oid)
    .input('pwd', sql.VarChar(200), await hashPassword(randomBytes(24).toString('hex')))
    .query(`
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, azure_oid, azure_tid,
         es_jefe_planta, es_jdt_default, activo, es_sintetico)
      OUTPUT INSERTED.usuario_id
      VALUES (@nombre, @username, NULL, @pwd, @oid, NULL, 0, 0, 1, 1)
    `);
  return r.recordset[0].usuario_id;
}

async function crearSesion(usuario_id, cargo_id) {
  const r = await db.request()
    .input('usuario_id', sql.Int, usuario_id)
    .input('planta_id', sql.VarChar(10), P)
    .input('cargo_id', sql.Int, cargo_id)
    .input('turno', sql.TinyInt, getTurnoColombia())
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);
  return r.recordset[0].sesion_id;
}

const cuerpoPatron = (cargo_id, extra = {}) => ({
  cargo_id,
  fecha_inicio: PATRON.inicio,
  fecha_fin: PATRON.fin,
  vector_t1: VECTOR_T1,
  vector_t2: VECTOR_T2,
  grupo_t1: 1,
  grupo_t2: 4,
  ...extra,
});

before(async () => {
  await initDB();
  db = await getDB();
  await limpiarFixture();

  await db.request().input('planta', sql.VarChar(10), P).query(`
    MERGE lov_bit.planta AS t USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
    WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
  `);

  const { recordset: cargos } = await db.request().query(`
    SELECT cargo_id, nombre, CAST(puede_configurar_rotacion AS BIT) AS flag FROM lov_bit.cargo
  `);
  const porNombre = (n) => cargos.find((c) => c.nombre === n);
  cargo.rol = porNombre(CARGO_ROL);
  cargo.rol2 = porNombre(CARGO_ROL_2);
  cargo.gerente = porNombre(CARGO_GERENTE);
  cargo.jdt = porNombre(CARGO_JDT);
  for (const [k, c] of Object.entries(cargo)) assert.ok(c, `cargo de la fixture '${k}' no existe`);
  assert.equal(cargo.gerente.flag, true, 'F37.A2: el Gerente configura la malla');
  assert.equal(cargo.jdt.flag, false, 'F37.A2: el JdT no configura la malla');

  for (const [clave, c] of Object.entries(CUENTAS)) {
    uid[clave] = await crearUsuario({ ...c, clave });
    ses[clave] = await crearSesion(uid[clave], porNombre(c.cargo).cargo_id);
  }
  for (const p of PERSONAS) uid[p.clave] = await crearUsuario(p);

  // Cabecera ABIERTO de 'TST' con fecha operativa PASADA y un turno que NO es el del reloj: es lo
  // que permite distinguir "turno en curso de la unidad" de "turno del reloj de pared" (CR2-15).
  turnoOpuesto = getTurnoColombia() === 1 ? 2 : 1;
  turnoFixture = await abrirTurnoSiFalta(db, P, turnoOpuesto, PATRON.inicio);
  assert.equal(turnoFixture.estado, 'ABIERTO', 'la fixture necesita la cabecera ABIERTO en TST');

  const health = await call('GET', '/health');
  assert.equal(health.status, 200, `backend en TEST_BASE_URL no responde /health: ${health.status}`);
});

after(async () => {
  await limpiarFixture();
  await deactivateSyntheticSessions();
});

// ═══════════════════ CR2-5 · las fixturas de rotación viven en el pasado ═══════════════════════
//
// Estático a propósito: lo que hay que fijar es una PROPIEDAD DE LAS OTRAS SUITES —que su patrón no
// esté activo hoy— y eso no se puede observar desde acá en tiempo de ejecución, porque cada una
// siembra y limpia dentro de su propia corrida. Lo que sí se puede es leer sus constantes y exigir
// que sigan siendo pasadas: si alguien mueve la ventana hacia adelante, este caso se pone rojo antes
// de que el turno-sweeper congele titulares de fixture en una planta real.

describe('D-065 L12 · CR2-5 · ventanas de fixture ancladas al pasado', () => {
  const leer = (archivo) => readFileSync(new URL(`./${archivo}`, import.meta.url), 'utf8');

  test('rotacion_endpoints: el periodo del patrón termina antes de hoy', () => {
    const src = leer('rotacion_endpoints.test.js');
    const m = src.match(/const PERIODO = \{ inicio: '(\d{4}-\d{2}-\d{2})', fin: '(\d{4}-\d{2}-\d{2})' \}/);
    assert.ok(m, 'no se pudo leer `const PERIODO` de rotacion_endpoints.test.js (¿lo renombraron?)');
    assert.ok(
      m[2] < HOY,
      `el patrón-fixture de rotacion_endpoints está activo hoy (${m[1]} → ${m[2]}, hoy ${HOY}): un cierre `
      + 'de GEC3/GEC32 durante la corrida congelaría a sus titulares sintéticos en planta real (CR2-5)',
    );
  });

  test('rotacion_control: la ventana del patrón termina antes de hoy', () => {
    const src = leer('rotacion_control.test.js');
    const m = src.match(/const PATRON_FIXTURE = \{ inicio: '(\d{4}-\d{2}-\d{2})', fin: '(\d{4}-\d{2}-\d{2})' \}/);
    assert.ok(m, 'no se pudo leer `const PATRON_FIXTURE` de rotacion_control.test.js (¿lo renombraron?)');
    assert.ok(m[2] < HOY, `el patrón-fixture de rotacion_control está activo hoy (${m[1]} → ${m[2]}, hoy ${HOY})`);
  });

  test('esta suite tampoco: su propio patrón vive en el pasado', () => {
    assert.ok(PATRON.fin < HOY, `${PATRON.inicio} → ${PATRON.fin} vs hoy ${HOY}`);
  });
});

// ═══════════════════ CR2-1 y CR2-10(b) · lo que F37.A4 pone en la BD ═══════════════════════════

describe('D-065 L12 · F37.A4 · formato del vector y UNIQUE filtrada', () => {
  test('CR2-1 · los dos CHECK de formato existen y son los de la columna correspondiente', async () => {
    const r = await db.request().query(`
      SELECT c.name AS nombre, c.definition AS definicion, col.name AS columna
      FROM sys.check_constraints c
      LEFT JOIN sys.columns col ON col.object_id = c.parent_object_id AND col.column_id = c.parent_column_id
      WHERE c.parent_object_id = OBJECT_ID('bitacora.rotacion_patron')
        AND c.name IN ('CK_rotacion_patron_vector_t1', 'CK_rotacion_patron_vector_t2')
    `);
    const porNombre = new Map(r.recordset.map((x) => [x.nombre, x]));
    for (const col of ['vector_t1', 'vector_t2']) {
      const ck = porNombre.get(`CK_rotacion_patron_${col}`);
      assert.ok(ck, `falta CK_rotacion_patron_${col} (F37.A4, CR2-1)`);
      assert.equal(ck.columna, col, 'el CHECK cuelga de su propia columna');
      assert.ok(
        ck.definicion.includes(VECTOR_LIKE_ESPERADO),
        `el patrón del CHECK no es el del contrato: ${ck.definicion}`,
      );
      // Comparación sin espacios y en minúsculas: el motor reescribe la definición con sus propios
      // corchetes y paréntesis, y eso varía entre versiones (mismo criterio que rotacion_schema).
      const norm = ck.definicion.replace(/\s+/g, '').toLowerCase();
      assert.ok(
        norm.includes(`datalength([${col}])=(${VECTOR_LARGO_ESPERADO})`),
        'el CHECK necesita la cota de DATALENGTH: con solo el LIKE, un espacio final pasa '
        + `(relleno de blancos ANSI). Definición actual: ${ck.definicion}`,
      );
    }
  });

  test('CR2-1 · un vector malformado ya no entra en la BD (547), y el bueno sí', async () => {
    // Todo dentro de una transacción que se descarta: ni el INSERT bueno queda.
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      const insertar = (v1, v2) => new sql.Request(tx)
        .input('cargo_id', sql.Int, cargo.rol2.cargo_id)
        .input('ini', sql.VarChar(10), '2024-01-01')
        .input('fin', sql.VarChar(10), '2024-12-31')
        .input('v1', sql.VarChar(32), v1)
        .input('v2', sql.VarChar(32), v2)
        .input('creado_por', sql.Int, uid.gerente)
        .query(`
          INSERT INTO bitacora.rotacion_patron
            (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
          VALUES (@cargo_id, CAST(@ini AS DATE), CAST(@fin AS DATE), @v1, @v2, 0, 0, @creado_por)
        `);

      await insertar(VECTOR_T1, VECTOR_T2); // el bueno entra

      for (const [v1, v2, caso] of [
        ['1,1,3', VECTOR_T2, 'menos de ocho grupos'],
        ['1,1,3,3,4,4,2,5', VECTOR_T2, 'un grupo fuera de 1..4'],
        ['1,1,3,3,4,4,2,2 ', VECTOR_T2, 'un espacio de sobra'],
        ['11,3,3,4,4,2,2,1', VECTOR_T2, 'dos dígitos pegados'],
        [VECTOR_T1, 'x,1,1,1,1,1,1,1', 'una letra en el t2'],
      ]) {
        await assert.rejects(
          () => insertar(v1, v2),
          (e) => /CK_rotacion_patron_vector_t[12]/.test(e.message),
          `debería rechazar ${caso}: '${v1}' / '${v2}'`,
        );
      }
    } finally {
      await tx.rollback();
    }
  });

  test('CR2-10(b) · la UNIQUE natural es un índice ÚNICO FILTRADO por activo = 1, y la vieja ya no está', async () => {
    const idx = await db.request().query(`
      SELECT i.name, i.is_unique, i.has_filter, i.filter_definition, i.is_unique_constraint
      FROM sys.indexes i
      WHERE i.object_id = OBJECT_ID('bitacora.rotacion_patron')
        AND i.name = 'UQ_rotacion_patron_natural_activo'
    `);
    const uq = idx.recordset[0];
    assert.ok(uq, 'falta el índice UQ_rotacion_patron_natural_activo (F37.A4, CR2-10)');
    assert.equal(uq.is_unique, true, 'tiene que ser único: dos patrones activos del mismo cargo y fecha no pueden convivir');
    assert.equal(uq.has_filter, true, 'tiene que ser FILTRADO, o desactivar un patrón no libera su fecha de inicio');
    assert.match(String(uq.filter_definition), /\[activo\]\s*=\s*\(1\)/, uq.filter_definition);

    const vieja = await db.request().query(`
      SELECT 1 AS x FROM sys.key_constraints
      WHERE name = 'UQ_rotacion_patron_natural' AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron')
    `);
    assert.equal(vieja.recordset.length, 0, 'la UNIQUE constraint vieja debió reemplazarse: cubría también a los inactivos');
  });

  test('CR2-12 · una constraint con drift preexistente NO tumba initDB: se omite, se denuncia y se reintenta', async () => {
    // El escenario que el pre-vuelo cubre: una fila escrita por fuera de la app que la constraint
    // WITH CHECK no aceptaría. Se arma quitando el CHECK, metiendo la fila mala y volviendo a correr
    // initDB: sin pre-vuelo eso aborta el arranque con un 547 pelado y el server no levanta.
    const bajar = () => db.request().batch(`
      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
                   AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron'))
        ALTER TABLE bitacora.rotacion_patron DROP CONSTRAINT CK_rotacion_patron_vector_t1;
    `);
    const existeCk = async () => (await db.request().query(`
      SELECT 1 AS x FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
        AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron')
    `)).recordset.length === 1;
    // El acotador va en el TEXTO del statement, no solo en el binding: el guard D-055 lo exige
    // léxicamente al lado, y el namespace de oids de fixture no puede alcanzar a nadie real.
    const borrarMalo = () => db.request().query(`
      DELETE FROM bitacora.rotacion_patron
       WHERE creado_por IN (SELECT usuario_id FROM lov_bit.usuario
                             WHERE azure_oid LIKE '00000000-d065-4012-%')`);

    try {
      await bajar();
      await db.request()
        .input('cargo_id', sql.Int, cargo.rol2.cargo_id)
        .input('creado_por', sql.Int, uid.gerente)
        .query(`
          INSERT INTO bitacora.rotacion_patron
            (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
          VALUES (@cargo_id, '2024-01-01', '2024-12-31', 'ROTO', '4,2,2,1,1,3,3,4', 0, 0, @creado_por)
        `);

      await initDB(); // no debe lanzar
      assert.equal(await existeCk(), false, 'con drift, la constraint se omite (no se agrega a la fuerza)');

      await borrarMalo();
      await initDB();
      assert.equal(await existeCk(), true, 'sin drift, el siguiente arranque sí la agrega');
    } finally {
      await borrarMalo();
      await initDB(); // deja la BD como estaba pase lo que pase
    }
  });
});

// ═══════════════════ CR3-5 · el CHECK y el parser dejan de divergir (F37.A5, L13) ══════════════
//
// `parsearVector` tolera espacios alrededor de cada número (lo dice su docstring), así que
// '1, 1, 3, 3, 4, 4, 2, 2' funciona perfecto en runtime. El CHECK de F37.A4 lo rechaza. Con una
// fila así —solo alcanzable por SQL a mano, que es JUSTO el escenario para el que existe el
// CHECK— el pre-vuelo omitía la constraint en cada arranque, para siempre, y F37.A4 no se
// registraba nunca: el invariante de CR2-1 no se instalaba, en silencio, y el remedio impreso
// pedía corregir una fila que no estaba mal.

describe('D-065 L13 · F37.A5 · normalización canónica del vector (CR3-5)', () => {
  const CON_ESPACIOS = '1, 1, 3, 3, 4, 4, 2, 2';
  const CANONICO = '1,1,3,3,4,4,2,2';

  // Sembrar y barrer con el acotador léxicamente al lado (guard D-055): el namespace de oids de
  // la fixture no alcanza a ninguna fila real.
  const sembrar = (v1, v2) => db.request()
    .input('cargo_id', sql.Int, cargo.rol2.cargo_id)
    .input('v1', sql.VarChar(32), v1)
    .input('v2', sql.VarChar(32), v2)
    .input('creado_por', sql.Int, uid.gerente)
    .query(`
      INSERT INTO bitacora.rotacion_patron
        (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
      OUTPUT INSERTED.rotacion_patron_id
      VALUES (@cargo_id, '2024-01-01', '2024-12-31', @v1, @v2, 0, 0, @creado_por)
    `).then((r) => r.recordset[0].rotacion_patron_id);

  const borrarMios = () => db.request().query(`
    DELETE FROM bitacora.rotacion_patron
     WHERE creado_por IN (SELECT usuario_id FROM lov_bit.usuario
                           WHERE azure_oid LIKE '00000000-d065-4012-%')`);

  const bajarCk = () => db.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
                 AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron'))
      ALTER TABLE bitacora.rotacion_patron DROP CONSTRAINT CK_rotacion_patron_vector_t1;
  `);
  const existeCk = async () => (await db.request().query(`
    SELECT 1 AS x FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
      AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron')
  `)).recordset.length === 1;
  const vectoresDe = async (id) => (await db.request().input('id', sql.Int, id).query(`
    SELECT vector_t1, vector_t2 FROM bitacora.rotacion_patron WHERE rotacion_patron_id = @id
  `)).recordset[0];
  const migracion = async (codigo) => (await db.request().input('c', sql.VarChar(20), codigo).query(`
    SELECT 1 AS x FROM bitacora.migracion_aplicada WHERE codigo = @c
  `)).recordset.length === 1;

  test('la mitad del contrato: el motor SÍ acepta el vector con espacios', () => {
    assert.deepEqual(parsearVector(CON_ESPACIOS), [1, 1, 3, 3, 4, 4, 2, 2]);
    assert.deepEqual(parsearVector(CANONICO), [1, 1, 3, 3, 4, 4, 2, 2]);
  });

  test('CR3-5 · el arranque normaliza la fila con espacios y la constraint SÍ se instala', async () => {
    let id;
    try {
      await bajarCk();
      id = await sembrar(CON_ESPACIOS, VECTOR_T2);

      await initDB();

      assert.deepEqual(
        await vectoresDe(id),
        { vector_t1: CANONICO, vector_t2: VECTOR_T2 },
        'F37.A5 tiene que reescribir el vector a su forma canónica con el PROPIO motor',
      );
      assert.equal(await existeCk(), true, 'sin drift real, el pre-vuelo ya no tiene por qué omitir la constraint');
      assert.equal(await migracion('F37.A4'), true, 'F37.A4 tiene que quedar registrada, no omitida para siempre');
      assert.equal(await migracion('F37.A5'), true, 'F37.A5 deja su rastro de auditoría');
    } finally {
      await borrarMios();
      await initDB();
    }
  });

  test('CR3-5 · lo que el motor NO puede leer no se adivina: sigue denunciado y la constraint se omite', async () => {
    let idRoto;
    let idEspacios;
    try {
      await bajarCk();
      idRoto = await sembrar('ROTO', VECTOR_T2);
      idEspacios = await sembrar(CON_ESPACIOS, VECTOR_T2);

      await initDB();

      // La legible se arregla…
      assert.equal((await vectoresDe(idEspacios)).vector_t1, CANONICO);
      // …y la ilegible queda TAL CUAL, con la constraint omitida y su remedio en el log.
      assert.equal((await vectoresDe(idRoto)).vector_t1, 'ROTO', 'normalizar no es adivinar');
      assert.equal(await existeCk(), false, 'con drift REAL la constraint se sigue omitiendo');
    } finally {
      await borrarMios();
      await initDB();
    }
  });
});

// ═══════════════════ CR2-2 · ids fuera de rango o con otra forma → 400, no 500 ═════════════════

describe('D-065 L12 · CR2-2 · validación de ids', () => {
  test('GET /patrones: 2147483648, 1e2, " 12 " y un arreglo salen 400 cargo_invalido', async () => {
    const casos = [
      ['cargo_id=2147483648', 'fuera del rango de INT: lo rechazaba el driver, no la validación'],
      ['cargo_id=1e2', 'notación científica: Number() la acepta, el cliente nunca la escribió'],
      ['cargo_id=%2012%20', 'con espacios alrededor'],
      ['cargo_id=0x10', 'hexadecimal'],
      ['cargo_id[]=7', 'un arreglo (?cargo_id[]=7): Number([7]) da 7 y colaba'],
    ];
    for (const [query, porque] of casos) {
      const r = await call('GET', `/api/rotacion/patrones?${query}`, { sesion_id: ses.jdt });
      assert.equal(r.status, 400, `${query} (${porque}) → ${r.status} ${JSON.stringify(r.data)}`);
      assert.equal(r.data.codigo, 'cargo_invalido', query);
      assert.equal(typeof r.data.mensaje, 'string');
    }
    // Y el id válido sigue pasando, en número y en texto.
    const ok = await call('GET', `/api/rotacion/patrones?cargo_id=${cargo.rol.cargo_id}`, { sesion_id: ses.jdt });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });

  test('GET /titulares: un cargo_id fuera del rango de INT también sale 400 (titulares.js)', async () => {
    const r = await call('GET', `/api/rotacion/titulares?fecha=${PATRON.inicio}&turno=1&cargo_id=2147483648`, { sesion_id: ses.jdt });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.codigo, 'cargo_invalido');
  });

  test('titularesDeTurno rechaza el cargo_id fuera de rango antes de tocar el driver', async () => {
    await assert.rejects(
      () => titularesDeTurno(db, { fechaOperativa: PATRON.inicio, turno: 1, cargo_id: 2147483648 }),
      (e) => e.message === 'cargo_invalido',
    );
  });
});

// ═══════════════════ CR2-10(a) · PATCH /patrones/:id ═══════════════════════════════════════════

describe('D-065 L12 · CR2-10 · corregir una carga anual mal digitada', () => {
  let patronMalo;

  test('el Gerente carga el patrón (con un grupo de arranque equivocado)', async () => {
    const r = await call('POST', '/api/rotacion/patrones', {
      sesion_id: ses.gerente, body: cuerpoPatron(cargo.rol.cargo_id),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    patronMalo = r.data.patron.rotacion_patron_id;
    assert.equal(r.data.patron.activo, true);
  });

  test('sin el flag del cargo, el PATCH responde 403 rotacion_no_autorizado', async () => {
    const r = await call('PATCH', `/api/rotacion/patrones/${patronMalo}`, {
      sesion_id: ses.jdt, body: { activo: false },
    });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.codigo, 'rotacion_no_autorizado');
    assert.equal(r.data.error, 'rotacion_no_autorizado');
    const p = await patronesDe(cargo.rol.cargo_id);
    assert.equal(p[0].activo, true, 'el 403 no escribió nada');
  });

  test('cuerpo y ruta inválidos → 400 con su slug; un id que no existe → 404 patron_no_encontrado', async () => {
    for (const body of [{}, { activo: 'false' }, { activo: 0 }, { activo: null }]) {
      const r = await call('PATCH', `/api/rotacion/patrones/${patronMalo}`, { sesion_id: ses.gerente, body });
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
      assert.equal(r.data.codigo, 'activo_invalido');
    }
    const malo = await call('PATCH', '/api/rotacion/patrones/abc', { sesion_id: ses.gerente, body: { activo: false } });
    assert.equal(malo.status, 400, JSON.stringify(malo.data));
    assert.equal(malo.data.codigo, 'patron_invalido');

    const grande = await call('PATCH', '/api/rotacion/patrones/2147483648', { sesion_id: ses.gerente, body: { activo: false } });
    assert.equal(grande.status, 400, 'un id fuera del rango de INT no puede llegar al driver');
    assert.equal(grande.data.codigo, 'patron_invalido');

    const nohay = await call('PATCH', '/api/rotacion/patrones/2147483647', { sesion_id: ses.gerente, body: { activo: false } });
    assert.equal(nohay.status, 404, JSON.stringify(nohay.data));
    assert.equal(nohay.data.codigo, 'patron_no_encontrado');
  });

  test('desactivar libera la fecha de inicio: el patrón corregido entra con la MISMA fecha y el malo queda en el listado', async () => {
    // Con el patrón activo, reponerlo choca: es el estado del que no había salida.
    const choque = await call('POST', '/api/rotacion/patrones', {
      sesion_id: ses.gerente, body: cuerpoPatron(cargo.rol.cargo_id, { grupo_t1: 3, grupo_t2: 2 }),
    });
    assert.equal(choque.status, 409, JSON.stringify(choque.data));
    assert.equal(choque.data.codigo, 'patron_duplicado');

    const off = await call('PATCH', `/api/rotacion/patrones/${patronMalo}`, {
      sesion_id: ses.gerente, body: { activo: false },
    });
    assert.equal(off.status, 200, JSON.stringify(off.data));
    assert.equal(off.data.patron.rotacion_patron_id, patronMalo);
    assert.equal(off.data.patron.activo, false);
    assert.deepEqual(off.data.patron.vector_t1, [1, 1, 3, 3, 4, 4, 2, 2], 'mismo shape que GET /patrones');

    const bueno = await call('POST', '/api/rotacion/patrones', {
      sesion_id: ses.gerente, body: cuerpoPatron(cargo.rol.cargo_id, { grupo_t1: 3, grupo_t2: 2 }),
    });
    assert.equal(bueno.status, 200, JSON.stringify(bueno.data));
    assert.notEqual(bueno.data.patron.rotacion_patron_id, patronMalo);
    assert.equal(bueno.data.patron.fecha_inicio, PATRON.inicio, 'la misma fecha de inicio que el corregido necesitaba');

    // Los dos siguen en el listado (el histórico de la carga no se borra) y solo uno está activo.
    const listado = await call('GET', `/api/rotacion/patrones?cargo_id=${cargo.rol.cargo_id}`, { sesion_id: ses.jdt });
    assert.equal(listado.status, 200);
    const mios = listado.data.patrones.filter((p) => p.creado_por === uid.gerente);
    assert.equal(mios.length, 2, 'desactivar no borra: el patrón mal cargado sigue visible');
    assert.equal(mios.filter((p) => p.activo).length, 1);

    // Y el desactivado ya no produce titulares: quien manda es el corregido.
    const t = await titularesDeTurno(db, { fechaOperativa: PATRON.inicio, turno: 1, cargo_id: cargo.rol.cargo_id });
    assert.equal(t.length, 1, 'un solo patrón activo → una sola respuesta a "quién debía estar"');
    assert.equal(t[0].grupo, 3, 'el grupo del patrón CORREGIDO (grupo_t1 = 3), no el del malo');
  });

  test('reactivar el que quedó mal choca con el corregido: 409 patron_duplicado y nada cambia', async () => {
    const r = await call('PATCH', `/api/rotacion/patrones/${patronMalo}`, {
      sesion_id: ses.gerente, body: { activo: true },
    });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.codigo, 'patron_duplicado');
    const p = await patronesDe(cargo.rol.cargo_id);
    assert.equal(p.filter((x) => x.activo).length, 1, 'sigue habiendo un solo patrón activo');
    assert.equal(p.find((x) => x.rotacion_patron_id === patronMalo).activo, false);
  });
});

// ═══════════════════ CR2-8 · una fila corrupta no vuelve 500 el listado ════════════════════════

test('CR2-8 · GET /patrones lista aunque una fila tenga el vector corrupto (200, no 500)', async () => {
  // La única forma de tener hoy una fila así es desactivando el CHECK que la impide (F37.A4): es
  // exactamente el estado en el que quedaría una BD migrada DESPUÉS de que alguien metiera la fila
  // mala por SQL. El administrador tiene que poder LISTAR para encontrar cuál es.
  const bajar = () => db.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
                 AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron'))
      ALTER TABLE bitacora.rotacion_patron
        DROP CONSTRAINT CK_rotacion_patron_vector_t1;
  `);
  const subir = () => db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
                     AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron'))
      ALTER TABLE bitacora.rotacion_patron WITH CHECK
        ADD CONSTRAINT CK_rotacion_patron_vector_t1
        CHECK (vector_t1 LIKE '${VECTOR_LIKE_ESPERADO}' AND DATALENGTH(vector_t1) = ${VECTOR_LARGO_ESPERADO});
  `);
  const borrar = () => db.request().query(`
    DELETE FROM bitacora.rotacion_patron
     WHERE creado_por IN (SELECT usuario_id FROM lov_bit.usuario
                           WHERE azure_oid LIKE '00000000-d065-4012-%')`);

  // Se restaura EXACTAMENTE el estado previo: si la constraint no estaba (una BD sin F37.A4), este
  // caso no la deja creada de contrabando — el estado del catálogo lo decide la migración, no un test.
  const existiaAntes = (await db.request().query(`
    SELECT 1 AS x FROM sys.check_constraints WHERE name = 'CK_rotacion_patron_vector_t1'
      AND parent_object_id = OBJECT_ID('bitacora.rotacion_patron')
  `)).recordset.length === 1;

  let idCorrupto;
  try {
    await bajar();
    const ins = await db.request()
      .input('cargo_id', sql.Int, cargo.rol2.cargo_id)
      .input('creado_por', sql.Int, uid.p1)
      .query(`
        INSERT INTO bitacora.rotacion_patron
          (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
        OUTPUT INSERTED.rotacion_patron_id
        VALUES (@cargo_id, '2024-02-01', '2024-11-30', 'ROTO', '4,2,2,1,1,3,3,4', 0, 1, @creado_por)
      `);
    idCorrupto = ins.recordset[0].rotacion_patron_id;

    const r = await call('GET', '/api/rotacion/patrones', { sesion_id: ses.jdt });
    assert.equal(r.status, 200, `una sola fila mala no puede volver 500 el listado: ${JSON.stringify(r.data)}`);
    const mala = r.data.patrones.find((p) => p.rotacion_patron_id === idCorrupto);
    assert.ok(mala, 'la fila corrupta SALE en el listado: es la que el administrador tiene que encontrar');
    assert.equal(mala.vector_invalido, true, 'y viene marcada');
    assert.equal(mala.grupo_t1, null);
    // Las sanas del mismo listado conservan su shape exacto, sin la marca.
    const sana = r.data.patrones.find((p) => p.rotacion_patron_id !== idCorrupto && p.creado_por === uid.gerente);
    assert.ok(Array.isArray(sana.vector_t1) && sana.vector_t1.length === 8);
    assert.equal(sana.vector_invalido, undefined, 'una fila sana no gana claves nuevas');
  } finally {
    await borrar();
    if (existiaAntes) await subir();
  }
});

// ═══════════════════ CR2-3 y CR2-11 · asignaciones ═════════════════════════════════════════════

describe('D-065 L12 · asignaciones', () => {
  const asignar = (body) => call('POST', '/api/rotacion/asignaciones', { sesion_id: ses.gerente, body });

  test('CR2-3 · salir de la rotación el MISMO día en que empieza la asignación la elimina (200), no la rechaza', async () => {
    const alta = await asignar({
      asignaciones: [{ usuario_id: uid.p1, cargo_id: cargo.rol.cargo_id, grupo: 2, vigente_desde: '2025-09-15' }],
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.data));
    assert.equal((await filasDe(uid.p1)).length, 1);

    const salida = await asignar({
      asignaciones: [{ usuario_id: uid.p1, cargo_id: cargo.rol.cargo_id, grupo: null, vigente_desde: '2025-09-15' }],
    });
    assert.equal(
      salida.status, 200,
      `salir el mismo día no es un conflicto: la fila nunca tuvo efecto (CR2-3) → ${JSON.stringify(salida.data)}`,
    );
    assert.deepEqual(salida.data, { creadas: 0, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });
    assert.deepEqual(await filasDe(uid.p1), [], 'la persona queda fuera de la rotación desde ese día, sin fantasma');
  });

  test('CR2-11 · un relevo ACOTADO repone la cola: al terminar la suplencia la persona vuelve a su grupo', async () => {
    const alta = await asignar({
      asignaciones: [{ usuario_id: uid.p2, cargo_id: cargo.rol.cargo_id, grupo: 1, vigente_desde: '2025-09-01' }],
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.data));

    const relevo = await asignar({
      asignaciones: [{
        usuario_id: uid.p2, cargo_id: cargo.rol.cargo_id, grupo: 3,
        vigente_desde: '2025-09-10', vigente_hasta: '2025-09-20',
      }],
    });
    assert.equal(relevo.status, 200, JSON.stringify(relevo.data));
    assert.deepEqual(relevo.data, { creadas: 2, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });

    const filas = await filasDe(uid.p2);
    assert.equal(filas.length, 3, 'la original truncada, la suplencia y la continuación');
    assert.deepEqual(
      filas.map((f) => [f.grupo, f.vigente_desde, f.vigente_hasta]),
      [
        [1, '2025-09-01', '2025-09-09'],
        [3, '2025-09-10', '2025-09-20'],
        [1, '2025-09-21', '9999-12-31'],
      ],
      'sin la continuación la persona salía de la rotación el 21 de septiembre, en silencio y con un 200',
    );

    // Y se ve donde importa: después de la suplencia sigue siendo titular de su grupo.
    const despues = await call(
      'GET', `/api/rotacion/asignaciones?fecha=2025-10-01&cargo_id=${cargo.rol.cargo_id}`,
      { sesion_id: ses.jdt },
    );
    assert.equal(despues.status, 200);
    const mia = despues.data.asignaciones.find((a) => a.usuario_id === uid.p2);
    assert.ok(mia, 'p2 sigue vigente después de la ventana del relevo');
    assert.equal(mia.grupo, 1);
  });

  test('un relevo de vigencia ABIERTA no repone nada (no hay cola que devolver)', async () => {
    const r = await asignar({
      asignaciones: [{ usuario_id: uid.p2, cargo_id: cargo.rol.cargo_id, grupo: 4, vigente_desde: '2025-10-05' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { creadas: 1, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });
    const ultima = (await filasDe(uid.p2)).at(-1);
    assert.deepEqual([ultima.grupo, ultima.vigente_desde, ultima.vigente_hasta], [4, '2025-10-05', '9999-12-31']);
  });
});

// ═══════════════════ CR2-15 · el turno en curso sale de la cabecera, no del reloj ══════════════

test('CR2-15 · GET /titulares sin fecha ni turno usa el turno ABIERTO de la unidad, con una sola lectura del reloj', async () => {
  const r = await call('GET', '/api/rotacion/titulares', { sesion_id: ses.jdt });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(
    r.data.fecha, PATRON.inicio,
    'la fecha operativa es la de la cabecera ABIERTO de la unidad, no el día de hoy',
  );
  assert.equal(
    r.data.turno, turnoOpuesto,
    `el turno es el de la cabecera (${turnoOpuesto}), no el del reloj de pared (${getTurnoColombia()}): `
    + 'durante una extensión (D-046) son distintos, y /control/estado y /cumplimiento leen la cabecera',
  );
  assert.equal(r.data.planta_id, P);

  // Con fecha y turno explícitos manda el cliente, como siempre.
  const explicito = await call('GET', `/api/rotacion/titulares?fecha=2025-09-05&turno=1`, { sesion_id: ses.jdt });
  assert.equal(explicito.status, 200);
  assert.equal(explicito.data.fecha, '2025-09-05');
  assert.equal(explicito.data.turno, 1);
});

// ═══════════════════ CR2-4, CR2-9, CR2-13, CR2-14 · Graph ══════════════════════════════════════

describe('D-065 L12 · cliente y directorio de Graph', () => {
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const CLIENTE = '66666666-7777-8888-9999-000000000000';
  const SP_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const ROLE_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
  const guid = (n) => `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const envPrevio = {};

  function ponerCredenciales() {
    for (const k of ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET']) envPrevio[k] = process.env[k];
    process.env.M365_TENANT_ID = TENANT;
    process.env.M365_CLIENT_ID = CLIENTE;
    process.env.M365_CLIENT_SECRET = 'secreto-de-fixture';
    graphCliente.limpiarCacheToken();
  }
  function restaurarEnv() {
    for (const [k, v] of Object.entries(envPrevio)) {
      if (v === undefined) delete process.env[k]; // asignar undefined deja el STRING "undefined"
      else process.env[k] = v;
    }
    graphCliente.limpiarCacheToken();
  }

  const json = (cuerpo, init = {}) => new Response(JSON.stringify(cuerpo), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });

  // `grupos` = [{ id, miembros: n, falla?: true }]; `usuarios` = [{ id, falla?: true }].
  function armarFetch({ grupos = [], usuarios = [] }) {
    let contadorPersona = 0;
    const idsGrupo = new Map(grupos.map((g) => [g.id, g]));
    const idsUsuario = new Map(usuarios.map((u) => [u.id, u]));
    const asignaciones = [
      ...grupos.map((g) => ({
        appRoleId: ROLE_ID, principalId: g.id, principalType: 'Group', principalDisplayName: `GRUPO ${g.id.slice(-1)}`,
      })),
      ...usuarios.map((u) => ({
        appRoleId: ROLE_ID, principalId: u.id, principalType: 'User', principalDisplayName: 'Directo',
      })),
    ];
    return async (url) => {
      const u = String(url);
      if (u.includes('login.microsoftonline.com')) return json({ access_token: 'tok', expires_in: 3600 });
      if (u.includes('/servicePrincipals?')) {
        return json({ value: [{ id: SP_ID, displayName: 'App', appRoles: [{ id: ROLE_ID, value: 'OPERADOR_PLANTA_SDM' }] }] });
      }
      if (u.includes('/appRoleAssignedTo')) return json({ value: asignaciones });
      const g = [...idsGrupo.keys()].find((id) => u.includes(`/groups/${id}/`));
      if (g) {
        if (idsGrupo.get(g).falla) return json({ error: 'nope' }, { status: 404 });
        return json({
          value: Array.from({ length: idsGrupo.get(g).miembros }, () => {
            contadorPersona += 1;
            return {
              id: guid(contadorPersona),
              displayName: `Persona Graph ${contadorPersona}`,
              userPrincipalName: `test_rot_l12_graph_${contadorPersona}@fixture.local`,
              accountEnabled: true,
            };
          }),
        });
      }
      const usr = [...idsUsuario.keys()].find((id) => u.includes(`/users/${id}`));
      if (usr) {
        if (idsUsuario.get(usr).falla) return json({ error: 'nope' }, { status: 404 });
        return json({
          id: usr, displayName: 'Directo Uno', userPrincipalName: 'test_rot_l12_graph_directo@fixture.local', accountEnabled: true,
        });
      }
      return json({ error: 'ruta no prevista en la fixture' }, { status: 500 });
    };
  }

  test('CR2-4 · el umbral cuenta PERSONAS: perder los grupos grandes ya no devuelve un 200 a medias', async () => {
    ponerCredenciales();
    try {
      // Tres grupos + una asignación directa. Se caen DOS grupos, y el que sobrevive tiene 10
      // personas: el umbral viejo (asignaciones) veía "2 de 4" y toleraba, así que respondía 200 con
      // 11 personas cuando debían ser ~31.
      const fetchImpl = armarFetch({
        grupos: [
          { id: guid(901), miembros: 10 },
          { id: guid(902), falla: true },
          { id: guid(903), falla: true },
        ],
        usuarios: [{ id: guid(904) }],
      });
      await assert.rejects(
        () => leerDirectorioEntra({ fetchImpl }),
        (e) => e.codigo === 'entra_no_disponible' && /2 de 4/.test(e.message) && /personas/.test(e.message),
        'dos grupos grandes caídos no son "un directorio con huecos": es Graph fallando',
      );
    } finally {
      restaurarEnv();
    }
  });

  test('CR2-4 · una omisión menor se sigue tolerando, y `omitidas` viaja en el resultado', async () => {
    ponerCredenciales();
    try {
      const fetchImpl = armarFetch({
        grupos: [
          { id: guid(911), miembros: 2 },
          { id: guid(912), miembros: 2 },
          { id: guid(913), falla: true },
        ],
        usuarios: [{ id: guid(914) }],
      });
      const dir = await leerDirectorioEntra({ fetchImpl });
      assert.equal(dir.personas.length, 5, 'las personas de los grupos leídos y la asignación directa');
      assert.ok(dir.omitidas, 'el resultado reporta lo que se omitió (sin esto el hueco solo vive en el log)');
      assert.deepEqual(dir.omitidas, { total: 1, grupos: 1, usuarios: 0, personas_estimadas: 2 });
    } finally {
      restaurarEnv();
    }
  });

  test('CR2-4 · sincronizarDirectorio propaga `omitidas` hasta su respuesta', async () => {
    const r = await sincronizarDirectorio(db, {
      directorio: {
        personas: [],
        grupos: [],
        omitidas: { total: 3, grupos: 2, usuarios: 1, personas_estimadas: 9 },
      },
    });
    assert.deepEqual(r.omitidas, { total: 3, grupos: 2, usuarios: 1, personas_estimadas: 9 });
    // Y un directorio inyectado sin el campo no rompe: cero omisiones.
    const sin = await sincronizarDirectorio(db, { directorio: { personas: [], grupos: [] } });
    assert.deepEqual(sin.omitidas, { total: 0, grupos: 0, usuarios: 0, personas_estimadas: 0 });
  });

  test('CR2-9 · un displayName vacío en Graph NO pisa el nombre que la BD ya tiene', async () => {
    const antes = await db.request().input('u', sql.Int, uid.p1)
      .query('SELECT nombre_completo FROM lov_bit.usuario WHERE usuario_id = @u');
    const nombreBueno = antes.recordset[0].nombre_completo;
    assert.equal(nombreBueno, PERSONAS[0].nombre);

    await sincronizarDirectorio(db, {
      directorio: {
        personas: [{
          azure_oid: PERSONAS[0].oid, nombre: '   ', upn: 'test_rot_l12_p1@fixture.local',
          activo: true, role: 'OPERADOR_PLANTA_SDM', cargo_nombre: 'Operador de Planta - Sala de Mando',
        }],
        grupos: [],
      },
    });

    const despues = await db.request().input('u', sql.Int, uid.p1)
      .query('SELECT nombre_completo, azure_upn FROM lov_bit.usuario WHERE usuario_id = @u');
    assert.equal(
      despues.recordset[0].nombre_completo, nombreBueno,
      'con displayName vacío la fila conservaba el nombre… o quedaba con el UPN / el GUID crudo (CR2-9)',
    );
    assert.equal(despues.recordset[0].azure_upn, 'test_rot_l12_p1@fixture.local', 'el UPN sí se actualiza');
  });

  test('CR2-9 · un displayName con contenido sí actualiza el nombre', async () => {
    await sincronizarDirectorio(db, {
      directorio: {
        personas: [{
          azure_oid: PERSONAS[0].oid, nombre: 'Test Rot L12 Persona 1 Renombrada',
          upn: 'test_rot_l12_p1@fixture.local', activo: true, role: 'OPERADOR_PLANTA_SDM', cargo_nombre: null,
        }],
        grupos: [],
      },
    });
    const r = await db.request().input('u', sql.Int, uid.p1)
      .query('SELECT nombre_completo FROM lov_bit.usuario WHERE usuario_id = @u');
    assert.equal(r.recordset[0].nombre_completo, 'Test Rot L12 Persona 1 Renombrada');
  });

  test('CR2-13 · la espera por 429 tiene presupuesto para toda la operación, no por llamada', async () => {
    ponerCredenciales();
    try {
      assert.equal(
        typeof graphCliente.nuevoPresupuesto429, 'function',
        'falta el presupuesto compartido de espera por 429 (CR2-13): con tope solo por llamada, '
        + '16 peticiones podían dormir 10 s cada una dentro de la petición HTTP del administrador',
      );
      const bolsa = graphCliente.nuevoPresupuesto429(1000);
      let llamadas = 0;
      const fetchImpl = async () => {
        llamadas += 1;
        if (llamadas === 1) return json({}, { status: 429, headers: { 'retry-after': '1' } });
        if (llamadas === 2) return json({ ok: true });
        return json({}, { status: 429, headers: { 'retry-after': '1' } });
      };
      const r = await graphCliente.graphGet('/algo', { fetchImpl, token: 'tok', presupuesto: bolsa });
      assert.deepEqual(r, { ok: true }, 'el primer 429 corto sí se reintenta');
      assert.equal(llamadas, 2);
      assert.equal(bolsa.restanteMs, 0, 'y ese reintento consumió el presupuesto de la operación');

      // La siguiente petición de la MISMA operación ya no puede dormir: falla en vez de esperar.
      const t0 = Date.now();
      await assert.rejects(
        () => graphCliente.graphGet('/otra', { fetchImpl, token: 'tok', presupuesto: bolsa }),
        (e) => e.codigo === 'entra_no_disponible' && /429/.test(e.message),
      );
      assert.ok(Date.now() - t0 < 900, 'no esperó: el presupuesto ya estaba agotado');
      assert.equal(llamadas, 3, 'y tampoco reintentó');
    } finally {
      restaurarEnv();
    }
  });

  test('CR2-14 · un cuerpo ya consumido sale como 503 entra_no_disponible, no como un 500 crudo', async () => {
    ponerCredenciales();
    try {
      const resp = json({ value: [] });
      await resp.json(); // el cuerpo queda consumido: getReader() lanzará TypeError
      const r = await assert.rejects(
        () => graphCliente.graphGet('/algo', { fetchImpl: async () => resp, token: 'tok' }),
        (e) => e.codigo === 'entra_no_disponible',
        'todo fallo de esta capa sale con el mismo código; un TypeError suelto termina en 500',
      );
      assert.equal(r, undefined);
    } finally {
      restaurarEnv();
    }
  });
});
