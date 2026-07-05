-- simular-umbral-turno-D046.sql
--
-- D-046 — SIMULACIÓN DEL UMBRAL DE CIERRE DE TURNO (para prueba manual · MANUAL · reversible).
--
-- Adelanta `fin_nominal` del turno ABIERTO de una unidad para que el turno-sweeper (corre c/60s) lo
-- trate como vencido y arranque el flujo REAL de transición (bloqueo/gracia) o de auto-cierre, SIN
-- esperar a las 06:00/18:00. Ejercita el código de producción tal cual (transicionarTurnosVencidos →
-- motivoAutoCierre → broadcast WS / cerrarTurno). NO inyecta reloj ni toca lógica de negocio: solo mueve
-- una columna. Sirve para verificar que, al llegar el umbral, TODOS los usuarios quedan bloqueados de
-- verdad (D-046: write-gate backend 409 turno_en_transicion + grilla read-only, no solo el modal).
--
-- NO es auto-ejecutable: se corre A MANO en SSMS / Azure Data Studio, en ventana COORDINADA con la unidad
-- (mutará el turno real de GEC3/GEC32). Un guardrail estático
-- (server/tests/guard_simular_umbral_no_auto_ejecutable.test.js) verifica que NADIE lo invoque desde el
-- código del server (initDB/CI). Solo el sweeper de PROD (scope ['GEC3','GEC32']) reacciona al cambio;
-- adelantar fin_nominal en 'TST' no dispara nada (los tests de dominio usan su propio harness).
--
-- ⚠️  MUTA UNA FILA de bitacora.turno_unidad (columna fin_nominal). NO borra nada. NO toca DISP ni
--     catálogos. Es REVERSIBLE con flujos de la propia app (ver RESTAURAR abajo).
--
-- RUNBOOK (resumen; detalle en ../docs/pruebas/prueba-umbral-cierre.md):
--   1. Elegí @planta (GEC3 / GEC32) y @modo:
--        'BLOQUEO'    → fin_nominal = ahora        → el sweeper emite bloqueo:true (gavela de gracia).
--                       El turno SIGUE ABIERTO; verificás que todos quedan bloqueados durante la gracia.
--        'AUTOCIERRE' → fin_nominal = ahora − 61m  → con ≥1 sesión activa fuerza AUTO_SIN_RESPUESTA en
--                       el siguiente tick (≥ GRACIA_CIERRE_MIN=60). El turno se CIERRA solo.
--   2. Ejecutá el script; revisá el SELECT ANTES/DESPUÉS.
--   3. Esperá ≤60s (un tick del sweeper) y observá el front con 2+ usuarios logueados en esa unidad.
--
-- RESTAURAR (sin SQL de reloj — usá los flujos reales de la app):
--   · Tras 'BLOQUEO' (turno aún ABIERTO): el Jefe de Turno pulsa **Extender** en el modal (o
--     POST /api/turno/extender) → fin_nominal salta al próximo umbral → se desbloquea para todos.
--   · Tras 'AUTOCIERRE' (turno CERRADO): POST /api/turno/reabrir → restaura fin_nominal al fin de la
--     ventana y deja el turno ABIERTO otra vez.
--
-- Idempotente: re-ejecutable; siempre deja fin_nominal en el valor calculado según @modo.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @planta VARCHAR(10) = 'GEC3';       -- unidad a simular: 'GEC3' | 'GEC32'
DECLARE @modo   VARCHAR(12) = 'BLOQUEO';    -- 'BLOQUEO' (gracia) | 'AUTOCIERRE' (fuerza AUTO_SIN_RESPUESTA)

DECLARE @nuevoFin DATETIME2 = CASE @modo
  WHEN 'BLOQUEO'    THEN SYSUTCDATETIME()
  WHEN 'AUTOCIERRE' THEN DATEADD(MINUTE, -61, SYSUTCDATETIME())   -- ≥ GRACIA_CIERRE_MIN (60)
END;

IF @nuevoFin IS NULL
BEGIN
  RAISERROR('@modo inválido: usá ''BLOQUEO'' o ''AUTOCIERRE''.', 16, 1);
  RETURN;
END;

PRINT '=== Turno ABIERTO de ' + @planta + ' ANTES ===';
SELECT turno_unidad_id, planta_id, turno, fecha_operativa, estado,
       fin_nominal, extendido, veces_extendido
FROM bitacora.turno_unidad
WHERE planta_id = @planta AND estado = 'ABIERTO';

IF NOT EXISTS (SELECT 1 FROM bitacora.turno_unidad WHERE planta_id = @planta AND estado = 'ABIERTO')
BEGIN
  PRINT 'AVISO: ' + @planta + ' no tiene turno ABIERTO. Nada que simular (¿ya cerrado? reabrí primero).';
  RETURN;
END;

-- Mueve SOLO fin_nominal del turno ABIERTO de la unidad. Nada más.
UPDATE bitacora.turno_unidad
SET fin_nominal = @nuevoFin
WHERE planta_id = @planta AND estado = 'ABIERTO';

PRINT '=== Turno ABIERTO de ' + @planta + ' DESPUÉS (modo=' + @modo + ') ===';
SELECT turno_unidad_id, planta_id, turno, fecha_operativa, estado,
       fin_nominal, extendido, veces_extendido
FROM bitacora.turno_unidad
WHERE planta_id = @planta AND estado = 'ABIERTO';

PRINT 'Listo. Esperá ≤60s al próximo tick del sweeper y observá el front.';
