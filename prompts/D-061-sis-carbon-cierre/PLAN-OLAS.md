# D-061 — Plan de olas

> Lo escribe el integrador en la fase 2 (2026-08-26) y lo commitea junto con el scaffolding. Es
> la fuente de `LOTES.json` y de los prompts `LNN-<slug>.md`. Solo el integrador lo edita (en un
> gate, con nota de por qué). Los lotes lo leen, no lo tocan.

## Grafo de dependencias
```
L01 (núcleo SIS: planta_id + concurrencia + sis-lock + discover.js) ──┬─> L04 (scrape manual asíncrono) ─┐
L02 (backend COMB: seed TST + GET + vaciar + revertir) ───────────────┤                                  ├─> L07 (docs + cleanup) ─> cierre
                                                                      ├─> L06 (higiene D-055) ────────────┤
L01 ──────────────────────────────────────────────────────────────────┴─> L05 (backfill histórico) ───────┘
L03 (front override; consume C4/C5 fijados) ── independiente en O1 ──────────────────────────────────────┘
```
Camino crítico: **L02 → L04 → L07 → cierre** (y la corrida prod del backfill, que depende de L05 y
del visto bueno tras GATE-O2). Fuera del camino crítico: L03, L06. **L05 arranca una corrida de
días** (backfill dev) que sigue viva durante el gate O2 y la O3: no bloquea nada, se reporta.

