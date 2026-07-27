// D-058 · E7 — Escritor OOXML y clonador del libro F03. UNITARIO PURO: sin BD, sin servidor.
// Si este archivo tarda más que milisegundos, algo tocó la BD y está mal.
//
// Lo que fija: que el paquete `.xlsx` que sale del generador sea ESTRUCTURALMENTE válido y que
// conserve intacto el andamiaje del formato controlado (logo, estilos, tabla de strings). Lo que
// NO puede cubrir: que Excel lo abra sin advertencia de corrupto — eso es el smoke manual que pide
// la etapa, y es la razón por la que existe. Un `.xlsx` inválido pasa todos los tests de conteo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leerZip, escribirZip, xmlEsc, colRef } from '../utils/xlsx.js';
import { construirLibroF03, cargarPlantillaF03 } from '../utils/f03-libro.js';

const RUTA_PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'f03-plantilla.xlsx');

const BLOQUES = ['00:00-06:00', '06:00 - 18:00', '18:00 - 00:00'];

// Día sintético: el bloque `i` recibe `i` eventos (0, 1 y 2), así cada libro ejercita a la vez el
// bloque vacío, el de una fila y el de varias.
function diaSintetico(fecha) {
  return {
    fecha,
    bloques: BLOQUES.map((turno_literal, i) => ({
      turno_literal,
      jefe: 'Omar Fedullo',
      ingenieros: 'Jose Saavedra - Luis Zapata',
      filas: Array.from({ length: i }, (_, j) => ({
        hora: `0${i}:${String(j * 7).padStart(2, '0')}`,
        asiento: `GEC3 E/L en servicio. Bloque ${i}, evento ${j}.`,
      })),
    })),
  };
}

const mesSintetico = (anio, mes, dias) =>
  Array.from({ length: dias }, (_, i) =>
    diaSintetico(`${anio}-${String(mes).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`));

const hojasDe = (z) => [...z.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
const textoDe = (z, parte) => z.get(parte).toString('utf8');

// ───────────────────────────────────────────────────────────────────── el ZIP: leer y escribir

test('escribirZip → leerZip: round-trip fiel, incluidos binarios y UTF-8', () => {
  const entradas = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'xl/media/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1a]) },
    { name: 'docProps/áéí.xml', data: Buffer.from('Operación 24h — GEC32', 'utf8') },
  ];
  const z = leerZip(escribirZip(entradas));
  assert.equal(z.size, 3);
  // El orden de inserción se preserva: `[Content_Types].xml` tiene que quedar primero en el paquete.
  assert.deepEqual([...z.keys()], entradas.map((e) => e.name));
  for (const e of entradas) assert.ok(z.get(e.name).equals(e.data), `difiere ${e.name}`);
});

test('leerZip: descomprime DEFLATE — es lo que permite derivar la plantilla desde un .xlsx de Excel', () => {
  // El F03 real viene todo en deflate salvo el PNG. Si el lector no inflara, el script offline no
  // podría existir y habría que agregar una dependencia (lo que REQ-01 §5.1 prohíbe).
  const z = cargarPlantillaF03();
  assert.ok(z.get('xl/styles.xml').toString('utf8').startsWith('<?xml'));
});

test('leerZip: rechaza un buffer que no es ZIP en vez de devolver basura', () => {
  assert.throws(() => leerZip(Buffer.from('esto no es un zip')), /End Of Central Directory/);
});

test('xmlEsc escapa lo que rompe una hoja; colRef traduce columnas', () => {
  assert.equal(xmlEsc('F/L > 30 min & "GEC3" <en línea>'), 'F/L &gt; 30 min &amp; &quot;GEC3&quot; &lt;en línea&gt;');
  assert.equal(colRef(0), 'A');
  assert.equal(colRef(8), 'I');
  assert.equal(colRef(26), 'AA');
});

// ─────────────────────────────────────────────────────────────────────── la plantilla derivada

