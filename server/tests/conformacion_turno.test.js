import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import {
  buildConformacionSnapshot,
  persistConformacionSnapshot,
} from '../utils/conformacion-snapshot.js';
import { setupSessions, cleanupTestRegistros, call, PLANTA_ID } from './helpers.js';

// Fechas históricas determinísticas — fuera de la ventana que las sesiones reales de
// setupSessions() (con inicio_sesion=now) podrían tocar. T1: 06:00-17:59 Bogotá del día X;
// T2: 18:00 día X → 05:59 día X+1.
const FECHA_T1 = '2026-05-17';
const FECHA_T2_INICIO = '2026-05-17'; // turno=2 con fecha_operativa = día del inicio (18:00)
const VENTANA_T1_INICIO_UTC = '2026-05-17T11:00:00.000Z'; // 06:00 Bogotá
const VENTANA_T1_FIN_UTC    = '2026-05-17T23:00:00.000Z'; // 18:00 Bogotá

let ctx;
let cargoByName;
let sesionesCreadas = [];

before(async () => {
  ctx = await setupSessions();
  const db = await getDB();
  const cargos = await db.request().query(`SELECT cargo_id, nombre FROM lov_bit.cargo`);
  cargoByName = Object.fromEntries(cargos.recordset.map(c => [c.nombre, c.cargo_id]));

  // Purgar residuos de runs anteriores: sesiones de test users cuyo inicio_sesion ya no es
  // "live" (más de 1h atrás). Las creadas por setupSessions() arriba son recientes y se
  // preservan; los residuos históricos de runs crasheados se eliminan.
  await db.request().query(`
    DELETE FROM bitacora.sesion_activa
    WHERE usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE username LIKE 'test_%')
      AND inicio_sesion < DATEADD(HOUR, -1, SYSUTCDATETIME())
  `);
});

after(async () => {
  await cleanupTestRegistros();
});

async function insertSesionManual({ usuario_id, planta_id = PLANTA_ID, cargo_id, turno, inicio_iso, cerrada_iso = null }) {
  const db = await getDB();
  const r = await db.request()
    .input('usuario_id', sql.Int, usuario_id)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('cargo_id', sql.Int, cargo_id)
    .input('turno', sql.TinyInt, turno)
    .input('inicio', sql.DateTime2, new Date(inicio_iso))
    .input('cerrada', sql.DateTime2, cerrada_iso ? new Date(cerrada_iso) : null)
    .query(`
      INSERT INTO bitacora.sesion_activa
        (usuario_id, planta_id, cargo_id, turno, inicio_sesion, ultima_actividad, activa, cerrada_en)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno, @inicio, @inicio,
              CASE WHEN @cerrada IS NULL THEN 1 ELSE 0 END, @cerrada);
    `);
  const sesion_id = r.recordset[0].sesion_id;
  sesionesCreadas.push(sesion_id);
  return sesion_id;
}

async function cleanupSesionesManuales() {
  if (sesionesCreadas.length === 0) return;
  const db = await getDB();
  const ids = sesionesCreadas.join(',');
  await db.request().query(`DELETE FROM bitacora.sesion_activa WHERE sesion_id IN (${ids})`);
  sesionesCreadas = [];
}

