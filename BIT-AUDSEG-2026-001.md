# BIT-AUDSEG-2026-001 — Auditoría de seguridad y arquitectura · Backlog de implementaciones pendientes

> **Qué es esto.** Inventario estricto y verificado de vulnerabilidades de seguridad y deuda de
> arquitectura del repo `Bit-cora-g3`, redactado como **backlog de implementaciones pendientes**
> para resolverse **una por una en chats nuevos** con la metodología de la casa
> (`/nueva-implementacion` → rondas por etapas E1..EN, decisión volcada a `docs/decisions.md` como
> ADR-lite `D-NNN`). No es un changelog ni un chat-log: cada ítem es autocontenido y arrancable.
>
> **Cómo usar este documento.**
> 1. Toma el ítem de mayor prioridad pendiente (empieza por la sección **P0 — Respuesta inmediata**).
> 2. Abre un chat nuevo dentro de `Bit-cora-g3/` y corre `/nueva-implementacion` pegando el ítem
>    (su problema, evidencia y remediación por etapas) como semilla.
> 3. Al cerrar la ronda: volca la decisión a `docs/decisions.md` (siguiente `D-NNN` libre), actualiza
>    `BIT-MODBD`/`CLAUDE.md` si aplica, marca el ítem como ✅ aquí y borra el scaffolding efímero
>    (`prompts/D-0XX-*`) según la regla 13 de `CLAUDE.md`.
>
> **Metodología de severidad.** Crítica = explotable o ya expuesto, impacto directo sobre
> confidencialidad/integridad/disponibilidad productiva. Alta = explotable con condición razonable o
> fuga de datos/PII. Media = requiere posición o configuración; defensa en profundidad ausente.
> Baja = deuda latente, mitigada hoy, o endurecimiento. Cada hallazgo cita **archivo:línea real**.
>
> **Origen.** Auditoría 2026-06-30 sobre la rama `feat/login-entra-id` (commit `543dc92`), seis
> frentes: auth/OIDC/sesiones, router+endpoints, capa BD+migraciones, scrapers SIS, frontend React,
> config/supply-chain. Hereda y NO duplica `docs/auditoria-auth-usuarios-roles-2026-06.md` (los
> hallazgos que **D-031 ya cerró** se anotan como cerrados en AUD-22).
>
> **Numeración ADR sugerida.** Los `D-NNN` propuestos abajo son tentativos (la secuencia real va en
> **D-035**; el siguiente libre es **D-036**). Asigna el número al cerrar cada ronda, en orden de
> ejecución real, no por el número sugerido aquí.

---

## Tablero de prioridades

Leyenda estado: ⬜ pendiente · 🟡 en progreso · ✅ resuelto.

### P0 — Respuesta inmediata (secretos/PII ya expuestos — NO esperar a una ronda formal)

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-01 | ⬜ | **Crítica** | Credenciales productivas de BD en `.env.example` | `.env.example:1-4` |
| AUD-02 | ⬜ | **Alta** | PII de ~80 empleados versionada (código muerto post-D-031) | `server/data/personal-2026.json`, `_build_personal_json.py` |
| AUD-03 | ⬜ | **Alta** | Screenshot de sesión autenticada en sistema externo (XM RIO) | `aut_redesp_y_pruebas.png` |
| AUD-04 | ⬜ | Media | `dist/index.html` versionado pese a `.gitignore` | `dist/index.html`, `.gitignore:2` |

### P1 — Seguridad crítica/alta de la aplicación

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-05 | ⬜ | **Crítica** | Autenticación opt-in: endpoints de datos/PII sin `loadSession` | `server.js:582,2098,2127,2141,2190,2213,536,568,2270` |
| AUD-06 | ⬜ | **Alta** | Backdoor `AUTH_TEST_BYPASS` suplanta por `X-Sesion-Id` enumerable | `middleware/auth.js:26-46`, `utils/http.js:4` |
| AUD-07 | ⬜ | **Alta** | SQL Server sin cifrado (`encrypt:false` + `trustServerCertificate:true`) | `db.js:22-26`, `auth/sessionStore.js:29-34` |
| AUD-08 | ⬜ | **Alta** | Cadena SIS HTTP plano + parser binario hecho a mano sin límites → DoS de todo el backend | `sis/sis-client.js:15`, `sis/xls-parser.js:13,36,44-56,84-114` |
| AUD-21 | ⬜ | **Alta** | Handshake WS fuera de Express: sin cookie ni `Origin` → Cross-Site WebSocket Hijacking | `ws-usuarios-activos.js:59-86`, `ws-conteo-bitacoras.js:60-86`, `server.js:2707-2709` |

### P2 — Seguridad media (posición de red/config o defensa en profundidad)

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-09 | ⬜ | Media | Cookie de sesión sin `Secure` forzado en prod (solo `console.warn`) | `auth/app.js:54,63-64`, `entra-config.js:33-34` |
| AUD-10 | ⬜ | Media | Privilegio (`cargo_id`) congelado sobrevive a revocación en Entra; revalidación fail-open | `auth/revalidate.js:34-56`, `server.js:141` |
| AUD-11 | ⬜ | Media | IDOR cross-planta en DISP (escritura sin `plantaMatch`) | `server.js:659-768,958-1092,2035-2094` |
| AUD-12 | ⬜ | Media | Login de la app con privilegios DDL/DROP (initDB acoplado al arranque) | `db.js:329-2067` |
| AUD-13 | ⬜ | Media | Tokens Entra (incl. refresh) en claro en `[auth].[AppSessions]` | `auth/sessionStore.js:56-69` |
| AUD-14 | ⬜ | Media | Scraper escribe a BD como SISTEMA sin validar rango (NaN/Infinity/`>cantidad_max`/DELETE) | `sis/sis-client.js:84-96`, `sis/carbon-scraper.js:127-145,202-233` |
| AUD-15 | ⬜ | Media | `parseBody` sin límite de tamaño → DoS por memoria | `utils/http.js:7-21` |
| AUD-16 | ⬜ | Media | CORS wildcard `Access-Control-Allow-Origin: *` global | `utils/http.js:1-5`, `server.js:109-112` |
| AUD-17 | ⬜ | Media | Topología de red interna hardcodeada (IPs BD/SIS) | `sis/sis-client.js:5,15`, `scrape.js:7`, `docs/`, `prompts/` |
| AUD-18 | ⬜ | Media | `eventos-dashboard` expone snapshots de personal (PII) sin auth | `server.js:2270-2317` |

### P3 — Seguridad baja / endurecimiento

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-19 | ⬜ | Baja | Sin defensa anti-CSRF (todo recae en `SameSite=lax`) | `auth/app.js:51-56`; mutadores del if-chain |
| AUD-20 | ⬜ | Baja | Sin rate limiting; búsqueda histórica `LIKE '%..%'` (scan) | global; `server.js:2162` |
| AUD-22 | ⬜ | Baja | Endurecimiento OIDC residual + cierre de hallazgos heredados | `m365.js:22,28,122`, `provision.js:37-48`, `auth/app.js:46` |
| AUD-39 | ⬜ | Media | `validateCamposExtra` sin tope de tamaño/claves → mass-assignment + DoS de storage | `utils/campos.js:6-55` (esp. `:18`) |
| AUD-40 | ⬜ | Media | Usuarios `test_*` con password `'1234'` + `activo=1` residentes en BD productiva | `tests/helpers.js:46` |
| AUD-41 | ⬜ | Baja | `IN (...)` por concatenación de enteros en el turno-sweeper (latente) | `utils/turno-sweeper.js:52-54,124-128` |
| AUD-42 | ⬜ | Baja | WS `usuarios-activos` emite snapshot global cross-planta a cualquier sesión | `ws-usuarios-activos.js:8-24,83` |
| AUD-23 | ⬜ | Baja | Interpolación de nombre de columna en `hasPermisoBitacora` | `middleware/permissions.js:6,12` |
| AUD-24 | ⬜ | Baja | `bitacora/abrir` no valida existencia/permiso de `bitacora_id` | `server.js:291-312` |
| AUD-25 | ⬜ | Baja | `buildUrl` interpola params en XML/URL sin escapar (latente) | `sis/sis-client.js:26-35`, `scrape.js:15-24` |
| AUD-26 | ⬜ | Baja | SSRF de baja exposición: `SIS_HOST` sin allowlist; `fetch` sigue redirects | `sis/sis-client.js:15,71` |
| AUD-27 | ⬜ | Baja | Confianza ciega en `logoutUrl` del backend (open-redirect latente) | `useAuth.js:90-97` |
| AUD-28 | ⬜ | Baja | `xlsx-write` escribe en `..` sin validar ruta (utilitario standalone) | `xlsx-write.js:85,133`, `scrape.js:94-95` |

