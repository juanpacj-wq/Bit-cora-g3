import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { scrapeDia } from '../utils/sis/carbon-scraper.js';
import { TEST_PLANTA, ensurePlantaCombTest } from './helpers.js';

// D-061 / CA-1 y CA-2: `scrapeDia` por PLANTA y con FETCH CONCURRENTE. BD real (patrón de
// sis_scraper_ownership) + `fetchFn` inyectado: no toca el SIS ni la red.
//
// Las dos propiedades que se fijan acá son las que se rompen sin ruido:
//  (1) una planta sin catálogo ALIM_1..8 corta ANTES del primer fetch. Si el guard se moviera
//      después, GEC3 pediría 24 periodos (~5 min de red) para terminar en un rollback y dejaría un
//      sis_scrape_log afirmando haber leído un día donde no se escribió una sola celda.
//  (2) `concurrencia: N` es SOLO una optimización de red: mismas celdas, mismo log, mismo resumen
//      que N=1. El orden en que conteste el SIS no puede filtrarse al resultado.
//
// D-061 (L06 · CA-26): las escrituras van a la planta-FIXTURE, no a GEC32. Este archivo nació
// borrando y reescribiendo `consumo_combustible` y `sis_scrape_log` de GEC32 en 2026-04-17 — una
// fecha entonces vacía que el backfill histórico de D-061 iba a llenar con carbón real durante
// esta misma ola, sobre la misma BD contra la que corre la suite (D-030/D-055). La fixture tiene
// sus propios ALIM_1..8 (seed C12 de `db.js`), así que `scrapeDia` la trata igual que a GEC32.
//
// GEC3 se queda como la planta "sin catálogo": usa ALIM_A..ALIM_F y jamás va a tener ALIM_1..8,
// mientras que 'TST' dejó de servir para ese caso el día que se le sembró el catálogo espejo.
// El caso "sin `planta_id` el default es GEC32" es el ÚNICO que sigue nombrando a GEC32, y se
// prueba SIN escribir (test 2): mira a qué planta le pide el catálogo el scraper y corta ahí.
//
// La limpieza borra SOLO (fixture, FECHA), en las dos tablas que el scraper toca.

const PLANTA = TEST_PLANTA;
const PLANTA_SIN_SIS = 'GEC3'; // tiene ALIM_A..ALIM_F, jamás ALIM_1..8 ⇒ "sin catálogo" estable.
const PLANTA_DEFAULT = 'GEC32'; // el default de `scrapeDia` (C1), verificado sin tocar la BD.
const FECHA = '2026-04-17';

let db;

// lastRow 1-indexado: [1..8]=tolvas, [9]=energía, [10]=v659, [11]=v651, [12]=mpaflow.
// En servicio ⇔ v659>400 && v651>400 && mpaflow>140. Valores DETERMINISTAS por periodo y tolva
// para poder comparar dos corridas celda a celda. El rango importa: `extraerCarbonValidado`
// convierte a 0 toda lectura ≤ 0.5 t/h (ruido) y el scraper NO crea celda para un 0, así que un
// valor bajito daría 8 celdas menos por periodo; y el tope físico del alimentador es 25 (D-034),
// que el scraper clampa. Estos van de 1,51 a 13,08: fuera del ruido y lejos del tope.
function lastRowDe(periodo) {
  const r = [];
  for (let k = 1; k <= 8; k++) r[k] = Number((1 + periodo * 0.5 + k * 0.01).toFixed(3));
  r[9] = 160;
  r[10] = 500; r[11] = 500; r[12] = 200;
  return r;
}

// Mock de fetchFn con latencia artificial y MEDIDOR de concurrencia: sin la latencia, un pool con
// tope y una corrida secuencial son indistinguibles (cada await resolvería antes de que salga el
// siguiente) y el test de CA-2 no probaría nada.
function mockMedido({ latenciaMs = 8, fallaEnPeriodo = null } = {}) {
  let enVuelo = 0, maxEnVuelo = 0, llamadas = 0;
  const fn = async (_f1, h1) => {
    const periodo = Number(h1) + 1;
    llamadas++;
    enVuelo++;
    if (enVuelo > maxEnVuelo) maxEnVuelo = enVuelo;
    try {
      await new Promise((r) => setTimeout(r, latenciaMs));
      if (periodo === fallaEnPeriodo) throw new Error(`SIS sin respuesta en p${periodo}`);
      return { lastRow: lastRowDe(periodo), ncols: 12 };
    } finally {
      enVuelo--;
    }
  };
  Object.defineProperty(fn, 'maxEnVuelo', { get: () => maxEnVuelo });
  Object.defineProperty(fn, 'llamadas', { get: () => llamadas });
  return fn;
}

