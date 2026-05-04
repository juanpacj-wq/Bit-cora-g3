// F13.3: regresiones de bugs reportados por el usuario.
//   Bug A: el cierre de turno arrastraba el vigente DISP al histórico con fecha_fin_estado=NULL.
//   Bug B: creado_en/cerrado_en/fecha_cierre_operativo se serializaban con offset incorrecto
//          porque GETDATE() del SQL Server estaba en zona local pero mssql lo lee como UTC.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, PLANTA_ID, TEST_TAG } from './helpers.js';

let ctx;
let DISP_ID, MAND_ID, CALDERA_ID;
let DISP_TIPO_EVENTO_ID, CALDERA_TIPO_EVENTO_ID;

const HOUR = 3600 * 1000;

async function cleanAll() {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('disp', sql.Int, DISP_ID)
    .input('mand', sql.Int, MAND_ID)
    .input('cal', sql.Int, CALDERA_ID)
    .query(`
      DELETE FROM bitacora.disponibilidad_dashboard WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE bitacora_id IN (@disp, @mand, @cal) AND planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE bitacora_id IN (@disp, @mand, @cal) AND planta_id = @p;
    `);
}

// INSERT directo en activo, sin pasar por el endpoint POST (evita issues de permisos por
// cargo). El test mide el comportamiento del cierre, no el de la creación.
async function insertActivoDirecto({
  bitacora_id, tipo_evento_id, fecha_evento, turno = 1, detalle, planta_id = PLANTA_ID,
  campos_extra = null, fecha_fin_estado = null,
}) {
  const db = await getDB();
  const r = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha_evento', sql.DateTime2, fecha_evento)
    .input('turno', sql.TinyInt, turno)
    .input('detalle', sql.NVarChar(sql.MAX), detalle)
    .input('campos_extra', sql.NVarChar(sql.MAX), campos_extra ? JSON.stringify(campos_extra) : null)
    .input('tipo_evento_id', sql.Int, tipo_evento_id)
    .input('creado_por', sql.Int, ctx.usuarios.jdt.usuario_id)
    .input('fecha_fin_estado', sql.DateTime2, fecha_fin_estado)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, fecha_fin_estado)
      OUTPUT INSERTED.registro_id, INSERTED.creado_en
      VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @campos_extra, @tipo_evento_id,
              'borrador', '[]', '[]', '[]', @creado_por, @fecha_fin_estado)
    `);
  return r.recordset[0];
}

before(async () => {
  ctx = await setupSessions();
  DISP_ID    = ctx.bitByCodigo.DISP;
  MAND_ID    = ctx.bitByCodigo.MAND;
  CALDERA_ID = ctx.bitByCodigo.CALDERA;
  assert.ok(DISP_ID && MAND_ID && CALDERA_ID, 'DISP/MAND/CALDERA bitacora_id deben existir');

  const db = await getDB();
  const tipos = await db.request()
    .input('disp', sql.Int, DISP_ID)
    .input('cal', sql.Int, CALDERA_ID)
    .query(`
      SELECT bitacora_id, MIN(tipo_evento_id) AS tipo_evento_id
      FROM lov_bit.tipo_evento WHERE bitacora_id IN (@disp, @cal)
      GROUP BY bitacora_id
    `);
  for (const r of tipos.recordset) {
    if (r.bitacora_id === DISP_ID) DISP_TIPO_EVENTO_ID = r.tipo_evento_id;
    if (r.bitacora_id === CALDERA_ID) CALDERA_TIPO_EVENTO_ID = r.tipo_evento_id;
  }
  assert.ok(DISP_TIPO_EVENTO_ID && CALDERA_TIPO_EVENTO_ID, 'tipo_evento_id de DISP y CALDERA deben existir');

  await cleanAll();
});

after(async () => {
  await cleanAll();
  await cleanupTestRegistros();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug A: cierre de turno NO debe afectar a DISP ni a MAND.
// ─────────────────────────────────────────────────────────────────────────────

test('A1. /api/cierre/preview-masivo NO lista DISP', async () => {
  // Vigente DISP en activo (estado='borrador' por default → matchearía cierre viejo).
  await insertActivoDirecto({
    bitacora_id: DISP_ID,
    tipo_evento_id: DISP_TIPO_EVENTO_ID,
    fecha_evento: new Date(Date.now() - 24 * HOUR),
    turno: null,
    detalle: `${TEST_TAG} disp-A1`,
    campos_extra: { evento: 'Disponible', fecha_inicio_estado: new Date(Date.now() - 24 * HOUR).toISOString() },
  });

  const { status, data } = await call('GET', `/api/cierre/preview-masivo?planta_id=${PLANTA_ID}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  const ids = (data.bitacoras_pendientes || []).map((b) => b.bitacora_id);
  assert.ok(!ids.includes(DISP_ID), `DISP (${DISP_ID}) NO debe aparecer: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes(MAND_ID), `MAND (${MAND_ID}) NO debe aparecer: ${JSON.stringify(ids)}`);
});

test('A2. POST /api/cierre/bitacora con bitacora_id=DISP retorna 422', async () => {
  const { status, data } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: ctx.sesiones.jdt,
    body: { bitacora_id: DISP_ID, planta_id: PLANTA_ID },
  });
  assert.equal(status, 422, JSON.stringify(data));
  assert.equal(data.error, 'bitacora_no_cerrable');
});

test('A3. POST /api/cierre/bitacora con bitacora_id=MAND retorna 400 (F16)', async () => {
  const { status, data } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: ctx.sesiones.jdt,
    body: { bitacora_id: MAND_ID, planta_id: PLANTA_ID },
  });
  // F16 cambió 422 → 400 con código específico para que el frontend pueda gatear el botón
  // sin ambigüedad. El cierre individual MAND quedó bloqueado: el cierre es automático vía
  // mand-sweeper.js al cambiar el día Bogotá.
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.error, 'mand_cierre_individual_no_permitido');
});

test('A4. /api/cierre/masivo NO mueve el vigente DISP al histórico', async () => {
  const db = await getDB();
  const before = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_ID)
    .query(`
      SELECT registro_id FROM bitacora.registro_activo
      WHERE bitacora_id = @bid AND planta_id = @p AND fecha_fin_estado IS NULL
    `);
  assert.ok(before.recordset.length > 0, 'Pre-condición: vigente DISP debe existir en activo');
  const vigenteIdAntes = before.recordset[0].registro_id;

  const { status, data } = await call('POST', '/api/cierre/masivo', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: PLANTA_ID },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const after = await db.request()
    .input('rid', sql.Int, vigenteIdAntes)
    .query(`SELECT fecha_fin_estado FROM bitacora.registro_activo WHERE registro_id = @rid`);
  assert.equal(after.recordset.length, 1, 'El vigente DISP debe seguir en activo');
  assert.equal(after.recordset[0].fecha_fin_estado, null, 'fecha_fin_estado debe seguir NULL');

  const histDisp = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, DISP_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE bitacora_id = @bid AND planta_id = @p`);
  assert.equal(histDisp.recordset[0].n, 0, 'No debe haber DISP en histórico tras el cierre masivo');
});

