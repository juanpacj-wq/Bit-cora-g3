// D-064 (L04) — Lector del hecho, creador del asiento y barrido cada 5 min.
//
// Cubre CA-1, CA-4, CA-6, CA-7, CA-8, CA-9, CA-10 y CA-11 del flujo REQ-05.
//
// ── Reglas duras de esta suite ──────────────────────────────────────────────────────────────────
// La suite corre contra la BD PRODUCTIVA (D-030) y este lote es el ÚNICO del flujo que escribe
// filas. Por eso:
//   · todo lo que se crea va a las dos plantas-fixture ('TST' y 'TSR'), NUNCA a GEC3/GEC32, y entra
//     por el parámetro `plantas` de `crearAsientoDespacho` — la contramedida estructural de D-061:
//     el guard estático solo ve el DML literal del test, así que una escritura que entrara por el
//     `default` de una función de producción le sería invisible;
//   · toda limpieza va acotada por `TEST_PLANTA`/`TEST_PLANTA_REFLEJO` léxicamente junto al
//     statement (`guard_no_prod_historico_destruction.test.js`);
//   · las fechas de despacho son de **1901**: ningún flujo real puede producirlas, así que ni el
//     libro mensual ni el relleno de L05 se cruzan con estos fixtures.
//
// ── El guard de coherencia de las 4 filas (R12 del code-review de la O1) ────────────────────────
// El libro F03 colapsa las cuatro filas del asiento por `campos_extra.clave_asiento` y se queda con
// el `detalle` y la hora de la de MENOR `registro_id`, descartando las otras tres SIN AVISAR. Nada
// en la BD sostiene que coincidan. `verificarCoherenciaDelAsiento()` es el equivalente del
// `verificarCoherenciaDeLotes()` que D-056 (c) tiene para los lotes de MAND, y se corre después de
// CADA escenario que escribe: si alguien recalcula el texto o la hora por fila —en vez de calcularla
// una vez y heredarla— el asiento se parte y el libro imprime uno de los cuatro renglones al azar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB, USUARIO_SISTEMA_ID } from '../db.js';
import {
  setupSessions, setupSesionReflejo, call, TEST_PLANTA, TEST_PLANTA_REFLEJO,
  deactivateSyntheticSessions,
} from './helpers.js';
import {
  asientoDespachoXM, claveAsientoDespacho, camposExtraDespacho,
  BITACORAS_ASIENTO_SISTEMA, TIPO_EVENTO_DESPACHO_XM, esAsientoDeSistema, esHoraEstimada,
} from '../utils/asientos/sistema.js';
import { crearAsientoDespacho, PLANTAS_DESPACHO } from '../utils/despacho-xm/asiento.js';
import { leerDespachosRecibidos, reiniciarAvisoDegradacion } from '../utils/despacho-xm/lector.js';
import { ejecutarTick, sweeperHabilitado, correrDias } from '../utils/despacho-xm/sweeper.js';
import { canEditarRegistro, esAsientoReflejado } from '../middleware/permissions.js';
import { abrirTurnoSiFalta } from '../utils/turno-entidad.js';
import { periodoFromFechaBogota, turnoFromPeriodo, getTurnoColombia, ventanaActual, fechaBogotaStr } from '../utils/turno.js';

// Fechas-fixture. 1901 no existe en ningún flujo real: ni el sweeper (ventana de ±2 días alrededor
// de hoy) ni el libro mensual ni el relleno pueden toparse con ellas.
const F_BASE = '1901-07-14';
const F_ARCHIVADO = '1901-07-15';
const F_SOLO_UNA_PLANTA = '1901-07-16';
const F_CA11 = '1901-07-17';
const F_TICK = '1901-07-18';

// 15:02:33 hora Bogotá del 13 de julio → 20:02:33 UTC. Es el instante que el LECTOR entrega ya
// convertido; el creador no vuelve a tocarlo.
const DETECTADO_EN = new Date('1901-07-13T20:02:33.000Z');

let ctx;
let SALA_IDS;   // { SALAJDT: bitacora_id, SALAING: bitacora_id }

// ── Limpieza ───────────────────────────────────────────────────────────────────────────────────
// Acotada a las DOS plantas-fixture Y al marcador de ESTE archivo (`DESPACHO_XM|1901-…`), con los
// acotadores léxicamente junto al statement (regla D-055).
//
// Deliberadamente NO se acota por `creado_por = SISTEMA`, aunque el creador siempre escriba con ese
// autor: si una corrida deja una fila con otro autor —pasó durante la verificación bidireccional de
// CA-11, que a propósito escribe el asiento a nombre de una persona— el filtro por autor la dejaría
// viva y la corrida siguiente arrancaría con un asiento envenenado. La clave, en cambio, identifica
// exactamente lo que este archivo crea y nada más: no puede alcanzar la fila de otra suite sobre la
// misma planta-fixture.
const PREFIJO_FIXTURE = 'DESPACHO_XM|1901-%';

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

