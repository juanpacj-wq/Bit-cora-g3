import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverEarliestDate, explicarDescubrimiento, offsetsVentana, addDays, diffDays,
} from '../utils/sis/discover.js';

// D-061 / CA-20: `discover` v2 con K sondeos repartidos en una ventana de W días. Test PURO —
// sin BD, sin red: el SIS se reemplaza por un HISTORIADOR SIMULADO (`historiador()`) que sabe
// desde qué día hay datos, en qué rangos la unidad estuvo parada y qué días falla la red.
//
// Lo que fijan estos tests es la razón de ser de la v2. La v1 declaraba "sin datos" con UN solo
// sondeo, así que una parada de 45 días leída en el candidato equivocado se confundía con "acá el
// SIS todavía no existía". El verificador es BIDIRECCIONAL: el mismo historiador se corre con
// K=6 (verde, ±0 días) y con K=1 —la heurística v1— (rojo: se traga la parada y falla por más de
// un día). Si alguien "simplifica" la v2 a un sondeo por candidato, el test 4 se cae.
//
// D-061 / L10 — se agregan CA-41, CA-42 y CA-43, los tres defectos que el code-review de la O2 le
// encontró a la v2 (H28/H29/H30) y que hacían que una corrida real devolviera una fecha equivocada
// SIN decirlo. El viejo test 10 ("un fetch que lanza cuenta como vacío y no aborta el sondeo")
// codificaba el defecto H28 como comportamiento esperado: lo reemplaza CA-41, que es su contrario.

const INICIO = '2016-11-15';   // primer día con datos del historiador simulado.
const TECHO = '2026-08-26';    // "hoy" del escenario (fecha de redacción del lote).

// Desde L10 la ventana del ancla se extiende HACIA ATRÁS cuando el candidato (el techo) está a
// menos de `span` días del tope: con K=6/W=60 el span es 50, así que el ancla arranca en techo-50 y
// la primera fecha con datos que ve es esa. Los candidatos de la fase coarse cuelgan de ahí, 365
// días exactos por vuelta (antes retrocedían desde el día rescatado por la ventana: ~315 d).
const ANCLA = addDays(TECHO, -50);
const candidatoCoarse = (y) => addDays(ANCLA, -365 * y);

// La parada larga se planta EXACTAMENTE sobre el 4.º candidato coarse (2022): es el caso que hace
// fallar a la v1. 45 días < 50 (el span de los 6 sondeos de una ventana de 60), así que la v2 no
// puede vaciar la ventana con ella.
const PARADA_2022 = [candidatoCoarse(4), addDays(candidatoCoarse(4), 44)];
const PARADA_2018 = ['2018-03-01', '2018-04-14'];

// Trampa para la heurística v1 (test 4). Con K=1 el span de la ventana es 0, así que el ancla NO se
// corre hacia atrás (H29) y su rejilla coarse queda 50 días por encima de la de K=6: una parada
// alineada con los candidatos de K=6 ya no cae sobre los de K=1. Esta va sobre el 3.er candidato de
// la rejilla de K=1 (2023-08-27); la ventana de K=6 de ese año arranca 50 días antes, fuera de la
// parada, y ni la ve.
const PARADA_2023_K1 = [addDays(TECHO, -365 * 3), addDays(TECHO, -365 * 3 + 44)];

