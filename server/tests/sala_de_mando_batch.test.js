import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { cerrarDiaMand } from '../utils/mand-sweeper.js';
import { fechaOperativaDePeriodo, turnoFromPeriodo } from '../utils/turno.js';
import { recalcularEventoDashboard } from '../utils/notificador.js';
import { setupSessions, cleanupTestRegistros, call, TEST_PLANTA, TEST_TAG } from './helpers.js';

// D-055: esta suite operaba sobre PLANTA_ID ('GEC3', planta REAL) y su cleanMand() borraba
// `registro_historico` de MAND en GEC3 SIN acotar por fecha ni por tag — con la suite corriendo
// contra la BD productiva (D-030), cada `npm test` destruía histórico inmutable real (RF-032).
// Ahora opera sobre la planta-fixture 'TST', igual que DISP. El endpoint dejó de hardcodear
// ['GEC3','GEC32'], que era lo que forzaba a esta suite a escribir en una planta real.
const PLANTA_ID = TEST_PLANTA;

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

// D-056: 'HH:mm' Bogotá desplazado `deltaMin` minutos respecto de ahora. Devuelve null si el
// desplazamiento se sale del día de la grilla (solo ocurre en los bordes 00:00 / 23:59) — el
// servidor rechazaría esa hora con `hora_invalida` y el test perdería su intención.
function horaBogotaMin(deltaMin) {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  const minutos = d.getUTCHours() * 60 + d.getUTCMinutes() + deltaMin;
  if (minutos < 0 || minutos > 1439) return null;
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

// Hora de llamada válida por defecto: 2 minutos atrás (nunca futura, siempre dentro del día).
const HORA_OK = horaBogotaMin(-2) ?? '00:00';

// D-055: hard-codeada a TEST_PLANTA y SIN parámetro de planta — imposible apuntarla a GEC3/GEC32
// por error (mismo patrón que cleanDispTestPlanta, D-041). El assert es la última línea de defensa
// si alguien reapunta la constante: preferimos reventar la suite antes que borrar histórico real.
async function cleanMand() {
  assert.equal(TEST_PLANTA, 'TST', 'cleanMand solo puede correr sobre la planta-fixture');
  const db = await getDB();
  await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), TEST_PLANTA)
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
  ctx = await setupSessions({ planta: PLANTA_ID });
  MAND_BITACORA_ID = ctx.bitByCodigo.MAND;
  assert.ok(MAND_BITACORA_ID, 'MAND bitacora_id debe existir');
  await cleanMand();
});

after(async () => {
  await cleanMand();
  await cleanupTestRegistros();
});

test('1. POST guardar — 3 filas con hora → 200 { lotes: 3, registros: N }', async () => {
  await cleanMand();
  // Elegimos un periodo REDESP >= P_ACTUAL para evitar el lock (variable según hora del run).
  const pRedesp1 = Math.min(P_ACTUAL, 24);
  const pRedesp2 = Math.min(P_ACTUAL + 1, 24);

  const body = {
    planta_id: PLANTA_ID,
    fecha: HOY,
    filas: [
      {
        tipo: 'AUTH',
        hora: HORA_OK,
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
        hora: HORA_OK,
        detalle: `${TEST_TAG} prueba`,
        funcionariocnd: null,
        periodos: [{ periodo: 1, valor_mw: 50 }],
      },
      {
        tipo: 'REDESP',
        hora: HORA_OK,
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
  assert.equal(data.resumen?.lotes, 3, 'una fila con celdas = un lote');
  assert.equal(data.resumen?.registros, totalCeldas);

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
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} sinfunc`, funcionariocnd: null,
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
        tipo: 'REDESP', hora: HORA_OK, detalle: `${TEST_TAG} bloq`, funcionariocnd: null,
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
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG}`, funcionariocnd: 'X',
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
        tipo: 'PRUEBA', hora: HORA_OK, detalle: `${TEST_TAG} pforced`, funcionariocnd: 'IGNORADO',
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

test('6. D-056: un segundo Guardar sobre el mismo periodo AGREGA, no pisa [criterio 3]', async () => {
  // Reemplaza al viejo test de "re-save" (cambio + vaciado + alta): la máquina de 4 casos por celda
  // desapareció con el modelo append-only. Acá se fija la regla nueva: registrar nunca destruye lo
  // registrado antes, ni siquiera para la misma celda.
  await cleanMand();
  const horaTemprana = horaBogotaMin(-30) ?? '00:00';

  const primero = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: horaTemprana, detalle: `${TEST_TAG} llamada 1`, funcionariocnd: 'Pérez',
        periodos: [{ periodo: 3, valor_mw: 90 }, { periodo: 5, valor_mw: 100 }],
      }],
    },
  });
  assert.equal(primero.status, 200, JSON.stringify(primero.data));
  assert.equal(primero.data.resumen.registros, 2);

  // Segunda llamada del CND para el MISMO periodo 3, más tarde y con otro valor y funcionario.
  const segundo = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} llamada 2`, funcionariocnd: 'Gómez',
        periodos: [{ periodo: 3, valor_mw: 92 }],
      }],
    },
  });
  assert.equal(segundo.status, 200, JSON.stringify(segundo.data));
  assert.equal(segundo.data.resumen.registros, 1);

  const db = await getDB();
  const p3 = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT registro_id,
             TRY_CAST(JSON_VALUE(campos_extra,'$.valor_mw') AS FLOAT) AS valor,
             JSON_VALUE(campos_extra,'$.lote_id') AS lote_id,
             JSON_VALUE(campos_extra,'$.hora_llamada') AS hora
      FROM bitacora.registro_activo
      WHERE bitacora_id=@m AND planta_id=@p AND estado='borrador'
        AND TRY_CAST(JSON_VALUE(campos_extra,'$.periodo') AS INT) = 3
    `);
  assert.equal(p3.recordset.length, 2, 'los dos registros del periodo 3 coexisten');
  assert.deepEqual(p3.recordset.map((r) => r.valor).sort((a, b) => a - b), [90, 92]);
  assert.notEqual(p3.recordset[0].lote_id, p3.recordset[1].lote_id, 'cada Guardar es un lote distinto');

  // Y el dashboard publica UNA sola fila por celda: la del lote de mayor hora_llamada [criterio 11].
  const ev = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, HOY)
    .query(`
      SELECT periodo, valor_mw, activa, registro_origen_id FROM bitacora.evento_dashboard
      WHERE planta_id=@p AND fecha=@f AND tipo='AUTH'
      ORDER BY periodo
    `);
  assert.deepEqual(ev.recordset.map((r) => r.periodo), [3, 5], 'una fila publicada por celda, sin duplicar');
  assert.equal(ev.recordset[0].valor_mw, 92, 'P3 publica el valor de la llamada más reciente por hora');
  assert.equal(ev.recordset[1].valor_mw, 100);
  // El puntero apunta al registro de MAYOR hora_llamada, no al último insertado por casualidad.
  // Mismo orden que resuelve el servidor: hora DESC y, si empatan, registro_id DESC (el empate solo
  // ocurre corriendo la suite en el primer minuto del día Bogotá, donde ambas horas caen en 00:00).
  const ganador = [...p3.recordset].sort((a, b) => (
    a.hora === b.hora ? b.registro_id - a.registro_id : (a.hora < b.hora ? 1 : -1)
  ))[0];
  assert.equal(ev.recordset[0].registro_origen_id, ganador.registro_id,
    'registro_origen_id debe apuntar al registro de hora mayor');
});

