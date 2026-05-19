import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, PLANTA_ID, TEST_TAG } from './helpers.js';

let ctx;
let DISP_BITACORA_ID;

const HOUR = 3600 * 1000;
const NOW = Date.now();
// Usamos fechas estrictamente pasadas (la rama DISP rechaza fecha_inicio_estado > now).
const T0 = new Date(NOW - 60 * HOUR);
const T1 = new Date(NOW - 48 * HOUR);
const T2 = new Date(NOW - 24 * HOUR);
const T3 = new Date(NOW - 12 * HOUR);
const FUTURE = new Date(NOW + HOUR);

async function cleanDisp() {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`
      DELETE FROM bitacora.disponibilidad_dashboard WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE bitacora_id = @bid AND planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE bitacora_id = @bid AND planta_id = @p;
    `);
}

async function postDisp({ sesion_id, evento, fechaInicio, detalle = `${TEST_TAG} disp`, planta_id = PLANTA_ID }) {
  return call('POST', '/api/registros', {
    sesion_id,
    body: {
      bitacora_id: DISP_BITACORA_ID,
      planta_id,
      fecha_evento: fechaInicio.toISOString(),
      campos_extra: { evento, fecha_inicio_estado: fechaInicio.toISOString() },
      detalle,
    },
  });
}

before(async () => {
  ctx = await setupSessions();
  DISP_BITACORA_ID = ctx.bitByCodigo.DISP;
  assert.ok(DISP_BITACORA_ID, 'DISP bitacora_id debe existir');
  await cleanDisp();
});

after(async () => {
  await cleanDisp();
  await cleanupTestRegistros();
});

test('1. POST primer registro En Servicio crea activo + dashboard', async () => {
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: T0,
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.registro?.registro_id);
  assert.equal(data.vigente_anterior_movido_id, null);

  const db = await getDB();
  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT evento, codigo FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset.length, 1);
  assert.equal(dash.recordset[0].evento, 'En Servicio');
  assert.equal(dash.recordset[0].codigo, 1);

  const activos = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id=@p AND bitacora_id=@bid AND fecha_fin_estado IS NULL`);
  assert.equal(activos.recordset[0].n, 1);
});

test('2. POST estado distinto cierra el anterior y mueve a histórico', async () => {
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Indisponible', fechaInicio: T1,
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.vigente_anterior_movido_id);

  const db = await getDB();
  const hist = await db.request()
    .input('rid', sql.Int, data.vigente_anterior_movido_id)
    .query(`SELECT registro_id, fecha_fin_estado FROM bitacora.registro_historico WHERE registro_id=@rid`);
  assert.equal(hist.recordset.length, 1);
  assert.ok(hist.recordset[0].fecha_fin_estado);
  // fecha_fin_estado del anterior == fecha_inicio del nuevo
  assert.equal(new Date(hist.recordset[0].fecha_fin_estado).getTime(), T1.getTime());

  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT evento FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset[0].evento, 'Indisponible');
});

test('3. POST mismo estado consecutivo → 409 mismo_estado', async () => {
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Indisponible', fechaInicio: T2,
  });
  assert.equal(status, 409);
  assert.equal(data.error, 'mismo_estado');
  assert.ok(data.vigente);
  assert.equal(data.vigente.evento, 'Indisponible');
});

test('4. POST con fecha futura → 422', async () => {
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: FUTURE,
  });
  assert.equal(status, 422, JSON.stringify(data));
});

test('5. POST con fecha anterior al vigente → 409 fecha_anterior_a_vigente', async () => {
  // T0 es anterior al vigente actual (T1=Indisponible).
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: T0,
  });
  assert.equal(status, 409);
  assert.equal(data.error, 'fecha_anterior_a_vigente');
});

test('6. PUT vigente cambia fecha → side-effect en N-1.fecha_fin_estado', async () => {
  const db = await getDB();
  const vigQ = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT TOP 1 registro_id FROM bitacora.registro_activo WHERE bitacora_id=@bid AND planta_id=@p AND fecha_fin_estado IS NULL`);
  const vigenteId = vigQ.recordset[0].registro_id;

  const histPrev = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT TOP 1 registro_id FROM bitacora.registro_historico WHERE bitacora_id=@bid AND planta_id=@p ORDER BY fecha_evento DESC, registro_id DESC`);
  const nMinus1Id = histPrev.recordset[0].registro_id;

  // Mover el inicio del vigente más adelante (debe seguir > T0 que es el inicio del N-1).
  const NUEVO_INICIO = new Date(T1.getTime() + 2 * HOUR);
  const { status, data } = await call('PUT', `/api/registros/${vigenteId}`, {
    sesion_id: ctx.sesiones.jdt,
    body: {
      campos_extra: { fecha_inicio_estado: NUEVO_INICIO.toISOString() },
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const after = await db.request()
    .input('rid', sql.Int, nMinus1Id)
    .query(`SELECT fecha_fin_estado FROM bitacora.registro_historico WHERE registro_id=@rid`);
  assert.equal(new Date(after.recordset[0].fecha_fin_estado).getTime(), NUEVO_INICIO.getTime());
});

test('7. POST /api/disponibilidad/deshacer con histórico restaura', async () => {
  const db = await getDB();
  // Estado actual: vigente=Indisponible, histórico tiene 'En Servicio'.
  const histPrev = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE bitacora_id=@bid AND planta_id=@p`);
  const histCountAntes = histPrev.recordset[0].n;

  const { status, data } = await call('POST', '/api/disponibilidad/deshacer', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: PLANTA_ID },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.restaurado, 'restaurado debe estar presente');
  assert.equal(data.restaurado.fecha_fin_estado, null, 'fecha_fin_estado del restaurado debe ser NULL');
  assert.ok(data.ciet_registro_id);

  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT evento FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset[0].evento, 'En Servicio');

  // El histórico tiene 1 fila menos.
  const histPost = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE bitacora_id=@bid AND planta_id=@p`);
  assert.equal(histPost.recordset[0].n, histCountAntes - 1);

  // Existe exactamente 1 vigente En Servicio en activo.
  const activos = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE bitacora_id=@bid AND planta_id=@p AND fecha_fin_estado IS NULL`);
  assert.equal(activos.recordset[0].n, 1);
});