### P4 — Robustez de BD / migraciones

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-29 | ⬜ | Media-baja | Guards de borrado destructivo por presencia de objeto/flag, no por datos | `db.js:997-1008,1308-1323` |
| AUD-30 | ⬜ | Media-baja | `MERGE` de aprovisionamiento sin `HOLDLOCK` (race en primer login) | `auth/provision.js:34-51` |
| AUD-31 | ⬜ | Baja | `enforceSingletonFlag`: TX explícita sin `XACT_ABORT`/rollback | `db.js:2084-2091` |
| AUD-32 | ⬜ | Baja | Tabla de sesión sin índice en `[expires]`; README con TTL obsoleto | `auth/sessionStore.js:56-61`, `sql/snippets/README.md:65-82` |

### P5 — Arquitectura y mantenibilidad

| ID | Estado | Severidad | Título | Evidencia |
|---|---|---|---|---|
| AUD-33 | ⬜ | Alta (arq.) | Suite de tests corre contra la BD productiva con borrados por `planta_id='GEC3'` | `db.js:38-56`; `CLAUDE.md` conv. #14 (riesgo residual) |
| AUD-34 | ⬜ | Media (arq.) | `server.js` monolítico (~2700 líneas, if-chain único) | `server/server.js` |
| AUD-35 | ⬜ | Media (arq.) | Modelo de routing partido http-nativo + wrapper Express tras D-031 | `auth/app.js`, `server.js` |
| AUD-36 | ⬜ | Baja (arq.) | Parser binario duplicado (ESM servidor ≡ CommonJS CLI, divergibles) | `sis/xls-parser.js` ≡ `js-scraper-carbon-g32/xls.js` |
| AUD-37 | ⬜ | Baja (arq.) | Sin `engines.node`; lockfile del scraper standalone ausente | `package.json`, `server/package.json`, `js-scraper-carbon-g32/package.json` |
| AUD-38 | ⬜ | Baja (arq.) | Drift de documentación (`architecture.md` vs. estado real post D-031/D-035) | `docs/architecture.md:14,269` |

---

## Rondas de implementación sugeridas

> Agrupación recomendada para los chats nuevos. Cada ronda = una decisión `D-NNN` con sus etapas.
> Respeta el orden: **P0 antes que todo** (es respuesta a incidente, no desarrollo).

| Ronda | D-NNN sug. | Ítems | Tema |
|---|---|---|---|
| R1 | D-036 | AUD-01..04 | Respuesta a secretos/PII expuestos + purga de historial |
| R2 | D-037 | AUD-05 | Autenticación por defecto en el if-chain + allowlist de rutas públicas |
| R3 | D-038 | AUD-06 | Endurecer/eliminar el backdoor de test |
| R4 | D-039 | AUD-07, AUD-09, AUD-13, AUD-22 | Endurecimiento de transporte y sesión (TLS BD, cookie, tokens, OIDC) |
| R5 | D-040 | AUD-08, AUD-14, AUD-25, AUD-26 | Blindaje del scraper SIS (canal + parser aislado + validación de datos) |
| R6 | D-041 | AUD-11, AUD-18, AUD-21, AUD-42 | Alcance de planta, CSWSH y PII en contratos/canales |
| R7 | D-042 | AUD-10 | Revalidación de privilegios efectiva (fail-closed) |
| R8 | D-043 | AUD-12, AUD-29, AUD-30, AUD-31 | Menor privilegio de BD + robustez de migraciones |
| R9 | D-044 | AUD-15, AUD-16, AUD-19, AUD-20, AUD-23, AUD-24, AUD-27, AUD-28, AUD-32, AUD-39, AUD-41 | Endurecimiento transversal (DoS/CORS/CSRF/validación) |
| R10 | D-045 | AUD-33, AUD-40 | BD de test dedicada (sacar la suite + credenciales débiles de producción) |
| R11 | D-046 | AUD-34, AUD-35, AUD-36, AUD-37, AUD-38 | Refactor arquitectónico + saneo de deuda y docs |

---

# Fichas detalladas

> Cada ficha tiene el formato que un chat nuevo necesita para arrancar con `/nueva-implementacion`:
> **Contexto · Problema · Evidencia · Impacto · Remediación por etapas · Verificación · Cross-ref**.

---

## P0 — Respuesta inmediata

### AUD-01 — Credenciales productivas de BD en `.env.example` · **Crítica**

**Contexto.** `.env` y `server/.env` están correctamente en `.gitignore` y nunca se commitearon. Pero
`.env.example` (versionado) **no contiene placeholders**: trae la cadena de conexión real.

**Problema.** Secreto productivo en claro en el control de versiones, presente en todo el historial de
git (borrarlo del working tree no lo elimina del historial).

**Evidencia.** `.env.example:1-4`:
```
DB_HOST=
DB_NAME=
DB_USER=
DB_PASSWORD=
```

**Impacto.** Cualquiera con acceso al repo (o a un clon/espejo/fuga) obtiene usuario, contraseña, host
e instancia internos de la BD productiva. **Asumir la credencial comprometida.**