// D-042: se eliminó el test del rechazo de cierre individual MAND — el cierre individual por
// bitácora ya no existe. MAND queda fuera del cierre de turno (masivo) por su exclusión
// `codigo NOT IN ('DISP','MAND')`, cubierta en cierre_y_fechas.test.js (A1).

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
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} cierre`, funcionariocnd: 'X',
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
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} ciet-fecha`, funcionariocnd: 'Y',
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-055 — Integridad de MAND. Regresiones de la auditoría de la discrepancia
// `registro_historico` (10 filas) vs `evento_dashboard` (45) en prod.
//
// Viven en ESTE archivo, no en uno propio, por una razón concreta: `setupSessions()` crea sesiones
// para los mismos usuarios-fixture y `select-context` mata cualquier OTRA sesión activa de esa
// persona (sesión única, D-035). Dos archivos que compartan la fixture de MAND se invalidan la
// sesión mutuamente (401 "Sesión no válida") apenas se solapan. Un solo archivo = un solo dueño de
// la fixture, y node:test corre sus tests en orden.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('D-055 1a. metadata en una fila SIN celdas → 400 lote_sin_celdas (nunca un 200 mentiroso) [criterio 9]', async () => {
  // D-056: la regla de D-055 se conserva, cambia el punto de validación — antes el motivo era
  // `detalle_sin_celdas` (no había ninguna celda donde anclar el comentario), ahora es
  // `lote_sin_celdas` (un lote sin ninguna celda con valor no existe como evento).
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', hora: HORA_OK, detalle: `${TEST_TAG} comentario sin valores`,
        funcionariocnd: null, periodos: [],
      }],
    },
  });
  assert.equal(status, 400, `esperado rechazo explícito, got ${status} ${JSON.stringify(data)}`);
  assert.ok(
    data.errores?.some((e) => e.tipo === 'PRUEBA' && e.motivo === 'lote_sin_celdas'),
    `esperado motivo lote_sin_celdas, got ${JSON.stringify(data.errores)}`,
  );

  const db = await getDB();
  const n = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE bitacora_id=@m AND planta_id=@p`);
  assert.equal(n.recordset[0].n, 0, 'un lote rechazado no deja rastro');
});

test('D-055 1c. REDESP: el lock protege el VALOR, nunca la hora ni el comentario', async () => {
  // RN-03.c. La llamada del CND pudo ocurrir hace media hora (hora PASADA) y el lote se registra
  // igual mientras su VALOR caiga en el periodo actual o posterior. El lock nunca mira la hora.
  await cleanMand();
  const horaPasada = horaBogotaMin(-45) ?? '00:00';
  const pLibre = Math.min(P_ACTUAL, 24);

  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'REDESP', hora: horaPasada, detalle: `${TEST_TAG} llamada de hace rato`,
        funcionariocnd: null, periodos: [{ periodo: pLibre, valor_mw: 99 }],
      }],
    },
  });
  assert.equal(status, 200, `una hora pasada no debe rebotar: ${JSON.stringify(data)}`);

  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT detalle,
             TRY_CAST(JSON_VALUE(campos_extra,'$.valor_mw') AS FLOAT) AS valor,
             JSON_VALUE(campos_extra,'$.hora_llamada') AS hora
      FROM bitacora.registro_activo
      WHERE bitacora_id=@m AND planta_id=@p AND estado='borrador'
    `);
  assert.equal(r.recordset.length, 1);
  assert.equal(r.recordset[0].detalle, `${TEST_TAG} llamada de hace rato`);
  assert.equal(r.recordset[0].valor, 99);
  assert.equal(r.recordset[0].hora, new Date(`${HOY}T${horaPasada}:00.000-05:00`).toISOString());
});

test('D-055 2. el INSERT de MAND estampa turno_id resolviendo por (planta, fecha_operativa, turno)', async () => {
  await cleanMand();
  const db = await getDB();
  const periodo = 12; // diurno → T1 del propio día, estable a cualquier hora del run
  const fop = fechaOperativaDePeriodo(HOY, periodo);
  const turno = turnoFromPeriodo(periodo);

  await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .input('cp', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t)
        INSERT INTO bitacora.turno_unidad
          (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal, creado_por)
        VALUES (@f, @p, @t, 'PROGRAMADO',
                DATEADD(HOUR, 11, CAST(@f AS DATETIME2)), DATEADD(HOUR, 23, CAST(@f AS DATETIME2)), @cp);
    `);
  const esperado = (await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .query(`SELECT turno_unidad_id FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`)
  ).recordset[0].turno_unidad_id;

  const { status } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} t`, funcionariocnd: 'Pérez',
        periodos: [{ periodo, valor_mw: 70 }],
      }],
    },
  });
  assert.equal(status, 200);

  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), PLANTA_ID)
    .query(`SELECT turno_id FROM bitacora.registro_activo WHERE bitacora_id=@m AND planta_id=@p AND estado='borrador'`);
  assert.equal(r.recordset[0].turno_id, esperado, 'turno_id debe apuntar a la cabecera del periodo');
});

