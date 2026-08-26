# Auditoría técnica — Bit-cora-g3

**Fecha:** 2026-07-04
**Alcance:** repositorio, base de datos que lo alimenta, arquitectura y modelo entidad-relación, con **énfasis especial en la dinámica de turnos (T1 diurno / T2 nocturno)**.
**Fuentes primarias:** `server/db.js` (2280 líneas, DDL idempotente real), `BIT-MODBD-2026-001.md` (modelo autoritativo v2.0), `server/utils/turno*.js`, `server/routes/*`, `docs/architecture.md`, `docs/decisions.md`, `docs/domain-glossary.md`.
**Método:** lectura directa del código y contraste con la documentación. Todos los hallazgos citan `archivo:línea`.

---

## 0. Resumen ejecutivo

Bit-cora-g3 es un sistema de bitácoras operativas para las plantas térmicas GEC3 y GEC32 (Gecelca). Reemplaza el registro manual en Excel por uno con trazabilidad, control de turnos y un contrato de eventos hacia el dashboard de generación (`dashboard-gen-gec3/`). Stack: React 19 + Vite (frontend), Node ≥20 ESM + Express (backend, puerto 3002), SQL Server (esquemas `lov_bit` y `bitacora`), login Microsoft Entra ID (OIDC, Auth Code + PKCE).

**Estado general: sano y maduro.** El sistema muestra una postura de seguridad seria (rastro AUD-01..42 remediado), un modelo de routing único y consistente (D-037), doble sesión bien separada, saneamiento de errores y WebSocket autenticado por cookie. La lógica de turnos —el corazón operativo— está bien modelada, con el cruce de medianoche de T2 tratado de forma uniforme y con buenas defensas contra el doble cierre.

**Hallazgos priorizados:**

| # | Sev. | Área | Resumen |
|---|---|---|---|
| **H1** | 🔴 ALTA | Turnos | El *catchup* de conformación al arranque deriva `fecha_operativa` del día del login, no del inicio de la ventana → los turnos T2 compuestos por logins **después de medianoche** pueden quedar **sin conformación**. |
| **H2** | 🟠 MEDIA | Turnos | El disparo de conformación por el sweeper depende de que exista una `sesion_bitacora` abierta; un turno donde nadie abrió bitácora (o todos hicieron logout) no dispara conformación por esa vía. |
| **H3** | 🟠 MEDIA | Turnos | Doble reloj: las ventanas se calculan con `new Date()` (Node) y las escrituras con `SYSUTCDATETIME()` (SQL). Divergencia de relojes → inconsistencias en el borde exacto del turno. |
| **S1** | 🟠 MEDIA | Seguridad | `GET /api/eventos-dashboard` (público) expone PII (nombres de personal en snapshots) y su token de servicio es **opcional**. |
| **S2** | 🟠 MEDIA | Seguridad | CORS con `Access-Control-Allow-Origin: '*'` por omisión si falta `CORS_ALLOWED_ORIGINS` (solo `console.warn`). |
| **D1** | 🟡 DOC | Documentación | Varias divergencias entre `BIT-MODBD` v2.0 y el DDL real (cargos, catálogo de bitácoras, `password_hash`, F27.A1, definición de turnos §7.5). |
| H4–H7, S3–S10 | 🟡 BAJA/INFO | Varias | Races benignos, deuda técnica de configuración y escalabilidad horizontal. Detalle en §6 y §7. |

---

## 1. Arquitectura

### 1.1 Capas y bootstrap

El bootstrap (`server/server.js`) es deliberadamente delgado (ya no contiene rutas, nota AUD-34/35). Secuencia (`server.js:18-33`):

1. `initDB()` — conexión + DDL/seeds/migraciones idempotentes; falla → `process.exit(1)`.
2. `setBroadcastUsuariosActivos(...)` — inyección tardía del broadcaster WS para romper el ciclo de import `server.js ↔ auth/app.js`.
3. `buildAuthApp()` — construye toda la app Express (async: abre el session store MSSQL).
4. `http.createServer(app)` — servidor HTTP nativo para poder colgar los WebSocket (`upgrade`).
5. `attachWSS` + `attachWSConteoBitacoras` — dos `WebSocketServer` en modo `noServer` sobre el mismo `http.Server`.
6. Sweepers: `startTurnoSweeper`, `startMandSweeper`, `startSisSweeper` (crons internos).
7. `server.listen(3002)`. Apagado limpio en `SIGTERM`/`SIGINT`.

### 1.2 Pipeline Express (D-037 — compositor único `auth/app.js`)

Orden de middlewares (crítico), `auth/app.js:56-319`:

