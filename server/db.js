import sql from 'mssql';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword, HASH_PREFIX } from './utils/password.js';
import { ventanaTurno } from './utils/turno.js';
import { buildConformacionSnapshot, persistConformacionSnapshot } from './utils/conformacion-snapshot.js';

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

// F16.A3: id del usuario sistema dedicado a CIETs automáticos (cierre diario MAND).
// Se cachea al final de initDB() y lo consume mand-sweeper.js + el endpoint de cierre manual.
export let USUARIO_SISTEMA_ID = null;

// JSON definitions EXACTAMENTE como en BIT-MODBD-2026-001.
// D-024 (2026-05-15): rebrand de estados DISP. "Disponible" → "En Servicio" + nuevo estado
// "Mantenimiento". Indisponible y Mantenimiento comparten codigo=-1; se distinguen por el
// string `evento` (Indisponible = salida forzada; Mantenimiento = consignación / salida
// planeada). Esto preserva la métrica numérica "horas de indisponibilidad" = sum(codigo=-1).
const DISP_JSON = JSON.stringify([
  { campo: 'evento', tipo: 'select', opciones: ['En Servicio', 'En Reserva', 'Indisponible', 'Mantenimiento'], requerido: true },
  { campo: 'codigo', tipo: 'auto', regla: { 'En Servicio': 1, 'En Reserva': 0, Indisponible: -1, Mantenimiento: -1 } },
]);

const AUTH_JSON = JSON.stringify([
  { campo: 'periodo', tipo: 'auto', fuente: 'periodo_bogota' },
  { campo: 'valor_autorizado_mw', tipo: 'float', requerido: true, label: 'Valor autorizado (MW)' },
  { campo: 'notificar_dashboard', tipo: 'auto', valor: true },
]);

// F6: definicion_campos de MAND. periodo y valor_mw son requeridos; funcionariocnd opcional
// (se exige solo cuando tipo_evento = 'Autorización' — ver server.js POST /api/registros).
const MAND_JSON = JSON.stringify([
  { campo: 'periodo', tipo: 'int', min: 1, max: 24, requerido: true },
  { campo: 'valor_mw', tipo: 'float', requerido: true, label: 'Valor (MW)' },
  { campo: 'funcionariocnd', tipo: 'text', requerido: false, label: 'Funcionario CND' },
]);

