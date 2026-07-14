/* ============================================================================================
   D-053 — Reporte PRE-FLIGHT del split de la bitácora de Sala de Mando
   ============================================================================================

   QUÉ ES
   Reporte de SOLO LECTURA que predice exactamente qué haría la migración F30.A1 (db.js) ANTES de
   desplegarla. No modifica absolutamente nada: solo SELECT.

   POR QUÉ EXISTE
   El cargo del autor de un registro NO está almacenado en ninguna parte: `creado_por` es un
   usuario_id y el cargo se resuelve desde el App Role de Entra en cada login, sin persistirse. La
   migración lo reconstruye por evidencia, en escalera. Este reporte te dice, contra los datos REALES
   de producción, cuántos registros resuelve cada escalón y —el número que importa— CUÁNTOS QUEDAN SIN
   ATRIBUIR. Ese conteo es la puerta de decisión: si no es 0, decidí qué hacer con ellos ANTES de
   desplegar, no durante.

   CÓMO SE CORRE
   A mano, en SSMS, contra la BD de producción, ANTES del deploy. Nunca lo invoca initDB ni el CI
   (guard: server/tests/guard_reporte_split_sala_no_auto_ejecutable.test.js).

   CÓMO LEERLO
   - Bloque 4: el desglose por destino = lo que hará F30.A1.
   - Bloque 5: los NO ATRIBUIBLES. Se quedarían en SALAJDT (la migración nunca adivina).
   - Bloque 6: el detalle fila a fila de esos no atribuibles, para triagearlos a mano si hace falta.

   OJO CON EL ORDEN: si lo corrés DESPUÉS del deploy, los bloques 3-6 dan casi vacío — la migración ya
   movió todo. El valor está en correrlo ANTES.
   ============================================================================================ */

SET NOCOUNT ON;

/* -- 0. Estado del catálogo -------------------------------------------------------------------
   Antes del deploy: existe SALA (codigo viejo) y NO existen SALAING/SALAOP.
   Después del deploy: SALA ya no existe; SALAJDT conserva su bitacora_id.                      */
SELECT '0. Catálogo' AS bloque, bitacora_id, nombre, codigo, orden, activa, oculta
FROM lov_bit.bitacora
WHERE codigo IN ('SALA', 'SALAJDT', 'SALAING', 'SALAOP')
ORDER BY orden;

/* -- 1. ¿Ya se aplicó la migración? ----------------------------------------------------------- */
SELECT '1. Flag F30.A1' AS bloque,
       CASE WHEN EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F30.A1')
            THEN 'YA APLICADA — los bloques de abajo van a dar vacío'
            ELSE 'PENDIENTE — el reporte es válido' END AS estado;

/* ---------------------------------------------------------------------------------------------
   Origen: la bitácora de Sala. Resuelve tanto el nombre viejo (pre-deploy) como el nuevo
   (post-deploy) para que el snippet sirva en los dos momentos.
   --------------------------------------------------------------------------------------------- */
DECLARE @sala INT = (
  SELECT TOP 1 bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SALA','SALAJDT') ORDER BY codigo
);

/* -- 2. Volumen ------------------------------------------------------------------------------- */
SELECT '2. Volumen' AS bloque, 'registro_activo' AS tabla,
       COUNT(*) AS registros, COUNT(DISTINCT creado_por) AS autores
FROM bitacora.registro_activo WHERE bitacora_id = @sala
UNION ALL
SELECT '2. Volumen', 'registro_historico',
       COUNT(*), COUNT(DISTINCT creado_por)
FROM bitacora.registro_historico WHERE bitacora_id = @sala;

/* ---------------------------------------------------------------------------------------------
   La escalera de atribución, idéntica a la de F30.A1 (db.js). Si cambiás una, cambiá la otra:
   este reporte solo vale si predice lo que la migración realmente hace.
   --------------------------------------------------------------------------------------------- */
