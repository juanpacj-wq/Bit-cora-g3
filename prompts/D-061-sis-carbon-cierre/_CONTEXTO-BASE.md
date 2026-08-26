# D-061 — Contexto base (compartido por todos los lotes)

> Es el **bloque de contexto** que cada prompt de lote referencia **por sección** (un lote no lo
> relee entero: su prompt dice qué secciones). Es **inmutable** una vez cerrada la fase de
> planificación (2026-08-26): si algo cambia durante la ejecución, se registra en el cierre del
> lote y el gate lo propaga como "hecho que cambia" en `GATE-On.md`, no acá.
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Node ESM + Express + MSSQL; backend `:3002`).
> Rama del flujo: `feat/sis-carbon-cierre-2026-08`, nacida de `feat/integrar-asientos-D-059`
> (rama de integración vigente; prod sigue en `8e08e03` sin desplegar, ver
> `../docs/deployment-unificado.md` §"Estado de ramas").

## 1. Objetivo
Cerrar la ingesta horaria de **carbón de GEC32 desde el SIS** que dejó a medias el flujo v1
`prompts/D-029-sis-carbon-gec32/` (E1–E4 hechas; E5 endpoints, E6 UI y E7 backfill pendientes):
(a) exponer `valor_sis`/override en el GET de COMB, **revertir** al valor SIS y **vaciar = override
a 0**; (b) scrape manual **asíncrono** con mutex frente al sweeper; (c) UI de override en la grilla
COMB (badge, tooltip, Revertir, auto-refresco con gavela de 10 min, chip SIS); (d) **backfill
histórico completo** de GEC32 (fecha de inicio descubierta por sondeo, CLI paralelo, dev y luego
prod); (e) higiene D-055 en COMB (planta `'TST'` con catálogo, tests fuera de plantas reales);
(f) docs permanentes y retiro del scaffolding v1 + scraper standalone.
**GEC3 queda fuera** (no tiene SIS). **No toca contratos cross-repo** (`evento_dashboard`,
`disponibilidad_dashboard` y `GET /api/eventos-dashboard` intactos). El ADR D-061 documenta la
ingesta SIS **completa** (D-029 fue consumido por otro ADR y la ingesta nunca tuvo el suyo).

## 2. Fuentes / insumos
- `prompts/D-029-sis-carbon-gec32/_CONTEXTO-BASE.md` y `PREGUNTAS-D-029.md` (diseño v1,
  vigente salvo lo precisado en `PREGUNTAS-D-061.md`) y su `ESTADO.md` (qué se hizo en E1–E4).
- ADR **D-060** (`docs/decisions.md`): semántica `completo ⇔ 24/24`, repesca de "ayer" en cada
  tick, `periodoDesde`, CLI de backfill reducido. **D-027/D-034** (COMB, `cantidad_max`),
  **D-048** (crean en COMB JdT + IngOp), **D-055** (ningún test escribe en planta real; guard).
- BIT-MODBD **§4.9** (`consumo_combustible`, `v_consumo_periodo`) y **§4.9.1** (ingesta SIS,
  `valor_sis`, `sis_scrape_log`, ownership). BIT-RF §4.9 (COMB).
- SIS interno `http://192.168.18.201` (`ExportDialog.aspx`, sin auth; allowlist interno en
  `validarSisHost`, `sis-client.js:20-36`). Medido 2026-08-26: ~13 s y ~830 KB por periodo
  (3.601 filas/hora); datos reales al menos desde 2020-08; 2016-08 en cero.
- Scraper standalone de referencia `js-scraper-carbon-g32/` (`scrape.js`, `xls.js`; produce un
  `.xlsx` por día) — sirve para el **spot-check** de L05 y se retira en L07.

## 3. Lo que ya existe (BD, endpoints, front)
Números de línea del snapshot 2026-08-26 (`60c285e`); confirmarlos con Grep antes de editar.

### 3.1 BD (`server/db.js`)
- `lov_bit.combustible` (F26.B1, `db.js:2005-2060`): `combustible_id, planta_id, codigo, nombre,
  unidad, tipo ('ALIMENTADOR'|'CALIZA'|'ACPM'), orden, activo, cantidad_max` (F28.A1). GEC32:
  `ALIM_1..ALIM_8` (Ton, 25), `CALIZA` (Ton, 40), `ACPM` (Gal, 25000). UQ `(planta_id, codigo)`.