```
trust proxy(1)
 → reposición de prefijo APP_BASE_PATH en originalUrl   (parche para express-session tras nginx)
 → session (cookie httpOnly, sameSite:lax, secure en prod, store MSSQL)
 → corsMiddleware → csrfMiddleware
 → /health (público)
 → rutas OIDC self-gating (/auth/login, /auth/redirect, /api/me, /api/logout)
 → requireEntra                         ← GATE por defecto: todo cierra salvo allowlist
 → express.json({limit:'1mb'})          ← post-auth: no se gasta parsing en anónimos
 → routers de dominio (/api/*)
 → 404
 → expressErrorHandler                  ← último: sanea errores, evita filtrar host/BD en stack HTML
```

El orden importa: el body parser va **después** del gate; el error handler va **último** para capturar incluso el fallo de `express-session` cuando el store MSSQL no conecta (de otro modo filtraría host/instancia de la BD en un stack HTML).

### 1.3 Autenticación y autorización (D-031)

**Flujo OIDC** (`@azure/msal-node`, Auth Code + PKCE):
- `GET /auth/login` (`app.js:131-152`) genera `authCodeUrl` + PKCE + state + nonce.
- `GET /auth/redirect` (`app.js:155-236`): maneja `AADSTS50105` (usuario no asignado a la Enterprise App → `no_acceso`, este es el gate de acceso que reemplaza al allowlist local), valida `state` (anti-CSRF), `acquireTokenByCode`, extrae claims (`upn/name/email/oid/tid`), **auto-aprovisiona** `lov_bit.usuario` por `azure_oid` (`provisionEntraUser`), y **regenera** la sesión (anti session-fixation) preservando la caché MSAL.

**Doble sesión** (invariante clave):
- **Sesión de login Entra** — cookie httpOnly firmada, store MSSQL `[auth].[AppSessions]`. Es la **identidad** (`req.session.user.oid`).
- **Sesión de app** — fila `bitacora.sesion_activa` (`activa=1`). Es el **contexto operativo** (planta, cargo, turno). Se resuelve desde el `oid` en `loadSession` (`middleware/auth.js:53-75`).

**Cargo derivado del App Role** (`utils/entra-roles.js`): el cargo **ya no se elige en el login**. `ROLE_TO_CARGO` (mapa 1:1 de 13 App Roles → 13 cargos) + `PRECEDENCE` (jerarquía; gana el mayor si hay multi-rol) → `resolveCargo(roles)`; sin rol → 403. `select-context` deriva `cargo_id` del token, no del body.

**Gate por defecto** — `requireEntra` (`_middleware.js:80-85`) cierra el acceso anónimo salvo una **allowlist pública explícita** (`/health`, catálogos no-PII, `eventos-dashboard`). Un endpoint nuevo **nace cerrado**. Backdoor de tests `AUTH_TEST_BYPASS` **fail-closed** (aborta el proceso si se activa en prod).

### 1.4 Routing (12 routers de dominio)

`catalogos`, `cierre`, `historicos`, `autorizaciones` (deprecated), `eventos-dashboard`, `conformacion`, `combustibles`, `disponibilidad`, `mand`, `sesion`, `bitacora`, `registros`. Patrón por router: `router.use(loadAppSession)` (setea `req.sesion` o 401) + handlers en `asyncH` (`throw → expressErrorHandler`). Errores centralizados en `utils/errores.js`: clasifica (conexión BD → 503, timeout → 503, SQL → 500, body >1 MB → 413, JSON inválido → 400) y **nunca** expone `err.message` crudo (D-032). El frontend ramifica por `codigo` estable, nunca por texto.

### 1.5 Frontend

Monolito orquestador `src/BitacorasGecelca3.jsx` (2313 líneas): `LoginScreen` (paso Microsoft → paso planta), `Header`/`HeaderMenu`, `BitacoraTabs` (categorías jerárquicas), `BarraEstado` (filtros F11 fecha+turno), y el switch de render por código de bitácora:

```
MAND → SalaDeMandoGrid   (grilla 24p×3×2, batch atómico)
DISP → DisponibilidadDashboard (mini-dashboard controlado)
COMB → ConsumosGrid       (grilla consumos controlada)
else → GrillaRegistros    (genérica con filtros F11)
```

**Routing por hash (D-035)** — la URL es fuente única: `#/op24h`, `#/disp?planta=GEC3`, `#/comb?fecha=YYYY-MM-DD`, `#/b/<codigo>`, `#/historicos`. Módulo puro `routing/appRoute.js` + hook `useAppRoute`; derivación bidireccional ruta↔estado con guardas de igualdad anti-loop. La grilla genérica recibe `bloqueado={turnoFinalizado}` → solo lectura, en paridad con el write-gate del backend.

Hooks clave: `useAuth`, `useApi` (traduce red caída a `codigo:'sin_conexion'`), `useBitacoraSesion`, `useCierre` (único cierre masivo), `useDisponibilidad` (conserva el body de los 409 de DISP), `useSalaDeMando`, `useUsuariosActivos` (WS).

### 1.6 Tiempo real (WebSocket)

