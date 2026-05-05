import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, PLANTA_ID, TEST_TAG } from './helpers.js';

let ctx;
let MAND_BITACORA_ID;

// Hoy Bogotá en formato YYYY-MM-DD (mismo cálculo que el endpoint /guardar).
function hoyBogota() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Periodo actual = hora_bogota + 1.
function periodoActual() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return d.getUTCHours() + 1;
}

const HOY = hoyBogota();
const P_ACTUAL = periodoActual();

async function cleanMand() {
  const db = await getDB();
  await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`
      DELETE FROM bitacora.evento_dashboard WHERE planta_id = @p
        AND registro_origen_id IN (
          SELECT registro_id FROM bitacora.registro_activo WHERE bitacora_id = @mand AND planta_id = @p
          UNION ALL
          SELECT registro_id FROM bitacora.registro_historico WHERE bitacora_id = @mand AND planta_id = @p
        );
      DELETE FROM bitacora.registro_activo WHERE bitacora_id = @mand AND planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE bitacora_id = @mand AND planta_id = @p;
      DELETE FROM bitacora.mand_cierre_log WHERE planta_id = @p;
    `);
}

async function postGuardar({ sesion_id, body }) {
  return call('POST', '/api/sala-de-mando/guardar', { sesion_id, body });
}

before(async () => {
  ctx = await setupSessions();
  MAND_BITACORA_ID = ctx.bitByCodigo.MAND;
  assert.ok(MAND_BITACORA_ID, 'MAND bitacora_id debe existir');
  await cleanMand();
});

after(async () => {
  await cleanMand();
  await cleanupTestRegistros();
});

test('1. POST guardar — 3 filas, 8 celdas total → 200 con resumen creados=8', async () => {
  // Elegimos un periodo REDESP >= P_ACTUAL para evitar el lock (variable según hora del run).
  const pRedesp1 = Math.min(P_ACTUAL, 24);
  const pRedesp2 = Math.min(P_ACTUAL + 1, 24);

  const body = {
    planta_id: PLANTA_ID,
    fecha: HOY,
    filas: [
      {
        tipo: 'AUTH',
        detalle: `${TEST_TAG} auth`,
        funcionariocnd: 'Pérez',
        periodos: [
          { periodo: 1, valor_mw: 80 }, { periodo: 2, valor_mw: 85 },
          { periodo: 3, valor_mw: 90 }, { periodo: 4, valor_mw: 95 },
          { periodo: 5, valor_mw: 100 },
        ],
      },
      {
        tipo: 'PRUEBA',
        detalle: `${TEST_TAG} prueba`,
        funcionariocnd: null,
        periodos: [{ periodo: 1, valor_mw: 50 }],
      },
      {
        tipo: 'REDESP',
        detalle: `${TEST_TAG} redesp`,
        funcionariocnd: null,
        periodos: pRedesp1 === pRedesp2
          ? [{ periodo: pRedesp1, valor_mw: 110 }]
          : [{ periodo: pRedesp1, valor_mw: 110 }, { periodo: pRedesp2, valor_mw: 115 }],
      },
    ],
  };

  const { status, data } = await postGuardar({ sesion_id: ctx.sesiones.jdt, body });
  assert.equal(status, 200, JSON.stringify(data));
  // 5 AUTH + 1 PRUEBA + (1 ó 2 REDESP) = 7 ó 8
  const totalCeldas = 5 + 1 + body.filas[2].periodos.length;
  assert.equal(data.resumen?.creados, totalCeldas);
  assert.equal(data.resumen?.actualizados, 0);
  assert.equal(data.resumen?.eliminados, 0);

  // Verificar evento_dashboard ahora tiene filas activas para los 3 tipos.
  const db = await getDB();
  const dash = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('f', sql.Date, HOY)
    .query(`
      SELECT tipo, COUNT(*) AS n FROM bitacora.evento_dashboard
      WHERE planta_id=@p AND fecha=@f AND activa=1
      GROUP BY tipo
    `);
  const byTipo = Object.fromEntries(dash.recordset.map((r) => [r.tipo, r.n]));
  assert.equal(byTipo.AUTH, 5);
  assert.equal(byTipo.PRUEBA, 1);
  assert.equal(byTipo.REDESP, body.filas[2].periodos.length);
});