// Las cabeceras de turno que este archivo abre para el caso HTTP de CA-11. Se desmontan enteras:
// una cabecera residual de 'TST' fuera de ventana vuelve intermitentes a otras suites (el sweeper no
// la toca porque solo barre GEC3/GEC32), así que la fixture tiene que quedar con CERO cabeceras.
async function limpiarTurnos() {
  const db = await getDB();
  await db.request().input('p', sql.VarChar(10), TEST_PLANTA).query(`
    UPDATE ra SET turno_id = NULL FROM bitacora.registro_activo ra
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = ra.turno_id WHERE tu.planta_id = @p;
    UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
    DELETE tp FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
    DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
  `);
}

async function filasDelAsiento(fecha_despacho) {
  const db = await getDB();
  const r = await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .query(`
      SELECT ra.registro_id, ra.bitacora_id, ra.planta_id, ra.fecha_evento, ra.turno, ra.detalle,
             ra.campos_extra, ra.tipo_evento_id, ra.estado, ra.creado_por, ra.turno_id,
             ra.ingenieros_snapshot, ra.jdts_snapshot, ra.jefes_snapshot,
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

// El guard de coherencia (R12). Las cuatro filas TIENEN que ser indistinguibles en todo lo que el
// libro mira, y su `tipo_evento_id` tiene que ser el de SU PROPIA bitácora (no hay FK que lo ate:
// D-053, `guard_tipo_evento_coherente`).
function verificarCoherenciaDelAsiento(filas, { fecha_despacho, esperadas }) {
  assert.equal(filas.length, esperadas, `el asiento de ${fecha_despacho} debe tener ${esperadas} filas`);

  const detalles = new Set(filas.map((f) => f.detalle));
  assert.equal(detalles.size, 1, `las filas divergen en el detalle: ${[...detalles].join(' | ')}`);

  const horas = new Set(filas.map((f) => f.fecha_evento.getTime()));
  assert.equal(horas.size, 1,
    `las filas divergen en fecha_evento (un solo instante de Node para las cuatro): ${[...horas].join(' | ')}`);

  const claves = new Set(filas.map((f) => JSON.parse(f.campos_extra).clave_asiento));
  assert.equal(claves.size, 1, `las filas divergen en clave_asiento: ${[...claves].join(' | ')}`);
  assert.equal([...claves][0], claveAsientoDespacho(fecha_despacho));

  const extras = new Set(filas.map((f) => f.campos_extra));
  assert.equal(extras.size, 1, 'las filas divergen en campos_extra');

  const turnos = new Set(filas.map((f) => f.turno));
  assert.equal(turnos.size, 1, 'las filas divergen en la columna turno');

  for (const f of filas) {
    assert.equal(f.tipo_evento_nombre, TIPO_EVENTO_DESPACHO_XM);
    assert.equal(f.te_bitacora_id, f.bitacora_id,
      `${f.bitacora_codigo}: el tipo_evento_id es de OTRA bitácora (drift invisible, D-053)`);
    assert.equal(f.creado_por, USUARIO_SISTEMA_ID, 'el autor tiene que ser SISTEMA');
    assert.equal(f.estado, 'borrador');
    assert.ok(esAsientoDeSistema(f.campos_extra), 'la fila tiene que llevar el marcador origen_sistema');
    assert.equal(esAsientoReflejado(f), false,
      'el asiento NO es una copia reflejada: origen_sistema no puede confundirse con origen_bitacora');
  }
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  await setupSesionReflejo();   // siembra la planta-fixture 'TSR' (activa = 0) y su usuario
  const db = await getDB();
  const r = await db.request().query(
    `SELECT codigo, bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SALAJDT', 'SALAING')`);
  SALA_IDS = Object.fromEntries(r.recordset.map((x) => [x.codigo, x.bitacora_id]));
  assert.ok(SALA_IDS.SALAJDT && SALA_IDS.SALAING, 'SALAJDT y SALAING deben existir');
  await limpiarAsientos();
  await limpiarTurnos();
  reiniciarAvisoDegradacion();
});

