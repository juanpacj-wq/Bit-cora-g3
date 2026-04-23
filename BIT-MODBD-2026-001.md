# BIT-MODBD-2026-001 — Modelo de Base de Datos

**Módulo de Bitácoras de Planta — SQL Server — Esquemas `bitacora.*` / `lov_bit.*`**

| Campo | Valor |
|---|---|
| Código | BIT-MODBD-2026-001 |
| Versión | 1.1 |
| Fecha | Abril 2026 |
| Motor | SQL Server 2019+ |
| Esquemas | `lov_bit` (catálogos) / `bitacora` (transaccional) |
| Autoría | Gerencia de Generación — GECELCA S.A. E.S.P. |

> **Convenciones:** las tablas de catálogos viven en `lov_bit`; las tablas operativas en `bitacora`. Los campos JSON usan `NVARCHAR(MAX)` y se validan en la capa de aplicación.

> **Cambios v1.1 (2026-04-18):**
> - `registro_activo`, `registro_historico` y `autorizacion_dashboard` sustituyen las columnas FK por rol (`ingeniero_id`, `jdt_turno_id`, `jefe_id`, `jdt_id`) por **snapshots JSON** (`ingenieros_snapshot`, `jdts_snapshot`, `jefes_snapshot`) que preservan la lista completa de usuarios con ese rol al momento del registro. Único FK vivo a `lov_bit.usuario` en estas tablas: `creado_por` (autor).
> - `sesion_activa` adopta un **TTL de 5 min** sobre `ultima_actividad`: sesiones ociosas o huérfanas se rechazan en el middleware y se limpian en el arranque.
> - Nuevo endpoint `POST /api/auth/resume` y contrato `sendBeacon` para distinguir recarga de cierre de pestaña (detalles en BIT-RF-2026-001, sección 4.1).

---

## Tabla de contenidos

