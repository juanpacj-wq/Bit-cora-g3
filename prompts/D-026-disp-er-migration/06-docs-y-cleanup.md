# Prompt 06 — Docs + cleanup (D-026)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Pre-requisitos:** prompts 01–05 ya corridos. Suite de tests verde (23/23).

## Tu tarea

Actualizar la documentación del repo para reflejar la nueva arquitectura DISP:

(a) `docs/decisions.md` — agregar ADR `D-026`.
(b) `BIT-MODBD-2026-001.md` — bump a v1.7, nueva §4.8, actualizar §5.2 y §7.8.
(c) `CLAUDE.md` (raíz del subrepo) — actualizar convención crítica #4.
(d) `../docs/interfaces-cross-repo.md` — nota sobre el backend storage de DISP.

NO toques código en este prompt. Es solo docs.

## (a) `docs/decisions.md`

Agregar al final (antes del Apéndice si lo hay), siguiendo el formato ADR-lite (Contexto / Decisión / Consecuencias):

```markdown
## D-026 — DISP migrado a tabla dedicada con vista de acumulados

**Fecha:** 2026-05-20

**Contexto:** la auditoría detectó que DISP rompía ~10 invariantes del modelo "bitácora dinámica genérica" (turno NULL, `fecha_fin_estado` column DISP-only, filtered unique index, histórico mutable controlado, vista `v_disp_intervalos` para reconstruir intervalos, tabla puente `disponibilidad_dashboard` paralela, ~13 de 25 ADRs dedicados a DISP/MAND). DISP es semánticamente una **máquina de estados con intervalos** que no encaja en la abstracción "bitácora con `campos_extra` JSON". Cross-repo aún no consume DISP (F15 pendiente) → blast radius bajo, ventana de oportunidad para refactor.

**Decisión:** mover DISP a una tabla dedicada `bitacora.disponibilidad_estado` (PK `disponibilidad_id`, columnas tipadas `planta_id`, `estado`, `codigo`, `fecha_inicio_estado`, `fecha_fin_estado`, `detalle`, snapshots JSON `jdts/jefes_planta/gerentes_produccion/ingenieros`). Acumulados por estado derivados via vista `bitacora.v_disponibilidad_estado` con window functions (`SUM(...) OVER (PARTITION BY planta ORDER BY fecha_inicio_estado ROWS UNBOUNDED PRECEDING)`). La tabla `bitacora.disponibilidad_dashboard` se reemplaza por una VIEW del row vigente, preservando el contrato HTTP del endpoint `GET /api/eventos-dashboard?tipo=DISP` (F15). Migración idempotente F26.A1 hace backfill desde `registro_activo`/`registro_historico` y luego DELETE de los rows DISP en origen. Endpoints, frontend y contrato cross-repo quedan idénticos.

**Consecuencias:** (a) §7.8 de `BIT-MODBD` queda como referencia histórica — DISP ya NO rompe esos invariantes porque vive en su propia tabla. (b) Nueva columna `gerentes_produccion_snapshot` (cargo='Gerente de Producción' con sesión activa global) capturada en cada POST/PUT/deshacer. (c) Vista `v_disp_intervalos` dropeada (sustituida por la tabla plana). (d) HistoricoTable.jsx genérica ya no muestra DISP (aceptado por el usuario — DISP solo via mini-dashboard). (e) `jefes_snapshot` renombrado a `jefes_planta_snapshot` en la tabla; la vista `disponibilidad_dashboard` mapea el nombre legacy para compat cross-repo. (f) ~600 LoC en `server.js` simplificadas (~22% del archivo). Cross-ref: [[D-008]] [[D-009]] [[D-010]] [[D-011]] [[D-012]] [[D-024]].
```

## (b) `BIT-MODBD-2026-001.md`

### Bump de versión

En el header del archivo (líneas 1–13):

```markdown
| Versión | 1.7 |
| Fecha | 2026-05-20 |
```

