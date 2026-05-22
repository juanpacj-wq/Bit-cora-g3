# Prompt 01 — Schema, vista, seeds (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Preguntas resueltas:** `PREGUNTAS-D-027.md`

## Tu tarea

Agregar a `server/db.js::initDB()` un bloque idempotente gateado por flag `F26.B1` en `bitacora.migracion_aplicada` que:

1. Crea `lov_bit.combustible` (catálogo).
2. Crea índice y UNIQUE constraint del catálogo.
3. Seedea las **18 entradas** (8 GEC3 + 10 GEC32) — idempotente con `IF NOT EXISTS` por `(planta_id, codigo)`.
4. Crea `bitacora.consumo_combustible` (transaccional long-format).
5. Crea índices + columnas Bogotá calculadas.
6. `CREATE OR ALTER VIEW bitacora.v_consumo_periodo` con Total Carbón derivado.
7. Inserta fila marcadora en `lov_bit.bitacora` (codigo `COMB`) si no existe.
8. Seedea permisos en `lov_bit.cargo_bitacora_permiso` para los 2 cargos privilegiados + ver-only para el resto.
9. Marca flag `F26.B1` en `migracion_aplicada`.

Todo dentro de una transacción única (rollback si algo falla, sin marcar flag → siguiente arranque reintenta). NO toques handlers de `server.js` ni frontend.

## Patrón idempotente del repo

Buscá en `server/db.js` los bloques gateados por `F16.A1`, `F22.D1`, `F26.A1` (si D-026 ya corrió). El patrón es:

```js
const flag = await db.request().query(
  `SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo = 'F26.B1'`
);
if (!flag.recordset[0]) {
  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    // ...DDL + seeds...
    await new sql.Request(tx).query(`
      INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F26.B1')
    `);
    await tx.commit();
    console.log('[F26.B1] Catálogo combustibles + tabla consumo + vista + permisos creados');
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}
```

## DDL exacto

### Catálogo

```sql
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='combustible' AND schema_id=SCHEMA_ID('lov_bit'))
CREATE TABLE lov_bit.combustible (
  combustible_id  INT IDENTITY(1,1) PRIMARY KEY,
  planta_id       VARCHAR(10)  NOT NULL REFERENCES lov_bit.planta(planta_id),
  codigo          VARCHAR(20)  NOT NULL,
  nombre          VARCHAR(100) NOT NULL,
  unidad          VARCHAR(10)  NOT NULL,
  tipo            VARCHAR(20)  NOT NULL CHECK (tipo IN ('ALIMENTADOR','CALIZA','ACPM')),
  orden           INT          NOT NULL DEFAULT 0,
  activo          BIT          NOT NULL DEFAULT 1,
  CONSTRAINT UQ_combustible_planta_codigo UNIQUE (planta_id, codigo)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_combustible_planta_orden')
CREATE INDEX IX_combustible_planta_orden ON lov_bit.combustible(planta_id, orden) WHERE activo = 1;
```

### Seeds catálogo (idempotentes)

```sql
-- GEC3 (6 alimentadores A-F + Caliza + ACPM = 8)
MERGE lov_bit.combustible AS t
USING (VALUES
  ('GEC3', 'ALIM_A', 'Alimentador A', 'Ton', 'ALIMENTADOR', 1),
  ('GEC3', 'ALIM_B', 'Alimentador B', 'Ton', 'ALIMENTADOR', 2),
  ('GEC3', 'ALIM_C', 'Alimentador C', 'Ton', 'ALIMENTADOR', 3),
  ('GEC3', 'ALIM_D', 'Alimentador D', 'Ton', 'ALIMENTADOR', 4),
  ('GEC3', 'ALIM_E', 'Alimentador E', 'Ton', 'ALIMENTADOR', 5),
  ('GEC3', 'ALIM_F', 'Alimentador F', 'Ton', 'ALIMENTADOR', 6),
  ('GEC3', 'CALIZA', 'Caliza',        'Ton', 'CALIZA',      7),
  ('GEC3', 'ACPM',   'ACPM',          'Gal', 'ACPM',        8),
  -- GEC32 (8 alimentadores 1-8 + Caliza + ACPM = 10)
  ('GEC32','ALIM_1', 'Alimentador 1', 'Ton', 'ALIMENTADOR', 1),
  ('GEC32','ALIM_2', 'Alimentador 2', 'Ton', 'ALIMENTADOR', 2),
  ('GEC32','ALIM_3', 'Alimentador 3', 'Ton', 'ALIMENTADOR', 3),
  ('GEC32','ALIM_4', 'Alimentador 4', 'Ton', 'ALIMENTADOR', 4),
  ('GEC32','ALIM_5', 'Alimentador 5', 'Ton', 'ALIMENTADOR', 5),
  ('GEC32','ALIM_6', 'Alimentador 6', 'Ton', 'ALIMENTADOR', 6),
  ('GEC32','ALIM_7', 'Alimentador 7', 'Ton', 'ALIMENTADOR', 7),
  ('GEC32','ALIM_8', 'Alimentador 8', 'Ton', 'ALIMENTADOR', 8),
  ('GEC32','CALIZA', 'Caliza',        'Ton', 'CALIZA',      9),
  ('GEC32','ACPM',   'ACPM',          'Gal', 'ACPM',       10)
) AS s(planta_id, codigo, nombre, unidad, tipo, orden)
  ON t.planta_id = s.planta_id AND t.codigo = s.codigo
WHEN NOT MATCHED THEN INSERT (planta_id, codigo, nombre, unidad, tipo, orden)
  VALUES (s.planta_id, s.codigo, s.nombre, s.unidad, s.tipo, s.orden);
```