after(async () => {
  await limpiarAsientos();
  await limpiarTurnos();
  await deactivateSyntheticSessions();
});

// ── CA-1 ───────────────────────────────────────────────────────────────────────────────────────
test('1. crea los asientos con autor SISTEMA (CA-1)', async () => {
  const db = await getDB();
  const r = await crearAsientoDespacho(db, {
    fecha_despacho: F_BASE,
    detectado_en: DETECTADO_EN,
    plantas: [TEST_PLANTA, TEST_PLANTA_REFLEJO],
  });
  assert.deepEqual(r, { creado: true, filas: 4 }, 'la primera escritura crea las 4 filas');

  const filas = await filasDelAsiento(F_BASE);
  verificarCoherenciaDelAsiento(filas, { fecha_despacho: F_BASE, esperadas: 4 });

  // Las 4 combinaciones exactas: 2 bitácoras de Sala × 2 unidades.
  const combinaciones = filas.map((f) => `${f.planta_id}/${f.bitacora_codigo}`).sort();
  assert.deepEqual(combinaciones, [
    `${TEST_PLANTA}/SALAING`, `${TEST_PLANTA}/SALAJDT`,
    `${TEST_PLANTA_REFLEJO}/SALAING`, `${TEST_PLANTA_REFLEJO}/SALAJDT`,
  ].sort());

  // El texto LITERAL del F03: sin punto final y sin prefijo de unidad, con la fecha en guiones.
  // El libro imprime este `detalle` tal cual, así que un espacio de más se ve en el papel.
  assert.equal(filas[0].detalle, 'Se recibe del XM despacho económico de G3.0 y G3.2 para el 14-07-1901');
  assert.equal(filas[0].detalle, asientoDespachoXM(F_BASE));

  // La hora del renglón es la de DETECCIÓN, no la de la escritura: es lo que el operador espera leer
  // y lo que va al libro. Comparación al milisegundo — es el punto donde una conversión de zona
  // repetida (o un `GETDATE()` colado) se delata.
  assert.equal(filas[0].fecha_evento.toISOString(), DETECTADO_EN.toISOString());
  assert.equal(filas[0].turno, turnoFromPeriodo(periodoFromFechaBogota(DETECTADO_EN)));
  assert.equal(filas[0].turno, 1, '15:02 Bogotá cae en T1');

  // `campos_extra` es exactamente el que produce el módulo puro de L02, con `hora_estimada`
  // PRESENTE en false (nunca ausente) y sin `origen_bitacora`.
  const extra = JSON.parse(filas[0].campos_extra);
  assert.deepEqual(extra, camposExtraDespacho({ fecha_despacho: F_BASE }));
  assert.equal(extra.origen_sistema, 'DESPACHO_XM');
  assert.equal(extra.hora_estimada, false);
  assert.equal(esHoraEstimada(filas[0].campos_extra), false);
  assert.equal(Object.hasOwn(extra, 'origen_bitacora'), false);

  for (const f of filas) {
    assert.equal(f.ingenieros_snapshot, '[]');
    assert.equal(f.jdts_snapshot, '[]');
    assert.equal(f.jefes_snapshot, '[]');
  }
});

// ── CA-4 ───────────────────────────────────────────────────────────────────────────────────────
test('2. idempotente ante repeticiones (activo e histórico) (CA-4)', async () => {
  const db = await getDB();

  // (a) Segunda pasada con el asiento VIVO en registro_activo.
  const repetido = await crearAsientoDespacho(db, {
    fecha_despacho: F_BASE, detectado_en: new Date('1901-07-13T21:00:00.000Z'),
    plantas: [TEST_PLANTA, TEST_PLANTA_REFLEJO],
  });
  assert.deepEqual(repetido, { creado: false, filas: 0, motivo: 'ya_existe' });
  const trasRepetir = await filasDelAsiento(F_BASE);
  assert.equal(trasRepetir.length, 4, 'sigue habiendo UN solo asiento (4 filas)');
  assert.equal(trasRepetir[0].fecha_evento.toISOString(), DETECTADO_EN.toISOString(),
    'la hora del asiento original no se pisa');

  // (b) El caso que de verdad importa: el asiento YA FUE ARCHIVADO por el cierre de turno. Buscarlo
  // solo en `registro_activo` lo duplicaría — es exactamente lo que le va a pasar al relleno del mes
  // de L05, que trabaja sobre días pasados.
  const creado = await crearAsientoDespacho(db, {
    fecha_despacho: F_ARCHIVADO, detectado_en: DETECTADO_EN,
    plantas: [TEST_PLANTA, TEST_PLANTA_REFLEJO],
  });
  assert.equal(creado.filas, 4);

  await archivarAsiento(F_ARCHIVADO);
  assert.equal((await filasDelAsiento(F_ARCHIVADO)).length, 0, 'ya no queda nada en registro_activo');
  assert.equal(await filasArchivadas(F_ARCHIVADO), 4, 'las 4 filas están en el histórico');

  const trasArchivar = await crearAsientoDespacho(db, {
    fecha_despacho: F_ARCHIVADO, detectado_en: DETECTADO_EN,
    plantas: [TEST_PLANTA, TEST_PLANTA_REFLEJO],
  });
  assert.deepEqual(trasArchivar, { creado: false, filas: 0, motivo: 'ya_existe' },
    'el asiento archivado también cuenta: la idempotencia mira LAS DOS tablas');
  assert.equal((await filasDelAsiento(F_ARCHIVADO)).length, 0,
    'no se escribió un duplicado en registro_activo');
});

