// D-064 · L02 — Motor del asiento de sistema. UNITARIO PURO: sin BD, sin servidor, sin reloj.
// Si este archivo tarda más que milisegundos, algo tocó la BD y está mal.
//
// Fija el contrato C2 y el criterio CA-2: el texto es el del F03 real, calcado
// (`docs/requerimientos/formatos/2026-07-F03-asiento-despacho-dia-siguiente.png`), y una fecha
// inválida LANZA en vez de producir un renglón con la fecha equivocada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORIGEN_DESPACHO_XM,
  BITACORAS_ASIENTO_SISTEMA,
  TIPO_EVENTO_DESPACHO_XM,
  asientoDespachoXM,
  claveAsientoDespacho,
  camposExtraDespacho,
  esAsientoDeSistema,
  claveDeAgrupacion,
  esHoraEstimada,
} from '../utils/asientos/sistema.js';
// Solo lectura: el asiento tiene que quedar FUERA del prefijo de unidad de Sala, y esa es la
// razón por la que este módulo vive aparte del motor de D-058.
import { UNIDAD_YA_NOMBRADA } from '../utils/asientos/formato.js';

// ────────────────────────────────────────────────────────────────────── CA-2: el texto literal

test('texto literal del F03', () => {
  // Calcado del recorte del 2026-07: guiones, sin punto final, sin prefijo de unidad, y `G3.0`/
  // `G3.2` tal como está escrito a mano en el papel (excepción deliberada a GEC3/GEC32).
  assert.equal(
    asientoDespachoXM('2026-07-14'),
    'Se recibe del XM despacho económico de G3.0 y G3.2 para el 14-07-2026',
  );

  const texto = asientoDespachoXM('2026-07-14');
  assert.ok(!texto.endsWith('.'), 'el papel no lleva punto final');
  assert.ok(!/GEC3/.test(texto), 'no se normaliza la unidad: la frase es fija');
  assert.ok(/G3\.0 y G3\.2/.test(texto), 'un solo asiento nombra las dos unidades (RQ-05.5)');

  // La razón de existir del marcador: si el asiento pasara por `asientoLiteralSala`, el regex no
  // lo reconocería como "ya nombra la unidad" y el libro imprimiría `GEC3 — Se recibe del XM…`.
  assert.equal(UNIDAD_YA_NOMBRADA.test(texto), false);
});

test('un día de un dígito sale con cero a la izquierda', () => {
  assert.equal(
    asientoDespachoXM('2026-07-03'),
    'Se recibe del XM despacho económico de G3.0 y G3.2 para el 03-07-2026',
  );
  assert.equal(
    asientoDespachoXM('2026-01-01'),
    'Se recibe del XM despacho económico de G3.0 y G3.2 para el 01-01-2026',
  );
  // 29 de febrero de un bisiesto: existe, no se rechaza.
  assert.equal(
    asientoDespachoXM('2028-02-29'),
    'Se recibe del XM despacho económico de G3.0 y G3.2 para el 29-02-2028',
  );
});

test('rechaza fechas inválidas en vez de inventar', () => {
  // Días que NO existen. La trampa: `new Date('2026-02-30')` no lanza, rueda al 2 de marzo — así
  // que validar con `Date` produciría el asiento con la fecha equivocada y ninguna excepción.
  assert.equal(new Date('2026-02-30').getUTCDate(), 2, 'JS rueda la fecha en silencio');
  for (const mala of ['2026-02-30', '2026-06-31', '2027-02-29', '2026-13-01', '2026-00-10', '2026-07-00']) {
    assert.throws(() => asientoDespachoXM(mala), TypeError, `debería lanzar con ${mala}`);
    assert.throws(() => claveAsientoDespacho(mala), TypeError, `debería lanzar con ${mala}`);
    assert.throws(() => camposExtraDespacho({ fecha_despacho: mala }), TypeError, `debería lanzar con ${mala}`);
  }

  // Formas que no son 'YYYY-MM-DD'.
  for (const mala of ['14/07/2026', '2026-7-14', '14-07-2026', '2026-07-14T00:00:00Z', '', '   ', null, undefined, 20260714, new Date('2026-07-14'), {}]) {
    assert.throws(() => asientoDespachoXM(mala), TypeError, `debería lanzar con ${JSON.stringify(mala)}`);
    assert.throws(() => claveAsientoDespacho(mala), TypeError, `debería lanzar con ${JSON.stringify(mala)}`);
  }

  // Y sin argumento tampoco pasa un objeto a medias.
  assert.throws(() => camposExtraDespacho(), TypeError);
  assert.throws(() => camposExtraDespacho({}), TypeError);
});

