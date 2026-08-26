# D-061 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-08-26. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en el cierre del lote + el gate, no acá.

## Fuente del requerimiento
- Pedido verbal del usuario: "Cerrar D-029: endpoints SIS, UI de override y backfill restante".
- Flujo v1 heredado: `prompts/D-029-sis-carbon-gec32/` (E1–E4 ✅, E5 endpoints ⬜, E6 UI ⬜,
  E7 backfill 🟡 parcial por D-060, E8 docs ⬜). Sus `PREGUNTAS-D-029.md` (2026-06-03) siguen
  vigentes salvo donde esta tabla las precisa (#3, #4, #6, #7).
- El número **D-029 ya fue consumido** en `docs/decisions.md` por el rol "Coordinador de carbón y
  maquinaria" (2026-06-20); la ingesta SIS nunca tuvo ADR propio (solo BIT-MODBD §4.9.1 y D-060).

## Medido antes de preguntar (2026-08-26)
- Prod `PortalG3`: 10.777 celdas ALIM GEC32 (2026-06-02 → 08-21), todas con `valor_sis`; 3
  humano-owned, 2 overrides reales; `sis_scrape_log` 74 días (todos 24/24), **12 días sin fila**
  (06-10..06-27). Migraciones hasta `F31.A1` (F32–F34 solo en dev).
- Dev `PortalG3_dev`: 5.197 celdas, 2 humano-owned, 1 override; 40 días de log, 46 sin fila.
- SIS `http://192.168.18.201`: responde desde este equipo, **~13 s por periodo, ~830 KB por .xls**
  (3.601 filas). Sondeo P12: 2026-08-15 en servicio 279 MW; 2025-08-15 fuera (0,2 MW);
  2023-08-15 299 MW; 2020-08-15 156 MW; **2016-08-15 todo en cero**.
- `GET /api/combustibles/consumos` no expone `valor_sis`; `routes/combustibles.js` hardcodea
  `['GEC3','GEC32']` (raíz del pendiente D-055 de COMB).
- Último ADR en todas las ramas: D-060. Última convención `CLAUDE.md`: 34. BIT-MODBD 2.4, BIT-RF 1.8.

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | D-029 ya está consumido. ¿Cómo numeramos y documentamos? a) **D-061 = ADR completo de la ingesta SIS** (retroactivo E1–E4 + este cierre; `git rm` de `prompts/D-029-*` y del scraper standalone al cerrar) · b) D-061 solo el cierre · c) seguir en v1 con `/ejecutar-etapa`. | **a) D-061 = ADR completo de la ingesta SIS.** |
| 2 | Rama base. `deployment-unificado.md` (2026-08-26) fija `feat/integrar-asientos-D-059` como rama de integración (30 commits sobre `main`; prod sigue en `8e08e03`). a) **desde `feat/integrar-asientos-D-059`** · b) desde `main`. | **a) `feat/sis-carbon-cierre-2026-08` nace de `feat/integrar-asientos-D-059`.** |
| 3 | Rango del backfill histórico (SIS con datos al menos desde 2020-08; 5,2 min/día secuencial). a) **todo el histórico descubierto** (`discoverEarliestDate` calibrado; ≥2.300 días, ~440k filas) · b) desde 2026-01-01 · c) solo huecos desde 2026-06-02 · d) otra fecha. | **a) Todo el histórico descubierto.** Sostiene la respuesta #2 de D-029. |
| 4 | Ejecución del backfill. a) **CLI con `--concurrencia N` (3–4) y Claude lo corre en el lote** (dev durante la ola; prod con visto bueno en el gate) · b) secuencial + Claude · c) paralelo pero lo corre el usuario. | **a) CLI paralelo; Claude lo corre.** El sweeper sigue secuencial. |

## Ronda 2

