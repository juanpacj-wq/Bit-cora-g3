# BIT-MODBD-2026-001 — Modelo de Base de Datos

**Módulo de Bitácoras de Planta — SQL Server — Esquemas `bitacora.*` / `lov_bit.*`**

| Campo | Valor |
|---|---|
| Código | BIT-MODBD-2026-001 |
| Versión | 1.8 |
| Fecha | 2026-05-21 |
| Motor | SQL Server 2019+ |
| Esquemas | `lov_bit` (catálogos) / `bitacora` (transaccional) |
| Autoría | Gerencia de Generación — GECELCA S.A. E.S.P. |

> **Convenciones:** las tablas de catálogos viven en `lov_bit`; las tablas operativas en `bitacora`. Los campos JSON usan `NVARCHAR(MAX)` y se validan en la capa de aplicación.

> **Cambios v1.9 (2026-06-26) — Login Microsoft Entra ID (D-031):**
> - **§2.3 `lov_bit.usuario`**: nuevas columnas `azure_oid VARCHAR(64) NULL` (clave de auto-aprovisionamiento, índice único filtrado `UQ_usuario_oid`), `azure_upn VARCHAR(200) NULL`, `azure_tid VARCHAR(64) NULL`. `password_hash` pasa a **nullable** (los usuarios Entra se insertan con `NULL`; SISTEMA conserva el centinela `'!disabled!'`). El seed por `personal-2026.json` (`seedPersonal`) se **retiró**: la identidad se auto-aprovisiona en el primer login (`auth/provision.js`, MERGE por `azure_oid`). Los singletons `es_jefe_planta`/`es_jdt_default` se fijan por UPN (`M365_JEFE_PLANTA_UPNS`/`M365_JDT_DEFAULT_UPNS`), no por App Role.
> - **§3 `sesion_activa`**: cambia el ciclo de vida — el `turno-sweeper` ahora **expulsa** la sesión de app a fin de turno (`activa=0`, `cerrada_en`), separada de la cookie de login Entra (larga). La reactivación (`select-context`) refresca `inicio_sesion`+`turno`. La identidad ya no viaja en `X-Sesion-Id`; `loadSession` resuelve por `req.session.user.oid` (cookie). El login local (`/api/auth/login`, scrypt) y `/api/auth/logout` por `sesion_id` fueron eliminados; nuevos `/auth/login`, `/auth/redirect`, `/api/me`, `/api/logout`.
> - **Nuevo esquema `auth`**: tabla `[auth].[AppSessions]` (store de `express-session`, auto-provisionada). Aislada de `lov_bit`/`bitacora`.
> - **§2.6 matriz de permisos**: sin cambios estructurales — el cargo se deriva del App Role (`server/utils/entra-roles.js`, value→`cargo.nombre` 1:1, precedencia en multi-rol) en `select-context`, no de selección manual. Ver D-031.

> **Cambios v1.8 (2026-05-21) — Consumos de Combustibles (D-027):**
> - **Nueva §2.7 `lov_bit.combustible`** — catálogo por planta (`planta_id, codigo, nombre, unidad, tipo, orden, activo`). 18 seeds (8 GEC3 + 10 GEC32). Tipo discriminador `ALIMENTADOR/CALIZA/ACPM` usado por la vista `v_consumo_periodo` para derivar Total Carbón.
> - **Nueva §4.9 `bitacora.consumo_combustible`** — transaccional long-format (1 fila por celda planta+fecha+periodo+combustible), `cantidad DECIMAL(12,3)`, auditoría `creado_por/modificado_por`. UNIQUE compuesto previene duplicados. Vista `v_consumo_periodo` pivotea por (planta, fecha, periodo) y suma `total_carbon_ton = SUM(tipo='ALIMENTADOR')`, `caliza_ton`, `acpm_gal`.
> - **§2.4 `lov_bit.bitacora`** gana una fila más: `codigo='COMB'`, `nombre='Consumos'`, `icono='Flame'`, `formulario_especial=1`, `orden=11`. Reusa el sistema de permisos en `cargo_bitacora_permiso` sin código nuevo; la matriz canónica de §2.6 se extendió con CASE clauses para COMB.
> - **Migración `F26.B1`** idempotente en `db.js::initDB()`: tablas + vista + seeds + permisos one-shot. Convive ortogonalmente con F26.A1 (DISP).

> **Cambios v1.7 (2026-05-20) — Migración ER DISP (D-026):**
> - **Nueva §4.8** con DDL de `bitacora.disponibilidad_estado` (PK `disponibilidad_id`, columnas tipadas, filtered unique index `UQ_disp_estado_vigente_por_planta`, columnas Bogotá calculadas, vista `v_disponibilidad_estado` con acumulados via window functions). Reemplaza el storage DISP que vivía en `registro_activo` / `registro_historico` con datos clave embebidos en `campos_extra` JSON.
> - **§5.2 `disponibilidad_dashboard`** ahora es una VIEW sobre `disponibilidad_estado` (filtra `fecha_fin_estado IS NULL`). Preserva shape para el endpoint `GET /api/eventos-dashboard?tipo=DISP` (F15). Mapea `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot` por compat.
> - **§7.8** marcada como referencia histórica — DISP ya NO rompe los invariantes ahí listados; vive en su propia tabla con su propio modelo.
> - **Vista `v_disp_intervalos` dropeada** (F26.A1) — la nueva tabla ya es plana, no requiere normalización extra. Las métricas (`GET /api/disponibilidad/metricas`) ahora suman `DATEDIFF_BIG` directamente sobre `disponibilidad_estado`.
> - **Cleanup**: rows DISP eliminados de `registro_activo`/`registro_historico` por el bloque idempotente F26.A1. La columna `fecha_fin_estado` en esas tablas queda como no-op para otras bitácoras (no se borra para evitar churn de schema).
> - **Contrato HTTP preservado**: POST/PUT/GET/deshacer DISP devuelven shape byte-a-byte idéntico — el frontend y el cross-repo no requieren cambios.

> **Cambios v1.6 (2026-05-19) — Conformación de turno:**
> - **Nueva §4.7** con DDL de `bitacora.conformacion_turno` (PK compuesta `(fecha_operativa, planta_id, turno, usuario_id)`, FKs a usuario/planta/cargo, índice `IX_conformacion_turno_lookup`, 3 columnas `*_bogota` calculadas vía bloque F22.D2 separado).
> - **§3 `sesion_activa`**: `cerrada_en` ahora se pobla en `POST /api/auth/logout` (fix retro: la columna existía desde F2 pero nunca se escribía). El caso "logout no llamado" usa `ventanaTurno().fin` como aproximación con `fin_inferido=1`.
> - **Filtro semántico del builder**: una sesión cuenta para el turno X si arrancó dentro de la ventana de X (`inicio_sesion >= ventana_inicio AND inicio_sesion < ventana_fin`). Decisión derivada de D-003 + observación de datos productivos (sesiones eternas + limbo producían duraciones absurdas).
> - Sin cambios al invariante D-003 — sesión sigue persistente hasta logout o sweeper de turno.