// ── CA-6 ───────────────────────────────────────────────────────────────────────────────────────
test('3. solo GEC3 y GEC32 (CA-6)', async () => {
  // La lista de destinos la decide el módulo, no el hecho: la tabla del dashboard anuncia un DÍA,
  // sin planta. Las Guajiras no están y no pueden agregarse en caliente.
  assert.deepEqual([...PLANTAS_DESPACHO], ['GEC3', 'GEC32']);
  assert.equal(PLANTAS_DESPACHO.includes('TGJ1'), false);
  assert.equal(PLANTAS_DESPACHO.includes('TGJ2'), false);
  assert.ok(Object.isFrozen(PLANTAS_DESPACHO), 'la lista está congelada');
  assert.throws(() => PLANTAS_DESPACHO.push('TGJ1'), TypeError,
    'un consumidor no puede sumarle una unidad al array exportado');

  // Y el creador escribe EXACTAMENTE en las unidades que recibe: ni una más. Es lo que hace que la
  // constante de arriba sea la única fuente de qué plantas se asientan.
  const db = await getDB();
  const r = await crearAsientoDespacho(db, {
    fecha_despacho: F_SOLO_UNA_PLANTA, detectado_en: DETECTADO_EN, plantas: [TEST_PLANTA],
  });
  assert.deepEqual(r, { creado: true, filas: 2 });

  const filas = await filasDelAsiento(F_SOLO_UNA_PLANTA);
  verificarCoherenciaDelAsiento(filas, { fecha_despacho: F_SOLO_UNA_PLANTA, esperadas: 2 });
  assert.deepEqual([...new Set(filas.map((f) => f.planta_id))], [TEST_PLANTA],
    'ninguna unidad fuera de la lista recibió el asiento');
  assert.deepEqual(filas.map((f) => f.bitacora_codigo).sort(), [...BITACORAS_ASIENTO_SISTEMA].sort());
});

// ── CA-7 ───────────────────────────────────────────────────────────────────────────────────────
test('4. sin hecho no hay asiento (CA-7)', async () => {
  const db = await getDB();

  // (a) El sweeper con un lector que no encuentra nada: ni siquiera llama al creador.
  let llamadasAlCreador = 0;
  const resumen = await ejecutarTick({
    pool: db,
    leerFn: async () => [],
    crearFn: async () => { llamadasAlCreador += 1; return { creado: true, filas: 4 }; },
    hoy: '1901-07-18',
    log: () => {}, logError: () => {},
  });
  assert.deepEqual(resumen, { revisados: 0, creados: 0, existentes: 0, fallidos: 0 });
  assert.equal(llamadasAlCreador, 0, 'sin hecho, el creador ni se invoca');
  assert.equal((await filasDelAsiento(F_TICK)).length, 0, 'no apareció ningún renglón');

  // (b) Y el lector real, contra la BD real, sobre un rango sin hechos: lista vacía.
  const vacio = await leerDespachosRecibidos(db, { desde: '1901-01-01', hasta: '1901-12-31', log: () => {} });
  assert.deepEqual(vacio, [], 'no hay hechos de 1901 en dashboard.despacho_recibido');
});

