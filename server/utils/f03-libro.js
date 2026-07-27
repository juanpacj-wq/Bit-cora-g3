// D-058 — Clonador del libro mensual GENE-F03: una hoja por día, calcada de la plantilla real.
//
// Módulo PURO: sin BD, sin reloj, sin red, sin TZ. Entra la estructura de datos del mes —la que
// arma `f03-datos.js` (E8)— y sale el `Buffer` del `.xlsx`. Las horas llegan ya resueltas como
// `'HH:MM'` en hora Bogotá: la zona horaria es problema de quien consulta, no de quien escribe
// (mismo criterio que el motor de asientos, D-058 E1).
//
// Qué NO hace y por qué: no infla nada. La plantilla de `server/assets/` ya viene como ZIP
// `stored` desde `scripts/derivar-plantilla-f03.mjs`, así que acá se clonan bytes y se inyectan los
// `sheetN.xml`. Es lo que permite cumplir REQ-01 §5.1 (cero dependencias nuevas) sin `exceljs`.
//
// Layout de cada hoja (§7 del insumo de formato):
//
//    1..5, 7, 8   encabezado GENE-F03 — clonado VERBATIM de la plantilla, con sus `t="s"` contra
//                 el `sharedStrings.xml` preservado. `Fecha: 01/06/2017` de la fila 4 es la fecha
//                 de emisión del FORMATO y no se toca nunca.
//    6            `FECHA:` + el día de la hoja
//    9..          tres bloques de turno, cada uno: TURNO: / JEFE DE TURNO: / INGENIERO DE TURNO: /
//                 títulos `HH:MM` + `DESCRIPCIÓN EVENTO Y/O ACTIVIDAD` / N filas de eventos
//
// Los bloques CRECEN hacia abajo, así que `dimension`, `mergeCells` y el `Print_Area` se recalculan
// con el alto real de cada hoja. La trampa del área de impresión está explicada abajo, en
// `workbookDelLibro`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leerZip, escribirZip, xmlEsc } from './xlsx.js';

const RUTA_PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'f03-plantilla.xlsx');

// Índices de estilo de la plantilla. El mapa completo, con su procedencia, vive en la cabecera de
// `scripts/derivar-plantilla-f03.mjs`: se midió sobre la hoja `2026-01-01` del F03 real.
// Si alguna vez se regenera la plantilla desde otro formato, hay que revisarlos ahí y acá juntos.
const S = {
  fechaRotulo: 2, // A6 `FECHA:`
  fechaValor: 48, // B6..D6 — numFmt 164 (fecha larga), SERIAL de Excel, no texto
  fechaRelleno: 3, // E6..H6
  fechaCierre: 4, // I6
  turnoRotulo: 49, turnoB: 50, turnoC: 51, turnoValor: 52, turnoRelleno: 53, turnoCierre: 54,
  jefeRotulo: 55, jefeB: 56, jefeC: 57, jefeValor: 58, jefeRelleno: 59, jefeCierre: 60,
  ingRotulo: 21, ingB: 22, ingC: 23, ingValor: 24, ingRelleno: 25, ingCierre: 26,
  titHora: 11, titDesc: 64, titRelleno: 65, titCierre: 66,
  datoHora: 12, datoDesc: 73, datoRelleno: 74, datoCierre: 75,
  // Terna de la ÚLTIMA fila de cada bloque: borde inferior grueso que cierra el recuadro.
  ultimaHora: 16, ultimaDesc: 76, ultimaRelleno: 77, ultimaCierre: 78,
};

const ROTULO_TURNO = 'TURNO:';
const ROTULO_JEFE = 'JEFE DE TURNO:';
const ROTULO_INGENIERO = 'INGENIERO DE TURNO:';
const TITULO_HORA = 'HH:MM';
const TITULO_DESCRIPCION = 'DESCRIPCIÓN EVENTO Y/O ACTIVIDAD';

const PRIMERA_FILA_BLOQUES = 9;
const FILA_FECHA = 6;
const ULTIMA_COLUMNA = 'I';

// Alto de una fila de datos. Las celdas de descripción llevan `wrapText="1"` y están COMBINADAS
// (B:I) — y Excel no autoajusta el alto de una celda combinada, así que hay que estimarlo o el
// texto largo sale cortado. Las constantes salen de medir el original: ~115 caracteres entran en un
// renglón de B:I con Arial Narrow 8, y el humano que llena el F03 usa 16.5 para una línea y 25.5
// para dos.
const CARACTERES_POR_RENGLON = 115;
const ALTO_RENGLON = 12.75;
const ALTO_MINIMO_DATO = 16.5;
const ALTO_FILA_ENCABEZADO = 16.5;

