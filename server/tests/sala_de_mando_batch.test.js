import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { getDB } from '../db.js';
import { cerrarDiaMand } from '../utils/mand-sweeper.js';
import { fechaOperativaDePeriodo, turnoFromPeriodo } from '../utils/turno.js';
import { recalcularEventoDashboard } from '../utils/notificador.js';
import { crearReflejoLote, actualizarReflejoLote } from '../utils/reflejo-sala.js';
import { resolverOAbrirTurnoAbierto } from '../utils/turno-entidad.js';
import { leerZip } from '../utils/xlsx.js';
import {
  setupSessions, cleanupTestRegistros, call, callBinario, TEST_PLANTA, TEST_TAG,
  TEST_PLANTA_REFLEJO, setupSesionReflejo,
} from './helpers.js';

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

// D-057 (E1): un periodo REDESP LIBRE del lock, evaluado AL CORRER el test y con una hora de margen.
// El patrón anterior — `Math.min(P_ACTUAL, 24)` — caía JUSTO sobre el umbral (`p < periodoActual`) y
// además usaba el `P_ACTUAL` congelado al cargar el módulo. Cualquier corrida que cruce una hora en
// punto (inevitable: la suite completa dura ~25 min) deja al servidor recalculando `periodoActual`
// mientras el test sigue pidiendo el periodo viejo → `periodo_bloqueado` espurio. Pasó de verdad: 4
// tests rojos al cruzar las 12:00 Bogotá, todos con `{periodo: 12, motivo: 'periodo_bloqueado'}`.
// Los tests que ejercitan el lock a propósito siguen usando `P_ACTUAL - 1`: ahí quedarse corto en el
// tiempo solo hace el periodo MÁS pasado, así que la staleness es inofensiva.
function periodoRedespLibre() {
  return Math.min(periodoActual() + 1, 24);
}

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
  // D-058 E4: la segunda planta-fixture (la que SÍ refleja) tiene su propia limpieza — sus filas
  // viven en MAND *y* en las dos bitácoras de Sala, así que `cleanMand` no las alcanza.
  await cleanReflejo();
  await cleanupTestRegistros();
});

test('1. POST guardar — 3 filas con hora → 200 { lotes: 3, registros: N }', async () => {
  await cleanMand();
  // Elegimos periodos REDESP libres del lock (variables según la hora del run).
  const pRedesp1 = periodoRedespLibre();
  const pRedesp2 = Math.min(pRedesp1 + 1, 24);

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

test('9. T1 regression — registro con fecha_evento UTC del día siguiente (22:30 Bogotá HOY) aparece en el listado del día Bogotá', async () => {
  // F19.A: la lectura del día MAND antes filtraba con CAST(fecha_evento AS DATE) = @fecha
  // (UTC), por lo que entre 19:00 y 23:59 Bogotá los recién insertados (cuyo fecha_evento
  // ya pertenecía al día UTC siguiente) quedaban fuera → pantalla vacía. La query usa
  // CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE). Este test inserta explícitamente un
  // registro con fecha_evento = HOY 22:30 Bogotá (= MAÑANA 03:30 UTC) y verifica que el día
  // Bogotá actual lo incluye, sin importar la hora del run.
  // D-056 E5: el pivote GET /api/sala-de-mando se dio de baja con la grilla-espejo; la
  // regresión se ejerce ahora contra GET /lotes, que hereda el mismo acotador de día.
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
    // `lote_id` es lo que agrupa el listado (D-056): un registro sin él no tendría dónde caer.
    .input('campos_extra', sql.NVarChar(sql.MAX), JSON.stringify({
      periodo: 23, valor_mw: 87.5, funcionariocnd: 'Madrugador', lote_id: '9c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
    }))
    .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} t1-regression`)
    .input('creado_por', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      VALUES (@mand, @p, @fecha_evento, 2, @detalle, @campos_extra, @te,
              'borrador', '[]', '[]', '[]', @creado_por)
    `);

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt, fecha: HOY });
  assert.equal(status, 200, JSON.stringify(data));
  const lote = data.lotes.find((l) => l.tipo === 'AUTH');
  assert.ok(lote, `el listado del día debe incluir el registro de las 22:30 — bug T1 reaparecido si falta. lotes=${JSON.stringify(data.lotes)}`);
  const celda = lote.periodos.find((p) => p.periodo === 23);
  assert.ok(celda, `el lote debe traer P23. periodos=${JSON.stringify(lote.periodos)}`);
  assert.equal(celda.valor_mw, 87.5);
});

test('9b. D-056 E5 — el pivote GET /api/sala-de-mando ya no existe (404)', async () => {
  // La grilla dejó de ser un espejo: no hay "un valor por celda" que devolver. Si alguien lo
  // reintrodujera, volvería a existir una lectura que colapsa varios lotes de la misma celda en uno.
  const { status } = await call('GET', `/api/sala-de-mando?planta_id=${PLANTA_ID}&fecha=${HOY}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 404, 'el pivote se dio de baja en E5');
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
  const pLibre = periodoRedespLibre();

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

  const pRedesp = periodoRedespLibre();
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

test('D-056 E1.4 — los lote_id que asignó F32.A1 son distintos entre sí (un NEWID por fila)', async () => {
  // La migración convirtió cada registro MAND preexistente en un lote de UN SOLO periodo: NEWID() se
  // evalúa por fila ⇒ count(*) == count(distinct lote_id) SOBRE LO QUE ELLA TOCÓ.
  //
  // D-057 (E1): el filtro `hora_llamada IS NULL` NO es cosmético — sin él la invariante es falsa en
  // cuanto un operador real usa la captura de D-056, porque un lote multi-celda comparte lote_id
  // ENTRE SUS FILAS a propósito. Se cayó apenas GEC3 registró sus primeros lotes de 8, 6 y 5
  // periodos (26 filas / 10 lotes). La marca que separa un universo del otro ya está documentada en
  // D-056: los migrados NO tienen la clave `hora_llamada`, y la captura la exige siempre.
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT JSON_VALUE(campos_extra,'$.lote_id')) AS distintos
      FROM (
        SELECT campos_extra FROM bitacora.registro_historico
          WHERE bitacora_id=@m AND planta_id<>@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
            AND JSON_VALUE(campos_extra,'$.hora_llamada') IS NULL
        UNION ALL
        SELECT campos_extra FROM bitacora.registro_activo
          WHERE bitacora_id=@m AND planta_id<>@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
            AND JSON_VALUE(campos_extra,'$.hora_llamada') IS NULL
      ) x
    `);
  const { total, distintos } = r.recordset[0];
  assert.equal(distintos, total, `esperado ${total} lote_id distintos, got ${distintos}`);
});

test('D-056 E1.4b — un lote multi-celda comparte lote_id entre sus filas (contracara de E1.4)', async () => {
  // Fija la otra mitad de la invariante, que es la que E1.4 no puede afirmar: dentro de un lote
  // capturado por D-056 el lote_id SE REPITE, y lo que no se repite es el periodo. Sin este test,
  // "arreglar" E1.4 quitándole el filtro volvería a pasar sin que nadie lo note.
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e1-4b`,
        periodos: [{ periodo: 21, valor_mw: 21 }, { periodo: 22, valor_mw: 22 }, { periodo: 23, valor_mw: 23 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('tst', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT JSON_VALUE(campos_extra,'$.lote_id')) AS lotes,
             COUNT(DISTINCT JSON_VALUE(campos_extra,'$.periodo')) AS periodos
      FROM bitacora.registro_activo
      WHERE bitacora_id=@m AND planta_id=@tst AND JSON_VALUE(campos_extra,'$.lote_id') IS NOT NULL
    `);
  assert.deepEqual(
    { total: r.recordset[0].total, lotes: r.recordset[0].lotes, periodos: r.recordset[0].periodos },
    { total: 3, lotes: 1, periodos: 3 },
  );
  await cleanMand();
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
//
// D-057 (E3): `detalle` y `funcionariocnd` son opcionales para poder sembrar un LOTE completo con su
// metadata — la vía por HTTP no sirve para los casos de REDESP en periodo PASADO, que el `POST
// /guardar` rechaza por diseño y que la corrección necesita como estado inicial.
async function seedRegistroMand({
  tipo, periodo, hora, valor, lote_id, jdts = '[]', jefes = '[]',
  detalle = `${TEST_TAG} e2`, funcionariocnd,
}) {
  const db = await getDB();
  const teId = await tipoEventoIdMand(tipo);
  const campos = { periodo, valor_mw: valor };
  if (hora) campos.hora_llamada = new Date(`${HOY}T${hora}:00-05:00`).toISOString();
  // `lote_id` es opcional: los tests de E2 no lo necesitan (la resolución del publicado es por celda
  // y lo ignora), pero el listado de E4 agrupa por él y necesita simular un registro migrado.
  if (lote_id) campos.lote_id = lote_id;
  // Ausente ≠ null (misma distinción que `hora_llamada`): sin argumento la clave no se escribe, para
  // no cambiar el shape que ven los tests de E2/E4.
  if (funcionariocnd !== undefined) campos.funcionariocnd = funcionariocnd;
  const ins = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('fe', sql.DateTime2, new Date(`${HOY}T12:00:00-05:00`))
    .input('turno', sql.TinyInt, turnoFromPeriodo(periodo))
    .input('detalle', sql.NVarChar(sql.MAX), detalle)
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

// Guard de coherencia de lote (D-056 E3.9). La metadata del lote —hora, funcionario, descripción—
// vive REPLICADA en cada celda y NINGÚN constraint la mantiene coherente: esta función es lo único
// que la sostiene. Agrupa las filas vivas por `lote_id` y afirma que cada lote tiene UNA sola hora,
// UN solo funcionario, UNA sola descripción, UN solo tipo y ningún periodo repetido.
//
// D-057 (E3): se extrajo del test de D-056 —que la creó pensando exactamente en esto ("la red que va
// a hacer falta cuando D-057 introduzca la edición por lote")— para poder correrla también DESPUÉS
// de un `PUT`, que es el escenario donde una corrección puede tocar unas celdas y no otras. Los dos
// callers siguen vivos: el de la captura NO se reemplaza por el de la corrección.
function verificarCoherenciaDeLotes(filas) {
  const porLote = new Map();
  for (const f of filas) {
    if (!porLote.has(f.lote_id)) porLote.set(f.lote_id, []);
    porLote.get(f.lote_id).push(f);
  }
  for (const [lote_id, celdas] of porLote) {
    for (const campo of ['hora_llamada', 'funcionariocnd', 'detalle']) {
      const distintos = new Set(celdas.map((c) => c[campo]));
      assert.equal(distintos.size, 1, `lote ${lote_id}: ${campo} debe ser idéntico en sus ${celdas.length} celdas`);
    }
    // Un lote nunca mezcla tipos ni repite periodo.
    assert.equal(new Set(celdas.map((c) => c.tipo)).size, 1, `lote ${lote_id}: no puede mezclar tipos`);
    assert.equal(new Set(celdas.map((c) => c.periodo)).size, celdas.length, `lote ${lote_id}: no puede repetir periodo`);
  }
  return porLote;
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
        periodos: [{ periodo: P_ACTUAL - 1, valor_mw: 120 }, { periodo: periodoRedespLibre(), valor_mw: 130 }],
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
        periodos: [{ periodo: periodoRedespLibre(), valor_mw: 140 }],
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
        .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE turno_id = @id; DELETE FROM bitacora.rotacion_control WHERE turno_id = @id; DELETE FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
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
        .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t; DELETE rc FROM bitacora.rotacion_control rc INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = rc.turno_id WHERE tu.planta_id=@p AND tu.fecha_operativa=@f AND tu.turno=@t; DELETE FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`);
    }
  }
});

test('D-056 E3.9 — guard de coherencia: todo lote_id escrito tiene UNA sola hora, funcionario y descripción', async () => {
  // La metadata del lote se REPLICA en cada celda (patrón vigente de MAND) y ningún constraint la
  // mantiene coherente. Este guard es la red que va a hacer falta cuando D-057 introduzca la
  // edición por lote: si una corrección toca unas celdas y no otras, acá se nota.
  await cleanMand();
  const pRedesp = periodoRedespLibre();
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

  const porLote = verificarCoherenciaDeLotes(await registrosMand());
  assert.equal(porLote.size, 3, 'tres filas del mismo Guardar = tres lotes distintos');
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-056 · E4 — GET /api/sala-de-mando/lotes: el listado del día agrupado por lote.
//
// Solo lectura y solo `registro_activo` (el día en curso). Los lotes se arman por `lote_id` y la
// metadata se deriva asumiendo coherencia, sin desempate ad-hoc. `publicado` es un indicador
// derivado del JOIN a evento_dashboard: acá se fija que cae por CELDA, no por lote.
//
// E5 dio de baja el pivote GET /api/sala-de-mando (su único consumidor era la grilla-espejo), así
// que este endpoint es la ÚNICA lectura del día MAND: la cubren el test 9 (acotador de día Bogotá)
// y el 9b (el pivote responde 404).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function getLotes({ sesion_id, planta_id = PLANTA_ID, fecha } = {}) {
  const qs = new URLSearchParams({ planta_id });
  if (fecha) qs.set('fecha', fecha);
  return call('GET', `/api/sala-de-mando/lotes?${qs}`, { sesion_id });
}

test('D-056 E4.1 — dos lotes del día → dos entradas, cada una con sus periodos y su metadata', async () => {
  await cleanMand();
  const horaAuth = horaBogotaMin(-12) ?? '00:00';
  const horaPrueba = horaBogotaMin(-4) ?? '00:01';

  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaAuth, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-auth`,
          periodos: [{ periodo: 10, valor_mw: 110 }, { periodo: 11, valor_mw: 111 }],
        },
        {
          tipo: 'PRUEBA', hora: horaPrueba, funcionariocnd: null, detalle: `${TEST_TAG} e4-prueba`,
          periodos: [{ periodo: 12, valor_mw: 50 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.planta_id, PLANTA_ID);
  assert.equal(data.fecha, HOY, 'sin ?fecha el default es hoy Bogotá');
  assert.equal(data.lotes.length, 2, 'dos filas guardadas = dos lotes');

  // Orden: hora_llamada DESC → PRUEBA (la más reciente) arriba.
  const [primero, segundo] = data.lotes;
  assert.equal(primero.tipo, 'PRUEBA');
  assert.equal(segundo.tipo, 'AUTH');

  assert.equal(segundo.funcionariocnd, 'J. Pérez');
  assert.equal(segundo.detalle, `${TEST_TAG} e4-auth`);
  assert.equal(segundo.hora_llamada, new Date(`${HOY}T${horaAuth}:00.000-05:00`).toISOString());
  assert.deepEqual(segundo.periodos.map((p) => p.periodo), [10, 11]);
  assert.deepEqual(segundo.periodos.map((p) => p.valor_mw), [110, 111]);
  assert.ok(segundo.tipo_nombre, 'el nombre del tipo de evento viaja para la UI');
  assert.equal(segundo.creado_por.usuario_id, ctx.usuarios.jdt.usuario_id);
  assert.equal(segundo.creado_por.nombre_completo, ctx.usuarios.jdt.nombre_completo);
  assert.ok(segundo.lote_id && segundo.lote_id !== primero.lote_id, 'dos lotes distintos');

  assert.equal(primero.funcionariocnd, null, 'PRUEBA fuerza funcionariocnd a null');
  assert.deepEqual(primero.periodos.map((p) => p.periodo), [12]);
});

test('D-056 E4.2 — un lote de P14..P18 es UNA fila con 5 periodos, no cinco filas', async () => {
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID,
      fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-rango`,
        // Se mandan desordenados a propósito: el listado los devuelve ascendentes.
        periodos: [18, 15, 14, 17, 16].map((periodo) => ({ periodo, valor_mw: 100 + periodo })),
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt, fecha: HOY });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 1, 'un lote = una fila del listado');
  assert.deepEqual(data.lotes[0].periodos.map((p) => p.periodo), [14, 15, 16, 17, 18]);
  assert.deepEqual(data.lotes[0].periodos.map((p) => p.valor_mw), [114, 115, 116, 117, 118]);
});

test('D-056 E4.3 — publicado cae por CELDA: con dos lotes solapados el flag distingue celda por celda', async () => {
  await cleanMand();
  const horaA = horaBogotaMin(-20) ?? '00:00';
  const horaB = horaBogotaMin(-3) ?? '00:01';

  // Lote A (más viejo) cubre P14 y P15; lote B (más nuevo) cubre P15 y P16. El compartido es P15.
  for (const [hora, periodos] of [[horaA, [14, 15]], [horaB, [15, 16]]]) {
    const r = await postGuardar({
      sesion_id: ctx.sesiones.jdt,
      body: {
        planta_id: PLANTA_ID, fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-solape-${hora}`,
          periodos: periodos.map((periodo) => ({ periodo, valor_mw: periodo })),
        }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 2);

  const [loteB, loteA] = data.lotes; // hora DESC → B primero
  assert.equal(loteB.hora_llamada, new Date(`${HOY}T${horaB}:00.000-05:00`).toISOString());

  const flags = (lote) => Object.fromEntries(lote.periodos.map((p) => [p.periodo, p.publicado]));
  // A conserva P14 (nadie se lo disputa) y PIERDE P15 contra B: un flag "por lote" habría marcado
  // las dos celdas de A igual.
  assert.deepEqual(flags(loteA), { 14: true, 15: false });
  assert.deepEqual(flags(loteB), { 15: true, 16: true });
});

