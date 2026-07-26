// D-058 · E1 — Motor de asientos de operación. UNITARIO PURO: sin BD, sin servidor, sin reloj.
// Si este archivo tarda más que milisegundos, algo tocó la BD y está mal.
//
// Fija la especificación de `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md` §4 y §5: las
// convenciones canónicas y las plantillas por tipo. Los cinco eventos reales de enero (§3(d)) se
// prueban ya normalizados — son el contrato con el papel.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asientoLote,
  asientoDisponibilidad,
  asientoLiteralSala,
  unidadCanonica,
  potenciaMW,
  listaPeriodos,
  carga,
  UNIDAD_YA_NOMBRADA,
} from '../utils/asientos/index.js';

// Helper: `[{periodo, valor_mw}]` con el mismo valor en todos los periodos.
const celdas = (periodos, valor_mw) => periodos.map((periodo) => ({ periodo, valor_mw }));

// ─────────────────────────────────────────────────────────── convenciones canónicas (§4)

test('unidadCanonica: identidad para las plantas reales, y no lanza con otras', () => {
  assert.equal(unidadCanonica('GEC3'), 'GEC3');
  assert.equal(unidadCanonica('GEC32'), 'GEC32');
  assert.equal(unidadCanonica('TST'), 'TST');   // el motor no valida catálogo
  assert.equal(unidadCanonica(null), '');
});

test('potenciaMW: entero, espacio antes de la unidad, NUNCA MWh', () => {
  assert.equal(potenciaMW(150), '150 MW');
  assert.equal(potenciaMW(0), '0 MW');
  assert.equal(potenciaMW(149.6), '150 MW');    // FLOAT en BD → entero en el texto
  assert.equal(potenciaMW('164'), '164 MW');
  assert.equal(potenciaMW(null), '');           // vacío ≠ cero: `Number(null)` es 0 y mentiría
  assert.equal(potenciaMW(undefined), '');
  assert.equal(potenciaMW(NaN), '');
});

test('celdas vacías o inválidas no inventan un 0 MW ni un P0', () => {
  assert.equal(carga([{ periodo: 17, valor_mw: null }]), '');
  assert.equal(carga([{ periodo: null, valor_mw: 150 }]), '');
  assert.equal(carga([{ periodo: 17, valor_mw: 'abc' }]), '');
  // Las válidas sobreviven aunque vengan mezcladas con basura.
  assert.equal(carga([{ periodo: 17, valor_mw: 150 }, { periodo: 18, valor_mw: null }]), '150 MW en el P17');
  assert.equal(listaPeriodos([null, 3, undefined, 7]), 'P3 y P7');
});

test('listaPeriodos: suelto, rango contiguo y no contiguos', () => {
  assert.equal(listaPeriodos([20]), 'P20');
  assert.equal(listaPeriodos([17, 18, 19]), 'P17 al P19');
  assert.equal(listaPeriodos([17, 18]), 'P17 al P18');
  assert.equal(listaPeriodos([3, 7, 19]), 'P3, P7 y P19');
  assert.equal(listaPeriodos([3, 7]), 'P3 y P7');
  assert.equal(listaPeriodos([]), '');
});

test('listaPeriodos: ordena ascendente y deduplica', () => {
  assert.equal(listaPeriodos([19, 17, 18]), 'P17 al P19');
  assert.equal(listaPeriodos([19, 3, 7, 3]), 'P3, P7 y P19');
});

test('carga: compacta si todas las celdas comparten valor, lista si difieren', () => {
  assert.equal(carga(celdas([17, 18, 19], 150)), '150 MW del P17 al P19');
  assert.equal(carga(celdas([20], 115)), '115 MW en el P20');
  assert.equal(carga(celdas([3, 7, 19], 150)), '150 MW en los P3, P7 y P19');
  assert.equal(
    carga([{ periodo: 17, valor_mw: 109 }, { periodo: 18, valor_mw: 134 }, { periodo: 19, valor_mw: 164 }]),
    'P17: 109 MW; P18: 134 MW; P19: 164 MW',
  );
  assert.equal(carga([]), '');
});

