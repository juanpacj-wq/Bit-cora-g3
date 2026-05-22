# D-027 — Ingesta de Consumos de Combustibles

Prompts secuenciales para ejecutar en sesiones separadas de Claude Code (cada una fresca, sin contexto compartido). Cada prompt es **autocontenido** — trae sus archivos clave, los shapes esperados y la verificación correspondiente.

## Contexto base

El portal necesita una pestaña nueva **"Combustibles → Consumos"** para registrar el consumo diario-horario de alimentadores de carbón, caliza y ACPM por planta. NO es una bitácora (no hay "estado" ni "cierre de turno"); es un **report numérico**. Se modela:

- **Catálogo** `lov_bit.combustible` (8 entradas GEC3 + 10 GEC32 = 18 totales).
- **Transaccional** `bitacora.consumo_combustible` long-format: 1 fila por celda (planta, fecha, periodo, combustible).
- **Vista** `bitacora.v_consumo_periodo` pivotea por periodo y deriva `total_carbon_ton = SUM(tipo='ALIMENTADOR')`.
- **Fila marcadora** en `lov_bit.bitacora` (codigo `COMB`) para reusar permisos y sidebar/routing (mismo patrón que D-026 establece para DISP).

Permisos: crean `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno`; resto ve.

## Decisiones del usuario (resueltas)

Ver `../../PREGUNTAS-D-027.md` en la raíz del repo.

Resumen:
- Total Carbón: calculado (vista SQL + UI derivada).
- Ventana edición: hoy o cualquier pasado; futuro bloqueado (`400 fecha_futura`).
- Permisos crear: `Operador de Planta - Carbón y Caliza` + JdT; resto solo ver.
- Auditoría: solo `creado_por`/`modificado_por` (sin snapshots de personal).
- Cargo operador: nombre exacto `Operador de Planta - Carbón y Caliza` (confirmado en `server/data/personal-2026.json`).
- Catálogo combustibles: seed idempotente en `initDB()`. Sin UI admin.

## Orden de ejecución (no alterar)

| # | Prompt | Toca | Output |
|---|---|---|---|
| 01 | `01-schema-y-seeds.md` | `server/db.js` | Bloque idempotente F26.B1: DDL `lov_bit.combustible` + `bitacora.consumo_combustible` + vista `v_consumo_periodo` + 18 seeds + fila `lov_bit.bitacora('COMB')` + permisos seedeados. |
| 02 | `02-backend-endpoints.md` | `server/server.js` | 3 endpoints: `GET /api/combustibles/catalogo`, `GET /api/combustibles/consumos`, `POST /api/combustibles/consumos` (batch atómico). |
| 03 | `03-frontend-grilla.md` | `src/components/Combustibles/*` (nuevo), `src/hooks/useCombustibles.js` (nuevo) | UI grilla 24×N + selector fecha + Total Carbón calculado live. |
| 04 | `04-integracion-sidebar.md` | `src/BitacorasGecelca3.jsx` | Categoría `Combustibles`, routing `COMB`, header condicional, `SIN_BADGE_CODIGOS.add('COMB')`. |
| 05 | `05-tests-backend.md` | `server/tests/consumos_combustible.test.js` (nuevo) | 12 tests cubriendo catálogo, batch, permisos, vista, ventana de fechas. |
| 06 | `06-docs.md` | `docs/decisions.md`, `BIT-MODBD-2026-001.md`, `CLAUDE.md` | ADR D-027 + BIT-MODBD §2.7/§4.9 + CLAUDE.md "Bitácoras especiales" + convención #11. |

## Criterio global de éxito

Al final de los 6 prompts:

1. `cd server && node --test --env-file=../.env tests/consumos_combustible.test.js` → 12/12 verde.
2. `cd server && node --test --env-file=../.env tests/` → suite completa sin regresión (los tests de DISP/MAND/etc. no se rompen).
3. Login como `Operador de Planta - Carbón y Caliza` GEC3:
   - Aparece la pestaña Combustibles → Consumos.
   - La grilla muestra 24 periodos × 8 combustibles (6 alimentadores + Caliza + ACPM) con default fecha=hoy.
   - Llenar 3 celdas, guardar → vista actualiza, Total Carbón refleja la suma.
   - Navegar a fecha pasada → grilla muestra datos previos, editable.
   - Intentar fecha futura desde devtools → 400 `fecha_futura`.
4. Login como `Ingeniero Químico` → ve la pestaña, abre la grilla read-only (sin botón Guardar).
5. SSMS:
   ```sql
   SELECT * FROM lov_bit.combustible ORDER BY planta_id, orden;        -- 18 filas
   SELECT * FROM lov_bit.bitacora WHERE codigo='COMB';                  -- 1 fila
   SELECT * FROM bitacora.migracion_aplicada WHERE codigo='F26.B1';     -- 1 fila
   SELECT * FROM bitacora.v_consumo_periodo
     WHERE planta_id='GEC3' AND fecha='2026-05-20';
   ```
6. Reiniciar backend: F26.B1 no se reejecuta (gateado por flag).

## Independencia respecto a D-026

D-027 es **ortogonal** a D-026 (migración ER de DISP):
- D-026 toca `bitacora.disponibilidad_estado` y rutas DISP.
- D-027 toca `lov_bit.combustible`, `bitacora.consumo_combustible` y rutas `/api/combustibles/*`.

Se pueden ejecutar en cualquier orden o en paralelo (no comparten archivos críticos). Si se ejecutan secuencialmente, el orden recomendado es D-026 primero (limpia el modelo DISP) y luego D-027 (introduce un nuevo módulo limpio).
