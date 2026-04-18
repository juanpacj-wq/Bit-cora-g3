import sql from 'mssql';

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
  { campo: 'periodo', tipo: 'int', min: 1, max: 24, requerido: true },
  { campo: 'valor_autorizado_mw', tipo: 'float', requerido: true },
  { campo: 'notificar_dashboard', tipo: 'auto', valor: true },
]);

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
      cargo_id     INT          IDENTITY(1,1) PRIMARY KEY,
      nombre       VARCHAR(100) NOT NULL,
      solo_lectura BIT          NOT NULL DEFAULT 0
    );
  `);

  await db.request().batch(`
    IF OBJECT_ID('lov_bit.usuario', 'U') IS NULL
    CREATE TABLE lov_bit.usuario (
      usuario_id      INT          IDENTITY(1,1) PRIMARY KEY,
      nombre_completo VARCHAR(200) NOT NULL,
      email           VARCHAR(200) NOT NULL UNIQUE,
      password_hash   VARCHAR(200) NOT NULL DEFAULT '1234',
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
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_sesion_lookup' AND object_id=OBJECT_ID('bitacora.sesion_activa'))
      CREATE INDEX IX_sesion_lookup
        ON bitacora.sesion_activa(activa, planta_id, cargo_id)
        INCLUDE (usuario_id, turno, inicio_sesion);
  `);

  // ---------- 4. Registros ----------
  await db.request().batch(`
    IF OBJECT_ID('bitacora.registro_activo', 'U') IS NULL
    CREATE TABLE bitacora.registro_activo (
      registro_id    INT           IDENTITY(1,1) PRIMARY KEY,
      bitacora_id    INT           NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
      planta_id      VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
      fecha_evento   DATETIME2     NOT NULL,
      turno          TINYINT       NOT NULL CHECK (turno IN (1, 2)),
      detalle        NVARCHAR(MAX) NOT NULL,
      campos_extra   NVARCHAR(MAX) NULL,
      tipo_evento_id INT           NOT NULL REFERENCES lov_bit.tipo_evento(tipo_evento_id),
      estado         VARCHAR(20)   NOT NULL DEFAULT 'borrador'
                     CHECK (estado IN ('borrador', 'cerrado')),
      ingeniero_id   INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      jdt_turno_id   INT           NULL     REFERENCES lov_bit.usuario(usuario_id),
      jefe_id        INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      creado_por     INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      creado_en      DATETIME2     NOT NULL DEFAULT GETDATE(),
      modificado_por INT           NULL     REFERENCES lov_bit.usuario(usuario_id),
      modificado_en  DATETIME2     NULL
    );
  `);
  const raIndices = [
    ['IX_ra_bitacora', 'bitacora.registro_activo', '(bitacora_id, planta_id)'],
    ['IX_ra_estado', 'bitacora.registro_activo', '(estado)'],
    ['IX_ra_fecha', 'bitacora.registro_activo', '(fecha_evento)'],
    ['IX_ra_ing', 'bitacora.registro_activo', '(ingeniero_id)'],
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
      ingeniero_id           INT           NOT NULL,
      jdt_turno_id           INT           NULL,
      jefe_id                INT           NOT NULL,
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
    ['IX_rh_ing', 'bitacora.registro_historico', '(ingeniero_id)'],
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
      autorizacion_id     INT         IDENTITY(1,1) PRIMARY KEY,
      registro_origen_id  INT         NOT NULL,
      planta_id           VARCHAR(10) NOT NULL REFERENCES lov_bit.planta(planta_id),
      fecha               DATE        NOT NULL,
      periodo             TINYINT     NOT NULL CHECK (periodo BETWEEN 1 AND 24),
      valor_autorizado_mw FLOAT       NOT NULL,
      jdt_id              INT         NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      jefe_id             INT         NOT NULL REFERENCES lov_bit.usuario(usuario_id),
      activa              BIT         NOT NULL DEFAULT 1,
      creado_en           DATETIME2   NOT NULL DEFAULT GETDATE(),
      CONSTRAINT UQ_auth_planta_fecha_periodo UNIQUE (planta_id, fecha, periodo)
    );
  `);
  await db.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_auth_lookup' AND object_id=OBJECT_ID('bitacora.autorizacion_dashboard'))
      CREATE INDEX IX_auth_lookup ON bitacora.autorizacion_dashboard(planta_id, fecha, activa);
  `);

  // ---------- 6. Datos semilla ----------
  await db.request().batch(`
    MERGE lov_bit.planta AS t
    USING (VALUES ('GEC3','Gecelca 3'),('GEC32','Gecelca 3.2')) AS s(planta_id, nombre)
      ON t.planta_id = s.planta_id
    WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (s.planta_id, s.nombre, 1);
  `);

  await db.request().batch(`
    MERGE lov_bit.cargo AS t
    USING (VALUES
      ('Jefe de Turno', 0),
      ('Ingeniero de Operación', 0),
      ('Ingeniero de Planta de Agua', 0),
      ('Gerente de Producción', 1)
    ) AS s(nombre, solo_lectura)
      ON t.nombre = s.nombre
    WHEN NOT MATCHED THEN INSERT (nombre, solo_lectura) VALUES (s.nombre, s.solo_lectura);
  `);

  await db.request().batch(`
    MERGE lov_bit.usuario AS t
    USING (VALUES
      ('Ernesto Muñoz', 'ernesto.munoz@gecelca.com', 1, 0),
      ('Omar Fedullo',  'omar.fedullo@gecelca.com',  0, 1)
    ) AS s(nombre_completo, email, es_jefe_planta, es_jdt_default)
      ON t.email = s.email
    WHEN NOT MATCHED THEN INSERT (nombre_completo, email, es_jefe_planta, es_jdt_default)
      VALUES (s.nombre_completo, s.email, s.es_jefe_planta, s.es_jdt_default);
  `);

  const bitReq = db.request();
  bitReq.input('disp', sql.NVarChar(sql.MAX), DISP_JSON);
  bitReq.input('auth', sql.NVarChar(sql.MAX), AUTH_JSON);
  await bitReq.batch(`
    MERGE lov_bit.bitacora AS t
    USING (VALUES
      ('Disponibilidad',            'DISP', 'Activity',     1, @disp, 1),
      ('Sincronización',            'SINC', 'Settings',     0, NULL,  2),
      ('Caldera',                   'CAL',  'Flame',        0, NULL,  3),
      ('Planta de Agua',            'AGUA', 'Droplets',     0, NULL,  4),
      ('Turbina',                   'TURB', 'Gauge',        0, NULL,  5),
      ('Eléctrica',                 'ELEC', 'Zap',          0, NULL,  6),
      ('Instrumentación y Control', 'IC',   'Cpu',          0, NULL,  7),
      ('Química',                   'QUIM', 'FlaskConical', 0, NULL,  8),
      ('Medio Ambiente',            'MA',   'Leaf',         0, NULL,  9),
      ('Autorizaciones',            'AUTH', 'FileCheck',    1, @auth, 10)
    ) AS s(nombre, codigo, icono, formulario_especial, definicion_campos, orden)
      ON t.codigo = s.codigo
    WHEN NOT MATCHED THEN INSERT (nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa)
      VALUES (s.nombre, s.codigo, s.icono, s.formulario_especial, s.definicion_campos, s.orden, 1);
  `);

  // tipo_evento default por bitácora
  await db.request().batch(`
    INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, es_default, orden)
    SELECT b.bitacora_id, 'Evento General', 1, 0
    FROM lov_bit.bitacora b
    WHERE NOT EXISTS (
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

  // matriz de permisos (idempotente)
  await db.request().batch(`
    ;WITH matriz AS (
      SELECT c.cargo_id, b.bitacora_id, c.nombre AS cargo_nombre, b.codigo,
        CASE
          WHEN c.nombre = 'Jefe de Turno'               THEN 1
          WHEN c.nombre = 'Ingeniero de Operación'      THEN 1
          WHEN c.nombre = 'Ingeniero de Planta de Agua' THEN CASE WHEN b.codigo='AGUA' THEN 1 ELSE 0 END
          WHEN c.nombre = 'Gerente de Producción'       THEN 1
          ELSE 0
        END AS puede_ver,
        CASE
          WHEN c.nombre = 'Jefe de Turno'               THEN CASE WHEN b.codigo IN ('DISP','AUTH') THEN 1 ELSE 0 END
          WHEN c.nombre = 'Ingeniero de Operación'      THEN CASE WHEN b.codigo IN ('DISP','AUTH','AGUA') THEN 0 ELSE 1 END
          WHEN c.nombre = 'Ingeniero de Planta de Agua' THEN CASE WHEN b.codigo='AGUA' THEN 1 ELSE 0 END
          WHEN c.nombre = 'Gerente de Producción'       THEN 0
          ELSE 0
        END AS puede_crear
      FROM lov_bit.cargo c CROSS JOIN lov_bit.bitacora b
    )
    MERGE lov_bit.cargo_bitacora_permiso AS t
    USING matriz AS s ON t.cargo_id = s.cargo_id AND t.bitacora_id = s.bitacora_id
    WHEN NOT MATCHED THEN INSERT (cargo_id, bitacora_id, puede_ver, puede_crear)
      VALUES (s.cargo_id, s.bitacora_id, s.puede_ver, s.puede_crear);
  `);

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
      AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Jefe de Turno');
  `);

  await db.request().batch(`
    CREATE OR ALTER VIEW bitacora.v_historico_busqueda AS
    SELECT h.registro_id, h.fecha_evento, h.turno, h.detalle,
           h.campos_extra, h.fecha_cierre_operativo,
           b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
           p.nombre AS planta_nombre, h.planta_id,
           u.nombre_completo AS ingeniero,
           te.nombre AS tipo_evento,
           jdt.nombre_completo AS jdt_nombre,
           jefe.nombre_completo AS jefe_nombre
    FROM bitacora.registro_historico h
    JOIN lov_bit.bitacora b ON b.bitacora_id = h.bitacora_id
    JOIN lov_bit.planta p ON p.planta_id = h.planta_id
    JOIN lov_bit.usuario u ON u.usuario_id = h.ingeniero_id
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = h.tipo_evento_id
    LEFT JOIN lov_bit.usuario jdt ON jdt.usuario_id = h.jdt_turno_id
    JOIN lov_bit.usuario jefe ON jefe.usuario_id = h.jefe_id;
  `);

  console.log('[DB] Conexión OK');
}
