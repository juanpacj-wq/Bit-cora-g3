# D-065 — GATE-O3 (cierre de la ola O3)

> Expediente **inmutable** del integrador. Si algo de acá se revierte después, se enmienda encima
> ("REVERTIDA el … por …"), no se borra. Fecha: **2026-09-02 09:40** (Bogotá).
> Rama: `feat/rotacion-turnos-2026-08`. BD de la corrida: `PortalG3_dev`.

## 1. Semáforo al cerrar

```
D-065 · rama feat/rotacion-turnos-2026-08

O3 [abierta]
  L07  done        L07-2246     Pantalla de configuración anual (superficie A, front) ← L04
  L08  done        L08-2246     Popup de toma de control (superficie B, front) ← L05
  L09  done        L09-2246     Vista de cumplimiento (superficie C, front) ← L06
  L12  done        L12-2246     Correcciones de la O2 (endpoints, control, Graph y schema)

O4 [pendiente]
  L10  pending                  Cableado en el componente raíz y rutas hash ← L07,L08,L09

test-lock: libre
```

Lotes en `in-progress` o `blocked`: **ninguno**. Los cuatro llegaron con su `cierres/LNN.md`
commiteado; **ninguno hubo que reconstruirlo**. El único bloqueo declarado es el **B1 de L12** —una
edición sobre territorio de L11, lote ya cerrado—, que este gate aplicó (decisión **D1**).

## 2. Territorios

```
=== L07 ===  3 commit(s): be686c2 4581919 b5cbc3b
  prompts/D-065-rotacion-turnos/cierres/L07.md
  src/components/Rotacion/ConfiguracionRotacion.jsx
  src/components/Rotacion/configuracion-rotacion.test.jsx
  src/hooks/useRotacion.js
[lotes] territorio respetado

=== L08 ===  2 commit(s): 7faa4bc 9b205a4
  prompts/D-065-rotacion-turnos/cierres/L08.md
  src/components/Rotacion/PopupTomaControl.jsx
  src/components/Rotacion/popup-toma-control.test.jsx
  src/hooks/useTomaControl.js
[lotes] territorio respetado

=== L09 ===  2 commit(s): 52dac78 fc58722
  prompts/D-065-rotacion-turnos/cierres/L09.md
  src/components/Rotacion/CumplimientoRotacion.jsx
  src/components/Rotacion/cumplimiento-rotacion.test.jsx
  src/hooks/useCumplimiento.js
[lotes] territorio respetado

=== L12 ===  3 commit(s): 387ee29 c683e3b 3049aea
  prompts/D-065-rotacion-turnos/cierres/L12.md
  server/db.js
  server/routes/rotacion.js
  server/tests/rotacion_control.test.js
  server/tests/rotacion_correcciones_o2.test.js
  server/tests/rotacion_endpoints.test.js
  server/utils/graph/cliente.js
  server/utils/graph/directorio.js
  server/utils/rotacion/control.js
  server/utils/rotacion/cumplimiento.js
  server/utils/rotacion/titulares.js
[lotes] territorio respetado
```

**Violaciones: ninguna.** Los tres lotes de front corrieron a la vez sobre el mismo árbol, con los
archivos de los otros dos vivos —y en un caso ya en el índice— y ninguno se coló: los tres
commitearon por pathspec. La disjunción que diseñó el `PLAN-OLAS.md` (tres pantallas + un lote de
backend) se cumplió, y **ningún lote necesitó tocar un archivo compartido**.

## 3. Verificación de la ola (bajo test-lock `GATE-O3`)

### 3.1 Ediciones que hizo este gate antes de correr

| Archivo | Qué | Por qué |
|---|---|---|
| `server/package.json` | `tests/rotacion_correcciones_o2.test.js` justo después de `tests/rotacion_cumplimiento.test.js` (68 → **69** archivos; `zzz_session_leak_guard` **sigue último**) | Lo pidió el cierre de L12 |
| `server/tests/rotacion_schema.test.js` | Caso `F37.A1 · 9` reescrito | **B1 de L12** — decisión **D1** |
| `server/routes/_middleware.js` | `MUTADORES = ['POST','PUT','PATCH','DELETE']`, exportada, y el CSRF la usa | **H-L07-1** — decisión **D2** |
| `server/utils/http.js` | `Access-Control-Allow-Methods` pasa a anunciar `PATCH` | **CR3-3** — completa **D2** |
| `server/tests/http_hardening.test.js` | 3 casos nuevos: la lista de mutadores y su acople con el preflight | Verificador de **D2** |
| `src/hooks/useApi.js` | `api.patch` | **H-L07-3** — decisión **D3** |
| `src/hooks/useRotacion.js` | `patchJSON` local retirado → `api.patch` | Cierra **D3** |

### 3.2 Backend efímero

`M365_CLIENT_SECRET= SIS_HOST=http://localhost:3154 SERVER_PORT=3199 AUTH_TEST_BYPASS=1 node
--env-file=../.env server.js` → `[SERVER] Escuchando en puerto 3199`, `/health` 200. Sin credencial
de Graph (para que CA-6 ejercite el camino real) y con el host del stub del SIS, igual que el
GATE-O2. En el arranque: `[despacho-xm] sweeper DESHABILITADO (AUTH_TEST_BYPASS=1 (backend de test:
no escribe en plantas reales))` — la convención 37(b) de D-064 haciendo su trabajo.

### 3.3 Cifra

La suite se corrió en **16 bloques en primer plano** (la corrida completa excede el tope por comando
de esta sesión), **todos con `--test-concurrency=1`, que es el flag que el propio script `test`
lleva escrito** — ver **H1**, que es la historia de por qué esta frase está acá.

