# D-065 · Ola O1 · Lote L03 — Cliente de Microsoft Graph y sincronización del directorio

> **Un lote = un chat.** Este archivo, junto con las secciones de `_CONTEXTO-BASE.md` que cita,
> basta para ejecutarlo completo. No relees el scaffolding entero.
> Redactado por el integrador el 2026-08-31.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L03 --sesion L03-HHMM
```

Si falla, **detente y reporta el mensaje**. Anota tu id de sesión: lo necesitas para `done` y para
el test-lock.

## 1. Lee, en este orden y solo esto

1. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §2.3, §6 (contrato C3), §7, §9**.
2. `server/utils/entra-roles.js` completo (~80 líneas) — **solo lectura**. `ROLE_TO_CARGO` :16 es
   el mapa App Role → `lov_bit.cargo.nombre`; `PRECEDENCE` :39 resuelve el multi-rol.
3. `server/utils/ia/` (los dos archivos) — **solo lectura**. Es el **modelo a copiar** para hablar
   con un servicio externo desde el backend: credencial que nunca sale del server, degradación a 503
   con código estable, y qué se loguea y qué no (D-047).
4. `server/utils/errores.js` — `responderError` / `mensajeUsuario` (D-032).
5. `server/tests/helpers.js` — `TEST_TAG` :107, `call()` :151, `deactivateSyntheticSessions()` :128.
6. `CLAUDE.md` del subrepo, convenciones **16** (saneamiento de errores), **23** (D-047: la clave
   jamás llega al front; en prod el FortiGate intercepta TLS y se resuelve con `NODE_EXTRA_CA_CERTS`,
   **nunca** desactivando la verificación) y **12** (nada hardcodeado por cargo).

## 2. Territorio — lo único que puedes crear o editar

- `server/utils/graph/cliente.js` *(nuevo)*
- `server/utils/graph/directorio.js` *(nuevo)*
- `server/tests/rotacion_sync_entra.test.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L03.md` *(tu cierre)*

**NO tocas** nada más. En particular: `server/db.js` (lo escribe **L02** en esta ola),
`server/utils/rotacion/**` (lo escribe **L01** en esta ola), `server/utils/entra-roles.js`
(lo lees, no lo editas), `server/auth/**`, `server/routes/**`, `server/package.json` (gate),
`.env` (lo toca el integrador, avisando), `ESTADO.md`, `docs/decisions.md`, `CLAUDE.md`, `BIT-*`.

Si necesitas un cambio fuera de tu territorio: detente ahí, escribe en tu cierre bajo `Bloqueos` la
edición **exacta** que necesitas, marca `lotes.mjs block L03 --motivo "…"` y sigue con lo que sí puedes.

## 3. Contrato

> Copiado literal de `_CONTEXTO-BASE.md §6 · C3`. L04 lo consume en la O2.

```js
// server/utils/graph/directorio.js

/** Consulta Graph y devuelve el directorio de la Enterprise App. NO escribe en BD.
 *  Lanza Error con .codigo='entra_no_disponible' si falta credencial o Graph no responde. */
export async function leerDirectorioEntra() : Promise<{
  personas: Array<{ azure_oid: string, nombre: string, upn: string, activo: boolean,
                    role: string, cargo_nombre: string|null }>,
  grupos:   Array<{ nombre: string, role: string, miembros: number }>,
}>

/** Aprovisiona/actualiza lov_bit.usuario por azure_oid. NUNCA crea una fila si ya existe una con
 *  ese azure_oid; NUNCA hace match por nombre ni por username. */
export async function sincronizarDirectorio(pool, { por_usuario }) : Promise<{
  creados: number, actualizados: number, total: number,
  por_rol: Record<string, number>,
}>
```

`cargo_nombre` sale de `ROLE_TO_CARGO`; es `null` si el App Role no está en el mapa (equivale a
"Default Access": esa persona aparece asignada pero **no puede entrar**, D-031).

**Consumes:** nada. Eres una de las tres raíces del grafo. `sincronizarDirectorio` recibe el `pool`
por parámetro: no importes `db.js`, que lo escribe L02 en esta misma ola.

## 4. Trabajo

**Qué se sabe (medido el 2026-08-31 contra el tenant real):**

- La secuencia de Graph que funciona, con `client_credentials` y scope
  `https://graph.microsoft.com/.default`:
  1. `POST https://login.microsoftonline.com/{M365_TENANT_ID}/oauth2/v2.0/token`
  2. `GET /servicePrincipals?$filter=appId eq '{M365_CLIENT_ID}'` → el SP y sus `appRoles`
  3. `GET /servicePrincipals/{spId}/appRoleAssignedTo?$top=999` → 14 asignaciones
  4. Por cada asignación de tipo `Group`:
     `GET /groups/{principalId}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName,accountEnabled&$top=999`
