import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { scrapeDia } from '../utils/sis/carbon-scraper.js';
import { TEST_PLANTA, ensurePlantaCombTest } from './helpers.js';

// D-029 / E3: tests de la regla de ownership de carbon-scraper.scrapeDia(). BD real +
// fetchPeriod MOCKEADO por inyección de dependencia (fetchFn) → no toca el SIS ni la red.
// Cubre las 6 filas de la tabla de ownership de _CONTEXTO-BASE.md + el log.
//
// SIS-owned ⇔ creado_por=SISTEMA AND (modificado_por IS NULL OR modificado_por=SISTEMA).
// "operador gana": humano-owned ⇒ el SIS solo escribe la sombra valor_sis.
//
// D-061 (L06 · CA-26): corre sobre la planta-fixture, NO sobre GEC32. Escribía y borraba celdas y
// `sis_scrape_log` REALES de GEC32 en una fecha fija que se daba por vacía — y dejó de estarlo en
// cuanto el backfill histórico de D-061 empezó a poblar el año entero sobre la misma BD contra la
// que corre la suite (D-030/D-055). La fixture tiene sus propios ALIM_1..8 (seed C12 de `db.js`),
// así que `scrapeDia` la trata igual que a GEC32: lo único que cambia es dónde aterrizan las filas.

const PLANTA = TEST_PLANTA;
const FECHA = '2026-04-16'; // fecha pasada fija, distinta de la de los otros suites de COMB/SIS.

let db, sistemaId, humanoId, alim1;

// lastRow 1-indexado [1..8]=tolvas, [9]=energía, [10]=v659, [11]=v651, [12]=mpaflow.
// En servicio ⇔ v659>400 && v651>400 && mpaflow>140.
function lastRowEnServicio(tolva1) {
  const r = [];
  r[1] = tolva1;
  for (let i = 2; i <= 8; i++) r[i] = 0;
  r[9] = 160;            // energía MW
  r[10] = 500; r[11] = 500; r[12] = 200; // sensores → en servicio
  return r;
}
function lastRowFuera() {
  const r = [];
  for (let i = 1; i <= 12; i++) r[i] = 0;
  return r;
}

// Mock de fetchFn: devuelve la lectura objetivo SOLO en targetPeriodo (h1 = periodo-1);
// el resto del día queda fuera de servicio (validado 0 → skip en celdas inexistentes).
function mockFetch(targetPeriodo, tolva1Value) {
  return async (_f1, h1) => {
    const periodo = Number(h1) + 1;
    const lastRow = periodo === targetPeriodo
      ? lastRowEnServicio(tolva1Value)
      : lastRowFuera();
    return { lastRow, ncols: 12 };
  };
}

async function cleanFecha() {
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f`);
}

// Inserta una celda directamente con dueño controlado (para preparar estados previos).
async function insertCelda({ periodo, cantidad, creadoPor, modificadoPor = null, valorSis = null }) {
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .input('per', sql.TinyInt, periodo)
    .input('cid', sql.Int, alim1)
    .input('cant', sql.Decimal(12, 3), cantidad)
    .input('cre', sql.Int, creadoPor)
    .input('mod', sql.Int, modificadoPor)
    .input('vsis', sql.Decimal(12, 3), valorSis)
    .query(`
      INSERT INTO bitacora.consumo_combustible
        (planta_id, fecha, periodo, combustible_id, cantidad, creado_por, modificado_por, valor_sis)
      VALUES (@p, @f, @per, @cid, @cant, @cre, @mod, @vsis)
    `);
}

async function getCelda(periodo) {
  return (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .input('per', sql.TinyInt, periodo)
    .input('cid', sql.Int, alim1)
    .query(`
      SELECT consumo_id, cantidad, valor_sis, creado_por, modificado_por
      FROM bitacora.consumo_combustible
      WHERE planta_id=@p AND fecha=@f AND periodo=@per AND combustible_id=@cid
    `)).recordset[0];
}

before(async () => {
  db = await getDB();
  // La fixture y su catálogo: este suite no abre sesiones de app, así que no pasa por
  // `setupSessions` y tiene que sembrarlas él mismo (idempotente).
  await ensurePlantaCombTest();

  sistemaId = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username='SISTEMA'`)
  ).recordset[0]?.usuario_id;
  assert.ok(sistemaId, 'usuario SISTEMA debe existir (F16.A3)');

  const pwd = await hashPassword('1234');
  await db.request()
    .input('nombre', sql.VarChar(200), 'Test SIS Humano')
    .input('username', sql.VarChar(50), 'test_sis_human')
    .input('pwd', sql.VarChar(200), pwd)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET activo=1, nombre_completo=@nombre
      WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
        VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1);
    `);
  humanoId = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username='test_sis_human'`)
  ).recordset[0].usuario_id;

  // Por CÓDIGO, nunca por id: los combustibles de la fixture tienen `combustible_id` distintos de
  // los de GEC3/GEC32 (los sembró otro MERGE) y hardcodear uno ataría el test a la BD de turno.
  alim1 = (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .query(`SELECT combustible_id FROM lov_bit.combustible WHERE planta_id=@p AND codigo='ALIM_1'`)
  ).recordset[0]?.combustible_id;
  assert.ok(alim1, `combustible ALIM_1 de ${PLANTA} debe existir (seed C12, D-061)`);
});