let plantillaCacheada = null;

// Lee el artefacto commiteado UNA vez por proceso: son ~120 KB que no cambian nunca en runtime.
export function cargarPlantillaF03() {
  if (!plantillaCacheada) plantillaCacheada = leerZip(readFileSync(RUTA_PLANTILLA));
  return plantillaCacheada;
}

/**
 * Arma el libro mensual completo.
 *
 * @param {Array<{fecha: string, bloques: Array<{turno_literal: string, jefe: string,
 *   ingenieros: string, filas: Array<{hora: string, asiento: string}>}>}>} dias
 *   Un elemento por día del mes, en orden ascendente. `fecha` en `YYYY-MM-DD` (es también el
 *   nombre de la hoja) y `hora` en `HH:MM` hora Bogotá. Un día sin eventos trae sus bloques con
 *   `filas: []`, y eso NO es un error: el mes vacío devuelve el libro con las hojas vacías
 *   (RN-06.h).
 * @param {Map<string, Buffer>} [plantilla] Partes de la plantilla; por defecto la del repo.
 * @returns {Buffer} el `.xlsx`
 */
export function construirLibroF03(dias, plantilla = cargarPlantillaF03()) {
  if (!Array.isArray(dias) || dias.length === 0) {
    throw new Error('construirLibroF03: se esperaba al menos un día');
  }
  const modelo = plantilla.get('xl/worksheets/sheet1.xml').toString('utf8');
  const encabezado = extraerEncabezado(modelo);

  const hojas = dias.map((dia, i) => {
    const { sheetData, ultimaFila, merges } = renderizarDia(dia, encabezado);
    return {
      nombre: dia.fecha,
      indice: i + 1,
      ultimaFila,
      xml: componerHoja(modelo, { sheetData, ultimaFila, merges, primera: i === 0 }),
    };
  });

  const entradas = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesDelLibro(hojas.length), 'utf8') },
    { name: '_rels/.rels', data: plantilla.get('_rels/.rels') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookDelLibro(hojas), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsDelLibro(hojas.length), 'utf8') },
  ];
  const relsModelo = plantilla.get('xl/worksheets/_rels/sheet1.xml.rels').toString('utf8');
  const drawingModelo = plantilla.get('xl/drawings/drawing1.xml');
  const drawingRelsModelo = plantilla.get('xl/drawings/_rels/drawing1.xml.rels');
  const printerSettings = plantilla.get('xl/printerSettings/printerSettings1.bin');

  for (const hoja of hojas) {
    const n = hoja.indice;
    entradas.push(
      { name: `xl/worksheets/sheet${n}.xml`, data: Buffer.from(hoja.xml, 'utf8') },
      // Los `rId` internos de la hoja NO cambian (rId1 = printerSettings, rId2 = drawing): lo que
      // cambia es a qué parte apuntan, y eso vive en el Target del rels.
      { name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: Buffer.from(renumerar(relsModelo, n), 'utf8') },
      { name: `xl/drawings/drawing${n}.xml`, data: drawingModelo },
      { name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: drawingRelsModelo },
      { name: `xl/printerSettings/printerSettings${n}.bin`, data: printerSettings },
    );
  }

  // Intactas byte a byte. El logo en particular: viaja tal cual desde el formato controlado y su
  // `drawing` lo referencia por `rId`, así que no hay nada que tocar mientras el encabezado no se
  // mueva de las filas 1..6.
  entradas.push(
    { name: 'xl/theme/theme1.xml', data: plantilla.get('xl/theme/theme1.xml') },
    { name: 'xl/styles.xml', data: plantilla.get('xl/styles.xml') },
    { name: 'xl/sharedStrings.xml', data: plantilla.get('xl/sharedStrings.xml') },
    { name: 'xl/media/image1.png', data: plantilla.get('xl/media/image1.png') },
    { name: 'docProps/core.xml', data: plantilla.get('docProps/core.xml') },
    { name: 'docProps/app.xml', data: Buffer.from(appDelLibro(hojas), 'utf8') },
  );

  return escribirZip(entradas);
}

// ── Render de una hoja ───────────────────────────────────────────────────────────────────────