| # | Pregunta | Respuesta |
|---|---|---|
| 5 | Scrape manual: un día tarda ~5 min (inviable en una request; nginx corta a 60 s) y choca con el sweeper. a) **asíncrono 202 + `GET /sis/estado` + mutex de proceso, gate `puede_crear`** · b) síncrono un día · c) asíncrono con cargos nombrados · d) sin endpoint. | **a) Asíncrono 202 + estado + mutex; gate por matriz `puede_crear` en COMB, nunca por nombre de cargo.** |
| 6 | Semántica de VACIAR una celda ALIM que el SIS alimenta (hoy DELETE y el sweeper la repuebla). a) **vaciar = override a 0 humano-owned** · b) vaciar = revertir al SIS · c) dejar como está. | **a) Vaciar = override a 0, humano-owned.** Revertir la devuelve al SIS (`valor_sis>0` → cantidad; `=0` → DELETE). |
| 7 | UI de override + auto-refresco (GEC32+hoy, 5 min + focus) y el buffer sin guardar. a) pausar auto-refresco mientras haya cambios · b) refrescar y mergear · c) sin auto-refresco. | **a) con ajuste del usuario:** el buffer no puede quedar "paralizado para siempre" → **gavela de 10 min**: si hay cambios sin guardar, se avisa y al vencer se **descartan** y se refresca de todas formas. |
| 8 | D-055 pendiente en COMB (`combustibles.js` hardcodea plantas; los tests borran `consumo_combustible` en GEC3/GEC32 reales con fechas fijas pre-2026-06-02). a) fuera de alcance · b) **incluir un lote: catálogo `'TST'` + `combustibles.js` acepta `TEST_PLANTA`** + migrar tests + guard. | **b) Incluir el lote de higiene.** |

## Ronda 3

| # | Pregunta | Respuesta |
|---|---|---|
| 9 | Gavela de 10 min: ¿solo donde hay auto-refresco (GEC32+hoy), con cuenta regresiva visible, botón Descartar, y al vencer descarte + refetch + toast? a) **sí, así** · b) en todas las fechas/plantas · c) sin cuenta visible (aviso a los 8 min). | **a) Sí: cuenta regresiva visible solo en GEC32+hoy; Guardar/Descartar la reinician; al vencer descarta + refetch + toast.** |
| 10 | ¿Botón "Actualizar desde SIS" en la grilla? a) sí, para la fecha visible · b) **solo API, sin botón**. | **b) Solo API, sin botón.** La UI no expone el scrape manual en este flujo. |
| 11 | ¿Cuándo corre el backfill contra PROD? a) **tras el gate de la ola del backfill, con visto bueno** (dev primero, verificado; prod desde este equipo, sin desplegar) · b) solo tras desplegar · c) solo dev. | **a) Tras GATE-O2 y con visto bueno explícito del usuario; lo corre el integrador.** |
| 12 | Cleanup y fixture. a) **`git rm` del scraper standalone (+ borrar los 3 sueltos) y versionar `server/tests/fixtures/sis-period.xls` (≤100 KB, ventana de 1 min)** · b) solo lo versionado · c) conservar el scraper · d) sin fixture. | **a) Ambos.** El test del parser deja de skipear. |

## Ronda final — reparto en olas
| # | Pregunta | Respuesta |
|---|---|---|
| R1 | Propongo 3 olas: **O1** = L01 núcleo SIS (`planta_id` + `concurrencia` en `scrapeDia`, mutex `sis-lock.js`, `discover.js`), L02 backend COMB (ÚNICO que toca `db.js`: seed catálogo `'TST'`; `combustibles.js`: `TEST_PLANTA`, GET con `valor_sis`/`sis_owned`/`es_override` + bloque `sis`, vaciar = override 0, `POST revertir`), L03 front override (badge + tooltip + Revertir + auto-refresco + gavela + chip SIS; `override.js` puro con vitest). **O2** = L04 scrape manual asíncrono (único escritor de `combustibles.js`), L05 backfill histórico (discover v2, `--concurrencia`, fixture, calibración, corrida dev), L06 higiene D-055. Tras GATE-O2 + OK: corrida prod (integrador). **O3** = L07 docs + cleanup. Cierre: ADR D-061 completo, `CLAUDE.md` conv. 35, corregir la cross-ref `[[D-029]]` de D-060. ¿De acuerdo? | **De acuerdo.** 3 olas, 7 lotes, sin migración `F-NN` (el catálogo `'TST'` es un seed idempotente); puertos 3101–3107. |