- `bitacora.consumo_combustible` (`db.js:2062-2090`): `consumo_id, planta_id, fecha DATE, periodo
  TINYINT 1..24, combustible_id, cantidad DECIMAL(12,3)>=0, detalle, creado_por (FK, NOT NULL),
  creado_en, modificado_por (FK, NULL), modificado_en, valor_sis DECIMAL(12,3) NULL,
  sis_actualizado_en DATETIME2 NULL` (F27.A1). UQ `(planta_id, fecha, periodo, combustible_id)`.
- `bitacora.sis_scrape_log` (F27.A1; BIT-MODBD §4.9.1): `planta_id, fecha, scrape_tipo
  ('horario'|'backfill'|'manual'), periodos_ok, periodos_error, ultimo_periodo, completo,
  scraped_en`, UQ `(planta_id, fecha)`. `completo=1 ⇔ periodos_error=0 AND ultimo_periodo=24`.
- `TEST_PLANTA_ID = 'TST'` (`db.js:59`), fila residente en `lov_bit.planta`; hoy **sin** catálogo
  de combustibles. `USUARIO_SISTEMA_ID` live binding (`db.js:49`; en ambas BD = 94).
- `SKIP_INITDB=1` (`db.js:361-366`): abre el pool sin DDL/seeds/migraciones (backends efímeros
  de lotes que no son dueños de `db.js`).
- Migraciones aplicadas: dev hasta `F34.A1`; prod hasta `F31.A1`. **Este flujo no crea
  migraciones** (§7).

### 3.2 Backend SIS (`server/utils/sis/`)
- `sis-client.js`: `SIS_HOST` (env `SIS_HOST`, validado), `TAGS` (12), `buildUrl(f1,h1,f2,h2)`
  (`t1/t2` con horas enteras, `:60-88`), `periodoBounds(fecha, periodo)` (`:90-104`),
  `fetchPeriod(f1,h1,f2,h2,{signal,timeoutMs})` (`:111-140`, `redirect:'error'`, tope de bytes,
  parseo en worker vía `parse-isolated.js`), `extraerCarbonValidado(lastRow)` (`:144+`).
- `carbon-scraper.js`: `leerScrapeLog(pool, fecha)` (`:33`, planta fija `'GEC32'`),
  `logContiguoHasta(row, periodoDesde)` (`:45`), `scrapeDia(pool, { fecha, scrape_tipo='horario',
  soloHoy=true, periodoDesde=1, ahora, fetchFn, log })` (`:216-321`; `PLANTA_ID='GEC32'` const en
  `:17`; fase fetch **secuencial** `:257-270`; fase write en una `sql.Transaction`; devuelve
  `{ fecha, periodos_ok, periodos_error, ultimo_periodo, desde, creados, actualizados, eliminados,
  completo }`), `discoverEarliestDate(pool, { hint, periodoProbe=12, techo, maxYearsBack=10,
  fetchFn, log })` (`:329-392`, **sin calibrar**: un solo sondeo por candidato → una parada de la
  unidad se lee como "sin datos").
- `sis-sweeper.js` (`:39-72`): tick a HH:02 Bogotá; catchup de AYER si `necesitaCatchup` y luego
  HOY; `startSisSweeper(pool)`/`stopSisSweeper()`. Helpers puros en `sis-sweeper-helpers.js`
  (`necesitaCatchup`, `periodoDesdeDe`, `msHastaProximaMarca`), fijados por `sis_sweeper.test.js`.
- `server/scripts/backfill-carbon-gec32.js` (128 líneas, D-060): flags `--confirm-db` (= `DB_NAME`),
  `--from`, `--to` (default hoy-2, nunca ≥ hoy), `--dry-run`, `--full`, `--solo-parciales`,
  `--throttle-ms`; **secuencial**; sin `--from` arranca en `MIN(fecha)` de `sis_scrape_log`.
- Wiring: `server.js:14,32` (`startSisSweeper(db)` tras `initDB`).

