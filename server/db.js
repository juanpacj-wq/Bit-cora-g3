import sql from 'mssql';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword, HASH_PREFIX } from './utils/password.js';

const PERSONAL_JSON_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'data',
  'personal-2026.json'
);

const rawHost = process.env.DB_HOST || '';
let server = rawHost;
let instanceName;

if (rawHost.includes('\\')) {
  const [host, instance] = rawHost.split('\\');
  server = host;
  instanceName = instance;
}

const poolConfig = {
  server,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: instanceName ? undefined : parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: false,
    trustServerCertificate: true,
    ...(instanceName ? { instanceName } : {}),
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

const pool = new sql.ConnectionPool(poolConfig);
const poolConnect = pool.connect();

export async function getDB() {
  await poolConnect;
  return pool;
}

// JSON definitions EXACTAMENTE como en BIT-MODBD-2026-001
const DISP_JSON = JSON.stringify([
  { campo: 'evento', tipo: 'select', opciones: ['Disponible', 'Indisponible', 'En Reserva'], requerido: true },
  { campo: 'codigo', tipo: 'auto', regla: { Disponible: 1, 'En Reserva': 0, Indisponible: -1 } },
]);

const AUTH_JSON = JSON.stringify([
  { campo: 'periodo', tipo: 'auto', fuente: 'periodo_bogota' },
  { campo: 'valor_autorizado_mw', tipo: 'float', requerido: true, label: 'Valor autorizado (MW)' },
  { campo: 'notificar_dashboard', tipo: 'auto', valor: true },
]);

async function migrateColumnToSnapshot(db, { table, oldCol, newCol, indexToDrop }) {
  await db.request().batch(`
    IF COL_LENGTH('${table}','${oldCol}') IS NOT NULL
    BEGIN
      ${indexToDrop ? `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='${indexToDrop}' AND object_id=OBJECT_ID('${table}'))
        DROP INDEX ${indexToDrop} ON ${table};` : ''}
      DECLARE @fk SYSNAME = (SELECT TOP 1 fk.name FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        WHERE fk.parent_object_id = OBJECT_ID('${table}')
          AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = '${oldCol}');
      IF @fk IS NOT NULL EXEC('ALTER TABLE ${table} DROP CONSTRAINT ' + @fk);
      IF COL_LENGTH('${table}','${newCol}') IS NULL
        ALTER TABLE ${table} ADD ${newCol} NVARCHAR(MAX) NULL;
    END
  `);
  await db.request().batch(`
    IF COL_LENGTH('${table}','${oldCol}') IS NOT NULL
       AND COL_LENGTH('${table}','${newCol}') IS NOT NULL
    BEGIN
      UPDATE r SET ${newCol} = (
        SELECT u.usuario_id, u.nombre_completo
        FROM lov_bit.usuario u WHERE u.usuario_id = r.${oldCol}
        FOR JSON PATH
      )
      FROM ${table} r WHERE r.${newCol} IS NULL;
      UPDATE ${table} SET ${newCol} = '[]' WHERE ${newCol} IS NULL;
    END
  `);
  await db.request().batch(`
    IF COL_LENGTH('${table}','${oldCol}') IS NOT NULL
       AND COL_LENGTH('${table}','${newCol}') IS NOT NULL
    BEGIN
      ALTER TABLE ${table} ALTER COLUMN ${newCol} NVARCHAR(MAX) NOT NULL;
      ALTER TABLE ${table} DROP COLUMN ${oldCol};
    END
  `);
}

async function migrateSnapshots(db) {
  const migrations = [
    { table: 'bitacora.registro_activo', oldCol: 'ingeniero_id', newCol: 'ingenieros_snapshot', indexToDrop: 'IX_ra_ing' },
    { table: 'bitacora.registro_activo', oldCol: 'jdt_turno_id', newCol: 'jdts_snapshot' },
    { table: 'bitacora.registro_activo', oldCol: 'jefe_id', newCol: 'jefes_snapshot' },
    { table: 'bitacora.registro_historico', oldCol: 'ingeniero_id', newCol: 'ingenieros_snapshot', indexToDrop: 'IX_rh_ing' },
    { table: 'bitacora.registro_historico', oldCol: 'jdt_turno_id', newCol: 'jdts_snapshot' },
    { table: 'bitacora.registro_historico', oldCol: 'jefe_id', newCol: 'jefes_snapshot' },
    { table: 'bitacora.autorizacion_dashboard', oldCol: 'jdt_id', newCol: 'jdts_snapshot' },
    { table: 'bitacora.autorizacion_dashboard', oldCol: 'jefe_id', newCol: 'jefes_snapshot' },
  ];
  for (const m of migrations) {
    await migrateColumnToSnapshot(db, m);
  }
}

