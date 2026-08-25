#!/usr/bin/env node
// D-058 — Deriva `server/assets/f03-plantilla.xlsx` a partir del formato controlado REAL.
//
//   node scripts/derivar-plantilla-f03.mjs [ruta-al-f03.xlsx]
//
// OFFLINE: se corre A MANO cuando el formato controlado cambia. NO lo invoca `initDB()`, ni el
// arranque, ni CI, ni ningún endpoint — su salida es un artefacto commiteado.
//
// Por qué existe en vez de dibujar la hoja desde cero: el libro mensual tiene que verse como el
// GENE-F03 —con su logo, sus estilos, sus bordes y su área de impresión—, no como un export. Y
// REQ-01 §5.1 prohíbe agregar dependencias, así que `exceljs`/`xlsx` quedan fuera. Clonar una
// plantilla real es la única forma de tener las dos cosas.
//
// Inflar el F03 real ocurre UNA vez, acá, offline: la plantilla queda derivada y commiteada, y en
// runtime el generador solo clona sus partes. Todo con `node:zlib` (nativo), así que producción
// sigue sin dependencias. La plantilla puede quedar `stored` o `deflate` indistintamente —`leerZip`
// soporta los dos—; desde 2026-07-27 `escribirZip` emite DEFLATE, que es como se ve un `.xlsx` real.
//
// Qué conserva la plantilla:
//   - el encabezado GENE-F03 (filas 1..5 y 7..8) VERBATIM, incluidos sus `t="s"` contra el
//     `sharedStrings.xml`, que se copia sin tocar;
//   - el logo (`xl/media/image1.png` + su `drawing`), los estilos, el tema, los anchos de columna,
//     la protección de hoja, los márgenes, la configuración de página y el área de impresión.
// Qué borra: TODAS las filas de datos (los eventos de enero) y la fila 6, que es variable — la
// fecha del día la escribe el generador en cada hoja.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// MAPA DE ÍNDICES DE ESTILO (`s="…"`) — medido sobre la hoja `2026-01-01` del F03 real.
// E8/E9 lo consumen; NO hay que re-descubrirlo a ojo. Vive acá, junto al script que lo extrajo.
//
//   Fila del layout        │  A        B        C..H     I     │ Notas
//   ───────────────────────┼───────────────────────────────────┼──────────────────────────────
//   6 · FECHA:             │  2        48       48       4     │ B6 = SERIAL de fecha, no texto.
//                          │           (C6,D6 = 48; E6..H6 = 3)│ `s=48` → numFmt 164, fecha larga
//                          │                                   │ (`dddd, mmmm dd, yyyy`), NO
//                          │                                   │ `dd/mm/aaaa`. Es lo que hace el
//                          │                                   │ formato real.
//   TURNO:                 │  49       50/51    53       54    │ D = 52 (valor, centrado)
//   JEFE DE TURNO:         │  55       56/57    59       60    │ D = 58 (valor, Arial Narrow 10 b)
//   INGENIERO DE TURNO:    │  21       22/23    25       26    │ D = 24 (valor)
//   HH:MM / DESCRIPCIÓN    │  11       64       65       66    │ rótulos, centrados
//   dato (intermedia)      │  12       73       74       75    │ A = hora (numFmt 20 = `h:mm`)
//   dato (última del bloq.)│  16       76       77       78    │ terna con borde inferior grueso
//
// Fuentes: `fontId=2` Arial Narrow 11 bold (rótulos) · `fontId=4` Arial Narrow 10 bold (valores
// del encabezado de bloque) · `fontId=5` Arial Narrow 8 (filas de datos).
// Las celdas de descripción (73/74/75 y 76/77/78) llevan `wrapText="1"`, y **las celdas combinadas
// no autoajustan su alto en Excel**: por eso `f03-libro.js` estima el `ht` por longitud del texto.
// El original hace lo mismo a mano (16.5 para un renglón, 25.5 para dos).
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leerZip, escribirZip } from '../server/utils/xlsx.js';

