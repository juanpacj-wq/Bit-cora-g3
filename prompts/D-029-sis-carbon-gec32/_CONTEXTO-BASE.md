# D-029 — Contexto base (compartido por todas las etapas)

> Este archivo es el **bloque de contexto acumulado** que cada prompt de etapa referencia.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md` (estado vivo de avance).
> Repo: `Bit-cora-g3/` (git independiente, React 19 + Node ESM + MSSQL, backend puerto 3002).

## Objetivo
Integrar al backend de Bitácora la extracción horaria de **consumo de carbón de GEC32** desde el
**SIS interno** (`http://192.168.18.201`, sin auth), persistirla en `bitacora.consumo_combustible`
y reflejarla en la grilla COMB (`ConsumosGrid.jsx`), más una **corrida histórica única (backfill)**.
**GEC3 queda fuera de alcance.** No toca contratos cross-repo (nada de `evento_dashboard`/dashboard).

## El scraper standalone (fuente a portar) — `js-scraper-carbon-g32/` (untracked, CommonJS)
- `scrape.js` — por cada periodo horario consulta el SIS vía `GET .../ExportDialog.aspx?params=<XML URL-encoded>`
  con `t1`/`t2` = inicio/fin del periodo, server `NEWSYNCBASE`, y 12 tags:
  - 8 tolvas: `DCS_20HFY10FU013 .. DCS_20HFY80FU013` → columnas `lastRow[1..8]`.
  - `DCS_20CFE01CE21` (energía MW, `lastRow[9]`), `DCS_20HBK10CT659_AVG` (`[10]`),
    `DCS_20HBK10CT651_AVG` (`[11]`), `DCS_MPAFLOW` (`[12]`).
  - Respuesta = archivo `.xls` (OLE2/BIFF8) parseado por `xls.js` → `{ maxRow, ncols, lastRow }`.
- **Validación de servicio** (clave): `enServicio = v659>400 && v651>400 && mpaflow>140`.
  `tolvaVal = (raw>0.5 && enServicio) ? raw : 0`. **Guardamos el VALIDADO** (0 si fuera de servicio).
- TZ: `America/Bogota` (UTC-5, sin DST). Periodo `p` ∈ 1..24, `p=1` = 00:00–01:00.
  Para `p=24`, `t2` cruza al día siguiente.
- `xls.js` y `xlsx-write.js` son parsers/escritores **sin dependencias**. Solo necesitamos el
  **lector** (`parseXls`); el escritor `.xlsx` no se porta (escribimos a BD).
- El scraper es **CommonJS**; el backend es **ESM** (`server/package.json` `"type":"module"`).
  Se **porta** `parseXls` a ESM; **no** se importa el folder viejo (se borra en E8).

## Destino en BD (ya existe — D-027 / F26.B1 en `server/db.js`)
- `lov_bit.combustible` (`db.js:1647`): catálogo por planta. GEC32 tiene 10 filas (`db.js:1678-1687`):
  `ALIM_1..ALIM_8` (tipo `ALIMENTADOR`, unidad `Ton`, orden 1..8), `CALIZA` (9), `ACPM` (10).
  **Las 8 tolvas mapean 1:1 a `ALIM_1..ALIM_8`** (tolva `k` → `ALIM_k`, k=1..8).
- `bitacora.consumo_combustible` (`db.js:1697`): long-format, 1 fila por celda.
  Columnas: `consumo_id PK`, `planta_id`, `fecha DATE`, `periodo TINYINT(1..24)`, `combustible_id`,
  `cantidad DECIMAL(12,3) >=0`, `detalle`, `creado_por` (FK usuario, NOT NULL),
  `creado_en`, `modificado_por` (FK usuario, NULL), `modificado_en`, columnas calc `*_bogota`.
  UNIQUE `(planta_id, fecha, periodo, combustible_id)`.
- Vista `bitacora.v_consumo_periodo` (`db.js:1731`): `total_carbon_ton = SUM(cantidad WHERE tipo='ALIMENTADOR')`.
- Migraciones idempotentes gated por `bitacora.migracion_aplicada(codigo)` (patrón F26.B1, `db.js:1637`).

## Endpoints existentes (`server/server.js`)
- `GET /api/combustibles/catalogo?planta_id=` (`server.js:2413`).
- `GET /api/combustibles/consumos?planta_id=&fecha=` (`server.js:2437`): devuelve `{ planta_id, fecha,
  catalogo, celdas }` donde `celdas["<periodo>"]["<combustible_id>"] = { consumo_id, cantidad, detalle,
  creado_por:{usuario_id,nombre_completo}, creado_en, modificado_por:{...}|null, modificado_en }`.
  SELECT en `server.js:2466-2477`, pivot en `2480-2495`.
- `POST /api/combustibles/consumos` (`server.js:2509`): batch atómico. cantidad null/0 ⇒ DELETE;
  existente ⇒ UPDATE; nueva ⇒ INSERT con `creado_por=sesion.usuario_id`. `modificado_por` solo se
  setea si `cantidad` cambió (D-019). **Cuando un humano edita, `modificado_por` = su usuario_id**
  (`server.js:2620`) — esta es la señal de "humano-owned".
- Gating de permisos: `hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'|'puede_crear')`.

## Patrones de infraestructura
- **Conexión BD**: `server/db.js` exporta `getDB()` (pool mssql). Transacciones:
  `const tx=new sql.Transaction(pool); await tx.begin(); try{ ...new sql.Request(tx)... await tx.commit(); }catch(e){ try{await tx.rollback()}catch{}; throw e }`.
