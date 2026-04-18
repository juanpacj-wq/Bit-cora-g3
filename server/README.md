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
| POST | `/api/auth/logout` | Marca sesión inactiva |
| POST | `/api/auth/heartbeat` | Actualiza `ultima_actividad` |
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
| GET | `/api/registros/activos?planta_id=&bitacora_id=&estado=` | Listar con filtros |
| POST | `/api/registros` | Crear (resuelve JdT/jefe, lógica especial AUTH) |
| PUT | `/api/registros/:id` | Editar (solo `estado='borrador'`) |
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

## Notas

- Todas las respuestas incluyen headers CORS.
- Queries parametrizados con `.input(name, sql.Tipo, value)`.
- `parseBody(req)` rechaza promesa en JSON malformado → capturado por try/catch global (500).
- Params de URL se extraen con regex.
