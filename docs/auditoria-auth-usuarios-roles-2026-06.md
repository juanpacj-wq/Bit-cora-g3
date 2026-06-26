# Auditoría — Usuarios, Roles e Inicio de Sesión (Bit-cora-g3)

> Fecha: 2026-06-26. Propósito: mapa exhaustivo de TODO lo relacionado con usuarios,
> cargos/roles, permisos, sesiones y autenticación, como base para un refactor grande.
> Fuente de verdad VIGENTE: código (`server/`, `src/`) + `BIT-MODBD-2026-001.md` + `docs/decisions.md`.
> El `BIT-RF-2026-001.md` está congelado en spec v1.0 y describe un modelo de sesión
> (TTL + heartbeat + login por email) **derogado** — ver §8.

---

## 1. Mapa de archivos (qué tocar en el refactor)

### Backend
| Archivo | Rol en auth/usuarios/roles |
|---|---|
| `server/server.js:113-257` | Endpoints de auth (login, select-context, logout, usuarios-activos) |
| `server/middleware/auth.js` | `loadSession` — validación del token `X-Sesion-Id` |
| `server/middleware/permissions.js` | Gates de autorización (`hasPermisoBitacora`, `puedeCerrarTurno`, `canEditarRegistro`, conformación) |
| `server/utils/password.js` | Hashing **scrypt** (`hashPassword`/`verifyPassword`) |
| `server/utils/http.js:1-5` | CORS (`Allow-Origin:*`, `Allow-Headers: X-Sesion-Id`), `parseBody`, `sendJSON` |
| `server/utils/snapshots.js` | Snapshots de presencia (JDTs/Jefes/Ingenieros/Gerentes) |
| `server/utils/conformacion-snapshot.js` | Builder de `conformacion_turno` |
| `server/utils/turno-sweeper.js` | Cron 60s: finaliza `sesion_bitacora` + dispara conformación. NO toca `sesion_activa` |
| `server/utils/ws-usuarios-activos.js` | WebSocket de presencia en vivo + interval 60s |
| `server/db.js` | DDL + seeds + migraciones + **matriz de permisos reconstruida en cada arranque** |
| `server/data/personal-2026.json` | 81 usuarios operativos (fuente del seed) |

> Nota: **no existe carpeta `server/routes/`** pese a la mención en CLAUDE.md/architecture.md;
> todo el routing es un if-chain en `server.js`.

### Frontend
| Archivo | Rol |
|---|---|
| `src/hooks/useAuth.js` | Estado de sesión cliente: login / selectContext / logout / logoutLocal; `sessionStorage` |
| `src/hooks/useApi.js:3-35` | Inyecta header `X-Sesion-Id`; dispara logout automático en 401 |
| `src/hooks/useCatalogos.js` | Trae cargos + permisos del cargo (`/api/catalogos/permisos/:cargo_id`) — UI data-driven |
| `src/hooks/useBitacoraSesion.js` | `abrir-bitacora` al montar; `finalizar-turno` |
| `src/hooks/useUsuariosActivos.js` | Presencia vía WebSocket (sin polling HTTP) |
| `src/BitacorasGecelca3.jsx` | `LoginScreen` (`:231`), gating de render (`:1794`,`:1801`), gating de UI por permisos, popup logout (`:1769`) |

### Documentación autoritativa
- `BIT-MODBD-2026-001.md` — §2.2 cargo, §2.3 usuario (+§2.3.1 `es_jdt_default`, §2.3.2 SISTEMA), §2.6 matriz permisos, §3 `sesion_activa`, §4.6 `sesion_bitacora`, §4.7 `conformacion_turno`.
- `docs/decisions.md` — D-001, D-003, D-015, D-023, D-025, D-027, D-029; fases F2, F9.
- `docs/domain-glossary.md` — cargos, turnos, SISTEMA, snapshots.

---

## 2. Modelo de datos

### `lov_bit.usuario` — `db.js:279-289`
```
usuario_id      INT IDENTITY PK
nombre_completo VARCHAR(200) NOT NULL
username        VARCHAR(50)  NOT NULL UNIQUE   (UQ_usuario_username)
email           VARCHAR(200) NULL              (ya no UNIQUE, post-v2)
password_hash   VARCHAR(200) NOT NULL          (scrypt; '!disabled!' para SISTEMA)
es_jefe_planta  BIT DEFAULT 0                  (singleton: emunoz / Ernesto Muñoz)
es_jdt_default  BIT DEFAULT 0                  (singleton: ofedullo / Omar Fedullo — fallback de identidad, NO permiso)
activo          BIT DEFAULT 1
```
**Hallazgo clave: `usuario` NO tiene `cargo_id`.** El cargo NO se fija en el usuario:
se elige en login y se persiste en `sesion_activa.cargo_id`. El campo `cargo` de
`personal-2026.json` solo se usa para validar que el cargo existe al sembrar; **no se escribe**
a `usuario` (`db.js:1988-1996` valida; el MERGE `2008-2018` no incluye cargo).

