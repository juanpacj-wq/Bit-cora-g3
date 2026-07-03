# AUDSEG-PIPELINE — ESTADO (tracker vivo)

> Pipeline de remediación de `BIT-AUDSEG-2026-001.md`. Rama: `sec/audseg-remediation`.
> Fuente de verdad del estado "solucionado": el tablero de `BIT-AUDSEG-2026-001.md` (⬜→✅).
> Este archivo registra rama/commit/resultado-de-verificación por ítem y el avance por olas.
>
> Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho+verificado · ⛔ bloqueado (humano/infra) · ⏭️ diferido.

## Precondiciones (Ola 0)
| Paso | Estado | Nota |
|---|---|---|
| PRE-1 commit WIP | ✅ | `ed83d85` checkpoint feat/login-entra-id (39 archivos). Árbol limpio. |
| PRE-2 rama + scaffolding | ✅ | rama `sec/audseg-remediation` desde `423591c`; baseline auditoría versionado; este tracker. |
| Conectividad BD (verificación) | ✅ | BD alcanzable (`SELECT 1` ok). Login `db_owner` pero SIN `dbcreator/sysadmin` → no puedo crear `PortalG3_test`. |
| AUD-33 (enabler) | 🟡 | Borrados destructivos GEC3 gateados tras `TEST_DB_DEDICATED=1` (`cd9fb8f`). BD de test dedicada = infra (DBA). |

## Avance por olas
| Ola | Estado | Ítems |
|---|---|---|
| 0 Precondiciones | ✅ | PRE-1✅ PRE-2✅ conectividad✅ AUD-33🟡(mitigado+runbook) |
| 1 P0 secretos/PII | ✅ | AUD-04✅ · AUD-01/02/03🟡 (código `4a96531`; rotación+purga = checkpoint humano, runbook en ficha) |
| 2 Auth/routing | ✅ | AUD-05✅ AUD-06✅ (`30b9447`); AUD-34/AUD-35 ✅ (D-037, ronda arq. dedicada — routing unificado en Express) |
| 3 Transporte/sesión | ✅* | AUD-09✅ AUD-22✅ (`1903579`); AUD-07🟡 (código+warn, cert=infra); AUD-13🟡 (documentado, ronda dedicada) |
| 4 Scraper/WS | ✅* | AUD-14/25/26/36/42 ✅, AUD-08/21 🟡 (`0013f52`); follow-ups: worker_thread, canal TLS (infra), DELETE SIS, auth WS por cookie |
| 5 Authz/BD | ✅* | AUD-10/11/29/30/31 ✅ (`d26bf84`,`9602416`,`dddfab1`); AUD-18 🟡 (token opcional, cierre=cross-repo); AUD-12 🟡 (infra/DBA, runbook) |
| 6 Endurecimiento | ✅ | 13/13 ✅ (`c7ac622`). Tests puros olas 2-6: 51/51 verde. |
| 7 Arquitectura/cierre | ✅* | AUD-37✅ (ws 8.18→8.21 CVE, engines, npm audit) AUD-38✅ (drift docs); ADR D-036; falta /security-review final |

## Tally final
- **✅ 24** resueltos en código + test: AUD-04,05,06,09,10,11,14,15,16,17,19,20,22,23,24,25,26,27,28,29,30,31,32,36,38,39,40,41,42,37 (y AUD-33 mitigado).
- **🟡 7** parcial + runbook: AUD-01 (rotación/purga historial), AUD-07 (cert TLS), AUD-13 (cifrado sesión), AUD-18 (token cross-repo), AUD-12 (split logins BD), AUD-08 (worker/canal SIS), AUD-21 (handshake WS por cookie). + AUD-02/03 (archivo fuera del árbol; purga de historial = checkpoint AUD-01). + AUD-33 (BD test dedicada = infra).
- **✅ AUD-34/AUD-35** (refactor arq., cerrado post-pipeline en **D-037**): split de `server.js` + routing unificado en Express.
- Tests puros nuevos: 51/51 verde. Build prod verde. server npm audit: 0 vulns.
- **`/security-review` final (gate de cierre):** revisó toda la rama (SQLi, bypass auth, CORS/CSRF/CSWSH, OIDC, XXE, SSRF, escalada de revalidación) → **0 vulnerabilidades de alta confianza introducidas**. La remediación no agrega regresiones; los puntos débiles restantes son los 🟡/⬜ ya documentados.
- **PIPELINE COMPLETO.** Acciones humanas pendientes (irreversibles/infra/cross-repo) listadas en los runbooks de las fichas 🟡.

