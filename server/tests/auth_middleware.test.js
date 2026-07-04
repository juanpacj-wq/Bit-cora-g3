import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, makeRegistroPayload, firstTipoEvento, TEST_PLANTA } from './helpers.js';
import { sweepTurnosVencidos } from '../utils/turno-sweeper.js';

let ctx;

// D-030: TODO este archivo opera sobre TEST_PLANTA (planta sintética), NUNCA sobre GEC3/GEC32
// reales. Antes usaba PLANTA_ID='GEC3': cada POST DISP cerraba el vigente REAL de GEC3 y creaba
// un sucesor tagueado que `cleanupTestRegistros` borraba, dejando GEC3 sin vigente ("Sin estado
// registrado" en el dashboard). Migrado a TEST_PLANTA como ya lo hace disponibilidad.test.js.
// F12: limpiar DISP antes para no arrastrar residuo de runs anteriores (la regla "no consecutivos
// iguales" hace que un En Servicio viejo en activo bloquee el primer test).
async function cleanDispTest() {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('bid', sql.Int, ctx.bitByCodigo.DISP)
    .query(`
      -- D-041: solo la TABLA BASE (disponibilidad_estado). El DELETE por la vista
      -- disponibilidad_dashboard (redundante) se retiró: escribir por vistas dashboard es el footgun
      -- que dejaba plantas reales sin vigente. Acotado a TEST_PLANTA (@p).
      DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE bitacora_id = @bid AND planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE bitacora_id = @bid AND planta_id = @p;
    `);
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  await cleanDispTest();
});

// D6: cada test arranca con DISP limpio para que la regla "no consecutivos iguales" (RN-11)
// no acople tests entre sí. before() global se mantiene — crea sesiones MERGE y no hace
// falta repetirlo.
beforeEach(async () => {
  if (ctx) await cleanDispTest();
});

after(async () => {
  await cleanDispTest();
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
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, planta_id: TEST_PLANTA, tipo_evento_id, extra: DISP_EN_SERVICIO }),
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
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.CALDERA, planta_id: TEST_PLANTA, tipo_evento_id }),
  });
  assert.equal(status, 403);
});

test('POST /api/registros Ing. Operación a DISP devuelve 201 (permisos iguales a JdT)', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.ingOp,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, planta_id: TEST_PLANTA, tipo_evento_id, extra: DISP_EN_SERVICIO }),
  });
  assert.equal(status, 201, JSON.stringify(data));
});

test('POST /api/registros JdT a DISP devuelve 201', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, planta_id: TEST_PLANTA, tipo_evento_id, extra: DISP_INDISPONIBLE }),
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.registro?.registro_id);
});

test('POST /api/registros devuelve snapshots JSON válidos', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, planta_id: TEST_PLANTA, tipo_evento_id, extra: DISP_RESERVA }),
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
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, planta_id: TEST_PLANTA, tipo_evento_id, extra: DISP_EN_SERVICIO }),
  });
  assert.equal(status, 403);
});

// D-042: el único cierre es el masivo por turno (POST /api/cierre/masivo). El gating por
// puede_cerrar_turno se ejercita sobre ese endpoint. El cierre emite el CIET de turno incluso
// si no hay borradores, así que no requiere sembrar registros previos.
test('POST /api/cierre/masivo Ing. Operación devuelve 200 (puede_cerrar_turno=1)', async () => {
  const { sesiones } = ctx;
  const { status } = await call('POST', '/api/cierre/masivo', {
    sesion_id: sesiones.ingOp,
    body: { planta_id: TEST_PLANTA },
  });
  assert.equal(status, 200);
});

test('POST /api/cierre/masivo Ing. Químico devuelve 403', async () => {
  const { sesiones } = ctx;
  const { status } = await call('POST', '/api/cierre/masivo', {
    sesion_id: sesiones.ingQuim,
    body: { planta_id: TEST_PLANTA },
  });
  assert.equal(status, 403);
});

test('POST /api/cierre/masivo JdT devuelve 200', async () => {
  const { sesiones } = ctx;
  const { status } = await call('POST', '/api/cierre/masivo', {
    sesion_id: sesiones.jdt,
    body: { planta_id: TEST_PLANTA },
  });
  assert.equal(status, 200);
});

test('POST /api/cierre/masivo sin header devuelve 401', async () => {
  const { status } = await call('POST', '/api/cierre/masivo', {
    body: { planta_id: TEST_PLANTA },
  });
  assert.equal(status, 401);
});

// Último test del archivo a propósito: expulsa sesiones.gerente y no debe correr antes que
// los tests que la usan (POST /api/registros Gerente devuelve 403, línea 105).
// Login Entra: /api/auth/logout (por sesion_id) fue eliminado. La sesión de app ahora se cierra
// a fin de turno vía el sweeper (activa=0 + cerrada_en), conservando la cookie Entra. Este test
// fuerza la sesión a un turno vencido y verifica que el sweeper la expulse.
test('turno-sweeper expulsa la sesión de app a fin de turno (activa=0 + cerrada_en)', async () => {
  const { sesiones } = ctx;
  const sesion_id = sesiones.gerente;
  const db = await getDB();

  // Forzamos inicio_sesion a un turno claramente vencido (2 días atrás) para que su ventana
  // ya haya terminado. Sin sesion_bitacora abierta → solo la rama de expulsión la alcanza.
  await db.request()
    .input('sid', sql.Int, sesion_id)
    .query(`
      UPDATE bitacora.sesion_activa
         SET activa = 1, cerrada_en = NULL, turno = 1,
             inicio_sesion = DATEADD(DAY, -2, SYSUTCDATETIME())
       WHERE sesion_id = @sid`);

  await sweepTurnosVencidos(db);

  const post = await db.request()
    .input('sid', sql.Int, sesion_id)
    .query('SELECT activa, cerrada_en FROM bitacora.sesion_activa WHERE sesion_id = @sid');
  assert.equal(post.recordset[0].activa, false, 'activa debe quedar en 0 tras la expulsión');
  assert.ok(post.recordset[0].cerrada_en instanceof Date, 'cerrada_en debe ser timestamp');
  const ageMs = Date.now() - post.recordset[0].cerrada_en.getTime();
  assert.ok(Math.abs(ageMs) < 60_000, `cerrada_en debe ser reciente (age=${ageMs}ms)`);
});