**Seed (`seedPersonal`, `db.js:1979-2023`):** 81 usuarios desde `personal-2026.json`, UPSERT por
`username`, **todos con password inicial `'1234'`**, `activo=1`. + usuario `SISTEMA`
(`db.js:1265-1281`, `activo=0`, `'!disabled!'`). Total: **82 filas**.
(Los comentarios "83 usuarios" en `db.js:1087`/`:2022` están desactualizados.)

Distribución por cargo en el seed: 1 Gerente de Producción (`emunoz`), 6 Ingeniero Jefe de Turno
(incl. `ofedullo`), 2 Ingeniero Químico, 14 Ingeniero de Operación, 10 Op. Caldera, 6 Op. Analista,
9 Op. Sala de Mando, 9 Op. Planta de Agua, 9 Op. Turbogrupo, 9 Op. Maquinaria Pesada, 9 Op. Carbón y Caliza.

### `lov_bit.cargo` — `db.js:268-276`
```
cargo_id INT IDENTITY PK, nombre, solo_lectura BIT DEFAULT 0, puede_cerrar_turno BIT DEFAULT 0
```
**12 cargos** (MERGE por `nombre`, `db.js:593-615`):

| # | Cargo | solo_lectura | puede_cerrar_turno |
|---|---|---|---|
| 1 | Gerente de Producción | **1** | 0 |
| 2 | Ingeniero Jefe de Turno | 0 | **1** |
| 3 | Ingeniero de Operación | 0 | **1** |
| 4 | Ingeniero Químico | 0 | 0 |
| 5 | Operador de Planta - Caldera | 0 | 0 |
| 6 | Operador de Planta - Analista | 0 | 0 |
| 7 | Operador de Planta - Sala de Mando | 0 | 0 |
| 8 | Operador de Planta - Planta de Agua | 0 | 0 |
| 9 | Operador de Planta - Turbogrupo | 0 | 0 |
| 10 | Operador Maquinaria Pesada | 0 | 0 |
| 11 | Operador de Planta - Carbón y Caliza | 0 | 0 |
| 12 | Coordinador de carbón y maquinaria (D-029) | 0 | 0 |

> Cargo obsoleto `Ingeniero de Planta de Agua` se elimina con limpieza de dependencias
> (`db.js:619-627`). El seed de MODBD §2.2 todavía lo lista — discrepancia documental (§8).

### `bitacora.sesion_activa` — `db.js:344-355`
```
sesion_id        INT IDENTITY PK
usuario_id       INT FK usuario
planta_id        VARCHAR(10) FK planta
cargo_id         INT FK cargo
turno            TINYINT CHECK (1,2)
inicio_sesion    DATETIME2 DEFAULT SYSUTCDATETIME()
ultima_actividad DATETIME2 DEFAULT SYSUTCDATETIME()   (se refresca, NO rige TTL)
activa           BIT DEFAULT 1
cerrada_en       DATETIME2 NULL  (db.js:380-383 — distingue logout explícito de cierre por sweeper)
```
Índice `IX_sesion_lookup(activa, planta_id, cargo_id)`. **Sin TTL** (post-F2/F9).

### Satélites
- `bitacora.sesion_bitacora` (`db.js:406-416`): participación de un login por bitácora; `abierta_en`/`finalizada_en`, UNIQUE `(sesion_id, bitacora_id)`.
- `bitacora.conformacion_turno` (`db.js:1302-1317`, D-025): snapshot inmutable por turno-planta. PK `(fecha_operativa, planta_id, turno, usuario_id)`. `fin_inferido` BIT (1 = cayó a fin de ventana por falta de logout).
- `lov_bit.cargo_bitacora_permiso` (matriz): PK `(cargo_id, bitacora_id)`, `puede_ver`, `puede_crear`.

