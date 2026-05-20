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
  // D-026: DISP storage migró a bitacora.disponibilidad_estado. Las tablas viejas
  // (registro_activo/registro_historico) ya no contienen filas DISP — el bloque F26.A1
  // de db.js las migró + DELETE en origen.
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @p;`);
}

// D-026: helper para tests 20-21-23 que necesitan controlar tiempos y estados exactos
// sin pasar por la API (la API valida que fecha_inicio_estado <= NOW, lo que impide
// armar series temporales determinísticas para vistas de acumulados). El usuario_id se
// toma del ctx (test_jdt sembrado por setupSessions).
async function insertDispDirecto({ planta_id, estado, codigo, fecha_inicio, fecha_fin }) {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('e', sql.VarChar(20), estado)
    .input('c', sql.SmallInt, codigo)
    .input('i', sql.DateTime2, fecha_inicio)
    .input('f', sql.DateTime2, fecha_fin)
    .input('u', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, fecha_fin_estado, creado_por)
      VALUES (@p, @e, @c, @i, @f, @u)
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

  // D-026 (Q11): post-migración DISP vive en `disponibilidad_estado`; el "vigente" es
  // la fila con fecha_fin_estado IS NULL. Antes esto se consultaba en registro_activo.
  const activos = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NULL`);
  assert.equal(activos.recordset[0].n, 1);
});

test('2. POST estado distinto cierra el anterior y mueve a histórico', async () => {
  const { status, data } = await postDisp({
    sesion_id: ctx.sesiones.jdt, evento: 'Indisponible', fechaInicio: T1,
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.vigente_anterior_movido_id);

  const db = await getDB();
  // D-026 (Q11): el "cierre del anterior" ahora es UPDATE fecha_fin_estado sobre la misma
  // fila en `disponibilidad_estado`. `vigente_anterior_movido_id` mapea a `disponibilidad_id`.
  const hist = await db.request()
    .input('rid', sql.Int, data.vigente_anterior_movido_id)
    .query(`SELECT disponibilidad_id, fecha_fin_estado FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@rid`);
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
  // D-026 (Q11): vigente y N-1 son ahora filas de `disponibilidad_estado` distinguidas
  // por fecha_fin_estado (NULL → vigente, NOT NULL → histórico). El handler PUT mapea
  // disponibilidad_id al param :id del route.
  const vigQ = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT TOP 1 disponibilidad_id FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NULL`);
  const vigenteId = vigQ.recordset[0].disponibilidad_id;

  const histPrev = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT TOP 1 disponibilidad_id FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NOT NULL ORDER BY fecha_inicio_estado DESC, disponibilidad_id DESC`);
  const nMinus1Id = histPrev.recordset[0].disponibilidad_id;

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
    .query(`SELECT fecha_fin_estado FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@rid`);
  assert.equal(new Date(after.recordset[0].fecha_fin_estado).getTime(), NUEVO_INICIO.getTime());
});