Dos canales sobre el mismo `http.Server`, modo `noServer`, autenticados por **cookie firmada** en el `upgrade` (AUD-21, `auth/wsSession.js`) + validación de **Origin** (anti-CSWSH):
- `/ws/usuarios-activos` — snapshot de sesiones `activa=1` **acotado a la planta del cliente** (AUD-42). Broadcast cada 60 s, en logout y en `select-context`/`cerrar-app`.
- `/ws/conteo-bitacoras` — borradores por bitácora, broadcast dirigido por planta tras mutaciones de registros.

### 1.7 Contrato cross-repo (con `dashboard-gen-gec3`)

- **`bitacora.evento_dashboard`** (AUTH/REDESP/PRUEBA por periodo): UPSERT por `(planta_id, fecha, periodo, tipo)` con soft-delete (`activa=0`). Escribe Bitácora (batch MAND + ramas de `registros.js`), lee Dashboard.
- **`bitacora.disponibilidad_dashboard`** (DISP por planta): **vista de solo lectura** del vigente de `disponibilidad_estado` (trigger `INSTEAD OF THROW`, D-041).
- **Lectura**: `GET /api/eventos-dashboard?tipo=&planta_id=&fecha=` (puerto 3002); la planta `TST` se trata como inexistente (D-030).
- **Señal push** `eventos-changed` (fire-and-forget, post-commit, timeout 1.5 s); si el receptor no existe, cae al poll.

---

## 2. Base de datos y modelo entidad-relación

Motor SQL Server 2019+. Conexión `mssql` con `useUTC=true`; toda hora en UTC vía `SYSUTCDATETIME()`. La BD se auto-crea/migra en cada arranque (`initDB()`); los bloques one-shot se gatean por `bitacora.migracion_aplicada`.

> **Nota transversal:** el DDL "base" de los `CREATE TABLE` **no es el esquema efectivo** — una cascada de `ALTER` idempotentes lo muta (nullabilidad, defaults `GETDATE()`→`SYSUTCDATETIME()`, columnas nuevas). Donde el doc y el código difieren, manda el DDL real de `db.js`.

### 2.1 Inventario de tablas

**Esquema `lov_bit` (catálogos):**

| Tabla | PK | Propósito |
|---|---|---|
| `planta` | `planta_id VARCHAR(10)` | GEC3, GEC32 (+ `TST` fixture) |
| `cargo` | `cargo_id INT IDENTITY` | 13 roles; `solo_lectura`, `puede_cerrar_turno` BIT |
| `usuario` | `usuario_id INT IDENTITY` | Identidades auto-aprovisionadas (Entra); `azure_oid/upn/tid`, `es_sintetico` |
| `bitacora` | `bitacora_id INT IDENTITY` | Catálogo dinámico; `codigo UNIQUE`, `formulario_especial` |
| `tipo_evento` | `tipo_evento_id INT IDENTITY` | Tipos por bitácora; `notificar_dashboard_tipo` (discriminador cross-repo) |
| `cargo_bitacora_permiso` | `(cargo_id, bitacora_id)` | Matriz de permisos (reconstruida en cada arranque) |
| `combustible` | `combustible_id INT IDENTITY` | Catálogo por planta; `tipo`, `cantidad_max` |

**Esquema `bitacora` (transaccional):**

| Tabla | PK | Propósito |
|---|---|---|
| `sesion_activa` | `sesion_id INT IDENTITY` | **Sesión de app / turno** (columnas `turno`, `turno_finalizado_en`) |
| `sesion_bitacora` | `sesion_bitacora_id INT IDENTITY` | Presencia login×bitácora |
| `registro_activo` | `registro_id INT IDENTITY` | Registros del día, editables |
| `registro_historico` | `registro_id INT` (sin IDENTITY) | Histórico inmutable append-only |
| `evento_dashboard` | `evento_id INT IDENTITY` | Puente cross-repo |
| `disponibilidad_estado` | `disponibilidad_id INT IDENTITY` | Máquina de estados DISP (D-026) |
| `conformacion_turno` | `(fecha_operativa, planta_id, turno, usuario_id)` | **Snapshot inmutable de turno** |
| `consumo_combustible` | `consumo_id INT IDENTITY` | Consumos long-format (+`valor_sis`) |
| `migracion_aplicada`, `mand_cierre_log`, `sis_scrape_log` | — | Idempotencia / observabilidad |

El store de sesión Entra `[auth].[AppSessions]` lo auto-provisiona `express-session`, no `initDB()`.

**Vistas:** `v_disponibilidad_estado`, `disponibilidad_dashboard`, `autorizacion_dashboard` (las tres **solo lectura** por trigger `INSTEAD OF THROW`, D-041), `v_consumo_periodo`, `v_ingenieros_en_turno`, `v_jdt_actual`, `v_historico_busqueda`.

### 2.2 Relaciones y snapshots (por qué no todo es FK)