### Snapshots de presencia (NO son FK — D-001)
Columnas JSON NOT NULL en cada registro: `ingenieros_snapshot`, `jdts_snapshot`, `jefes_snapshot`
(`[{usuario_id, nombre_completo}]`). Helpers en `snapshots.js`. Único FK vivo a usuario:
`creado_por`/`modificado_por`. Estas son las ÚNICAS columnas de identidad que cruzan a
`dashboard-gen-gec3` (vía `evento_dashboard` y `disponibilidad_dashboard`).

---

## 3. Flujo de autenticación (login de 2 pasos)

El "token" es un **entero `sesion_id`** que viaja en header **`X-Sesion-Id`**. NO hay JWT, ni
cookie, ni bearer firmado. Estado cliente en `sessionStorage['bitacoras_auth'] = {user, sesion}`.

1. **Login** — `POST /api/auth/login` (`server.js:113-134`). Valida `username`+password contra
   `usuario WHERE username=@u AND activo=1`, `verifyPassword` (scrypt). Devuelve `{usuario}` sin
   `password_hash`. **No crea sesión todavía.** Front: `useAuth.login` (`useAuth.js:71-82`).
2. **Selección planta → cargo** (UI: `paso = credenciales|planta|cargo`).
3. **Crear sesión** — `POST /api/auth/select-context` (`server.js:136-212`). Valida planta+cargo
   existen, calcula `turno=getTurnoColombia()`, y en transacción UPDLOCK+HOLDLOCK hace **dedupe por
   `(usuario_id, planta_id, cargo_id)`**: reactiva la fila existente (`activa=1, cerrada_en=NULL`,
   sin pisar `inicio_sesion`/`turno` — D-003) o INSERT. Devuelve `sesion` con `cargo_nombre`,
   `solo_lectura`, `puede_cerrar_turno`. Dispara `broadcastUsuariosActivos()`.
4. **Transporte** — `useApi.js:23-25` adjunta `X-Sesion-Id` salvo `skipAuth`.
   `loadSession` (`auth.js:4-30`) valida `sesion_id` + `activa=1` y refresca `ultima_actividad`
   (fire-and-forget, no gate). Sin fila → endpoint responde 401.

### Logout
- `logout()` (`useAuth.js:58-64`) → `POST /api/auth/logout` (`server.js:214-229`): `activa=0, cerrada_en=now` + broadcast.
- `logoutLocal()` (`useAuth.js:50-56`): limpia solo cliente; la fila queda `activa=1` (cerrar pestaña / "salir sin finalizar" — respeta D-003, se reusa luego).
- 401 en request autenticado → `unauthorizedHandler` → `logout()` automático (`useApi.js:33-35` + `useAuth.js:66-69`).
- Popup `handleLogout` (`BitacorasGecelca3.jsx:1769-1791`): finalizar+salir / salir sin finalizar / cancelar.

### Hashing — `server/utils/password.js`
**scrypt** (NO bcrypt, pese a comentarios en `server.js:113`, `db.js:146,212,1266`).
`N=2^15, r=8, p=1, keyLen=64, salt=16B`. Formato `scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>`.
`verifyPassword` usa `timingSafeEqual`. Parámetros leídos del propio hash (permite rotación).
Migración `migrateSchemaV2` (`db.js:212-234`) rehashea filas `NOT LIKE 'scrypt$%'` **siempre con `'1234'`**.

---

## 4. Autorización — matriz de permisos

### Reconstrucción en cada arranque (`db.js:785-860`, transacción `matrizTx`)
`DELETE ... WITH (TABLOCKX, HOLDLOCK)` + CTE `WITH matriz AS` (CROSS JOIN cargo × bitácora `activa=1`)
+ INSERT. **Match por `c.nombre` y `b.codigo`, no por id.**

> **Gotcha central para el refactor:** la matriz se ARRASA y reconstruye en cada arranque. Un seed
> one-shot de permisos NO sobrevive al siguiente restart. Para crear un rol hay que tocar DOS lugares:
> el MERGE de cargos (`db.js:593-615`) **y** las CASE de `puede_ver`/`puede_crear` (`db.js:791-849`).

