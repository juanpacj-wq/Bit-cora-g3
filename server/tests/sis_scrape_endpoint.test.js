import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, call, TEST_PLANTA, deactivateSyntheticSessions } from './helpers.js';
import { iniciarScrapeJob, estadoScrapeJob, _resetScrapeJobParaTests } from '../utils/sis/sis-job.js';
import { estadoSisLock, withSisLock, _resetSisLockParaTests } from '../utils/sis/sis-lock.js';

// D-061 (L04): scrape manual asíncrono del SIS — POST /sis/scrape (202/400/403/409) y
// GET /sis/estado, más el job en memoria que los alimenta.
//
// Dos mitades a propósito:
//   1. **Unidad (sin BD, sin red):** `iniciarScrapeJob` con `scrapeFn`/`ahora` inyectados. Es la
//      única forma de probar "un día que revienta NO aborta el job" (CA-18): a través de HTTP no
//      hay entrada que haga LANZAR a scrapeDia — el endpoint valida planta y fechas antes.
//   2. **HTTP (BD real + stub del SIS):** el backend efímero arranca con
//      SIS_HOST=http://localhost:3154, este archivo levanta ahí un stub que responde 500 a todo y
//      así cada periodo cuenta como error sin tocar el SIS real (que tarda ~13 s por periodo).
//
// TODO lo que escribe va sobre TEST_PLANTA ('TST', catálogo espejo del seed C12): la suite corre
// contra la BD productiva y ningún test puede escribir en GEC3/GEC32 (D-055).
//
// Cubre CA-16 (POST 202/400×6/403/409 y plantas), CA-17 (GET estado + gate puede_ver + sweeper),
// CA-18 (job bajo el mutex, día a día 'manual', fila en sis_scrape_log, día fallido que no aborta),
// CA-19 (segundo POST durante el job → 409) y CA-44 (que la mitad HTTP no se saltee en silencio).
//
// D-061 / L10 (H31): antes TODO el archivo —los casos de unidad incluidos, que no tocan BD ni red—
// estaba gateado por SIS_HOST. Un `npm test` con el .env real dejaba los 9 casos en `skipped` y la
// suite quedaba verde y VACÍA sobre el endpoint nuevo: una regresión en la tabla de validaciones,
// en el 409 o en el manejo de errores por día no la veía nadie. Los casos de unidad pasaron a
// correr SIEMPRE (no necesitan stub, ni BD, ni backend) y el salto de la mitad HTTP dejó de ser
// invisible.
//
// D-061 / L11 (H51/CA-53): el fin era correcto y no se toca; el MEDIO estaba mal calibrado. L10
// convirtió la ausencia de stub en un rojo incondicional, y como `.env` no trae `SIS_HOST` eso dejó
// `npm test` en rojo PERMANENTE (medido por el gate: `pass 4 · fail 1`). Un rojo que no es una
// regresión destruye la señal igual de bien que el skip silencioso que H31 quería evitar, y encima
// entrena a la gente a ignorar el rojo. La regla quedó así:
//   · sin harness HTTP declarado (o sea, `npm test` a secas contra el backend de dev): VERDE, pero
//     con los saltados contados —el `skipped` de node— y un aviso ruidoso por stderr que dice
//     cuántos casos no corrieron y con qué comando corren;
//   · con harness declarado (`TEST_BASE_URL` explícito, que es lo que hace quien levanta un efímero
//     para esto) y sin stub: ROJO, porque ahí el salto sí es un accidente;
//   · `SIS_STUB_OPCIONAL=1` sigue siendo el opt-out explícito de ese rojo;
//   · y el recuento de casos HTTP está fijado a mano (`HTTP_ESPERADOS`): agregar uno sin tocar ese
//     número deja la suite roja, que es lo que impide que "5 saltados" se vuelva "3 saltados" sin
//     que nadie lo note.

const STUB_URL = 'http://localhost:3154';
// El server efímero resuelve SIS_HOST al cargar sis-client.js: si no apunta al stub, los casos HTTP
// pedirían de verdad el SIS interno (~5 min por día). Sin stub no hay test HTTP.
const hayStub = process.env.SIS_HOST === STUB_URL;
const skip = hayStub ? false : 'requiere SIS_HOST=http://localhost:3154 en server y tests';

