# D-061 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive
> en `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito: el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero
| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Núcleo SIS: `planta_id` + `concurrencia`, `sis-lock`, `discover.js` | ✅ | `cierres/L01.md` (`939f1a8`, `ea8fcb8`) | GATE-O1 |
| O1 | L02 | Backend COMB: catálogo TST, GET con `valor_sis`, vaciar = override 0, revertir | ✅ | `cierres/L02.md` (`ada04b0`, `c69f791`) | GATE-O1 |
| O1 | L03 | Front: badge + tooltip + Revertir + auto-refresco con gavela + chip SIS | ✅ (CA-12/13 parciales → L08) | `cierres/L03.md` (`528b12d`, `882f3f8`) | GATE-O1 |
| — | GATE-O1 | 607/608 en verde, 0 violaciones, D1–D6, L08 nuevo | ✅ (visto bueno 2026-08-26 19:32) | | `GATE-O1.md` (`125e0c9`) |
| O2 | L04 | Scrape manual asíncrono (job + 202/409 + estado) + CA-36 | ✅ | `cierres/L04.md` (`8ed2d46`, `7bbf427`) | GATE-O2 |
| O2 | L05 | Backfill histórico (discover v2, `--concurrencia`, fixture, calibración, corrida dev) | ✅ | `cierres/L05.md` (`b3799b8`, `3c173fb`) | GATE-O2 |
| O2 | L06 | Higiene D-055 (tests a TEST_PLANTA incl. `sis_concurrencia`, guard, residuos, seed TST en helpers) | ✅ | `cierres/L06.md` (`1955c48`, `0c9b572`) | GATE-O2 |
| O2 | L08 | Correcciones del front COMB tras el code-review de la O1 | ✅ (CA-33/35 parciales → L09) | `cierres/L08.md` (`f14918b`, `9da067f`) | GATE-O2 |
| — | GATE-O2 | 632/632 en verde y 0 skips, 0 violaciones, D7–D10, L09 y L10 nuevos | ✅ (visto bueno 2026-08-26 23:11) | | `GATE-O2.md` (`eb9d00e`) |
| — | Backfill prod | Corrida contra `PortalG3` (2.996 días desde `2018-06-13`) | 🟡 en curso (PID 23504, arranque 2026-08-26 23:35, ETA ~3,3 días) | | `GATE-O2.md` §5 D10 |
| O3 | L09 | El refetch preservado no puede convertirse en un borrado al guardar (front) | ✅ (CA-37/39 parciales → L11) | `cierres/L09.md` (`2520640`, `fa25807`) | GATE-O3 |
| O3 | L10 | Endurecer el descubrimiento del SIS y la cobertura del scrape manual | ✅ (CA-42/44/46 parciales → L11) | `cierres/L10.md` (`2805869`, `8cf415c`) | GATE-O3 |
| — | GATE-O3 | 637/637 en verde, 0 violaciones, D11–D13, L11 nuevo con 3 altos | ✅ (visto bueno pendiente) | | `GATE-O3.md` |
| O4 | L11 | Cerrar las fronteras que dejaron abiertas L09 y L10 | ⬜ | — | — |
| O4 | L07 | Docs + cleanup (BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm) | ⬜ | — | — |
| — | GATE-O4 | | ⬜ | | `GATE-O4.md` |
| Cierre | — | ADR D-061 + CLAUDE.md conv. 35 + cross-ref D-060 + git rm scaffolding | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite
| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base `feat/integrar-asientos-D-059` @ `60c285e`, server efímero `:3199`, `PortalG3_dev`) | `ℹ tests 577 · suites 31 · pass 576 · fail 0 · skipped 1` (el skip es el parser sin fixture, lo cierra L05) · `npm run test:residuos` → cero | 28,0 min (1.683 s) |
| Referencia previa (merge `0a7015f`, 2026-08-25) | backend 572 en verde · vitest front 98/98 | |
| GATE-O1 (2026-08-26, rama @ `c69f791` + ediciones del gate, server efímero `:3199` sin `SKIP_INITDB`) | `ℹ tests 608 · suites 31 · pass 607 · fail 0 · skipped 1` (+31 = los enganchados) · vitest front **126/126** · `npm run build` ✓ · residuos cero | 30,3 min (1.816 s) |
| **GATE-O2** (2026-08-26, rama @ `3c173fb` + ediciones del gate; efímero `:3199` con `SIS_HOST` al stub y `SIS_SWEEPER_ENABLED=0`) | **`ℹ tests 632 · suites 31 · pass 632 · fail 0 · cancelled 0 · skipped 0 · todo 0`** (+24 y el único skip cerrado) · vitest front **160/160** · `npm run build` ✓ · residuos cero (script de 10 checks + query directa) | **58,0 min** (3.480 s — el backfill de dev escribía en la misma BD; sin esa competencia son ~30 min) |
| **GATE-O3** (2026-08-27, rama @ `8cf415c`; efímero `:3199` con `SIS_HOST` al stub y `SIS_SWEEPER_ENABLED=0`) | **`ℹ tests 637 · suites 31 · pass 637 · fail 0 · skipped 0`** (+5) · CA-45 aparte: 10/10 × 3 con el sweeper **encendido** · vitest front **201/201** · `npm run build` ✓ · residuos cero | **38,0 min** (2.277 s, con los **dos** backfills escribiendo: van por 2018–2019, días sin carbón y baratos de escribir) |
| GATE-O4 | | |

## Hechos descubiertos (acumulado, breve)
- 2026-08-26 (planeación): el SIS responde desde el equipo de desarrollo (~13 s/periodo, ~830 KB);
  historiador con datos reales al menos desde 2020-08 y todo en cero en 2016-08. El P24 y el
  `completo` ya están corregidos por D-060. Prod tiene 12 días sin fila en `sis_scrape_log`
  (06-10..06-27); dev 46. `D-029` en `decisions.md` es el rol Coordinador: la ingesta SIS nunca
  tuvo ADR (por eso D-061 la documenta completa).
- 2026-08-26 (GATE-O1, detalle en `GATE-O1.md` §6): `SKIP_INITDB=1` ahora resuelve los live
  bindings (antes dejaba COMB en 403); `'TST'` es una planta con SIS válida para `scrapeDia`
  (GEC3 es el "sin catálogo" estable); la fase de escritura cuesta ~12 s/día y la concurrencia
  no la baja; con `concurrencia>1` un periodo fallido re-pide el día completo; una tolva ≤ 0,5 t/h
  se lee como 0; `node --test` con varios archivos HTTP exige `--test-concurrency=1`; los tests de
  fecha del repo son ciegos a la TZ en equipos en Bogotá; `planta_invalida` ya existía en `auth.js`.
- 2026-08-26 (GATE-O2, detalle en `GATE-O2.md` §6): **GEC32 arranca en el SIS el `2018-06-13`**
  (58 sondeos, 0,13 MW y sin carbón; el primer carbón es del 2018-07-15) y el histórico son
  **2.996 días**, no ~1.100; la **concurrencia tolerada es 6** (~95 s/día real, RSS plano en 132 MB
  — la sospecha del gate O1 sobre el RSS queda descartada); el histórico tiene **huecos de más de
  60 días** (ago–oct 2018) que la ventana por defecto de `discover` no distingue del pre-inicio, así
  que `--from auto` es una **calibración de una sola vez**; el estado del job manual es **volátil**
  y la verdad persistente sigue siendo `sis_scrape_log`; el fixture `.xls` está versionado y su
  ausencia ya es un rojo (la suite quedó en `skipped 0`); **el orden de los archivos en el script
  `test` no es el orden de ejecución de `node --test`**; y la suite tarda ~58 min mientras el
  backfill escriba en la misma BD.
- 2026-08-27 (GATE-O3, detalle en `GATE-O3.md` §6): **`concurrencia 6` sostenida SÍ produce errores**
  (22 días de 331 en dev, 23 de 235 en prod) — no se pierde nada, pero **la corrida del backfill son
  DOS pasadas**, la segunda con `--solo-parciales`, y el criterio de terminado es
  `COUNT(*) WHERE completo=0` en cero, no que el proceso haya salido. **`npm test` a secas quedó
  ROJO** desde L10 (la guarda de CA-44 exige un `SIS_HOST` que el `.env` no trae). **CA-45 y
  `SIS_SWEEPER_ENABLED=0` no caben en el mismo backend**, y la pasada con el sweeper encendido
  ensucia la fila de hoy de GEC32 (medido: `ok=3` → `ok=0/err=8`; se auto-sana). El CLI tiene un
  código de salida nuevo (`4` = tope alcanzado) y `/sis/estado` devuelve `sweeper.habilitado`, que
  **ninguna pantalla consume**. Dos cierres seguidos sumaron mal su propio aporte de tests.
- 2026-08-26 (GATE-O2, code-review): el arreglo de L08 al latido dejó abierto el camino de vuelta
  —el snapshot se actualiza y el buffer no, así que el Guardar siguiente manda celdas que el
  operador nunca tocó— y `discover` v2 puede devolver una fecha de inicio equivocada sin decirlo
  (memoriza sondeos fallidos como vacíos, degenera la ventana del ancla a K=1 y no distingue
  "tope alcanzado" de "inicio hallado"). Ambos abren lote propio en O3 (L09 y L10).

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- **D1 (gate O1):** `consumos_combustible.test.js:330` acota el conteo del catálogo a `GEC3`/`GEC32`.
- **D2 (gate O1):** `SKIP_INITDB=1` ya no es "solo abre el pool": resuelve `USUARIO_SISTEMA_ID` y
  `COMB_BITACORA_ID`. `CLAUDE.md` y `server/migrations/README.md` lo corrigen en el cierre/L07.
- **D3:** `fecha_invalida` aplica también a GET/POST `/consumos` (aditivo, L02).
- **D5:** `plantaCombValida` conserva el conjunto explícito `{GEC3, GEC32, TST}` (contrato C4);
  el ADR matiza la conv. 28.
- **D7 (gate O2):** `server.js` gana `SIS_SWEEPER_ENABLED` — flag **de test**, no de producción; solo
  el valor exacto `'0'` apaga el sweeper y el apagado se anuncia en el log de arranque.
- **D8 (gate O2):** `POST /consumos` responde también `codigo: 'fecha_futura'`; el mensaje de
  `--from auto` del CLI pasó de voseo a tuteo.
- **D9 (gate O2):** el reparto cambia — **O3 = L09 + L10** (lotes de corrección del code-review) y
  **O4 = L07** (docs, que ahora depende también de ellos). Única enmienda de contrato autorizada:
  **C3** (`discoverEarliestDate` devuelve `{ fecha, motivo, sondeos }`) y el crecimiento aditivo de
  **C8** (`sweeper: { habilitado }`), ambas en L10.
- **D11 (gate O3):** el gate **no arregló nada de código** pese a tres hallazgos altos: los tres viven
  en territorio de lote y ninguno se cierra bien sin un test que lo fije.
- **D12 (gate O3):** **O4 = L11 + L07 en paralelo**. L11 no mueve ningún contrato (C3 y C8 quedan
  como los dejó L10), por eso L07 puede documentar al mismo tiempo.
- **D13 (gate O3):** el backfill son dos pasadas; los días con `err>0` se recuperan con
  `--solo-parciales`. Va al runbook de `DEPLOY.md` (L07).
- **Reparto acumulado:** O2 ganó **L08** (gate O1); L04 ganó `sis_endpoints.test.js` + CA-36; L06
  ganó `sis_concurrencia.test.js`; O3 ganó L09 y L10 (gate O2); O4 gana **L11** (gate O3).
- `db.js` exporta `seedCatalogoCombTest(db)` (gate O1) y el `MERGE` del seed TST lleva `HOLDLOCK`.
- Desviaciones aditivas de la O2 (ningún contrato roto): `plantaConSis()` es un helper nuevo y no un
  reúso de `plantaCombValida`; `iniciarScrapeJob` acepta un `log` opcional; los 400/409 del scrape
  llevan también `error` y `mensaje`; el CLI aborta si `--confirm-from` no coincide con un `--from`
  explícito; `discover.js` exporta además `addDays`, `diffDays` y `offsetsVentana`; `helpers.js`
  gana `ensurePlantaCombTest()`; `override.js` exporta 10 funciones en vez de 7.

## Bitácora
- 2026-08-26 · Fase 1 cerrada: 3 rondas + reparto congelados en `PREGUNTAS-D-061.md`.
- 2026-08-26 · Baseline de la suite corrido por el integrador (server efímero `:3199`, bajo test-lock `INT-baseline`): 576/577, 1 skip, cero residuos.
- 2026-08-26 · Fase 2: scaffolding + reservas (D-061, conv. 35, BIT-MODBD 2.5, BIT-RF 1.9,
  RF-071, sin migraciones) commiteados en `feat/sis-carbon-cierre-2026-08` (ver `git log`).
- 2026-08-26 · O1 ejecutada en tres chats paralelos (L01-1542, L02-1542, L03-1542), 15:42–16:35.
- 2026-08-26 · GATE-O1 (16:20–17:10, test-lock `GATE-O1`): suite 607/608 + vitest 126 + build;
  `/code-review` (15 hallazgos) y `/security-review` (sin hallazgos); D1–D6; L08 creado; prompts
  de O2 enmendados. Commit `125e0c9`. Visto bueno a las 19:32; O2 abierta (L04, L05, L06, L08).
- 2026-08-26 · O2 ejecutada en cuatro chats paralelos (L04-1938, L05-1938, L06-1938, L08-1939),
  19:38–20:46. L05 dejó **viva** la corrida del backfill de dev (PID 15424, `2018-06-13..2026-08-24`,
  ETA ~3,5 días); al cerrar el gate iba por 89 días de log sin un solo error de red.
- 2026-08-26 · GATE-O2 (20:50–22:05, test-lock `GATE-O2`): suite **632/632 con 0 skips** (58 min,
  efímero `:3199` con el stub del SIS y el sweeper apagado) + vitest **160/160** + build; residuos
  cero; `/code-review` (15 hallazgos, 2 de pérdida de datos confirmados a mano) y `/security-review`
  (sin hallazgos ≥ 0,7); D7–D10; **L09 y L10 creados**, L07 movido a O4; prompt de L07 enmendado.
  Commit `eb9d00e`. **Visto bueno a las 23:11; O3 abierta (L09, L10)** (`80c77a1`).
- 2026-08-26 23:35 · **Backfill de producción autorizado y lanzado** (D10): `PortalG3`,
  `2018-06-13..2026-08-24` (2.996 días), `--concurrencia 6`, **PID 23504**, log en
  `%LOCALAPPDATA%\Temp\bitacora-backfill\prod-2026-08.log`, ETA ~3,3 días. Arranque limpio
  (2018-06-13 en 24/24, 0 errores). Los dry-run previos confirmaron que el CLI **no reescribe** los
  74 días que prod ya tenía completos. Conteos finales: `/cerrar-implementacion`.
- 2026-08-27 · O3 ejecutada en dos chats paralelos (L09-2344, L10-2345), 23:44–00:20.
- 2026-08-27 · GATE-O3 (08:05–09:05, test-lock `GATE-O3`): suite **637/637 con 0 skips** (38 min) +
  CA-45 aparte con el sweeper encendido (10/10 × 3) + vitest **201/201** + build; residuos cero;
  `/code-review` (13 hallazgos, **3 altos** verificados dos veces: por el revisor y por el
  integrador); `/security-review` **no** se corrió y el gate deja escrito por qué (§3). D11–D13;
  **L11 creado** para O4, junto a L07; prompt de L07 enmendado (G2).
