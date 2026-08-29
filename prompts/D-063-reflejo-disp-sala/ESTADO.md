# D-063 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Corto a propósito: el detalle está en los cierres y en los
> `GATE-On.md`.

## Tablero
| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Módulo de reflejo DISP en `reflejo-sala.js` (crear / actualizar / anular) | ✅ | `cierres/L01.md` (`f11b76b`, `a0cca57`) | GATE-O1 |
| O1 | L03 | Front: marcador `origen_bitacora` + estado "Anulado" (grilla + Históricos) | ✅ | `cierres/L03.md` (`e2216da`, `fd0f1af`) | GATE-O1 |
| O1 | L04 | Marcador universal `origen_bitacora`: helper + espejo SQL + 403 + F03 + guard | ✅ | `cierres/L04.md` (`478218c`, `4a1b184`) | GATE-O1 |
| — | GATE-O1 | 3 lotes · 666/666 backend · 319/319 front · 0 violaciones · CA-1…CA-9 `cumple` | ✅ (visto bueno pendiente) | | `GATE-O1.md` |
| O2 | L02 | Enganches DISP (POST/PUT/deshacer) + test HTTP sobre TSR + guard final | ⬜ | — | — |
| O2 | L05 | Docs: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture, glosario | ⬜ | — | — |
| O2 | L06 | Front + guard: tooltip honesto en copia anulada, helpers en `src/utils/reflejo.js`, stripper (GATE-O1 D7) | ⬜ | — | — |
| O2 | L07 | Módulo: reloj único, normalizador de id, rescate de huérfanos sin cota inferior (GATE-O1 D6/D7 — D6 con OK del usuario) | ⬜ | — | — |
| — | GATE-O2 | | ⬜ | | `GATE-O2.md` |
| Cierre | — | ADR D-063 + `CLAUDE.md` conv. 36 + `git rm` del scaffolding | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite
| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base `6d7e1e2`, cierre de D-061, 2026-08-27) | backend `641/641` · front `304/304` (documentado en el cierre de D-061; no se re-corrió) | ~40 min |
| GATE-O1 (2026-08-28) | backend **`666/666`** (9 bloques, efímero `:3199` con `initDB`, stub SIS) · front **`319/319`** · build ✓ · residuos 0 | ≈ 52 min |
| GATE-O2 | | |
| Cierre | | |

## Hechos descubiertos (acumulado, breve)
- Fase 2: **prod (`PortalG3`) no tiene F34.A1** (ni F32.A1/F33.A1): D-058 no está desplegado allá.
  D-063 sale a prod en el mismo despliegue; el cierre lo anota en el runbook.
- Fase 2: `TSR` está `activa=0` y la rama DISP exige `activa=1` → el test HTTP de L02 la enciende
  solo durante la corrida y un guard final la apaga (PREGUNTAS #4).
- GATE-O1: el CIET del sweeper MAND en `TST` escapaba de toda limpieza (H1) → arreglado en
  `cleanupTestRegistros` (D1). `JSON_MODIFY` reemplaza una clave existente sin fallar: la idempotencia
  de anular vive solo en el predicado SQL (L01). El predicado de las copias DISP compara texto con
  texto (`JSON_VALUE` es NVARCHAR). Los helpers del front del estado "Anulado" viven en
  `HistoricoTable.jsx` (D4). El 403 `asiento_reflejado` es origin-aware (payload C4).
- GATE-O1: la BD estuvo inalcanzable ≈ 20 min durante el gate (red/VPN); se esperó y se repitió la
  suite desde el inicio.

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- GATE-O1 D4: los helpers puros del front (`estadoReflejo`, `tituloAnulado`, `fechaHoraBogota`,
  `ChipAnulado`) viven en `HistoricoTable.jsx` y no en `src/utils/fecha.js` (que no tenía el
  formato); la regla D del guard acepta el import. Ver `GATE-O1.md` §5.
- GATE-O1: §3.2 del contexto citaba líneas de `registros.js` que L04 movió; las nuevas están en
  `GATE-O1.md` §6 y en la cabecera de L02.

## Bitácora
- 2026-08-28 · Fase 1 cerrada: 2 rondas + reparto (`PREGUNTAS-D-063.md`).
- 2026-08-28 · Fase 2 cerrada: scaffolding + reservas commiteados (`7b7154d`).
- 2026-08-28 · O1 abierta; 3 chats (L01, L03, L04), los tres `done` entre 18:16 y 18:41.
- 2026-08-28 · GATE-O1 (`1784703`): suite 666/666 + front 319/319 + residuos 0; D1 aplicado en `helpers.js`;
  prompts L02/L05 enmendados; a la espera del visto bueno para abrir O2.