> **Cambios v1.5 (2026-05-18) — sincronización con BD productiva:**
> - Cierre del gap doc↔código detectado al cruzar `INFORMATION_SCHEMA` real con `server/db.js`. Las DDLs de §2 y §3 se alinearon a lo que efectivamente crea `initDB()` post-migraciones F2/F3/F5/F6/F9/v2.
> - `lov_bit.cargo`: agregada `puede_cerrar_turno BIT NOT NULL DEFAULT 0`. Cargo "Jefe de Turno" renombrado a "Ingeniero Jefe de Turno" (migración v2). `puede_cerrar_turno=1` en *Ingeniero Jefe de Turno* y *Ingeniero de Operación*.
> - `lov_bit.usuario`: agregada `username VARCHAR(50) NOT NULL` con `UQ_usuario_username`. `email` pasa a `NULL`. Hash de contraseña migra de plaintext a `bcrypt` (migración v2 con backfill).
> - `lov_bit.bitacora`: agregada `oculta BIT NOT NULL DEFAULT 0` (toggle de visibilidad en UI sin desactivar la bitácora).
> - `lov_bit.tipo_evento`: agregada `notificar_dashboard_tipo VARCHAR(10) NULL CHECK IN ('AUTH','REDESP','PRUEBA')` (F6). Reemplaza al flag JSON `notificar_dashboard:true` que vivía en `lov_bit.bitacora.definicion_campos`. Decisión de qué `tipo` escribir en `evento_dashboard` ahora vive en la fila del `tipo_evento`, no en el JSON de la bitácora.
> - `bitacora.sesion_activa`: agregada `cerrada_en DATETIME2 NULL` (F2 — distingue logout explícito del cierre por sweeper de turno F4). El **sweep TTL de arranque fue eliminado en F9** — el modelo post-F2 mantiene la sesión activa hasta logout o sweeper de turno; la columna `ultima_actividad` sigue actualizándose pero ya no se rechazan requests por TTL ni se purgan filas al arranque.
> - `bitacora.registro_activo` / `registro_historico`: `detalle NVARCHAR(MAX)` pasa a `NULL` (F3 — CIETs no usan `detalle`, MAND tampoco siempre).
> - **Nueva §4.6**: DDL formal de `bitacora.sesion_bitacora` (F2 — trackea participación de un login en cada bitácora). Estaba en código pero ausente del MD; era referenciada desde §4.5, §7.4 y §7.9 sin DDL propio.
> - §5.1 `evento_dashboard`: corregido el `UNIQUE` a 4 columnas `(planta_id, fecha, periodo, tipo)` (era 3 en v1.4 — F5 lo extendió a 4 para permitir AUTH/REDESP/PRUEBA coexistentes por celda 24h).
> - §5.1: la **vista compat `bitacora.autorizacion_dashboard` sigue viva** — el doc v1.4 afirmaba que F9 la eliminó, pero `db.js::initDB()` la recrea idempotentemente en cada arranque. Marcada como deuda; ningún consumidor activo la usa hoy.

> **Cambios v1.1 (2026-04-18):**
> - `registro_activo`, `registro_historico` y `autorizacion_dashboard` sustituyen las columnas FK por rol (`ingeniero_id`, `jdt_turno_id`, `jefe_id`, `jdt_id`) por **snapshots JSON** (`ingenieros_snapshot`, `jdts_snapshot`, `jefes_snapshot`) que preservan la lista completa de usuarios con ese rol al momento del registro. Único FK vivo a `lov_bit.usuario` en estas tablas: `creado_por` (autor).
> - `sesion_activa` adopta un **TTL de 5 min** sobre `ultima_actividad`: sesiones ociosas o huérfanas se rechazan en el middleware y se limpian en el arranque. _(Histórico — este TTL fue eliminado en F9. Ver §7.4 vigente.)_
> - Nuevo endpoint `POST /api/auth/resume` y contrato `sendBeacon` para distinguir recarga de cierre de pestaña (detalles en BIT-RF-2026-001, sección 4.1).

---

## Tabla de contenidos