// ── CA-8 ───────────────────────────────────────────────────────────────────────────────────────
test('5. degrada sin tabla (CA-8)', async () => {
  const db = await getDB();

  // (a) Contra la BD REAL. Mientras el dashboard no se despliegue, `dashboard.despacho_recibido` no
  // existe y esta es la rama que corre de verdad; cuando exista, la consulta funciona. Las dos son
  // correctas y ninguna puede lanzar — que es lo que el criterio pide.
  const existe = (await db.request().query(
    `SELECT OBJECT_ID('dashboard.despacho_recibido','U') AS oid`)).recordset[0].oid;
  reiniciarAvisoDegradacion();
  const avisos = [];
  const leido = await leerDespachosRecibidos(db, {
    desde: '1901-01-01', hasta: '1901-01-02', log: (m) => avisos.push(m),
  });
  assert.ok(Array.isArray(leido), 'siempre devuelve un array, exista o no la tabla');
  if (existe === null) {
    assert.deepEqual(leido, [], 'sin tabla, lista vacía');
    assert.equal(avisos.length, 1, 'y un aviso, uno solo');
    assert.match(avisos[0], /despacho-xm/);
  } else {
    assert.equal(avisos.length, 0, 'con la tabla presente no hay degradación que avisar');
  }

  // (b) El caso exacto del despliegue por delante del dashboard, determinista: la consulta falla con
  // `Invalid object name`. Se loguea UNA vez aunque se llame dos, porque el sweeper vuelve cada 5
  // minutos y repetirlo llenaría el journal de una línea ya leída.
  reiniciarAvisoDegradacion();
  const sinTabla = poolQueFalla(
    Object.assign(new Error("Invalid object name 'dashboard.despacho_recibido'."), { code: 'EREQUEST' }));
  const log1 = [];
  assert.deepEqual(await leerDespachosRecibidos(sinTabla, { desde: '1901-01-01', hasta: '1901-01-02', log: (m) => log1.push(m) }), []);
  assert.deepEqual(await leerDespachosRecibidos(sinTabla, { desde: '1901-01-01', hasta: '1901-01-02', log: (m) => log1.push(m) }), []);
  assert.equal(log1.length, 1, 'se loguea una vez, no en cada tick');
  assert.match(log1[0], /Invalid object name/);

  // (c) Una lectura exitosa REINICIA la latch: si la tabla vuelve a caerse, hay que enterarse.
  // Silenciar para siempre sería peor que repetir.
  const log2 = [];
  await leerDespachosRecibidos(db, { desde: '1901-01-01', hasta: '1901-01-02', log: (m) => log2.push(m) });
  if (existe !== null) {
    await leerDespachosRecibidos(sinTabla, { desde: '1901-01-01', hasta: '1901-01-02', log: (m) => log2.push(m) });
    assert.equal(log2.length, 1, 'tras una lectura buena, la degradación vuelve a avisar');
  }

  // (d) Un rango inválido tampoco lanza: el contrato dice NUNCA lanza, sin excepciones.
  reiniciarAvisoDegradacion();
  const log3 = [];
  assert.deepEqual(await leerDespachosRecibidos(db, { desde: 'ayer', hasta: null, log: (m) => log3.push(m) }), []);
  assert.equal(log3.length, 1);

  // (e) Y el tick del sweeper completa aunque el lector explote: un throw acá sería un
  // `unhandledRejection` que tumba el proceso entero.
  const errores = [];
  const resumen = await ejecutarTick({
    pool: db,
    leerFn: async () => { throw new Error('BD caída'); },
    crearFn: async () => { throw new Error('no debería llegar acá'); },
    hoy: '1901-07-18', log: () => {}, logError: (m) => errores.push(m),
  });
  assert.deepEqual(resumen, { revisados: 0, creados: 0, existentes: 0, fallidos: 0 });
  assert.equal(errores.length, 1);
  assert.match(errores[0], /tick abortado/);

  // (f) Y un día malo no se lleva a los otros por delante: los productores del asiento LANZAN ante
  // una fecha que no existe (hecho 2 del GATE-O1), así que el tick se salta ESE día y sigue.
  const errores2 = [];
  const resumen2 = await ejecutarTick({
    pool: db,
    leerFn: async () => ([
      { fecha_despacho: '1901-02-30', detectado_en: DETECTADO_EN },
      { fecha_despacho: F_TICK, detectado_en: DETECTADO_EN },
    ]),
    crearFn: async (_pool, opciones) => {
      claveAsientoDespacho(opciones.fecha_despacho);   // lanza con la fecha que no existe
      return { creado: true, filas: 4 };
    },
    hoy: '1901-07-18', log: () => {}, logError: (m) => errores2.push(m),
  });
  assert.deepEqual(resumen2, { revisados: 2, creados: 1, existentes: 0, fallidos: 1 });
  assert.equal(errores2.length, 1);
  assert.match(errores2[0], /1901-02-30/);
});