const FILA_CON_DATOS = [null, 14.46, 14.44, 16.42, 14.82, 17.18, 17.59, 17.23, 15.71, 279.69, 966.91, 902.78, 255.8];
const FILA_VACIA = [null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// fetchFn simulado. Devuelve el mismo shape que fetchPeriod: { lastRow, ncols }. Registra cada
// fecha pedida para poder afirmar sobre el costo (la caché) y sobre los reintentos, además del
// resultado. `falla` cae siempre; `fallaUnaVez` cae solo en el primer intento de ese día (el bache
// de red transitorio que el reintento de CA-41 tiene que absorber).
function historiador({ inicio = INICIO, paradas = [PARADA_2018, PARADA_2022, PARADA_2023_K1], falla = [], fallaUnaVez = [] } = {}) {
  const pedidos = [];
  const transitorios = new Set(fallaUnaVez);
  const fetchFn = async (f1) => {
    pedidos.push(f1);
    if (falla.includes(f1)) throw new Error(`HTTP 500 simulado en ${f1}`);
    if (transitorios.has(f1)) {
      transitorios.delete(f1);
      throw new Error(`HTTP 500 transitorio simulado en ${f1}`);
    }
    const parado = paradas.some(([d, h]) => f1 >= d && f1 <= h);
    const hay = f1 >= inicio && !parado;
    return { lastRow: hay ? FILA_CON_DATOS : FILA_VACIA, ncols: 13 };
  };
  return { fetchFn, pedidos };
}

function corrida(opts = {}) {
  const { fetchFn, pedidos } = historiador(opts.historiador);
  const lineas = [];
  const log = (...a) => lineas.push(a.join(' '));
  return {
    pedidos,
    lineas,
    correr: () => discoverEarliestDate(null, {
      techo: TECHO, maxYearsBack: 12, fetchFn, log, ...opts.discover,
    }),
  };
}

// --- offsetsVentana ---------------------------------------------------------------------------

test('1. offsetsVentana reparte K sondeos uniformemente en la ventana W', () => {
  assert.deepEqual(offsetsVentana(6, 60), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(offsetsVentana(1, 60), [0], 'K=1 es el sondeo único de la v1');
  assert.deepEqual(offsetsVentana(3, 30), [0, 10, 20]);
  // El span de los sondeos (último offset) es lo que decide qué parada NO puede vaciar la ventana.
  const off = offsetsVentana(6, 60);
  assert.equal(off[off.length - 1], 50, 'los 6 sondeos abarcan 50 días: una parada de 45 no los cubre');
  assert.deepEqual(offsetsVentana(6, 3), [0, 1, 2, 3], 'K > W no repite el mismo día');
});

// --- CA-20: la v2 halla la fecha de inicio -----------------------------------------------------

test('2. historiador con inicio 2016-11-15 y paradas de 45 días → la v2 lo halla exacto (±1)', async () => {
  const c = corrida();
  const r = await c.correr();
  assert.ok(Math.abs(diffDays(INICIO, r.fecha)) <= 1, `esperaba ${INICIO} ±1 día, obtuve ${r.fecha}`);
  assert.equal(r.fecha, INICIO, 'con este historiador la v2 cae justo en el día de inicio');
  assert.equal(r.motivo, 'hallada');

  // Ningún día se le pidió dos veces al SIS: la caché es lo que hace viable la rejilla solapada.
  assert.equal(new Set(c.pedidos).size, c.pedidos.length, `hay fechas repetidas: ${c.pedidos.length} pedidos`);
  assert.ok(c.pedidos.length < 120, `demasiados sondeos (${c.pedidos.length}); a ~13 s cada uno no cierra`);
  assert.equal(r.sondeos, c.pedidos.length, 'el contador de sondeos son los fetch REALES');
});

test('3. un candidato DENTRO de una parada no se toma como "sin datos"', async () => {
  const [desdeParada] = PARADA_2022;
  const c = corrida();
  await c.correr();

  // El candidato coarse cae dentro de la parada de 2022 y la ventana igual encuentra datos:
  // el sondeo del offset 50 se sale de los 45 días parados.
  const sondeoDelCandidato = c.lineas.find((l) => l.startsWith(`${desdeParada} P12`));
  assert.match(sondeoDelCandidato, /vacío$/, 'el candidato mismo sí sale vacío (está parado)');
  const off50 = addDays(desdeParada, 50);
  assert.ok(c.lineas.includes(`${off50} P12 → datos`), `el sondeo de ${off50} debía rescatar la ventana`);

  // Y la fase fino arranca en el pre-inicio REAL (antes de 2016-11-15), no en la parada de 2022.
  const primerFino = c.lineas.find((l) => l.startsWith('fino: ventana desde '));
  assert.ok(primerFino < `fino: ventana desde ${INICIO}`, `la fase fino arrancó tarde: ${primerFino}`);
});

test('4. NEGATIVO — con K=1 (la heurística v1) la parada se lee como "sin datos" y falla', async () => {
  const c = corrida({ discover: { sondeosPorVentana: 1 } });
  const r = await c.correr();

  assert.ok(Math.abs(diffDays(INICIO, r.fecha)) > 1,
    `la v1 no debería acertar; devolvió ${r.fecha} y el inicio real es ${INICIO}`);

  // El mecanismo del fallo, explícito: certifica como pre-inicio un candidato de 2022 que en
  // realidad es una parada, y de ahí en adelante busca el inicio en el lugar equivocado.
  const primerFino = c.lineas.find((l) => l.startsWith('fino: ventana desde '));
  assert.ok(primerFino > 'fino: ventana desde 2022', `esperaba que la v1 arrancara el fino en 2022: ${primerFino}`);
});

// --- Bordes de la firma ------------------------------------------------------------------------

test('5. hint inválido se ignora y el sondeo se ancla en el techo', async () => {
  const c = corrida({ discover: { hint: 'ayer' } });
  const r = await c.correr();
  assert.ok(c.lineas.includes('hint inválido, se ignora: ayer'));
  assert.equal(r.fecha, INICIO);
});

test('6. hint válido y anterior al techo ancla ahí y no sondea por encima de su ventana', async () => {
  // OJO (L10): el test decía "acorta el sondeo" y comparaba conteos. Eso NO es una propiedad del
  // algoritmo, era suerte de alineación: el costo lo domina la fase fino (30 d por paso entre el
  // pre-inicio certificado y la cota superior), y con el coarse corregido a 365 días por vuelta
  // (H30) la corrida SIN hint aterriza más cerca del inicio y sale más barata. Lo que el hint sí
  // garantiza —y es para lo que lo usa el CLI— es que la búsqueda arranca ahí y no vuelve a mirar
  // los años que hay entre el techo y él.
  const HINT = '2017-01-10';
  const conHint = corrida({ discover: { hint: HINT } });
  const rHint = await conHint.correr();
  const sinHint = corrida();
  await sinHint.correr();

  assert.equal(rHint.fecha, INICIO);
  const tope = addDays(HINT, 60);
  for (const d of conHint.pedidos) assert.ok(d <= tope, `con hint no debía sondear ${d}`);
  assert.ok(sinHint.pedidos.some((d) => d > tope), 'sin hint el ancla es el techo y sí se sondea arriba');
  assert.ok(!conHint.lineas.some((l) => l.startsWith('coarse: ventana desde 2025')),
    'el hint se salta las vueltas del coarse que van del techo hasta él');
});

test('7. hint posterior al techo se ignora', async () => {
  const c = corrida({ discover: { hint: '2030-01-01' } });
  const r = await c.correr();
  assert.ok(c.lineas.includes(`hint 2030-01-01 es posterior al techo ${TECHO}, se ignora`));
  assert.equal(r.fecha, INICIO);
});

test('8. ni hint ni techo con datos → fecha null con motivo sin-datos', async () => {
  const c = corrida({ historiador: { inicio: '2099-01-01' }, discover: { hint: '2020-01-01' } });
  const r = await c.correr();
  assert.deepEqual({ fecha: r.fecha, motivo: r.motivo }, { fecha: null, motivo: 'sin-datos' });
  assert.ok(c.lineas.includes('ni hint ni techo tienen datos — no se puede anclar el sondeo'));

  // El CLI no ofrece confirmar nada y sale distinto de 0.
  const e = explicarDescubrimiento(r);
  assert.equal(e.confirmable, false);
  assert.equal(e.codigo, 2);
});

test('9. maxYearsBack alcanzado → devuelve el día con datos más antiguo que conoce, no null', async () => {
  // El historiador tiene datos desde 2016, pero solo se permite retroceder 3 años desde 2026.
  const c = corrida({ discover: { maxYearsBack: 3 } });
  const r = await c.correr();
  assert.ok(c.lineas.some((l) => l.startsWith('alcanzado maxYearsBack=3')));
  assert.equal(r.motivo, 'tope-alcanzado', 'no es lo mismo que haber encontrado el inicio');
  assert.ok(r.fecha > '2022-01-01' && r.fecha < TECHO, `esperaba un tope de ~2023, obtuve ${r.fecha}`);
  assert.notEqual(r.fecha, null);

  // H30: cada vuelta del coarse retrocede 365 días EXACTOS desde el ancla; antes retrocedía desde
  // el día que la ventana rescataba (candidato + hasta 50 d) y `maxYearsBack=10` alcanzaba ~8,6 años.
  assert.ok(c.lineas.includes(`coarse: ventana desde ${candidatoCoarse(3)} (-3a, 1095 d desde el ancla)`),
    `la 3.ª vuelta debía caer en ${candidatoCoarse(3)}: ${c.lineas.filter((l) => l.startsWith('coarse:')).join(' | ')}`);
});

// --- CA-41: un sondeo que falla no es un sondeo vacío (H28) -------------------------------------

test('CA-41. un fetch que falla NO se memoriza como vacío: se reintenta y el segundo intento manda', async () => {
  // El primer intento del día de inicio revienta. Antes se cacheaba como "vacío" para el resto de
  // la corrida —incluida la fase de confirmación, que releía la mentira— y el barrido diario se
  // saltaba el día: la fecha de inicio salía tarde, sin un solo aviso.
  const c = corrida({ historiador: { fallaUnaVez: [INICIO] } });
  const r = await c.correr();

  assert.equal(r.fecha, INICIO, 'el reintento recupera el día que el bache de red había tumbado');
  assert.equal(r.motivo, 'hallada');
  assert.equal(c.pedidos.filter((d) => d === INICIO).length, 2, `${INICIO} debía pedirse dos veces`);
  assert.ok(c.lineas.includes(`reintento del sondeo de ${INICIO}`), 'el reintento se loguea');
  assert.match(c.lineas.find((l) => l.startsWith(`${INICIO} P12`)), /→ error \(HTTP 500 transitorio/);
  assert.ok(c.lineas.includes(`${INICIO} P12 → datos`), 'y el segundo intento sí decide el día');
});

test('CA-41. si el SIS insiste en fallar, el sondeo para y lo dice: error-de-sondeo, sin fecha', async () => {
  // Un bache de red que tumba TODA una ventana. Antes esos seis fallos se leían como seis días
  // vacíos y certificaban un pre-inicio falso; ahora la ventana es indecidible y el descubrimiento
  // termina diciéndolo, en vez de devolver una fecha inventada.
  const ventanaPrevia = offsetsVentana(6, 60).map((o) => addDays(addDays(INICIO, -60), o));
  const c = corrida({ historiador: { falla: ventanaPrevia } });
  const r = await c.correr();

  assert.deepEqual({ fecha: r.fecha, motivo: r.motivo }, { fecha: null, motivo: 'error-de-sondeo' },
    'después de un error de red no se devuelve NINGUNA fecha');
  assert.ok(r.sondeos > 0, 'el conteo de sondeos sigue siendo real');
  const caido = ventanaPrevia.find((d) => c.pedidos.includes(d));
  assert.equal(c.pedidos.filter((d) => d === caido).length, 2, `${caido} se reintentó antes de rendirse`);
  assert.ok(c.lineas.some((l) => l.startsWith('el SIS falló dos veces en ')), 'el log dice por qué paró');

  // Y el CLI no escribe nada: sale distinto de 0 y no ofrece confirmar ninguna fecha.
  const e = explicarDescubrimiento(r);
  assert.equal(e.confirmable, false);
  assert.equal(e.codigo, 2);
  assert.match(e.lineas[0], /^el sondeo se detuvo: el SIS falló dos veces seguidas en el mismo día/);
});

// --- CA-42: la ventana del ancla se extiende hacia atrás (H29) ----------------------------------

test('CA-42. con el techo en un día de parada el ancla igual encuentra el inicio', async () => {
  // Un solo día de parada sobre el techo bastaba para matar el sondeo: la ventana del ancla se
  // recortaba a K=1 (los offsets 10..50 caían en el futuro y se descartaban), ese único sondeo
  // salía vacío y, sin hint, `discoverEarliestDate` devolvía null y el CLI moría con exit 2.
  const paradaEnElTecho = [addDays(TECHO, -3), TECHO];
  const c = corrida({ historiador: { paradas: [PARADA_2018, paradaEnElTecho] } });
  const r = await c.correr();

  assert.equal(r.motivo, 'hallada', 'la parada del techo no puede impedir anclar el sondeo');
  assert.equal(r.fecha, INICIO);
  assert.ok(
    c.lineas.includes(`ventana de ${TECHO} no cabe hasta el techo ${TECHO}: se extiende hacia atrás desde ${ANCLA}`),
    'el log dice que la ventana se corrió hacia atrás',
  );
  // La regla no cambia: siguen siendo K sondeos en W días, y ninguno pasa del techo.
  const sondeosDelAncla = offsetsVentana(6, 60).map((o) => addDays(ANCLA, o));
  assert.equal(sondeosDelAncla[sondeosDelAncla.length - 1], TECHO, 'la ventana termina justo en el techo');
  for (const d of c.pedidos) assert.ok(d <= TECHO, `se sondeó el futuro: ${d}`);
});

// --- CA-43: el resultado dice POR QUÉ paró, y el CLI lo distingue -------------------------------

test('CA-43. el retorno es { fecha, motivo, sondeos } y el CLI distingue hallada de tope-alcanzado', async () => {
  const hallada = await corrida().correr();
  assert.deepEqual(Object.keys(hallada).sort(), ['fecha', 'motivo', 'sondeos']);
  assert.equal(hallada.motivo, 'hallada');
  assert.ok(Number.isInteger(hallada.sondeos) && hallada.sondeos > 0);

  // Lo que imprime el CLI, literal (va prefijado con "[backfill] " en cada línea).
  assert.deepEqual(explicarDescubrimiento(hallada), {
    lineas: [`fecha de inicio = ${INICIO} (${hallada.sondeos} sondeos)`],
    confirmable: true,
    codigo: 3,
  });

  const tope = await corrida({ discover: { maxYearsBack: 3 } }).correr();
  assert.equal(tope.motivo, 'tope-alcanzado');
  assert.notEqual(tope.fecha, null);
  const e = explicarDescubrimiento(tope);
  assert.equal(e.codigo, 4, 'el código de salida distingue el tope de una fecha hallada');
  assert.equal(e.confirmable, true, 'se puede confirmar igual, pero sabiendo lo que se confirma');
  assert.deepEqual(e.lineas, [
    `llegué al tope de retroceso SIN certificar el inicio (${tope.sondeos} sondeos).`,
    `el día más antiguo con datos que conozco es ${tope.fecha}, pero puede haber historia más atrás: confírmalo antes de tomarlo como la primera fecha del SIS.`,
  ]);
  assert.ok(!e.lineas.join(' ').includes('fecha de inicio ='),
    'una fecha truncada NO puede imprimirse como si fuera la respuesta');
});

// --- Bordes que no cambian ---------------------------------------------------------------------

test('11. formato del log de cada sondeo: "<fecha> P<periodo> → datos|vacío|error"', async () => {
  const c = corrida({ discover: { periodoProbe: 7 } });
  await c.correr();
  const sondeos = c.lineas.filter((l) => / P7 → /.test(l));
  assert.ok(sondeos.length > 0, 'no se logueó ningún sondeo');
  for (const l of sondeos) {
    assert.match(l, /^\d{4}-\d{2}-\d{2} P7 → (datos|vacío|error \(.*\))$/, `log fuera de formato: ${l}`);
  }
});

test('12. techo inválido lanza antes de pedirle nada al SIS', async () => {
  const { fetchFn, pedidos } = historiador();
  await assert.rejects(
    () => discoverEarliestDate(null, { techo: '26/08/2026', fetchFn }),
    /techo inválido/,
  );
  assert.equal(pedidos.length, 0, 'no debía sondear nada');
});

test('13. ventanaDias/sondeosPorVentana son parametrizables: W más ancho tolera paradas más largas', async () => {
  // Parada de 100 días sobre el candidato coarse de 2022: con W=60 (span 50) la ventana se vacía y
  // la v2 falla igual que la v1; con W=240 (span 200) la parada no alcanza a taparla.
  const paradaLarga = [candidatoCoarse(4), addDays(candidatoCoarse(4), 99)];
  const paradas = [PARADA_2018, paradaLarga];

  const angosta = corrida({ historiador: { paradas } });
  const rAngosta = await angosta.correr();
  assert.ok(Math.abs(diffDays(INICIO, rAngosta.fecha)) > 1,
    `con W=60 y una parada de 100 días esperaba fallar; devolvió ${rAngosta.fecha}`);

  const ancha = corrida({ historiador: { paradas }, discover: { ventanaDias: 240, sondeosPorVentana: 6 } });
  const rAncha = await ancha.correr();
  assert.ok(Math.abs(diffDays(INICIO, rAncha.fecha)) <= 1,
    `con W=240 esperaba ${INICIO} ±1, obtuve ${rAncha.fecha}`);
});