test('D-055 3. la captura append-only no deja evento_dashboard huérfano (causa de las 35 filas de prod)', async () => {
  // D-056: vaciar una celda ya no borra nada (el envío del front omite las celdas sin valor), así
  // que el vector original desapareció. La INVARIANTE sigue siendo la misma y se mantiene fijada:
  // ninguna fila de evento_dashboard puede apuntar a un registro inexistente. Acá se ejerce con
  // dos lotes sobre la misma celda, que es lo que ahora mueve `registro_origen_id`.
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: horaBogotaMin(-30) ?? '00:00', detalle: `${TEST_TAG} h`,
        funcionariocnd: 'Pérez', periodos: [{ periodo: 10, valor_mw: 55 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const relevo = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} h2`, funcionariocnd: 'Pérez',
        periodos: [{ periodo: 10, valor_mw: 66 }],
      }],
    },
  });
  assert.equal(relevo.status, 200, JSON.stringify(relevo.data));

  const db = await getDB();
  const h = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`
      SELECT COUNT(*) AS n FROM bitacora.evento_dashboard ed
      WHERE ed.planta_id=@p
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_activo ra WHERE ra.registro_id=ed.registro_origen_id)
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_historico rh WHERE rh.registro_id=ed.registro_origen_id)
    `);
  assert.equal(h.recordset[0].n, 0, 'no debe quedar ninguna fila de evento_dashboard sin origen');
});

test('D-055 4. cerrarDiaMand archiva AUTH, PRUEBA y REDESP (no solo autorizaciones) preservando el detalle', async () => {
  await cleanMand();
  const db = await getDB();
  const sistema = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username='SISTEMA'`)).recordset[0]?.usuario_id;
  assert.ok(sistema, 'usuario SISTEMA debe existir');

  const pRedesp = Math.min(P_ACTUAL, 24);
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [
        { tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} a`, funcionariocnd: 'Pérez', periodos: [{ periodo: 11, valor_mw: 60 }] },
        { tipo: 'PRUEBA', hora: HORA_OK, detalle: `${TEST_TAG} p`, funcionariocnd: null, periodos: [{ periodo: 11, valor_mw: 61 }] },
        { tipo: 'REDESP', hora: HORA_OK, detalle: `${TEST_TAG} r`, funcionariocnd: null, periodos: [{ periodo: pRedesp, valor_mw: 62 }] },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const res = await cerrarDiaMand(db, { fecha: HOY, planta_id: PLANTA_ID, usuarioCierre: sistema });
  assert.equal(res.closed, true, JSON.stringify(res));

  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), PLANTA_ID)
    .query(`
      SELECT te.notificar_dashboard_tipo AS tipo, rh.detalle
      FROM bitacora.registro_historico rh
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = rh.tipo_evento_id
      WHERE rh.bitacora_id=@m AND rh.planta_id=@p
    `);
  const tipos = r.recordset.map((x) => x.tipo).sort();
  assert.deepEqual(tipos, ['AUTH', 'PRUEBA', 'REDESP'], 'los tres tipos deben llegar al histórico');
  // El detalle de PRUEBA/REDESP debe sobrevivir al archivado (el reporte original decía perderse).
  for (const row of r.recordset) {
    assert.ok(row.detalle?.startsWith(TEST_TAG), `${row.tipo} debe conservar su detalle, got ${row.detalle}`);
  }
  await cleanMand();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-056 · E1 — Migración F32.A1: respaldos residentes + lote_id en los registros MAND previos.
//
// La migración corre en initDB (disparada por getDB() en el before() de esta suite). Estos tests
// son SOLO LECTURA: NO hacen DML sobre registro_activo/registro_historico. Se acotan a plantas
// REALES (planta_id <> TEST_PLANTA) porque la población que F32.A1 migró es la que ya existía al
// arrancar el backend, no la que la propia corrida siembra en la fixture 'TST'. El scoping importa
// especialmente para E1.4: tras E3 un lote multi-celda comparte un solo `lote_id` entre varios
// registros, así que "un lote_id por registro" solo vale para los migrados, que son lotes de un
// único periodo por construcción (NEWID() por fila).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('D-056 E1.1 — migracion_aplicada tiene la fila F32.A1 tras initDB', async () => {
  const db = await getDB();
  const r = await db.request().query(
    `SELECT 1 AS x FROM bitacora.migracion_aplicada WHERE codigo = 'F32.A1'`
  );
  assert.equal(r.recordset.length, 1, 'F32.A1 debe estar marcada como aplicada');
});

test('D-056 E1.2 — existen los respaldos residentes registro_{historico,activo}_backup_D056', async () => {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT
      OBJECT_ID('bitacora.registro_historico_backup_D056','U') AS hist,
      OBJECT_ID('bitacora.registro_activo_backup_D056','U')   AS activo
  `);
  assert.ok(r.recordset[0].hist,   'registro_historico_backup_D056 debe existir');
  assert.ok(r.recordset[0].activo, 'registro_activo_backup_D056 debe existir');
});

