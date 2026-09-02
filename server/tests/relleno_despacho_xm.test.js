// D-064 (L05) — CLI del relleno del mes para el asiento del despacho económico. Cubre CA-5.
//
// ── Reglas duras de esta suite ──────────────────────────────────────────────────────────────────
// La suite corre contra la BD PRODUCTIVA (D-030) y el relleno escribe un MES ENTERO de asientos de
// una sola pasada: es, de lejos, la escritura más grande del flujo. Por eso:
//   · todo entra por el parámetro `plantas` de `ejecutarRelleno`, apuntado a las dos plantas-fixture
//     ('TST' y 'TSR'), NUNCA a GEC3/GEC32. Es la contramedida ESTRUCTURAL de D-061, no un adorno: el
//     guard estático solo ve el DML literal del test, y una escritura que entrara por el `default`
//     de una función de producción le sería invisible;
//   · el CLI **completo** (`main()`) NO se corre en ningún caso, ni siquiera para el guardrail: sin
//     `plantas` inyectables, `main()` rellenaría el mes en curso de GEC3 y GEC32. Del CLI solo se
//     ejercita el camino de RECHAZO de `--confirm-db`, que aborta antes de abrir el pool;
//   · toda limpieza va acotada por `TEST_PLANTA`/`TEST_PLANTA_REFLEJO` **y** por el marcador del
//     asiento, léxicamente junto al statement (`guard_no_prod_historico_destruction.test.js`);
//   · las fechas-fixture son de **1902** — L04 ya usó 1901, y su cierre pide expresamente no
//     reusarlas. Ningún flujo real puede producir un despacho de 1902.
//
// ── Por qué las funciones se importan y el CLI no se ejecuta ────────────────────────────────────
// El script lleva un guard de módulo principal (`esPrincipal`), así que importarlo no dispara nada.
// Sin ese guard no habría forma de probar el recorrido sin correr el programa entero contra la BD.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { getDB, USUARIO_SISTEMA_ID } from '../db.js';
import {
  setupSessions, setupSesionReflejo, TEST_PLANTA, TEST_PLANTA_REFLEJO, deactivateSyntheticSessions,
} from './helpers.js';
import {
  asientoDespachoXM, claveAsientoDespacho, camposExtraDespacho, esHoraEstimada, esAsientoDeSistema,
  TIPO_EVENTO_DESPACHO_XM,
} from '../utils/asientos/sistema.js';
import { crearAsientoDespacho } from '../utils/despacho-xm/asiento.js';
import { reiniciarAvisoDegradacion } from '../utils/despacho-xm/lector.js';
import {
  ejecutarRelleno, verificarMes, clavesPresentes, diasDelMesHasta, detectadoEnEstimado,
  HORA_ESTIMADA_BOGOTA,
} from '../scripts/relleno-asiento-despacho.js';

// Las plantas-fixture, siempre explícitas: ni un solo caso puede caer en el `default` del creador.
const PLANTAS = [TEST_PLANTA, TEST_PLANTA_REFLEJO];

// Un mes-fixture por escenario, para que ninguno herede el estado del anterior. El día del "hoy"
// simulado es el último del rango: `diasDelMesHasta` recorre del 1 hasta ahí.
const HOY_BASE = '1902-03-04';          // el relleno completo, y después la idempotencia
const HOY_HORA_REAL = '1902-04-03';     // un día pre-asentado con hora real que no se puede pisar
const HOY_DRY = '1902-05-03';           // el ensayo
const HOY_PREFIERE = '1902-06-03';      // el dashboard SÍ tiene la hora de un día
const HOY_ESTRICTO = '1902-07-03';      // --solo-con-hecho

const PREFIJO_FIXTURE = 'DESPACHO_XM|1902-%';
const RUTA_SERVER = fileURLToPath(new URL('..', import.meta.url));

