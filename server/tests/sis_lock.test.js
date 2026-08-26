import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { estadoSisLock, withSisLock, _resetSisLockParaTests } from '../utils/sis/sis-lock.js';
import { ejecutarTick } from '../utils/sis/sis-sweeper.js';

// D-061 / CA-3 y CA-4: mutex de proceso del SIS y el tick del sweeper que lo usa. Tests PUROS —
// sin BD, sin red, sin timers de producción: `ejecutarTick` recibe el pool, el scrape, la lectura
// del log y el propio lock por parámetro.
//
// Lo que fijan estos tests es la decisión de diseño que más fácil se revierte "arreglándola":
// el lock NO TIENE COLA. El segundo que llega falla de inmediato con `sis_ocupado` en vez de
// esperar. Si alguien lo convierte en una cola, el test 3 se cae — y debe caerse: el SIS tarda
// ~13 s por periodo, así que encolar convierte un 409 honesto en un request colgado varios minutos
// y hace que el sweeper corra su tick horario fuera de hora.

beforeEach(() => { _resetSisLockParaTests(); });

// --- CA-3: sis-lock ---------------------------------------------------------------------------

test('1. arranca libre y estadoSisLock refleja motivo y desde mientras está tomado', async () => {
  assert.deepEqual(estadoSisLock(), { ocupado: false, motivo: null, desde: null });

  const antes = Date.now();
  let dentro = null;
  await withSisLock('scrape manual 2026-04-17..2026-04-17', async () => {
    dentro = estadoSisLock();
  });

  assert.equal(dentro.ocupado, true);
  assert.equal(dentro.motivo, 'scrape manual 2026-04-17..2026-04-17');
  assert.match(dentro.desde, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'desde es ISO UTC');
  const desdeMs = Date.parse(dentro.desde);
  assert.ok(desdeMs >= antes - 1000 && desdeMs <= Date.now() + 1000, 'desde es de ahora');

  assert.deepEqual(estadoSisLock(), { ocupado: false, motivo: null, desde: null }, 'liberado al salir');
});

test('2. devuelve el valor de fn', async () => {
  const r = await withSisLock('sweeper 2026-04-17', async () => ({ periodos_ok: 24 }));
  assert.deepEqual(r, { periodos_ok: 24 });
});

test('3. ocupado ⇒ sis_ocupado SIN ESPERAR al dueño (no hay cola)', async () => {
  let dueñoTerminado = false;
  let intrusoEjecutado = false;

  const dueño = withSisLock('sweeper 2026-04-17', async () => {
    await new Promise((r) => setTimeout(r, 80));
    dueñoTerminado = true;
  });

  await assert.rejects(
    () => withSisLock('scrape manual', async () => { intrusoEjecutado = true; }),
    (err) => {
      assert.equal(err.codigo, 'sis_ocupado');
      assert.equal(err.motivo, 'sweeper 2026-04-17', 'el motivo es el del DUEÑO, no el del que llega');
      return true;
    },
  );

  assert.equal(dueñoTerminado, false, 'rechazó mientras el dueño seguía corriendo: no esperó turno');
  assert.equal(intrusoEjecutado, false, 'no ejecutó la fn del que llegó tarde');

  await dueño;
  assert.equal(estadoSisLock().ocupado, false, 'el dueño lo liberó al terminar');
});

test('4. libera en finally aunque fn lance, y el siguiente lo toma sin problema', async () => {
  await assert.rejects(
    () => withSisLock('scrape manual', async () => { throw new Error('el SIS se cayó'); }),
    /el SIS se cayó/,
  );
  assert.deepEqual(estadoSisLock(), { ocupado: false, motivo: null, desde: null });

  let corrio = false;
  await withSisLock('sweeper 2026-04-17', async () => { corrio = true; });
  assert.equal(corrio, true);
});

test('5. estadoSisLock devuelve una copia: mutarla no toca el estado del módulo', async () => {
  const dueño = withSisLock('sweeper 2026-04-17', () => new Promise((r) => setTimeout(r, 30)));
  const foto = estadoSisLock();
  foto.ocupado = false;
  foto.motivo = 'mentira';
  assert.equal(estadoSisLock().ocupado, true);
  assert.equal(estadoSisLock().motivo, 'sweeper 2026-04-17');
  await dueño;
});

// --- CA-4: el tick del sweeper corre bajo el lock -----------------------------------------------

