-- purga-arranque-limpio-D045.sql
--
-- D-045 E10 — PURGA DE ARRANQUE LIMPIO (DESTRUCTIVO · one-time · MANUAL).
--
-- Borra los datos operativos acumulados durante el desarrollo/pruebas de D-045 para arrancar la
-- feature "entidad explícita de turno" en limpio (decisión del usuario, PREGUNTAS-D-045 R2 Q1).
-- NO es auto-ejecutable: se corre A MANO en SSMS / Azure Data Studio contra la BD productiva, con
-- backup previo y coordinación con dashboard-gen-gec3. Un guardrail estático
-- (server/tests/guard_purga_no_auto_ejecutable.test.js) verifica que NADIE lo invoque desde initDB().
--
-- ⚠️  IRREVERSIBLE. Borra:
--     - bitacora.evento_dashboard     (AUTH/REDESP/PRUEBA — lo CONSUME dashboard-gen-gec3)
--     - bitacora.registro_historico   (histórico archivado)
--     - bitacora.registro_activo      (borradores vivos, incl. MAND y CIET)
--     - bitacora.conformacion_turno   (conformación congelada)
--     - bitacora.turno_participante   (detalle vivo de turno)     <- ver NOTA DE ALCANCE
--     - bitacora.turno_unidad         (cabecera de turno)         <- ver NOTA DE ALCANCE
--
-- NO toca (se preservan intactas):
--     - bitacora.disponibilidad_estado (DISP) — preservada por decisión explícita del usuario.
--     - bitacora.sesion_activa — las sesiones NO se borran; solo se NULL-ea turno_id (FK).
--     - lov_bit.* — catálogos, usuarios, cargos, permisos, combustibles.
--     - bitacora.mand_cierre_log — auditoría de cierres MAND (fuera de alcance).
--
-- NOTA DE ALCANCE (pivote respecto al plan E10): el plan asumía turno_unidad/turno_participante
-- "vacías post-feature". Resultó FALSO — E3-E9 (apertura automática por el sweeper + pruebas)
-- las poblaron con turnos reales de GEC3/GEC32. Para un arranque 100% limpio se incluyen en la
-- purga, con orden FK-seguro (hijos -> NULL sesion_activa.turno_id -> padres). El turno-sweeper
-- recrea el turno vigente en el siguiente arranque (abrirTurnosVigentes), así que dejarlas vacías
-- es seguro y esperado.
--
-- RUNBOOK (operador humano):
--   1. BACKUP de la BD (o export de las 6 tablas afectadas).
--   2. Ventana de mantenimiento: detener escrituras (apps en pausa) para que no reaparezcan filas.
--   3. Coordinar con dashboard-gen-gec3: perderá evento_dashboard (AUTH/REDESP/PRUEBA históricos).
--      Ver ../docs/interfaces-cross-repo.md.
--   4. Ejecutar este script; revisar los PRINT de conteos ANTES/DESPUES.
--   5. Verificar: las 6 tablas en 0 filas; disponibilidad_estado intacta.
--   6. Reactivar escrituras.
--
-- Idempotente: re-ejecutable sin efectos secundarios (una 2a corrida borra 0 filas).

SET XACT_ABORT ON;
SET NOCOUNT ON;

PRINT '=== Conteos ANTES de la purga ===';
SELECT 'evento_dashboard'                AS tabla, COUNT(*) AS filas FROM bitacora.evento_dashboard
UNION ALL SELECT 'registro_historico',            COUNT(*)          FROM bitacora.registro_historico
UNION ALL SELECT 'registro_activo',               COUNT(*)          FROM bitacora.registro_activo
UNION ALL SELECT 'conformacion_turno',            COUNT(*)          FROM bitacora.conformacion_turno
UNION ALL SELECT 'turno_participante',            COUNT(*)          FROM bitacora.turno_participante
UNION ALL SELECT 'turno_unidad',                  COUNT(*)          FROM bitacora.turno_unidad
UNION ALL SELECT 'disponibilidad_estado (INTACTA)', COUNT(*)        FROM bitacora.disponibilidad_estado;

BEGIN TRAN;

  -- 1) Puente cross-repo (sin FK entrante). Lo consume dashboard-gen-gec3.
  DELETE FROM bitacora.evento_dashboard;

  -- 2) Registros archivados y vivos (hijos de turno_unidad vía turno_id).
  DELETE FROM bitacora.registro_historico;
  DELETE FROM bitacora.registro_activo;

  -- 3) Conformación congelada (hija de turno_unidad vía turno_id).
  DELETE FROM bitacora.conformacion_turno;

  -- 4) Desligar las sesiones vivas del turno ANTES de borrar la cabecera (FK sesion_activa.turno_id).
  --    Las sesiones NO se borran: solo pierden el vínculo al turno que se va a eliminar.
  UPDATE bitacora.sesion_activa SET turno_id = NULL WHERE turno_id IS NOT NULL;

  -- 5) Detalle + cabecera de turno (padres). turno_participante antes que turno_unidad (FK).
  DELETE FROM bitacora.turno_participante;
  DELETE FROM bitacora.turno_unidad;

COMMIT;

PRINT '=== Conteos DESPUES (esperado 0 en todas salvo disponibilidad_estado) ===';
SELECT 'evento_dashboard'                AS tabla, COUNT(*) AS filas FROM bitacora.evento_dashboard
UNION ALL SELECT 'registro_historico',            COUNT(*)          FROM bitacora.registro_historico
UNION ALL SELECT 'registro_activo',               COUNT(*)          FROM bitacora.registro_activo
UNION ALL SELECT 'conformacion_turno',            COUNT(*)          FROM bitacora.conformacion_turno
UNION ALL SELECT 'turno_participante',            COUNT(*)          FROM bitacora.turno_participante
UNION ALL SELECT 'turno_unidad',                  COUNT(*)          FROM bitacora.turno_unidad
UNION ALL SELECT 'disponibilidad_estado (INTACTA)', COUNT(*)        FROM bitacora.disponibilidad_estado;
