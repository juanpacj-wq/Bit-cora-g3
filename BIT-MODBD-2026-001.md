# BIT-MODBD-2026-001 — Modelo de Base de Datos

**Módulo de Bitácoras de Planta — SQL Server — Esquemas `bitacora.*` / `lov_bit.*`**

| Campo | Valor |
|---|---|
| Código | BIT-MODBD-2026-001 |
| Versión | 1.4 |
| Fecha | Mayo 2026 |
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
   - 4.4 [Tablas auxiliares de migración y cierre MAND](#44-tablas-auxiliares-de-migración-y-cierre-mand)
   - 4.5 [Columnas calculadas Bogotá (F22)](#45-columnas-calculadas-bogotá-f22)
5. [Integración con el Dashboard (esquema `bitacora`)](#5-integración-con-el-dashboard-esquema-bitacora)
6. [Vistas útiles](#6-vistas-útiles)
7. [Notas de diseño](#7-notas-de-diseño)
   - 7.10 [Convención de zonas horarias (F19+F20+F21+F22)](#710-convención-de-zonas-horarias-f19f20f21f22)
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

#### 2.3.2 Usuario `SISTEMA` (autor automático, F16)

Seed idempotente al arranque (`db.js::initDB()` flag `'F16.A3'`):

```sql
IF NOT EXISTS (SELECT 1 FROM lov_bit.usuario WHERE username = 'SISTEMA')
INSERT INTO lov_bit.usuario
    (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
VALUES ('Sistema (cierre automático)', 'SISTEMA', NULL, '!disabled!', 0, 0, 0);
```

Reglas:

- Único usuario marcado `activo=0` en el seed. El `activo=0` impide que aparezca en login y en cualquier listado de "usuarios activos" / dropdowns.
- `password_hash='!disabled!'` no matchea el formato de scrypt (`scrypt:N:r:p:salt:hash`) — defensa en profundidad ante un eventual bypass de la check de `activo=0`.
- `email=NULL` por diseño: el usuario no recibe notificaciones ni se comunica con humanos.
- Su `usuario_id` se cachea en `db.js` como `USUARIO_SISTEMA_ID` y se exporta. Los procesos automáticos (hoy: sweeper diario MAND, ver 4.4 y 7.9) lo usan como `creado_por` en CIETs de cierre. La traza humana de quién operó la grilla durante el día queda en los snapshots agregados (`*_snapshot` con la guardia que rotó por la grilla — ver `notificador.snapshotJDTsDelDia` y siblings).

Si en el futuro se agregan más procesos automáticos (cron jobs adicionales, integraciones), reusar el mismo `USUARIO_SISTEMA_ID` — no crear un usuario nuevo por cada cron.

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

**Columna `fecha_fin_estado` (F12, DISP only):**

```sql
ALTER TABLE bitacora.registro_activo ADD fecha_fin_estado DATETIME2 NULL;
```

`NULL` para todas las bitácoras excepto DISP. Para DISP, `NULL` = registro vigente; el filtered unique index `UQ_disp_vigente_por_planta` (ver 4.4) garantiza máximo 1 vigente por planta. Se puebla con la `fecha_inicio_estado` del próximo evento al transicionar al histórico (ver 4.2).

**Nullable `turno` (F12):**

`turno TINYINT NOT NULL CHECK (turno IN (1,2))` se relajó a `NULL`-able. El `CHECK` admite `UNKNOWN` sobre NULL. DISP graba `NULL` siempre — la mecánica de turnos no aplica.

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

**Columna `fecha_fin_estado` (F12, DISP only):**

```sql
ALTER TABLE bitacora.registro_historico ADD fecha_fin_estado DATETIME2 NULL;
```

Para DISP, viaja del activo al histórico ya poblada (= `fecha_inicio_estado` del evento que lo cerró). Esto rompe parcialmente la inmutabilidad del histórico: editar la `fecha_inicio_estado` del vigente vía `PUT /api/registros/:id` actualiza la `fecha_fin_estado` del N-1 (último histórico) para mantener cronología sin gap. Es la **única excepción documentada** a la regla "histórico es inmutable" (ver 7.8).

### 4.3 Filtered unique index para vigente DISP

```sql
-- Garantiza máximo 1 vigente por planta para DISP. SQL Server no admite
-- subqueries en filtered index predicates → bitacora_id se incrusta como
-- literal en el script de migración (resuelto en JS antes del CREATE).
CREATE UNIQUE INDEX UQ_disp_vigente_por_planta
  ON bitacora.registro_activo (planta_id)
  WHERE bitacora_id = <DISP> AND fecha_fin_estado IS NULL;
```

Es la segunda barrera defensiva al `UPDLOCK + HOLDLOCK` del POST DISP transaccional (RF-055): aunque dos POSTs concurrentes burlaran el lock, el unique index los rechaza antes del COMMIT.

### 4.4 Tablas auxiliares de migración y cierre MAND

Dos tablas operativas internas, ajenas al flujo transaccional principal pero referenciadas desde `initDB()` y desde el sweeper diario.

#### 4.4.1 `bitacora.migracion_aplicada` (F16)

```sql
CREATE TABLE bitacora.migracion_aplicada (
    codigo      VARCHAR(50)  NOT NULL PRIMARY KEY,
    aplicada_en DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
);
```

Flag genérico para migraciones one-time idempotentes ejecutadas desde `initDB()`. Se inserta `INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('<flag>')` al final de cada bloque de migración, y el bloque se gateaba al inicio con `IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='<flag>')`. Esto permite que `initDB()` corra en restart sin duplicar el efecto.

Flags hoy en uso:

| Código | Efecto |
|---|---|
| `F16.A1` | TRUNCATE selectivo MAND (`evento_dashboard.activa=0` por origen MAND + DELETE `registro_activo` + DELETE `registro_historico`). Datos de prueba previos a F16 — ver `preguntas_mand.md` C4. |
| `F16.A2` | Limpieza `funcionariocnd` remanente en MAND PRUEBA/REDESP en histórico (`JSON_MODIFY` con NULL). Los activos quedaron limpios tras `F16.A1`. |

Las dos migraciones son **destructivas** y solo se ejecutaron por confirmación expresa (datos de prueba). Si se necesita repetir el efecto, se debe `DELETE FROM bitacora.migracion_aplicada WHERE codigo='F16.A1'` antes de reiniciar — y entender que se borran datos.

#### 4.4.2 `bitacora.mand_cierre_log` (F16)

```sql
CREATE TABLE bitacora.mand_cierre_log (
    fecha_cerrada       DATE         NOT NULL,
    planta_id           VARCHAR(10)  NOT NULL REFERENCES lov_bit.planta(planta_id),
    cerrado_en          DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
    registros_cerrados  INT          NOT NULL,
    CONSTRAINT PK_mand_cierre_log PRIMARY KEY (fecha_cerrada, planta_id)
);
```

Idempotencia primaria del sweeper diario MAND (`server/utils/mand-sweeper.js::cerrarDiaMand`):

- Antes de cualquier escritura, el sweeper hace `SELECT 1 ... WHERE fecha_cerrada=@f AND planta_id=@p`. Si encuentra fila, retorna `{ skipped: true, reason: 'already_closed' }` sin abrir transacción.
- La fila se inserta DENTRO de la transacción que cierra el día (junto al INSERT histórico, soft-delete `evento_dashboard`, DELETE activo y CIET). Si dos calls concurrentes llegan al INSERT, la PK colisiona y la segunda hace rollback automático — comportamiento correcto.
- `registros_cerrados` = cuántos registros borrador se movieron a histórico. Sirve para auditoría operacional (¿el día N tuvo uso? ¿cuánto?).
- El sweeper también hace early return `{ skipped: true, reason: 'no_records' }` (sin INSERT al log) si no hay registros borrador para `(fecha, planta)`. Esto evita que un día sin uso aparezca en el log y bloquee re-procesos legítimos. Trade-off aceptado: si pasado un tiempo aparecen registros para ese día y se gatilla el cron, el sweeper sí cerrará correctamente porque no hay fila previa en el log.

### 4.5 Columnas calculadas Bogotá (F22)

Para que las consultas humanas directas en SSMS muestren hora Bogotá sin ceremonias, cada tabla operativa expone columnas calculadas no-persistidas con sufijo `_bogota`. Aplicaciones siguen leyendo las columnas UTC (sin sufijo); las `_bogota` son solo para inspección humana.

```sql
ALTER TABLE bitacora.registro_activo
  ADD fecha_evento_bogota   AS DATEADD(HOUR, -5, fecha_evento),
      creado_en_bogota      AS DATEADD(HOUR, -5, creado_en),
      modificado_en_bogota  AS DATEADD(HOUR, -5, modificado_en),
      fecha_fin_estado_bogota AS DATEADD(HOUR, -5, fecha_fin_estado);

ALTER TABLE bitacora.registro_historico
  ADD fecha_evento_bogota   AS DATEADD(HOUR, -5, fecha_evento),
      creado_en_bogota      AS DATEADD(HOUR, -5, creado_en),
      modificado_en_bogota  AS DATEADD(HOUR, -5, modificado_en),
      cerrado_en_bogota     AS DATEADD(HOUR, -5, cerrado_en),
      fecha_fin_estado_bogota AS DATEADD(HOUR, -5, fecha_fin_estado);

ALTER TABLE bitacora.evento_dashboard
  ADD creado_en_bogota AS DATEADD(HOUR, -5, creado_en);

ALTER TABLE bitacora.disponibilidad_dashboard
  ADD fecha_inicio_estado_bogota AS DATEADD(HOUR, -5, fecha_inicio_estado),
      modificado_en_bogota       AS DATEADD(HOUR, -5, modificado_en),
      actualizado_en_bogota      AS DATEADD(HOUR, -5, actualizado_en);

ALTER TABLE bitacora.sesion_activa
  ADD inicio_sesion_bogota    AS DATEADD(HOUR, -5, inicio_sesion),
      ultima_actividad_bogota AS DATEADD(HOUR, -5, ultima_actividad);

ALTER TABLE bitacora.sesion_bitacora
  ADD abierta_en_bogota    AS DATEADD(HOUR, -5, abierta_en),
      finalizada_en_bogota AS DATEADD(HOUR, -5, finalizada_en);

ALTER TABLE bitacora.mand_cierre_log
  ADD cerrado_en_bogota AS DATEADD(HOUR, -5, cerrado_en);

ALTER TABLE bitacora.migracion_aplicada
  ADD aplicada_en_bogota AS DATEADD(HOUR, -5, aplicada_en);
```

Las columnas calculadas son **virtuales** — no ocupan espacio, se calculan al SELECT. No son indexables sin marcarlas `PERSISTED`, pero como solo se usan para inspección humana, no es necesario.

**Implementación operativa:** la migración aplica en `server/db.js::initDB()` con flag `'F22.D1'` en `bitacora.migracion_aplicada`. Las DDLs son idempotentes — cada `ADD <col>` se gateaba con `IF NOT EXISTS (SELECT 1 FROM sys.columns ...)`.

**Consumidores con `SELECT *`:** las columnas calculadas aparecen automáticamente en `SELECT *`. Cualquier handler que dependa de la posición o el shape exacto del recordset rompería. Auditoría (F22): los flujos transaccionales usan listas explícitas de columnas (forzado por F18 en MAND y F12+F14 en DISP); los `SELECT *` residuales en `server.js` operan vía nombre de propiedad (`row.fecha_evento`) sin sensibilidad a posición/shape.

---

## 5. Integración con el Dashboard (esquema `bitacora`)

El esquema expone dos tablas-puente independientes hacia el Dashboard de Generación:

- **5.1 `evento_dashboard`** — eventos por hora/periodo (AUTH, REDESP, PRUEBA) emitidos desde MAND. Reemplaza la tabla v1.0 `autorizacion_dashboard` (renombrada en F5; vista compat eliminada en F9).
- **5.2 `disponibilidad_dashboard`** (F12) — estado vigente por planta (DISP). Separada deliberadamente: DISP no tiene periodo ni semántica horaria.

### 5.1 `evento_dashboard` (eventos por periodo, MAND)

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

### 5.2 `disponibilidad_dashboard` (estado vigente por planta, DISP)

Cimiento cross-app para que F15 (futuro) muestre un badge de disponibilidad por planta en `dashboard-gen-gec3`. Se mantiene **una fila por planta** sincronizada con el vigente real en `registro_activo` mediante UPSERT atómico.

```sql
CREATE TABLE bitacora.disponibilidad_dashboard (
  planta_id              VARCHAR(10) PRIMARY KEY
      REFERENCES lov_bit.planta(planta_id),
  evento                 VARCHAR(20) NOT NULL
      CHECK (evento IN ('Disponible','Indisponible','En Reserva')),
  codigo                 SMALLINT    NOT NULL CHECK (codigo IN (-1, 0, 1)),
  fecha_inicio_estado    DATETIME2   NOT NULL,
  registro_activo_id     INT         NOT NULL,
  jdts_snapshot          NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  jefes_snapshot         NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  modificado_por         INT         NULL
      REFERENCES lov_bit.usuario(usuario_id),
  modificado_en          DATETIME2   NULL,
  actualizado_en         DATETIME2   NOT NULL DEFAULT GETDATE()
);
```

**Invariantes:**

- 1 fila por planta. PK garantiza unicidad.
- Refleja siempre el `registro_activo` vigente (`fecha_fin_estado IS NULL`).
- UPSERT atómico desde 3 caminos transaccionales:
  - `POST /api/registros` (rama DISP) — RF-055.
  - `PUT /api/registros/:id` (rama DISP) — RF-056.
  - `POST /api/disponibilidad/deshacer` — RF-057. Si el deshacer no encuentra histórico, se hace `DELETE` (la planta vuelve al empty state — vigente null).
- `modificado_por`/`modificado_en` se setean al editor cuando es un PUT; se limpian a NULL en POST y deshacer (el autor original vive en `registro_activo.creado_por`).
- `codigo` deriva del `evento` con la regla fija `Disponible:1 / 'En Reserva':0 / Indisponible:-1`.

**Diferencias con `evento_dashboard` (5.1):**

| Aspecto | `evento_dashboard` | `disponibilidad_dashboard` |
|---|---|---|
| Granularidad | Por (planta, fecha, periodo, tipo) | Por planta |
| Tipo enum | AUTH/REDESP/PRUEBA | — (DISP siempre) |
| Soft delete | `activa=0` reactivable | DELETE total al deshacer sin histórico |
| Histórico | El dashboard no lo necesita (un valor por celda 24h) | El dashboard solo ve el vigente; histórico vive en `registro_historico` |

**Endpoint expuesto:** `GET /api/eventos-dashboard?tipo=DISP&planta_id=GEC3` (extendido en F12; el handler detecta `tipo='DISP'` y consulta `disponibilidad_dashboard` en lugar de `evento_dashboard`). Shape de respuesta: `{ eventos: [{ planta_id, evento, codigo, fecha_inicio_estado, jdts_snapshot, jefes_snapshot, actualizado_en }] }`.

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

### 7.8 Disponibilidad como mini-dashboard (F12)

La bitácora DISP rompe deliberadamente varias invariantes del modelo general porque su semántica operativa es distinta (estado vigente único por planta, sin ciclo de turno):

- **No usa cierre de turno:** los registros se cierran automáticamente cuando llega un evento posterior (UPDATE `fecha_fin_estado` + INSERT en histórico + DELETE del activo, todo en transacción).
- **No emite CIET de finalización/cierre:** F3 y F4 no se aplican. El único CIET que emite DISP es `'Deshacer disponibilidad'` desde `POST /api/disponibilidad/deshacer` (audit con autor + jdts/gerentes activos).
- **`turno = NULL` siempre:** ver 4.1.
- **Una sola fila vigente por planta:** garantizado por filtered unique index `UQ_disp_vigente_por_planta` (4.3) + `UPDLOCK + HOLDLOCK` en el SELECT del POST (RF-055).
- **Side-effect controlado en `registro_historico`:** editar `fecha_inicio_estado` del vigente vía PUT actualiza `fecha_fin_estado` del último histórico (N-1) para mantener cronología sin gap. **Es la única excepción documentada a "histórico inmutable".** Cualquier código nuevo que asuma inmutabilidad estricta debe excluir este caso.
- **`disponibilidad_dashboard` (5.2) vive aparte de `evento_dashboard` (5.1):** no comparten UNIQUE ni schema. Mezclarlas obligaría a hacer `periodo` nullable en `evento_dashboard` y romper la UNIQUE existente — preferimos dos tablas con semánticas claras.
- **Permisos diferenciados:** `puede_ver=1` para todos los cargos (es información operativa de interés universal); `puede_crear=1` solo para JdT (1) e IngOp (2). Frontend gatea botones; backend rechaza con 403 desde `hasPermisoBitacora`.

### 7.9 Operación 24h con batch save y cierre automático (F16+F17)

La bitácora MAND también rompe varias invariantes del modelo general — distintas a las de DISP:

- **No usa cierre individual ni masivo:** `POST /api/cierre/bitacora` con `bitacora.codigo='MAND'` retorna `400 mand_cierre_individual_no_permitido`. La exclusión del cierre masivo (vigente desde F10) se mantiene. El cierre se ejecuta automáticamente al final del día Bogotá vía sweeper diario (`server/utils/mand-sweeper.js`) que cada 60s detecta cambio de día y mueve los registros activos del día anterior a `registro_historico` con `estado='cerrado'`. Resiliente a reinicios: el primer tick post-arranque intenta cerrar AYER por si el server estaba caído al cruzar medianoche.
- **No acepta save por celda:** `POST /api/registros` y `PUT /api/registros/:id` siguen aceptando registros MAND (compatibilidad con flujos automáticos legacy), pero la UI usa exclusivamente `POST /api/sala-de-mando/guardar` con shape de batch atómico `{ planta_id, fecha, filas: [{ tipo, detalle, funcionariocnd, periodos: [{ periodo, valor_mw }] }] }`. Toda la batch corre en una transacción única. Validaciones de negocio devuelven 400 con `{ errores: [{ tipo, periodo?, motivo }] }` y NO escriben. Motivos: `fecha_no_es_hoy`, `tipo_invalido`, `periodos_invalido`, `periodo_fuera_rango`, `valor_mw_invalido`, `periodo_bloqueado`, `funcionariocnd_requerido`.
- **`fecha` debe ser hoy en Bogotá:** el server fuerza `fecha == hoyStr` (Bogotá calculado como `new Date(now - 5h)`). Sino 400 `fecha_no_es_hoy`. La grilla solo opera sobre HOY tras F17 — la paginación entre días F10 (`/api/sala-de-mando/dias-pendientes`) fue eliminada en F16.
- **REDESP locked en periodos pasados:** server rechaza `tipo='REDESP' && valor_mw!=null && periodo < periodoActual` (`= floor(horaBogota)+1`) con 400 `periodo_bloqueado`. AUTH y PRUEBA no tienen lock — pueden registrarse a-posteriori dentro del día.
- **`funcionariocnd` por tipo:** AUTH lo requiere si hay al menos un `valor_mw != null` en la fila (`funcionariocnd_requerido` si vacío). PRUEBA y REDESP fuerzan `funcionariocnd = NULL` en persistencia (silencioso, sin error). Esto vale tanto para el INSERT como para el UPDATE.
- **`modificado_por` selectivo:** se actualiza únicamente cuando `valor_mw` cambió. Cambios de `detalle`/`funcionariocnd` no tocan `modificado_por`/`modificado_en`. Trade-off explícito de F16 (regla 2b de `preguntas_mand2.md`): `modificado_por` audita cambios numéricos al despacho, no edición de metadatos.
- **CIET de cierre con autor SISTEMA:** distinto del CIET regular (autor=usuario que cierra, snapshot del momento). El sweeper diario emite CIET con `creado_por=USUARIO_SISTEMA_ID` y snapshots agregados con todo el personal que rotó por la guardia ese día (`snapshotJDTsDelDia`, `snapshotJefesDelDia`, `snapshotIngenierosDelDia`). `campos_extra = { rol: 'SISTEMA', bitacora_origen, forzado: true, motivo: 'mand-sweeper-diario', fecha_cerrada, registros_cerrados }`. Idempotencia vía `bitacora.mand_cierre_log` (4.4.2).
- **`evento_dashboard` soft-delete en cierre:** al cerrar el día, las filas en `evento_dashboard` cuyo `registro_origen_id` apunta a registros que se mueven al histórico se marcan `activa=0`. El dashboard productivo deja de verlas inmediatamente.
- **Permisos:** `puede_ver=1` y `puede_crear=1` solo para cargos 1 (JdT) y 2 (IngOp). Otros cargos no ven la bitácora en el sidebar.

### 7.10 Convención de zonas horarias (F19+F20+F21+F22)

La BD guarda **todas las columnas DATETIME2 en UTC**, pobladas por `SYSUTCDATETIME()`. Toda conversión a hora Bogotá ocurre explícitamente en presentación o en comparación dentro de queries. La aplicación opera para usuarios en Colombia: el render frontend usa siempre `timeZone: 'America/Bogota'` explícito (no la TZ del navegador).

**Reglas operativas:**

- INSERTs y UPDATEs DEFAULT usan `SYSUTCDATETIME()`. `GETDATE()` está prohibido en `Bit-cora-g3/server/` salvo que esté documentado por qué.
- Comparaciones de fecha del día Bogotá usan `CAST(DATEADD(HOUR, -5, columna_utc) AS DATE) = @fecha_bogota` (Colombia UTC−5 sin DST). Patrón en `mand-sweeper.js::cerrarDiaMand`, `GET /api/sala-de-mando` (post F19) y handlers similares.
- Sweep TTL de sesiones (`db.js`) usa `SYSUTCDATETIME()` (post F19) — antes era `GETDATE()` con desfase si el SQL host no estaba en UTC.
- Helpers JS canónicos:
  - **Frontend** (`src/utils/fecha.js`): `getTodayBogota`, `horaBogota`, `shiftDate` con `Intl.DateTimeFormat('America/Bogota')`.
  - **Backend** (`server/utils/turno.js`): `colombiaParts`, `getTurnoColombia`, `turnoFromPeriodo`, `ventanaTurno`, `periodoFromFechaBogota`, `fechaBogotaStr`, `fechaBogotaIso`. Offset puro `-5h` con `getUTC*()`.
  - **Backend** (`server/utils/mand-sweeper.js::todayBogota`): patrón offset puro idéntico, archivo-local.
- Antipatrones prohibidos:
  - `new Date(date.toLocaleString('…', { timeZone: 'America/Bogota' }))` — `new Date(string)` re-interpreta el string en TZ del navegador/host.
  - `date.getTimezoneOffset()` para "normalizar a UTC" — depende del host.
  - `.toLocaleString(...)` / `.toLocaleDateString(...)` SIN `timeZone: 'America/Bogota'` explícito.
  - `getHours()`/`getDate()`/`getMonth()` directamente sobre `new Date()` sin offset previo.
  - `GETDATE()` en columnas DATETIME2 nuevas o en queries que comparan "hoy" — siempre `SYSUTCDATETIME()` con `DATEADD(HOUR, -5, …)` para Bogotá.
- Inputs `<input type="datetime-local">` interpretan lo tipeado como hora Bogotá. Frontend convierte a UTC antes de POST con offset `-05:00` apendido (patrón `toIsoFromLocal` / `toDatetimeLocal` en `Disponibilidad/CambiarEstadoModal.jsx` post F20).
- CIET `campos_extra.fecha_cerrada` es fecha Bogotá (`YYYY-MM-DD` día Bogotá), `fecha_revertida` es ISO con sufijo `-05:00` Bogotá. CIETs históricos pre-F19 quedan en UTC — distinguir por fecha de creación si auditás cruces históricos.

**Vistas/columnas compat para SSMS** (F22):

Cada tabla operativa con columnas DATETIME2 expone columnas calculadas con sufijo `_bogota` que aplican `DATEADD(HOUR, -5, …)`. No persistidas, costo cero al INSERT, aparecen en `SELECT *` automáticamente. Lista completa en §4.5.

**Snippets SSMS** viven en `Bit-cora-g3/sql/snippets/`. Incluye templates para queries ad-hoc Bogotá (filtrar por día, agregar por hora, inspeccionar CIETs).

**Deuda documentada:**

- **T4 cierre cronológico (RESUELTO 2026-05-13)**: `server.js:1741` (cierre individual) y `:1840` (cierre masivo) usan `ORDER BY fecha_evento ASC, registro_id ASC`. El tiebreaker `registro_id ASC` garantiza determinismo cuando dos registros tienen `fecha_evento` idéntica (posible en batch insert). Test de regresión: `server/tests/fechas_bogota.test.js::C5`. La sugerencia original de usar `DATEADD(HOUR, -5, fecha_evento)` no aplica — Colombia no tiene DST y la ordenación por UTC es equivalente a la ordenación por Bogotá para registros del mismo offset.
- **Tests de componentes RTL**: `HistoricoTable`, `EstadoActualCard`, `BarraEstado`, `SalaDeMandoGrid` no tienen tests automáticos de render con TZ override. Smoke manual con DevTools cubre el gap hoy.
- **CI matrix con GH Actions**: el repo no tiene CI configurado. F21 dejó tests corriendo localmente (`npm test`). Cuando se agregue GH Actions, configurar matriz `TZ=UTC,America/Bogota,Asia/Tokyo` para detectar regresiones por uso accidental de `getHours()`/`getTimezoneOffset()` sin TZ explícito.

---

## 8. Historial de versiones

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 2026-04-10 | Versión inicial: esquema completo de catálogos, sesiones, registros activo/histórico, tabla puente al Dashboard, vistas y notas de diseño. |
| 1.1 | 2026-04-18 | Roles por rol (JdTs, Jefes, Ingenieros) migrados a snapshots JSON (`*_snapshot NVARCHAR(MAX) NOT NULL`). `creado_por` queda como único FK vivo a `lov_bit.usuario` en tablas transaccionales. Se añade TTL de 5 min sobre `sesion_activa.ultima_actividad`, sweep de arranque y endpoint `/api/auth/resume`. Vista `v_historico_busqueda` reescrita sin JOINs por rol. |
| 1.2 | 2026-04-29 | F12+F13+F14 (Disponibilidad como mini-dashboard). Columna `fecha_fin_estado DATETIME2 NULL` en `registro_activo` y `registro_historico` (DISP only). Filtered unique index `UQ_disp_vigente_por_planta` (4.3). Tabla nueva `bitacora.disponibilidad_dashboard` (5.2) — separada de `evento_dashboard`. `turno` se vuelve nullable (DISP graba NULL). Sección 7.8 documenta las invariantes que DISP rompe deliberadamente. **Fuera del alcance de v1.2:** F2/F4/F5/F9 ya estaban incorporados al modelo en parches previos sin bumpear esta versión — la `autorizacion_dashboard` se renombró a `evento_dashboard` con columna `tipo` (F5) y la vista compat se eliminó (F9); la columna `cerrada_en` de `sesion_activa` y la tabla `sesion_bitacora` (F2) viven en código pero no estaban reflejadas acá. |
| 1.3 | 2026-05-04 | F16+F17+F18 (Sala de Mando con batch save y cierre automático fin de día). Sección 2.3.2 nueva — usuario `SISTEMA` (autor automático para CIETs de procesos cron). Sección 4.4 nueva con dos tablas auxiliares: `bitacora.migracion_aplicada` (flag genérico de migraciones one-time) y `bitacora.mand_cierre_log` (idempotencia del sweeper diario MAND). Sección 7.9 nueva — políticas MAND (no acepta cierre individual/masivo, batch save atómico vía `POST /api/sala-de-mando/guardar`, lock REDESP por hora actual, funcionariocnd condicional por tipo, CIET con autor SISTEMA y snapshots agregados del día). El endpoint `GET /api/sala-de-mando/dias-pendientes` (F10) fue eliminado en F16. |
| 1.4 | 2026-05-05 | F19+F20+F21+F22 (corrección de fechas — convención TZ formalizada). Sección 7.10 nueva con la convención (BD en UTC, presentación Bogotá explícito), antipatrones prohibidos, helpers canónicos. Sección 4.5 nueva con columnas calculadas `*_bogota` para inspección humana en SSMS, aplicadas vía migración idempotente F22.D1 en `db.js::initDB()`. Bugs corregidos en F19: T1 (`GET /api/sala-de-mando` con `DATEADD(HOUR, -5, fecha_evento)`), T2 (sweep TTL `db.js` con `SYSUTCDATETIME()`), T3 (CIET `fecha_cerrada` y `fecha_revertida` en hora Bogotá). T4 (cierre cronológico edge case) queda como deuda documentada. F20 corrigió formatters frontend (T5/T6/T7) con `timeZone: 'America/Bogota'` explícito en `BitacorasGecelca3.jsx`, `HistoricoTable.jsx` y `Disponibilidad/CambiarEstadoModal.jsx`. F21 agregó tests de helpers (`server/tests/fechas_bogota.test.js`). |

---

**FIN DEL MODELO**