async function migrateColumnToSnapshot(db, { table, oldCol, newCol, indexToDrop }) {
  // Guard a nivel JS: SQL Server compila el batch completo antes del IF y resuelve
  // referencias de columna en compile-time (no hay deferred name resolution para columnas
  // de tablas existentes en batches ad-hoc). Si la columna vieja ya no existe, los batches
  // de abajo —que referencian r.${oldCol}— fallarían a compilar aunque el IF nunca corra.
  const probe = await db.request().query(
    `SELECT COL_LENGTH('${table}','${oldCol}') AS len`
  );
  if (probe.recordset[0].len === null) return;

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
    // F5: la tabla se renombra a evento_dashboard. Si todavía existe la vieja, las migraciones
    // de snapshots ya corrieron en deploys previos — el COL_LENGTH guard evita re-trabajo.
    { table: 'bitacora.evento_dashboard', oldCol: 'jdt_id', newCol: 'jdts_snapshot' },
    { table: 'bitacora.evento_dashboard', oldCol: 'jefe_id', newCol: 'jefes_snapshot' },
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
      activa              BIT           NOT NULL DEFAULT 1,
      oculta              BIT           NOT NULL DEFAULT 0
    );
  `);

  // F10: oculta=1 marca bitácoras de auditoría interna que NO deben aparecer en frontend
  // (tabs, catálogos, históricos, cierres masivos). Sus registros se siguen creando vía
  // helpers internos (ej. registrarEventoCierre para CIET). El UPDATE post-MERGE garantiza
  // el flag.
  await db.request().batch(`
    IF COL_LENGTH('lov_bit.bitacora','oculta') IS NULL
      ALTER TABLE lov_bit.bitacora
        ADD oculta BIT NOT NULL CONSTRAINT DF_bitacora_oculta DEFAULT 0;
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
      inicio_sesion    DATETIME2   NOT NULL DEFAULT SYSUTCDATETIME(),
      ultima_actividad DATETIME2   NOT NULL DEFAULT SYSUTCDATETIME(),
      activa           BIT         NOT NULL DEFAULT 1
    );
  `);
  await db.request().batch(`
    IF COL_LENGTH('bitacora.sesion_activa', 'ultima_actividad') IS NULL
    BEGIN
      ALTER TABLE bitacora.sesion_activa
        ADD ultima_actividad DATETIME2 NOT NULL CONSTRAINT DF_sesion_ultact DEFAULT SYSUTCDATETIME();
    END
  `);
  // F9: el barrido inicial por TTL (`ultima_actividad < -5min`) fue eliminado — el modelo
  // post F2 mantiene la sesión activa hasta logout o sweeper de turno (F4). Las sesiones
  // huérfanas de pruebas se limpian con cleanupTestRegistros (helpers.js) o manualmente.
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_sesion_lookup' AND object_id=OBJECT_ID('bitacora.sesion_activa'))
      CREATE INDEX IX_sesion_lookup
        ON bitacora.sesion_activa(activa, planta_id, cargo_id)
        INCLUDE (usuario_id, turno, inicio_sesion);
  `);

  // F2: cerrada_en distingue logout explícito (activa=0 + cerrada_en=SYSUTCDATETIME()) del
  // cierre por sweeper de F4 (activa=0 + cerrada_en=NULL legacy, hoy el sweeper sigue sin
  // tocar sesion_activa por D-003). El builder de conformacion_turno (D-025) usa cerrada_en
  // como hora de salida cuando hay logout explícito; si NULL, cae a ventanaTurno().fin con
  // fin_inferido=1. Convención TZ post F19: siempre SYSUTCDATETIME() — ver §7.10 de
  // BIT-MODBD-2026-001.md.
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
      abierta_en         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
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
      creado_en           DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
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
      cerrado_en             DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
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

  // ---------- 5. Eventos Dashboard (F5: renombrado desde autorizacion_dashboard) ----------
  // F5: rename idempotente de la tabla y sus columnas. Solo corre la primera vez que el
  // server arranca después del upgrade. En BD pristine no hace nada (la tabla nueva se crea
  // directamente con el CREATE de abajo).
  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'bitacora' AND t.name = 'autorizacion_dashboard'
    )
    BEGIN
      EXEC sp_rename 'bitacora.autorizacion_dashboard', 'evento_dashboard';
      IF COL_LENGTH('bitacora.evento_dashboard', 'autorizacion_id') IS NOT NULL
        EXEC sp_rename 'bitacora.evento_dashboard.autorizacion_id', 'evento_id', 'COLUMN';
      IF COL_LENGTH('bitacora.evento_dashboard', 'valor_autorizado_mw') IS NOT NULL
        EXEC sp_rename 'bitacora.evento_dashboard.valor_autorizado_mw', 'valor_mw', 'COLUMN';
    END
  `);

  await db.request().batch(`
    IF OBJECT_ID('bitacora.evento_dashboard', 'U') IS NULL
    CREATE TABLE bitacora.evento_dashboard (
      evento_id           INT           IDENTITY(1,1) PRIMARY KEY,
      registro_origen_id  INT           NOT NULL,
      planta_id           VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
      fecha               DATE          NOT NULL,
      periodo             TINYINT       NOT NULL CHECK (periodo BETWEEN 1 AND 24),
      valor_mw            FLOAT         NOT NULL,
      jdts_snapshot       NVARCHAR(MAX) NOT NULL,
      jefes_snapshot      NVARCHAR(MAX) NOT NULL,
      tipo                VARCHAR(10)   NOT NULL DEFAULT 'AUTH'
                          CHECK (tipo IN ('AUTH','REDESP','PRUEBA')),
      activa              BIT           NOT NULL DEFAULT 1,
      creado_en           DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
      CONSTRAINT UQ_evento_planta_fecha_periodo_tipo UNIQUE (planta_id, fecha, periodo, tipo)
    );
  `);

  // F5: en deploys que ya tenían autorizacion_dashboard sin la columna tipo, agregarla.
  await db.request().batch(`
    IF COL_LENGTH('bitacora.evento_dashboard','tipo') IS NULL
      ALTER TABLE bitacora.evento_dashboard
        ADD tipo VARCHAR(10) NOT NULL
            CONSTRAINT DF_evento_tipo DEFAULT 'AUTH'
            CONSTRAINT CK_evento_tipo CHECK (tipo IN ('AUTH','REDESP','PRUEBA'));
  `);

  // F5: drop UNIQUE viejo (planta, fecha, periodo) si todavía existe; el constraint nuevo
  // (planta, fecha, periodo, tipo) permite que un mismo periodo tenga AUTH + PRUEBA en simultáneo
  // (preguntas2.md respuesta B).
  await db.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name='UQ_auth_planta_fecha_periodo')
      ALTER TABLE bitacora.evento_dashboard DROP CONSTRAINT UQ_auth_planta_fecha_periodo;
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name='UQ_evento_planta_fecha_periodo_tipo')
      ALTER TABLE bitacora.evento_dashboard
        ADD CONSTRAINT UQ_evento_planta_fecha_periodo_tipo UNIQUE (planta_id, fecha, periodo, tipo);
  `);

  // Índice de lookup por planta/fecha/activa renombrado al esquema nuevo.
  await db.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_auth_lookup' AND object_id=OBJECT_ID('bitacora.evento_dashboard'))
      DROP INDEX IX_auth_lookup ON bitacora.evento_dashboard;
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_evento_lookup' AND object_id=OBJECT_ID('bitacora.evento_dashboard'))
      CREATE INDEX IX_evento_lookup ON bitacora.evento_dashboard(planta_id, fecha, activa);
  `);

  // F5: vista compat para que el dashboard externo siga consultando el nombre viejo. Solo
  // expone tipo='AUTH' con los nombres originales de columna. F9 la elimina cuando el dashboard
  // pase a usar /api/eventos-dashboard.
  await db.request().batch(`
    IF OBJECT_ID('bitacora.autorizacion_dashboard', 'V') IS NOT NULL
      DROP VIEW bitacora.autorizacion_dashboard;
  `);
  await db.request().batch(`
    EXEC('CREATE VIEW bitacora.autorizacion_dashboard AS
      SELECT evento_id AS autorizacion_id, registro_origen_id, planta_id, fecha, periodo,
             valor_mw AS valor_autorizado_mw, jdts_snapshot, jefes_snapshot, activa, creado_en
      FROM bitacora.evento_dashboard
      WHERE tipo = ''AUTH''');
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
  bitReq.input('mand', sql.NVarChar(sql.MAX), MAND_JSON);
  // F6: la bitácora "Sala de Mando" original (codigo SALA) se reasigna a MANDOPER porque
  // MAND la reemplaza; SALA queda como bitácora operativa "Sala de Mando Operativa" del
  // operador. Esto evita duplicar el nombre en UI. La activa=0 de AUTH se aplica abajo.
  await bitReq.batch(`
    MERGE lov_bit.bitacora AS t
    USING (VALUES
      ('Caldera',                       'CALDERA',  'Flame',        0, NULL,  1, 1),
      ('Análisis',                      'ANAL',     'TestTube',     0, NULL,  2, 1),
      ('Sala de Mando Operativa',       'SALA',     'Monitor',      0, NULL,  3, 1),
      ('Planta de Agua',                'AGUA',     'Droplets',     0, NULL,  4, 1),
      ('Turbogrupo',                    'TURBO',    'Gauge',        0, NULL,  5, 1),
      ('Maquinaria',                    'MAQU',     'Truck',        0, NULL,  6, 1),
      ('Carbón y Caliza',               'CYC',      'Mountain',     0, NULL,  7, 1),
      ('Disponibilidad',                'DISP',     'Activity',     1, @disp, 8, 1),
      ('Autorizaciones',                'AUTH',     'FileCheck',    1, @auth, 9, 0),
      ('Química',                       'QUIM',     'FlaskConical', 0, NULL, 10, 1),
      ('Cierres y Finalizaciones',      'CIET',     'LogOut',       0, NULL, 11, 1),
      ('Operación 24h',                 'MAND',     'LayoutGrid',   1, @mand,12, 1)
    ) AS s(nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa)
      ON t.codigo = s.codigo
    WHEN MATCHED THEN UPDATE SET
      nombre = s.nombre,
      icono = s.icono,
      formulario_especial = s.formulario_especial,
      definicion_campos = s.definicion_campos,
      orden = s.orden,
      activa = s.activa
    WHEN NOT MATCHED THEN INSERT (nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa)
      VALUES (s.nombre, s.codigo, s.icono, s.formulario_especial, s.definicion_campos, s.orden, s.activa);
  `);

  // F10: marca CIET como oculta (auditoría interna). El UPDATE complementario sobre el resto
  // garantiza que un seteo accidental fuera-de-init quede revertido en el próximo arranque.
  await db.request().batch(`
    UPDATE lov_bit.bitacora SET oculta = 1 WHERE codigo = 'CIET' AND oculta <> 1;
    UPDATE lov_bit.bitacora SET oculta = 0 WHERE codigo <> 'CIET' AND oculta <> 0;
  `);

  // tipo_evento default por bitácora
  // F3: CIET se excluye — sus tipos son exclusivamente 'Finalización de turno' y 'Cierre de turno'.
  // F6: MAND también se excluye — sus tipos son 'Autorización', 'Pruebas', 'Redespacho'.
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, es_default, orden)
    SELECT b.bitacora_id, 'Evento General', 1, 0
    FROM lov_bit.bitacora b
    WHERE b.codigo NOT IN ('CIET','MAND')
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        WHERE te.bitacora_id = b.bitacora_id AND te.nombre = 'Evento General'
      );
  `);

  // F12: tipos viejos de DISP ('Cambio de Estado','Redespacho','Sincronización') retirados.
  // El seed nuevo se hace en F12.A4 ('Cambio de Disponibilidad' único).

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

  // F6: tipos de evento MAND. Cada uno se mapea a un tipo de evento_dashboard via la
  // columna notificar_dashboard_tipo (cableado abajo).
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
    SELECT b.bitacora_id, s.nombre, s.orden
    FROM lov_bit.bitacora b
    CROSS JOIN (VALUES
      ('Autorización', 1),
      ('Pruebas',      2),
      ('Redespacho',   3)
    ) AS s(nombre, orden)
    WHERE b.codigo = 'MAND'
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        WHERE te.bitacora_id = b.bitacora_id AND te.nombre = s.nombre
      );
  `);

  // F6: columna notificar_dashboard_tipo en tipo_evento. Reemplaza al flag
  // hasNotificarDashboard() que vivía dentro del JSON definicion_campos de la bitácora.
  // Granularidad por tipo_evento permite que MAND tenga tipos que NO notifican (futuro) y
  // que la decisión de qué `tipo` (AUTH/REDESP/PRUEBA) escribir en evento_dashboard quede
  // en la fila del tipo de evento, no en el JSON de la bitácora.
  await db.request().batch(`
    IF COL_LENGTH('lov_bit.tipo_evento','notificar_dashboard_tipo') IS NULL
      ALTER TABLE lov_bit.tipo_evento
        ADD notificar_dashboard_tipo VARCHAR(10) NULL
            CONSTRAINT CK_te_notificar_dashboard_tipo
              CHECK (notificar_dashboard_tipo IN ('AUTH','REDESP','PRUEBA'));
  `);
  await db.request().batch(`
    UPDATE te SET notificar_dashboard_tipo = 'AUTH'
    FROM lov_bit.tipo_evento te INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo = 'MAND' AND te.nombre = 'Autorización' AND te.notificar_dashboard_tipo IS NULL;

    UPDATE te SET notificar_dashboard_tipo = 'PRUEBA'
    FROM lov_bit.tipo_evento te INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo = 'MAND' AND te.nombre = 'Pruebas' AND te.notificar_dashboard_tipo IS NULL;

    UPDATE te SET notificar_dashboard_tipo = 'REDESP'
    FROM lov_bit.tipo_evento te INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo = 'MAND' AND te.nombre = 'Redespacho' AND te.notificar_dashboard_tipo IS NULL;
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
          -- F6: MAND la ve TODO el mundo (la fila operativa la usan JdT/IngOp pero el resto
          -- la consulta read-only para coordinación).
          WHEN b.codigo = 'MAND' THEN 1
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
          -- F6: en MAND solo crean JdT e IngOp (preguntas.md punto 1).
          WHEN b.codigo = 'MAND' THEN
            CASE WHEN c.nombre IN ('Ingeniero Jefe de Turno','Ingeniero de Operación') THEN 1 ELSE 0 END
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

  // ---------- F12.A — Disponibilidad: BD ----------
  // F12: DISP pasa de grilla genérica a mini-dashboard. La rama POST/PUT/deshacer en
  // server.js asume:
  //   - turno nullable (DISP graba NULL — no aplica turno operativo).
  //   - fecha_fin_estado nullable en activo+histórico (NULL=vigente, no-NULL=cerrado).
  //   - Filtered unique index (planta_id) WHERE bitacora=DISP AND fecha_fin_estado IS NULL
  //     garantiza 1 vigente por planta (segunda barrera al UPDLOCK del POST).
  //   - tipo_evento DISP único 'Cambio de Disponibilidad' — el backend lo fuerza, ignora
  //     lo que mande el frontend.
  //   - tipo CIET 'Deshacer disponibilidad' para audit del POST /api/disponibilidad/deshacer.
  //   - DISP visible para todos los cargos (puede_ver=1); creación restringida a JdT+IngOp.
  //   - Tabla disponibilidad_dashboard (1 fila/planta) como cimiento separado de
  //     evento_dashboard (semántica distinta — no por periodo).

  await db.request().batch(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='turno' AND is_nullable=0
    )
      ALTER TABLE bitacora.registro_activo ALTER COLUMN turno TINYINT NULL;
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='turno' AND is_nullable=0
    )
      ALTER TABLE bitacora.registro_historico ALTER COLUMN turno TINYINT NULL;
  `);

  await db.request().batch(`
    IF COL_LENGTH('bitacora.registro_activo','fecha_fin_estado') IS NULL
      ALTER TABLE bitacora.registro_activo ADD fecha_fin_estado DATETIME2 NULL;
    IF COL_LENGTH('bitacora.registro_historico','fecha_fin_estado') IS NULL
      ALTER TABLE bitacora.registro_historico ADD fecha_fin_estado DATETIME2 NULL;
  `);

  // Resolvemos el bitacora_id de DISP en JS porque SQL Server no admite subqueries en el
  // predicate de un filtered index. El valor se incrusta como literal en el CREATE INDEX.
  const dispRow = await db.request().query(`
    SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'
  `);
  const DISP_BITACORA_ID = dispRow.recordset[0]?.bitacora_id;
  if (!DISP_BITACORA_ID) {
    throw new Error('[initDB] bitácora DISP no fue sembrada antes de F12.A');
  }

  // F12.A1: TRUNCATE selectivo de DISP — one-shot, solo cuando aún no existe la tabla
  // disponibilidad_dashboard (gate de "primer arranque post-F12"). Datos previos eran de
  // prueba (preguntas_disp.md A1). En arranques posteriores los registros productivos
  // se preservan.
  const tablaCreadaCheck = await db.request().query(`
    SELECT CASE WHEN OBJECT_ID('bitacora.disponibilidad_dashboard','U') IS NULL THEN 1 ELSE 0 END AS pristine
  `);
  const dispPristine = tablaCreadaCheck.recordset[0].pristine === 1;
  if (dispPristine) {
    await db.request()
      .input('bitacora_id', sql.Int, DISP_BITACORA_ID)
      .query(`
        DELETE FROM bitacora.registro_historico WHERE bitacora_id = @bitacora_id;
        DELETE FROM bitacora.registro_activo    WHERE bitacora_id = @bitacora_id;
      `);
  }

  // F12.A4: reemplaza los 3 tipos de evento viejos (Cambio de Estado / Redespacho /
  // Sincronización) por 1 fijo 'Cambio de Disponibilidad'. El usuario nunca elige tipo
  // para DISP — POST/PUT lo fuerzan al único tipo válido.
  await db.request()
    .input('bitacora_id', sql.Int, DISP_BITACORA_ID)
    .query(`
      DELETE FROM lov_bit.tipo_evento
      WHERE bitacora_id = @bitacora_id
        AND nombre IN ('Cambio de Estado', 'Redespacho', 'Sincronización');

      IF NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento
        WHERE bitacora_id = @bitacora_id AND nombre = 'Cambio de Disponibilidad'
      )
        INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
        VALUES (@bitacora_id, 'Cambio de Disponibilidad', 1);
    `);

  // F12.A5: tipo CIET 'Deshacer disponibilidad' (orden 3, después de finalización/cierre).
  // POST /api/disponibilidad/deshacer lo emite con audit del autor + JdTs/Gerentes activos
  // en sesion_activa.
  await db.request().batch(`
    IF EXISTS (SELECT 1 FROM lov_bit.bitacora WHERE codigo='CIET')
      AND NOT EXISTS (
        SELECT 1 FROM lov_bit.tipo_evento te
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
        WHERE b.codigo='CIET' AND te.nombre = 'Deshacer disponibilidad'
      )
      INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden)
      SELECT bitacora_id, 'Deshacer disponibilidad', 3 FROM lov_bit.bitacora WHERE codigo='CIET';
  `);

  // F12.A6: DISP visible para TODOS los cargos; creación solo para JdT/IngOp. La matriz
  // INSERT de arriba ya cubre los cargos sembrados, pero forzamos defensivamente para
  // sobrevivir cargos nuevos o renumeraciones — el match es por nombre, no por id.
  await db.request()
    .input('bitacora_id', sql.Int, DISP_BITACORA_ID)
    .query(`
      INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
      SELECT c.cargo_id, @bitacora_id, 0, 0
      FROM lov_bit.cargo c
      WHERE NOT EXISTS (
        SELECT 1 FROM lov_bit.cargo_bitacora_permiso p
        WHERE p.cargo_id = c.cargo_id AND p.bitacora_id = @bitacora_id
      );

      UPDATE p
      SET puede_ver   = 1,
          puede_crear = CASE WHEN c.nombre IN ('Ingeniero Jefe de Turno','Ingeniero de Operación')
                             THEN 1 ELSE 0 END
      FROM lov_bit.cargo_bitacora_permiso p
      INNER JOIN lov_bit.cargo c ON c.cargo_id = p.cargo_id
      WHERE p.bitacora_id = @bitacora_id;
    `);

  // F12.A7: cimiento del mini-dashboard. UPSERT desde POST/PUT/deshacer mantiene 1 fila
  // por planta con el estado vigente. Snapshots viajan con la fila para que F15 renderee
  // el indicador con audit completo sin joins.
  // D-026 (F26.A1): tras la migración, este objeto pasa a ser VIEW (no tabla). Guardamos
  // contra cualquier objeto del mismo nombre — no solo tablas — para que el CREATE TABLE no
  // dispare en arranques post-F26 (la vista ya satisface el nombre).
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name='disponibilidad_dashboard' AND schema_id=SCHEMA_ID('bitacora'))
    CREATE TABLE bitacora.disponibilidad_dashboard (
      planta_id              VARCHAR(10) PRIMARY KEY REFERENCES lov_bit.planta(planta_id),
      evento                 VARCHAR(20) NOT NULL CONSTRAINT CK_disp_dashboard_evento
        CHECK (evento IN ('En Servicio','En Reserva','Indisponible','Mantenimiento')),
      codigo                 SMALLINT NOT NULL CHECK (codigo IN (-1, 0, 1)),
      fecha_inicio_estado    DATETIME2 NOT NULL,
      registro_activo_id     INT NOT NULL,
      jdts_snapshot          NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispdash_jdts DEFAULT '[]',
      jefes_snapshot         NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispdash_jefes DEFAULT '[]',
      modificado_por         INT NULL REFERENCES lov_bit.usuario(usuario_id),
      modificado_en          DATETIME2 NULL,
      actualizado_en         DATETIME2 NOT NULL CONSTRAINT DF_dispdash_act DEFAULT SYSUTCDATETIME()
    );
  `);

  // D-024 (2026-05-15): migración idempotente del modelo de estados DISP.
  //
  // Rebrand "Disponible" → "En Servicio" + alta del nuevo estado "Mantenimiento" (que
  // comparte codigo=-1 con Indisponible y se distingue por el string `evento`).
  //
  // Tres pasos atómicos:
  //   (a) Drop del CHECK viejo (anónimo en BDs creadas antes de F22/D-024). Lo buscamos
  //       por definición — el `IS_REPLICATED=0` filtra system constraints. Si la BD ya
  //       trae el nuevo CHECK nombrado (BD nueva o re-init), el drop es no-op.
  //   (b) UPDATE de datos: rename 'Disponible' → 'En Servicio' en la tabla dashboard y
  //       dentro del JSON campos_extra de registro_activo + registro_historico para DISP.
  //       Usa JSON_MODIFY (SQL Server 2016+; el repo requiere 2019+).
  //   (c) Add del nuevo CHECK nombrado si aún no existe. Para BDs nuevas el CREATE TABLE
  //       ya lo creó; para BDs viejas el (a) lo dropeó y este paso lo recrea.
  // D-026 (F26.A1): el bloque entero solo aplica si disponibilidad_dashboard sigue siendo
  // una TABLA. Post-F26 pasa a ser VIEW: el ALTER TABLE ADD CONSTRAINT al final fallaría
  // y los UPDATE sobre registro_activo/historico son no-op (no quedan filas DISP allí).
  await db.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.tables WHERE name='disponibilidad_dashboard' AND schema_id=SCHEMA_ID('bitacora'))
    BEGIN
      DECLARE @ck_viejo SYSNAME;
      SELECT @ck_viejo = cc.name
        FROM sys.check_constraints cc
        JOIN sys.tables  t ON t.object_id  = cc.parent_object_id
        JOIN sys.schemas s ON s.schema_id  = t.schema_id
        WHERE s.name = 'bitacora'
          AND t.name = 'disponibilidad_dashboard'
          AND cc.name <> 'CK_disp_dashboard_evento'
          AND cc.definition LIKE '%Disponible%';
      IF @ck_viejo IS NOT NULL
        EXEC('ALTER TABLE bitacora.disponibilidad_dashboard DROP CONSTRAINT ' + @ck_viejo);

      UPDATE bitacora.disponibilidad_dashboard
        SET evento = 'En Servicio'
        WHERE evento = 'Disponible';

      UPDATE bitacora.registro_activo
        SET campos_extra = JSON_MODIFY(campos_extra, '$.evento', 'En Servicio')
        WHERE bitacora_id = ${DISP_BITACORA_ID}
          AND JSON_VALUE(campos_extra, '$.evento') = 'Disponible';

      UPDATE bitacora.registro_historico
        SET campos_extra = JSON_MODIFY(campos_extra, '$.evento', 'En Servicio')
        WHERE bitacora_id = ${DISP_BITACORA_ID}
          AND JSON_VALUE(campos_extra, '$.evento') = 'Disponible';

      IF NOT EXISTS (
        SELECT 1 FROM sys.check_constraints WHERE name = 'CK_disp_dashboard_evento'
      )
        ALTER TABLE bitacora.disponibilidad_dashboard
          ADD CONSTRAINT CK_disp_dashboard_evento
          CHECK (evento IN ('En Servicio','En Reserva','Indisponible','Mantenimiento'));
    END
  `);

  // F12.A3: filtered unique index = segunda barrera (después del UPDLOCK del POST) contra
  // dos vigentes simultáneos por planta.
  // D-026 (F26.A1): post-migración DISP no tiene filas en registro_activo; el índice se
  // dropea en F26.A1. Gateamos por existencia de `bitacora.disponibilidad_estado`:
  //   - pre-F26  → CREATE if missing
  //   - post-F26 → DROP if leftover (auto-heal: arranques antes del gate dejaron el índice
  //                huérfano; este else lo limpia sin requerir SQL manual)
  // El gate por migracion_aplicada no sirve acá porque esa tabla se crea después (F16.A0).
  const f26Done_UQ = (await db.request().query(
    `SELECT 1 AS x WHERE OBJECT_ID('bitacora.disponibilidad_estado','U') IS NOT NULL`
  )).recordset[0];
  if (!f26Done_UQ) {
    await db.request().batch(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name='UQ_disp_vigente_por_planta' AND object_id=OBJECT_ID('bitacora.registro_activo')
      )
        CREATE UNIQUE INDEX UQ_disp_vigente_por_planta
          ON bitacora.registro_activo (planta_id)
          WHERE bitacora_id = ${DISP_BITACORA_ID} AND fecha_fin_estado IS NULL;
    `);
  } else {
    await db.request().batch(`
      IF EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name='UQ_disp_vigente_por_planta' AND object_id=OBJECT_ID('bitacora.registro_activo')
      )
        DROP INDEX UQ_disp_vigente_por_planta ON bitacora.registro_activo;
    `);
  }

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

  // D-024 (2026-05-15): vista cimiento para métricas DISP por planta.
  // Normaliza activo + histórico en un único set de intervalos [fecha_inicio_estado, fecha_fin_estado)
  // por (planta, evento). El vigente (`fecha_fin_estado IS NULL`) representa "abierto hasta ahora";
  // los consumidores deben coalescer a NOW al sumar duración.
  //
  // Para DISP el invariante del backend es `fecha_evento = fecha_inicio_estado` (ver POST DISP
  // rama en server.js — se hace .input('fecha_evento', sql.DateTime2, fechaInicio)), por lo que
  // usamos `fecha_evento` como inicio sin re-parsear el JSON.
  //
  // D-026 (F26.A1): post-migración DISP vive en `disponibilidad_estado` y `/api/disponibilidad/metricas`
  // suma DATEDIFF_BIG directo sobre esa tabla. La vista se dropea en F26.A1.
  //   - pre-F26  → CREATE OR ALTER (idempotente intra-versión)
  //   - post-F26 → DROP if leftover (auto-heal: arranques antes del gate la dejaron huérfana)
  const f26Done_VI = (await db.request().query(
    `SELECT 1 AS x WHERE OBJECT_ID('bitacora.disponibilidad_estado','U') IS NOT NULL`
  )).recordset[0];
  if (f26Done_VI) {
    await db.request().batch(`
      IF EXISTS (SELECT 1 FROM sys.views
                 WHERE name='v_disp_intervalos' AND schema_id=SCHEMA_ID('bitacora'))
        DROP VIEW bitacora.v_disp_intervalos;
    `);
  } else {
    await db.request().batch(`
      CREATE OR ALTER VIEW bitacora.v_disp_intervalos AS
    SELECT
      r.planta_id,
      JSON_VALUE(r.campos_extra, '$.evento') AS evento,
      TRY_CAST(JSON_VALUE(r.campos_extra, '$.codigo') AS SMALLINT) AS codigo,
      r.fecha_evento     AS fecha_inicio_estado,
      r.fecha_fin_estado AS fecha_fin_estado,
      r.creado_por,
      r.registro_id
    FROM bitacora.registro_activo r
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    WHERE b.codigo = 'DISP'
    UNION ALL
    SELECT
      h.planta_id,
      JSON_VALUE(h.campos_extra, '$.evento') AS evento,
      TRY_CAST(JSON_VALUE(h.campos_extra, '$.codigo') AS SMALLINT) AS codigo,
      h.fecha_evento     AS fecha_inicio_estado,
      h.fecha_fin_estado AS fecha_fin_estado,
      h.creado_por,
      h.registro_id
    FROM bitacora.registro_historico h
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = h.bitacora_id
    WHERE b.codigo = 'DISP';
    `);
  }

  // F13.3: migración de DEFAULTs GETDATE() → SYSUTCDATETIME() para columnas DATETIME2.
  // GETDATE() retorna hora local del SQL Server; mssql con useUTC=true (default) las lee
  // como UTC y el frontend resta -5h al formatear → fechas mostradas 5h temprano. Las
  // tablas ya existen al hacer hot-reload, así que el CREATE TABLE no re-ejecuta los
  // DEFAULTs nuevos — necesitamos DROP+ADD del constraint en vivo.
  // Idempotente: si el DEFAULT ya es SYSUTCDATETIME() (post-migración), no lo cambia.
  const datetimeUTCDefaults = [
    { schema: 'bitacora', table: 'sesion_activa',          column: 'inicio_sesion',    cname: 'DF_sesion_inicio'   },
    { schema: 'bitacora', table: 'sesion_activa',          column: 'ultima_actividad', cname: 'DF_sesion_ultact'   },
    { schema: 'bitacora', table: 'sesion_bitacora',        column: 'abierta_en',       cname: 'DF_sesion_bit_open' },
    { schema: 'bitacora', table: 'registro_activo',        column: 'creado_en',        cname: 'DF_ra_creado_en'    },
    { schema: 'bitacora', table: 'registro_historico',     column: 'cerrado_en',       cname: 'DF_rh_cerrado_en'   },
    { schema: 'bitacora', table: 'evento_dashboard',       column: 'creado_en',        cname: 'DF_ed_creado_en'    },
    { schema: 'bitacora', table: 'disponibilidad_dashboard', column: 'actualizado_en', cname: 'DF_dispdash_act'    },
  ];
  for (const m of datetimeUTCDefaults) {
    await db.request().batch(`
      DECLARE @cname SYSNAME, @def NVARCHAR(MAX);
      SELECT @cname = dc.name, @def = dc.definition
        FROM sys.default_constraints dc
        JOIN sys.columns c ON c.column_id = dc.parent_column_id AND c.object_id = dc.parent_object_id
        JOIN sys.tables t ON t.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = '${m.schema}' AND t.name = '${m.table}' AND c.name = '${m.column}';
      IF @cname IS NOT NULL AND @def NOT LIKE '%SYSUTCDATETIME%'
      BEGIN
        EXEC('ALTER TABLE ${m.schema}.${m.table} DROP CONSTRAINT ' + @cname);
        EXEC('ALTER TABLE ${m.schema}.${m.table} ADD CONSTRAINT ${m.cname} DEFAULT SYSUTCDATETIME() FOR ${m.column}');
      END
    `);
  }

  // ---------- F16.A — Operación 24h (MAND): backend batch + cierre automático ----------
  // F16.A0: tabla flag para marcar migraciones one-time aplicadas. Sirve para que F16.A1
  // (TRUNCATE selectivo MAND) y F16.A2 (limpieza funcionariocnd) corran solo una vez
  // aunque initDB() vuelva a ejecutarse.
  await db.request().batch(`
    IF OBJECT_ID('bitacora.migracion_aplicada','U') IS NULL
    CREATE TABLE bitacora.migracion_aplicada (
      codigo      VARCHAR(50) NOT NULL PRIMARY KEY,
      aplicada_en DATETIME2   NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);

  const mandRow = await db.request().query(
    `SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='MAND'`
  );
  const MAND_BITACORA_ID = mandRow.recordset[0]?.bitacora_id;

  // F16.A1: TRUNCATE selectivo MAND (datos de prueba — preguntas_mand.md C4). Soft-delete
  // de evento_dashboard por registro_origen_id antes de borrar registro_activo + histórico.
  // Una sola vez: el flag F16.A1 protege contra re-ejecución en restart.
  if (MAND_BITACORA_ID) {
    await db.request()
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .batch(`
        IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F16.A1')
        BEGIN
          UPDATE bitacora.evento_dashboard SET activa = 0
            WHERE registro_origen_id IN (
              SELECT registro_id FROM bitacora.registro_activo WHERE bitacora_id = @mand
            );
          DELETE FROM bitacora.registro_activo    WHERE bitacora_id = @mand;
          DELETE FROM bitacora.registro_historico WHERE bitacora_id = @mand;
          INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F16.A1');
        END
      `);
  }

  // F16.A2: limpia funcionariocnd remanente en PRUEBA/REDESP en histórico (los activos
  // ya quedaron limpios tras A1; los históricos previos pueden tener datos del flujo viejo).
  if (MAND_BITACORA_ID) {
    await db.request()
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .batch(`
        IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F16.A2')
        BEGIN
          UPDATE rh
          SET campos_extra = JSON_MODIFY(campos_extra, '$.funcionariocnd', NULL)
          FROM bitacora.registro_historico rh
          INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = rh.tipo_evento_id
          WHERE rh.bitacora_id = @mand
            AND te.nombre IN ('Pruebas','Redespacho')
            AND JSON_VALUE(rh.campos_extra, '$.funcionariocnd') IS NOT NULL;

          UPDATE ra
          SET campos_extra = JSON_MODIFY(campos_extra, '$.funcionariocnd', NULL)
          FROM bitacora.registro_activo ra
          INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
          WHERE ra.bitacora_id = @mand
            AND te.nombre IN ('Pruebas','Redespacho')
            AND JSON_VALUE(ra.campos_extra, '$.funcionariocnd') IS NOT NULL;

          INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F16.A2');
        END
      `);
  }

  // F16.A3: usuario SISTEMA dedicado para CIETs automáticos. activo=0 evita login;
  // password_hash='!disabled!' no matchea scrypt → defensa en profundidad.
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM lov_bit.usuario WHERE username = 'SISTEMA')
    BEGIN
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
      VALUES ('Sistema (cierre automático)', 'SISTEMA', NULL, '!disabled!', 0, 0, 0);
    END
  `);
  const sistemaRes = await db.request().query(
    `SELECT usuario_id FROM lov_bit.usuario WHERE username = 'SISTEMA'`
  );
  USUARIO_SISTEMA_ID = sistemaRes.recordset[0]?.usuario_id ?? null;
  if (!USUARIO_SISTEMA_ID) {
    throw new Error("[initDB] usuario 'SISTEMA' no fue sembrado (F16.A3)");
  }

  // F16.A4: log de cierre diario MAND. Idempotencia del sweeper — segunda llamada para
  // (fecha, planta) detecta la fila y retorna skipped sin duplicar el cierre. Resiliente
  // a reinicios del server.
  await db.request().batch(`
    IF OBJECT_ID('bitacora.mand_cierre_log','U') IS NULL
    CREATE TABLE bitacora.mand_cierre_log (
      fecha_cerrada       DATE         NOT NULL,
      planta_id           VARCHAR(10)  NOT NULL REFERENCES lov_bit.planta(planta_id),
      cerrado_en          DATETIME2    NOT NULL CONSTRAINT DF_mand_cierre_en DEFAULT SYSUTCDATETIME(),
      registros_cerrados  INT          NOT NULL,
      CONSTRAINT PK_mand_cierre_log PRIMARY KEY (fecha_cerrada, planta_id)
    );
  `);

  // Q1+Q2 conformacion-turno-2026-05: snapshot al cierre de turno (T1/T2 por planta).
  // 1 fila por (fecha_operativa, planta_id, turno, usuario_id) — agregada. PK garantiza
  // idempotencia. Inmutable post-snapshot. fin_inferido=1 cuando el builder cae a
  // ventanaTurno().fin (logout no llamado, Q5); =0 cuando viene de sesion_activa.cerrada_en.
  await db.request().batch(`
    IF OBJECT_ID('bitacora.conformacion_turno', 'U') IS NULL
    CREATE TABLE bitacora.conformacion_turno (
      fecha_operativa  DATE          NOT NULL,
      planta_id        VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
      turno            TINYINT       NOT NULL CHECK (turno IN (1, 2)),
      usuario_id       INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      usuario_nombre   VARCHAR(200)  NOT NULL,
      cargo_id         INT           NOT NULL REFERENCES lov_bit.cargo(cargo_id),
      cargo_nombre     VARCHAR(100)  NOT NULL,
      inicio_sesion    DATETIME2     NOT NULL,
      fin_sesion       DATETIME2     NOT NULL,
      duracion_min     INT           NOT NULL,
      fin_inferido     BIT           NOT NULL CONSTRAINT DF_conformacion_fin_inferido DEFAULT 0,
      snapshot_en      DATETIME2     NOT NULL CONSTRAINT DF_conformacion_snapshot_en DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_conformacion_turno PRIMARY KEY (fecha_operativa, planta_id, turno, usuario_id)
    );
  `);

  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name='IX_conformacion_turno_lookup'
                     AND object_id=OBJECT_ID('bitacora.conformacion_turno'))
      CREATE INDEX IX_conformacion_turno_lookup
        ON bitacora.conformacion_turno(planta_id, fecha_operativa, turno)
        INCLUDE (usuario_id, usuario_nombre, cargo_nombre);
  `);

  // ---------- F22.D1 — columnas calculadas Bogotá para inspección humana en SSMS ----------
  // No persistidas (DATEADD virtual, costo cero al INSERT). Aplicaciones siguen leyendo
  // las columnas UTC (sin sufijo); las *_bogota son solo para SSMS / Azure Data Studio.
  // Cada ADD <col> se gateaba con IF NOT EXISTS contra sys.columns → idempotente sin necesidad
  // del flag migracion_aplicada. El flag se setea al final como audit trail.
  // Documentado en BIT-MODBD-2026-001.md §4.5 + §7.10. Convención TZ: BD UTC, presentación Bogotá.
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='fecha_evento_bogota')
      ALTER TABLE bitacora.registro_activo ADD fecha_evento_bogota AS DATEADD(HOUR, -5, fecha_evento);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='creado_en_bogota')
      ALTER TABLE bitacora.registro_activo ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='modificado_en_bogota')
      ALTER TABLE bitacora.registro_activo ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_activo') AND name='fecha_fin_estado_bogota')
      ALTER TABLE bitacora.registro_activo ADD fecha_fin_estado_bogota AS DATEADD(HOUR, -5, fecha_fin_estado);

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='fecha_evento_bogota')
      ALTER TABLE bitacora.registro_historico ADD fecha_evento_bogota AS DATEADD(HOUR, -5, fecha_evento);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='creado_en_bogota')
      ALTER TABLE bitacora.registro_historico ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='modificado_en_bogota')
      ALTER TABLE bitacora.registro_historico ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='cerrado_en_bogota')
      ALTER TABLE bitacora.registro_historico ADD cerrado_en_bogota AS DATEADD(HOUR, -5, cerrado_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.registro_historico') AND name='fecha_fin_estado_bogota')
      ALTER TABLE bitacora.registro_historico ADD fecha_fin_estado_bogota AS DATEADD(HOUR, -5, fecha_fin_estado);

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.evento_dashboard') AND name='creado_en_bogota')
      ALTER TABLE bitacora.evento_dashboard ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);

    -- D-026 (F26.A1): tras la migración, disponibilidad_dashboard pasa a ser VIEW. Solo
    -- agregar columnas Bogotá si el objeto sigue siendo TABLA (ALTER TABLE ADD sobre VIEW falla).
    IF EXISTS (SELECT 1 FROM sys.tables WHERE name='disponibilidad_dashboard' AND schema_id=SCHEMA_ID('bitacora'))
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.disponibilidad_dashboard') AND name='fecha_inicio_estado_bogota')
        ALTER TABLE bitacora.disponibilidad_dashboard ADD fecha_inicio_estado_bogota AS DATEADD(HOUR, -5, fecha_inicio_estado);
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.disponibilidad_dashboard') AND name='modificado_en_bogota')
        ALTER TABLE bitacora.disponibilidad_dashboard ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.disponibilidad_dashboard') AND name='actualizado_en_bogota')
        ALTER TABLE bitacora.disponibilidad_dashboard ADD actualizado_en_bogota AS DATEADD(HOUR, -5, actualizado_en);
    END

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.sesion_activa') AND name='inicio_sesion_bogota')
      ALTER TABLE bitacora.sesion_activa ADD inicio_sesion_bogota AS DATEADD(HOUR, -5, inicio_sesion);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.sesion_activa') AND name='ultima_actividad_bogota')
      ALTER TABLE bitacora.sesion_activa ADD ultima_actividad_bogota AS DATEADD(HOUR, -5, ultima_actividad);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.sesion_activa') AND name='cerrada_en_bogota')
      ALTER TABLE bitacora.sesion_activa ADD cerrada_en_bogota AS DATEADD(HOUR, -5, cerrada_en);

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.sesion_bitacora') AND name='abierta_en_bogota')
      ALTER TABLE bitacora.sesion_bitacora ADD abierta_en_bogota AS DATEADD(HOUR, -5, abierta_en);
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.sesion_bitacora') AND name='finalizada_en_bogota')
      ALTER TABLE bitacora.sesion_bitacora ADD finalizada_en_bogota AS DATEADD(HOUR, -5, finalizada_en);

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.mand_cierre_log') AND name='cerrado_en_bogota')
      ALTER TABLE bitacora.mand_cierre_log ADD cerrado_en_bogota AS DATEADD(HOUR, -5, cerrado_en);

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bitacora.migracion_aplicada') AND name='aplicada_en_bogota')
      ALTER TABLE bitacora.migracion_aplicada ADD aplicada_en_bogota AS DATEADD(HOUR, -5, aplicada_en);

    IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F22.D1')
      INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F22.D1');
  `);

  // ---------- F22.D2 — columnas Bogotá para conformacion_turno (mismo patrón que F22.D1) ----------
  // Bloque separado para trazabilidad: F22.D1 ya quedó marcado como aplicado; estas columnas
  // pertenecen a una tabla creada después (Q1 del flujo conformacion-turno-2026-05).
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id=OBJECT_ID('bitacora.conformacion_turno') AND name='inicio_sesion_bogota')
      ALTER TABLE bitacora.conformacion_turno ADD inicio_sesion_bogota AS DATEADD(HOUR, -5, inicio_sesion);
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id=OBJECT_ID('bitacora.conformacion_turno') AND name='fin_sesion_bogota')
      ALTER TABLE bitacora.conformacion_turno ADD fin_sesion_bogota AS DATEADD(HOUR, -5, fin_sesion);
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id=OBJECT_ID('bitacora.conformacion_turno') AND name='snapshot_en_bogota')
      ALTER TABLE bitacora.conformacion_turno ADD snapshot_en_bogota AS DATEADD(HOUR, -5, snapshot_en);

    IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F22.D2')
      INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F22.D2');
  `);

  // ---------- F26.A1 — D-026: DISP a tabla dedicada bitacora.disponibilidad_estado ----------
  // DISP vivía en registro_activo/registro_historico con datos clave (evento, codigo,
  // fecha_inicio_estado) embebidos en campos_extra JSON. Mover a ER nativo elimina ~10
  // excepciones del modelo y habilita una vista de acumulados con window functions.
  // Cross-repo aún no consume DISP (F15 pendiente) → blast radius bajo.
  //
  // Steps dentro de UNA transacción (rollback ante cualquier fallo → flag no se setea →
  // siguiente arranque reintenta):
  //   1. CREATE TABLE bitacora.disponibilidad_estado + índices + columnas Bogotá.
  //   2. CREATE OR ALTER VIEW bitacora.v_disponibilidad_estado (acumulados via window fns).
  //   3. Backfill: INSERT desde registro_activo ∪ registro_historico (rows con bitacora=DISP).
  //   4. Validación de conteo. THROW si no coincide.
  //   5. DELETE rows DISP de registro_activo / registro_historico.
  //   6. DROP INDEX UQ_disp_vigente_por_planta, DROP VIEW v_disp_intervalos.
  //   7. DROP TABLE bitacora.disponibilidad_dashboard + CREATE OR ALTER VIEW del mismo nombre
  //      (shape preservado → cross-repo y código existente leen idéntico).
  //   8. INSERT flag F26.A1.
  // Documentado en docs/decisions.md D-026 y BIT-MODBD-2026-001.md §4.8.
  const f26Aplicada = await db.request().query(
    `SELECT 1 AS x FROM bitacora.migracion_aplicada WHERE codigo = 'F26.A1'`
  );
  if (!f26Aplicada.recordset[0]) {
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      // 1. Tabla base + índices + columnas Bogotá. (CREATE TABLE/INDEX/ALTER TABLE en un mismo
      //    batch: no son statements de DDL "first-in-batch" como CREATE VIEW/PROCEDURE/etc.)
      await new sql.Request(tx).batch(`
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
          jdts_snapshot                NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispest_jdts DEFAULT '[]',
          jefes_planta_snapshot        NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispest_jefes DEFAULT '[]',
          gerentes_produccion_snapshot NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispest_gerentes DEFAULT '[]',
          ingenieros_snapshot          NVARCHAR(MAX) NOT NULL CONSTRAINT DF_dispest_ing DEFAULT '[]',
          creado_por                   INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
          creado_en                    DATETIME2     NOT NULL CONSTRAINT DF_dispest_creado_en DEFAULT SYSUTCDATETIME(),
          modificado_por               INT           NULL REFERENCES lov_bit.usuario(usuario_id),
          modificado_en                DATETIME2     NULL
        );

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_disp_estado_vigente_por_planta')
          CREATE UNIQUE INDEX UQ_disp_estado_vigente_por_planta
            ON bitacora.disponibilidad_estado(planta_id)
            WHERE fecha_fin_estado IS NULL;

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_disp_estado_planta_inicio')
          CREATE INDEX IX_disp_estado_planta_inicio
            ON bitacora.disponibilidad_estado(planta_id, fecha_inicio_estado DESC);

        IF NOT EXISTS (SELECT 1 FROM sys.columns
                       WHERE object_id=OBJECT_ID('bitacora.disponibilidad_estado') AND name='fecha_inicio_estado_bogota')
          ALTER TABLE bitacora.disponibilidad_estado
            ADD fecha_inicio_estado_bogota AS DATEADD(HOUR, -5, fecha_inicio_estado);
        IF NOT EXISTS (SELECT 1 FROM sys.columns
                       WHERE object_id=OBJECT_ID('bitacora.disponibilidad_estado') AND name='fecha_fin_estado_bogota')
          ALTER TABLE bitacora.disponibilidad_estado
            ADD fecha_fin_estado_bogota AS DATEADD(HOUR, -5, fecha_fin_estado);
        IF NOT EXISTS (SELECT 1 FROM sys.columns
                       WHERE object_id=OBJECT_ID('bitacora.disponibilidad_estado') AND name='creado_en_bogota')
          ALTER TABLE bitacora.disponibilidad_estado
            ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);
        IF NOT EXISTS (SELECT 1 FROM sys.columns
                       WHERE object_id=OBJECT_ID('bitacora.disponibilidad_estado') AND name='modificado_en_bogota')
          ALTER TABLE bitacora.disponibilidad_estado
            ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
      `);

      // 2. Vista derivada de acumulados (CREATE OR ALTER VIEW debe ser el primer statement
      //    del batch — por eso va en su propia llamada).
      await new sql.Request(tx).batch(`
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
      `);

      // 3-7. Backfill + validación + DELETE en origen + DROP de index/view/tabla viejos.
      await new sql.Request(tx).batch(`
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

        DECLARE @migrados INT = (SELECT COUNT(*) FROM bitacora.disponibilidad_estado);
        DECLARE @origen INT = (
          SELECT
            (SELECT COUNT(*) FROM bitacora.registro_activo    WHERE bitacora_id=@disp_bid) +
            (SELECT COUNT(*) FROM bitacora.registro_historico WHERE bitacora_id=@disp_bid)
        );
        IF @migrados <> @origen
          THROW 50001, 'F26.A1: conteo backfill no coincide con origen', 1;

        DELETE FROM bitacora.registro_activo    WHERE bitacora_id = @disp_bid;
        DELETE FROM bitacora.registro_historico WHERE bitacora_id = @disp_bid;

        IF EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name='UQ_disp_vigente_por_planta'
                     AND object_id=OBJECT_ID('bitacora.registro_activo'))
          DROP INDEX UQ_disp_vigente_por_planta ON bitacora.registro_activo;

        IF EXISTS (SELECT 1 FROM sys.views
                   WHERE name='v_disp_intervalos' AND schema_id=SCHEMA_ID('bitacora'))
          DROP VIEW bitacora.v_disp_intervalos;

        IF EXISTS (SELECT 1 FROM sys.tables
                   WHERE name='disponibilidad_dashboard' AND schema_id=SCHEMA_ID('bitacora'))
          DROP TABLE bitacora.disponibilidad_dashboard;
      `);

      // 7. Vista compat para cross-repo — preserva el shape de disponibilidad_dashboard.
      //    CREATE OR ALTER VIEW debe ser el primer statement del batch.
      await new sql.Request(tx).batch(`
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
      `);

      // 8. Flag de migración aplicada (último statement antes del COMMIT — si algo falla
      //    antes, el ROLLBACK borra el INSERT y el siguiente arranque reintenta).
      await new sql.Request(tx).batch(`
        INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F26.A1');
      `);

      await tx.commit();
      console.log('[F26.A1] DISP migrado a bitacora.disponibilidad_estado');
    } catch (err) {
      try { await tx.rollback(); } catch {}
      throw err;
    }
  }

  // F10: bitacora_oculta expuesto para que /api/historicos pueda filtrar bitácoras de
  // auditoría interna (CIET).
  await db.request().batch(`
    CREATE OR ALTER VIEW bitacora.v_historico_busqueda AS
    SELECT h.registro_id, h.fecha_evento, h.turno, h.detalle,
           h.campos_extra, h.fecha_cierre_operativo,
           b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
           b.oculta AS bitacora_oculta,
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

  // Invariante singleton de flags de usuario (BIT-RF-2026-001.md §3 + §6.5):
  //   * Sólo username='emunoz' (Ernesto Muñoz) tiene es_jefe_planta=1.
  //   * Sólo username='ofedullo' (Omar Fedullo) tiene es_jdt_default=1.
  // Defensa en profundidad: aunque seedPersonal() ya re-aplica los flags del JSON,
  // este bloque corrige divergencias en filas FUERA del JSON (cuentas test, manuales)
  // y blinda contra ediciones por SSMS. La limpieza one-off vive en
  // sql/snippets/limpiar_test_user_flags.sql. Cross-ref D-023 en docs/decisions.md.
  await db.request().batch(`
    BEGIN TRAN;
      UPDATE lov_bit.usuario
         SET es_jefe_planta = 0
       WHERE es_jefe_planta = 1 AND username <> 'emunoz';

      UPDATE lov_bit.usuario
         SET es_jdt_default = 0
       WHERE es_jdt_default = 1 AND username <> 'ofedullo';
    COMMIT;
  `);

  // Q3=d conformacion-turno-2026-05: catchup al arranque. Detecta (planta, turno, fecha_operativa)
  // de los últimos 7 días Bogotá que NO tengan snapshot en conformacion_turno, y para cada uno
  // verifica en JS si la ventana ya cerró (ahora >= ventanaTurno.fin). Resiliencia ante crashes
  // del server justo al cambio de turno. Errores aislados — uno no rompe la inicialización.
  try {
    const candidatos = await db.request().query(`
      WITH TurnosCandidatos AS (
        SELECT DISTINCT
          sa.planta_id,
          sa.turno,
          CAST(DATEADD(HOUR, -5, sa.inicio_sesion) AS DATE) AS fecha_operativa
        FROM bitacora.sesion_activa sa
        WHERE sa.inicio_sesion >= DATEADD(DAY, -7, SYSUTCDATETIME())
      )
      SELECT t.planta_id, t.turno, t.fecha_operativa
      FROM TurnosCandidatos t
      WHERE NOT EXISTS (
        SELECT 1 FROM bitacora.conformacion_turno c
        WHERE c.planta_id = t.planta_id
          AND c.turno = t.turno
          AND c.fecha_operativa = t.fecha_operativa
      )
    `);

    const ahora = new Date();
    let totalInsertadas = 0;
    for (const row of candidatos.recordset) {
      const fechaStr = row.fecha_operativa.toISOString().slice(0, 10);
      const fechaRef = new Date(`${fechaStr}T12:00:00.000-05:00`);
      const { fin } = ventanaTurno(row.turno, fechaRef);
      if (ahora < fin) continue; // turno aún en curso, lo procesará el sweeper

      try {
        const filas = await buildConformacionSnapshot(db, {
          fecha_operativa: fechaStr,
          planta_id: row.planta_id,
          turno: row.turno,
        });
        const { insertadas } = await persistConformacionSnapshot(db, filas);
        totalInsertadas += insertadas;
      } catch (err) {
        console.error(`[initDB catchup conformacion] ${row.planta_id} T${row.turno} ${fechaStr}:`, err.message);
      }
    }
    if (totalInsertadas > 0) {
      console.log(`[initDB catchup conformacion] ${totalInsertadas} filas insertadas para turnos pasados`);
    }
  } catch (err) {
    console.error('[initDB catchup conformacion] fallo general (no bloqueante):', err.message);
  }

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