**Remediación por etapas.**
1. **E1 (inmediata, fuera de git):** rotar la contraseña de `user_portalg3` en SQL Server.
2. **E2:** reemplazar los valores de `.env.example` por placeholders (`DB_PASSWORD=
3. **E3:** purgar el secreto del historial con `git filter-repo`/BFG y forzar re-clonado a quien tenga copias. Coordinar porque reescribe historia.
4. **E4:** documentar la IP interna como dato sensible (cruza con AUD-17).

**Verificación.** `git log -p -- .env.example` no debe mostrar la contraseña real en ninguna revisión
tras la purga; intento de conexión con la credencial vieja debe fallar.

**Cross-ref.** AUD-07 (cifrado del canal), AUD-17 (IPs internas), memoria `db-host-override-local`.

---

### AUD-02 — PII de ~80 empleados versionada (código muerto post-D-031) · **Alta**

**Contexto.** D-031 retiró `personal-2026.json`/`seedPersonal` (la identidad ahora se auto-aprovisiona
por `azure_oid` vía `provision.js`). El archivo y su generador siguen en el repo.

**Problema.** `server/data/personal-2026.json` contiene nombre legal completo + username + cargo de ~80
trabajadores reales; `_build_personal_json.py` hardcodea la ruta al Excel fuente. Es PII sin uso
funcional (código muerto).

**Evidencia.** `server/data/personal-2026.json`, `server/data/_build_personal_json.py` (ambos tracked).

**Impacto.** Filtración de datos personales de la plantilla (Habeas Data / Ley 1581 de Colombia) sin
justificación funcional.

**Remediación por etapas.**
1. **E1:** confirmar por grep que ningún módulo importa `personal-2026.json` (D-031 dice que no).
2. **E2:** `git rm` ambos archivos.
3. **E3:** purgar del historial junto con AUD-01 (misma operación `filter-repo`).

**Verificación.** Grep `personal-2026` en `server/**` sin resultados de import; suite verde.

**Cross-ref.** `CLAUDE.md` nota 15 (D-031), regla 13 (scaffolding efímero), AUD-01.

---

### AUD-03 — Screenshot de sesión autenticada en sistema externo (XM RIO) · **Alta**

**Contexto.** PNG en la raíz, versionado.

**Problema.** `aut_redesp_y_pruebas.png` captura el portal regulatorio productivo
`rio.xm.com.co/#/redespacho/ingreso-solicitud/nacional-manual` con sesión iniciada como **"ERNESTO
JAVIER MUÑOZ SUAREZ"**, datos de redespacho de GECELCA 3, y la barra de pestañas del navegador
personal (Gmail, YouTube, taobao, "XM Admin"). **Verificado visualmente en esta auditoría.**

**Evidencia.** `aut_redesp_y_pruebas.png` (raíz, tracked).

**Impacto.** Expone nombre real de funcionario, su acceso a un sistema productivo de terceros, una URL
operativa sensible y metadatos personales. Disclosure operacional + PII.

**Remediación por etapas.**
1. **E1:** `git rm aut_redesp_y_pruebas.png`; reemplazar por un mockup si se necesita documentar la UI.
2. **E2:** purgar del historial (misma operación de AUD-01/02).
3. **E3:** revisar el resto de imágenes sueltas; `image.png` es ilustración decorativa (sin datos) — dejar, pero mover a `public/` o `docs/` para higiene.

**Verificación.** El archivo no aparece en `git ls-files` ni en el historial tras la purga.

**Cross-ref.** D-023 (titular Jefe de Planta `emunoz`), AUD-01.

---

### AUD-04 — `dist/index.html` versionado pese a `.gitignore` · Media

**Contexto.** `.gitignore:2` ignora `dist/`, pero `dist/index.html` quedó trackeado (agregado con `-f`
o antes del ignore) y figura modificado en el status. Los `assets/*` referenciados NO están → build
parcial e incoherente.

**Problema.** Artefacto de build en git: divergencia con el fuente y riesgo de embeber
`import.meta.env.VITE_*` en bundles futuros. Hoy el HTML no contiene secretos.

**Evidencia.** `dist/index.html`, `.gitignore:2`.

**Remediación.** `git rm --cached dist/index.html` (la gitignore ya lo cubre). Una sola etapa.

**Verificación.** `git status` deja de listar `dist/`.

---

## P1 — Seguridad crítica/alta de la aplicación

### AUD-05 — Autenticación opt-in: endpoints de datos/PII sin `loadSession` · **Crítica**

**Contexto.** La autenticación NO es global. El wrapper Express solo puebla `req.session`; **cada
handler del if-chain decide si llama `loadSession`**. Por tanto, todo endpoint que no la invoca es
público. **Verificado:** `/api/registros/activos` (`server.js:582`) y `/api/historicos` (`:2141`) no
llaman `loadSession`, a diferencia de `/api/bitacora/counts` (`:612`) que sí.

**Problema.** Endpoints que vuelcan operación viva, histórico y PII (snapshots `jdts_snapshot`,
`jefes_snapshot`, `ingenieros_snapshot`, correos del personal de turno) sin credencial alguna.

**Evidencia (inventario de endpoints públicos por error).**
- `server.js:582-608` — `GET /api/registros/activos` (operación viva + snapshots).
- `server.js:2141-2184` — `GET /api/historicos` (toda la historia; `limit` hasta 500, paginable).
- `server.js:2127-2138` — `GET /api/historicos/:id` (enumerable por id secuencial).
- `server.js:2098-2123` — `GET /api/historicos/resumen`.
- `server.js:2190-2209` y `:2213-2232` — `GET /api/autorizaciones` y lookup por periodo (deprecated, vivos).
- `server.js:536-565` (`jdt-actual`) y `:568-579` (`jefe`) — devuelven `email`+`nombre_completo` (PII).
- `server.js:2270-2317` — `GET /api/eventos-dashboard` (snapshots; ver AUD-18, parcialmente por diseño).
- Menor sensibilidad sin auth: `:464` plantas, `:476` cargos, `:488` bitácoras, `:500` tipos-evento, `:516` permisos.

**Impacto.** Cualquiera con conectividad al puerto 3002 — o cualquier web que el operador visite, vía
CORS wildcard AUD-16, porque estos endpoints no dependen de cookie — pagina toda la historia operativa
de GEC3/GEC32 y recolecta nombres/correos de JdT y jefes (phishing dirigido). Enumeración trivial de
`/api/historicos/:id`.

**Remediación por etapas.**
1. **E1 (estructural):** invertir el modelo — exigir sesión por defecto en `legacyHandler` y declarar una **allowlist explícita de rutas públicas** (`/health`, `eventos-dashboard` gateado por red/token, catálogos no-PII que el `LoginScreen` necesita pre-login).
2. **E2:** anteponer `const sesion = await loadSession(req); if (!sesion) return 401;` a cada handler de datos/PII; aplicar `plantaMatch`/scoping de planta y `hasPermisoBitacora(...,'puede_ver')` donde corresponda.
3. **E3:** eliminar definitivamente `/api/autorizaciones*` (ya reemplazado por `/api/eventos-dashboard`).
4. **E4:** tests de regresión: cada endpoint sensible responde 401 sin sesión y 403 sin permiso/planta.

**Verificación.** `curl` sin cookie a cada ruta del inventario → 401; con sesión de otra planta → 403
donde aplique scoping.

**Cross-ref.** AUD-06 (bypass), AUD-16 (CORS), AUD-18 (PII en contrato), AUD-11 (scoping de planta).

---

### AUD-06 — Backdoor `AUTH_TEST_BYPASS` suplanta por `X-Sesion-Id` enumerable · **Alta**

**Contexto.** Con `AUTH_TEST_BYPASS==='1'`, `loadSession` resuelve la identidad desde el header
`X-Sesion-Id` (entero) vía `loadBySesionIdTest`, que selecciona cualquier `sesion_activa.activa=1` por
id, sin más control. El header está además listado en `Access-Control-Allow-Headers` en producción.

**Problema.** Branch fail-open por configuración: si la env var se filtra a prod (copiar `.env`, CI/
Dockerfile de test reusado), `curl -H 'X-Sesion-Id: 1..N'` recorre identidades hasta dar con una sesión
activa y opera como ella — incluido JdT (cerrar turnos, anular eventos). IDOR puro sin cookie.

**Evidencia.** `middleware/auth.js:26-46` (branch), `:29-35` (`loadBySesionIdTest`), `utils/http.js:4`
(`X-Sesion-Id` en CORS), `.env.example:33-36` (documentado solo-test).

**Impacto.** Suplantación total de cualquier usuario activo si el flag está presente en prod.

**Remediación por etapas.**
1. **E1:** doble gate — exigir además `NODE_ENV !== 'production'`; abortar el arranque si `AUTH_TEST_BYPASS=1` con `NODE_ENV=production`.
2. **E2:** sustituir el id enumerable por un **token aleatorio de test** (no un entero secuencial).
3. **E3:** quitar `X-Sesion-Id` de `Access-Control-Allow-Headers` (queda solo bajo el gate de test).
4. **E4:** verificar que el harness HTTP (`helpers.js`) sigue verde con el nuevo mecanismo.

**Verificación.** Arranque con `AUTH_TEST_BYPASS=1 NODE_ENV=production` debe **abortar**; sin el flag,
`X-Sesion-Id` se ignora.

**Cross-ref.** D-030/D-031 (backdoor de test), AUD-05, AUD-16.

---

### AUD-07 — SQL Server sin cifrado (`encrypt:false` + `trustServerCertificate:true`) · **Alta**

**Contexto.** Tanto el pool de runtime como el store de sesiones se conectan a SQL Server por IP
interna sin TLS y aceptando cualquier certificado.

**Problema.** Todo el tráfico SQL — incluida la autenticación con la contraseña de AUD-01, los datos de
bitácoras y el blob de sesión con tokens MSAL (AUD-13) — viaja en texto plano. `trustServerCertificate:
true` haría MITM-able el canal aun si se activara `encrypt`.

**Evidencia.** `db.js:22-26` (`encrypt:false`, `trustServerCertificate:true`); idéntico en
`auth/sessionStore.js:29-34`.

**Impacto.** Un atacante en la LAN (la app y la BD se hablan por `192.168.17.20`) esnifa credenciales
y datos, o monta un MITM.

**Remediación por etapas.**
1. **E1:** emitir/instalar un certificado de servidor SQL de una CA confiable (o pinear thumbprint).
2. **E2:** `encrypt:true` + `trustServerCertificate:false` en **ambos** archivos; parametrizar por env con default seguro.
3. **E3:** validar conectividad end-to-end (la BD remota fue intermitente en sesiones previas — ver memoria `db-host-override-local`).

**Verificación.** Captura de red al puerto 1433 cifrada; conexión con cert inválido rechazada.

**Cross-ref.** AUD-01, AUD-13, memoria `db-host-override-local`.

---

### AUD-08 — Cadena SIS HTTP plano + parser binario sin límites → DoS de todo el backend · **Alta**

**Contexto.** El sweeper horario consulta un SIS interno (`http://192.168.18.201`, plano, "sin auth"
según el propio comentario) y parsea el `.xls` devuelto con un lector OLE2/CFB+BIFF8 **hecho a mano,
síncrono, en el event loop principal**. Cualquier `.xls` malicioso (entregado vía MITM por el canal en
claro) se convierte en DoS de todo el proceso (HTTP :3002, sweepers, auth).

**Problema (raíz común de varios sub-bugs).** El parser corre sobre bytes no autenticados, sin tope de
tamaño, sin validación de campos estructurales y sin detección de ciclos:
- **Cadena FAT sin detección de ciclos**, `readChain(firstDirSector, null)` con `lim=Infinity` → bucle infinito / OOM. `xls-parser.js:44-56,58`.
- **`sectorSize = 1<<readUInt16LE(30)` sin validar** → `Uint32Array` gigante/negativo (OOM). `xls-parser.js:13,36-37`.
- **`numDifat`/`cstUnique` (u32) sin tope** dimensionan arrays y bucles → cuelgue de CPU; `String.fromCharCode(...codes)` por spread puede `RangeError`. `xls-parser.js:25-34,84-114`.
- **`resp.arrayBuffer()` sin límite de descarga** → OOM con cuerpo gigante dentro del timeout. `sis-client.js:73`. El standalone `scrape.js:38-41` además **no tiene timeout**.
- El `timeoutMs=30000` aborta el `fetch`, NO la CPU del parser ya en marcha.

**Evidencia.** `sis/sis-client.js:5,15,71,73`; `sis/xls-parser.js:13,36-37,44-56,58,84-114`; duplicado
en `js-scraper-carbon-g32/xls.js` y `scrape.js:7,38-41`.

**Impacto.** Un `.xls` con FAT cíclica o `sectorSize` exponente 28 cuelga/mata el backend completo en
cada tick horario. Vector de entrega = MITM en la LAN o un SIS comprometido.

**Remediación por etapas.**
1. **E1 (canal):** migrar el SIS a HTTPS con validación/pinning; si solo habla HTTP, aislar el tramo (VLAN dedicada / mTLS / IPsec) y restringir por IP de origen. Validar `Content-Type`.
2. **E2 (aislamiento):** mover `parseXls` a un `worker_thread` con límite de tiempo y memoria; el cuelgue del worker no debe tumbar el event loop.
3. **E3 (validación estructural):** `Set` de sectores visitados (abortar ante ciclo); tope duro de sectores/bytes en `readChain` aun con `size==null`; validar `sectorSize ∈ {512,4096}`, `numDifat`/`cstUnique`/`firstDirSector` contra el tamaño real del buffer antes de asignar/iterar; reemplazar `String.fromCharCode(...codes)` por construcción incremental/`TextDecoder`.
4. **E4 (descarga):** leer el body en streaming con límite (~5–10 MB; el `.xls` real son pocos KB) y abortar al superarlo; añadir timeout al standalone.
5. **E5:** unificar las dos copias del parser (AUD-36) para no arreglar una y dejar la otra.

**Verificación.** Fixtures `.xls` malformados (FAT cíclica, `sectorSize` inválido, `cstUnique` enorme,
body de 50 MB) → el scraper falla acotado y el backend sigue respondiendo en :3002.

**Cross-ref.** AUD-14 (validación de los datos), AUD-25/26 (XML/SSRF), AUD-36 (duplicación), D-029
(SIS GEC32).

---

## P2 — Seguridad media

### AUD-09 — Cookie de sesión sin `Secure` forzado en prod · Media

**Problema.** `SESSION_COOKIE_SECURE` se lee de env; si falta, `String(undefined)→'undefined'→false`,
y producción solo emite `console.warn` (`app.js:63-64`), no aborta. La cookie de identidad (httpOnly,
30 días) se emitiría sin `Secure`.

**Evidencia.** `auth/app.js:54,63-64`; `entra-config.js:33-34`.

**Impacto.** Olvido de la env var → cookie de identidad capturable en claro tras un downgrade a HTTP.

**Remediación.** Derivar `secure:true` de `NODE_ENV==='production'` (no leerlo de env); negarse a
arrancar si falta en prod. Mantener `trust proxy` para el TLS-terminating proxy.

**Cross-ref.** AUD-22 (mismo paquete OIDC), `.env.example:28`.

---

### AUD-10 — Privilegio congelado sobrevive a revocación en Entra; revalidación fail-open · Media

**Problema.** El `cargo_id` autorizante se congela en `sesion_activa` al hacer `select-context` y nunca
se re-deriva del token. `revalidate` actualiza `req.session.user.roles` pero ese array no gobierna la
autorización real (que pasa por `permissions.js → cargo_id`). Además: corre cada 20 min, falla-abierto
ante errores transitorios (sin tocar `lastRevalidatedAt` → un atacante que induzca throttling prolonga
la sesión), y `isRevocation` solo mata ante des-asignación de la app, no ante un downgrade de rol.

**Evidencia.** `auth/revalidate.js:34-56`; `server.js:141`; `middleware/auth.js:10-17`.

**Impacto.** A un usuario se le baja de JdT a operador en Entra y conserva `puede_cerrar_turno`
potencialmente todo el turno.

**Remediación por etapas.**
1. **E1:** re-derivar `cargoNombre` desde los roles revalidados y comparar con el `cargo_id` de la sesión de app; si difiere, invalidar la sesión de app.
2. **E2:** fail-closed tras N fallos transitorios consecutivos; registrar/limitar.
3. **E3:** evaluar acortar `REVALIDATE_INTERVAL_MS`.

**Cross-ref.** D-031 (dos sesiones), `entra-roles.js` (precedencia).

---

### AUD-11 — IDOR cross-planta en DISP (escritura sin `plantaMatch`) · Media

**Problema.** Las ramas DISP de `POST/PUT /api/registros` y `POST /api/disponibilidad/deshacer`
verifican `hasPermisoBitacora(...)` pero **deliberadamente omiten `plantaMatch`**. Un operador con
sesión en GEC3 y permiso DISP puede crear/editar/deshacer la disponibilidad de GEC32 (pasando
`planta_id:'GEC32'` o un `disponibilidad_id` ajeno) — dato que cruza a XM/dashboard productivo.

**Evidencia.** `server.js:659-768` (POST, comentario "omite plantaMatch"), `:958-1092` (PUT, no valida
`reg.planta_id===sesion.planta_id`), `:2035-2094` (deshacer), `:1961-2027` (lectura).

**Impacto.** Una persona logueada en una unidad marca Indisponible la otra; se propaga vía
`disponibilidad_dashboard`.

**Remediación.** Decidir explícitamente: si DISP es multi-planta a propósito, restringir la **escritura**
a cargos con alcance cross-planta (JdT/IngOp/Jefe Planta) o validar `planta_id` contra las plantas que
el cargo puede operar; si no, aplicar `plantaMatch`. Documentar la decisión en `decisions.md`.

**Cross-ref.** AUD-05, D-035 ("una persona no en 2 unidades"), D-026 (DISP).

---

### AUD-12 — Login de la app con privilegios DDL/DROP (initDB acoplado al arranque) · Media

**Problema.** `initDB` corre en cada arranque con `CREATE SCHEMA/TABLE`, `ALTER`, `DROP TABLE/VIEW/
INDEX/CONSTRAINT`, `sp_rename` → el login de runtime `user_portalg3` necesita `db_owner` efectivo. El
CRUD de runtime no requiere nada de eso (violación de menor privilegio).

**Evidencia.** `db.js:329-2067`.

**Impacto.** Un compromiso de la app hereda capacidad de `DROP`/alterar esquema sobre producción, no
solo CRUD.

**Remediación por etapas.**
1. **E1:** separar dos logins SQL — uno privilegiado solo-deploy (corre migraciones), uno de runtime con `SELECT/INSERT/UPDATE/DELETE` sobre `lov_bit`/`bitacora`/`auth`.
2. **E2:** desacoplar `initDB` del arranque del servicio (paso de deploy explícito).

**Cross-ref.** AUD-29/30/31 (robustez de migraciones), AUD-33 (tests).

---

### AUD-13 — Tokens Entra (incl. refresh) en claro en `[auth].[AppSessions]` · Media

**Problema.** La tabla de sesión se crea como `[session] nvarchar(max)` y `connect-mssql-v2` serializa
la sesión Express como JSON sin cifrar. Con `offline_access` (`.env.example:18`), contiene tokens de
Entra incluido el refresh token de larga vida.

**Evidencia.** `auth/sessionStore.js:56-69`; `.env.example:18`.

**Impacto.** Quien lea esa tabla (DBA, backup robado, o vía AUD-01/07) obtiene tokens reutilizables para
suplantar usuarios contra Entra/Graph durante la vida del refresh token.

**Remediación.** No persistir tokens en la sesión (guardar solo `oid`/claims mínimos y re-obtener vía
caché MSAL server-side), o cifrar el blob de sesión en reposo. Confirmar qué guarda exactamente
`auth/app.js` en la sesión.

**Cross-ref.** AUD-07 (canal), AUD-22.

---

### AUD-14 — Scraper escribe a BD como SISTEMA sin validar rango · Media

**Problema.** Las queries del scraper están **bien parametrizadas** (sin SQLi), pero los valores vienen
del `.xls` no confiable: `num()` deja pasar `Infinity` (`parseFloat("1e999")`), `round3(Infinity)` se
intenta meter en `Decimal(12,3)`, y no se valida contra `lov_bit.combustible.cantidad_max` (el tope
físico D-034 que el POST humano sí aplica) → el scraper **evade la regla de negocio**. Peor: si el
SIS/MITM reporta `enServicio=false`/tolvas 0, las filas SIS-owned se **eliminan** (`DELETE`)
silenciosamente.

**Evidencia.** `sis/sis-client.js:84-96` (`extraerCarbonValidado`); `sis/carbon-scraper.js:202-233`
(escritura), `:127-145` (rama `valorSis===0` → DELETE).

**Impacto.** MITM con valores absurdos o 0 → se sobrescriben/eliminan consumos de GEC32 sin rastro
humano, corrompiendo reportes y "Total Carbón".

**Remediación.** Validar cada valor: finito, ≥0, ≤ `cantidad_max`; descartar/loguear fuera de rango en
vez de escribir. Tope de variación entre scrapes; no permitir DELETE automático sin umbral/confirmación.

**Cross-ref.** AUD-08 (canal/parser), D-034 (límites físicos), D-029 (ownership SIS).

---

### AUD-15 — `parseBody` sin límite de tamaño → DoS por memoria · Media

**Problema.** `parseBody` acumula `data += chunk` sin tope ni chequeo de `Content-Length` antes de
`JSON.parse`. `express.json()` está acotado solo a `/auth`, así que **todos** los POST/PUT del if-chain
leen el stream crudo sin límite.

**Evidencia.** `utils/http.js:7-21`.

**Impacto.** Un body de cientos de MB a cualquier mutador (o a los endpoints públicos de AUD-05)
bufferiza en memoria → OOM del proceso Node (single process). Repetible → DoS sostenido.

**Remediación.** Imponer límite de bytes en `parseBody` (abortar con 413); `express.json({ limit:
'100kb' })` en `/auth`.

**Cross-ref.** AUD-05, AUD-08 (otra cara del DoS), AUD-20.

---

### AUD-16 — CORS wildcard `Access-Control-Allow-Origin: *` global · Media

**Problema.** Todas las respuestas del if-chain llevan ACAO `*`. No se emite `Allow-Credentials:true`
(mitigante real para endpoints con cookie), pero combinado con los endpoints **sin auth** (AUD-05),
cualquier web que la víctima visite puede `fetch()` esos endpoints (no requieren cookie) y leer la
respuesta → exfiltración de datos/PII desde el navegador del operador en la LAN corporativa.

**Evidencia.** `utils/http.js:1-5` (en `sendJSON`/`responderError`), `server.js:109-112` (preflight).

**Remediación.** Reemplazar el wildcard por un allowlist de orígenes y reflejar el `Origin` validado;
quitar `X-Sesion-Id` de `Allow-Headers` en prod (cruza AUD-06).

**Cross-ref.** AUD-05, AUD-06, AUD-19.

---

### AUD-17 — Topología de red interna hardcodeada · Media

**Problema.** IPs internas en código y docs: `REDACTED` (BD), `192.168.18.201` (SIS), con
comentario "SIS interno sin auth". `scrape.js:7` hardcodea la IP del SIS sin override por env.

**Evidencia.** `sis/sis-client.js:5,15`; `js-scraper-carbon-g32/scrape.js:7`; `docs/`, `prompts/`.

**Impacto.** Mapa de infraestructura interna embebido en el repo facilita movimiento lateral.

**Remediación.** Mover hosts a env (el SIS del backend ya soporta `process.env.SIS_HOST`; aplicarlo
siempre, incluido el standalone); no documentar IPs en `docs/`/`prompts/`.

**Cross-ref.** AUD-01, AUD-26.

---

### AUD-18 — `eventos-dashboard` expone snapshots de personal (PII) sin auth · Media

**Problema.** Es el borde del contrato cross-repo y por diseño no exige sesión, pero su `SELECT`
incluye `jdts_snapshot`/`jefes_snapshot` (nombres/cargos).

**Evidencia.** `server.js:2270-2317`.

**Remediación.** Restringir por red (firewall/allowlist de IP del dashboard) o token de servicio
compartido; o no incluir snapshots de personal en el shape cross-repo si el dashboard no los usa.
**Coordinar con `dashboard-gen-gec3`** antes de tocar el shape (ver `docs/interfaces-cross-repo.md`).

**Cross-ref.** AUD-05, D-006/D-009 (contrato), `docs/interfaces-cross-repo.md`.

---

## P3 — Seguridad baja / endurecimiento

### AUD-19 — Sin defensa anti-CSRF (todo recae en `SameSite=lax`) · Baja
**Problema.** Los mutadores se autentican solo por cookie; no hay token anti-CSRF ni verificación de
`Origin`/`Referer`. Mitiga `SameSite=lax` + ACAO sin credenciales, pero queda expuesto si se relaja
`sameSite` o aparece un subdominio same-site no confiable.
**Evidencia.** `auth/app.js:51-56`; mutadores `server.js:130,249`, `auth/app.js:199`; cliente en
`useApi.js:28-33` (`credentials:'include'`, sin header anti-CSRF).
**Remediación.** Verificar `Origin`/`Referer` contra allowlist en mutadores, o token CSRF de doble
envío reenviado por el front; documentar que `SameSite` no debe relajarse.
**Cross-ref.** AUD-16, frontend hallazgo #1.

### AUD-20 — Sin rate limiting; búsqueda histórica `LIKE '%..%'` · Baja
**Problema.** Ningún endpoint tiene límite de tasa; la búsqueda de históricos usa wildcard líder
(`detalle LIKE '%'+@busqueda+'%'`) que impide índice (scan). Amplifica el DoS de AUD-05/15.
**Evidencia.** global; `server.js:2162`.
**Remediación.** Rate limiting por IP/sesión (al menos `/auth/login`, `select-context`, históricos);
considerar full-text index.

### AUD-21 — Handshake WS fuera de Express: sin cookie ni `Origin` → CSWSH · **Alta** *(promovido desde Baja)*
**Contexto.** El `upgrade` WS se engancha con `httpServer.on('upgrade')` directamente sobre el
`http.Server` (`server.js:2707-2709`), **fuera** del wrapper Express (`buildAuthApp`). Por diseño de
Node, los eventos `upgrade` no pasan por el middleware de sesión cookie de Express → la cookie httpOnly
de login Entra (`[auth].[AppSessions]`) **nunca se valida** en el handshake (consecuencia directa del
modelo de routing partido, AUD-35).
**Problema.** El único gate es `validateSesion(sesion_id)` (`ws-usuarios-activos.js:43-54`, usado en
`:69-76`): `SELECT 1 FROM sesion_activa WHERE sesion_id=@sesion_id AND activa=1`. Por tanto: (a) el
secreto que autoriza es un `sesion_id` **IDENTITY secuencial y enumerable** que viaja en claro en la URL
(se filtra a logs de proxy, historial, `Referer`); (b) **no se valida `Origin`** del upgrade →
**Cross-Site WebSocket Hijacking (CSWSH)**: una web maliciosa abierta por un usuario logueado puede
conectar `ws://host:3002/ws/usuarios-activos?sesion_id=...` desde su navegador y leer el stream. La query
está parametrizada (sin SQLi); el problema es de autenticación/autorización del canal.
**Evidencia.** servidor `ws-usuarios-activos.js:43-54,59-86`, `ws-conteo-bitacoras.js:44-55,60-86`,
`server.js:2707-2709`; cliente `useUsuariosActivos.js:23-25`, `useBitacoraCounts.js:32-33`.
**Impacto.** Exfiltración (enumerando ids o vía CSWSH) de la lista de usuarios activos (nombre, cargo,
planta, inicio de sesión) y de los conteos de borradores por bitácora.
**Remediación.** (1) Validar la cookie de sesión Entra en el handshake: parsear `req.headers.cookie`,
resolver la sesión del store MSSQL y exigir que el `sesion_id` del query pertenezca al `oid` de esa
cookie. (2) Validar `req.headers.origin` contra allowlist; `socket.destroy()` si no coincide. (3) Sin
cookie válida, rechazar el upgrade.
**Cross-ref.** AUD-35 (routing partido — causa raíz), AUD-42 (snapshot global), AUD-06 (mismo patrón de
id enumerable).

### AUD-22 — Endurecimiento OIDC residual + hallazgos heredados · Baja
**Problema.** (a) `TENANT` cae a `'common'` si falta env (multi-tenant); sin verificación explícita de
`claims.tid` tras el canje. (b) `nonce` se valida solo `if (nonce && ...)` (MSAL mitiga internamente).
(c) `SESSION_SECRET` con fallback efímero por proceso (`app.js:46`) → sesiones mueren al reiniciar y
rompe multi-instancia. (d) `provision` re-activa (`activo=1`) usuarios desactivados localmente en cada
login (`provision.js:37-48`). **Hallazgos heredados de `docs/auditoria-auth-usuarios-roles-2026-06.md`
§7:** confirmar el estado de #4 (logout sin auth), #5 (rehash vs centinela SISTEMA) y #6 (timing oracle
leve en login).
**Evidencia.** `m365.js:22,28,122`; `auth/app.js:46,60-62`; `provision.js:37-48`.
**Remediación.** Validar `claims.tid===M365_TENANT_ID`; tratar `nonce` ausente como error duro; exigir
`SESSION_SECRET` en prod (abortar si falta); no tocar `activo` en MATCHED (desactivación local pegajosa)
o documentar que el único gate de bloqueo es Entra.
**Cross-ref.** D-031, `docs/auditoria-auth-usuarios-roles-2026-06.md`.

### AUD-23 — Interpolación de nombre de columna en `hasPermisoBitacora` · Baja
**Problema.** `SELECT ${accion} AS ok` interpola `accion`. Mitigado por el guard que solo acepta
`'puede_ver'`/`'puede_crear'` y porque todos los callers pasan literales — pero es el único punto de
concatenación dinámica en queries.
**Evidencia.** `middleware/permissions.js:6,12`.
**Remediación.** Mapear `accion`→columna vía objeto fijo o `CASE`, dejando el valor fuera del template.

### AUD-24 — `bitacora/abrir` no valida existencia/permiso de `bitacora_id` · Baja
**Problema.** `MERGE` en `sesion_bitacora` con cualquier `bitacora_id` del body sin verificar que la
bitácora exista/sea visible o que el cargo tenga permiso (la FK rechaza ids inexistentes, pero permite
registrar "participación" en bitácoras sin acceso).
**Evidencia.** `server.js:291-312`.
**Remediación.** Validar existencia + `hasPermisoBitacora(...,'puede_ver')` antes del MERGE.

### AUD-25 — `buildUrl` interpola params en XML/URL sin escapar (latente) · Baja
**Problema.** `f1,h1,f2,h2` se interpolan en el XML sin escape de entidades. Hoy saneados aguas arriba
(`periodoBounds` valida `1..24`, `scrapeDia` valida fecha `^\d{4}-\d{2}-\d{2}$`), pero un futuro
llamador (backfill/endpoint manual) que pase valores sin validar reintroduce inyección XML hacia el SIS.
**Evidencia.** `sis/sis-client.js:26-35`; `scrape.js:15-24`.
**Remediación.** Escapar entidades XML y validar formato dentro de `buildUrl` (no depender del llamador).

### AUD-26 — SSRF de baja exposición: `SIS_HOST` sin allowlist; `fetch` sigue redirects · Baja
**Problema.** `SIS_HOST` viene de env sin validar esquema/host; `fetch` (undici) sigue redirecciones por
defecto → un SIS/MITM puede 30x-redirigir el scraper a otro destino interno cuyos resultados se escriben
como SISTEMA.
**Evidencia.** `sis/sis-client.js:15,71`.
**Remediación.** Allowlist de host/puerto/esquema para `SIS_HOST`; `redirect:'error'` en el `fetch`.

### AUD-27 — Confianza ciega en `logoutUrl` del backend (open-redirect latente) · Baja
**Problema.** El front navega a `r.logoutUrl` tal cual la devuelve el backend, sin validar host. No
explotable solo desde el front (la genera el server con la config OIDC), pero es open-redirect si el
backend la construye desde input no confiable.
**Evidencia.** `useAuth.js:90-97`.
**Remediación.** Validar en el cliente que `logoutUrl` sea relativa o de una allowlist (Microsoft) antes
de asignar `window.location.href`.

### AUD-28 — `xlsx-write` escribe en `..` sin validar ruta (utilitario standalone) · Baja
**Problema.** `writeXlsx`/`scrape.js` escriben en la ruta recibida sin validar; el llamador escribe en
el dir padre (`path.join(__dirname,"..",...)`). `fechaCompact` deriva del reloj (no input) → sin path
traversal real hoy, pero el escritor no impone contención.
**Evidencia.** `xlsx-write.js:85,133`; `scrape.js:94-95`.
**Remediación.** Resolver y validar que la salida quede dentro de un directorio designado. Baja
prioridad (fuera del runtime productivo).

### AUD-39 — `validateCamposExtra` sin tope de tamaño/claves → mass-assignment + DoS de storage · Media
**Problema.** La validación solo recorre los campos declarados en `def`, pero **toda clave extra de
`input` se conserva** vía `const normalized = { ...input }` (`campos.js:18`) y termina en `campos_extra`
(`NVARCHAR(MAX)`). No hay límite de longitud total del JSON, ni de número de claves, ni de profundidad,
ni validación de tipo para campos no `int/float/select` (un `tipo:'text'` no valida nada).
**Evidencia.** `utils/campos.js:6-55` (esp. `:18`).
**Impacto.** (a) Mass-assignment al blob: el cliente inyecta claves no previstas que quedan en el
registro/snapshot. (b) DoS de almacenamiento: payload JSON enorme aceptado (acotado solo por el body
parser, que tampoco tiene tope — AUD-15) y persistido a MAX. No es SQLi (todo por `.input()` NVARCHAR),
sin `eval`, y el spread de `__proto__` no contamina prototipos.
**Remediación.** Construir `normalized` solo con campos declarados en `def` (no spread de `input`);
validar longitud máxima de strings de texto y un tope de bytes del JSON serializado.
**Cross-ref.** AUD-15 (límite de body), D-001 (snapshots/`campos_extra`).

### AUD-40 — Usuarios `test_*` con password `'1234'` + `activo=1` residentes en BD productiva · Media
**Problema.** El harness siembra 4 usuarios `test_*` con `hashPassword('1234')` (`helpers.js:46`) y
`activo=1` en la **BD productiva** (la suite corre contra prod, AUD-33). Es una contraseña débil conocida
para cuentas activas. Mitigado por D-031 (el login local por password se retiró), pero el riesgo
reaparece si algún camino de auth por password sobrevive o se reintroduce.
**Evidencia.** `tests/helpers.js:46`.
**Impacto.** Cuentas activas con credencial trivial residentes en producción; superficie si el login
legacy reviviera.
**Remediación.** Crear los usuarios de test en la BD de test dedicada (AUD-33); si deben existir en prod,
sembrarlos `activo=0` con centinela `'!disabled!'` (patrón SISTEMA). Documentar.
**Cross-ref.** AUD-33 (tests contra prod), AUD-06 (backdoor de test), D-031.

### AUD-41 — `IN (...)` por concatenación de enteros en el turno-sweeper (latente) · Baja
**Problema.** Dos cláusulas `IN` concatenan strings en vez de parametrizar. **No explotable hoy**: los
valores provienen de columnas IDENTITY de la BD (`sesion_bitacora_id`, `sesion_id`), no de input. Higiene
preventiva: si el origen cambiara a algo influenciable por el cliente, sería SQLi.
**Evidencia.** `utils/turno-sweeper.js:52-54` (`IN (${idsCsv})`), `:124-128` (`IN (${expirados.join(',')})`).
**Remediación.** Parametrizar con lista de `.input()` o TVP. (El resto de queries de
sweepers/snapshots/ciet/conformación están correctamente parametrizadas — verificado.)
**Cross-ref.** AUD-23 (mismo patrón de interpolación).

### AUD-42 — WS `usuarios-activos` emite snapshot global cross-planta a cualquier sesión · Baja
**Problema.** `fetchSnapshot()` devuelve TODAS las sesiones activas de TODAS las plantas; el handshake
valida que el `sesion_id` exista pero no scopea el snapshot a la planta de esa sesión. Un operador de
GEC3 ve la presencia de GEC32 y de la planta de test. (Contraste correcto: `ws-conteo-bitacoras.js:78-79,
83` **sí** scopea por `planta_id`.)
**Evidencia.** `ws-usuarios-activos.js:8-24,83`.
**Remediación.** Filtrar el snapshot por la `planta_id` de la sesión validada, salvo roles globales.
**Cross-ref.** AUD-21 (mismo canal), AUD-11 (alcance de planta).

---

## P4 — Robustez de BD / migraciones

### AUD-29 — Guards de borrado destructivo por presencia de objeto/flag, no por datos · Media-baja
**Problema.** El wipe one-shot de DISP se dispara si `OBJECT_ID('bitacora.disponibilidad_dashboard')`
es NULL; el TRUNCATE de MAND, si falta la fila `F16.A1` en `migracion_aplicada`. Si un operador dropea
esa tabla o borra el flag, el siguiente arranque **re-ejecuta un borrado masivo** de datos productivos
en silencio.
**Evidencia.** `db.js:997-1008,1308-1323`.
**Remediación.** Gatear también por ausencia de datos (`IF NOT EXISTS (SELECT 1 ...)`) o env var de
confirmación; nunca re-truncar productivo solo porque desapareció un flag.

### AUD-30 — `MERGE` de aprovisionamiento sin `HOLDLOCK` (race en primer login) · Media-baja
**Problema.** `MERGE lov_bit.usuario ON azure_oid` sin `HOLDLOCK`/`SERIALIZABLE`; dos primeros logins
concurrentes del mismo OID pueden ambos resolver `WHEN NOT MATCHED`. El índice `UQ_usuario_oid` evita la
duplicación real (peor caso: un login falla con violación de unicidad — mala UX).
**Evidencia.** `auth/provision.js:34-51`.
**Remediación.** `MERGE lov_bit.usuario WITH (HOLDLOCK) AS t ...`; mantener `UQ_usuario_oid` como red.

### AUD-31 — `enforceSingletonFlag`: TX explícita sin `XACT_ABORT`/rollback · Baja
**Problema.** `BEGIN TRAN;...UPDATE;...UPDATE;COMMIT;` en un batch sin `SET XACT_ABORT ON` ni manejo de
error → si el 2º UPDATE falla puede quedar la TX abierta en la conexión devuelta al pool. Contrasta con
`matrizTx`/F26–F28 que sí usan `sql.Transaction` con try/rollback.
**Evidencia.** `db.js:2084-2091`.
**Remediación.** Envolver en `sql.Transaction` con try/catch+rollback, o al menos `SET XACT_ABORT ON`.

### AUD-32 — Tabla de sesión sin índice en `[expires]`; README con TTL obsoleto · Baja
**Problema.** La tabla de sesión tiene PK en `[sid]` pero sin índice en `[expires]` (el `autoRemove`
barre por esa columna cada hora → scan; irrelevante a baja escala). El README de snippets aún describe
un "TTL 5 min" que ya no aplica post-F9/D-031.
**Evidencia.** `auth/sessionStore.js:56-61`; `sql/snippets/README.md:65-82`.
**Remediación.** Índice en `[expires]` si crece; actualizar el comentario del snippet.

---

## P5 — Arquitectura y mantenibilidad

### AUD-33 — La suite de tests corre contra la BD productiva con borrados por `planta_id='GEC3'` · Alta (arq.)
**Problema.** Por diseño (D-030) los tests operan sobre la BD real, aislados en la planta `TST`. Pero el
propio `CLAUDE.md` (conv. #14) admite el riesgo residual: **los tests de MAND/AUTH siguen borrando por
`planta_id='GEC3'`** (datos reales) sin migrar al patrón TST, y las vistas DISP no filtran `TST`.
**Evidencia.** `db.js:38-56`; `CLAUDE.md` conv. #14; **confirmado en `tests/helpers.js`:** `:146-151`
`DELETE FROM bitacora.mand_cierre_log WHERE planta_id='GEC3' AND fecha_cerrada>='2026-05-01'` y `:154-161`
`DELETE FROM bitacora.evento_dashboard WHERE planta_id='GEC3' ...` — ambos sin tag de test, sobre la
planta productiva (`PLANTA_ID='GEC3'`, `helpers.js:6`).
**Impacto.** Una corrida de tests borra el log de cierre MAND y eventos-dashboard productivos de GEC3.
**Remediación por etapas.** E1: provisionar una BD de test dedicada (instancia/credencial propia). E2:
apuntar la suite a esa BD vía env. E3 (puente, mientras tanto): migrar los cleanups MAND/AUTH
(`helpers.js:146-161` y los helpers de `sala_de_mando_batch`/`auth_middleware`/`cierre_y_fechas`/
`fechas_bogota`) al patrón `TEST_PLANTA_ID='TST'` y prohibir borrar por `'GEC3'`.
**Cross-ref.** D-030, AUD-12, AUD-40.

### AUD-34 — `server.js` monolítico (~2700 líneas, if-chain único) · Media (arq.)
**Problema.** Todos los endpoints viven en un if-chain gigante en un solo archivo (`server/routes/` está
prácticamente vacío, solo `.gitkeep`). Dificulta auditar autorización por endpoint (raíz de AUD-05),
testear unidades y razonar sobre el flujo. **El god-file es la causa estructural de que la
autenticación sea opt-in y fácil de olvidar.**
**Evidencia.** `server/server.js`; `server/routes/.gitkeep`.
**Remediación.** Extraer handlers a módulos por dominio bajo `routes/` con un dispatcher que aplique
auth/permiso **por defecto** (cruza AUD-05 E1). Refactor incremental, una familia de endpoints por etapa,
con la suite como red.

### AUD-35 — Modelo de routing partido http-nativo + wrapper Express tras D-031 · Media (arq.)
**Problema.** D-031 introdujo un wrapper Express delgado solo para `/auth`, delegando el resto al
if-chain nativo (`legacyHandler`). Conviven dos modelos de routing, dos formas de parsear el body
(`express.json()` acotado vs. `parseBody` crudo) y dos posturas de middleware — fuente de inconsistencias
de seguridad (límites de body, CORS, auth) y de carga cognitiva. `CLAUDE.md`/`architecture.md` aún dicen
"sin Express".
**Evidencia.** `auth/app.js`, `server.js`; `architecture.md:14`.
**Remediación.** Decidir un modelo único (migrar el if-chain a Express con middleware de auth/CORS/body
unificado es lo natural dado que Express ya está dentro), o aislar limpiamente las dos capas con un
contrato explícito. Volcar la decisión a `decisions.md`.
**Cross-ref.** AUD-15, AUD-16, AUD-34, D-031.

### AUD-36 — Parser binario duplicado (ESM servidor ≡ CommonJS CLI) · Baja (arq.)
**Problema.** `sis/xls-parser.js` y `js-scraper-carbon-g32/xls.js` son el mismo algoritmo byte a byte;
`buildUrl`/`fetchPeriod` también duplicados. Cada bug de AUD-08 existe por duplicado; un fix a una copia
deja la otra vulnerable.
**Evidencia.** `sis/xls-parser.js` ≡ `js-scraper-carbon-g32/xls.js`; `sis-client.js` ≡ `scrape.js`.
**Remediación.** Unificar en un módulo compartido y endurecerlo una sola vez; el CLI importa la misma
implementación. Resolver junto con AUD-08 E5.

### AUD-37 — Sin `engines.node`; lockfile del scraper standalone ausente · Baja (arq.)
**Problema.** Ningún `package.json` declara `engines.node` pese a depender de Node ≥20 (`--env-file`,
`node:test`, ESM). `js-scraper-carbon-g32` no tiene lockfile (mitigado: solo usa módulos nativos).
**Evidencia.** `package.json`, `server/package.json`, `js-scraper-carbon-g32/package.json`.
**Remediación.** Agregar `"engines":{"node":">=20"}`; correr `npm audit` en raíz y `server/` para
confirmar el árbol transitivo (versiones actuales sin CVE obvios: express 4.22.2, mssql 11.0.1, ws
8.20.0, @azure/msal-node 5.3.0, vite 5.4.21).

### AUD-38 — Drift de documentación · Baja (arq.)
**Problema.** `architecture.md` afirma "Backend ... `http` nativo (sin Express)" (contradice D-031) y
describe `sessionStorage('disponibilidad.plantaSeleccionada')` como vigente (D-035 lo retiró). La doc
desincronizada engaña a auditorías futuras.
**Evidencia.** `docs/architecture.md:14,269`.
**Remediación.** Pasada de consolidación de `architecture.md` contra el estado real post D-031/D-035.

---

## Apéndice — Cobertura de la auditoría

Revisado de principio a fin (6 frentes, lectura completa de archivos, no muestreo):

- **Auth/OIDC/sesiones:** `server/auth/*` (app, entra-config, m365, provision, revalidate, roles, sessionStore), `middleware/auth.js`, `middleware/permissions.js`, `utils/entra-roles.js`, `utils/password.js`.
- **Router/endpoints:** `server/server.js` (completo), `utils/http.js`, `utils/errores.js`, `utils/notificador.js`.
- **BD/migraciones:** `server/db.js` (completo), `auth/provision.js`, `auth/sessionStore.js`, `sql/snippets/*`.
- **Scrapers SIS:** `server/utils/sis/*` (carbon-scraper, sis-client, sis-sweeper, xls-parser), `js-scraper-carbon-g32/*` (scrape, xls, xlsx-write, package.json).
- **Frontend:** `src/**` completo (main, BitacorasGecelca3, todos los hooks y componentes, routing, utils), `index.html`, `vite.config.js`, `dist/`.
- **Config/supply-chain:** `.env.example`, `.gitignore`, los tres `package.json` + lockfiles, configs (vite/vitest/postcss/tailwind), `server/data/*`, imágenes de la raíz, READMEs, `docs/auditoria-auth-usuarios-roles-2026-06.md`.
- **Utils restantes + canales WS + tests:** `utils/ws-usuarios-activos.js`, `utils/ws-conteo-bitacoras.js`, `utils/campos.js`, `utils/snapshots.js`, `utils/ciet.js`, `utils/conformacion-snapshot.js`, `utils/mand-sweeper.js`, `utils/turno-sweeper.js`, `utils/turno.js`, `tests/helpers.js`. (`utils/fecha.js` no existe — sus helpers se consolidaron en `turno.js:61-80`, F19; `architecture.md` aún lo lista: ver AUD-38.)

**Controles verificados como correctos (no son hallazgos):** scrypt + `timingSafeEqual` en `password.js`;
PKCE S256 + `state` + `nonce` + regeneración de sesión anti-fixation en el flujo OIDC; saneamiento de
errores D-032 (ningún catch devuelve `err.message`/`stack` crudo); queries de datos parametrizadas con
`.input()` (sin SQLi en la capa transaccional); frontend sin `dangerouslySetInnerHTML`/`eval`/XSS y sin
token en storage (D-031 verificado); rebuild de la matriz de permisos con `TABLOCKX,HOLDLOCK`+rollback;
migraciones F26–F28 idempotentes con validación de conteo + `THROW`; `.env`/`server/.env` nunca
commiteados; sin scripts `postinstall`/`preinstall`.

---

*Generado por auditoría 2026-06-30. Mantén este tablero vivo: marca ✅ y enlaza el `D-NNN` real al
cerrar cada ronda. Cuando todos los ítems estén ✅, este archivo puede archivarse en `docs/`.*
