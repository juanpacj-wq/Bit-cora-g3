# D-040 · E2 — Endpoints (finalizar/revertir/forzado) + fix del bug + write-gate + tests

> Etapa self-contained. Depende de **E1 ✅**. Objetivo: `turno_finalizado_en` como fuente de
> verdad server-side, arreglar la reaparición del bug y blindar la escritura **solo en
> bitácoras genéricas**.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verificá que E1 figure ✅.** Si no, detenete.
3. Releé "Decisiones/desviaciones" y "Datos descubiertos" (números de línea reales de E1).

## Alcance de esta etapa
Backend completo del ciclo finalizar/revertir + el fix del bug + el write-gate genérico +
tests. NO tocar frontend de producto (eso es E3). NO gatear DISP/MAND/COMB.

## Tareas

1. **`server/middleware/permissions.js` — helper puro:**
   ```js
   export function turnoFinalizado(sesion) {
     return !!sesion && sesion.turno_finalizado_en != null;
   }
   ```

2. **`server/routes/bitacora.js`:**
   - **`POST /finalizar` (~`:50-88`):** dentro de la transacción existente, reemplazá el
     UPDATE sobre `sesion_bitacora` por:
     ```sql
     UPDATE bitacora.sesion_activa
       SET turno_finalizado_en = SYSUTCDATETIME()
       OUTPUT INSERTED.sesion_id
       WHERE usuario_id = @usuario_id AND activa = 1 AND turno_finalizado_en IS NULL;
     ```
     Emitir CIET `tipo:'finalizacion'` **solo si hubo fila** (idempotente). Devolver
     `{ turno_finalizado_en, evento_ciet }`. **Ya NO tocar `sesion_bitacora`.**
   - **NUEVO `POST /revertir-turno`** (self-service, sin permiso especial; montado tras
     `loadAppSession`, envuelto en `asyncH`; transacción):
     ```sql
     UPDATE bitacora.sesion_activa
       SET turno_finalizado_en = NULL
       OUTPUT DELETED.turno_finalizado_en AS antes
       WHERE usuario_id = @usuario_id AND activa = 1 AND turno_finalizado_en IS NOT NULL;
     ```
     Si hubo fila, CIET `tipo:'reapertura'`. Devolver `{ turno_finalizado_en: null, evento_ciet }`.
     Idempotente (revertir dos veces no re-emite CIET).
   - **`POST /finalizar-forzado` (~`:91-149`, gated `puedeCerrarTurno`):** en el loop por
     usuario objetivo, además del comportamiento actual, setear:
     ```sql
     UPDATE bitacora.sesion_activa SET turno_finalizado_en = SYSUTCDATETIME()
       WHERE usuario_id = @u AND planta_id = @p AND activa = 1 AND turno_finalizado_en IS NULL;
     ```
     Emitir CIET solo si cambió. Dejar de tocar `sesion_bitacora` también acá.

3. **`server/routes/cierre.js` — FIX DEL BUG — `ingenieros_no_finalizados` (~`:77-98`):**
   el criterio de "no finalizado" pasa a ser la columna:
   ```sql
   SELECT sa.usuario_id, u.nombre_completo,
          COALESCE(pres.bitacoras, '') AS bitacoras_csv
   FROM bitacora.sesion_activa sa
   INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
   OUTER APPLY (
     SELECT STRING_AGG(CONVERT(VARCHAR(10), sb.bitacora_id), ',') AS bitacoras
     FROM bitacora.sesion_bitacora sb
     WHERE sb.sesion_id = sa.sesion_id AND sb.finalizada_en IS NULL
   ) pres
   WHERE sa.planta_id = @planta_id AND sa.activa = 1 AND sa.turno_finalizado_en IS NULL;
   ```
   El `OUTER APPLY` conserva `bitacoras_abiertas` (informativo, lo pinta el modal); el filtro
   de finalización ya **no** depende de `sesion_bitacora`. Mantené el shape de salida que el
   front espera (`usuario_id`, `nombre_completo`, `bitacoras_abiertas` como array — ver el map
   actual `:92-98` y adaptalo desde `bitacoras_csv`).