WITH universo AS (
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'activo' AS tabla
  FROM bitacora.registro_activo WHERE bitacora_id = @sala
  UNION ALL
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'historico'
  FROM bitacora.registro_historico WHERE bitacora_id = @sala
),
escalones AS (
  SELECT u.*,
    (SELECT TOP 1 tp.cargo_id FROM bitacora.turno_participante tp
      WHERE tp.turno_id = u.turno_id AND tp.usuario_id = u.creado_por) AS e1_participante,
    (SELECT TOP 1 ct.cargo_id FROM bitacora.conformacion_turno ct
      WHERE ct.turno_id = u.turno_id AND ct.usuario_id = u.creado_por) AS e2_conformacion,
    (SELECT MIN(sa.cargo_id) FROM bitacora.sesion_activa sa
      WHERE sa.usuario_id = u.creado_por
      HAVING COUNT(DISTINCT sa.cargo_id) = 1)                          AS e3_cargo_unico
  FROM universo u
),
resuelto AS (
  SELECT e.*,
         COALESCE(e.e1_participante, e.e2_conformacion, e.e3_cargo_unico) AS cargo_id
  FROM escalones e
)

/* -- 3. Qué escalón resuelve cada registro ---------------------------------------------------- */
SELECT '3. Escalón que resuelve' AS bloque,
       CASE
         WHEN e1_participante IS NOT NULL THEN '1 - turno_participante (evidencia exacta)'
         WHEN e2_conformacion IS NOT NULL THEN '2 - conformacion_turno (evidencia exacta)'
         WHEN e3_cargo_unico  IS NOT NULL THEN '3 - sesion_activa (cargo único del autor)'
         ELSE                                  '4 - SIN ATRIBUIR (se queda en SALAJDT)'
       END AS escalon,
       COUNT(*) AS registros
FROM resuelto
GROUP BY CASE
         WHEN e1_participante IS NOT NULL THEN '1 - turno_participante (evidencia exacta)'
         WHEN e2_conformacion IS NOT NULL THEN '2 - conformacion_turno (evidencia exacta)'
         WHEN e3_cargo_unico  IS NOT NULL THEN '3 - sesion_activa (cargo único del autor)'
         ELSE                                  '4 - SIN ATRIBUIR (se queda en SALAJDT)'
       END;
GO

/* ---------------------------------------------------------------------------------------------
   Bloques 4-6: hay que re-declarar (el GO cierra el batch). Mismo CTE.
   --------------------------------------------------------------------------------------------- */
SET NOCOUNT ON;
DECLARE @sala INT = (
  SELECT TOP 1 bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SALA','SALAJDT') ORDER BY codigo
);

WITH universo AS (
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'activo' AS tabla
  FROM bitacora.registro_activo WHERE bitacora_id = @sala
  UNION ALL
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'historico'
  FROM bitacora.registro_historico WHERE bitacora_id = @sala
),
resuelto AS (
  SELECT u.*,
         COALESCE(
           (SELECT TOP 1 tp.cargo_id FROM bitacora.turno_participante tp
             WHERE tp.turno_id = u.turno_id AND tp.usuario_id = u.creado_por),
           (SELECT TOP 1 ct.cargo_id FROM bitacora.conformacion_turno ct
             WHERE ct.turno_id = u.turno_id AND ct.usuario_id = u.creado_por),
           (SELECT MIN(sa.cargo_id) FROM bitacora.sesion_activa sa
             WHERE sa.usuario_id = u.creado_por
             HAVING COUNT(DISTINCT sa.cargo_id) = 1)
         ) AS cargo_id
  FROM universo u
)

/* -- 4. DESGLOSE POR DESTINO = lo que hará F30.A1 ---------------------------------------------
   Regla: solo IngOp y Op de Sala se MUEVEN. Todo lo demás (JdT, Admin, sin atribuir) se queda.  */
SELECT '4. Destino' AS bloque,
       r.tabla,
       ISNULL(c.nombre, '(cargo no resuelto)') AS cargo_autor,
       CASE c.nombre
         WHEN 'Ingeniero de Operación'             THEN 'SALAING  → SE MUEVE'
         WHEN 'Operador de Planta - Sala de Mando' THEN 'SALAOP   → SE MUEVE'
         ELSE                                           'SALAJDT  → se queda'
       END AS destino,
       COUNT(*) AS registros
FROM resuelto r
LEFT JOIN lov_bit.cargo c ON c.cargo_id = r.cargo_id
GROUP BY r.tabla, c.nombre
ORDER BY r.tabla, cargo_autor;
GO