// Doble de scrapeDia/leerScrapeLog que solo registra con qué lo llamaron.
function espia() {
  const llamadas = [];
  const fn = async (_pool, opts) => {
    llamadas.push(opts);
    return { fecha: opts.fecha, periodos_ok: 24, periodos_error: 0, ultimo_periodo: 24, completo: true };
  };
  fn.llamadas = llamadas;
  return fn;
}

// Log capturado: `ejecutarTick` recibe la línea COMPLETA (con el prefijo), para poder asertarla.
function logCapturado() {
  const lineas = [];
  const fn = (msg) => { lineas.push(msg); };
  fn.lineas = lineas;
  return fn;
}

test('6. tick normal: toma el lock con motivo "sweeper <hoy>" y scrapea ayer + hoy', async () => {
  const scrapeFn = espia();
  const log = logCapturado();
  let motivoDelLock = null;

  await ejecutarTick({
    pool: {},
    scrapeFn,
    leerLogFn: async () => null,          // sin log previo ⇒ necesitaCatchup(null) = true
    lockFn: (motivo, fn) => { motivoDelLock = motivo; return fn(); },
    hoy: '2026-04-17',
    log,
  });

  assert.equal(motivoDelLock, 'sweeper 2026-04-17');
  assert.equal(scrapeFn.llamadas.length, 2, 'ayer (catchup) + hoy');
  assert.equal(scrapeFn.llamadas[0].fecha, '2026-04-16');
  assert.equal(scrapeFn.llamadas[0].soloHoy, false, 'ayer se pide completo');
  assert.equal(scrapeFn.llamadas[0].periodoDesde, 1, 'sin log previo arranca en 1');
  assert.equal(scrapeFn.llamadas[1].fecha, '2026-04-17');
  assert.ok(log.lineas.some((l) => l.startsWith('[sis-sweeper] hoy 2026-04-17:')), log.lineas.join(' | '));
});

test('7. ayer ya cerrado (24/24) ⇒ no lo repesca, solo hoy', async () => {
  const scrapeFn = espia();
  await ejecutarTick({
    pool: {},
    scrapeFn,
    leerLogFn: async () => ({ periodos_ok: 24, periodos_error: 0, ultimo_periodo: 24, completo: true }),
    lockFn: (_motivo, fn) => fn(),
    hoy: '2026-04-17',
    log: logCapturado(),
  });
  assert.equal(scrapeFn.llamadas.length, 1);
  assert.equal(scrapeFn.llamadas[0].fecha, '2026-04-17');
});

test('8. lock ocupado ⇒ tick OMITIDO: cero scrapeFn y log "omitido: sis_ocupado (motivo)"', async () => {
  const scrapeFn = espia();
  const log = logCapturado();

  await ejecutarTick({
    pool: {},
    scrapeFn,
    leerLogFn: async () => { throw new Error('no debería consultarse el log'); },
    lockFn: async () => {
      const err = new Error('sis_ocupado');
      err.codigo = 'sis_ocupado';
      err.motivo = 'scrape manual 2026-01-01..2026-03-31';
      throw err;
    },
    hoy: '2026-04-17',
    log,
  });

  assert.equal(scrapeFn.llamadas.length, 0, 'ni ayer ni hoy: el tick entero se omite');
  assert.deepEqual(log.lineas, ['[sis-sweeper] omitido: sis_ocupado (scrape manual 2026-01-01..2026-03-31)']);
});

test('9. integración lock+sweeper real: con el lock ya tomado el tick se omite y no lo roba', async () => {
  const scrapeFn = espia();
  const log = logCapturado();

  const dueño = withSisLock('scrape manual 2026-04-17..2026-04-17', async () => {
    await ejecutarTick({ pool: {}, scrapeFn, leerLogFn: async () => null, hoy: '2026-04-17', log });
  });
  await dueño;

  assert.equal(scrapeFn.llamadas.length, 0);
  assert.deepEqual(log.lineas, ['[sis-sweeper] omitido: sis_ocupado (scrape manual 2026-04-17..2026-04-17)']);
  assert.equal(estadoSisLock().ocupado, false, 'el dueño conservó el lock y lo liberó él');
});

test('10. ejecutarTick NUNCA lanza: un scrapeFn que revienta no tumba el proceso', async () => {
  const log = logCapturado();
  await ejecutarTick({
    pool: {},
    scrapeFn: async () => { throw new Error('BD caída'); },
    leerLogFn: async () => ({ periodos_ok: 24, periodos_error: 0, ultimo_periodo: 24, completo: true }),
    lockFn: (_motivo, fn) => fn(),
    hoy: '2026-04-17',
    log,
  });
  assert.equal(estadoSisLock().ocupado, false);
});