### Matriz cargo × bitácora (celda = ver/crear)
| Cargo | CALDERA | ANAL | SALA | AGUA | TURBO | MAQU | CYC | QUIM | DISP | MAND | COMB | CIET |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gerente de Producción | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– |
| Ingeniero Jefe de Turno | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/C | V/– | V/C | V/– |
| Ingeniero de Operación | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/C | V/– | V/– | V/– |
| Ingeniero Químico | V/– | V/– | V/– | V/– | V/– | V/– | V/– | V/C | V/– | V/– | V/– | V/– |
| Op. Caldera | V/C | – | – | – | – | – | – | – | V/– | V/– | V/– | V/– |
| Op. Analista | – | V/C | – | – | – | – | – | – | V/– | V/– | V/– | V/– |
| Op. Sala de Mando | – | – | V/C | – | – | – | – | – | V/– | V/– | V/– | V/– |
| Op. Planta de Agua | – | – | – | V/C | – | – | – | – | V/– | V/– | V/– | V/– |
| Op. Turbogrupo | – | – | – | – | V/C | – | – | – | V/– | V/– | V/– | V/– |
| Op. Maquinaria Pesada | – | – | – | – | – | V/C | – | – | V/– | V/– | V/– | V/– |
| Op. Carbón y Caliza | – | – | – | – | – | – | V/C | – | V/– | V/– | V/C | V/– |
| Coordinador carbón y maquinaria | – | – | – | – | – | V/C | V/C | – | V/– | V/– | V/C | V/– |

Reglas globales (preceden a las por-cargo, `db.js:793-801`):
- **CIET**: ver=todos, crear=nadie (automático). Pero `oculta=1` → no aparece en frontend.
- **MAND**: ver=todos; crear solo JdT/IngOp (`db.js:825-826`).
- **COMB**: ver=todos; crear solo Op. Carbón y Caliza + JdT + Coordinador carbón y maquinaria (`db.js:829-830`).
- **DISP**: refuerzo defensivo idempotente además del CTE (`db.js:958-976`, F12.A6).

> El CTE filtra `b.activa=1`, por eso **AUTH no recibe filas** (se siembra `activa=0`,
> reemplazada por MAND). COMB se siembra aparte (F26.B1).

### Middleware — `server/middleware/permissions.js`
- `hasPermisoBitacora(sesion, bitacora_id, accion)` (`:4-17`) — accion ∈ `puede_ver|puede_crear`.
- `puedeCerrarTurno(sesion)` (`:21-23`) — lee flag `sesion.puede_cerrar_turno` (no el nombre).
- `plantaMatch` (`:25-27`); `canEditarRegistro` (`:29-35`) — misma planta + (creador OR puedeCerrarTurno OR puede_crear).
- `puedeVerConformacion` (`:40-42`, siempre true); `puedeTriggerConformacion` (`:46-51`, JdT/IngOp o `es_jefe_planta`).

Uso en `server.js`: creación `:633,:748,:939,:1337,:2011,:2513`; ver `:1939,:1974,:2417,:2441`;
cierres (puedeCerrarTurno) `:341,:1573,:1638,:1694,:1799,:2208,:2284`; edición (canEditarRegistro) `:1082,:1908`.

### Consumo en frontend (data-driven)
- `useCatalogos(cargoId)` (`useCatalogos.js`) trae `/api/catalogos/cargos` + `/api/catalogos/permisos/:cargoId`.
- `BitacorasGecelca3.jsx`: `bitacorasPermitidas` filtra por `puede_ver` (`:1510`); `esJefeTurno=!!sesion.puede_cerrar_turno` (`:1546`); `puedeCrear=!!permisoActivo.puede_crear` (`:1548`). Nunca hardcodea nombres de cargo.

### Endpoints de catálogo
- `GET /api/catalogos/cargos` (`server.js:447-454`).
- `GET /api/catalogos/permisos/:cargo_id` (`server.js:487-503`, filtra `activa=1 AND oculta=0`).
- `GET /api/catalogos/bitacoras` (`server.js:459-467`).

---

## 5. Presencia y conformación de turno
- **Snapshots** (`snapshots.js`): `snapshotJDTs` (activa=1 + fallback `es_jdt_default`), `snapshotJefes` (`es_jefe_planta`), `snapshotIngenieros` (activa, excluye JdT/Gerente), variantes "DelDia" (F16), `snapshotGerentesProduccion` (D-026).
- **Vistas**: `v_ingenieros_en_turno` (`db.js:1091`), `v_jdt_actual` (`db.js:1101`).
- **Conformación** (`conformacion-snapshot.js`): builder agrupa sesiones cuyo `inicio_sesion` ∈ ventana del turno (D-003), `fin_efectivo = cerrada_en` o fin de ventana. Disparo: `turno-sweeper.js` (cron 60s, **NO toca `sesion_activa`**) + trigger manual `POST /api/conformacion-turno/trigger` (gated). Lectura `GET /api/conformacion-turno`.