test('2. AUTH sin funcionariocnd con valor → 400 con errores', async () => {
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG} sinfunc`, funcionariocnd: null,
        periodos: [{ periodo: 6, valor_mw: 70 }],
      }],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(Array.isArray(data.errores));
  assert.ok(data.errores.some((e) => e.tipo === 'AUTH' && e.motivo === 'funcionariocnd_requerido'));
});

test('3. REDESP en periodo bloqueado (P1 si la hora actual > 0) → 400 con errores', async () => {
  // Solo corre si hay periodo bloqueable (cuando P_ACTUAL > 1).
  if (P_ACTUAL <= 1) return;
  const pBloqueado = 1;
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'REDESP', detalle: `${TEST_TAG} bloq`, funcionariocnd: null,
        periodos: [{ periodo: pBloqueado, valor_mw: 50 }],
      }],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(Array.isArray(data.errores));
  assert.ok(data.errores.some((e) => e.tipo === 'REDESP' && e.motivo === 'periodo_bloqueado'));
});

test('4. fecha != hoy → 400 fecha_no_es_hoy', async () => {
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: '2020-01-01',
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG}`, funcionariocnd: 'X',
        periodos: [{ periodo: 1, valor_mw: 1 }],
      }],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(data.errores?.some((e) => e.motivo === 'fecha_no_es_hoy'));
});

test('5. PRUEBA con funcionariocnd != null → server lo fuerza a NULL silencioso', async () => {
  await cleanMand(); // estado limpio para verificar
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', detalle: `${TEST_TAG} pforced`, funcionariocnd: 'IGNORADO',
        periodos: [{ periodo: 8, valor_mw: 33 }],
      }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  // Verificar que el registro no tiene funcionariocnd persistido.
  const db = await getDB();
  const r = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .query(`
      SELECT TOP 1 JSON_VALUE(campos_extra, '$.funcionariocnd') AS func
      FROM bitacora.registro_activo
      WHERE bitacora_id = @mand AND detalle LIKE '%pforced%'
      ORDER BY creado_en DESC
    `);
  assert.equal(r.recordset[0]?.func, null);
});

test('6. Re-save: cambio en P3, vaciar P5, sumar P6 → 1 actualizado, 1 eliminado, 1 creado', async () => {
  await cleanMand();
  // Setup inicial: AUTH P3=90, P5=100.
  const setup = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG} resave`, funcionariocnd: 'Pérez',
        periodos: [{ periodo: 3, valor_mw: 90 }, { periodo: 5, valor_mw: 100 }],
      }],
    },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.data.resumen.creados, 2);

  // Re-save: P3=92 (update), P5=null (delete), P6=105 (insert).
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG} resave`, funcionariocnd: 'Pérez',
        periodos: [
          { periodo: 3, valor_mw: 92 },
          { periodo: 5, valor_mw: null },
          { periodo: 6, valor_mw: 105 },
        ],
      }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.resumen.creados, 1);
  assert.equal(data.resumen.actualizados, 1);
  assert.equal(data.resumen.eliminados, 1);
});