// ───────────────────────────────────────────────────────── clave de agrupación y campos_extra

test('clave y campos_extra', () => {
  assert.equal(claveAsientoDespacho('2026-07-14'), 'DESPACHO_XM|2026-07-14');
  // Determinística: la idempotencia de RQ-05.13 depende de que buscar y escribir usen la misma.
  assert.equal(claveAsientoDespacho('2026-07-14'), claveAsientoDespacho('2026-07-14'));
  assert.notEqual(claveAsientoDespacho('2026-07-14'), claveAsientoDespacho('2026-07-15'));
  assert.ok(claveAsientoDespacho('2026-07-14').startsWith(`${ORIGEN_DESPACHO_XM}|`));

  const ce = camposExtraDespacho({ fecha_despacho: '2026-07-14' });
  assert.deepEqual(ce, {
    origen_sistema: 'DESPACHO_XM',
    clave_asiento: 'DESPACHO_XM|2026-07-14',
    fecha_despacho: '2026-07-14',
    hora_estimada: false,
  });
  assert.deepEqual(Object.keys(ce).sort(), ['clave_asiento', 'fecha_despacho', 'hora_estimada', 'origen_sistema']);

  // La clave que arma `camposExtraDespacho` y la que se busca antes de escribir son la MISMA.
  assert.equal(ce.clave_asiento, claveAsientoDespacho('2026-07-14'));

  // Los tres productores normalizan IGUAL. Si uno tratara la entrada distinto que otro, se
  // buscaría una clave y se escribiría otra: la idempotencia de RQ-05.13 se rompería en silencio
  // y el asiento saldría duplicado en el libro.
  const pad = '  2026-07-14  ';
  assert.equal(asientoDespachoXM(pad), asientoDespachoXM('2026-07-14'));
  assert.equal(claveAsientoDespacho(pad), claveAsientoDespacho('2026-07-14'));
  assert.deepEqual(camposExtraDespacho({ fecha_despacho: pad }), ce);

  // `hora_estimada` SIEMPRE presente y SIEMPRE booleana (lección de D-056 (b): ausente ≠ false).
  assert.equal('hora_estimada' in ce, true);
  assert.equal(typeof ce.hora_estimada, 'boolean');
  const estimada = camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: true });
  assert.equal(estimada.hora_estimada, true);
  // Al ESCRIBIR se marca de más antes que de menos: un `1` de una columna BIT cuenta como estimada.
  assert.equal(camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: 1 }).hora_estimada, true);
  assert.equal(typeof camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: null }).hora_estimada, 'boolean');
  assert.equal(camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: null }).hora_estimada, false);

  // Sobrevive el round-trip por la columna: es como va a viajar a la BD y como vuelve.
  assert.deepEqual(JSON.parse(JSON.stringify(ce)), ce);
});

test('no usa la clave del reflejo', () => {
  // `origen_bitacora` marca las COPIAS reflejadas de MAND/DISP (D-063) y `eventosSala` excluye del
  // libro toda fila que la lleve. Este asiento es un registro ORIGINAL de Sala (RQ-05.9): llevarla
  // lo borraría del único lugar donde tiene que salir.
  const ce = camposExtraDespacho({ fecha_despacho: '2026-07-14' });
  assert.equal('origen_bitacora' in ce, false);
  assert.equal(JSON.stringify(ce).includes('origen_bitacora'), false);
  // Ni tampoco los punteros del reflejo.
  assert.equal('origen_lote_id' in ce, false);
  assert.equal('origen_disponibilidad_id' in ce, false);
});

// ──────────────────────────────────────────────────────────────────────────────── predicados

