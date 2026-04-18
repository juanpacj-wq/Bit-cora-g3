import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSessions, cleanupTestRegistros, call, makeRegistroPayload, firstTipoEvento, PLANTA_ID } from './helpers.js';

let ctx;

before(async () => {
  ctx = await setupSessions();
});

after(async () => {
  await cleanupTestRegistros();
});

const DISP_EXTRA = { campos_extra: { evento: 'Disponible' } };

test('POST /api/registros sin header devuelve 401', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status } = await call('POST', '/api/registros', {
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EXTRA }),
  });
  assert.equal(status, 401);
  // sesiones solo se usa para que setup corra antes del assert
  assert.ok(sesiones.jdt);
});

test('POST /api/registros Ing. Agua a CAL devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.CAL);
  const { status } = await call('POST', '/api/registros', {
    sesion_id: sesiones.ingAgua,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.CAL, tipo_evento_id }),
  });
  assert.equal(status, 403);
});

test('POST /api/registros Ing. Operación a DISP devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status } = await call('POST', '/api/registros', {
    sesion_id: sesiones.ingOp,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EXTRA }),
  });
  assert.equal(status, 403);
});

test('POST /api/registros JdT a DISP devuelve 201', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EXTRA }),
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.registro?.registro_id);
});

test('POST /api/registros devuelve snapshots JSON válidos', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const tipo_evento_id = await firstTipoEvento(bitByCodigo.DISP);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: sesiones.jdt,
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EXTRA }),
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
    body: makeRegistroPayload({ bitacora_id: bitByCodigo.DISP, tipo_evento_id, extra: DISP_EXTRA }),
  });
  assert.equal(status, 403);
});

test('POST /api/cierre/bitacora Ing. Operación devuelve 403', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const { status } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: sesiones.ingOp,
    body: { bitacora_id: bitByCodigo.DISP, planta_id: PLANTA_ID },
  });
  assert.equal(status, 403);
});

test('POST /api/cierre/bitacora JdT devuelve 200', async () => {
  const { sesiones, bitByCodigo } = ctx;
  const { status } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: sesiones.jdt,
    body: { bitacora_id: bitByCodigo.DISP, planta_id: PLANTA_ID },
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
