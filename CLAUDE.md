# CLAUDE.md — Bit-cora-g3

Sistema web de bitácoras operativas para plantas térmicas Gecelca (GEC3 y GEC32). Reemplaza el registro manual en Excel con trazabilidad, control de turnos y un contrato de eventos hacia el dashboard productivo (`dashboard-gen-gec3/`).

**Repo git independiente.** Su raíz `Bit-cora-g3/` tiene su propio `.git/`. NO es un submódulo del workspace umbrella; convive en disco con `dashboard-gen-gec3/` bajo `PORTAL GENERACIÓN/`.

## Inicio rápido — qué leer

- **Detalle de arquitectura**: `docs/architecture.md` (capas, módulos, schemas, mecánica por bitácora).
- **Decisiones**: `docs/decisions.md` (ADR-lite F1–F22).
- **Glosario**: `docs/domain-glossary.md` (MAND, CIET, DISP, AUTH/REDESP/PRUEBA, periodos, turnos, cargos).
- **Modelo de BD autoritativo**: `BIT-MODBD-2026-001.md` (en la raíz del repo).
- **Requerimientos funcionales**: `BIT-RF-2026-001.md`.
- **Contrato cross-repo**: `../docs/interfaces-cross-repo.md` (cómo Bitácora habla con dashboard-gen-gec3).

## Commands

- `cd Bit-cora-g3 && npm run dev` — frontend Vite (puerto 5174, fijo por `strictPort` para el redirect de Entra).
- `cd Bit-cora-g3 && npm run build` — build a `dist/`.
- `cd Bit-cora-g3 && npm run lint` — ESLint.
- `cd Bit-cora-g3/server && node --watch --env-file=../.env server.js` — backend en modo desarrollo (puerto 3002).
- `cd Bit-cora-g3/server && node --test --env-file=../.env tests/` — tests (vitest patrones, `node:test` runner).

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 19, Vite 5, TailwindCSS 3, lucide-react |
| Backend | Node.js ≥20 ESM, **Express** (routing único, D-037: `auth/app.js` compone el pipeline; handlers en `routes/*.js`), `node:test`, `--env-file` |
| BD | SQL Server 2019+ (`mssql` con `useUTC=true`). Esquemas `lov_bit` (catálogos) + `bitacora` (transaccional). |
| Build | Vite frontend; Node directo backend (sin bundler) |

## Estructura

```
Bit-cora-g3/
├── src/                       Frontend (React)
│   ├── BitacorasGecelca3.jsx  Layout principal + routing por bitácora.codigo
│   ├── components/
│   │   ├── SalaDeMando/SalaDeMandoGrid.jsx   UI MAND (formulario_especial=1)
│   │   ├── Disponibilidad/*                  UI DISP (mini-dashboard)
│   │   ├── GrillaRegistros.jsx               UI genérica para otras bitácoras
│   │   ├── BarraEstado.jsx                   Filtros F11 (fecha+turno)
│   │   └── historicos/HistoricoTable.jsx
│   └── hooks/
│       ├── useAuth.js, useBitacoraSesion.js, useUsuariosActivos.js
│       ├── useDisponibilidad.js, useSalaDeMando.js
│       └── useApi.js
├── server/                    Backend (Node ESM, Express — D-037)
│   ├── server.js              Bootstrap (initDB → buildAuthApp → http.Server + WS → sweepers → listen)
│   ├── auth/app.js            Compositor Express: sesión + /auth OIDC + requireEntra + montaje de routers
│   ├── db.js                  Conexión + initDB() idempotente (DDL, seeds)
│   ├── middleware/auth.js permissions.js
│   ├── routes/                Un router por dominio + _middleware.js (requireEntra/loadAppSession/asyncH), _shared.js
│   ├── utils/
│   │   ├── turno.js           getTurnoColombia, turnoFromPeriodo, colombiaParts
│   │   ├── fecha.js           helpers TZ Bogotá
│   │   ├── snapshots.js       snapshotJDTs/Jefes/Ingenieros
│   │   ├── notificador.js     evento_dashboard + disponibilidad_dashboard helpers
│   │   ├── ciet.js            registrarEventoCierre
│   │   └── mand-sweeper.js    Cron interno c/60s, cierre automático MAND
│   └── tests/
├── sql/snippets/              Queries auxiliares para SSMS
├── BIT-MODBD-2026-001.md      Modelo BD autoritativo
├── BIT-RF-2026-001.md         RFs (RF-001..RF-065 + RN-01..RN-14)
└── docs/
    ├── architecture.md
    ├── decisions.md
    └── domain-glossary.md
```