test('D-056 E1.3 — ningún registro MAND (planta real) con campos_extra JSON quedó sin lote_id', async () => {
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM bitacora.registro_historico
          WHERE bitacora_id=@m AND planta_id<>@tst
            AND ISJSON(campos_extra)=1 AND JSON_VALUE(campos_extra,'$.lote_id') IS NULL) AS hist,
        (SELECT COUNT(*) FROM bitacora.registro_activo
          WHERE bitacora_id=@m AND planta_id<>@tst
            AND ISJSON(campos_extra)=1 AND JSON_VALUE(campos_extra,'$.lote_id') IS NULL) AS activo
    `);
  assert.equal(r.recordset[0].hist, 0, 'histórico MAND real sin lote_id debe ser 0');
  assert.equal(r.recordset[0].activo, 0, 'activo MAND real sin lote_id debe ser 0');
});

test('D-056 E1.4 — los lote_id asignados son distintos entre sí (un NEWID por fila)', async () => {
  // A la altura de E1 cada registro MAND previo es un lote de UN SOLO periodo: NEWID() se evalúa por
  // fila ⇒ count(*) == count(distinct lote_id). (E3 introduce lotes multi-celda que comparten
  // lote_id y reescribe este archivo, así que esta invariante es la correcta para el estado E1.)
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT JSON_VALUE(campos_extra,'$.lote_id')) AS distintos
      FROM (
        SELECT campos_extra FROM bitacora.registro_historico
          WHERE bitacora_id=@m AND planta_id<>@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
        UNION ALL
        SELECT campos_extra FROM bitacora.registro_activo
          WHERE bitacora_id=@m AND planta_id<>@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
      ) x
    `);
  const { total, distintos } = r.recordset[0];
  assert.equal(distintos, total, `esperado ${total} lote_id distintos, got ${distintos}`);
});