---

## 6. Administración de usuarios — NO existe CRUD
No hay endpoints `/api/usuarios` ni `/api/admin`. Las únicas escrituras a `lov_bit.usuario` son
seed/migración en `db.js`. Gestión = **seed declarativo idempotente**:
- Alta/edición: editar `personal-2026.json` + reiniciar (UPSERT por `username`; MATCHED fuerza `activo=1`).
- Password: todos nacen `'1234'`; **no hay endpoint de cambio ni reset**.
- Baja: no hay flujo expuesto; el seed re-activa (`activo=1`) a quien siga en el JSON cada arranque.
- Asignación de cargo a usuario: no existe (cargo se elige por sesión).

---

## 7. Hallazgos de seguridad / riesgos para el refactor

1. **Token = entero IDENTITY secuencial sin firma** (`X-Sesion-Id`). Predecible, viaja en claro,
   sin nonce ni binding a IP/UA. Quien ponga un `sesion_id` de una sesión `activa=1` ajena queda
   autenticado como ese usuario. `loadSession` solo valida existencia + `activa=1`. **Punto más débil.**
2. **`select-context` no liga login con creación de sesión.** Es `skipAuth` y confía en el
   `usuario_id` del body — cualquiera puede crear sesión para cualquier `usuario_id` válido **sin
   conocer su password**. Login (paso 1) y creación de sesión (paso 2) están desacoplados.
3. **`select-context` no valida entitlement de cargo.** Solo verifica que el cargo exista; cualquier
   usuario puede abrir sesión con cualquier cargo (no hay relación usuario↔cargo en BD).
4. **Logout sin auth.** `POST /api/auth/logout` es `skipAuth` y solo necesita `sesion_id` en el body
   → se pueden cerrar sesiones ajenas (DoS menor).
5. **Rehash rompe el centinela de SISTEMA.** En el 2º+ arranque, `migrateSchemaV2` (`db.js:223-226`)
   selecciona filas `NOT LIKE 'scrypt$%'` e incluye `'!disabled!'` de SISTEMA → lo rehashea a
   `scrypt('1234')`. No explotable hoy (login filtra `activo=0`), pero el invariante documentado se
   rompe en silencio. Conviene excluir SISTEMA del rehash o usar un centinela que sí matchee el filtro.
6. **Timing oracle leve en login** (`server.js:129`): si el usuario no existe se hace short-circuit y
   no se llama `verifyPassword` → respuesta más rápida que con usuario válido + password errada.
7. **Password inicial universal `'1234'`** y sin rotación forzada.
8. **CORS `Allow-Origin:*`** (`http.js`) — viable hoy porque no usa cookies, pero a revisar si el
   refactor introduce credenciales por cookie.

---

## 8. Inconsistencias documentales (RF v1.0 congelado vs realidad)
1. **Sesión**: RF-003/005/006/007, RN-09, §3.3/§3.4, glosario "TTL"/"authReady" describen TTL 5min +
   heartbeat + resume + sendBeacon + barrido — **todo derogado por D-003/F9**. El código solo valida `activa=1`.
2. **Login email→username**: RF-001/§6 dicen email; el código y MODBD §2.3 usan `username` (email nullable).
3. **bcrypt vs scrypt**: comentarios dicen bcrypt; el algoritmo real es scrypt (`password.js`).
4. **id3 del glosario**: glosario dice "Ingeniero Químico"; seed MODBD §2.2 dice "Ingeniero de Planta de Agua" (cargo obsoleto, eliminado en `db.js:619`).
5. **Cargos**: RF lista 4; el catálogo real tiene 12 (incl. D-027/D-029).
6. **"83 usuarios"** (`db.js:1087`,`:2022`): el JSON tiene 81 (+SISTEMA = 82).

---

## 9. Resumen para el refactor
- **Modelo cargo-por-sesión, no cargo-por-usuario**: el cambio más estructural si se quiere RBAC real.
- **Token inseguro**: migrar a JWT/sesión firmada o al menos id opaco aleatorio + binding.
- **Acoplar login↔select-context**: la creación de sesión debe exigir prueba del login.
- **Matriz reconstruida en arranque**: cualquier modelo de permisos nuevo debe vivir en el CTE de `matrizTx`, no en seeds one-shot.
- **Sin admin UI**: gestión de usuarios es por JSON + restart; si el refactor pide gestión en runtime hay que construirla de cero.