4. **WRITE-GATE — SOLO bitácoras genéricas:**
   - Guard reusable en `server/routes/_middleware.js` (usa el shape de `errores.js`):
     ```js
     import { turnoFinalizado } from '../middleware/permissions.js';
     export function rechazarSiTurnoFinalizado(req, res, next) {
       if (turnoFinalizado(req.sesion)) {
         return sendJSON(res, 409, {
           error: 'turno_finalizado',
           codigo: 'turno_finalizado',
           mensaje: 'Finalizaste tu turno. Revierte la finalización para volver a registrar.',
         });
       }
       next();
     }
     ```
   - Aplicarlo **solo en la rama GENÉRICA** de `server/routes/registros.js`: en `POST '/'`
     (rama genérica `~:227-392`, NO la rama DISP `~:115-225`), `PUT '/:id'` (rama genérica) y
     `DELETE '/:id'`. Como `registros.js` mezcla DISP y genérico en el mismo router, **no** lo
     pongas como `router.use` (pegaría a DISP): invocá el guard/chequeo dentro de la rama
     genérica, después de resolver que la bitácora **no** es DISP. **NO** aplicar en
     `combustibles.js`, `disponibilidad.js` ni `mand.js`.

5. **Tests — nuevo `server/tests/finalizar_turno.test.js`** (`node:test`, planta `'TST'` D-030,
   patrón `helpers.js` con `setupSessions`):
   1. **finalizar** → `sesion_activa.turno_finalizado_en` no-NULL + exactamente 1 CIET
      'Finalización de turno'.
   2. **REGRESIÓN DEL BUG (clave):** finalizar → `POST /api/bitacora/abrir` (misma y otra
      bitácora) → el usuario **sigue finalizado** y **NO reaparece** en
      `GET /api/cierre/preview-masivo`.`ingenieros_no_finalizados`.
   3. **revertir** → columna NULL + 1 CIET 'Reapertura de turno'.
   4. **write-gate:** finalizado → `POST /api/registros` a una bitácora **genérica** → 409
      `codigo:'turno_finalizado'`; a DISP / COMB (`/api/combustibles/consumos`) / MAND
      (`/api/sala-de-mando/guardar`) → **sigue permitido**; tras revertir → 201/200 en la
      genérica.
   5. **finalizar-forzado** marca `turno_finalizado_en` del objetivo.
   6. **idempotencia:** doble finalizar / doble revertir no duplican CIET.

## Verificación (antes de commitear)
- `cd server && node --test --env-file=../.env tests/` con `AUTH_TEST_BYPASS=1`: toda la suite
  verde (incl. `finalizar_turno.test.js`) y **sin regresión** en sweeper/conformación/cierre
  (baseline conocido en `_CONTEXTO-BASE.md`).
- Smoke manual opcional: finalizar vía endpoint → `POST /abrir` → `preview-masivo` no lista al
  usuario.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E2 ✅ + bloque `### E2 ...  ✅` con Archivos tocados / Verificación (resultado real de
  tests) / Desviaciones. Anotá en "Datos descubiertos" el shape final de
  `ingenieros_no_finalizados` y cualquier ajuste al montaje del guard.

## Commit (1 por etapa)
```bash
git add server/routes/bitacora.js server/routes/cierre.js server/routes/registros.js \
        server/routes/_middleware.js server/middleware/permissions.js \
        server/tests/finalizar_turno.test.js \
        "prompts/D-040-finalizar-turno-revertible/ESTADO.md"
git commit -m "$(cat <<'EOF'
feat(turno): D-040 E2 — finalizar/revertir por sesion_activa + fix reaparición + write-gate

Finalización de turno pasa a sesion_activa.turno_finalizado_en (fuente única,
revertible con nuevo POST /api/bitacora/revertir-turno). ingenieros_no_finalizados
deja de leer sesion_bitacora.finalizada_en (causa del bug: /abrir la reseteaba),
ahora filtra por la columna y conserva bitacoras_abiertas vía OUTER APPLY.
Write-gate 409 'turno_finalizado' solo en la rama genérica de registros.js
(MAND/DISP/COMB intactos). Tests de regresión + idempotencia.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
