# D-061 — Plan de olas

> Lo escribe el integrador en la fase 2 (2026-08-26) y lo commitea junto con el scaffolding. Es
> la fuente de `LOTES.json` y de los prompts `LNN-<slug>.md`. Solo el integrador lo edita (en un
> gate, con nota de por qué). Los lotes lo leen, no lo tocan.

## Grafo de dependencias
```
L01 (núcleo SIS: planta_id + concurrencia + sis-lock + discover.js) ──┬─> L04 (scrape manual asíncrono) ─┬─> L10 (endurecer SIS, GATE-O2) ─┐
L02 (backend COMB: seed TST + GET + vaciar + revertir) ───────────────┤                                  │                                 ├─> L07 (docs + cleanup) ─> cierre
                                                                      ├─> L06 (higiene D-055) ───────────┤                                 │
L01 ──────────────────────────────────────────────────────────────────┴─> L05 (backfill histórico) ──────┘                                 │
L03 (front override; consume C4/C5 fijados) ──> L08 (correcciones front, GATE-O1) ──> L09 (refetch vs Guardar, GATE-O2) ───────────────────┘
```
Camino crítico: **L02 → L04 → {L09, L10} → L07 → cierre** (y la corrida prod del backfill, que
depende de L05 y del visto bueno tras GATE-O2). Fuera del camino crítico: L06. **L05 arrancó una
corrida de días** (backfill dev) que sigue viva durante los gates O2/O3/O4: no bloquea nada, se
reporta — solo obliga a presupuestar ~58 min de suite en vez de ~30 mientras esté escribiendo.

