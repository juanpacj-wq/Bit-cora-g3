import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID } from '../db.js';
import { hashPassword } from '../utils/password.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';
export const PLANTA_ID = 'GEC3';

// D-030: planta sintética reservada para tests (definida en db.js, excluida de las vistas DISP).
// Los tests que tocan disponibilidad operan sobre esta planta — nunca sobre GEC3/GEC32 reales.
export const TEST_PLANTA = TEST_PLANTA_ID;

// D5: sin corchetes [...]. SQL Server interpreta [ y ] como wildcards de conjunto en LIKE,
// con corchetes el patrón '%[TEST-RUN-N]%' NO matchea el literal '[TEST-RUN-N]' — el
// cleanup quedaba inerte y los asserts con LIKE TEST_TAG fallaban silenciosamente.
export const TEST_TAG = `TEST-RUN-${Date.now()}`;

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

export async function setupSessions({ planta = PLANTA_ID } = {}) {
  await initDB();
  const db = await getDB();
  const password_hash = await hashPassword('1234');

  // D-030: si las sesiones van a una planta distinta de las productivas (típicamente TEST_PLANTA),
  // sembrarla idempotentemente. Necesaria por la FK de sesion_activa/disponibilidad_estado y por la
  // validación `planta_id=@p AND activa=1` del POST DISP y /metricas (activa=1 obligatorio).
  if (planta !== PLANTA_ID) {
    await db.request()
      .input('planta', sql.VarChar(10), planta)
      .query(`
        MERGE lov_bit.planta AS t
        USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
        WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
      `);
  }

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
      .input('planta_id', sql.VarChar(10), planta)
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
      -- D-026: DISP storage migró a bitacora.disponibilidad_estado. Borramos por TEST_TAG
      -- en detalle para no acumular leftover entre runs (la vieja disponibilidad_dashboard
      -- ahora es una VIEW derivada — no se escribe directamente).
      DELETE FROM bitacora.disponibilidad_estado WHERE detalle LIKE @tag;
      DELETE FROM bitacora.registro_activo WHERE detalle LIKE @tag;
      DELETE FROM bitacora.registro_historico WHERE detalle LIKE @tag;
    `);
  // F16 + D5: limpia mand_cierre_log para la planta de test. El log no tiene un campo "tag";
  // borrar por (planta_id, fecha_cerrada >= 2026-05-01) cubre fechas determinísticas usadas
  // en cierre_y_fechas.test.js (D5) y cualquier futuro día Bogotá donde el sweeper haya
  // disparado durante el run. El rango guarda contra borrar mand_cierre_log histórico previo
  // a este branch (no debería existir en GEC3, pero queda como safety net).
  await db.request()
    .input('planta', sql.VarChar(10), PLANTA_ID)
    .query(`
      DELETE FROM bitacora.mand_cierre_log
      WHERE planta_id = @planta AND fecha_cerrada >= '2026-05-01';
    `);
  // F16: limpia evento_dashboard MAND remanente (los soft-deleted ya quedan así, pero por
  // si algun test deja filas activas tras un fallo).
  await db.request()
    .input('planta', sql.VarChar(10), PLANTA_ID)
    .query(`
      DELETE FROM bitacora.evento_dashboard
      WHERE planta_id = @planta
        AND registro_origen_id NOT IN (SELECT registro_id FROM bitacora.registro_activo)
        AND registro_origen_id NOT IN (SELECT registro_id FROM bitacora.registro_historico);
    `);
  const usernames = TEST_USERS.map((u) => `'${u.username}'`).join(',');
  await db.request().query(`
    UPDATE bitacora.sesion_activa SET activa = 0
    WHERE usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE username IN (${usernames}))
  `);
  // conformacion-turno-2026-05: snapshots seedeados por los tests E2E/builder. Limpiar por
  // usuario_id porque la PK incluye fecha/planta/turno y los tests usan fechas históricas.
  await db.request().query(`
    DELETE FROM bitacora.conformacion_turno
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
