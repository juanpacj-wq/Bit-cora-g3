# E5 — Endpoints (scrape manual + revertir) + GET extendido

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E4 ✅.
- Endpoints COMB existentes en `server/server.js`: GET `/api/combustibles/consumos` (`server.js:2437`),
  POST `/api/combustibles/consumos` (`server.js:2509`). Gating: `hasPermisoBitacora(sesion,
  dbBindings.COMB_BITACORA_ID, 'puede_ver'|'puede_crear')`.
- Para gating por cargo (JdT/IngOp/Jefe Planta) mira cómo lo hace
  `POST /api/conformacion-turno/trigger` (busca su handler en `server.js`/`routes/`). Confirma los
  nombres reales de cargo contra `lov_bit.cargo` y anótalos en ESTADO.md.
- Usa `scrapeDia` (E3).

## Objetivo
Exponer disparo manual del scraper, la acción "revertir al valor SIS", y devolver `valor_sis` en el GET.

## Tareas — `server/server.js`
1. **Extender GET** `/api/combustibles/consumos` (`server.js:2466-2494`):
   - Agregar `c.valor_sis, c.sis_actualizado_en` al SELECT.
   - Añadir al objeto pivot de cada celda: `valor_sis: row.valor_sis == null ? null :
     Number(row.valor_sis)`, `sis_actualizado_en: row.sis_actualizado_en`.
2. **POST `/api/combustibles/sis/scrape`** (gated por cargo JdT/IngOp/Jefe Planta):
   - Body `{ fecha }` (un día) o `{ from, to }` (rango). Validar formato `YYYY-MM-DD`, no futuro,
     `from<=to`. Planta fija GEC32.
   - Para un día: `await scrapeDia(pool, { fecha, scrape_tipo: 'manual' })`. Para rango: iterar días
     (con throttling) y devolver resumen agregado. Para rangos largos preferir respuesta inmediata
     + ejecución en background, o limitar el tamaño máximo del rango (documenta la elección).
   - Responder `{ resumen }`.
3. **POST `/api/combustibles/consumos/revertir`** (gated `puede_crear` COMB):
   - Body `{ planta_id, fecha, periodo, combustible_id }`. Validar pertenencia del combustible a la
     planta y rango de periodo.
   - Buscar la fila; si no existe o `valor_sis IS NULL` → 400/404 con motivo. Si `valor_sis = 0` →
     DELETE la fila (vacío ≡ 0). Si `valor_sis > 0` → UPDATE `cantidad = valor_sis`,
     `creado_por = SISTEMA`, `modificado_por = NULL`, `modificado_en = NULL`, `sis_actualizado_en =
     SYSUTCDATETIME()` (vuelve a SIS-owned).
   - Responder la celda resultante.

## Prueba — `server/tests/sis_endpoints.test.js` (node:test, HTTP con helpers)
- Usa `setupSessions()`/`call()` de `server/tests/helpers.js`. Como `setupSessions` no crea el
  Operador Carbón, mira `consumos_combustible.test.js` para el helper `setupOperadorCarbon()` y
  reutiliza ese patrón si necesitas `puede_crear`.
- Casos:
  1. GET de un día con datos SIS incluye `valor_sis`/`sis_actualizado_en` en las celdas.
  2. POST `/sis/scrape` con sesión SIN cargo permitido ⇒ 403; con cargo permitido ⇒ 200 + resumen.
     (El scrape real depende del SIS; si no hay acceso en el entorno de test, mockear `scrapeDia` o
     verificar solo el gating/validación y documentarlo.)
  3. POST `/consumos/revertir`: sembrar una fila humano-owned con `valor_sis` conocido, revertir,
     y verificar `cantidad===valor_sis`, `creado_por=SISTEMA`, `modificado_por=NULL`.
  4. Revertir sin `valor_sis` ⇒ error controlado.
- Limpieza en `after()`. Agregar al script `test` de `server/package.json`.

## Al terminar
Actualiza `ESTADO.md`: E5 ✅, archivos, nombres reales de cargos usados en el gating, decisión sobre
rangos largos (sincrónico/background/límite), y resultados de tests.