| Bloque | Archivos | Resultado |
|---|---|---|
| 1 | guards ×2, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split sala | `tests 52 · pass 52 · fail 0` |
| 2a | guards ×2, campos_validate, **rotación O1 ×3** | `tests 75 · pass 75 · fail 0` |
| 2b | **rotacion_correcciones, rotacion_endpoints, rotacion_control** | `tests 51 · pass 51 · fail 0` |
| 2c | asientos ×2, asiento_despacho_xm, reflejo_disponibilidad | `tests 58 · pass 58 · fail 0` |
| 3a | F03 ×3, revalidate, fechas_bogota | `tests 105 · pass 105 · fail 0` |
| 3b | turno-entidad, **rotacion_cumplimiento** | `tests 65 · pass 65 · fail 0` |
| 3c | **rotacion_correcciones_o2** (archivo nuevo de L12) | `tests 27 · pass 27 · fail 0` |
| 4a | auth_middleware, auth_reactivate, disponibilidad ×2 | `tests 47 · pass 47 · fail 0` |
| 4b | disponibilidad_reflejo_http, cierre_y_fechas | `tests 16 · pass 16 · fail 0` |
| 4c | sala_de_mando_batch | `tests 85 · pass 85 · fail 0` |
| 5a | conformacion_turno, consumos_combustible, sis_endpoints | `tests 51 · pass 51 · fail 0` |
| 5b | sis_scrape_endpoint (**con stub**), finalizar_turno, cambiar_unidad | `tests 37 · pass 37 · fail 0` |
| 5c | registros ×2, despacho_xm, relleno_despacho_xm | `tests 32 · pass 32 · fail 0` |
| 6 | transición/seguimiento de turno, históricos ×2, 3 guards de no-auto-ejecución | `tests 37 · pass 37 · fail 0` |
| 7 | rol coordinador, rol consulta, sis ×6 | `tests 86 · pass 86 · fail 0` |
| 8 | sis ×2, contrato dashboard, http_hardening, errores, ia ×2, **zzz_session_leak_guard** | `tests 70 · pass 70 · fail 0` |

**Cifra de la ola: `tests 894 · pass 894 · fail 0 · skipped 0`.**

> El bloque 8 se corrió **dos veces**: la primera con `69`, antes de que el `/code-review` trajera
> CR3-3, y la segunda con `70` ya con el arreglo y su caso. La cifra que vale es la segunda. Los
> otros quince bloques no se tocaron después de su corrida.

**Comparación con el baseline.** El de `ESTADO.md` es **861/861** (GATE-O2), y **894 − 861 = 33**
cuadra exactamente con lo que se agregó, sin residuo que explicar:

| Origen | Casos |
|---|---|
| `rotacion_correcciones_o2.test.js` — archivo nuevo de L12 | +27 |
| `rotacion_control.test.js` (13 → 16): L12 rehízo el verificador negativo de CA-11 y midió el `UPDLOCK` | +3 |
| `http_hardening.test.js` (67 → 70): los tres casos que agregó este gate por **D2** y **CR3-3** | +3 |

**Cero rojos nuevos y cero tests preexistentes perdidos.** La suite tampoco tiene ni un `skipped`.

**El deadlock del GATE-O2 (su H4) no se reprodujo:** el bloque 3b salió `65 · pass 65` a la primera,
donde el gate anterior tuvo que relanzar `turno-entidad`. El `UPDLOCK` de CR2-6 ordena ahora los
bloqueos entre `cerrarTurno` y el `TOMAR`, así que hay motivo para esperar que ayude — pero **una
corrida limpia no prueba que el abrazo se cerró**, y la otra mitad (el `turno-sweeper` del propio
backend efímero, deuda H3/D4 del GATE-O1) sigue exactamente donde estaba. Queda como **H15**,
observación, no como cerrado.

### 3.4 Front

```
npm run build   → ✓ built in 4.36s   (exit 0)
npx vitest run  → Test Files 20 passed (20) · Tests 392 passed (392)
```

**324 → 392** son los tres archivos nuevos, medidos: L07 **12** + L08 **30** + L09 **26** = **68**.
`324 + 68 = 392`, sin residuo.

**Lo que el `npm run build` NO prueba, y los tres cierres tienen razón en decirlo:** hoy nadie
importa los tres componentes —el cableado es de L10, en la O4—, así que Rollup no los mete al grafo
y el build verde significa "la ola no rompió el bundle", no "este JSX compila". Quien los compila de
verdad es vitest (esbuild, runtime JSX automático) y quien los parsea enteros es `eslint`.
**La confirmación end-to-end de CA-19/20/21 es de la O4.**

### 3.5 Residuos en BD: ninguno

`npm run test:residuos` → `[residuos] cero residuos`, exit 0, **20 checks en 0**, incluidos los cinco
de rotación y los dos que miran *cualquier planta* (la red que dejó CR2-5, capaz de detectar un
congelado de GEC3/GEC32 con titulares de fixture). Salieron en cero: **la carrera que describen no
ocurrió**, y las fixturas ancladas al pasado que trajo L12 son la razón por la que ya no puede.

### 3.6 CA-23 (cero tareas recurrentes), re-verificado por este gate

`grep -nE "setInterval|setTimeout|cron|sweeper|localStorage|sessionStorage"` sobre los seis módulos
de front de la ola y los cuatro de backend: **una sola ocurrencia real**,
`server/utils/graph/cliente.js:269` — el `setTimeout` del backoff ante un 429, **acotado por el
presupuesto que introdujo CR2-13**, que vive dentro de una petición y no entre peticiones. Todo lo
demás que matchea es la palabra "sin**cron**ización" y comentarios que declaran que NO hay
almacenamiento local. **CA-23 sigue en pie.**

### 3.7 `/code-review` del diff de la ola

`4415d2b..HEAD` más el árbol de trabajo (las ediciones de este gate), nivel `high`. **5 hallazgos de
corrección.** El gate los trió **contra el código, no contra el reporte**: leyó el fuente completo de
cada uno. **Los cinco quedaron confirmados** y están en §7 como **CR3-1 … CR3-5** con su veredicto y
su destino. Uno se arregló acá (CR3-3, archivo sin escritor); los otros cuatro caen sobre territorios
de lotes ya cerrados y van a un lote de corrección — decisión **D5**.

