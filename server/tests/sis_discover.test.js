import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverEarliestDate, offsetsVentana, addDays, diffDays,
} from '../utils/sis/discover.js';

// D-061 / CA-20: `discover` v2 con K sondeos repartidos en una ventana de W días. Test PURO —
// sin BD, sin red: el SIS se reemplaza por un HISTORIADOR SIMULADO (`historiador()`) que sabe
// desde qué día hay datos y en qué rangos la unidad estuvo parada.
//
// Lo que fijan estos tests es la razón de ser de la v2. La v1 declaraba "sin datos" con UN solo
// sondeo, así que una parada de 45 días leída en el candidato equivocado se confundía con "acá el
// SIS todavía no existía". El verificador es BIDIRECCIONAL: el mismo historiador se corre con
// K=6 (verde, ±0 días) y con K=1 —la heurística v1— (rojo: se traga la parada y falla por más de
// un día). Si alguien "simplifica" la v2 a un sondeo por candidato, el test 4 se cae.

const INICIO = '2016-11-15';   // primer día con datos del historiador simulado.
const TECHO = '2026-08-26';    // "hoy" del escenario (fecha de redacción del lote).

// Candidatos exactos de la fase coarse: el barrido retrocede 365 días desde el ancla y, mientras
// cada candidato tenga datos en su primer sondeo, el ancla queda en el candidato mismo.
const candidatoCoarse = (y) => {
  let d = TECHO;
  for (let i = 0; i < y; i++) d = addDays(d, -365);
  return d;
};

// La parada larga se planta EXACTAMENTE sobre el 4.º candidato coarse (2022): es el caso que hace
// fallar a la v1. 45 días < 50 (el span de los 6 sondeos de una ventana de 60), así que la v2 no
// puede vaciar la ventana con ella.
const PARADA_2022 = [candidatoCoarse(4), addDays(candidatoCoarse(4), 44)];
const PARADA_2018 = ['2018-03-01', '2018-04-14'];

const FILA_CON_DATOS = [null, 14.46, 14.44, 16.42, 14.82, 17.18, 17.59, 17.23, 15.71, 279.69, 966.91, 902.78, 255.8];
const FILA_VACIA = [null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// fetchFn simulado. Devuelve el mismo shape que fetchPeriod: { lastRow, ncols }. Registra cada
// fecha pedida para poder afirmar sobre el costo (la caché) además del resultado.
function historiador({ inicio = INICIO, paradas = [PARADA_2018, PARADA_2022], falla = [] } = {}) {
  const pedidos = [];
  const fetchFn = async (f1) => {
    pedidos.push(f1);
    if (falla.includes(f1)) throw new Error(`HTTP 500 simulado en ${f1}`);
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
  assert.ok(Math.abs(diffDays(INICIO, r)) <= 1, `esperaba ${INICIO} ±1 día, obtuve ${r}`);
  assert.equal(r, INICIO, 'con este historiador la v2 cae justo en el día de inicio');

  // Ningún día se le pidió dos veces al SIS: la caché es lo que hace viable la rejilla solapada.
  assert.equal(new Set(c.pedidos).size, c.pedidos.length, `hay fechas repetidas: ${c.pedidos.length} pedidos`);
  assert.ok(c.pedidos.length < 120, `demasiados sondeos (${c.pedidos.length}); a ~13 s cada uno no cierra`);
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

  // Y la fase fino arranca en el pre-inicio REAL (2015), no en la parada de 2022.
  const primerFino = c.lineas.find((l) => l.startsWith('fino: ventana desde '));
  assert.ok(primerFino < 'fino: ventana desde 2016', `la fase fino arrancó tarde: ${primerFino}`);
});

test('4. NEGATIVO — con K=1 (la heurística v1) la parada se lee como "sin datos" y falla', async () => {
  const c = corrida({ discover: { sondeosPorVentana: 1 } });
  const r = await c.correr();

  assert.ok(Math.abs(diffDays(INICIO, r)) > 1,
    `la v1 no debería acertar; devolvió ${r} y el inicio real es ${INICIO}`);

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
  assert.equal(r, INICIO);
});

test('6. hint válido y anterior al techo acorta el sondeo', async () => {
  const conHint = corrida({ discover: { hint: '2017-01-10' } });
  const rHint = await conHint.correr();
  const sinHint = corrida();
  await sinHint.correr();

  assert.equal(rHint, INICIO);
  assert.ok(conHint.pedidos.length < sinHint.pedidos.length,
    `el hint debía ahorrar sondeos: ${conHint.pedidos.length} vs ${sinHint.pedidos.length}`);
});

test('7. hint posterior al techo se ignora', async () => {
  const c = corrida({ discover: { hint: '2030-01-01' } });
  const r = await c.correr();
  assert.ok(c.lineas.includes(`hint 2030-01-01 es posterior al techo ${TECHO}, se ignora`));
  assert.equal(r, INICIO);
});

test('8. ni hint ni techo con datos → null', async () => {
  const c = corrida({ historiador: { inicio: '2099-01-01' }, discover: { hint: '2020-01-01' } });
  const r = await c.correr();
  assert.equal(r, null);
  assert.ok(c.lineas.includes('ni hint ni techo tienen datos — no se puede anclar el sondeo'));
});

test('9. maxYearsBack alcanzado → devuelve el día con datos más antiguo que conoce, no null', async () => {
  // El historiador tiene datos desde 2016, pero solo se permite retroceder 3 años desde 2026.
  const c = corrida({ discover: { maxYearsBack: 3 } });
  const r = await c.correr();
  assert.ok(c.lineas.some((l) => l.startsWith('alcanzado maxYearsBack=3')));
  assert.ok(r > '2022-01-01' && r < TECHO, `esperaba un tope de ~2023, obtuve ${r}`);
  assert.notEqual(r, null);
});

test('10. un fetch que lanza cuenta como vacío y no aborta el sondeo', async () => {
  const rotos = [addDays(INICIO, -10), addDays(INICIO, -20)];
  const c = corrida({ historiador: { falla: rotos } });
  const r = await c.correr();
  assert.equal(r, INICIO, 'los fetch rotos son días previos al inicio: no mueven el resultado');
  for (const d of rotos) {
    const linea = c.lineas.find((l) => l.startsWith(`${d} P12`));
    if (linea) assert.match(linea, /→ error \(HTTP 500 simulado/, `el log de ${d} debe decir error`);
  }
});

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
  assert.ok(Math.abs(diffDays(INICIO, rAngosta)) > 1,
    `con W=60 y una parada de 100 días esperaba fallar; devolvió ${rAngosta}`);

  const ancha = corrida({ historiador: { paradas }, discover: { ventanaDias: 240, sondeosPorVentana: 6 } });
  const rAncha = await ancha.correr();
  assert.ok(Math.abs(diffDays(INICIO, rAncha)) <= 1,
    `con W=240 esperaba ${INICIO} ±1, obtuve ${rAncha}`);
});
