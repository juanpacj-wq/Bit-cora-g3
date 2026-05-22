# Prompt 06 — Docs (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Pre-requisitos:** prompts 01–05 corridos. Tests verde.

## Tu tarea

Documentar la nueva funcionalidad de Consumos de Combustibles:

(a) `docs/decisions.md` — ADR `D-027`.
(b) `BIT-MODBD-2026-001.md` — bump v1.8, nueva §2.7 (catálogo) y §4.9 (transaccional + vista).
(c) `CLAUDE.md` (raíz subrepo) — agregar entrada en "Bitácoras especiales" y nueva convención crítica #11.

NO toques código.

## (a) `docs/decisions.md`

Agregar al final (antes del Apéndice si lo hay):

```markdown
## D-027 — Ingesta de Consumos de Combustibles (pestaña Combustibles → Consumos)

**Fecha:** 2026-05-20

**Contexto:** la operación necesita registrar el consumo diario-horario de carbón (por alimentador), caliza y ACPM en cada planta para alimentar reportes regulatorios y de eficiencia. No es una bitácora (no hay estado ni cierre de turno); es un report numérico estructurado por (planta, fecha, periodo). El esquema es asimétrico entre plantas: GEC3 tiene 6 alimentadores nombrados (A–F) y GEC32 tiene 8 numerados (1–8), más caliza y ACPM en ambas. La spec original (`carbon.md`) lista las columnas pedidas.

**Decisión:** modelar como pestaña nueva categoría jerárquica "Combustibles" en el sidebar, con un solo ítem "Consumos" por ahora. Storage en tablas dedicadas siguiendo el patrón híbrido que [[D-026]] establece para DISP: fila marcadora en `lov_bit.bitacora` (codigo `COMB`) para reusar permisos+sidebar+routing, pero datos en tablas propias — catálogo `lov_bit.combustible(planta_id, codigo, nombre, unidad, tipo, orden, activo)` y transaccional `bitacora.consumo_combustible(planta_id, fecha, periodo, combustible_id, cantidad, ...)` en formato long (1 fila por celda) para soportar el catálogo dinámico por planta. Vista `bitacora.v_consumo_periodo` deriva el formato wide para reportes/dashboard y calcula `total_carbon_ton = SUM(tipo='ALIMENTADOR')` sin duplicar storage. Permisos: crean `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno`; resto solo ven. Ventana de edición: fecha pasada o hoy; futuro rechazado con `400 fecha_futura`. Auditoría liviana: solo `creado_por`/`modificado_por` (sin snapshots de personal). Migración idempotente `F26.B1` en `initDB()` crea tablas + vista + 18 seeds de combustibles + fila bitácora COMB + permisos seedeados.

**Consecuencias:** (a) categoría jerárquica del sidebar gana una entrada (extensible — futuros ítems pueden agruparse acá). (b) `SIN_BADGE_CODIGOS` se extiende con `'COMB'` (consumos no tiene "pendientes"). (c) Header (`BarraEstado`) tratamiento equivalente a MAND: oculta filtros F11 + botones de turno/cierre — el botón Guardar vive dentro del propio `ConsumosGrid`. (d) Para agregar/quitar un combustible: editar `db.js::seedCombustibles()` + redeploy. Sin UI admin (cambia raramente). (e) `modificado_por` se actualiza solo si `cantidad` cambió, no si solo cambió `detalle` — paridad con [[D-019]] de MAND. Cross-ref: [[D-021]] (categorías hardcoded), [[D-022]] (SIN_BADGE_CODIGOS), [[D-026]] (patrón híbrido bitácora marcadora + tabla propia).
```

## (b) `BIT-MODBD-2026-001.md`

### Bump de versión

Header (líneas 1–13):
```markdown
| Versión | 1.8 |
| Fecha | 2026-05-20 |
```

Agregar bloque de cambios debajo del bloque v1.7:

```markdown
> **Cambios v1.8 (2026-05-20) — Consumos de Combustibles (D-027):**
> - **Nueva §2.7 `lov_bit.combustible`** — catálogo por planta (planta_id, codigo, nombre, unidad, tipo, orden, activo). 18 seeds (8 GEC3 + 10 GEC32). Tipo discriminador `ALIMENTADOR/CALIZA/ACPM` usado por la vista `v_consumo_periodo` para derivar Total Carbón.
> - **Nueva §4.9 `bitacora.consumo_combustible`** — transaccional long-format (1 fila por celda planta+fecha+periodo+combustible), `cantidad DECIMAL(12,3)`, auditoría `creado_por/modificado_por`. UNIQUE compuesto previene duplicados. Vista `v_consumo_periodo` pivotea por (planta, fecha, periodo) y suma `total_carbon_ton = SUM(tipo='ALIMENTADOR')`, `caliza_ton`, `acpm_gal`.
> - **§2.4 `lov_bit.bitacora`** gana una fila más: `codigo='COMB'`, `nombre='Consumos'`, `icono='Flame'`, `formulario_especial=1`, `orden=11`. Reusa el sistema de permisos en `cargo_bitacora_permiso` sin código nuevo.
> - **Migración `F26.B1`** idempotente en `db.js::initDB()`: tablas + vista + seeds + permisos.
```