const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F03_POR_DEFECTO = '2026_01_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx';
const SALIDA = 'server/assets/f03-plantilla.xlsx';

// La hoja duplicada `2026-01-24 (2)` es además el PRIMER sheet del libro: tomarla por descuido
// deja la plantilla derivada de una copia de trabajo. El modelo es la primera hoja cuyo nombre es
// una fecha limpia.
const NOMBRE_DE_DIA = /^\d{4}-\d{2}-\d{2}$/;

// Filas del encabezado que sobreviven tal cual. La 6 (FECHA) NO está: es variable y la genera
// `f03-libro.js` por hoja. La 5, la 7 y la 8 son separadores con bordes — parte del andamiaje.
const FILAS_ENCABEZADO = new Set([1, 2, 3, 4, 5, 7, 8]);
const ULTIMA_FILA_ENCABEZADO = 8;

// El formato solo ocupa A..I; el original arrastra celdas sueltas en J..M (relleno de un editor
// anterior) que ensucian la `dimension` y no pintan nada. Se recortan al derivar.
const ULTIMA_COLUMNA = 'I';
const COLUMNAS_UTILES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', ULTIMA_COLUMNA]);

// Una `<row>` es `<row …/>` (vacía) o `<row …>…</row>`. La alternativa importa y el orden también:
// una regex no-greedy del tipo `<row …[\s\S]*?(?:<\/row>|\/>)` corta en el primer `/>` que
// encuentra —que es una CELDA auto-cerrada, no el fin de la fila— y deja el XML partido. Excel
// abre eso como "archivo corrupto", y ningún test de conteo lo nota.
const FILA = /<row\s[^>]*\/>|<row\s[^>]*>[\s\S]*?<\/row>/g;
const CELDA = /<c\s[^>]*\/>|<c\s[^>]*>[\s\S]*?<\/c>/g;

function main() {
  const origen = resolve(RAIZ_REPO, process.argv[2] ?? F03_POR_DEFECTO);
  const destino = rutaDeSalidaSegura(SALIDA);

  console.log(`Leyendo   ${relative(RAIZ_REPO, origen)}`);
  const z = leerZip(readFileSync(origen));
  console.log(`  ${z.size} entradas en el paquete`);

  const modelo = resolverHojaModelo(z);
  console.log(`  hoja modelo: "${modelo.nombre}" → ${modelo.parte}`);

  const hojaLimpia = limpiarHoja(z.get(modelo.parte).toString('utf8'));

  // El drawing y los printerSettings de la hoja modelo, renombrados al índice 1: la plantilla es
  // mono-hoja y el generador los replica por día.
  const numeroModelo = /sheet(\d+)\.xml$/.exec(modelo.parte)[1];
  const drawing = z.get(`xl/drawings/drawing${numeroModelo}.xml`);
  const printerSettings = z.get(`xl/printerSettings/printerSettings${numeroModelo}.bin`);
  if (!drawing) throw new Error(`La hoja modelo no tiene drawing: sin él la plantilla pierde el logo`);
  if (!printerSettings) throw new Error(`La hoja modelo no tiene printerSettings`);

  const entradas = [
    ['[Content_Types].xml', Buffer.from(contentTypesPlantilla(), 'utf8')],
    ['_rels/.rels', z.get('_rels/.rels')],
    ['xl/workbook.xml', Buffer.from(workbookPlantilla(modelo.nombre), 'utf8')],
    ['xl/_rels/workbook.xml.rels', Buffer.from(workbookRelsPlantilla(), 'utf8')],
    ['xl/worksheets/sheet1.xml', Buffer.from(hojaLimpia, 'utf8')],
    ['xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(sheetRelsPlantilla(1), 'utf8')],
    ['xl/drawings/drawing1.xml', drawing],
    ['xl/drawings/_rels/drawing1.xml.rels', Buffer.from(drawingRelsPlantilla(), 'utf8')],
    ['xl/printerSettings/printerSettings1.bin', printerSettings],
    ['xl/theme/theme1.xml', z.get('xl/theme/theme1.xml')],
    ['xl/styles.xml', z.get('xl/styles.xml')],
    ['xl/sharedStrings.xml', z.get('xl/sharedStrings.xml')],
    ['xl/media/image1.png', z.get('xl/media/image1.png')],
    ['docProps/core.xml', z.get('docProps/core.xml')],
    ['docProps/app.xml', Buffer.from(appPlantilla(modelo.nombre), 'utf8')],
  ];
  for (const [nombre, datos] of entradas) {
    if (!datos) throw new Error(`Falta la parte "${nombre}" en el F03 de origen`);
  }

  const buf = escribirZip(entradas.map(([name, data]) => ({ name, data })));
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, buf);
  console.log(`\nEscrito   ${SALIDA}  (${buf.length} bytes, ${entradas.length} entradas)`);
  console.log('Recuerda commitear el artefacto: en runtime nadie lo regenera.');
}