// ── CA-9 ───────────────────────────────────────────────────────────────────────────────────────
test('6. no toca Operación 24h (CA-9)', async () => {
  const db = await getDB();
  const antes = await conteoMand();
  const r = await crearAsientoDespacho(db, {
    fecha_despacho: '1901-07-19', detectado_en: DETECTADO_EN, plantas: [TEST_PLANTA],
  });
  assert.equal(r.creado, true);
  const despues = await conteoMand();
  assert.deepEqual(despues, antes,
    'el asiento no crea ni borra una sola fila de MAND: no pasa por la grilla de captura (RQ-05.11)');
  await borrarAsiento('1901-07-19');
});

// ── CA-10 ──────────────────────────────────────────────────────────────────────────────────────
test('7. no republica al dashboard (CA-10)', async () => {
  const db = await getDB();
  const antes = await huellaDashboard();
  const r = await crearAsientoDespacho(db, {
    fecha_despacho: '1901-07-20', detectado_en: DETECTADO_EN, plantas: [TEST_PLANTA],
  });
  assert.equal(r.creado, true);
  const despues = await huellaDashboard();
  assert.deepEqual(despues, antes,
    'evento_dashboard y disponibilidad_estado quedan intactos: el dato vino del dashboard y ' +
    'devolvérselo sería un ciclo (RQ-05.12)');
  await borrarAsiento('1901-07-20');
});

// ── CA-11 ──────────────────────────────────────────────────────────────────────────────────────
test('8. no lo edita nadie, por autoría (CA-11)', async () => {
  const db = await getDB();
  await crearAsientoDespacho(db, {
    fecha_despacho: F_CA11, detectado_en: DETECTADO_EN, plantas: [TEST_PLANTA],
  });
  const [asiento] = (await filasDelAsiento(F_CA11)).filter((f) => f.planta_id === TEST_PLANTA);
  assert.ok(asiento, 'el asiento existe en la planta-fixture');

  // (a) La regla, al nivel donde vive: `canEditarRegistro` exige autoría, y SISTEMA (activo = 0)
  // nunca tiene sesión. Ningún cargo pasa — tampoco el ADMIN, que es el único con puede_crear en
  // TODAS las bitácoras (D-039). No hizo falta tocar `permissions.js`: sale gratis de D-049.
  const sesiones = await sesionesDeTest();
  assert.ok(sesiones.length >= 5, 'hay que probar contra varios cargos, no contra uno');
  for (const sesion of sesiones) {
    assert.equal(await canEditarRegistro(sesion, asiento), false,
      `${sesion.cargo_nombre} no puede editar el asiento del sistema`);
  }

  // Contraprueba del fixture: la MISMA forma de sesión SÍ autoriza sobre una fila propia. Sin esto,
  // el `false` de arriba podría venir de un objeto de sesión mal armado y el test sería un verde
  // falso.
  const propia = { ...asiento, creado_por: sesiones[0].usuario_id, bitacora_id: SALA_IDS.SALAJDT, campos_extra: null };
  const admin = sesiones.find((s) => s.cargo_nombre === 'Administrador y Debugging');
  assert.ok(admin, 'el fixture del ADMIN es necesario para la contraprueba');
  assert.equal(await canEditarRegistro({ ...admin, usuario_id: sesiones[0].usuario_id }, propia), true,
    'PRECONDICIÓN: con autoría y puede_crear, este mismo helper sí autoriza');

  // (b) Y por HTTP, que es por donde entraría un operador. El turno de la unidad se abre a propósito:
  // sin turno ABIERTO el endpoint contestaría 409 `turno_cerrado` y el 403 quedaría sin probar.
  await abrirTurnoSiFalta(db, TEST_PLANTA, getTurnoColombia(), fechaBogotaStr(ventanaActual(new Date()).inicio));

  for (const sesionKey of ['admin', 'jdt', 'ingOp']) {
    const put = await call('PUT', `/api/registros/${asiento.registro_id}`, {
      sesion_id: ctx.sesiones[sesionKey],
      body: { detalle: 'intento de edición del asiento del sistema' },
    });
    assert.equal(put.status, 403, `${sesionKey} PUT esperaba 403, fue ${put.status} ${JSON.stringify(put.data)}`);
    // `solo_autor` y NO `asiento_reflejado`: el marcador de este asiento es `origen_sistema`, que es
    // deliberadamente distinto de `origen_bitacora` (si fuera ese, el libro F03 lo excluiría).
    assert.equal(put.data.codigo, 'solo_autor');

    const del = await call('DELETE', `/api/registros/${asiento.registro_id}`, { sesion_id: ctx.sesiones[sesionKey] });
    assert.equal(del.status, 403, `${sesionKey} DELETE esperaba 403, fue ${del.status} ${JSON.stringify(del.data)}`);
    assert.equal(del.data.codigo, 'solo_autor');
  }

  const intacto = (await filasDelAsiento(F_CA11)).filter((f) => f.planta_id === TEST_PLANTA);
  assert.equal(intacto.length, 2, 'las dos filas siguen ahí');
  assert.equal(intacto[0].detalle, asientoDespachoXM(F_CA11), 'y con su texto original');
});