function renderizarDia(dia, encabezado) {
  const filas = [...encabezado.hasta5, filaFecha(dia.fecha), ...encabezado.desde7];
  const merges = [...encabezado.merges];

  let r = PRIMERA_FILA_BLOQUES;
  for (const bloque of dia.bloques ?? []) {
    const eventos = bloque.filas ?? [];

    filas.push(filaRotulo(r, S.turnoRotulo, S.turnoB, S.turnoC, S.turnoValor, S.turnoRelleno, S.turnoCierre, ROTULO_TURNO, bloque.turno_literal));
    merges.push(mergeRotulo(r));
    r++;
    filas.push(filaRotulo(r, S.jefeRotulo, S.jefeB, S.jefeC, S.jefeValor, S.jefeRelleno, S.jefeCierre, ROTULO_JEFE, bloque.jefe));
    merges.push(mergeRotulo(r));
    r++;
    filas.push(filaRotulo(r, S.ingRotulo, S.ingB, S.ingC, S.ingValor, S.ingRelleno, S.ingCierre, ROTULO_INGENIERO, bloque.ingenieros));
    merges.push(mergeRotulo(r));
    r++;

    filas.push(filaTitulos(r));
    merges.push(mergeDescripcion(r));
    r++;

    // Un bloque sin eventos deja su encabezado y ninguna fila (§7.2-5). No se inventa una fila en
    // blanco: el papel tampoco la tiene.
    eventos.forEach((evento, i) => {
      filas.push(filaDato(r, evento, i === eventos.length - 1));
      merges.push(mergeDescripcion(r));
      r++;
    });
  }

  return { sheetData: filas.join(''), ultimaFila: r - 1, merges };
}

function filaFecha(fecha) {
  const celdas =
    celdaTexto(`A${FILA_FECHA}`, S.fechaRotulo, 'FECHA:') +
    `<c r="B${FILA_FECHA}" s="${S.fechaValor}"><v>${serialDeFecha(fecha)}</v></c>` +
    celdaVacia(`C${FILA_FECHA}`, S.fechaValor) +
    celdaVacia(`D${FILA_FECHA}`, S.fechaValor) +
    ['E', 'F', 'G', 'H'].map((c) => celdaVacia(`${c}${FILA_FECHA}`, S.fechaRelleno)).join('') +
    celdaVacia(`I${FILA_FECHA}`, S.fechaCierre);
  return `<row r="${FILA_FECHA}" spans="1:9" ht="20.25" customHeight="1">${celdas}</row>`;
}

function filaRotulo(r, sA, sB, sC, sValor, sRelleno, sCierre, rotulo, valor) {
  const celdas =
    celdaTexto(`A${r}`, sA, rotulo) +
    celdaVacia(`B${r}`, sB) +
    celdaVacia(`C${r}`, sC) +
    // Sin dato, la celda va vacía pero CON su estilo: el recuadro del formato se dibuja igual.
    // No inventar un nombre es una regla del armado (E8): si el turno no dejó rastro, va en blanco.
    celdaTexto(`D${r}`, sValor, valor) +
    ['E', 'F', 'G', 'H'].map((c) => celdaVacia(`${c}${r}`, sRelleno)).join('') +
    celdaVacia(`I${r}`, sCierre);
  return `<row r="${r}" spans="1:9" ht="${ALTO_FILA_ENCABEZADO}" customHeight="1">${celdas}</row>`;
}

function filaTitulos(r) {
  const celdas =
    celdaTexto(`A${r}`, S.titHora, TITULO_HORA) +
    celdaTexto(`B${r}`, S.titDesc, TITULO_DESCRIPCION) +
    ['C', 'D', 'E', 'F', 'G', 'H'].map((c) => celdaVacia(`${c}${r}`, S.titRelleno)).join('') +
    celdaVacia(`I${r}`, S.titCierre);
  return `<row r="${r}" spans="1:9" ht="${ALTO_FILA_ENCABEZADO}" customHeight="1" thickBot="1">${celdas}</row>`;
}

function filaDato(r, evento, esUltima) {
  const sHora = esUltima ? S.ultimaHora : S.datoHora;
  const sDesc = esUltima ? S.ultimaDesc : S.datoDesc;
  const sRelleno = esUltima ? S.ultimaRelleno : S.datoRelleno;
  const sCierre = esUltima ? S.ultimaCierre : S.datoCierre;

  const asiento = String(evento?.asiento ?? '');
  const fraccion = fraccionDeHora(evento?.hora);
  // La hora va como NÚMERO con formato `h:mm`, igual que el original — no como texto. Es lo que
  // permite ordenar y filtrar en Excel, y lo que hace que `00:00` no se lea como un cero suelto.
  const celdaHora =
    fraccion === null
      ? celdaVacia(`A${r}`, sHora)
      : `<c r="A${r}" s="${sHora}"><v>${fraccion}</v></c>`;

  const celdas =
    celdaHora +
    celdaTexto(`B${r}`, sDesc, asiento) +
    ['C', 'D', 'E', 'F', 'G', 'H'].map((c) => celdaVacia(`${c}${r}`, sRelleno)).join('') +
    celdaVacia(`I${r}`, sCierre);
  const alto = altoDeFila(asiento);
  const cierre = esUltima ? ' thickBot="1"' : '';
  return `<row r="${r}" spans="1:9" ht="${alto}" customHeight="1"${cierre}>${celdas}</row>`;
}