## Olas
| Ola | Lotes | Por qué pueden ir juntos | Compartidos y su escritor |
|---|---|---|---|
| O1 | L01, L02, L03 | Raíces del grafo. Territorios disjuntos (`utils/sis/*` + tests SIS / `db.js` + `routes/combustibles.js` + test HTTP / `src/components/Combustibles/*` + hook). L03 construye contra los contratos C4/C5/C11 ya fijados; la integración real la ve el gate. | `db.js` → L02 · `combustibles.js` → L02 · `carbon-scraper.js` → L01 |
| O2 | L04, L05, L06 | Consumen C1/C2/C12 verificados en GATE-O1. Disjuntos: L04 (`sis-job.js` + `combustibles.js` + su test) / L05 (`discover.js` + CLI + fixture + `sis_parser.test.js` + su test) / L06 (solo archivos de test + helpers + residuos). | `combustibles.js` → L04 · `discover.js` → L05 · `helpers.js` → L06 |
| Tarea del integrador tras GATE-O2 | Corrida del backfill contra **prod** (`DB_NAME=PortalG3 … --confirm-db PortalG3`) | Requiere visto bueno explícito del usuario (PREGUNTAS #11). Se registra en `GATE-O2.md` §5 y en `ESTADO.md`. | — |
| O3 | L07 | Docs permanentes + cleanup del scaffolding v1 y del scraper standalone, con toda la funcionalidad ya verificada. | `BIT-*`, `docs/architecture.md`, `docs/domain-glossary.md`, `deploy/DEPLOY.md` → L07 |
| Cierre | `/cerrar-implementacion D-061` | ADR D-061 completo (desde los aportes), `CLAUDE.md` conv. 35, corregir la cross-ref `[[D-029]]` de D-060 → `[[D-061]]`, `git rm` de `prompts/D-061-*`, smoke + suite final. | `decisions.md`, `CLAUDE.md` → integrador |

## Lotes

### L01 — Núcleo SIS: `planta_id` + `concurrencia` en `scrapeDia`, mutex `sis-lock`, `discover.js`
- **Ola:** O1 · **Depende de:** — · **Puro (sin BD):** no (`sis_concurrencia` usa BD; `sis_lock` y `sis_sweeper` puros) · **Puerto de test:** 3101 (no necesita backend HTTP)
- **Territorio (escritura):** `server/utils/sis/carbon-scraper.js`, `server/utils/sis/sis-lock.js` (nuevo), `server/utils/sis/discover.js` (nuevo, movimiento), `server/utils/sis/sis-sweeper.js`, `server/tests/sis_lock.test.js` (nuevo), `server/tests/sis_concurrencia.test.js` (nuevo)
- **Contratos que produce:** C1, C2, C3 · **que consume:** —
- **Criterios de aceptación:** CA-1, CA-2, CA-3, CA-4
- **Tests que corre:** `tests/sis_lock.test.js`, `tests/sis_concurrencia.test.js`, `tests/sis_sweeper.test.js`, `tests/sis_scraper_ownership.test.js` (existentes deben seguir verdes)
- **Riesgo / nota:** `sis_concurrencia` escribe en GEC32 con fecha fija `2026-04-17` (< 2026-06-02) y limpia solo esa fecha (D-055). Queda en GEC32 con fecha fija (está fuera del territorio de L06): si el guard ampliado de L06 lo marca, el gate O2 aplica el acotador. `sis_sweeper.test.js` hoy es puro: el test del tick omitido debe seguir siendo puro (inyectar `scrapeFn`/lock).

### L02 — Backend COMB: catálogo `'TST'`, GET con `valor_sis`, vaciar = override 0, `POST revertir`
- **Ola:** O1 · **Depende de:** — · **Puro:** no · **Puerto de test:** 3102 (**dueño de `db.js`: arranca SIN `SKIP_INITDB`**, bajo test-lock)
- **Territorio:** `server/db.js`, `server/routes/combustibles.js`, `server/tests/sis_endpoints.test.js` (nuevo)
- **Contratos que produce:** C4, C5, C6, C12 · **que consume:** —
- **Criterios:** CA-5, CA-6, CA-7, CA-8, CA-9, CA-10
- **Tests que corre:** `tests/sis_endpoints.test.js`, `tests/consumos_combustible.test.js`, `tests/sis_schema.test.js`
- **Riesgo / nota:** es el único que toca `db.js` en O1; el seed va como bloque idempotente **fuera** del gate `F26.B1` y **después** del seed de `'TST'` en `lov_bit.planta`. El test nuevo opera en `TEST_PLANTA` (sesiones con `setupSessions({ planta: TEST_PLANTA })`, celdas sembradas por SQL con `creado_por` SISTEMA/humano) — es el **calibrador** del patrón TST-en-COMB que L06 replica.

### L03 — Front: badge de override + tooltip + Revertir + auto-refresco con gavela + chip SIS
- **Ola:** O1 · **Depende de:** — (contratos C4/C5 fijados) · **Puro:** sí (vitest + build) · **Puerto de test:** 3103 (reservado; no levanta backend)
- **Territorio:** `src/hooks/useCombustibles.js`, `src/components/Combustibles/ConsumosGrid.jsx`, `src/components/Combustibles/combustibles.css`, `src/components/Combustibles/override.js` (nuevo), `src/components/Combustibles/override.test.js` (nuevo)
- **Contratos que produce:** C11 · **que consume:** C4, C5, C6
- **Criterios:** CA-11, CA-12, CA-13, CA-14, CA-15
- **Tests que corre:** `npx vitest run src/components/Combustibles/override.test.js`, `npm run build`
- **Riesgo / nota:** hasta que L02 esté `done`, el backend no devuelve `es_override`/`sis`: la UI debe tolerar campos ausentes (`undefined` ⇒ sin badge, chip "sin lectura"). Smoke visual contra `npm run dev` solo si L02 ya cerró; si no, queda explícito para el gate.

### L04 — Scrape manual asíncrono: `sis-job.js` + `POST /sis/scrape` (202/409) + `GET /sis/estado`
- **Ola:** O2 · **Depende de:** L01, L02 · **Puro:** no · **Puerto de test:** 3104 (`SKIP_INITDB=1`; además un **SIS stub** local en 3154 que responde 500)
- **Territorio:** `server/utils/sis/sis-job.js` (nuevo), `server/routes/combustibles.js`, `server/tests/sis_scrape_endpoint.test.js` (nuevo)
- **Contratos que produce:** C7, C8, C9 · **que consume:** C1, C2, C12
- **Criterios:** CA-16, CA-17, CA-18, CA-19
- **Tests que corre:** `tests/sis_scrape_endpoint.test.js`, `tests/sis_endpoints.test.js` (de L02, debe seguir verde)
- **Riesgo / nota:** el backend efímero arranca con `SIS_HOST=http://localhost:3154` para que el job no toque el SIS real; el test usa `planta_id: TEST_PLANTA` y fechas fijas; limpia `sis_scrape_log` de TST. El job es en memoria: `_resetScrapeJobParaTests()` es una función interna del módulo (ningún endpoint la expone); el test HTTP espera `estado='terminado'` por polling de `GET /sis/estado`.

### L05 — Backfill histórico: `discover` v2, CLI `--concurrencia`, fixture `.xls`, calibración y corrida dev
- **Ola:** O2 · **Depende de:** L01 · **Puro:** no (CLI contra BD + SIS real; `sis_discover` y `sis_parser` puros) · **Puerto de test:** 3105 (no necesita backend HTTP)
- **Territorio:** `server/utils/sis/discover.js`, `server/scripts/backfill-carbon-gec32.js`, `server/tests/sis_discover.test.js` (nuevo), `server/tests/fixtures/sis-period.xls` (nuevo), `server/tests/sis_parser.test.js`
- **Contratos que produce:** C3 (v2), C10 · **que consume:** C1
- **Criterios:** CA-20, CA-21, CA-22, CA-23, CA-24
- **Tests que corre:** `tests/sis_discover.test.js`, `tests/sis_parser.test.js`, `tests/sis_parser_hardening.test.js` (existente)
- **Riesgo / nota:** **es el lote largo**: sondeos reales (~13 s cada uno), spot-check y arranque de una corrida de días en background (fuera del chat, log fuera del repo). Mide la concurrencia tolerada por el SIS (2/4/6) antes de fijar el default recomendado. No corre prod: eso es del integrador tras GATE-O2 con visto bueno.

### L06 — Higiene D-055: tests de COMB/SIS a `TEST_PLANTA`, guard ampliado, residuos
- **Ola:** O2 · **Depende de:** L01, L02 · **Puro:** no · **Puerto de test:** 3106 (`SKIP_INITDB=1`)
- **Territorio:** `server/tests/consumos_combustible.test.js`, `server/tests/rol_coordinador_carbon_maquinaria.test.js`, `server/tests/sis_scraper_ownership.test.js`, `server/tests/guard_no_prod_historico_destruction.test.js`, `server/tests/helpers.js`, `server/tests/residuos.js`
- **Contratos que produce:** C13 · **que consume:** C1, C12
- **Criterios:** CA-25, CA-26, CA-27, CA-28
- **Tests que corre:** los cuatro archivos de test de su territorio + `npm run test:residuos`
- **Riesgo / nota:** al ampliar el guard, otros archivos fuera de su territorio pueden caer en rojo (p. ej. `sis_concurrencia.test.js` de L01 en GEC32 con fecha fija, o `sis_scrape_endpoint.test.js` de L04): **no los edita** — lo reporta como `Bloqueos` con el diff exacto y el gate lo aplica. El guard exige acotador léxico; una fecha fija no lo es.

### L07 — Docs + cleanup
- **Ola:** O3 · **Depende de:** L04, L05, L06 · **Puro:** sí · **Puerto de test:** 3107 (no aplica)
- **Territorio:** `BIT-MODBD-2026-001.md`, `BIT-RF-2026-001.md`, `docs/architecture.md`, `docs/domain-glossary.md`, `deploy/DEPLOY.md`, `js-scraper-carbon-g32/**` (git rm + sueltos), `prompts/D-029-sis-carbon-gec32/**` (git rm)
- **Contratos:** — · **consume:** todos (documenta)
- **Criterios:** CA-29, CA-30, CA-31
- **Tests que corre:** `git grep js-scraper-carbon-g32` (vacío fuera de `docs/decisions.md`), `node --check` no aplica
- **Riesgo / nota:** lee los `GATE-O1/O2.md` y los cierres para documentar lo real, no el plan. El ADR y `CLAUDE.md` NO son suyos (cierre).

## Criterios de tamaño y reparto aplicados
- Partición por dependencias, no por volumen: L01/L02/L03 son las tres raíces; L04/L05/L06
  consumen contratos de O1; L07 documenta lo verificado.
- ≤ 6 archivos de territorio y ≤ 8 CA por lote (L01 6/4, L02 3/6, L03 5/5, L04 3/4, L05 5/5,
  L06 6/4, L07 7/3 — L07 excede en archivos porque son docs sin lógica); 3 lotes por ola (1 en O3).
- Un solo escritor por compartido y por ola (§8 de `_CONTEXTO-BASE.md`).
- Riesgo asimétrico: la **corrida larga del backfill** (L05) queda en background y fuera del
  camino de los gates; la **corrida prod** es tarea del integrador con visto bueno.
- Calibrador: L02 fija el patrón "COMB en `TEST_PLANTA`" que L06 replica; L01 fija `planta_id` en
  `scrapeDia` que L04/L06 consumen.
- Sin migración ni cambio cross-repo: no hay pasos previos en el umbrella.