// Silencia el log del scraper: 24 periodos × 2 corridas ensucian la salida del runner.
const mudo = () => {};

// Pool FALSO que deja correr lo que `scrapeDia` hace antes de la red y corta en la consulta del
// catálogo, anotando a qué planta se lo pidió. Es lo que permite afirmar el DEFAULT de `planta_id`
// sin escribir en GEC32.
//
// Sigue el orden real de `scrapeDia`: valida argumentos → resuelve el id de SISTEMA → resuelve el
// mapa ALIM_1..8 de la planta → recién ahí sale a la red. Cualquier consulta que no sea una de
// esas dos hace fallar el test con "consulta inesperada" en vez de pasar en falso.
function poolEspia() {
  const plantasConsultadas = [];
  const CORTE = new Error('poolEspia: corte deliberado en la consulta del catálogo');
  const fetchFn = async () => { fetchFn.llamadas++; return { lastRow: [], ncols: 0 }; };
  fetchFn.llamadas = 0;

  return {
    CORTE,
    plantasConsultadas,
    fetchFn,
    request() {
      const params = {};
      const req = {
        input(nombre, _tipo, valor) { params[nombre] = valor; return req; },
        async query(texto) {
          if (/lov_bit\.combustible/.test(texto)) {
            plantasConsultadas.push(params.p);
            throw CORTE;
          }
          if (/username\s*=\s*'SISTEMA'/.test(texto)) return { recordset: [{ usuario_id: -1 }] };
          throw new Error(`poolEspia: consulta inesperada antes del catálogo → ${texto.trim().slice(0, 120)}`);
        },
      };
      return req;
    },
  };
}

// Toda corrida de este archivo que ESCRIBA pasa por acá: `planta_id` va siempre, y así un caso
// nuevo no puede caer en el default (GEC32, planta REAL) por olvidarse de pasarlo. No es celo
// preventivo: durante la migración de este archivo se me quedaron tres llamadas sin `planta_id` y
// escribieron 192 celdas sintéticas en el GEC32 de la BD de desarrollo. Los casos que a propósito
// apuntan a otra planta (test 1) o a otro pool (test 2) llaman `scrapeDia` directo y explícito.
const scrapeFixture = (opts) => scrapeDia(db, { planta_id: PLANTA, fecha: FECHA, ...opts });