### 3.3 Endpoints COMB (`server/routes/combustibles.js`, montado en `auth/app.js:317`)
- `GET /catalogo?planta_id=` (`:18-37`), `GET /consumos?planta_id=&fecha=` (`:41-106`; SELECT
  `:66-80` **sin** `valor_sis`; pivot `:83-98` → `celdas[periodo][combustible_id] = { consumo_id,
  cantidad, detalle, creado_por:{usuario_id,nombre_completo}, creado_en, modificado_por|null,
  modificado_en }`), `POST /consumos` (`:112-250`; validación `:147-172` con `cantidad_max`;
  batch en tx `:175-249`: vacío ⇒ DELETE `:193-201`, nuevo ⇒ INSERT, existente ⇒ UPDATE con
  `modificado_por` solo si `cantidad` cambió `:219-241`).
- Planta hardcodeada `['GEC3','GEC32']` en `:24`, `:48`, `:119` (raíz del pendiente D-055).
- Gating: `hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'|'puede_crear')`.
  Crean en COMB: JdT, IngOp, ADMIN (D-048/D-039); observador solo lee (D-059).
- Errores: `sendJSON(res, 4xx, { error, codigo?, mensaje? })`; el front ramifica por `codigo`
  (D-032) y por `errores[]` (`useApi.js:49-51`).

### 3.4 Front COMB
- `src/hooks/useCombustibles.js` (40 líneas): `getCatalogo`, `getConsumos(planta_id, fecha)`,
  `guardarBatch({planta_id, fecha, celdas})`; `api` de `useApi.js` (errores con `codigo`,
  `errores`, `body`).
- `src/components/Combustibles/ConsumosGrid.jsx` (354 líneas): props `{ bitacora, plantaId,
  puedeCrear, showToast, fecha, onFechaChange }`; estado `catalogo/snapshot/buffer/error`;
  `refetch` (`:56-69`), `hayCambios` (`:71-74`), `setCelda` (`:84-101`, **0 ⇒ borra del buffer**),
  `calcularDiff` (`:121-141`), `onGuardar` (`:143-163`), columnas `:168-178`, `maxPorId`,
  heatmap `tint()`; render de celda `:296-340` (`<input type=number>`; `v = cantidad ?? ''`).
  Topbar `:223-261` (título + `SelectorFecha` + leyenda + Guardar/"Solo lectura").
- `combustibles.css` (179 líneas, piel D-033 bajo `.comb-root`), `colores.js`, `SelectorFecha.jsx`.
- Cableado en `src/BitacorasGecelca3.jsx:23` (import) — **no se toca** en este flujo (COMB ya
  recibe `fecha`/`onFechaChange` controlados, D-035).
- `src/utils/fecha.js`: `getTodayBogota()`, `horaBogotaHHMM(fecha)`. Formato de fecha/hora Bogotá
  para tooltips: `Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', … })`.
- Vitest: `src/**/*.test.{js,jsx}` (`npm test` en la raíz; 98 casos hoy).

### 3.5 Tests backend relevantes (`server/tests/`)
- `helpers.js`: `PLANTA_ID='GEC3'` (default de `setupSessions()`), `TEST_PLANTA='TST'`,
  `TEST_PLANTA_REFLEJO='TSR'`, `TEST_TAG`, `setupSessions({ planta })` (`:192`; crea JdT, IngOp,
  Gerente, IngQuim sintéticos + sesiones), `call(method, path, { body, sesion_id })` (`:151`;
  `TEST_BASE_URL`), `cleanupTestRegistros()` (`:283`), `deactivateSyntheticSessions()` (`:128`).
- `consumos_combustible.test.js` (16 tests, **planta GEC3 real**, `TEST_FECHA='2026-04-15'`,
  `setupOperadorCarbon()` local `:22-72`, `cleanConsumos` `:74-80`), `rol_coordinador_carbon_maquinaria.test.js`
  (POST COMB a GEC3, `:142-144`; DELETE `:90`), `sis_scraper_ownership.test.js` (BD real,
  `PLANTA='GEC32'`, `FECHA='2026-04-16'`, `fetchFn` mock `:33-41`, `insertCelda` `:52+`, 10 tests),
  `sis_sweeper.test.js` (11, puros), `sis_parser.test.js` (9; el del parser en **SKIP** sin
  fixture), `sis_parser_hardening.test.js`, `sis_schema.test.js` (5, solo lectura).