beforeEach(async () => { await cleanFecha(); });

after(async () => {
  await cleanFecha();
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`DELETE FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`);
});

test('1. celda inexistente + SIS>0 ⇒ INSERT (creado_por=SISTEMA, cantidad=valor_sis)', async () => {
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockFetch(1, 12.5) });
  assert.equal(r.creados, 1);
  const cell = await getCelda(1);
  assert.ok(cell, 'debe existir la celda insertada');
  assert.equal(Number(cell.cantidad), 12.5);
  assert.equal(Number(cell.valor_sis), 12.5);
  assert.equal(cell.creado_por, sistemaId);
  assert.equal(cell.modificado_por, null);
});

test('2. celda SIS-owned + SIS nuevo>0 ⇒ UPDATE cantidad y valor_sis', async () => {
  await insertCelda({ periodo: 2, cantidad: 10.0, creadoPor: sistemaId, valorSis: 10.0 });
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockFetch(2, 20.0) });
  assert.equal(r.actualizados, 1);
  const cell = await getCelda(2);
  assert.equal(Number(cell.cantidad), 20.0);
  assert.equal(Number(cell.valor_sis), 20.0);
  assert.equal(cell.creado_por, sistemaId);
});

test('3. celda humano-owned + SIS>0 ⇒ cantidad intacta, solo valor_sis actualizado', async () => {
  await insertCelda({ periodo: 3, cantidad: 99.0, creadoPor: humanoId, modificadoPor: humanoId });
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockFetch(3, 7.0) });
  const cell = await getCelda(3);
  assert.equal(Number(cell.cantidad), 99.0, 'cantidad humana intacta');
  assert.equal(Number(cell.valor_sis), 7.0, 'sombra actualizada');
  assert.equal(cell.modificado_por, humanoId, 'modificado_por NO debe pasar a SISTEMA');
  assert.equal(r.actualizados, 1);
});

test('4. celda SIS-owned + SIS=0 ⇒ DELETE', async () => {
  await insertCelda({ periodo: 4, cantidad: 5.0, creadoPor: sistemaId, valorSis: 5.0 });
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockFetch(4, 0) });
  assert.equal(r.eliminados, 1);
  const cell = await getCelda(4);
  assert.ok(!cell, 'la celda SIS-owned con SIS=0 debe borrarse');
});

test('5. celda humano-owned + SIS=0 ⇒ cantidad intacta, valor_sis=0', async () => {
  await insertCelda({ periodo: 5, cantidad: 50.0, creadoPor: humanoId, modificadoPor: humanoId, valorSis: 5.0 });
  await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockFetch(5, 0) });
  const cell = await getCelda(5);
  assert.ok(cell, 'la celda humana NO se borra');
  assert.equal(Number(cell.cantidad), 50.0, 'cantidad humana intacta');
  assert.equal(Number(cell.valor_sis), 0, 'sombra a 0');
  assert.equal(cell.modificado_por, humanoId);
});

test('6. sis_scrape_log queda con el resumen correcto', async () => {
  await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'backfill', fetchFn: mockFetch(1, 3.0) });
  const log = (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`SELECT scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo
            FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`)
  ).recordset[0];
  assert.ok(log, 'debe existir el row de sis_scrape_log');
  assert.equal(log.scrape_tipo, 'backfill');
  assert.equal(log.periodos_ok, 24, 'día pasado ⇒ 24 periodos ok');
  assert.equal(log.periodos_error, 0);
  assert.equal(log.ultimo_periodo, 24);
  assert.equal(log.completo, true);
});

// ---------------------------------------------------------------------------------------------
// D-060: horizonte de "hoy", periodoDesde y semántica completo=24/24. Sin estos, el P24 de cada
// día nunca se pedía (el tick de las 23h dejaba completo=1 con ultimo_periodo=23).
// ---------------------------------------------------------------------------------------------