- Los permisos **de aplicación** `User.Read.All` + `GroupMember.Read.All` ya están concedidos con
  consentimiento de admin desde 2026-07-15. Son **de aplicación**, no delegados: en
  `client_credentials` los delegados no aplican (el claim `roles` sale vacío y Graph responde
  `403 Authorization_RequestDenied`).
- El resultado actual: **13 grupos + 1 usuario directo**, 14 App Roles, 81 personas en roles de
  rotación. La tabla completa de conteos está en `_CONTEXTO-BASE.md §2.3`.
- **Dos grupos están vacíos**: `COORDINADOR_CARBON_MAQUINARIA` y `ADMINISTRADOR_DEBUGGING`.
  Eso es un hecho operativo, no un error a mitigar: tu código tiene que tolerarlo sin ruido.
- `lov_bit.usuario` tiene estas columnas: `usuario_id, nombre_completo, email, password_hash,
  es_jefe_planta, es_jdt_default, activo, username, azure_oid, azure_upn, azure_tid, es_sintetico`.
  **No tiene `cargo_id`**: el cargo llega del App Role en cada login (D-031). Por eso el directorio
  devuelve `role`/`cargo_nombre` y el módulo de rotación lo usa para agrupar, pero **no** lo
  persiste en `lov_bit.usuario`.

**La sospecha (verifícala, no te la creas):** que la sincronización pueda hacer `MERGE … ON
nombre_completo` o `ON username`. **No.** En prod hay **13 personas duplicadas** (fila legacy
`atafur` + fila Entra `atafur@GECELCA.COM.CO`) y el Excel muestra que los nombres traen typos. El
match es **exclusivamente por `azure_oid`**, que es el mismo identificador con el que
auto-aprovisiona el login (D-031); así, cuando la persona entre por primera vez, calza con tu fila
en vez de crear otra. Un `MERGE ON u.azure_oid = @oid` y nada más. Los duplicados preexistentes
**no se arreglan en este flujo**: no los borres, no los fusiones, no los toques.

1. `cliente.js` — token + `GET` a Graph. Cachea el token en memoria hasta su `expires_in` menos un
   margen. **Sin dependencias nuevas**: `fetch` es nativo en Node ≥ 20 y el backend tiene seis
   dependencias y así se queda.
2. `directorio.js` — `leerDirectorioEntra()` (orquesta los 4 pasos y arma el shape del contrato) y
   `sincronizarDirectorio(pool, {por_usuario})` (el `MERGE` por `azure_oid`, en transacción).
3. **Degradación (CA-6):** si falta `M365_CLIENT_SECRET`/`M365_TENANT_ID`/`M365_CLIENT_ID`, o si
   Graph no responde, lanza `Error` con `.codigo = 'entra_no_disponible'`. El server **no se cae** y
   el arranque **no depende de Graph**: no llames a Graph desde `initDB` ni desde el bootstrap.
4. **Qué NO se loguea (regla dura):** la respuesta cruda de Graph trae los UPN de 89 personas, y el
   secret del `.env` es además llave de lectura del directorio. Loguea **solo conteos**
   (`[graph] directorio: 13 grupos, 81 personas, 5 creados`), nunca nombres, UPNs ni el cuerpo de la
   respuesta. Mismo criterio que D-047 con el texto del operador.
5. **El test se escribe contra una respuesta capturada**, no contra la red: guarda un fixture
   pequeño y anonimizado dentro del propio archivo de test (3–4 personas inventadas, 2 grupos, un
   `appRoleId` que no está en `appRoles` para el caso "Default Access"). Inyecta el transporte
   (parámetro opcional `{ fetchImpl }` en `cliente.js`) para poder probar sin red. **La llamada real
   la verificas a mano una vez y reportas el resultado en el cierre.**

## 5. Criterios de aceptación y sus verificadores

