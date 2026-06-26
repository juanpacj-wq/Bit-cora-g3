# D-029 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** Cada etapa, al terminar, actualiza este archivo:
> qué se hizo, archivos tocados, resultado de tests, desviaciones. Cada etapa, al empezar, lo lee.
> Una etapa solo se ejecuta si las anteriores figuran ✅ aquí.

## Tablero de avance
| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Carpeta de prompts creada: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-029.md`, `ESTADO.md`, `E1..E8`. |
| E1 — Migración F27.A1 | ✅ | `valor_sis`+`sis_actualizado_en` en `consumo_combustible` + tabla `sis_scrape_log`. Migración idempotente aplicada y test verde. |
| E2 — Parser + cliente SIS | ✅ | Port ESM de `parseXls` + `sis-client.js` (buildUrl/fetchPeriod/periodoBounds/extraerCarbonValidado). 8/8 verde; test del parser SKIP (sin fixture `.xls` offline). |
| E3 — carbon-scraper + ownership | ✅ | `carbon-scraper.js` (`scrapeDia` con tabla de ownership + `discoverEarliestDate`). 6/6 ownership verde (BD real, fetch mockeado). `discoverEarliestDate` pendiente de calibración en E7. |
| E4 — Sweeper horario + wiring | ✅ | `sis-sweeper.js` (1h, catchup hoy + ayer-si-incompleto) cableado en `server.js`. Server arranca y sobrevive SIS sin respuesta. 136/137 verde (1 skip parser). |
| E5 — Endpoints + GET | ⬜ | — |
| E6 — UI grilla | ⬜ | — |
| E7 — Backfill (corrida única) | ⬜ | — |
| E8 — Docs + cleanup + commit | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas
- **E1**: `sis_scrape_log` lleva `CONSTRAINT DF_*` con nombre explícito en cada DEFAULT
  (`periodos_ok`/`periodos_error`/`completo`/`scraped_en`) — paridad con el estilo nombrado de
  F26.B1, no DEFAULTs anónimos. Sin impacto funcional.
- **E1 (entorno, no del código)**: el suite HTTP requiere el backend corriendo en `:3002` y la BD
  remota `192.168.17.20:1433` fue intermitente durante la sesión (sweepers loguearon
  `ESOCKET / Could not connect`), lo que en una corrida colgó el primer test 316s y cascadeó todo.
  Reintento con server fresco tras restablecerse la conectividad → **107/107 verde** (incluido el
  baseline flaky T4/C5). El cambio de schema (columnas nullable + tabla nueva) no es la causa.
  Para correr el server localmente: override de `DB_HOST=
  (el `--env-file` del `.env` mete el instance name → timeout vía SQL Browser). Ver memoria
  `db-host-override-local`.

## Datos descubiertos en ejecución (rellenar a medida)
- Fecha de inicio GEC32 (descubierta por sondeo SIS): _por determinar en E7_.
- **Conectividad SIS desde el equipo de ejecución (E4)**: el host `192.168.18.201` **acepta TCP**
  (connect a `:80` OK en <1s), pero el endpoint HTTP `ExportDialog.aspx` **NO responde** desde este
  equipo: `fetchPeriod` se cuelga hasta el `timeoutMs` y aborta con `AbortError`. Es decir, el SIS
  HTTP no es alcanzable funcionalmente desde acá (probablemente requiere estar en la red de planta).
  Confirma que el camino "SIS caído" del sweeper es el que se ejerció en E4. El backfill (E7) deberá
  correrse desde un equipo CON acceso real al SIS HTTP.
- Nombres reales de cargos para gating (JdT/IngOp/Jefe Planta): _confirmar contra `lov_bit.cargo` en E5_.
- **Fixture `.xls` real del SIS**: no disponible offline en E2 (no hay `.xls`/`.xlsx` en el repo ni
  acceso al SIS al ejecutar). El test del parser quedó condicional (`skip` si no existe
  `server/tests/fixtures/sis-period.xls`). Capturar el `arrayBuffer` crudo de una respuesta del SIS
  y depositarlo ahí en E3/E7 para que el test corra; mientras tanto el parser se valida contra el
  SIS real en esas etapas.