test('7. POST /api/disponibilidad/deshacer con histórico restaura', async () => {
  const db = await getDB();
  // D-026 (Q11): "histórico" y "vigente" son ambos filas de `disponibilidad_estado`;
  // se distinguen por fecha_fin_estado. Deshacer DELETE-ea el vigente y UPDATE-a
  // fecha_fin_estado=NULL al ex-N-1.
  const histPrev = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NOT NULL`);
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

  // El histórico tiene 1 fila menos (el vigente Indisponible fue DELETE-eado).
  const histPost = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NOT NULL`);
  assert.equal(histPost.recordset[0].n, histCountAntes - 1);

  // Existe exactamente 1 vigente En Servicio en disponibilidad_estado.
  const activos = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id=@p AND fecha_fin_estado IS NULL`);
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

// ============================================================================
// D-026: tests nuevos que cubren la migración de DISP a bitacora.disponibilidad_estado
// (tabla ER nativa) + vistas derivadas (v_disponibilidad_estado, disponibilidad_dashboard).
// ============================================================================

test('19. F26.A1 backfill idempotente: flag presente + conteo estable', async () => {
  // initDB() ya corrió en setupSessions(); el bloque F26.A1 estaba gateado y el flag
  // debe estar persistido. Re-ejecutar setupSessions() no debe duplicar rows ni perder
  // el flag (verifica que el patrón "IF NOT EXISTS migracion_aplicada → run" funciona).
  const db = await getDB();
  const flag = await db.request().query(
    `SELECT 1 AS ok FROM bitacora.migracion_aplicada WHERE codigo='F26.A1'`
  );
  assert.equal(flag.recordset[0]?.ok, 1, 'flag F26.A1 debe existir tras initDB');

  const c0 = (await db.request().query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado`))
    .recordset[0].n;

  // Forzar otra entrada a initDB() (la idempotencia del flag impide re-ejecutar el bloque)
  const { initDB } = await import('../db.js');
  await initDB();

  const c1 = (await db.request().query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado`))
    .recordset[0].n;
  assert.equal(c0, c1, 'rows en disponibilidad_estado deben quedar iguales tras re-initDB');

  // Y el flag sigue exactamente 1 vez (no duplicado por PK).
  const flagCount = (await db.request().query(
    `SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo='F26.A1'`
  )).recordset[0].n;
  assert.equal(flagCount, 1, 'flag F26.A1 debe estar exactamente una vez');
});

test('20. v_disponibilidad_estado acumula correctamente intervalos cerrados', async () => {
  await cleanDisp();

  // Tres intervalos cerrados con duraciones conocidas:
  //   t0→t1: 2h En Servicio,  t1→t2: 3h En Reserva,  t2→t3: 1h Indisponible.
  const t0 = new Date(Date.now() - 10 * 3600 * 1000);
  const t1 = new Date(t0.getTime() + 2 * 3600 * 1000);
  const t2 = new Date(t1.getTime() + 3 * 3600 * 1000);
  const t3 = new Date(t2.getTime() + 1 * 3600 * 1000);

  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Servicio',  codigo:  1, fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Reserva',   codigo:  0, fecha_inicio: t1, fecha_fin: t2 });
  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'Indisponible', codigo: -1, fecha_inicio: t2, fecha_fin: t3 });

  const db = await getDB();
  const rows = (await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT * FROM bitacora.v_disponibilidad_estado WHERE planta=@p ORDER BY fecha`)
  ).recordset;

  assert.equal(rows.length, 3, '3 intervalos en la vista');

  // Acumulados son sums runnings: row[i] suma los i+1 intervalos hasta él.
  assert.equal(Number(rows[0].horas_en_servicio).toFixed(2),     '2.00');
  assert.equal(Number(rows[0].horas_en_reserva).toFixed(2),      '0.00');
  assert.equal(Number(rows[1].horas_en_servicio).toFixed(2),     '2.00');
  assert.equal(Number(rows[1].horas_en_reserva).toFixed(2),      '3.00');
  assert.equal(Number(rows[2].horas_en_servicio).toFixed(2),     '2.00');
  assert.equal(Number(rows[2].horas_en_reserva).toFixed(2),      '3.00');
  assert.equal(Number(rows[2].horas_en_indisponible).toFixed(2), '1.00');
});

