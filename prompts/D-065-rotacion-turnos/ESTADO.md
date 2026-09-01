# D-065 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito: el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero

| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Motor puro del patrón de rotación | ⬜ | — | — |
| O1 | L02 | Schema `F37.A1` + flag de cargo `F37.A2` | ⬜ | — | — |
| O1 | L03 | Cliente de Graph y sincronización del directorio | ⬜ | — | — |
| — | **GATE-O1** | | ⬜ | | `GATE-O1.md` |
| O2 | L04 | Endpoints de configuración anual | ⬜ | — | — |
| O2 | L05 | Toma de control del rol (backend) | ⬜ | — | — |
| O2 | L06 | Cumplimiento y congelado al cerrar | ⬜ | — | — |
| — | **GATE-O2** | | ⬜ | | `GATE-O2.md` |
| O3 | L07 | Pantalla de configuración anual | ⬜ | — | — |
| O3 | L08 | Popup de toma de control | ⬜ | — | — |
| O3 | L09 | Vista de cumplimiento | ⬜ | — | — |
| — | **GATE-O3** | | ⬜ | | `GATE-O3.md` |
| O4 | L10 | Cableado en el componente raíz y rutas hash | ⬜ | — | — |
| — | **GATE-O4** | | ⬜ | | `GATE-O4.md` |
| Cierre | — | ADR D-065 + `CLAUDE.md` 38 + BIT-MODBD v2.8 + BIT-RF v2.4/RF-079 + `git rm` | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite

| Momento | Resultado | Duración |
|---|---|---|
| Rama base `feat/integrar-asientos-D-059` (heredado de GATE-O2 de D-063, `9dfbbe3`, 2026-08-29) | backend **681/681** · front **324/324** · 0 violaciones | ~40 min backend |
| Antes de O1 (medición propia) | **pendiente — la corre el GATE-O1** | |
| GATE-O1 | | |
| GATE-O2 | | |
| GATE-O3 | | |
| GATE-O4 | | |

> **Por qué el baseline propio quedó pendiente y no es una omisión:** al cerrar la fase 2 (2026-08-31
> 21:30 Bogotá) había una sesión de `/cerrar-implementacion D-064` corriendo la suite completa en el
> árbol principal, con el **test-lock tomado** (`CIERRE-D064`, TTL 45 min). Correr la suite en
> paralelo la habría contaminado. El baseline heredado de D-063 es el punto de comparación válido
> —la rama base no ha cambiado desde ese gate salvo dos commits de `docs/`— y el GATE-O1 establece
> la medición propia bajo el lock.

## Hechos descubiertos (acumulado, breve)

- **Fase 2:** la cuadrilla OPS del Excel **cambia todos los meses** (69 de 308 celdas al año);
  la de ING no cambia ni una vez en 12. De ahí sale el modelo de asignación con vigencia.
- **Fase 2:** Entra ID ya aporta **persona + rol** para 81 personas en roles de rotación; lo único
  que falta es el grupo G1–G4. La cuadrilla del Excel calza en 71 de 81.
- **Fase 2:** el desfase **no se puede derivar de `grupo_t1` solo** — `V1` toma 4 valores distintos
  en 8 índices. Hacen falta los grupos de T1 **y** T2 del día de inicio.
- **Fase 2:** el grupo de Entra `ADMINISTRADOR Y DEBUGGING` está **vacío**, y es uno de los dos
  cargos que podrán configurar la malla. Hoy el único que puede usar la superficie A es el
  Gerente de Producción. Va al runbook del cierre.
- **Fase 2:** prod tiene **13 personas duplicadas** en `lov_bit.usuario` (fila legacy + fila Entra).
  Preexistente, **fuera de alcance**; el módulo se defiende trabajando solo sobre filas con
  `azure_oid`.

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`

- *(ninguna todavía)*

## Bitácora

- **2026-08-31** · Fase 1 cerrada: 5 rondas de preguntas (incluida una ronda 0 de vocabulario y una
  ronda 4 de corrección del eje del modelo, de "área" a **rol**). 23 criterios de aceptación
  congelados en `PREGUNTAS-D-065.md`.
- **2026-08-31** · Fase 2 cerrada: scaffolding + reservas commiteados. Rama
  `feat/rotacion-turnos-2026-08` creada desde `feat/integrar-asientos-D-059` (`5cc84a2`) **en un
  worktree temporal**, porque el árbol principal tenía una sesión de cierre de D-064 corriendo la
  suite. El usuario hace `git checkout feat/rotacion-turnos-2026-08` en el árbol principal cuando esa
  sesión termine, antes de abrir los chats de la O1.