Los **roles presentes** en cada registro se guardan como **snapshots JSON inmutables** (`jdts_snapshot`, `jefes_snapshot`, `ingenieros_snapshot`, y en DISP también `jefes_planta_snapshot`/`gerentes_produccion_snapshot`), `NVARCHAR(MAX) NOT NULL` (mínimo `'[]'`). **No son FK**: si un usuario se renombra o desactiva, el histórico no se rompe (D-001/D-011). El único FK vivo a `usuario` en las tablas de registro es `creado_por` (+ `modificado_por`/`cerrado_por`).

**FK declaradas (integridad real):** `usuario`, `planta`, `cargo`, `bitacora`, `tipo_evento`, `sesion_activa`, `combustible` funcionan como padres. **Sin FK por diseño (append-only):** `registro_historico.*` y `evento_dashboard.registro_origen_id`.

### 2.3 Diagrama ER (textual)

```
┌─────────────────────────── lov_bit (catálogos) ───────────────────────────┐
│                                                                            │
│   PLANTA ──1─────< COMBUSTIBLE                                              │
│     │                                                                      │
│   CARGO ──1──< CARGO_BITACORA_PERMISO >──1── BITACORA ──1──< TIPO_EVENTO   │
│     │            (M:N, matriz permisos)          │                         │
│   USUARIO (azure_oid, es_sintetico)              │                         │
└─────┼────────────────────────────────────────────┼────────────────────────┘
      │                                             │
┌─────┼──────────────────────── bitacora (transaccional) ───────────────────┐
│     │                                             │                        │
│  SESION_ACTIVA >──1── PLANTA   >──1── CARGO        │                        │
│   (usuario,planta,cargo,TURNO, turno_finalizado_en)│                       │
│     │ 1                                            │                        │
│     └──< SESION_BITACORA >──1── BITACORA ──────────┘                        │
│                                                                            │
│  CONFORMACION_TURNO  (FK: usuario, planta, cargo; PK natural               │
│     fecha_operativa+planta+turno+usuario; desnormaliza nombre/cargo)       │
│                                                                            │
│  REGISTRO_ACTIVO >──1── BITACORA / PLANTA / TIPO_EVENTO / USUARIO(creado)  │
│     · roles = snapshots JSON (línea punteada a USUARIO, sin FK)            │
│     └──(cierre: INSERT+DELETE, mismo registro_id)──> REGISTRO_HISTORICO    │
│                                                                            │
│  DISPONIBILIDAD_ESTADO >──1── PLANTA / USUARIO(creado)                     │
│     · 1 vigente por planta (UQ filtrado WHERE fecha_fin_estado IS NULL)    │
│     · auto-encadenado: fin(N) = inicio(N+1)                               │
│     └── vista disponibilidad_dashboard (proyección del vigente, RO)        │
│                                                                            │
│  CONSUMO_COMBUSTIBLE >──1── PLANTA / COMBUSTIBLE / USUARIO                 │
│     └── vista v_consumo_periodo (pivot; total_carbon = SUM tipo=ALIMENTADOR)│
│                                                                            │
│  EVENTO_DASHBOARD >──1── PLANTA   (registro_origen_id = ref lógica, sin FK)│
│     └── vista autorizacion_dashboard (proyección tipo=AUTH, RO)           │
└────────────────────────────────────────────────────────────────────────────┘
```

**Cardinalidades clave:** 1 vigente DISP por planta · 1 fila `evento_dashboard` por (planta,fecha,periodo,tipo) · 1 celda `consumo_combustible` por (planta,fecha,periodo,combustible) · 1 permiso por (cargo,bitácora) · 1 `sesion_bitacora` por (sesión,bitácora).

### 2.4 Matriz de permisos (reconstruida en cada arranque)

`cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)`. En una transacción con `TABLOCKX, HOLDLOCK` se hace `DELETE` total + `INSERT ... WITH matriz AS (cargo CROSS JOIN bitacora WHERE activa=1)`, **data-driven, matcheando por `c.nombre`** (no por id), con dos `CASE` (`puede_ver`/`puede_crear`). Precedencia: `Administrador y Debugging` (todo) → `CIET` (ver, no crear) → `MAND` → `COMB` → cargos generales → operadores (solo su bitácora). `puede_cerrar_turno`/`solo_lectura` viven en `cargo`, no aquí. **Gotcha DISP (F12.A6):** un `UPDATE` posterior recomputa `puede_crear` de toda fila DISP con un `IN (...)` de cargos — un cargo que deba crear en DISP debe estar en ese `IN`, no solo en la matriz.

### 2.5 Integridad

- **Append-only:** `registro_historico` y `conformacion_turno` solo reciben INSERT; sin hard-delete por auditoría.
- **Unique filtrados:** `UQ_disp_estado_vigente_por_planta` (1 vigente), `UQ_usuario_oid WHERE azure_oid IS NOT NULL`, `IX_sesion_bit_finalizada WHERE finalizada_en IS NULL`.
- **UTC:** todos los `DATETIME2` en UTC; columnas calculadas `*_bogota = DATEADD(HOUR,-5,...)` para presentación; comparaciones de día con `CAST(DATEADD(HOUR,-5,col) AS DATE)`.