test('D-056 E1.5 — idempotencia: un segundo run reasignaría 0 filas y el lote_id conocido sobrevive', async () => {
  const db = await getDB();
  // (a) El predicado del UPDATE de la migración (JSON válido AND lote_id IS NULL) no matchea nada ⇒
  //     un re-run es un no-op y ningún GUID se reasigna. Prueba de idempotencia sin re-ejecutar
  //     initDB ni hacer DML (los tests de E1 no escriben las tablas protegidas).
  const pend = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT COUNT(*) AS n FROM (
        SELECT registro_id FROM bitacora.registro_historico
          WHERE bitacora_id=@m AND planta_id<>@tst AND ISJSON(campos_extra)=1
            AND JSON_VALUE(campos_extra,'$.lote_id') IS NULL
        UNION ALL
        SELECT registro_id FROM bitacora.registro_activo
          WHERE bitacora_id=@m AND planta_id<>@tst AND ISJSON(campos_extra)=1
            AND JSON_VALUE(campos_extra,'$.lote_id') IS NULL
      ) x
    `);
  assert.equal(pend.recordset[0].n, 0, 'un segundo run del UPDATE reasignaría 0 filas');

  // (b) Un lote_id conocido (si hay data real) es un GUID de 36 chars — sanity del CONVERT(NEWID()).
  const uno = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT TOP 1 JSON_VALUE(campos_extra,'$.lote_id') AS lote_id
      FROM bitacora.registro_historico
      WHERE bitacora_id=@m AND planta_id<>@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
      ORDER BY registro_id
    `);
  const lote = uno.recordset[0]?.lote_id;
  if (lote) {
    assert.match(
      lote,
      /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
      `lote_id debe ser un GUID de 36 chars, got ${lote}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-056 · E2 — recalcularEventoDashboard: resolución de lo publicado POR CELDA.
//
// Se ejercita la función DIRECTAMENTE (sin pasar por HTTP): en esta rama ningún caller la invoca
// todavía (E3 conecta el guardar append-only; la rama de "retroceder al anterior al borrar" no tiene
// caller real hasta D-057). Una rama sin test que la ejercite es código muerto que diverge, así que
// los criterios 11 y 12 del REQ-03 se validan acá con transacción propia sobre TEST_PLANTA.
//
// Fixtures: se siembran registros MAND directo en registro_activo (INSERT no destructivo, sobre la
// planta-fixture) con hora_llamada compuesta como ISO UTC (toISOString), igual que hará el server en
// E3. Los borrados de fixture van por `registro_id = @id` (acotador de PK,
// guard_no_prod_historico_destruction) y la limpieza final es el cleanMand() del archivo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// tipo_evento_id MAND para un notificar_dashboard_tipo (AUTH/PRUEBA/REDESP).
async function tipoEventoIdMand(tipo) {
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('t', sql.VarChar(10), tipo)
    .query(`SELECT tipo_evento_id FROM lov_bit.tipo_evento WHERE bitacora_id=@m AND notificar_dashboard_tipo=@t`);
  return r.recordset[0].tipo_evento_id;
}

// Siembra un registro MAND vivo (borrador) en TEST_PLANTA y devuelve su registro_id. `hora` es
// 'HH:mm' Bogotá → se compone hora_llamada como ISO UTC; si es null/undefined la CLAVE queda AUSENTE
// (no null), como los registros migrados por F32.A1. `fecha_evento` se fija a mediodía Bogotá de HOY
// para que el día Bogotá sea determinista a cualquier hora del run.
async function seedRegistroMand({ tipo, periodo, hora, valor, jdts = '[]', jefes = '[]' }) {
  const db = await getDB();
  const teId = await tipoEventoIdMand(tipo);
  const campos = { periodo, valor_mw: valor };
  if (hora) campos.hora_llamada = new Date(`${HOY}T${hora}:00-05:00`).toISOString();
  const ins = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('fe', sql.DateTime2, new Date(`${HOY}T12:00:00-05:00`))
    .input('turno', sql.TinyInt, turnoFromPeriodo(periodo))
    .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} e2`)
    .input('ce', sql.NVarChar(sql.MAX), JSON.stringify(campos))
    .input('te', sql.Int, teId)
    .input('ing', sql.NVarChar(sql.MAX), '[]')
    .input('jdts', sql.NVarChar(sql.MAX), jdts)
    .input('jefes', sql.NVarChar(sql.MAX), jefes)
    .input('cp', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      OUTPUT INSERTED.registro_id
      VALUES (@mand, @p, @fe, @turno, @detalle, @ce, @te,
              'borrador', @ing, @jdts, @jefes, @cp)
    `);
  return ins.recordset[0].registro_id;
}

// Borra un fixture puntual por su PK (acotador de fixture: WHERE registro_id = @id). Simula lo que
// hará D-057 al borrar un registro; acá sirve para ejercer la rama de retroceso/eliminación.
async function borrarRegistro(registro_id) {
  const db = await getDB();
  await db.request()
    .input('id', sql.Int, registro_id)
    .query(`DELETE FROM bitacora.registro_activo WHERE registro_id = @id`);
}

// Corre recalcularEventoDashboard en su propia transacción (patrón canónico del subrepo).
async function recalc({ periodo, tipo, planta_id = PLANTA_ID, fecha = HOY }) {
  const db = await getDB();
  const t = new sql.Transaction(db);
  await t.begin();
  try {
    const r = await recalcularEventoDashboard(t, { planta_id, fecha, periodo, tipo });
    await t.commit();
    return r;
  } catch (e) {
    try { await t.rollback(); } catch {}
    throw e;
  }
}

// Lee la fila publicada de una celda (o null).
async function getEvento({ periodo, tipo }) {
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, HOY)
    .input('per', sql.TinyInt, periodo)
    .input('t', sql.VarChar(10), tipo)
    .query(`
      SELECT registro_origen_id, valor_mw, activa, jdts_snapshot, jefes_snapshot
      FROM bitacora.evento_dashboard
      WHERE planta_id=@p AND fecha=@f AND periodo=@per AND tipo=@t
    `);
  return r.recordset[0] || null;
}

test('D-056 E2.1 — un registro AUTH → recalc INSERTA la fila y publica su valor y snapshots', async () => {
  await cleanMand();
  const rid = await seedRegistroMand({
    tipo: 'AUTH', periodo: 14, hora: '09:12', valor: 150,
    jdts: '[{"usuario_id":1}]', jefes: '[{"usuario_id":2}]',
  });
  const r = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r.accion, 'insertado', JSON.stringify(r));
  assert.equal(r.registro_origen_id, rid);

  const ev = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.ok(ev, 'debe existir la fila publicada');
  assert.equal(ev.registro_origen_id, rid);
  assert.equal(ev.valor_mw, 150);
  assert.equal(ev.activa, true);
  // Snapshots tomados del PROPIO registro ganador (columnas de registro_activo).
  assert.equal(ev.jdts_snapshot, '[{"usuario_id":1}]');
  assert.equal(ev.jefes_snapshot, '[{"usuario_id":2}]');
});

test('D-056 E2.2 — dos registros mismo periodo: gana la mayor hora_llamada (09:40 > 09:12) [criterio 11]', async () => {
  await cleanMand();
  const early = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:12', valor: 100 });
  const late = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:40', valor: 200 });
  assert.ok(late > early, 'el segundo insertado tiene registro_id mayor');

  const r = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r.registro_origen_id, late, 'debe publicar el de 09:40');

  const ev = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.equal(ev.registro_origen_id, late);
  assert.equal(ev.valor_mw, 200);
});

test('D-056 E2.3 — al borrar el ganador recalc RETROCEDE al anterior; sin registros BORRA la fila [criterio 12]', async () => {
  await cleanMand();
  const early = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:12', valor: 100 });
  const late = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:40', valor: 200 });
  await recalc({ periodo: 14, tipo: 'AUTH' }); // publica late

  // Borro el ganador (lo que hará D-057). Recalc → retrocede a early.
  await borrarRegistro(late);
  const r2 = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r2.accion, 'actualizado', JSON.stringify(r2));
  assert.equal(r2.registro_origen_id, early);
  const ev2 = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.equal(ev2.registro_origen_id, early);
  assert.equal(ev2.valor_mw, 100);

  // Borro el último. Recalc → la fila de evento_dashboard DESAPARECE (RQ-03.23), no queda activa=0.
  await borrarRegistro(early);
  const r3 = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r3.accion, 'eliminado', JSON.stringify(r3));
  const ev3 = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.equal(ev3, null, 'sin registros vivos la celda no debe seguir publicada');
});

test('D-056 E2.4 — solape PARCIAL de lotes: la decisión es por celda, no por lote', async () => {
  await cleanMand();
  // Lote A (09:12) cubre P14 y P15. Lote B (09:40) cubre P15 y P16. El periodo compartido es P15.
  const a14 = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:12', valor: 114 });
  await seedRegistroMand({ tipo: 'AUTH', periodo: 15, hora: '09:12', valor: 115 }); // a15 (perdedor en P15)
  const b15 = await seedRegistroMand({ tipo: 'AUTH', periodo: 15, hora: '09:40', valor: 215 });
  const b16 = await seedRegistroMand({ tipo: 'AUTH', periodo: 16, hora: '09:40', valor: 216 });

  await recalc({ periodo: 14, tipo: 'AUTH' });
  await recalc({ periodo: 15, tipo: 'AUTH' });
  await recalc({ periodo: 16, tipo: 'AUTH' });

  assert.equal((await getEvento({ periodo: 14, tipo: 'AUTH' })).registro_origen_id, a14, 'P14 solo lo cubre A');
  assert.equal((await getEvento({ periodo: 15, tipo: 'AUTH' })).registro_origen_id, b15, 'P15 (compartido) lo publica B, 09:40 > 09:12');
  assert.equal((await getEvento({ periodo: 16, tipo: 'AUTH' })).registro_origen_id, b16, 'P16 solo lo cubre B');
});

test('D-056 E2.5 — registro SIN hora_llamada nunca gana por hora, aunque se cree después', async () => {
  await cleanMand();
  const conHora = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:12', valor: 100 });
  // El SIN hora se inserta DESPUÉS (registro_id mayor): si el NULL no fuera al final ganaría por
  // creado_en/registro_id. Debe perder igual.
  const sinHora = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: null, valor: 999 });
  assert.ok(sinHora > conHora, 'el sin-hora es el más nuevo');

  const r = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r.registro_origen_id, conHora, 'gana el que tiene hora aunque sea el más viejo');
  const ev = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.equal(ev.valor_mw, 100);
});

test('D-056 E2.6 — con la misma hora_llamada desempata el registro_id mayor (más nuevo)', async () => {
  await cleanMand();
  await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:30', valor: 100 }); // primero
  const segundo = await seedRegistroMand({ tipo: 'AUTH', periodo: 14, hora: '09:30', valor: 200 });

  const r = await recalc({ periodo: 14, tipo: 'AUTH' });
  assert.equal(r.registro_origen_id, segundo, 'con hora empatada gana el más nuevo');
  const ev = await getEvento({ periodo: 14, tipo: 'AUTH' });
  assert.equal(ev.valor_mw, 200);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-056 · E3 — POST /guardar append-only: lotes, hora de la llamada, sin edición.
//
// Los tests del modelo viejo que asumían "un registro por celda, el segundo Guardar lo pisa" se
// reescribieron arriba (1, 6, D-055 1a/1c/3): la máquina de 4 casos por celda desapareció. Acá van
// los criterios de aceptación del REQ-03 que solo existen con el modelo nuevo.
//
// Todo corre sobre TEST_PLANTA con TEST_TAG; el `hora` de cada lote se calcula relativo al reloj
// del run (horaBogotaMin) porque el servidor valida contra SU propio reloj, no contra el del test.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Lee los registros MAND vivos de la fixture con su metadata de lote desempaquetada.
async function registrosMand() {
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT ra.registro_id, ra.detalle, ra.turno_id,
             te.notificar_dashboard_tipo AS tipo,
             TRY_CAST(JSON_VALUE(ra.campos_extra,'$.periodo') AS INT)   AS periodo,
             TRY_CAST(JSON_VALUE(ra.campos_extra,'$.valor_mw') AS FLOAT) AS valor_mw,
             JSON_VALUE(ra.campos_extra,'$.funcionariocnd') AS funcionariocnd,
             JSON_VALUE(ra.campos_extra,'$.lote_id')        AS lote_id,
             JSON_VALUE(ra.campos_extra,'$.hora_llamada')   AS hora_llamada
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.bitacora_id=@m AND ra.planta_id=@p AND ra.estado='borrador'
      ORDER BY ra.registro_id
    `);
  return r.recordset;
}

test('D-056 E3.1 — un lote de P14..P18 crea 5 registros con el MISMO lote_id y la misma metadata [criterio 2]', async () => {
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} rango`,
        periodos: [14, 15, 16, 17, 18].map((periodo) => ({ periodo, valor_mw: 150 })),
      }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(data.resumen, { lotes: 1, registros: 5 });

  const filas = await registrosMand();
  assert.equal(filas.length, 5);
  assert.deepEqual(filas.map((f) => f.periodo), [14, 15, 16, 17, 18]);
  assert.equal(new Set(filas.map((f) => f.lote_id)).size, 1, 'las 5 celdas comparten un solo lote_id');
  assert.match(
    filas[0].lote_id,
    /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
    'lote_id debe ser un GUID',
  );
  const horaEsperada = new Date(`${HOY}T${HORA_OK}:00.000-05:00`).toISOString();
  for (const f of filas) {
    assert.equal(f.hora_llamada, horaEsperada);
    assert.equal(f.funcionariocnd, 'J. Pérez');
    assert.equal(f.detalle, `${TEST_TAG} rango`);
    assert.equal(f.valor_mw, 150);
  }
});

test('D-056 E3.2 — lote sin hora → 400 hora_requerida, y el error NO lleva periodo [criterio 6]', async () => {
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} sin hora`,
        periodos: [{ periodo: 14, valor_mw: 150 }],
      }],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  const err = data.errores?.find((e) => e.motivo === 'hora_requerida');
  assert.ok(err, `esperado hora_requerida, got ${JSON.stringify(data.errores)}`);
  assert.equal(err.tipo, 'AUTH');
  assert.equal(err.periodo, undefined, 'la hora es del LOTE: el error viaja sin periodo');

  const filas = await registrosMand();
  assert.equal(filas.length, 0, 'nada se escribió');
});