SET NOCOUNT ON;
DECLARE @sala INT = (
  SELECT TOP 1 bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SALA','SALAJDT') ORDER BY codigo
);

WITH universo AS (
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'activo' AS tabla
  FROM bitacora.registro_activo WHERE bitacora_id = @sala
  UNION ALL
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'historico'
  FROM bitacora.registro_historico WHERE bitacora_id = @sala
),
resuelto AS (
  SELECT u.*,
         COALESCE(
           (SELECT TOP 1 tp.cargo_id FROM bitacora.turno_participante tp
             WHERE tp.turno_id = u.turno_id AND tp.usuario_id = u.creado_por),
           (SELECT TOP 1 ct.cargo_id FROM bitacora.conformacion_turno ct
             WHERE ct.turno_id = u.turno_id AND ct.usuario_id = u.creado_por),
           (SELECT MIN(sa.cargo_id) FROM bitacora.sesion_activa sa
             WHERE sa.usuario_id = u.creado_por
             HAVING COUNT(DISTINCT sa.cargo_id) = 1)
         ) AS cargo_id
  FROM universo u
)

/* -- 5. EL NÚMERO QUE DECIDE ------------------------------------------------------------------
   Si `sin_atribuir` = 0 → la migración es 100% automática, desplegá tranquilo.
   Si > 0 → esos registros se quedarán en SALAJDT. Decidí ANTES del deploy si es aceptable.      */
SELECT '5. PUERTA DE DECISIÓN' AS bloque,
       COUNT(*)                                                    AS total,
       SUM(CASE WHEN cargo_id IS NULL THEN 1 ELSE 0 END)           AS sin_atribuir,
       SUM(CASE WHEN cargo_id IS NOT NULL THEN 1 ELSE 0 END)       AS atribuidos
FROM resuelto;
GO

SET NOCOUNT ON;
DECLARE @sala INT = (
  SELECT TOP 1 bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SALA','SALAJDT') ORDER BY codigo
);

/* -- 6. Detalle de los NO ATRIBUIBLES (para triage manual) ------------------------------------
   Por qué un registro cae acá: (a) turno_id NULL (creado antes de D-045) y (b) su autor usó varios
   cargos distintos, así que sesion_activa no desambigua. Revisalos uno a uno si el bloque 5 no dio 0.
   `cargos_del_autor` te dice entre cuántos cargos hay que elegir.                                */
WITH universo AS (
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'activo' AS tabla
  FROM bitacora.registro_activo WHERE bitacora_id = @sala
  UNION ALL
  SELECT registro_id, creado_por, turno_id, planta_id, turno, fecha_evento, 'historico'
  FROM bitacora.registro_historico WHERE bitacora_id = @sala
),
resuelto AS (
  SELECT u.*,
         COALESCE(
           (SELECT TOP 1 tp.cargo_id FROM bitacora.turno_participante tp
             WHERE tp.turno_id = u.turno_id AND tp.usuario_id = u.creado_por),
           (SELECT TOP 1 ct.cargo_id FROM bitacora.conformacion_turno ct
             WHERE ct.turno_id = u.turno_id AND ct.usuario_id = u.creado_por),
           (SELECT MIN(sa.cargo_id) FROM bitacora.sesion_activa sa
             WHERE sa.usuario_id = u.creado_por
             HAVING COUNT(DISTINCT sa.cargo_id) = 1)
         ) AS cargo_id
  FROM universo u
)
SELECT '6. Sin atribuir (detalle)' AS bloque,
       r.tabla, r.registro_id, r.creado_por, u.nombre_completo AS autor,
       r.turno_id, r.planta_id, r.turno,
       DATEADD(HOUR, -5, r.fecha_evento) AS fecha_evento_bogota,
       (SELECT COUNT(DISTINCT sa.cargo_id) FROM bitacora.sesion_activa sa
         WHERE sa.usuario_id = r.creado_por) AS cargos_del_autor
FROM resuelto r
LEFT JOIN lov_bit.usuario u ON u.usuario_id = r.creado_por
WHERE r.cargo_id IS NULL
ORDER BY r.tabla, r.registro_id;