## Bitácora por etapa
### E0 — Andamiaje  ✅
- Creados: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-029.md`, `ESTADO.md`, `E1-migracion.md`,
  `E2-parser-cliente.md`, `E3-scraper-core.md`, `E4-sweeper.md`, `E5-endpoints.md`,
  `E6-ui.md`, `E7-backfill.md`, `E8-docs-cleanup.md`.
- Sin código de producto todavía.

### E1 — Migración F27.A1  ✅
- **Archivos tocados:**
  - `server/db.js` — bloque de migración `F27.A1` agregado tras resolver `COMB_BITACORA_ID`
    (~`db.js:1816`, justo después de F26.B1). Idempotente, gated por `migracion_aplicada('F27.A1')`,
    en una sola transacción: (1) `ALTER consumo_combustible ADD valor_sis DECIMAL(12,3) NULL` +
    `sis_actualizado_en DATETIME2 NULL` (con `IF NOT EXISTS` por columna), (2) `CREATE TABLE
    bitacora.sis_scrape_log` (`scrape_log_id` PK, `planta_id` FK, `fecha DATE`, `scrape_tipo`
    CHECK `('horario','backfill','manual')`, `periodos_ok/error TINYINT`, `ultimo_periodo TINYINT NULL`,
    `completo BIT`, `scraped_en DATETIME2 DEFAULT SYSUTCDATETIME()`, UNIQUE `(planta_id,fecha)`),
    (3) `INSERT migracion_aplicada (codigo) VALUES ('F27.A1')` — shape `(codigo)` confirmado contra
    la tabla real (`codigo` PK + `aplicada_en` con default).
  - `server/tests/sis_schema.test.js` — **nuevo**. 5 tests vía `getDB()`: columnas presentes,
    tabla existe, UNIQUE cubre `(planta_id,fecha)`, CHECK `CK_sis_scrape_tipo` existe, flag registrado.
  - `server/package.json` — `sis_schema.test.js` agregado al script `test`.
- **Verificación:**
  - Migración aplicada en BD (query directa: flag presente, 2 columnas + tabla existen).
  - Idempotencia confirmada: 2 arranques posteriores del server NO re-aplican (sin log `[F27.A1]`,
    sin error).
  - `sis_schema.test.js` aislado: **5/5 verde**.
  - Suite completo (9 archivos, server fresco en `:3002`): **107/107 verde, EXITCODE=0** — incluido
    el baseline históricamente flaky T4/C5 (cierre cronológico). Sin regresión.

### E2 — Parser + cliente SIS  ✅
- **Archivos tocados:**
  - `server/utils/sis/xls-parser.js` — **nuevo**. Port ESM 1:1 de `js-scraper-carbon-g32/xls.js`
    (lector OLE2/CFB + BIFF8 sin deps: `readCFBStream`, `parseSST`, `decodeRK`, `parseXls`).
    Único cambio respecto al original: `module.exports` → `export function parseXls`. Mantiene la
    firma `{ maxRow, ncols, lastRow }` (`lastRow` 1-indexado por columna).
  - `server/utils/sis/sis-client.js` — **nuevo**. Constantes `SIS_HOST` (override `process.env.SIS_HOST`),
    `SIS_SERVER='NEWSYNCBASE'`, `TAGS` (12, mismo orden que el scraper). Funciones:
    `buildUrl(f1,h1,f2,h2)` (XML URL-encoded idéntico a `scrape.js`), `periodoBounds(fecha,periodo)`
    (`h1=periodo-1`; `periodo=24` ⇒ `f2`=día siguiente vía aritmética UTC pura, `h2='00'`; valida
    rango 1..24), `fetchPeriod(f1,h1,f2,h2,{signal,timeoutMs})` (fetch→valida `ok`→`parseXls`; arma
    `AbortController` interno si se pasa `timeoutMs` y no hay `signal`), `extraerCarbonValidado(lastRow)`
    (validación de servicio `v659>400 && v651>400 && mpaflow>140`; `tolvasVal[i]=(raw>0.5 && enServicio)
    ? round3(raw) : 0`; devuelve `{enServicio, tolvasVal[8], energiaMw, totalCarbon}`).
  - `server/tests/sis_parser.test.js` — **nuevo**. 9 tests `node:test` de lógica pura (no toca BD/red):
    `buildUrl` (12 tags + server + t1/t2), `periodoBounds` (p1, p24, cruce de mes, fuera de rango),
    `extraerCarbonValidado` (en servicio / fuera de servicio / no-numéricos→0), y el test del parser
    **condicional** (`skip` si falta el fixture).
  - `server/package.json` — `sis_parser.test.js` agregado al script `test`.
- **Verificación:**
  - `node --test tests/sis_parser.test.js` (sin server, sin `--env-file`): **8/8 verde, 1 SKIP**.
  - El SKIP es el test del parser: requiere `server/tests/fixtures/sis-period.xls` (buffer `.xls` crudo
    del SIS), no disponible offline. Pendiente de capturar en E3/E7 (ver sección de datos descubiertos).
- **Desviaciones:** ninguna respecto al prompt. `extraerCarbonValidado` redondea `energiaMw` a 3
  decimales (el scraper standalone solo lo redondeaba al escribir el `.xlsx`); irrelevante para BD.

### E3 — carbon-scraper core + ownership  ✅
- **Archivos tocados:**
  - `server/utils/sis/carbon-scraper.js` — **nuevo**. Núcleo del scraper GEC32:
    - `scrapeDia(pool, { fecha, scrape_tipo='horario', soloHoy=true, fetchFn, log })`:
      determina `nEsperado` (hoy⇒1..horaBogotaActual con `soloHoy`; pasado⇒1..24; futuro⇒throw).
      Resuelve `SISTEMA` (live binding `db.js` o fallback `SELECT … username='SISTEMA'`, robusto
      en proceso de test sin `initDB`) y el mapa `{k: combustible_id}` de `ALIM_1..8` (LIKE
      `'ALIM[_]%'` escapando el `_`). **Fase fetch sin tx** (red): un fetch fallido cuenta
      `periodos_error` y NO aborta el día. **Fase write en UNA transacción** (día + log,
      rollback ante error). Por celda aplica `aplicarCelda` con la tabla de ownership
      (`esSisOwned` ⇔ `creado_por=SISTEMA AND (modificado_por IS NULL OR =SISTEMA)`):
      INSERT / UPDATE cantidad+sombra / UPDATE solo-sombra (humano) / skip / DELETE /
      UPDATE sombra=0. Toda escritura SIS usa `SISTEMA` y `sis_actualizado_en=SYSUTCDATETIME()`;
      el caso humano-owned NUNCA toca `cantidad`/`modificado_por` ("operador gana"). Upsert de
      `sis_scrape_log` por `UNIQUE(planta,fecha)` (IF EXISTS UPDATE ELSE INSERT). Devuelve
      `{ fecha, periodos_ok, periodos_error, creados, actualizados, eliminados, completo }`
      (`completo` ⇔ `error===0 && ultimoOk===nEsperado && nEsperado>0`).
    - `discoverEarliestDate(pool, { hint, periodoProbe=12, techo, maxYearsBack=10, fetchFn, log })`:
      sondeo coarse→fine (retroceso anual hasta año sin datos + binaria por día). "Hay datos" ⇔
      fetch OK y `energiaMw>0 || alguna tolva>0 || enServicio`. **Parametrizable y muy logueado —
      heurística PENDIENTE DE CALIBRACIÓN EN E7** con sondeos reales (no se ejecuta en E3).
  - `server/tests/sis_scraper_ownership.test.js` — **nuevo**. 6 tests `node:test`, BD real +
    `fetchPeriod` mockeado por inyección de dependencia (`fetchFn`, sin red). Cubre las 6 filas de
    la tabla de ownership sobre GEC32/`ALIM_1` + el resumen de `sis_scrape_log`. Mock devuelve la
    lectura objetivo solo en `targetPeriodo` y "fuera de servicio" en el resto (validado 0 ⇒ skip
    en celdas inexistentes). `beforeEach` limpia la fecha; `after` borra filas + el row del log.
  - `server/package.json` — `sis_scraper_ownership.test.js` agregado al script `test`.
- **Verificación:**
  - `DB_HOST=
    (sin server HTTP — el test llama `scrapeDia` directo contra `getDB()`): **6/6 verde**.
  - El test NO requiere el backend en `:3002` (no usa `call()`/HTTP), solo conectividad a la BD
    remota. Resolución de `SISTEMA` vía query confirmada funcionando en proceso de test sin `initDB`.
