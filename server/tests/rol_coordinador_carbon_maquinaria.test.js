import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { setupSessions, call, TEST_PLANTA, deactivateSyntheticSessions } from './helpers.js';
import { getTurnoColombia } from '../utils/turno.js';

// D-029: rol "Coordinador de carbón y maquinaria".
// Lectura + llenado de Carbón y Caliza (CYC) y Maquinaria (MAQU). Ve Consumos de Combustible
// (COMB) pero ya NO lo llena: D-048 dejó la escritura de COMB solo para JdT + Ingeniero de
// Operación (el Coordinador y el Op. Carbón quedaron en solo-lectura). NO cierra turno, NO es
// solo_lectura. La matriz de permisos se reconstruye idempotentemente en cada arranque (db.js,
// bloque "matriz AS"); estos tests fijan ese contrato.
//
// D-061 (L06 · CA-25): la sesión y el POST de prueba viven en la planta-fixture 'TST', y el
// `after()` limpia ahí. El POST del test 7 espera 403, así que "nunca escribió nada en GEC3" era
// cierto por accidente: bastaba con que la matriz cambiara para que empezara a insertar en una
// planta real, y el DELETE del cleanup ya apuntaba a GEC3 sin más acotador que una fecha fija.

const NOMBRE_CARGO = 'Coordinador de carbón y maquinaria';
const TEST_FECHA = '2026-04-18';   // fecha fija pasada, propia (no la comparte con otro suite)

let _ctx;            // setupSessions(): { sesiones, usuarios, bitByCodigo }
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
  // Turno ACTUAL, nunca un 1 hardcodeado: en T2 la ventana [06:00,18:00) de una sesión turno=1 ya
  // venció y el turno-sweeper la expulsa (activa=0) a los ≤60s → 401 a mitad de corrida. Mismo
  // landmine que `consumos_combustible` y que `helpers.js` ya había resuelto para el resto.
  const ins = await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .input('planta_id', sql.VarChar(10), TEST_PLANTA)
    .input('cargo_id', sql.Int, c.cargo_id)
    .input('turno', sql.TinyInt, getTurnoColombia())
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
  _ctx = await setupSessions({ planta: TEST_PLANTA });
  const coord = await setupCoordinador();
  sesionCoord = coord.sesion_id;
});

after(async () => {
  const db = await getDB();
  // Acotado a la planta-fixture DENTRO del statement (D-055/D-061): la fecha fija no acota nada
  // desde que el backfill del SIS llena el histórico de carbón de las plantas reales.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, TEST_FECHA)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@tp AND fecha=@f`);
  // Este suite crea sesiones sintéticas (setupSessions + test_coord_cym). Desactivarlas SIEMPRE
  // aquí para no dejarlas en el panel CONECTADOS de prod (D-030). Cubre las TEST_USERS + test_coord_cym.
  await deactivateSyntheticSessions();
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

test('4. Matriz: ve pero NO crea en COMB (solo-lectura, D-048)', async () => {
  const p = await permiso('COMB');
  assert.ok(p, 'debe existir fila de permiso para COMB');
  assert.equal(p.puede_ver, true);
  assert.equal(p.puede_crear, false, 'D-048: el Coordinador ya no escribe COMB (solo JdT + IngOp)');
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

test('7. Permiso runtime D-048: el Coordinador VE pero NO llena Consumos (GET 200, POST COMB → 403)', async () => {
  const cat = (await call('GET', `/api/combustibles/catalogo?planta_id=${TEST_PLANTA}`, { sesion_id: sesionCoord })).data;
  assert.equal(cat.combustibles.length, 10, 'el catálogo de la fixture debe seguir visible para el Coordinador');
  // El id sale por CÓDIGO: los combustibles de la fixture no comparten `combustible_id` con GEC3.
  const alim1 = cat.combustibles.find((c) => c.codigo === 'ALIM_1').combustible_id;
  const { status } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionCoord,
    body: { planta_id: TEST_PLANTA, fecha: TEST_FECHA, celdas: [
      { periodo: 5, combustible_id: alim1, cantidad: 7.5 },
    ]},
  });
  assert.equal(status, 403, 'D-048: el Coordinador ya no escribe COMB');
});

test('8. Idempotencia: re-initDB() preserva los permisos del rol (matriz reconstruida)', async () => {
  const { initDB } = await import('../db.js');
  await initDB();
  // CYC y MAQU: ve + crea. COMB: solo ve (D-048 → puede_crear=false), estable tras re-initDB.
  for (const cod of ['CYC', 'MAQU']) {
    const p = await permiso(cod);
    assert.ok(p && p.puede_ver === true && p.puede_crear === true,
      `${cod} debe seguir ver+crear tras re-initDB`);
  }
  const comb = await permiso('COMB');
  assert.ok(comb && comb.puede_ver === true && comb.puede_crear === false,
    'COMB debe quedar ver=true, crear=false tras re-initDB (D-048)');
});