async function limpiarFecha() {
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f`);
  await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`DELETE FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`);
}

// Foto comparable de las celdas del día. Sin `sis_actualizado_en`: es un SYSUTCDATETIME() que
// cambia entre corridas por definición y compararlo haría fallar el test por la razón equivocada.
async function celdasDelDia(planta = PLANTA) {
  const r = await db.request()
    .input('p', sql.VarChar(10), planta)
    .input('f', sql.Date, FECHA)
    .query(`
      SELECT periodo, combustible_id, cantidad, valor_sis, creado_por, modificado_por
      FROM bitacora.consumo_combustible
      WHERE planta_id=@p AND fecha=@f
      ORDER BY periodo, combustible_id
    `);
  return r.recordset.map((c) => ({
    periodo: Number(c.periodo),
    combustible_id: c.combustible_id,
    cantidad: Number(c.cantidad),
    valor_sis: c.valor_sis === null ? null : Number(c.valor_sis),
    creado_por: c.creado_por,
    modificado_por: c.modificado_por,
  }));
}

async function logDelDia(planta = PLANTA) {
  const r = await db.request()
    .input('p', sql.VarChar(10), planta)
    .input('f', sql.Date, FECHA)
    .query(`SELECT scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo
            FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f`);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    scrape_tipo: row.scrape_tipo,
    periodos_ok: Number(row.periodos_ok),
    periodos_error: Number(row.periodos_error),
    ultimo_periodo: row.ultimo_periodo === null ? null : Number(row.ultimo_periodo),
    completo: row.completo === true || Number(row.completo) === 1,
  };
}

// Cuántas filas tiene ESE día cada planta que NO es la nuestra. Es el testigo de "escribe solo en
// la planta pedida": si el scraper se saliera de la fixture, este conteo cambiaría.
//
// Es una LECTURA de plantas reales, nunca una escritura. Si alguna vez falla nombrando a GEC32,
// sospecha primero de un backfill en vuelo sobre esta misma BD escribiendo justo ese día: el
// testigo compara un antes y un después separados por la corrida del scraper.
async function filasDeOtrasPlantas() {
  const r = await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`
      SELECT planta_id, COUNT(*) AS n
      FROM bitacora.consumo_combustible
      WHERE fecha=@f AND planta_id <> @p
      GROUP BY planta_id
      ORDER BY planta_id
    `);
  return r.recordset.map((x) => ({ planta_id: x.planta_id, n: Number(x.n) }));
}

async function logsDeOtrasPlantas() {
  const r = await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`
      SELECT planta_id FROM bitacora.sis_scrape_log
      WHERE fecha=@f AND planta_id <> @p ORDER BY planta_id
    `);
  return r.recordset.map((x) => x.planta_id);
}

before(async () => {
  db = await getDB();
  // Este suite no abre sesiones de app, así que no pasa por `setupSessions`: siembra él mismo la
  // fixture y su catálogo (idempotente). Sin las 8 tolvas `scrapeDia` la rechazaría por "planta sin
  // catálogo" y el archivo entero probaría lo contrario de lo que dice probar.
  await ensurePlantaCombTest();
  const n = (await db.request()
    .input('p', sql.VarChar(10), PLANTA)
    .query(`SELECT COUNT(*) AS n FROM lov_bit.combustible
            WHERE planta_id=@p AND codigo LIKE 'ALIM[_]%'`)).recordset[0].n;
  assert.equal(Number(n), 8, `${PLANTA} debe tener ALIM_1..ALIM_8 (seed C12, D-061)`);
});

beforeEach(async () => { await limpiarFecha(); });

after(async () => { await limpiarFecha(); });

// --- CA-1: planta_id ---------------------------------------------------------------------------

test('1. planta sin catálogo ALIM_1..8 ⇒ Error ANTES de cualquier fetch y sin escribir nada', async () => {
  const fetchFn = mockMedido();
  const otrasAntes = await filasDeOtrasPlantas();
  const logsAntes = await logsDeOtrasPlantas();

  await assert.rejects(
    () => scrapeDia(db, { fecha: FECHA, planta_id: PLANTA_SIN_SIS, scrape_tipo: 'manual', fetchFn, log: mudo }),
    (err) => {
      assert.equal(err.message, `scrapeDia: planta sin catálogo ALIM_1..8: ${PLANTA_SIN_SIS}`);
      return true;
    },
  );

  assert.equal(fetchFn.llamadas, 0, 'ni un solo fetch al SIS: el guard corre antes de la red');
  assert.deepEqual(await filasDeOtrasPlantas(), otrasAntes,
    'no escribió celdas en ninguna otra planta (si nombra a GEC32: ¿backfill en vuelo?)');
  assert.deepEqual(await logsDeOtrasPlantas(), logsAntes, 'no dejó un sis_scrape_log mentiroso');
});

test('2. sin planta_id el default es GEC32 — comprobado SIN escribir una sola fila', async () => {
  // El default de C1 sigue siendo GEC32, pero comprobarlo scrapeando de verdad mete 192 celdas de
  // carbón sintético en la planta REAL: es justo lo que este lote vino a sacar de ahí. `scrapeDia`
  // le pide a la planta su catálogo ALIM_1..8 antes que nada, así que basta con leer ESA pregunta.
  const espia = poolEspia();
  await assert.rejects(
    () => scrapeDia(espia, { fecha: FECHA, scrape_tipo: 'manual', fetchFn: espia.fetchFn, log: mudo }),
    (err) => err === espia.CORTE,
    'el pool espía debe cortar en la consulta del catálogo, antes de escribir nada',
  );

  assert.deepEqual(espia.plantasConsultadas, [PLANTA_DEFAULT],
    'sin planta_id, el catálogo se resuelve contra GEC32');
  assert.equal(espia.fetchFn.llamadas, 0, 'ni un fetch: el guard de catálogo corre antes de la red');

  // Y por el otro lado: pasarle la fixture cambia la planta consultada. Mismo espía, misma ruta —
  // sin este segundo caso, un `scrapeDia` que ignorara `planta_id` pasaría el primero igual.
  const espia2 = poolEspia();
  await assert.rejects(
    () => scrapeDia(espia2, { fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: espia2.fetchFn, log: mudo }),
    (err) => err === espia2.CORTE,
  );
  assert.deepEqual(espia2.plantasConsultadas, [PLANTA]);
});

test('3. planta_id explícito escribe el día entero en esa planta y SOLO en esa planta', async () => {
  const otrasAntes = await filasDeOtrasPlantas();
  const logsAntes = await logsDeOtrasPlantas();

  const r = await scrapeDia(db, {
    fecha: FECHA, planta_id: PLANTA, scrape_tipo: 'manual', fetchFn: mockMedido({ latenciaMs: 0 }), log: mudo,
  });

  assert.equal(r.creados, 24 * 8, 'día pasado completo: 24 periodos × 8 alimentadores');
  assert.equal((await celdasDelDia()).length, 24 * 8);
  assert.ok(await logDelDia(), `el sis_scrape_log quedó en ${PLANTA}`);
  assert.deepEqual(await filasDeOtrasPlantas(), otrasAntes,
    'ninguna otra planta ganó filas ese día (si nombra a GEC32: ¿backfill en vuelo?)');
  assert.deepEqual(await logsDeOtrasPlantas(), logsAntes);
});

// --- CA-2: concurrencia ------------------------------------------------------------------------

test('4. concurrencia:4 ≡ concurrencia:1 en celdas, log y resumen (y el pool respeta el tope)', async () => {
  const seq = mockMedido({ latenciaMs: 8 });
  const rSeq = await scrapeFixture({ scrape_tipo: 'manual', concurrencia: 1, fetchFn: seq, log: mudo });
  const celdasSeq = await celdasDelDia();
  const logSeq = await logDelDia();

  await limpiarFecha();

  const par = mockMedido({ latenciaMs: 8 });
  const rPar = await scrapeFixture({ scrape_tipo: 'manual', concurrencia: 4, fetchFn: par, log: mudo });
  const celdasPar = await celdasDelDia();
  const logPar = await logDelDia();

  assert.equal(seq.maxEnVuelo, 1, 'concurrencia:1 es estrictamente secuencial');
  assert.ok(par.maxEnVuelo > 1, `concurrencia:4 debe solaparse (observado ${par.maxEnVuelo})`);
  assert.ok(par.maxEnVuelo <= 4, `nunca más de 4 en vuelo (observado ${par.maxEnVuelo})`);
  assert.equal(seq.llamadas, 24);
  assert.equal(par.llamadas, 24);

  assert.deepEqual(rPar, rSeq, 'mismo resumen');
  assert.deepEqual(celdasPar, celdasSeq, 'mismas celdas, mismos valores');
  assert.deepEqual(logPar, logSeq, 'mismo sis_scrape_log');
  assert.equal(logPar.ultimo_periodo, 24);
  assert.equal(logPar.completo, true);
});

test('5. un periodo que falla cuenta como error, NO aborta el día y ultimo_periodo = mayor OK', async () => {
  const fetchFn = mockMedido({ latenciaMs: 4, fallaEnPeriodo: 7 });
  const r = await scrapeFixture({ scrape_tipo: 'manual', concurrencia: 4, fetchFn, log: mudo });

  assert.equal(r.periodos_error, 1);
  assert.equal(r.periodos_ok, 23, 'los otros 23 sí entraron');
  assert.equal(r.ultimo_periodo, 24, 'el mayor periodo OK, no el último que respondió');
  assert.equal(r.completo, false, 'con un error el día NO está completo');
  assert.equal(r.creados, 23 * 8);

  const celdas = await celdasDelDia();
  assert.equal(celdas.filter((c) => c.periodo === 7).length, 0, 'el periodo fallido no dejó celdas');
  assert.equal(celdas.filter((c) => c.periodo === 8).length, 8, 'el día siguió después del fallo');
  assert.equal(celdas.filter((c) => c.periodo === 24).length, 8);
});

test('6. concurrencia fuera de 1..6 (o no entera) ⇒ Error sin pedirle nada al SIS', async () => {
  for (const concurrencia of [0, 7, 2.5, -1, '4', null]) {
    const fetchFn = mockMedido();
    await assert.rejects(
      () => scrapeFixture({ scrape_tipo: 'manual', concurrencia, fetchFn, log: mudo }),
      (err) => {
        assert.equal(err.message, `scrapeDia: concurrencia fuera de rango 1..6: ${concurrencia}`);
        return true;
      },
      `concurrencia=${concurrencia} debía rechazarse`,
    );
    assert.equal(fetchFn.llamadas, 0, `concurrencia=${concurrencia}: cero fetch`);
  }
  assert.equal((await celdasDelDia()).length, 0, 'ninguna corrida inválida escribió celdas');
});

test('7. los extremos válidos 1 y 6 pasan', async () => {
  for (const concurrencia of [1, 6]) {
    await limpiarFecha();
    const fetchFn = mockMedido({ latenciaMs: 0 });
    const r = await scrapeFixture({ scrape_tipo: 'manual', concurrencia, fetchFn, log: mudo });
    assert.equal(r.periodos_error, 0, `concurrencia=${concurrencia}`);
    assert.equal(r.creados, 24 * 8, `concurrencia=${concurrencia}`);
  }
});
