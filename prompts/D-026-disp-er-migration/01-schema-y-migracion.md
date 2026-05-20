# Prompt 01 — Schema + migración idempotente (D-026)

**Working directory:** `Bit-cora-g3/` (este repo)
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Preguntas resueltas:** `PREGUNTAS-D-026.md`

## Tu tarea

Agregar a `server/db.js::initDB()` un bloque idempotente nuevo, gateado por flag `F26.A1` en `bitacora.migracion_aplicada`, que:

1. Crea la tabla `bitacora.disponibilidad_estado` (DDL más abajo).
2. Crea los índices, constraints y columnas calculadas Bogotá.
3. Crea `CREATE OR ALTER VIEW bitacora.v_disponibilidad_estado` con acumulados via window functions.
4. Hace **backfill** de los rows DISP existentes (de `bitacora.registro_activo` ∪ `bitacora.registro_historico`) a la tabla nueva, mapeando campos JSON a columnas tipadas.
5. **Valida conteo**: si los rows backfilleados ≠ rows DISP en origen, `ROLLBACK` y `RAISERROR`. Sin marcar flag → siguiente arranque reintenta.
6. `DELETE FROM registro_activo WHERE bitacora_id = <DISP>` y lo mismo en `registro_historico`.
7. `DROP INDEX UQ_disp_vigente_por_planta` si existe.
8. `DROP VIEW bitacora.v_disp_intervalos` si existe.
9. `DROP TABLE bitacora.disponibilidad_dashboard` + `CREATE VIEW bitacora.disponibilidad_dashboard` con mismo nombre (shape preservado).
10. `INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F26.A1')`.

Todo dentro de una `BEGIN TRAN / COMMIT` (o `ROLLBACK` ante error). NO toques handlers de `server.js` en este prompt.

## Contexto: patrón idempotente del repo

`server/db.js` ya tiene migraciones one-time gateadas por `bitacora.migracion_aplicada`. Busca los flags `F16.A1`, `F16.A2`, `F22.D1` para ver el patrón:

```js
const f26Aplicada = await db.request().query(
  `SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo = 'F26.A1'`
);
if (!f26Aplicada.recordset[0]) {
  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    // ...DDL idempotente + backfill + DELETE + DROP + CREATE VIEW...
    await new sql.Request(tx).query(`
      INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F26.A1')
    `);
    await tx.commit();
    console.log('[F26.A1] DISP migrado a bitacora.disponibilidad_estado');
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}
```

## DDL exacto

### Tabla base

```sql
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='disponibilidad_estado' AND schema_id=SCHEMA_ID('bitacora'))
CREATE TABLE bitacora.disponibilidad_estado (
  disponibilidad_id            INT IDENTITY(1,1) PRIMARY KEY,
  planta_id                    VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
  estado                       VARCHAR(20)   NOT NULL
      CONSTRAINT CK_disp_estado_evento
      CHECK (estado IN ('En Servicio','En Reserva','Indisponible','Mantenimiento')),
  codigo                       SMALLINT      NOT NULL CHECK (codigo IN (-1, 0, 1)),
  fecha_inicio_estado          DATETIME2     NOT NULL,
  fecha_fin_estado             DATETIME2     NULL,
  detalle                      NVARCHAR(MAX) NULL,
  jdts_snapshot                NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  jefes_planta_snapshot        NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  gerentes_produccion_snapshot NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  ingenieros_snapshot          NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  creado_por                   INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
  creado_en                    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  modificado_por               INT           NULL REFERENCES lov_bit.usuario(usuario_id),
  modificado_en                DATETIME2     NULL
);
```

### Índices

```sql
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_disp_estado_vigente_por_planta')
CREATE UNIQUE INDEX UQ_disp_estado_vigente_por_planta
  ON bitacora.disponibilidad_estado(planta_id)
  WHERE fecha_fin_estado IS NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_disp_estado_planta_inicio')
CREATE INDEX IX_disp_estado_planta_inicio
  ON bitacora.disponibilidad_estado(planta_id, fecha_inicio_estado DESC);
```

### Columnas Bogotá (idempotentes, una por una)