---

## 3. Dinámica de turnos ★ (énfasis)

### 3.1 Definición canónica

Toda la lógica vive en `server/utils/turno.js` con **offset fijo −5 h** (`COLOMBIA_OFFSET_HOURS = 5`). Colombia no tiene DST → el offset puro es seguro. Tres formas de calcular el turno, todas consistentes entre sí:

| Origen | Función | Regla | Resultado |
|---|---|---|---|
| Hora reloj | `getTurnoColombia()` / `turnoDe(fecha)` (`turno.js:18-21,59-62`) | `hour >= 6 && hour < 18 ? 1 : 2` | **T1 = 06:00–17:59**, **T2 = 18:00–05:59** |
| Periodo (1..24) | `turnoFromPeriodo(p)` (`turno.js:29-31`) | `p >= 7 && p <= 18 ? 1 : 2` | periodo = `hora+1`; P7..P18 = T1 |
| Ventana UTC | `ventanaTurno(turno, fechaRef)` (`turno.js:33-55`) | ver abajo | intervalo `[inicio, fin)` |

**Cruce de medianoche (T2), `ventanaTurno` `turno.js:43-54`:**
- **T1** → `[hoy 06:00, hoy 18:00)` Bogotá.
- **T2** → si `hour < 6`, la ventana arrancó **ayer** a las 18:00 → `[díaN-1 18:00, díaN 06:00)`; si `hour >= 18` → `[díaN 18:00, díaN+1 06:00)`. La conversión Bogotá→UTC (`colombiaHourToUtcDate`) usa `Date.UTC`, que maneja bien el under/overflow de día.

Intervalos siempre **medio-abiertos `[inicio, fin)`**, de forma uniforme en builder, cierre y write-gate. `ventanaActual(now)` compone `turnoDe` + `ventanaTurno` para que ningún llamador reimplemente el cruce de medianoche.

### 3.2 Ciclo de vida de la sesión de turno

Dos sesiones separadas: cookie Entra (identidad) y `bitacora.sesion_activa` (participación en el turno).

| Fase | Dónde | Columna / mecanismo |
|---|---|---|
| Login + asignación de turno | `sesion.js:66` `select-context` | `turno = getTurnoColombia()` **al login** (D-003, turno fijo). Persistido en `sesion_activa.turno`. |
| Sesión única por persona | `sesion.js:87-91` | Al entrar a una unidad, `activa=0` de cualquier OTRA sesión activa del usuario. |
| Reactivación (re-login / volver) | `sesion.js:101-119` | Dedup por `(usuario,planta,cargo)` con `UPDLOCK+HOLDLOCK`; refresca `inicio_sesion`, `turno`. |
| Apertura de bitácora | `bitacora.js:33-46` `/abrir` | UPSERT en `sesion_bitacora` (`finalizada_en=NULL`). Solo presencia por-bitácora. |
| Finalización de turno | `bitacora.js:54-98` `/finalizar` | `sesion_activa.turno_finalizado_en = now` (fuente única, D-040). |
| Cierre (archivo de registros) | `cierre.js` `/masivo` | Mueve borradores a `registro_historico`. **No toca `sesion_activa`.** |
| Expulsión a fin de turno | `turno-sweeper.js:121-146` | `activa=0, cerrada_en=now` cuando la ventana venció. **No toca la cookie Entra.** |
| Heartbeat | `middleware/auth.js:70-73` | `ultima_actividad` en cada request; post-F9 **ya no es gate de TTL**. |

### 3.3 Finalización de turno (D-040) — revertible, por ventana

- **Fuente única:** `sesion_activa.turno_finalizado_en` (`NULL` = vivo). **Nunca reusar `sesion_bitacora.finalizada_en`** (se reseteaba en cada `/abrir` → causaba "des-finalización al ver una bitácora").
- **Vigencia por ventana:** `finalizacionVigente(finalizadoEn, ahora)` (`turno.js:74-80`) — la finalización solo cuenta si cae dentro de `ventanaActual(ahora)`; una finalización de un turno pasado **expira sola** al siguiente turno.
- **Escritura/reversión** (`/finalizar`, `/revertir-turno`, `/finalizar-forzado`): idempotentes, con criterio de ventana; CIET solo si cambió.
- **Persistencia en re-login:** `select-context` usa un `CASE` que **preserva** `turno_finalizado_en` si sigue en la ventana y lo limpia si es de un turno pasado (reemplazó el reset incondicional que reabría el turno).
- **Servido al front:** `loadSession` fuerza `turno_finalizado_en=null` si `!finalizacionVigente(...)` → el cliente no hace lógica de TZ. La fila en BD queda intacta.
- **Write-gate 409** `turno_finalizado` (`_middleware.js:105-124`): solo en la **rama genérica** de `registros.js` (POST/PUT/DELETE). **MAND/DISP/COMB exentos** (endpoints propios). Alcance **por unidad** (por fila `sesion_activa`).