test('predicados no se caen con basura', () => {
  const ce = camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: true });
  const crudo = JSON.stringify(ce);

  // Objeto ya parseado y string crudo de la columna dan lo mismo.
  for (const entrada of [ce, crudo]) {
    assert.equal(esAsientoDeSistema(entrada), true);
    assert.equal(claveDeAgrupacion(entrada), 'DESPACHO_XM|2026-07-14');
    assert.equal(esHoraEstimada(entrada), true);
  }

  // Basura: JSON inválido, tipos raros, vacíos. Ni una excepción.
  const basura = ['', '   ', '{', '{"a":', 'no soy json', '[1,2,3]', '"hola"', '5', 'null', null, undefined, 42, true, [], () => {}];
  for (const b of basura) {
    assert.equal(esAsientoDeSistema(b), false, `esAsientoDeSistema(${JSON.stringify(b)})`);
    assert.equal(claveDeAgrupacion(b), null, `claveDeAgrupacion(${JSON.stringify(b)})`);
    assert.equal(esHoraEstimada(b), false, `esHoraEstimada(${JSON.stringify(b)})`);
  }

  // Una fila normal de Sala (sin marcador) no es del sistema y no agrupa.
  const libre = { origen_bitacora: 'MAND', origen_lote_id: 'abc' };
  assert.equal(esAsientoDeSistema(libre), false);
  assert.equal(claveDeAgrupacion(libre), null);
  assert.equal(esAsientoDeSistema({}), false);
  assert.equal(esAsientoDeSistema('{}'), false);

  // Marcador vacío o de otro tipo no cuenta.
  assert.equal(esAsientoDeSistema({ origen_sistema: '' }), false);
  assert.equal(esAsientoDeSistema({ origen_sistema: '   ' }), false);
  assert.equal(esAsientoDeSistema({ origen_sistema: 7 }), false);
  assert.equal(esAsientoDeSistema({ origen_sistema: null }), false);

  // Es del sistema pero le falta la clave: `null` para que el consumidor caiga a `registro_id`
  // (C5). Agrupar mal dos filas ajenas sería peor que duplicar una.
  assert.equal(esAsientoDeSistema({ origen_sistema: 'DESPACHO_XM' }), true);
  assert.equal(claveDeAgrupacion({ origen_sistema: 'DESPACHO_XM' }), null);
  assert.equal(claveDeAgrupacion({ origen_sistema: 'DESPACHO_XM', clave_asiento: '' }), null);
  assert.equal(claveDeAgrupacion({ origen_sistema: 'DESPACHO_XM', clave_asiento: 42 }), null);

  // El predicado es genérico: un segundo origen de sistema no obliga a editarlo.
  assert.equal(esAsientoDeSistema({ origen_sistema: 'OTRO_ORIGEN', clave_asiento: 'OTRO|x' }), true);
  assert.equal(claveDeAgrupacion({ origen_sistema: 'OTRO_ORIGEN', clave_asiento: 'OTRO|x' }), 'OTRO|x');
});

test('hora estimada: la ausencia es false y el texto de JSON_VALUE se entiende', () => {
  // Una fila vieja sin la clave se lee como NO estimada (robustez de lectura).
  assert.equal(esHoraEstimada({ origen_sistema: 'DESPACHO_XM' }), false);
  assert.equal(esHoraEstimada({ origen_sistema: 'DESPACHO_XM', hora_estimada: undefined }), false);
  assert.equal(esHoraEstimada({ hora_estimada: false }), false);
  assert.equal(esHoraEstimada({ hora_estimada: true }), true);

  // `JSON_VALUE` devuelve nvarchar: sin esto, `Boolean('false')` diría que sí.
  assert.equal(esHoraEstimada({ hora_estimada: 'true' }), true);
  assert.equal(esHoraEstimada({ hora_estimada: '1' }), true);
  assert.equal(esHoraEstimada({ hora_estimada: 1 }), true);
  assert.equal(esHoraEstimada({ hora_estimada: 'false' }), false);
  assert.equal(esHoraEstimada({ hora_estimada: '0' }), false);
  assert.equal(esHoraEstimada({ hora_estimada: 0 }), false);
  assert.equal(esHoraEstimada({ hora_estimada: 'sí' }), false);
});