El revisor no encontró escenario concreto en el resto del diff: la reposición de cola de CR2-11, el
`UPDLOCK` sobre `turno_unidad`, el presupuesto de 429, el `COALESCE(@nombre, t.nombre_completo)` del
`MERGE`, el `/titulares` resuelto por `resolverTurnoAbierto` y la migración del índice filtrado.

### 3.8 `/security-review`

Corrido porque la ola estrena un verbo HTTP (`PATCH`), toca el chequeo CSRF de AUD-19, el cliente de
Microsoft Graph (secreto, bearer, `@odata.nextLink`), un `MERGE` sobre `lov_bit.usuario` y SQL
dinámico de DDL en `db.js`.

**Resultado: cero hallazgos que superen la barra de confianza.** Lo verificado, por archivo:

- **`PATCH /api/rotacion/patrones/:id`** — nace **cerrado**: `/api/rotacion/*` no está en
  `PUBLIC_EXACT` ni en `PUBLIC_GET_REGEX`, pasa por `requireEntra` y por `router.use(loadAppSession)`,
  y la primera línea del handler es el gate `puede_configurar_rotacion === true` (flag data-driven,
  sin nombre de cargo). `req.params.id` pasa por `validarEnteroPositivo` (ahora `/^\d+$/` + cota
  `MAX_INT32`) y se bindea `sql.Int`; `req.body.activo` exige booleano; **nada más del cuerpo llega
  a SQL**. Lo único interpolado es `${SELECT_PATRON}`, constante del módulo. Los caminos de rechazo
  hacen `rollback` sin haber escrito.
- **`routes/_middleware.js`** — el cambio de este gate **añade** defensa (extiende el CSRF a `PATCH`);
  no retira ninguna.
- **`graph/cliente.js`** — el `client_secret` sigue solo en el cuerpo del POST de token, nunca en una
  URL ni en un log. El ancla del `@odata.nextLink` por host con barra final resiste las evasiones
  clásicas (`https://graph.microsoft.com@evil.com/` y `…com.evil.com/` fallan el `startsWith`), y
  `redirect: 'error'` corta el pivote por 30x. `errEntra()` compone status, nombre de variable de
  entorno y `e.cause.code`: **nunca `e.message` ni el cuerpo** (D-032).
- **`graph/directorio.js`** — el `omitidas` que estrena CR2-4 y viaja hasta la respuesta HTTP lleva
  **solo conteos**; los `console.warn`/`console.error` nuevos también. **Cero UPNs y cero nombres.**
  `principalId` sigue validado con `esGuid()` antes de interpolarse. Los dos valores nuevos del
  `MERGE` van por `.input()` con tipo y longitud.
- **`db.js` (F37.A4 + `agregarConstraintConPrevuelo`)** — es donde más superficie de SQL dinámico hay.
  Todo lo interpolado sale de literales del propio módulo: **ninguna entrada de usuario, request o
  fila de BD alcanza el DDL**. El `DROP CONSTRAINT` + `CREATE UNIQUE INDEX` va bajo `SET XACT_ABORT
  ON` + transacción, así que no queda ventana sin unicidad.
- **`cumplimiento.js`** — el filtro `es_sintetico` se retiró **solo** de `leerEventosControl`;
  `leerParticipantes`, que es el que D-044 protege, lo conserva. Cambio de semántica de conteo, no de
  control de acceso.
- **Front** — grep negativo de `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`.
  `api.patch` hereda `credentials:'include'`, `withBase` y el logout global ante un 401.

## 4. Criterios confirmados

Solo se marca `cumple` lo que **este gate vio en verde él mismo**, dentro de la corrida completa.

| CA | Propuesto por | Confirmado | Verificador que el gate vio en verde |
|---|---|---|---|
| **CA-19** | L07 | `cumple` | `configuracion-rotacion.test.jsx` — **12 casos**, dentro de los `392 passed` del front. Cubre las cuatro mitades del texto del CA: el agrupamiento por rol (`› arma una tarjeta por rol, con su gente adentro y el conteo por grupo`), asignar `G1..G4` (`› cambiar un grupo marca la pantalla como sucia…`), "sin grupo" (`› quitarle el grupo a alguien manda grupo null…`) y guardar sin recargar (**un solo** POST, y la pantalla queda limpia). Más `› puedeConfigurar = false … deja todo deshabilitado` |
| **CA-20** | L08 | `cumple` | `popup-toma-control.test.jsx` — **30 casos**. Los seis que CA-20 enumera tienen cada uno su test nominal (tabla en el cierre de L08), y los tres cargos que el CA excluye por nombre llegan como `aplica: false` **desde el backend**, con un guard estático que falla si alguno de esos nombres o `es_observador` aparece en el código del lote (convención 12: el front no replica la regla) |
| **CA-21** | L09 | `cumple` | `cumplimiento-rotacion.test.jsx` — **26 casos**. Los cuatro estados distinguibles (4 `data-estado`, 4 etiquetas y 4 colores, `new Set(...).size === 4` en ambos), la fila `PENDIENTE` nombrando a sus titulares ausentes, el filtro por rango y planta (controlado, con el rango completo en el callback) y el rango vacío que dice "Sin datos" y **no** pinta error |
| **CA-3** | L12 (propuesto `parcial`) | `cumple` | L12 lo dejó `parcial` por su bloqueo **B1**; este gate aplicó la edición (**D1**) y `rotacion_schema.test.js` volvió a verde dentro del bloque 2a (`75 · pass 75`). El invariante **no se debilitó**: la UNIQUE natural pasó de key constraint a índice único **filtrado por `activo = 1`**, y `rotacion_correcciones_o2 › CR2-10(b)` lee `sys.indexes` para fijar que es único y filtrado |
| CA-5 … CA-18 | L11/L12 (protegidos) | `cumple` (siguen) | Los verificadores que el GATE-O2 nombró uno por uno, verdes de nuevo dentro de la corrida completa: bloques 2a (75), 2b (51), 3b (65) y 3c (27) |
| **CA-23** | (gate) | `en pie` | §3.6: una sola ocurrencia real de `setTimeout` en todo el territorio del flujo, y es un backoff acotado **dentro** de una petición. Se re-verifica en cada gate |