test('la plantilla commiteada es mono-hoja y trae el andamiaje completo del formato', () => {
  const z = cargarPlantillaF03();
  assert.equal(hojasDe(z).length, 1);
  for (const parte of [
    'xl/styles.xml', 'xl/theme/theme1.xml', 'xl/sharedStrings.xml', 'xl/media/image1.png',
    'xl/drawings/drawing1.xml', 'xl/printerSettings/printerSettings1.bin', '_rels/.rels', 'docProps/core.xml',
  ]) {
    assert.ok(z.has(parte), `falta ${parte} en la plantilla`);
  }
  const hoja = textoDe(z, 'xl/worksheets/sheet1.xml');
  // El encabezado GENE-F03 sobrevive con sus `t="s"` contra el sharedStrings preservado, y la fila
  // 4 conserva la fecha de EMISIÓN del formato, que no es la del día y no se toca nunca.
  assert.match(hoja, /<drawing r:id=/);
  assert.match(hoja, /<pageSetup[^>]*r:id=/);
  assert.equal((hoja.match(/t="s"/g) ?? []).length, 6);
  // Ni una fila de datos: los eventos de enero se borraron al derivar.
  const filas = [...hoja.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(filas, [1, 2, 3, 4, 5, 7, 8]);
});

// ────────────────────────────────────────────────────────────────────────────── el libro mensual

for (const [etiqueta, anio, mes, dias] of [['febrero', 2026, 2, 28], ['abril', 2026, 4, 30], ['enero', 2026, 1, 31]]) {
  test(`libro de ${dias} hojas (${etiqueta}): una por día, en orden, con su área de impresión`, () => {
    const z = leerZip(construirLibroF03(mesSintetico(anio, mes, dias)));

    assert.equal(hojasDe(z).length, dias);
    const wb = textoDe(z, 'xl/workbook.xml');
    const nombres = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(nombres.length, dias);
    assert.deepEqual(nombres, mesSintetico(anio, mes, dias).map((d) => d.fecha));
    for (const n of nombres) assert.match(n, /^\d{4}-\d{2}-\d{2}$/);

    // Un `definedName` por hoja, con `localSheetId` 0-based correlativo. Clonar el bloque sin
    // recalcular haría que Excel imprima rangos vacíos o corte los días largos.
    const areas = [...wb.matchAll(/<definedName name="_xlnm\.Print_Area" localSheetId="(\d+)">'([^']+)'!\$A\$6:\$I\$(\d+)<\/definedName>/g)];
    assert.equal(areas.length, dias);
    areas.forEach((a, i) => {
      assert.equal(Number(a[1]), i, 'localSheetId debe ser el índice 0-based de la hoja');
      assert.equal(a[2], nombres[i], 'el área de impresión apunta a otra hoja');
      const alto = Number(a[3]);
      const dimension = /<dimension ref="A1:I(\d+)"\/>/.exec(textoDe(z, `xl/worksheets/sheet${i + 1}.xml`));
      assert.equal(alto, Number(dimension[1]), 'el rango de impresión no coincide con el alto real');
      assert.ok(alto > 8, 'el área de impresión no puede quedarse en el encabezado');
    });

    // Un `Override` por cada parte emitida: si falta uno, Excel repara el archivo al abrirlo.
    const ct = textoDe(z, '[Content_Types].xml');
    for (let n = 1; n <= dias; n++) {
      assert.ok(ct.includes(`PartName="/xl/worksheets/sheet${n}.xml"`), `sin Override sheet${n}`);
      assert.ok(ct.includes(`PartName="/xl/drawings/drawing${n}.xml"`), `sin Override drawing${n}`);
      assert.ok(z.has(`xl/worksheets/_rels/sheet${n}.xml.rels`), `sin _rels sheet${n}`);
      assert.ok(z.has(`xl/printerSettings/printerSettings${n}.bin`), `sin printerSettings${n}`);
    }
    // Y ningún Override huérfano apuntando a una parte que no viaja en el paquete.
    for (const m of ct.matchAll(/<Override PartName="\/([^"]+)"/g)) {
      assert.ok(z.has(m[1]), `Override huérfano: ${m[1]}`);
    }
  });
}