// ─────────────────────────────────────────────────────────── Operación 24h (§5.1 a §5.3)

test('AUTH: el caso real del 30/01 normalizado', () => {
  assert.equal(
    asientoLote({ tipo: 'AUTH', planta_id: 'GEC3', funcionariocnd: 'Jair Pardo', periodos: celdas([17, 18, 19], 150) }),
    'Se recibe llamada del CND (Jair Pardo) autorizando GEC3 a generar 150 MW del P17 al P19.',
  );
});

test('AUTH: el segundo caso real del 30/01 — periodo suelto', () => {
  assert.equal(
    asientoLote({ tipo: 'AUTH', planta_id: 'GEC3', funcionariocnd: 'Jair Pardo', periodos: celdas([20], 115) }),
    'Se recibe llamada del CND (Jair Pardo) autorizando GEC3 a generar 115 MW en el P20.',
  );
});

test('AUTH sin verbo de sentido (decisión A): jamás subir ni bajar', () => {
  const txt = asientoLote({ tipo: 'AUTH', planta_id: 'GEC32', funcionariocnd: 'Ivan Hernandez', periodos: celdas([14, 15, 16, 17, 18], 270) });
  assert.match(txt, /a generar 270 MW del P14 al P18\.$/);
  assert.doesNotMatch(txt, /subir|bajar/i);
});

test('AUTH sin funcionario: se omite el paréntesis, no se inventa texto', () => {
  const txt = asientoLote({ tipo: 'AUTH', planta_id: 'GEC3', periodos: celdas([17], 150) });
  assert.equal(txt, 'Se recibe llamada del CND autorizando GEC3 a generar 150 MW en el P17.');
  assert.doesNotMatch(txt, /\(\)/);
});

test('REDESP con valores distintos por periodo (caso real del 27/01)', () => {
  assert.equal(
    asientoLote({
      tipo: 'REDESP',
      planta_id: 'GEC3',
      periodos: [{ periodo: 17, valor_mw: 109 }, { periodo: 18, valor_mw: 134 }, { periodo: 19, valor_mw: 164 }],
    }),
    'Se recibe del CND redespacho para GEC3: P17: 109 MW; P18: 134 MW; P19: 164 MW.',
  );
});

test('REDESP plano a cero con detalle (caso real del 06/01)', () => {
  assert.equal(
    asientoLote({
      tipo: 'REDESP',
      planta_id: 'GEC3',
      periodos: celdas(Array.from({ length: 24 }, (_, i) => i + 1), 0),
      detalle: 'Aplicado en RIO',
    }),
    'Se recibe del CND redespacho para GEC3: 0 MW del P1 al P24. Aplicado en RIO.',
  );
});

test('PRUEBA: redacción neutra, sin funcionario (decisión G)', () => {
  assert.equal(
    asientoLote({ tipo: 'PRUEBA', planta_id: 'GEC32', periodos: celdas([9, 10, 11], 270) }),
    'Se declara prueba de GEC32 a 270 MW del P9 al P11.',
  );
});

test('el detalle va al final tras punto, y sin detalle la frase termina en el dato duro', () => {
  const base = { tipo: 'PRUEBA', planta_id: 'GEC32', periodos: celdas([9], 270) };
  assert.equal(asientoLote(base), 'Se declara prueba de GEC32 a 270 MW en el P9.');
  assert.equal(asientoLote({ ...base, detalle: '' }), 'Se declara prueba de GEC32 a 270 MW en el P9.');
  assert.equal(asientoLote({ ...base, detalle: null }), 'Se declara prueba de GEC32 a 270 MW en el P9.');
  assert.equal(
    asientoLote({ ...base, detalle: '  Coordinado con XM.  ' }),
    'Se declara prueba de GEC32 a 270 MW en el P9. Coordinado con XM.',
  );
});

test('el detalle multilínea se aplana a un renglón (el asiento es UNA línea)', () => {
  assert.equal(
    asientoLote({ tipo: 'PRUEBA', planta_id: 'GEC3', periodos: celdas([9], 150), detalle: 'Linea uno\nlinea dos' }),
    'Se declara prueba de GEC3 a 150 MW en el P9. Linea uno linea dos.',
  );
});

