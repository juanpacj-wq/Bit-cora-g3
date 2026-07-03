# D-040 · E1 — Esquema + exposición del estado de sesión

> Etapa self-contained. Ejecutable solo con este archivo + `_CONTEXTO-BASE.md` + `ESTADO.md`
> + el contexto del subrepo. Objetivo: agregar la columna de finalización y exponerla en
> toda la superficie de sesión, **sin cambiar comportamiento** todavía.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. Esta es la primera etapa de código: verificá que E0 figure ✅.
3. Confirmá los números de línea con Grep/Read antes de editar (pueden haber corrido).
4. Si no estás en el branch del flujo, creá/cambiate a `feat/D-040-finalizar-turno-revertible`
   (hoy el repo está en `sec/audseg-remediation`).

## Alcance de esta etapa
SOLO esquema + propagación del campo a la sesión. Al terminar, `sesion.turno_finalizado_en`
existe y viaja al frontend por `/api/me`, pero **nada de lógica de negocio cambia** (finalizar
sigue funcionando como antes hasta E2). No tocar frontend de producto ni endpoints de
finalización todavía.

## Tareas
1. **`server/db.js` — 3 migraciones idempotentes** (dentro de `initDB()`, patrón del archivo):
   a. Bloque "3. Sesiones", tras el `ALTER ... ADD cerrada_en` (~`:488`):
      ```sql
      IF COL_LENGTH('bitacora.sesion_activa', 'turno_finalizado_en') IS NULL
        ALTER TABLE bitacora.sesion_activa ADD turno_finalizado_en DATETIME2 NULL;
      ```
   b. Bloque de paridad Bogotá (junto a `cerrada_en_bogota`, ~`:1537-1542`):
      ```sql
      IF NOT EXISTS (SELECT 1 FROM sys.columns
                     WHERE object_id = OBJECT_ID('bitacora.sesion_activa')
                       AND name = 'turno_finalizado_en_bogota')
        ALTER TABLE bitacora.sesion_activa
          ADD turno_finalizado_en_bogota AS DATEADD(HOUR, -5, turno_finalizado_en);
      ```
      (Va en su propio batch si hay `GO`/ejecución separada, como las otras calculadas.)
   c. Seed del tipo de evento CIET, junto al de 'Deshacer disponibilidad' (~`:1078-1090`):
      ```sql
      IF EXISTS (SELECT 1 FROM lov_bit.bitacora WHERE codigo = 'CIET')
         AND NOT EXISTS (
           SELECT 1 FROM lov_bit.tipo_evento te
           INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
           WHERE b.codigo = 'CIET' AND te.nombre = 'Reapertura de turno')
        INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
        SELECT bitacora_id, 'Reapertura de turno', 4
        FROM lov_bit.bitacora WHERE codigo = 'CIET';
      ```
      (Ajustá `orden` al siguiente libre y las columnas al shape real de `tipo_evento` —
      confirmá con la DDL/seed vecino.)

2. **`server/middleware/auth.js` — `SELECT_SESION` (~`:24-31`):** agregá `s.turno_finalizado_en,`
   a la lista de columnas. Propaga automáticamente a `req.sesion`, `loadByOid` (`/api/me`) y
   el path de test. No hace falta el `_bogota` (el back trabaja en UTC).

3. **`server/routes/sesion.js` — `select-context` (query SEPARADA del `SELECT_SESION`):**
   - Agregá `s.turno_finalizado_en` al `SELECT` final (~`:112-120`).
   - En la rama de **REACTIVACIÓN** (~`:97-104`) agregá `turno_finalizado_en = NULL` al `SET`
     (reactivar = turno nuevo → limpiar finalización). La rama INSERT ya nace NULL por default.
     **Crítico:** sin este reset queda un bug simétrico (un usuario que finalizó y usó "Operar
     otra unidad" de vuelta a la misma planta seguiría "finalizado").

4. **`server/utils/ciet.js` — `TIPO_NOMBRE` (~`:6-9`):** agregá `reapertura: 'Reapertura de turno'`.
   Habilita `registrarEventoCierre(tx, { tipo:'reapertura', ... })` en E2 sin duplicar código.

## Verificación (antes de commitear)
- Arrancá el server (dispara `initDB()`): no debe fallar; re-arrancá una segunda vez para
  confirmar **idempotencia**.
- Query directa a BD: `SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('bitacora.sesion_activa')`
  incluye `turno_finalizado_en` y `turno_finalizado_en_bogota`.
- `SELECT te.nombre FROM lov_bit.tipo_evento te JOIN lov_bit.bitacora b ON b.bitacora_id=te.bitacora_id
  WHERE b.codigo='CIET'` incluye 'Reapertura de turno'.
- `GET /api/me` con sesión de test (bypass `AUTH_TEST_BYPASS=1` + `X-Sesion-Id`) devuelve
  `sesion.turno_finalizado_en: null`.
- Suite backend sin regresión: `cd server && node --test --env-file=../.env tests/` (baseline
  conocido, ver `_CONTEXTO-BASE.md`).

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E1 ✅ con resumen de una línea.
- Bloque `### E1 — Esquema + exposición del estado de sesión  ✅`: **Archivos tocados**,
  **Verificación** (resultado real), **Desviaciones** ("ninguna" si aplica). Registrá números
  de línea reales y el `orden` usado para el tipo de evento en "Datos descubiertos".

## Commit (1 por etapa)
```bash
git add server/db.js server/middleware/auth.js server/routes/sesion.js server/utils/ciet.js \
        "prompts/D-040-finalizar-turno-revertible/ESTADO.md"
git commit -m "$(cat <<'EOF'
feat(sesion): D-040 E1 — columna turno_finalizado_en + tipo CIET reapertura

Agrega bitacora.sesion_activa.turno_finalizado_en (+ paridad _bogota) como base
de la finalización de turno revertible, la expone en SELECT_SESION/select-context
(con reset en reactivación) y siembra el tipo de evento CIET 'Reapertura de turno'.
Sin cambio de comportamiento todavía (la lógica llega en E2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
