import sql from 'mssql';
import { initDB, getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';
export const PLANTA_ID = 'GEC3';

export const TEST_TAG = `[TEST-RUN-${Date.now()}]`;

export async function call(method, path, { body, sesion_id } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sesion_id != null) headers['X-Sesion-Id'] = String(sesion_id);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const TEST_USERS = [
  { key: 'jdt',     nombre: 'Test JdT',      username: 'test_jdt',     jefe: 0, jdtd: 1 },
  { key: 'ingOp',   nombre: 'Test Ing Op',   username: 'test_ingop',   jefe: 0, jdtd: 0 },
  { key: 'gerente', nombre: 'Test Gerente',  username: 'test_gerente', jefe: 1, jdtd: 0 },
  { key: 'ingQuim', nombre: 'Test Ing Quim', username: 'test_ingquim', jefe: 0, jdtd: 0 },
];

const USER_CARGO = {
  jdt:     'Ingeniero Jefe de Turno',
  ingOp:   'Ingeniero de Operación',
  gerente: 'Gerente de Producción',
  ingQuim: 'Ingeniero Químico',
};

export async function setupSessions() {
  await initDB();
  const db = await getDB();
  const password_hash = await hashPassword('1234');

  for (const u of TEST_USERS) {
    await db.request()
      .input('nombre',   sql.VarChar(200), u.nombre)
      .input('username', sql.VarChar(50),  u.username)
      .input('pwd',      sql.VarChar(200), password_hash)
      .input('jefe',     sql.Bit, u.jefe)
      .input('jdtd',     sql.Bit, u.jdtd)
      .query(`
        MERGE lov_bit.usuario AS t
        USING (SELECT @username AS username) AS s ON t.username = s.username
        WHEN MATCHED THEN UPDATE SET
          activo = 1, nombre_completo = @nombre,
          es_jefe_planta = @jefe, es_jdt_default = @jdtd
        WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
          VALUES (@nombre, @username, NULL, @pwd, @jefe, @jdtd, 1);
      `);
  }

  const usernames = TEST_USERS.map(u => `'${u.username}'`).join(',');
  const { recordset: usuarios } = await db.request().query(`
    SELECT usuario_id, username FROM lov_bit.usuario WHERE username IN (${usernames})
  `);
  const userByUsername = Object.fromEntries(usuarios.map(u => [u.username, u.usuario_id]));

  const { recordset: cargos } = await db.request().query(`
    SELECT cargo_id, nombre FROM lov_bit.cargo
  `);
  const cargoByName = Object.fromEntries(cargos.map(c => [c.nombre, c.cargo_id]));

  async function ensureSesion(usuario_id, cargo_id) {
    await db.request()
      .input('usuario_id', sql.Int, usuario_id)
      .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
    const ins = await db.request()
      .input('usuario_id', sql.Int, usuario_id)
      .input('planta_id', sql.VarChar(10), PLANTA_ID)
      .input('cargo_id', sql.Int, cargo_id)
      .input('turno', sql.TinyInt, 1)
      .query(`
        INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
        OUTPUT INSERTED.sesion_id
        VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
      `);
    return ins.recordset[0].sesion_id;
  }

  const sesiones = {};
  const usuariosOut = {};
  for (const u of TEST_USERS) {
    const usuario_id = userByUsername[u.username];
    const cargo_id = cargoByName[USER_CARGO[u.key]];
    sesiones[u.key] = await ensureSesion(usuario_id, cargo_id);
    usuariosOut[u.key] = { usuario_id, username: u.username, nombre_completo: u.nombre };
  }

  const { recordset: bitacoras } = await db.request().query(`
    SELECT bitacora_id, codigo FROM lov_bit.bitacora
  `);
  const bitByCodigo = Object.fromEntries(bitacoras.map(b => [b.codigo, b.bitacora_id]));

  return { sesiones, usuarios: usuariosOut, bitByCodigo };
}

export async function cleanupTestRegistros() {
  const db = await getDB();
  await db.request()
    .input('tag', sql.NVarChar(200), `%${TEST_TAG}%`)
    .query(`
      UPDATE bitacora.autorizacion_dashboard SET activa = 0
      WHERE registro_origen_id IN (
        SELECT registro_id FROM bitacora.registro_activo WHERE detalle LIKE @tag
      );
      DELETE FROM bitacora.registro_activo WHERE detalle LIKE @tag;
    `);
  const usernames = TEST_USERS.map((u) => `'${u.username}'`).join(',');
  await db.request().query(`
    UPDATE bitacora.sesion_activa SET activa = 0
    WHERE usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE username IN (${usernames}))
  `);
}

export function makeRegistroPayload({ bitacora_id, planta_id = PLANTA_ID, tipo_evento_id, extra = {} }) {
  return {
    bitacora_id,
    planta_id,
    fecha_evento: new Date().toISOString(),
    turno: 1,
    detalle: `${TEST_TAG} detalle prueba`,
    tipo_evento_id,
    ...extra,
  };
}

export async function firstTipoEvento(bitacora_id) {
  const db = await getDB();
  const r = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`SELECT TOP 1 tipo_evento_id FROM lov_bit.tipo_evento WHERE bitacora_id = @bitacora_id ORDER BY orden`);
  return r.recordset[0]?.tipo_evento_id;
}