## Criterios de aceptación congelados
| CA | Criterio (falsable) | Verificador previsto |
|---|---|---|
| CA-1 | `scrapeDia(pool, { planta_id })` escribe **solo** en esa planta (default `'GEC32'`); si la planta no tiene catálogo `ALIM_1..8` lanza error antes de tocar el SIS. | `tests/sis_concurrencia.test.js` › planta_id |
| CA-2 | `scrapeDia({ concurrencia: N })` hace los fetch en paralelo con tope N y produce **el mismo resultado** que N=1 (mismas celdas, mismo `sis_scrape_log`); un fetch fallido sigue contando `periodos_error` sin abortar el día; `ultimo_periodo` = mayor periodo OK. | `tests/sis_concurrencia.test.js` › concurrencia 4 ≡ 1, error parcial |
| CA-3 | `sis-lock.js`: `withSisLock(motivo, fn)` serializa; si está ocupado lanza `Error` con `codigo='sis_ocupado'` sin esperar; `estadoSisLock()` expone `{ ocupado, motivo, desde }`. | `tests/sis_lock.test.js` (puro) |
| CA-4 | El tick del sweeper corre bajo el lock; con el lock ocupado **salta el tick** (log `[sis-sweeper] omitido: sis_ocupado`) y reprograma sin scrapear. | `tests/sis_sweeper.test.js` › tick omitido con lock ocupado |
| CA-5 | Seed idempotente de `lov_bit.combustible` para `TEST_PLANTA` (10 filas espejo de GEC32) — existen tras `initDB()` y un segundo arranque no duplica. | `tests/sis_endpoints.test.js` › catálogo TST 10 filas + query de duplicados |
| CA-6 | `routes/combustibles.js` acepta `TEST_PLANTA_ID` en catálogo/GET/POST/revertir (400 `planta_invalida` sigue para cualquier otra planta). | `tests/sis_endpoints.test.js` › planta TST 200 / `'XXX'` 400 |
| CA-7 | `GET /api/combustibles/consumos` expone por celda `valor_sis`, `sis_actualizado_en`, `sis_owned`, `es_override` y un bloque `sis` del día (`null` si no hay fila en `sis_scrape_log`). | `tests/sis_endpoints.test.js` › shape del GET |
| CA-8 | `POST /api/combustibles/consumos`: vaciar una celda con `valor_sis IS NOT NULL` → `UPDATE cantidad=0, modificado_por=humano` (no DELETE); vaciar una celda sin `valor_sis` → DELETE como antes. | `tests/sis_endpoints.test.js` › vaciar SIS = override 0 / vaciar manual = DELETE |
| CA-9 | `POST /api/combustibles/consumos/revertir`: `valor_sis>0` → `cantidad=valor_sis`, `creado_por=SISTEMA`, `modificado_por=NULL`, `modificado_en=NULL`; `valor_sis=0` → DELETE; sin fila → 404 `celda_no_existe`; `valor_sis NULL` → 400 `sin_valor_sis`; planta/combustible ajeno → 400; sin `puede_crear` → 403. | `tests/sis_endpoints.test.js` › revertir ×5 |
| CA-10 | El gating `hasPermisoBitacora` (`puede_ver`/`puede_crear`) se conserva en todos los endpoints de COMB; el observador (D-059) sigue GET 200 / POST 403. | `tests/consumos_combustible.test.js` (existente) + `tests/rol_usuario_consulta.test.js` (existente) en verde |
| CA-11 | `src/components/Combustibles/override.js` (puro): `esOverride(celda)`, `textoOverride(celda)` ("Editado por X el <fecha Bogotá>. Valor SIS: N Ton"), `politicaRefresco({plantaId, fecha, hoy, hayCambios})`, `restanteGavela(inicio, ahora)`, `formatoMMSS(ms)`, `textoChipSis(sis)`. | `src/components/Combustibles/override.test.js` (vitest) |
| CA-12 | En la grilla, una celda ALIM de GEC32 con `es_override` muestra badge ámbar; su tooltip muestra `textoOverride` y un botón **Revertir** (solo con `puedeCrear`); Revertir → `POST revertir` → `refetch()` → toast; la celda sigue editable; una celda con override 0 muestra `0`. | build + smoke manual (checklist en el cierre) |
| CA-13 | Auto-refresco **solo** con `plantaId==='GEC32' && fecha===hoy`: intervalo 5 min + `window.focus`; **pausado** mientras `hayCambios`; limpio al cambiar planta/fecha. | `override.test.js` › `politicaRefresco` + smoke manual |
| CA-14 | Gavela: con cambios sin guardar en GEC32+hoy arranca una cuenta regresiva visible desde 10:00; Guardar/Descartar la reinician; al vencer → descarta buffer + `refetch()` + toast "Se descartaron cambios sin guardar (10 min)". | `override.test.js` › `restanteGavela`/`formatoMMSS` + smoke manual |
| CA-15 | Chip "SIS" en la cabecera (solo GEC32) desde el bloque `sis` del GET: "SIS 14/24 · 13:02" / "SIS 24/24 ✓" / "SIS · sin lectura"; `npm run build` verde. | `override.test.js` › `textoChipSis` + build |
| CA-16 | `POST /api/combustibles/sis/scrape`: gate `puede_crear`; body `{ planta_id? , fecha }` o `{ planta_id?, from, to }` (≤ 31 días, no futuro, `from<=to`; `planta_id` ∈ {`GEC32` (default), `TEST_PLANTA`}, otra → 400 `planta_sin_sis`); responde **202** `{ job }`; **409** `scrape_en_curso` si hay job vivo o lock ocupado. | `tests/sis_scrape_endpoint.test.js` |
| CA-17 | `GET /api/combustibles/sis/estado`: gate `puede_ver`; `{ job: JobEstado\|null, lock: { ocupado, motivo, desde } }`. | `tests/sis_scrape_endpoint.test.js` |
| CA-18 | El job corre bajo `withSisLock`, día por día con `scrape_tipo:'manual'`, deja su resultado por día en `sis_scrape_log`, un día fallido no aborta el job; al terminar `estado='terminado'` con `resultados[]`. | `tests/sis_scrape_endpoint.test.js` (SIS stub local que responde 500 → 24 errores/día) |
| CA-19 | Mientras hay job, el tick del sweeper se omite (CA-4) y un segundo POST recibe 409. | `tests/sis_scrape_endpoint.test.js` › 409 durante el job |
| CA-20 | `discover.js` v2: "sin datos" ⇔ K sondeos repartidos en una ventana de W días todos vacíos (default K=6, W=60); con un historiador simulado que arranca el 2016-11-15 y tiene paradas de hasta 45 días, halla la fecha de inicio ±1 día. | `tests/sis_discover.test.js` (puro, `fetchFn` simulado) |
| CA-21 | CLI: `--concurrencia N` (default 1, tope 6, pasa a `scrapeDia`), `--from auto` (usa discover, imprime la fecha y exige `--confirm-from YYYY-MM-DD` igual para escribir), `--dry-run`, resumible, `--to ≤ hoy-2` intacto. | `node scripts/backfill-carbon-gec32.js --dry-run …` (salida literal en el cierre) |
| CA-22 | Fixture real `server/tests/fixtures/sis-period.xls` (≤ 100 KB) versionado y `tests/sis_parser.test.js` deja de skipear: parsea `maxRow/ncols/lastRow` con 12+ columnas. | `tests/sis_parser.test.js` en verde sin SKIP |
| CA-23 | Calibración real: fecha de inicio de GEC32 determinada con sondeos literales (registrados en el cierre) + spot-check de 2 días históricos contra `js-scraper-carbon-g32/scrape.js` (tolvas ≡ `ALIM_1..8`). | cierre L05 (evidencia literal) |
| CA-24 | Corrida dev iniciada en background (`--confirm-db PortalG3_dev`, log fuera del repo) y reportada en el cierre (rango, días procesados, errores, conteos por año hasta ese momento). | cierre L05 + query de conteos por año |
| CA-25 | `tests/consumos_combustible.test.js` y `tests/rol_coordinador_carbon_maquinaria.test.js` operan **solo** en `TEST_PLANTA` (ningún DELETE/POST sobre GEC3/GEC32). | los dos archivos en verde + guard CA-27 |
| CA-26 | `tests/sis_scraper_ownership.test.js` corre `scrapeDia({ planta_id: TEST_PLANTA })` y limpia solo TST. | archivo en verde + guard CA-27 |
| CA-27 | `guard_no_prod_historico_destruction.test.js` protege también `consumo_combustible` y `sis_scrape_log` (todo DELETE/UPDATE exige acotador léxico); verificador bidireccional. | guard en verde; rojo con un DELETE sin acotador de prueba |
| CA-28 | `tests/residuos.js` cuenta `consumo_combustible` y `sis_scrape_log` en TST/TSR; `cleanupTestRegistros` (helpers.js) barre `consumo_combustible` de `TEST_PLANTA`. | `npm run test:residuos` → cero tras la suite |
| CA-29 | BIT-MODBD **2.5** (§4.9.1 ampliada: ownership completa, override 0, revertir, scrape manual y job, backfill, catálogo TST) + fila de changelog; BIT-RF **1.9** (RF-071 ingesta SIS + override/revertir + scrape manual) + fila de changelog. | revisión del gate O3 |
| CA-30 | `docs/architecture.md` (sección SIS: módulos, sweeper, job, CLI) y `docs/domain-glossary.md` (SIS, SIS-owned, override, `valor_sis`); `deploy/DEPLOY.md` con el runbook del backfill en prod. | revisión del gate O3 |
| CA-31 | `git rm -r js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32` + borrado de los 3 archivos sueltos; ningún archivo del repo referencia `js-scraper-carbon-g32/` salvo docs históricas (ADR). | `git grep js-scraper-carbon-g32` vacío fuera de `docs/decisions.md` |