- `guard_no_prod_historico_destruction.test.js` (D-055): `TABLAS_PROTEGIDAS` `:37-42`
  (`registro_historico`, `registro_activo`, `evento_dashboard`, `mand_cierre_log`), `ACOTADORES`
  `:52+`; `stripComments` parte por `/\r?\n/` (gotcha conv. 28).
- `residuos.js` (`npm run test:residuos`): 8 checks (registro_*, sesiones sintéticas,
  conformación, disponibilidad, evento_dashboard) — **no** cuenta `consumo_combustible`.
- Script `test` de `server/package.json`: lista literal; `zzz_session_leak_guard` último. Lo
  escribe **solo el gate**.

## 4. Patrones de infraestructura a reutilizar
- **Transacción**: `const tx = new sql.Transaction(db); await tx.begin(); try { … new sql.Request(tx) …; await tx.commit(); } catch (e) { try { await tx.rollback(); } catch {} throw e; }`.
- **Usuario SISTEMA**: `dbBindings.USUARIO_SISTEMA_ID` (live binding); fallback por query
  (`resolverSistemaId`, `carbon-scraper.js:54-63`) en procesos sin `initDB`.
- **Sweepers**: `let timer; tick() try/catch + finally reprograma; start*(pool) idempotente / stop*()`.
- **TZ**: `fechaBogotaStr(date)` (`utils/turno.js`), aritmética UTC pura para ±días
  (`addDays` en el CLI/`discover`); nunca `getHours()` sin shift.
- **Errores HTTP**: `sendJSON(res, code, { error, codigo, mensaje })`; 5xx por `expressErrorHandler`
  (`throw` dentro de `asyncH`). Nunca `err.message` crudo (D-032).
- **Tests con BD y sin HTTP** (patrón `sis_scraper_ownership`): `getDB()` directo + `fetchFn`
  inyectado; limpieza en `after()`; **bajo test-lock**.
- **Tests HTTP**: backend efímero `SERVER_PORT=31NN AUTH_TEST_BYPASS=1 [SKIP_INITDB=1] node --env-file=../.env server.js` + `TEST_BASE_URL=http://localhost:31NN`. Si la conexión a la BD
  cuelga al arrancar, anteponer `DB_HOST=192.168.17.20 DB_PORT=1433` (evita el instance name).
- **Front**: módulos puros en `src/components/<X>/<y>.js` con vitest al lado (patrón
  `SalaDeMando/libro-mensual-descarga.test.jsx`, `Disponibilidad/anios.test.js`).

## 5. Diseño acordado
> Volcado de `PREGUNTAS-D-061.md` en forma técnica accionable.

### 5.1 Schema / cambios de BD
- **Sin DDL ni migración `F-NN`.**
- **Seed idempotente** (L02, `db.js`, fuera del gate `F26.B1`, se ejecuta en cada `initDB`):
  `MERGE lov_bit.combustible` por `(planta_id, codigo)` para `TEST_PLANTA_ID` con las 10 filas
  espejo de GEC32 (§2 de PREGUNTAS "Detalles operativos"). Requiere la fila `'TST'` en
  `lov_bit.planta` (ya sembrada por D-030; el seed va **después** de ese bloque).

### 5.2 Lógica núcleo
- **Ownership** (intacta): SIS-owned ⇔ `creado_por=SISTEMA AND (modificado_por IS NULL OR =SISTEMA)`.
- **`es_override`** (backend): `NOT sis_owned AND valor_sis IS NOT NULL AND cantidad <> valor_sis`.
- **Vaciar** (POST batch): si la fila existente tiene `valor_sis IS NOT NULL` → `UPDATE cantidad=0,
  modificado_por=@u, modificado_en=SYSUTCDATETIME()` (solo si `cantidad<>0`; `detalle` como hoy);
  si `valor_sis IS NULL` → DELETE (D-027). Aplica a cualquier planta (solo GEC32 tiene `valor_sis`).
- **Revertir**: tabla de decisión en §6 C5.
- **Mutex `sis-lock`**: de proceso, sin cola: el que llega con el lock ocupado **no espera**
  (`sis_ocupado`). Lo usan el tick del sweeper (omite el tick) y el job manual (409). El CLI es
  otro proceso: su exclusión con el sweeper es `--to ≤ hoy-2` (D-060).