## Bitácoras especiales

Dos bitácoras tienen UI propia (resto usa `GrillaRegistros` genérica):

- **MAND** (Operación 24h) — `SalaDeMandoGrid.jsx`. Grilla 24p × 3 tipos × 2 plantas. Batch save atómico via `POST /api/sala-de-mando/guardar`. Cierre automático fin de día via sweeper diario. Solo HOY editable. No se cierra por turno (excluido del cierre de turno vía `codigo NOT IN ('DISP','MAND')`).
- **DISP** (Disponibilidad) — `DisponibilidadDashboard.jsx`. Mini-dashboard con tabs GEC3/GEC32, counter live "tiempo en estado", panel de acumulado histórico por estado (D-028, fuente `/api/disponibilidad/metricas`; vigente crece en vivo, resto congelado), historial paginado. Sin cierre de turno. Storage: tabla dedicada `bitacora.disponibilidad_estado` (D-026), 1 vigente por planta vía filtered unique index `UQ_disp_estado_vigente_por_planta`. Cierre automático cuando llega nuevo evento (UPDATE `fecha_fin_estado` del vigente + INSERT del nuevo en la misma transacción).
- **COMB** (Consumos de Combustibles) — `Combustibles/ConsumosGrid.jsx`. Pestaña bajo categoría jerárquica "Combustibles" en el sidebar. Grilla 24 periodos × N combustibles dinámicos por planta (8 GEC3 / 10 GEC32 desde `lov_bit.combustible`). Selector de fecha (default hoy, futuro bloqueado con 400 `fecha_futura`). Total Carbón calculado live (`SUM(tipo='ALIMENTADOR')`). Batch save atómico vía `POST /api/combustibles/consumos`. Permisos: crean `Operador de Planta - Carbón y Caliza` + JdT; resto ven. NO es una bitácora — es un report numérico. D-027. **Piel "Blueprint Heatmap" (D-033):** restyle solo-front scopeado bajo `.comb-root` (`combustibles.css`) + fuentes `@fontsource` locales (Archivo/Inter/JetBrains Mono, sin CDN); heatmap con escala fija `HEATMAP_MAX_TON=25` solo en columnas alimentador, rampa única `HEATMAP_RAMP` compartida por `tint()` y la leyenda (`colores.js`). Lógica intacta.

Las demás (CIET, AUTOR, etc.) usan `GrillaRegistros.jsx` con filtros F11.

## Conformación de turno

Al cierre de cada turno (T1/T2 por planta GEC3/GEC32) se escribe snapshot inmutable a `bitacora.conformacion_turno` con quién operó: usuario, cargo, inicio/fin de sesión, duración. Trigger híbrido: `turno-sweeper.js` (F4) extendido + catchup al arranque (últimos 7 días Bogotá). Endpoints `GET /api/conformacion-turno` (cualquier rol) y `POST /api/conformacion-turno/trigger` (gated JdT/IngOp/Jefe Planta). Builder filtra sesiones cuyo `inicio_sesion` cae dentro de la ventana del turno — D-003 fija el turno al login. Ver D-025 y BIT-MODBD §4.7. **D-044 (blindaje anti-sintéticos):** el builder EXCLUYE `lov_bit.usuario.es_sintetico=1` (fixtures `test_*`, marcados por seed idempotente) — la suite corre contra la BD prod (D-030) y sembraba sesiones test en GEC3/GEC32, que el builder grababa en el histórico inmutable. `buildConformacionSnapshot` sólo incluye sintéticos si se le pasa `incluirSinteticos:true` — **exclusivo de unit tests**, custodiado por guardrail estático; producción nunca lo pasa. NUNCA quitar el filtro. La "diferencia de 1 día" T2 (`fecha_operativa`=día de inicio vs `snapshot_en` del día siguiente) NO es bug: T2 cruza medianoche. Ver D-044.