// El script SÍ escribe a disco, así que valida su ruta (el criterio de AUD-28). `escribirZip` no lo
// necesita porque devuelve un `Buffer` y no toca el filesystem.
function rutaDeSalidaSegura(relativa) {
  const destino = resolve(RAIZ_REPO, relativa);
  const rel = relative(RAIZ_REPO, destino);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Ruta de salida fuera del repo: ${destino}`);
  }
  return destino;
}

function resolverHojaModelo(z) {
  const wb = z.get('xl/workbook.xml').toString('utf8');
  const rels = z.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const destinos = new Map(
    [...rels.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  for (const m of wb.matchAll(/<sheet name="([^"]+)"[^>]*r:id="([^"]+)"\s*\/>/g)) {
    if (!NOMBRE_DE_DIA.test(m[1])) continue;
    return { nombre: m[1], parte: `xl/${destinos.get(m[2])}` };
  }
  throw new Error('No se encontró ninguna hoja con nombre YYYY-MM-DD en el F03 de origen');
}

// Deja el andamiaje y borra el contenido: filas de datos fuera, `dimension` y `mergeCells`
// recortados al encabezado, y la vista normalizada para que cada hoja abra arriba (el original
// quedó guardado con `topLeftCell="A8"` y una selección a media hoja, que es estado de trabajo del
// último que lo editó, no parte del formato).
function limpiarHoja(xml) {
  let salida = xml;

  const sheetData = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(salida);
  if (!sheetData) throw new Error('La hoja modelo no tiene <sheetData>');
  const conservadas = [...sheetData[1].matchAll(FILA)]
    .map((f) => f[0])
    .filter((fila) => FILAS_ENCABEZADO.has(Number(/<row r="(\d+)"/.exec(fila)[1])))
    .map(recortarColumnas);
  if (conservadas.length !== FILAS_ENCABEZADO.size) {
    throw new Error(
      `Se esperaban las filas ${[...FILAS_ENCABEZADO].join(',')} del encabezado y se encontraron ${conservadas.length}`,
    );
  }
  salida = salida.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${conservadas.join('')}</sheetData>`);

  salida = salida.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:I${ULTIMA_FILA_ENCABEZADO}"/>`);
  salida = salida.replace(
    /<sheetViews>[\s\S]*?<\/sheetViews>/,
    '<sheetViews><sheetView showGridLines="0" tabSelected="1" zoomScale="130" zoomScaleNormal="130" workbookViewId="0">' +
      '<selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>',
  );

  const merges = /<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/.exec(salida);
  if (!merges) throw new Error('La hoja modelo no tiene <mergeCells>');
  const delEncabezado = [...merges[1].matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)]
    .filter((m) => Number(m[4]) <= ULTIMA_FILA_ENCABEZADO)
    .map((m) => m[0]);
  salida = salida.replace(
    /<mergeCells count="\d+">[\s\S]*?<\/mergeCells>/,
    `<mergeCells count="${delEncabezado.length}">${delEncabezado.join('')}</mergeCells>`,
  );

  console.log(`  filas conservadas: ${conservadas.length} · merges del encabezado: ${delEncabezado.length}`);
  return salida;
}