```sql
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='fecha_inicio_estado_bogota'
               AND object_id=OBJECT_ID('bitacora.disponibilidad_estado'))
  ALTER TABLE bitacora.disponibilidad_estado
    ADD fecha_inicio_estado_bogota AS DATEADD(HOUR, -5, fecha_inicio_estado);
-- repetir para fecha_fin_estado_bogota, creado_en_bogota, modificado_en_bogota
```

### Vista derivada

```sql
CREATE OR ALTER VIEW bitacora.v_disponibilidad_estado AS
WITH base AS (
  SELECT *,
    CAST(DATEDIFF_BIG(MILLISECOND, fecha_inicio_estado,
                      COALESCE(fecha_fin_estado, SYSUTCDATETIME())) AS BIGINT) / 3600000.0
      AS horas_intervalo
  FROM bitacora.disponibilidad_estado
)
SELECT
  disponibilidad_id,
  planta_id                                                                AS planta,
  codigo                                                                   AS codigo_estado,
  estado,
  detalle,
  fecha_inicio_estado                                                      AS fecha,
  fecha_fin_estado,
  creado_en                                                                AS fecha_creacion,
  SUM(CASE WHEN estado='En Servicio'   THEN horas_intervalo ELSE 0 END)
    OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)                AS horas_en_servicio,
  SUM(CASE WHEN estado='Indisponible'  THEN horas_intervalo ELSE 0 END)
    OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)                AS horas_en_indisponible,
  SUM(CASE WHEN estado='Mantenimiento' THEN horas_intervalo ELSE 0 END)
    OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)                AS horas_en_mantenimiento,
  SUM(CASE WHEN estado='En Reserva'    THEN horas_intervalo ELSE 0 END)
    OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)                AS horas_en_reserva,
  jefes_planta_snapshot,
  gerentes_produccion_snapshot,
  jdts_snapshot,
  ingenieros_snapshot,
  creado_por,
  modificado_por,
  modificado_en
FROM base;
```

### Backfill

```sql
DECLARE @disp_bid INT = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP');

INSERT INTO bitacora.disponibilidad_estado
  (planta_id, estado, codigo, fecha_inicio_estado, fecha_fin_estado, detalle,
   jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
   creado_por, creado_en, modificado_por, modificado_en)
SELECT
  planta_id,
  JSON_VALUE(campos_extra, '$.evento')                  AS estado,
  CAST(JSON_VALUE(campos_extra, '$.codigo') AS SMALLINT) AS codigo,
  fecha_evento                                          AS fecha_inicio_estado,
  fecha_fin_estado,
  detalle,
  ISNULL(jdts_snapshot, '[]'),
  ISNULL(jefes_snapshot, '[]'),
  '[]'                                                  AS gerentes_produccion_snapshot,
  ISNULL(ingenieros_snapshot, '[]'),
  creado_por, creado_en, modificado_por, modificado_en
FROM bitacora.registro_activo
WHERE bitacora_id = @disp_bid
UNION ALL
SELECT
  planta_id,
  JSON_VALUE(campos_extra, '$.evento'),
  CAST(JSON_VALUE(campos_extra, '$.codigo') AS SMALLINT),
  fecha_evento,
  fecha_fin_estado,
  detalle,
  ISNULL(jdts_snapshot, '[]'),
  ISNULL(jefes_snapshot, '[]'),
  '[]',
  ISNULL(ingenieros_snapshot, '[]'),
  creado_por, creado_en, modificado_por, modificado_en
FROM bitacora.registro_historico
WHERE bitacora_id = @disp_bid;
```

### Validación de conteo

```sql
DECLARE @migrados INT = (SELECT COUNT(*) FROM bitacora.disponibilidad_estado);
DECLARE @origen INT = (
  SELECT
    (SELECT COUNT(*) FROM bitacora.registro_activo    WHERE bitacora_id=@disp_bid) +
    (SELECT COUNT(*) FROM bitacora.registro_historico WHERE bitacora_id=@disp_bid)
);
IF @migrados <> @origen
  THROW 50001, 'F26.A1: conteo backfill no coincide con origen', 1;
```