test('un tipo desconocido LANZA — no emite un renglón en blanco', () => {
  assert.throws(() => asientoLote({ tipo: 'OTRO', planta_id: 'GEC3', periodos: celdas([1], 10) }), TypeError);
  assert.throws(() => asientoLote({ planta_id: 'GEC3', periodos: celdas([1], 10) }), TypeError);
});

// ─────────────────────────────────────────────────────────── Disponibilidad (§5.4)

test('DISP: los cuatro estados, sin detalle', () => {
  assert.equal(asientoDisponibilidad({ planta_id: 'GEC32', evento: 'En Servicio' }), 'GEC32 E/L en servicio.');
  assert.equal(asientoDisponibilidad({ planta_id: 'GEC3', evento: 'En Reserva' }), 'GEC3 disponible en reserva, sin generar.');
  assert.equal(asientoDisponibilidad({ planta_id: 'GEC3', evento: 'Indisponible' }), 'GEC3 F/L indisponible.');
  assert.equal(asientoDisponibilidad({ planta_id: 'GEC32', evento: 'Mantenimiento' }), 'GEC32 F/L en mantenimiento programado.');
});

test('DISP: los cuatro estados, con detalle', () => {
  assert.equal(
    asientoDisponibilidad({ planta_id: 'GEC32', evento: 'En Servicio', detalle: 'Sincronizada' }),
    'GEC32 E/L en servicio. Sincronizada.',
  );
  assert.equal(
    asientoDisponibilidad({ planta_id: 'GEC3', evento: 'En Reserva', detalle: 'A disposición del CND.' }),
    'GEC3 disponible en reserva, sin generar. A disposición del CND.',
  );
  assert.equal(
    asientoDisponibilidad({ planta_id: 'GEC3', evento: 'Indisponible', detalle: 'Fuga en ducto de descarga del alimentador de carbón C' }),
    'GEC3 F/L indisponible. Fuga en ducto de descarga del alimentador de carbón C.',
  );
  assert.equal(
    asientoDisponibilidad({ planta_id: 'GEC32', evento: 'Mantenimiento', detalle: 'Consignación C2048713' }),
    'GEC32 F/L en mantenimiento programado. Consignación C2048713.',
  );
});

test('DISP: un estado desconocido LANZA', () => {
  assert.throws(() => asientoDisponibilidad({ planta_id: 'GEC3', evento: 'En pruebas' }), TypeError);
});

// ─────────────────────────────────────────────────────────── Sala, literal (§5.5 + decisión I)

test('Sala: texto que no nombra la unidad se prefija con guion LARGO', () => {
  assert.equal(
    asientoLiteralSala({ planta_id: 'GEC3', texto: 'Disparo de ventilador inducido #2 por falla en unidad de lubricación.' }),
    'GEC3 — Disparo de ventilador inducido #2 por falla en unidad de lubricación.',
  );
  // Guion largo con espacios, nunca el corto (que ya separa nombres de ingenieros).
  assert.match(asientoLiteralSala({ planta_id: 'GEC32', texto: 'Se normaliza campo.' }), /^GEC32 — /);
});

test('Sala: si el texto ya nombra la unidad NO se prefija (las cuatro variantes)', () => {
  for (const texto of ['GEC3 sincronizada.', 'GEC32 sincronizada.', 'G3.0 sincronizada.', 'UG32 sincronizada.']) {
    assert.equal(asientoLiteralSala({ planta_id: 'GEC3', texto }), texto, texto);
  }
  // Y las demás formas del papel (§3(a)) también evitan el duplicado.
  for (const texto of ['G3,0 fuera de línea', 'G30 en reserva', 'UG3.2 disparada', 'g3.2 en mantenimiento']) {
    assert.equal(asientoLiteralSala({ planta_id: 'GEC32', texto }), texto, texto);
  }
});

