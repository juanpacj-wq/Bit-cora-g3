# Bitácoras Server

Backend Node.js (ESM, `http.createServer` nativo, sin frameworks) con SQL Server vía `mssql`.

## Instalación

```bash
cd server
npm install
```

Copia `.env.example` de la raíz a `.env` y completa las variables:

```
DB_HOST=           # usa backslash para named instances (HOST\INSTANCIA)
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_PORT=1433
SERVER_PORT=3002
```

## Scripts

```bash
npm run dev     # node --env-file=../.env --watch server.js
npm start       # node --env-file=../.env server.js
```

Al arrancar, `initDB()` crea esquemas, tablas, índices, vistas y datos semilla de forma idempotente.

## Endpoints

### Health
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Status y timestamp |

### Autenticación
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | Login con email/password |
| POST | `/api/auth/select-context` | Selecciona planta/cargo y crea sesión |
| POST | `/api/auth/resume` | Reactiva una sesión dentro del TTL (usada al reload) |
| POST | `/api/auth/heartbeat` | Actualiza `ultima_actividad` |
| POST | `/api/auth/logout` | Marca sesión inactiva (también invocado vía `sendBeacon` en `pagehide`) |
| GET | `/api/auth/sesiones-activas?planta_id=` | Sesiones activas por planta |

### Catálogos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/catalogos/plantas` | Plantas activas |
| GET | `/api/catalogos/cargos` | Todos los cargos |
| GET | `/api/catalogos/bitacoras` | Bitácoras activas con `definicion_campos` |
| GET | `/api/catalogos/bitacoras/:id/tipos-evento` | Tipos de evento de una bitácora |
| GET | `/api/catalogos/permisos/:cargo_id` | Permisos ver/crear por cargo |
| GET | `/api/catalogos/jdt-actual?planta_id=` | JdT con sesión activa, fallback a default |
| GET | `/api/catalogos/jefe` | Usuario con `es_jefe_planta=1` |

### Registros activos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/registros/activos?planta_id=&bitacora_id=&estado=` | Listar con filtros (incluye `ingenieros_snapshot`, `jdts_snapshot`, `jefes_snapshot`, `creado_por_nombre`) |
| POST | `/api/registros` | Crear (genera snapshots de rol, `creado_por = sesion.usuario_id`, lógica especial AUTH) |
| PUT | `/api/registros/:id` | Editar (solo `estado='borrador'`; los snapshots son inmutables) |
| DELETE | `/api/registros/:id` | Eliminar (solo borrador, soft-delete autorización asociada) |

### Cierre
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/cierre/bitacora` | Cierra una bitácora (transaccional) |
| POST | `/api/cierre/masivo` | Cierra todas las bitácoras de una planta |

### Históricos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/historicos?...&page=&limit=` | Búsqueda paginada con filtros |
| GET | `/api/historicos/:id` | Registro histórico específico |
| GET | `/api/historicos/resumen?planta_id=&fecha=` | Resumen por bitácora en una fecha |

### Autorizaciones (consumidas por Dashboard)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/autorizaciones?planta_id=&fecha=` | Autorizaciones activas |
| GET | `/api/autorizaciones/:planta_id/:fecha/:periodo` | Lookup específico |
| DELETE | `/api/autorizaciones/:id` | Soft-delete (`activa=0`) |

## Sesión y autenticación

- Header obligatorio `X-Sesion-Id: <sesion_id>` en cada request no-`skipAuth`.
- `middleware/auth.js::loadSession` valida contra `bitacora.sesion_activa` con TTL de 5 min sobre `ultima_actividad`; cada request autenticado bumpea el timestamp en fire-and-forget.
- `POST /api/auth/logout` marca `activa=0`; `POST /api/auth/resume` reactiva (`activa=1`, `ultima_actividad=GETDATE()`) si dentro del TTL.
- En arranque, `initDB()` barre sesiones huérfanas fuera del TTL.

## Snapshots de usuarios por rol

Desde 2026-04, los registros y autorizaciones guardan los roles presentes como JSON (no FK). Los helpers en `utils/snapshots.js` resuelven la lista de `{usuario_id, nombre_completo}` mirando `sesion_activa.activa=1` con filtro TTL. El autor del registro queda en `creado_por INT FK`, único puntero vivo a `lov_bit.usuario`.

## Notas

- Todas las respuestas incluyen headers CORS (ver `utils/http.js`).
- Queries parametrizados con `.input(name, sql.Tipo, value)`. No hay interpolación de strings en SQL.
- `parseBody(req)` rechaza en JSON malformado → capturado por try/catch global (500).
- Params de URL se extraen con regex; el router es manual en `server.js` (sin Express).
- Dentro de transacciones `mssql` no lanzar queries en paralelo (`Promise.all`): serializar con `await`.