// Envuelve un fetchFn y registra los límites pedidos, para asertar QUÉ periodos se pidieron.
function grabar(fetchFn) {
  const llamadas = [];
  const fn = async (f1, h1, f2, h2) => { llamadas.push({ f1, h1, f2, h2 }); return fetchFn(f1, h1, f2, h2); };
  fn.llamadas = llamadas;
  return fn;
}

async function setLog({ periodos_ok, periodos_error, ultimo_periodo, completo }) {
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .input('ok', sql.TinyInt, periodos_ok)
    .input('err', sql.TinyInt, periodos_error)
    .input('ult', sql.TinyInt, ultimo_periodo)
    .input('comp', sql.Bit, completo ? 1 : 0)
    .query(`
      IF EXISTS (SELECT 1 FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f)
        UPDATE bitacora.sis_scrape_log SET scrape_tipo='manual', periodos_ok=@ok, periodos_error=@err,
               ultimo_periodo=@ult, completo=@comp WHERE planta_id=@p AND fecha=@f;
      ELSE
        INSERT INTO bitacora.sis_scrape_log (planta_id, fecha, scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo)
        VALUES (@p, @f, 'manual', @ok, @err, @ult, @comp);
    `);
}

async function getLog() {
  return (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`SELECT periodos_ok, periodos_error, ultimo_periodo, completo
            FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`)).recordset[0];
}

test('7. "hoy" a las 23:30 con soloHoy ⇒ pide 1..23 (nunca el 24) y completo=false', async () => {
  // 2026-04-16 23:30 Bogotá = 2026-04-17T04:30Z → hoy === FECHA, hora=23.
  const ahora = () => new Date('2026-04-17T04:30:00Z');
  const fetchFn = grabar(mockFetch(1, 3.0));
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'horario', soloHoy: true, ahora, fetchFn });
  assert.equal(fetchFn.llamadas.length, 23, 'hoy a las 23h: periodos cerrados 1..23');
  assert.ok(!fetchFn.llamadas.some((c) => c.h1 === '23'), 'el P24 (h1=23) NO se pide en el día en curso');
  assert.equal(r.ultimo_periodo, 23);
  assert.equal(r.completo, false, 'completo NUNCA significa "hasta la hora actual"');
  const log = await getLog();
  assert.equal(log.periodos_ok, 23);
  assert.equal(log.ultimo_periodo, 23);
  assert.equal(log.completo, false);
});

test('8. periodoDesde=24 con log previo contiguo (ultimo=23) ⇒ 1 solo fetch del P24 y 24/24', async () => {
  await setLog({ periodos_ok: 23, periodos_error: 0, ultimo_periodo: 23, completo: false });
  const fetchFn = grabar(mockFetch(24, 9.0));
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'backfill', soloHoy: false, periodoDesde: 24, fetchFn });
  assert.equal(fetchFn.llamadas.length, 1, 'solo el periodo que falta');
  assert.deepEqual(fetchFn.llamadas[0], { f1: FECHA, h1: '23', f2: '2026-04-17', h2: '00' }, 'P24 cruza al día siguiente');
  assert.equal(r.desde, 24);
  assert.equal(r.creados, 1);
  assert.equal(Number((await getCelda(24)).cantidad), 9.0);
  const log = await getLog();
  assert.equal(log.periodos_ok, 24, 'acumula lo previo (23) + 1');
  assert.equal(log.periodos_error, 0);
  assert.equal(log.ultimo_periodo, 24);
  assert.equal(log.completo, true);
});

test('9. periodoDesde=24 con log previo NO contiguo (ultimo=20) ⇒ cae a 1..24 (auto-sanador)', async () => {
  await setLog({ periodos_ok: 20, periodos_error: 0, ultimo_periodo: 20, completo: false });
  const fetchFn = grabar(mockFetch(24, 4.0));
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'backfill', soloHoy: false, periodoDesde: 24, fetchFn });
  assert.equal(r.desde, 1);
  assert.equal(fetchFn.llamadas.length, 24);
  const log = await getLog();
  assert.equal(log.periodos_ok, 24);
  assert.equal(log.ultimo_periodo, 24);
  assert.equal(log.completo, true);
});

test('10. log previo con errores ⇒ periodoDesde se ignora aunque ultimo=23', async () => {
  await setLog({ periodos_ok: 23, periodos_error: 1, ultimo_periodo: 23, completo: false });
  const fetchFn = grabar(mockFetch(24, 4.0));
  const r = await scrapeDia(db, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'backfill', soloHoy: false, periodoDesde: 24, fetchFn });
  assert.equal(r.desde, 1);
  assert.equal(fetchFn.llamadas.length, 24);
});
