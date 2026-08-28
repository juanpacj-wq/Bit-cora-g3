# D-063 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Corto a propósito: el detalle está en los cierres y en los
> `GATE-On.md`.

## Tablero
| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Módulo de reflejo DISP en `reflejo-sala.js` (crear / actualizar / anular) | ⬜ | — | — |
| O1 | L03 | Front: marcador `origen_bitacora` + estado "Anulado" (grilla + Históricos) | ⬜ | — | — |
| O1 | L04 | Marcador universal `origen_bitacora`: helper + espejo SQL + 403 + F03 + guard | ⬜ | — | — |
| — | GATE-O1 | | ⬜ | | `GATE-O1.md` |
| O2 | L02 | Enganches DISP (POST/PUT/deshacer) + test HTTP sobre TSR + guard final | ⬜ | — | — |
| O2 | L05 | Docs: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture | ⬜ | — | — |
| — | GATE-O2 | | ⬜ | | `GATE-O2.md` |
| Cierre | — | ADR D-063 + `CLAUDE.md` conv. 36 + `git rm` del scaffolding | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite
| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base `6d7e1e2`, cierre de D-061, 2026-08-27) | backend `641/641` · front `304/304` (documentado en el cierre de D-061; no se re-corrió) | ~40 min |
| GATE-O1 | | |
| GATE-O2 | | |
| Cierre | | |

## Hechos descubiertos (acumulado, breve)
- Fase 2: **prod (`PortalG3`) no tiene F34.A1** (ni F32.A1/F33.A1): D-058 no está desplegado allá.
  D-063 sale a prod en el mismo despliegue; el cierre lo anota en el runbook.
- Fase 2: `TSR` está `activa=0` y la rama DISP exige `activa=1` → el test HTTP de L02 la enciende
  solo durante la corrida y un guard final la apaga (PREGUNTAS #4).

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- (ninguna todavía)

## Bitácora
- 2026-08-28 · Fase 1 cerrada: 2 rondas + reparto (`PREGUNTAS-D-063.md`).
- 2026-08-28 · Fase 2 cerrada: scaffolding + reservas commiteados (sha en el commit de scaffolding).
- 2026-08-28 · O1 abierta; el usuario abre 3 chats (L01, L03, L04).