**CA-22 sigue sin tocar** (es de la O4, con L10). **Ningún CA quedó `parcial` ni `bloqueado`.**

> **Lo que estos tres `cumple` NO dicen.** CA-19, CA-20 y CA-21 están confirmados **en el nivel de
> componente**: cada pantalla monta, se comporta y se prueba contra un `fetch` stubeado. Ninguna está
> **enchufada** todavía —el `npm run build` ni siquiera las mete al bundle (§3.4)—, así que nadie las
> ha visto contra el backend real. Eso es exactamente el trabajo de L10 en la O4, y por eso su prompt
> lista "la confirmación end-to-end de CA-19/20/21" entre sus criterios.

## 5. Decisiones tomadas en este gate

### D1 — El bloqueo B1 de L12 sobre `tests/rotacion_schema.test.js`

- **Qué lo provoca:** `F37.A4` reemplaza la UNIQUE `UQ_rotacion_patron_natural` por el índice único
  **filtrado** `UQ_rotacion_patron_natural_activo` (una constraint no puede filtrar, y sin el filtro
  desactivar un patrón no libera su fecha de inicio). El caso `F37.A1 · 9` lee `sys.key_constraints`,
  donde un índice filtrado no aparece, y queda rojo. El archivo es territorio de **L11**, lote ya
  cerrado, así que L12 no podía tocarlo.
- **Opciones:** a) aplicarla el gate (es un compartido sin escritor vivo) · b) abrir un lote de
  corrección solo para dos líneas de test · c) dejar el rojo documentado hasta el cierre.
  — **Recomendada: (a)**.
- **Decidido: (a).** Se aplicó **la edición exacta que L12 dejó escrita**, sin reinterpretarla.
  (c) era inaceptable: un rojo "esperado" en la suite entrena a leer los rojos como ruido, que es
  justo por donde se cuela el siguiente de verdad. (b) es un chat entero para dos líneas.
- **Qué cambia / qué NO cambia:** el test deja de exigir una key constraint que ya no existe y pasa a
  exigir el índice filtrado con las mismas columnas. **El invariante no se debilita** — sigue habiendo
  algo que impide dos patrones del mismo cargo arrancando el mismo día; ahora solo entre los
  **activos**, que es precisamente lo que hace corregible la carga anual.
- **Enmiendas que produce:** ninguna en un prompt. CA-3 pasa de `parcial` a `cumple` (§4).

### D2 — Un verbo HTTP nuevo nacía sin la defensa CSRF de AUD-19 (H-L07-1, CR3-3)

- **Qué lo provoca:** L07 lo levantó al consumir el `PATCH /api/rotacion/patrones/:id` de L12.
  `csrfMiddleware` chequea el `Origin` de `POST | PUT | DELETE` **escritos a mano**, así que el verbo
  nuevo pasaba sin ese control (verificado leyendo `routes/_middleware.js`). Lo que lo tapaba era que
  `Access-Control-Allow-Methods` no anuncia `PATCH` y el navegador mata el preflight — o sea, el
  sistema quedaba protegido **por accidente**, por una lista que existe para otra cosa.
- **Opciones:** a) agregar `PATCH` al chequeo CSRF · b) que L12 montara el endpoint como `PUT`, con lo
  que heredaba las dos protecciones sin tocar nada · c) dejarlo, apoyándose en el preflight.
  — **Recomendada: (a)**, que es también lo que recomendó L07.
- **Decidido: (a), y completa.** (b) cambia un contrato que el GATE-O2 §6.6 ya fijó y que L07 ya
  consume. (c) apuesta a que nadie agregue `PATCH` a `Access-Control-Allow-Methods`, y el
  `/code-review` mostró que ese "nadie" éramos nosotros: **CR3-3** señaló que dejar el preflight sin
  `PATCH` rompe el endpoint en cualquier despliegue cross-origin, **sin rastro server-side**. Se
  hicieron las **dos mitades**: `MUTADORES = ['POST','PUT','PATCH','DELETE']` como fuente única del
  CSRF, y `PATCH` anunciado en el preflight. Es coherente porque **las dos usan la misma allowlist**
  (`csrfOriginAllowed` confía en la de CORS): un `PATCH` cross-origin ahora pasa el preflight **y** el
  chequeo de Origin, o no pasa ninguno de los dos.
- **Qué cambia / qué NO cambia:** cero cambios de comportamiento para el front, que es same-origin en
  prod (un nginx, sub-paths) y por el proxy de Vite en dev — ahí nunca hubo preflight. Lo que cambia
  es que el hueco dejó de depender de una coincidencia.
- **Verificador:** tres casos nuevos en `tests/http_hardening.test.js`, con el rojo comprobado en las
  dos direcciones (quitar `PATCH` de `MUTADORES` → rojo; quitarlo del preflight → rojo).

### D3 — `useApi` no tenía `PATCH` (H-L07-3)

- **Qué lo provoca:** L07 necesitaba el verbo y `src/hooks/useApi.js` no lo expone. Ese archivo **no
  tiene escritor en ninguna ola** (§8 del contexto base no lo lista), así que L07 armó un `patchJSON`
  local que replica `withBase`, `credentials:'include'` y el `Error` con `.status`/`.codigo`/`.body`,
  y dejó el pedido en su §Bloqueos.
- **Opciones:** a) agregar `api.patch` y dejar el helper local · b) agregar `api.patch` **y** retirar
  el helper · c) no agregarlo.
- **Decidido: (b).** El helper funcionaba, pero **no dispara el `unauthorizedHandler` global** (es
  privado del módulo), así que un 401 en ese endpoint se veía como un error de pantalla en vez de
  cerrar la sesión sola. Dejarlo (a) es conservar el defecto **y** una segunda copia de las reglas de
  transporte. La edición toca `useRotacion.js`, territorio de L07 —lote cerrado, sin dependientes en
  la O4—, y su suite quedó **12/12** después del cambio.