### Nueva §2.7

Después de §2.6 (permisos), agregar sección completa con:
- DDL de `lov_bit.combustible` (copiar del prompt 01).
- Lista de 18 seeds.
- Notas: catálogo es estable; cambios via redeploy del seed.

### Nueva §4.9

Después de §4.8 (DISP, post-D-026), agregar sección con:
- DDL de `bitacora.consumo_combustible` (copiar del prompt 01).
- DDL de la vista `v_consumo_periodo`.
- Flujo transaccional del POST batch: validaciones, UPSERT por celda, regla de `modificado_por` solo si cantidad cambió.
- Cross-ref a [[D-027]] en decisions.

### Historial de versiones

Agregar fila a §8:

```markdown
| 1.8 | 2026-05-20 | Consumos de Combustibles (D-027). **Nueva §2.7** `lov_bit.combustible` (catálogo por planta, 18 seeds). **Nueva §4.9** `bitacora.consumo_combustible` (long-format transaccional) + vista `v_consumo_periodo` con Total Carbón derivado. §2.4 gana fila `COMB`. Permisos: `Operador de Planta - Carbón y Caliza` + JdT crean; resto ven. Migración idempotente F26.B1. Endpoints `GET /api/combustibles/catalogo`, `GET /api/combustibles/consumos`, `POST /api/combustibles/consumos` (batch atómico). Frontend nuevo `src/components/Combustibles/ConsumosGrid.jsx` integrado a la categoría jerárquica "Combustibles" en sidebar. |
```

## (c) `CLAUDE.md` (raíz subrepo `Bit-cora-g3/`)

### Sección "Bitácoras especiales"

Hoy lista MAND y DISP. Agregar tercera entrada:

```markdown
- **COMB** (Consumos de Combustibles) — `Combustibles/ConsumosGrid.jsx`. Pestaña bajo categoría "Combustibles" en el sidebar. Grilla 24 periodos × N combustibles dinámicos por planta (8 GEC3 / 10 GEC32 desde `lov_bit.combustible`). Selector de fecha (default hoy, futuro bloqueado). Total Carbón calculado live (`SUM(tipo='ALIMENTADOR')`). Batch save atómico vía `POST /api/combustibles/consumos`. Permisos: crean `Operador de Planta - Carbón y Caliza` + JdT; resto ven. NO es una bitácora — es un report numérico. D-027.
```

### Nueva convención crítica #11

Hoy tiene 10 convenciones; agregar:

```markdown
11. **Combustibles**: catálogo `lov_bit.combustible` por planta (codigo, nombre, unidad, tipo). El campo `tipo` es discriminador (`ALIMENTADOR/CALIZA/ACPM`) usado por la vista `bitacora.v_consumo_periodo` para calcular `total_carbon_ton = SUM(WHERE tipo='ALIMENTADOR')`. Storage en `bitacora.consumo_combustible` long-format (1 fila por celda planta+fecha+periodo+combustible). `modificado_por` solo se actualiza si `cantidad` cambió, no si solo cambió `detalle` (paridad D-019 con MAND). Para agregar/quitar un combustible: editar seed en `db.js` y redeploy — sin CRUD admin. D-027.
```

## Importante (gotchas)

1. **Renumeración de versiones**: si D-026 ya está mergeada como v1.7, este queda v1.8. Si D-026 todavía no se mergeó (sigue en su rama), coordinar el bump — ambas no pueden ser v1.7.
2. **Cross-refs `[[D-NNN]]`**: el archivo `decisions.md` usa esta notación para links a otros ADRs. Mantenerlo.
3. **No tocar D-001..D-025 ni D-026** en este prompt — solo agregar D-027 al final.
4. **Verificación visual**: abrir el MD renderizado para confirmar que las tablas y los listados se ven bien.

## Verificación

```powershell
# Suite completa sin regresión
cd server
node --test --env-file=../.env tests/
# 12 tests nuevos verdes + previos sin romperse
```

## Lo que NO hagas en este prompt

- NO toques código.
- NO modifiques nada fuera de los 3 archivos listados.
- NO renumeres ADRs anteriores.

## Al finalizar

Mensaje de commit sugerido:

```
docs(combustibles): D-027 + BIT-MODBD v1.8 + CLAUDE.md

Documenta la nueva ingesta de Consumos de Combustibles:
- ADR D-027 (Contexto/Decisión/Consecuencias)
- BIT-MODBD §2.7 catálogo combustibles + §4.9 tabla + vista + bump v1.8
- CLAUDE.md: entrada COMB en "Bitácoras especiales" + convención #11

Sin cambios funcionales; documentación de la implementación previa.
```
