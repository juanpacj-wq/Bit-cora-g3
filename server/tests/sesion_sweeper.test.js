import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { sweepSesionesInactivas } from '../utils/sesion-sweeper.js';

const TEST_USERNAME = 'test_sweeper';
const PLANTA_ID = 'GEC3';

let db;
let usuario_id;
let cargo_id;
const createdSesiones = [];

before(async () => {
  await initDB();
  db = await getDB();

  const pwd = await hashPassword('1234');
  await db.request()
    .input('username', sql.VarChar(50), TEST_USERNAME)
    .input('pwd',      sql.VarChar(200), pwd)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET activo = 1, nombre_completo = 'Test Sweeper'
      WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
        VALUES ('Test Sweeper', @username, NULL, @pwd, 0, 0, 1);
    `);
  const u = await db.request()
    .input('username', sql.VarChar(50), TEST_USERNAME)
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = @username`);
  usuario_id = u.recordset[0].usuario_id;

  const c = await db.request().query(
    `SELECT TOP 1 cargo_id FROM lov_bit.cargo WHERE nombre = 'Ingeniero de Operación'`
  );
  cargo_id = c.recordset[0].cargo_id;
});

after(async () => {
  if (!createdSesiones.length) return;
  const ids = createdSesiones.join(',');
  await db.request().query(`DELETE FROM bitacora.sesion_activa WHERE sesion_id IN (${ids})`);
});

async function insertSesion({ offsetMin }) {
  const ins = await db.request()
    .input('usuario_id', sql.Int, usuario_id)
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('cargo_id', sql.Int, cargo_id)
    .input('turno', sql.TinyInt, 1)
    .input('offset', sql.Int, offsetMin)
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno, ultima_actividad, activa)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno, DATEADD(MINUTE, @offset, GETDATE()), 1)
    `);
  const id = ins.recordset[0].sesion_id;
  createdSesiones.push(id);
  return id;
}

async function getActiva(sesion_id) {
  const r = await db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`SELECT activa FROM bitacora.sesion_activa WHERE sesion_id = @sesion_id`);
  return r.recordset[0].activa;
}

test('sweepSesionesInactivas apaga sesiones fuera del TTL y respeta las frescas', async () => {
  const vieja = await insertSesion({ offsetMin: -10 });
  const fresca = await insertSesion({ offsetMin: 0 });

  const antesVieja = await getActiva(vieja);
  const antesFresca = await getActiva(fresca);
  assert.equal(antesVieja, true, 'sesión vieja debe empezar activa=1');
  assert.equal(antesFresca, true, 'sesión fresca debe empezar activa=1');

  const n = await sweepSesionesInactivas(db);
  assert.ok(n >= 1, `rowsAffected debe ser ≥1 (fue ${n})`);

  assert.equal(await getActiva(vieja), false, 'sesión vieja debe quedar activa=0');
  assert.equal(await getActiva(fresca), true, 'sesión fresca no debe ser tocada');
});

test('sweepSesionesInactivas es idempotente sobre sesiones ya apagadas', async () => {
  const apagada = await insertSesion({ offsetMin: -10 });
  await db.request()
    .input('id', sql.Int, apagada)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE sesion_id = @id`);

  const n = await sweepSesionesInactivas(db);
  assert.equal(await getActiva(apagada), false);
  assert.ok(Number.isInteger(n), 'rowsAffected debe ser número entero');
});