// Migración a v2: agrega usuario.username, cargo.puede_cerrar_turno; hace usuario.email nullable;
// rehashea contraseñas plaintext a bcrypt; renombra cargo 'Jefe de Turno' -> 'Ingeniero Jefe de Turno'.
async function migrateSchemaV2(db) {
  // cargo.puede_cerrar_turno
  await db.request().batch(`
    IF COL_LENGTH('lov_bit.cargo','puede_cerrar_turno') IS NULL
      ALTER TABLE lov_bit.cargo ADD puede_cerrar_turno BIT NOT NULL
        CONSTRAINT DF_cargo_puede_cerrar_turno DEFAULT 0;
  `);

  // usuario.username (nullable first, backfill, then NOT NULL + UNIQUE)
  await db.request().batch(`
    IF COL_LENGTH('lov_bit.usuario','username') IS NULL
      ALTER TABLE lov_bit.usuario ADD username VARCHAR(50) NULL;
  `);
  // Backfill los 2 usuarios pre-existentes (si existen con el email antiguo)
  await db.request().batch(`
    UPDATE lov_bit.usuario SET username='emunoz'
      WHERE username IS NULL AND email='ernesto.munoz@gecelca.com';
    UPDATE lov_bit.usuario SET username='ofedullo'
      WHERE username IS NULL AND email='omar.fedullo@gecelca.com';
  `);
  // Si quedan usuarios sin username, fallar con mensaje claro (no forzamos NOT NULL a ciegas).
  const pending = await db.request().query(`
    SELECT COUNT(*) AS n FROM lov_bit.usuario WHERE username IS NULL;
  `);
  if (pending.recordset[0].n > 0) {
    throw new Error(
      `[migrateSchemaV2] Hay ${pending.recordset[0].n} usuarios sin username. ` +
      `Asigna username manualmente o elimínalos antes de reiniciar.`
    );
  }
  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('lov_bit.usuario') AND name='username' AND is_nullable=1
    )
      ALTER TABLE lov_bit.usuario ALTER COLUMN username VARCHAR(50) NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes WHERE name='UQ_usuario_username' AND object_id=OBJECT_ID('lov_bit.usuario')
    )
      CREATE UNIQUE INDEX UQ_usuario_username ON lov_bit.usuario(username);
  `);

  // usuario.email ahora nullable (antes era NOT NULL UNIQUE)
  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('lov_bit.usuario') AND name='email' AND is_nullable=0
    )
      ALTER TABLE lov_bit.usuario ALTER COLUMN email VARCHAR(200) NULL;
  `);

  // La UNIQUE constraint autogenerada sobre email (era NOT NULL UNIQUE en la tabla original) impide
  // insertar más de un usuario con email NULL en SQL Server. Se busca y elimina.
  await db.request().batch(`
    DECLARE @uq SYSNAME;
    SELECT @uq = kc.name
    FROM sys.key_constraints kc
    INNER JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
    INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE kc.parent_object_id = OBJECT_ID('lov_bit.usuario')
      AND kc.type = 'UQ' AND c.name = 'email';
    IF @uq IS NOT NULL
      EXEC('ALTER TABLE lov_bit.usuario DROP CONSTRAINT [' + @uq + ']');
  `);

  // usuario.password_hash: eliminar DEFAULT '1234' si existe, rehashear texto plano a bcrypt.
  await db.request().batch(`
    DECLARE @df SYSNAME = (
      SELECT dc.name FROM sys.default_constraints dc
      JOIN sys.columns c ON c.default_object_id = dc.object_id
      WHERE dc.parent_object_id = OBJECT_ID('lov_bit.usuario') AND c.name = 'password_hash'
    );
    IF @df IS NOT NULL
      EXEC('ALTER TABLE lov_bit.usuario DROP CONSTRAINT ' + @df);
  `);
  // Rehash de contraseñas en texto plano a scrypt. Detecta "ya hasheadas" por el prefijo `scrypt$`.
  const { recordset: needsRehash } = await db.request().query(`
    SELECT usuario_id FROM lov_bit.usuario
    WHERE password_hash NOT LIKE '${HASH_PREFIX}%'
  `);
  for (const { usuario_id } of needsRehash) {
    const h = await hashPassword('1234');
    await db.request()
      .input('uid',   sql.Int,         usuario_id)
      .input('shash', sql.VarChar(200), h)
      .query(`UPDATE lov_bit.usuario SET password_hash = @shash WHERE usuario_id = @uid`);
  }

  // cargo: rename 'Jefe de Turno' -> 'Ingeniero Jefe de Turno' (preserva cargo_id).
  await db.request().batch(`
    UPDATE lov_bit.cargo SET nombre='Ingeniero Jefe de Turno'
      WHERE nombre='Jefe de Turno';
  `);
}