### Transaccional

```sql
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='consumo_combustible' AND schema_id=SCHEMA_ID('bitacora'))
CREATE TABLE bitacora.consumo_combustible (
  consumo_id       INT IDENTITY(1,1) PRIMARY KEY,
  planta_id        VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
  fecha            DATE          NOT NULL,
  periodo          TINYINT       NOT NULL CHECK (periodo BETWEEN 1 AND 24),
  combustible_id   INT           NOT NULL REFERENCES lov_bit.combustible(combustible_id),
  cantidad         DECIMAL(12,3) NOT NULL CHECK (cantidad >= 0),
  detalle          NVARCHAR(MAX) NULL,
  creado_por       INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
  creado_en        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  modificado_por   INT           NULL REFERENCES lov_bit.usuario(usuario_id),
  modificado_en    DATETIME2     NULL,
  CONSTRAINT UQ_consumo_planta_fecha_periodo_combustible UNIQUE (planta_id, fecha, periodo, combustible_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_consumo_planta_fecha')
CREATE INDEX IX_consumo_planta_fecha ON bitacora.consumo_combustible(planta_id, fecha DESC, periodo);
```

### Columnas Bogotá (patrón F22)

```sql
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='creado_en_bogota'
               AND object_id=OBJECT_ID('bitacora.consumo_combustible'))
  ALTER TABLE bitacora.consumo_combustible ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='modificado_en_bogota'
               AND object_id=OBJECT_ID('bitacora.consumo_combustible'))
  ALTER TABLE bitacora.consumo_combustible ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
```

### Vista

```sql
CREATE OR ALTER VIEW bitacora.v_consumo_periodo AS
SELECT
  c.planta_id,
  c.fecha,
  c.periodo,
  SUM(CASE WHEN cb.tipo = 'ALIMENTADOR' THEN c.cantidad ELSE 0 END) AS total_carbon_ton,
  SUM(CASE WHEN cb.tipo = 'CALIZA'      THEN c.cantidad ELSE 0 END) AS caliza_ton,
  SUM(CASE WHEN cb.tipo = 'ACPM'        THEN c.cantidad ELSE 0 END) AS acpm_gal,
  MAX(c.modificado_en)                                              AS modificado_en
FROM bitacora.consumo_combustible c
JOIN lov_bit.combustible cb ON cb.combustible_id = c.combustible_id
GROUP BY c.planta_id, c.fecha, c.periodo;
```

### Fila marcadora en `lov_bit.bitacora`

```sql
IF NOT EXISTS (SELECT 1 FROM lov_bit.bitacora WHERE codigo='COMB')
INSERT INTO lov_bit.bitacora (nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa, oculta)
VALUES ('Consumos', 'COMB', 'Flame', 1, NULL, 11, 1, 0);
```

### Seeds permisos

