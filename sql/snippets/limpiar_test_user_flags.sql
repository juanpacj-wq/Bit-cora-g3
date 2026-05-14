-- limpiar_test_user_flags.sql
--
-- Limpia flags es_jefe_planta y es_jdt_default que divergen de la spec
-- BIT-RF-2026-001.md §3 (líneas 113-114) y §6.5 (línea 623):
--   * Sólo Ernesto Muñoz (username='emunoz') debe tener es_jefe_planta=1.
--   * Sólo Omar Fedullo (username='ofedullo') debe tener es_jdt_default=1.
--
-- Idempotente: re-ejecutable sin efectos secundarios. El WHERE filtra
-- únicamente filas divergentes.
--
-- Ejecutar en SSMS contra la BD productiva una vez. La protección en
-- caliente (initDB() al arranque) la agrega el commit siguiente (prompt 02
-- del flujo fix/test-user-flags-snapshot-2026-05).
--
-- Cross-ref: D-023 en docs/decisions.md.

SET XACT_ABORT ON;

-- 1) Diagnóstico previo: listar todas las filas con flag = 1.
--    Antes de correr el UPDATE, verificá que esta lista sea exactamente:
--      es_jefe_planta=1 → emunoz (Ernesto Muñoz) + outliers a limpiar
--      es_jdt_default=1 → ofedullo (Omar Fedullo) + outliers a limpiar
--    Si hay outliers desconocidos, PARAR y consultar con el equipo antes
--    de continuar con el UPDATE.
SELECT usuario_id, nombre_completo, username, es_jefe_planta, es_jdt_default, activo
FROM   lov_bit.usuario
WHERE  es_jefe_planta = 1 OR es_jdt_default = 1
ORDER  BY es_jefe_planta DESC, es_jdt_default DESC, usuario_id;

-- 2) Limpieza atómica. BIT-RF-2026-001.md:623 dice explícitamente
--    "en una misma transacción" → BEGIN TRAN/COMMIT envolvente.
BEGIN TRAN;

  UPDATE lov_bit.usuario
  SET    es_jefe_planta = 0
  WHERE  es_jefe_planta = 1
    AND  username <> 'emunoz';

  UPDATE lov_bit.usuario
  SET    es_jdt_default = 0
  WHERE  es_jdt_default = 1
    AND  username <> 'ofedullo';

COMMIT;

-- 3) Diagnóstico post: el set debe quedar exactamente en 2 filas.
--    Esperado:
--      Ernesto Muñoz (emunoz)  es_jefe_planta=1, es_jdt_default=0
--      Omar Fedullo  (ofedullo) es_jefe_planta=0, es_jdt_default=1
SELECT usuario_id, nombre_completo, username, es_jefe_planta, es_jdt_default, activo
FROM   lov_bit.usuario
WHERE  es_jefe_planta = 1 OR es_jdt_default = 1
ORDER  BY es_jefe_planta DESC, es_jdt_default DESC, usuario_id;