export async function initDB() {
  const db = await getDB();

  // ---------- 1. Esquemas ----------
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lov_bit')
      EXEC('CREATE SCHEMA lov_bit');
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'bitacora')
      EXEC('CREATE SCHEMA bitacora');
  `);

  // Migra columnas INT FK a snapshots JSON si todavía existen (idempotente)
  await migrateSnapshots(db);

  // ---------- 2. Catálogos (lov_bit) ----------
  await db.request().batch(`
    IF OBJECT_ID('lov_bit.planta', 'U') IS NULL
    CREATE TABLE lov_bit.planta (
      planta_id VARCHAR(10)  PRIMARY KEY,
      nombre    VARCHAR(100) NOT NULL,
      activa    BIT          NOT NULL DEFAULT 1
    );
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.cargo', 'U') IS NULL
    CREATE TABLE lov_bit.cargo (
      cargo_id           INT          IDENTITY(1,1) PRIMARY KEY,
      nombre             VARCHAR(100) NOT NULL,
      solo_lectura       BIT          NOT NULL DEFAULT 0,
      puede_cerrar_turno BIT          NOT NULL DEFAULT 0
    );
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.usuario', 'U') IS NULL
    CREATE TABLE lov_bit.usuario (
      usuario_id      INT          IDENTITY(1,1) PRIMARY KEY,
      nombre_completo VARCHAR(200) NOT NULL,
      username        VARCHAR(50)  NOT NULL UNIQUE,
      email           VARCHAR(200) NULL,
      password_hash   VARCHAR(200) NOT NULL,
      es_jefe_planta  BIT          NOT NULL DEFAULT 0,
      es_jdt_default  BIT          NOT NULL DEFAULT 0,
      activo          BIT          NOT NULL DEFAULT 1
    );
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.bitacora', 'U') IS NULL
    CREATE TABLE lov_bit.bitacora (
      bitacora_id         INT           IDENTITY(1,1) PRIMARY KEY,
      nombre              VARCHAR(100)  NOT NULL,
      codigo              VARCHAR(10)   NOT NULL UNIQUE,
      icono               VARCHAR(50)   NULL,
      formulario_especial BIT           NOT NULL DEFAULT 0,
      definicion_campos   NVARCHAR(MAX) NULL,
      orden               INT           NOT NULL DEFAULT 0,
      activa              BIT           NOT NULL DEFAULT 1
    );
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.tipo_evento', 'U') IS NULL
    CREATE TABLE lov_bit.tipo_evento (
      tipo_evento_id INT          IDENTITY(1,1) PRIMARY KEY,
      bitacora_id    INT          NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
      nombre         VARCHAR(100) NOT NULL,
      es_default     BIT          NOT NULL DEFAULT 0,
      orden          INT          NOT NULL DEFAULT 0
    );
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_tipo_evento_bit' AND object_id=OBJECT_ID('lov_bit.tipo_evento'))
      CREATE INDEX IX_tipo_evento_bit ON lov_bit.tipo_evento(bitacora_id);
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.cargo_bitacora_permiso', 'U') IS NULL
    CREATE TABLE lov_bit.cargo_bitacora_permiso (
      cargo_id    INT NOT NULL REFERENCES lov_bit.cargo(cargo_id),
      bitacora_id INT NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
      puede_ver   BIT NOT NULL DEFAULT 0,
      puede_crear BIT NOT NULL DEFAULT 0,
      PRIMARY KEY (cargo_id, bitacora_id)
    );
  `);

  // ---------- 3. Sesiones (bitacora) ----------
  await db.request().batch(`
    IF OBJECT_ID('bitacora.sesion_activa', 'U') IS NULL
    CREATE TABLE bitacora.sesion_activa (
      sesion_id        INT         IDENTITY(1,1) PRIMARY KEY,
      usuario_id       INT         NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      planta_id        VARCHAR(10) NOT NULL REFERENCES lov_bit.planta(planta_id),
      cargo_id         INT         NOT NULL REFERENCES lov_bit.cargo(cargo_id),
      turno            TINYINT     NOT NULL CHECK (turno IN (1, 2)),
      inicio_sesion    DATETIME2   NOT NULL DEFAULT GETDATE(),
      ultima_actividad DATETIME2   NOT NULL DEFAULT GETDATE(),
      activa           BIT         NOT NULL DEFAULT 1
    );
  `);
  await db.request().batch(`
    IF COL_LENGTH('bitacora.sesion_activa', 'ultima_actividad') IS NULL
    BEGIN
      ALTER TABLE bitacora.sesion_activa
        ADD ultima_actividad DATETIME2 NOT NULL CONSTRAINT DF_sesion_ultact DEFAULT GETDATE();
    END
  `);
  await db.request().query(`
    UPDATE bitacora.sesion_activa
    SET activa = 0
    WHERE activa = 1
      AND ultima_actividad < DATEADD(MINUTE, -5, GETDATE())
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_sesion_lookup' AND object_id=OBJECT_ID('bitacora.sesion_activa'))
      CREATE INDEX IX_sesion_lookup
        ON bitacora.sesion_activa(activa, planta_id, cargo_id)
        INCLUDE (usuario_id, turno, inicio_sesion);
  `);

  // F2: cerrada_en distingue logout explícito (activa=0 + cerrada_en=NULL) del cierre por
  // sweeper de F4 (activa=0 + cerrada_en=GETDATE()). Hoy todavía nadie escribe esta columna;
  // se añade idempotente para que F4 la consuma sin migración adicional.
  await db.request().batch(`
    IF COL_LENGTH('bitacora.sesion_activa', 'cerrada_en') IS NULL
      ALTER TABLE bitacora.sesion_activa ADD cerrada_en DATETIME2 NULL;
  `);

  // F3: detalle pasa a nullable en ambas tablas. CIET no usa detalle, MAND (F6) tampoco lo
  // requiere siempre. Se hace acá (después de la creación de la tabla) en lugar de en
  // migrateSchemaV2 para mantener la migración acotada a F3.
  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='detalle' AND is_nullable=0
    )
      ALTER TABLE bitacora.registro_activo ALTER COLUMN detalle NVARCHAR(MAX) NULL;
  `);
  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='detalle' AND is_nullable=0
    )
      ALTER TABLE bitacora.registro_historico ALTER COLUMN detalle NVARCHAR(MAX) NULL;
  `);

  // F2: sesion_bitacora trackea participación de un login en cada bitácora. abierta_en al
  // entrar a la vista; finalizada_en cuando el usuario clicka "Finalizar turno" (o el sweeper
  // de F4 lo hace en su nombre). Una sola fila por (sesion_id, bitacora_id) — reabrir es UPSERT.
  await db.request().batch(`
    IF OBJECT_ID('bitacora.sesion_bitacora', 'U') IS NULL
    CREATE TABLE bitacora.sesion_bitacora (
      sesion_bitacora_id INT       IDENTITY(1,1) PRIMARY KEY,
      sesion_id          INT       NOT NULL REFERENCES bitacora.sesion_activa(sesion_id),
      bitacora_id        INT       NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
      abierta_en         DATETIME2 NOT NULL DEFAULT GETDATE(),
      finalizada_en      DATETIME2 NULL,
      CONSTRAINT UQ_sesion_bitacora UNIQUE (sesion_id, bitacora_id)
    );
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_sesion_bit_finalizada' AND object_id=OBJECT_ID('bitacora.sesion_bitacora'))
      CREATE INDEX IX_sesion_bit_finalizada
        ON bitacora.sesion_bitacora(finalizada_en)
        WHERE finalizada_en IS NULL;
  `);

  // ---------- 4. Registros ----------
  await db.request().batch(`
    IF OBJECT_ID('bitacora.registro_activo', 'U') IS NULL
    CREATE TABLE bitacora.registro_activo (
      registro_id         INT           IDENTITY(1,1) PRIMARY KEY,
      bitacora_id         INT           NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
      planta_id           VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
      fecha_evento        DATETIME2     NOT NULL,
      turno               TINYINT       NOT NULL CHECK (turno IN (1, 2)),
      detalle             NVARCHAR(MAX) NOT NULL,
      campos_extra        NVARCHAR(MAX) NULL,
      tipo_evento_id      INT           NOT NULL REFERENCES lov_bit.tipo_evento(tipo_evento_id),
      estado              VARCHAR(20)   NOT NULL DEFAULT 'borrador'
                          CHECK (estado IN ('borrador', 'cerrado')),
      ingenieros_snapshot NVARCHAR(MAX) NOT NULL,
      jdts_snapshot       NVARCHAR(MAX) NOT NULL,
      jefes_snapshot      NVARCHAR(MAX) NOT NULL,
      creado_por          INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      creado_en           DATETIME2     NOT NULL DEFAULT GETDATE(),
      modificado_por      INT           NULL     REFERENCES lov_bit.usuario(usuario_id),
      modificado_en       DATETIME2     NULL
    );
  `);
  const raIndices = [
    ['IX_ra_bitacora', 'bitacora.registro_activo', '(bitacora_id, planta_id)'],
    ['IX_ra_estado', 'bitacora.registro_activo', '(estado)'],
    ['IX_ra_fecha', 'bitacora.registro_activo', '(fecha_evento)'],
    ['IX_ra_creado_por', 'bitacora.registro_activo', '(creado_por)'],
  ];
  for (const [name, table, cols] of raIndices) {
    await db.request().batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='${name}' AND object_id=OBJECT_ID('${table}'))
        CREATE INDEX ${name} ON ${table} ${cols};
    `);
  }

  await db.request().batch(`
    IF OBJECT_ID('bitacora.registro_historico', 'U') IS NULL
    CREATE TABLE bitacora.registro_historico (
      registro_id            INT           PRIMARY KEY,  -- preserva ID original, NO IDENTITY
      bitacora_id            INT           NOT NULL,
      planta_id              VARCHAR(10)   NOT NULL,
      fecha_evento           DATETIME2     NOT NULL,
      turno                  TINYINT       NOT NULL,
      detalle                NVARCHAR(MAX) NOT NULL,
      campos_extra           NVARCHAR(MAX) NULL,
      tipo_evento_id         INT           NOT NULL,
      estado                 VARCHAR(20)   NOT NULL DEFAULT 'cerrado',
      ingenieros_snapshot    NVARCHAR(MAX) NOT NULL,
      jdts_snapshot          NVARCHAR(MAX) NOT NULL,
      jefes_snapshot         NVARCHAR(MAX) NOT NULL,
      creado_por             INT           NOT NULL,
      creado_en              DATETIME2     NOT NULL,
      modificado_por         INT           NULL,
      modificado_en          DATETIME2     NULL,
      cerrado_por            INT           NOT NULL,
      cerrado_en             DATETIME2     NOT NULL DEFAULT GETDATE(),
      fecha_cierre_operativo DATE          NOT NULL
    );
  `);
  const rhIndices = [
    ['IX_rh_fecha', 'bitacora.registro_historico', '(fecha_cierre_operativo, bitacora_id)'],
    ['IX_rh_planta', 'bitacora.registro_historico', '(planta_id, bitacora_id)'],
    ['IX_rh_creado_por', 'bitacora.registro_historico', '(creado_por)'],
    ['IX_rh_bit', 'bitacora.registro_historico', '(bitacora_id)'],
  ];
  for (const [name, table, cols] of rhIndices) {
    await db.request().batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='${name}' AND object_id=OBJECT_ID('${table}'))
        CREATE INDEX ${name} ON ${table} ${cols};
    `);
  }

  // ---------- 5. Autorizaciones Dashboard ----------
  await db.request().batch(`
    IF OBJECT_ID('bitacora.autorizacion_dashboard', 'U') IS NULL
    CREATE TABLE bitacora.autorizacion_dashboard (
      autorizacion_id     INT           IDENTITY(1,1) PRIMARY KEY,
      registro_origen_id  INT           NOT NULL,
      planta_id           VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
      fecha               DATE          NOT NULL,
      periodo             TINYINT       NOT NULL CHECK (periodo BETWEEN 1 AND 24),
      valor_autorizado_mw FLOAT         NOT NULL,
      jdts_snapshot       NVARCHAR(MAX) NOT NULL,
      jefes_snapshot      NVARCHAR(MAX) NOT NULL,
      activa              BIT           NOT NULL DEFAULT 1,
      creado_en           DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT UQ_auth_planta_fecha_periodo UNIQUE (planta_id, fecha, periodo)
    );
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_auth_lookup' AND object_id=OBJECT_ID('bitacora.autorizacion_dashboard'))
      CREATE INDEX IX_auth_lookup ON bitacora.autorizacion_dashboard(planta_id, fecha, activa);
  `);

  // ---------- 6. Migración schema v2 (columnas nuevas en tablas existentes) ----------
  await migrateSchemaV2(db);

  // ---------- 7. Datos semilla ----------
  await db.request().batch(`
    MERGE lov_bit.planta AS t
    USING (VALUES ('GEC3','Gecelca 3'),('GEC32','Gecelca 3.2')) AS s(planta_id, nombre)
      ON t.planta_id = s.planta_id
    WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (s.planta_id, s.nombre, 1);
  `);

  // Cargos definitivos según LISTADO DE PERSONAL 2026.xlsx.
  // puede_cerrar_turno=1 para Ingeniero Jefe de Turno e Ingeniero de Operación (mismo poder operativo,
  // roles distintos en UI y snapshots).
  await db.request().batch(`
    MERGE lov_bit.cargo AS t
    USING (VALUES
      ('Gerente de Producción',                1, 0),
      ('Ingeniero Jefe de Turno',              0, 1),
      ('Ingeniero de Operación',               0, 1),
      ('Ingeniero Químico',                    0, 0),
      ('Operador de Planta - Caldera',         0, 0),
      ('Operador de Planta - Analista',        0, 0),
      ('Operador de Planta - Sala de Mando',   0, 0),
      ('Operador de Planta - Planta de Agua',  0, 0),
      ('Operador de Planta - Turbogrupo',      0, 0),
      ('Operador Maquinaria Pesada',           0, 0),
      ('Operador de Planta - Carbón y Caliza', 0, 0)
    ) AS s(nombre, solo_lectura, puede_cerrar_turno)
      ON t.nombre = s.nombre
    WHEN MATCHED THEN UPDATE SET
      solo_lectura       = s.solo_lectura,
      puede_cerrar_turno = s.puede_cerrar_turno
    WHEN NOT MATCHED THEN INSERT (nombre, solo_lectura, puede_cerrar_turno)
      VALUES (s.nombre, s.solo_lectura, s.puede_cerrar_turno);
  `);

  // Eliminar cargo obsoleto 'Ingeniero de Planta de Agua' (no existe en el Excel 2026).
  // Primero limpiamos dependencias en cargo_bitacora_permiso y sesion_activa.
  await db.request().batch(`
    DECLARE @cargo_obsoleto INT = (SELECT cargo_id FROM lov_bit.cargo WHERE nombre='Ingeniero de Planta de Agua');
    IF @cargo_obsoleto IS NOT NULL
    BEGIN
      DELETE FROM lov_bit.cargo_bitacora_permiso WHERE cargo_id = @cargo_obsoleto;
      DELETE FROM bitacora.sesion_activa         WHERE cargo_id = @cargo_obsoleto;
      DELETE FROM lov_bit.cargo                  WHERE cargo_id = @cargo_obsoleto;
    END
  `);

  // Paso 1: Renombrar códigos preservados (CAL→CALDERA, TURB→TURBO).
  await db.request().batch(`
    UPDATE lov_bit.bitacora SET codigo='CALDERA' WHERE codigo='CAL';
    UPDATE lov_bit.bitacora SET codigo='TURBO'   WHERE codigo='TURB';
  `);

  // Paso 2: Eliminar bitácoras obsoletas (SINC, ELEC, IC, MA) y sus dependencias.
  // Falla si hay registros (activos o históricos) que la referencien — guardarraíl defensivo.
  await db.request().batch(`
    DECLARE @obs TABLE (bitacora_id INT);
    INSERT INTO @obs (bitacora_id)
      SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo IN ('SINC','ELEC','IC','MA');

    IF EXISTS (SELECT 1 FROM bitacora.registro_activo WHERE bitacora_id IN (SELECT bitacora_id FROM @obs))
      THROW 50001, 'No se pueden eliminar bitácoras obsoletas: existen registros activos. Limpia bitacora.registro_activo primero.', 1;
    IF EXISTS (SELECT 1 FROM bitacora.registro_historico WHERE bitacora_id IN (SELECT bitacora_id FROM @obs))
      THROW 50002, 'No se pueden eliminar bitácoras obsoletas: existen registros históricos. Limpia bitacora.registro_historico primero.', 1;

    DELETE FROM lov_bit.cargo_bitacora_permiso WHERE bitacora_id IN (SELECT bitacora_id FROM @obs);
    DELETE FROM lov_bit.tipo_evento            WHERE bitacora_id IN (SELECT bitacora_id FROM @obs);
    DELETE FROM lov_bit.bitacora               WHERE bitacora_id IN (SELECT bitacora_id FROM @obs);
  `);

  // Paso 3: MERGE con las 10 bitácoras definitivas (orden según hoja BITÁCORAS del Excel 2026,
  // con DISP y AUTH separadas en posiciones 8 y 9).
  const bitReq = db.request();
  bitReq.input('disp', sql.NVarChar(sql.MAX), DISP_JSON);
  bitReq.input('auth', sql.NVarChar(sql.MAX), AUTH_JSON);
  await bitReq.batch(`
    MERGE lov_bit.bitacora AS t
    USING (VALUES
      ('Caldera',                'CALDERA', 'Flame',        0, NULL,  1),
      ('Análisis',               'ANAL',    'TestTube',     0, NULL,  2),
      ('Sala de Mando',          'SALA',    'Monitor',      0, NULL,  3),
      ('Planta de Agua',         'AGUA',    'Droplets',     0, NULL,  4),
      ('Turbogrupo',             'TURBO',   'Gauge',        0, NULL,  5),
      ('Maquinaria',             'MAQU',    'Truck',        0, NULL,  6),
      ('Carbón y Caliza',        'CYC',     'Mountain',     0, NULL,  7),
      ('Disponibilidad',         'DISP',    'Activity',     1, @disp, 8),
      ('Autorizaciones',         'AUTH',    'FileCheck',    1, @auth, 9),
      ('Química',                'QUIM',    'FlaskConical', 0, NULL, 10),
      ('Cierres y Finalizaciones','CIET',   'LogOut',       0, NULL, 11)
    ) AS s(nombre, codigo, icono, formulario_especial, definicion_campos, orden)
      ON t.codigo = s.codigo
    WHEN MATCHED THEN UPDATE SET
      nombre = s.nombre,
      icono = s.icono,
      formulario_especial = s.formulario_especial,
      definicion_campos = s.definicion_campos,
      orden = s.orden,
      activa = 1
    WHEN NOT MATCHED THEN INSERT (nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa)
      VALUES (s.nombre, s.codigo, s.icono, s.formulario_especial, s.definicion_campos, s.orden, 1);
  `);

  // tipo_evento default por bitácora
  // F3: CIET se excluye — sus tipos son exclusivamente 'Finalización de turno' y 'Cierre de turno'.
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, es_default, orden)
    SELECT b.bitacora_id, 'Evento General', 1, 0
    FROM lov_bit.bitacora b
    WHERE b.codigo <> 'CIET'
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        WHERE te.bitacora_id = b.bitacora_id AND te.nombre = 'Evento General'
      );
  `);

  // tipos específicos para DISP
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
    SELECT b.bitacora_id, s.nombre, s.orden
    FROM lov_bit.bitacora b
    CROSS JOIN (VALUES
      ('Cambio de Estado', 1),
      ('Redespacho', 2),
      ('Sincronización', 3)
    ) AS s(nombre, orden)
    WHERE b.codigo = 'DISP'
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        WHERE te.bitacora_id = b.bitacora_id AND te.nombre = s.nombre
      );
  `);

  // F3: tipos de evento CIET. Se generan automáticamente desde /api/bitacora/finalizar y
  // /api/cierre/bitacora — ningún cargo tiene puede_crear=1 en CIET.
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
    SELECT b.bitacora_id, s.nombre, s.orden
    FROM lov_bit.bitacora b
    CROSS JOIN (VALUES
      ('Finalización de turno', 1),
      ('Cierre de turno', 2)
    ) AS s(nombre, orden)
    WHERE b.codigo = 'CIET'
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        WHERE te.bitacora_id = b.bitacora_id AND te.nombre = s.nombre
      );
  `);

  // Matriz de permisos (cargo × bitácora) derivada del Excel 2026.
  // Nota clave: Ingeniero Jefe de Turno e Ingeniero de Operación tienen filas idénticas (mismo
  // poder operativo). La distinción de rol se preserva por cargo.nombre en UI y snapshots.
  // Se reconstruye desde cero con DELETE + MERGE para limpiar combinaciones muertas.
  await db.request().batch(`
    DELETE FROM lov_bit.cargo_bitacora_permiso;

    ;WITH matriz AS (
      SELECT c.cargo_id, b.bitacora_id,
        CASE
          -- F3: CIET es read-only para TODOS los cargos (los registros se generan automáticamente).
          WHEN b.codigo = 'CIET' THEN 1
          -- Gerente de Producción ve todo
          WHEN c.nombre = 'Gerente de Producción'                THEN 1
          -- Ingeniero Jefe de Turno / Ingeniero de Operación ven todo
          WHEN c.nombre IN ('Ingeniero Jefe de Turno','Ingeniero de Operación') THEN 1
          -- Ingeniero Químico ve todo
          WHEN c.nombre = 'Ingeniero Químico'                    THEN 1
          -- Operadores sólo ven su propia bitácora
          WHEN c.nombre = 'Operador de Planta - Caldera'         THEN CASE WHEN b.codigo='CALDERA' THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Analista'        THEN CASE WHEN b.codigo='ANAL'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Sala de Mando'   THEN CASE WHEN b.codigo='SALA'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Planta de Agua'  THEN CASE WHEN b.codigo='AGUA'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Turbogrupo'      THEN CASE WHEN b.codigo='TURBO'   THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador Maquinaria Pesada'           THEN CASE WHEN b.codigo='MAQU'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Carbón y Caliza' THEN CASE WHEN b.codigo='CYC'     THEN 1 ELSE 0 END
          ELSE 0
        END AS puede_ver,
        CASE
          -- F3: nadie crea en CIET (registros automáticos).
          WHEN b.codigo = 'CIET' THEN 0
          -- Gerente no crea en nada
          WHEN c.nombre = 'Gerente de Producción'                THEN 0
          -- JdT e IngOp sólo crean en DISP y AUTH
          WHEN c.nombre IN ('Ingeniero Jefe de Turno','Ingeniero de Operación') THEN CASE WHEN b.codigo IN ('DISP','AUTH') THEN 1 ELSE 0 END
          -- IngQuímico sólo crea en QUIM
          WHEN c.nombre = 'Ingeniero Químico'                    THEN CASE WHEN b.codigo='QUIM'    THEN 1 ELSE 0 END
          -- Operadores crean sólo en su propia bitácora (igual que puede_ver)
          WHEN c.nombre = 'Operador de Planta - Caldera'         THEN CASE WHEN b.codigo='CALDERA' THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Analista'        THEN CASE WHEN b.codigo='ANAL'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Sala de Mando'   THEN CASE WHEN b.codigo='SALA'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Planta de Agua'  THEN CASE WHEN b.codigo='AGUA'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Turbogrupo'      THEN CASE WHEN b.codigo='TURBO'   THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador Maquinaria Pesada'           THEN CASE WHEN b.codigo='MAQU'    THEN 1 ELSE 0 END
          WHEN c.nombre = 'Operador de Planta - Carbón y Caliza' THEN CASE WHEN b.codigo='CYC'     THEN 1 ELSE 0 END
          ELSE 0
        END AS puede_crear
      FROM lov_bit.cargo c CROSS JOIN lov_bit.bitacora b
      WHERE b.activa = 1
    )
    INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
    SELECT cargo_id, bitacora_id, puede_ver, puede_crear FROM matriz;
  `);

  // Semilla de personal (83 usuarios del Excel 2026)
  await seedPersonal(db);

  // ---------- 7. Vistas ----------
  await db.request().batch(`
    CREATE OR ALTER VIEW bitacora.v_ingenieros_en_turno AS
    SELECT s.planta_id, s.turno, u.usuario_id, u.nombre_completo,
           c.nombre AS cargo, s.inicio_sesion
    FROM bitacora.sesion_activa s
    JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
    JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
    WHERE s.activa = 1;
  `);

  await db.request().batch(`
    CREATE OR ALTER VIEW bitacora.v_jdt_actual AS
    SELECT DISTINCT s.planta_id,
      FIRST_VALUE(s.usuario_id) OVER (
        PARTITION BY s.planta_id ORDER BY s.inicio_sesion DESC
      ) AS jdt_usuario_id,
      FIRST_VALUE(u.nombre_completo) OVER (
        PARTITION BY s.planta_id ORDER BY s.inicio_sesion DESC
      ) AS jdt_nombre
    FROM bitacora.sesion_activa s
    JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
    WHERE s.activa = 1
      AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Ingeniero Jefe de Turno');
  `);

  await db.request().batch(`
    CREATE OR ALTER VIEW bitacora.v_historico_busqueda AS
    SELECT h.registro_id, h.fecha_evento, h.turno, h.detalle,
           h.campos_extra, h.fecha_cierre_operativo,
           b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
           p.nombre AS planta_nombre, h.planta_id,
           te.nombre AS tipo_evento,
           h.ingenieros_snapshot, h.jdts_snapshot, h.jefes_snapshot,
           autor.nombre_completo AS creado_por_nombre,
           h.creado_por AS creado_por_id,
           h.creado_en
    FROM bitacora.registro_historico h
    JOIN lov_bit.bitacora b ON b.bitacora_id = h.bitacora_id
    JOIN lov_bit.planta p ON p.planta_id = h.planta_id
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = h.tipo_evento_id
    LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = h.creado_por;
  `);

  console.log('[DB] Conexión OK');
}