- **Concurrencia en `scrapeDia`**: solo la fase fetch (`:257-270`) pasa a un pool de tamaño N
  (orden de escritura por `periodo` ascendente; `ultimo_periodo` = mayor periodo OK; el resto
  idéntico). N=1 ⇒ comportamiento actual byte a byte.
- **`discover` v2**: un candidato "sin datos" solo cuando **K sondeos** (default 6) repartidos en
  una ventana de **W días** hacia adelante (default 60) devuelven todos vacíos (fetch OK con
  `energiaMw=0 && tolvas=0 && !enServicio`, o fetch fallido). Coarse anual → fino mensual →
  diario; devuelve el primer día con datos. Parametrizable y logueado.
- **Job manual**: uno a la vez, en memoria (se pierde con el restart; `sis_scrape_log` es la
  verdad persistente), día a día con `scrape_tipo:'manual'`, `soloHoy` solo si `fecha===hoy`.
- **Gavela** (front): estado `{ inicio }` que arranca con el primer `hayCambios` en modo
  auto-refresco y se limpia al guardar/descartar; `restante = 600000 - (ahora - inicio)`; al
  llegar a 0: `setBuffer(deepClone(snapshot))`, `refetch()`, toast.

### 5.3 Módulos nuevos
| Ruta | Responsable | Responsabilidad |
|---|---|---|
| `server/utils/sis/sis-lock.js` | L01 | Mutex de proceso (§6 C2). |
| `server/utils/sis/discover.js` | L01 (mueve) → L05 (v2) | `discoverEarliestDate` fuera de `carbon-scraper.js`. |
| `server/utils/sis/sis-job.js` | L04 | Job de scrape manual asíncrono (§6 C9). |
| `server/tests/sis_lock.test.js`, `sis_concurrencia.test.js` | L01 | |
| `server/tests/sis_endpoints.test.js` | L02 | GET extendido, vaciar, revertir, catálogo TST. |
| `server/tests/sis_scrape_endpoint.test.js` | L04 | 202/409/estado/job con SIS stub local. |
| `server/tests/sis_discover.test.js` | L05 | Historiador simulado. |
| `server/tests/fixtures/sis-period.xls` | L05 | Fixture real ≤100 KB. |
| `src/components/Combustibles/override.js` + `override.test.js` | L03 | Helpers puros de UI (§6 C11). |

### 5.4 Endpoints nuevos / cambios
Ver §6 C4 (GET extendido), C5 (revertir), C6 (vaciar), C7/C8 (scrape manual + estado). Todos en
`routes/combustibles.js` bajo `loadAppSession` + `hasPermisoBitacora`.

### 5.5 Front
`ConsumosGrid.jsx`: badge ámbar (`.comb-override`) en celdas ALIM GEC32 con `es_override`; tooltip
(hover/click, `.comb-tip`) con `textoOverride` + botón Revertir (solo `puedeCrear`); auto-refresco
(5 min + focus) solo GEC32+hoy y pausado con `hayCambios`; gavela 10 min con cuenta regresiva en
la topbar (`.comb-gavela`) + botón **Descartar**; chip SIS (`.comb-sis-chip`) desde `r.sis`.
Celdas con `cantidad=0` se muestran como `0`. Sin botón de scrape manual. Sin cambios en
`BitacorasGecelca3.jsx`.

## 6. Contratos entre lotes (fijos durante la ola)
> Precisión de `.d.ts`. Cambiarlos = bloqueo (`lotes.mjs block`) que decide el gate.

