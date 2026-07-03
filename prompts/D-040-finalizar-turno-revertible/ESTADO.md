# D-040 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable),
> este archivo se actualiza en CADA etapa: leerlo al empezar (qué quedó hecho, qué se
> descubrió, qué desviaciones hay) y registrar al terminar (qué se hizo, archivos tocados,
> tests, desviaciones). Una etapa solo corre si **todas las anteriores figuran ✅**.

## Tablero de avance
| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Scaffolding creado: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-040.md`, `ESTADO.md`, `E1..E4`. |
| E1 — Esquema + exposición del estado de sesión | ✅ | Columna `sesion_activa.turno_finalizado_en` (+ paridad `_bogota`) + tipo CIET 'Reapertura de turno' (orden 4); expuesta en `SELECT_SESION`/`select-context` (reset en reactivación). Sin cambio de comportamiento. |
| E2 — Endpoints (finalizar/revertir/forzado) + fix del bug + write-gate + tests | ✅ | `finalizar`/`revertir-turno`/`finalizar-forzado` por `sesion_activa.turno_finalizado_en` (revertible, CIET idempotente); fix `ingenieros_no_finalizados` (deja de leer `sesion_bitacora`, `OUTER APPLY` conserva `bitacoras_abiertas`); write-gate 409 solo en rama genérica de `registros.js`; suite 218/217✔/1skip. |
| E3 — Frontend: fuente de verdad backend + revertir + gate de UI | ⬜ | — |
| E4 — Docs + ADR D-040 + cleanup + commit | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas
> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno con
> la etapa que lo originó y si tiene impacto funcional.
- **E1 (sin impacto funcional):** el seed del tipo CIET 'Reapertura de turno' se ubicó junto
  al bloque de 'Deshacer disponibilidad' (`db.js`, patrón `IF EXISTS/NOT EXISTS ... INSERT
  SELECT`, **orden 4**), NO en el bloque `CROSS JOIN VALUES` de tipos CIET (`~:824-837`). Es
  el mismo destino lógico y el patrón que pedía el `_CONTEXTO-BASE` ('mismo patrón que Deshacer
  disponibilidad'). Los tipos CIET quedaron: 1 Finalización · 2 Cierre · 3 Deshacer disp · 4 Reapertura.
- **E1 (verificación, sin impacto):** el `GET /api/me` live-hit se sustituyó por verificación
  de esquema directa contra la BD + `initDB()` 2da corrida + inspección de `SELECT_SESION`
  (que alimenta `loadByOid`→`/api/me`), porque el puerto 3002 estaba ocupado por un dev server
  con código viejo. La columna se agregó a `SELECT_SESION`, así que propaga a `req.sesion` y `/api/me`.
- **E2 (write-gate, sin impacto funcional):** en `registros.js` el gate se aplica con un helper
  **inline** `bloquearSiTurnoFinalizado(req,res)` (devuelve bool y ya respondió 409), NO con el
  middleware Express `rechazarSiTurnoFinalizado(req,res,next)`, porque ese router **mezcla** DISP +
  genérico y no admite `router.use` (pegaría a DISP). Ambos exports viven en `_middleware.js` y
  comparten el cuerpo 409 (`respTurnoFinalizado`). El middleware queda para routers 100% genéricos futuros.
- **E2 (DELETE, sin impacto):** el gate en `DELETE /api/registros/:id` va al **tope** del handler.
  Es seguro para DISP (vive en `disponibilidad_estado` → un id DISP daría 404 acá) y MAND no se
  borra por esta ruta (UI usa batch de sala-de-mando).
- **E2 (verificación, sin impacto):** los tests corrieron contra un server **efímero en :3099**
  (`SERVER_PORT=3099`, `AUTH_TEST_BYPASS=1`, `TEST_BASE_URL=…:3099`) con el código nuevo, para no
  tocar el dev server del usuario en :3002. Server apagado al terminar.
- **E2 (cobertura COMB/MAND, sin impacto):** para "no gateado", los tests 4c/4d afirman
  `status≠404` (el endpoint existe) **y** `codigo≠'turno_finalizado'` — el claim preciso del scoping —
  en vez de un write válido completo (payloads pesados). DISP (4b) sí hace un POST válido → 201.

## Datos descubiertos en ejecución
> Hechos que solo se conocen corriendo (números de línea exactos tras editar, baseline real
> de tests, nombres de bitácoras genéricas de prueba, etc.). Rellenar a medida.
- Los números de línea en `_CONTEXTO-BASE.md` y en los `EX-*.md` son del snapshot de
  planificación (2026-07-03); confirmarlos con Grep/Read antes de editar, pueden haber
  corrido.
- **Números de línea reales E1** (post-edición, para E2):
  - `db.js`: migración `ADD turno_finalizado_en` justo tras el bloque `ADD cerrada_en` (~`:490`);
    columna calculada `turno_finalizado_en_bogota` tras `cerrada_en_bogota` (~`:1544`);
    seed CIET 'Reapertura de turno' tras el de 'Deshacer disponibilidad' (~`:1092`).
  - `auth.js`: `s.turno_finalizado_en,` en `SELECT_SESION` (línea ~26, tras `s.activa`).
  - `sesion.js`: `turno_finalizado_en = NULL` en el `SET` de reactivación; `s.turno_finalizado_en`
    en el `SELECT` final de `select-context`.
  - `ciet.js`: `reapertura: 'Reapertura de turno'` en `TIPO_NOMBRE` — listo para `registrarEventoCierre(tx,{tipo:'reapertura',...})` en E2.
- **Baseline real de tests (E1):** `npm test` → **207 tests, 206 pass, 1 skip, 0 fail** (~600 s).
  `T4/C5` (tiebreaker CALDERA) verde en esta corrida. Es el baseline a no degradar en E2+.
- **Baseline real de tests (E2):** `npm test` canónico (con `finalizar_turno.test.js` ya agregado a
  `package.json`) → **218 tests, 217 pass, 1 skip, 0 fail** (~647 s). Los 11 de finalización todos ✔.
  Es el nuevo baseline para E3+.
- **Datos E2 para E3/E4:**
  - Paths cross-router usados por el write-gate/tests: COMB=`POST /api/combustibles/consumos`,
    MAND=`POST /api/sala-de-mando/guardar`, DISP=rama de `POST /api/registros`.
  - Bitácoras **genéricas** (no MAND/DISP/COMB, `oculta=0`) tienen `definicion_campos=NULL`
    (CALDERA/AGUA/TURBO/QUIM/ANAL/CYC/MAQU/SALA) → un POST solo-`detalle` da 201. Útil para tests.
  - **Shape final de `ingenieros_no_finalizados`** (sin cambio para el front): `{ usuario_id,
    nombre_completo, bitacoras_abiertas: number[] }`. `bitacoras_csv` ahora sale `''` (COALESCE) →
    el `.map` existente lo vuelve `[]` (rama falsy). Filtro de finalización = `sa.turno_finalizado_en IS NULL`.
  - Respuesta nueva de `POST /api/bitacora/finalizar` y `/revertir-turno`:
    `{ turno_finalizado_en, evento_ciet }` (antes `finalizar` devolvía `{ finalizadas, evento_ciet }`).
    **E3 debe alinear el front a este shape.**
  - Los CIET **no** llevan `TEST_TAG` (detalle NULL): el cleanup de `finalizar_turno.test.js` borra
    `registro_activo` por `creado_por IN (uids test) AND planta_id='TST'` (cubre genérico + CIET) +
    `disponibilidad_estado` por planta TST.

## Bitácora por etapa
### E0 — Andamiaje  ✅
- Creados: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-040.md`, `ESTADO.md`, `E1-esquema-sesion.md`,
  `E2-endpoints-writegate.md`, `E3-frontend.md`, `E4-docs-cleanup.md`.
