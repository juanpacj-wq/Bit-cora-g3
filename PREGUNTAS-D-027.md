# Preguntas y respuestas — Consumos de Combustibles (D-027)

**Fecha:** 2026-05-20
**Plan asociado:** `C:\Users\jcespedes\.claude\plans\si-hagamos-un-plan-floating-wirth.md`
**Prompts secuenciales:** `prompts/D-027-combustibles-consumos/`
**Spec de origen:** `../carbon.md` (esquema de columnas pedido por el usuario).

Este documento registra las preguntas que tuve durante el diseño y las respuestas que diste. Si surge una nueva duda durante la ejecución de los prompts, agrégala al final.

---

## Decisiones cerradas

### Q1 — "Total Carbón": ¿se ingresa o se calcula?

**Decisión:** Calculado (suma de alimentadores).

Implicaciones:
- La tabla `bitacora.consumo_combustible` no tiene columna `total_carbon`.
- La vista `bitacora.v_consumo_periodo` deriva `total_carbon_ton = SUM(cantidad WHERE tipo='ALIMENTADOR')` por (planta, fecha, periodo).
- El frontend muestra una columna "TOTAL CARBÓN" read-only entre los alimentadores y caliza, calculada en vivo sobre el buffer.

### Q2 — Ventana temporal de edición

**Decisión:** Hoy o cualquier fecha pasada. Fecha futura rechazada (`400 fecha_futura`).

Implicaciones:
- Sin límite hacia atrás (a diferencia del default recomendado de 7 días). Esto permite reescritura arbitraria del histórico — trade-off aceptado.
- El selector de fecha del frontend tiene `max={today_Bogota}`.
- Backend valida `fecha <= hoy_Bogota` en `POST /api/combustibles/consumos`.

### Q3 — Permisos por cargo

**Decisión:**
- **Crear/editar:** `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno`.
- **Solo ver:** todos los demás cargos del catálogo (Operador Tablero, Operador Caldera, Ingeniero de Operación, Ingeniero Químico, Operador Maquinaria Pesada, Gerente de Producción, etc.).

Implicaciones:
- Reusa `lov_bit.cargo_bitacora_permiso` (no se introduce ruta de permisos paralela).
- Seed en `initDB()` insertando `puede_crear=1` para los 2 cargos privilegiados y `puede_crear=0` para el resto (todos `puede_ver=1`).

### Q4 — Auditoría por fila

**Decisión:** Solo `creado_por` / `modificado_por` / `creado_en` / `modificado_en`. Sin snapshots de personal del turno.

Implicaciones:
- La tabla `consumo_combustible` queda liviana (~50 rows/día × 2 plantas = ~100 rows/día = ~36k rows/año).
- Si en el futuro se necesita "quién más estaba en el turno", se puede agregar una columna JSON sin migración disruptiva (NULLable).

### Q5 — Cargo "Operador de planta - carbón y caliza"

**Decisión:** Ya existe en el catálogo real. Nombre exacto: **`Operador de Planta - Carbón y Caliza`**.

Confirmado vía `server/data/personal-2026.json`:
```
$ grep -oE '"cargo": "[^"]+"' server/data/personal-2026.json | sort -u
"cargo": "Gerente de Producción"
"cargo": "Ingeniero de Operación"
"cargo": "Ingeniero Jefe de Turno"
"cargo": "Ingeniero Químico"
"cargo": "Operador de Planta - Analista"
"cargo": "Operador de Planta - Caldera"
"cargo": "Operador de Planta - Carbón y Caliza"     ← ESTE
"cargo": "Operador de Planta - Planta de Agua"
"cargo": "Operador de Planta - Sala de Mando"
"cargo": "Operador de Planta - Turbogrupo"
"cargo": "Operador Maquinaria Pesada"
```

Usar este nombre exacto en el seed de permisos (no inventar variantes con/sin tilde o guion).

### Q6 — Administración del catálogo de combustibles

**Decisión:** Seed idempotente en `initDB()` (`seedCombustibles()`). Sin UI de admin CRUD.

Implicaciones:
- 18 entradas seedeadas (8 GEC3 + 10 GEC32) al primer arranque, idempotentes en arranques posteriores.
- Para agregar/quitar un combustible: editar el seed + redeploy. Cambia raramente; no justifica un CRUD admin hoy.

---

## Preguntas abiertas

Ninguna al cierre del diseño. Si surge alguna durante la ejecución de los prompts, agrégala acá con su respuesta:

```
### QN — <pregunta>

**Surgida en:** prompt 0X
**Estado:** abierta / resuelta
**Decisión:** ...
```
