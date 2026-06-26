import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { scrapeDia } from '../utils/sis/carbon-scraper.js';

// D-029 / E3: tests de la regla de ownership de carbon-scraper.scrapeDia(). BD real +
// fetchPeriod MOCKEADO por inyección de dependencia (fetchFn) → no toca el SIS ni la red.
// Cubre las 6 filas de la tabla de ownership de _CONTEXTO-BASE.md sobre GEC32 + el log.
//
// SIS-owned ⇔ creado_por=SISTEMA AND (modificado_por IS NULL OR modificado_por=SISTEMA).
// "operador gana": humano-owned ⇒ el SIS solo escribe la sombra valor_sis.

const PLANTA = 'GEC32';
const FECHA = '2026-04-16'; // fecha pasada fija, distinta de la del suite de consumos.

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

  alim1 = (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .query(`SELECT combustible_id FROM lov_bit.combustible WHERE planta_id=@p AND codigo='ALIM_1'`)
  ).recordset[0]?.combustible_id;
  assert.ok(alim1, 'combustible ALIM_1 de GEC32 debe existir (F26.B1)');
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
  const r = await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: mockFetch(1, 12.5) });
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
  const r = await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: mockFetch(2, 20.0) });
  assert.equal(r.actualizados, 1);
  const cell = await getCelda(2);
  assert.equal(Number(cell.cantidad), 20.0);
  assert.equal(Number(cell.valor_sis), 20.0);
  assert.equal(cell.creado_por, sistemaId);
});

test('3. celda humano-owned + SIS>0 ⇒ cantidad intacta, solo valor_sis actualizado', async () => {
  await insertCelda({ periodo: 3, cantidad: 99.0, creadoPor: humanoId, modificadoPor: humanoId });
  const r = await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: mockFetch(3, 7.0) });
  const cell = await getCelda(3);
  assert.equal(Number(cell.cantidad), 99.0, 'cantidad humana intacta');
  assert.equal(Number(cell.valor_sis), 7.0, 'sombra actualizada');
  assert.equal(cell.modificado_por, humanoId, 'modificado_por NO debe pasar a SISTEMA');
  assert.equal(r.actualizados, 1);
});

test('4. celda SIS-owned + SIS=0 ⇒ DELETE', async () => {
  await insertCelda({ periodo: 4, cantidad: 5.0, creadoPor: sistemaId, valorSis: 5.0 });
  const r = await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: mockFetch(4, 0) });
  assert.equal(r.eliminados, 1);
  const cell = await getCelda(4);
  assert.ok(!cell, 'la celda SIS-owned con SIS=0 debe borrarse');
});

test('5. celda humano-owned + SIS=0 ⇒ cantidad intacta, valor_sis=0', async () => {
  await insertCelda({ periodo: 5, cantidad: 50.0, creadoPor: humanoId, modificadoPor: humanoId, valorSis: 5.0 });
  await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: mockFetch(5, 0) });
  const cell = await getCelda(5);
  assert.ok(cell, 'la celda humana NO se borra');
  assert.equal(Number(cell.cantidad), 50.0, 'cantidad humana intacta');
  assert.equal(Number(cell.valor_sis), 0, 'sombra a 0');
  assert.equal(cell.modificado_por, humanoId);
});

test('6. sis_scrape_log queda con el resumen correcto', async () => {
  await scrapeDia(db, { fecha: FECHA, scrape_tipo: 'backfill', fetchFn: mockFetch(1, 3.0) });
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