- Sin código de producto todavía.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->

### E1 — Esquema + exposición del estado de sesión  ✅
**Archivos tocados:**
- `server/db.js` — 3 migraciones idempotentes: `ALTER ... ADD turno_finalizado_en DATETIME2 NULL`
  (guard `COL_LENGTH IS NULL`), columna calculada `turno_finalizado_en_bogota AS DATEADD(HOUR,-5,...)`
  (guard `sys.columns NOT EXISTS`), seed tipo CIET 'Reapertura de turno' orden 4 (guard `NOT EXISTS`).
- `server/middleware/auth.js` — `s.turno_finalizado_en` agregado a `SELECT_SESION` (propaga a `req.sesion`, `loadByOid`/`/api/me` y path de test).
- `server/routes/sesion.js` — `select-context`: `turno_finalizado_en = NULL` en la rama de reactivación (reset = turno nuevo) + `s.turno_finalizado_en` en el `SELECT` de respuesta.
- `server/utils/ciet.js` — `TIPO_NOMBRE.reapertura = 'Reapertura de turno'`.
- `prompts/D-040-finalizar-turno-revertible/ESTADO.md` — este archivo.

**Verificación (real):**
- Sintaxis: `node --check` OK en los 4 archivos JS.
- `initDB()` corrió limpio contra la BD productiva (`[DB] Conexión OK`, sweepers iniciados); 2da corrida OK → **idempotente**.
- Query directa: `sys.columns` de `bitacora.sesion_activa` incluye `turno_finalizado_en` y `turno_finalizado_en_bogota`.
- Tipos CIET: `1 Finalización | 2 Cierre | 3 Deshacer disponibilidad | 4 Reapertura de turno`.
- Suite backend `npm test`: **207 tests, 206 pass, 1 skip, 0 fail** — sin regresión (T4/C5 verde).
- `/api/me` live-hit sustituido (puerto 3002 ocupado por dev server viejo) por verificación de esquema + inspección de `SELECT_SESION` — ver desviaciones.