test('D-056 E3.3 — hora con formato inválido → hora_invalida; hora futura más allá de la tolerancia → hora_futura', async () => {
  await cleanMand();
  const invalida = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', hora: '25:99', detalle: `${TEST_TAG} mala hora`, funcionariocnd: null,
        periodos: [{ periodo: 14, valor_mw: 10 }],
      }],
    },
  });
  assert.equal(invalida.status, 400, JSON.stringify(invalida.data));
  assert.ok(invalida.data.errores?.some((e) => e.motivo === 'hora_invalida'), JSON.stringify(invalida.data.errores));

  // +30 min supera holgadamente la tolerancia de 5 min contra el reloj del SERVIDOR.
  const futura = horaBogotaMin(30);
  if (futura == null) return; // últimos 30 min del día Bogotá: el desplazamiento saldría de la grilla
  const res = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', hora: futura, detalle: `${TEST_TAG} hora futura`, funcionariocnd: null,
        periodos: [{ periodo: 14, valor_mw: 10 }],
      }],
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.data));
  assert.ok(res.data.errores?.some((e) => e.motivo === 'hora_futura'), JSON.stringify(res.data.errores));

  const filas = await registrosMand();
  assert.equal(filas.length, 0, 'ningún lote con hora inválida se escribió');
});

test('D-056 E3.4 — REDESP con valor en periodo pasado → periodo_bloqueado y nada se escribe [criterio 7]', async () => {
  if (P_ACTUAL <= 1) return; // sin periodo bloqueable a esta hora
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'REDESP', hora: HORA_OK, detalle: `${TEST_TAG} redesp tarde`, funcionariocnd: null,
        periodos: [{ periodo: P_ACTUAL - 1, valor_mw: 120 }, { periodo: Math.min(P_ACTUAL, 24), valor_mw: 130 }],
      }],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  const err = data.errores?.find((e) => e.motivo === 'periodo_bloqueado');
  assert.ok(err, JSON.stringify(data.errores));
  assert.equal(err.periodo, P_ACTUAL - 1, 'el error de celda SÍ lleva periodo');

  const filas = await registrosMand();
  assert.equal(filas.length, 0, 'el lote entero se rechaza, incluida la celda válida (RN-03.b)');
});