- **Qué cambia:** la regla queda escrita en los dos archivos — **todo verbo nuevo de la app entra por
  `useApi`**, porque la cookie httpOnly, el sub-path del despliegue, el `codigo` de D-032 y el logout
  global viven ahí y no en el call site. Su hermano de backend es `MUTADORES` (D2).

### D4 — El panel de ausencias deja fuera a los de `CUBIERTO_POR_RELEVO` (H-L09-2)

- **Qué lo provoca:** L09 implementó su §4 al pie de la letra (el panel se alimenta de los
  `titulares[].entro === false` de las filas `PENDIENTE` y `PARCIAL`) y **pidió expresamente que el
  gate decidiera**, porque es una pregunta de producto y no de código: un titular que faltó en un
  turno que alguien más cubrió tampoco entró, y no aparece en el panel.
- **Opciones:** a) dejarlo como está — el panel responde *"¿quién dejó el rol sin cubrir?"* ·
  b) incluir también los de `CUBIERTO_POR_RELEVO` — pasa a responder *"¿quién faltó?"* · c) las dos
  listas, separadas. — **Recomendada: (a)**.
- **Decidido: (a), y queda a confirmación del usuario** (§8). Razones: el titular ausente de una fila
  cubierta **sí se ve**, con su ✗, en la columna de titulares de la tabla —no se pierde el dato, se
  pierde el resumen—, y el entregable que se pidió por nombre mide **riesgo operativo**, no
  asistencia individual. Cambiarlo es una línea (`ESTADOS_CON_AUSENCIA`) y un caso: la puerta queda
  abierta.
- **Qué NO cambia:** nada del contrato C6 ni del backend. Es una regla de lectura del front.

> **ENMENDADA el 2026-09-02 por el usuario: se adopta la opción (b), no la (a).** El panel pasa a
> incluir también los ausentes de las filas `CUBIERTO_POR_RELEVO`, o sea que responde **"¿quién
> faltó?"** y no "¿quién dejó el rol sin cubrir?". La recomendación del gate se apoyaba en que el
> dato del ausente cubierto igual se ve en la tabla; el usuario —que es quien pidió el reporte—
> decide que el resumen tiene que contarlo, y esa pregunta la responde él, no el gate. **Va a L13**,
> cuyo territorio crece con `src/hooks/useCumplimiento.js` (donde vive `ausenciasPorTitular`),
> `CumplimientoRotacion.jsx` y su test. Cuidado con el copy: la etiqueta del panel y su subtítulo
> dicen hoy lo que el panel medía antes, y quedarían mintiendo.

### D5 — Qué se hace con los hallazgos del `/code-review` (**pendiente del visto bueno**)

- **Qué lo provoca:** los cinco hallazgos quedaron **confirmados** leyendo el fuente. **CR3-3** cayó
  en `utils/http.js`, sin escritor en ninguna ola → arreglado acá (D2). Los otros cuatro caen sobre
  territorios de **lotes ya cerrados** (`ConfiguracionRotacion.jsx` de L07, `useTomaControl.js` de
  L08, `db.js` de L12), así que no tienen escritor en la O4.
- **Opciones:** a) un lote de corrección **L13** en la O4, en paralelo con L10 · b) metérselos a L10 ·
  c) empujarlos al cierre de la implementación. — **Recomendada: (a)**.
- **Decidido: (a), sujeto al visto bueno.** (b) es exactamente lo que el `PLAN-OLAS.md` prohíbe: L10
  va solo porque toca el archivo más disputado del repo, y cargarle cuatro arreglos ajenos convierte
  el lote de mayor riesgo en el de mayor superficie. (c) no sirve para **CR3-2**, cuyo disparador **lo
  crea L10**: hoy el popup no está montado, así que el estado obsoleto es inalcanzable; el día que L10
  lo cablee, deja de serlo. Arreglarlo después de montarlo es publicar un bug a propósito.
- **Territorio de L13, y por qué es disjunto de L10:**
  `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx`
  · `src/hooks/useTomaControl.js` · `src/components/Rotacion/popup-toma-control.test.jsx` ·
  `server/db.js` · `server/tests/rotacion_correcciones_o2.test.js` · puerto **3119**. L10 tiene
  `src/BitacorasGecelca3.jsx` · `src/routing/appRoute.js` · `src/routing/appRoute.test.js`: **ni un
  archivo en común**.
- **Regla dura para L13, porque es lo único que los ata:** **no puede cambiar la firma de props de
  ningún componente** — L10 está cableando contra las que fijaron los cierres de L07/L08/L09. Un
  arreglo que necesite una prop nueva **no es de L13**: se detiene y se coordina en el GATE-O4.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> Este bloque se copia **tal cual** al inicio del prompt de la ola O4 (`L10`, y `L13` si se aprueba).

1. **Las tres pantallas existen, están probadas y NO están enchufadas.** Nadie las importa, así que
   Rollup no las mete al bundle: el `npm run build` verde de la O3 **no** prueba que su JSX compile
   (lo prueban vitest y `eslint`). L10 es quien las hace reales, y con eso confirma CA-19/20/21
   end-to-end por primera vez.
2. **Props exactas de `ConfiguracionRotacion`** — las dos opcionales, las dos fallan cerradas:
   ```jsx
   <ConfiguracionRotacion
     puedeConfigurar={sesion?.puede_configurar_rotacion === true}   // cae a false
     onError={(codigo) => { /* aviso global; `codigo` puede ser null */ }}   // cae a no-op
   />
   ```
   **No recibe ni devuelve estado de ruta**: no lee ni escribe el hash, no importa `appRoute.js` y no
   acepta `params`. Va bajo `#/rotacion` (C8, `params: {}`). Ocupa el alto disponible con
   `flex-1 flex flex-col overflow-hidden` y hace scroll adentro, como DISP/COMB: **el contenedor de
   L10 tiene que darle un padre con altura** (`h-screen flex flex-col`), o scrollea el documento
   entero y se va la barra de navegación (el mismo softlock que documenta `ConsumosGrid`). Exporta
   además dos helpers puros: `parsearVectorTexto(texto)` y `calcularCambios(personas, buffer)`.