| # | Contrato | Productor | Consumidores | Definición |
|---|---|---|---|---|
| C1 | `scrapeDia(pool, opts)` | L01 (O1) | L04, L05, L06, sweeper | `opts` gana `planta_id: string = 'GEC32'` y `concurrencia: number = 1` (entero 1..6; fuera de rango → `Error`). Resuelve el mapa `ALIM_1..8` de **esa** planta (sin catálogo → `Error('scrapeDia: planta sin catálogo ALIM_1..8: <p>')` **antes** de cualquier fetch); `sis_scrape_log` y celdas se escriben con `planta_id`. Devuelve **el mismo shape** de hoy: `{ fecha, periodos_ok, periodos_error, ultimo_periodo, desde, creados, actualizados, eliminados, completo }`. `leerScrapeLog(pool, fecha, planta_id = 'GEC32')` gana el tercer parámetro opcional. Con `concurrencia>1` el orden de escritura es por `periodo` asc y `ultimo_periodo` = mayor periodo OK. |
| C2 | `server/utils/sis/sis-lock.js` | L01 | L04, sweeper | `export function estadoSisLock(): { ocupado: boolean, motivo: string\|null, desde: string\|null /* ISO UTC */ }` · `export async function withSisLock(motivo: string, fn: () => Promise<T>): Promise<T>` — si `ocupado` lanza **sin esperar** `Error` con `.codigo = 'sis_ocupado'` y `.motivo` = motivo del dueño; libera en `finally` aunque `fn` lance · `export function _resetSisLockParaTests()`. Sin dependencias de BD. |
| C3 | `server/utils/sis/discover.js` | L01 (mueve tal cual) → L05 (v2) | L05 CLI | `export async function discoverEarliestDate(pool, opts): Promise<'YYYY-MM-DD' \| null>`. `carbon-scraper.js` deja de definirla y la **re-exporta** (`export { discoverEarliestDate } from './discover.js'`) para no romper imports. v2 (L05) conserva nombre y firma y agrega `sondeosPorVentana = 6`, `ventanaDias = 60`, `fetchFn`, `log`. |
| C4 | `GET /api/combustibles/consumos?planta_id=&fecha=` | L02 | L03 | Cada celda gana `valor_sis: number\|null`, `sis_actualizado_en: string(ISO)\|null`, `sis_owned: boolean`, `es_override: boolean` (= `!sis_owned && valor_sis !== null && cantidad !== valor_sis`). Respuesta gana `sis: null \| { scrape_tipo, periodos_ok, periodos_error, ultimo_periodo: number\|null, completo: boolean, scraped_en: string(ISO) }` (fila de `sis_scrape_log` para `(planta_id, fecha)`; `null` si no hay). Todo lo demás igual. `planta_id` ∈ {`GEC3`,`GEC32`,`TEST_PLANTA_ID`}. |
| C5 | `POST /api/combustibles/consumos/revertir` | L02 | L03 | Gate `puede_crear` (403 `{ error }`). Body `{ planta_id, fecha: 'YYYY-MM-DD', periodo: 1..24, combustible_id: number }`. 400 `codigo`: `planta_invalida`, `fecha_invalida`, `periodo_fuera_rango`, `combustible_no_pertenece_planta`, `sin_valor_sis` (fila con `valor_sis IS NULL`). 404 `codigo: 'celda_no_existe'`. 200 `{ accion: 'restaurado'\|'eliminado'\|'sin_cambios', celda: <shape de celda del GET>\|null }`: `valor_sis>0` → `UPDATE cantidad=valor_sis, creado_por=SISTEMA, modificado_por=NULL, modificado_en=NULL, sis_actualizado_en=SYSUTCDATETIME()` → `restaurado`; `valor_sis=0` → DELETE → `eliminado` (`celda:null`); ya SIS-owned con `cantidad=valor_sis` → `sin_cambios`. |
| C6 | `POST /api/combustibles/consumos` (cambio de semántica) | L02 | L03 | Celda del body con `cantidad` null/0/undefined y fila existente con `valor_sis IS NOT NULL` → `UPDATE cantidad=0, modificado_por=@u, modificado_en=SYSUTCDATETIME()` (solo si `cantidad<>0`), cuenta en `actualizados`; con `valor_sis IS NULL` → DELETE (cuenta en `eliminados`). Resto igual (validaciones D-034, `modificado_por` solo si cambió `cantidad`). |
| C7 | `POST /api/combustibles/sis/scrape` | L04 | (sin consumidor front) | Gate `puede_crear`. Body `{ planta_id?: 'GEC32' (default) \| TEST_PLANTA_ID, fecha }` **o** `{ planta_id?, from, to }`. 400 `codigo`: `planta_sin_sis` (cualquier otra planta), `fecha_invalida`, `fecha_futura`, `rango_invalido` (`from>to`), `rango_excede_max` (>31 días). **202** `{ job: JobEstado }`. **409** `{ codigo: 'scrape_en_curso', job: JobEstado\|null, lock }` si hay job vivo **o** `estadoSisLock().ocupado`. |
| C8 | `GET /api/combustibles/sis/estado` | L04 | — | Gate `puede_ver`. 200 `{ job: JobEstado\|null, lock: estadoSisLock() }`. `JobEstado = { id: string, estado: 'en_curso'\|'terminado'\|'error', planta_id, from, to, dias_total, dias_hechos, dia_actual: string\|null, iniciado_en: ISO, terminado_en: ISO\|null, iniciado_por: { usuario_id, nombre_completo }, resultados: Array<{ fecha, periodos_ok, periodos_error, completo, creados, actualizados, eliminados, error?: string }>, error: string\|null }`. |
| C9 | `server/utils/sis/sis-job.js` | L04 | `combustibles.js` (L04) | `export function iniciarScrapeJob({ pool, planta_id, from, to, usuario: {usuario_id, nombre_completo}, scrapeFn = scrapeDia, ahora = () => new Date() }): JobEstado` — lanza `Error` `.codigo='scrape_en_curso'` si hay job `en_curso` o `estadoSisLock().ocupado`; arranca el trabajo **sin await** dentro de `withSisLock('scrape manual <from>..<to>', …)`; un día que lanza se registra en `resultados[].error` y el job sigue; al terminar `estado='terminado'` (o `'error'` si el lock/BD falla antes del primer día). `export function estadoScrapeJob(): JobEstado\|null` · `export function _resetScrapeJobParaTests()`. |
| C10 | CLI `server/scripts/backfill-carbon-gec32.js` | L05 | integrador (corrida prod) | Flags nuevos: `--concurrencia <1..6>` (default 1 → `scrapeDia({ concurrencia })`), `--from auto` (corre `discoverEarliestDate`, imprime `fecha de inicio = …` y **sale con código 3** salvo que venga `--confirm-from YYYY-MM-DD` idéntico), `--log <ruta>` opcional (además de stdout). Flags existentes intactos. Salida final `[backfill] FIN …` igual + `conteo por año` (`SELECT YEAR(fecha), COUNT(*)` de ALIM). |
| C11 | `src/components/Combustibles/override.js` | L03 | `ConsumosGrid.jsx` (L03) | `esOverride(celda) → boolean` (usa `celda.es_override === true`) · `textoOverride(celda, ahora?) → string` ("Editado por {modificado_por?.nombre_completo ?? creado_por?.nombre_completo} el {fecha Bogotá dd/MM/yyyy HH:mm de modificado_en ?? creado_en}. Valor SIS: {valor_sis} Ton") · `politicaRefresco({ plantaId, fecha, hoy, hayCambios }) → { autoRefresco: boolean, gavela: boolean }` (`autoRefresco = plantaId==='GEC32' && fecha===hoy && !hayCambios`; `gavela = plantaId==='GEC32' && fecha===hoy && hayCambios`) · `GAVELA_MS = 600000` · `restanteGavela(inicioMs, ahoraMs) → number ≥ 0` · `formatoMMSS(ms) → 'm:ss'` · `textoChipSis(sis) → string` (`null` → `'SIS · sin lectura'`; `completo` → `'SIS 24/24 ✓'`; si no `'SIS {ok}/24 · {HH:mm Bogotá de scraped_en}'`). |
| C12 | Seed catálogo `'TST'` | L02 (`db.js`) | L04, L06 | 10 filas en `lov_bit.combustible` con `planta_id = TEST_PLANTA_ID`: `ALIM_1..ALIM_8` (`tipo='ALIMENTADOR'`, `unidad='Ton'`, `cantidad_max=25`, `orden` 1..8, nombres `Alimentador 1..8`), `CALIZA` (`'CALIZA'`, `Ton`, 40, 9), `ACPM` (`'ACPM'`, `Gal`, 25000, 10); `activo=1`. |
| C13 | `helpers.js` (O2) | L06 | tests | `cleanupTestRegistros()` además borra `bitacora.consumo_combustible` y `bitacora.sis_scrape_log` donde `planta_id IN (TEST_PLANTA, TEST_PLANTA_REFLEJO)`. Nombres/firmas existentes intactos. |