// ¿Alguien levantó un harness HTTP para esta corrida? `helpers.js` cae a http://localhost:3002 —el
// backend de dev, que apunta al SIS real— cuando nadie pone `TEST_BASE_URL`, así que la variable
// EXPLÍCITA es la única señal que distingue "corro la suite canónica" de "levanté un efímero para
// ejercer estos casos". Se eligió esto y no meter `SIS_STUB_OPCIONAL=1` en el script `test` porque
// eso no es portable entre Windows y Ubuntu y, sobre todo, es el skip silencioso otra vez con otro
// nombre: el opt-out tiene que ser una decisión de quien corre, no del `package.json`.
const harnessHttp = !!process.env.TEST_BASE_URL;

// Cómo se corren de verdad los casos HTTP (el gate levanta el efímero en :3199; un lote, en el suyo).
const COMO_CORRERLOS = [
  'SERVER_PORT=3199 AUTH_TEST_BYPASS=1 SKIP_INITDB=1 SIS_HOST=http://localhost:3154 node --env-file=../.env server.js',
  'TEST_BASE_URL=http://localhost:3199 SIS_HOST=http://localhost:3154 node --env-file=../.env --test --test-concurrency=1 tests/sis_scrape_endpoint.test.js',
].map((c) => `    ${c}`).join('\n');

// Cuántos casos HTTP tiene este archivo, a mano y a propósito (ver CA-53 al final).
const HTTP_ESPERADOS = 5;
let httpDeclarados = 0;
let httpCorridos = 0;

// Toda la mitad HTTP se declara por acá: el mismo lugar que decide si corre es el que lleva la
// cuenta, así que no hay forma de agregar un caso y que quede fuera del recuento.
function testHttp(nombre, fn) {
  httpDeclarados++;
  return test(nombre, { skip }, async (t) => {
    httpCorridos++;
    return fn(t);
  });
}

const FECHA_A = '2026-04-21';   // fechas fijas pasadas, fuera de todo rango real de la BD
const FECHA_B = '2026-04-22';

let ctx;                        // setupSessions: { sesiones, usuarios, bitByCodigo }
let stub = null;                // servidor SIS de mentira en :3154
let retrasoStub = 0;            // ms que tarda el stub en responder (para abrir la ventana del 409)