// ── El barrido ─────────────────────────────────────────────────────────────────────────────────
test('9. el tick asienta cada hecho que lee, y repetirlo no duplica nada', async () => {
  const db = await getDB();
  const hechos = [{ fecha_despacho: F_TICK, detectado_en: DETECTADO_EN }];
  const crearFn = (pool, opciones) => crearAsientoDespacho(pool, { ...opciones, plantas: [TEST_PLANTA] });

  const primero = await ejecutarTick({
    pool: db, leerFn: async () => hechos, crearFn, hoy: '1901-07-18', log: () => {}, logError: () => {},
  });
  assert.deepEqual(primero, { revisados: 1, creados: 1, existentes: 0, fallidos: 0 });
  verificarCoherenciaDelAsiento(await filasDelAsiento(F_TICK), { fecha_despacho: F_TICK, esperadas: 2 });

  const segundo = await ejecutarTick({
    pool: db, leerFn: async () => hechos, crearFn, hoy: '1901-07-18', log: () => {}, logError: () => {},
  });
  assert.deepEqual(segundo, { revisados: 1, creados: 0, existentes: 1, fallidos: 0 },
    'el segundo tick reconoce el asiento existente y no escribe');
  assert.equal((await filasDelAsiento(F_TICK)).length, 2, 'sigue habiendo un solo asiento');
});

test('10. la ventana del tick mira hacia adelante (el hecho de hoy anuncia MAÑANA) y dos días atrás', async () => {
  const db = await getDB();
  let rango = null;
  await ejecutarTick({
    pool: db,
    leerFn: async (_pool, r) => { rango = r; return []; },
    crearFn: async () => ({ creado: false, filas: 0, motivo: 'ya_existe' }),
    hoy: '2026-03-01', log: () => {}, logError: () => {},
  });
  // Hacia adelante hace falta 1 día porque el hecho que llega hoy a las 15:00 anuncia el día
  // siguiente: sin esa holgura el asiento del día no entraría nunca en la ventana. Hacia atrás, 2
  // días para que un reinicio no cueste un renglón.
  assert.deepEqual(rango, { desde: '2026-02-27', hasta: '2026-03-02' });

  // Y el corrimiento de días cruza meses y años sin ayuda del reloj local.
  assert.equal(correrDias('2026-01-01', -1), '2025-12-31');
  assert.equal(correrDias('2024-02-28', 1), '2024-02-29', 'año bisiesto');
  assert.equal(correrDias('2026-12-31', 1), '2027-01-01');
});

test('11. el sweeper NO arranca en un backend de test, y el apagado se anuncia', () => {
  // La lección de D-061: un flag que hay que acordarse de poner no protege nada. Este sweeper es el
  // único que escribe FILAS en las bitácoras de Sala de plantas reales, así que en un proceso con el
  // backdoor de test encendido viene apagado POR DEFECTO — sin depender de que nadie exporte nada.
  const test1 = sweeperHabilitado({ AUTH_TEST_BYPASS: '1' });
  assert.equal(test1.habilitado, false);
  assert.match(test1.motivo, /AUTH_TEST_BYPASS/);

  // Producción: sin variables, encendido. Ningún despliegue puede perder la ingesta por omisión.
  assert.equal(sweeperHabilitado({}).habilitado, true);
  assert.equal(sweeperHabilitado({ NODE_ENV: 'production' }).habilitado, true);

  // Apagado explícito (runbook): SOLO el string exacto '0'.
  assert.equal(sweeperHabilitado({ DESPACHO_XM_SWEEPER_ENABLED: '0' }).habilitado, false);
  assert.equal(sweeperHabilitado({ DESPACHO_XM_SWEEPER_ENABLED: 'false' }).habilitado, true);
  assert.equal(sweeperHabilitado({ DESPACHO_XM_SWEEPER_ENABLED: '' }).habilitado, true);

  // Encendido explícito: gana incluso sobre el backdoor de test, para poder ejercitarlo a mano.
  assert.equal(sweeperHabilitado({ AUTH_TEST_BYPASS: '1', DESPACHO_XM_SWEEPER_ENABLED: '1' }).habilitado, true);

  // Todos los caminos traen motivo: un sweeper mudo es indistinguible de uno roto.
  for (const env of [{}, { AUTH_TEST_BYPASS: '1' }, { DESPACHO_XM_SWEEPER_ENABLED: '0' }]) {
    assert.ok(sweeperHabilitado(env).motivo, 'siempre hay un motivo que anunciar');
  }
});