## Detalles operativos confirmados
- **Ownership** (sin cambios, D-029): SIS-owned ⇔ `creado_por = SISTEMA AND (modificado_por IS NULL OR = SISTEMA)`; cualquier otra fila es humano-owned y el SIS solo le escribe la sombra `valor_sis`.
- **Override = humano-owned con `valor_sis` no nulo y `cantidad ≠ valor_sis`** (incluye el override a 0). `es_override` lo calcula el backend; el front no conoce el id de SISTEMA.
- **Vaciar** una celda con `valor_sis` no nulo = override a 0 (fila viva, `cantidad=0`, `modificado_por=humano`). Vaciar una celda sin `valor_sis` = DELETE (comportamiento D-027).
- **Revertir** devuelve la celda al SIS: `valor_sis>0` → `cantidad=valor_sis` y vuelve SIS-owned; `valor_sis=0` → DELETE (vacío ≡ 0). Gate `puede_crear` (colaborativo, no por autor: COMB no pasa por `canEditarRegistro`, D-049).
- **Mutex `sis-lock`** es de **proceso** (sweeper + job manual del mismo server). El CLI corre en otro proceso: su exclusión con el sweeper sigue siendo `--to ≤ hoy-2` (D-060).
- **Concurrencia** solo en la fase de fetch de `scrapeDia`; la escritura sigue siendo una sola transacción por día. El sweeper y el job manual usan `concurrencia=1`; el CLI la recibe por flag (tope 6).
- **Backfill**: dev durante O2 (L05, background, resumible); prod tras GATE-O2 con visto bueno explícito, desde este equipo, `DB_NAME=PortalG3 … --confirm-db PortalG3`, sin desplegar la rama. Solo se guardan celdas con carbón > 0; los días en cero quedan solo en `sis_scrape_log`.
- **Catálogo `'TST'`**: seed idempotente (MERGE por `(planta_id, codigo)`) espejo de GEC32 — `ALIM_1..8` (ALIMENTADOR, Ton, `cantidad_max` 25), `CALIZA` (Ton, 40), `ACPM` (Gal, 25000), `orden` 1..10, `activo=1`. Es un seed, **no** una migración con flag.
- **Sin cambios de DDL** ni de contrato cross-repo (`evento_dashboard`/dashboard intactos).
- **Fechas fijas de test**: mientras L06 no migre los tests a TST, todo test nuevo sobre GEC32 usa fechas anteriores a `2026-06-02` (primer dato real) y limpia solo esas fechas.
- Auto-refresco y gavela viven en el front; no hay WS nuevo.