test('D-056 E4.4 — un registro migrado (sin hora_llamada) sale con hora_llamada null y va ÚLTIMO', async () => {
  await cleanMand();
  // Simula lo que dejó F32.A1: lote_id propio (un solo periodo) y la clave hora_llamada AUSENTE.
  const loteMigrado = '00000000-0000-4000-8000-0000000000e4';
  const ridMigrado = await seedRegistroMand({
    tipo: 'AUTH', periodo: 9, hora: null, valor: 77, lote_id: loteMigrado,
  });

  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-nuevo`,
        periodos: [{ periodo: 8, valor_mw: 88 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 2);
  assert.equal(data.lotes[1].lote_id, loteMigrado, 'el sin-hora va al final del listado');
  assert.equal(data.lotes[1].hora_llamada, null, 'clave ausente → null explícito, nunca inventado');
  assert.deepEqual(data.lotes[1].periodos.map((p) => p.registro_id), [ridMigrado]);
  assert.ok(data.lotes[0].hora_llamada, 'el lote con hora queda arriba');
});

test('D-056 E4.5 — un cargo con puede_ver pero SIN puede_crear en MAND obtiene 200 [RN-04.f]', async () => {
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-lectura`,
        periodos: [{ periodo: 7, valor_mw: 70 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  // Ingeniero Químico: puede_ver=1 en MAND (la ve todo el mundo) y puede_crear=0. Consultar lo
  // registrado no es escribirlo — el listado no puede exigir permiso de escritura.
  const escribir = await postGuardar({
    sesion_id: ctx.sesiones.ingQuim,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'X', detalle: `${TEST_TAG} e4-no`,
        periodos: [{ periodo: 7, valor_mw: 1 }],
      }],
    },
  });
  assert.equal(escribir.status, 403, 'el fixture debe ser un cargo SIN puede_crear en MAND');

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.ingQuim });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 1);
});

