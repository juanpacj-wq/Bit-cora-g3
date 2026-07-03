import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB } from '../db.js';

// D-039: rol ADMIN "Administrador y Debugging" (App Role ADMINISTRADOR_DEBUGGING).
// Acceso TOTAL modelado por la matriz data-driven (no por bypass): puede_ver=1 y puede_crear=1 en
// TODAS las bitácoras activas, + puede_cerrar_turno=1 y solo_lectura=0. La matriz se reconstruye
// idempotentemente en cada arranque (db.js, bloque "matriz AS" + override DISP F12.A6); estos
// tests fijan ese contrato y blindan la regresión del override DISP.

const NOMBRE_CARGO = 'Administrador y Debugging';

let cargoIdAdmin;

before(async () => {
  await initDB();
  const db = await getDB();
  const c = (await db.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @n`)
  ).recordset[0];
  assert.ok(c, 'el cargo admin debe existir tras initDB');
  cargoIdAdmin = c.cargo_id;
});

async function permiso(codigoBitacora) {
  const db = await getDB();
  const r = await db.request()
    .input('cargo_id', sql.Int, cargoIdAdmin)
    .input('cod', sql.VarChar(10), codigoBitacora)
    .query(`
      SELECT p.puede_ver, p.puede_crear
      FROM lov_bit.cargo_bitacora_permiso p
      JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
      WHERE p.cargo_id = @cargo_id AND b.codigo = @cod
    `);
  return r.recordset[0] || null;
}

test('1. El cargo existe con flags de acceso total (solo_lectura=0, puede_cerrar_turno=1)', async () => {
  const db = await getDB();
  const r = await db.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT CAST(solo_lectura AS INT) AS sl, CAST(puede_cerrar_turno AS INT) AS pct
            FROM lov_bit.cargo WHERE nombre = @n`);
  assert.equal(r.recordset.length, 1, 'el cargo debe existir exactamente una vez');
  assert.equal(r.recordset[0].sl, 0, 'solo_lectura debe ser 0');
  assert.equal(r.recordset[0].pct, 1, 'puede_cerrar_turno debe ser 1');
});

test('2. Matriz: ve Y crea en TODAS las bitácoras activas (ninguna en 0)', async () => {
  const db = await getDB();
  // Cada bitácora activa debe tener fila de permiso con puede_ver=1 AND puede_crear=1.
  const r = await db.request()
    .input('cargo_id', sql.Int, cargoIdAdmin)
    .query(`
      SELECT b.codigo,
             ISNULL(p.puede_ver, 0)   AS puede_ver,
             ISNULL(p.puede_crear, 0) AS puede_crear
      FROM lov_bit.bitacora b
      LEFT JOIN lov_bit.cargo_bitacora_permiso p
        ON p.bitacora_id = b.bitacora_id AND p.cargo_id = @cargo_id
      WHERE b.activa = 1
    `);
  assert.ok(r.recordset.length > 0, 'debe haber bitácoras activas');
  for (const row of r.recordset) {
    assert.equal(row.puede_ver, true,   `${row.codigo}: puede_ver debe ser 1`);
    assert.equal(row.puede_crear, true, `${row.codigo}: puede_crear debe ser 1`);
  }
});

test('3. Regresión override DISP (F12.A6): admin crea en DISP', async () => {
  // El bloque F12.A6 recomputa puede_crear de TODA fila DISP; el admin debe estar incluido.
  const p = await permiso('DISP');
  assert.ok(p, 'debe existir fila de permiso para DISP');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, true, 'el override DISP debe conceder puede_crear al admin');
});

test('4. Bitácoras normalmente restringidas también son creables por admin (MAND, CIET, QUIM)', async () => {
  for (const cod of ['MAND', 'CIET', 'QUIM', 'COMB']) {
    const p = await permiso(cod);
    assert.ok(p, `debe existir fila de permiso para ${cod}`);
    assert.equal(p.puede_ver, true,   `${cod}: puede_ver`);
    assert.equal(p.puede_crear, true, `${cod}: puede_crear`);
  }
});

test('5. Idempotencia: re-initDB() preserva el acceso total (matriz + override reconstruidos)', async () => {
  await initDB();
  const db = await getDB();
  const r = await db.request()
    .input('cargo_id', sql.Int, cargoIdAdmin)
    .query(`
      SELECT COUNT(*) AS activas,
             SUM(CASE WHEN ISNULL(p.puede_ver,0)=1 AND ISNULL(p.puede_crear,0)=1 THEN 1 ELSE 0 END) AS con_full
      FROM lov_bit.bitacora b
      LEFT JOIN lov_bit.cargo_bitacora_permiso p
        ON p.bitacora_id = b.bitacora_id AND p.cargo_id = @cargo_id
      WHERE b.activa = 1
    `);
  const { activas, con_full } = r.recordset[0];
  assert.equal(con_full, activas, 'tras re-initDB, admin debe ver+crear en todas las bitácoras activas');
});
