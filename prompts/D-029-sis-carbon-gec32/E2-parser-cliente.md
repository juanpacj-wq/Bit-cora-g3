# E2 — Port ESM del parser XLS + cliente SIS

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0 ✅, E1 ✅.
- Fuente a portar: `js-scraper-carbon-g32/xls.js` (parser OLE2/BIFF8, sin deps) y `scrape.js`
  (lógica de `buildUrl`/`fetchPeriod`). El backend es ESM; el origen es CommonJS.

## Objetivo
Crear el cliente SIS reutilizable en ESM, sin tocar BD todavía.

## Tareas
1. `server/utils/sis/xls-parser.js`:
   - Portar `parseXls` (y sus auxiliares `readCFBStream`, `parseSST`, lectura de celdas
     LABELSST/NUMBER/RK) desde `js-scraper-carbon-g32/xls.js` a **ESM** (`export function parseXls(buf)`).
   - Mantener la firma de retorno `{ maxRow, ncols, lastRow }` (array `lastRow` 1-indexado por columna).
   - No agregar dependencias. Copiar el algoritmo tal cual; solo cambiar `module.exports` → `export`.
2. `server/utils/sis/sis-client.js`:
   - Constantes: `SIS_HOST='http://192.168.18.201'` (configurable por `process.env.SIS_HOST`),
     `SIS_SERVER='NEWSYNCBASE'`, y el array de 12 `TAGS` (8 tolvas + energía + CT659 + CT651 + MPAFLOW),
     en el MISMO orden que el scraper (define columnas `lastRow[1..12]`).
   - `export function buildUrl(f1, h1, f2, h2)`: replica el XML URL-encoded de `scrape.js:19-28`.
   - `export async function fetchPeriod(f1, h1, f2, h2)`: `fetch(buildUrl(...))`, valida `resp.ok`,
     `Buffer.from(await resp.arrayBuffer())`, `parseXls(buf)`, devuelve `{ status, bytes, ...parsed }`.
     Acepta un `signal`/timeout opcional (AbortController) para no colgar el sweeper.
   - `export function periodoBounds(fecha, periodo)`: dado `fecha` (YYYY-MM-DD) y `periodo` 1..24,
     devuelve `{ f1, h1, f2, h2 }` con la regla del scraper (`h1=periodo-1`; `periodo=24` ⇒ `f2`=día
     siguiente, `h2='00'`). Corrige el cómputo del día siguiente para que sea robusto en TZ.
   - `export function extraerCarbonValidado(lastRow)`: aplica la validación de servicio
     (`v659=lastRow[10]`, `v651=lastRow[11]`, `mpaflow=lastRow[12]`, `enServicio = v659>400 && v651>400
     && mpaflow>140`) y devuelve `{ enServicio, tolvasVal:[8], energiaMw, totalCarbon }` donde
     `tolvasVal[i] = (raw>0.5 && enServicio) ? round3(raw) : 0` para `raw=lastRow[i+1]`.

## Prueba
- `server/tests/sis_parser.test.js` (node:test):
  - `buildUrl(...)` contiene los 12 tags, el server `NEWSYNCBASE`, y `t1`/`t2` correctos.
  - `periodoBounds('2026-06-03', 1)` → `h1='00'`, `h2='01'`, `f2='2026-06-03'`;
    `periodoBounds('2026-06-03', 24)` → `h1='23'`, `h2='00'`, `f2='2026-06-04'`.
  - `extraerCarbonValidado([_,..])`: caso en servicio (sensores altos, tolvas>0.5) suma>0;
    caso fuera de servicio (sensores bajos) ⇒ todas las tolvas 0.
  - **Parser**: capturar un buffer `.xls` real de muestra (ver nota) y verificar que `parseXls`
    devuelve `lastRow` con 12 valores numéricos. Si no hay fixture disponible offline, dejar el test
    del parser marcado y validarlo contra el SIS real en E3/E7; documentarlo en ESTADO.md.
- Agregar el/los test(s) al script `test` de `server/package.json`.

> Nota fixture: si tienes acceso al SIS desde el equipo, captura un `.xls` con
> `node js-scraper-carbon-g32/scrape.js` (genera el `.xlsx`) NO sirve como fixture del parser;
> mejor guarda el `arrayBuffer` crudo de una respuesta a `server/tests/fixtures/sis-period.xls`.

## Al terminar
Actualiza `ESTADO.md`: E2 ✅, archivos (`server/utils/sis/xls-parser.js`, `sis-client.js`,
tests, fixtures), resultado, y si el test del parser quedó pendiente de fixture real.
