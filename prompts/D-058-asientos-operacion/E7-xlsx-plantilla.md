# D-058 · E7 — Escritor XLSX en ESM + plantilla F03 derivada

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo (secciones **"Anatomía del `.xlsx` de referencia"**,
   **"Layout de la hoja"** y **"4. El Excel"**) y `ESTADO.md`.
2. **Verificá que E1..E6 figuren ✅.**
3. Tené a mano `2026_01_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx` (raíz del repo) y
   §7 del insumo de formato.

## Alcance de esta etapa

**Entra:** la infraestructura `.xlsx` — el port ESM del escritor, el lector mínimo de ZIP y el
script offline que deriva la plantilla, más el artefacto `server/assets/f03-plantilla.xlsx`
commiteado.
**No entra:** ninguna consulta a BD, ningún endpoint, ningún dato real. El entregable es
"puedo clonar la plantilla N veces e inyectar filas, y Excel lo abre sin quejarse".

## Restricción dura

**Cero dependencias nuevas.** REQ-01 §5.1 ya decidió que `exceljs`/`xlsx` están prohibidas: el
backend tiene seis deps y así se queda. Todo sale de `node:zlib` (nativo) y del escritor propio de
`js-scraper-carbon-g32/xlsx-write.js`.

Ese escritor **emite pero no lee**, y un `.xlsx` de Excel viene en **deflate**. De ahí el reparto:

- **Offline** (script de derivación): lee con `zlib.inflateRawSync`, re-emite el artefacto como ZIP
  **`stored`**.
- **En runtime**: la plantilla ya es `stored`, así que el generador **solo clona bytes e inyecta los
  `sheetN.xml`** — cero `inflate`, cero deps en producción.

## Tareas

1. `server/utils/xlsx.js` — port ESM de `js-scraper-carbon-g32/xlsx-write.js`, con:
   - `leerZip(buffer)` → `Map<nombre, Buffer>`. Recorre el **central directory** desde el EOCD;
     soporta `stored` y `deflate` (`inflateRawSync`) para que el script offline lo reuse.
   - `escribirZip(entradas)` → `Buffer`. El writer que ya existe (CRC32 + `stored`), sin
     `fs.writeFileSync`: **devuelve `Buffer`**, no escribe a disco. Conservar `xmlEsc` y `colRef`.
   - Se retira el `assertWithinDir` de AUD-28: acá no se escribe a disco. (El script offline sí
     escribe, y ahí sí valida su ruta de salida.)
   - **No** tocar `js-scraper-carbon-g32/xlsx-write.js`: es otro proyecto (CommonJS) y sigue como
     está.
2. `scripts/derivar-plantilla-f03.mjs` — **offline**, se corre a mano, no lo invoca `initDB()` ni CI:
   - Lee el F03 de la raíz. **Ignorá `2026-01-24 (2)`**, la hoja duplicada, que además es el primer
     `sheet` del libro: tomá una hoja limpia como modelo.
   - Produce una plantilla de **una sola hoja**: encabezado GENE-F03 (filas 1..6, con
     `Fecha: 01/06/2017` que es la **fecha de emisión del formato** y **no cambia**), el logo, los
     estilos, los merges del encabezado, el área de impresión y la configuración de página.
     **Borra las filas de datos** (los eventos de enero).
   - Escribe `server/assets/f03-plantilla.xlsx` como ZIP **`stored`**.
   - Deja en el propio script, comentado, **qué índices de estilo (`s="…"`) corresponden a cada tipo
     de celda** del layout: rótulo `TURNO:`, valor del turno, `JEFE DE TURNO:`, `INGENIERO DE
     TURNO:`, encabezado `HH:MM`/`DESCRIPCIÓN`, celda de hora (con su `numFmt`) y celda de
     descripción. E8/E9 los necesitan y no deben re-descubrirlos a ojo.