3. **Props exactas de `PopupTomaControl`** — son **cuatro**, no las tres del contrato original: el §3
   listaba `estado`/`onTomar`/`onDescartar`/`onCerrar`, y el §4.4 del mismo prompt exige ofrecer
   "Abandonar el control", que es otro endpoint. La firma es
   `<PopupTomaControl estado onTomar onAbandonar onDescartar onCerrar />`, y `useTomaControl` ya
   devuelve `abandonar()`. **L10 tiene que pasar los cuatro handlers.**
4. **El popup se renderiza SIEMPRE que haya sesión de app viva, y él decide solo si se dibuja**
   (devuelve `null` cuando no aplica). **L10 no debe replicar la condición**: si lo hace hay dos
   verdades para la misma pregunta y una se va a desincronizar. La regla, exportada como
   `modoPopup(estado)`, es en este orden: `aplica === false` → nada · `soy_titular` → nada ·
   `soy_principal` → **abandonar** · `ya_respondi` → nada · si no → **preguntar**. El `soy_principal`
   **antes** de `ya_respondi` es contraintuitivo y deliberado: sin eso la pila no se puede deshacer
   desde la UI.
5. **`useTomaControl(ready, plantaId)` ya reconsulta solo al cambiar de unidad en caliente** (D-054 no
   desmonta el componente). L10 solo le pasa la planta de la sesión; no orquesta nada. Una consulta al
   montar, sin polling. **Ojo con CR3-2** (§7): ese hook todavía no descarta la respuesta obsoleta.
6. **Props exactas de `CumplimientoRotacion`** — es **controlado de verdad, sin valores por defecto
   internos**: si `desde`, `hasta` o `planta` llegan vacíos **no consulta** y lo dice en pantalla.
   ```jsx
   <CumplimientoRotacion
     desde hasta planta                          // requeridas
     onRangoChange={({ desde, hasta }) => {}}    // SIEMPRE los dos campos, no solo el que cambió
     onPlantaChange={(planta) => {}}             // el planta_id, string pelado
   />
   ```
   Para `#/rotacion/cumplimiento` sin parámetros, **usa `rangoPorDefecto()`** (exportado por
   `src/hooks/useCumplimiento.js`): últimos **14 días** Bogotá.
7. **Gotcha de la convención 17 que ya mordió en D-054:** el efecto que deriva el estado desde la ruta
   le da **prioridad a `route.params`** sobre la sesión. Si L10 cablea `planta` desde las dos fuentes,
   tiene que decidir cuál manda **antes** de montar la vista, o pasará lo de DISP: la planta del hash
   revierte la de la sesión.
8. **La precedencia entre el popup y `TurnoTransicionModal` la decide L10, y es una decisión real.**
   Los dos son overlays `z-50` y pueden coincidir — entrar a la unidad en plena gavela de gracia
   (D-046) con el turno todavía ABIERTO da `aplica: true` **y** el modal de transición arriba. L08 no
   lo reprodujo porque hoy nadie monta el popup. Sugerencia de L08, no verificada: no montar el popup
   mientras `turnoHook.bloqueo` esté en `true`, porque la transición bloquea la unidad entera.
9. **`api.patch` YA existe** en `src/hooks/useApi.js`, y `useRotacion.js` lo usa (el `patchJSON` local
   se retiró). **Todo verbo nuevo entra por `useApi`**: ahí viven la cookie httpOnly, el `withBase`
   del sub-path, el `codigo` estable de D-032 y el logout global ante un 401. Su hermano de backend es
   `MUTADORES` en `server/routes/_middleware.js`, hoy fuente única del chequeo CSRF y atada por test
   al `Access-Control-Allow-Methods` de `utils/http.js`: **un verbo se agrega en los dos lados, o en
   ninguno.**
10. **El punto 13 del `GATE-O2 §6` dejó de ser verdad:** un `cargo_id` fuera del rango de `INT` ahora
    responde **400**, no 500. Lo mismo `'1e2'`, `' 12 '`, `'0x10'` y `?cargo_id[]=7`.
11. **El punto 14 del `GATE-O2 §6` dejó de ser verdad:** `GET /titulares` sin `fecha` ni `turno`
    resuelve por la **cabecera ABIERTO de la unidad**, así que ya concuerda con `/control/estado` y
    `/cumplimiento` incluso durante una extensión. Pasarle `fecha` y `turno` explícitos sigue siendo
    lo recomendable, pero ya no es obligatorio.
12. **El punto 12 del `GATE-O2 §6` cambió a medias:** el umbral de la sincronización ya cuenta
    **personas**, y `POST /sincronizar-entra` devuelve además
    `omitidas: { total, grupos, usuarios, personas_estimadas }`. El consejo sigue en pie —mostrar el
    `total` y el `por_rol` **que devolvió la respuesta**, nunca un número prometido de antemano— y
    ahora además hay que **mostrar `omitidas`**: hoy la pantalla no la lee, y ese es **CR3-4**.
13. **El punto 6 del `GATE-O2 §6` está entregado:** `PATCH /api/rotacion/patrones/:id` existe, con el
    contrato del §6.6 y dos adiciones aditivas — acepta `activo: true` (reactivar, con `409` si choca)
    y responde `400 activo_invalido` si el cuerpo no trae un booleano.
14. **`GET /patrones` puede traer una fila con `vector_invalido: true`** y, en ese caso, sus
    `vector_t1`/`vector_t2` vienen **como texto crudo, no como arreglo**, y `grupo_t1`/`grupo_t2` en
    `null`. Es deliberado (CR2-8: que el administrador pueda **listar** para encontrar la fila mala).
    **Hoy la pantalla revienta con esa fila** — es **CR3-1**, el hallazgo de peor consecuencia de la
    ola.
