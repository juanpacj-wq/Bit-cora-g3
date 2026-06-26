import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { setupSessions, call, PLANTA_ID } from './helpers.js';

// D-029: rol "Coordinador de carbón y maquinaria".
// Lectura + llenado de Carbón y Caliza (CYC) y Maquinaria (MAQU), + llenado en
// Consumos de Combustible (COMB). NO cierra turno, NO es solo_lectura.
// La matriz de permisos se reconstruye idempotentemente en cada arranque (db.js,
// bloque "matriz AS"); estos tests fijan ese contrato.

const NOMBRE_CARGO = 'Coordinador de carbón y maquinaria';
const TEST_FECHA = '2026-04-16';   // fecha fija pasada, distinta de la del test de consumos

let ctx;            // setupSessions(): { sesiones, usuarios, bitByCodigo }
let sesionCoord;    // sesion_id del Coordinador
let cargoIdCoord;

async function setupCoordinador() {
  const db = await getDB();
  const passwordHash = await hashPassword('1234');
  await db.request()
    .input('nombre', sql.VarChar(200), 'Test Coordinador Carbón y Maquinaria')
    .input('username', sql.VarChar(50), 'test_coord_cym')
    .input('pwd', sql.VarChar(200), passwordHash)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET activo = 1, nombre_completo = @nombre
      WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
        VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1);
    `);
  const u = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = 'test_coord_cym'`)
  ).recordset[0];
  const c = (await db.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT cargo_id, solo_lectura, puede_cerrar_turno FROM lov_bit.cargo WHERE nombre = @n`)
  ).recordset[0];
  cargoIdCoord = c.cargo_id;

  await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
  const ins = await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('cargo_id', sql.Int, c.cargo_id)
    .input('turno', sql.TinyInt, 1)
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);
  return { sesion_id: ins.recordset[0].sesion_id, usuario_id: u.usuario_id, cargo: c };
}

async function permiso(codigoBitacora) {
  const db = await getDB();
  const r = await db.request()
    .input('cargo_id', sql.Int, cargoIdCoord)
    .input('cod', sql.VarChar(10), codigoBitacora)
    .query(`
      SELECT p.puede_ver, p.puede_crear
      FROM lov_bit.cargo_bitacora_permiso p
      JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
      WHERE p.cargo_id = @cargo_id AND b.codigo = @cod
    `);
  return r.recordset[0] || null;
}

before(async () => {
  ctx = await setupSessions();
  const coord = await setupCoordinador();
  sesionCoord = coord.sesion_id;
});

after(async () => {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), 'GEC3')
    .input('f', sql.Date, TEST_FECHA)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f`);
});

test('1. El cargo existe con flags correctos (solo_lectura=0, puede_cerrar_turno=0)', async () => {
  const db = await getDB();
  const r = await db.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT CAST(solo_lectura AS INT) AS sl, CAST(puede_cerrar_turno AS INT) AS pct FROM lov_bit.cargo WHERE nombre = @n`);
  assert.equal(r.recordset.length, 1, 'el cargo debe existir exactamente una vez');
  assert.equal(r.recordset[0].sl, 0, 'solo_lectura debe ser 0');
  assert.equal(r.recordset[0].pct, 0, 'puede_cerrar_turno debe ser 0');
});

test('2. Matriz: ve y crea en CYC (Carbón y Caliza)', async () => {
  const p = await permiso('CYC');
  assert.ok(p, 'debe existir fila de permiso para CYC');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, true);
});

test('3. Matriz: ve y crea en MAQU (Maquinaria)', async () => {
  const p = await permiso('MAQU');
  assert.ok(p, 'debe existir fila de permiso para MAQU');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, true);
});

test('4. Matriz: ve y crea en COMB (Consumos de Combustible)', async () => {
  const p = await permiso('COMB');
  assert.ok(p, 'debe existir fila de permiso para COMB');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, true);
});

test('5. Matriz: NO ve ni crea en una bitácora ajena (QUIM)', async () => {
  const p = await permiso('QUIM');
  assert.ok(p, 'debe existir fila de permiso para QUIM');
  assert.equal(p.puede_ver, false);
  assert.equal(p.puede_crear, false);
});

test('6. Matriz: MAND es visible (global) pero NO creable por este rol', async () => {
  const p = await permiso('MAND');
  assert.ok(p, 'debe existir fila de permiso para MAND');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, false);
});

test('7. Permiso runtime: el Coordinador puede llenar Consumos (POST COMB → 200)', async () => {
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionCoord })).data;
  assert.equal(cat.combustibles.length, 8, 'el catálogo GEC3 debe ser visible para el Coordinador');
  const { status } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionCoord,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 5, combustible_id: cat.combustibles[0].combustible_id, cantidad: 7.5 },
    ]},
  });
  assert.equal(status, 200);
});

test('8. Idempotencia: re-initDB() preserva los permisos del rol (matriz reconstruida)', async () => {
  const { initDB } = await import('../db.js');
  await initDB();
  for (const cod of ['CYC', 'MAQU', 'COMB']) {
    const p = await permiso(cod);
    assert.ok(p && p.puede_ver === true && p.puede_crear === true,
      `${cod} debe seguir ver+crear tras re-initDB`);
  }
});