test('D-056 E4.6 — planta distinta a la de la sesión → 403 (plantaMatch)', async () => {
  const { status } = await getLotes({ sesion_id: ctx.sesiones.jdt, planta_id: 'GEC3' });
  assert.equal(status, 403);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-057 · E1 — PUT /api/sala-de-mando/lotes/:lote_id: la corrección por lote.
//
// Humo happy-path del diff quirúrgico: un solo PUT cambia un valor, agrega un periodo, quita otro y
// reescribe la descripción — conservando `lote_id` y los `registro_id` de las celdas que sobreviven
// (reinsertar el lote entero dejaría huérfano `evento_dashboard.registro_origen_id`, que no tiene FK
// posible, D-055 (c)). La matriz completa de los 14 criterios vive en E3.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function putLote({ sesion_id, lote_id, body }) {
  return call('PUT', `/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}`, { sesion_id, body });
}

test('D-057 E1.1 — un PUT cambia, agrega y quita periodos conservando el lote', async () => {
  await cleanMand();
  // AUTH (sin lock de REDESP) sobre P10..P12: el resultado no depende de la hora del run.
  const hora = horaBogotaMin(-12) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e1-original`,
        periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 101 }, { periodo: 12, valor_mw: 102 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const previo = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0];
  const ridsPrevios = Object.fromEntries(previo.periodos.map((p) => [p.periodo, p.registro_id]));

  // P10 cambia de valor · P11 se quita (no viaja) · P13 se agrega · P12 queda idéntico.
  // La hora NO cambia: así `celdas_recalculadas` deja ver que solo se recalculó lo que el diff tocó.
  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: previo.lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e1-corregido`,
      periodos: [{ periodo: 10, valor_mw: 150 }, { periodo: 12, valor_mw: 102 }, { periodo: 13, valor_mw: 103 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lote_id, previo.lote_id, 'el lote conserva su identidad');
  assert.deepEqual(data.resumen, {
    actualizados: 1, creados: 1, eliminados: 1, celdas_recalculadas: 3,
  }, 'P12 quedó idéntico y con la misma hora: no se recalcula');

  const { data: despues } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(despues.lotes.length, 1, 'sigue siendo UN lote, no dos');
  const lote = despues.lotes[0];
  assert.equal(lote.lote_id, previo.lote_id);
  assert.deepEqual(lote.periodos.map((p) => p.periodo), [10, 12, 13]);
  assert.deepEqual(lote.periodos.map((p) => p.valor_mw), [150, 102, 103]);
  assert.equal(lote.detalle, `${TEST_TAG} e1-corregido`, 'la descripción se aplica a nivel de LOTE');
  assert.equal(lote.hora_llamada, new Date(`${HOY}T${hora}:00.000-05:00`).toISOString());
  assert.equal(lote.creado_por.usuario_id, ctx.usuarios.jdt.usuario_id, 'la autoría original no se pierde');

  const porPeriodo = Object.fromEntries(lote.periodos.map((p) => [p.periodo, p]));
  assert.equal(porPeriodo[10].registro_id, ridsPrevios[10], 'la celda corregida conserva su registro_id');
  assert.equal(porPeriodo[12].registro_id, ridsPrevios[12], 'la celda intacta conserva su registro_id');
  assert.ok(porPeriodo[13].registro_id > 0, 'la celda agregada es una fila nueva');
  for (const p of lote.periodos) assert.equal(p.publicado, true, 'las tres celdas vivas publican');

  // La celda quitada dejó de estar publicada: sin ganador, la fila de evento_dashboard se ELIMINA
  // (no `activa=0`), porque su origen dejó de existir y el puntero quedaría huérfano (D-055 (c)).
  const db = await getDB();
  const ev = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA).input('f', sql.Date, HOY)
    .query(`SELECT periodo FROM bitacora.evento_dashboard WHERE planta_id=@p AND fecha=@f AND tipo='AUTH'`);
  assert.deepEqual(ev.recordset.map((r) => r.periodo).sort((a, b) => a - b), [10, 12, 13]);

  // Auditoría (decisión 2): la corrección deliberada marca las celdas AFECTADAS — incluida la que
  // solo recibió metadata nueva —, y deja sin sellar la que nació en este mismo PUT.
  const audit = await db.request()
    .input('mand', sql.Int, MAND_BITACORA_ID).input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT registro_id, modificado_por,
             TRY_CAST(JSON_VALUE(campos_extra,'$.periodo') AS INT) AS periodo
      FROM bitacora.registro_activo WHERE bitacora_id=@mand AND planta_id=@p
    `);
  const modPor = Object.fromEntries(audit.recordset.map((r) => [r.periodo, r.modificado_por]));
  assert.equal(modPor[10], ctx.usuarios.jdt.usuario_id, 'cambió de valor → sellada');
  assert.equal(modPor[12], ctx.usuarios.jdt.usuario_id, 'cambió la descripción del lote → sellada');
  assert.equal(modPor[13], null, 'la celda recién creada no se marca como modificada');

  await cleanMand();
});

test('D-057 E1.2 — vaciar todos los periodos no borra: 400 lote_sin_celdas y nada se escribe', async () => {
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', hora: HORA_OK, funcionariocnd: null, detalle: `${TEST_TAG} e1-vaciar`,
        periodos: [{ periodo: 20, valor_mw: 20 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0];

  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: lote.lote_id,
    body: { planta_id: PLANTA_ID, hora: HORA_OK, funcionariocnd: null, detalle: `${TEST_TAG} e1-vaciar`, periodos: [] },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(data.errores.some((e) => e.motivo === 'lote_sin_celdas'), JSON.stringify(data));

  const { data: despues } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(despues.lotes.length, 1, 'vaciar ≠ borrar: el lote sigue intacto');
  assert.deepEqual(despues.lotes[0].periodos.map((p) => p.periodo), [20]);
  await cleanMand();
});

test('D-057 E1.3 — lote inexistente → 404 lote_inexistente; otra planta → 403', async () => {
  const inexistente = '00000000-0000-4000-8000-0000000000d7';
  const a = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: inexistente,
    body: { planta_id: PLANTA_ID, hora: HORA_OK, funcionariocnd: 'X', detalle: null, periodos: [{ periodo: 5, valor_mw: 5 }] },
  });
  assert.equal(a.status, 404, JSON.stringify(a.data));
  assert.equal(a.data.codigo, 'lote_inexistente');

  const b = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: inexistente,
    body: { planta_id: 'GEC3', hora: HORA_OK, funcionariocnd: 'X', detalle: null, periodos: [{ periodo: 5, valor_mw: 5 }] },
  });
  assert.equal(b.status, 403, 'plantaMatch corta antes de tocar la BD');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-057 · E2 — DELETE /api/sala-de-mando/lotes/:lote_id: el borrado real.
//
// Humo del criterio 10 con dos lotes SOLAPADOS: borrar el que está publicado hace RETROCEDER la
// celda compartida al lote sobreviviente, y borrar el último ELIMINA la fila de `evento_dashboard`
// (nunca `activa=0`: sin origen vivo el puntero quedaría huérfano, D-055 (c)). La matriz completa de
// los 14 criterios vive en E3.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function delLote({ sesion_id, lote_id, planta_id = PLANTA_ID }) {
  const qs = planta_id == null ? '' : `?${new URLSearchParams({ planta_id })}`;
  return call('DELETE', `/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}${qs}`, { sesion_id });
}

// Filas de evento_dashboard de un tipo, para el día y la planta-fixture. Solo lectura.
async function eventosDashboard(tipo) {
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, HOY)
    .input('t', sql.VarChar(10), tipo)
    .query(`
      SELECT periodo, valor_mw, registro_origen_id, activa
      FROM bitacora.evento_dashboard
      WHERE planta_id = @p AND fecha = @f AND tipo = @t
      ORDER BY periodo
    `);
  return r.recordset;
}

test('D-057 E2.1 — borrar el lote publicado hace retroceder la celda; borrar el último la elimina', async () => {
  await cleanMand();
  // AUTH (sin lock de REDESP) sobre P14..P16: el resultado no depende de la hora del run.
  // Lote A: P14+P15 con hora temprana · Lote B: P15+P16 con hora tardía. Solapan SOLO en P15.
  const horaA = horaBogotaMin(-32) ?? '00:00';
  const horaB = horaBogotaMin(-2) ?? '00:00';
  const alta = async (hora, periodos, marca) => postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{ tipo: 'AUTH', hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} ${marca}`, periodos }],
    },
  });
  const rA = await alta(horaA, [{ periodo: 14, valor_mw: 140 }, { periodo: 15, valor_mw: 150 }], 'e2-A');
  assert.equal(rA.status, 200, JSON.stringify(rA.data));
  const rB = await alta(horaB, [{ periodo: 15, valor_mw: 155 }, { periodo: 16, valor_mw: 160 }], 'e2-B');
  assert.equal(rB.status, 200, JSON.stringify(rB.data));

  const lotes = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes;
  assert.equal(lotes.length, 2);
  const loteA = lotes.find((l) => l.detalle === `${TEST_TAG} e2-A`);
  const loteB = lotes.find((l) => l.detalle === `${TEST_TAG} e2-B`);
  assert.ok(loteA && loteB, JSON.stringify(lotes));
  const ridA = Object.fromEntries(loteA.periodos.map((p) => [p.periodo, p.registro_id]));

  // B gana P15 de forma DETERMINISTA en las dos ramas de `horaBogotaMin`: con horas distintas por
  // `hora_llamada DESC`, y si el borde de medianoche las colapsó a la misma, por `creado_en DESC`
  // (B se registró después). Es el desempate de `recalcularEventoDashboard`.
  const antes = await eventosDashboard('AUTH');
  assert.deepEqual(antes.map((e) => e.periodo), [14, 15, 16]);
  assert.equal(antes[1].valor_mw, 155, 'P15 lo publica el lote B (hora más reciente)');

  // ── Se borra el lote PUBLICADO en la celda compartida ────────────────────────────────────────
  const d1 = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: loteB.lote_id });
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  assert.equal(d1.data.lote_id, loteB.lote_id);
  assert.deepEqual(d1.data.resumen, { eliminados: 2, celdas_recalculadas: 2 });

  const tras1 = await eventosDashboard('AUTH');
  assert.deepEqual(tras1.map((e) => e.periodo), [14, 15], 'P16 no lo cubría nadie más: su fila DESAPARECE');
  assert.equal(tras1[1].valor_mw, 150, 'P15 RETROCEDE al valor del lote A');
  assert.equal(tras1[1].registro_origen_id, ridA[15], 'y su origen es la celda del lote sobreviviente');
  assert.equal(tras1[1].activa, true, 'el retroceso deja la fila activa, no anulada');

  const quedan = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes;
  assert.equal(quedan.length, 1, 'el lote borrado desaparece del listado (borrado real, RN-04.c)');
  assert.equal(quedan[0].lote_id, loteA.lote_id);
  for (const p of quedan[0].periodos) assert.equal(p.publicado, true, 'A pasó a publicar sus dos celdas');

  // ── Se borra el último lote: ya no queda ganador en ninguna celda ─────────────────────────────
  const d2 = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: loteA.lote_id });
  assert.equal(d2.status, 200, JSON.stringify(d2.data));
  assert.deepEqual(d2.data.resumen, { eliminados: 2, celdas_recalculadas: 2 });
  assert.equal((await eventosDashboard('AUTH')).length, 0, 'sin origen vivo la fila se ELIMINA, no queda activa=0');
  assert.equal((await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes.length, 0);

  // Sanidad global (E2): ningún puntero de la planta-fixture quedó apuntando a una fila borrada.
  const db = await getDB();
  const huerfanos = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT ed.evento_id
      FROM bitacora.evento_dashboard ed
      WHERE ed.planta_id = @p
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_activo    ra WHERE ra.registro_id = ed.registro_origen_id)
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_historico rh WHERE rh.registro_id = ed.registro_origen_id)
    `);
  assert.equal(huerfanos.recordset.length, 0, 'evento_dashboard sin registro_origen_id huérfano');

  await cleanMand();
});

test('D-057 E2.2 — gates del DELETE: sin planta_id 400, otra planta 403, lote inexistente 404', async () => {
  const inexistente = '00000000-0000-4000-8000-0000000000e2';
  const sinPlanta = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: inexistente, planta_id: null });
  assert.equal(sinPlanta.status, 400, 'planta_id viaja por query string, no por body');

  const otraPlanta = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: inexistente, planta_id: 'GEC3' });
  assert.equal(otraPlanta.status, 403, 'plantaMatch corta antes de tocar la BD');

  const noExiste = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: inexistente });
  assert.equal(noExiste.status, 404, JSON.stringify(noExiste.data));
  assert.equal(noExiste.data.codigo, 'lote_inexistente');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-057 · E3 — Cobertura: criterios de aceptación de REQ-04 §6 + guards transversales.
//
// Qué NO está acá y por qué (para que ningún criterio quede como hueco silencioso):
//  - Criterios 1, 3 y 4 (un renglón por lote · solo hoy y la planta de la sesión · sin
//    Disponibilidad): los cubren `D-056 E4.1/E4.2/E4.6` y el test 9 (acotador de día Bogotá).
//  - Criterio 2 (formato del mensaje de WhatsApp): FUERA DE ALCANCE de D-057 — REQ-04 §8.1 sigue
//    bloqueado por falta de la plantilla literal y se resuelve en un flujo posterior (D-058).
//  - Criterio 6 (en otra bitácora sigue prohibido editar lo ajeno): su cara negativa vive en
//    `tests/registros_solo_autor.test.js`, que prueba que ni el ADMIN toca un registro ajeno por la
//    rama genérica. Acá vive la cara POSITIVA (E3.1). Son un PAR: si alguien "unifica" la política
//    de MAND con la genérica, uno de los dos tiene que ponerse rojo. No los desacoples.
//  - Criterios 8 y 9-copias (cascada a SALAJDT/SALAING): eran FUERA DE ALCANCE cuando estos tests se
//    escribieron —las copias no existían—; los cubre `D-058 E5`, al final de este archivo. Corren
//    sobre `TEST_PLANTA_REFLEJO` porque `TEST_PLANTA` no refleja por diseño (RN-02.e).
//
// Todo corre sobre TEST_PLANTA con TEST_TAG. Los lotes que necesitan un estado inicial imposible de
// producir por HTTP (REDESP en periodo pasado) se siembran con `seedLoteMand`.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Siembra un LOTE completo (N celdas con el mismo lote_id y la misma metadata) directo en
// registro_activo. Necesario para REDESP en periodos PASADOS: el `POST /guardar` los rechaza por
// diseño (lock D-016), así que no hay forma de llegar por HTTP al estado que la corrección debe
// manejar. Devuelve { lote_id, rids: {periodo → registro_id} }.
async function seedLoteMand({ tipo, hora, periodos, detalle, funcionariocnd = null }) {
  const lote_id = randomUUID();
  const rids = {};
  for (const { periodo, valor } of periodos) {
    rids[periodo] = await seedRegistroMand({
      tipo, periodo, hora, valor, lote_id, detalle, funcionariocnd,
    });
  }
  return { lote_id, rids };
}

// Celdas vivas de un lote con TODO lo que la corrección puede tocar (valor, metadata, autoría y
// fecha_evento). Solo lectura, acotada a la fixture.
async function celdasDelLote(lote_id) {
  const db = await getDB();
  const r = await db.request()
    .input('m', sql.Int, MAND_BITACORA_ID)
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .input('lote', sql.NVarChar(64), lote_id)
    .query(`
      SELECT ra.registro_id, ra.detalle, ra.turno_id, ra.fecha_evento,
             ra.creado_por, ra.modificado_por, ra.modificado_en,
             te.notificar_dashboard_tipo AS tipo,
             CONVERT(varchar(10), DATEADD(HOUR, -5, ra.fecha_evento), 23) AS dia_bogota,
             TRY_CAST(JSON_VALUE(ra.campos_extra,'$.periodo') AS INT)    AS periodo,
             TRY_CAST(JSON_VALUE(ra.campos_extra,'$.valor_mw') AS FLOAT) AS valor_mw,
             JSON_VALUE(ra.campos_extra,'$.funcionariocnd') AS funcionariocnd,
             JSON_VALUE(ra.campos_extra,'$.hora_llamada')   AS hora_llamada,
             JSON_VALUE(ra.campos_extra,'$.lote_id')        AS lote_id
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.bitacora_id=@m AND ra.planta_id=@p AND ra.estado='borrador'
        AND JSON_VALUE(ra.campos_extra,'$.lote_id') = @lote
      ORDER BY TRY_CAST(JSON_VALUE(ra.campos_extra,'$.periodo') AS INT)
    `);
  return r.recordset;
}

// Huella comparable de un lote: lo que un PUT rechazado NO puede haber movido. Incluye los
// timestamps de auditoría, así que detecta hasta un UPDATE que "no cambió nada visible".
function huellaDeLote(celdas) {
  return celdas.map((c) => [
    c.registro_id, c.periodo, c.valor_mw, c.detalle, c.funcionariocnd, c.hora_llamada,
    c.creado_por, c.modificado_por, c.modificado_en?.getTime() ?? null,
  ]);
}

test('D-057 E3.1 — un lote creado por el Ing. de Operación lo corrige y lo borra el Jefe de Turno [criterio 5]', async () => {
  // La excepción a D-049 en su cara POSITIVA: en MAND el gate es `puede_crear` (matriz data-driven),
  // NO `creado_por` — corregir Operación 24h es colaborativo por diseño (el turno entrante arregla lo
  // que dejó mal el saliente). La cara negativa —en una bitácora genérica nadie toca lo ajeno, ni
  // siquiera con puede_crear— la fija `registros_solo_autor.test.js`. Los dos tests son un par.
  await cleanMand();
  const hora = horaBogotaMin(-15) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.ingOp,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e3-ajeno`,
        periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 101 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const lote = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0];
  assert.equal(lote.creado_por.usuario_id, ctx.usuarios.ingOp.usuario_id, 'el lote lo creó el Ing. de Operación');

  const put = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: lote.lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e3-corregido`,
      periodos: [{ periodo: 10, valor_mw: 150 }, { periodo: 11, valor_mw: 101 }],
    },
  });
  assert.equal(put.status, 200, `el JdT no es el autor y debe poder corregir igual: ${JSON.stringify(put.data)}`);

  const celdas = await celdasDelLote(lote.lote_id);
  assert.equal(celdas.length, 2);
  for (const c of celdas) {
    assert.equal(c.creado_por, ctx.usuarios.ingOp.usuario_id, 'la autoría original NO se reescribe');
    assert.equal(c.modificado_por, ctx.usuarios.jdt.usuario_id, 'quien corrigió queda atribuido');
  }

  // Borrar lo ajeno en MAND también es legal: mismo gate, misma excepción acotada.
  const del = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: lote.lote_id });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes.length, 0);
  await cleanMand();
});

test('D-057 E3.2 — un PUT cambia MW, hora, funcionario, descripción y el conjunto de periodos [criterio 7]', async () => {
  await cleanMand();
  const horaVieja = horaBogotaMin(-40) ?? '00:00';
  const horaNueva = horaBogotaMin(-3) ?? '00:01';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: horaVieja, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-2-viejo`,
        periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 101 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;

  // Las cinco cosas a la vez: P10 cambia de valor, P11 se quita, P12 se agrega, y hora/funcionario/
  // descripción cambian.
  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora: horaNueva, funcionariocnd: 'Gómez', detalle: `${TEST_TAG} e3-2-nuevo`,
      periodos: [{ periodo: 10, valor_mw: 150 }, { periodo: 12, valor_mw: 102 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(data.resumen, { actualizados: 1, creados: 1, eliminados: 1, celdas_recalculadas: 3 },
    'cambiar la hora obliga a recalcular TODAS las celdas del lote: es el desempate de la publicación');

  const celdas = await celdasDelLote(lote_id);
  assert.deepEqual(celdas.map((c) => c.periodo), [10, 12], 'el conjunto exacto de periodos');
  assert.deepEqual(celdas.map((c) => c.valor_mw), [150, 102]);
  const horaEsperada = new Date(`${HOY}T${horaNueva}:00.000-05:00`).toISOString();
  for (const c of celdas) {
    assert.equal(c.hora_llamada, horaEsperada, 'la hora nueva aterriza en TODAS las celdas del lote');
    assert.equal(c.funcionariocnd, 'Gómez');
    assert.equal(c.detalle, `${TEST_TAG} e3-2-nuevo`);
  }

  // Lo publicado sigue a la corrección celda por celda: P11 salió, P12 entró.
  const ev = await eventosDashboard('AUTH');
  assert.deepEqual(ev.map((e) => e.periodo), [10, 12]);
  assert.deepEqual(ev.map((e) => e.valor_mw), [150, 102]);
  await cleanMand();
});

test('D-057 E3.3 — borrar un lote lo saca del listado y no toca a los demás [criterio 9]', async () => {
  await cleanMand();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaBogotaMin(-20) ?? '00:00', funcionariocnd: 'Pérez',
          detalle: `${TEST_TAG} e3-3-queda`, periodos: [{ periodo: 8, valor_mw: 80 }],
        },
        {
          tipo: 'PRUEBA', hora: horaBogotaMin(-10) ?? '00:01', funcionariocnd: null,
          detalle: `${TEST_TAG} e3-3-se-va`, periodos: [{ periodo: 9, valor_mw: 90 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const lotes = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes;
  const victima = lotes.find((l) => l.detalle === `${TEST_TAG} e3-3-se-va`);
  const testigo = lotes.find((l) => l.detalle === `${TEST_TAG} e3-3-queda`);
  assert.ok(victima && testigo, JSON.stringify(lotes));

  const del = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: victima.lote_id });
  assert.equal(del.status, 200, JSON.stringify(del.data));

  const quedan = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes;
  assert.equal(quedan.length, 1, 'el lote borrado desaparece del listado (borrado real, RN-04.c)');
  assert.equal(quedan[0].lote_id, testigo.lote_id, 'el otro lote queda intacto');
  assert.equal((await celdasDelLote(victima.lote_id)).length, 0, 'sus celdas ya no existen en la BD');
  await cleanMand();
});