- **Desviaciones:** ninguna respecto al prompt. Conteo del resumen: `actualizados` cuenta TODO
  UPDATE (incluido el solo-sombra humano-owned y el sombra=0), `creados`=INSERT, `eliminados`=DELETE.
- **Nota discoverEarliestDate:** implementada y parametrizable pero **sin calibrar** — los umbrales
  (`periodoProbe`, `maxYearsBack`, criterio "hay datos") se ajustan en E7 contra el SIS real, donde
  además se captura el fixture `.xls` pendiente de E2.

### E4 — Sweeper horario + wiring  ✅
- **Archivos tocados:**
  - `server/utils/sis/sis-sweeper.js` — **nuevo**. Patrón calcado de `mand-sweeper.js`:
    `INTERVAL_MS=3_600_000` (1h), `let timer`, `tick()` con `try/catch` + reprograma en `finally`,
    `startSisSweeper(pool)` idempotente (`if (timer) return;`) / `stopSisSweeper()`.
    - **tick**: re-scrapea HOY Bogotá vía `scrapeDia(pool, { fecha: hoyBogota(), scrape_tipo: 'horario' })`.
      Todo el tick va en `try/catch` (loguea `err.message`, no relanza) + `finally { timer=setTimeout(tick, INTERVAL_MS) }`,
      así un SIS inalcanzable nunca rompe el proceso ni detiene el ciclo. `scrapeDia` ya tolera fetch
      fallidos por periodo; el tick agrega la segunda capa.
    - **Catchup** al arranque: primer tick a `CATCHUP_MS=10_000` (no compite con el boot). En el primer
      tick además re-scrapea AYER **una vez** *solo si* su `sis_scrape_log` no quedó `completo`
      (helper `ayerIncompleto` → query a `sis_scrape_log`; row ausente o `completo=0/false` ⇒ re-scrape
      con `soloHoy:false` = 24 periodos). Flag de proceso `primerTick` (reset en `stopSisSweeper`).
    - `hoyBogota()` = `fechaBogotaStr(new Date())` (reusa `turno.js`); `ayerBogotaDe()` = aritmética
      UTC pura `-1 día` (idéntico al de `mand-sweeper.js`). `PLANTA_ID='GEC32'` (GEC3 fuera de alcance).
  - `server/server.js` — import `startSisSweeper/stopSisSweeper`; `startSisSweeper(db)` tras
    `startMandSweeper(db)` (~`server.js:2658`); `stopSisSweeper()` en el handler `SIGTERM/SIGINT`.