## Convenciones críticas (no obvias)

1. **Dos sesiones separadas (D-031, login Entra ID)**: (a) la **sesión de login Entra** es una cookie httpOnly larga (store MSSQL `[auth].[AppSessions]`) — la identidad; (b) la **sesión de app** es la fila `bitacora.sesion_activa`. El `turno-sweeper` **expulsa** la sesión de app a fin de turno (`activa=0`, esto **invierte** la regla vieja "TTL ninguno / activa=1 hasta logout"), pero NO toca la cookie: reentrar reactiva `sesion_activa` (refrescando `inicio_sesion`+`turno`) sin re-login. `ultima_actividad` sigue sin regir TTL. La identidad NO viaja en `X-Sesion-Id` (eliminado en prod); `loadSession` resuelve por `req.session.user.oid`.
2. **Snapshots JSON inmutables**: `jdts_snapshot`, `jefes_snapshot`, `ingenieros_snapshot` en JSON. NO usar FK directo a `lov_bit.usuario` para reconstruir presencia. Solo `creado_por` y `modificado_por` son FK.
3. **2 turnos solamente** (no 3): T1 [06,17], T2 [18,23]∪[00,05]. Cualquier mención a "3 turnos" es narrativa, no datos.
4. **DISP vive en `bitacora.disponibilidad_estado` (D-026, post-2026-05-20)**: tabla dedicada con `fecha_inicio_estado`/`fecha_fin_estado` tipadas (no via `campos_extra` JSON). Mantiene la regla de cierre cronológico: PUT del vigente que cambia `fecha_inicio_estado` actualiza también `N-1.fecha_fin_estado`. La "excepción a la inmutabilidad histórica" de D-011 ya no aplica porque DISP no vive en `registro_historico` — el N-1 es otro row de la misma tabla. Acumulados por estado expuestos via vista `v_disponibilidad_estado` con window functions. La vista `disponibilidad_dashboard` (cross-repo, F15) preserva su shape mapeando `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot`. **D-041:** `disponibilidad_dashboard`/`autorizacion_dashboard`/`v_disponibilidad_estado` son **vistas de SOLO LECTURA** — trigger `INSTEAD OF … THROW` en la BD las hace inescribibles (un `DELETE` por la vista cascaba a la tabla base y borraba el vigente real). Escribí SIEMPRE la tabla base (`disponibilidad_estado`/`evento_dashboard`), nunca la vista.
5. **MAND `modificado_por` se actualiza SOLO si `valor_mw` cambió** (no si solo cambió detalle/funcionariocnd). D-019.
6. **AUTH requiere `funcionariocnd`** (si hay valor en algún periodo). PRUEBA y REDESP fuerzan `funcionariocnd=NULL`. D-018.
7. **Lock REDESP**: solo `periodo >= floor(horaBogota) + 1` ("actual o posteriores") editable. AUTH y PRUEBA sin lock. D-016.
8. **Usuario SISTEMA** (`activo=0`, `password_hash='!disabled!'`) seedeado para CIETs automáticos del sweeper MAND. NUNCA loguea. D-015.
9. **TZ canónica**: BD en UTC, presentación en Bogotá explícito (`Intl.DateTimeFormat` con `timeZone`). Comparaciones de día Bogotá en SQL con `CAST(DATEADD(HOUR, -5, columna) AS DATE)`. D-020.
10. **No node_modules en búsquedas**: si necesitás grep, excluí siempre `node_modules/`.
11. **Combustibles (D-027)**: catálogo `lov_bit.combustible` por planta (`codigo, nombre, unidad, tipo`). El campo `tipo` es discriminador (`ALIMENTADOR/CALIZA/ACPM`) usado por la vista `bitacora.v_consumo_periodo` para calcular `total_carbon_ton = SUM(WHERE tipo='ALIMENTADOR')`. Storage en `bitacora.consumo_combustible` long-format (1 fila por celda planta+fecha+periodo+combustible). `modificado_por` solo se actualiza si `cantidad` cambió, no si solo cambió `detalle` (paridad D-019 con MAND). Para agregar/quitar un combustible: editar seed en `db.js` (F26.B1) + matriz canónica de permisos si afecta cargos + redeploy — sin CRUD admin. Permisos COMB sobreviven a restarts porque la matriz de §2.6 BIT-MODBD se extendió con CASE clauses para `b.codigo='COMB'`. Crean en COMB: `Operador de Planta - Carbón y Caliza`, `Ingeniero Jefe de Turno` y `Coordinador de carbón y maquinaria` (D-029). **Límite físico por combustible (D-034):** columna `lov_bit.combustible.cantidad_max` (migración `F28.A1`; ALIMENTADOR=25, CALIZA=40, ACPM=25000 Gal; `NULL`=sin tope). Data-driven: los GET la exponen, el POST rechaza `cantidad > cantidad_max` con `cantidad_excede_max` y el front marca la celda + bloquea Guardar. Para cambiar un tope: editar el `UPDATE` de la migración + redeploy. **Pendiente (próxima fase):** tope agregado de Total Carbón por periodo/planta (`carbon_max_periodo_ton` en `lov_bit.planta`, 150/200) + editabilidad de alimentadores según la unidad del login.
12. **Cargos y matriz de permisos (`lov_bit.cargo` + `cargo_bitacora_permiso`)**: la matriz se **reconstruye desde cero en CADA arranque** (`db.js`, transacción `matrizTx`, bloque `WITH matriz AS`, matchea por `c.nombre` no por id). Para crear un rol: agregarlo al `MERGE` de cargos **y** a las CASE clauses de `puede_ver`/`puede_crear` — un seed one-shot no basta, el siguiente restart lo dejaría sin permisos. El frontend es data-driven (`/api/catalogos/permisos/:cargo_id`); `puede_cerrar_turno`/`solo_lectura` se leen del cargo. Último rol: `Administrador y Debugging` (D-039). **D-039 (rol ADMIN):** `Administrador y Debugging` (App Role `ADMINISTRADOR_DEBUGGING`) tiene acceso TOTAL — `puede_ver=1` y `puede_crear=1` en todas las bitácoras activas + `puede_cerrar_turno=1` + `solo_lectura=0` — modelado por la MISMA matriz data-driven (NO por bypass; toda acción queda atribuida). Su cláusula va **primero** en ambos CASE y **primero** en `PRECEDENCE`. **Gotcha:** el override defensivo DISP (F12.A6) recomputa `puede_crear` de toda fila DISP, así que un cargo que deba crear en DISP debe estar en ese `IN (...)`, no solo en la matriz. No añade hard-delete de históricos (append-only por auditoría). **D-031:** el cargo ya NO se elige en el login — se asigna automáticamente desde el App Role de Entra (`server/utils/entra-roles.js` mapea value→`cargo.nombre`, 1:1 con los 13 cargos, y resuelve por precedencia si hay multi-rol; sin rol → 403). `select-context` deriva `cargo_id` del token, no del body. Un rol nuevo necesita además su entrada en `ROLE_TO_CARGO`/`PRECEDENCE` y el App Role correspondiente en Entra.
15. **Login Microsoft Entra ID (D-031)**: OIDC server-side (`@azure/msal-node`, Auth Code + PKCE) en `server/auth/app.js`, que tras D-037 es el **compositor Express de toda la app** (ya no un wrapper solo-`/auth`). Identidad auto-aprovisionada por `azure_oid` (`lov_bit.usuario.azure_oid/upn/tid`; `password_hash` nullable; `personal-2026.json`/`seedPersonal` retirados). Singletons `es_jefe_planta`/`es_jdt_default` por UPN (`M365_*_UPNS`), no por App Role. Tests: backdoor `AUTH_TEST_BYPASS=1` en `loadSession`/`requireEntra` (resuelve por `X-Sesion-Id`) — **solo** para el harness, nunca en prod.
18. **Routing unificado en Express (D-037, AUD-34/35)**: modelo ÚNICO — se eliminó el if-chain nativo (`legacyHandler`) y `parseBody`. `buildAuthApp` (`auth/app.js`) compone `session → corsMiddleware → csrfMiddleware → /health → auth (login/redirect/me/logout) → **requireEntra** → express.json (global, 1 MB) → routers de dominio (`routes/*.js`) → 404 → expressErrorHandler`. **Auth por defecto:** `requireEntra` (`routes/_middleware.js`) cierra el acceso anónimo salvo una **allowlist pública explícita** (`esRutaPublica`: `/health`, catálogos no-PII, `eventos-dashboard`); un endpoint nuevo nace cerrado. Patrón por router: `router.use(loadAppSession)` (setea `req.sesion` o 401) + handlers envueltos en `asyncH` (throw → `expressErrorHandler`); `req.body`/`req.query`/`req.params` en vez de `parseBody`/`url.searchParams`/regex. `server.js` quedó en bootstrap. Añadir un endpoint = editar/crear su `routes/<dominio>.js` y montarlo en `app.js` (NO tocar `server.js`); si debe ser anónimo, agregarlo a la allowlist de `_middleware.js`.
13. **Ciclo de vida del scaffolding de feature**: las carpetas `prompts/D-0XX-*` y los `PREGUNTAS-D-0XX.md` son andamiaje **efímero** para ejecutar una ronda de implementación. Una vez mergeada la feature y volcada su decisión a `docs/decisions.md` (ADR) + `BIT-MODBD` + este archivo, **se borran** (`git rm`). El historial de git los conserva recuperables (`git show <commit>:<path>`); no se archivan copias ni zips. La metodología/plantillas genéricas viven fuera del subrepo, no acá.
16. **Saneamiento de errores (D-032)**: NUNCA devolver `err.message` crudo en una respuesta — filtra internals (host/instancia/puerto de la BD, config OIDC) y es incomprensible. Todo error inesperado pasa por `server/utils/errores.js` (`responderError`/`mensajeUsuario`): clasifica (conexión BD → 503 `db_no_disponible`, timeout → `db_timeout`, SQL → `db_error`, body no-JSON → `cuerpo_invalido`, resto → `error_interno`), loguea el detalle server-side y responde `{ error, codigo, mensaje }` con texto amigable en español + `codigo` estable. El frontend ramifica por `codigo`, nunca por texto. **Excepción:** los 409 de DISP exponen su `error`-slug (`mismo_estado`, etc.) + `vigente`/`n_menos_1` a propósito (el modal los usa) — saneá solo los caminos 5xx/inesperados. El rechazo de `fetch` (servidor caído) se traduce a `codigo:'sin_conexion'` en `useApi`/`useDisponibilidad`.
14. **Planta de test `'TST'` (D-030)**: la suite corre contra la BD productiva. Constante `TEST_PLANTA_ID` en `db.js`; los tests de DISP siembran esa planta (`setupSessions({ planta })` en `tests/helpers.js`) y operan **solo** sobre ella, nunca sobre GEC3/GEC32 — así ninguna corrida destruye disponibilidad real (el `cleanDisp` que borraba por `planta_id='GEC3'` era el bug). El leak cross-repo se corta en `GET /api/eventos-dashboard` (devuelve vacío para `'TST'`); las vistas DISP **no** la filtran porque los tests de acumulados dependen de ellas. Gotcha: la fila `'TST'` queda residente en `lov_bit.planta` (fixture, como SISTEMA). **`auth_middleware.test.js` migrado a `TEST_PLANTA` (2026-07-03):** posteaba DISP a `PLANTA_ID='GEC3'` y cada POST cerraba el vigente REAL de GEC3 + creaba un sucesor tagueado que `cleanupTestRegistros` borraba → GEC3 quedaba **sin vigente** ("Sin estado registrado" en el dashboard pese a haber historial). Reparación de datos: reabrir el último estado (`fecha_fin_estado=NULL`) restaura el vigente. **D-041 (2026-07-03) — segunda recurrencia, causa REAL + blindaje:** el vector no era un POST DISP sino un **DELETE a través de la VISTA `disponibilidad_dashboard`**. Esa vista es *updatable* (una sola tabla base) → `DELETE FROM disponibilidad_dashboard WHERE planta_id='GEC3'` **cascada a `disponibilidad_estado`** y borra el vigente. `cierre_y_fechas.test.js` corría en GEC3 y su `cleanAll` hacía justo eso (¡sin siquiera escribir DISP!). Blindaje: (1) trigger `INSTEAD OF … THROW` en `disponibilidad_dashboard`/`autorizacion_dashboard`/`v_disponibilidad_estado` → **vistas de solo lectura a nivel BD** (`db.js` initDB, idempotente); (2) `cierre_y_fechas` migrado a `TEST_PLANTA`; (3) `cleanupTestRegistros` acota DISP a `TEST_PLANTA` y escribe la base `evento_dashboard` (no la vista); helper `cleanDispTestPlanta()`; (4) guardrail estático `guard_no_prod_disp_destruction.test.js` (no DML por vistas dashboard; no literal de planta real en `disponibilidad_estado`). **Regla dura:** nunca `INSERT/UPDATE/DELETE` sobre una vista dashboard — siempre la tabla base; toda limpieza DISP va por `cleanDispTestPlanta()`/`TEST_PLANTA`. Ver D-041. **Pendiente:** `sala_de_mando_batch`/`consumos_combustible` aún escriben/borran `registro_activo` por `planta_id='GEC3'` (registros, no DISP → no borra disponibilidad); no migrado.
17. **Navegación = hash, fuente única (D-035)**: la sección activa + su subestado viven en la URL (`#/op24h`, `#/disp?planta=GEC3`, `#/comb?fecha=YYYY-MM-DD`, `#/b/<codigo>`, `#/historicos`), no en estado local — sobreviven F5 y son deep-linkables. Módulo puro `src/routing/appRoute.js` + hook `src/hooks/useAppRoute.js`; el dashboard (`BitacorasGecelca3.jsx`) deriva su estado desde la ruta (permission-gated, fallback a la primera permitida) y la escribe ante cambios (subestado → `replaceState`, sección → `pushState`). Solo-front, sin react-router. DISP/COMB son **controlados** (`planta`/`onPlantaChange`, `fecha`/`onFechaChange`); se retiró el `sessionStorage` de planta de DISP (doble fuente). El hash NO colisiona con el callback OIDC (`?auth=…` es search, Entra aterriza en `/`). Mismo archivo trae **"Operar otra unidad"** (`auth.clearSesion()`): conserva el login Entra pero **mata la sesión de app** (`POST /api/auth/cerrar-app` → `activa=0`) para que una persona no quede iniciada en 2 unidades → `LoginScreen` paso "planta"; al elegir unidad, `select-context` también desactiva cualquier OTRA sesión activa del usuario (sesión única por persona). Gotcha: la sincronización ruta↔estado usa refs de igualdad para no entrar en loop ni revertir un clic — no metas `activeBitacora` en las deps del efecto "derive".
20. **Cierre de turno = único cierre (D-042)**: NO existe cierre individual por bitácora. El único cierre es el **cierre de turno masivo** (`POST /api/cierre/masivo`, preview `GET /api/cierre/preview-masivo`, botón "Cerrar Turno" en `BitacorasGecelca3.jsx` + `CierrePendientesModal`, hook `useCierre.previewMasivo`/`cerrarMasivoConFinalizacionForzada`). Se eliminaron `POST /api/cierre/bitacora`, `GET /api/cierre/preview`, `useCierre.cerrarBitacora`/`previewCierre` y sus tests. MAND/DISP quedan fuera vía `codigo NOT IN ('DISP','MAND')` (ya no hay rechazos `mand_cierre_individual_no_permitido`/`bitacora_no_cerrable` — el endpoint que los emitía dejó de existir). El cierre cronológico por ventana de turno (D-005) vive ahora solo en el bucle de `/masivo`. NO reintroducir cierre por bitácora. Ver D-042.
19. **Finalización de turno = `sesion_activa.turno_finalizado_en` (D-040)**: fuente ÚNICA, revertible. NUNCA reusar `sesion_bitacora.finalizada_en` (que es **SOLO presencia por-bitácora**) para representar finalización — estaban sobrecargadas y `POST /api/bitacora/abrir` reseteaba `finalizada_en=NULL` en cada apertura, así que *ver* una bitácora des-finalizaba el turno. `POST /api/bitacora/finalizar`/`finalizar-forzado` setean la columna; `POST /api/bitacora/revertir-turno` la limpia (self-service, sin permiso, CIET `reapertura`). Muere sola (sweeper → `activa=0`; `select-context` la resetea a NULL al reactivar — **crítico**: sin ese reset, volver por "Operar otra unidad" a la misma planta dejaba el turno "finalizado"). Write-gate `409 turno_finalizado` **solo en la rama genérica** de `POST/PUT/DELETE /api/registros` (helper inline `bloquearSiTurnoFinalizado` en `_middleware.js`; MAND/DISP/COMB exentos, tienen endpoints propios). `ingenieros_no_finalizados` (cierre JdT) filtra por `sa.turno_finalizado_en IS NULL`. Front: `turnoFinalizado` deriva de `sesion.turno_finalizado_en` (`/api/me`, sin `localStorage`), `useAuth.patchSesion` lo refleja, botón togglea a "Revertir finalización" + banner. **Gate de UI blindado (addendum 2026-07-03):** el gate row-level de `GrillaRegistros` es la clave — `puedeEditar`/`isEditing` llevan `!bloqueado` (prop = `turnoFinalizado`), `RegistroRow` muestra un chip "Bloqueado" (Lock) en vez de Editar/Eliminar y NO entra en modo edición (`onStartEdit` no-op + reset de `editingId`). Sin esto la grilla se veía editable y el descarte de un borrador local (front-only, sin backend) burlaba el 409. Además `handleFinalizarTurno` **bloquea finalizar si hay `_dirty` en la bitácora activa** (borrador/edición sin guardar) con popup "Guárdalo o descártalo antes de finalizar" → flujo **guardar todo → finalizar → solo lectura**. Backend ya estaba blindado (tests de gate ahora cubren PUT/DELETE, no solo POST). **Persistencia por ventana de turno (addendum 2 2026-07-03):** la finalización se acota a la **ventana `[inicio, fin)` del turno actual** (`finalizacionVigente()` en `utils/turno.js`, fuente única). `select-context` ya NO resetea `turno_finalizado_en` incondicionalmente — usa un CASE que **preserva si es la misma ventana** (re-login / volver a la unidad NO reabren el turno) y limpia solo si es de un turno pasado (expira sola al siguiente turno). `permissions.turnoFinalizado` + `loadSession` (serving a `/api/me`) son window-aware; los guards de `/finalizar`·`/revertir-turno`·`/finalizar-forzado` van acotados a la ventana. Alcance **por unidad** (vive en la fila `sesion_activa` de cada `(usuario,planta,cargo)`). Front sin cambios. Ver D-040.

## Contrato con dashboard-gen-gec3

Bitácora escribe `bitacora.evento_dashboard` (AUTH/REDESP/PRUEBA por periodo) y `bitacora.disponibilidad_dashboard` (DISP por planta). El dashboard productivo consume via `GET /api/eventos-dashboard?tipo=&planta_id=` expuesto por **este** backend (puerto 3002).

**Detalle completo: [`../docs/interfaces-cross-repo.md`](../docs/interfaces-cross-repo.md).** No tocar el shape de respuesta sin coordinar con el otro lado.

## Cómo evolucionar este archivo

**Agregá una entrada SOLO cuando:**
- Tomaste una decisión arquitectónica no-obvia (qué + por qué, máximo 3 líneas).
- Encontraste un gotcha que va a morder a alguien en el futuro (ej. orden de migraciones idempotentes, edge case en cierre cronológico).
- Cambió un contrato externo (endpoint cross-repo, schema BD, env var).
- Cambió un invariante del dominio (nueva bitácora, nuevo tipo de evento_dashboard, nuevo cargo).

**NO agreges:**
- Qué hace el código (eso ya lo dice el código bien nombrado).
- Cambios pequeños (refactor, rename, bugfix puntual) — `git log` es suficiente.
- Decisiones grandes — esas van a `docs/decisions.md` con formato ADR-lite (Contexto/Decisión/Consecuencias, 4-8 líneas) y acá solo el resumen + link.
- Transcripciones de discusiones (esto no es un chat log).

**Reglas de tamaño:**
- 1-3 frases por entrada acá; lo demás a `docs/`.
- Si este archivo supera ~250 líneas, hacé una pasada de consolidación.

**Para decisiones grandes**: `docs/decisions.md` con formato ADR-lite. Numerá la decisión (D-NNN siguiendo la secuencia).