test('8. POST /api/disponibilidad/deshacer sin histórico → empty state', async () => {
  await cleanDisp();
  // Solo 1 registro: el inicial En Servicio.
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: T0 });

  const { status, data } = await call('POST', '/api/disponibilidad/deshacer', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: PLANTA_ID },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.restaurado, null);

  const db = await getDB();
  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT planta_id FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset.length, 0);

  const activos = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_BITACORA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE bitacora_id=@bid AND planta_id=@p`);
  assert.equal(activos.recordset[0].n, 0);
});

test('9. PUT con planta_id distinto al actual → 422', async () => {
  await cleanDisp();
  const post = await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: T0 });
  assert.equal(post.status, 201);
  const vigenteId = post.data.registro.registro_id;

  const { status, data } = await call('PUT', `/api/registros/${vigenteId}`, {
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: 'GEC32',
      campos_extra: { evento: 'Indisponible', fecha_inicio_estado: T1.toISOString() },
    },
  });
  assert.equal(status, 422, JSON.stringify(data));
  assert.match(String(data.error || ''), /planta/i);
});

test('10. GET /api/disponibilidad devuelve vigente + historial', async () => {
  await cleanDisp();
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: T0 });
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'Indisponible', fechaInicio: T1 });

  const { status, data } = await call('GET', `/api/disponibilidad?planta_id=${PLANTA_ID}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.vigente?.evento, 'Indisponible');
  assert.ok(Array.isArray(data.historial));
  assert.ok(data.historial.length >= 1);
  assert.equal(data.historial[0].evento, 'En Servicio');
  assert.ok(data.historial[0].fecha_fin_estado);
});

test('11. Permisos: Ingeniero Químico no puede crear DISP (403)', async () => {
  const { status } = await postDisp({
    sesion_id: ctx.sesiones.ingQuim, evento: 'En Reserva', fechaInicio: T2,
  });
  assert.equal(status, 403);
});

// D-024: nuevo estado Mantenimiento. Indisponible y Mantenimiento comparten codigo=-1 pero
// el discriminador es el string `evento`. La transición Indisponible→Mantenimiento (o
// viceversa) NO es duplicado consecutivo y debe aceptarse.
test('12. POST Mantenimiento como primer registro persiste codigo=-1', async () => {
  await cleanDisp();
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Mantenimiento', fechaInicio: T0,
  });
  assert.equal(status, 201, JSON.stringify(data));

  const db = await getDB();
  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT evento, codigo FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset[0].evento, 'Mantenimiento');
  assert.equal(dash.recordset[0].codigo, -1);
});

