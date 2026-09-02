// D-065 L01 · Motor del patrón de rotación. Test PURO: sin BD, sin servidor, sin reloj — el oráculo
// (`fixtures/rotacion-oraculo-2026.json`, volcado de Rotacion2026.xlsx y verificado el 2026-08-31)
// es la única fuente de verdad, y el Excel no se abre en tiempo de test.
//
// CA-1: `grupoDeTurno` reproduce el oráculo sin una sola discrepancia en los 730 pares
//       (fecha, turno) de cada malla, 2026-02-01 … 2027-01-31.
// CA-2: el desfase se DERIVA de (fecha_inicio, grupo_t1, grupo_t2); con un solo grupo el motor
//       lanza `desfase_ambiguo` en vez de adivinar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LARGO_CICLO,
  parsearVector,
  serializarVector,
  derivarDesfase,
  diasEntre,
  diaDelCiclo,
  grupoDeTurno,
  desfaseDeContinuidad,
} from '../utils/rotacion/patron.js';

const oraculo = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/rotacion-oraculo-2026.json', import.meta.url)), 'utf8'),
);

const ROLES = ['OPS', 'ING'];

// El oráculo guarda el ancla aparte de los patrones; el motor la espera como `fecha_inicio`.
const patronDe = (rol) => ({ fecha_inicio: oraculo.ancla, ...oraculo.patrones[rol] });

const lanza = (codigo) => (err) => err instanceof Error && err.message === codigo;