test('el andamiaje del formato viaja intacto: logo byte-idéntico y sharedStrings sin tocar', () => {
  const plantilla = leerZip(readFileSync(RUTA_PLANTILLA));
  const z = leerZip(construirLibroF03(mesSintetico(2026, 1, 31)));
  for (const parte of ['xl/media/image1.png', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/theme/theme1.xml']) {
    assert.ok(z.get(parte).equals(plantilla.get(parte)), `${parte} se modificó y debía copiarse tal cual`);
  }
  // El logo se referencia por `rId` desde el drawing de cada hoja; una sola copia de la imagen.
  assert.equal([...z.keys()].filter((n) => n.startsWith('xl/media/')).length, 1);
});

test('las filas de datos van como inlineStr: ni una t="s" nueva contra el sharedStrings', () => {
  const z = leerZip(construirLibroF03(mesSintetico(2026, 1, 31)));
  const plantilla = textoDe(leerZip(readFileSync(RUTA_PLANTILLA)), 'xl/worksheets/sheet1.xml');
  const enPlantilla = (plantilla.match(/t="s"/g) ?? []).length;
  const hoja = textoDe(z, 'xl/worksheets/sheet3.xml');
  // Agregar entradas a la tabla de strings obligaría a reindexarla, y esa tabla es justo la que
  // sostiene los `t="s"` del encabezado GENE-F03 clonado: un índice corrido corrompe el título.
  assert.equal((hoja.match(/t="s"/g) ?? []).length, enPlantilla);
  assert.ok((hoja.match(/t="inlineStr"/g) ?? []).length > 0);
  assert.match(hoja, /<is><t xml:space="preserve">DESCRIPCIÓN EVENTO Y\/O ACTIVIDAD<\/t><\/is>/);
});

test('el XML de cada hoja está bien formado: filas cerradas y en orden ascendente', () => {
  // Guard del bug que apareció al derivar la plantilla: una regex no-greedy `[\s\S]*?(?:<\/row>|\/>)`
  // corta en el primer `/>`, que es una CELDA auto-cerrada y no el fin de la fila. El resultado
  // pasa cualquier conteo y Excel lo reporta como archivo corrupto.
  const z = leerZip(construirLibroF03(mesSintetico(2026, 1, 31)));
  for (const parte of hojasDe(z)) {
    const hoja = textoDe(z, parte);
    const aperturas = (hoja.match(/<row\s/g) ?? []).length;
    const cierres = (hoja.match(/<\/row>/g) ?? []).length;
    assert.equal(aperturas, cierres, `${parte}: filas abiertas sin cerrar`);
    // Toda `<c …>` tiene que cerrar: o es auto-cerrada, o termina en `</c>`. Si alguna quedara
    // abierta, la cuenta de celdas completas sería menor que la de aperturas.
    const celdasCompletas = (hoja.match(/<c\s[^>]*\/>|<c\s[^>]*>[\s\S]*?<\/c>/g) ?? []).length;
    assert.equal(celdasCompletas, (hoja.match(/<c\s/g) ?? []).length, `${parte}: celdas sin cerrar`);

    const numeros = [...hoja.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(numeros, [...numeros].sort((a, b) => a - b), `${parte}: filas fuera de orden`);
    assert.equal(new Set(numeros).size, numeros.length, `${parte}: filas repetidas`);
  }
});

test('el texto del operador se escapa: & < > y comillas no rompen la hoja', () => {
  const asiento = 'F/L > 30 min & "GEC3" <en línea> — se coordina con el CND.';
  const z = leerZip(construirLibroF03([{
    fecha: '2026-07-15',
    bloques: [{ turno_literal: '00:00-06:00', jefe: 'A & B', ingenieros: '<sin dato>', filas: [{ hora: '03:15', asiento }] }],
  }]));
  const hoja = textoDe(z, 'xl/worksheets/sheet1.xml');
  assert.ok(hoja.includes(xmlEsc(asiento)), 'el asiento no viaja escapado');
  assert.ok(!hoja.includes('& "GEC3"'), 'quedó un & sin escapar');
  assert.ok(hoja.includes('A &amp; B') && hoja.includes('&lt;sin dato&gt;'));
});

test('la hora va como NÚMERO con formato h:mm, no como texto', () => {
  const z = leerZip(construirLibroF03([{
    fecha: '2026-07-15',
    bloques: [{
      turno_literal: '06:00 - 18:00', jefe: '', ingenieros: '',
      filas: [{ hora: '06:00', asiento: 'uno' }, { hora: '16:38', asiento: 'dos' }, { hora: null, asiento: 'sin hora' }],
    }],
  }]));
  const hoja = textoDe(z, 'xl/worksheets/sheet1.xml');
  // Fracción del día: 06:00 = 0.25 (lo mismo que guarda el F03 real). Es lo que permite ordenar y
  // filtrar en Excel, y lo que evita que `00:00` se lea como un cero suelto.
  assert.match(hoja, /<c r="A13" s="\d+"><v>0\.25<\/v><\/c>/);
  assert.match(hoja, /<c r="A14" s="\d+"><v>0\.6930555555555555\d*<\/v><\/c>/);
  // Sin hora utilizable la celda queda VACÍA, no en `00:00`: no se inventa un dato que nadie registró.
  assert.match(hoja, /<c r="A15" s="\d+"\/>/);
});

test('la fecha de la hoja va como serial de Excel, anclado al F03 real', () => {
  // 46023 es el valor exacto que trae la celda B6 de la hoja `2026-01-01` del formato controlado.
  // Si el desfase de época se rompe, la hoja muestra otro día y nadie lo nota hasta imprimir.
  const z = leerZip(construirLibroF03([diaSintetico('2026-01-01'), diaSintetico('2026-01-02')]));
  assert.match(textoDe(z, 'xl/worksheets/sheet1.xml'), /<c r="B6" s="48"><v>46023<\/v><\/c>/);
  assert.match(textoDe(z, 'xl/worksheets/sheet2.xml'), /<c r="B6" s="48"><v>46024<\/v><\/c>/);
});

test('un bloque sin eventos deja su encabezado y ninguna fila', () => {
  const z = leerZip(construirLibroF03([{
    fecha: '2026-07-15',
    bloques: BLOQUES.map((turno_literal) => ({ turno_literal, jefe: '', ingenieros: '', filas: [] })),
  }]));
  const hoja = textoDe(z, 'xl/worksheets/sheet1.xml');
  // 8 del encabezado + 3 bloques × 4 filas de rótulos = 20 filas, sin una sola de datos.
  assert.equal([...hoja.matchAll(/<row r="(\d+)"/g)].length, 7 + 1 + 12);
  // Contra el contenido EXACTO de la celda: `TURNO:` a secas es substring de `JEFE DE TURNO:`.
  const celdasCon = (texto) => (hoja.match(new RegExp(`<is><t xml:space="preserve">${texto}</t></is>`, 'g')) ?? []).length;
  assert.equal(celdasCon('TURNO:'), 3);
  assert.equal(celdasCon('JEFE DE TURNO:'), 3);
  assert.equal(celdasCon('HH:MM'), 3);
  assert.match(hoja, /<dimension ref="A1:I20"\/>/);
  // Y sin datos, el turno sin personal deja la celda en blanco: no se inventa un nombre.
  assert.ok(!hoja.includes('undefined') && !hoja.includes('null'));
});

test('cada hoja crece con sus eventos y solo la primera queda seleccionada', () => {
  const corto = { fecha: '2026-07-01', bloques: [{ turno_literal: '00:00-06:00', jefe: '', ingenieros: '', filas: [] }] };
  const largo = {
    fecha: '2026-07-02',
    bloques: [{
      turno_literal: '00:00-06:00', jefe: '', ingenieros: '',
      filas: Array.from({ length: 12 }, (_, i) => ({ hora: `0${i % 6}:00`, asiento: `evento ${i}` })),
    }],
  };
  const z = leerZip(construirLibroF03([corto, largo]));
  assert.match(textoDe(z, 'xl/worksheets/sheet1.xml'), /<dimension ref="A1:I12"\/>/);
  assert.match(textoDe(z, 'xl/worksheets/sheet2.xml'), /<dimension ref="A1:I24"\/>/);
  // Si `tabSelected` fuera a todas, Excel abre el libro con las hojas AGRUPADAS y cualquier
  // edición se replica en todas.
  assert.ok(textoDe(z, 'xl/worksheets/sheet1.xml').includes('tabSelected="1"'));
  assert.ok(!textoDe(z, 'xl/worksheets/sheet2.xml').includes('tabSelected="1"'));
});

test('los merges se recalculan por hoja: rótulos A:C + D:I, y descripción B:I', () => {
  const z = leerZip(construirLibroF03([diaSintetico('2026-07-15')]));
  const hoja = textoDe(z, 'xl/worksheets/sheet1.xml');
  const declarado = Number(/<mergeCells count="(\d+)">/.exec(hoja)[1]);
  assert.equal(declarado, (hoja.match(/<mergeCell /g) ?? []).length, 'el count no coincide con los merges');
  // 8 del encabezado + por bloque (3 rótulos × 2 merges + 1 títulos) + 1 por fila de datos.
  assert.equal(declarado, 8 + 3 * 7 + 3);
  assert.ok(hoja.includes('<mergeCell ref="B6:D6"/>'), 'se perdió el merge del encabezado');
});

test('construirLibroF03 rechaza un mes sin días y una fecha con formato inválido', () => {
  assert.throws(() => construirLibroF03([]), /al menos un día/);
  assert.throws(() => construirLibroF03([{ fecha: '15/07/2026', bloques: [] }]), /fecha inválida/);
});