## Regresión post-remediación corregida (2026-06-30)
El login en dev quedó roto (bucle de logout / no se podía entrar). Dos cambios de la remediación
chocaron con el setup de dev y se corrigieron:
- **AUD-05** puso gate `loadSession` (sesión de app) en `/api/catalogos/jefe` y `/api/catalogos/jdt-actual`,
  pero `useCatalogos` los pide en la pantalla de **selección de planta**, ANTES de que exista `sesion_activa`
  → `loadSession`=null → 401 → `useApi` dispara `logout()` global → bucle. **Fix:** esos dos catálogos
  ahora se gatean por **autenticación Entra** (`req.session.user.oid`), no por sesión de app (siguen sin
  exponer PII a anónimos). Los endpoints operativos (registros/históricos/autorizaciones) conservan `loadSession`.
- **AUD-19/AUD-21** (CSRF mutadores + anti-CSWSH WS) comparan `Origin` contra el `Host` del request. El proxy
  de Vite con `changeOrigin:true` reescribía `Host` a `:3002` mientras el navegador manda `Origin :5174`
  → 403 en todo POST / WS rechazado. **Fix:** `changeOrigin:false` en `vite.config.js` (dev) → `Host==Origin`.
  Prod (same-origin real) no se toca y los checks siguen estrictos (verificado: cross-site → 403).

## Avance post-cierre (uno por uno con el usuario)
- **AUD-01 ✅ (completado)**: secreto purgado de TODO el historial con `git filter-repo` + force-push;
  `.env.example` quedó en blanco en cada commit; `G3c3lc4` no aparece en `origin/main`. (El usuario
  decidió no rotar la clave en vivo; ya no está expuesta en git.)
- **AUD-21 ✅ (completado)**: handshake WS autenticado por la **cookie de sesión Entra** (no por el
  `sesion_id` IDENTITY enumerable). Nuevo `server/auth/wsSession.js` resuelve la cookie firmada contra
  el MISMO store+secreto de express-session (compartidos vía `setWsSessionContext`), y deriva la planta
  de la sesión de app ACTIVA del usuario. Ambos canales (`/ws/usuarios-activos`, `/ws/conteo-bitacoras`)
  rechazan sin cookie (401) y cross-origin (403). MemoryStore de dev ahora es instancia explícita para
  poder compartirse. Verificado: 10/10 tests puros (cookie manipulada/secreto erróneo → rechazada),
  y EN VIVO contra el backend — sin cookie→401, origin ajeno→403, con cookie válida→snapshot por planta.
- **AUD-08 ✅ (parte de código completada)**: el parser `.xls` ahora corre en un `worker_thread`
  (`server/utils/sis/parse-isolated.js` + `xls-parser-worker.js`) con tope de heap
  (`maxOldGenerationSizeMb`, env `SIS_PARSE_MAX_HEAP_MB`) y timeout que TERMINA un parseo runaway
  (env `SIS_PARSE_TIMEOUT_MS`). Un `.xls` hostil ya no puede colgar el event loop ni reventar la
  memoria del proceso; en el peor caso muere el worker. `sis-client.js` usa `await parseXlsIsolated`.
  El endurecimiento del parser (validaciones OLE2/BIFF8) ya estaba. Tests: 3/3 (transfer+resolve,
  propagación de error, timeout). **Residual (infra/red, fuera de código):** el canal SIS sigue siendo
  HTTP plano no autenticado (MITM) — eso es endurecimiento de red del host SIS, no del backend.