async function clearConformacionTest({ fecha, planta_id = PLANTA_ID }) {
  const db = await getDB();
  await db.request()
    .input('fecha', sql.Date, fecha)
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      DELETE FROM bitacora.conformacion_turno
      WHERE fecha_operativa = @fecha AND planta_id = @planta_id
        AND usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE username LIKE 'test_%')
    `);
}

describe('buildConformacionSnapshot', () => {
  beforeEach(async () => {
    await cleanupSesionesManuales();
    await clearConformacionTest({ fecha: FECHA_T1 });
    await clearConformacionTest({ fecha: FECHA_T2_INICIO });
  });

  test('sin sesiones en la ventana → array vacío', async () => {
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
    });
    assert.deepEqual(filas, []);
  });

  test('1 usuario T1 con logout explícito dentro de ventana → 1 fila, fin_inferido=0, duración correcta', async () => {
    await insertSesionManual({
      usuario_id: ctx.usuarios.jdt.usuario_id,
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      turno: 1,
      inicio_iso: VENTANA_T1_INICIO_UTC,             // 06:00 Bogotá
      cerrada_iso: '2026-05-17T22:00:00.000Z',       // 17:00 Bogotá → 11h
    });
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
    });
    assert.equal(filas.length, 1);
    assert.equal(filas[0].fin_inferido, 0);
    assert.equal(filas[0].duracion_min, 11 * 60);
    assert.equal(filas[0].cargo_nombre, 'Ingeniero Jefe de Turno');
  });

  test('1 usuario T1 sin logout (cerrada=NULL) → fin_sesion=ventana.fin, fin_inferido=1', async () => {
    await insertSesionManual({
      usuario_id: ctx.usuarios.jdt.usuario_id,
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      turno: 1,
      inicio_iso: VENTANA_T1_INICIO_UTC,
      cerrada_iso: null,
    });
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
    });
    assert.equal(filas.length, 1);
    assert.equal(filas[0].fin_inferido, 1);
    assert.equal(filas[0].fin_sesion.toISOString(), VENTANA_T1_FIN_UTC);
    assert.equal(filas[0].duracion_min, 12 * 60); // ventana completa T1 = 12h
  });

  test('2 usuarios distintos en mismo turno → 2 filas', async () => {
    await insertSesionManual({
      usuario_id: ctx.usuarios.jdt.usuario_id,
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      turno: 1, inicio_iso: VENTANA_T1_INICIO_UTC, cerrada_iso: '2026-05-17T22:00:00.000Z',
    });
    await insertSesionManual({
      usuario_id: ctx.usuarios.ingOp.usuario_id,
      cargo_id: cargoByName['Ingeniero de Operación'],
      turno: 1, inicio_iso: VENTANA_T1_INICIO_UTC, cerrada_iso: '2026-05-17T22:00:00.000Z',
    });
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
    });
    assert.equal(filas.length, 2);
    const cargos = filas.map(f => f.cargo_nombre).sort();
    assert.deepEqual(cargos, ['Ingeniero Jefe de Turno', 'Ingeniero de Operación'].sort());
  });

  test('re-login del mismo usuario en mismo turno → 1 fila agregada con SUMA duración', async () => {
    // Primera sesión: 06:00→10:00 Bogotá (4h)
    await insertSesionManual({
      usuario_id: ctx.usuarios.jdt.usuario_id,
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      turno: 1,
      inicio_iso: '2026-05-17T11:00:00.000Z',
      cerrada_iso: '2026-05-17T15:00:00.000Z',
    });
    // Segunda sesión: 12:00→17:00 Bogotá (5h)
    await insertSesionManual({
      usuario_id: ctx.usuarios.jdt.usuario_id,
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      turno: 1,
      inicio_iso: '2026-05-17T17:00:00.000Z',
      cerrada_iso: '2026-05-17T22:00:00.000Z',
    });
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
    });
    assert.equal(filas.length, 1);
    assert.equal(filas[0].duracion_min, (4 + 5) * 60);
    // inicio_sesion debe ser el MIN; fin_sesion el MAX de los efectivos
    assert.equal(filas[0].inicio_sesion.toISOString(), '2026-05-17T11:00:00.000Z');
    assert.equal(filas[0].fin_sesion.toISOString(),    '2026-05-17T22:00:00.000Z');
  });

  test('T2 cruzando medianoche → ventana correcta [18:00 día X, 06:00 día X+1) Bogotá', async () => {
    // T2 con fecha_operativa=2026-05-17 → ventana [2026-05-17T23:00:00Z, 2026-05-18T11:00:00Z)
    // Sesión: 20:00 Bogotá del 17 (= 2026-05-18T01:00:00Z) → 04:00 Bogotá del 18 (= 2026-05-18T09:00:00Z) → 8h
    await insertSesionManual({
      usuario_id: ctx.usuarios.ingOp.usuario_id,
      cargo_id: cargoByName['Ingeniero de Operación'],
      turno: 2,
      inicio_iso: '2026-05-18T01:00:00.000Z',
      cerrada_iso: '2026-05-18T09:00:00.000Z',
    });
    const db = await getDB();
    const filas = await buildConformacionSnapshot(db, {
      fecha_operativa: FECHA_T2_INICIO, planta_id: PLANTA_ID, turno: 2,
    });
    assert.equal(filas.length, 1);
    assert.equal(filas[0].duracion_min, 8 * 60);
    assert.equal(filas[0].fin_inferido, 0);
  });
});

describe('persistConformacionSnapshot', () => {
  beforeEach(async () => {
    await cleanupSesionesManuales();
    await clearConformacionTest({ fecha: FECHA_T1 });
  });

  test('idempotencia vía PK: segunda call al mismo set → insertadas=0, skipped=1', async () => {
    const db = await getDB();
    const fila = {
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
      usuario_id: ctx.usuarios.jdt.usuario_id,
      usuario_nombre: 'Test JdT',
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      cargo_nombre: 'Ingeniero Jefe de Turno',
      inicio_sesion: new Date(VENTANA_T1_INICIO_UTC),
      fin_sesion: new Date(VENTANA_T1_FIN_UTC),
      duracion_min: 720,
      fin_inferido: 0,
    };
    const r1 = await persistConformacionSnapshot(db, [fila]);
    const r2 = await persistConformacionSnapshot(db, [fila]);
    assert.equal(r1.insertadas, 1);
    assert.equal(r1.skipped, 0);
    assert.equal(r2.insertadas, 0);
    assert.equal(r2.skipped, 1);
  });
});

describe('GET /api/conformacion-turno', () => {
  beforeEach(async () => {
    await cleanupSesionesManuales();
    await clearConformacionTest({ fecha: FECHA_T1 });
  });

  test('sin x-sesion-id → 401', async () => {
    const { status } = await call('GET', `/api/conformacion-turno?fecha=${FECHA_T1}&turno=1&planta_id=${PLANTA_ID}`);
    assert.equal(status, 401);
  });

  test('turno inválido → 400', async () => {
    const { status, data } = await call('GET', `/api/conformacion-turno?fecha=${FECHA_T1}&turno=9&planta_id=${PLANTA_ID}`, {
      sesion_id: ctx.sesiones.jdt,
    });
    assert.equal(status, 400);
    assert.match(data.error, /turno/);
  });

  test('200 con shape correcto y filtra por (fecha, turno, planta_id)', async () => {
    // Seed: 1 fila en conformacion_turno via persist
    const db = await getDB();
    await persistConformacionSnapshot(db, [{
      fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1,
      usuario_id: ctx.usuarios.jdt.usuario_id,
      usuario_nombre: 'Test JdT',
      cargo_id: cargoByName['Ingeniero Jefe de Turno'],
      cargo_nombre: 'Ingeniero Jefe de Turno',
      inicio_sesion: new Date(VENTANA_T1_INICIO_UTC),
      fin_sesion: new Date(VENTANA_T1_FIN_UTC),
      duracion_min: 720, fin_inferido: 0,
    }]);
    const { status, data } = await call('GET',
      `/api/conformacion-turno?fecha=${FECHA_T1}&turno=1&planta_id=${PLANTA_ID}`,
      { sesion_id: ctx.sesiones.jdt });
    assert.equal(status, 200);
    assert.equal(data.planta_id, PLANTA_ID);
    assert.equal(data.turno, 1);
    assert.ok(Array.isArray(data.filas));
    const mine = data.filas.find(f => f.usuario_id === ctx.usuarios.jdt.usuario_id);
    assert.ok(mine, 'la fila seedeada debe aparecer');
    assert.equal(mine.duracion_min, 720);
    assert.equal(mine.fin_inferido, false); // mssql BIT → boolean
    assert.ok('inicio_sesion_bogota' in mine);
  });
});

describe('POST /api/conformacion-turno/trigger', () => {
  beforeEach(async () => {
    await cleanupSesionesManuales();
    await clearConformacionTest({ fecha: FECHA_T1 });
  });

  test('sin sesión → 401', async () => {
    const { status } = await call('POST', '/api/conformacion-turno/trigger', {
      body: { fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1 },
    });
    assert.equal(status, 401);
  });

  test('Ingeniero Químico (sin permiso) → 403', async () => {
    const { status, data } = await call('POST', '/api/conformacion-turno/trigger', {
      sesion_id: ctx.sesiones.ingQuim,
      body: { fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1 },
    });
    assert.equal(status, 403, JSON.stringify(data));
  });

  test('JdT, turno pasado, sin sesiones de test users → 200 y no aparecen filas test en la tabla', async () => {
    const { status, data } = await call('POST', '/api/conformacion-turno/trigger', {
      sesion_id: ctx.sesiones.jdt,
      body: { fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1 },
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.force, false);
    // No aserto sobre insertadas absoluto: la BD productiva tiene sesiones reales en
    // 2026-05-17 que el builder fix-eado correctamente incluye. Asserto sobre test users.
    const db = await getDB();
    const r = await db.request()
      .input('fecha', sql.Date, FECHA_T1)
      .input('planta', sql.VarChar(10), PLANTA_ID)
      .query(`
        SELECT COUNT(*) AS n FROM bitacora.conformacion_turno
        WHERE fecha_operativa = @fecha AND turno = 1 AND planta_id = @planta
          AND usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE username LIKE 'test_%')
      `);
    assert.equal(r.recordset[0].n, 0, 'no debe haber filas de test users sin sesiones manuales previas');
  });

  test('JdT con sesión de test user → trigger inserta la fila test; segunda call es idempotente', async () => {
    await insertSesionManual({
      usuario_id: ctx.usuarios.ingOp.usuario_id,
      cargo_id: cargoByName['Ingeniero de Operación'],
      turno: 1,
      inicio_iso: VENTANA_T1_INICIO_UTC,
      cerrada_iso: '2026-05-17T22:00:00.000Z',
    });

    const r1 = await call('POST', '/api/conformacion-turno/trigger', {
      sesion_id: ctx.sesiones.jdt,
      body: { fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1 },
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));

    const db = await getDB();
    const q = `
      SELECT COUNT(*) AS n, MAX(duracion_min) AS dur FROM bitacora.conformacion_turno
      WHERE fecha_operativa = @fecha AND turno = 1 AND planta_id = @planta
        AND usuario_id = @uid
    `;
    const post1 = await db.request()
      .input('fecha', sql.Date, FECHA_T1)
      .input('planta', sql.VarChar(10), PLANTA_ID)
      .input('uid', sql.Int, ctx.usuarios.ingOp.usuario_id)
      .query(q);
    assert.equal(post1.recordset[0].n, 1, 'la fila del test user debe existir tras el primer trigger');
    assert.equal(post1.recordset[0].dur, 11 * 60);

    // Segunda call — debe ser idempotente (no duplica)
    const r2 = await call('POST', '/api/conformacion-turno/trigger', {
      sesion_id: ctx.sesiones.jdt,
      body: { fecha_operativa: FECHA_T1, planta_id: PLANTA_ID, turno: 1 },
    });
    assert.equal(r2.status, 200);

    const post2 = await db.request()
      .input('fecha', sql.Date, FECHA_T1)
      .input('planta', sql.VarChar(10), PLANTA_ID)
      .input('uid', sql.Int, ctx.usuarios.ingOp.usuario_id)
      .query(q);
    assert.equal(post2.recordset[0].n, 1, 'idempotencia: la fila sigue siendo única');
  });
});