// ───────────────────────────────────────────────────────────────────── constantes del contrato

test('las constantes del contrato C2 son las que importan L03, L04 y L05', () => {
  assert.equal(ORIGEN_DESPACHO_XM, 'DESPACHO_XM');
  assert.deepEqual(BITACORAS_ASIENTO_SISTEMA, ['SALAJDT', 'SALAING']);
  assert.equal(TIPO_EVENTO_DESPACHO_XM, 'Despacho económico');
  // El marcador no puede colisionar con el del reflejo (D-063), que es un valor de `codigo`.
  assert.equal(BITACORAS_ASIENTO_SISTEMA.includes(ORIGEN_DESPACHO_XM), false);
  // Congelado: es un array exportado y un `.push()` de un consumidor lo contaminaría para todo el
  // proceso. `Object.freeze` es superficial, pero acá el contenido son strings.
  assert.equal(Object.isFrozen(BITACORAS_ASIENTO_SISTEMA), true, 'la constante tiene que ser inmutable');
});

// GATE-O1 (R7): el par de bitácoras está escrito DOS veces —acá y en `reflejo-sala.js`—, a
// propósito: este módulo es puro y no importa de nadie. Pero una duplicación sin guard es drift
// silencioso (la lección del espejo de nombres de D-052, que sí tiene su test). El día que entre una
// tercera bitácora de Sala, o que SALAOP pase a recibir copias, este test falla y obliga a mirar las
// dos listas en vez de dejar una vieja viva.
test('el par de bitácoras es el mismo que el del reflejo (D-063): las dos listas no pueden divergir', async () => {
  const { BITACORAS_REFLEJO } = await import('../utils/reflejo-sala.js');
  assert.deepEqual(
    [...BITACORAS_ASIENTO_SISTEMA].sort(),
    [...BITACORAS_REFLEJO].sort(),
    'BITACORAS_ASIENTO_SISTEMA y BITACORAS_REFLEJO se separaron: decide si es a propósito y actualiza las dos',
  );
});

// GATE-O1 (R5): el escritor y el lector comparten normalizador. Sin esto, `Boolean('false')` daba
// `true` al escribir y `esHoraEstimada` decía `false` al leer: la misma fila marcada de dos maneras.
test('escribir y leer el flag no pueden divergir: un `false` en texto es false en las dos puntas', () => {
  for (const negativo of ['false', 'FALSE', ' false ', '0', '']) {
    const extra = camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: negativo });
    assert.equal(extra.hora_estimada, false, `un ${JSON.stringify(negativo)} no marca la hora como estimada`);
    assert.equal(esHoraEstimada(extra), false);
  }
  for (const positivo of [true, 1, 'true', 'TRUE', '1']) {
    const extra = camposExtraDespacho({ fecha_despacho: '2026-07-14', hora_estimada: positivo });
    assert.equal(extra.hora_estimada, true, `un ${JSON.stringify(positivo)} sí la marca`);
    assert.equal(esHoraEstimada(extra), true);
  }
});

// GATE-O1 (R6): un solo productor del string de contrato. Si `camposExtraDespacho` volviera a
// armarlo inline, el día que la clave cambie de forma se buscaría con una y se escribiría otra.
test('la clave del campos_extra la produce claveAsientoDespacho, no un literal repetido', () => {
  const fuente = io_leer();
  assert.match(
    fuente,
    /clave_asiento:\s*claveAsientoDespacho\(/,
    'camposExtraDespacho tiene que llamar a claveAsientoDespacho, no repetir el template de la clave',
  );
  for (const fecha of ['2026-01-05', '2026-07-14', '2026-12-31']) {
    assert.equal(camposExtraDespacho({ fecha_despacho: fecha }).clave_asiento, claveAsientoDespacho(fecha));
  }
});

// Lee el fuente del módulo para los guards estáticos de arriba. Va acá abajo y no arriba para no
// meterle ruido de I/O al cuerpo de los tests puros: se llama una sola vez.
function io_leer() {
  return readFileSync(new URL('../utils/asientos/sistema.js', import.meta.url), 'utf8');
}
