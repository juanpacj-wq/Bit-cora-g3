// D-065 · L02 — Schema del módulo de Rotación de Turnos (`F37.A1`) y flag de cargo (`F37.A2`).
//
// Qué fija este archivo, y por qué cada cosa:
//
//   CA-3 · Las cuatro tablas de `bitacora` existen con sus columnas, tipos, CHECK, UNIQUE, PK e
//          índices EXACTOS del contrato C2 — L04, L05 y L06 los van a escribir tal cual en la O2,
//          así que un nombre distinto no es cosmético: rompe el lote siguiente. Y la migración es
//          IDEMPOTENTE: correr `initDB()` dos veces no falla ni deja dos filas `F37.A1`.
//
//   CA-4 · `puede_configurar_rotacion` vale 1 SOLO para 'Administrador y Debugging' y 'Gerente de
//          Producción', y SOBREVIVE A UN RESTART. Ese "sobrevive" es el corazón del test: la
//          convención 27 documenta que un flag de cargo puesto por un `UPDATE` suelto se revierte
//          al siguiente arranque, porque el MERGE de `db.js` corre en cada boot y su rama
//          WHEN MATCHED es auto-correctora. El caso (b) de abajo pone el flag a mano en un TERCER
//          cargo y comprueba que `initDB()` lo baja a 0: si el flag no estuviera DENTRO del MERGE,
//          ese valor manual sobreviviría y el test se pone rojo.
//
// Escrituras: ninguna sobre datos de operación. La única es el `UPDATE` del caso CA-4(b) sobre
// `lov_bit.cargo` (catálogo, no operación), acotado por `.input()` a un cargo concreto. Ese cargo
// es REAL y no puede ser sintético (L11, CR-5): el MERGE de cargos solo corrige las filas que
// matchean por `nombre` con su tabla de valores, así que un cargo de fixture que no está en esa
// tabla conservaría cualquier flag y el caso no probaría nada. Lo que sí se controla es la
// VENTANA en que el cargo real queda con el flag en 1: el `try/finally` del propio caso lo baja
// aunque un assert falle, el `before()` limpia un residuo de una corrida muerta antes de empezar,
// el `after()` es la última red, y `npm run test:residuos` cuenta cualquier cargo con el flag
// fuera de los dos del contrato. No siembra sesiones, ni registros, ni plantas: nada que limpiar
// en `'TST'`/`TEST_TAG`, y nada que pueda tocar `'GEC3'`/`'GEC32'` (D-055).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB } from '../db.js';

// Los dos cargos que llevan el flag en 1 (contrato §5.1). Todo lo demás va en 0.
const CARGOS_CON_FLAG = ['Administrador y Debugging', 'Gerente de Producción'];

// Cargo usado como conejillo del caso CA-4(b): NO lleva el flag, así que si tras `initDB()` sigue
// en 1, el flag no está en el MERGE. Se elige uno estable del catálogo de 14.
const CARGO_CONEJILLO = 'Ingeniero Químico';

/** Baja el flag del conejillo. Acotado por `.input()` a UN cargo: nunca un UPDATE sin WHERE. */
async function bajarFlagConejillo(pool) {
  await pool.request()
    .input('nombre', sql.VarChar(100), CARGO_CONEJILLO)
    .query(`
      UPDATE lov_bit.cargo SET puede_configurar_rotacion = 0
      WHERE nombre = @nombre AND puede_configurar_rotacion = 1;
    `);
}

/** Flag actual del conejillo, como entero. */
async function flagConejillo(pool) {
  const r = await pool.request()
    .input('nombre', sql.VarChar(100), CARGO_CONEJILLO)
    .query(`
      SELECT CAST(puede_configurar_rotacion AS INT) AS flag
      FROM lov_bit.cargo WHERE nombre = @nombre
    `);
  return r.recordset[0]?.flag;
}

const TABLAS = [
  'rotacion_patron',
  'rotacion_asignacion',
  'rotacion_control',
  'rotacion_cumplimiento',
];

let db;
let columnas;   // Map 'tabla.columna' → { tipo, nullable, longitud }
let computadas; // Map 'tabla.columna' → definición
let checks;     // Map nombre → { tabla, definicion }
let indices;    // Map nombre → { tabla, clave: [...], incluidas: [...] }
let claves;     // Map nombre → { tabla, tipo, columnas: [...] }

