import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDB } from '../db.js';

// D-029 (F27.A1): tests del schema de soporte para el valor SIS sombra (consumo de carbón
// GEC32 scrapeado del SIS) + observabilidad del scraper. Solo verifica que la migración
// idempotente del initDB() dejó las columnas/tabla/constraints esperadas. No toca scraper.

let db;

before(async () => {
  db = await getDB();
});

test('F27.A1 — consumo_combustible tiene columnas valor_sis y sis_actualizado_en', async () => {
  const r = await db.request().query(`
    SELECT name FROM sys.columns
    WHERE object_id = OBJECT_ID('bitacora.consumo_combustible')
      AND name IN ('valor_sis', 'sis_actualizado_en')
  `);
  const cols = r.recordset.map((x) => x.name).sort();
  assert.deepEqual(cols, ['sis_actualizado_en', 'valor_sis'],
    'faltan columnas valor_sis / sis_actualizado_en en bitacora.consumo_combustible');
});

test('F27.A1 — existe la tabla bitacora.sis_scrape_log', async () => {
  const r = await db.request().query(`
    SELECT 1 AS x FROM sys.tables
    WHERE name = 'sis_scrape_log' AND schema_id = SCHEMA_ID('bitacora')
  `);
  assert.ok(r.recordset[0], 'no existe la tabla bitacora.sis_scrape_log');
});

test('F27.A1 — sis_scrape_log tiene UNIQUE (planta_id, fecha)', async () => {
  // Verifica que el constraint UNIQUE existe y cubre exactamente (planta_id, fecha).
  const r = await db.request().query(`
    SELECT c.name AS col
    FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID('bitacora.sis_scrape_log')
      AND i.name = 'UQ_sis_scrape_planta_fecha'
      AND i.is_unique = 1
    ORDER BY ic.key_ordinal
  `);
  const cols = r.recordset.map((x) => x.col);
  assert.deepEqual(cols, ['planta_id', 'fecha'],
    'UQ_sis_scrape_planta_fecha no cubre (planta_id, fecha)');
});

test('F27.A1 — sis_scrape_log tiene CHECK de scrape_tipo (horario/backfill/manual)', async () => {
  const r = await db.request().query(`
    SELECT 1 AS x FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('bitacora.sis_scrape_log')
      AND name = 'CK_sis_scrape_tipo'
  `);
  assert.ok(r.recordset[0], 'no existe el CHECK CK_sis_scrape_tipo');
});

test('F27.A1 — la migración quedó registrada en migracion_aplicada', async () => {
  const r = await db.request().query(
    `SELECT 1 AS x FROM bitacora.migracion_aplicada WHERE codigo = 'F27.A1'`
  );
  assert.ok(r.recordset[0], 'flag F27.A1 no registrado en migracion_aplicada');
});