15. **`POST /asignaciones`:** una salida (`grupo: null`) el mismo día en que empieza la asignación ya
    **no** da 409 (elimina la fila, que nunca tuvo efecto), y un relevo con `vigente_hasta` explícito
    crea **dos** filas —la suplencia y la continuación de la cola—, así que `creadas` puede ser 2 para
    un solo elemento del lote.
16. **Cero polling, cero `localStorage`/`sessionStorage`, cero tareas recurrentes (CA-23).** La O3 no
    agregó ni un `setInterval`; el único `setTimeout` del flujo es el backoff acotado del 429. **No lo
    estrenes tú.** El "no volver a preguntar" del popup es `ya_respondi` del backend, con guard
    estático que lo vigila.
17. **`--test-concurrency=1` no es opcional.** El script `test` lo lleva escrito; correr
    `node --test tests/` a pelo produce rojos **espurios** por `initDB()` concurrente
    (`There is already an object named 'autorizacion_dashboard' in the database`). Ver **H1**.

## 7. Hallazgos consolidados (deduplicados entre lotes)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H1 | gate (corrida) | **`CLAUDE.md:22` documenta el comando de tests SIN `--test-concurrency=1`**, y `server/tests/README.md` dice lo contrario ("usar siempre `npm test`"). Este gate cayó en la trampa: el bloque 1 salió con 11 y luego 17 rojos, y el mensaje —`There is already an object named 'autorizacion_dashboard'`— no se parece en nada a una carrera de `initDB()`. Con el flag: 52/52 | media (rojo espurio que se lee como regresión) | **Cierre** — corregir esa línea de `CLAUDE.md` |
| H2 | gate | **8 archivos `.test.js` del disco están fuera del script `test`** (69 de 77): `fecha_futura_registros`, `rol_admin_debugging`, `routes_middleware`, `session_crypto`, `sis_parse_isolated`, `turno_reabrir`, `turno_vigencia`, `ws_session`. El gate los corrió: **43/43 verdes**. Supera al H6 del GATE-O2, que solo veía `turno_reabrir` | media | **Cierre** — engancharlos es una línea y están verdes. No es territorio de D-065 |
| CR3-1 | `/code-review` | **La pantalla de configuración revienta justo con la fila que CR2-8 existe para mostrar.** `mapPatron` devuelve los vectores **crudos** (string) + `vector_invalido: true`; el front hace `p.vector_t1.join(', ')` (`:620-621`) y `origen.vector_t1.join(',')` al copiar (`:567`), y **nunca lee `vector_invalido`**. Con una fila corrupta: `TypeError` → pantalla en blanco. Se cambió un 500 por un vidrio roto, que es peor: el 500 al menos queda en el log | **media** — confirmado leyendo los dos lados | **L13** (D5) |
| CR3-2 | `/code-review` | **`useTomaControl` no descarta la respuesta obsoleta.** `refrescar()` solo se protege con `desmontadoRef`, y el efecto lo **resetea a `false`** al principio para la unidad nueva: el GET de la unidad vieja aterriza después y pisa el estado. Al cambiar GEC3→GEC32 en caliente (D-054 no desmonta), el popup queda con el `turno_id`/`principal` de la unidad anterior y su `useEffect([turnoId])` lo **vuelve a abrir**. `useCumplimiento` resolvió esto mismo con `secuenciaRef`: dos lotes de la misma ola, dos respuestas al mismo problema | **media**, hoy **inalcanzable** (nadie monta el popup) | **L13**, y **antes de que L10 lo cablee** — L10 es quien crea el disparador |
| CR3-3 | `/code-review` | `Access-Control-Allow-Methods` no anunciaba `PATCH`: en un despliegue cross-origin el preflight mata el único camino que existe para corregir una carga anual mal digitada, **sin rastro server-side** | media | **Arreglado en el gate** (D2), con su caso y su rojo comprobado |
| CR3-4 | `/code-review` | **`omitidas` no llega a la pantalla.** L12 la agregó a la respuesta justo para que la superficie A pudiera decir "faltaron N" (CR2-4), y L07 —escrita en paralelo— no la lee: un grupo de 14 personas que no respondió se ve **idéntico** a una sincronización completa, porque un grupo omitido aporta cero al `por_rol` y no hay contra qué comparar. Es la mitad de transparencia de CR2-4, sin cerrar | media | **L13** (D5) |
| CR3-5 | `/code-review` | **El CHECK es más estricto que el parser que espeja.** `parsearVector` "tolera espacios alrededor de cada número" (lo dice su docstring), así que `'1, 1, 3, 3, 4, 4, 2, 2'` funciona perfecto en runtime pero falla el `LIKE` + `DATALENGTH = 15`. Una fila así —solo alcanzable por SQL a mano, que es justo el escenario para el que existe el CHECK— hace que el pre-vuelo **omita la constraint en cada arranque, para siempre**, y que `F37.A4` nunca se registre: el invariante de CR2-1 no se instala nunca, en silencio, y el remedio que imprime pide corregir una fila que no está mal | baja | **L13** (D5) |
| H-L07-1 | L07 | El `PATCH` nuevo quedaba fuera del CSRF de AUD-19 | media | **Arreglado en el gate** (D2) |
| H-L07-3 | L07 | `useApi` sin `PATCH` → un 401 en ese endpoint no cerraba la sesión sola | baja | **Arreglado en el gate** (D3) |
| H-L07-2 | L07 | `POST /asignaciones` exige un `cargo_id` que la salida de la rotación (`grupo: null`) **ignora**: para sacar a alguien hay que mandar un rol que el backend no usa, y el front tiene que ir a buscarlo sabiendo que da igual cuál mande. Funciona; es una asimetría del contrato que el próximo lector va a leer como significativa y no lo es | baja | **Cierre** (o L13, si lo toca de paso) |
| H-L09-2 | L09 | El panel de ausencias deja fuera a los ausentes de las filas `CUBIERTO_POR_RELEVO` | baja | **D4, enmendada por el usuario el 2026-09-02:** se incluyen → **L13**. El panel pasa a medir asistencia, no cobertura |
| H-L09-1 | L09 | `src/utils/fecha.js` no tiene formateadores de **presentación**, y ya hay dos copias del mismo (`SeguimientoTurnos.jsx:7` y esta vista). Hoy los dos formatos coinciden y hay un caso que lo fija en TZ hostil | baja | **Cierre** (consolidación) |
| H-L09-3 | L09 | `ESTADOS` vive dos veces: el de `src/hooks/useCumplimiento.js` es espejo literal del de `server/utils/rotacion/cumplimiento.js`, y nada los ata. Hermano del H8 del GATE-O2 (pila LIFO duplicada) y del espejo `ROL_POR_BITACORA` de D-052 | baja | **Cierre** (con guard, si se decide fijarlo) |
| H-L12-1 | L12 | **`LIKE` de SQL Server ignora los blancos finales del valor:** un CHECK `col LIKE '[1-4],…'` acepta `'1,1,3,3,4,4,2,2 '` (medido: `MATCH`, `DATALENGTH 16`) y `LEN` tampoco los cuenta. Cualquier CHECK de formato del repo que se apoye solo en `LIKE` tiene el mismo agujero | media | **Cierre** → `CLAUDE.md` |
| H-L12-2 | L12 | **Una constraint gateada por su nombre nunca adopta un cambio de definición.** Pasó dentro del propio lote: la primera versión del CHECK (sin `DATALENGTH`) alcanzó a aplicarse en dev y el arranque siguiente la dio por buena. Cambiar una definición exige **una migración nueva con nombre nuevo** | baja | **Cierre** → `CLAUDE.md` + runbook |
| H15 | gate | El deadlock H4 del GATE-O2 **no se reprodujo** con el `UPDLOCK` de CR2-6. Pero la otra mitad del abrazo —el `turno-sweeper` del backend efímero, que cierra GEC3/GEC32 cada 60 s también bajo `AUTH_TEST_BYPASS`— sigue exactamente donde estaba (deuda H3/D4 del GATE-O1, **fuera de alcance de D-065**) | baja | Observación. Al ADR, como supuesto |
| H-L08-1 | L08 | El popup y `TurnoTransicionModal` pueden coincidir en pantalla, los dos con `z-50` | baja | **L10** (hecho §6.8) |
| H-L08-2 | L08 | `import.meta.url` **no** es una URL `file:` bajo la transformación de vitest: un guard estático en un test de front tiene que resolver por `process.cwd()` | informativa | Al cierre, como gotcha |
| H-L12-3 | L12 | `GET /titulares` hace ahora una lectura de BD extra (la cabecera ABIERTO) cuando falta `fecha` o `turno`: un `SELECT TOP 1` por PK sobre ~2 filas por día y planta | informativa | Ninguno |
| H-L07-4 | L07 | La nómina real son ~81 personas en una sola pantalla, **sin buscador ni filtro**. Con el directorio simulado de 5 no se nota; la carga anual real es una lista larga de tarjetas | baja, **no verificada** | **Smoke con datos reales**, en el cierre |

