# D-026 — Migración ER de DISP a `bitacora.disponibilidad_estado`

Prompts secuenciales para ejecutar en sesiones separadas de Claude Code (frescas, sin contexto compartido). Cada prompt es **autocontenido**: trae sus archivos clave, el shape esperado y las verificaciones de aceptación.

## Contexto base (lo que motiva todo)

DISP hoy vive en las tablas genéricas `bitacora.registro_activo` / `bitacora.registro_historico` con datos clave (`evento`, `codigo`, `fecha_inicio_estado`) embebidos en `campos_extra` JSON. Esto fuerza ~10 excepciones documentadas en `BIT-MODBD §7.8`. La auditoría concluyó que DISP es una máquina de estados con intervalos que no encaja en la abstracción "bitácora dinámica genérica". Cross-repo aún no consume DISP (F15 pendiente). Blast radius bajo.

**Objetivo:** mover DISP a una tabla dedicada `bitacora.disponibilidad_estado` + derivar acumulados por estado vía VIEW con window functions + reemplazar la tabla `bitacora.disponibilidad_dashboard` por una vista del vigente. **Sin cambiar el comportamiento observable de los endpoints HTTP, el frontend ni el contrato cross-repo.**

## Decisiones del usuario (resueltas)

Ver `../../PREGUNTAS-D-026.md` en la raíz del repo.

Resumen:
- Tabla `bitacora.disponibilidad_estado`, esquema existente.
- Acumulados por estado derivados via VIEW (window functions), no materializados.
- Tabla `disponibilidad_dashboard` → vista del vigente (preserva endpoint `GET /api/eventos-dashboard?tipo=DISP`).
- Backfill desde rows DISP de `registro_activo`+`registro_historico` + DELETE en origen (idempotente con flag `F26.A1`).
- Snapshot nuevo `gerentes_produccion_snapshot` (cargo='Gerente de Producción' con sesión activa global).
- DISP sale del histórico unificado de `HistoricoTable.jsx` (aceptado).
- 18 tests existentes se preservan sin cambio + 5 tests nuevos.

## Orden de ejecución (no alterar)

| # | Prompt | Toca | Output esperado |
|---|---|---|---|
| 01 | `01-schema-y-migracion.md` | `server/db.js` | DDL + backfill + vistas en `initDB()`, gateado por flag `F26.A1`. |
| 02 | `02-helpers-snapshots-y-notificador.md` | `server/utils/snapshots.js`, `server/utils/notificador.js` | Nueva función `snapshotGerentesProduccion`. Reemplazo de helpers DISP en `notificador.js`. |
| 03 | `03-refactor-post-y-put-disp.md` | `server/server.js` | Branch DISP de POST y PUT reescritos contra la nueva tabla. |
| 04 | `04-refactor-deshacer-y-gets.md` | `server/server.js` | Deshacer + 3 GETs reescritos. |
| 05 | `05-tests-nuevos.md` | `server/tests/disponibilidad.test.js` | 5 tests nuevos agregados; los 18 existentes deben pasar sin tocar. |
| 06 | `06-docs-y-cleanup.md` | `docs/decisions.md`, `BIT-MODBD-2026-001.md`, `CLAUDE.md`, `../docs/interfaces-cross-repo.md` | ADR D-026 + bump BIT-MODBD v1.7 + actualización CLAUDE.md + nota cross-repo. |

## Criterio global de éxito

Al final de los 6 prompts:

1. `cd server && node --test --env-file=../.env tests/disponibilidad.test.js` → 23 tests verde.
2. `cd server && node --test --env-file=../.env tests/` → suite completa sin regresión.
3. `GET /api/disponibilidad?planta_id=GEC3` antes y después del refactor devuelve mismo JSON (snapshot diff).
4. `GET /api/eventos-dashboard?tipo=DISP&planta_id=GEC3` devuelve mismo JSON.
5. `GET /api/disponibilidad/metricas?...` devuelve métricas idénticas (±1ms por timing).
6. Frontend DISP funciona idéntico (crear / editar / deshacer / paginación / counter live / popups 409).
7. `bitacora.registro_activo` y `bitacora.registro_historico` no tienen rows con `bitacora_id = <DISP>`.
8. Reiniciar el server: el bloque `F26.A1` no se re-ejecuta (gateado por flag).