test('7. POST /api/cierre/bitacora con MAND → 400 con motivo específico', async () => {
  const { status, data } = await call('POST', '/api/cierre/bitacora', {
    sesion_id: ctx.sesiones.jdt,
    body: { bitacora_id: MAND_BITACORA_ID, planta_id: PLANTA_ID },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.error, 'mand_cierre_individual_no_permitido');
});

test('9. T1 regression — registro con fecha_evento UTC del día siguiente (22:30 Bogotá HOY) aparece en grilla del día Bogotá', async () => {
  // F19.A: GET /api/sala-de-mando antes filtraba con CAST(fecha_evento AS DATE) = @fecha
  // (UTC), por lo que entre 19:00 y 23:59 Bogotá los recién insertados (cuyo fecha_evento
  // ya pertenecía al día UTC siguiente) aparecían fuera de la grilla → grilla vacía. La
  // query ahora usa CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE). Este test inserta
  // explícitamente un registro con fecha_evento = HOY 22:30 Bogotá (= MAÑANA 03:30 UTC) y
  // verifica que la grilla del día Bogotá actual lo incluye, sin importar la hora del run.
  await cleanMand();
  const db = await getDB();

  const tipos = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .query(`
      SELECT tipo_evento_id, notificar_dashboard_tipo
      FROM lov_bit.tipo_evento
      WHERE bitacora_id = @mand AND notificar_dashboard_tipo = 'AUTH'
    `);
  const authTipoEventoId = tipos.recordset[0]?.tipo_evento_id;
  assert.ok(authTipoEventoId, 'tipo_evento_id AUTH MAND debe existir');

  const fechaEvento22h30Bogota = new Date(`${HOY}T22:30:00-05:00`);
  // Sanity: el ISO UTC debe ser día siguiente (cruce de medianoche UTC).
  assert.notEqual(fechaEvento22h30Bogota.toISOString().slice(0, 10), HOY,
    'fecha_evento UTC debe pertenecer al día siguiente para ejercer el bug T1');

  await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('fecha_evento', sql.DateTime2, fechaEvento22h30Bogota)
    .input('te', sql.Int, authTipoEventoId)
    .input('campos_extra', sql.NVarChar(sql.MAX), JSON.stringify({ periodo: 23, valor_mw: 87.5, funcionariocnd: 'Madrugador' }))
    .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} t1-regression`)
    .input('creado_por', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      VALUES (@mand, @p, @fecha_evento, 2, @detalle, @campos_extra, @te,
              'borrador', '[]', '[]', '[]', @creado_por)
    `);

  const { status, data } = await call('GET', `/api/sala-de-mando?planta_id=${PLANTA_ID}&fecha=${HOY}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.AUTH, 'respuesta debe incluir bloque AUTH');
  // P23 → índice 22.
  assert.equal(data.AUTH.valores[22], 87.5, `AUTH P23 debe valer 87.5 — bug T1 reaparecido si null. valores=${JSON.stringify(data.AUTH.valores)}`);
});

test('8. /cierre-diario manual → 200 closed:true; segundo intento → 200 skipped', async () => {
  await cleanMand();
  // Primero metemos al menos 1 registro hoy para que el cierre genere CIET.
  const setup = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG} cierre`, funcionariocnd: 'X',
        periodos: [{ periodo: 12, valor_mw: 60 }],
      }],
    },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));

  const c1 = await call('POST', '/api/sala-de-mando/cierre-diario', {
    sesion_id: ctx.sesiones.jdt,
    body: { fecha: HOY, planta_id: PLANTA_ID },
  });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.equal(c1.data.closed, true);
  assert.ok(c1.data.registros >= 1);

  // Segundo intento → skipped.
  const c2 = await call('POST', '/api/sala-de-mando/cierre-diario', {
    sesion_id: ctx.sesiones.jdt,
    body: { fecha: HOY, planta_id: PLANTA_ID },
  });
  assert.equal(c2.status, 200, JSON.stringify(c2.data));
  assert.equal(c2.data.skipped, true);
  assert.equal(c2.data.reason, 'already_closed');

  // Verificar que no quedó registro en activo y sí en histórico, y que mand_cierre_log tiene la fila.
  const db = await getDB();
  const activos = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE bitacora_id=@mand AND planta_id=@p`);
  assert.equal(activos.recordset[0].n, 0);
  const log = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('f', sql.Date, HOY)
    .query(`SELECT registros_cerrados FROM bitacora.mand_cierre_log WHERE planta_id=@p AND fecha_cerrada=@f`);
  assert.equal(log.recordset.length, 1);
  assert.ok(log.recordset[0].registros_cerrados >= 1);
});

test('10. F21.C — CIET emitido por cierre-diario tiene campos_extra.fecha_cerrada en formato YYYY-MM-DD día Bogotá', async () => {
  // F19.C: registrarCierreMand antes serializaba fecha_cerrada con .toISOString().slice(0,10),
  // que entre 19:00 y 23:59 Bogotá emitía el día UTC siguiente. Ahora usa fechaBogotaStr
  // (offset puro -5h). Este test ejerce el flujo completo (insert MAND → cierre-diario)
  // y valida la forma del JSON resultante.
  await cleanMand();
  const setup = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', detalle: `${TEST_TAG} ciet-fecha`, funcionariocnd: 'Y',
        periodos: [{ periodo: 14, valor_mw: 70 }],
      }],
    },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));

  const cierre = await call('POST', '/api/sala-de-mando/cierre-diario', {
    sesion_id: ctx.sesiones.jdt,
    body: { fecha: HOY, planta_id: PLANTA_ID },
  });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.data));
  assert.equal(cierre.data.closed, true);

  const db = await getDB();
  const ciet = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`
      SELECT TOP 1 ra.registro_id, ra.campos_extra
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE b.codigo = 'CIET' AND ra.planta_id = @p
        AND JSON_VALUE(ra.campos_extra, '$.motivo') = 'mand-sweeper-diario'
      ORDER BY ra.registro_id DESC
    `);
  assert.equal(ciet.recordset.length, 1, 'el cierre debe emitir 1 CIET con motivo mand-sweeper-diario');

  const camposExtra = JSON.parse(ciet.recordset[0].campos_extra);
  assert.match(camposExtra.fecha_cerrada, /^\d{4}-\d{2}-\d{2}$/,
    `fecha_cerrada debe ser YYYY-MM-DD (got ${camposExtra.fecha_cerrada})`);
  assert.equal(camposExtra.fecha_cerrada, HOY,
    `fecha_cerrada (${camposExtra.fecha_cerrada}) debe matchear día Bogotá actual (${HOY}) — bug T3 reaparecido si difiere por 1 día`);

  // Cleanup: borrar el CIET emitido para no acumular leftover entre runs (no tiene TEST_TAG en
  // detalle porque registrarCierreMand lo deja NULL).
  await db.request()
    .input('rid', sql.Int, ciet.recordset[0].registro_id)
    .query(`DELETE FROM bitacora.registro_activo WHERE registro_id = @rid`);
});