test('D-056 E3.5 — REDESP guarda funcionariocnd = null aunque el cliente lo mande [criterio 8]', async () => {
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'REDESP', hora: HORA_OK, detalle: `${TEST_TAG} redesp func`, funcionariocnd: 'IGNORADO',
        periodos: [{ periodo: Math.min(P_ACTUAL, 24), valor_mw: 140 }],
      }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  const filas = await registrosMand();
  assert.equal(filas.length, 1);
  assert.equal(filas[0].funcionariocnd, null, 'REDESP fuerza funcionariocnd a NULL (RQ-03.16)');
});

test('D-056 E3.6 — un error en UNA fila impide escribir las demás [criterio 10]', async () => {
  await cleanMand();
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [
        // Fila válida…
        {
          tipo: 'PRUEBA', hora: HORA_OK, detalle: `${TEST_TAG} valida`, funcionariocnd: null,
          periodos: [{ periodo: 20, valor_mw: 70 }],
        },
        // …y fila inválida (AUTH sin funcionario): el Guardar completo se rechaza.
        {
          tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} invalida`, funcionariocnd: null,
          periodos: [{ periodo: 21, valor_mw: 80 }],
        },
      ],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(data.errores?.some((e) => e.tipo === 'AUTH' && e.motivo === 'funcionariocnd_requerido'));

  const filas = await registrosMand();
  assert.equal(filas.length, 0, 'la fila válida tampoco se escribió (atomicidad, RN-03.b)');
});

test('D-056 E3.7 — el periodo 3 de la grilla del día F queda atado al T2 iniciado en F-1 [criterio 13]', async () => {
  await cleanMand();
  const db = await getDB();
  const periodo = 3;
  const fop = fechaOperativaDePeriodo(HOY, periodo); // = HOY - 1 día
  const turno = turnoFromPeriodo(periodo);           // = 2
  assert.notEqual(fop, HOY, 'la madrugada pertenece al turno que arrancó el día anterior');

  // La cabecera de un turno PASADO no existe necesariamente en la fixture. Si la sembramos nosotros,
  // la retiramos al final: una fila PROGRAMADO residente en 'TST' es sucesora candidata de cualquier
  // `cerrarTurno` posterior (activarSucesor toma el PROGRAMADO más antiguo) y contaminaría a las
  // suites que corren después.
  const yaExistia = (await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .query(`SELECT turno_unidad_id FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`)
  ).recordset[0] || null;

  if (!yaExistia) {
    await db.request()
      .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
      .input('cp', sql.Int, ctx.usuarios.jdt.usuario_id)
      .query(`
        INSERT INTO bitacora.turno_unidad
          (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal, creado_por)
        VALUES (@f, @p, @t, 'PROGRAMADO',
                DATEADD(HOUR, 23, CAST(@f AS DATETIME2)), DATEADD(HOUR, 35, CAST(@f AS DATETIME2)), @cp);
      `);
  }
  const esperado = (await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .query(`SELECT turno_unidad_id FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`)
  ).recordset[0].turno_unidad_id;

  try {
    const { status, data } = await postGuardar({
      sesion_id: ctx.sesiones.jdt,
      body: {
        planta_id: PLANTA_ID,
        fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} madrugada`,
          periodos: [{ periodo, valor_mw: 75 }],
        }],
      },
    });
    assert.equal(status, 200, JSON.stringify(data));

    const filas = await registrosMand();
    assert.equal(filas.length, 1);
    assert.equal(filas[0].turno_id, esperado, 'turno_id debe apuntar al T2 del día anterior, no al del día de la grilla');
  } finally {
    if (!yaExistia) {
      // Primero los registros que la referencian por `turno_id` (FK), con el borrado acotado a la
      // fixture que ya hace cleanMand(); después la cabecera sembrada, por su PK.
      await cleanMand();
      await db.request()
        .input('id', sql.Int, esperado)
        .query(`DELETE FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
    }
  }
});

test('D-056 E3.8 — con el turno finalizado y la cabecera CERRADA se registra igual [criterio 14]', async () => {
  await cleanMand();
  const db = await getDB();
  // Periodo del turno que NO está corriendo ahora: así la cabecera que cerramos no es la vigente y
  // no contamina a las suites posteriores que escriben en TEST_PLANTA por la rama genérica.
  const periodo = (P_ACTUAL >= 7 && P_ACTUAL <= 18) ? 3 : 12;
  const fop = fechaOperativaDePeriodo(HOY, periodo);
  const turno = turnoFromPeriodo(periodo);

  const previo = (await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .query(`SELECT turno_unidad_id, estado FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`)
  ).recordset[0] || null;

  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
    .input('cp', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      IF EXISTS (SELECT 1 FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t)
        UPDATE bitacora.turno_unidad
          SET estado='CERRADO', motivo_cierre='MANUAL', cerrado_por=@cp, cerrado_en=SYSUTCDATETIME()
          WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t;
      ELSE
        INSERT INTO bitacora.turno_unidad
          (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal,
           motivo_cierre, cerrado_por, cerrado_en, creado_por)
        VALUES (@f, @p, @t, 'CERRADO',
                DATEADD(HOUR, 11, CAST(@f AS DATETIME2)), DATEADD(HOUR, 23, CAST(@f AS DATETIME2)),
                'MANUAL', @cp, SYSUTCDATETIME(), @cp);
    `);
  // Finalización de turno VIGENTE en la sesión que va a escribir (D-040).
  await db.request()
    .input('sid', sql.Int, ctx.sesiones.jdt)
    .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en = SYSUTCDATETIME() WHERE sesion_id = @sid`);

  try {
    const { status, data } = await postGuardar({
      sesion_id: ctx.sesiones.jdt,
      body: {
        planta_id: PLANTA_ID,
        fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} exencion`,
          periodos: [{ periodo, valor_mw: 88 }],
        }],
      },
    });
    assert.equal(status, 200, `MAND está exenta del turno (RQ-03.18): ${JSON.stringify(data)}`);
    assert.notEqual(data.codigo, 'turno_finalizado');
    assert.notEqual(data.codigo, 'turno_cerrado');
    assert.equal(data.resumen.registros, 1);
  } finally {
    await db.request()
      .input('sid', sql.Int, ctx.sesiones.jdt)
      .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en = NULL WHERE sesion_id = @sid`);
    // Restaurar la cabecera al estado en que estaba (o retirarla si la creamos nosotros).
    if (previo) {
      await db.request()
        .input('id', sql.Int, previo.turno_unidad_id).input('e', sql.VarChar(12), previo.estado)
        .query(`
          UPDATE bitacora.turno_unidad
            SET estado=@e, motivo_cierre=NULL, cerrado_por=NULL, cerrado_en=NULL
            WHERE turno_unidad_id=@id
        `);
    } else {
      // La cabecera la creamos nosotros: primero se van los registros que la referencian por FK
      // (cleanMand, acotado a la fixture) y después ella.
      await cleanMand();
      await db.request()
        .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, fop).input('t', sql.TinyInt, turno)
        .query(`DELETE FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`);
    }
  }
});

test('D-056 E3.9 — guard de coherencia: todo lote_id escrito tiene UNA sola hora, funcionario y descripción', async () => {
  // La metadata del lote se REPLICA en cada celda (patrón vigente de MAND) y ningún constraint la
  // mantiene coherente. Este guard es la red que va a hacer falta cuando D-057 introduzca la
  // edición por lote: si una corrección toca unas celdas y no otras, acá se nota.
  await cleanMand();
  const pRedesp = Math.min(P_ACTUAL, 24);
  const { status, data } = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} coh-auth`,
          periodos: [{ periodo: 20, valor_mw: 10 }, { periodo: 21, valor_mw: 11 }, { periodo: 22, valor_mw: 12 }],
        },
        {
          tipo: 'PRUEBA', hora: horaBogotaMin(-10) ?? '00:00', funcionariocnd: null,
          detalle: `${TEST_TAG} coh-prueba`,
          periodos: [{ periodo: 20, valor_mw: 20 }, { periodo: 21, valor_mw: 21 }],
        },
        {
          tipo: 'REDESP', hora: horaBogotaMin(-5) ?? '00:00', funcionariocnd: null, detalle: null,
          periodos: [{ periodo: pRedesp, valor_mw: 30 }],
        },
      ],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.resumen.lotes, 3);

  const filas = await registrosMand();
  const porLote = new Map();
  for (const f of filas) {
    if (!porLote.has(f.lote_id)) porLote.set(f.lote_id, []);
    porLote.get(f.lote_id).push(f);
  }
  assert.equal(porLote.size, 3, 'tres filas del mismo Guardar = tres lotes distintos');
  for (const [lote_id, celdas] of porLote) {
    for (const campo of ['hora_llamada', 'funcionariocnd', 'detalle']) {
      const distintos = new Set(celdas.map((c) => c[campo]));
      assert.equal(distintos.size, 1, `lote ${lote_id}: ${campo} debe ser idéntico en sus ${celdas.length} celdas`);
    }
    // Un lote nunca mezcla tipos ni repite periodo.
    assert.equal(new Set(celdas.map((c) => c.tipo)).size, 1);
    assert.equal(new Set(celdas.map((c) => c.periodo)).size, celdas.length);
  }
});