### Limpieza post-backfill

```sql
DELETE FROM bitacora.registro_activo    WHERE bitacora_id = @disp_bid;
DELETE FROM bitacora.registro_historico WHERE bitacora_id = @disp_bid;

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_disp_vigente_por_planta')
  DROP INDEX UQ_disp_vigente_por_planta ON bitacora.registro_activo;

IF EXISTS (SELECT 1 FROM sys.views WHERE name='v_disp_intervalos' AND schema_id=SCHEMA_ID('bitacora'))
  DROP VIEW bitacora.v_disp_intervalos;
```

### Vista compat para cross-repo

```sql
IF EXISTS (SELECT 1 FROM sys.tables WHERE name='disponibilidad_dashboard' AND schema_id=SCHEMA_ID('bitacora'))
  DROP TABLE bitacora.disponibilidad_dashboard;

CREATE OR ALTER VIEW bitacora.disponibilidad_dashboard AS
SELECT
  planta_id,
  estado                                AS evento,
  codigo,
  fecha_inicio_estado,
  disponibilidad_id                     AS registro_activo_id,
  jdts_snapshot,
  jefes_planta_snapshot                 AS jefes_snapshot,
  modificado_por,
  modificado_en,
  COALESCE(modificado_en, creado_en)    AS actualizado_en
FROM bitacora.disponibilidad_estado
WHERE fecha_fin_estado IS NULL;
```

## Importante (gotchas)

1. **Orden de migración**: el bloque F26.A1 debe correr DESPUÉS de cualquier bloque que cree/modifique `disponibilidad_dashboard` o agregue columnas Bogotá a esa tabla (porque vas a dropearla). Buscar en `db.js` cualquier `ALTER TABLE bitacora.disponibilidad_dashboard` o `CREATE TABLE ... disponibilidad_dashboard` y poner F26.A1 DESPUÉS — o gatear esos bloques previos con `IF EXISTS` sobre la tabla original.
2. **No usar `CREATE OR ALTER` para tabla** — no existe en SQL Server. Usar `IF NOT EXISTS` + `CREATE TABLE`.
3. **No olvidar `JSON_VALUE` cast a SMALLINT** — viene como NVARCHAR si no se castea.
4. **El backfill incluye también las filas de PRUEBAS / dev** — si alguien insertó filas DISP con campos_extra mal formados (e.g. evento legacy "Disponible" sin migrar), el INSERT puede fallar por CHECK constraint. La migración D-024 ya cubrió ese caso, pero validar.
5. **No marcar el flag si algo falla**: el `THROW` dentro de la transacción debe quedar fuera del `INSERT INTO migracion_aplicada` para que el ROLLBACK borre el INSERT del flag.

## Verificación

```powershell
# Reiniciar el server. Debe loguear "[F26.A1] DISP migrado...".
cd server
node --watch --env-file=../.env server.js

# En SSMS o sqlcmd:
SELECT COUNT(*) AS disp_estado_count FROM bitacora.disponibilidad_estado;
SELECT COUNT(*) AS resto_activo_disp FROM bitacora.registro_activo
  WHERE bitacora_id = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'); -- debe ser 0
SELECT COUNT(*) AS resto_hist_disp FROM bitacora.registro_historico
  WHERE bitacora_id = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'); -- debe ser 0

-- Vista de acumulados
SELECT TOP 10 * FROM bitacora.v_disponibilidad_estado WHERE planta='GEC3' ORDER BY fecha;

-- Vista compat
SELECT * FROM bitacora.disponibilidad_dashboard; -- 1 row por planta con vigente

-- Idempotencia
SELECT * FROM bitacora.migracion_aplicada WHERE codigo='F26.A1';

# Reiniciar el server nuevamente: NO debe re-loguear "[F26.A1]" ni intentar correr el bloque.
```

## Lo que NO hagas en este prompt

- NO toques `server/server.js` (siguientes prompts).
- NO toques `server/utils/notificador.js` ni `server/utils/snapshots.js` (prompt 02).
- NO modifiques tests (prompt 05).
- NO escribas docs (prompt 06).