Agregar bloque de cambios v1.7 (debajo del bloque v1.6 actual):

```markdown
> **Cambios v1.7 (2026-05-20) — Migración ER DISP (D-026):**
> - **Nueva §4.8** con DDL de `bitacora.disponibilidad_estado` (PK `disponibilidad_id`, columnas tipadas, filtered unique index `UQ_disp_estado_vigente_por_planta`, columnas Bogotá calculadas, vista `v_disponibilidad_estado` con acumulados via window functions). Reemplaza el storage DISP en `registro_activo`/`registro_historico` + `campos_extra` JSON.
> - **§5.2 `disponibilidad_dashboard`** ahora es una VIEW sobre `disponibilidad_estado` (filtra `fecha_fin_estado IS NULL`). Preserva shape para el endpoint `GET /api/eventos-dashboard?tipo=DISP` (F15). Mapea `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot` por compat.
> - **§7.8** marcada como referencia histórica — DISP ya NO rompe los invariantes ahí listados; vive en su propia tabla con su propio modelo.
> - **Vista `v_disp_intervalos` dropeada** (F26.A1) — la nueva tabla ya es plana, no requiere normalización extra.
> - **Cleanup**: rows DISP eliminados de `registro_activo`/`registro_historico`. La columna `fecha_fin_estado` en esas tablas queda como no-op para otras bitácoras.
```

### Nueva §4.8

Después de §4.7 (Conformación de turno), agregar sección con el DDL completo de `disponibilidad_estado` + vista. Copiá el DDL del prompt 01 (sección "DDL exacto"). Documentá:

- Invariantes (1 vigente por planta, no estados consecutivos iguales en N-1, etc.)
- Flujos transaccionales (POST, PUT, deshacer) — el storage es atómico, sin doble escritura.
- Cross-ref a §5.2 (la vista cross-repo) y [[D-026]] en decisions.
- Patrón idempotente F26.A1 en `db.js::initDB()`.

### Actualizar §5.2

Cambiar el texto inicial de "**Tabla** `bitacora.disponibilidad_dashboard`" a "**Vista** `bitacora.disponibilidad_dashboard`" y agregar nota:

```markdown
> **Cambio v1.7 (D-026):** `disponibilidad_dashboard` ahora es una VIEW sobre `bitacora.disponibilidad_estado` (§4.8). El shape se preserva para no romper el endpoint cross-repo `GET /api/eventos-dashboard?tipo=DISP` (F15 pendiente). Cualquier consumidor SQL directo (no hay ninguno hoy) sigue funcionando — la vista mapea `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot`.
```

### Marcar §7.8 como histórica

Al inicio de §7.8 agregar:

```markdown
> **Nota v1.7 (D-026):** esta sección queda como referencia histórica de F12–F14. DISP ya NO rompe los invariantes listados — vive en su propia tabla `bitacora.disponibilidad_estado` (§4.8). El refactor preservó el contrato HTTP, por lo que el comportamiento observable de los endpoints, el frontend y el cross-repo no cambió.
```

### Historial de versiones

Agregar fila a §8:

```markdown
| 1.7 | 2026-05-20 | Migración ER DISP (D-026). **Nueva §4.8** con DDL de `bitacora.disponibilidad_estado` + vista `v_disponibilidad_estado` (acumulados via window functions). §5.2 actualizada — `disponibilidad_dashboard` ahora es VIEW del vigente sobre la nueva tabla. §7.8 marcada como histórica. Vista `v_disp_intervalos` dropeada. Migración idempotente F26.A1 hace backfill + DELETE de rows DISP en `registro_activo`/`registro_historico`. Contratos HTTP y shape de response preservados (los 18 tests existentes pasan sin cambio). |
```

## (c) `CLAUDE.md` (raíz del subrepo `Bit-cora-g3/`)

### Actualizar convenciones críticas #4