// Carga server/data/personal-2026.json y hace UPSERT contra lov_bit.usuario por username.
// Todos los usuarios usan scrypt('1234') como password inicial. Las filas ya existentes conservan
// su password_hash actual (no se resetean si alguien ya cambió su clave).
async function seedPersonal(db) {
  const raw = await readFile(PERSONAL_JSON_PATH, 'utf8');
  const personal = JSON.parse(raw);
  if (!Array.isArray(personal) || personal.length === 0) {
    throw new Error(`[seedPersonal] ${PERSONAL_JSON_PATH} vacío o no es un array`);
  }
  // Un hash distinto por usuario (cada uno con salt aleatorio). Para 83 filas cuesta ~10s total;
  // sólo ocurre en el primer arranque (WHEN NOT MATCHED no se dispara en arranques siguientes).

  // Validar que cada cargo referenciado existe en lov_bit.cargo
  const cargoSet = new Set(personal.map(p => p.cargo));
  const cargoRows = await db.request().query('SELECT cargo_id, nombre FROM lov_bit.cargo');
  const cargoByName = new Map(cargoRows.recordset.map(c => [c.nombre, c.cargo_id]));
  for (const name of cargoSet) {
    if (!cargoByName.has(name)) {
      throw new Error(`[seedPersonal] Cargo '${name}' referenciado en personal-2026.json no existe en lov_bit.cargo`);
    }
  }

  // UPSERT por username (fila a fila: volumen bajo, 83 registros).
  for (const p of personal) {
    const hashed = await hashPassword('1234');
    await db.request()
      .input('nombre_completo', sql.VarChar(200), p.nombre_completo)
      .input('username',        sql.VarChar(50),  p.username)
      .input('password_hash',   sql.VarChar(200), hashed)
      .input('es_jefe_planta',  sql.Bit,          !!p.es_jefe_planta)
      .input('es_jdt_default',  sql.Bit,          !!p.es_jdt_default)
      .query(`
        MERGE lov_bit.usuario AS t
        USING (VALUES (@nombre_completo, @username, @password_hash, @es_jefe_planta, @es_jdt_default))
            AS s (nombre_completo, username, password_hash, es_jefe_planta, es_jdt_default)
          ON t.username = s.username
        WHEN MATCHED THEN UPDATE SET
          nombre_completo = s.nombre_completo,
          es_jefe_planta  = s.es_jefe_planta,
          es_jdt_default  = s.es_jdt_default,
          activo          = 1
        WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
          VALUES (s.nombre_completo, s.username, NULL, s.password_hash, s.es_jefe_planta, s.es_jdt_default, 1);
      `);
  }

  console.log(`[DB] seedPersonal: ${personal.length} usuarios procesados`);
}