## 7. Reservas (consumidas al planificar)
| Qué | Valor reservado | Verificado en |
|---|---|---|
| ADR | `D-061` (stub committeado en `docs/decisions.md`) | último ADR D-060 en todas las ramas |
| Migraciones | **ninguna** (el catálogo `'TST'` es un seed idempotente) | `git grep F[0-9][0-9]\.` en todas las ramas: último `F34.A1` (`F35.A1` solo aparece como ejemplo en `server/migrations/README.md`) |
| Convención `CLAUDE.md` | **35** | última numerada: 34 (`feat/integrar-asientos-D-059`), 32 (`archivo/stash-0`), 31 (`main`) |
| `BIT-MODBD` / `BIT-RF` | **2.5** / **1.9** | changelogs: 2.4 (2026-08-25) / 1.8 (2026-07-22) |
| Archivos de test nuevos | `server/tests/sis_lock.test.js`, `sis_concurrencia.test.js`, `sis_endpoints.test.js`, `sis_scrape_endpoint.test.js`, `sis_discover.test.js`, `server/tests/fixtures/sis-period.xls`, `src/components/Combustibles/override.test.js` | no existen |
| Módulos nuevos | `server/utils/sis/sis-lock.js`, `discover.js`, `sis-job.js`, `src/components/Combustibles/override.js` | no existen |
| Puertos de test | L01 → 3101 · L02 → 3102 · L03 → 3103 · L04 → 3104 · L05 → 3105 · L06 → 3106 · L07 → 3107 · gate → 3199 | libres |
| RF nuevo | **RF-071** (ingesta SIS: ownership, override/revertir, scrape manual, backfill) | último RF-070 |
| Códigos de error nuevos | `sin_valor_sis`, `celda_no_existe`, `planta_invalida`, `planta_sin_sis`, `scrape_en_curso`, `sis_ocupado`, `rango_invalido`, `rango_excede_max` | no existen en `server/` |