| CA | Criterio | Verificador |
|---|---|---|
| **CA-5** | La sincronización aprovisiona por `azure_oid`: una persona ya existente **no** genera fila nueva, y una nueva entra con su `azure_oid` para que su primer login calce | `tests/rotacion_sync_entra.test.js › "sincronizarDirectorio"` — siembra un usuario sintético con `azure_oid` conocido, corre la sincronización con un directorio capturado que lo incluye + una persona nueva, y verifica `creados = 1`, `actualizados = 1` y que `COUNT(*)` del `azure_oid` sembrado sigue en **1**. Caso negativo explícito: dos personas con nombres casi iguales y `azure_oid` distintos → **dos** filas, no una |
| **CA-6** | Sin `M365_CLIENT_SECRET` o con Graph caído, el módulo degrada a **503 `entra_no_disponible`** y **el server no se cae**; el resto sigue usable | `tests/rotacion_sync_entra.test.js › "degradación"` — (a) sin credencial → `.codigo === 'entra_no_disponible'`; (b) `fetchImpl` que lanza / que devuelve 500 → mismo código; (c) tras el fallo, `GET /health` del backend efímero sigue respondiendo 200 |

**Regla del verificador bidireccional:** rompe a propósito el `MERGE` para que matchee por
`nombre_completo` y confirma que CA-5 se pone **rojo** señalando la fila duplicada; restaura y
confirma el verde. La salida literal de ambas corridas va en tu cierre.

## 6. Verificación que corres (solo la tuya)

```bash
cd server
node --check utils/graph/cliente.js
node --check utils/graph/directorio.js
node --check tests/rotacion_sync_entra.test.js

# Toca BD (siembra usuarios sintéticos) → test-lock OBLIGATORIO.
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-lock --sesion <tu sesión>

SERVER_PORT=3113 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js &

TEST_BASE_URL=http://localhost:3113 node --env-file=../.env --test tests/rotacion_sync_entra.test.js

node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-unlock --sesion <tu sesión>
# y apaga tu backend efímero.
```

- **No corras `npm test` completo**: eso lo hace el gate.
- **Los usuarios que siembres van con `es_sintetico = 1`** y se limpian con
  `deactivateSyntheticSessions()` (`helpers.js:128`). **Nunca por username** (convención 28):
  el guard `zzz_session_leak_guard.test.js` corre último en la suite y falla nombrando al ofensor.
- **Cero residuos.** Deja la query de verificación en tu cierre.
- La verificación **contra la red real** es manual y se hace una sola vez, con el `.env` del
  usuario. Reporta en el cierre: cuántos grupos, cuántas personas, y si el FortiGate dejó pasar el
  TLS desde tu máquina. Si no pasa, **eso es un hallazgo, no un bloqueo del lote**: el código sigue
  siendo correcto y en prod se resuelve con `NODE_EXTRA_CA_CERTS` (DEPLOY.md §7).

## 7. Cierre (obligatorio, en este orden)

1. Escribe `prompts/D-065-rotacion-turnos/cierres/L03.md` con la plantilla
   `../metodología de implementación/plantillas/CIERRE-LOTE.md`.
2. Commitea **solo tus rutas** (sin firmas de IA):
   ```bash
   git commit -m "$(cat <<'EOF'
   feat(D-065 L03): cliente de Microsoft Graph y sincronización del directorio de Entra

   <por qué; root cause si hubo pivot>
   EOF
   )" -- server/utils/graph/cliente.js server/utils/graph/directorio.js \
        server/tests/rotacion_sync_entra.test.js \
        prompts/D-065-rotacion-turnos/cierres/L03.md
   ```
   **Un lote que no commiteó no cerró.** Cita los SHA en el cierre.
3. `node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 done L03 --sesion <tu sesión>`
4. Termina el chat con este mensaje, **con esta forma exacta**:
   ```
   L03 cerrado.
   Commits: <sha> <título>
   Criterios (propuestos, confirma el gate): CA-5 cumple · CA-6 cumple
   Hallazgos nuevos: <ninguno | uno por línea, con escenario concreto>
   Bloqueos: <ninguno | archivo + edición exacta que necesito>
   Para el gate: enganchar tests/rotacion_sync_entra.test.js en el script test de server/package.json;
                 resultado de la verificación manual contra Graph real; <hechos que cambian para L04>
   ```

## Reglas (no negociables)

- `git commit -- <rutas>` siempre; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore,
  switch, rebase, amend, push, merge.
- **Nunca desactives la verificación TLS** (`NODE_TLS_REJECT_UNAUTHORIZED=0` y equivalentes están
  prohibidos), ni siquiera "para probar". Si el FortiGate estorba, se resuelve con la CA corporativa.
- **Nunca loguees UPNs, nombres ni el cuerpo de la respuesta de Graph.** Solo conteos.
- No agregues dependencias a `server/package.json`: `fetch` es nativo.
- No inventes datos: si falta algo, placeholder + `Bloqueos`, no una suposición silenciosa.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
- Tuteo colombiano estándar en todo texto y comentario; sin voseo.