function recortarColumnas(fila) {
  const utiles = (fila.match(CELDA) ?? []).filter((c) =>
    COLUMNAS_UTILES.has(/r="([A-Z]+)\d+"/.exec(c)?.[1] ?? ''),
  );
  const apertura = /<row\s[^>]*?>/.exec(fila);
  if (!apertura) return fila; // fila vacía auto-cerrada: no tiene celdas que recortar
  return `${apertura[0].replace(/spans="[^"]*"/, 'spans="1:9"')}${utiles.join('')}</row>`;
}

const CABECERA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// El `workbook.xml` se REGENERA en vez de copiarse: el original arrastra un `mc:AlternateContent`
// con la ruta OneDrive corporativa del computador donde se editó, y 32 `definedName` que no
// aplican. Acá queda uno solo, y el generador lo reescribe entero por libro.
function workbookPlantilla(nombreHoja) {
  return (
    CABECERA_XML +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<workbookPr codeName="ThisWorkbook"/>' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="25440" windowHeight="15270"/></bookViews>' +
    `<sheets><sheet name="${nombreHoja}" sheetId="1" r:id="rId1"/></sheets>` +
    `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'${nombreHoja}'!$A$6:$I$${ULTIMA_FILA_ENCABEZADO}</definedName></definedNames>` +
    '<calcPr calcId="191029"/></workbook>'
  );
}

function workbookRelsPlantilla() {
  const tipo = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return (
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${tipo}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${tipo}/theme" Target="theme/theme1.xml"/>` +
    `<Relationship Id="rId3" Type="${tipo}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId4" Type="${tipo}/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>'
  );
}

function sheetRelsPlantilla(n) {
  const tipo = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return (
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${tipo}/printerSettings" Target="../printerSettings/printerSettings${n}.bin"/>` +
    `<Relationship Id="rId2" Type="${tipo}/drawing" Target="../drawings/drawing${n}.xml"/>` +
    '</Relationships>'
  );
}

function drawingRelsPlantilla() {
  const tipo = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return (
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${tipo}/image" Target="../media/image1.png"/>` +
    '</Relationships>'
  );
}

function contentTypesPlantilla() {
  const doc = 'application/vnd.openxmlformats-officedocument';
  return (
    CABECERA_XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Default Extension="bin" ContentType="${doc}.spreadsheetml.printerSettings"/>` +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${doc}.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${doc}.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${doc}.drawing+xml"/>` +
    `<Override PartName="/xl/theme/theme1.xml" ContentType="${doc}.theme+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${doc}.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${doc}.spreadsheetml.sharedStrings+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    `<Override PartName="/docProps/app.xml" ContentType="${doc}.extended-properties+xml"/>` +
    '</Types>'
  );
}

function appPlantilla(nombreHoja) {
  return (
    CABECERA_XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
    '<HeadingPairs><vt:vector size="4" baseType="variant">' +
    '<vt:variant><vt:lpstr>Hojas de cálculo</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>' +
    '<vt:variant><vt:lpstr>Rangos con nombre</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>' +
    '</vt:vector></HeadingPairs>' +
    '<TitlesOfParts><vt:vector size="2" baseType="lpstr">' +
    `<vt:lpstr>${nombreHoja}</vt:lpstr><vt:lpstr>'${nombreHoja}'!Área_de_impresión</vt:lpstr>` +
    '</vt:vector></TitlesOfParts>' +
    '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>'
  );
}

main();