3. Correr el script y **commitear el artefacto** `server/assets/f03-plantilla.xlsx`.
4. `server/utils/f03-libro.js` — el clonador. Dada una plantilla y `N` días, produce el `Buffer` del
   libro:
   - Por día emite `xl/worksheets/sheet{N}.xml` + `xl/worksheets/_rels/sheet{N}.xml.rels` +
     `xl/drawings/drawing{N}.xml` + `xl/drawings/_rels/drawing{N}.xml.rels` +
     `xl/printerSettings/printerSettings{N}.bin`, todos clonados del modelo con sus `rId`
     corregidos.
   - Regenera `xl/workbook.xml` (sheets con nombre `YYYY-MM-DD` + **un `definedName` por hoja**),
     `xl/_rels/workbook.xml.rels`, `[Content_Types].xml` y `docProps/app.xml`.
   - Copia intactas `xl/styles.xml`, `xl/theme/theme1.xml`, `xl/sharedStrings.xml`,
     `xl/media/image1.png`, `_rels/.rels`, `docProps/core.xml`.
   - Recalcula por hoja: `dimension`, `mergeCells` y el **`Print_Area`**.

   **Tres detalles que ahorran dolor** (respuesta 15):
   1. **`inlineStr` para las filas de datos**, nunca `sharedStrings`: evita reindexar la tabla de
      strings de la plantilla y corromperla. Las celdas del encabezado se clonan verbatim y
      conservan sus `t="s"` contra el `sharedStrings.xml` preservado.
   2. El logo vive en `xl/media/` y se copia tal cual; su `drawing` referencia por `rId` y **no hay
      que tocarlo mientras no se muevan las filas del encabezado**.
   3. **La trampa:** el área de impresión es **por hoja**
      (`<definedName name="_xlnm.Print_Area" localSheetId="N">`) y el original trae una por cada uno
      de sus 32 sheets, con rangos distintos (`$A$6:$I$25` … `$A$6:$I$32`) según cuántos eventos
      tuvo el día. Emitir **un `definedName` por hoja**, con su `localSheetId` (índice **0-based**
      en la colección de sheets) y su rango recalculado al alto real. Clonar el bloque sin
      recalcular hace que Excel imprima rangos vacíos o corte los días largos.
5. Tests `server/tests/f03_libro.test.js` — **unitarios, sin BD**. Engancharlo al script `test` de
   `server/package.json` (el guard de D-041 existía y no corría por olvidar esto):
   - Generar un libro de 28, 30 y 31 hojas con contenido sintético.
   - Releer el `Buffer` con `leerZip` y verificar: cantidad de hojas; nombres `YYYY-MM-DD` en orden;
     un `definedName` por hoja con `localSheetId` correlativo y rango coherente con el alto;
     `[Content_Types].xml` con un `Override` por cada parte emitida; `xl/media/image1.png` presente
     y **byte-idéntico** al de la plantilla; `sharedStrings.xml` **sin modificar**.
   - Que las filas de datos usen `t="inlineStr"` y ninguna `t="s"` nueva.
   - Que el XML escape correctamente `&`, `<`, `>` y comillas en el texto de un asiento.
   - **Smoke manual del autor:** abrir uno de los libros generados en Excel y confirmar que no
     aparece la advertencia de archivo corrupto (criterio 9 de REQ-06) y que se ve el logo. Dejalo
     explícito en `ESTADO.md`: es lo único que el test no puede cubrir.

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado.
- Smoke manual en Excel (arriba). **No cierres la etapa sin hacerlo**: un `.xlsx` inválido pasa
  todos los tests de estructura y falla en el único lugar que importa.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E7 ✅. Bloque con **Archivos tocados**, **Verificación** (incluido el resultado del smoke en
  Excel) y **Desviaciones**.
- Anotá en "Datos descubiertos" el **mapa de índices de estilo** que descubriste: E8 y E9 lo usan.

## Commit
```bash
git add server/utils/xlsx.js server/utils/f03-libro.js server/assets/f03-plantilla.xlsx scripts/derivar-plantilla-f03.mjs server/tests/f03_libro.test.js server/package.json
git commit -m "$(cat <<'EOF'
feat(xlsx): escritor OOXML en ESM + plantilla F03 clonable, sin dependencias nuevas

El libro mensual tiene que verse como el formato controlado GENE-F03, con su logo,
sus estilos y su área de impresión — no como un export. Así que en vez de dibujar la
hoja desde cero se clona una plantilla real.

El reparto lo impone una restricción: REQ-01 §5.1 prohíbe agregar dependencias
(exceljs/xlsx quedan fuera), y el escritor propio del scraper emite ZIP stored pero no
lee, mientras que un .xlsx de Excel viene en deflate. Entonces el script de derivación
corre OFFLINE — infla con zlib nativo, borra las filas de datos, conserva el andamiaje
y re-emite el artefacto como stored — y en runtime el generador solo clona bytes e
inyecta los sheetN.xml. Cero inflate y cero deps en producción.

Las filas de datos van como inlineStr para no reindexar la tabla de sharedStrings de
la plantilla y corromperla. Y el área de impresión se emite por hoja con su rango
recalculado: es un definedName con localSheetId, y clonarlo sin recalcular hace que
Excel imprima rangos vacíos o corte los días largos.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
