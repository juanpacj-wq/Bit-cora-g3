# Preguntas y respuestas — Migración ER DISP (D-026)

**Fecha:** 2026-05-20
**Plan asociado:** `C:\Users\jcespedes\.claude\plans\si-hagamos-un-plan-floating-wirth.md`
**Prompts secuenciales:** `prompts/D-026-disp-er-migration/`

Este documento registra las preguntas que tuve durante el diseño del refactor de DISP y las decisiones que tomaste. Si más adelante surge una nueva duda durante la ejecución, agrégala acá con su respuesta — el plan y los prompts deben permanecer alineados.

---

## Decisiones cerradas

### Q1 — Semántica de las 4 columnas "horas en X"

**Decisión:** acumulado de cada estado hasta `fecha`. Es decir, cada row expone 4 contadores running totals (todas las horas de la planta en cada estado hasta el inicio del intervalo del row), inclusive incorporando la duración del intervalo del propio row.

**Refinamiento técnico (Q5):** los acumulados se derivan vía VIEW con window functions (`SUM(...) OVER (PARTITION BY planta ORDER BY fecha_inicio_estado ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`). No se materializan en la tabla base. Cero mantenimiento; imposible desincronizar.

---

### Q2 — ¿Qué pasa con `bitacora.disponibilidad_dashboard`?

**Decisión:** reemplazarla por una VIEW que devuelve el row vigente por planta desde `bitacora.disponibilidad_estado`. Preserva el contrato del endpoint `GET /api/eventos-dashboard?tipo=DISP&planta_id=` (consumido por dashboard-gen-gec3 F15, pendiente). El handler de ese endpoint NO se toca.

---

### Q3 — Nombre y esquema de la tabla nueva

**Decisión:** `bitacora.disponibilidad_estado`. Esquema `bitacora` ya en uso; nombre describe la entidad (cada fila es un estado de disponibilidad).

---

### Q4 — Snapshot "gerente en turno"

**Decisión:** corresponde al **cargo "Gerente de Producción"** (no al `es_jefe_planta=1`). Nueva columna `gerentes_produccion_snapshot` en la tabla. Snapshot capturado en cada POST/PUT/deshacer.

Adicional (Q9): el filtro es "Gerentes con sesión activa global" — cargo='Gerente de Producción' AND `sesion_activa.activa=1`, sin filtrar por planta (los gerentes son rol global). Coincide con el patrón actual del CIET 'Deshacer disponibilidad'.

Nota: la columna `jefes_snapshot` actual (es_jefe_planta=1, Ernesto Muñoz) se preserva renombrada a `jefes_planta_snapshot` en la tabla nueva.

---

### Q5 — Acumulados materializados vs derivados via vista

**Decisión:** VIEW con window functions (ver Q1).

---

### Q6 — Datos existentes en `registro_activo`+`registro_historico` para DISP

**Decisión:** backfill al `bitacora.disponibilidad_estado` + DELETE de rows DISP en las tablas viejas. Migración idempotente gateada por flag `F26.A1` en `bitacora.migracion_aplicada`. Si el conteo backfill ≠ origen, ROLLBACK + RAISERROR (sin marcar flag → reintenta al siguiente arranque).

---

### Q7 — Significado de la columna `fecha`

**Decisión:** la fecha del cambio de estado (`fecha_inicio_estado`). Como un cambio de estado marca también la fecha fin del estado anterior, ambas columnas viven en la tabla: `fecha_inicio_estado` y `fecha_fin_estado`. Adicional: la fecha de creación del registro vive en `creado_en` (separada — auditoría de cuándo se hizo el INSERT, no cuándo ocurrió el cambio físico en planta).

La vista `v_disponibilidad_estado` expone `fecha_inicio_estado` como alias `fecha` y `creado_en` como `fecha_creacion`.

---

### Q8 — Cobertura de tests

**Decisión:** mantener los 18 tests existentes sin cambio (validan que el contrato HTTP se preserva) + agregar 5 nuevos:

1. `backfill_idempotente`
2. `vista_acumulados_intervalos_cerrados`
3. `vista_acumulados_incluye_vigente_hasta_now`
4. `deshacer_restaura_vigente_y_acumulados`
5. `disponibilidad_dashboard_vista_devuelve_vigente`

Si algún test existente falla durante la migración, es regresión de contrato — corregir el handler, no el test.

---

### Q9 — Snapshot de Gerentes de Producción: criterio

**Decisión:** sesión activa global (ver Q4 ampliado).

---

### Q10 — DISP en el histórico unificado de `HistoricoTable.jsx`

**Decisión:** DISP sale del histórico unificado. El operador consulta DISP solo desde su mini-dashboard (`GET /api/disponibilidad`). La vista `v_historico_busqueda` NO se extiende; no se hace UNION.

Trade-off aceptado: pierdes la vista cross-bitácora donde DISP aparecía mezclado con CIET/CAL/etc. A cambio, sale completamente de las tablas genéricas y queda en su propio storage limpio.

---

### Q11 — Tests existentes que introspecccionan storage interno DISP

**Surgida en:** verificación post-prompt 05 (2026-05-20).
**Estado:** resuelta.

**Contexto:** Q8 fijó "18 tests existentes sin cambio". Al correr la suite post-migración, 4 de esos 18 (tests 1, 2, 6, 7) fallan porque sus aserciones queryean directamente `bitacora.registro_activo` y `bitacora.registro_historico` filtrando por `bitacora_id = DISP`. Post-F26.A1 ninguna fila DISP vive en esas tablas (DELETE durante el backfill), así que los `COUNT(*)` retornan 0 y los `SELECT TOP 1 ... recordset[0]` quedan undefined.

La premisa de Q8 ("los tests validan contrato HTTP") era inexacta: 4 tests introspeccionan storage. La nota "regresión de contrato → corregir handler, no test" no aplica porque el handler está bien — el storage interno se movió por definición de la migración.

**Decisión:** actualizar las 4 queries internas a `bitacora.disponibilidad_estado` con la equivalencia:

| Query vieja | Query nueva |
|---|---|
| `FROM registro_activo WHERE bitacora_id=DISP AND fecha_fin_estado IS NULL` | `FROM disponibilidad_estado WHERE fecha_fin_estado IS NULL` |
| `FROM registro_historico WHERE bitacora_id=DISP` | `FROM disponibilidad_estado WHERE fecha_fin_estado IS NOT NULL` |
| `registro_id` | `disponibilidad_id` |
| `ORDER BY fecha_evento DESC` (N-1) | `ORDER BY fecha_inicio_estado DESC` |

Las aserciones de comportamiento (códigos HTTP, shape del response, lado-efecto sobre `disponibilidad_dashboard`) se preservan tal cual. Resultado: 23/23 verde.

**Footnote a Q8:** "18 tests sin cambio" se enmienda a "14 sin cambio + 4 con swap del FROM/WHERE para apuntar al nuevo storage; 0 cambios de intent ni de aserciones HTTP".

---

## Preguntas abiertas

Ninguna al cierre del diseño. Si surge una durante la ejecución de los prompts, agregarla acá:

```
### QN — <pregunta>

**Surgida en:** prompt 0X
**Estado:** abierta / resuelta
**Decisión:** ...
```