// Helper local del test: suma días a un 'YYYY-MM-DD' con la misma aritmética UTC del módulo, para
// no depender del huso de la máquina que corre la suite.
function sumarDias(fechaIso, n) {
  const [y, m, d] = fechaIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ── CA-1 ──────────────────────────────────────────────────────────────────────────────────────

test('el motor reproduce el oráculo del Excel sin una sola discrepancia', () => {
  let pares = 0;
  const discrepancias = [];

  for (const rol of ROLES) {
    const patron = patronDe(rol);
    for (const [fecha, [esperadoT1, esperadoT2]] of Object.entries(oraculo.dias[rol])) {
      for (const [turno, esperado] of [[1, esperadoT1], [2, esperadoT2]]) {
        pares += 1;
        const obtenido = grupoDeTurno(patron, fecha, turno);
        if (obtenido !== esperado) {
          discrepancias.push(`${rol} ${fecha} T${turno}: el Excel dice ${esperado}, el motor dice ${obtenido}`);
        }
      }
    }
  }

  assert.equal(
    discrepancias.length,
    0,
    `${discrepancias.length} discrepancia(s) contra el Excel. La primera: ${discrepancias[0]}`,
  );
  // 365 días × 2 turnos × 2 mallas. Si el fixture se recorta, esto lo delata antes de que un
  // "0 discrepancias" sobre 3 días pase por victoria.
  assert.equal(pares, 1460, 'el oráculo no trae los 730 pares por malla');
});

test('el oráculo trae las dos mallas completas, de 2026-02-01 a 2027-01-31', () => {
  assert.equal(oraculo.ancla, '2026-02-01');
  for (const rol of ROLES) {
    const fechas = Object.keys(oraculo.dias[rol]);
    assert.equal(fechas.length, 365, `${rol} no trae 365 días`);
    assert.equal(fechas[0], '2026-02-01');
    assert.equal(fechas[fechas.length - 1], '2027-01-31');
  }
});

test('los vectores del fixture son los medidos sobre el Excel (dato duro de §2.2)', () => {
  assert.deepEqual(oraculo.patrones.OPS.vector_t1, [1, 1, 3, 3, 4, 4, 2, 2]);
  assert.deepEqual(oraculo.patrones.OPS.vector_t2, [4, 2, 2, 1, 1, 3, 3, 4]);
  assert.equal(oraculo.patrones.OPS.desfase, 3);
  assert.deepEqual(oraculo.patrones.ING.vector_t1, [1, 1, 2, 2, 4, 4, 3, 3]);
  assert.deepEqual(oraculo.patrones.ING.vector_t2, [4, 3, 3, 1, 1, 2, 2, 4]);
  assert.equal(oraculo.patrones.ING.desfase, 2);
});

test('la periodicidad es de 8 días: cada fecha da el mismo grupo que la de 8 días después', () => {
  for (const rol of ROLES) {
    const patron = patronDe(rol);
    const fechas = Object.keys(oraculo.dias[rol]);
    for (let i = 0; i + LARGO_CICLO < fechas.length; i += 1) {
      for (const turno of [1, 2]) {
        assert.equal(
          grupoDeTurno(patron, fechas[i], turno),
          grupoDeTurno(patron, fechas[i + LARGO_CICLO], turno),
          `${rol} T${turno}: ${fechas[i]} y ${fechas[i + LARGO_CICLO]} deberían coincidir`,
        );
      }
    }
  }
});

// ── CA-2 ──────────────────────────────────────────────────────────────────────────────────────

test('derivarDesfase', async (t) => {
  const ops = patronDe('OPS');
  const ing = patronDe('ING');

  await t.test('OPS: el 2026-02-01 arranca el grupo 3 de día y el 1 de noche → desfase 3', () => {
    assert.equal(
      derivarDesfase({ vectorT1: ops.vector_t1, vectorT2: ops.vector_t2, grupoT1: 3, grupoT2: 1 }),
      3,
    );
  });

  await t.test('ING: el 2026-02-01 arranca el grupo 2 de día y el 3 de noche → desfase 2', () => {
    assert.equal(
      derivarDesfase({ vectorT1: ing.vector_t1, vectorT2: ing.vector_t2, grupoT1: 2, grupoT2: 3 }),
      2,
    );
  });

  await t.test('el desfase derivado es el que el oráculo trae guardado, en las dos mallas', () => {
    for (const rol of ROLES) {
      const patron = patronDe(rol);
      const [grupoT1, grupoT2] = oraculo.dias[rol][oraculo.ancla];
      assert.equal(
        derivarDesfase({ vectorT1: patron.vector_t1, vectorT2: patron.vector_t2, grupoT1, grupoT2 }),
        patron.desfase,
        `${rol}`,
      );
    }
  });

  await t.test('un par que no existe en la malla → desfase_imposible', () => {
    // OPS: el grupo 1 sólo hace T1 en los índices 0 y 1, y esas dos noches son de los grupos 4 y 2.
    // Un "grupo 1 de día y grupo 3 de noche" no ocurre nunca.
    assert.throws(
      () => derivarDesfase({ vectorT1: ops.vector_t1, vectorT2: ops.vector_t2, grupoT1: 1, grupoT2: 3 }),
      lanza('desfase_imposible'),
    );
  });

  await t.test('con un vector degenerado (T2 = T1) el par deja de ser único → desfase_ambiguo', () => {
    // Preguntar sólo por el grupo de T1 es equivalente a esto: V1 toma 4 valores en 8 índices, así
    // que cada respuesta cuadra con DOS desfases. El motor no elige: lanza.
    assert.throws(
      () => derivarDesfase({ vectorT1: ops.vector_t1, vectorT2: ops.vector_t1, grupoT1: 3, grupoT2: 3 }),
      lanza('desfase_ambiguo'),
    );
  });

  await t.test('el grupo de T1 solo NUNCA alcanza: cada valor sale en exactamente 2 índices', () => {
    for (const rol of ROLES) {
      const { vector_t1: v1 } = patronDe(rol);
      for (const grupo of [1, 2, 3, 4]) {
        const indices = v1.reduce((acc, g, i) => (g === grupo ? [...acc, i] : acc), []);
        assert.equal(indices.length, 2, `${rol}: el grupo ${grupo} debería salir 2 veces en V1`);
      }
    }
  });

  await t.test('los 8 pares (V1[i], V2[i]) sí son todos distintos: por eso dos grupos bastan', () => {
    for (const rol of ROLES) {
      const { vector_t1: v1, vector_t2: v2 } = patronDe(rol);
      const pares = new Set(v1.map((g, i) => `${g}-${v2[i]}`));
      assert.equal(pares.size, LARGO_CICLO, `${rol}: hay pares repetidos`);
    }
  });

  await t.test('un vector malformado no se interpreta a la brava → vector_invalido', () => {
    assert.throws(
      () => derivarDesfase({ vectorT1: '1,1,3,3,4,4,2,2', vectorT2: ops.vector_t2, grupoT1: 3, grupoT2: 1 }),
      lanza('vector_invalido'),
    );
    assert.throws(() => derivarDesfase(), lanza('vector_invalido'));
  });
});

// ── parsearVector / serializarVector ──────────────────────────────────────────────────────────

test('parsearVector acepta la malla real y tolera espacios', () => {
  assert.deepEqual(parsearVector('1,1,3,3,4,4,2,2'), [1, 1, 3, 3, 4, 4, 2, 2]);
  assert.deepEqual(parsearVector(' 4, 2 ,2,1,1,3,3,4 '), [4, 2, 2, 1, 1, 3, 3, 4]);
});

test('parsearVector rechaza todo lo que no sean 8 enteros en 1..4', () => {
  const malos = [
    ['1,1,3,3,4,4,2', 'siete elementos'],
    ['1,1,3,3,4,4,2,2,1', 'nueve elementos'],
    ['1,1,3,3,5,4,2,2', 'un 5 fuera de rango'],
    ['1,1,3,3,0,4,2,2', 'un 0 fuera de rango'],
    ['', 'vacío'],
    ['1,1,3,3,4,4,2,', 'con un hueco al final'],
    ['1,1,3,3,4,4,2,a', 'una letra'],
    ['1,1,3,3,4,4,2,1.5', 'un decimal'],
    ['1,1,3,3,4,4,2,-2', 'un negativo'],
  ];
  for (const [texto, porque] of malos) {
    assert.throws(() => parsearVector(texto), lanza('vector_invalido'), porque);
  }
  for (const noTexto of [null, undefined, 42, ['1', '1'], [1, 1, 3, 3, 4, 4, 2, 2]]) {
    assert.throws(() => parsearVector(noTexto), lanza('vector_invalido'), String(noTexto));
  }
});

test('serializarVector es la inversa exacta de parsearVector', () => {
  for (const rol of ROLES) {
    const { vector_t1: v1, vector_t2: v2 } = patronDe(rol);
    for (const vector of [v1, v2]) {
      const texto = serializarVector(vector);
      assert.deepEqual(parsearVector(texto), vector);
      assert.equal(serializarVector(parsearVector(texto)), texto);
    }
  }
  assert.equal(serializarVector([1, 1, 3, 3, 4, 4, 2, 2]), '1,1,3,3,4,4,2,2');
});

test('serializarVector rechaza un arreglo que no es una malla válida', () => {
  for (const malo of [[1, 2, 3], [1, 1, 3, 3, 4, 4, 2, 9], 'no soy arreglo', null]) {
    assert.throws(() => serializarVector(malo), lanza('vector_invalido'), JSON.stringify(malo));
  }
});

// ── diasEntre ─────────────────────────────────────────────────────────────────────────────────

test('diasEntre cuenta días de calendario, con signo', () => {
  assert.equal(diasEntre('2026-02-01', '2026-02-01'), 0);
  assert.equal(diasEntre('2026-02-01', '2026-02-09'), 8);
  assert.equal(diasEntre('2026-02-09', '2026-02-01'), -8, 'negativo si la segunda es anterior');
});

test('diasEntre cruza el cambio de año', () => {
  assert.equal(diasEntre('2026-12-31', '2027-01-01'), 1);
  assert.equal(diasEntre('2026-02-01', '2027-01-31'), 364, 'el largo del periodo del oráculo');
  assert.equal(diasEntre('2026-02-01', '2027-02-01'), 365, 'un año no bisiesto');
});

test('diasEntre respeta los años bisiestos (2028 lo es; 2026 y 2027 no)', () => {
  assert.equal(diasEntre('2028-02-28', '2028-03-01'), 2, '2028 tiene 29 de febrero');
  assert.equal(diasEntre('2027-02-28', '2027-03-01'), 1, '2027 no lo tiene');
  assert.equal(diasEntre('2028-02-28', '2028-02-29'), 1);
  assert.equal(diasEntre('2028-01-01', '2029-01-01'), 366, 'un año bisiesto completo');
});

test('diasEntre no acepta un Date ni una fecha inventada', () => {
  assert.throws(() => diasEntre(new Date('2026-02-01'), '2026-02-02'), lanza('fecha_invalida'));
  assert.throws(() => diasEntre('2026-02-01T00:00:00Z', '2026-02-02'), lanza('fecha_invalida'));
  assert.throws(() => diasEntre('2026-02-30', '2026-03-01'), lanza('fecha_invalida'), '30 de febrero');
  assert.throws(() => diasEntre('2027-02-29', '2027-03-01'), lanza('fecha_invalida'), '2027 no es bisiesto');
  assert.throws(() => diasEntre('2026-2-1', '2026-02-02'), lanza('fecha_invalida'), 'sin ceros de relleno');
  assert.throws(() => diasEntre(null, '2026-02-02'), lanza('fecha_invalida'));
});

// ── diaDelCiclo ───────────────────────────────────────────────────────────────────────────────

test('diaDelCiclo arranca en el desfase y avanza de a uno', () => {
  const ops = patronDe('OPS'); // desfase 3
  assert.equal(diaDelCiclo(ops, '2026-02-01'), 3);
  assert.equal(diaDelCiclo(ops, '2026-02-02'), 4);
  assert.equal(diaDelCiclo(ops, '2026-02-05'), 7);
  assert.equal(diaDelCiclo(ops, '2026-02-06'), 0, 'da la vuelta');
  assert.equal(diaDelCiclo(ops, '2026-02-09'), 3, 'ocho días después, el mismo índice');
});

test('diaDelCiclo con una fecha ANTERIOR al inicio da un índice válido, no un negativo', () => {
  const ops = patronDe('OPS');
  for (const fecha of ['2026-01-31', '2026-01-29', '2026-01-01', '2020-06-15']) {
    const i = diaDelCiclo(ops, fecha);
    assert.ok(Number.isInteger(i) && i >= 0 && i < LARGO_CICLO, `${fecha} → ${i}`);
  }
  assert.equal(diaDelCiclo(ops, '2026-01-31'), 2, 'el día antes del ancla');
  assert.equal(diaDelCiclo(ops, '2026-01-29'), 0);
  assert.equal(diaDelCiclo(ops, '2026-01-28'), 7, 'sigue dando la vuelta hacia atrás');
});

test('diaDelCiclo rechaza un patrón sin desfase entero', () => {
  const malos = [
    null,
    undefined,
    {},
    { fecha_inicio: '2026-02-01' },
    { fecha_inicio: '2026-02-01', desfase: '3' },
    { fecha_inicio: '2026-02-01', desfase: 1.5 },
  ];
  for (const malo of malos) {
    assert.throws(() => diaDelCiclo(malo, '2026-02-01'), lanza('patron_invalido'), JSON.stringify(malo));
  }
});

// ── grupoDeTurno ──────────────────────────────────────────────────────────────────────────────

test('grupoDeTurno sólo conoce los turnos 1 y 2 (no hay tres turnos)', () => {
  const ops = patronDe('OPS');
  for (const turno of [3, 0, -1, '1', '2', null, undefined, 1.0000001, true]) {
    assert.throws(() => grupoDeTurno(ops, '2026-02-01', turno), lanza('turno_invalido'), String(turno));
  }
  assert.equal(grupoDeTurno(ops, '2026-02-01', 1), 3);
  assert.equal(grupoDeTurno(ops, '2026-02-01', 2), 1);
});

test('grupoDeTurno devuelve siempre un grupo de 1 a 4', () => {
  for (const rol of ROLES) {
    const patron = patronDe(rol);
    for (const fecha of Object.keys(oraculo.dias[rol])) {
      for (const turno of [1, 2]) {
        const g = grupoDeTurno(patron, fecha, turno);
        assert.ok([1, 2, 3, 4].includes(g), `${rol} ${fecha} T${turno} → ${g}`);
      }
    }
  }
});

test('grupoDeTurno se puede consultar hacia atrás del ancla sin romperse', () => {
  const ops = patronDe('OPS');
  // 2026-01-24 está 8 días antes del ancla → mismo grupo que el ancla.
  assert.equal(grupoDeTurno(ops, '2026-01-24', 1), grupoDeTurno(ops, '2026-02-01', 1));
  assert.equal(grupoDeTurno(ops, '2026-01-24', 2), grupoDeTurno(ops, '2026-02-01', 2));
});

// ── desfaseDeContinuidad ──────────────────────────────────────────────────────────────────────

test('desfaseDeContinuidad: encadenar dos periodos reproduce la secuencia como si fuera uno solo', () => {
  for (const rol of ROLES) {
    const viejo = patronDe(rol);
    const inicioSiguiente = '2027-02-01'; // el periodo 2027-2028 arranca donde terminó el de 2026.
    const nuevo = {
      fecha_inicio: inicioSiguiente,
      vector_t1: viejo.vector_t1,
      vector_t2: viejo.vector_t2,
      desfase: desfaseDeContinuidad(viejo, inicioSiguiente),
    };

    // La costura: el primer día del periodo nuevo tiene que dar lo mismo por los dos caminos, y el
    // día anterior (último del viejo) tiene que ser el índice INMEDIATAMENTE anterior en el ciclo —
    // ni salto ni día repetido.
    assert.equal(diaDelCiclo(nuevo, inicioSiguiente), diaDelCiclo(viejo, inicioSiguiente), `${rol}: la costura`);
    assert.equal(
      diaDelCiclo(viejo, '2027-01-31'),
      (diaDelCiclo(nuevo, inicioSiguiente) + LARGO_CICLO - 1) % LARGO_CICLO,
      `${rol}: el día anterior a la costura`,
    );

    // Y los 365 días del periodo nuevo coinciden con lo que habría dicho el patrón viejo si lo
    // hubiéramos dejado correr de largo.
    for (let n = 0; n < 365; n += 1) {
      const fecha = sumarDias(inicioSiguiente, n);
      for (const turno of [1, 2]) {
        assert.equal(
          grupoDeTurno(nuevo, fecha, turno),
          grupoDeTurno(viejo, fecha, turno),
          `${rol} ${fecha} T${turno}: el periodo nuevo se despegó del viejo`,
        );
      }
    }
  }
});

test('desfaseDeContinuidad devuelve un desfase válido aunque el corte no caiga en múltiplo de 8', () => {
  const ops = patronDe('OPS');
  for (const fecha of ['2027-02-01', '2027-02-02', '2027-02-03', '2026-02-01']) {
    const d = desfaseDeContinuidad(ops, fecha);
    assert.ok(Number.isInteger(d) && d >= 0 && d < LARGO_CICLO, `${fecha} → ${d}`);
  }
  assert.equal(desfaseDeContinuidad(ops, '2026-02-01'), ops.desfase, 'continuar desde el propio inicio no mueve nada');
});