```sql
DECLARE @comb_bid INT = (SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='COMB');

-- Cargos con puede_crear=1 (Operador Carbón y Caliza + JdT)
MERGE lov_bit.cargo_bitacora_permiso AS t
USING (
  SELECT c.cargo_id, @comb_bid AS bitacora_id,
         CAST(1 AS BIT) AS puede_ver, CAST(1 AS BIT) AS puede_crear
  FROM lov_bit.cargo c
  WHERE c.nombre IN ('Operador de Planta - Carbón y Caliza', 'Ingeniero Jefe de Turno')
) AS s
  ON t.cargo_id = s.cargo_id AND t.bitacora_id = s.bitacora_id
WHEN MATCHED THEN UPDATE SET puede_ver = s.puede_ver, puede_crear = s.puede_crear
WHEN NOT MATCHED THEN INSERT (cargo_id, bitacora_id, puede_ver, puede_crear)
  VALUES (s.cargo_id, s.bitacora_id, s.puede_ver, s.puede_crear);

-- Resto de cargos: puede_ver=1, puede_crear=0
MERGE lov_bit.cargo_bitacora_permiso AS t
USING (
  SELECT c.cargo_id, @comb_bid AS bitacora_id,
         CAST(1 AS BIT) AS puede_ver, CAST(0 AS BIT) AS puede_crear
  FROM lov_bit.cargo c
  WHERE c.nombre NOT IN ('Operador de Planta - Carbón y Caliza', 'Ingeniero Jefe de Turno')
) AS s
  ON t.cargo_id = s.cargo_id AND t.bitacora_id = s.bitacora_id
WHEN NOT MATCHED THEN INSERT (cargo_id, bitacora_id, puede_ver, puede_crear)
  VALUES (s.cargo_id, s.bitacora_id, s.puede_ver, s.puede_crear);
```

(Nota: la segunda MERGE solo INSERTea para cargos que aún no tienen fila; no sobreescribe permisos manualmente ajustados después de la migración.)

## Importante (gotchas)

1. **`MERGE` necesita un `;` al final** en SQL Server. Si pegás múltiples MERGEs seguidos, ponelo siempre.
2. **El cargo `Operador de Planta - Carbón y Caliza` debe existir** antes de correr esta migración. Si arrancás contra una BD vacía, primero corre `seedPersonal()` (que carga `personal-2026.json`); este bloque va DESPUÉS.
3. **Tipo de `cantidad` es `DECIMAL(12,3)`** — soporta hasta 999_999_999.999 (suficiente para Ton diarios). Si querés más precisión, ajustá.
4. **Validar conteo post-seed**: opcional pero recomendado:
   ```sql
   IF (SELECT COUNT(*) FROM lov_bit.combustible) < 18
     THROW 50002, 'F26.B1: seeds de combustible incompletos', 1;
   ```
5. **No marcar el flag si algo falla**: el `THROW` o exception debe quedar dentro de la transacción para que el ROLLBACK borre todo.
6. **Si D-026 (DISP) ya corrió**, no hay conflicto: F26.A1 y F26.B1 son bloques independientes.

## Verificación

```powershell
# Restart server — debe loguear "[F26.B1] Catálogo combustibles + ..."
cd server
node --watch --env-file=../.env server.js

# En SSMS o sqlcmd:
SELECT * FROM lov_bit.combustible ORDER BY planta_id, orden;
-- Esperado: 18 filas (8 GEC3 + 10 GEC32)

SELECT * FROM lov_bit.bitacora WHERE codigo='COMB';
-- Esperado: 1 fila con nombre='Consumos', icono='Flame', formulario_especial=1

SELECT b.codigo, c.nombre AS cargo, p.puede_ver, p.puede_crear
FROM lov_bit.cargo_bitacora_permiso p
JOIN lov_bit.cargo c ON c.cargo_id = p.cargo_id
JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
WHERE b.codigo = 'COMB' ORDER BY p.puede_crear DESC, c.nombre;
-- Esperado: 'Operador de Planta - Carbón y Caliza' y 'Ingeniero Jefe de Turno' con puede_crear=1;
--           resto de cargos con puede_crear=0

SELECT * FROM bitacora.migracion_aplicada WHERE codigo='F26.B1';
-- Esperado: 1 fila

-- Idempotencia: reiniciar el server. NO debe re-loguear ni re-insertar.
```

## Lo que NO hagas en este prompt

- NO toques `server/server.js` (prompts 02).
- NO toques frontend (prompts 03–04).
- NO escribas tests (prompt 05).
- NO escribas docs (prompt 06).
