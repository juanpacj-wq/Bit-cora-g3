# D-064 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito; el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero

| Ola | Lote | Título | Repo | Estado | Cierre | Gate |
|---|---|---|---|---|---|---|
| O1 | L01 | Persistir la llegada del despacho | `dashboard-gen-gec3` | ⬜ | — | — |
| O1 | L02 | Motor del asiento de sistema (puro) | `Bit-cora-g3` | ⬜ | — | — |
| O1 | L03 | Tipo de evento (`F36.A1`) y colapso en el libro | `Bit-cora-g3` | ⬜ | — | — |
| — | **GATE-O1** | | | ⬜ | | `GATE-O1.md` |
| O2 | L04 | Lector, creador del asiento y barrido | `Bit-cora-g3` | ⬜ | — | — |
| O2 | L05 | CLI del relleno del mes | `Bit-cora-g3` | ⬜ | — | — |
| — | **GATE-O2** | | | ⬜ | | `GATE-O2.md` |
| Cierre | — | ADR D-064 + `CLAUDE.md` 37 + `BIT-MODBD` v2.7 + `BIT-RF` v2.3/RF-078 + REQ-05 + `git rm` | | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite

| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base) | **681/681 backend · 324/324 front · 0 violaciones** — heredado del gate O2 de D-063 (`9dfbbe3`, 2026-08-29), sobre la rama que se mergeó a `feat/integrar-asientos-D-059`. No se volvió a correr en planeación. | ~40 min |
| GATE-O1 | | |
| GATE-O2 | | |

> **Deuda conocida de la base, no la confundas con una regresión:** `npm test` a secas contra un
> efímero **sin `SIS_HOST`** deja rojos los 5 casos del scrape manual (convención 35). Si aparecen,
> son de la base, no de este flujo.

## Hechos descubiertos (acumulado, breve)

- **Planeación (2026-08-31):** `asientoLiteralSala` habría prefijado la unidad al texto literal
  (`UNIDAD_YA_NOMBRADA` no matchea `"Se recibe del XM…"`), rompiendo CA-2. De ahí el marcador
  `origen_sistema` y el colapso de L03.
- **Planeación (2026-08-31):** el esquema `dashboard` **es visible** con las credenciales de
  Bitácora (query a `sys.schemas`), y `dashboard.despacho_recibido` **no existe**. Confirma la
  premisa de REQ-05 §5.1: la comunicación es por BD, sin endpoint nuevo.
- **Planeación (2026-08-31):** CA-11 (nadie edita el asiento) **sale gratis** de D-049
  (`canEditarRegistro` exige autoría y `SISTEMA` nunca tiene sesión). `permissions.js` **no se
  toca** en toda la implementación: se verifica, no se implementa.

## Desviaciones acumuladas respecto a `REQ-05` / `_CONTEXTO-BASE.md`

- **Planeación D1 — cuatro filas en vez de dos.** RQ-05.8/RQ-05.10 dicen "un registro en `SALAJDT`
  y otro en `SALAING`" / "las dos filas"; se implementan **cuatro** (las dos bitácoras × las dos
  plantas) para que el asiento sea visible en la Sala de las dos unidades. El espíritu de RQ-05.5
  se conserva: un solo texto, un solo renglón en el libro. **El cierre actualiza el REQ.**
  Ver `PREGUNTAS-D-064.md` § Desviaciones.

## Bitácora

- **2026-08-31** · Fase 1 cerrada: dos rondas, 7 preguntas, todas congeladas en
  `PREGUNTAS-D-064.md`. El REQ-05 llegó sin preguntas abiertas, así que las rondas fueron solo de
  decisiones de implementación.
- **2026-08-31** · Fase 2 cerrada: scaffolding + reservas commiteados. Rama
  `feat/asiento-despacho-xm-2026-08` en los **dos** repos (Bitácora desde
  `feat/integrar-asientos-D-059` `5cc84a2`; dashboard desde `main` `d8f8f5e`).
  `docs/interfaces-cross-repo.md` del umbrella actualizado **antes** de la O1.
- **2026-08-31** · O1 abierta con 3 chats (L01, L02, L03).