- **AUD-13 ✅ (completado)**: cifrado en reposo del blob de sesión en `[auth].[AppSessions]` (antes en
  claro, con tokens MSAL + identidad). `server/auth/sessionCrypto.js` (AES-256-GCM, clave de
  `SESSION_ENC_KEY` o derivada de `SESSION_SECRET`) + subclase del store mssql que cifra en `set` /
  descifra en `get`; filas legacy en claro siguen leyéndose → migración sin downtime. Verificado:
  5/5 tests puros (round-trip, GCM detecta tampering, legacy passthrough, la fila no lleva identidad en
  claro) y EN VIVO contra la BD — la columna `session` guarda `{"cookie":…,"__enc":"enc1:…"}` sin oid/token
  en claro, y `/api/me` con la cookie descifra y responde `authenticated:true`. Solo aplica al store mssql
  (el de memoria es dev). **Hallazgo lateral (anotado, NO de AUD-13):** si el store mssql falla la conexión,
  el error sube al handler por defecto de Express y filtra el host de BD en HTML — el saneo D-032 cubre el
  if-chain pero no la capa Express/express-session. Candidato a una pasada de error-handler en `auth/app.js`.
- **D-032 / capa Express ✅ (hallazgo lateral cerrado)**: nuevo `expressErrorHandler` en
  `server/utils/errores.js` (error-middleware de 4 args, reusa `responderError`) registrado de ÚLTIMO en
  `buildAuthApp` (`auth/app.js`), después del catch-all que delega al if-chain. Cierra el hueco: un error
  propagado por el middleware de express-session (store mssql sin BD) ya NO sube al handler por defecto de
  Express (que renderizaba el stack en HTML y filtraba `Failed to connect to 192.168...\mssqlg3`); ahora se
  clasifica → loguea server-side → responde `{ error, codigo, mensaje }` saneado (503 `db_no_disponible`).
  Verificado: 3 tests end-to-end nuevos en `errores.test.js` (Express real + el handler exportado: conexión
  → 503 sin filtrar host; genérico → 500 sin filtrar detalle; camino feliz intacto). Suite `errores` 10/10.
- **AUD-34 / AUD-35 ✅ (completados — ADR D-037)**: ronda arquitectónica dedicada. Migración strangler del
  if-chain (`legacyHandler`) a **routers Express por dominio** (E1–E10): `server/routes/*.js` (catálogos,
  cierre, históricos, autorizaciones, eventos-dashboard, conformación, combustibles, disponibilidad, MAND,
  registros —con rama DISP inline, D-026—, bitácora, sesión) montados en `auth/app.js` antes del catch-all.
  E11 borró `legacyHandler` + `parseBody`, hoistó `express.json` a global (post-auth, 1 MB) y dejó
  `server.js` en **bootstrap** (~73 líneas, era ~2849). **Fix estructural de AUD-05:** middleware global
  `requireEntra` (`routes/_middleware.js`) cierra el acceso anónimo salvo allowlist pública → auth por
  defecto. Pipeline único: `session → cors → csrf → /health → auth → requireEntra → express.json → routers
  → 404 → expressErrorHandler`. **Verificación "proceder ahora"** (decisión del usuario): por etapa
  `node --check` + tests puros (`routes_middleware` 8/8, suite pura 68/68) + smoke autenticado en `:3099`
  contra planta `'TST'` (D-030, sin tocar `:3002` ni datos reales). **Residual:** la suite HTTP completa
  (`server npm test`) sigue diferida a la BD de test dedicada (AUD-33). Commits `19ed9ae` (E10) + E11.

## Bitácora por ítem (rellenar a medida)
<!-- AUD-NN | estado | commit | verificación | residual humano/infra -->