async function limpiar() {
  const db = await getDB();
  // Acotado por TEST_PLANTA en el mismo statement (regla dura D-055): jamás por fecha suelta.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .query(`
      DELETE FROM bitacora.consumo_combustible WHERE planta_id = @tp;
      DELETE FROM bitacora.sis_scrape_log      WHERE planta_id = @tp;
    `);
}

async function leerLog(fecha) {
  const db = await getDB();
  return (await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, fecha)
    .query(`
      SELECT scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo
      FROM bitacora.sis_scrape_log WHERE planta_id = @tp AND fecha = @f
    `)).recordset[0];
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Ayudas de la mitad HTTP ─────────────────────────────────────────────────────────────────────

async function estadoSis(sesion_id = ctx.sesiones.jdt) {
  const { status, data } = await call('GET', '/api/combustibles/sis/estado', { sesion_id });
  assert.equal(status, 200, `GET /sis/estado debería responder 200: ${JSON.stringify(data)}`);
  return data;
}

// Espera a que el SIS quede libre (ni mutex tomado ni job en curso).
async function esperarLibre({ timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const data = await estadoSis();
    if (!data.lock.ocupado && data.job?.estado !== 'en_curso') return data;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`el SIS sigue ocupado tras ${timeoutMs} ms: ${JSON.stringify(data)}`);
    }
    await dormir(250);
  }
}

// El backend efímero arranca su propio sis-sweeper (server.js), que a los 10 s toma el MISMO mutex
// para scrapear hoy/ayer. Ese 409 es correcto pero no es el que buscamos: se espera y se reintenta.
// Quién es el dueño del mutex lo dice `lock.motivo` ("sweeper …" vs "scrape manual …") y NADA MÁS:
// el discriminador viejo (`job == null`) daba por propio cualquier 409 posterior al primer job
// manual —el estado del job ya no vuelve a ser null— y una colisión real con el sweeper se colaba
// como respuesta buena, con el 202 fallando después (H32).
async function lanzarScrape(body, { sesion_id = ctx.sesiones.jdt, intentos = 8 } = {}) {
  for (let i = 0; i < intentos; i++) {
    const r = await call('POST', '/api/combustibles/sis/scrape', { sesion_id, body });
    const esDelSweeper = r.status === 409 && /^sweeper/.test(r.data?.lock?.motivo || '');
    if (!esDelSweeper) return r;
    await esperarLibre();
  }
  throw new Error('el tick del sweeper no soltó el mutex del SIS tras varios reintentos');
}

// ── Ayudas de la mitad de unidad ────────────────────────────────────────────────────────────────

// scrapeDia de mentira: registra con qué opciones lo llamaron y devuelve el shape de C1.
// `porFecha[fecha] === 'lanza'` hace que ese día explote (como lo haría la BD o una planta sin
// catálogo), que es el caso que el endpoint no puede provocar.
function scrapeFalso({ porFecha = {}, retraso = 0 } = {}) {
  const llamadas = [];
  const fn = async (pool, opts) => {
    llamadas.push({ ...opts });
    if (retraso) await dormir(retraso);
    if (porFecha[opts.fecha] === 'lanza') throw new Error(`scrapeDia: falla simulada de ${opts.fecha}`);
    return {
      fecha: opts.fecha, periodos_ok: 24, periodos_error: 0, ultimo_periodo: 24, desde: 1,
      creados: 3, actualizados: 2, eliminados: 1, completo: true,
    };
  };
  return { fn, llamadas };
}

async function esperarJobLocal({ timeoutMs = 10000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = estadoScrapeJob();
    if (j && j.estado !== 'en_curso') return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`el job no terminó: ${JSON.stringify(j)}`);
    await dormir(10);
  }
}

function limpiarJobLocal() {
  _resetScrapeJobParaTests();
  _resetSisLockParaTests();
}

const silencio = () => {};

before(async () => {
  if (!hayStub) return;   // los casos de unidad no necesitan stub, BD ni backend

  // Stub del SIS: 500 a todo. `fetchPeriod` lo convierte en `HTTP 500` → periodo con error, que es
  // exactamente lo que necesitamos para ejercer el camino completo sin pedirle nada al SIS real.
  stub = http.createServer((req, res) => {
    const responder = () => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('stub SIS: 500');
    };
    if (retrasoStub > 0) setTimeout(responder, retrasoStub);
    else responder();
  });
  await new Promise((ok, fail) => {
    stub.once('error', fail);
    stub.listen(3154, ok);   // sin host: escucha en IPv4 e IPv6, porque 'localhost' resuelve a ::1
  });

  ctx = await setupSessions({ planta: TEST_PLANTA });
  await limpiar();
  await esperarLibre();
});

after(async () => {
  limpiarJobLocal();
  if (!hayStub) return;
  await limpiar();
  // Esta suite crea sesiones sintéticas sobre TEST_PLANTA: desactivarlas SIEMPRE para no dejarlas
  // en el panel CONECTADOS de producción (D-030/D-044).
  await deactivateSyntheticSessions();
  if (stub) {
    stub.closeAllConnections?.();   // undici deja keep-alive vivos: sin esto close() cuelga
    await new Promise((ok) => stub.close(ok));
  }
});

// ──────────────────────────────────────────── CA-18 · el job (unidad, sin BD ni red)

test('CA-18. el job corre el rango día a día como manual, secuencial y bajo el mutex', async () => {
  limpiarJobLocal();
  const { fn, llamadas } = scrapeFalso();

  const inicial = iniciarScrapeJob({
    pool: null, planta_id: TEST_PLANTA, from: FECHA_A, to: FECHA_B,
    usuario: { usuario_id: 7, nombre_completo: 'Test JdT' },
    scrapeFn: fn, log: silencio,
  });

  // El estado que devuelve (y que el 202 serializa) ya describe el trabajo lanzado.
  assert.equal(inicial.estado, 'en_curso');
  assert.equal(inicial.dias_total, 2);
  assert.equal(inicial.dias_hechos, 0);
  assert.equal(inicial.dia_actual, FECHA_A, 'el primer día arranca antes de responder');
  assert.deepEqual(inicial.iniciado_por, { usuario_id: 7, nombre_completo: 'Test JdT' });
  assert.equal(inicial.terminado_en, null);
  assert.equal(inicial.resultados.length, 0);
  // El mutex se toma SIN esperar al primer await: si no, el tick del sweeper podría colarse entre
  // la validación y la corrida y las dos escribirían las mismas celdas.
  assert.equal(estadoSisLock().ocupado, true);
  assert.equal(estadoSisLock().motivo, `scrape manual ${FECHA_A}..${FECHA_B}`);

  const fin = await esperarJobLocal();
  assert.equal(fin.estado, 'terminado');
  assert.equal(fin.dias_hechos, 2);
  assert.equal(fin.dia_actual, null);
  assert.ok(fin.terminado_en, 'terminado_en se llena al cerrar');
  assert.equal(fin.error, null);
  assert.deepEqual(fin.resultados.map((r) => r.fecha), [FECHA_A, FECHA_B], 'orden del rango');
  assert.deepEqual(fin.resultados[0], {
    fecha: FECHA_A, periodos_ok: 24, periodos_error: 0, completo: true,
    creados: 3, actualizados: 2, eliminados: 1,
  });
  assert.equal(estadoSisLock().ocupado, false, 'el mutex se libera al terminar');

  // Cómo se le pidió cada día (C9): manual, un periodo a la vez y sin recorte de "hoy" en el pasado.
  assert.equal(llamadas.length, 2);
  for (const l of llamadas) {
    assert.equal(l.planta_id, TEST_PLANTA);
    assert.equal(l.scrape_tipo, 'manual');
    assert.equal(l.concurrencia, 1);
    assert.equal(l.soloHoy, false);
  }
  limpiarJobLocal();
});

test('CA-18. un día que revienta se anota y el job sigue con los demás', async () => {
  limpiarJobLocal();
  const { fn } = scrapeFalso({ porFecha: { '2026-04-22': 'lanza' } });

  iniciarScrapeJob({
    pool: null, planta_id: TEST_PLANTA, from: FECHA_A, to: '2026-04-23',
    usuario: { usuario_id: 7, nombre_completo: 'Test JdT' },
    scrapeFn: fn, log: silencio,
  });
  const fin = await esperarJobLocal();

  assert.equal(fin.estado, 'terminado', 'un día fallido NO deja el job en error');
  assert.equal(fin.dias_total, 3);
  assert.equal(fin.dias_hechos, 3, 'los tres días se intentaron');
  assert.equal(fin.resultados.length, 3);
  assert.equal(fin.resultados[1].error, 'scrapeDia: falla simulada de 2026-04-22');
  assert.equal(fin.resultados[1].periodos_ok, 0);
  assert.equal(fin.resultados[2].error, undefined, 'el día siguiente corrió igual');
  assert.equal(fin.resultados[2].periodos_ok, 24);
  assert.equal(fin.error, null, 'el error del día no es el error del job');
  limpiarJobLocal();
});

test('CA-18. soloHoy se activa únicamente para el día en curso (Bogotá)', async () => {
  limpiarJobLocal();
  const { fn, llamadas } = scrapeFalso();

  // 2026-04-22T15:00Z = 10:00 en Bogotá del 22 → "hoy" es FECHA_B y FECHA_A es pasado.
  iniciarScrapeJob({
    pool: null, planta_id: TEST_PLANTA, from: FECHA_A, to: FECHA_B,
    usuario: { usuario_id: 7, nombre_completo: 'Test JdT' },
    scrapeFn: fn, ahora: () => new Date('2026-04-22T15:00:00Z'), log: silencio,
  });
  await esperarJobLocal();

  assert.deepEqual(llamadas.map((l) => [l.fecha, l.soloHoy]), [[FECHA_A, false], [FECHA_B, true]]);
  limpiarJobLocal();
});

test('CA-19. arrancar con un job en curso o con el mutex tomado lanza scrape_en_curso', async () => {
  limpiarJobLocal();

  // (a) job en curso
  const { fn } = scrapeFalso({ retraso: 40 });
  const args = {
    pool: null, planta_id: TEST_PLANTA, from: FECHA_A, to: FECHA_A,
    usuario: { usuario_id: 7, nombre_completo: 'Test JdT' },
    scrapeFn: fn, log: silencio,
  };
  iniciarScrapeJob(args);
  assert.throws(() => iniciarScrapeJob(args), (e) => e.codigo === 'scrape_en_curso');
  await esperarJobLocal();

  // (b) mutex tomado por el sweeper: el job ni siquiera nace.
  limpiarJobLocal();
  let soltar;
  const bloqueo = new Promise((ok) => { soltar = ok; });
  const tickFalso = withSisLock('sweeper 2026-04-21', () => bloqueo);
  assert.equal(estadoSisLock().ocupado, true);
  assert.throws(
    () => iniciarScrapeJob(args),
    (e) => e.codigo === 'scrape_en_curso' && /sweeper/.test(e.message),
  );
  assert.equal(estadoScrapeJob(), null, 'un rechazo no puede pisar el job anterior');
  soltar();
  await tickFalso;
  limpiarJobLocal();
});

// ──────────────────────────────────────────── CA-16 · POST (gate y validaciones)

testHttp('CA-16. POST scrape: el Ingeniero Químico lee pero no dispara (403) y no arranca nada', async () => {
  const antes = await estadoSis();
  const { status } = await call('POST', '/api/combustibles/sis/scrape', {
    sesion_id: ctx.sesiones.ingQuim,
    body: { planta_id: TEST_PLANTA, fecha: FECHA_A },
  });
  assert.equal(status, 403, 'scrape ESCRIBE celdas: va por puede_crear, igual que el batch');
  // SOLO `job`: `lock` es una foto viva que el tick del sweeper voltea por su cuenta, y compararla
  // producía un rojo ajeno al 403 que se está probando, apuntando al lugar equivocado (H32).
  assert.deepEqual((await estadoSis()).job, antes.job, 'el 403 no puede haber lanzado un job');
});

testHttp('CA-16. POST scrape: las seis validaciones de C7 responden 400 con su codigo', async () => {
  const antes = await estadoSis();
  const casos = [
    ['planta_sin_sis',   { planta_id: 'GEC3', fecha: FECHA_A }],
    ['fecha_invalida',   { planta_id: TEST_PLANTA, fecha: '21/04/2026' }],
    ['fecha_invalida',   { planta_id: TEST_PLANTA }],
    ['fecha_futura',     { planta_id: TEST_PLANTA, fecha: '2099-01-01' }],
    ['rango_invalido',   { planta_id: TEST_PLANTA, from: FECHA_B, to: FECHA_A }],
    ['rango_excede_max', { planta_id: TEST_PLANTA, from: '2026-01-01', to: FECHA_A }],
  ];
  for (const [codigo, body] of casos) {
    const { status, data } = await call('POST', '/api/combustibles/sis/scrape', {
      sesion_id: ctx.sesiones.jdt, body,
    });
    assert.equal(status, 400, `${JSON.stringify(body)} → ${JSON.stringify(data)}`);
    assert.equal(data.codigo, codigo, `${JSON.stringify(body)} → ${JSON.stringify(data)}`);
  }

  // El default de `planta_id` es GEC32 (C7). Se comprueba con un body que muere DESPUÉS del gate de
  // planta: si el default no existiera, este caso daría `planta_sin_sis` en vez de `fecha_futura`.
  // Deliberadamente NO se lanza un scrape real sobre GEC32: es planta REAL (D-055).
  const porDefecto = await call('POST', '/api/combustibles/sis/scrape', {
    sesion_id: ctx.sesiones.jdt, body: { fecha: '2099-01-01' },
  });
  assert.equal(porDefecto.status, 400);
  assert.equal(porDefecto.data.codigo, 'fecha_futura', 'sin planta_id el default GEC32 pasa el gate');

  assert.deepEqual((await estadoSis()).job, antes.job, 'ningún 400 puede haber lanzado un job');
});

// ──────────────────────────────────────────── CA-16/17/18 · 202, estado y log

testHttp('CA-16. POST scrape de un día: 202, el job termina y queda la fila manual en sis_scrape_log', async () => {
  await limpiar();
  await esperarLibre();

  const { status, data } = await lanzarScrape({ planta_id: TEST_PLANTA, fecha: FECHA_A });
  assert.equal(status, 202, `202 y no 200: el trabajo apenas arrancó — ${JSON.stringify(data)}`);
  const job = data.job;
  assert.equal(job.estado, 'en_curso');
  assert.equal(job.planta_id, TEST_PLANTA);
  assert.equal(job.from, FECHA_A);
  assert.equal(job.to, FECHA_A);
  assert.equal(job.dias_total, 1, 'un día suelto es el rango degenerado from=to=fecha');
  assert.equal(job.dias_hechos, 0);
  assert.equal(job.iniciado_por.usuario_id, ctx.usuarios.jdt.usuario_id);
  assert.ok(job.iniciado_en, 'iniciado_en viene poblado');
  assert.equal(job.terminado_en, null);

  // CA-17: el avance se sigue por GET /sis/estado hasta que el job cierra.
  const fin = await esperarLibre();
  assert.equal(fin.job.id, job.id, 'es el mismo job, no otro');
  assert.equal(fin.job.estado, 'terminado');
  assert.equal(fin.job.dias_hechos, 1);
  assert.equal(fin.job.dia_actual, null);
  assert.ok(fin.job.terminado_en);
  assert.equal(fin.job.resultados.length, fin.job.dias_total);
  assert.equal(fin.lock.ocupado, false, 'el mutex quedó libre para el sweeper');

  // Contra el stub (500 a todo) los 24 periodos fallan: 24 errores, ninguna celda y el día
  // incompleto. Es el mismo camino que un SIS caído en producción.
  const r0 = fin.job.resultados[0];
  assert.equal(r0.fecha, FECHA_A);
  assert.equal(r0.periodos_ok, 0);
  assert.equal(r0.periodos_error, 24);
  assert.equal(r0.completo, false);
  assert.equal(r0.error, undefined, 'un día con periodos fallidos NO es un día fallido');

  const log = await leerLog(FECHA_A);
  assert.ok(log, 'el job deja su rastro persistente en sis_scrape_log');
  assert.equal(log.scrape_tipo, 'manual', 'CHECK scrape_tipo: horario | backfill | manual');
  assert.equal(Number(log.periodos_ok), 0);
  assert.equal(Number(log.periodos_error), 24);
  assert.equal(!!log.completo, false, 'completo ⇔ 24/24 sin errores (D-060)');

  await limpiar();
});

testHttp('CA-19. un segundo POST mientras el job corre responde 409 con el job y el mutex', async () => {
  await limpiar();
  await esperarLibre();

  // 60 ms por periodo abren una ventana de ~3 s (2 días × 24 periodos) sin depender del azar.
  retrasoStub = 60;
  try {
    const primero = await lanzarScrape({ planta_id: TEST_PLANTA, from: FECHA_A, to: FECHA_B });
    assert.equal(primero.status, 202, JSON.stringify(primero.data));

    const segundo = await call('POST', '/api/combustibles/sis/scrape', {
      sesion_id: ctx.sesiones.jdt,
      body: { planta_id: TEST_PLANTA, fecha: FECHA_A },
    });
    assert.equal(segundo.status, 409, `409 y no 500: el SIS está ocupado — ${JSON.stringify(segundo.data)}`);
    assert.equal(segundo.data.codigo, 'scrape_en_curso');
    assert.equal(segundo.data.job.id, primero.data.job.id, 'el 409 dice CUÁL job está corriendo');
    assert.equal(segundo.data.job.estado, 'en_curso');
    assert.equal(segundo.data.lock.ocupado, true);
    assert.match(segundo.data.lock.motivo, /^scrape manual /, 'el dueño del mutex es el job, no el sweeper');
    assert.ok(segundo.data.lock.desde, 'desde cuándo está tomado');

    const fin = await esperarLibre();
    assert.equal(fin.job.estado, 'terminado');
    assert.equal(fin.job.dias_total, 2);
    assert.equal(fin.job.resultados.length, 2, 'el rango completo, no solo el primer día');
    assert.deepEqual(fin.job.resultados.map((r) => r.fecha), [FECHA_A, FECHA_B]);
    for (const f of [FECHA_A, FECHA_B]) {
      const log = await leerLog(f);
      assert.equal(log?.scrape_tipo, 'manual', `falta la fila de ${f} en sis_scrape_log`);
    }
  } finally {
    retrasoStub = 0;
  }

  await limpiar();
});

// ──────────────────────────────────────────── CA-17 · GET estado

testHttp('CA-17. GET estado va por puede_ver: el Ingeniero Químico lo lee (200) con job, lock y sweeper', async () => {
  const { status, data } = await call('GET', '/api/combustibles/sis/estado', {
    sesion_id: ctx.sesiones.ingQuim,
  });
  assert.equal(status, 200, 'estado es lectura: mismo gate que el GET de consumos');
  assert.ok('job' in data, 'el cuerpo siempre trae la clave job (null si nunca corrió ninguno)');
  assert.deepEqual(Object.keys(data).sort(), ['job', 'lock', 'sweeper']);
  assert.deepEqual(Object.keys(data.lock).sort(), ['desde', 'motivo', 'ocupado']);

  // CA-46 (H33): un sweeper APAGADO con SIS_SWEEPER_ENABLED=0 se veía desde afuera idéntico a uno
  // ROTO — el chip decía "SIS · sin lectura" día tras día y este endpoint respondía exactamente lo
  // mismo que un sweeper sano en reposo. El valor refleja el entorno del SERVIDOR, no el de este
  // proceso (el gate levanta el efímero con su propia variable), así que acá se fija la forma; el
  // valor concreto de cada corrida queda en la evidencia del lote/gate.
  assert.deepEqual(Object.keys(data.sweeper), ['habilitado']);
  assert.equal(typeof data.sweeper.habilitado, 'boolean',
    'apagado y roto tienen que poder distinguirse desde afuera');
  if (data.job) {
    assert.deepEqual(
      Object.keys(data.job).sort(),
      ['dia_actual', 'dias_hechos', 'dias_total', 'error', 'estado', 'from', 'id', 'iniciado_en',
        'iniciado_por', 'planta_id', 'resultados', 'terminado_en', 'to'].sort(),
    );
  }
});

// ──────────────────────────── CA-44 (L10) + CA-53 (L11) · el salto no puede ser silencioso

// Va ÚLTIMO a propósito: los tests de un archivo corren en orden de declaración, así que acá
// `httpCorridos` ya es definitivo. Corre siempre, con stub o sin él.
test('CA-53. los casos HTTP no se saltean en silencio: quedan contados y con el comando exacto', () => {
  // El recuento fijado a mano es lo que hace que "saltado" sea CONTABLE: si mañana alguien agrega un
  // caso HTTP y no toca este número, la suite se pone roja aunque el caso nuevo se haya salteado
  // igual que los otros. Sin esto, "5 saltados" se convierte en "3 saltados" sin que nadie lo note.
  assert.equal(httpDeclarados, HTTP_ESPERADOS,
    `este archivo declara ${httpDeclarados} casos HTTP y HTTP_ESPERADOS dice ${HTTP_ESPERADOS}: `
    + 'actualiza la constante en la misma edición que agrega o quita el caso');

  if (hayStub) {
    assert.equal(httpCorridos, httpDeclarados,
      `con el stub levantado tienen que correr los ${httpDeclarados} casos HTTP, corrieron ${httpCorridos}`);
    return;
  }

  const aviso = `Los ${httpDeclarados} casos HTTP de este archivo NO corrieron: falta el stub del SIS.\n`
    + `  Se necesita SIS_HOST=${STUB_URL} en el backend efímero Y en el proceso de node --test:\n`
    + `${COMO_CORRERLOS}\n`
    + '  Si de verdad solo quieres los casos de unidad, decláralo: SIS_STUB_OPCIONAL=1.';

  // Ruidoso aunque la suite quede verde: el conteo de `skipped` de node dice CUÁNTOS y esto dice
  // CUÁLES y cómo correrlos. Es la constancia que reemplaza al rojo permanente de L10.
  console.error(`\n[sis_scrape_endpoint] ${aviso}\n`);

  assert.equal(httpCorridos, 0, 'sin stub no puede haber corrido ningún caso HTTP');

  // Con un harness HTTP declarado, saltearlos SÍ es un accidente: quien levantó un efímero y apuntó
  // `TEST_BASE_URL` ahí cree que está ejerciendo estos casos. Ahí el rojo es la señal correcta.
  if (harnessHttp && process.env.SIS_STUB_OPCIONAL !== '1') {
    assert.fail(`${aviso}\n  (TEST_BASE_URL=${process.env.TEST_BASE_URL} declara un harness HTTP: `
      + 'esto no es la suite canónica, es una corrida que cree estar probando el endpoint.)');
  }
});
