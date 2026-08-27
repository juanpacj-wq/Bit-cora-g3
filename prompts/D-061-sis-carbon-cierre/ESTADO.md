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
| — | GATE-O1 | 607/608 en verde, 0 violaciones, D1–D6, L08 nuevo | ✅ (visto bueno 2026-08-26 19:32) | | `GATE-O1.md` |
| O2 | L04 | Scrape manual asíncrono (job + 202/409 + estado) + CA-36 | ⬜ | — | — |
| O2 | L05 | Backfill histórico (discover v2, `--concurrencia`, fixture, calibración, corrida dev) | ⬜ | — | — |
| O2 | L06 | Higiene D-055 (tests a TEST_PLANTA incl. `sis_concurrencia`, guard, residuos, seed TST en helpers) | ⬜ | — | — |
| O2 | L08 | Correcciones del front COMB tras el code-review de la O1 (añadido en GATE-O1) | ⬜ | — | — |
| — | GATE-O2 | | ⬜ | | `GATE-O2.md` |
| — | Backfill prod | Corrida contra `PortalG3` (integrador, con visto bueno) | ⬜ | | `GATE-O2.md` §5 |
| O3 | L07 | Docs + cleanup (BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm) | ⬜ | — | — |
| — | GATE-O3 | | ⬜ | | `GATE-O3.md` |
| Cierre | — | ADR D-061 + CLAUDE.md conv. 35 + cross-ref D-060 + git rm scaffolding | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite
| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base `feat/integrar-asientos-D-059` @ `60c285e`, server efímero `:3199`, `PortalG3_dev`) | `ℹ tests 577 · suites 31 · pass 576 · fail 0 · skipped 1` (el skip es el parser sin fixture, lo cierra L05) · `npm run test:residuos` → cero | 28,0 min (1.683 s) |
| Referencia previa (merge `0a7015f`, 2026-08-25) | backend 572 en verde · vitest front 98/98 | |
| GATE-O1 (2026-08-26, rama @ `c69f791` + ediciones del gate, server efímero `:3199` sin `SKIP_INITDB`) | `ℹ tests 608 · suites 31 · pass 607 · fail 0 · skipped 1` (+31 = los enganchados) · recorrida `sis_endpoints`+`consumos_combustible` tras H4/H12: 31/31 · vitest front **126/126** · `npm run build` ✓ · residuos cero (script + query directa COMB/SIS) | 30,3 min (1.816 s) |
| GATE-O2 | | |
| GATE-O3 | | |

## Hechos descubiertos (acumulado, breve)
- 2026-08-26 (planeación): el SIS responde desde el equipo de desarrollo (~13 s/periodo, ~830 KB);
  historiador con datos reales al menos desde 2020-08 y todo en cero en 2016-08. El P24 y el
  `completo` ya están corregidos por D-060. Prod tiene 12 días sin fila en `sis_scrape_log`
  (06-10..06-27); dev 46. `D-029` en `decisions.md` es el rol Coordinador: la ingesta SIS nunca
  tuvo ADR (por eso D-061 la documenta completa).
- 2026-08-26 (GATE-O1, detalle en `GATE-O1.md` §6): `SKIP_INITDB=1` ahora resuelve los live
  bindings (antes dejaba COMB en 403); `'TST'` es una planta con SIS válida para `scrapeDia`
  (GEC3 es el "sin catálogo" estable); la fase de escritura cuesta ~12 s/día y la concurrencia
  no la baja (piso ≥ 3,7 h para ~1.100 días); con `concurrencia>1` un periodo fallido re-pide el
  día completo; una tolva ≤ 0,5 t/h se lee como 0 (fixtures con tolvas > 0,5); `node --test` con
  varios archivos HTTP exige `--test-concurrency=1`; los tests de fecha del repo son ciegos a la
  TZ en equipos en Bogotá; `planta_invalida` ya existía en `routes/auth.js`.
- 2026-08-26 (GATE-O1, code-review): los tests de SIS sobre GEC32 con fecha fija (`2026-04-16/17`)
  van a chocar con el backfill de L05 → L06 los migra a `TEST_PLANTA` antes del gate O2.

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- **D1 (gate O1):** `consumos_combustible.test.js:330` acota el conteo del catálogo a `GEC3`/`GEC32`
  (territorio L06 en O2, aplicado en el gate por ser un rojo conocido).
- **D2 (gate O1):** `SKIP_INITDB=1` ya no es "solo abre el pool": resuelve `USUARIO_SISTEMA_ID` y
  `COMB_BITACORA_ID` (dos SELECT). `CLAUDE.md` y `server/migrations/README.md` lo corrigen en el cierre/L07.
- **D3:** `fecha_invalida` aplica también a GET/POST `/consumos` (aditivo, L02).
- **D5:** `plantaCombValida` conserva el conjunto explícito `{GEC3, GEC32, TST}` (contrato C4);
  el ADR matiza la conv. 28.
- **Reparto:** O2 gana **L08** (corrección front, puro); L04 gana `sis_endpoints.test.js` + CA-36;
  L06 gana `sis_concurrencia.test.js` (+ CA-26/CA-28 ampliados); L07 depende también de L08.
- `db.js` exporta `seedCatalogoCombTest(db)` (gate O1) y el `MERGE` del seed TST lleva `HOLDLOCK`.
- `textoOverride(celda)` declara un solo parámetro (C11 listaba `ahora?` sin uso); `formatoMMSS`
  redondea hacia arriba (L03).

## Bitácora
- 2026-08-26 · Fase 1 cerrada: 3 rondas + reparto congelados en `PREGUNTAS-D-061.md`.
- 2026-08-26 · Baseline de la suite corrido por el integrador (server efímero `:3199`, bajo test-lock `INT-baseline`): 576/577, 1 skip, cero residuos.
- 2026-08-26 · Fase 2: scaffolding + reservas (D-061, conv. 35, BIT-MODBD 2.5, BIT-RF 1.9,
  RF-071, sin migraciones) commiteados en `feat/sis-carbon-cierre-2026-08` (ver `git log`).
- 2026-08-26 · O1 ejecutada en tres chats paralelos (L01-1542, L02-1542, L03-1542), 15:42–16:35.
- 2026-08-26 · GATE-O1 (16:20–17:10, test-lock `GATE-O1`): suite 607/608 + vitest 126 + build;
  `/code-review` (15 hallazgos) y `/security-review` (sin hallazgos); D1–D6; L08 creado; prompts
  de O2 enmendados. Commit `125e0c9` `gate(D-061): O1 cerrada — …`. Visto bueno dado a las 19:32; O2 abierta (L04, L05, L06, L08).