test('21. v_disponibilidad_estado: vigente acumula hasta SYSUTCDATETIME()', async () => {
  await cleanDisp();
  // t0: hace 1h. t1: hace 30min (cierra el primero, abre el vigente). Esperado:
  // intervalo cerrado contribuye exactamente 30min en horas_en_servicio; el vigente
  // suma ≈30min en horas_en_reserva (depende del clock skew, tolerancia ±2s).
  const t0 = new Date(Date.now() - 60 * 60 * 1000);
  const t1 = new Date(Date.now() - 30 * 60 * 1000);

  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Servicio', codigo: 1, fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Reserva',  codigo: 0, fecha_inicio: t1, fecha_fin: null });

  const db = await getDB();
  const rows = (await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT * FROM bitacora.v_disponibilidad_estado WHERE planta=@p ORDER BY fecha`)
  ).recordset;

  assert.equal(rows.length, 2, '2 intervalos en la vista (1 cerrado + 1 vigente)');
  // El row vigente (row[1]) acumula 0.5h cerrado + ≈0.5h vigente vs ahora.
  const reservaH = Number(rows[1].horas_en_reserva);
  const TOL = 2 / 3600; // ±2s
  assert.ok(reservaH > 0.5 - TOL && reservaH < 0.5 + TOL,
    `vigente horas_en_reserva esperada ≈0.50h, obtenida ${reservaH}`);
});

test('22. deshacer restaura N-1 como vigente y la vista refleja el rollback', async () => {
  await cleanDisp();
  // Crear A → B vía API real (postDisp usa fechas en el pasado para evitar 422 fecha futura).
  const HOUR_T = 3600 * 1000;
  const tA = new Date(Date.now() - 2 * HOUR_T);
  const tB = new Date(Date.now() - 1 * HOUR_T);

  const postA = await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Servicio', fechaInicio: tA });
  assert.equal(postA.status, 201);
  const postB = await postDisp({ sesion_id: ctx.sesiones.jdt, evento: 'En Reserva',  fechaInicio: tB });
  assert.equal(postB.status, 201);

  // Estado pre-deshacer: vigente=En Reserva, cerrado=En Servicio.
  const antes = await call('GET', `/api/disponibilidad?planta_id=${PLANTA_ID}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(antes.data.vigente?.evento, 'En Reserva');
  assert.equal(antes.data.historial[0]?.evento, 'En Servicio');

  // Deshacer.
  const undo = await call('POST', '/api/disponibilidad/deshacer', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: PLANTA_ID },
  });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(undo.data.revertido?.evento, 'En Reserva');
  assert.equal(undo.data.restaurado?.evento, 'En Servicio');
  assert.equal(undo.data.restaurado?.fecha_fin_estado, null);
  assert.ok(undo.data.ciet_registro_id, 'ciet_registro_id presente');

  // Estado post-deshacer: vigente=En Servicio, historial vacío.
  const despues = await call('GET', `/api/disponibilidad?planta_id=${PLANTA_ID}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(despues.data.vigente?.evento, 'En Servicio');
  assert.equal(despues.data.historial.length, 0);

  // La vista refleja: solo el row En Servicio vigente; horas_en_reserva = 0.
  const db = await getDB();
  const rows = (await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT * FROM bitacora.v_disponibilidad_estado WHERE planta=@p`)
  ).recordset;
  assert.equal(rows.length, 1, 'solo el vigente queda tras deshacer');
  assert.ok(Number(rows[0].horas_en_servicio) > 0, 'horas_en_servicio > 0');
  assert.equal(Number(rows[0].horas_en_reserva), 0);
});

test('23. vista disponibilidad_dashboard devuelve solo vigente con shape cross-repo', async () => {
  await cleanDisp();
  const t0 = new Date(Date.now() - 60 * 60 * 1000);
  const t1 = new Date(Date.now() - 30 * 60 * 1000);

  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Servicio', codigo: 1, fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto({ planta_id: PLANTA_ID, estado: 'En Reserva',  codigo: 0, fecha_inicio: t1, fecha_fin: null });

  const db = await getDB();
  const rows = (await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT * FROM bitacora.disponibilidad_dashboard WHERE planta_id=@p`)
  ).recordset;

  assert.equal(rows.length, 1, 'la vista devuelve solo el vigente');
  const row = rows[0];

  // Shape exacto del contrato cross-repo (preservado tras D-026):
  assert.equal(row.planta_id, PLANTA_ID);
  assert.equal(row.evento, 'En Reserva');
  assert.equal(row.codigo, 0);
  assert.ok(row.fecha_inicio_estado, 'fecha_inicio_estado presente');
  assert.ok(row.registro_activo_id, 'registro_activo_id mapeado de disponibilidad_id');
  assert.equal(typeof row.jdts_snapshot, 'string', 'jdts_snapshot es JSON string');
  assert.equal(typeof row.jefes_snapshot, 'string', 'jefes_snapshot mapeado de jefes_planta_snapshot');
  assert.ok(row.actualizado_en, 'actualizado_en presente (COALESCE(modificado_en, creado_en))');
});