test('D-057 E3.4 — cadena completa de retroceso: tres lotes solapados, dos borrados seguidos [criterio 10]', async () => {
  await cleanMand();
  // Tres llamadas del CND al MISMO periodo, a horas distintas. El desempate es determinista incluso
  // si `horaBogotaMin` cae en el borde del día y colapsa las tres a '00:00': ahí manda `creado_en
  // DESC` y el orden de registro sigue siendo A → B → C.
  const escalones = [
    { marca: 'A', hora: horaBogotaMin(-40) ?? '00:00', valor: 141 },
    { marca: 'B', hora: horaBogotaMin(-25) ?? '00:00', valor: 142 },
    { marca: 'C', hora: horaBogotaMin(-10) ?? '00:00', valor: 143 },
  ];
  for (const e of escalones) {
    const r = await postGuardar({
      sesion_id: ctx.sesiones.jdt,
      body: {
        planta_id: PLANTA_ID, fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora: e.hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-4-${e.marca}`,
          periodos: [{ periodo: 14, valor_mw: e.valor }],
        }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }

  const porMarca = Object.fromEntries(
    (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes
      .map((l) => [l.detalle.slice(-1), l]),
  );
  assert.equal(Object.keys(porMarca).length, 3, JSON.stringify(porMarca));

  const publicado = async () => (await eventosDashboard('AUTH'))[0] ?? null;
  assert.equal((await publicado()).valor_mw, 143, 'publica la llamada más reciente');

  // 1er borrado: retrocede al escalón intermedio.
  const d1 = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: porMarca.C.lote_id });
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  const tras1 = await publicado();
  assert.equal(tras1.valor_mw, 142, 'el publicado RETROCEDE al lote B');
  assert.equal(tras1.registro_origen_id, porMarca.B.periodos[0].registro_id);
  assert.equal(tras1.activa, true, 'el retroceso deja la fila activa, nunca anulada');

  // 2º borrado seguido: retrocede otra vez, no salta al vacío.
  const d2 = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: porMarca.B.lote_id });
  assert.equal(d2.status, 200, JSON.stringify(d2.data));
  const tras2 = await publicado();
  assert.equal(tras2.valor_mw, 141, 'el publicado RETROCEDE al lote A');
  assert.equal(tras2.registro_origen_id, porMarca.A.periodos[0].registro_id);

  // 3º: sin ningún lote vivo la fila se ELIMINA (no `activa=0`), porque su origen dejó de existir y
  // el puntero quedaría huérfano — `registro_origen_id` no tiene FK posible (D-055 (c)).
  const d3 = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id: porMarca.A.lote_id });
  assert.equal(d3.status, 200, JSON.stringify(d3.data));
  assert.equal((await eventosDashboard('AUTH')).length, 0, 'sin origen vivo la celda deja de existir en el dashboard');
  await cleanMand();
});

test('D-057 E3.5 — REDESP: cambiar, agregar o quitar un periodo PASADO se rechaza [criterio 11 a/b/c]', async () => {
  const pAct = periodoActual();
  if (pAct <= 1) return; // a esta hora no hay ningún periodo pasado que bloquear
  await cleanMand();
  const pPasado = pAct - 1;
  const pLibre = periodoRedespLibre();
  const hora = horaBogotaMin(-20) ?? '00:00';

  // Estado inicial sembrado: el `POST /guardar` no puede crear un REDESP en periodo pasado (lock
  // D-016), pero un lote registrado a tiempo LLEGA a esa situación con solo pasar la hora — que es
  // exactamente el escenario que la corrección debe rechazar (riesgo REQ-04 §5.4).
  const { lote_id } = await seedLoteMand({
    tipo: 'REDESP', hora, detalle: `${TEST_TAG} e3-5`, funcionariocnd: null,
    periodos: [{ periodo: pPasado, valor: 50 }, { periodo: pLibre, valor: 60 }],
  });
  const huellaOriginal = huellaDeLote(await celdasDelLote(lote_id));

  const cuerpo = (periodos) => ({
    planta_id: PLANTA_ID, hora, funcionariocnd: null, detalle: `${TEST_TAG} e3-5`, periodos,
  });
  const rechazado = async (etiqueta, periodos) => {
    const { status, data } = await putLote({ sesion_id: ctx.sesiones.jdt, lote_id, body: cuerpo(periodos) });
    assert.equal(status, 400, `${etiqueta}: ${JSON.stringify(data)}`);
    assert.ok(
      data.errores?.some((e) => e.motivo === 'periodo_bloqueado'),
      `${etiqueta}: esperado periodo_bloqueado, got ${JSON.stringify(data.errores)}`,
    );
    assert.deepEqual(huellaDeLote(await celdasDelLote(lote_id)), huellaOriginal, `${etiqueta}: nada se escribió`);
  };

  // (a) cambiar el VALOR de un periodo pasado.
  await rechazado('cambiar valor pasado', [{ periodo: pPasado, valor_mw: 55 }, { periodo: pLibre, valor_mw: 60 }]);
  // (b) AGREGAR un periodo pasado que el lote no tenía (solo si hay otro pasado disponible).
  if (pAct >= 3) {
    await rechazado('agregar periodo pasado', [
      { periodo: pAct - 2, valor_mw: 45 }, { periodo: pPasado, valor_mw: 50 }, { periodo: pLibre, valor_mw: 60 },
    ]);
  }
  // (c) QUITAR un periodo pasado: retirar lo publicado es un cambio de valor, no una omisión inocua.
  await rechazado('quitar periodo pasado', [{ periodo: pLibre, valor_mw: 60 }]);
  await cleanMand();
});

test('D-057 E3.6 — REDESP: cambiar solo hora y descripción con los periodos pasados idénticos se permite [criterio 11 d]', async () => {
  const pAct = periodoActual();
  if (pAct <= 1) return;
  await cleanMand();
  const pPasado = pAct - 1;
  const horaVieja = horaBogotaMin(-40) ?? '00:00';
  const horaNueva = horaBogotaMin(-2) ?? '00:01';
  const { lote_id, rids } = await seedLoteMand({
    tipo: 'REDESP', hora: horaVieja, detalle: `${TEST_TAG} e3-6-viejo`, funcionariocnd: null,
    periodos: [{ periodo: pPasado, valor: 70 }],
  });

  // "El lock protege el VALOR, nunca el comentario": el operador tiene que poder arreglar la hora de
  // la llamada y la descripción de un redespacho ya despachado.
  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora: horaNueva, funcionariocnd: null, detalle: `${TEST_TAG} e3-6-nuevo`,
      periodos: [{ periodo: pPasado, valor_mw: 70 }],
    },
  });
  assert.equal(status, 200, `hora y descripción pasan siempre: ${JSON.stringify(data)}`);

  const celdas = await celdasDelLote(lote_id);
  assert.equal(celdas.length, 1);
  assert.equal(celdas[0].registro_id, rids[pPasado], 'la celda es la misma fila, no una reinserción');
  assert.equal(celdas[0].valor_mw, 70, 'el valor protegido no se movió');
  assert.equal(celdas[0].detalle, `${TEST_TAG} e3-6-nuevo`);
  assert.equal(celdas[0].hora_llamada, new Date(`${HOY}T${horaNueva}:00.000-05:00`).toISOString());
  assert.equal(celdas[0].modificado_por, ctx.usuarios.jdt.usuario_id, 'el cambio de metadata queda atribuido');
  await cleanMand();
});

test('D-057 E3.7 — con el turno finalizado y la cabecera CERRADA se corrige y se borra igual [criterio 12]', async () => {
  await cleanMand();
  const db = await getDB();
  // Mismo patrón que D-056 E3.8: se elige un periodo del turno que NO está corriendo, para que la
  // cabecera que cerramos no sea la vigente y no contamine a las suites posteriores.
  const pAct = periodoActual();
  const periodo = (pAct >= 7 && pAct <= 18) ? 3 : 12;
  const fop = fechaOperativaDePeriodo(HOY, periodo);
  const turno = turnoFromPeriodo(periodo);
  const hora = horaBogotaMin(-8) ?? '00:00';

  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-7`,
        periodos: [{ periodo, valor_mw: 88 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;

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
  // Finalización de turno VIGENTE en la sesión que va a corregir (D-040).
  await db.request()
    .input('sid', sql.Int, ctx.sesiones.jdt)
    .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en = SYSUTCDATETIME() WHERE sesion_id = @sid`);

  try {
    // MAND está exenta de los gates de turno (D-040/D-045/D-046): la llamada al CND ocurre igual
    // aunque el turno esté finalizado, y corregir lo mal digitado no puede quedar bloqueado.
    const put = await putLote({
      sesion_id: ctx.sesiones.jdt,
      lote_id,
      body: {
        planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-7-corregido`,
        periodos: [{ periodo, valor_mw: 99 }],
      },
    });
    assert.equal(put.status, 200, `MAND exenta del turno (RQ-04.18): ${JSON.stringify(put.data)}`);
    assert.notEqual(put.data.codigo, 'turno_finalizado');
    assert.notEqual(put.data.codigo, 'turno_cerrado');
    assert.notEqual(put.data.codigo, 'turno_en_transicion');
    assert.equal((await celdasDelLote(lote_id))[0].valor_mw, 99);

    const del = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal((await celdasDelLote(lote_id)).length, 0);
  } finally {
    await db.request()
      .input('sid', sql.Int, ctx.sesiones.jdt)
      .query(`UPDATE bitacora.sesion_activa SET turno_finalizado_en = NULL WHERE sesion_id = @sid`);
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
        .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t; DELETE rc FROM bitacora.rotacion_control rc INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = rc.turno_id WHERE tu.planta_id=@p AND tu.fecha_operativa=@f AND tu.turno=@t; DELETE FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa=@f AND turno=@t`);
    }
    await cleanMand();
  }
});

test('D-057 E3.8 — un cargo SIN puede_crear en MAND no corrige ni borra: 403 y nada cambia [criterio 13]', async () => {
  await cleanMand();
  const hora = horaBogotaMin(-6) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-8`,
        periodos: [{ periodo: 7, valor_mw: 70 }, { periodo: 8, valor_mw: 71 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;
  const huella = huellaDeLote(await celdasDelLote(lote_id));

  // Ingeniero Químico: `puede_ver=1` en MAND (la ve todo el mundo) y `puede_crear=0`. El enforcement
  // sale de la matriz data-driven — NUNCA de un cargo hardcodeado en el endpoint.
  const put = await putLote({
    sesion_id: ctx.sesiones.ingQuim,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'Intruso', detalle: `${TEST_TAG} e3-8-intruso`,
      periodos: [{ periodo: 7, valor_mw: 999 }],
    },
  });
  assert.equal(put.status, 403, JSON.stringify(put.data));

  const del = await delLote({ sesion_id: ctx.sesiones.ingQuim, lote_id });
  assert.equal(del.status, 403, JSON.stringify(del.data));

  assert.deepEqual(huellaDeLote(await celdasDelLote(lote_id)), huella, 'el lote quedó exactamente igual');
  // Y sigue viendo el listado: consultar lo registrado no es escribirlo (RN-04.f).
  assert.equal((await getLotes({ sesion_id: ctx.sesiones.ingQuim })).status, 200);
  await cleanMand();
});

test('D-057 E3.9 — una corrección que falla NO queda aplicada a medias [criterio 14]', async () => {
  const pAct = periodoActual();
  if (pAct <= 1) return; // sin periodo pasado no hay error tardío que provocar
  await cleanMand();
  const pPasado = pAct - 1;
  const pLibre = periodoRedespLibre();
  const pNuevo = Math.min(pLibre + 1, 24);
  if (pNuevo === pLibre) return; // último periodo del día: no queda uno libre donde insertar
  const hora = horaBogotaMin(-20) ?? '00:00';

  const { lote_id } = await seedLoteMand({
    tipo: 'REDESP', hora, detalle: `${TEST_TAG} e3-9`, funcionariocnd: null,
    periodos: [{ periodo: pPasado, valor: 50 }, { periodo: pLibre, valor: 60 }],
  });
  // Se publica el estado inicial para que la comprobación de atomicidad incluya el dashboard: un
  // rollback parcial que dejara la publicación movida sería tan grave como uno que dejara la celda.
  for (const p of [pPasado, pLibre]) await recalc({ periodo: p, tipo: 'REDESP' });
  const huella = huellaDeLote(await celdasDelLote(lote_id));
  const evAntes = await eventosDashboard('REDESP');
  assert.equal(evAntes.length, 2, 'las dos celdas del lote arrancan publicadas');

  // El body pide CUATRO cosas válidas —cambiar el valor de un periodo libre, agregar otro, cambiar la
  // descripción y la hora— y UNA inválida: el periodo pasado cambia de valor. El lote entero se cae.
  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora: horaBogotaMin(-1) ?? '00:01', funcionariocnd: null,
      detalle: `${TEST_TAG} e3-9-no-debe-aterrizar`,
      periodos: [
        { periodo: pLibre, valor_mw: 65 },
        { periodo: pNuevo, valor_mw: 66 },
        { periodo: pPasado, valor_mw: 55 },
      ],
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.ok(data.errores?.some((e) => e.motivo === 'periodo_bloqueado' && e.periodo === pPasado), JSON.stringify(data.errores));

  const despues = await celdasDelLote(lote_id);
  assert.deepEqual(despues.map((c) => c.periodo), [pPasado, pLibre].sort((a, b) => a - b),
    'ni el periodo nuevo se creó ni ninguno se borró');
  assert.deepEqual(huellaDeLote(despues), huella,
    'ningún valor, metadata ni sello de auditoría se movió (todo o nada, una sola transacción)');
  assert.deepEqual(
    (await eventosDashboard('REDESP')).map((e) => [e.periodo, e.valor_mw, e.registro_origen_id]),
    evAntes.map((e) => [e.periodo, e.valor_mw, e.registro_origen_id]),
    'la publicación al dashboard tampoco se movió',
  );
  await cleanMand();
});

test('D-057 E3.10 — un lote ya archivado por el cierre diario → 409 lote_cerrado en PUT y DELETE', async () => {
  await cleanMand();
  const db = await getDB();
  const hora = horaBogotaMin(-7) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-10`,
        periodos: [{ periodo: 16, valor_mw: 60 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;

  const cierre = await call('POST', '/api/sala-de-mando/cierre-diario', {
    sesion_id: ctx.sesiones.jdt,
    body: { fecha: HOY, planta_id: PLANTA_ID },
  });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.data));
  assert.equal(cierre.data.closed, true);

  // El histórico es inmutable (RF-032): la corrección se corta en el borde del día. El 409 le dice al
  // front "refrescá el listado", que es distinto del 404 "esto nunca existió".
  const put = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: { planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-10`, periodos: [{ periodo: 16, valor_mw: 61 }] },
  });
  assert.equal(put.status, 409, JSON.stringify(put.data));
  assert.equal(put.data.codigo, 'lote_cerrado');

  const del = await delLote({ sesion_id: ctx.sesiones.jdt, lote_id });
  assert.equal(del.status, 409, JSON.stringify(del.data));
  assert.equal(del.data.codigo, 'lote_cerrado');

  // El CIET del cierre no lleva TEST_TAG (registrarCierreMand deja el detalle en NULL): se borra por
  // PK para no acumular leftover entre corridas.
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

test('D-057 E3.11 — la celda que agrega el PUT HEREDA el fecha_evento del lote: nunca se parte entre dos días', async () => {
  await cleanMand();
  // El lote se siembra con `fecha_evento` = mediodía Bogotá de HOY, distinto del instante en que el
  // PUT insertará la celda nueva. Si la herencia fallara y el INSERT usara SYSUTCDATETIME(), la celda
  // agregada se despegaría del resto — y en las últimas horas del día Bogotá caería en OTRO día,
  // partiendo el lote entre dos jornadas (el listado y el cierre diario acotan por día Bogotá).
  const hora = horaBogotaMin(-5) ?? '00:00';
  const { lote_id } = await seedLoteMand({
    tipo: 'AUTH', hora, detalle: `${TEST_TAG} e3-11`, funcionariocnd: 'Pérez',
    periodos: [{ periodo: 18, valor: 180 }, { periodo: 19, valor: 190 }],
  });
  const feEsperado = (await celdasDelLote(lote_id))[0].fecha_evento.getTime();

  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-11`,
      periodos: [{ periodo: 18, valor_mw: 180 }, { periodo: 19, valor_mw: 190 }, { periodo: 20, valor_mw: 200 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.resumen.creados, 1);

  const celdas = await celdasDelLote(lote_id);
  assert.deepEqual(celdas.map((c) => c.periodo), [18, 19, 20]);
  for (const c of celdas) {
    assert.equal(c.fecha_evento.getTime(), feEsperado, 'todas las celdas del lote comparten fecha_evento');
    assert.equal(c.dia_bogota, HOY);
  }
  // Y el listado del día lo trae como UN solo lote, no como dos.
  const lotes = (await getLotes({ sesion_id: ctx.sesiones.jdt, fecha: HOY })).data.lotes;
  assert.equal(lotes.length, 1);
  assert.deepEqual(lotes[0].periodos.map((p) => p.periodo), [18, 19, 20]);
  await cleanMand();
});

test('D-057 E3.12 — la celda que agrega el PUT resuelve turno_id por el PERIODO (madrugada → T2 de F-1)', async () => {
  await cleanMand();
  const db = await getDB();
  const periodo = 3; // madrugada: pertenece al T2 que arrancó a las 18:00 del día anterior (D-055 (b))
  const fop = fechaOperativaDePeriodo(HOY, periodo);
  const turno = turnoFromPeriodo(periodo);
  assert.notEqual(fop, HOY, 'la madrugada pertenece al turno que arrancó el día anterior');

  // Igual que D-056 E3.7: la cabecera de un turno pasado puede no existir en la fixture. Si la
  // sembramos nosotros, la retiramos al final — una fila PROGRAMADO residente en 'TST' es sucesora
  // candidata de cualquier `cerrarTurno` posterior y contaminaría a las suites que corren después.
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
    const hora = horaBogotaMin(-5) ?? '00:00';
    const alta = await postGuardar({
      sesion_id: ctx.sesiones.jdt,
      body: {
        planta_id: PLANTA_ID, fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-12`,
          periodos: [{ periodo: 12, valor_mw: 120 }],
        }],
      },
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.data));
    const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;

    // El PUT agrega la celda de madrugada. Su turno sale del PERIODO, no del instante de la
    // corrección (que cae en el turno de ahora) ni del día de la grilla.
    const { status, data } = await putLote({
      sesion_id: ctx.sesiones.jdt,
      lote_id,
      body: {
        planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-12`,
        periodos: [{ periodo: 12, valor_mw: 120 }, { periodo, valor_mw: 75 }],
      },
    });
    assert.equal(status, 200, JSON.stringify(data));

    const celdas = await celdasDelLote(lote_id);
    const madrugada = celdas.find((c) => c.periodo === periodo);
    assert.ok(madrugada, JSON.stringify(celdas));
    assert.equal(madrugada.turno_id, esperado, 'turno_id debe apuntar al T2 del día anterior');
  } finally {
    await cleanMand();
    if (!yaExistia) {
      await db.request()
        .input('id', sql.Int, esperado)
        .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE turno_id = @id; DELETE FROM bitacora.rotacion_control WHERE turno_id = @id; DELETE FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
    }
  }
});

test('D-057 E3.13 — la auditoría marca solo las celdas AFECTADAS por cada corrección', async () => {
  await cleanMand();
  const hora = horaBogotaMin(-9) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-13-v1`,
        periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 101 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lote_id = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes[0].lote_id;
  for (const c of await celdasDelLote(lote_id)) {
    assert.equal(c.modificado_por, null, 'la captura no sella modificado_por (D-019 rige ahí)');
  }

  // (1) Cambiar SOLO la descripción sella TODAS las celdas: la metadata es del LOTE y vive replicada
  //     en cada una — es la lección de D-055 (a), donde aplicarla dentro del loop del delta perdía el
  //     comentario en silencio.
  const soloDetalle = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-13-v2`,
      periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 101 }],
    },
  });
  assert.equal(soloDetalle.status, 200, JSON.stringify(soloDetalle.data));
  assert.equal(soloDetalle.data.resumen.celdas_recalculadas, 0,
    'ningún valor cambió y la hora tampoco: la publicación no se toca');

  const trasV2 = await celdasDelLote(lote_id);
  for (const c of trasV2) {
    assert.equal(c.detalle, `${TEST_TAG} e3-13-v2`);
    assert.equal(c.modificado_por, ctx.usuarios.jdt.usuario_id, 'cambió la descripción del lote → sellada');
    assert.ok(c.modificado_en, 'y con su timestamp');
  }
  const selloV2 = Object.fromEntries(trasV2.map((c) => [c.periodo, c.modificado_en.getTime()]));

  // (2) Cambiar SOLO el valor de P10, con la metadata idéntica: P11 no está afectada y su sello no
  //     puede moverse. Si el UPDATE sellara todo el lote, este assert lo delata.
  const soloValor = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id,
    body: {
      planta_id: PLANTA_ID, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-13-v2`,
      periodos: [{ periodo: 10, valor_mw: 155 }, { periodo: 11, valor_mw: 101 }],
    },
  });
  assert.equal(soloValor.status, 200, JSON.stringify(soloValor.data));
  assert.equal(soloValor.data.resumen.celdas_recalculadas, 1, 'solo la celda que cambió de valor se recalcula');

  const trasV3 = Object.fromEntries((await celdasDelLote(lote_id)).map((c) => [c.periodo, c]));
  assert.equal(trasV3[10].valor_mw, 155);
  assert.ok(trasV3[10].modificado_en.getTime() >= selloV2[10], 'la celda corregida vuelve a sellarse');
  assert.equal(trasV3[11].modificado_en.getTime(), selloV2[11],
    'la celda que no cambió de valor ni recibió metadata nueva NO se re-sella');
  await cleanMand();
});