// Normaliza la definición que devuelve SQL Server: la reescribe con corchetes y paréntesis propios
// y con espacios que varían entre versiones. Comparar sin espacios es estable y sigue siendo
// específico (un `<=(5)` en vez de `<=(4)` no pasa desapercibido).
const norm = (def) => String(def).replace(/\s+/g, '');

// Extrae los literales de texto de un CHECK `IN (...)` ya normalizado por el motor.
const literales = (def) => [...String(def).matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();

before(async () => {
  assert.notEqual(
    process.env.SKIP_INITDB, '1',
    'este test EXIGE el initDB real (aplica F37.A1/F37.A2). Con SKIP_INITDB=1 no hay DDL que verificar.'
  );

  await initDB();
  db = await getDB();
  // Residuo de una corrida muerta a mitad del caso 14: se limpia ANTES de empezar (L11, CR-5).
  await bajarFlagConejillo(db);

  const cols = await db.request().query(`
    SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, DATA_TYPE AS tipo,
           IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS longitud
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'bitacora' AND TABLE_NAME LIKE 'rotacion_%'
  `);
  columnas = new Map(cols.recordset.map((c) => [`${c.tabla}.${c.columna}`, c]));

  const comp = await db.request().query(`
    SELECT t.name AS tabla, c.name AS columna, c.definition AS definicion
    FROM sys.computed_columns c
    INNER JOIN sys.tables t  ON t.object_id = c.object_id
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'bitacora' AND t.name LIKE 'rotacion_%'
  `);
  computadas = new Map(comp.recordset.map((c) => [`${c.tabla}.${c.columna}`, c.definicion]));

  const cks = await db.request().query(`
    SELECT k.name AS nombre, t.name AS tabla, k.definition AS definicion
    FROM sys.check_constraints k
    INNER JOIN sys.tables t  ON t.object_id = k.parent_object_id
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'bitacora' AND t.name LIKE 'rotacion_%'
  `);
  checks = new Map(cks.recordset.map((k) => [k.nombre, k]));

  const idx = await db.request().query(`
    SELECT i.name AS indice, t.name AS tabla, c.name AS columna,
           ic.key_ordinal AS orden, ic.is_included_column AS incluida
    FROM sys.indexes i
    INNER JOIN sys.tables t         ON t.object_id = i.object_id
    INNER JOIN sys.schemas s        ON s.schema_id = t.schema_id
    INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    INNER JOIN sys.columns c        ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE s.name = 'bitacora' AND t.name LIKE 'rotacion_%'
    ORDER BY i.name, ic.is_included_column, ic.key_ordinal, c.name
  `);
  indices = new Map();
  for (const r of idx.recordset) {
    if (!indices.has(r.indice)) indices.set(r.indice, { tabla: r.tabla, clave: [], incluidas: [] });
    const e = indices.get(r.indice);
    (r.incluida ? e.incluidas : e.clave).push(r.columna);
  }

  const kcs = await db.request().query(`
    SELECT k.name AS nombre, t.name AS tabla, k.type AS tipo, c.name AS columna, ic.key_ordinal AS orden
    FROM sys.key_constraints k
    INNER JOIN sys.tables t         ON t.object_id = k.parent_object_id
    INNER JOIN sys.schemas s        ON s.schema_id = t.schema_id
    INNER JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id
    INNER JOIN sys.columns c        ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE s.name = 'bitacora' AND t.name LIKE 'rotacion_%'
    ORDER BY k.name, ic.key_ordinal
  `);
  claves = new Map();
  for (const r of kcs.recordset) {
    if (!claves.has(r.nombre)) claves.set(r.nombre, { tabla: r.tabla, tipo: r.tipo.trim(), columnas: [] });
    claves.get(r.nombre).columnas.push(r.columna);
  }
});

after(async () => {
  // Última red del caso CA-4(b): si el proceso murió entre el UPDATE y el `finally`, el conejillo
  // podría haber quedado con el flag en 1.
  await bajarFlagConejillo(await getDB());
});

// ───────────────────────────── CA-3 · F37.A1 ─────────────────────────────

test('F37.A1 · 1. las cuatro tablas de rotación existen en el esquema bitacora', () => {
  for (const t of TABLAS) {
    const tiene = [...columnas.keys()].some((k) => k.startsWith(`${t}.`));
    assert.ok(tiene, `falta la tabla bitacora.${t} (contrato C2)`);
  }
});

test('F37.A1 · 2. rotacion_patron: columnas, tipos y nulabilidad del contrato', () => {
  const esperado = {
    rotacion_patron_id: ['int', 'NO', null],
    cargo_id:           ['int', 'NO', null],
    fecha_inicio:       ['date', 'NO', null],
    fecha_fin:          ['date', 'NO', null],
    vector_t1:          ['varchar', 'NO', 32],
    vector_t2:          ['varchar', 'NO', 32],
    desfase:            ['tinyint', 'NO', null],
    activo:             ['bit', 'NO', null],
    creado_por:         ['int', 'NO', null],
    creado_en:          ['datetime2', 'NO', null],
  };
  for (const [col, [tipo, nullable, longitud]] of Object.entries(esperado)) {
    const c = columnas.get(`rotacion_patron.${col}`);
    assert.ok(c, `falta rotacion_patron.${col}`);
    assert.equal(c.tipo, tipo, `rotacion_patron.${col}: tipo`);
    assert.equal(c.nullable, nullable, `rotacion_patron.${col}: nulabilidad`);
    if (longitud !== null) assert.equal(c.longitud, longitud, `rotacion_patron.${col}: longitud`);
  }
});

test('F37.A1 · 3. rotacion_asignacion: columnas, tipos y nulabilidad del contrato', () => {
  const esperado = {
    rotacion_asignacion_id: ['int', 'NO', null],
    usuario_id:             ['int', 'NO', null],
    cargo_id:               ['int', 'NO', null],
    grupo:                  ['tinyint', 'NO', null],
    vigente_desde:          ['date', 'NO', null],
    vigente_hasta:          ['date', 'NO', null],
    creado_por:             ['int', 'NO', null],
    creado_en:              ['datetime2', 'NO', null],
  };
  for (const [col, [tipo, nullable, longitud]] of Object.entries(esperado)) {
    const c = columnas.get(`rotacion_asignacion.${col}`);
    assert.ok(c, `falta rotacion_asignacion.${col}`);
    assert.equal(c.tipo, tipo, `rotacion_asignacion.${col}: tipo`);
    assert.equal(c.nullable, nullable, `rotacion_asignacion.${col}: nulabilidad`);
    if (longitud !== null) assert.equal(c.longitud, longitud, `rotacion_asignacion.${col}: longitud`);
  }
});

test('F37.A1 · 4. rotacion_control: columnas, tipos y nulabilidad del contrato', () => {
  const esperado = {
    rotacion_control_id: ['int', 'NO', null],
    turno_id:            ['int', 'NO', null],
    planta_id:           ['varchar', 'NO', 10],
    cargo_id:            ['int', 'NO', null],
    usuario_id:          ['int', 'NO', null],
    accion:              ['varchar', 'NO', 12],
    ocurrido_en:         ['datetime2', 'NO', null],
  };
  for (const [col, [tipo, nullable, longitud]] of Object.entries(esperado)) {
    const c = columnas.get(`rotacion_control.${col}`);
    assert.ok(c, `falta rotacion_control.${col}`);
    assert.equal(c.tipo, tipo, `rotacion_control.${col}: tipo`);
    assert.equal(c.nullable, nullable, `rotacion_control.${col}: nulabilidad`);
    if (longitud !== null) assert.equal(c.longitud, longitud, `rotacion_control.${col}: longitud`);
  }
});

test('F37.A1 · 5. rotacion_cumplimiento: columnas, tipos y nulabilidad del contrato', () => {
  const esperado = {
    fecha_operativa:   ['date', 'NO', null],
    planta_id:         ['varchar', 'NO', 10],
    turno:             ['tinyint', 'NO', null],
    cargo_id:          ['int', 'NO', null],
    cargo_nombre:      ['varchar', 'NO', 100],
    grupo:             ['tinyint', 'YES', null],   // NULL = el rol no tenía patrón ese día
    estado:            ['varchar', 'NO', 20],
    titulares_json:    ['nvarchar', 'NO', -1],     // -1 = MAX
    relevo_usuario_id: ['int', 'YES', null],
    turno_id:          ['int', 'NO', null],
    snapshot_en:       ['datetime2', 'NO', null],
  };
  for (const [col, [tipo, nullable, longitud]] of Object.entries(esperado)) {
    const c = columnas.get(`rotacion_cumplimiento.${col}`);
    assert.ok(c, `falta rotacion_cumplimiento.${col}`);
    assert.equal(c.tipo, tipo, `rotacion_cumplimiento.${col}: tipo`);
    assert.equal(c.nullable, nullable, `rotacion_cumplimiento.${col}: nulabilidad`);
    if (longitud !== null) assert.equal(c.longitud, longitud, `rotacion_cumplimiento.${col}: longitud`);
  }
});

test('F37.A1 · 6. las columnas *_bogota son CALCULADAS con el shift -5 canónico (D-020)', () => {
  const esperado = {
    'rotacion_patron.creado_en_bogota':        'creado_en',
    'rotacion_asignacion.creado_en_bogota':    'creado_en',
    'rotacion_control.ocurrido_en_bogota':     'ocurrido_en',
    'rotacion_cumplimiento.snapshot_en_bogota': 'snapshot_en',
  };
  for (const [clave, origen] of Object.entries(esperado)) {
    const def = computadas.get(clave);
    assert.ok(def, `${clave} debe existir y ser una columna CALCULADA, no almacenada`);
    const d = norm(def).toLowerCase();
    assert.ok(
      d.includes('dateadd(hour,(-5)') || d.includes('dateadd(hour,-5'),
      `${clave}: la presentación Bogotá se hace con DATEADD(HOUR, -5, …); definición real: ${def}`
    );
    assert.ok(d.includes(`[${origen}]`), `${clave} debe derivar de ${origen}; definición real: ${def}`);
  }
});

test('F37.A1 · 7. los CHECK con nombre del contrato existen sobre su tabla', () => {
  const esperado = {
    CK_rotacion_patron_desfase:  'rotacion_patron',
    CK_rotacion_patron_rango:    'rotacion_patron',
    CK_rotacion_asig_grupo:      'rotacion_asignacion',
    CK_rotacion_asig_rango:      'rotacion_asignacion',
    CK_rotacion_control_accion:  'rotacion_control',
    CK_rotacion_cumpl_turno:     'rotacion_cumplimiento',
    CK_rotacion_cumpl_estado:    'rotacion_cumplimiento',
    CK_rotacion_cumpl_grupo:     'rotacion_cumplimiento',   // F37.A3 (L11, CR-9)
  };
  for (const [nombre, tabla] of Object.entries(esperado)) {
    const k = checks.get(nombre);
    assert.ok(k, `falta el CHECK ${nombre}. Un CHECK sin nombre explícito recibe uno autogenerado ` +
                 `(CK__rotacion__…) que cambia entre BDs y no se puede volver a crear igual.`);
    assert.equal(k.tabla, tabla, `${nombre} debe colgar de bitacora.${tabla}`);
  }
});

test('F37.A1 · 8. los dominios de los CHECK son los del contrato, ni más ni menos', () => {
  // desfase ∈ [0,7]: son 8 posiciones de la rueda; un 8 significaría una vuelta completa repetida.
  const desfase = norm(checks.get('CK_rotacion_patron_desfase').definicion);
  assert.ok(desfase.includes('[desfase]>=(0)'), `cota inferior de desfase: ${desfase}`);
  assert.ok(desfase.includes('[desfase]<=(7)'), `cota superior de desfase: ${desfase}`);

  // grupo ∈ [1,4]: cuatro cuadrillas. Un quinto grupo no existe en el dominio.
  const grupo = norm(checks.get('CK_rotacion_asig_grupo').definicion);
  assert.ok(grupo.includes('[grupo]>=(1)'), `cota inferior de grupo: ${grupo}`);
  assert.ok(grupo.includes('[grupo]<=(4)'), `cota superior de grupo: ${grupo}`);

  // Rangos de vigencia: el patrón exige fin ESTRICTAMENTE mayor; la asignación admite un solo día.
  assert.ok(
    norm(checks.get('CK_rotacion_patron_rango').definicion).includes('[fecha_fin]>[fecha_inicio]'),
    'CK_rotacion_patron_rango: fecha_fin > fecha_inicio'
  );
  assert.ok(
    norm(checks.get('CK_rotacion_asig_rango').definicion).includes('[vigente_hasta]>=[vigente_desde]'),
    'CK_rotacion_asig_rango: vigente_hasta >= vigente_desde (una vigencia de un solo día es válida)'
  );

  // accion: exactamente tres. L05 deriva la pila LIFO de estos verbos — un cuarto la rompe.
  assert.deepEqual(
    literales(checks.get('CK_rotacion_control_accion').definicion),
    ['ABANDONAR', 'DESCARTAR', 'TOMAR'],
    'rotacion_control.accion acepta exactamente TOMAR | ABANDONAR | DESCARTAR (contrato C2)'
  );

  // estado: exactamente cuatro, los que congela L06 al cerrar el turno.
  assert.deepEqual(
    literales(checks.get('CK_rotacion_cumpl_estado').definicion),
    ['COMPLETO', 'CUBIERTO_POR_RELEVO', 'PARCIAL', 'PENDIENTE'],
    'rotacion_cumplimiento.estado acepta exactamente los cuatro estados del contrato'
  );

  // turno ∈ {1,2}: son DOS turnos, no tres (convención 3 de CLAUDE.md).
  const turno = norm(checks.get('CK_rotacion_cumpl_turno').definicion);
  assert.ok(turno.includes('[turno]=(1)') && turno.includes('[turno]=(2)'), `turno ∈ {1,2}: ${turno}`);
  assert.ok(!turno.includes('[turno]=(3)'), `no existe un turno 3 (convención 3): ${turno}`);

  // grupo del cumplimiento ∈ [1,4] o NULL (F37.A3, CR-9). El GATE-O1 §6.7 midió que un CHECK
  // sobre columna NULLABLE ya acepta NULL (evalúa a UNKNOWN, no a FALSE); el `IS NULL` explícito
  // deja escrito en el catálogo que "sin patrón ese día" es un valor legítimo, no una omisión.
  const cumplGrupo = norm(checks.get('CK_rotacion_cumpl_grupo').definicion);
  assert.ok(cumplGrupo.includes('[grupo]ISNULL'), `acepta NULL explícitamente: ${cumplGrupo}`);
  assert.ok(cumplGrupo.includes('[grupo]>=(1)'), `cota inferior: ${cumplGrupo}`);
  assert.ok(cumplGrupo.includes('[grupo]<=(4)'), `cota superior: ${cumplGrupo}`);
});

test('F37.A1 · 9. la UNIQUE natural del patrón y la PK del cumplimiento', () => {
  // F37.A4 (D-065 L12, CR2-10): la UNIQUE natural dejó de ser una key constraint y pasó a ser un
  // ÍNDICE ÚNICO FILTRADO por `activo = 1` — un índice filtrado no puede ser una constraint. Sin el
  // filtro, desactivar un patrón cargado con error no liberaba su fecha de inicio y el corregido
  // seguía chocando con `patron_duplicado`: la carga anual no tenía arreglo por la app.
  // Que sea único y filtrado lo verifica `rotacion_correcciones_o2 › CR2-10(b)`, que sí lee
  // sys.indexes; acá solo se fija que la vieja se fue y que la nueva cubre las mismas columnas.
  assert.equal(claves.get('UQ_rotacion_patron_natural'), undefined,
    'F37.A4 la reemplazó por UQ_rotacion_patron_natural_activo: ya no es una key constraint');
  const uq = indices.get('UQ_rotacion_patron_natural_activo');
  assert.ok(uq, 'falta el índice único filtrado UQ_rotacion_patron_natural_activo (F37.A4)');
  assert.deepEqual(uq.clave, ['cargo_id', 'fecha_inicio'],
    'un rol no puede tener dos patrones ACTIVOS que arranquen el mismo día');

  const pk = claves.get('PK_rotacion_cumplimiento');
  assert.ok(pk, 'falta PK_rotacion_cumplimiento');
  assert.equal(pk.tipo, 'PK', 'PK_rotacion_cumplimiento debe ser PRIMARY KEY');
  assert.deepEqual(
    pk.columnas, ['fecha_operativa', 'planta_id', 'turno', 'cargo_id'],
    'esta PK natural es LO QUE HACE IDEMPOTENTE el congelado de L06: sin ella, un segundo cierre ' +
    'del mismo turno duplicaría la fila'
  );
});

test('F37.A1 · 10. los dos índices de lectura, con sus columnas en orden', () => {
  const pila = indices.get('IX_rotacion_control_pila');
  assert.ok(pila, 'falta IX_rotacion_control_pila');
  assert.deepEqual(
    pila.clave, ['turno_id', 'planta_id', 'cargo_id', 'rotacion_control_id'],
    'la pila LIFO de L05 se deriva ordenando por rotacion_control_id dentro de (turno, planta, cargo)'
  );

  const resolucion = indices.get('IX_rotacion_asig_resolucion');
  assert.ok(resolucion, 'falta IX_rotacion_asig_resolucion');
  assert.deepEqual(
    resolucion.clave, ['cargo_id', 'vigente_desde', 'vigente_hasta'],
    'la resolución de titulares de L04 entra por (cargo, vigencia)'
  );
  assert.deepEqual(
    [...resolucion.incluidas].sort(), ['grupo', 'usuario_id'],
    'usuario_id y grupo van INCLUDE para que la resolución no vuelva a la tabla'
  );
});

test('F37.A1 · 11. es idempotente: un segundo initDB() no falla ni duplica el flag', async () => {
  // El `before` ya corrió initDB() una vez (fue quien aplicó la migración si faltaba). Esta segunda
  // corrida es el escenario real: el server reinicia y vuelve a ejecutar todo el arranque.
  await initDB();

  const r = await db.request().query(`
    SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A1'
  `);
  assert.equal(r.recordset[0].n, 1, 'F37.A1 debe aparecer UNA sola vez en migracion_aplicada');

  // F37.A3 (L11) corre en el mismo arranque y con el mismo patrón: también una sola fila.
  const r3 = await db.request().query(`
    SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A3'
  `);
  assert.equal(r3.recordset[0].n, 1, 'F37.A3 debe aparecer UNA sola vez en migracion_aplicada');

  // Y las tablas siguen siendo las mismas: el DDL guardado por IF OBJECT_ID no las recreó.
  const t = await db.request().query(`
    SELECT COUNT(*) AS n FROM sys.tables t
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'bitacora' AND t.name LIKE 'rotacion_%'
  `);
  assert.equal(t.recordset[0].n, 4, 'siguen siendo exactamente las cuatro tablas de rotación');
});

// ───────────────────────────── CA-4 · F37.A2 ─────────────────────────────

test('F37.A2 · 12. la columna puede_configurar_rotacion existe, es BIT y es NOT NULL', async () => {
  const r = await db.request().query(`
    SELECT DATA_TYPE AS tipo, IS_NULLABLE AS nullable
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'lov_bit' AND TABLE_NAME = 'cargo'
      AND COLUMN_NAME = 'puede_configurar_rotacion'
  `);
  const c = r.recordset[0];
  assert.ok(c, 'falta lov_bit.cargo.puede_configurar_rotacion (F37.A2)');
  assert.equal(c.tipo, 'bit');
  assert.equal(c.nullable, 'NO', 'el flag no admite NULL: un cargo sin permiso vale 0, no "se ignora"');
});

test('F37.A2 · 13. (a) exactamente los dos cargos del contrato lo tienen en 1', async () => {
  const r = await db.request().query(`
    SELECT nombre, CAST(puede_configurar_rotacion AS INT) AS flag
    FROM lov_bit.cargo ORDER BY nombre
  `);
  const con = r.recordset.filter((c) => c.flag === 1).map((c) => c.nombre).sort();
  assert.deepEqual(
    con, [...CARGOS_CON_FLAG].sort(),
    'la configuración anual de la malla la cargan solo el Administrador y el Gerente de Producción'
  );

  const sin = r.recordset.filter((c) => c.flag === 0);
  assert.equal(sin.length, r.recordset.length - CARGOS_CON_FLAG.length,
    'todos los demás cargos del catálogo quedan en 0');
});

test('F37.A2 · 14. (b) un UPDATE manual NO sobrevive a initDB(): el flag vive en el MERGE', async () => {
  // Este es el test que la convención 27 pide de verdad. Si `puede_configurar_rotacion` estuviera
  // fuera del MERGE (por ejemplo en un `UPDATE … WHERE nombre IN (…)` suelto), el valor puesto a
  // mano acá seguiría en 1 después del arranque y este assert se pondría rojo.
  //
  // El cargo es real (ver cabecera): la ventana con el flag en 1 dura lo que tarda `initDB()`, y
  // el `finally` lo baja pase lo que pase con los asserts (L11, CR-5).
  let despues;
  try {
    await db.request()
      .input('nombre', sql.VarChar(100), CARGO_CONEJILLO)
      .query(`UPDATE lov_bit.cargo SET puede_configurar_rotacion = 1 WHERE nombre = @nombre;`);
    assert.equal(await flagConejillo(db), 1, 'precondición: el UPDATE manual sí escribió');

    await initDB(); // el mismo camino que corre el server al reiniciar

    despues = await flagConejillo(db);
  } finally {
    await bajarFlagConejillo(db);
  }
  assert.equal(
    despues, 0,
    `'${CARGO_CONEJILLO}' quedó con el flag en 1 tras el arranque. El MERGE de cargos es la fuente ` +
    'autoritativa y su rama WHEN MATCHED debe bajarlo a 0 (convención 27): el flag tiene que estar ' +
    'DENTRO del MERGE, no en un UPDATE aparte.'
  );
});

test('F37.A2 · 15. (b bis) y los dos cargos del contrato siguen en 1 tras ese arranque', async () => {
  const r = await db.request()
    .query(`SELECT nombre, CAST(puede_configurar_rotacion AS INT) AS flag FROM lov_bit.cargo`);
  for (const nombre of CARGOS_CON_FLAG) {
    const c = r.recordset.find((x) => x.nombre === nombre);
    assert.ok(c, `falta el cargo '${nombre}' en el catálogo`);
    assert.equal(c.flag, 1, `'${nombre}' debe conservar el flag tras el restart`);
  }
});

test('F37.A2 · 16. (c) el Gerente de Producción sigue en solo_lectura = 1', async () => {
  const r = await db.request().query(`
    SELECT CAST(solo_lectura AS INT) AS solo_lectura,
           CAST(puede_cerrar_turno AS INT) AS puede_cerrar_turno,
           CAST(es_observador AS INT) AS es_observador,
           CAST(puede_configurar_rotacion AS INT) AS puede_configurar_rotacion
    FROM lov_bit.cargo WHERE nombre = 'Gerente de Producción'
  `);
  const g = r.recordset[0];
  assert.ok(g, 'falta el cargo Gerente de Producción');
  assert.equal(
    g.solo_lectura, 1,
    'configurar la malla NO es escribir en una bitácora: el flag de rotación no puede haber ' +
    'convertido al Gerente en un cargo de escritura'
  );
  assert.equal(g.puede_configurar_rotacion, 1, 'el Gerente sí configura la malla');
  assert.equal(g.puede_cerrar_turno, 0, 'y sigue sin cerrar turno');
  assert.equal(g.es_observador, 0, 'no es el rol observador de D-059');
});

test('F37.A2 · 17. el flag no le tocó los permisos a ningún otro cargo (D-039/D-054/D-059 intactos)', async () => {
  const r = await db.request().query(`
    SELECT nombre,
           CAST(solo_lectura AS INT)         AS solo_lectura,
           CAST(puede_cerrar_turno AS INT)   AS puede_cerrar_turno,
           CAST(puede_cambiar_unidad AS INT) AS puede_cambiar_unidad,
           CAST(es_observador AS INT)        AS es_observador
    FROM lov_bit.cargo
  `);
  const por = (n) => r.recordset.find((c) => c.nombre === n);

  const admin = por('Administrador y Debugging');
  assert.ok(admin, 'falta el cargo Administrador y Debugging');
  assert.deepEqual(
    [admin.solo_lectura, admin.puede_cerrar_turno, admin.puede_cambiar_unidad, admin.es_observador],
    [0, 1, 0, 0], 'D-039: el ADMIN conserva sus flags'
  );

  // D-054: los dos cargos que cambian de unidad en caliente siguen siendo esos dos, ni uno más.
  const cambian = r.recordset.filter((c) => c.puede_cambiar_unidad === 1).map((c) => c.nombre).sort();
  assert.deepEqual(
    cambian,
    ['Ingeniero Jefe de Turno', 'Operador de Planta - Analista', 'USUARIO DE CONSULTA'].sort(),
    'D-054/D-059: la lista de cargos que cambian de unidad en caliente no cambió'
  );

  // D-059: sigue habiendo un único observador.
  const observadores = r.recordset.filter((c) => c.es_observador === 1).map((c) => c.nombre);
  assert.deepEqual(observadores, ['USUARIO DE CONSULTA'], 'D-059: un solo cargo observador');
});