// `inlineStr` SIEMPRE para lo que escribimos, nunca `sharedStrings`: agregar entradas obligaría a
// reindexar la tabla de strings de la plantilla, y esa tabla es justo lo que sostiene los `t="s"`
// del encabezado GENE-F03 clonado. Un solo índice corrido corrompe el título del formato.
// `xml:space="preserve"` porque un asiento puede terminar en espacio y Excel lo recortaría.
function celdaTexto(ref, s, valor) {
  const texto = valor == null ? '' : String(valor);
  if (texto === '') return celdaVacia(ref, s);
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(texto)}</t></is></c>`;
}

const celdaVacia = (ref, s) => `<c r="${ref}" s="${s}"/>`;

const mergeRotulo = (r) => `<mergeCell ref="A${r}:C${r}"/><mergeCell ref="D${r}:${ULTIMA_COLUMNA}${r}"/>`;
const mergeDescripcion = (r) => `<mergeCell ref="B${r}:${ULTIMA_COLUMNA}${r}"/>`;

function altoDeFila(texto) {
  const renglones = Math.max(1, Math.ceil(texto.length / CARACTERES_POR_RENGLON));
  return Math.max(ALTO_MINIMO_DATO, renglones * ALTO_RENGLON);
}

// `HH:MM` → fracción del día, que es como Excel guarda una hora. Devuelve `null` si no hay hora
// utilizable: la celda queda vacía en vez de escribir un `00:00` que nadie registró.
function fraccionDeHora(hora) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return (h * 60 + min) / 1440;
}

// `YYYY-MM-DD` → serial de Excel. El desfase 25569 es días entre la época Unix y la de Excel, que
// arranca en 1899-12-30 por el bug del año bisiesto de 1900 que Excel conserva a propósito.
// Se parsea la cadena a mano y se calcula en UTC: nada de `new Date(str)` ni `getMonth()`, que
// meterían la zona horaria de la máquina en un dato que ya viene resuelto en Bogotá (D-020).
function serialDeFecha(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha ?? ''));
  if (!m) throw new Error(`construirLibroF03: fecha inválida "${fecha}" (se espera YYYY-MM-DD)`);
  const dias = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  return dias + 25569;
}

// ── Composición del XML de la hoja ───────────────────────────────────────────────────────────

// De la plantilla salen las filas del encabezado y sus merges. Se parten en "hasta la 5" y "desde
// la 7" porque la fila 6 (FECHA) se genera por hoja y las filas de `sheetData` tienen que quedar en
// orden ascendente de `r`.
function extraerEncabezado(modelo) {
  const sheetData = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(modelo);
  if (!sheetData) throw new Error('La plantilla F03 no tiene <sheetData>');
  // Una `<row>` es `<row …/>` o `<row …>…</row>`; el orden de la alternativa importa. Una regex
  // no-greedy del tipo `<row …[\s\S]*?(?:<\/row>|\/>)` corta en el primer `/>`, que es una CELDA
  // auto-cerrada y no el fin de la fila, y produce un XML partido que Excel reporta como archivo
  // corrupto — sin que ningún test de conteo lo note.
  const filas = [...sheetData[1].matchAll(/<row\s[^>]*\/>|<row\s[^>]*>[\s\S]*?<\/row>/g)].map((f) => ({
    n: Number(/<row r="(\d+)"/.exec(f[0])[1]),
    xml: f[0],
  }));
  const merges = /<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/.exec(modelo);
  if (!merges) throw new Error('La plantilla F03 no tiene <mergeCells>');
  return {
    hasta5: filas.filter((f) => f.n <= 5).map((f) => f.xml),
    desde7: filas.filter((f) => f.n >= 7).map((f) => f.xml),
    merges: [merges[1]],
  };
}

function componerHoja(modelo, { sheetData, ultimaFila, merges, primera }) {
  let xml = modelo.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetData}</sheetData>`);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${ULTIMA_COLUMNA}${ultimaFila}"/>`);
  const total = merges.join('').match(/<mergeCell /g)?.length ?? 0;
  xml = xml.replace(
    /<mergeCells count="\d+">[\s\S]*?<\/mergeCells>/,
    `<mergeCells count="${total}">${merges.join('')}</mergeCells>`,
  );
  // `tabSelected` solo en la primera hoja: si va en todas, Excel abre el libro con las 31 hojas
  // AGRUPADAS y cualquier edición se replica en todas — un accidente esperando a pasar.
  if (!primera) xml = xml.replace(' tabSelected="1"', '');
  return xml;
}