### 3.4 Cierre masivo de turno (D-042) — único cierre

Se eliminó el cierre individual por bitácora. Solo existen `POST /api/cierre/masivo` y `GET /api/cierre/preview-masivo` (`routes/cierre.js`).

- **Qué se cierra:** borradores de bitácoras con `oculta=0 AND codigo NOT IN ('DISP','MAND')`. CIET excluida (evita recursión); DISP y MAND tienen su propio ciclo.
- **Cierre cronológico por ventana** (`cierre.js:135-179`): por bitácora, toma el borrador **más antiguo** con `UPDLOCK+HOLDLOCK` (tiebreaker `fecha_evento ASC, registro_id ASC`, D-005 T4), deriva el turno de la **hora del registro** (no de la columna `turno`, por robustez), calcula su `ventanaTurno` y archiva **solo** los registros en `[inicio, fin)`. Emite CIET `'Cierre de turno'` por bitácora, en transacción aislada.
- **Preview:** `ingenieros_no_finalizados` filtra por `sa.turno_finalizado_en IS NULL` (D-040). Gating: `puede_cerrar_turno` + `plantaMatch`.

### 3.5 Conformación de turno (D-025/D-044)

Snapshot inmutable a `conformacion_turno` (PK natural `(fecha_operativa, planta_id, turno, usuario_id)`; re-logins colapsan en una fila por usuario/turno/planta).

- **Builder** `buildConformacionSnapshot` (`conformacion-snapshot.js:17-85`):
  - Ventana vía `ventanaTurno(turno, fechaRefBogotaMediodia(fecha))` — usa **mediodía Bogotá** para que `new Date('YYYY-MM-DD')` (midnight UTC) no caiga al día anterior tras el shift −5 h.
  - **Filtro por login en ventana (D-003):** `sa.inicio_sesion >= @inicio AND < @fin` — no por solape (el solape metía sesiones eternas de jefes con duraciones absurdas).
  - `inicio=MIN`, `fin=MAX(fin_efectivo)`, `duracion_min=SUM(DATEDIFF)`, agregado por `(usuario,cargo)`.
  - `fin_efectivo`/`fin_inferido`: si `cerrada_en < ventana_fin` usa `cerrada_en` (`fin_inferido=0`, logout explícito); si no, `ventana_fin` (`fin_inferido=1`, sin logout).
  - **Exclusión de sintéticos (D-044):** `WHERE (@incluir_sinteticos=1 OR u.es_sintetico=0)`; producción **nunca** pasa `incluirSinteticos` (guardrail estático). Sin este filtro, los fixtures `test_*` quedaban en el histórico inmutable de GEC3/GEC32.
- **Persistencia** `IF NOT EXISTS ... INSERT` por usuario → idempotente vía PK (`{insertadas, skipped}`).
- **Trigger híbrido:** (1) sweeper de turno, (2) catchup al arranque (últimos 7 días), (3) manual `POST /api/conformacion-turno/trigger` (gated).
- **"Diferencia de 1 día" en T2 (no es bug):** `fecha_operativa` = día Bogotá del **inicio** (18:00); en filas T2, `fin_sesion` y `snapshot_en` caen el día calendario **siguiente** porque el turno cruza medianoche. Presentar siempre las columnas `*_bogota`. Se confirmó en datos reales (`registros_tabla_conformacionturnos.md`): filas T2 GEC3 con `fecha_operativa=2026-07-03` y `fin_sesion` en `2026-07-04 06:00`.

### 3.6 Los sweepers

Dos crons independientes, `setInterval` cada **60 s**, singletons con guarda, cada tick en `try/catch/finally` que re-arma el timer (no muere ante error).

- **`turno-sweeper.js`** (`sweepTurnosVencidos`): (1) lista `sesion_bitacora` con `sa.activa=1 AND sb.finalizada_en IS NULL`; (2) las vencidas (`ahora >= ventanaTurno(turno, abierta_en).fin`) las agrupa por sesión; (3) por sesión: `UPDATE finalizada_en=now` (idempotente) + CIET `'finalizacion'` solo si `rowsAffected>0`; (4) dispara conformación por `(planta,turno,fecha)` únicos; (5) **expulsión**: recorre TODAS las `sesion_activa` con `activa=1` y las vencidas → `activa=0`.
- **`mand-sweeper.js`**: cierra el **día** MAND (no el turno) al cambiar el día Bogotá. Idempotencia vía `mand_cierre_log` (PK `fecha+planta`); catchup de ayer en reinicio. MAND cierra a medianoche Bogotá (coherente con su exclusión del cierre de turno).

Ambos escriben con `SYSUTCDATETIME()` y comparan ventanas con `new Date()` (reloj Node).

---

## 4. Hallazgos de turnos (detalle)