test('Sala: el texto pasa LITERAL — no se normaliza ni se corrige la ortografía', () => {
  const crudo = 'Se recibe llamdaa CND, ramppa de carga nuecamente';
  assert.equal(asientoLiteralSala({ planta_id: 'GEC3', texto: crudo }), `GEC3 — ${crudo}`);
});

test('Sala: texto vacío devuelve vacío, no un prefijo huérfano', () => {
  assert.equal(asientoLiteralSala({ planta_id: 'GEC3', texto: '   ' }), '');
  assert.equal(asientoLiteralSala({ planta_id: 'GEC3', texto: null }), '');
});

test('la alternativa GEC3 de la regex no se come el GEC32 (el \\b lo cubre)', () => {
  assert.equal(/^\s*GEC3\b/i.test('GEC32 sincronizada.'), false);
  assert.equal(UNIDAD_YA_NOMBRADA.test('GEC32 sincronizada.'), true);
  assert.equal(UNIDAD_YA_NOMBRADA.test('GEC3 sincronizada.'), true);
  // Una palabra que solo EMPIEZA como la unidad no cuenta.
  assert.equal(UNIDAD_YA_NOMBRADA.test('GEC33 no existe'), false);
  assert.equal(UNIDAD_YA_NOMBRADA.test('Generador principal fuera'), false);
});

// ─────────────────────────────────────────────────────────── invariantes sobre todas las salidas

// Corpus de referencia: una salida por cada camino del motor.
const CORPUS = [
  asientoLote({ tipo: 'AUTH', planta_id: 'GEC3', funcionariocnd: 'Jair Pardo', periodos: celdas([17, 18, 19], 150) }),
  asientoLote({ tipo: 'AUTH', planta_id: 'GEC3', periodos: celdas([20], 115), detalle: 'Ajuste por rampa' }),
  asientoLote({ tipo: 'REDESP', planta_id: 'GEC3', periodos: [{ periodo: 17, valor_mw: 109 }, { periodo: 19, valor_mw: 164 }] }),
  asientoLote({ tipo: 'REDESP', planta_id: 'GEC32', periodos: celdas([1, 2, 3], 0), detalle: 'Aplicado en RIO' }),
  asientoLote({ tipo: 'PRUEBA', planta_id: 'GEC32', periodos: celdas([9, 10, 11], 270) }),
  asientoDisponibilidad({ planta_id: 'GEC3', evento: 'En Servicio' }),
  asientoDisponibilidad({ planta_id: 'GEC3', evento: 'En Reserva', detalle: 'Sin generar' }),
  asientoDisponibilidad({ planta_id: 'GEC32', evento: 'Indisponible' }),
  asientoDisponibilidad({ planta_id: 'GEC32', evento: 'Mantenimiento', detalle: 'Consignación C2048713' }),
  asientoLiteralSala({ planta_id: 'GEC3', texto: 'Se coordina con Transelca normalización de campo.' }),
  asientoLiteralSala({ planta_id: 'GEC32', texto: 'G3.2 sincronizada.' }),
];

test('ninguna salida dice MWh: es potencia por periodo, no energía', () => {
  for (const txt of CORPUS) assert.doesNotMatch(txt, /MWh/i, txt);
});

test('ninguna salida filtra undefined, null, NaN ni deja puntuación huérfana', () => {
  for (const txt of CORPUS) {
    assert.doesNotMatch(txt, /undefined|null|NaN/, txt);
    assert.doesNotMatch(txt, / \./, txt);       // espacio antes del punto
    assert.doesNotMatch(txt, /\.\./, txt);      // punto duplicado
    assert.doesNotMatch(txt, /:\s*$/, txt);     // rótulo sin dato
    assert.equal(txt, txt.trim(), txt);
  }
});

test('la hora NUNCA va dentro del texto: es columna de la hoja y del listado', () => {
  for (const txt of CORPUS) assert.doesNotMatch(txt, /\b\d{1,2}:\d{2}\b/, txt);
});

test('toda salida generada cierra con punto', () => {
  for (const txt of CORPUS) assert.match(txt, /[.!?…]$/, txt);
});