test('D-056 E3.10 — cerrarDiaMand arrastra lote_id y hora_llamada al histórico y sigue soft-deleteando el publicado', async () => {
  await cleanMand();
  const db = await getDB();
  const sistema = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username='SISTEMA'`)).recordset[0]?.usuario_id;
  assert.ok(sistema, 'usuario SISTEMA debe existir');

  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} cierre-lote`,
        periodos: [{ periodo: 13, valor_mw: 65 }, { periodo: 14, valor_mw: 66 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const loteEsperado = (await registrosMand())[0].lote_id;
  const horaEsperada = new Date(`${HOY}T${HORA_OK}:00.000-05:00`).toISOString();

  const res = await cerrarDiaMand(db, { fecha: HOY, planta_id: PLANTA_ID, usuarioCierre: sistema });
  assert.equal(res.closed, true, JSON.stringify(res));

  const hist = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT JSON_VALUE(campos_extra,'$.lote_id') AS lote_id,
             JSON_VALUE(campos_extra,'$.hora_llamada') AS hora_llamada
      FROM bitacora.registro_historico
      WHERE bitacora_id=@m AND planta_id=@p
    `);
  assert.equal(hist.recordset.length, 2, 'las 2 celdas del lote llegaron al histórico');
  for (const row of hist.recordset) {
    assert.equal(row.lote_id, loteEsperado, 'lote_id viaja dentro de campos_extra');
    assert.equal(row.hora_llamada, horaEsperada, 'hora_llamada viaja dentro de campos_extra');
  }

  // El cierre diario conserva su SOFT-delete (activa=0): el origen no desapareció, migró al
  // histórico y el puntero sigue resolviendo. El DELETE de D-056 es solo para el otro caso.
  const ev = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, HOY)
    .query(`SELECT periodo, activa FROM bitacora.evento_dashboard WHERE planta_id=@p AND fecha=@f AND tipo='AUTH'`);
  assert.equal(ev.recordset.length, 2, 'las filas publicadas siguen existiendo tras el cierre');
  for (const row of ev.recordset) assert.equal(row.activa, false, 'quedan desactivadas, no borradas');

  // El CIET del cierre no lleva TEST_TAG en detalle (registrarCierreMand lo deja NULL): se borra
  // por PK para no acumular leftover entre corridas.
  const ciet = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT TOP 1 ra.registro_id
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE b.codigo='CIET' AND ra.planta_id=@p
        AND JSON_VALUE(ra.campos_extra,'$.motivo')='mand-sweeper-diario'
      ORDER BY ra.registro_id DESC
    `);
  if (ciet.recordset[0]) {
    await db.request()
      .input('rid', sql.Int, ciet.recordset[0].registro_id)
      .query(`DELETE FROM bitacora.registro_activo WHERE registro_id = @rid`);
  }
  await cleanMand();
});