test('D-057 E3.14 — guard de coherencia de lote: se sostiene también DESPUÉS de un PUT', async () => {
  // Extensión del guard de D-056 E3.9 al escenario para el que fue escrito. La metadata del lote está
  // REPLICADA por celda y ningún constraint la mantiene coherente: una corrección que tocara unas
  // celdas y no otras (p. ej. aplicando la metadata dentro del loop del delta, D-055 (a)) dejaría un
  // lote con dos horas distintas — y la publicación al dashboard se decide justamente por la hora.
  await cleanMand();
  const horaVieja = horaBogotaMin(-30) ?? '00:00';
  const horaNueva = horaBogotaMin(-4) ?? '00:01';
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaVieja, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e3-14-auth`,
          periodos: [{ periodo: 14, valor_mw: 140 }, { periodo: 15, valor_mw: 150 }, { periodo: 16, valor_mw: 160 }],
        },
        {
          tipo: 'PRUEBA', hora: horaVieja, funcionariocnd: null, detalle: `${TEST_TAG} e3-14-prueba`,
          periodos: [{ periodo: 14, valor_mw: 40 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lotes = (await getLotes({ sesion_id: ctx.sesiones.jdt })).data.lotes;
  const auth = lotes.find((l) => l.tipo === 'AUTH');
  assert.ok(auth, JSON.stringify(lotes));

  // Corrección que mueve las tres piezas de metadata Y el conjunto de periodos a la vez: quita P15,
  // agrega P17 y deja P14/P16 vivos. Las celdas quedan de tres orígenes distintos (heredada,
  // actualizada, recién insertada) — el peor caso para la coherencia.
  const { status, data } = await putLote({
    sesion_id: ctx.sesiones.jdt,
    lote_id: auth.lote_id,
    body: {
      planta_id: PLANTA_ID, hora: horaNueva, funcionariocnd: 'Gómez', detalle: `${TEST_TAG} e3-14-corregido`,
      periodos: [{ periodo: 14, valor_mw: 145 }, { periodo: 16, valor_mw: 160 }, { periodo: 17, valor_mw: 170 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const porLote = verificarCoherenciaDeLotes(await registrosMand());
  assert.equal(porLote.size, 2, 'el lote corregido sigue siendo UNO, y el otro no se contaminó');
  assert.deepEqual(
    porLote.get(auth.lote_id).map((c) => c.periodo).sort((a, b) => a - b),
    [14, 16, 17],
  );
  // El lote vecino conserva SU metadata: la corrección no se derrama al resto del día.
  const vecino = [...porLote.entries()].find(([id]) => id !== auth.lote_id)[1];
  assert.equal(vecino[0].detalle, `${TEST_TAG} e3-14-prueba`);
  assert.equal(vecino[0].hora_llamada, new Date(`${HOY}T${horaVieja}:00.000-05:00`).toISOString());
  await cleanMand();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-058 · E2 — el asiento normalizado en el listado del día (REQ-04 §8.1).
//
// El texto lo arma el BACKEND con el motor de `utils/asientos/` y viaja en `lote.asiento`; el front
// solo lo pinta (respuesta 6). Lo que se fija acá es el CABLEADO —que el tipo, la unidad, los
// periodos con sus valores, el funcionario y la descripción del lote lleguen al motor y vuelvan
// armados—, no las plantillas: esas ya las cubren los 28 tests PUROS de `asientos.test.js`, que
// corren sin BD en 275 ms. Duplicarlas acá solo agregaría 25 minutos de suite.
//
// Los asientos nombran `TST` porque la suite opera sobre la planta-fixture: `unidadCanonica` no
// valida contra el catálogo a propósito (el motor es puro), así que la unidad sale tal cual llega.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('D-058 E2.1 — cada lote trae el asiento de SU tipo y la hora nunca va adentro del texto', async () => {
  await cleanMand();
  const horaAuth = horaBogotaMin(-15) ?? '00:00';
  const horaPrueba = horaBogotaMin(-5) ?? '00:01';

  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaAuth, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e2-auth`,
          // Mismo valor en los dos periodos → forma COMPACTA (`150 MW del P10 al P11`).
          periodos: [{ periodo: 10, valor_mw: 150 }, { periodo: 11, valor_mw: 150 }],
        },
        {
          // Sin `detalle`: es el caso NORMAL (D-056) y la frase tiene que terminar en el dato duro,
          // sin rótulo huérfano ni `undefined`.
          tipo: 'PRUEBA', hora: horaPrueba, funcionariocnd: null, detalle: null,
          periodos: [{ periodo: 12, valor_mw: 50 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  const auth = data.lotes.find((l) => l.tipo === 'AUTH');
  const prueba = data.lotes.find((l) => l.tipo === 'PRUEBA');
  assert.ok(auth && prueba, JSON.stringify(data.lotes));

  assert.equal(
    auth.asiento,
    `Se recibe llamada del CND (J. Pérez) autorizando ${PLANTA_ID} a generar 150 MW del P10 al P11. ${TEST_TAG} e2-auth.`,
  );
  assert.equal(prueba.asiento, `Se declara prueba de ${PLANTA_ID} a 50 MW en el P12.`);

  // La hora viaja SIEMPRE aparte: cada consumidor la ubica en su columna (el listado, la columna A
  // del F03). Si se colara en el texto, el Excel la imprimiría dos veces.
  assert.ok(auth.hora_llamada, 'el lote sí tiene hora_llamada, solo que fuera del asiento');
  assert.ok(!auth.asiento.includes(horaAuth), `la hora ${horaAuth} no puede estar en el asiento`);
  assert.ok(!/\d{1,2}:\d{2}/.test(auth.asiento), `el asiento no lleva ningún HH:MM: ${auth.asiento}`);
  await cleanMand();
});

test('D-058 E2.2 — con valores distintos el asiento los lista periodo por periodo', async () => {
  await cleanMand();
  // Contracara de la compactación: el endpoint tiene que entregarle al motor las celdas REALES del
  // lote, no un valor único. Si mandara solo el primero, este asiento saldría `109 MW del P10 al
  // P11` y publicaría una carga que nadie autorizó.
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Gómez', detalle: null,
        periodos: [{ periodo: 10, valor_mw: 109 }, { periodo: 11, valor_mw: 134 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 1);
  assert.equal(
    data.lotes[0].asiento,
    `Se recibe llamada del CND (Gómez) autorizando ${PLANTA_ID} a generar P10: 109 MW; P11: 134 MW.`,
  );
  await cleanMand();
});

test('D-058 E2.3 — un lote migrado por F32.A1 (sin hora_llamada) igual trae su asiento', async () => {
  await cleanMand();
  // La clave `hora_llamada` está AUSENTE, no en null (D-056 (b)). El asiento no depende de ella:
  // el texto nunca la llevó, así que estos registros viejos se leen igual de bien.
  const loteMigrado = '00000000-0000-4000-8000-000000000058';
  await seedRegistroMand({
    tipo: 'AUTH', periodo: 9, hora: null, valor: 77, lote_id: loteMigrado,
    funcionariocnd: 'CND-migrado', detalle: `${TEST_TAG} e2-migrado`,
  });

  const { status, data } = await getLotes({ sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.lotes.length, 1);
  assert.equal(data.lotes[0].hora_llamada, null, 'sigue sin hora, como lo dejó la migración');
  assert.equal(
    data.lotes[0].asiento,
    `Se recibe llamada del CND (CND-migrado) autorizando ${PLANTA_ID} a generar 77 MW en el P9. ${TEST_TAG} e2-migrado.`,
  );
  await cleanMand();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-058 · E4 — el lote registrado se asienta en SALAJDT y SALAING (REQ-02).
//
// Estos tests NO corren sobre `TEST_PLANTA`: RN-02.e la excluye del reflejo a propósito (si
// reflejara, cada `npm test` sembraría asientos de prueba en las bitácoras de Sala sobre la BD
// productiva, D-030). Corren sobre `TEST_PLANTA_REFLEJO`, la segunda planta-fixture — sembrada con
// `activa = 0`, invisible en el selector del login y rechazada por `validarPlantaOperable`, así que
// ningún operador puede verla ni entrar a ella. Ver `tests/helpers.js`.
//
// El caso "TEST_PLANTA no refleja" sí se prueba, con la sesión de siempre (E4.5).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

let ctxReflejo;
async function sesionReflejo() {
  if (!ctxReflejo) ctxReflejo = await setupSesionReflejo();
  return ctxReflejo;
}

async function lotesReflejo(sesion_id) {
  const r = await call('GET', `/api/sala-de-mando/lotes?planta_id=${TEST_PLANTA_REFLEJO}`, { sesion_id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.lotes;
}

// Limpieza de la planta-fixture del reflejo. Acotada a `TEST_PLANTA_REFLEJO` y SIN parámetro de
// planta, igual que `cleanMand` (D-055): imposible apuntarla a GEC3/GEC32 por error. Barre TODA la
// planta y no solo MAND —sin filtrar por `bitacora_id`— porque el reflejo escribe en dos bitácoras
// más que el origen y una copia mal dirigida tiene que quedar limpia igual.
async function cleanReflejo() {
  assert.equal(TEST_PLANTA_REFLEJO, 'TSR', 'cleanReflejo solo puede correr sobre la planta-fixture');
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.evento_dashboard WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE planta_id = @p;
      DELETE FROM bitacora.mand_cierre_log WHERE planta_id = @p;
    `);
}

// Las COPIAS de un lote: se buscan por `campos_extra.origen_lote_id`, nunca por `registro_id` — la
// copia también migra al histórico y no hay FK posible (D-055 (c)). Trae el `bitacora_id` del tipo
// de evento aparte del de la fila: compararlos ES el guard de coherencia de D-053.
async function copiasDelLote(lote_id) {
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('lote', sql.NVarChar(64), lote_id)
    .query(`
      SELECT ra.registro_id, ra.bitacora_id, ra.detalle, ra.fecha_evento, ra.turno, ra.turno_id,
             ra.estado, ra.creado_por, ra.modificado_por,
             b.codigo AS bitacora_codigo,
             te.nombre AS tipo_nombre, te.bitacora_id AS tipo_bitacora_id, te.seleccionable,
             JSON_VALUE(ra.campos_extra, '$.origen_bitacora') AS origen_bitacora,
             JSON_VALUE(ra.campos_extra, '$.origen_lote_id')  AS origen_lote_id
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.planta_id = @p
        AND JSON_VALUE(ra.campos_extra, '$.origen_lote_id') = @lote
      ORDER BY b.codigo
    `);
  return r.recordset;
}

// Todas las filas de Sala de la planta-fixture, reflejadas o no. Sirve para afirmar AUSENCIA.
async function registrosSalaReflejo() {
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      SELECT ra.registro_id, b.codigo AS bitacora_codigo, ra.detalle,
             JSON_VALUE(ra.campos_extra, '$.origen_lote_id') AS origen_lote_id
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.planta_id = @p AND b.codigo IN ('SALAJDT', 'SALAING', 'SALAOP')
    `);
  return r.recordset;
}

test('D-058 E4.1 — un lote crea DOS copias (SALAJDT + SALAING) con el mismo origen_lote_id; SALAOP ninguna', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e4-1`,
        periodos: [{ periodo: 10, valor_mw: 150 }, { periodo: 11, valor_mw: 150 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const lotes = await lotesReflejo(s.sesion_id);
  assert.equal(lotes.length, 1, JSON.stringify(lotes));
  const copias = await copiasDelLote(lotes[0].lote_id);

  assert.equal(copias.length, 2, `deben ser exactamente dos copias: ${JSON.stringify(copias)}`);
  assert.deepEqual(copias.map((c) => c.bitacora_codigo), ['SALAING', 'SALAJDT'],
    'las dos bitácoras de Sala, sin importar cuál de los dos cargos originó el evento (RQ-02.2)');
  for (const c of copias) {
    assert.equal(c.origen_lote_id, lotes[0].lote_id, 'el vínculo con el origen es por LOTE');
    assert.equal(c.origen_bitacora, 'MAND');
    assert.equal(c.estado, 'borrador');
    assert.equal(c.modificado_por, null, 'nace sin corregir');
    // D-053: el tipo_evento TIENE que pertenecer a la bitácora de la fila. No hay FK ni CHECK que lo
    // garantice y el drift es invisible hasta que alguien abre el editor.
    assert.equal(c.tipo_bitacora_id, c.bitacora_id, `tipo_evento de otra bitácora en ${c.bitacora_codigo}`);
    assert.equal(c.tipo_nombre, 'Autorización', 'el nombre literal del catálogo de MAND');
    assert.equal(c.seleccionable, false, 'el tipo espejo no es tecleable a mano (E3)');
  }

  // RQ-02.3: SALAOP queda fuera. Se verifica sobre TODAS las filas de Sala de la fixture, no solo
  // sobre las del lote: una copia mal dirigida aparecería igual acá.
  const enSala = await registrosSalaReflejo();
  assert.equal(enSala.filter((r) => r.bitacora_codigo === 'SALAOP').length, 0,
    `SALAOP no recibe copia: ${JSON.stringify(enSala)}`);
  assert.equal(enSala.length, 2, 'y no se escribió nada más en Sala');
  await cleanReflejo();
});

test('D-058 E4.2 — el detalle de la copia ES el asiento del listado, con la hora y el autor del origen', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const hora = horaBogotaMin(-7) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'REDESP', hora, funcionariocnd: 'ignorado', detalle: `${TEST_TAG} e4-2`,
        periodos: [{ periodo: periodoRedespLibre(), valor_mw: 120 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const lote = (await lotesReflejo(s.sesion_id))[0];
  const copias = await copiasDelLote(lote.lote_id);
  assert.equal(copias.length, 2);

  for (const c of copias) {
    // FUENTE ÚNICA: el listado del día y la bitácora de Sala no pueden decir cosas distintas del
    // mismo evento. Las dos salidas vienen del mismo motor (`utils/asientos/`), no de dos plantillas.
    assert.equal(c.detalle, lote.asiento, 'la copia dice EXACTAMENTE lo que muestra el listado');
    assert.ok(c.detalle.includes(`redespacho para ${TEST_PLANTA_REFLEJO}`), c.detalle);

    // `fecha_evento` = la HORA DE LA LLAMADA, no el instante de la escritura (dato narrativo).
    assert.equal(new Date(c.fecha_evento).toISOString(), lote.hora_llamada,
      'la copia se asienta a la hora en que llamó el CND');
    // RN-02.c: el autor es el del ORIGEN, nunca SISTEMA.
    assert.equal(c.creado_por, s.usuario_id);
    assert.ok(c.turno === 1 || c.turno === 2);
  }
  await cleanReflejo();
});

test('D-058 E4.3 — dos lotes en un mismo Guardar → dos pares de copias, cada uno con su texto', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaBogotaMin(-20) ?? '00:00', funcionariocnd: 'Gómez',
          detalle: null, periodos: [{ periodo: 8, valor_mw: 109 }, { periodo: 9, valor_mw: 134 }],
        },
        {
          tipo: 'PRUEBA', hora: horaBogotaMin(-3) ?? '00:01', funcionariocnd: null,
          detalle: `${TEST_TAG} e4-3`, periodos: [{ periodo: 12, valor_mw: 50 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const lotes = await lotesReflejo(s.sesion_id);
  assert.equal(lotes.length, 2);
  const auth = lotes.find((l) => l.tipo === 'AUTH');
  const prueba = lotes.find((l) => l.tipo === 'PRUEBA');

  const copiasAuth = await copiasDelLote(auth.lote_id);
  const copiasPrueba = await copiasDelLote(prueba.lote_id);
  assert.equal(copiasAuth.length, 2);
  assert.equal(copiasPrueba.length, 2);
  assert.equal((await registrosSalaReflejo()).length, 4, 'cuatro copias en total, ni una de más');

  // Cada par lleva SU tipo espejo y SU texto: un reflejo "por Guardar" en vez de "por lote" habría
  // mezclado los dos eventos en un solo renglón.
  for (const c of copiasAuth) {
    assert.equal(c.tipo_nombre, 'Autorización');
    assert.equal(c.detalle, auth.asiento);
    assert.ok(c.detalle.includes('P8: 109 MW; P9: 134 MW'), c.detalle);
  }
  for (const c of copiasPrueba) {
    assert.equal(c.tipo_nombre, 'Pruebas');
    assert.equal(c.detalle, prueba.asiento);
    assert.ok(c.detalle.startsWith(`Se declara prueba de ${TEST_PLANTA_REFLEJO}`), c.detalle);
  }
  await cleanReflejo();
});

test('D-058 E4.4 — turno_id de la copia sale del turno ABIERTO de la unidad, no del periodo', async () => {
  // La decisión con la razón más larga de la etapa: `fecha_evento` es narrativo y `turno_id` NO —
  // es el puntero de archivado (D-045). Una copia apuntando a un turno ya CERRADO no la archiva
  // nadie y queda viva en `registro_activo` para siempre.
  //
  // El contraste se construye con un periodo que NO cae en el turno abierto: su celda MAND resuelve
  // el `turno_id` por `fechaOperativaDePeriodo` (D-055 (b)) → una cabecera que la fixture no tiene,
  // así que queda en NULL. La copia, en cambio, tiene que apuntar al turno ABIERTO.
  // El periodo se elige AL CORRER, no se hardcodea: cuál de los tres bloques coincide con el turno
  // abierto depende de la hora, y un P3 fijo colisiona con la ventana entre 00:00 y 06:00 Bogotá.
  await cleanReflejo();
  const db = await getDB();
  const s = await sesionReflejo();
  const abierto = await resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO);
  assert.ok(abierto?.turno_unidad_id, 'la fixture necesita un turno ABIERTO para este caso');
  const diaAbierto = new Date(abierto.fecha_operativa).toISOString().slice(0, 10);
  const periodoAjeno = [3, 12, 20].find((p) => (
    fechaOperativaDePeriodo(HOY, p) !== diaAbierto || turnoFromPeriodo(p) !== abierto.turno
  ));
  assert.ok(periodoAjeno, 'siempre hay un bloque de la grilla fuera del turno abierto');

  try {
    const alta = await postGuardar({
      sesion_id: s.sesion_id,
      body: {
        planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
        filas: [{
          tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e4-4`,
          periodos: [{ periodo: periodoAjeno, valor_mw: 90 }],
        }],
      },
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.data));

    const lote = (await lotesReflejo(s.sesion_id))[0];
    const celda = (await db.request()
      .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
      .input('lote', sql.NVarChar(64), lote.lote_id)
      .query(`
        SELECT turno_id FROM bitacora.registro_activo
        WHERE planta_id = @p AND JSON_VALUE(campos_extra, '$.lote_id') = @lote
      `)).recordset[0];
    assert.equal(celda.turno_id, null,
      `la celda MAND del P${periodoAjeno} resuelve por periodo → cabecera inexistente en la fixture`);

    for (const c of await copiasDelLote(lote.lote_id)) {
      assert.equal(c.turno_id, abierto.turno_unidad_id,
        'la copia se archiva con el turno ABIERTO, no con el del periodo');
    }
  } finally {
    // Los registros primero: `registro_activo.turno_id` tiene FK a `turno_unidad`.
    await cleanReflejo();
    await db.request()
      .input('id', sql.Int, abierto.turno_unidad_id)
      .query(`DELETE FROM bitacora.rotacion_cumplimiento WHERE turno_id = @id; DELETE FROM bitacora.rotacion_control WHERE turno_id = @id; DELETE FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
  }
});

test('D-058 E4.5 — la planta-fixture TEST_PLANTA no genera copias (RN-02.e)', async () => {
  await cleanMand();
  const db = await getDB();
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e4-5`,
        periodos: [{ periodo: 10, valor_mw: 100 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  // La suite corre contra la BD PRODUCTIVA (D-030): sin este guard, cada corrida dejaría asientos de
  // prueba en las bitácoras de Sala. Se mira TODA la planta-fixture, no solo el lote.
  const enSala = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT COUNT(*) AS n
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.planta_id = @p AND b.codigo IN ('SALAJDT', 'SALAING', 'SALAOP')
    `);
  assert.equal(enSala.recordset[0].n, 0, 'TEST_PLANTA no refleja');
  await cleanMand();
});

test('D-058 E4.6 — si el reflejo falla, el lote tampoco queda (atomicidad, criterio 8)', async () => {
  await cleanReflejo();
  const db = await getDB();
  const s = await sesionReflejo();
  const lote_id = randomUUID();
  const tipoAuth = await tipoEventoIdMand('AUTH');

  // Reproduce la composición del endpoint —celdas + reflejo en UNA transacción— y le inyecta una
  // falla REAL en el INSERT de la copia: `creado_por` inexistente viola la FK a lov_bit.usuario.
  // No se simula con un throw temprano a propósito: lo que hay que probar es que un error de SQL a
  // mitad del reflejo se propaga y revierte TAMBIÉN el origen.
  const tx = new sql.Transaction(db);
  await tx.begin();
  let fallo = null;
  try {
    await new sql.Request(tx)
      .input('m', sql.Int, MAND_BITACORA_ID)
      .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
      .input('te', sql.Int, tipoAuth)
      .input('ce', sql.NVarChar(sql.MAX), JSON.stringify({
        periodo: 10, valor_mw: 100, funcionariocnd: 'Pérez', lote_id,
        hora_llamada: new Date().toISOString(),
      }))
      .input('creado_por', sql.Int, s.usuario_id)
      .query(`
        INSERT INTO bitacora.registro_activo
          (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
        VALUES (@m, @p, SYSUTCDATETIME(), 1, 'atomicidad', @ce, @te, 'borrador', '[]', '[]', '[]', @creado_por)
      `);
    await crearReflejoLote(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      lote_id,
      tipo: 'AUTH',
      periodos: [{ periodo: 10, valor_mw: 100 }],
      funcionariocnd: 'Pérez',
      detalle: null,
      hora_llamada: new Date().toISOString(),
      creado_por: 2147483000, // no existe → viola la FK dentro del reflejo
      snapshots: { ingenieros_snapshot: '[]', jdts_snapshot: '[]', jefes_snapshot: '[]' },
    });
    await tx.commit();
  } catch (e) {
    fallo = e;
    await tx.rollback();
  }

  assert.ok(fallo, 'el reflejo NO puede tragarse el error: eso dejaría un origen sin copias');
  const r = await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id = @p`);
  assert.equal(r.recordset[0].n, 0, 'ni el lote ni las copias: o los tres lados o ninguno (RQ-02.9)');
  await cleanReflejo();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D-058 · E5 — corregir o borrar el lote CASCADEA a sus copias de Sala (REQ-02 / RQ-04.14).
//
// Cubre los criterios 8 y 9 de REQ-04 y el 5, 6 y 8 de REQ-02, que D-057 dejó explícitamente fuera
// de alcance ("las copias no existen todavía"). Corren sobre `TEST_PLANTA_REFLEJO` por la misma
// razón que E4: `TEST_PLANTA` no refleja por diseño (RN-02.e).
//
// Decisión H: corregir REGENERA el texto de las copias; no se agrega un renglón de corrección. La
// bitácora de Sala muestra el estado ACTUAL y el rastro vive en `modificado_por`/`modificado_en`.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Siembra un lote MAND completo en la planta-fixture del reflejo Y sus dos copias, en UNA sola
// transacción — igual que hace `POST /guardar`. Hace falta para el estado inicial que el endpoint
// rechaza por diseño (REDESP en periodo PASADO, lock D-016): sin esto no hay forma de llegar por
// HTTP a lo que la corrección sí tiene que saber manejar.
//
// Las copias las crea el MÓDULO DE PRODUCCIÓN, nunca un INSERT del test: sembradas a mano, el test
// estaría probando su propia idea de cómo debe verse una copia en vez de la del código.
async function seedLoteReflejo({ tipo, hora, periodos, detalle = null, funcionariocnd = null }) {
  const db = await getDB();
  const s = await sesionReflejo();
  const teId = await tipoEventoIdMand(tipo);
  const lote_id = randomUUID();
  const hora_llamada = new Date(`${HOY}T${hora}:00-05:00`).toISOString();
  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    for (const { periodo, valor_mw } of periodos) {
      await new sql.Request(tx)
        .input('mand', sql.Int, MAND_BITACORA_ID)
        .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
        .input('fe', sql.DateTime2, new Date(`${HOY}T12:00:00-05:00`))
        .input('turno', sql.TinyInt, turnoFromPeriodo(periodo))
        .input('detalle', sql.NVarChar(sql.MAX), detalle)
        .input('ce', sql.NVarChar(sql.MAX), JSON.stringify({
          periodo, valor_mw, funcionariocnd, lote_id, hora_llamada,
        }))
        .input('te', sql.Int, teId)
        .input('cp', sql.Int, s.usuario_id)
        .query(`
          INSERT INTO bitacora.registro_activo
            (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
             estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
          VALUES (@mand, @p, @fe, @turno, @detalle, @ce, @te, 'borrador', '[]', '[]', '[]', @cp)
        `);
    }
    await crearReflejoLote(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      lote_id, tipo, periodos, funcionariocnd, detalle, hora_llamada,
      creado_por: s.usuario_id,
      snapshots: { ingenieros_snapshot: '[]', jdts_snapshot: '[]', jefes_snapshot: '[]' },
    });
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch {}
    throw e;
  }
  return { lote_id, hora_llamada };
}

test('D-058 E5.1 — el PUT reescribe el asiento en las DOS copias, sin reinsertarlas [criterio 8 de REQ-04]', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const hora = horaBogotaMin(-15) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'J. Pérez', detalle: `${TEST_TAG} e5-1`,
        periodos: [{ periodo: 10, valor_mw: 100 }, { periodo: 11, valor_mw: 100 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const previo = (await lotesReflejo(s.sesion_id))[0];
  const copiasAntes = await copiasDelLote(previo.lote_id);
  assert.equal(copiasAntes.length, 2);
  assert.ok(copiasAntes[0].detalle.includes('100 MW del P10 al P11'), copiasAntes[0].detalle);

  // P10 cambia de valor, P12 se agrega y cambia la descripción: el asiento pasa de compacto
  // (`100 MW del P10 al P11`) a lista por periodo, que es la prueba de que se RE-RENDERIZÓ y no de
  // que se le pegó un texto encima.
  const { status, data } = await putLote({
    sesion_id: s.sesion_id,
    lote_id: previo.lote_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, hora, funcionariocnd: 'J. Pérez',
      detalle: `${TEST_TAG} e5-1-corregido`,
      periodos: [
        { periodo: 10, valor_mw: 150 }, { periodo: 11, valor_mw: 100 }, { periodo: 12, valor_mw: 164 },
      ],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const lote = (await lotesReflejo(s.sesion_id))[0];
  const copias = await copiasDelLote(previo.lote_id);
  assert.equal(copias.length, 2, 'siguen siendo DOS: la corrección no duplica el asiento (decisión H)');
  assert.deepEqual(copias.map((c) => c.bitacora_codigo), ['SALAING', 'SALAJDT']);
  assert.deepEqual(
    copias.map((c) => c.registro_id).sort((a, b) => a - b),
    copiasAntes.map((c) => c.registro_id).sort((a, b) => a - b),
    'la copia se ACTUALIZA en su sitio: reinsertarla perdería su identidad en el histórico',
  );

  for (const c of copias) {
    assert.equal(c.detalle, lote.asiento, 'la copia dice EXACTAMENTE lo que muestra el listado corregido');
    assert.ok(c.detalle.includes('P10: 150 MW; P11: 100 MW; P12: 164 MW'), c.detalle);
    assert.ok(c.detalle.includes('e5-1-corregido'), 'la descripción nueva viaja al asiento');
    assert.ok(!c.detalle.includes('100 MW del P10 al P11'), 'el texto viejo no sobrevive');
    // RN-02.c: la autoría original NO se pisa; quién corrigió queda en `modificado_por`.
    assert.equal(c.creado_por, s.usuario_id);
    assert.equal(c.modificado_por, s.usuario_id, 'la corrección sella la copia');
  }
  await cleanReflejo();
});

test('D-058 E5.2 — un PUT que solo mueve la HORA mueve la fecha_evento de las copias, sin tocar el texto', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const horaInicial = horaBogotaMin(-40) ?? '00:00';
  const horaNueva = horaBogotaMin(-5) ?? '00:05';
  if (horaInicial === horaNueva) return; // borde del día: no hay dos horas distintas que comparar
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'PRUEBA', hora: horaInicial, funcionariocnd: null, detalle: `${TEST_TAG} e5-2`,
        periodos: [{ periodo: 9, valor_mw: 50 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const previo = (await lotesReflejo(s.sesion_id))[0];
  const antes = await copiasDelLote(previo.lote_id);

  const { status, data } = await putLote({
    sesion_id: s.sesion_id,
    lote_id: previo.lote_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, hora: horaNueva, funcionariocnd: null,
      detalle: `${TEST_TAG} e5-2`, periodos: [{ periodo: 9, valor_mw: 50 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const lote = (await lotesReflejo(s.sesion_id))[0];
  for (const c of await copiasDelLote(previo.lote_id)) {
    // La HORA NO va dentro del asiento (es columna del listado y del F03), así que el texto queda
    // idéntico y lo que se mueve es `fecha_evento` — que es donde el F03 y el listado la leen.
    assert.equal(c.detalle, lote.asiento);
    assert.equal(c.detalle, antes[0].detalle, 'el texto no cambia: la hora nunca estuvo adentro');
    assert.equal(new Date(c.fecha_evento).toISOString(), lote.hora_llamada,
      'la copia se movió a la hora corregida');
    assert.notEqual(new Date(c.fecha_evento).toISOString(),
      new Date(antes[0].fecha_evento).toISOString());
    assert.equal(c.modificado_por, s.usuario_id, 'mover la hora también sella la copia');
  }
  await cleanReflejo();
});

test('D-058 E5.3 — con REDESP bloqueado, cambiar solo el detalle SÍ reescribe las copias', async () => {
  const pAct = periodoActual();
  if (pAct <= 1) return; // sin periodo pasado no hay lock que ejercitar
  await cleanReflejo();
  const s = await sesionReflejo();
  const pPasado = pAct - 1;
  const hora = horaBogotaMin(-30) ?? '00:00';

  // Estado inicial imposible de producir por HTTP (el POST rechaza REDESP en periodo pasado): se
  // siembra el lote CON sus copias, igual que lo haría la captura.
  const { lote_id } = await seedLoteReflejo({
    tipo: 'REDESP', hora, detalle: `${TEST_TAG} e5-3`,
    periodos: [{ periodo: pPasado, valor_mw: 120 }],
  });
  const antes = await copiasDelLote(lote_id);
  assert.equal(antes.length, 2, 'el lote sembrado arranca con sus dos copias');

  // Mismo valor y misma hora, otra descripción: el lock de D-057 actúa sobre el DELTA de VALOR, así
  // que esto pasa — el lock protege lo despachado, jamás el comentario (D-055 (a)).
  const { status, data } = await putLote({
    sesion_id: s.sesion_id,
    lote_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, hora, funcionariocnd: null,
      detalle: `${TEST_TAG} e5-3-aclaracion`, periodos: [{ periodo: pPasado, valor_mw: 120 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const lote = (await lotesReflejo(s.sesion_id))[0];
  for (const c of await copiasDelLote(lote_id)) {
    assert.equal(c.detalle, lote.asiento);
    assert.ok(c.detalle.includes('e5-3-aclaracion'), c.detalle);
    assert.ok(!c.detalle.includes('e5-3.'), 'la aclaración REEMPLAZA, no se acumula');
    assert.ok(c.detalle.includes(`120 MW en el P${pPasado}`), 'el valor bloqueado sigue intacto');
    assert.equal(c.modificado_por, s.usuario_id);
  }
  await cleanReflejo();
});

test('D-058 E5.4 — el DELETE del lote borra las DOS copias [criterio 9 de REQ-04]', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [
        {
          tipo: 'AUTH', hora: horaBogotaMin(-25) ?? '00:00', funcionariocnd: 'Gómez',
          detalle: `${TEST_TAG} e5-4-a`, periodos: [{ periodo: 8, valor_mw: 90 }],
        },
        {
          tipo: 'PRUEBA', hora: horaBogotaMin(-4) ?? '00:01', funcionariocnd: null,
          detalle: `${TEST_TAG} e5-4-b`, periodos: [{ periodo: 13, valor_mw: 40 }],
        },
      ],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const lotes = await lotesReflejo(s.sesion_id);
  const auth = lotes.find((l) => l.tipo === 'AUTH');
  const prueba = lotes.find((l) => l.tipo === 'PRUEBA');
  assert.equal((await registrosSalaReflejo()).length, 4, 'cuatro copias antes de borrar');

  const del = await delLote({
    sesion_id: s.sesion_id, lote_id: auth.lote_id, planta_id: TEST_PLANTA_REFLEJO,
  });
  assert.equal(del.status, 200, JSON.stringify(del.data));

  assert.equal((await copiasDelLote(auth.lote_id)).length, 0,
    'borrado REAL, no anulación: un renglón tachado en la bitácora del turno confunde (RN-04.c)');
  // Y solo las suyas: la cascada va acotada por `origen_lote_id`, nunca por planta ni por bitácora.
  assert.equal((await copiasDelLote(prueba.lote_id)).length, 2, 'el otro lote conserva sus copias');
  const enSala = await registrosSalaReflejo();
  assert.equal(enSala.length, 2, JSON.stringify(enSala));
  await cleanReflejo();
});

test('D-058 E5.5 — si el cierre de turno ya archivó la copia, el PUT igual responde 200 y el histórico no se toca', async () => {
  await cleanReflejo();
  const db = await getDB();
  const s = await sesionReflejo();
  const hora = horaBogotaMin(-18) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e5-5`,
        periodos: [{ periodo: 14, valor_mw: 80 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const previo = (await lotesReflejo(s.sesion_id))[0];
  const copias = await copiasDelLote(previo.lote_id);
  assert.equal(copias.length, 2);

  // Simula el cierre de turno de Sala sobre UNA de las dos copias: pasa al histórico (mismo shape
  // que archiva `cerrarTurno`) y desaparece de `registro_activo`. La otra queda viva, así que el
  // mismo PUT ejercita los dos caminos a la vez.
  const archivada = copias[0].registro_id;
  await db.request()
    .input('r', sql.Int, archivada)
    .input('cp', sql.Int, s.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_historico
        (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra,
         tipo_evento_id, estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por,
         creado_en, modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
      SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra,
             tipo_evento_id, 'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot,
             creado_por, creado_en, modificado_por, modificado_en, @cp, SYSUTCDATETIME(),
             CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)
      FROM bitacora.registro_activo WHERE registro_id = @r;
      DELETE FROM bitacora.registro_activo WHERE registro_id = @r;
    `);
  const histAntes = (await db.request()
    .input('r', sql.Int, archivada)
    .query(`SELECT detalle, fecha_evento, modificado_por FROM bitacora.registro_historico WHERE registro_id = @r`)
  ).recordset[0];
  assert.ok(histAntes, 'la copia quedó archivada');

  // `rowsAffected = 0` sobre la archivada NO es error, y rechazar la corrección con 409 volvería
  // incorregible un lote a las 18:01 por el estado de su reflejo (criterio 12 de REQ-04: MAND está
  // exenta de los gates de turno).
  const { status, data } = await putLote({
    sesion_id: s.sesion_id,
    lote_id: previo.lote_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, hora, funcionariocnd: 'Pérez',
      detalle: `${TEST_TAG} e5-5-corregido`, periodos: [{ periodo: 14, valor_mw: 95 }],
    },
  });
  assert.equal(status, 200, JSON.stringify(data));

  const histDespues = (await db.request()
    .input('r', sql.Int, archivada)
    .query(`SELECT detalle, fecha_evento, modificado_por FROM bitacora.registro_historico WHERE registro_id = @r`)
  ).recordset[0];
  assert.deepEqual(
    [histDespues.detalle, histDespues.fecha_evento.getTime(), histDespues.modificado_por],
    [histAntes.detalle, histAntes.fecha_evento.getTime(), histAntes.modificado_por],
    'el histórico no se reescribe (RF-032)',
  );

  const vivas = await copiasDelLote(previo.lote_id);
  assert.equal(vivas.length, 1, 'quedó una sola copia viva');
  assert.ok(vivas[0].detalle.includes('95 MW'), 'y esa sí se corrigió');
  assert.ok(vivas[0].detalle.includes('e5-5-corregido'), vivas[0].detalle);

  // Y borrar el lote tampoco se traba con la copia archivada.
  const del = await delLote({
    sesion_id: s.sesion_id, lote_id: previo.lote_id, planta_id: TEST_PLANTA_REFLEJO,
  });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((await copiasDelLote(previo.lote_id)).length, 0);
  assert.equal(
    (await db.request().input('r', sql.Int, archivada)
      .query(`SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE registro_id = @r`)
    ).recordset[0].n,
    1,
    'la copia archivada sigue en el histórico: el borrado del origen no lo alcanza',
  );
  await cleanReflejo();
});

test('D-058 E5.6 — una corrección que falla en el reflejo no queda aplicada a medias [criterio 14 de REQ-04]', async () => {
  await cleanReflejo();
  const db = await getDB();
  const s = await sesionReflejo();
  const hora = horaBogotaMin(-22) ?? '00:00';
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: {
      planta_id: TEST_PLANTA_REFLEJO, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e5-6`,
        periodos: [{ periodo: 15, valor_mw: 70 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const previo = (await lotesReflejo(s.sesion_id))[0];
  const rid = previo.periodos[0].registro_id;
  const copiasAntes = await copiasDelLote(previo.lote_id);
  const huella = copiasAntes.map((c) => [c.registro_id, c.detalle, c.modificado_por]);

  // Reproduce la composición del PUT —origen + reflejo en UNA transacción— y le inyecta una falla
  // REAL dentro del reflejo: `modificado_por` inexistente viola la FK a lov_bit.usuario. No se
  // simula con un throw temprano a propósito: lo que hay que probar es que un error de SQL a mitad
  // de la cascada revierte TAMBIÉN la corrección del origen.
  const tx = new sql.Transaction(db);
  await tx.begin();
  let fallo = null;
  try {
    await new sql.Request(tx)
      .input('registro_id', sql.Int, rid)
      .input('detalle', sql.NVarChar(sql.MAX), `${TEST_TAG} e5-6-no-debe-aterrizar`)
      .query(`UPDATE bitacora.registro_activo SET detalle = @detalle WHERE registro_id = @registro_id`);
    await actualizarReflejoLote(tx, {
      planta_id: TEST_PLANTA_REFLEJO,
      lote_id: previo.lote_id,
      tipo: 'AUTH',
      periodos: [{ periodo: 15, valor_mw: 71 }], // cambia el texto → el CASE sí sella → la FK truena
      funcionariocnd: 'Pérez',
      detalle: `${TEST_TAG} e5-6-no-debe-aterrizar`,
      hora_llamada: previo.hora_llamada,
      modificado_por: 2147483000, // no existe → viola la FK dentro del reflejo
    });
    await tx.commit();
  } catch (e) {
    fallo = e;
    try { await tx.rollback(); } catch {}
  }

  assert.ok(fallo, 'el reflejo NO puede tragarse el error');
  const celda = (await db.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('lote', sql.NVarChar(64), previo.lote_id)
    .query(`
      SELECT detalle FROM bitacora.registro_activo
      WHERE planta_id = @p AND JSON_VALUE(campos_extra, '$.lote_id') = @lote
    `)).recordset[0];
  assert.equal(celda.detalle, `${TEST_TAG} e5-6`, 'el origen no quedó corregido');
  assert.deepEqual(
    (await copiasDelLote(previo.lote_id)).map((c) => [c.registro_id, c.detalle, c.modificado_por]),
    huella,
    'ni las copias: o los tres lados o ninguno (RQ-02.9)',
  );
  await cleanReflejo();
});

test('D-058 E5.7 — un PUT que no cambia nada no sella las copias (paridad con el origen)', async () => {
  await cleanReflejo();
  const s = await sesionReflejo();
  const hora = horaBogotaMin(-10) ?? '00:00';
  const cuerpo = {
    planta_id: TEST_PLANTA_REFLEJO, hora, funcionariocnd: 'Pérez', detalle: `${TEST_TAG} e5-7`,
    periodos: [{ periodo: 16, valor_mw: 60 }],
  };
  const alta = await postGuardar({
    sesion_id: s.sesion_id,
    body: { planta_id: TEST_PLANTA_REFLEJO, fecha: HOY, filas: [{ tipo: 'AUTH', ...cuerpo }] },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));
  const previo = (await lotesReflejo(s.sesion_id))[0];

  // El mismo lote, reenviado igual. El origen no sella nada (D-057, decisión 2: solo se marcan las
  // celdas AFECTADAS) y la copia sigue el mismo criterio — si sellara igual, la bitácora de Sala
  // diría que alguien corrigió un asiento que nadie tocó.
  const { status, data } = await putLote({ sesion_id: s.sesion_id, lote_id: previo.lote_id, body: cuerpo });
  assert.equal(status, 200, JSON.stringify(data));

  for (const c of await copiasDelLote(previo.lote_id)) {
    assert.equal(c.modificado_por, null, 'sin cambio real no hay sello de corrección');
    assert.equal(c.detalle, previo.asiento, 'y el texto es el mismo');
  }
  await cleanReflejo();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D-058 E9 — GET /api/sala-de-mando/reporte-mensual (REQ-06)
//
// La descarga del libro mensual GENE-F03. Es SOLO LECTURA: ningún test de este bloque escribe nada
// (el único que siembra —E9.7— lo hace para comprobar que la planta-fixture NO sale en el libro, y
// limpia con `cleanMand`).
// ════════════════════════════════════════════════════════════════════════════════════════════════

const MES_ACTUAL = HOY.slice(0, 7);

// `YYYY-MM` de `n` meses atrás del actual (Bogotá). Se calcula relativo a HOY y no se hardcodea un
// mes: un literal como '2026-05' se vuelve FUTURO —y el endpoint lo rechaza con `mes_futuro`— si
// alguien corre la suite antes de esa fecha, y el test fallaría por la razón equivocada.
function mesAtras(n) {
  const [y, m] = MES_ACTUAL.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Días de un mes `YYYY-MM`. `Date.UTC(y, m, 0)` es el día 0 del mes siguiente: resuelve febrero y
// los bisiestos sin tabla (mismo cálculo que `diasDelMes` en f03-datos.js).
function diasDe(mes) {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// El mes PASADO más reciente con exactamente `n` días. Busca hacia atrás para no depender de la
// fecha en que se corra la suite.
function mesPasadoCon(n) {
  for (let i = 1; i <= 14; i++) {
    const mes = mesAtras(i);
    if (diasDe(mes) === n) return mes;
  }
  throw new Error(`no se encontró un mes pasado de ${n} días`);
}

async function descargarLibro({ sesion_id, mes }) {
  const qs = mes === undefined ? '' : `?mes=${encodeURIComponent(mes)}`;
  return callBinario('GET', `/api/sala-de-mando/reporte-mensual${qs}`, { sesion_id });
}

// Nombres de las hojas, EN ORDEN, leídos del `xl/workbook.xml` del libro descargado.
function hojasDelLibro(buffer) {
  const zip = leerZip(buffer);
  const workbook = zip.get('xl/workbook.xml').toString('utf8');
  return [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
}

// Todo el XML de las hojas concatenado: sirve para preguntar si un texto aparece EN ALGÚN renglón
// del libro (sin importar en qué día ni en qué bloque cayó).
function textoDelLibro(buffer) {
  const zip = leerZip(buffer);
  let todo = '';
  for (const [nombre, datos] of zip) {
    if (nombre.startsWith('xl/worksheets/sheet')) todo += datos.toString('utf8');
  }
  return todo;
}

// Foto de las tablas que el reporte LEE. Sirve para probar RN-06.f / criterio 10: generar el libro
// no puede cambiar una sola fila.
async function fotoDeLaBD() {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT
      (SELECT COUNT(*) FROM bitacora.registro_activo)        AS activos,
      (SELECT COUNT(*) FROM bitacora.registro_historico)     AS historicos,
      (SELECT COUNT(*) FROM bitacora.evento_dashboard)       AS dashboard,
      (SELECT COUNT(*) FROM bitacora.disponibilidad_estado)  AS disponibilidad,
      (SELECT COUNT(*) FROM bitacora.mand_cierre_log)        AS cierres
  `);
  return r.recordset[0];
}

test('D-058 E9.1 — un cargo con solo puede_ver en MAND NO descarga: 403 [criterio 2 de REQ-06]', async () => {
  // El gate NO puede derivarse de la visibilidad: la matriz le da `puede_ver` en MAND a TODOS los
  // cargos (`WHEN b.codigo = 'MAND' THEN 1`), y este mismo cargo obtiene 200 en `GET /lotes`
  // (D-056 E4.5). Lo que lo separa es `puede_crear`, data-driven (RQ-06.11/12).
  const { status, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.ingQuim, mes: MES_ACTUAL });
  assert.equal(status, 403, buffer.toString('utf8').slice(0, 200));
  const cuerpo = JSON.parse(buffer.toString('utf8'));
  assert.equal(cuerpo.codigo, 'sin_permiso_descarga');

  // Contracara en la misma corrida: el mismo mes, con un cargo que sí registra, baja el archivo.
  const ok = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: MES_ACTUAL });
  assert.equal(ok.status, 200);
});

test('D-058 E9.2 — con puede_crear baja un .xlsx real, con el nombre del formato controlado', async () => {
  const { status, headers, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: MES_ACTUAL });
  assert.equal(status, 200, buffer.toString('utf8').slice(0, 200));
  assert.equal(
    headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const disposicion = headers.get('content-disposition');
  assert.ok(disposicion.startsWith('attachment;'), `se esperaba attachment: ${disposicion}`);
  // Las dos formas del nombre: el `filename*` en UTF-8 percent-encoded (la tilde de "operación") y
  // el `filename` ASCII de respaldo. Mandar la tilde cruda en un header la entrega como latin-1.
  assert.ok(
    disposicion.includes(`filename*=UTF-8''${MES_ACTUAL.replace('-', '_')}_OPG3-F03`),
    `sin filename* con el mes: ${disposicion}`,
  );
  assert.ok(disposicion.includes('operaci%C3%B3n.xlsx'), `la tilde no viajó codificada: ${disposicion}`);
  assert.ok(/filename="[\x20-\x7e]+"/.test(disposicion), `el respaldo no es ASCII puro: ${disposicion}`);

  // Es un ZIP de verdad (firma del local file header), no un JSON de error con status 200.
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const hojas = hojasDelLibro(buffer);
  assert.equal(hojas.length, diasDe(MES_ACTUAL), 'una hoja por día del mes en curso');
});

test('D-058 E9.3 — mes futuro → 400 mes_futuro (paridad con el fecha_futura de COMB)', async () => {
  const [y, m] = MES_ACTUAL.split('-').map(Number);
  const siguiente = new Date(Date.UTC(y, m, 1));
  const mesFuturo = `${siguiente.getUTCFullYear()}-${String(siguiente.getUTCMonth() + 1).padStart(2, '0')}`;

  const { status, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: mesFuturo });
  assert.equal(status, 400, buffer.toString('utf8').slice(0, 200));
  assert.equal(JSON.parse(buffer.toString('utf8')).codigo, 'mes_futuro');
});

test('D-058 E9.4 — mes mal formado → 400 mes_invalido; sin mes → el mes en curso', async () => {
  for (const mes of ['2026-13', '2026-00', '2026', 'julio', '2026-7']) {
    const { status, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes });
    assert.equal(status, 400, `mes "${mes}" debió rechazarse: ${buffer.toString('utf8').slice(0, 120)}`);
    assert.equal(JSON.parse(buffer.toString('utf8')).codigo, 'mes_invalido', `mes "${mes}"`);
  }
  // `mes` ausente cae al mes Bogotá en curso, misma paridad que la `fecha` de `GET /lotes` (y lo que
  // pide RQ-06.4). No es un 400: el caso normal del botón es "descargá el mes en curso".
  const sinMes = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: undefined });
  assert.equal(sinMes.status, 200, sinMes.buffer.toString('utf8').slice(0, 200));
  assert.equal(hojasDelLibro(sinMes.buffer).length, diasDe(MES_ACTUAL));
});

test('D-058 E9.5 — 31, 30 y 28 hojas según el mes, en orden y con el día por nombre [criterio 4]', async () => {
  for (const dias of [31, 30, 28]) {
    const mes = mesPasadoCon(dias);
    const { status, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes });
    assert.equal(status, 200, `${mes}: ${buffer.toString('utf8').slice(0, 200)}`);

    const hojas = hojasDelLibro(buffer);
    assert.equal(hojas.length, dias, `${mes} debe traer ${dias} hojas`);
    // Ascendente y sin huecos: la hoja i es el día i del mes. Un día sin eventos igual está presente
    // (RQ-06.8) — con la adopción actual, la mayoría del libro sale así, y es correcto.
    const esperadas = Array.from({ length: dias }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
    assert.deepEqual(hojas, esperadas, `${mes}: las hojas deben ir del día 1 al ${dias}`);
  }
});

test('D-058 E9.6 — la descarga no cambia NADA en la BD [criterio 10 / RN-06.f]', async () => {
  const antes = await fotoDeLaBD();
  const { status } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: MES_ACTUAL });
  assert.equal(status, 200);
  assert.deepEqual(await fotoDeLaBD(), antes, 'generar el libro es solo lectura');
});

test('D-058 E9.7 — la planta-fixture no sale en el libro [RN-06.g]', async () => {
  await cleanMand();
  // Un lote REAL sobre 'TST', creado por el endpoint de captura. Si el alcance del libro fuera "todas
  // las plantas", su asiento —que arrastra el TEST_TAG dentro del detalle— aparecería en la hoja de
  // hoy. `PLANTAS_F03` es lo que lo deja afuera, sin que producción nombre ninguna fixture.
  const alta = await postGuardar({
    sesion_id: ctx.sesiones.jdt,
    body: {
      planta_id: PLANTA_ID, fecha: HOY,
      filas: [{
        tipo: 'AUTH', hora: HORA_OK, detalle: `${TEST_TAG} e9-tst`, funcionariocnd: 'Pérez',
        periodos: [{ periodo: 7, valor_mw: 120 }],
      }],
    },
  });
  assert.equal(alta.status, 200, JSON.stringify(alta.data));

  const { status, buffer } = await descargarLibro({ sesion_id: ctx.sesiones.jdt, mes: MES_ACTUAL });
  assert.equal(status, 200);
  assert.ok(
    !textoDelLibro(buffer).includes(TEST_TAG),
    'un registro de la planta-fixture se coló en el libro del formato controlado',
  );
  await cleanMand();
});
