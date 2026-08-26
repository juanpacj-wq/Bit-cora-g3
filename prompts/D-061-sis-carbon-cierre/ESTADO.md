# D-061 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive
> en `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito: el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero
| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Núcleo SIS: `planta_id` + `concurrencia`, `sis-lock`, `discover.js` | ⬜ | — | — |
| O1 | L02 | Backend COMB: catálogo TST, GET con `valor_sis`, vaciar = override 0, revertir | ⬜ | — | — |
| O1 | L03 | Front: badge + tooltip + Revertir + auto-refresco con gavela + chip SIS | ⬜ | — | — |
| — | GATE-O1 | | ⬜ | | `GATE-O1.md` |
| O2 | L04 | Scrape manual asíncrono (job + 202/409 + estado) | ⬜ | — | — |
| O2 | L05 | Backfill histórico (discover v2, `--concurrencia`, fixture, calibración, corrida dev) | ⬜ | — | — |
| O2 | L06 | Higiene D-055 (tests a TEST_PLANTA, guard, residuos) | ⬜ | — | — |
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
| GATE-O1 | | |
| GATE-O2 | | |
| GATE-O3 | | |

## Hechos descubiertos (acumulado, breve)
- 2026-08-26 (planeación): el SIS responde desde el equipo de desarrollo (~13 s/periodo, ~830 KB);
  historiador con datos reales al menos desde 2020-08 y todo en cero en 2016-08. El P24 y el
  `completo` ya están corregidos por D-060. Prod tiene 12 días sin fila en `sis_scrape_log`
  (06-10..06-27); dev 46. `D-029` en `decisions.md` es el rol Coordinador: la ingesta SIS nunca
  tuvo ADR (por eso D-061 la documenta completa).

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- (ninguna todavía)

## Bitácora
- 2026-08-26 · Fase 1 cerrada: 3 rondas + reparto congelados en `PREGUNTAS-D-061.md`.
- 2026-08-26 · Baseline de la suite corrido por el integrador (server efímero `:3199`, bajo test-lock `INT-baseline`): 576/577, 1 skip, cero residuos.
- 2026-08-26 · Fase 2: scaffolding + reservas (D-061, conv. 35, BIT-MODBD 2.5, BIT-RF 1.9,
  RF-071, sin migraciones) commiteados en `feat/sis-carbon-cierre-2026-08` (ver `git log`).