// ── Auxiliares ─────────────────────────────────────────────────────────────────────────────────

// Simula el archivado que hace el cierre de turno: mueve las filas del asiento a
// `registro_historico` preservando el `registro_id`, igual que `cerrarTurno`/`cerrarDiaMand`.
// Acotado a las dos plantas-fixture, léxicamente junto al statement.
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

  // El borrado del activo va en su PROPIO request y no pegado al INSERT de arriba: así el acotador
  // de fixture queda léxicamente junto al statement, que es lo que exige (y verifica) el guard de
  // D-055 — un `@tp` bindeado 900 caracteres más arriba no le sirve a quien revisa el diff.
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

async function filasArchivadas(fecha_despacho) {
  const db = await getDB();
  const r = await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .query(`
      SELECT COUNT(*) AS n FROM bitacora.registro_historico
      WHERE ISJSON(campos_extra) = 1 AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave
    `);
  return r.recordset[0].n;
}

// Borra UN asiento por su clave, acotado a la planta-fixture (el acotador va en el `.input(...)`
// que precede al statement). Tampoco mira el autor, por la misma razón que `limpiarAsientos`.
async function borrarAsiento(fecha_despacho) {
  const db = await getDB();
  await db.request()
    .input('clave', sql.NVarChar(200), claveAsientoDespacho(fecha_despacho))
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE planta_id = @tp AND ISJSON(campos_extra) = 1
        AND JSON_VALUE(campos_extra, '$.clave_asiento') = @clave
    `);
}

// Huella de MAND: cuántas filas hay y cuál es el último id. Si el asiento tocara la grilla de
// captura —o cerrara un día— alguno de los dos se movería.
async function conteoMand() {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT (SELECT COUNT(*) FROM bitacora.registro_activo ra
              INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
            WHERE b.codigo = 'MAND') AS activos,
           (SELECT COUNT(*) FROM bitacora.registro_historico rh
              INNER JOIN lov_bit.bitacora b ON b.bitacora_id = rh.bitacora_id
            WHERE b.codigo = 'MAND') AS historicos,
           (SELECT COUNT(*) FROM bitacora.mand_cierre_log) AS cierres
  `);
  return r.recordset[0];
}

// Huella de lo que Bitácora le publica al dashboard. Se lee de las TABLAS BASE, nunca de las vistas
// (D-041: son de solo lectura por trigger, y un DML por ahí cascadearía a la base).
async function huellaDashboard() {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT (SELECT COUNT(*) FROM bitacora.evento_dashboard) AS eventos,
           (SELECT COUNT(*) FROM bitacora.evento_dashboard WHERE activa = 1) AS eventos_activos,
           (SELECT COUNT(*) FROM bitacora.disponibilidad_estado) AS disponibilidad
  `);
  return r.recordset[0];
}

// Las sesiones de test, con el shape EXACTO que `canEditarRegistro` consume (`usuario_id`,
// `planta_id`, `cargo_id`). Se leen de `sesion_activa` en vez de armarse a mano: así el test no
// puede pasar por un objeto inventado que el helper rechace por otra razón.
async function sesionesDeTest() {
  const db = await getDB();
  const ids = Object.values(ctx.sesiones).join(',');
  const r = await db.request().query(`
    SELECT sa.sesion_id, sa.usuario_id, sa.planta_id, sa.cargo_id, c.nombre AS cargo_nombre
    FROM bitacora.sesion_activa sa
    INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
    WHERE sa.sesion_id IN (${ids})
  `);
  return r.recordset;
}

// Un `pool` mínimo que reproduce el fallo de la consulta sin depender del estado de la BD. Solo
// implementa lo que el lector usa: `.request().input().query()`.
function poolQueFalla(err) {
  const req = { input() { return req; }, query() { return Promise.reject(err); } };
  return { request: () => req };
}