Hoy dice:
```
4. **DISP es excepción a la inmutabilidad histórica**: PUT vigente DISP que cambia `fecha_inicio_estado` actualiza `N-1.fecha_fin_estado` en histórico. Documentado en D-011.
```

Cambiar por:
```
4. **DISP vive en `bitacora.disponibilidad_estado` (D-026, post-2026-05-20)**: tabla dedicada con `fecha_inicio_estado`/`fecha_fin_estado` tipadas (no via `campos_extra` JSON). Mantiene la regla de cierre cronológico: PUT del vigente que cambia `fecha_inicio_estado` actualiza también `N-1.fecha_fin_estado`. La "excepción a la inmutabilidad histórica" de D-011 ya no aplica porque DISP no vive en `registro_historico`. Acumulados por estado expuestos via vista `v_disponibilidad_estado` con window functions. La vista `disponibilidad_dashboard` (cross-repo, F15) preserva su shape.
```

### Actualizar sección "Bitácoras especiales"

Hoy dice:
```
- **DISP** (Disponibilidad) — `DisponibilidadDashboard.jsx`. Mini-dashboard con tabs GEC3/GEC32, counter live "tiempo en estado", historial paginado. Sin cierre de turno. 1 vigente por planta (filtered unique index). Cierre automático cuando llega nuevo evento.
```

Cambiar a:
```
- **DISP** (Disponibilidad) — `DisponibilidadDashboard.jsx`. Mini-dashboard con tabs GEC3/GEC32, counter live "tiempo en estado", historial paginado. Sin cierre de turno. Storage: tabla dedicada `bitacora.disponibilidad_estado` (D-026), 1 vigente por planta vía filtered unique index. Cierre automático cuando llega nuevo evento (UPDATE `fecha_fin_estado` del vigente + INSERT del nuevo en la misma transacción).
```

## (d) `../docs/interfaces-cross-repo.md`

En la sección que documenta el contrato DISP, agregar nota:

```markdown
> **Backend storage (D-026, 2026-05-20):** desde el 2026-05-20, DISP vive en `bitacora.disponibilidad_estado` (tabla dedicada). El endpoint `GET /api/eventos-dashboard?tipo=DISP&planta_id=` y `GET /api/disponibilidad/metricas` preservan su shape de response sin cambio (la vista `bitacora.disponibilidad_dashboard` que el endpoint lee es ahora derivada de la nueva tabla). Polling 60s recomendado para F15. Detalle: `bit-cora-g3/docs/decisions.md` D-026 y `BIT-MODBD-2026-001.md` §4.8.
```

## Verificación

```powershell
# Verificar que los docs renderean
# (visualmente en VS Code o cualquier markdown viewer)

# Smoke check final del sistema:
cd server
node --test --env-file=../.env tests/

# Esperado: TODOS los tests (no solo disponibilidad) pasan
# Si algo falla en otros archivos (auth, sala_de_mando, etc.), NO está relacionado
# con esta migración — investigar por separado.
```

## Lo que NO hagas en este prompt

- NO toques código (`server.js`, `db.js`, `utils/`, `tests/`).
- NO modifiques nada fuera de los 4 archivos listados.
- NO renombres archivos.
- NO crees nuevos ADRs además del D-026.

## Al finalizar

Listar los 4 archivos modificados en el commit. Mensaje sugerido:

```
docs(disp): D-026 + BIT-MODBD v1.7 + CLAUDE.md + cross-repo

Documenta la migración ER de DISP a bitacora.disponibilidad_estado:
- ADR D-026 (Contexto/Decisión/Consecuencias)
- BIT-MODBD §4.8 nueva, §5.2 actualizada, §7.8 histórica
- CLAUDE.md convención #4 + sección "Bitácoras especiales"
- ../docs/interfaces-cross-repo.md nota sobre backend storage

Contrato HTTP preservado — sin impacto en frontend ni cross-repo.
```