## 8. Ola siguiente

- **Prompt enmendado en cabecera** ("ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto") con
  el §6 copiado tal cual: `L10-cableado-raiz.md`. Su sección ya estaba reservada esperando este gate.
- **Reparto revisado — un cambio:** la **O4 pasa de 1 a 2 lotes** con `L13`, el lote de corrección de
  la O3 (decisión **D5**). Queda escrito en `PLAN-OLAS.md` y en `LOTES.json` como `pending` dentro de
  una ola `pendiente`, así que **nadie puede reclamarlo** hasta el `ola-abrir O4`, que solo ocurre con
  el visto bueno. Si el visto bueno lo rechaza, se retira con una enmienda encima de este expediente.
- **Lo que NO cambió:** los ocho contratos del `_CONTEXTO-BASE.md`, el territorio de L10 y su
  condición de lote aislado sobre el archivo más disputado del repo.

| Lote | Título | Territorio |
|---|---|---|
| L10 | Cableado en el componente raíz y rutas hash | `src/BitacorasGecelca3.jsx` · `src/routing/appRoute.js` · `src/routing/appRoute.test.js` |
| L13 ⭑ | Correcciones de la O3 (pantalla de configuración, hook del popup y schema) | `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx` · `src/hooks/useTomaControl.js` · `src/components/Rotacion/popup-toma-control.test.jsx` · `server/db.js` · `server/tests/rotacion_correcciones_o2.test.js` · puerto **3119** |

⭑ Lote nuevo, abierto por este gate (D5). **Sin dependencias y sin dependientes**: su chat se abre a
la vez que el de L10 y sus territorios no comparten un solo archivo. **Regla dura: L13 no cambia la
firma de props de ningún componente** — L10 está cableando contra las que fijaron los cierres de la
O3, y un arreglo que necesite una prop nueva se detiene y se coordina en el GATE-O4.

**Visto bueno del usuario: DADO el 2026-09-02.**

- **D5 aprobada:** `L13` se abre **en paralelo con L10**, como recomendaba el gate.
- **D4 enmendada:** el usuario eligió la opción (b) — el panel de ausencias **sí** incluye a los
  ausentes de las filas `CUBIERTO_POR_RELEVO`. Va a **L13**, que por eso suma tres archivos a su
  territorio: `src/hooks/useCumplimiento.js`, `src/components/Rotacion/CumplimientoRotacion.jsx` y
  `src/components/Rotacion/cumplimiento-rotacion.test.jsx`. **Sigue sin compartir un archivo con
  L10.** `ola-abrir O4` ejecutado.

## 9. Commit del gate

`9ab5243` `gate(D-065): O3 cerrada — 4 lotes, 894/894 backend, 392/392 front, 0 violaciones`