## Olas
| Ola | Lotes | Por qué pueden ir juntos | Compartidos y su escritor |
|---|---|---|---|
| O1 | L01, L02, L03 | Raíces del grafo. Territorios disjuntos (`utils/sis/*` + tests SIS / `db.js` + `routes/combustibles.js` + test HTTP / `src/components/Combustibles/*` + hook). L03 construye contra los contratos C4/C5/C11 ya fijados; la integración real la ve el gate. | `db.js` → L02 · `combustibles.js` → L02 · `carbon-scraper.js` → L01 |
| O2 | L04, L05, L06, **L08** | Consumen C1/C2/C12 verificados en GATE-O1. L08 (corrección front, puro) se añadió en GATE-O1 §7. Disjuntos: L04 (`sis-job.js` + `combustibles.js` + su test) / L05 (`discover.js` + CLI + fixture + `sis_parser.test.js` + su test) / L06 (solo archivos de test + helpers + residuos). | `combustibles.js` → L04 · `discover.js` → L05 · `helpers.js` → L06 |
| Tarea del integrador tras GATE-O2 | Corrida del backfill contra **prod** (`DB_NAME=PortalG3 … --confirm-db PortalG3`) | Requiere visto bueno explícito del usuario (PREGUNTAS #11). Se registra en `GATE-O2.md` §5 y en `ESTADO.md`. | — |
| O3 | **L09, L10** | Lotes de corrección abiertos por el `/code-review` de la O2 (`GATE-O2.md` §5 D9). Disjuntos por completo: L09 vive en `src/components/Combustibles/**` y L10 en `server/utils/sis/discover.js` + el CLI + `routes/combustibles.js` + tres archivos de test. | `combustibles.js` → L10 · `discover.js` → L10 |
| O5 | **L12** | Último lote de código de D-061 (`GATE-O4.md` §5 D16, opción c): los tres hallazgos altos que pueden perder datos o atascar al operador. **Sin tocar el popover** — eso sale a D-062. | `src/components/Combustibles/**` (sin el CSS) → L12 |
| O4 | **L11, L07** | L11 cierra las fronteras que dejaron abiertas L09 y L10 (`GATE-O3.md` §5 D12) y L07 documenta. Van en paralelo porque los territorios son disjuntos (`src/**` + `utils/sis` + tests, contra `BIT-*` + `docs/` + `deploy/`) y **L11 no mueve ningún contrato**: C3 y C8 quedan como los dejó L10, así que lo que L07 escribe no se mueve bajo sus pies. | `discover.js`, `carbon-scraper.js` → L11 · `BIT-*`, `docs/*`, `deploy/DEPLOY.md` → L07 |
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
- **Territorio:** `server/utils/sis/sis-job.js` (nuevo), `server/routes/combustibles.js`, `server/tests/sis_scrape_endpoint.test.js` (nuevo), `server/tests/sis_endpoints.test.js` (desde GATE-O1: CA-36)
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
- **Territorio:** `server/tests/consumos_combustible.test.js`, `server/tests/rol_coordinador_carbon_maquinaria.test.js`, `server/tests/sis_scraper_ownership.test.js`, `server/tests/sis_concurrencia.test.js` (desde GATE-O1: H1), `server/tests/guard_no_prod_historico_destruction.test.js`, `server/tests/helpers.js`, `server/tests/residuos.js`
- **Contratos que produce:** C13 · **que consume:** C1, C12
- **Criterios:** CA-25, CA-26, CA-27, CA-28
- **Tests que corre:** los cuatro archivos de test de su territorio + `npm run test:residuos`
- **Riesgo / nota:** al ampliar el guard, otros archivos fuera de su territorio pueden caer en rojo (p. ej. `sis_concurrencia.test.js` de L01 en GEC32 con fecha fija, o `sis_scrape_endpoint.test.js` de L04): **no los edita** — lo reporta como `Bloqueos` con el diff exacto y el gate lo aplica. El guard exige acotador léxico; una fecha fija no lo es.

### L08 — Correcciones del front COMB tras el code-review de la O1 (añadido en GATE-O1)
- **Ola:** O2 · **Depende de:** L03 · **Puro:** sí (vitest + build) · **Puerto de test:** 3108 (reservado; no levanta backend)
- **Territorio:** `src/components/Combustibles/ConsumosGrid.jsx`, `combustibles.css`, `override.js`, `override.test.js`, `ConsumosGrid.test.jsx` (nuevo)
- **Contratos:** — (consume C4/C5/C6/C11 sin cambiarlos)
- **Criterios:** CA-32, CA-33, CA-34, CA-35
- **Tests que corre:** `npx vitest run src/components/Combustibles`, `npm run build`
- **Riesgo / nota:** creado por el gate O1 con los 8 hallazgos front del `/code-review` (H2, H3, H5, H6, H10, H11, H13, H14 en `GATE-O1.md` §7): Revertir pisaba ediciones ajenas, refetch en vuelo, override 0 encendía Guardar, medianoche, apilamiento y recorte del popover, toast en `sin_cambios`, banderín tabulable. Disjunto de L04/L05/L06 (solo `src/components/Combustibles/**`). No bloquea a L07 más que por el gate O2.

### L09 — El refetch preservado no puede convertirse en un borrado al guardar (front COMB)
- **Ola:** O3 · **Depende de:** L08 · **Puro:** sí (vitest + build) · **Puerto de test:** 3109 (reservado; no levanta backend)
- **Territorio:** `src/components/Combustibles/{ConsumosGrid.jsx,combustibles.css,override.js,override.test.js,ConsumosGrid.test.jsx}`
- **Contratos:** — (consume C4/C5/C6/C11 sin cambiarlos; C11 puede crecer)
- **Criterios:** CA-37, CA-38, CA-39, CA-40
- **Tests que corre:** `npx vitest run src/components/Combustibles`, `npm run build`
- **Riesgo / nota:** creado por el gate O2 con cuatro hallazgos del `/code-review` (`GATE-O2.md` §7:
  H24, H25, H26, H27). **H24 es pérdida de datos sobre planta real** y es lo primero que se arregla:
  el arreglo de L08 al latido (CA-33) dejó el buffer viejo contra un snapshot nuevo, así que el
  Guardar siguiente manda como cambios celdas que el operador nunca tocó. Disjunto de L10 (solo
  `src/**`). El smoke visual pendiente de CA-12/CA-35 conviene hacerlo **después** de este lote.

### L10 — Endurecer el descubrimiento del SIS y hacer honesta la cobertura del scrape manual
- **Ola:** O3 · **Depende de:** L04, L05 · **Puro:** no (la parte HTTP levanta efímero y toma el test-lock) · **Puerto de test:** 3110 (+ stub del SIS en 3154)
- **Territorio:** `server/utils/sis/discover.js`, `server/scripts/backfill-carbon-gec32.js`, `server/routes/combustibles.js`, `server/tests/{sis_discover,sis_scrape_endpoint,sis_endpoints}.test.js`
- **Contratos que produce:** **C3 v3** (`discoverEarliestDate` → `{ fecha, motivo, sondeos }`; único llamador, el CLI de su propio territorio) y **C8 +1** (`sweeper: { habilitado }`, aditivo) · **que consume:** C1, C7, C9, C10
- **Criterios:** CA-41 … CA-47
- **Tests que corre:** `tests/sis_discover.test.js` (puro) + `tests/sis_scrape_endpoint.test.js` y `tests/sis_endpoints.test.js` (HTTP, con el stub y el sweeper **encendido**)
- **Riesgo / nota:** creado por el gate O2 con seis hallazgos del `/code-review` (`GATE-O2.md` §7:
  H28–H33) más la simetría de `detalle` que quedó a medias en CA-36 (H25). **No corre el CLI contra
  ninguna BD** y **no toca el proceso del backfill**, que sigue vivo. La fecha `2018-06-13` ya
  descubierta **no está en duda** (esa corrida tuvo 0 errores de red): lo que se arregla es que la
  próxima no pueda mentir en silencio.

### L11 — Cerrar las fronteras que dejaron abiertas L09 y L10
- **Ola:** O4 · **Depende de:** L09, L10 · **Puro:** no (la parte HTTP de CA-53 levanta efímero) · **Puerto de test:** 3111 (+ stub del SIS en 3154)
- **Territorio:** `src/components/Combustibles/**` (5 archivos), `server/utils/sis/{discover,carbon-scraper}.js`, `server/tests/{sis_discover,sis_scrape_endpoint}.test.js`
- **Contratos:** **ninguno** — C3 y C8 quedan como los dejó L10; C11 solo puede crecer. Cambiar uno es un bloqueo.
- **Criterios:** CA-48 … CA-54
- **Tests que corre:** `npx vitest run src/components/Combustibles`, `node --test tests/sis_discover.test.js`, `npm test` (para CA-53) y `tests/sis_scrape_endpoint.test.js` con harness
- **Riesgo / nota:** creado por el gate O3 con tres hallazgos **altos** (`GATE-O3.md` §7: H50 —H24
  vuelve por la puerta de al lado porque `editadasRef` nunca suelta una coordenada—, H49 —el arreglo
  de H29 dejó de sondear el día del `hint`, una regresión— y H51 —la guarda de CA-44 dejó `npm test`
  rojo para siempre—) más cuatro medios y tres de limpieza. Los tres altos son **fronteras de
  arreglos anteriores**, no defectos independientes: el prompt le pide leer primero el cierre del
  lote que hizo cada arreglo. Disjunto de L07.

### L12 — Una sola definición de "esta celda cambió", y que el conjunto de editadas no mienta
- **Ola:** O5 · **Depende de:** L11 · **Puro:** sí (vitest + build) · **Puerto de test:** 3112 (reservado; no levanta backend)
- **Territorio:** `src/components/Combustibles/{ConsumosGrid.jsx,override.js,override.test.js,ConsumosGrid.test.jsx}` — **`combustibles.css` queda fuera a propósito**: es la señal de que el popover no es suyo
- **Contratos:** ninguno (C11 puede crecer; `celdaEquivalente` corrige comportamiento, no firma)
- **Criterios:** CA-55, CA-56, CA-57, CA-58
- **Tests que corre:** `npx vitest run src/components/Combustibles`, `npx vitest run src`, `npm run build`
- **Riesgo / nota:** creado por el gate O4 (D16, opción c) con **H65, H66, H72** (altos) más H68, H73
  y H74. **H65 es la tercera aparición del mismo modo de pérdida de datos** (H24 → H50 → H65): el
  prompt le exige que la propiedad quede cierta **por construcción**, derivando la pertenencia al
  conjunto del estado en vez de acumularla por eventos, en lugar de tapar otra puerta. Los hallazgos
  del popover (H67, H69, H70, **H75**) **no son suyos**: salen a D-062.

### L07 — Docs + cleanup
- **Ola:** **O4** (movida por `GATE-O2.md` §5 D9) · **Depende de:** L04, L05, L06, L08, L09, L10 · **Puro:** sí · **Puerto de test:** 3107 (no aplica) · **Comparte ola con L11**, que no mueve contratos
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

## Enmiendas del gate O1 (2026-08-26)
- **L08 nuevo en O2** (corrección front, puro): los 8 hallazgos de UI del `/code-review` de la O1
  no son de archivos compartidos, así que van en lote propio, no en el gate.
- **L06 gana `server/tests/sis_concurrencia.test.js`** (H1, alta): el test escribe GEC32 en
  `2026-04-17` y el backfill de L05 poblará esa fecha en la misma ola.
- **L04 gana `server/tests/sis_endpoints.test.js`** y CA-36 (conservar `detalle` al vaciar sin la
  clave; retirar `resolverSistemaId` del router, muerto tras D2).
- Reparto y camino crítico sin cambios (`L02 → L04 → L07 → cierre`). O2 queda con 4 lotes.

## Enmiendas del gate O2 (2026-08-26)
- **L09 y L10 nuevos en O3** (`GATE-O2.md` §5 D9). Los 15 hallazgos del `/code-review` de la O2 no
  caían en ningún archivo compartido sin dueño, salvo el voseo del CLI (arreglado en el gate), así
  que van en lotes propios y no en el gate.
- **L07 pasa a una ola O4** y gana dos dependencias (L09, L10). Su prompt dice "documenta lo real,
  no el plan": con L10 enmendando C3 y haciendo crecer C8 en la misma ola, documentaría un blanco
  móvil.
- **Camino crítico revisado:** `L02 → L04 → {L09, L10} → L07 → cierre`.
- **La corrida del backfill contra prod** sigue siendo tarea del integrador con visto bueno
  explícito (`GATE-O2.md` §5 D10), con la foto de prod ya tomada: 74 días de log, todos completos.
- Puertos de test reservados: **L09 → 3109**, **L10 → 3110** (más el stub del SIS en **3154**, que
  no estaba en la tabla de reservas de `_CONTEXTO-BASE.md §7`).

## Enmiendas del gate O3 (2026-08-27)
- **L11 nuevo en O4** (`GATE-O3.md` §5 D12), en paralelo con L07. Tercera ola seguida en la que la
  revisión encuentra defectos en las correcciones de la anterior; la diferencia es que estos tres
  altos son **fronteras** de arreglos previos (el caso que no se contempló, la regresión en el
  camino de al lado) y no una lista abierta: cerrarlos agota el trabajo sobre COMB y `discover`.
- **El gate O3 no arregló nada de código** (D11): los tres altos viven en territorio de lote y
  ninguno se puede arreglar bien sin un test que lo fije.
- **Camino crítico revisado:** `L02 → L04 → {L09, L10} → {L11, L07} → cierre`.
- **La corrida del backfill son dos pasadas** (D13): la segunda con `--solo-parciales`, y el
  criterio de terminado es `COUNT(*) WHERE completo = 0` en cero. Lo escribe L07 en `DEPLOY.md`.
- **El smoke visual del front se hace después de L11**, que es la última mano sobre esa pantalla.
- Puerto de test reservado: **L11 → 3111**.

## Enmiendas del gate O4 (2026-08-27)
- **L12 nuevo en O5** (`GATE-O4.md` §5 D16, opción **c** elegida por el usuario). Es el **último lote
  de código** de D-061: después va el cierre.
- **Lo que SALE de D-061 hacia `D-062`:** el rediseño del popover del override (sacarlo a un portal
  con `position: fixed` en vez de seguir corrigiendo la medición — va por su quinta corrección) y el
  rediseño del modelo de edición de la grilla. Se planifica con `/nueva-implementacion` cuando el
  usuario lo decida; el cierre de D-061 deja la cross-referencia.
- **Camino crítico final:** `L02 → L04 → {L09, L10} → L11 → L12 → cierre`.
- **La recuperación de un backfill interrumpido es relanzar el comando completo**, no
  `--solo-parciales` (D15, enmienda la D13 del gate O3).
- **El smoke visual va después de L12**, que es de verdad la última mano sobre esa pantalla dentro
  de D-061.
- Puerto de test reservado: **L12 → 3112**.