test('13. POST Indisponible → Mantenimiento NO es mismo_estado (cambio válido)', async () => {
  await cleanDisp();
  const post1 = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Indisponible', fechaInicio: T0,
  });
  assert.equal(post1.status, 201);

  const post2 = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Mantenimiento', fechaInicio: T1,
  });
  assert.equal(post2.status, 201, JSON.stringify(post2.data));
  assert.ok(post2.data.vigente_anterior_movido_id, 'el Indisponible debe haber pasado a histórico');

  const db = await getDB();
  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT evento, codigo FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`);
  assert.equal(dash.recordset[0].evento, 'Mantenimiento');
  assert.equal(dash.recordset[0].codigo, -1);
});

test('14. POST con evento fuera del whitelist → 400', async () => {
  await cleanDisp();
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Foo', fechaInicio: T0,
  });
  assert.equal(status, 400);
  assert.match(String(data.error || ''), /evento debe ser uno de/);
});

test('15. POST con evento legacy "Disponible" (post-rebrand) → 400', async () => {
  await cleanDisp();
  const { status } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Disponible', fechaInicio: T0,
  });
  assert.equal(status, 400, 'el estado legacy "Disponible" ya no debe aceptarse');
});

// D-024: endpoint de métricas DISP (cimiento del futuro dashboard).
// Cubre tres escenarios: serie completa históricos + vigente abierto, ventana acotada
// que recorta intervalos, y planta sin registros (todo 0).
// Anclas de tiempo (header del archivo): T0=NOW-60h, T1=NOW-48h, T2=NOW-24h, T3=NOW-12h.
// Duraciones: T0→T1 = 12h (En Servicio), T1→T2 = 24h (Indisponible),
//             T2→T3 = 12h (Mantenimiento), T3→NOW = 12h (En Reserva, vigente).
test('16. GET /api/disponibilidad/metricas suma tiempo por evento entre históricos + vigente', async () => {
  await cleanDisp();
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Servicio',   fechaInicio: T0 });
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'Indisponible',  fechaInicio: T1 });
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'Mantenimiento', fechaInicio: T2 });
  await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Reserva',    fechaInicio: T3 });

  const { status, data } = await call(
    'GET',
    `/api/disponibilidad/metricas?planta_id=${PLANTA_ID}`,
    { sesion_id: ctx.sesiones.jdt }
  );
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.planta_id, PLANTA_ID);
  assert.ok(data.tiempo_ms);
  assert.ok(data.acumulados_ms);

  const H12 = 12 * HOUR;
  const H24 = 24 * HOUR;
  // Tolerancia generosa (segundos) para reloj del server vs. Date.now() del cliente.
  const TOL = 5 * 60 * 1000;

  assert.ok(Math.abs(data.tiempo_ms['En Servicio']  - H12) < TOL, `En Servicio ≈ 12h, got ${data.tiempo_ms['En Servicio']}`);
  assert.ok(Math.abs(data.tiempo_ms['Indisponible'] - H24) < TOL, `Indisponible ≈ 24h, got ${data.tiempo_ms['Indisponible']}`);
  assert.ok(Math.abs(data.tiempo_ms['Mantenimiento']- H12) < TOL, `Mantenimiento ≈ 12h, got ${data.tiempo_ms['Mantenimiento']}`);
  assert.ok(data.tiempo_ms['En Reserva'] >= H12 - TOL, `En Reserva ≥ 12h (vigente), got ${data.tiempo_ms['En Reserva']}`);

  // Acumulados: disponible = En Servicio + En Reserva; no_disponible = Indisponible + Mantenimiento.
  assert.equal(
    data.acumulados_ms.disponible,
    data.tiempo_ms['En Servicio'] + data.tiempo_ms['En Reserva'],
  );
  assert.equal(
    data.acumulados_ms.no_disponible,
    data.tiempo_ms['Indisponible'] + data.tiempo_ms['Mantenimiento'],
  );
  assert.equal(data.total_ms, data.acumulados_ms.disponible + data.acumulados_ms.no_disponible);
});

test('17. GET /api/disponibilidad/metricas con ventana [desde, hasta] recorta intervalos', async () => {
  // Mismo dataset que test 16. Pido solo [T1, T2] — eso encierra exactamente al Indisponible (24h).
  const { status, data } = await call(
    'GET',
    `/api/disponibilidad/metricas?planta_id=${PLANTA_ID}&desde=${T1.toISOString()}&hasta=${T2.toISOString()}`,
    { sesion_id: ctx.sesiones.jdt }
  );
  assert.equal(status, 200, JSON.stringify(data));
  const H24 = 24 * HOUR;
  const TOL = 1000;
  assert.ok(Math.abs(data.tiempo_ms['Indisponible'] - H24) < TOL, `solo Indisponible en ventana, got ${data.tiempo_ms['Indisponible']}`);
  assert.equal(data.tiempo_ms['En Servicio'], 0);
  assert.equal(data.tiempo_ms['Mantenimiento'], 0);
  assert.equal(data.tiempo_ms['En Reserva'], 0);
  assert.equal(data.acumulados_ms.disponible, 0);
  assert.ok(Math.abs(data.acumulados_ms.no_disponible - H24) < TOL);
});

test('18. GET /api/disponibilidad/metricas planta sin registros → todo 0', async () => {
  await cleanDisp();
  const { status, data } = await call(
    'GET',
    `/api/disponibilidad/metricas?planta_id=${PLANTA_ID}`,
    { sesion_id: ctx.sesiones.jdt }
  );
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.tiempo_ms['En Servicio'], 0);
  assert.equal(data.tiempo_ms['En Reserva'], 0);
  assert.equal(data.tiempo_ms['Indisponible'], 0);
  assert.equal(data.tiempo_ms['Mantenimiento'], 0);
  assert.equal(data.total_ms, 0);
  assert.equal(data.desde, null);
});