### 🔴 H1 (ALTA) — Catchup de conformación usa la fecha del login, no la del inicio de ventana T2
`db.js:2197-2213` deriva `fecha_operativa = CAST(DATEADD(HOUR,-5, sa.inicio_sesion) AS DATE)` (día Bogotá del **login**), mientras el sweeper la deriva correctamente de `ventanaTurno(...).inicio` (`turno-sweeper.js:92-93`). Para un login **T2 después de medianoche** (00:00–05:59), la fecha del login es el **día N+1**, pero ese turno arrancó el día N a las 18:00.
- El catchup genera un candidato `(turno=2, fecha=N+1)` espurio; su ventana `[N+1 18:00, N+2 06:00)` **no contiene** la sesión de las 02:00 → snapshot vacío o mal filtrado.
- Si un turno T2 estuvo compuesto **solo** por logins post-medianoche, el catchup **nunca** genera el candidato correcto `fecha=N` → ese turno queda **sin conformación** por la vía de arranque.
- **Recomendación:** en el CTE derivar la fecha con la misma lógica de ventana que el sweeper (para T2, `hora Bogotá < 6 ⇒ día-1`), o reusar `ventanaTurno` en JS antes de deduplicar candidatos.

### 🟠 H2 (MEDIA) — La conformación del sweeper depende de una `sesion_bitacora` abierta
`turno-sweeper.js:22-31` solo puebla los candidatos de conformación a partir de sesiones con `sb.finalizada_en IS NULL`. Si en un turno **nadie abrió una bitácora**, o todos hicieron **logout explícito** antes del fin de turno, el sweeper **no dispara** la conformación. La expulsión de sesiones sí es robusta (recorre todas las `sesion_activa`), pero la conformación no. Queda el catchup como red — y el catchup arrastra H1.
- **Recomendación:** derivar los candidatos de conformación de `sesion_activa` (mismo criterio de ventana que la expulsión), no de `sesion_bitacora`.

### 🟠 H3 (MEDIA) — Doble reloj (Node vs SQL Server)
Las ventanas se calculan con `new Date()` (Node) en sweepers, `finalizacionVigente`, `select-context` y catchup; las escrituras usan `SYSUTCDATETIME()` (SQL). Si los relojes divergen, en el **borde exacto del turno** hay inconsistencias (una finalización se ve vigente/no-vigente según qué reloj mande). Toda la lógica de turnos depende del reloj del servidor.
- **Recomendación:** garantizar NTP; idealmente una sola fuente de tiempo. Severidad acotada por el intervalo de 60 s y la naturaleza revertible/idempotente de las operaciones.

### 🟡 H4 (BAJA) — Race expulsión vs reactivación
`turno-sweeper.js:122-141`: la lista de expirados se calcula desde `inicio_sesion` viejo, pero el `UPDATE` filtra solo por `activa=1 AND sesion_id IN (...)`, sin re-verificar la ventana. Un usuario que se reactive en la ventana de ms entre SELECT y UPDATE es expulsado igual. Auto-sana en el siguiente request. Recomendación: añadir `AND inicio_sesion = @valor_leido` o recomputar ventana en el UPDATE.

### 🟡 H5 (BAJA/UX) — "Cerrar Turno" cierra el turno más antiguo
`cierre.js:135-143` archiva solo la ventana del borrador más antiguo por bitácora. Si se acumularon borradores de T1 y T2, un clic cierra solo T1; T2 requiere un segundo cierre. Correcto por diseño (D-005) pero puede sorprender ("cerré y siguen apareciendo pendientes").

### 🟡 H6 (BAJA) — Fragilidad de `periodo = hora + 1`
`turnoFromPeriodo` asume periodo 1-24; un futuro llamador que pase hora cruda 0-23 obtendría el turno equivocado en los bordes. Hoy todos los llamadores pasan `periodoFromFechaBogota()` (hora+1), así que es correcto, pero el nombre invita al error. La coherencia turno↔hora se valida en POST/PUT de registros (`codigo:'turno_no_coincide'`).

### 🟡 H7 (INFO) — Asimetría `<` vs `<=` en el builder
`conformacion-snapshot.js:34` usa `cerrada_en < @fin` para `fin_efectivo` y `:38` usa `<= @fin` para `fin_inferido`. En el borde exacto `cerrada_en == ventana_fin`, `fin_inferido=0` con `fin_efectivo=ventana_fin`. Borde improbable (igualdad al ms) y benigno; vale documentarlo.

**Fortalezas confirmadas:** doble-cierre bien prevenido (UPDLOCK+HOLDLOCK, PK de idempotencia, operaciones idempotentes); cruce de medianoche T2 modelado uniformemente; sin DST; sintéticos estructuralmente excluidos del histórico; sweepers resistentes a errores.

---

## 5. Hallazgos de arquitectura / seguridad

