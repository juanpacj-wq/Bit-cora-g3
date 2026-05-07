# Snippets SSMS — inspección humana en hora Bogotá

Plantillas para queries ad-hoc cuando inspeccionás la BD desde SSMS / Azure Data Studio.

La BD almacena DATETIME2 en UTC (convención formalizada en F22 — ver `BIT-MODBD-2026-001.md` §7.10). Las columnas calculadas `*_bogota` (§4.5) cubren el 90% de los casos de inspección. Estos snippets son para queries más complejas o agregaciones por hora Bogotá.

## Ver registros recientes en hora Bogotá

```sql
SELECT TOP 50
    registro_id,
    bitacora_id,
    planta_id,
    fecha_evento_bogota AS fecha_evento,
    detalle,
    creado_en_bogota AS creado_en,
    creado_por
FROM bitacora.registro_activo
ORDER BY creado_en DESC;
```

## Filtrar por fecha del día Bogotá

```sql
-- Sin columna calculada (patrón canónico):
SELECT *
FROM bitacora.registro_activo
WHERE CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = '2026-05-05';

-- Con columna calculada (más legible):
SELECT *
FROM bitacora.registro_activo
WHERE CAST(fecha_evento_bogota AS DATE) = '2026-05-05';
```

## Agregar por hora Bogotá

```sql
SELECT
    DATEPART(HOUR, DATEADD(HOUR, -5, fecha_evento)) AS hora_bogota,
    COUNT(*) AS registros
FROM bitacora.registro_activo
WHERE bitacora_id = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo = 'CAL')
GROUP BY DATEPART(HOUR, DATEADD(HOUR, -5, fecha_evento))
ORDER BY hora_bogota;
```

## Ver CIETs recientes con fecha Bogotá legible

```sql
SELECT
    registro_id,
    creado_en_bogota AS creado_en,
    JSON_VALUE(campos_extra, '$.fecha_cerrada')   AS fecha_cerrada_bogota,
    JSON_VALUE(campos_extra, '$.fecha_revertida') AS fecha_revertida_bogota,
    JSON_VALUE(campos_extra, '$.motivo')          AS motivo,
    JSON_VALUE(campos_extra, '$.bitacora_origen') AS bitacora_origen
FROM bitacora.registro_activo
WHERE bitacora_id = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo = 'CIET')
ORDER BY creado_en DESC;
```

> Nota: `campos_extra.fecha_cerrada` y `fecha_revertida` están en hora Bogotá explícita post F19. CIETs anteriores a F19 quedaron en UTC; distinguir por `creado_en` si auditás históricos cruzados.

## Ver sesiones activas dentro del TTL (5 min)

```sql
SELECT
    s.sesion_id,
    u.nombre_completo,
    s.planta_id,
    c.nombre AS cargo,
    s.inicio_sesion_bogota   AS inicio_sesion,
    s.ultima_actividad_bogota AS ultima_actividad,
    s.activa
FROM bitacora.sesion_activa s
JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
JOIN lov_bit.cargo c   ON c.cargo_id   = s.cargo_id
WHERE s.activa = 1
  AND s.ultima_actividad > DATEADD(MINUTE, -5, SYSUTCDATETIME())
ORDER BY s.ultima_actividad DESC;
```

## Ver cierres MAND del día anterior

```sql
SELECT
    fecha_cerrada,
    planta_id,
    cerrado_en_bogota AS cerrado_en,
    registros_cerrados
FROM bitacora.mand_cierre_log
WHERE fecha_cerrada >= DATEADD(DAY, -7, CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE))
ORDER BY fecha_cerrada DESC, planta_id;
```

## Ver migraciones aplicadas

```sql
SELECT codigo, aplicada_en_bogota AS aplicada_en
FROM bitacora.migracion_aplicada
ORDER BY aplicada_en DESC;
-- Esperado post F22: F16.A1, F16.A2, F22.D1, ...
```

## Verificar shape de columnas calculadas (F22 audit)

```sql
SELECT
    OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
    OBJECT_NAME(c.object_id)        AS table_name,
    c.name                          AS column_name,
    cc.definition
FROM sys.columns c
JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.name LIKE '%_bogota'
ORDER BY OBJECT_NAME(c.object_id), c.name;
```
