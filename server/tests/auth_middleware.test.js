import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, makeRegistroPayload, firstTipoEvento, PLANTA_ID } from './helpers.js';

let ctx;

// F12: limpiar DISP antes para no arrastrar residuo de runs anteriores (la nueva regla
// "no consecutivos iguales" hace que un En Servicio viejo en activo bloquee el primer test).
async function cleanDispGec3() {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, ctx.bitByCodigo.DISP)
    .query(`
      DELETE FROM bitacora.disponibilidad_dashboard WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE bitacora_id = @bid AND planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE bitacora_id = @bid AND planta_id = @p;
    `);
}

before(async () => {
  ctx = await setupSessions();
  await cleanDispGec3();
});

// D6: cada test arranca con DISP limpio para que la regla "no consecutivos iguales" (RN-11)
// no acople tests entre sí. before() global se mantiene — crea sesiones MERGE y no hace
// falta repetirlo.
beforeEach(async () => {
  if (ctx) await cleanDispGec3();
});

after(async () => {
  await cleanDispGec3();
  await cleanupTestRegistros();
});

// F12: DISP rechaza el mismo evento consecutivo. Cada test que POSTea DISP usa un evento
// distinto al del test anterior para evitar 409 mismo_estado entre tests del mismo run.
const DISP_EN_SERVICIO = { campos_extra: { evento: 'En Servicio' } };
const DISP_INDISPONIBLE = { campos_extra: { evento: 'Indisponible' } };
const DISP_RESERVA = { campos_extra: { evento: 'En Reserva' } };

test('POST /api/registros sin header devuelve 401', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status } = await call('POST', '/api/registros', {
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EN_SERVICIO }),
  });
  assert.equal(status, 401);
  // sesiones solo se usa para que setup corra antes del assert
  assert.ok(sesiones.jdt);
});

test('POST /api/registros Ing. Químico a CALDERA devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.CALDERA);
  const { status } = await call('POST', '/api/registros', {
    sesion_id: sesiones.ingQuim,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.CALDERA, tipo_evento_id }),
  });
  assert.equal(status, 403);
});

test('POST /api/registros Ing. Operación a DISP devuelve 201 (permisos iguales a JdT)', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.ingOp,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EN_SERVICIO }),
  });
  assert.equal(status, 201, JSON.stringify(data));
});

test('POST /api/registros JdT a DISP devuelve 201', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_INDISPONIBLE }),
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.registro?.registro_id);
});

test('POST /api/registros devuelve snapshots JSON válidos', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_RESERVA }),
  });
  assert.equal(status, 201, JSON.stringify(data));
  const reg = data.registro;
  const jdts = JSON.parse(reg.jdts_snapshot);
  assert.ok(Array.isArray(jdts) && jdts.length >= 1, 'jdts_snapshot debe tener ≥1 elemento');
  assert.ok(jdts.every((u) => Number.isInteger(u.usuario_id) && typeof u.nombre_completo === 'string'));
  assert.ok(JSON.parse(reg.jefes_snapshot).length >= 1, 'jefes_snapshot debe tener ≥1 elemento');
  assert.ok(Array.isArray(JSON.parse(reg.ingenieros_snapshot)), 'ingenieros_snapshot debe ser array');
  assert.equal(typeof reg.creado_por, 'number');
});

test('POST /api/registros Gerente devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status } = await call('POST', '/api/registros', {
    sesion_id: sesiones.gerente,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EN_SERVICIO }),
  });
  assert.equal(status, 403);
});

test('POST /api/cierre/bitacora Ing. Operación devuelve 200 (puede_cerrar_turno=1)', async () => {
  const { sesiones, bitByCodigo } = ctx;
  // D6: DISP no es cerrable (F13.3 — endpoint devuelve 422). Usamos CALDERA (bitácora
  // normal) para ejercitar la rama "puede_cerrar_turno=1 ⇒ pasa el middleware y llega
  // al business logic". No requiere registros activos previos: el endpoint emite el
  // CIET de cierre incluso si el SELECT oldest viene vacío.
  const { status } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: sesiones.ingOp,
    body: { bitacora_id: bitByCodigo.CALDERA, planta_id: PLANTA_ID },
  });
  assert.equal(status, 200);
});

test('POST /api/cierre/bitacora Ing. Químico devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const { status } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: sesiones.ingQuim,
    body: { bitacora_id: bitByCodigo.DISP, planta_id: PLANTA_ID },
  });
  assert.equal(status, 403);
});

test('POST /api/cierre/bitacora JdT devuelve 200', async () => {
  const { sesiones, bitByCodigo } = ctx;
  // D6: idem comentario arriba — usamos CALDERA porque DISP devuelve 422 (no cerrable).
  const { status } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: sesiones.jdt,
    body: { bitacora_id: bitByCodigo.CALDERA, planta_id: PLANTA_ID },
  });
  assert.equal(status, 200);
});

test('POST /api/cierre/bitacora sin header devuelve 401', async () => {
  const { bitByCodigo } = ctx;
  const { status } = await call('POST', '/api/cierre/bitacora', {
    body: { bitacora_id: bitByCodigo.DISP, planta_id: PLANTA_ID },
  });
  assert.equal(status, 401);
});

// Último test del archivo a propósito: cierra sesiones.gerente y no debe correr antes que
// los tests que la usan (POST /api/registros Gerente devuelve 403, línea 105).
test('POST /api/auth/logout pobla cerrada_en además de activa=0', async () => {
  const { sesiones } = ctx;
  const sesion_id = sesiones.gerente;
  const db = await getDB();

  const pre = await db.request()
    .input('sid', sql.Int, sesion_id)
    .query('SELECT activa, cerrada_en FROM bitacora.sesion_activa WHERE sesion_id = @sid');
  assert.equal(pre.recordset[0].activa, true, 'precondicion: sesion activa');
  assert.equal(pre.recordset[0].cerrada_en, null, 'precondicion: cerrada_en NULL antes del logout');

  const { status, data } = await call('POST', '/api/auth/logout', { body: { sesion_id } });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);

  const post = await db.request()
    .input('sid', sql.Int, sesion_id)
    .query('SELECT activa, cerrada_en FROM bitacora.sesion_activa WHERE sesion_id = @sid');
  assert.equal(post.recordset[0].activa, false, 'activa debe quedar en 0');
  assert.ok(post.recordset[0].cerrada_en instanceof Date, 'cerrada_en debe ser timestamp');
  const ageMs = Date.now() - post.recordset[0].cerrada_en.getTime();
  assert.ok(ageMs >= 0 && ageMs < 60_000, `cerrada_en debe ser reciente (age=${ageMs}ms)`);
});