0. [Resumen de arquitectura](#0-resumen-de-arquitectura)
1. [Creación de esquemas](#1-creación-de-esquemas)
2. [Catálogos (esquema `lov_bit`)](#2-catálogos-esquema-lov_bit)
   - 2.7 [`combustible` — catálogo por planta de Consumos (D-027)](#27-combustible--catálogo-por-planta-de-consumos-d-027)
3. [Sesiones activas (esquema `bitacora`)](#3-sesiones-activas-esquema-bitacora)
4. [Registros de bitácora (esquema `bitacora`)](#4-registros-de-bitácora-esquema-bitacora)
   - 4.4 [Tablas auxiliares de migración y cierre MAND](#44-tablas-auxiliares-de-migración-y-cierre-mand)
   - 4.5 [Columnas calculadas Bogotá (F22)](#45-columnas-calculadas-bogotá-f22)
   - 4.6 [`sesion_bitacora` — participación por bitácora (F2)](#46-sesion_bitacora--participación-por-bitácora-f2)
   - 4.7 [`conformacion_turno` — snapshot histórico por turno-planta](#47-conformacion_turno--snapshot-histórico-por-turno-planta)
   - 4.8 [`disponibilidad_estado` — máquina de estados DISP (D-026)](#48-disponibilidad_estado--máquina-de-estados-disp-d-026)
   - 4.9 [`consumo_combustible` — Consumos long-format + vista pivot (D-027)](#49-consumo_combustible--consumos-long-format--vista-pivot-d-027)
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
| Sesiones | `bitacora` | Sesiones activas (logout o cierre por sweeper de turno); punto de consulta para snapshots de rol |
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
-- solo_lectura       = 1 para Gerente de Producción (solo consulta, no escribe).
-- puede_cerrar_turno = 1 para Ingeniero Jefe de Turno e Ingeniero de Operación
--                      (mismo poder operativo, roles distintos en UI y snapshots).
CREATE TABLE lov_bit.cargo (
    cargo_id           INT           IDENTITY(1,1) PRIMARY KEY,
    nombre             VARCHAR(100)  NOT NULL,
    solo_lectura       BIT           NOT NULL DEFAULT 0,
    puede_cerrar_turno BIT           NOT NULL DEFAULT 0
);

-- Cargos definitivos según LISTADO DE PERSONAL 2026 (migración v2 hizo el rename
-- de "Jefe de Turno" → "Ingeniero Jefe de Turno" + cableó puede_cerrar_turno).
-- El catálogo real incluye además personal operativo de planta no listado aquí
-- (Operador Tablero, Operador Maquinaria Pesada, etc.) con ambos flags en 0.
INSERT INTO lov_bit.cargo (nombre, solo_lectura, puede_cerrar_turno) VALUES
    ('Ingeniero Jefe de Turno',     0, 1),  -- cargo_id = 1 (ex "Jefe de Turno")
    ('Ingeniero de Operación',      0, 1),  -- cargo_id = 2
    ('Ingeniero de Planta de Agua', 0, 0),  -- cargo_id = 3
    ('Gerente de Producción',       1, 0);  -- cargo_id = 4
```

**Semántica de `puede_cerrar_turno`:** se valida en el middleware de cierre (RF). Los dos cargos que pueden cerrar comparten permisos operativos; lo que los distingue es la **identidad** (snapshots `jdts_snapshot` vs `ingenieros_snapshot`), no el permiso. Ver §2.3.1 sobre `es_jdt_default`.

### 2.3 Usuarios

```sql
-- Login por username + PIN/contraseña. Keycloak queda fuera del scope actual.
-- username        = identificador único (se usa en JWT y en logs).
-- email           = opcional (NULL para usuarios sin correo corporativo, p.ej. SISTEMA).
-- password_hash   = bcrypt post-migración v2 (antes plaintext con default '1234').
-- es_jefe_planta  = 1 solo para Ernesto Muñoz (jefe global).
-- es_jdt_default  = 1 solo para Omar Fedullo (JdT fallback — ver 2.3.1).
CREATE TABLE lov_bit.usuario (
    usuario_id      INT           IDENTITY(1,1) PRIMARY KEY,
    nombre_completo VARCHAR(200)  NOT NULL,
    username        VARCHAR(50)   NOT NULL,
    email           VARCHAR(200)  NULL,
    password_hash   VARCHAR(200)  NOT NULL,
    es_jefe_planta  BIT           NOT NULL DEFAULT 0,
    es_jdt_default  BIT           NOT NULL DEFAULT 0,
    activo          BIT           NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX UQ_usuario_username ON lov_bit.usuario(username);

INSERT INTO lov_bit.usuario (nombre_completo, username, email, es_jefe_planta, es_jdt_default) VALUES
    ('Ernesto Muñoz', 'ernesto.munoz', 'ernesto.munoz@gecelca.com', 1, 0),
    ('Omar Fedullo',  'omar.fedullo',  'omar.fedullo@gecelca.com',  0, 1);
```

**Notas:**

- **`username` reemplaza al `email` como identificador de login** (migración v2). El backfill mapeó los emails pre-existentes a la parte local del correo. `email` queda como dato de contacto opcional, sin UNIQUE.
- **`password_hash` con bcrypt** desde v2. La migración rehashea contraseñas plaintext detectadas al primer arranque post-upgrade. El default plaintext `'1234'` del legacy ya no existe — usuarios nuevos requieren hash explícito.
- El antiguo `UNIQUE(email)` se removió en v2.

#### 2.3.1 Semántica de `es_jdt_default`

`es_jdt_default` **no es un flag de rol ni de permiso**: es un **fallback de identidad** que se usa para poblar `jdts_snapshot` (y `/api/catalogos/jdt-actual`) cuando no hay ningún usuario del cargo *Ingeniero Jefe de Turno* con `sesion_activa.activa=1` en la planta. Post-F9 no hay filtro TTL — basta una sesión viva (sin `cerrada_en` y sin haber sido cerrada por logout/sweeper). Reglas:

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
-- activa = 0 elimina la bitácora del sistema (no creable, no consultable).
-- oculta = 1 la oculta del sidebar pero sigue creable vía API y visible en histórico
--          (útil para bitácoras que se usan vía batch como MAND).
CREATE TABLE lov_bit.bitacora (
    bitacora_id         INT             IDENTITY(1,1) PRIMARY KEY,
    nombre              VARCHAR(100)    NOT NULL,
    codigo              VARCHAR(10)     NOT NULL UNIQUE,
    icono               VARCHAR(50)     NULL,
    formulario_especial BIT             NOT NULL DEFAULT 0,
    definicion_campos   NVARCHAR(MAX)   NULL,
    orden               INT             NOT NULL DEFAULT 0,
    activa              BIT             NOT NULL DEFAULT 1,
    oculta              BIT             NOT NULL DEFAULT 0
);

-- Bitácoras iniciales
INSERT INTO lov_bit.bitacora
    (nombre, codigo, icono, formulario_especial, definicion_campos, orden)
VALUES
    ('Disponibilidad', 'DISP', 'Activity', 1,
     '[{"campo":"evento","tipo":"select",
       "opciones":["En Servicio","En Reserva","Indisponible","Mantenimiento"],
       "requerido":true},
      {"campo":"codigo","tipo":"auto",
       "regla":{"En Servicio":1,"En Reserva":0,"Indisponible":-1,"Mantenimiento":-1}}]',
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
-- notificar_dashboard_tipo (F6): si != NULL, al INSERT/UPDATE del registro se hace UPSERT
--   en bitacora.evento_dashboard con este valor en la columna `tipo`. NULL = no notifica.
--   Reemplaza al flag JSON `notificar_dashboard:true` que vivía en `bitacora.definicion_campos`.
CREATE TABLE lov_bit.tipo_evento (
    tipo_evento_id           INT           IDENTITY(1,1) PRIMARY KEY,
    bitacora_id              INT           NOT NULL
        REFERENCES lov_bit.bitacora(bitacora_id),
    nombre                   VARCHAR(100)  NOT NULL,
    es_default               BIT           NOT NULL DEFAULT 0,
    orden                    INT           NOT NULL DEFAULT 0,
    notificar_dashboard_tipo VARCHAR(10)   NULL
        CONSTRAINT CK_te_notificar_dashboard_tipo
        CHECK (notificar_dashboard_tipo IN ('AUTH','REDESP','PRUEBA'))
);

CREATE INDEX IX_tipo_evento_bit ON lov_bit.tipo_evento(bitacora_id);

-- Cableado MAND: cada tipo del Operación 24h se mapea a su `tipo` en evento_dashboard.
-- Los tipos de DISP, AUTH (de la bitácora vieja) y de las bitácoras técnicas
-- quedan con notificar_dashboard_tipo = NULL (no escriben en evento_dashboard).
UPDATE te SET notificar_dashboard_tipo = 'AUTH'
FROM lov_bit.tipo_evento te JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
WHERE b.codigo = 'MAND' AND te.nombre = 'Autorización';

UPDATE te SET notificar_dashboard_tipo = 'PRUEBA'
FROM lov_bit.tipo_evento te JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
WHERE b.codigo = 'MAND' AND te.nombre = 'Pruebas';

UPDATE te SET notificar_dashboard_tipo = 'REDESP'
FROM lov_bit.tipo_evento te JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
WHERE b.codigo = 'MAND' AND te.nombre = 'Redespacho';

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

> **Nota v1.8 (D-027):** la matriz canónica que reconstruye `cargo_bitacora_permiso` en cada arranque (`db.js`, bloque "Matriz de permisos") se extendió con dos CASE clauses para `b.codigo = 'COMB'`:
>
> - `puede_ver = 1` para TODOS los cargos (igual que MAND).
> - `puede_crear = 1` solo si `c.nombre IN ('Operador de Planta - Carbón y Caliza', 'Ingeniero Jefe de Turno')`.
>
> Esto garantiza que los permisos COMB sobreviven a restarts sin depender del bloque idempotente F26.B1 (que solo corre una vez y seedea los permisos como bootstrap del primer arranque).

---

### 2.7 `combustible` — catálogo por planta de Consumos (D-027)

Catálogo de combustibles operativos por planta, consumido por el módulo Consumos (§4.9). Filas estables — cambios se hacen vía `db.js` (seed MERGE en F26.B1) y redeploy; sin UI admin. El catálogo es asimétrico entre plantas: GEC3 tiene 6 alimentadores nombrados (A–F); GEC32 tiene 8 numerados (1–8); ambas con CALIZA y ACPM.

```sql
CREATE TABLE lov_bit.combustible (
    combustible_id  INT IDENTITY(1,1) PRIMARY KEY,
    planta_id       VARCHAR(10)  NOT NULL REFERENCES lov_bit.planta(planta_id),
    codigo          VARCHAR(20)  NOT NULL,
    nombre          VARCHAR(100) NOT NULL,
    unidad          VARCHAR(10)  NOT NULL,           -- 'Ton' | 'Gal'
    tipo            VARCHAR(20)  NOT NULL
        CONSTRAINT CK_combustible_tipo CHECK (tipo IN ('ALIMENTADOR','CALIZA','ACPM')),
    orden           INT          NOT NULL DEFAULT 0, -- orden visual en la grilla
    activo          BIT          NOT NULL DEFAULT 1,
    CONSTRAINT UQ_combustible_planta_codigo UNIQUE (planta_id, codigo)
);

CREATE INDEX IX_combustible_planta_orden
    ON lov_bit.combustible(planta_id, orden)
    WHERE activo = 1;
```

**18 seeds (F26.B1):**

| Planta | Codigo  | Nombre          | Unidad | Tipo        | Orden |
|--------|---------|-----------------|--------|-------------|-------|
| GEC3   | ALIM_A  | Alimentador A   | Ton    | ALIMENTADOR | 1     |
| GEC3   | ALIM_B  | Alimentador B   | Ton    | ALIMENTADOR | 2     |
| GEC3   | ALIM_C  | Alimentador C   | Ton    | ALIMENTADOR | 3     |
| GEC3   | ALIM_D  | Alimentador D   | Ton    | ALIMENTADOR | 4     |
| GEC3   | ALIM_E  | Alimentador E   | Ton    | ALIMENTADOR | 5     |
| GEC3   | ALIM_F  | Alimentador F   | Ton    | ALIMENTADOR | 6     |
| GEC3   | CALIZA  | Caliza          | Ton    | CALIZA      | 7     |
| GEC3   | ACPM    | ACPM            | Gal    | ACPM        | 8     |
| GEC32  | ALIM_1  | Alimentador 1   | Ton    | ALIMENTADOR | 1     |
| GEC32  | ALIM_2  | Alimentador 2   | Ton    | ALIMENTADOR | 2     |
| ...    | ...     | ...             | ...    | ...         | ...   |
| GEC32  | ALIM_8  | Alimentador 8   | Ton    | ALIMENTADOR | 8     |
| GEC32  | CALIZA  | Caliza          | Ton    | CALIZA      | 9     |
| GEC32  | ACPM    | ACPM            | Gal    | ACPM        | 10    |

El campo `tipo` es el discriminador semántico que usa la vista `v_consumo_periodo` (§4.9) para calcular el **Total Carbón** como `SUM(cantidad) WHERE tipo='ALIMENTADOR'` por (planta, fecha, periodo) — sin almacenar el total derivado en la tabla transaccional.

**Cross-ref:** ADR [[D-027]]. Catálogo se siembra en `db.js::initDB()` bloque F26.B1 vía `MERGE` por `UQ(planta_id, codigo)` (idempotente).

---

## 3. Sesiones activas (esquema `bitacora`)

```sql
-- Resuelve: quién es JdT en turno y qué ingenieros están en turno.
-- activa     = 0 al cerrar sesión o al finalizar el turno por el sweeper de F4.
-- cerrada_en (F2): distingue logout explícito (activa=0 + cerrada_en=NULL legacy o
--                  cerrada_en=ts cuando el frontend manda LOGOUT) del cierre por
--                  sweeper de turno (activa=0 + cerrada_en=ts SYSUTCDATETIME()).
-- ultima_actividad: heartbeat de 60s y cada request autenticado lo refresca.
--                   Sigue actualizándose para inspección operativa, pero post-F9 ya
--                   NO se rechaza el request por TTL ni se purga la sesión al arranque.
CREATE TABLE bitacora.sesion_activa (
    sesion_id         INT           IDENTITY(1,1) PRIMARY KEY,
    usuario_id        INT           NOT NULL
        REFERENCES lov_bit.usuario(usuario_id),
    planta_id         VARCHAR(10)   NOT NULL
        REFERENCES lov_bit.planta(planta_id),
    cargo_id          INT           NOT NULL
        REFERENCES lov_bit.cargo(cargo_id),
    turno             TINYINT       NOT NULL CHECK (turno IN (1, 2)),
    inicio_sesion     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    ultima_actividad  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    activa            BIT           NOT NULL DEFAULT 1,
    cerrada_en        DATETIME2     NULL
);

CREATE INDEX IX_sesion_lookup
    ON bitacora.sesion_activa(activa, planta_id, cargo_id)
    INCLUDE (usuario_id, turno, inicio_sesion);
```

**Cambio de modelo post-F9:** el sweep TTL de arranque y el rechazo `401` por `ultima_actividad < -5min` **fueron eliminados**. El modelo vigente mantiene la sesión activa hasta que ocurra una de:

1. **Logout explícito** del usuario (frontend POST `/api/auth/logout` o beacon de `pagehide`).
2. **Cierre por sweeper de turno** (F4 — `server/utils/turno-sweeper.js`): finaliza la sesión y emite CIET cuando se agota la ventana del turno.
3. **Reinicio del proceso**: las sesiones quedan huérfanas hasta logout manual; ya no se barren al arranque.

La columna `ultima_actividad` se sigue refrescando con heartbeat para visibilidad operativa, pero **no es un gate de autenticación**.

**Resolución del JdT actual** (sin filtro TTL post-F9):

```sql
SELECT TOP 1 u.usuario_id, u.nombre_completo
FROM bitacora.sesion_activa s
JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
WHERE s.activa = 1
  AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Ingeniero Jefe de Turno')
  AND s.planta_id = @planta
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
    detalle        NVARCHAR(MAX)   NULL,  -- F3: pasa a nullable; CIETs y MAND no siempre requieren detalle

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
| `jdts_snapshot` | `sesion_activa.activa=1`, `cargo.nombre='Ingeniero Jefe de Turno'`, `u.activo=1`. Si la lista queda vacía, fallback a `usuario.es_jdt_default=1 AND activo=1` |
| `jefes_snapshot` | `usuario.es_jefe_planta=1 AND activo=1` (lista estable independiente de sesión) |
| `ingenieros_snapshot` | `sesion_activa.activa=1`, cuyo cargo tenga `cargo_bitacora_permiso.puede_crear=1` para la `bitacora_id`, excluyendo los cargos "Ingeniero Jefe de Turno" y "Gerente de Producción" |

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
    turno          TINYINT         NULL,  -- F12: NULL para DISP, INT 1|2 para el resto
    detalle        NVARCHAR(MAX)   NULL,  -- F3: pasa a nullable (mismo cambio que §4.1)
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

### 4.6 `sesion_bitacora` — participación por bitácora (F2)

Trackea la **participación de un login en cada bitácora individual**, desacoplado de la sesión global. `abierta_en` se setea al entrar a la vista de la bitácora; `finalizada_en` cuando el usuario clickea "Finalizar turno" en esa bitácora, o cuando el sweeper de turno (F4) lo hace en su nombre al agotarse la ventana del turno.

```sql
-- F2: una fila por (sesion_id, bitacora_id). Reabrir tras finalizar es UPSERT
-- (UPDATE finalizada_en = NULL + abierta_en = SYSUTCDATETIME() vía MERGE).
CREATE TABLE bitacora.sesion_bitacora (
    sesion_bitacora_id INT       IDENTITY(1,1) PRIMARY KEY,
    sesion_id          INT       NOT NULL
        REFERENCES bitacora.sesion_activa(sesion_id),
    bitacora_id        INT       NOT NULL
        REFERENCES lov_bit.bitacora(bitacora_id),
    abierta_en         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    finalizada_en      DATETIME2 NULL,
    CONSTRAINT UQ_sesion_bitacora UNIQUE (sesion_id, bitacora_id)
);

-- Índice filtrado: acelera lookups del sweeper F4 y de "¿quién está en qué bitácora?".
CREATE INDEX IX_sesion_bit_finalizada
    ON bitacora.sesion_bitacora(finalizada_en)
    WHERE finalizada_en IS NULL;
```

**Invariantes:**

- Una sola fila por par `(sesion_id, bitacora_id)` — el UNIQUE garantiza que reabrir la misma bitácora con la misma sesión no duplica filas; el MERGE actualiza `finalizada_en = NULL` y refresca `abierta_en`.
- `finalizada_en IS NULL` = participación viva. El listado de "ingenieros con bitácora X abierta para planta Y" filtra por este predicado (ver `server/server.js` `GET /api/sala-de-mando/ingenieros-en-bitacora`).
- El sweeper de turno (`server/utils/turno-sweeper.js`) cierra todas las `sesion_bitacora` activas cuya `sesion_activa.turno` ya terminó (ventana de 12 h, ver §7.5), en transacción por sesión + emisión de CIET de finalización.

**Endpoints relevantes:**

- `POST /api/sala-de-mando/abrir-bitacora`: UPSERT del par (sesion, bitácora).
- `POST /api/sala-de-mando/finalizar-bitacora`: marca `finalizada_en = SYSUTCDATETIME()` para la bitácora actual del usuario.
- `POST /api/sala-de-mando/finalizar-turno`: finaliza **todas** las bitácoras del usuario logueado (no solo del login actual: si el usuario rotó por varias sesiones, las cierra todas).

---

### 4.7 `conformacion_turno` — snapshot histórico por turno-planta

Tabla snapshot inmutable que captura, al cierre de cada turno (T1/T2 por planta GEC3/GEC32), una fila por usuario que participó. Cierra el objetivo de negocio del módulo (registro auditable de quién operó en cada turno).

```sql
-- Q1+Q2 conformacion-turno-2026-05: una fila por (fecha_operativa, planta_id, turno, usuario_id).
-- Agregada (re-logins del mismo usuario en el mismo turno colapsan). Inmutable post-snapshot.
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
    snapshot_en      DATETIME2     NOT NULL CONSTRAINT DF_conformacion_snapshot_en  DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_conformacion_turno PRIMARY KEY (fecha_operativa, planta_id, turno, usuario_id)
);

CREATE INDEX IX_conformacion_turno_lookup
    ON bitacora.conformacion_turno(planta_id, fecha_operativa, turno)
    INCLUDE (usuario_id, usuario_nombre, cargo_nombre);

-- Columnas Bogotá calculadas (F22.D2) — virtuales, costo cero al INSERT.
ALTER TABLE bitacora.conformacion_turno ADD inicio_sesion_bogota AS DATEADD(HOUR, -5, inicio_sesion);
ALTER TABLE bitacora.conformacion_turno ADD fin_sesion_bogota    AS DATEADD(HOUR, -5, fin_sesion);
ALTER TABLE bitacora.conformacion_turno ADD snapshot_en_bogota   AS DATEADD(HOUR, -5, snapshot_en);
```

**Semántica y reglas de poblado:**

- **`fecha_operativa`** = fecha Bogotá del **inicio** del turno. Para T2 (que cruza medianoche) se usa el día del inicio (18:00 Bogotá), no el del fin (05:59 del día siguiente).
- **Filtro del builder** (`server/utils/conformacion-snapshot.js::buildConformacionSnapshot`): una sesión cuenta para el turno X si `sa.inicio_sesion BETWEEN ventana_inicio AND ventana_fin` del turno X (intervalo medio-abierto). Derivación: el modelo `sesion_activa.turno` se fija al login (D-003), por lo que "ser del turno X" = "haber arrancado en la ventana de X". El intento inicial de filtrar por solape produjo duraciones absurdas en BD productiva (jefes con sesiones eternas + sesiones limbo).
- **`fin_sesion`**:
  - Logout explícito → `cerrada_en` directo, `fin_inferido=0`.
  - Sin logout (sweeper cierra `sesion_bitacora` pero D-003 deja `sesion_activa.activa=1`) → `fin_efectivo = ventana_fin`, `fin_inferido=1`.
- **`duracion_min`** = `SUM(DATEDIFF(MINUTE, inicio_efectivo, fin_efectivo))` agregando todos los logins del mismo usuario en el mismo turno.

**Trigger híbrido (Q3=d):**

1. **`server/utils/turno-sweeper.js` (F4)** extendido: tras finalizar `sesion_bitacora` por agotamiento del turno, recopila `(planta, turno, fecha_operativa)` únicos y dispara `buildConformacionSnapshot` + `persistConformacionSnapshot` en transacciones aisladas (try/catch por conformación; un fallo no rompe los demás ni el cierre ya commiteado).
2. **Catchup en `server/db.js::initDB()`** al arranque: detecta `(planta, turno, fecha_operativa)` de los últimos 7 días Bogotá sin snapshot, filtra "ventana ya cerró" en JS (`ventanaTurno().fin < now`), y persiste. Resiliencia ante crashes del server al cambio de turno.

PK natural rechaza duplicados → idempotente entre runs concurrentes y entre sweeper/catchup/trigger admin.

**Endpoints expuestos:**

- `GET /api/conformacion-turno?fecha=YYYY-MM-DD&turno=1|2&planta_id=GEC3|GEC32` — auth requerida, abierto a cualquier rol con sesión (`puedeVerConformacion`). Devuelve `{ fecha_operativa, planta_id, turno, filas: [...], total }` con columnas UTC + `*_bogota`.
- `POST /api/conformacion-turno/trigger` (body `{fecha_operativa, planta_id, turno}`) — gated por `puedeTriggerConformacion` (`puede_cerrar_turno=1` o `es_jefe_planta=1`). Por defecto rechaza turnos cuya ventana no cerró (400); `?force=true` permite bypass para QA y recovery (response incluye `force: true`). Idempotente; response incluye `insertadas`, `skipped`, `disparado_por` para audit.

**Inmutabilidad:** las filas NO se actualizan post-INSERT. Si un usuario revierte un logout o el sweeper se re-ejecuta sobre el mismo turno, la PK rechaza y el conteo de `skipped` aumenta.

**Cross-ref:** ADR [[D-025]] documenta la decisión completa, incluido el pivot del filtro del builder. La columna `fin_inferido` se mantiene contra la Q5 pura (que era "sin columna extra") porque cuesta 1 byte y deja auditoría disponible sin migración futura.

---

### 4.8 `disponibilidad_estado` — máquina de estados DISP (D-026)

Tabla dedicada para la bitácora DISP (Disponibilidad). Hasta v1.6, DISP vivía en `registro_activo`/`registro_historico` con los datos clave (`evento`, `codigo`, `fecha_inicio_estado`) embebidos en `campos_extra` JSON — eso obligaba ~10 excepciones documentadas en §7.8. **D-026 (v1.7)** mueve DISP a ER nativo: una sola tabla con columnas tipadas, sin doble escritura, sin filtered index DISP-only sobre tablas genéricas, sin vista intermedia `v_disp_intervalos`.

```sql
CREATE TABLE bitacora.disponibilidad_estado (
    disponibilidad_id            INT IDENTITY(1,1) PRIMARY KEY,
    planta_id                    VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
    estado                       VARCHAR(20)   NOT NULL
        CONSTRAINT CK_disp_estado_evento
        CHECK (estado IN ('En Servicio','En Reserva','Indisponible','Mantenimiento')),
    codigo                       SMALLINT      NOT NULL CHECK (codigo IN (-1, 0, 1)),
    fecha_inicio_estado          DATETIME2     NOT NULL,
    fecha_fin_estado             DATETIME2     NULL,          -- NULL = vigente; no-NULL = cerrado
    detalle                      NVARCHAR(MAX) NULL,
    jdts_snapshot                NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    jefes_planta_snapshot        NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    gerentes_produccion_snapshot NVARCHAR(MAX) NOT NULL DEFAULT '[]',   -- nuevo en D-026
    ingenieros_snapshot          NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    creado_por                   INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
    creado_en                    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    modificado_por               INT           NULL REFERENCES lov_bit.usuario(usuario_id),
    modificado_en                DATETIME2     NULL
);

-- 1 vigente por planta (segunda barrera al UPDLOCK del POST).
CREATE UNIQUE INDEX UQ_disp_estado_vigente_por_planta
    ON bitacora.disponibilidad_estado(planta_id)
    WHERE fecha_fin_estado IS NULL;

-- Lookup por planta ordenado DESC (historial paginado, último cerrado).
CREATE INDEX IX_disp_estado_planta_inicio
    ON bitacora.disponibilidad_estado(planta_id, fecha_inicio_estado DESC);

-- Columnas Bogotá calculadas (F22.D1 idem). No persistidas; costo cero al INSERT.
ALTER TABLE bitacora.disponibilidad_estado
    ADD fecha_inicio_estado_bogota AS DATEADD(HOUR, -5, fecha_inicio_estado);
ALTER TABLE bitacora.disponibilidad_estado
    ADD fecha_fin_estado_bogota    AS DATEADD(HOUR, -5, fecha_fin_estado);
ALTER TABLE bitacora.disponibilidad_estado
    ADD creado_en_bogota           AS DATEADD(HOUR, -5, creado_en);
ALTER TABLE bitacora.disponibilidad_estado
    ADD modificado_en_bogota       AS DATEADD(HOUR, -5, modificado_en);
```

**Vista derivada de acumulados (window functions):**

```sql
CREATE VIEW bitacora.v_disponibilidad_estado AS
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
    estado, detalle,
    fecha_inicio_estado                                                      AS fecha,
    fecha_fin_estado,
    creado_en                                                                AS fecha_creacion,
    SUM(CASE WHEN estado='En Servicio'   THEN horas_intervalo ELSE 0 END)
        OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)              AS horas_en_servicio,
    SUM(CASE WHEN estado='Indisponible'  THEN horas_intervalo ELSE 0 END)
        OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)              AS horas_en_indisponible,
    SUM(CASE WHEN estado='Mantenimiento' THEN horas_intervalo ELSE 0 END)
        OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)              AS horas_en_mantenimiento,
    SUM(CASE WHEN estado='En Reserva'    THEN horas_intervalo ELSE 0 END)
        OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)              AS horas_en_reserva,
    jefes_planta_snapshot, gerentes_produccion_snapshot,
    jdts_snapshot, ingenieros_snapshot,
    creado_por, modificado_por, modificado_en
FROM base;
```

El vigente (sin `fecha_fin_estado`) se trunca a `SYSUTCDATETIME()` al calcular `horas_intervalo` — los consumidores que necesiten conocer el reloj usado deben leer el endpoint `/api/disponibilidad/metricas` que devuelve `ahora` explícito.

**Invariantes:**

- **1 vigente por planta** garantizado por `UQ_disp_estado_vigente_por_planta` (filtered unique). El POST agarra `UPDLOCK+HOLDLOCK` sobre el row vigente como serialización defensiva en concurrencia.
- **No estados consecutivos iguales**: validado en backend (POST → 409 `mismo_estado`; PUT → 409 `mismo_estado_que_anterior` mirando el último cerrado N-1).
- **Cronología sin gap**: cuando un POST cierra el vigente, `fecha_fin_estado` del cerrado = `fecha_inicio_estado` del nuevo (regla preservada de D-011). PUT que cambia `fecha_inicio_estado` del vigente actualiza `N-1.fecha_fin_estado` para mantener el invariante.
- **Inmutabilidad post-cierre**: solo el vigente (`fecha_fin_estado IS NULL`) es editable vía PUT. Los cerrados son immutables (excepto el side-effect cronológico D-011 sobre `fecha_fin_estado`).

**Flujos transaccionales (sin doble escritura):**

1. **POST /api/registros** (rama DISP) — RF-055. `findVigente` → si hay y estado distinto, `cerrarVigente` (UPDATE `fecha_fin_estado`); snapshots; `insertNuevoEstado` (INSERT con OUTPUT INSERTED.*). Devuelve `{ registro, vigente_anterior_movido_id }` con `registro.registro_id = disponibilidad_id` y `campos_extra` reconstruido como JSON string para compat con el shape legacy del frontend.
2. **PUT /api/registros/:id** (rama DISP) — RF-056. Peek a `disponibilidad_estado` por id; si match → `actualizarVigente` (UPDATE en sitio). Si `fecha_inicio_estado` cambió, `cerrarVigente` del N-1 con la nueva fecha (cronología sin gap, D-011).
3. **POST /api/disponibilidad/deshacer** — RF-057. `findVigente` → `eliminarPorId` (DELETE físico); `findUltimoCerrado` → `restaurarComoVigente` (UPDATE `fecha_fin_estado=NULL`). El row del N-1 NO se mueve entre tablas; vuelve a vigente in-place. Si no hay N-1, la planta queda sin vigente (la vista compat §5.2 devuelve 0 filas — empty state).

**Migración idempotente (F26.A1):**

`db.js::initDB()` ejecuta el bloque F26.A1 una sola vez (gateado por flag en `bitacora.migracion_aplicada`). Dentro de una transacción única: crea la tabla + índices + columnas Bogotá + vista `v_disponibilidad_estado`, hace backfill desde `registro_activo` ∪ `registro_historico` (mapea `JSON_VALUE(campos_extra,'$.evento') → estado`, `CAST(... AS SMALLINT) → codigo`, `fecha_evento → fecha_inicio_estado`), valida conteo de origen vs. destino con `THROW 50001` si no coincide, hace DELETE de rows DISP en `registro_activo`/`registro_historico`, dropea `UQ_disp_vigente_por_planta` y `v_disp_intervalos` y la vieja `disponibilidad_dashboard` (tabla), crea la vista compat `disponibilidad_dashboard` (§5.2), inserta el flag F26.A1. Ante cualquier fallo: rollback completo → flag no se setea → próximo arranque reintenta. Bloques previos que tocaban `disponibilidad_dashboard` como tabla (F12.A7, D-024, F22.D1) se gatearon con `IF EXISTS sys.tables` para no fallar tras la migración.

**Cross-ref:** ADR [[D-026]] documenta la decisión completa. §5.2 describe la vista compat para cross-repo. §7.8 queda como referencia histórica de las invariantes que DISP rompía pre-D-026.

---

### 4.9 `consumo_combustible` — Consumos long-format + vista pivot (D-027)

Tabla transaccional del módulo Consumos de Combustibles. Storage en formato **long**: 1 fila por celda `(planta, fecha, periodo, combustible)` — soporta el catálogo asimétrico de §2.7 (GEC3 tiene 8 combustibles, GEC32 tiene 10) sin columnas fijas por planta. La presentación wide (24 periodos × N combustibles) se construye en el frontend o vía la vista `v_consumo_periodo` de abajo.

```sql
CREATE TABLE bitacora.consumo_combustible (
    consumo_id       INT IDENTITY(1,1) PRIMARY KEY,
    planta_id        VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id),
    fecha            DATE          NOT NULL,
    periodo          TINYINT       NOT NULL
        CONSTRAINT CK_consumo_periodo CHECK (periodo BETWEEN 1 AND 24),
    combustible_id   INT           NOT NULL REFERENCES lov_bit.combustible(combustible_id),
    cantidad         DECIMAL(12,3) NOT NULL
        CONSTRAINT CK_consumo_cantidad CHECK (cantidad >= 0),
    detalle          NVARCHAR(MAX) NULL,
    creado_por       INT           NOT NULL REFERENCES lov_bit.usuario(usuario_id),
    creado_en        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    modificado_por   INT           NULL REFERENCES lov_bit.usuario(usuario_id),
    modificado_en    DATETIME2     NULL,
    CONSTRAINT UQ_consumo_planta_fecha_periodo_combustible
        UNIQUE (planta_id, fecha, periodo, combustible_id)
);

CREATE INDEX IX_consumo_planta_fecha
    ON bitacora.consumo_combustible(planta_id, fecha DESC, periodo);

-- Columnas Bogotá calculadas (patrón F22, idempotente):
ALTER TABLE bitacora.consumo_combustible
    ADD creado_en_bogota     AS DATEADD(HOUR, -5, creado_en);
ALTER TABLE bitacora.consumo_combustible
    ADD modificado_en_bogota AS DATEADD(HOUR, -5, modificado_en);
```

**Vista pivot por periodo** — agrega los N combustibles de la planta a un row por (planta, fecha, periodo) y deriva los acumulados semánticos:

```sql
CREATE VIEW bitacora.v_consumo_periodo AS
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

**Invariantes:**

- **UQ compuesto `(planta_id, fecha, periodo, combustible_id)`** garantiza una sola celda por intersección — el endpoint POST hace lookup→UPDATE/INSERT/DELETE en lugar de re-INSERT.
- **`cantidad >= 0`** (CHECK constraint); el handler trata `cantidad=null` o `cantidad=0` como "celda vacía" y DELETE-ea la fila si existía.
- **Ventana de fechas**: hoy o pasado en TZ Bogotá. Futuro rechazado con `400 fecha_futura` por el handler (`fechaBogotaStr(new Date())` para el corte canónico).
- **`modificado_por` paridad D-019**: el UPDATE solo setea `modificado_por`/`modificado_en` si `cantidad` cambió. Cambios solo de `detalle` actualizan la fila pero NO el audit trail (no es una modificación operativa). Cross-ref [[D-019]] (MAND).

**Flujo del POST batch** (endpoint `POST /api/combustibles/consumos`):

1. Validar permiso `puede_crear` en bitácora COMB. 403 si no.
2. Validar `planta_id ∈ {GEC3, GEC32}`, `fecha` formato `YYYY-MM-DD`, `fecha <= hoyBogota`, `celdas: Array`.
3. Pre-load del catálogo activo de la planta. Validar cada celda: `periodo ∈ [1,24]`, `combustible_id ∈ catálogo`, `cantidad >= 0` o null/0.
4. Si hay errores estructurados → `400 { errores: [{periodo, combustible_id, motivo}] }` sin ejecutar nada.
5. Transacción única: por celda, lookup por UQ → si `cantidad` vacío y existe ⇒ DELETE (`eliminados++`); si nuevo ⇒ INSERT (`creados++`); si existe y `cantidad` cambió ⇒ UPDATE + setear `modificado_por` (`actualizados++`); si solo cambió `detalle` ⇒ UPDATE detalle sin tocar audit (`actualizados++`); si idéntico ⇒ no-op.
6. Response `200 { resumen: { creados, actualizados, eliminados } }`.

**Migración idempotente (F26.B1):**

`db.js::initDB()` ejecuta el bloque F26.B1 una sola vez (gateado por flag en `bitacora.migracion_aplicada`). Dentro de una transacción única: crea `lov_bit.combustible` + índice + UQ, MERGE de 18 seeds del catálogo, crea `bitacora.consumo_combustible` + índice + columnas Bogotá, crea `v_consumo_periodo`, INSERT IF NOT EXISTS de la fila `COMB` en `lov_bit.bitacora`, seed one-shot de permisos en `cargo_bitacora_permiso` (Operador Carbón y Caliza + JdT crean; resto ven), validación de conteo (`THROW` si <18), INSERT flag F26.B1. Ortogonal a F26.A1 (DISP). La matriz canónica de §2.6 se extendió con CASE clauses para `b.codigo='COMB'` → los permisos persisten en restarts subsecuentes vía el rebuild de matriz, sin depender del flag F26.B1.

**Cross-ref:** ADR [[D-027]] documenta la decisión completa. §2.7 detalla el catálogo. Paridad de `modificado_por` con [[D-019]] (MAND).

---

## 5. Integración con el Dashboard (esquema `bitacora`)

El esquema expone dos tablas-puente independientes hacia el Dashboard de Generación:

- **5.1 `evento_dashboard`** — eventos por hora/periodo (AUTH, REDESP, PRUEBA) emitidos desde MAND. Reemplaza la tabla v1.0 `autorizacion_dashboard` (renombrada en F5; vista compat `autorizacion_dashboard` sigue creándose idempotentemente en `initDB()` — F9 planeaba eliminarla pero el bloque DROP+CREATE quedó vivo. Sin consumidores activos al 2026-05-18).
- **5.2 `disponibilidad_dashboard`** (F12) — estado vigente por planta (DISP). Separada deliberadamente: DISP no tiene periodo ni semántica horaria.

### 5.1 `evento_dashboard` (eventos por periodo, MAND)

Las autorizaciones son registros de la bitácora AUTH que disparan automáticamente una fila en esta tabla. El Dashboard la consume vía REST para suprimir la desviación en periodos autorizados.

```sql
-- Tabla puente: Bitácora (MAND + AUTH histórica) -> Dashboard de Generación.
-- Se INSERT/UPSERT al crear o editar un registro cuyo tipo_evento tenga
-- notificar_dashboard_tipo != NULL (F6). El `tipo` AUTH/REDESP/PRUEBA viaja en
-- la fila — múltiples tipos pueden coexistir para la misma (planta, fecha, periodo).
-- Dashboard: GET /api/eventos-dashboard?planta_id=GEC32&fecha=2026-04-13
CREATE TABLE bitacora.evento_dashboard (
    evento_id           INT           IDENTITY(1,1) PRIMARY KEY,
    registro_origen_id  INT           NOT NULL,
    planta_id           VARCHAR(10)   NOT NULL
        REFERENCES lov_bit.planta(planta_id),
    fecha               DATE          NOT NULL,
    periodo             TINYINT       NOT NULL
        CHECK (periodo BETWEEN 1 AND 24),
    valor_mw            FLOAT         NOT NULL,

    jdts_snapshot       NVARCHAR(MAX) NOT NULL,   -- JSON array
    jefes_snapshot      NVARCHAR(MAX) NOT NULL,   -- JSON array

    tipo                VARCHAR(10)   NOT NULL DEFAULT 'AUTH'
        CHECK (tipo IN ('AUTH','REDESP','PRUEBA')),
    activa              BIT           NOT NULL DEFAULT 1,
    creado_en           DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_evento_planta_fecha_periodo_tipo
        UNIQUE (planta_id, fecha, periodo, tipo)
);

CREATE INDEX IX_evento_lookup
    ON bitacora.evento_dashboard(planta_id, fecha, activa);
```

**Historia del nombre:** la tabla se llamó `autorizacion_dashboard` con columnas `autorizacion_id` y `valor_autorizado_mw` hasta F5 (2026), que la renombró a `evento_dashboard` y agregó la columna `tipo` para soportar REDESP y PRUEBA además de AUTH. El `UNIQUE` viejo de 3 columnas se reemplazó por uno de 4 que incluye `tipo` (deploys con UQ_auth_planta_fecha_periodo lo migran idempotente en `initDB()`).

**Flujo:**

1. El JdT (vía MAND batch save o AUTH manual) crea un registro cuyo `tipo_evento.notificar_dashboard_tipo` != NULL.
2. El backend genera los snapshots y resuelve el `tipo` desde la fila del `tipo_evento` (no del JSON de la bitácora — F6).
3. Se ejecuta `upsertEventoDashboard` (`server/utils/notificador.js`): INSERT nuevo o, si existe una fila con `activa=0` para `(planta_id, fecha, periodo, tipo)`, UPDATE reactivándola con el nuevo valor.
4. El Dashboard consulta `/api/eventos-dashboard` y suprime la alerta de desviación para ese periodo.

El Dashboard debe **parsear `jdts_snapshot` y `jefes_snapshot` como JSON**: ya no son `INT` como en versiones previas del modelo.

**Vista compat `bitacora.autorizacion_dashboard` (deuda viva):**

Para preservar el shape legacy (`autorizacion_id`, `valor_autorizado_mw`) de consumidores anteriores a F5, `initDB()` recrea idempotentemente una **vista** filtrada por `tipo='AUTH'`:

```sql
CREATE VIEW bitacora.autorizacion_dashboard AS
  SELECT evento_id AS autorizacion_id, registro_origen_id, planta_id, fecha, periodo,
         valor_mw AS valor_autorizado_mw, jdts_snapshot, jefes_snapshot, activa, creado_en
  FROM bitacora.evento_dashboard
  WHERE tipo = 'AUTH';
```

**Estado real al 2026-05-18:** la vista sigue creándose en cada arranque (`server/db.js`) pero **ningún consumidor activo la usa** — el Dashboard ya consume `/api/eventos-dashboard`. F9 originalmente planeaba eliminarla; el bloque DROP+CREATE quedó en el código. Pendiente: borrar el bloque o ratificarla como contrato externo si algún tercero la lee.

### 5.2 `disponibilidad_dashboard` (vista — estado vigente por planta, DISP)

Cimiento cross-app para que F15 (futuro) muestre un badge de disponibilidad por planta en `dashboard-gen-gec3`. **Una fila por planta** con el estado vigente.

> **Cambio v1.7 (D-026):** `disponibilidad_dashboard` ahora es una VIEW sobre `bitacora.disponibilidad_estado` (§4.8), no una tabla puente. El shape se preserva byte-a-byte para no romper el endpoint cross-repo `GET /api/eventos-dashboard?tipo=DISP` (F15 pendiente). Cualquier consumidor SQL directo (no hay ninguno hoy) sigue funcionando — la vista mapea `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot`, y deriva `actualizado_en` como `COALESCE(modificado_en, creado_en)`. Filtra implícitamente `fecha_fin_estado IS NULL` (solo vigentes). El DDL de la tabla original queda como referencia histórica más abajo.

```sql
CREATE TABLE bitacora.disponibilidad_dashboard (
  planta_id              VARCHAR(10) PRIMARY KEY
      REFERENCES lov_bit.planta(planta_id),
  evento                 VARCHAR(20) NOT NULL
      CONSTRAINT CK_disp_dashboard_evento
      CHECK (evento IN ('En Servicio','En Reserva','Indisponible','Mantenimiento')),
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
- `codigo` deriva del `evento` con la regla fija `'En Servicio':1 / 'En Reserva':0 / Indisponible:-1 / Mantenimiento:-1` (ver D-024). `Indisponible` y `Mantenimiento` **comparten `codigo=-1`**: el código numérico es la métrica agregable de "horas de indisponibilidad" (reporte XM); el discriminador semántico vive en el string `evento` (Indisponible = salida forzada; Mantenimiento = consignación / salida planeada).
- Migración idempotente en `initDB()` (db.js): si la BD trae el CHECK viejo, se dropa por nombre, se reemplazan los strings `'Disponible'` → `'En Servicio'` en la tabla y en `campos_extra` JSON de `registro_activo`/`registro_historico` con `JSON_MODIFY`, y se agrega el nuevo CHECK nombrado `CK_disp_dashboard_evento`.

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

### 6.1 Ingenieros en turno

```sql
-- Post-F9: sin filtro TTL. activa=1 es el único gate.
CREATE OR ALTER VIEW bitacora.v_ingenieros_en_turno AS
SELECT s.planta_id, s.turno, u.usuario_id, u.nombre_completo,
       c.nombre AS cargo, s.inicio_sesion, s.ultima_actividad
FROM bitacora.sesion_activa s
JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
JOIN lov_bit.cargo c   ON c.cargo_id   = s.cargo_id
WHERE s.activa = 1;
```

### 6.2 JdT actual por planta

```sql
-- Post-F9: sin filtro TTL. Cargo renombrado a "Ingeniero Jefe de Turno" en v2.
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
  AND s.cargo_id = (SELECT cargo_id FROM lov_bit.cargo
                     WHERE nombre = 'Ingeniero Jefe de Turno');
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

### 7.4 Modelo de sesión (post-F9)

- La sesión vive hasta que ocurra **una** de tres cosas: logout explícito, cierre por sweeper de turno (F4 — `turno-sweeper.js`), o reinicio del proceso (las filas quedan con `activa=1` huérfanas y se cierran manualmente).
- **No hay gate TTL.** El middleware solo verifica `activa=1`. El sweep TTL al arranque y el rechazo `401` por `ultima_actividad < -5min` fueron eliminados en F9.
- `ultima_actividad` se sigue refrescando con cada request autenticado y con un heartbeat de 60s a `POST /api/auth/heartbeat`, exclusivamente para **visibilidad operativa** (¿quién está activo ahora?).
- `cerrada_en` distingue logout explícito del cierre por sweeper: la migración F4 leerá esta columna en CIETs futuros.
- `POST /api/auth/resume` sigue existiendo para reanudar sesiones tras recarga de pestaña (F5 del navegador), pero ya no depende del TTL — basta que `activa=1`.
- **Limpieza operativa:** sesiones huérfanas se purgan con `cleanupTestRegistros` (helpers de test) o `UPDATE ... SET activa=0` manual. No hay job automático.

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

> **Nota v1.7 (D-026):** esta sección queda como referencia histórica de F12–F14. DISP ya NO rompe los invariantes listados — vive en su propia tabla `bitacora.disponibilidad_estado` (§4.8). El refactor preservó el contrato HTTP, por lo que el comportamiento observable de los endpoints, el frontend y el cross-repo no cambió. Las descripciones abajo (turno NULL, filtered index DISP-only, etc.) reflejan el modelo F12 original, no el modelo post-D-026.

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
- ~~Sweep TTL de sesiones (`db.js`) usa `SYSUTCDATETIME()` (post F19) — antes era `GETDATE()` con desfase si el SQL host no estaba en UTC.~~ _(Obsoleto: el sweep TTL fue eliminado en F9. Nota preservada para auditoría histórica.)_
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
| 1.5 | 2026-05-18 | Sincronización doc↔BD productiva tras auditoría de `INFORMATION_SCHEMA` + `sys.indexes` + `sys.foreign_keys`. **Catálogos:** `lov_bit.cargo.puede_cerrar_turno` agregado al DDL (estaba en §2.3.1 sin DDL); cargo "Jefe de Turno" renombrado a "Ingeniero Jefe de Turno" (migración v2). `lov_bit.usuario.username NOT NULL` con `UQ_usuario_username` (reemplaza email como identificador de login); `email` pasa a NULL; `password_hash` migra a bcrypt. `lov_bit.bitacora.oculta` (toggle de sidebar). `lov_bit.tipo_evento.notificar_dashboard_tipo VARCHAR(10) CHECK IN ('AUTH','REDESP','PRUEBA')` (F6) reemplaza al flag JSON `notificar_dashboard:true`. **Sesiones:** `bitacora.sesion_activa.cerrada_en` (F2). **Sweep TTL eliminado en F9** — el modelo post-F2 mantiene la sesión hasta logout o sweeper de turno; §3 y §7.4 actualizadas. **Nueva §4.6 `sesion_bitacora`** (F2 — DDL formal que estaba en código pero ausente del MD). **Registros:** `detalle` pasa a NULL en §4.1 y §4.2 (F3). **Dashboard:** §5.1 UQ corregido a 4 columnas `(planta_id, fecha, periodo, tipo)`; vista compat `autorizacion_dashboard` documentada como deuda viva (el doc v1.4 afirmaba que F9 la eliminó, pero `db.js` la recrea). |
| 1.6 | 2026-05-19 | Conformación de turno (D-025). **Nueva §4.7** con DDL de `bitacora.conformacion_turno` (PK compuesta, FKs a usuario/planta/cargo, índice de lookup, columnas `*_bogota` calculadas vía F22.D2). Trigger híbrido: `turno-sweeper.js` extendido + catchup en `initDB()` para los últimos 7 días Bogotá. Endpoints `GET /api/conformacion-turno` y `POST /api/conformacion-turno/trigger`. **Fix retro:** `POST /api/auth/logout` ahora pobla `sesion_activa.cerrada_en = SYSUTCDATETIME()` (era deuda F2 nunca cerrada). **Filtro semántico del builder:** una sesión cuenta para el turno X si arrancó dentro de la ventana de X (derivación de D-003). Cobertura backend: 14 tests dirigidos en `conformacion_turno.test.js`. |
| 1.7 | 2026-05-20 | Migración ER DISP (D-026). **Nueva §4.8** con DDL de `bitacora.disponibilidad_estado` (PK `disponibilidad_id`, columnas tipadas `estado`/`codigo`/`fecha_inicio_estado`/`fecha_fin_estado`, snapshot adicional `gerentes_produccion_snapshot`, filtered unique index `UQ_disp_estado_vigente_por_planta`, columnas Bogotá) + vista `v_disponibilidad_estado` (acumulados via window functions). §5.2 actualizada — `disponibilidad_dashboard` ahora es VIEW del vigente sobre la nueva tabla (preserva shape: `disponibilidad_id → registro_activo_id`, `jefes_planta_snapshot → jefes_snapshot`). §7.8 marcada como histórica. Vista `v_disp_intervalos` dropeada (las métricas suman `DATEDIFF_BIG` directo sobre la nueva tabla). Migración idempotente F26.A1 hace backfill + DELETE de rows DISP en `registro_activo`/`registro_historico`. Contratos HTTP y shape de response preservados (los tests existentes que validan via HTTP siguen verdes). |
| 1.8 | 2026-05-21 | Consumos de Combustibles (D-027). **Nueva §2.7** `lov_bit.combustible` (catálogo por planta, 18 seeds: 8 GEC3 + 10 GEC32 con tipos `ALIMENTADOR/CALIZA/ACPM`). **Nueva §4.9** `bitacora.consumo_combustible` (long-format transaccional, `cantidad DECIMAL(12,3)`, UQ compuesto, columnas Bogotá) + vista `v_consumo_periodo` (pivot con `total_carbon_ton = SUM(tipo='ALIMENTADOR')`, `caliza_ton`, `acpm_gal`). §2.4 gana fila `COMB` (formulario_especial=1, icono Flame). §2.6 matriz extendida con CASE para COMB. Permisos: `Operador de Planta - Carbón y Caliza` + JdT crean; resto ven. Migración idempotente F26.B1 (ortogonal a F26.A1). Endpoints `GET /api/combustibles/catalogo`, `GET /api/combustibles/consumos`, `POST /api/combustibles/consumos` (batch atómico, regla D-019 paridad `modificado_por` solo si cantidad cambió). Frontend bajo `src/components/Combustibles/` integrado a categoría jerárquica nueva "Combustibles". 12 tests en `consumos_combustible.test.js`. |

---

**FIN DEL MODELO**