const renumerar = (rels, n) => rels.replace(/printerSettings1\.bin/, `printerSettings${n}.bin`).replace(/drawing1\.xml/, `drawing${n}.xml`);

// ── Partes del libro ─────────────────────────────────────────────────────────────────────────

function workbookDelLibro(hojas) {
  const sheets = hojas
    .map((h) => `<sheet name="${xmlEsc(h.nombre)}" sheetId="${h.indice}" r:id="rId${h.indice}"/>`)
    .join('');
  // LA TRAMPA: el área de impresión es POR HOJA (`localSheetId` = índice 0-based en la colección de
  // sheets) y su rango depende de cuántos eventos tuvo el día — el F03 original trae 32, con rangos
  // que van de `$A$6:$I$25` a `$A$6:$I$32`. Clonar el bloque sin recalcular hace que Excel imprima
  // rangos vacíos en los días cortos y CORTE los días largos, que es el defecto que más se nota al
  // imprimir y el que nadie ve en pantalla.
  const definedNames = hojas
    .map(
      (h, i) =>
        `<definedName name="_xlnm.Print_Area" localSheetId="${i}">'${xmlEsc(h.nombre)}'!$A$6:$${ULTIMA_COLUMNA}$${h.ultimaFila}</definedName>`,
    )
    .join('');
  return (
    CABECERA_XML +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<workbookPr codeName="ThisWorkbook"/>' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="25440" windowHeight="15270" activeTab="0"/></bookViews>' +
    `<sheets>${sheets}</sheets>` +
    `<definedNames>${definedNames}</definedNames>` +
    '<calcPr calcId="191029"/></workbook>'
  );
}

function workbookRelsDelLibro(cantidad) {
  const tipo = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const hojas = Array.from(
    { length: cantidad },
    (_, i) => `<Relationship Id="rId${i + 1}" Type="${tipo}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    hojas +
    `<Relationship Id="rId${cantidad + 1}" Type="${tipo}/theme" Target="theme/theme1.xml"/>` +
    `<Relationship Id="rId${cantidad + 2}" Type="${tipo}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${cantidad + 3}" Type="${tipo}/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>'
  );
}

function contentTypesDelLibro(cantidad) {
  const doc = 'application/vnd.openxmlformats-officedocument';
  const porHoja = Array.from(
    { length: cantidad },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${doc}.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="${doc}.drawing+xml"/>`,
  ).join('');
  return (
    CABECERA_XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Default Extension="bin" ContentType="${doc}.spreadsheetml.printerSettings"/>` +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${doc}.spreadsheetml.sheet.main+xml"/>` +
    porHoja +
    `<Override PartName="/xl/theme/theme1.xml" ContentType="${doc}.theme+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${doc}.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${doc}.spreadsheetml.sharedStrings+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    `<Override PartName="/docProps/app.xml" ContentType="${doc}.extended-properties+xml"/>` +
    '</Types>'
  );
}

function appDelLibro(hojas) {
  const nombres = hojas.map((h) => `<vt:lpstr>${xmlEsc(h.nombre)}</vt:lpstr>`).join('');
  const areas = hojas.map((h) => `<vt:lpstr>'${xmlEsc(h.nombre)}'!Área_de_impresión</vt:lpstr>`).join('');
  return (
    CABECERA_XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
    '<HeadingPairs><vt:vector size="4" baseType="variant">' +
    `<vt:variant><vt:lpstr>Hojas de cálculo</vt:lpstr></vt:variant><vt:variant><vt:i4>${hojas.length}</vt:i4></vt:variant>` +
    `<vt:variant><vt:lpstr>Rangos con nombre</vt:lpstr></vt:variant><vt:variant><vt:i4>${hojas.length}</vt:i4></vt:variant>` +
    '</vt:vector></HeadingPairs>' +
    `<TitlesOfParts><vt:vector size="${hojas.length * 2}" baseType="lpstr">${nombres}${areas}</vt:vector></TitlesOfParts>` +
    '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>'
  );
}

const CABECERA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