## 8. Archivos compartidos y su escritor en cada ola
| Archivo | O1 | O2 | O3 | Cierre |
|---|---|---|---|---|
| `server/db.js` | **L02** | — | — | — |
| `server/routes/combustibles.js` | **L02** | **L04** | — | — |
| `server/utils/sis/carbon-scraper.js` | **L01** | — | — | — |
| `server/utils/sis/discover.js` | **L01** (crea, mueve) | **L05** | — | — |
| `server/package.json` (script `test`) | gate | gate | gate | gate |
| `server/tests/helpers.js` | — | **L06** | — | — |
| `src/BitacorasGecelca3.jsx` | — (no se toca) | — | — | — |
| `BIT-MODBD`, `BIT-RF`, `docs/architecture.md`, `docs/domain-glossary.md`, `deploy/DEPLOY.md` | — | — | **L07** | integrador (ajustes) |
| `docs/decisions.md`, `CLAUDE.md` | — | — | — | integrador |
| `ESTADO.md`, `PLAN-OLAS.md`, `GATE-On.md`, `LOTES.json` (vía `lotes.mjs`) | integrador | integrador | integrador | integrador |
| `.env` | — | — | — | — (sin cambios; `SIS_HOST` opcional ya existe) |

## 9. Convenciones a respetar
- TZ canónica: BD en UTC (`SYSUTCDATETIME()`), presentación Bogotá explícita; `fechaBogotaStr`
  y aritmética UTC pura para días. Nunca `getHours()`/`toLocaleString()` para persistir.
- Sin DDL en este flujo. El seed `'TST'` es idempotente y corre en cada arranque.
- No romper el server si el SIS no responde (try/catch + log); el sweeper reprograma siempre.
- **Nunca** una allowlist de cargos en un endpoint (D-054/D-059): gate por matriz
  (`hasPermisoBitacora`). **Nunca** `err.message` crudo (D-032). Códigos `codigo` estables.
- Ningún test escribe en GEC3/GEC32 salvo con fechas fijas < 2026-06-02 mientras L06 no migre
  (D-055); todo DELETE/UPDATE de test lleva acotador léxico (`TEST_PLANTA`/`TEST_TAG`/PK).
- MAND, DISP, `evento_dashboard`, dashboard cross-repo y `BitacorasGecelca3.jsx`: **fuera**.
- Commits `tipo(D-061 LNN): …` con `git commit -- <rutas>`; sin firmas de IA; sin push.
- Idioma de todo artefacto, comentario, toast y log visible: tuteo colombiano estándar, sin voseo.