0. [Resumen de arquitectura](#0-resumen-de-arquitectura)
1. [Creación de esquemas](#1-creación-de-esquemas)
2. [Catálogos (esquema `lov_bit`)](#2-catálogos-esquema-lov_bit)
3. [Sesiones activas (esquema `bitacora`)](#3-sesiones-activas-esquema-bitacora)
4. [Registros de bitácora (esquema `bitacora`)](#4-registros-de-bitácora-esquema-bitacora)
5. [Integración con el Dashboard (esquema `bitacora`)](#5-integración-con-el-dashboard-esquema-bitacora)
6. [Vistas útiles](#6-vistas-útiles)
7. [Notas de diseño](#7-notas-de-diseño)
8. [Historial de versiones](#8-historial-de-versiones)

---

## 0. Resumen de arquitectura

El modelo se divide en dos esquemas y cuatro bloques lógicos:

| Bloque | Esquema | Contenido |
|---|---|---|
| Catálogos | `lov_bit` | Plantas, cargos, usuarios, bitácoras, tipos de evento, permisos |
| Sesiones | `bitacora` | Sesiones activas con TTL; punto de consulta para snapshots de rol |
| Registros | `bitacora` | Tabla activa (día en curso, editable) e histórica (inmutable) |
| Dashboard | `bitacora` | Autorizaciones horarias expuestas al Dashboard vía API REST |

**Escalabilidad:** para agregar una bitácora nueva, basta insertar una fila en `lov_bit.bitacora` con su JSON `definicion_campos`. El frontend renderiza el formulario dinámicamente; los campos específicos se almacenan en `campos_extra (NVARCHAR(MAX) JSON)` del registro. Sin migraciones de esquema.

---

## 1. Creación de esquemas

```sql
-- =========================================================
-- MODELO BD - BITÁCORAS DE PLANTA (SQL Server 2019+)
-- lov_bit: catálogos y listas de valores
-- bitacora: tablas transaccionales y operativas
-- =========================================================

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lov_bit')
    EXEC('CREATE SCHEMA lov_bit');
GO
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'bitacora')
    EXEC('CREATE SCHEMA bitacora');
GO
```

---

## 2. Catálogos (esquema `lov_bit`)

### 2.1 Plantas

```sql
-- Plantas operativas. planta_id coincide con el Dashboard.
CREATE TABLE lov_bit.planta (
    planta_id   VARCHAR(10)   PRIMARY KEY,
    nombre      VARCHAR(100)  NOT NULL,
    activa      BIT           NOT NULL DEFAULT 1
);

INSERT INTO lov_bit.planta (planta_id, nombre) VALUES
    ('GEC3',  'Gecelca 3'),
    ('GEC32', 'Gecelca 3.2');
```

### 2.2 Cargos

```sql
-- Roles seleccionables tras login.
-- solo_lectura = 1 para Gerente de Producción.
CREATE TABLE lov_bit.cargo (
    cargo_id        INT           IDENTITY(1,1) PRIMARY KEY,
    nombre          VARCHAR(100)  NOT NULL,
    solo_lectura    BIT           NOT NULL DEFAULT 0
);

INSERT INTO lov_bit.cargo (nombre, solo_lectura) VALUES
    ('Jefe de Turno', 0),                -- cargo_id = 1
    ('Ingeniero de Operación', 0),       -- cargo_id = 2
    ('Ingeniero de Planta de Agua', 0),  -- cargo_id = 3
    ('Gerente de Producción', 1);        -- cargo_id = 4
```

### 2.3 Usuarios

```sql
-- Login simple por ahora. Keycloak en fase posterior.
-- es_jefe_planta = 1 solo para Ernesto Muñoz (jefe global).
-- es_jdt_default = 1 solo para Omar Fedullo (JdT fallback).
CREATE TABLE lov_bit.usuario (
    usuario_id      INT           IDENTITY(1,1) PRIMARY KEY,
    nombre_completo VARCHAR(200)  NOT NULL,
    email           VARCHAR(200)  NOT NULL UNIQUE,
    password_hash   VARCHAR(200)  NOT NULL DEFAULT '1234',
    es_jefe_planta  BIT           NOT NULL DEFAULT 0,
    es_jdt_default  BIT           NOT NULL DEFAULT 0,
    activo          BIT           NOT NULL DEFAULT 1
);

INSERT INTO lov_bit.usuario (nombre_completo, email, es_jefe_planta, es_jdt_default) VALUES
    ('Ernesto Muñoz', 'ernesto.munoz@gecelca.com', 1, 0),
    ('Omar Fedullo',  'omar.fedullo@gecelca.com',  0, 1);
```

#### 2.3.1 Semántica de `es_jdt_default`

`es_jdt_default` **no es un flag de rol ni de permiso**: es un **fallback de identidad** que se usa para poblar `jdts_snapshot` (y `/api/catalogos/jdt-actual`) cuando no hay ningún usuario del cargo *Ingeniero Jefe de Turno* con sesión activa dentro del TTL (5 min). Reglas:

- Se asigna a **un único usuario global** por diseño (hoy: Omar Fedullo). No se expande a más usuarios.
- Si se setea a `1` en N usuarios, `snapshotJDTs()` devolverá a los N como fallback (lista, sin prioridad ni filtro por planta). Esto ensucia el audit trail, no lo mejora.
- Los **permisos operativos** (cerrar turno, editar cualquier registro) viven en `lov_bit.cargo.puede_cerrar_turno`, no aquí. `puede_cerrar_turno=1` en *Ingeniero Jefe de Turno* y en *Ingeniero de Operación* — son iguales para permisos, distintos para identidad.
- Cuando un IngOp crea un registro sin JdT en sesión, `ingenieros_snapshot` captura al IngOp real; `jdts_snapshot` contendrá al usuario con `es_jdt_default=1` como fallback. La trazabilidad del creador está intacta; la "firma" JdT es cosmética.
- Auditoría sugerida: ejecutar `server/sql/audit_fallback_jdt.sql` mensualmente para detectar registros con fallback activo.

### 2.4 Bitácoras (catálogo dinámico — pieza central)

```sql
-- formulario_especial = 1: Disponibilidad y Autorizaciones.
-- definicion_campos: JSON que describe campos extra del formulario.
-- El frontend lee este JSON y renderiza dinámicamente.
-- Para agregar una bitácora nueva: solo INSERT aquí.
CREATE TABLE lov_bit.bitacora (
    bitacora_id         INT             IDENTITY(1,1) PRIMARY KEY,
    nombre              VARCHAR(100)    NOT NULL,
    codigo              VARCHAR(10)     NOT NULL UNIQUE,
    icono               VARCHAR(50)     NULL,
    formulario_especial BIT             NOT NULL DEFAULT 0,
    definicion_campos   NVARCHAR(MAX)   NULL,
    orden               INT             NOT NULL DEFAULT 0,
    activa              BIT             NOT NULL DEFAULT 1
);

-- Bitácoras iniciales
INSERT INTO lov_bit.bitacora
    (nombre, codigo, icono, formulario_especial, definicion_campos, orden)
VALUES
    ('Disponibilidad', 'DISP', 'Activity', 1,
     '[{"campo":"evento","tipo":"select",
       "opciones":["Disponible","Indisponible","En Reserva"],
       "requerido":true},
      {"campo":"codigo","tipo":"auto",
       "regla":{"Disponible":1,"En Reserva":0,"Indisponible":-1}}]',
     1),
    ('Sincronización',              'SINC', 'Settings',     0, NULL, 2),
    ('Caldera',                     'CAL',  'Flame',        0, NULL, 3),
    ('Planta de Agua',              'AGUA', 'Droplets',     0, NULL, 4),
    ('Turbina',                     'TURB', 'Gauge',        0, NULL, 5),
    ('Eléctrica',                   'ELEC', 'Zap',          0, NULL, 6),
    ('Instrumentación y Control',   'IC',   'Cpu',          0, NULL, 7),
    ('Química',                     'QUIM', 'FlaskConical', 0, NULL, 8),
    ('Medio Ambiente',              'MA',   'Leaf',         0, NULL, 9),
    ('Autorizaciones', 'AUTH', 'FileCheck', 1,
     '[{"campo":"periodo","tipo":"int","min":1,"max":24,"requerido":true},
      {"campo":"valor_autorizado_mw","tipo":"float","requerido":true},
      {"campo":"notificar_dashboard","tipo":"auto","valor":true}]',
     10);
```

**Ejemplo de escalabilidad futura** — agregar bitácora de Combustible sin tocar código:

```sql
INSERT INTO lov_bit.bitacora (nombre, codigo, formulario_especial, definicion_campos, orden) VALUES
('Combustible', 'COMB', 1,
 '[{"campo":"tipo_carbon","tipo":"select",
   "opciones":["Bituminoso","Sub-bituminoso","Antracita"],"requerido":true},
  {"campo":"toneladas","tipo":"float","requerido":true},
  {"campo":"poder_calorifico_kcal","tipo":"float","requerido":false}]',
 11);
```

### 2.5 Tipos de evento por bitácora

```sql
-- Cada bitácora tiene su catálogo propio de tipos.
-- es_default = 1 marca 'Evento General' como preseleccionado.
CREATE TABLE lov_bit.tipo_evento (
    tipo_evento_id  INT           IDENTITY(1,1) PRIMARY KEY,
    bitacora_id     INT           NOT NULL
        REFERENCES lov_bit.bitacora(bitacora_id),
    nombre          VARCHAR(100)  NOT NULL,
    es_default      BIT           NOT NULL DEFAULT 0,
    orden           INT           NOT NULL DEFAULT 0
);

CREATE INDEX IX_tipo_evento_bit ON lov_bit.tipo_evento(bitacora_id);

-- 'Evento General' para TODAS las bitácoras
INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, es_default, orden)
SELECT bitacora_id, 'Evento General', 1, 0 FROM lov_bit.bitacora;

-- Tipos específicos adicionales (ejemplo: Disponibilidad)
INSERT INTO lov_bit.tipo_evento (bitacora_id, nombre, orden) VALUES
    (1, 'Cambio de Estado', 1),
    (1, 'Redespacho', 2),
    (1, 'Sincronización', 3);
```

### 2.6 Permisos cargo ↔ bitácora

```sql
-- Matriz de acceso: qué cargo VE y/o CREA en cada bitácora.
CREATE TABLE lov_bit.cargo_bitacora_permiso (
    cargo_id    INT  NOT NULL REFERENCES lov_bit.cargo(cargo_id),
    bitacora_id INT  NOT NULL REFERENCES lov_bit.bitacora(bitacora_id),
    puede_ver   BIT  NOT NULL DEFAULT 0,
    puede_crear BIT  NOT NULL DEFAULT 0,
    PRIMARY KEY (cargo_id, bitacora_id)
);

-- JdT (1): ve TODO, crea en DISP y AUTH
INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
SELECT 1, bitacora_id, 1,
    CASE WHEN codigo IN ('DISP','AUTH') THEN 1 ELSE 0 END
FROM lov_bit.bitacora;

-- Ing. Operación (2): ve todo, crea en generales
INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
SELECT 2, bitacora_id, 1,
    CASE WHEN codigo IN ('DISP','AUTH','AGUA') THEN 0 ELSE 1 END
FROM lov_bit.bitacora;

-- Ing. Planta de Agua (3): solo AGUA
INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
SELECT 3, bitacora_id,
    CASE WHEN codigo = 'AGUA' THEN 1 ELSE 0 END,
    CASE WHEN codigo = 'AGUA' THEN 1 ELSE 0 END
FROM lov_bit.bitacora;

-- Gerente (4): solo lectura en todo
INSERT INTO lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)
SELECT 4, bitacora_id, 1, 0 FROM lov_bit.bitacora;
```

---

## 3. Sesiones activas (esquema `bitacora`)

```sql
-- Resuelve: quién es JdT en turno y qué ingenieros están en turno.
-- activa = 0 al cerrar sesión o al disparar el beacon de pagehide.
-- TTL: una sesión con ultima_actividad fuera de 5 min se considera
-- caducada aunque activa=1 (se rechaza en el middleware).
-- Heartbeat cada 60 s y cada request autenticado refresca ultima_actividad.
CREATE TABLE bitacora.sesion_activa (
    sesion_id         INT           IDENTITY(1,1) PRIMARY KEY,
    usuario_id        INT           NOT NULL
        REFERENCES lov_bit.usuario(usuario_id),
    planta_id         VARCHAR(10)   NOT NULL
        REFERENCES lov_bit.planta(planta_id),
    cargo_id          INT           NOT NULL
        REFERENCES lov_bit.cargo(cargo_id),
    turno             TINYINT       NOT NULL CHECK (turno IN (1, 2)),
    inicio_sesion     DATETIME2     NOT NULL DEFAULT GETDATE(),
    ultima_actividad  DATETIME2     NOT NULL DEFAULT GETDATE(),
    activa            BIT           NOT NULL DEFAULT 1
);

CREATE INDEX IX_sesion_lookup
    ON bitacora.sesion_activa(activa, planta_id, cargo_id)
    INCLUDE (usuario_id, turno, inicio_sesion, ultima_actividad);
```

**Sweep de arranque** — `initDB()` ejecuta al levantar el backend:

```sql
UPDATE bitacora.sesion_activa
SET activa = 0
WHERE activa = 1
  AND ultima_actividad < DATEADD(MINUTE, -5, GETDATE());
```

**Resolución del JdT actual** (con filtro TTL):

```sql
SELECT TOP 1 u.usuario_id, u.nombre_completo
FROM bitacora.sesion_activa s
JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
WHERE s.activa = 1
  AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Jefe de Turno')
  AND s.planta_id = @planta
  AND s.ultima_actividad > DATEADD(MINUTE, -5, GETDATE())
ORDER BY s.inicio_sesion DESC;
-- Si 0 filas → SELECT ... FROM lov_bit.usuario WHERE es_jdt_default = 1 AND activo = 1;
```

---

## 4. Registros de bitácora (esquema `bitacora`)

### 4.1 Tabla activa (día en curso, editable)

```sql
-- 3 campos manuales: fecha_evento, turno, detalle.
-- campos_extra: JSON para bitácoras especiales.
-- Snapshots JSON: listas completas de usuarios por rol al momento del INSERT.
-- creado_por: único FK vivo a usuario (autor del registro).
CREATE TABLE bitacora.registro_activo (
    registro_id    INT             IDENTITY(1,1) PRIMARY KEY,
    bitacora_id    INT             NOT NULL
        REFERENCES lov_bit.bitacora(bitacora_id),
    planta_id      VARCHAR(10)     NOT NULL
        REFERENCES lov_bit.planta(planta_id),

    -- === INPUTS MANUALES (3) ===
    fecha_evento   DATETIME2       NOT NULL,
    turno          TINYINT         NOT NULL CHECK (turno IN (1, 2)),
    detalle        NVARCHAR(MAX)   NOT NULL,

    -- === CAMPO DINÁMICO (bitácoras especiales) ===
    campos_extra   NVARCHAR(MAX)   NULL,  -- JSON

    -- === TIPO DE EVENTO (input con default) ===
    tipo_evento_id INT             NOT NULL
        REFERENCES lov_bit.tipo_evento(tipo_evento_id),

    -- === SNAPSHOTS DE ROL (inmutables tras INSERT) ===
    ingenieros_snapshot NVARCHAR(MAX) NOT NULL,  -- JSON array
    jdts_snapshot       NVARCHAR(MAX) NOT NULL,
    jefes_snapshot      NVARCHAR(MAX) NOT NULL,

    -- === ESTADO ===
    estado         VARCHAR(20)     NOT NULL DEFAULT 'borrador'
        CHECK (estado IN ('borrador', 'cerrado')),

    -- === AUDITORÍA ===
    creado_por     INT             NOT NULL
        REFERENCES lov_bit.usuario(usuario_id),
    creado_en      DATETIME2       NOT NULL DEFAULT GETDATE(),
    modificado_por INT             NULL
        REFERENCES lov_bit.usuario(usuario_id),
    modificado_en  DATETIME2       NULL
);

CREATE INDEX IX_ra_bitacora    ON bitacora.registro_activo(bitacora_id, planta_id);
CREATE INDEX IX_ra_estado      ON bitacora.registro_activo(estado);
CREATE INDEX IX_ra_fecha       ON bitacora.registro_activo(fecha_evento);
CREATE INDEX IX_ra_creado_por  ON bitacora.registro_activo(creado_por);
```

**Shape de los snapshots** (`NVARCHAR(MAX)`, `NOT NULL`, nunca vacío):

```json
[
  { "usuario_id": 2, "nombre_completo": "Omar Fedullo" },
  { "usuario_id": 7, "nombre_completo": "María Pérez" }
]
```

Si no hay usuarios para un rol, se escribe la cadena `"[]"` — **nunca `NULL`**.

**Criterio de inclusión en cada snapshot** (ver `server/utils/snapshots.js`):

| Snapshot | Criterio |
|---|---|
| `jdts_snapshot` | `sesion_activa.activa=1` y dentro de TTL, `cargo.nombre='Jefe de Turno'`, `u.activo=1`. Si la lista queda vacía, fallback a `usuario.es_jdt_default=1 AND activo=1` |
| `jefes_snapshot` | `usuario.es_jefe_planta=1 AND activo=1` (lista estable independiente de sesión) |
| `ingenieros_snapshot` | `sesion_activa.activa=1` y TTL válido, cuyo cargo tenga `cargo_bitacora_permiso.puede_crear=1` para la `bitacora_id`, excluyendo los cargos "Jefe de Turno" y "Gerente de Producción" |

### 4.2 Tabla histórica (inmutable, cerrada por JdT)

```sql
-- Misma estructura + campos de cierre. Sin FKs para roles (ver 7.3).
-- Proceso: INSERT INTO hist SELECT ... FROM activo; DELETE FROM activo;
CREATE TABLE bitacora.registro_historico (
    registro_id    INT             PRIMARY KEY,  -- preserva ID original
    bitacora_id    INT             NOT NULL,
    planta_id      VARCHAR(10)     NOT NULL,
    fecha_evento   DATETIME2       NOT NULL,
    turno          TINYINT         NOT NULL,
    detalle        NVARCHAR(MAX)   NOT NULL,
    campos_extra   NVARCHAR(MAX)   NULL,
    tipo_evento_id INT             NOT NULL,

    ingenieros_snapshot NVARCHAR(MAX) NOT NULL,
    jdts_snapshot       NVARCHAR(MAX) NOT NULL,
    jefes_snapshot      NVARCHAR(MAX) NOT NULL,

    estado         VARCHAR(20)     NOT NULL DEFAULT 'cerrado',
    creado_por     INT             NOT NULL,
    creado_en      DATETIME2       NOT NULL,
    modificado_por INT             NULL,
    modificado_en  DATETIME2       NULL,

    -- === CAMPOS EXCLUSIVOS DE CIERRE ===
    cerrado_por             INT        NOT NULL,
    cerrado_en              DATETIME2  NOT NULL DEFAULT GETDATE(),
    fecha_cierre_operativo  DATE       NOT NULL
);

CREATE INDEX IX_rh_fecha       ON bitacora.registro_historico(fecha_cierre_operativo, bitacora_id);
CREATE INDEX IX_rh_planta      ON bitacora.registro_historico(planta_id, bitacora_id);
CREATE INDEX IX_rh_bit         ON bitacora.registro_historico(bitacora_id);
CREATE INDEX IX_rh_creado_por  ON bitacora.registro_historico(creado_por);
```

**Proceso de cierre (transacción atómica):**

```sql
BEGIN TRANSACTION;
    INSERT INTO bitacora.registro_historico
        (registro_id, bitacora_id, planta_id, fecha_evento, turno,
         detalle, campos_extra, tipo_evento_id,
         ingenieros_snapshot, jdts_snapshot, jefes_snapshot,
         estado, creado_por, creado_en, modificado_por, modificado_en,
         cerrado_por, cerrado_en, fecha_cierre_operativo)
    SELECT
        registro_id, bitacora_id, planta_id, fecha_evento, turno,
        detalle, campos_extra, tipo_evento_id,
        ingenieros_snapshot, jdts_snapshot, jefes_snapshot,
        'cerrado', creado_por, creado_en, modificado_por, modificado_en,
        @jdt_usuario_id, GETDATE(), CAST(GETDATE() AS DATE)
    FROM bitacora.registro_activo
    WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id;

    DELETE FROM bitacora.registro_activo
    WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id;
COMMIT;
```

Los snapshots JSON viajan como strings — **sin re-cálculo ni JOINs** — preservando la fotografía exacta capturada en el INSERT original.

---

## 5. Integración con el Dashboard (esquema `bitacora`)

Las autorizaciones son registros de la bitácora AUTH que disparan automáticamente una fila en esta tabla. El Dashboard la consume vía REST para suprimir la desviación en periodos autorizados.

```sql
-- Tabla puente: bitácora AUTH -> Dashboard de Generación
-- Se INSERT automáticamente al crear registro en AUTH.
-- Dashboard: GET /api/autorizaciones?planta_id=GEC32&fecha=2026-04-13
CREATE TABLE bitacora.autorizacion_dashboard (
    autorizacion_id     INT           IDENTITY(1,1) PRIMARY KEY,
    registro_origen_id  INT           NOT NULL,
    planta_id           VARCHAR(10)   NOT NULL
        REFERENCES lov_bit.planta(planta_id),
    fecha               DATE          NOT NULL,
    periodo             TINYINT       NOT NULL
        CHECK (periodo BETWEEN 1 AND 24),
    valor_autorizado_mw FLOAT         NOT NULL,

    jdts_snapshot       NVARCHAR(MAX) NOT NULL,   -- JSON array
    jefes_snapshot      NVARCHAR(MAX) NOT NULL,   -- JSON array

    activa              BIT           NOT NULL DEFAULT 1,
    creado_en           DATETIME2     NOT NULL DEFAULT GETDATE(),

    CONSTRAINT UQ_auth_planta_fecha_periodo
        UNIQUE (planta_id, fecha, periodo)
);

CREATE INDEX IX_auth_lookup
    ON bitacora.autorizacion_dashboard(planta_id, fecha, activa);
```

**Flujo:**

1. El JdT crea un registro en la bitácora AUTH con `periodo`, `valor_autorizado_mw` y `planta`.
2. El backend detecta `notificar_dashboard=true` en `definicion_campos` y genera los snapshots.
3. Se ejecuta `upsertAutorizacion` (ver `server/utils/notificador.js`): INSERT nuevo o, si existe una fila con `activa=0` para `(planta_id, fecha, periodo)`, UPDATE reactivándola con el nuevo valor. Si la fila existente está con `activa=1`, la API retorna `HTTP 409`.
4. El Dashboard consulta el endpoint y suprime la alerta de desviación para ese periodo.

El Dashboard debe **parsear `jdts_snapshot` y `jefes_snapshot` como JSON**: ya no son `INT` como en versiones previas del modelo.

---

## 6. Vistas útiles

### 6.1 Ingenieros en turno (con filtro TTL)

```sql
CREATE OR ALTER VIEW bitacora.v_ingenieros_en_turno AS
SELECT s.planta_id, s.turno, u.usuario_id, u.nombre_completo,
       c.nombre AS cargo, s.inicio_sesion, s.ultima_actividad
FROM bitacora.sesion_activa s
JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
JOIN lov_bit.cargo c   ON c.cargo_id   = s.cargo_id
WHERE s.activa = 1
  AND s.ultima_actividad > DATEADD(MINUTE, -5, GETDATE());
```

### 6.2 JdT actual por planta

```sql
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
  AND s.ultima_actividad > DATEADD(MINUTE, -5, GETDATE())
  AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo
                     WHERE nombre = 'Jefe de Turno');
```

### 6.3 Búsqueda unificada en históricos (sin JOINs a `usuario` por rol)

```sql
CREATE OR ALTER VIEW bitacora.v_historico_busqueda AS
SELECT h.registro_id, h.fecha_evento, h.turno, h.detalle,
       h.campos_extra, h.fecha_cierre_operativo,
       b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
       p.nombre AS planta_nombre, h.planta_id,
       te.nombre AS tipo_evento,
       h.ingenieros_snapshot, h.jdts_snapshot, h.jefes_snapshot,
       autor.nombre_completo AS creado_por_nombre,
       h.creado_por AS creado_por_id, h.creado_en
FROM bitacora.registro_historico h
JOIN lov_bit.bitacora    b    ON b.bitacora_id   = h.bitacora_id
JOIN lov_bit.planta      p    ON p.planta_id     = h.planta_id
JOIN lov_bit.tipo_evento te   ON te.tipo_evento_id = h.tipo_evento_id
LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = h.creado_por;
```

Los nombres humanos de los roles se resuelven **del lado del cliente** parseando las columnas `*_snapshot`.

---

## 7. Notas de diseño

### 7.1 ¿Por qué JSON y no EAV?

- SQL Server 2016+ soporta JSON nativo: `JSON_VALUE()`, `JSON_QUERY()`, `OPENJSON()`.
- EAV genera N filas por registro, multiplica JOINs y complejidad de queries.
- JSON se mapea directamente a un formulario dinámico en frontend sin transformación.
- Si se necesita indexar un campo JSON específico, se crean columnas computadas persistentes.

### 7.2 ¿Por qué dos tablas y no un flag?

- La tabla activa es pequeña (solo turno en curso) → escrituras rápidas sin bloqueos.
- La histórica solo recibe INSERTs (append-only) → ideal para indexación y búsqueda.
- Evita locks de lectura histórica bloqueando escrituras del día actual.
- Cierre atómico: INSERT + DELETE en una transacción.

### 7.3 ¿Por qué snapshots JSON en lugar de FKs por rol?

**Contexto histórico:** la versión 1.0 del modelo referenciaba al **único** JdT (`jdt_turno_id`), al **único** Jefe (`jefe_id`) y al **único** Ingeniero (`ingeniero_id`) como FKs `INT`. Esto presentaba dos problemas:

1. **Pérdida de trazabilidad cuando hay superposición de roles**: en el cambio de turno pueden haber dos JdTs con sesión solapada, o varios ingenieros con sesión activa en la misma planta. Almacenar un único `INT` obliga a elegir uno arbitrariamente.
2. **Semántica confusa de `ingeniero_id`**: mezclaba "autor del registro" con "ingeniero de rol presente". El autor ya vive en `creado_por` (poblado con `sesion.usuario_id`).

**Solución v1.1:** las tres columnas pasan a ser arrays JSON con la lista completa de usuarios del rol al instante del INSERT. El autor queda explícitamente en `creado_por`, único FK vivo a `lov_bit.usuario` y único campo con integridad referencial.

**Consecuencias:**

- No se puede aplicar FK sobre JSON. La integridad se valida en capa de aplicación al generar el snapshot.
- Si un catálogo cambia (renombrar usuario, desactivar), los registros históricos no se rompen: guardan `nombre_completo` embebido.
- Los JOINs por rol desaparecen de la vista de búsqueda. El parseo ocurre en cliente.

### 7.4 Sesiones con TTL y reanudación

- La columna `ultima_actividad` **no es informativa**: el middleware de autenticación rechaza (`401`) cualquier request cuya sesión tenga `ultima_actividad < DATEADD(MINUTE, -5, GETDATE())`, incluso si `activa=1`.
- Cada request autenticado hace un `UPDATE ... SET ultima_actividad = GETDATE()` en *fire-and-forget*.
- El cliente mantiene vivas las sesiones con un heartbeat a `POST /api/auth/heartbeat` cada 60 s.
- `initDB()` incluye un sweep al arranque que desactiva sesiones fuera del TTL, previniendo acumulación de filas huérfanas tras caídas del proceso.
- `POST /api/auth/resume` reactiva una sesión (`activa=1`, `ultima_actividad=GETDATE()`) siempre que esté dentro del TTL. Es el endpoint que el cliente invoca al **recargar la página** (F5), distinguiendo así la recarga del **cierre de pestaña** (que no reanuda).

### 7.5 Turnos

- **Turno 1:** 00:00 – 11:59 hora Colombia (UTC−5, sin horario de verano).
- **Turno 2:** 12:00 – 23:59 hora Colombia.
- Se determina automáticamente al crear el registro pero es editable por el ingeniero.

### 7.6 Flujo de cierre

- **Individual:** el JdT cierra una bitácora específica. Mueve los registros de esa combinación bitácora+planta.
- **Masivo:** cierre de todas las bitácoras con registros activos para una planta. Se ejecuta como bucle de cierres individuales independientes (si alguno falla, los demás continúan y el resumen final lo reporta).
- **Registros incompletos:** se notifica pero no bloquea la acción — la responsabilidad de cerrar es del JdT.

### 7.7 Lo que NO se forzó en BD (a propósito)

- Validación del JSON `campos_extra` contra `definicion_campos`: se hace en capa de aplicación para no meter lógica compleja en triggers.
- Validación de shape de los snapshots de rol: el backend los genera con `server/utils/snapshots.js`; la BD solo verifica que sean `NVARCHAR(MAX) NOT NULL`.
- Notificación de bitácoras no cerradas: se implementa en el backend como job programado.
- Permisos de lectura/escritura: se validan en el API middleware, no en la BD.
- Unicidad temporal de la marca `es_jefe_planta=1`: regla organizativa validada en código al cambiar el titular (ver RN-03 en el RF).

---

## 8. Historial de versiones

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 2026-04-10 | Versión inicial: esquema completo de catálogos, sesiones, registros activo/histórico, tabla puente al Dashboard, vistas y notas de diseño. |
| 1.1 | 2026-04-18 | Roles por rol (JdTs, Jefes, Ingenieros) migrados a snapshots JSON (`*_snapshot NVARCHAR(MAX) NOT NULL`). `creado_por` queda como único FK vivo a `lov_bit.usuario` en tablas transaccionales. Se añade TTL de 5 min sobre `sesion_activa.ultima_actividad`, sweep de arranque y endpoint `/api/auth/resume`. Vista `v_historico_busqueda` reescrita sin JOINs por rol. |

---

**FIN DEL MODELO**