**Desviaciones:** ubicación del seed CIET y sustitución del `/api/me` live-hit (ambas sin impacto funcional) — ver "Decisiones / desviaciones acumuladas".

**Sin cambio de comportamiento:** finalizar sigue funcionando como antes; la lógica de negocio (write-gate, revertir, fix del bug) llega en E2.

### E2 — Endpoints + fix del bug + write-gate + tests  ✅
**Archivos tocados:**
- `server/middleware/permissions.js` — helper puro `turnoFinalizado(sesion)`.
- `server/routes/_middleware.js` — write-gate D-040: `respTurnoFinalizado` (cuerpo 409), middleware
  `rechazarSiTurnoFinalizado` (routers genéricos futuros) + helper inline `bloquearSiTurnoFinalizado`
  (para `registros.js`, que mezcla DISP+genérico). Import de `turnoFinalizado`.
- `server/routes/bitacora.js` — `POST /finalizar` reescrito → `sesion_activa.turno_finalizado_en`
  (ya no toca `sesion_bitacora`), CIET solo si cambió, respuesta `{ turno_finalizado_en, evento_ciet }`;
  **nuevo `POST /revertir-turno`** (self-service, columna→NULL, CIET `reapertura` idempotente);
  `POST /finalizar-forzado` setea la columna del objetivo (deja de tocar `sesion_bitacora`).
- `server/routes/cierre.js` — **FIX**: `ingenieros_no_finalizados` filtra por
  `sa.turno_finalizado_en IS NULL` (no `sesion_bitacora.finalizada_en`), `OUTER APPLY` conserva `bitacoras_abiertas`.
- `server/routes/registros.js` — write-gate 409 `turno_finalizado` en la rama **genérica** de
  `POST '/'`, `PUT '/:id'` (no-DISP) y `DELETE '/:id'`. Import de `bloquearSiTurnoFinalizado`.
- `server/utils/ciet.js` — mensaje de error de tipo inválido incluye `'reapertura'`.
- `server/tests/finalizar_turno.test.js` — **nuevo** (11 tests). `server/package.json` — agregado a `npm test`.

**Verificación (real):**
- `node --check` OK en los 6 JS + el test.
- Test nuevo aislado (server :3099 con código nuevo): **11/11 ✔** — finalizar+CIET, regresión del bug
  (/abrir no des-finaliza + no reaparece en preview-masivo), revertir+CIET, write-gate 409 en genérica,
  DISP 201 / COMB / MAND no gateados, 201 tras revertir, finalizar-forzado, doble finalizar/revertir idempotentes.
- Suite canónica `npm test` (incluye el nuevo): **218 tests, 217 pass, 1 skip, 0 fail** (~647 s). Sin regresión.

**Desviaciones:** helper inline vs middleware para el gate en `registros.js`; cobertura COMB/MAND por
"no-gateado" en vez de write completo; verificación contra server :3099 — todas sin impacto funcional,
detalladas en "Decisiones / desviaciones acumuladas".