- **Comportamiento ante SIS caído (observado):** server arrancado localmente (override
  `DB_HOST=
  `[SERVER] Escuchando en puerto 3002`. El catchup dispara a los 10s y arranca a sondear el SIS; como
  el host **acepta TCP pero el HTTP no responde** (ver "Datos descubiertos"), cada `fetchPeriod` se
  cuelga hasta `TIMEOUT_MS=30s` y aborta con `AbortError`, que `scrapeDia` atrapa por periodo. **El
  server quedó vivo y responsivo durante ~4 min de fetches fallidos** (probe HTTP a `:3002` devolvió
  404 = ruta manejada, proceso sano) — confirmada la resiliencia del prompt. Nota operativa: con el SIS
  inalcanzable el catchup de ayer (24 periodos × 30s secuenciales) tarda ~12 min en cerrar; los logs
  per-periodo del proceso en background quedan en el buffer async de stdout de Windows y no se vieron
  en disco, pero el `AbortError` a 30s se verificó con un `fetchPeriod` aislado (abortó a 8013ms con
  `timeoutMs:8000`). Detenido el server con `TaskStop` tras la verificación.
- **Catchup de "ayer":** **incluido** — pero gated por `sis_scrape_log.completo` para no re-trabajar
  días ya cerrados (desviación menor sobre el "Opcional" del prompt: lo hicimos condicional en vez de
  incondicional, evita 24 fetches inútiles si ayer ya está completo).
- **Verificación tests:** suite completo (11 archivos, server fresco en `:3002`, override DB):
  **137 tests · 136 pass · 0 fail · 1 skip · EXITCODE=0** (646s). El skip es el parser sin fixture
  (heredado de E2). Incluye el baseline flaky **T4/C5 verde** este run. Sin regresión por el wiring.
