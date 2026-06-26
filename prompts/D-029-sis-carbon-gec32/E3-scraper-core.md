# E3 — carbon-scraper core + regla de ownership

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E2 ✅.
- Usa `server/utils/sis/sis-client.js` (E2): `fetchPeriod`, `periodoBounds`, `extraerCarbonValidado`.
- Destino: `bitacora.consumo_combustible` (+ columnas `valor_sis`, `sis_actualizado_en` de E1) y
  `bitacora.sis_scrape_log`. Autor automático: `dbBindings.USUARIO_SISTEMA_ID`.
- Combustibles GEC32: `ALIM_1..ALIM_8` (tolva k → `ALIM_k`). Resolver sus `combustible_id` por
  `SELECT combustible_id, codigo FROM lov_bit.combustible WHERE planta_id='GEC32' AND codigo LIKE 'ALIM_%'`.

## Objetivo
Implementar el núcleo que extrae un día y persiste con la **regla de ownership** (operador gana).

## Tareas — `server/utils/sis/carbon-scraper.js`
1. `export async function scrapeDia(pool, { fecha, scrape_tipo = 'horario', soloHoy = true })`:
   - Determinar `periodos`: si `fecha === hoyBogota`, procesar `1..hora_actual_bogota`; si es día
     pasado, `1..24`. (Reusar helpers de `server/utils/turno.js`/`fecha.js`.)
   - Resolver `USUARIO_SISTEMA_ID` y el mapa `{ k: combustible_id }` para `ALIM_1..8` de GEC32 (una vez).
   - Por cada periodo: `fetchPeriod(periodoBounds(...))` → `extraerCarbonValidado(lastRow)`.
     Acumular `periodos_ok`/`periodos_error` (un fetch fallido NO aborta el día; cuenta error).
   - Por cada tolva k=1..8, con `valorSis = tolvasVal[k-1]`, aplicar **la tabla de ownership**
     (de `_CONTEXTO-BASE.md`) contra la fila existente buscada por
     `UNIQUE(planta_id='GEC32', fecha, periodo, combustible_id=ALIM_k)`:
     - SIS-owned ⇔ `creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA)`.
     - `>0` no existe → INSERT; `>0` SIS-owned → UPDATE cantidad+valor_sis; `>0` humano-owned →
       UPDATE solo valor_sis; `=0` no existe → skip; `=0` SIS-owned → DELETE; `=0` humano-owned →
       UPDATE valor_sis=0.
     - Toda escritura SIS usa `creado_por`/`modificado_por = SISTEMA` y setea `sis_actualizado_en=SYSUTCDATETIME()`.
   - Envolver la escritura del día (o por periodo) en transacción(es) mssql con rollback ante error.
   - Upsert en `sis_scrape_log` (por `UNIQUE(planta_id,fecha)`): MERGE/IF EXISTS UPDATE ELSE INSERT,
     con `periodos_ok`, `periodos_error`, `ultimo_periodo`, `completo` (= `periodos_error===0 &&
     últimoPeriodoProcesado===Nesperado`), `scrape_tipo`, `scraped_en=now`.
   - Devolver un resumen `{ fecha, periodos_ok, periodos_error, creados, actualizados, eliminados, completo }`.
2. `export async function discoverEarliestDate(pool, { hint } = {})`:
   - Sondea el SIS hacia atrás para hallar la primera fecha con datos (unidad existía/en servicio
     alguna vez ese día). Estrategia: probar un periodo medio (p. ej. 12) en fechas candidatas
     retrocediendo por año, luego afinar por mes/día (búsqueda binaria). "Hay datos" ⇔ `fetchPeriod`
     responde OK y `lastRow` trae los 12 tags presentes con algún sensor != 0 / bytes razonables.
   - **Esta heurística se calibra en E7 con sondeos reales**; aquí deja la función parametrizable
     (umbrales, fecha tope de búsqueda) y bien logueada.

## Prueba — `server/tests/sis_scraper_ownership.test.js` (node:test, BD real + fetch mockeado)
- Mockear `fetchPeriod` (inyección de dependencia o `mock` de node:test) para devolver `lastRow`
  controlados, evitando red. Casos sobre una `fecha` de test y GEC32:
  1. Celda inexistente + SIS>0 ⇒ INSERT con `creado_por=SISTEMA`, `cantidad=valor_sis`.
  2. Celda SIS-owned + SIS nuevo>0 ⇒ UPDATE de `cantidad` y `valor_sis`.
  3. Celda humano-owned (insertar una con `modificado_por`=usuario test) + SIS>0 ⇒ `cantidad`
     intacta, `valor_sis` actualizado.
  4. Celda SIS-owned + SIS=0 ⇒ DELETE.
  5. Celda humano-owned + SIS=0 ⇒ `cantidad` intacta, `valor_sis=0`.
  6. `sis_scrape_log` queda con el resumen correcto.
- Limpieza en `after()` (borrar filas de la fecha de test + el row de `sis_scrape_log`).
- Agregar al script `test` de `server/package.json`.

## Al terminar
Actualiza `ESTADO.md`: E3 ✅, archivos, resultados, y nota sobre el estado de `discoverEarliestDate`
(pendiente de calibración en E7).
