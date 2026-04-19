# Bit-cora-g3

Módulo de **bitácoras operativas** de la planta termoeléctrica GECELCA 3. Reemplaza el registro manual en Excel por una aplicación web con trazabilidad, control de turnos y autorizaciones integradas al Dashboard de generación.

> Parte del monorepo **PORTAL GENERACIÓN**, que convive en el mismo servidor con `dashboard-gen-gec3/`. El acoplamiento entre ambos proyectos ocurre a través de la tabla `bitacora.autorizacion_dashboard` (contrato descrito abajo).

---

## Tabla de contenidos

1. [Qué hace](#qué-hace)
2. [Arquitectura](#arquitectura)
3. [Stack](#stack)
4. [Estructura del repositorio](#estructura-del-repositorio)
5. [Requisitos](#requisitos)
6. [Puesta en marcha](#puesta-en-marcha)
7. [Configuración](#configuración)
8. [Modelo de sesión y autenticación](#modelo-de-sesión-y-autenticación)
9. [Referencia de API](#referencia-de-api)
10. [Base de datos](#base-de-datos)
11. [Integración con el Dashboard](#integración-con-el-dashboard)
12. [Testing](#testing)
13. [Documentación oficial](#documentación-oficial)
14. [Resolución de problemas](#resolución-de-problemas)

---

## Qué hace

- Registra eventos operativos por **bitácora** (DISP, OP, AUTH, AGUA, etc.) con tipo de evento, turno, detalle y campos dinámicos por bitácora.
- Gestiona **sesiones por planta + cargo**: al iniciar sesión el usuario elige contexto (planta, cargo) y durante esa sesión sus permisos quedan derivados de `cargo_bitacora_permiso`.
- Cierra turnos de forma transaccional (activos → históricos) con verificación de completitud.
- Escribe **autorizaciones horarias de despacho** (bitácora AUTH) en una tabla que consume el Dashboard de generación para validar márgenes de MW.
- Guarda **snapshots JSON** de JdTs, Jefes e Ingenieros presentes al momento del registro para trazabilidad histórica (ver [Base de datos](#base-de-datos)).

## Arquitectura

```
┌───────────────┐      HTTP /api/*      ┌────────────────┐      MSSQL     ┌────────────────┐
│   Frontend    │ ────────────────────▶ │    Backend     │ ─────────────▶ │  SQL Server    │
│ React 19+Vite │ ◀──────────────────── │  Node http +   │ ◀───────────── │   PortalG3     │
│  (port 5173)  │   X-Sesion-Id header  │  mssql (3002)  │                │ schemas:       │
└───────────────┘                       └────────────────┘                │  lov_bit       │
                                                                          │  bitacora      │
                                                                          └────────────────┘
```

- **Frontend** ([`src/`](src/)): SPA React con hooks de dominio (`useAuth`, `useCatalogos`, `useRegistros`, `useCierre`, `useHistoricos`). Un único componente `BitacorasGecelca3.jsx` orquesta el UI.
- **Backend** ([`server/`](server/)): Node ESM con `http.createServer` nativo (sin Express) y `mssql`. `server.js` enruta a mano y delega en `utils/` y `middleware/`.
- **Base de datos**: SQL Server. `db.js::initDB()` crea y migra esquema de forma **idempotente** al arrancar (tablas, índices, vistas y seed).

## Stack

| Capa | Tecnología |
|---|---|
| UI | React 19, Vite 5, TailwindCSS 3, lucide-react |
| Backend | Node.js ≥ 20 (ESM, `--env-file`, `--test`), `mssql` 11, `ws` |
| BD | SQL Server (soporta instancias nombradas: `HOST\INSTANCIA`) |
| Build | `vite build` (frontend), `node` directo (backend, sin bundler) |

## Estructura del repositorio

```
Bit-cora-g3/
├── src/                          # Frontend (Vite)
│   ├── BitacorasGecelca3.jsx     # Componente raíz
│   ├── main.jsx                  # Entry + React.StrictMode
│   ├── index.css                 # Tailwind
│   └── hooks/
│       ├── useApi.js             # fetch wrapper + X-Sesion-Id + 401 handler
│       ├── useAuth.js            # login/logout, TTL, heartbeat, resume, authReady
│       ├── useCatalogos.js       # plantas/cargos/bitacoras/permisos (gated por ready)
│       ├── useRegistros.js       # CRUD de registro_activo
│       ├── useCierre.js          # cerrar bitácora / cierre masivo
│       └── useHistoricos.js      # búsqueda paginada sobre registro_historico
├── server/                       # Backend Node
│   ├── server.js                 # Router HTTP + endpoints
│   ├── db.js                     # initDB idempotente (DDL, seed, migraciones)
│   ├── middleware/
│   │   ├── auth.js               # loadSession (TTL + bump ultima_actividad)
│   │   └── permissions.js        # verificación puede_ver / puede_crear
│   ├── utils/
│   │   ├── http.js               # parseBody, sendJSON, CORS
│   │   ├── snapshots.js          # snapshotJDTs / Jefes / Ingenieros (JSON)
│   │   ├── notificador.js        # upsertAutorizacion (AUTH → dashboard)
│   │   ├── campos.js             # validación de campos_extra por bitácora
│   │   └── turno.js              # cálculo de turno por hora
│   └── tests/                    # node:test smoke tests
│       ├── helpers.js            # setup/cleanup, usuarios y sesiones de prueba
│       ├── auth_middleware.test.js
│       └── auth_reactivate.test.js
├── BIT-MODBD-2026-001.docx       # Modelo de BD (fuente de verdad)
├── BIT-RF-2026-001.docx          # Requerimientos funcionales RF-001..RF-053
├── vite.config.js                # Proxy /api → localhost:3002
└── README.md                     # Este archivo
```

## Requisitos

- **Node.js ≥ 20** (se usa `node --env-file` y `--test`, ambas funciones nativas a partir de 20.6).
- **SQL Server** accesible (local o red). Se soportan instancias nombradas.
- **npm** (viene con Node).

## Puesta en marcha

Tres terminales (la tercera solo para tests).

### 1. Clonar e instalar dependencias

```bash
cd Bit-cora-g3
npm install
cd server && npm install && cd ..
```

### 2. Configurar `.env`

El archivo `.env` vive en la **raíz del monorepo** (`PORTAL GENERACIÓN/.env`). Ambos `npm start` y `npm test` del backend lo cargan vía `--env-file=../.env`. Copiá `.env.example` como base y ajustá valores. **Nunca comprometer credenciales productivas.**

### 3. Backend

```bash
cd server
npm run dev     # watch mode (recarga al editar)
# o
npm start       # arranque simple
```

Expone `http://localhost:3002`. Al primer arranque, `initDB()` crea esquemas, tablas, vistas, índices y seed.

### 4. Frontend

```bash
cd Bit-cora-g3
npm run dev
```

Vite sirve en `http://localhost:5173` y proxy `/api/*` → `localhost:3002` (definido en `vite.config.js`), por lo que el cliente nunca enfrenta CORS en desarrollo.

### 5. Build de producción

```bash
npm run build       # en Bit-cora-g3/: genera dist/
```

Servir `dist/` tras un reverse-proxy (p. ej. Nginx) y exponer `server/` en un socket/puerto interno es el patrón de deploy previsto.

## Configuración

Variables consumidas en tiempo de ejecución (ver `.env.example`):

| Variable | Descripción |
|---|---|
| `DB_HOST` | Host o `HOST\INSTANCIA` para instancia nombrada de SQL Server |
| `DB_NAME` | Base de datos (por convención `PortalG3`) |
| `DB_USER` / `DB_PASSWORD` | Credenciales SQL |
| `DB_PORT` | Puerto SQL Server (default 1433) |
| `SERVER_PORT` | Puerto HTTP del backend (default 3002) |

## Modelo de sesión y autenticación

El cliente envía `X-Sesion-Id: <sesion_id>` en cada request. El middleware [`server/middleware/auth.js`](server/middleware/auth.js) valida la sesión contra `bitacora.sesion_activa` aplicando:

- **TTL de 5 minutos** sobre `ultima_actividad`: sesiones ociosas se rechazan (401) aunque `activa=1`.
- **Fire-and-forget bump**: cada request autenticado refresca `ultima_actividad = GETDATE()`.

En el cliente, [`src/hooks/useAuth.js`](src/hooks/useAuth.js) implementa:

| Evento | Acción |
|---|---|
| Heartbeat cada 60 s | `POST /api/auth/heartbeat` — evita expiración por ociosidad |
| `pagehide` (cerrar pestaña o recargar) | `navigator.sendBeacon('/api/auth/logout', …)` — marca `activa=0` en el servidor |
| Montaje tras recarga | `POST /api/auth/resume` — reactiva si la sesión está dentro del TTL |
| Fallo del resume | Limpia `sessionStorage` y fuerza login |

**Reload vs cierre de pestaña:** ambos disparan el beacon. La distinción la hace el navegador al cargar la siguiente página — en un reload el cliente monta de nuevo y llama a `/api/auth/resume`; en un cierre, no hay cliente que reanude y la sesión queda cerrada.

**`authReady` gate:** `useAuth` expone `ready` (false hasta que el mount effect resuelve). `useCatalogos` y el render principal se gatean en `ready`; esto evita que requests tempranas salgan antes de que `resume` termine, previniendo una carrera donde el beacon dejaba `activa=0` momentáneamente y las llamadas paralelas recibían 401 → logout en cadena.

**Storage sync:** el effect que persiste `{user, sesion}` a `sessionStorage` **solo escribe, nunca borra**. Limpiar el storage es responsabilidad explícita de `logout()` y del catch de `resume`. Esta invariante es crítica: con `React.StrictMode` los efectos se montan dos veces y un `removeItem` sin guarda wipeaba la sesión entre montajes.

**Sweep de arranque:** `initDB()` cierra (`activa=0`) sesiones huérfanas cuyo `ultima_actividad` esté fuera del TTL. Previene acumulación de filas muertas tras caídas del proceso.

## Referencia de API

Detalle completo y tabla de endpoints en [`server/README.md`](server/README.md). Resumen:

| Dominio | Prefijo |
|---|---|
| Salud | `GET /health` |
| Auth | `POST /api/auth/{login,select-context,logout,heartbeat,resume}` |
| Catálogos | `GET /api/catalogos/*` |
| Registros activos | `GET/POST/PUT/DELETE /api/registros*` |
| Cierre | `POST /api/cierre/{bitacora,masivo}` |
| Históricos | `GET /api/historicos*` |
| Autorizaciones (consumo Dashboard) | `GET /api/autorizaciones*`, `DELETE /api/autorizaciones/:id` |

## Base de datos

Dos esquemas en la misma DB `PortalG3`:

- **`lov_bit`** — catálogos maestros (usuarios, cargos, plantas, bitácoras, tipos de evento, permisos por cargo×bitácora).
- **`bitacora`** — transaccional (registro_activo, registro_historico, sesion_activa, autorizacion_dashboard).

### Snapshots de usuarios por rol (convención vigente desde 2026-04)

En `registro_activo`, `registro_historico` y `autorizacion_dashboard`, los antiguos FKs de rol (`ingeniero_id`, `jdt_turno_id`, `jefe_id`, `jdt_id`) fueron reemplazados por columnas JSON `NVARCHAR(MAX) NOT NULL`:

| Columna | Shape |
|---|---|
| `ingenieros_snapshot` | `[{"usuario_id":N,"nombre_completo":"…"}, …]` |
| `jdts_snapshot` | ídem |
| `jefes_snapshot` | ídem |

Nunca `NULL`: si no hay usuarios del rol, se guarda `"[]"`. Escritos una sola vez en el INSERT del registro; los cierres (`INSERT INTO registro_historico SELECT …`) copian los strings tal cual, sin re-cálculo.

**Único FK vivo a `lov_bit.usuario`** en estas tablas: `creado_por` (autor del registro = `sesion.usuario_id`). Este es el único identificador con integridad referencial.

Fuente de verdad del modelo completo: **`BIT-MODBD-2026-001.docx`** en la raíz del repo.

## Integración con el Dashboard

El único acoplamiento explícito con `dashboard-gen-gec3/` es la tabla `bitacora.autorizacion_dashboard`:

- **Escritura:** al crear un registro en la bitácora `AUTH`, `server.js` parsea `campos_extra` (`periodo`, `valor_autorizado_mw`) y `utils/notificador.js::upsertAutorizacion` inserta/reactiva la fila. `DELETE` del registro hace soft-delete (`activa=0`) de la autorización.
- **Lectura:** `GET /api/autorizaciones?planta_id=&fecha=` y `GET /api/autorizaciones/:planta_id/:fecha/:periodo`.
- **Consumo:** el dashboard debe parsear `jdts_snapshot` y `jefes_snapshot` como JSON (ya no son INT). Validar el consumidor antes de modificar el contrato.

## Testing

```bash
cd server
npm test
```

Corre `tests/auth_middleware.test.js` y `tests/auth_reactivate.test.js` usando `node --test` contra la base **real** (no hay mocks de DB). `tests/helpers.js::setupSessions` crea usuarios y sesiones de prueba deterministas vía `MERGE`; `cleanupTestRegistros` desactiva esas sesiones al final.

Convención: los registros de prueba incluyen el tag `[TEST-RUN-<timestamp>]` en `detalle` para poder identificarlos y limpiarlos con confianza.

## Documentación oficial

Los contratos autoritativos del módulo viven como `.docx` en la raíz:

- **`BIT-MODBD-2026-001.docx`** — Modelo de BD: DDL, seed, vistas, notas de diseño.
- **`BIT-RF-2026-001.docx`** — Requerimientos funcionales RF-001..RF-053, matriz RF↔tablas, 8 reglas de negocio (RN-01..RN-08) y criterios de aceptación.

Ante cualquier discrepancia entre código y estos documentos, cotejar primero con los `.docx`.

## Resolución de problemas

**El frontend me saca al login después de un F5.**
Verificá que el `useEffect` de storage en `useAuth.js` no tenga un `else sessionStorage.removeItem(...)`; debe escribir solamente. También confirmá que `useCatalogos` y cualquier otro hook nuevo estén gateados por `auth.ready` o por un dato post-auth.

**Se acumulan filas con `activa=1` en `sesion_activa`.**
Comprobá que el servidor esté arrancando (ejecuta el sweep de TTL en `initDB()`) y que el heartbeat del cliente esté corriendo (devtools → network cada 60 s). Los tests deberían limpiarse solos vía `cleanupTestRegistros`.

**Error `Can't acquire connection for the request. There is another request in progress.`**
En código dentro de una transacción `mssql` no se pueden disparar múltiples queries concurrentes. Secuencializar con `await` en serie en lugar de `Promise.all`.

**`initDB()` tarda o falla al arrancar.**
Suele ser una migración idempotente que no encuentra la DB esperada; revisar credenciales en `.env` y permisos del usuario SQL sobre `PortalG3` (debe poder crear esquemas y alterar tablas).