- **Usuario SISTEMA**: `dbBindings.USUARIO_SISTEMA_ID` (live binding, `db.js:49`), `activo=0`, nunca loguea.
  **Es el autor de toda escritura automática del scraper** (`creado_por`/`modificado_por`).
- **Sweepers**: `server/utils/mand-sweeper.js` y `turno-sweeper.js`. Patrón: `INTERVAL_MS`,
  `let timer`, `tick()` con `try/catch` y reprograma en `finally` (`timer=setTimeout(tick,INTERVAL_MS)`),
  `start*(pool)` / `stop*()`. `mand-sweeper` hace **catchup** al primer tick. Se arrancan en
  `server.js` tras `initDB()` (junto a `startMandSweeper(db)`, ~`server.js:2657`) y se paran en
  el handler `SIGTERM/SIGINT`.
- **Helpers TZ**: `server/utils/turno.js` (`periodoFromFechaBogota`, `fechaBogotaStr`, `colombiaParts`,
  `COLOMBIA_OFFSET_HOURS=5`), `server/utils/fecha.js`. Front: `src/utils/fecha.js` `getTodayBogota()`.
- **Tests**: `server/tests/` con `node:test` (`--test-concurrency=1 --env-file=../.env`).
  Helpers `server/tests/helpers.js`: `setupSessions()`, `call(method,path,{body,sesion_id})`,
  `PLANTA_ID`, `TEST_TAG`. Ej. `consumos_combustible.test.js`. Correr: `cd server && npm test`.
  **Baseline conocido**: `T4/C5` (cierre cronológico) flaky rojo en `main`; el resto verde.
- **Front grilla**: `src/components/Combustibles/ConsumosGrid.jsx` + `src/hooks/useCombustibles.js`.
  Periodos `p` se muestran `P{p} ({p-1}h)`. "Total Carbón" se calcula en vivo sumando ALIMENTADOR.

## Diseño D-029 (acordado)
### Schema nuevo (migración `F27.A1` en `db.js`)
- `ALTER bitacora.consumo_combustible ADD valor_sis DECIMAL(12,3) NULL, sis_actualizado_en DATETIME2 NULL`.
- `CREATE TABLE bitacora.sis_scrape_log (planta_id, fecha DATE, scrape_tipo VARCHAR(20)
  ['horario'|'backfill'], periodos_ok TINYINT, periodos_error TINYINT, ultimo_periodo TINYINT,
  completo BIT, scraped_en DATETIME2 DEFAULT SYSUTCDATETIME(), UNIQUE(planta_id,fecha))`.

### Regla de upsert con ownership (núcleo de `carbon-scraper.js`)
`SIS-owned` ⇔ `creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA)`.
Cualquier otro caso = **humano-owned** ⇒ "operador gana".

| `valor_sis` validado | fila | acción |
|---|---|---|
| `>0` | no existe | INSERT `cantidad=valor_sis`, `valor_sis`, `creado_por=SISTEMA`, `sis_actualizado_en=now` |
| `>0` | SIS-owned | UPDATE `cantidad=valor_sis`, `valor_sis`, `sis_actualizado_en=now` |
| `>0` | humano-owned | UPDATE **solo** `valor_sis`, `sis_actualizado_en` (NO toca `cantidad`/`modificado_por`) |
| `=0` | no existe | skip |
| `=0` | SIS-owned | DELETE |
| `=0` | humano-owned | UPDATE `valor_sis=0`, `sis_actualizado_en` |

### Módulos backend nuevos (`server/utils/sis/`)
- `xls-parser.js` (port ESM de `xls.js`), `sis-client.js` (`buildUrl`,`fetchPeriod`),
  `carbon-scraper.js` (`scrapeDia(pool,{fecha,scrape_tipo})`, `discoverEarliestDate(pool)`),
  `sis-sweeper.js` (`startSisSweeper`/`stopSisSweeper`, 1h, catchup, resiliente a SIS caído).

### Endpoints nuevos / cambios (`server.js`)
- `POST /api/combustibles/sis/scrape` (gated JdT/IngOp/Jefe Planta) body `{fecha}`|`{from,to}`.
- `POST /api/combustibles/consumos/revertir` (gated `puede_crear`) body `{planta_id,fecha,periodo,combustible_id}`:
  `cantidad=valor_sis`, vuelve a SIS-owned (`creado_por=SISTEMA`, `modificado_por=NULL`).
- GET `/api/combustibles/consumos`: agregar `valor_sis`, `sis_actualizado_en` al SELECT y al pivot.

### Front
- Celda ALIM GEC32 con override (humano-owned y `cantidad!==valor_sis`): badge + tooltip
  "Editado por <nombre> el <fecha>. Valor SIS: <x>. [Revertir]". Botón → endpoint revertir + refetch.
  Celdas siguen editables. Auto-refresco si `GEC32 && fecha===hoy` (interval ~5min + window focus).

### Backfill (CLI `server/scripts/backfill-carbon-gec32.js`)
- `node --env-file=../.env scripts/backfill-carbon-gec32.js [--from][--to]`. Sin `--from` ⇒
  `discoverEarliestDate`. Resumible (salta días `sis_scrape_log.completo=1`), throttled. Solo
  guarda filas con carbón>0. **Claude lo corre una vez en E7.**

## Convenciones a respetar
- TZ canónica: BD en UTC (`SYSUTCDATETIME()`), presentación Bogotá explícita.
- Migraciones idempotentes (`IF NOT EXISTS`), gated por flag en `migracion_aplicada`.
- No romper el server si el SIS no responde (try/catch + log).
- Excluir `node_modules` de búsquedas. No tocar GEC3.