### 🟠 S1 (MEDIA) — PII en el borde cross-repo con token opcional
`GET /api/eventos-dashboard` está en la allowlist pública y su único gate es `DASHBOARD_API_TOKEN` **opcional** (`eventos-dashboard.js:24-34`). Sin token, cualquiera con acceso de red al :3002 lee `jdts_snapshot`/`jefes_snapshot` (nombres de personal). **Recomendación:** token obligatorio en prod (mismo patrón que `SESSION_SECRET`).

### 🟠 S2 (MEDIA) — CORS wildcard por omisión
Si falta `CORS_ALLOWED_ORIGINS`, `Access-Control-Allow-Origin: '*'` incluso en prod, con solo un `console.warn` (`http.js:21-35`). No explotable hoy (front same-origin), pero es inseguro por omisión. **Recomendación:** fail-closed en prod.

### 🟡 S3–S10 (BAJA/INFO)
- **Rate limiter y estado WS en memoria por proceso** → inefectivos en multi-instancia (el session store sí es MSSQL). 
- **CSRF depende de que el navegador siempre mande Origin** (mutadores con Origin ausente pasan, para no romper server-to-server).
- **Parche frágil `originalUrl`/`APP_BASE_PATH`** depende de un internal de `express-session@1.19`; un upgrade podría romper login silenciosamente. Sin test que lo cubra.
- **`sesion_id` vestigial** en el WS del cliente (`useUsuariosActivos.js:24`), ignorado por el server desde AUD-21.
- **Dos `WebSocketServer` compitiendo por `upgrade`**: un path no manejado deja el socket colgado sin `destroy()` (fuga menor).
- **Router `autorizaciones.js` deprecated aún montado.**
- **DISP cross-planta por diseño:** `puede_crear` DISP puede cambiar el estado de cualquier planta (revierte `plantaMatch` solo para DISP); amplía el blast radius del permiso.
- **Fire-and-forget sin observabilidad:** `notifyDashboard`, update de `ultima_actividad` y broadcasts WS se tragan errores en silencio.

---

## 6. Divergencias documentación ↔ código (D1)

`BIT-MODBD-2026-001.md` v2.0 diverge del DDL real en `db.js` en varios puntos — recomendable una pasada de sincronización:

1. **`cargo`:** el doc siembra 4 cargos; el código siembra **13** y elimina `Ingeniero de Planta de Agua`.
2. **`bitacora`:** el doc §2.4 muestra el catálogo v1.0 (SINC/CAL/ELEC/IC/MA); el real es CALDERA/ANAL/SALA/AGUA/TURBO/MAQU/CYC/DISP/AUTH(activa=0)/QUIM/CIET/MAND/COMB.
3. **`usuario`:** el doc dice `password_hash` bcrypt NOT NULL; el real es nullable (Entra) y los comentarios hablan de scrypt. `es_sintetico`/`azure_*` poco reflejados en el DDL principal del doc.
4. **F27.A1 no documentado:** `consumo_combustible.valor_sis`/`sis_actualizado_en` y la tabla `sis_scrape_log` existen en código pero no en el MODBD §4.9.
5. **Definición de turnos §7.5:** el doc dice T1=00:00–11:59 / T2=12:00–23:59, **contradiciendo** la definición autoritativa (T1=06:00–17:59, T2=18:00–05:59) que implementa `utils/turno.js`. El §7.5 está desactualizado y es peligrosamente engañoso para quien lo lea sin leer el código.
6. **`autorizacion_dashboard`:** el doc afirma que F9 la eliminó; el código la recrea en cada arranque (deuda viva).
7. **Defaults:** el doc muestra `GETDATE()`; el DDL real usa `SYSUTCDATETIME()` (F13.3).

---

## 7. Recomendaciones priorizadas

| Prioridad | Acción |
|---|---|
| **P0** | Corregir **H1** (fecha del catchup de conformación para T2 post-medianoche) — puede dejar turnos nocturnos sin registro inmutable de quién operó. |
| **P0** | Hacer `DASHBOARD_API_TOKEN` **obligatorio en prod** (S1, PII de personal). |
| **P1** | Derivar los candidatos de conformación del sweeper desde `sesion_activa`, no `sesion_bitacora` (**H2**). |
| **P1** | Fail-closed en CORS cuando falta `CORS_ALLOWED_ORIGINS` (S2). |
| **P1** | Corregir §7.5 del `BIT-MODBD` (definición de turnos) y las demás divergencias doc↔código (D1). |
| **P2** | Garantizar NTP / fuente única de tiempo (**H3**); re-verificar ventana en el UPDATE de expulsión (**H4**). |
| **P2** | Limpiar deuda: `sesion_id` vestigial, `autorizaciones.js`, `destroy()` de sockets en paths no manejados, observabilidad de fire-and-forget. |

---

*Auditoría generada el 2026-07-04. Hallazgos verificables por las citas `archivo:línea`. Ningún archivo del repositorio fue modificado durante la auditoría (salvo la creación de este documento).*