test('A5. /api/cierre/masivo SÍ mueve registros de bitácoras normales (CALDERA)', async () => {
  const dia = new Date();
  dia.setHours(8, 0, 0, 0);
  await insertActivoDirecto({
    bitacora_id: CALDERA_ID,
    tipo_evento_id: CALDERA_TIPO_EVENTO_ID,
    fecha_evento: dia,
    turno: 1,
    detalle: `${TEST_TAG} caldera-A5`,
  });

  const { status, data } = await call('POST', '/api/cierre/masivo', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: PLANTA_ID },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const db = await getDB();
  const histCal = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('bid', sql.Int, CALDERA_ID)
    .input('tag', sql.NVarChar(200), `%${TEST_TAG} caldera-A5%`)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_historico
            WHERE bitacora_id = @bid AND planta_id = @p AND detalle LIKE @tag`);
  assert.ok(histCal.recordset[0].n >= 1, 'CALDERA debe haber sido movida al histórico');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug B: SYSUTCDATETIME() consistente para que el frontend formatee bien.
// ─────────────────────────────────────────────────────────────────────────────

test('B1. creado_en de un nuevo registro está en zona consistente con UTC del cliente', async () => {
  const tBefore = Date.now();
  const inserted = await insertActivoDirecto({
    bitacora_id: CALDERA_ID,
    tipo_evento_id: CALDERA_TIPO_EVENTO_ID,
    fecha_evento: new Date(),
    turno: 1,
    detalle: `${TEST_TAG} caldera-B1`,
  });
  const tAfter = Date.now();

  const creadoEnMs = new Date(inserted.creado_en).getTime();
  // SYSUTCDATETIME() devuelve UTC; mssql lo lee como UTC; el ms debe estar entre tBefore y
  // tAfter (con skew tolerable). Si seguía con GETDATE() (local Bogotá UTC-5), el ms quedaría
  // 5h ATRÁS y este assert fallaría.
  const skew = 5 * 60 * 1000;
  assert.ok(
    creadoEnMs >= tBefore - skew && creadoEnMs <= tAfter + skew,
    `creado_en (${new Date(creadoEnMs).toISOString()}) fuera de [${new Date(tBefore - skew).toISOString()}, ${new Date(tAfter + skew).toISOString()}]`
  );
});

test('B2. cerrado_en y fecha_cierre_operativo del histórico están en zona consistente', async () => {
  const db = await getDB();
  await insertActivoDirecto({
    bitacora_id: CALDERA_ID,
    tipo_evento_id: CALDERA_TIPO_EVENTO_ID,
    fecha_evento: new Date(Date.now() - HOUR),
    turno: 1,
    detalle: `${TEST_TAG} caldera-B2`,
  });

  const tBefore = Date.now();
  const { status, data } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: ctx.sesiones.jdt,
    body: { bitacora_id: CALDERA_ID, planta_id: PLANTA_ID },
  });
  const tAfter = Date.now();
  assert.equal(status, 200, JSON.stringify(data));

  const hist = await db.request()
    .input('bid', sql.Int, CALDERA_ID)
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('tag', sql.NVarChar(200), `%${TEST_TAG} caldera-B2%`)
    .query(`
      SELECT TOP 1 cerrado_en, fecha_cierre_operativo
      FROM bitacora.registro_historico
      WHERE bitacora_id = @bid AND planta_id = @p AND detalle LIKE @tag
      ORDER BY registro_id DESC
    `);
  assert.equal(hist.recordset.length, 1, '1 registro CALDERA en histórico tras cierre');

  const cerradoEnMs = new Date(hist.recordset[0].cerrado_en).getTime();
  const skew = 5 * 60 * 1000;
  assert.ok(
    cerradoEnMs >= tBefore - skew && cerradoEnMs <= tAfter + skew,
    `cerrado_en (${new Date(cerradoEnMs).toISOString()}) fuera del rango`
  );

  // fecha_cierre_operativo: día Bogotá del cierre (vía CAST(DATEADD(HOUR,-5, SYSUTCDATETIME()) AS DATE)).
  const ahoraUTC = new Date(tBefore + (tAfter - tBefore) / 2);
  const ahoraBogota = new Date(ahoraUTC.getTime() - 5 * HOUR);
  const expectedDiaBogota = ahoraBogota.toISOString().slice(0, 10);
  const fechaOpStr = new Date(hist.recordset[0].fecha_cierre_operativo).toISOString().slice(0, 10);
  assert.equal(
    fechaOpStr, expectedDiaBogota,
    `fecha_cierre_operativo (${fechaOpStr}) debe matchear día Bogotá actual (${expectedDiaBogota})`
  );
});