// ── Limpieza ───────────────────────────────────────────────────────────────────────────────────
// Acotada a las DOS plantas-fixture Y al marcador de ESTE archivo (`DESPACHO_XM|1902-…`). No se
// acota por `creado_por = SISTEMA` a propósito (la lección de §Desviaciones 3 del cierre de L04):
// un filtro por autor deja viva la fila que una ruptura deliberada haya escrito a nombre de otro, y
// la corrida siguiente arranca envenenada. La clave identifica exactamente lo que este archivo crea.
async function limpiarAsientos() {
  const db = await getDB();
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('pref', sql.NVarChar(200), PREFIJO_FIXTURE)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') LIKE @pref;
    `);
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('pref', sql.NVarChar(200), PREFIJO_FIXTURE)
    .query(`
      DELETE FROM bitacora.registro_historico
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') LIKE @pref;
    `);
}

// La fixture tiene que quedar con CERO cabeceras de turno: una cabecera residual de 'TST' fuera de
// ventana vuelve intermitentes a otras suites, y el sweeper no la toca (solo barre GEC3/GEC32).
async function limpiarTurnos() {
  const db = await getDB();
  await db.request().input('p', sql.VarChar(10), TEST_PLANTA).query(`
    UPDATE ra SET turno_id = NULL FROM bitacora.registro_activo ra
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = ra.turno_id WHERE tu.planta_id = @p;
    UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
    DELETE tp FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
    -- D-065 (GATE-O2): rotacion_control y rotacion_cumplimiento referencian turno_unidad por FK.
    DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
    DELETE FROM bitacora.rotacion_control WHERE planta_id = @p;
    DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
  `);
}

async function filasDelAsiento(fecha_despacho) {
  const db = await getDB();
  const r = await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .query(`
      SELECT ra.registro_id, ra.bitacora_id, ra.planta_id, ra.fecha_evento, ra.turno, ra.detalle,
             ra.campos_extra, ra.creado_por, ra.estado,
             b.codigo AS bitacora_codigo, te.nombre AS tipo_evento_nombre, te.bitacora_id AS te_bitacora_id
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ISJSON(ra.campos_extra) = 1
        AND JSON_VALUE(ra.campos_extra, '$.clave_asiento') = @clave
      ORDER BY ra.planta_id, b.codigo
    `);
  return r.recordset;
}

// Cuántas filas del mes-fixture hay en total. Es el número que `--dry-run` no puede mover.
async function contarFilasDelMes(mes) {
  const db = await getDB();
  const r = await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('pref', sql.NVarChar(200), `DESPACHO_XM|${mes}-%`)
    .query(`
      SELECT COUNT(*) AS n FROM bitacora.registro_activo
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') LIKE @pref
    `);
  return r.recordset[0].n;
}

// El guard de coherencia de las cuatro filas, en la versión que le toca a este lote. El libro F03
// colapsa el asiento por `clave_asiento` y se queda con el `detalle` y la hora de la fila de MENOR
// `registro_id`, descartando las otras tres SIN AVISAR (R12 del code-review de la O1). Nada en la BD
// lo sostiene, así que cada día que el relleno escribe se verifica acá también: si una corrida
// larga recalculara la hora por fila —el gotcha (b) de D-058, medido en 147 ms de deriva por L04—
// el asiento se partiría y el renglón saldría al azar.
function verificarCoherenciaDelAsiento(filas, { fecha_despacho, hora_estimada }) {
  assert.equal(filas.length, 4, `el asiento de ${fecha_despacho} debe tener 4 filas`);

  const detalles = new Set(filas.map((f) => f.detalle));
  assert.equal(detalles.size, 1, `las filas divergen en el detalle: ${[...detalles].join(' | ')}`);
  assert.equal([...detalles][0], asientoDespachoXM(fecha_despacho));

  const horas = new Set(filas.map((f) => f.fecha_evento.getTime()));
  assert.equal(horas.size, 1,
    `las filas divergen en fecha_evento (un solo instante para las cuatro): ${[...horas].join(' | ')}`);

  const extras = new Set(filas.map((f) => f.campos_extra));
  assert.equal(extras.size, 1, 'las filas divergen en campos_extra');
  assert.deepEqual(JSON.parse([...extras][0]), camposExtraDespacho({ fecha_despacho, hora_estimada }));

  const combinaciones = filas.map((f) => `${f.planta_id}/${f.bitacora_codigo}`).sort();
  assert.deepEqual(combinaciones, [
    `${TEST_PLANTA}/SALAING`, `${TEST_PLANTA}/SALAJDT`,
    `${TEST_PLANTA_REFLEJO}/SALAING`, `${TEST_PLANTA_REFLEJO}/SALAJDT`,
  ].sort(), 'las 4 combinaciones son 2 bitácoras de Sala × 2 unidades');

  for (const f of filas) {
    assert.equal(f.creado_por, USUARIO_SISTEMA_ID, 'el autor del relleno tiene que ser SISTEMA');
    assert.equal(f.estado, 'borrador');
    assert.equal(f.tipo_evento_nombre, TIPO_EVENTO_DESPACHO_XM);
    assert.equal(f.te_bitacora_id, f.bitacora_id,
      `${f.bitacora_codigo}: el tipo_evento_id es de OTRA bitácora (drift invisible, D-053)`);
    assert.ok(esAsientoDeSistema(f.campos_extra), 'la fila lleva el marcador origen_sistema');
    assert.equal(esHoraEstimada(f.campos_extra), hora_estimada,
      `${fecha_despacho}: la marca de hora estimada no es la esperada`);
  }
}

before(async () => {
  await setupSessions({ planta: TEST_PLANTA });
  await setupSesionReflejo();   // siembra 'TSR' (activa = 0) — el relleno no necesita sesión HTTP
  await limpiarAsientos();
  await limpiarTurnos();
  reiniciarAvisoDegradacion();
});

after(async () => {
  await limpiarAsientos();
  await limpiarTurnos();
  await deactivateSyntheticSessions();
});

// ── Piezas puras ───────────────────────────────────────────────────────────────────────────────
test('0. el recorrido del mes y la hora de la convención (piezas puras)', () => {
  // Del 1 hasta hoy, nunca un día futuro: el despacho de MAÑANA lo asienta el sweeper.
  assert.deepEqual(diasDelMesHasta('1902-03-04'),
    ['1902-03-01', '1902-03-02', '1902-03-03', '1902-03-04']);
  assert.equal(diasDelMesHasta('1902-03-31').length, 31);
  assert.deepEqual(diasDelMesHasta('1902-01-01'), ['1902-01-01']);

  // Una fecha que no existe LANZA, no rueda: `new Date('1902-02-30')` daría el 2 de marzo sin avisar.
  assert.throws(() => diasDelMesHasta('1902-02-30'), TypeError);
  assert.throws(() => diasDelMesHasta('4/3/1902'), TypeError);
  assert.throws(() => diasDelMesHasta(undefined), TypeError);

  // La detección es la tarde del día ANTERIOR: 15:00 Bogotá = 20:00 UTC.
  assert.equal(detectadoEnEstimado('1902-03-04').toISOString(), '1902-03-03T20:00:00.000Z');
  assert.equal(HORA_ESTIMADA_BOGOTA, 15);

  // El borde del día 1: cae en el ÚLTIMO día del mes anterior, sin caso especial. 1902 no es
  // bisiesto (febrero termina el 28); 1904 sí (termina el 29). Si esto se calculara restando
  // 86.400.000 ms sobre una fecha local, un cambio de mes o de año lo correría.
  assert.equal(detectadoEnEstimado('1902-03-01').toISOString(), '1902-02-28T20:00:00.000Z');
  assert.equal(detectadoEnEstimado('1904-03-01').toISOString(), '1904-02-29T20:00:00.000Z');
  assert.equal(detectadoEnEstimado('1902-01-01').toISOString(), '1901-12-31T20:00:00.000Z');

  assert.throws(() => detectadoEnEstimado('no-es-fecha'), TypeError);
});

// ── CA-5 ───────────────────────────────────────────────────────────────────────────────────────
test('1. rellena los días pasados a las 15:00', async () => {
  const db = await getDB();
  const dias = diasDelMesHasta(HOY_BASE);

  // El lector REAL, sin inyectar: hoy `dashboard.despacho_recibido` no existe en esta base, así que
  // degrada a `[]` (contrato C4) y el relleno cae entero en la convención de las 15:00 — que es el
  // estado normal hasta que el otro repo se despliegue, y el caso que CA-5 describe.
  const r = await ejecutarRelleno({ pool: db, hoy: HOY_BASE, plantas: PLANTAS });

  assert.equal(r.dias, 4);
  assert.equal(r.creados, 4, 'los 4 días del mes quedan asentados');
  assert.equal(r.creados_con_hora_estimada, 4);
  assert.equal(r.creados_con_hora_real, 0);
  assert.equal(r.existentes, 0);
  assert.equal(r.fallidos, 0);
  assert.equal(r.hechos_leidos, 0, 'sin la tabla del dashboard no hay ninguna hora real que preferir');

  for (const fecha of dias) {
    const filas = await filasDelAsiento(fecha);
    verificarCoherenciaDelAsiento(filas, { fecha_despacho: fecha, hora_estimada: true });

    // La hora del renglón: 15:00 Bogotá del día ANTERIOR, al milisegundo. Es donde se delataría una
    // conversión de zona repetida o un `GETDATE()` colado.
    assert.equal(filas[0].fecha_evento.toISOString(), detectadoEnEstimado(fecha).toISOString());
    assert.equal(filas[0].fecha_evento.getUTCHours(), HORA_ESTIMADA_BOGOTA + 5);

    // Y la marca que hace visible que la hora es una convención y no una medición.
    assert.equal(JSON.parse(filas[0].campos_extra).hora_estimada, true);
  }

  // El día 1 del mes queda fechado el 28 de febrero: su renglón sale en el libro del mes ANTERIOR.
  const primero = await filasDelAsiento('1902-03-01');
  assert.equal(primero[0].fecha_evento.toISOString(), '1902-02-28T20:00:00.000Z');

  // El texto es el mismo del F03, con la fecha del despacho (no la de detección) y en guiones.
  assert.equal(primero[0].detalle,
    'Se recibe del XM despacho económico de G3.0 y G3.2 para el 01-03-1902');
});

test('2. no pisa la hora real', async () => {
  const db = await getDB();
  const conHoraReal = '1902-04-02';
  const HORA_MEDIDA = new Date('1902-04-01T20:37:11.000Z');   // 15:37:11 Bogotá del día anterior

  // Un día que YA fue asentado con la hora medida por el sweeper.
  const previo = await crearAsientoDespacho(db, {
    fecha_despacho: conHoraReal, detectado_en: HORA_MEDIDA, hora_estimada: false, plantas: PLANTAS,
  });
  assert.equal(previo.creado, true);

  const r = await ejecutarRelleno({ pool: db, hoy: HOY_HORA_REAL, plantas: PLANTAS, leerFn: async () => [] });

  assert.equal(r.dias, 3);
  assert.equal(r.creados, 2, 'solo los dos días que faltaban');
  assert.equal(r.existentes, 1, 'el día con hora real se reconoce como ya asentado');

  // Lo que importa: ese día conserva su hora ORIGINAL y sigue marcado como medición.
  const filas = await filasDelAsiento(conHoraReal);
  verificarCoherenciaDelAsiento(filas, { fecha_despacho: conHoraReal, hora_estimada: false });
  assert.equal(filas[0].fecha_evento.toISOString(), HORA_MEDIDA.toISOString(),
    'el relleno le habría puesto las 15:00 en punto; la hora medida tiene que sobrevivir intacta');
  assert.equal(esHoraEstimada(filas[0].campos_extra), false);

  // Y el estado del mes lo confirma desde la BD: 1 con hora real, 2 con hora estimada.
  const estado = await verificarMes(db, { hoy: HOY_HORA_REAL, plantas: PLANTAS });
  assert.deepEqual(estado.faltantes, []);
  assert.equal(estado.reales, 1);
  assert.equal(estado.estimados, 2);
});

test('3. resumible e idempotente', async () => {
  const db = await getDB();
  const antes = await contarFilasDelMes('1902-03');
  assert.equal(antes, 16, 'los 4 días del caso 1 siguen ahí (4 filas cada uno)');

  const r = await ejecutarRelleno({ pool: db, hoy: HOY_BASE, plantas: PLANTAS, leerFn: async () => [] });

  assert.equal(r.creados, 0, 'la segunda corrida no crea nada');
  assert.equal(r.existentes, 4, 'los 4 días se reportan como "ya existía"');
  assert.equal(r.fallidos, 0);
  assert.deepEqual(r.detalle.map((d) => d.accion), ['ya_existe', 'ya_existe', 'ya_existe', 'ya_existe']);

  assert.equal(await contarFilasDelMes('1902-03'), antes, 'el conteo de filas no se movió');

  // El caso que de verdad ejercita el relleno de un mes: un día YA ARCHIVADO por el cierre de turno.
  // Si la idempotencia solo mirara `registro_activo`, este día se volvería a escribir.
  await archivarAsiento('1902-03-02');
  assert.equal((await filasDelAsiento('1902-03-02')).length, 0, 'ya no está en registro_activo');

  const trasArchivar = await ejecutarRelleno({
    pool: db, hoy: HOY_BASE, plantas: PLANTAS, leerFn: async () => [],
  });
  assert.equal(trasArchivar.creados, 0, 'un día archivado NO se vuelve a escribir');
  assert.equal(trasArchivar.existentes, 4);
  assert.equal((await filasDelAsiento('1902-03-02')).length, 0, 'sigue sin duplicarse en el activo');
});

test('4. dry-run no escribe', async () => {
  const db = await getDB();
  const mes = HOY_DRY.slice(0, 7);
  assert.equal(await contarFilasDelMes(mes), 0, 'el mes del ensayo arranca vacío');

  // Un día ya asentado, para que el ensayo tenga los dos desenlaces que reportar.
  await crearAsientoDespacho(db, {
    fecha_despacho: '1902-05-01', detectado_en: new Date('1902-04-30T20:00:00.000Z'),
    hora_estimada: true, plantas: PLANTAS,
  });
  const antes = await contarFilasDelMes(mes);
  assert.equal(antes, 4);

  const r = await ejecutarRelleno({ pool: db, hoy: HOY_DRY, plantas: PLANTAS, dryRun: true });

  // El conteo es la prueba: no se lee el código, se cuentan filas antes y después.
  assert.equal(await contarFilasDelMes(mes), antes, '--dry-run no escribió ni una fila');
  assert.equal(r.dry_run, true);

  // Y reporta exactamente lo que habría hecho, día por día.
  assert.equal(r.creados, 2, 'habría creado los dos días que faltan');
  assert.equal(r.existentes, 1, 'y habría dejado quieto el que ya estaba');
  assert.deepEqual(r.detalle.map((d) => `${d.fecha}:${d.accion}`),
    ['1902-05-01:ya_existe', '1902-05-02:crearia', '1902-05-03:crearia']);
  const crearia = r.detalle.find((d) => d.fecha === '1902-05-02');
  assert.equal(crearia.hora_estimada, true);
  assert.equal(crearia.detectado_en.toISOString(), '1902-05-01T20:00:00.000Z');

  // El día que ya estaba sigue con sus 4 filas y su hora, intacto.
  const filas = await filasDelAsiento('1902-05-01');
  verificarCoherenciaDelAsiento(filas, { fecha_despacho: '1902-05-01', hora_estimada: true });
});

test('5. guardrail de BD equivocada', async () => {
  const db = await getDB();
  const mesEnCurso = new Date().toISOString().slice(0, 7);
  const antesFixture = await contarFilasDelMes(HOY_DRY.slice(0, 7));

  // Se invoca el CLI DE VERDAD, como programa. Es el único caso que lo hace, y solo puede hacerlo
  // porque el rechazo ocurre ANTES de abrir el pool: con la BD equivocada el proceso muere sin
  // tocar una conexión. El camino de aceptación NO se prueba acá a propósito — `main()` no acepta
  // `plantas`, así que correrlo rellenaría el mes en curso de GEC3 y GEC32 (D-055).
  const r = spawnSync(process.execPath,
    ['--env-file=../.env', 'scripts/relleno-asiento-despacho.js', '--confirm-db', 'BD_QUE_NO_EXISTE'],
    { cwd: RUTA_SERVER, encoding: 'utf8', timeout: 60_000 });

  assert.equal(r.status, 2, `el CLI tiene que abortar con código 2 (stderr: ${r.stderr})`);
  assert.match(r.stderr, /--confirm-db debe ser exactamente el DB_NAME activo/);
  assert.equal(r.stdout, '', 'no alcanza a imprimir ni la línea de arranque: muere antes del pool');

  // Sin `--confirm-db` tampoco corre.
  const sinFlag = spawnSync(process.execPath,
    ['--env-file=../.env', 'scripts/relleno-asiento-despacho.js'],
    { cwd: RUTA_SERVER, encoding: 'utf8', timeout: 60_000 });
  assert.equal(sinFlag.status, 2);

  // Y no escribió nada, ni en la fixture ni en el mes en curso de las plantas REALES.
  assert.equal(await contarFilasDelMes(HOY_DRY.slice(0, 7)), antesFixture);
  const enReales = await db.request()
    .input('pref', sql.NVarChar(200), `DESPACHO_XM|${mesEnCurso}-%`)
    .query(`
      SELECT COUNT(*) AS n FROM bitacora.registro_activo
      WHERE planta_id IN ('GEC3', 'GEC32') AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') LIKE @pref
        AND creado_en >= DATEADD(MINUTE, -5, SYSUTCDATETIME())
    `);
  assert.equal(enReales.recordset[0].n, 0, 'el CLI rechazado no escribió en plantas reales');
});

test('6. prefiere la hora real cuando el dashboard la tiene', async () => {
  const db = await getDB();
  const conHecho = '1902-06-02';
  const DETECTADO = new Date('1902-06-01T20:14:02.000Z');   // 15:14:02 Bogotá del día anterior

  // El dashboard alcanzó a registrar la llegada de ese día. El relleno tiene que usar ESA hora y no
  // inventar las 15:00: no se marca como estimada una hora que sí se midió.
  const r = await ejecutarRelleno({
    pool: db, hoy: HOY_PREFIERE, plantas: PLANTAS,
    leerFn: async () => [{ fecha_despacho: conHecho, detectado_en: DETECTADO }],
  });

  assert.equal(r.hechos_leidos, 1);
  assert.equal(r.creados, 3);
  assert.equal(r.creados_con_hora_real, 1);
  assert.equal(r.creados_con_hora_estimada, 2);

  const filas = await filasDelAsiento(conHecho);
  verificarCoherenciaDelAsiento(filas, { fecha_despacho: conHecho, hora_estimada: false });
  assert.equal(filas[0].fecha_evento.toISOString(), DETECTADO.toISOString(),
    'la hora medida entra tal cual: el lector ya la convirtió a UTC y nadie la vuelve a tocar');
  assert.notEqual(filas[0].fecha_evento.toISOString(), detectadoEnEstimado(conHecho).toISOString());

  // Los otros dos días sí caen en la convención.
  const otro = await filasDelAsiento('1902-06-01');
  assert.equal(esHoraEstimada(otro[0].campos_extra), true);
  assert.equal(otro[0].fecha_evento.toISOString(), detectadoEnEstimado('1902-06-01').toISOString());
});

test('7. --solo-con-hecho no inventa un día sin evidencia', async () => {
  const db = await getDB();
  const conHecho = '1902-07-02';
  const DETECTADO = new Date('1902-07-01T20:03:00.000Z');

  // La lectura estricta de RN-05.d: solo se asienta lo que tiene fila en el dashboard. Es la forma
  // de acotar la suposición de fondo del relleno (que el despacho llegó todos los días del mes)
  // para quien no la quiera asumir.
  const r = await ejecutarRelleno({
    pool: db, hoy: HOY_ESTRICTO, plantas: PLANTAS, soloConHecho: true,
    leerFn: async () => [{ fecha_despacho: conHecho, detectado_en: DETECTADO }],
  });

  assert.equal(r.creados, 1, 'solo el día con evidencia');
  assert.equal(r.creados_con_hora_real, 1);
  assert.equal(r.creados_con_hora_estimada, 0, 'con --solo-con-hecho no se inventa ninguna hora');
  assert.equal(r.omitidos, 2);
  assert.deepEqual(r.detalle.filter((d) => d.accion === 'omitido').map((d) => d.fecha),
    ['1902-07-01', '1902-07-03']);

  assert.equal((await filasDelAsiento('1902-07-01')).length, 0, 'el día omitido queda SIN renglón');
  assert.equal((await filasDelAsiento('1902-07-03')).length, 0);
  verificarCoherenciaDelAsiento(await filasDelAsiento(conHecho),
    { fecha_despacho: conHecho, hora_estimada: false });

  // Y la verificación de cierre nombra los que faltan, en vez de decir que terminó.
  const estado = await verificarMes(db, { hoy: HOY_ESTRICTO, plantas: PLANTAS });
  assert.deepEqual(estado.faltantes, ['1902-07-01', '1902-07-03']);
  assert.equal(estado.con_asiento, 1);
});

test('8. la verificación de cierre se la pregunta a la BD, no al contador', async () => {
  const db = await getDB();

  // Estado sano del mes del caso 1: los 4 días (uno de ellos archivado en el caso 3).
  const sano = await verificarMes(db, { hoy: HOY_BASE, plantas: PLANTAS });
  assert.deepEqual(sano.faltantes, [], 'el día archivado también cuenta: se busca en las dos tablas');
  assert.equal(sano.con_asiento, 4);
  assert.equal(sano.estimados, 4);

  // Se borra un día por debajo, como si una corrida se hubiera cortado. El acumulador del bucle no
  // se enteraría; la consulta sí. Es la lección de D-061: "terminado" no es que el proceso salga
  // con 0, es que la BD no tenga huecos.
  await borrarAsiento('1902-03-03');

  const conHueco = await verificarMes(db, { hoy: HOY_BASE, plantas: PLANTAS });
  assert.deepEqual(conHueco.faltantes, ['1902-03-03'], 'la verificación nombra el día que falta');
  assert.equal(conHueco.con_asiento, 3);

  // Relanzar el MISMO comando lo repone y no duplica lo demás: eso es "resumible".
  const r = await ejecutarRelleno({ pool: db, hoy: HOY_BASE, plantas: PLANTAS, leerFn: async () => [] });
  assert.equal(r.creados, 1);
  assert.equal(r.existentes, 3);
  assert.deepEqual((await verificarMes(db, { hoy: HOY_BASE, plantas: PLANTAS })).faltantes, []);

  // La consulta está acotada por planta: los asientos de la fixture no se ven desde las reales.
  const desdeReales = await clavesPresentes(db, { mes: '1902-03', plantas: ['GEC3', 'GEC32'] });
  assert.equal(desdeReales.size, 0, 'ningún asiento de la fixture aparece consultando GEC3/GEC32');
});

// ── Regresión del GATE-O2 (hallazgo R1) ────────────────────────────────────────────────────────
//
// El bug que este caso fija: `main()` abría el pool con `getDB()` y nada más. Los live bindings
// —`USUARIO_SISTEMA_ID` entre ellos— los resuelve `initDB()`, que en un script NO corre, así que
// `crearAsientoDespacho` lanzaba "USUARIO_SISTEMA_ID no inicializado" en CADA día del mes. El
// try/catch por día los contaba como `fallidos` y la corrida terminaba con un resumen de ceros y
// exit 1, sin escribir un solo asiento; el `--dry-run` del ensayo pasaba limpio porque nunca llega
// al escritor.
//
// Y la razón por la que NINGÚN caso de este archivo lo veía: el harness corre `setupSessions()` en
// el `before`, que llama a `initDB()`. En el proceso del test el binding SIEMPRE está resuelto.
// Por eso la verificación tiene que pasar por un proceso HIJO — es el único lugar donde se reproduce
// el estado de arranque real del CLI. No escribe ni una fila: abre el pool, resuelve y lee.
test('9. un proceso nuevo del CLI resuelve USUARIO_SISTEMA_ID antes de escribir', () => {
  const scriptURL = new URL('../scripts/relleno-asiento-despacho.js', import.meta.url).href;
  const snippet = `(async () => {
    const { abrirPool } = await import(${JSON.stringify(scriptURL)});
    const pool = await abrirPool();
    const db = await import(${JSON.stringify(new URL('../db.js', import.meta.url).href)});
    console.log('SISTEMA=' + db.USUARIO_SISTEMA_ID);
    await pool.close();
  })().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });`;

  const r = spawnSync(process.execPath, ['--env-file=../.env', '-e', snippet],
    { cwd: RUTA_SERVER, encoding: 'utf8', timeout: 120_000 });

  assert.equal(r.status, 0, `el arranque del CLI no puede fallar (stderr: ${r.stderr})`);
  const m = /SISTEMA=(\S+)/.exec(r.stdout);
  assert.ok(m, `el hijo tiene que imprimir el binding (stdout: ${r.stdout} · stderr: ${r.stderr})`);
  assert.notEqual(m[1], 'null',
    'USUARIO_SISTEMA_ID quedó en null: el CLI abrió el pool sin resolver los live bindings y '
    + 'crearAsientoDespacho fallaría los 31 días del mes sin escribir nada');
  assert.match(m[1], /^\d+$/, 'el binding tiene que ser el usuario_id de SISTEMA');

  // Y el proceso del test, que sí pasó por initDB, ve el mismo usuario: el CLI no inventa un autor.
  assert.equal(Number(m[1]), USUARIO_SISTEMA_ID);
});

// ── Helpers de escenario ───────────────────────────────────────────────────────────────────────

// Mueve el asiento de un día a `registro_historico`, como haría el cierre de turno.
async function archivarAsiento(fecha_despacho) {
  const db = await getDB();
  await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('sistema', sql.Int, USUARIO_SISTEMA_ID)
    .query(`
      INSERT INTO bitacora.registro_historico
        (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
         cerrado_por, cerrado_en, fecha_cierre_operativo)
      SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
             'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
             @sistema, SYSUTCDATETIME(), CAST(fecha_evento AS DATE)
      FROM bitacora.registro_activo
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave;
    `);

  // El borrado va en su PROPIO request, no pegado al INSERT de arriba: así el acotador de fixture
  // queda léxicamente junto al statement, que es lo que exige el guard de D-055 — un `@tp` bindeado
  // 900 caracteres más arriba no le sirve a quien revisa el diff.
  await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave;
    `);
}

// Borra el asiento de un día de las DOS tablas, para simular una corrida que se cortó.
async function borrarAsiento(fecha_despacho) {
  const db = await getDB();
  await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave;
    `);
  await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.registro_historico
      WHERE planta_id IN (@tp, @tpr) AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave;
    `);
}
