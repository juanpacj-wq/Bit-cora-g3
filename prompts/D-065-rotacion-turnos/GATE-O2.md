# D-065 — GATE-O2 (cierre de la ola O2)

> Expediente **inmutable** del gate. Lo escribe solo el integrador. Si algo de acá se revierte
> después, se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: **2026-09-01 21:40 (Bogotá)** · Rama: `feat/rotacion-turnos-2026-08` · BD: `PortalG3_dev`.

## 1. Semáforo al cerrar

```
D-065 · rama feat/rotacion-turnos-2026-08

O1 [cerrada] gate: GATE-O1.md
  L01  done        L01-1034     Motor puro del patrón de rotación
  L02  done        L02-1055     Schema de rotación (F37.A1) y flag de cargo (F37.A2)
  L03  done        L03-1055     Cliente de Microsoft Graph y sincronización del directorio

O2 [abierta]
  L04  done        L04-1921     Endpoints de configuración anual (superficie A) ← L01,L02,L03
  L05  done        L05-1922     Toma de control del rol (superficie B, backend) ← L02
  L06  done        L06-1922     Cumplimiento y congelado al cerrar (superficie C, backend) ← L01,L02
  L11  done        L11-1923     Correcciones de la O1 (schema, cliente de Graph y tests)

O3 [pendiente]
  L07  pending                  Pantalla de configuración anual (superficie A, front) ← L04
  L08  pending                  Popup de toma de control (superficie B, front) ← L05
  L09  pending                  Vista de cumplimiento (superficie C, front) ← L06

O4 [pendiente]
  L10  pending                  Cableado en el componente raíz y rutas hash ← L07,L08,L09

test-lock: libre
```

Lotes sin cierre commiteado: **ninguno**. Los cuatro dejaron su `cierres/LNN.md`; ninguno quedó
`in-progress` ni `blocked`. Cero lotes reconstruidos por el gate.

## 2. Territorios

```
=== L04 ===   L04 · 2 commit(s): bf395c3 94191d9
  prompts/D-065-rotacion-turnos/cierres/L04.md
  server/auth/app.js
  server/middleware/auth.js
  server/routes/rotacion.js
  server/tests/rotacion_endpoints.test.js
  server/utils/rotacion/titulares.js
  server/utils/sesion-contexto.js
[lotes] territorio respetado

=== L05 ===   L05 · 2 commit(s): e624dcd 60a61b7
  prompts/D-065-rotacion-turnos/cierres/L05.md
  server/routes/rotacion-control.js
  server/tests/rotacion_control.test.js
  server/utils/rotacion/control.js
[lotes] territorio respetado

=== L06 ===   L06 · 2 commit(s): 1e3c325 a92925a
  prompts/D-065-rotacion-turnos/cierres/L06.md
  server/routes/rotacion-cumplimiento.js
  server/tests/rotacion_cumplimiento.test.js
  server/utils/rotacion/cumplimiento.js
  server/utils/turno-entidad.js
[lotes] territorio respetado

=== L11 ===   L11 · 2 commit(s): 8a9b8b7 7bdb638
  prompts/D-065-rotacion-turnos/cierres/L11.md
  server/db.js
  server/tests/residuos.js
  server/tests/rotacion_correcciones.test.js
  server/tests/rotacion_schema.test.js
  server/tests/rotacion_sync_entra.test.js
  server/utils/graph/cliente.js
  server/utils/graph/directorio.js
[lotes] territorio respetado
```

**Violaciones: ninguna.** Los cuatro corrieron con el `pre-commit` y `LOTE_SESION`, así que la
comprobación la hizo el hook, no la palabra de cada chat. Los tres compartidos con escritor
declarado en la O2 (`auth/app.js` → L04 · `utils/turno-entidad.js` → L06 · `db.js` → L11, heredado
de la O1) los tocó **solo** su dueño. Los cuatro lotes reportaron sin tocar lo ajeno: L06 dejó su
hallazgo sobre `reabrirTurno` escrito en vez de editarlo, y L11 reportó el guard roto de L05 en vez
de arreglar un archivo que no era suyo. Eso es exactamente lo que manda el §8.

## 3. Verificación de la ola (bajo test-lock `GATE-O2`)

**Tests enganchados a `server/package.json`** (64 → 68 archivos; `zzz_session_leak_guard` sigue
último): `tests/rotacion_correcciones.test.js`, `tests/rotacion_endpoints.test.js` y
`tests/rotacion_control.test.js` en las posiciones 15–17 (tras `rotacion_sync_entra`, cerrando el
bloque de rotación), y `tests/rotacion_cumplimiento.test.js` **inmediatamente después de
`turno-entidad`**, como lo pidió el cierre de L06 (es una suite del dominio de turno: abre y cierra
cabeceras de `'TST'` por el camino real).

**Backend efímero** con el código de la rama, **sin credencial de Graph** y con el host del stub del
SIS: `M365_CLIENT_SECRET= SIS_HOST=http://localhost:3154 SERVER_PORT=3199 AUTH_TEST_BYPASS=1 node
--env-file=../.env server.js` → `[SERVER] Escuchando en puerto 3199`, `/health` 200. La suite se
corrió en **16 bloques en primer plano** (la corrida completa excede el tope por comando de esta
sesión); los resultados se suman abajo.

| Bloque | Archivos | Resultado |
|---|---|---|
| 1 | guards ×2, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split sala | `tests 52 · pass 52 · fail 0` |
| 2a | guards ×2, campos_validate, **rotación O1 ×3** | `tests 75 · pass 75 · fail 0` |
| 2b | **rotacion_correcciones, rotacion_endpoints, rotacion_control** | `tests 48 · pass 48 · fail 0` |
| 2c | asientos ×2, asiento_despacho_xm, reflejo_disponibilidad | `tests 58 · pass 58 · fail 0` |
| 3a | F03 ×3, revalidate, fechas_bogota | `tests 105 · pass 105 · fail 0` |
| 3b | turno-entidad, **rotacion_cumplimiento** | `tests 65 · pass 64 · fail 1` ⚠ |
| 3b bis | turno-entidad (relanzado solo) | `tests 35 · pass 35 · fail 0` |
| 4a | auth_middleware, auth_reactivate, disponibilidad ×2 | `tests 47 · pass 47 · fail 0` |
| 4b | disponibilidad_reflejo_http, cierre_y_fechas | `tests 16 · pass 16 · fail 0` |
| 4c | sala_de_mando_batch | `tests 85 · pass 85 · fail 0` |
| 5a | conformacion_turno, consumos_combustible, sis_endpoints | `tests 51 · pass 51 · fail 0` |
| 5b | sis_scrape_endpoint (**con stub**), finalizar_turno, cambiar_unidad | `tests 37 · pass 37 · fail 0 · skipped 0` |
| 5c | registros ×2, despacho_xm, relleno_despacho_xm | `tests 32 · pass 32 · fail 0` |
| 6 | transición/seguimiento de turno, históricos ×2, 3 guards de no-auto-ejecución | `tests 37 · pass 37 · fail 0` |
| 7 | rol coordinador, rol consulta, sis ×6 | `tests 86 · pass 86 · fail 0` |
| 8 | sis ×2, contrato dashboard, http_hardening, errores, ia ×2, **zzz_session_leak_guard** | `tests 67 · pass 67 · fail 0` |

**Cifra de la ola: `tests 861 · pass 861 · fail 0 · skipped 0`.** Este gate corrió el archivo del
SIS **con su stub desde el principio** (lo que el GATE-O1 tuvo que remedir aparte), así que los 5
casos que allá quedaron `skipped` y el rojo deliberado de `CA-53` acá están verdes de entrada: la
suite ya no tiene ni un `skipped`.

**El único rojo (bloque 3b) fue un deadlock de SQL Server, no una regresión.** Salida literal:

```
✖ activarSucesor no hace nada mientras haya un ABIERTO; cerrarTurno cierra y activa el PROGRAMADO
  Error [RequestError]: Transaction (Process ID 98) was deadlocked on lock resources with another
  process and has been chosen as the deadlock victim. Rerun the transaction.
```

Relanzado el archivo completo, sin tocar una línea: `tests 35 · pass 35 · fail 0`. La otra parte del
abrazo es el **`turno-sweeper` del propio backend efímero**, que cierra GEC3/GEC32 cada 60 s (deuda
H3/D4 del GATE-O1) mientras el test cierra su turno de `'TST'`. Lo que este gate **sí** anota como
cambio de esta ola: desde L06, `cerrarTurno` lee dos tablas más dentro de su transacción
(`rotacion_patron`/`rotacion_asignacion` vía `titularesDeTurno`, y `rotacion_control`), así que la
huella de bloqueos del cierre creció. Va como hallazgo H4 con destino, no como flake ignorado.

**Front:** `npm run build` → `✓ built in 15.48s`, exit 0. `npm test` (vitest) →
`Test Files 17 passed (17) · Tests 324 passed (324)`.

**Comparación con el baseline.** El baseline de `ESTADO.md` es **781/781** (GATE-O1). Los cuatro
archivos nuevos de la O2 aportan **78** casos, medidos por este gate: `rotacion_correcciones` 21 +
`rotacion_endpoints` 14 + `rotacion_control` 13 (los tres son el bloque 2b, 48) y
`rotacion_cumplimiento` 30 (bloque 3b, 65, menos los 35 de `turno-entidad` medidos aparte; son los
29 de L06 más el caso de reapertura que agregó este gate). **861 − 78 = 783** preexistentes contra
los 781 que reportó el GATE-O1.

Esa diferencia de **+2 no son tests nuevos: es aritmética del gate anterior**, y queda dicha acá
para que nadie la busque después. El GATE-O1 midió en 12 bloques **sin** el stub del SIS y después
ajustó la cifra a mano dos veces —restó 1 por el archivo del SIS remedido con stub y sumó 1 por el
caso que él mismo agregó a `tests/errores.test.js` a mitad del gate—. Este gate midió los 68
archivos en **una sola condición** (stub arriba, caso de `errores` ya presente), así que 783 es una
medición directa. **Cero rojos nuevos y cero tests preexistentes perdidos.**

**Fuera del script `test`:** `tests/turno_reabrir.test.js` (`tests 3 · pass 3 · fail 0`). No está en
`npm test` desde que lo escribió D-045 y este gate **no lo engancha** (no es territorio de esta ola
ni de esta implementación), pero lo corrió a propósito porque el gate editó `reabrirTurno`. Queda
como hallazgo H6.

**Residuos en BD: ninguno.** `npm run test:residuos` → `[residuos] cero residuos`, exit 0, con
**20 checks** (14 previos + 6 que agregó este gate):

```
  ok       0  rotacion_control en planta de test
  ok       0  rotacion_cumplimiento en planta de test
  ok       0  rotacion_patron creado por usuario sintético o SISTEMA
  ok       0  rotacion_cumplimiento con titulares sintéticos o inexistentes (cualquier planta)
  ok       0  rotacion_control de usuario sintético en planta real
  ok       0  rotacion_asignacion de o por usuario sintético o SISTEMA
```

Los dos que miran **cualquier planta** existen por el hallazgo CR2-5 (ver §7): son la red que
detecta un congelado de GEC3/GEC32 con titulares de fixture. Salieron en cero, así que la carrera
que describen **no ocurrió** en esta corrida.

**`/code-review` del diff de la ola (`3183270..HEAD`, nivel `high`):** 15 hallazgos de corrección
más uno de convenciones y ~12 de limpieza. El gate los trió **contra el código, no contra el
reporte**; los siete que confirmó leyendo el fuente están en §7 como CR2-1…CR2-15 con su veredicto.

**`/security-review`:** corrido porque la ola monta **la primera superficie HTTP** del módulo
(tres routers), toca la resolución de sesión (`middleware/auth.js`, `utils/sesion-contexto.js`), el
`sp_getapplock`, un `MERGE` sobre `lov_bit.usuario` y el secreto de Graph.
**Resultado: cero hallazgos que superen la barra de confianza.** Lo verificado, por archivo:

- **`auth/app.js`** — los tres routers se montan **después** de `requireEntra` y de
  `express.json`, con `expressErrorHandler` de último; ninguna ruta `/api/rotacion*` entró a la
  allowlist pública (`_middleware.js` no se tocó en esta ola). El orden `/control` y `/cumplimiento`
  **antes** de `/api/rotacion` es invariante: un sub-path desconocido cae por `next()` al router
  padre y termina en 404, no en un handler ajeno.
- **`routes/rotacion.js`** — el gate de los tres POST lee **únicamente**
  `req.sesion.puede_configurar_rotacion === true` (comparación estricta, falla cerrada), nunca
  `solo_lectura` ni un nombre de cargo. `POST /sincronizar-entra` llama
  `sincronizarDirectorio(pool, { por_usuario: req.sesion.usuario_id })` y **no toca `req.body` ni
  `req.query`**: las opciones `directorio`/`fetchImpl` son inalcanzables desde el cliente, que era
  el riesgo hacia adelante H4 del GATE-O1 (§6.5 de aquel expediente). **Queda cerrado.**
- **`routes/rotacion-control.js`** — los tres POST no leen cuerpo ni query: turno, planta, cargo y
  usuario salen de `req.sesion`. No hay forma de actuar por otra persona, planta o turno.
- **`routes/rotacion-cumplimiento.js`** — `planta_id` validado contra `lov_bit.planta`
  (data-driven, sin allowlist en el endpoint); rango tope 93 días; slugs de un conjunto cerrado.
- **SQL** — todo parametrizado por `.input()` con tipo y longitud en los tres routers y los cuatro
  módulos de `utils/rotacion/`. El recurso del `sp_getapplock` viaja como parámetro, no interpolado.
- **Secretos y PII** — el `client_secret` solo va en el cuerpo del POST de token; el bearer de Graph
  sigue anclado por host con la barra final; los logs del módulo imprimen conteos e ids, **nunca**
  nombres ni UPNs de las 89 personas.
- **`db.js` (F37.A3)** — DDL estático e idempotente, sin entrada de usuario. Las dos FK compuestas
  nuevas **reducen** superficie: atan `planta_id` (y la clave natural del cumplimiento) al `turno_id`.

## 4. Criterios confirmados

Solo se marca `cumple` lo que el gate vio en verde él mismo, dentro de la suite completa.

| CA | Propuesto por | Confirmado | Verificador que el gate vio en verde |
|---|---|---|---|
| CA-6 (mitad HTTP) | L04 (asignada por el GATE-O1) | `cumple` | `rotacion_endpoints.test.js › CA-6 (mitad HTTP) · POST /sincronizar-entra sin credencial de Graph → 503 entra_no_disponible saneado`. El gate corrió **los dos** procesos con `M365_CLIENT_SECRET=` en blanco, así que el caso ejerció el camino real. **CA-6 queda completo**: la mitad de código la confirmó el GATE-O1, la mitad HTTP este |
| CA-7 | L04 | `cumple` | `› CA-7 · GET /titulares reproduce el oráculo del Excel (20 fechas × 2 turnos, mallas OPS e ING) sin consultar el Excel` — 40 pares contra el fixture del oráculo, con los patrones sembrados **por el POST** (el desfase lo deriva el server) |
| CA-8 | L04 | `cumple` | `› CA-8 · gate: un Ingeniero Jefe de Turno recibe 403 rotacion_no_autorizado en los tres POST` + `› CA-8 · gate: el Gerente de Producción (solo_lectura = 1) crea el patrón OPS y sus asignaciones → 200` |
| CA-9 | L04 | `cumple` | `› CA-9 · relevo: cierra la vigencia anterior e inserta una nueva; el titular de una fecha pasada no cambia` |
| CA-10 | L05 | `cumple` | `rotacion_control.test.js › CA-10 · pila LIFO: A, B, C toman; C, B, A abandonan y el control vuelve al titular` |
| CA-11 | L05 | `cumple` | `› CA-11 · concurrencia: dos TOMAR simultáneos se serializan — un solo principal y los dos eventos en orden` |
| CA-12 | L05 | `cumple` | `› CA-12 · el titular del fondo no abandona (409 titular_no_abandona): la pila nunca queda vacía` |
| CA-13 | L05 | `cumple` | `› CA-13 · descartar: ya_respondi queda en true para ese usuario en este turno, sin tocar la pila` |
| CA-14 | L05 | `cumple` | `› CA-14 · turno CERRADO: los tres verbos → 409 turno_cerrado y el log no se altera; /estado → aplica false` |
| CA-15 | L06 | `cumple` | `rotacion_cumplimiento.test.js › por persona, no por conteo · …` (puro + end-to-end). Es la regla central del módulo y tiene sus propios casos porque los cuatro escalones "clásicos" siguen verdes con un contador por participantes |
| CA-16 | L06 | `cumple` | `› escalones · …` ×4 + `› un titular que tomó el control NO es relevo` + `› D-059 · un titular que entra como OBSERVADOR no satisface el slot` |
| CA-17 | L06 | `cumple` | `› congelado · cerrarTurno deja UNA fila por (fecha, planta, turno, cargo) …; cerrar dos veces no duplica` + `› congelado · un cierre con CERO patrones activos NO falla: filas = 0 y el turno queda CERRADO` |
| CA-18 | L06 | `cumple` | `› reporte de rango · …` + los cinco casos HTTP, **re-verificados contra el `auth/app.js` ya commiteado por L04** (era la desviación 7 de su cierre) |
| CA-3, CA-4, CA-5 | L11 (protegidos) | `cumple` (siguen) | `rotacion_schema.test.js` 17/17 y `rotacion_sync_entra.test.js` 11/11 dentro de la suite completa, más los 21 de `rotacion_correcciones.test.js` |
| CA-23 | (gate) | `en pie` | `grep -E "setInterval|cron|sweeper"` sobre los siete módulos nuevos de la ola y los tres routers: **cero** ocurrencias. La ola no agregó ni una tarea recurrente. Se re-verifica en cada gate |

**Ningún CA nuevo queda `parcial` ni `bloqueado`.** Los que faltan (CA-19 a CA-22) son de las olas
O3 y O4 y no se tocaron.

## 5. Decisiones tomadas en este gate

### D1 — Los tres hallazgos de L06 sobre archivos sin escritor en la ola

- **Qué lo provoca:** el cierre de L06 dejó tres cosas escritas y sin tocar, porque su territorio en
  `turno-entidad.js` era "solo añadir la llamada al congelado": (1) `reabrirTurno` borra la
  conformación del turno pero **no** su cumplimiento, así que el re-cierre no lo refresca (queda
  `PENDIENTE` para siempre aunque el titular sí haya entrado); (2) los barridos de fixtures que
  borran `turno_unidad` **no conocen** las dos tablas nuevas que la referencian por FK, así que el
  día que haya un patrón vigente que cubra la fecha de un turno de `'TST'` el `after()` de una suite
  ajena revienta con 547; (3) el comentario de `utils/rotacion/titulares.js` documenta un contrato
  con L06 que no existe.
- **Opciones:** a) **arreglarlos en este gate** · b) un lote de corrección en la O3 · c) dejarlos
  para el cierre de la implementación. — **Recomendada: a.**
- **Decidido: a.** Los tres caen sobre archivos **sin escritor en ninguna ola** del §8
  (`tests/helpers.js`, `tests/turno-entidad.test.js`, quince archivos de test más, y el bloque de
  `reabrirTurno`), que es literalmente el caso que la regla del gate reserva para el integrador. b)
  llegaría tarde: el 547 lo dispara la primera carga anual real, no la O3. c) deja la trampa armada
  durante dos olas. **Hecho en este gate, antes de correr la suite**, así que la verificación de
  arriba ya lo cubre:
  - `utils/turno-entidad.js`: `reabrirTurno` borra `rotacion_cumplimiento` del turno, en el mismo
    bloque que la conformación. **`rotacion_control` NO se toca**: es un log append-only y su pila
    se deriva por `turno_id`; las tomas siguen valiendo mientras el turno viva.
  - `tests/rotacion_cumplimiento.test.js`: un caso nuevo que lo prueba de punta a punta —
    `› reabrir · reabrirTurno borra el cumplimiento congelado y el re-cierre lo recongela con la
    verdad nueva` (cierra `PARCIAL`, reabre, entra el segundo titular, re-cierra → `COMPLETO`). Sin
    el borrado el caso queda rojo en la aserción de `COMPLETO`.
  - Las dos tablas entraron a **todos** los barridos de `turno_unidad` de la suite: `tests/helpers.js`
    (el `NOT EXISTS` de cabeceras huérfanas), `turno-entidad`, `turno_seguimiento`,
    `turno_transicion_write_gate`, `turno_reabrir`, `registros_turno_id`, `registros_solo_autor`,
    `rol_usuario_consulta`, `despacho_xm`, `relleno_despacho_xm`, `disponibilidad_reflejo_http`,
    `f03_datos`, `reflejo_disponibilidad` y `sala_de_mando_batch`.
  - `utils/rotacion/titulares.js`: el comentario corregido a la lectura que decidió el gate (D2).
- **Qué cambia / qué NO cambia:** nada de lo que `cerrarTurno` hace. Cambia que reabrir un turno
  ahora deja el cumplimiento sin congelar, que es el estado correcto para un turno ABIERTO (la
  consulta C6 lo deriva en vivo).

### D2 — Qué significa un rol con patrón pero sin nadie en el grupo de guardia

- **Qué lo provoca:** hallazgo 3 de L06. `titulares.js` (L04) dice en su cabecera que ese rol "sí
  aparece, con `personas: []` — es exactamente lo que L06 necesita para marcarlo PENDIENTE"; el
  prompt de L06 dice lo contrario y así quedó implementado (no se congela fila).
- **Opciones:** a) la lectura de L04 (congelar `PENDIENTE` con 0 titulares) · b) **la de L06** (no
  hay fila) · c) dejar las dos y decidir en el front. — **Recomendada: b.**
- **Decidido: b.** Marcar "PENDIENTE, 0 de 0 titulares" cuenta como incumplimiento un turno en el
  que **nadie debía venir**, y ensucia el reporte que el usuario pidió por nombre ("qué titulares no
  entraron"). c) no es una opción: dejaría dos verdades para la misma pregunta. El código ya hacía
  b); lo que se corrigió es el comentario de `titulares.js`, que era el que mentía. `titularesDeTurno`
  **sigue** devolviendo el rol con `personas: []` — eso no cambia, y para el popup de L05 significa
  "sin fondo" (`principal: null`).
- **Qué cambia / qué NO cambia:** ni una línea de lógica. Cambia la documentación y queda fijado
  para L09, que es quien pinta el reporte.

### D3 — El guard estático D-055 estaba en rojo por el `limpiarTodo` de L05

- **Qué lo provoca:** lo levantó L11 en su cierre y **este gate lo reprodujo**: `node --test
  tests/guard_no_prod_historico_destruction.test.js` → `✖ Regla D-055 … 2 !== 0`, señalando
  `rotacion_control.test.js:212-213` (`DELETE FROM bitacora.registro_historico` y `registro_activo`
  "sin acotador de fixture"). El `DELETE` **sí** estaba acotado (`WHERE planta_id = @p`, con `P =
  TEST_PLANTA_ID`), pero el batch de `limpiarTodo` era tan largo que el `.input('p', …)` quedaba a
  más de 700 caracteres del statement, o sea **fuera de la ventana** que el guard mira hacia atrás.
  Un falso positivo del detector, pero un rojo real en la suite: el guard es el archivo 1 y 2 del
  script `test`.
- **Opciones:** a) ampliar la ventana del guard · b) **partir el batch de L05 en tres requests**,
  cada uno con su `.input('p', …)` · c) agregar un acotador redundante en el texto SQL. —
  **Recomendada: b.**
- **Decidido: b.** a) debilita el guard para toda la suite por un solo archivo, y la ventana
  asimétrica de 700/400 es una decisión medida de D-055. c) es un comentario disfrazado de código.
  b) además es más honesto con lo que el guard quiere leer: cada `DELETE` con su binding a la vista.
  El `limpiarTodo` de L05 quedó en tres requests (rotación · cabeceras de TST · sesiones y usuarios),
  con el `DECLARE @mios` extraído a una constante compartida. Verificado: `tests 8 · pass 8 · fail 0`
  en los dos guards, y verde otra vez dentro de la suite completa (bloque 1).
- **Además**, el guard se amplió con lo que esta ola trajo: las **cuatro tablas de rotación** entran
  a `TABLAS_PROTEGIDAS` (el log de relevos es la auditoría de "quién tenía el control" y el patrón es
  la carga anual: un `DELETE` sin acotar contra la BD del `.env` los borraría), y dos acotadores
  nuevos que los tests de rotación ya usaban — el namespace de oids de fixture `00000000-d065-…` y
  el prefijo de username `test_rot` —, los mismos que cuenta `residuos.js`.

### D4 — El deadlock del bloque 3b

- **Qué lo provoca:** ver §3. `activarSucesor` murió como víctima de deadlock; relanzado, verde.
- **Opciones:** a) anotarlo como flake y seguir · b) **registrarlo como hallazgo con destino** y
  dejar el arreglo (`WITH (UPDLOCK)` en la re-verificación de estado de `control.js`) al lote de
  corrección · c) arreglarlo en este gate. — **Recomendada: b.**
- **Decidido: b.** c) toca `utils/rotacion/control.js`, territorio de un lote cerrado, **después** de
  haber corrido la suite completa: o invalido la verificación de la ola o la corro otra vez entera
  (~75 min) por un rojo que no se reprodujo. Y el arreglo no es gratis: el cierre de L05 dejó
  explicado que **omitió el `UPDLOCK` a propósito**, porque con él el bloqueo de fila serializaría
  por sí solo y el verificador negativo de CA-11 ("quita el `sp_getapplock`") seguiría verde por la
  razón equivocada. Cambiarlo exige rehacer ese verificador, que es trabajo de lote, no de gate.
  a) no: el `/code-review` predijo esta clase exacta de abrazo (CR2-6) por lectura, antes de que yo
  lo viera en la corrida. Va a **L12** con las dos cosas juntas: el `UPDLOCK` y el verificador nuevo.
- **Qué cambia / qué NO cambia:** nada del código hoy. Cambia que queda medido, con la salida
  literal y con la observación de que la huella de bloqueos de `cerrarTurno` creció en esta ola.

### D5 — Qué se hace con los hallazgos del `/code-review` (**pendiente del visto bueno**)

- **Qué lo provoca:** el `/code-review` del diff de la ola devolvió 15 hallazgos de corrección. Tras
  el triaje del gate contra el código, **siete quedan confirmados por lectura directa del fuente** y
  el resto son plausibles y anotados. Todos caen sobre `routes/rotacion.js`,
  `utils/rotacion/{titulares,control,cumplimiento}.js`, `utils/graph/*`, `db.js` y los tests de
  L04/L05 — es decir, **territorios de lotes ya cerrados**, y otra vez ninguno tiene escritor en la
  ola siguiente, porque la O3 es entera de front.
- **Opciones:**
  a) Arreglarlos **en este gate**, ahora.
  b) **Un lote de corrección `L12` en la O3**, backend puro, territorio disjunto de L07/L08/L09.
  c) Repartirlos entre los tres lotes de front.
  d) Dejarlos todos para el cierre de la implementación.
  — **Recomendada: b.**
- **Por qué b y no las otras.** a) es el mismo argumento del GATE-O1: reescribir un router, la
  paginación de Graph y una migración **después** de haber corrido la suite completa invalida la
  verificación de la ola o cuesta correrla otra vez entera. c) es lo peor: le mete ediciones de
  backend a tres chats de front que no tienen ni el contexto ni el territorio. d) es la que más
  duele acá, y por una razón concreta: **cuatro de los siete confirmados son de la superficie de
  configuración, que es justo lo que L07 va a manejar en la O3**. Si L12 no corre con L07, la
  pantalla de la carga anual se construye contra un backend en el que **no existe forma de corregir
  un patrón cargado con error** (CR2-10), y esa es la operación que el usuario hace una vez al año,
  la primera vez con gente aprendiendo. b) los agrupa donde pertenecen, en la ola en que se
  necesitan, con territorio disjunto y su propio test.
- **Riesgo de b, dicho explícito:** L12 entrega el `PATCH /api/rotacion/patrones/:id` que **L07
  consume en la misma ola**. Es la misma coordinación que el GATE-O1 aceptó cuando L04 montó los
  routers de L05 y L06 antes de que existieran: el contrato lo fija este gate (§6, punto 6), L07
  escribe contra él, y si al probar todavía no está montado, eso es coordinación de la ola y no un
  bloqueo. Se mitiga además con `depende_de: []` — **L12 no bloquea a nadie y nadie lo bloquea**.
- **Decidido: SÍ, va L12** (visto bueno del usuario, 2026-09-01). Agregar un lote cambia el reparto
  de la ola, y ese es el único punto de este gate donde no decido solo. `L12` queda escrito en
  `LOTES.json` y `PLAN-OLAS.md`, y la O3 se abrió con los cuatro lotes.
- **Visto bueno del usuario: DADO** el 2026-09-01. `L12` confirmado y la O3 abierta.
- **Qué NO entra en L12, y por qué:** el `turno-sweeper` bajo `AUTH_TEST_BYPASS` (H3/D4 del GATE-O1)
  sigue fuera de alcance: es deuda de D-064 y precede a esta rama. Los ~12 hallazgos de limpieza del
  `/code-review` (duplicación de la pila LIFO en dos módulos, tres listas de slugs, el barrido de FK
  copiado en quince tests) van al **cierre de la implementación**, no a L12: son consolidación, y
  consolidar mientras la O3 escribe encima es cómo se rompe una ola que ya está verde.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> Este bloque se copia **tal cual** al inicio de cada prompt de la ola O3.

1. **Las tres superficies existen y están probadas por HTTP.** Los routers se montan en
   `auth/app.js` en el orden `/api/rotacion/control` → `/api/rotacion/cumplimiento` →
   `/api/rotacion`, y **ese orden es invariante**: si alguien lo cambia, `loadAppSession` correría
   dos veces por request y un 404 de `/control/*` saldría del router equivocado. No lo toques: el
   front no necesita saber más que las rutas.
2. **`puede_configurar_rotacion` YA viaja en la sesión** como booleano, en `/api/me` y en lo que
   devuelven `select-context` y `cambiar-unidad` (los dos SELECT espejo de `middleware/auth.js` y
   `utils/sesion-contexto.js`). L07 lo lee de la sesión, igual que los otros flags de cargo, y
   **nunca** compara nombres de cargo.
3. **`GET /asignaciones` devuelve además `personas`**, la nómina asignable: filas con `azure_oid` y
   `activo = 1`, con `ultimo_cargo_id`/`ultimo_cargo_nombre` (el cargo de su última sesión) y su
   asignación vigente en la fecha. **`ultimo_cargo_id` es `null` para quien nunca ha iniciado
   sesión**, y tras la primera sincronización real eso son ~78 de 81 personas: la pantalla de L07
   **necesita un selector de cargo por persona**, no puede asumir que vienen pre-agrupadas por rol.
4. **`POST /asignaciones`** recibe `{ asignaciones: [{ usuario_id, cargo_id, grupo, vigente_desde?,
   vigente_hasta? }] }` y responde `{ creadas, cerradas, actualizadas, sin_cambio, total }`.
   `vigente_desde` ausente = hoy Bogotá; `vigente_hasta` ausente = vigencia abierta (`9999-12-31`);
   **`grupo: null` = la persona sale de la rotación** (queda supernumeraria). Recargar el mismo lote
   es idempotente (`sin_cambio`). El lote es **atómico** y el 4xx trae el `indice` del elemento malo.
   Tope: 500 asignaciones por solicitud.
5. **`POST /patrones`** acepta los vectores como arreglo o como texto, **ignora** `desfase` y `ancla`
   si el cliente los manda, y responde el patrón con `grupo_t1`/`grupo_t2` derivados (lo que digitó
   el administrador). Los 409 son `patron_duplicado` (misma `fecha_inicio`) y `patron_solapado` (otro
   patrón activo del cargo cubre parte del periodo), y traen `patron_id`.
6. **Hoy NO existe forma de corregir un patrón cargado con error, y eso lo arregla L12 en esta misma
   ola** (decisión D5, hallazgo CR2-10). El router solo tiene `GET` y `POST` de `/patrones`, `activo`
   siempre se escribe en 1, y `UQ_rotacion_patron_natural (cargo_id, fecha_inicio)` **no filtra por
   `activo`**: ni siquiera poner `activo = 0` a mano libera esa fecha de inicio. **Contrato que L12
   entrega y L07 consume:** `PATCH /api/rotacion/patrones/:id` con `{ activo: false }`, gated por
   `puede_configurar_rotacion`, `200 { patron }` · `404 patron_no_encontrado` · `403
   rotacion_no_autorizado`; y la UQ pasa a filtrada por `activo = 1` para que reponer el patrón
   corregido con la misma fecha de inicio sea posible. **L07: escribe la pantalla contra ese
   contrato.** Si al probar todavía no está montado, es coordinación de la ola, no un bloqueo.
7. **`GET /api/rotacion/control/estado` devuelve exactamente las 9 claves de C5, en ese orden**, y
   `principal` es **siempre** `pila[pila.length - 1]` (o `null` si el rol no tiene titulares ni
   tomas). Con el turno cerrado responde **`200 { aplica: false, turno_id: null }`, no 409** — entrar
   en la gavela entre turnos es un caso normal, no un error. Los tres POST van **sin cuerpo** y
   devuelven el mismo shape; `/descartar` agrega además `ok: true`.
8. **Los slugs de 409 del control** son `ya_es_principal`, `no_es_principal`, `titular_no_abandona`,
   `turno_cerrado`, `control_ocupado` y uno que C5 no enumeraba: **`rotacion_no_aplica`** (el cargo
   no rota o está excluido por R12). Todos llegan como `{ error, codigo, mensaje }`: **ramifica por
   `codigo`**, nunca por el texto (D-032).
9. **Cumplimiento (C6):** los 400 son `rango_requerido`, `fecha_invalida`, `rango_invalido`,
   `rango_excesivo` (> 93 días) y `planta_invalida`, más los seis del motor. `resumen` trae
   **siempre** las cuatro claves aunque estén en 0. `congelado: false` marca el turno en curso
   (derivado en vivo); las filas congeladas traen el `cargo_nombre` **de la época**, no el actual, y
   **nunca** incluyen usuarios sintéticos.
10. **Un rol con patrón activo pero sin nadie asignado al grupo de guardia NO produce fila de
    cumplimiento** (decisión D2): 0 de 0 no es un estado, nadie debía venir. Para el popup de L08 ese
    mismo caso llega como `principal: null`. Un rango vacío es un resultado normal, no un error.
11. **Reabrir un turno ahora borra su cumplimiento congelado** (decisión D1), así que el re-cierre lo
    recongela con la verdad nueva. Para L09: una fila que desaparece del reporte porque el turno se
    reabrió es correcto, y vuelve al cerrar.
12. **La sincronización con Entra puede responder `200` con menos gente de la esperada.** Tolera
    fallos **por asignación** y solo lanza `entra_no_disponible` si falla más de la mitad, pero el
    conteo cuenta **asignaciones (14: 13 grupos + 1 usuario directo), no personas** (CR2-4): si se
    caen los grupos grandes, el 200 puede traer 20 personas en vez de 81 y el único rastro es una
    línea en el log. **L07: muestra el `total` y el `por_rol` que devuelve la respuesta, nunca un
    número prometido de antemano**, y deja el conteo por rol a la vista — es lo que le permite al
    administrador notar que falta gente. `503 entra_no_disponible` ya sale saneado por HTTP y debe
    mostrarse como aviso **no bloqueante**: el resto de la pantalla sigue usable.
13. **Un id fuera del rango de `INT` en la query responde 500, no 400** (CR2-2, lo arregla L12):
    `validarEnteroPositivo` no tiene tope de 32 bits, así que `cargo_id=2147483648` pasa la
    validación y revienta en el driver. No construyas la UI apoyándote en un 400 ahí.
14. **`GET /titulares` sin `fecha` ni `turno` resuelve el "turno en curso" por reloj de pared**, no
    por el turno ABIERTO de la unidad (CR2-15), así que durante una extensión (D-046) puede nombrar
    un turno distinto del que dicen `/control/estado` y `/cumplimiento`. **Pásale siempre `fecha` y
    `turno` explícitos** si necesitas que las tres superficies coincidan.
15. **Cero polling, cero `localStorage`/`sessionStorage`, cero tareas recurrentes** (CA-23). El
    "no volver a preguntar" del popup sale de `ya_respondi` del backend, y la ola O2 no agregó ni un
    `setInterval`: no lo estrenes tú.

## 7. Hallazgos consolidados (deduplicados entre lotes)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H1 | L06 | `reabrirTurno` borraba la conformación pero no el cumplimiento: el re-cierre congelaba sobre la fila vieja y el titular que entró tras reabrir quedaba `PENDIENTE` para siempre | media | **Arreglado en el gate** (D1), con su caso end-to-end |
| H2 | L06 | Ningún barrido de fixtures conocía los dos dependientes nuevos de `turno_unidad`: el primer patrón vigente que cubra la fecha de un turno de `'TST'` haría fallar con 547 el `after()` de una suite ajena | media | **Arreglado en el gate** (D1): 14 archivos de test + `helpers.js` + `residuos.js` |
| H3 | L11 → gate | El guard estático D-055 en rojo por la ventana de 700 caracteres contra el batch de `limpiarTodo` de L05 | media (rojo real en la suite) | **Arreglado en el gate** (D3), y el guard ampliado con las 4 tablas de rotación |
| H4 | gate (corrida) | Deadlock de `activarSucesor` contra el `turno-sweeper`; verde al relanzar. La huella de bloqueos de `cerrarTurno` creció en esta ola (lee dos tablas más dentro de su transacción) | media | **L12** (D4), junto con CR2-6 |
| H5 | L05 | Con RCSI activado aparecería una ventana en la que un `TOMAR` puede comprometer después de que el congelado leyó el log. Medido: `is_read_committed_snapshot_on = 0` en `PortalG3_dev`, así que hoy los bloqueos de fila lo serializan | baja (hoy no ocurre) | Al ADR como supuesto explícito. **Si algún día se activa RCSI, esto se rompe en silencio** |
| H6 | gate | `tests/turno_reabrir.test.js` **nunca estuvo en el script `test`** (lo escribió D-045 y quedó fuera). El gate lo corrió a mano por haber editado `reabrirTurno`: 3/3 | baja | **No se enganchó**: no es territorio de D-065. Al cierre, como deuda de la suite |
| H7 | L04 | La nómina de `personas` infiere el cargo de la última sesión: tras la primera sincronización real, ~78 personas llegan con `ultimo_cargo_id = null` | baja | Hecho §6.3 para L07. Persistir el cargo del directorio sería schema = fuera de alcance |
| H8 | L06 | La pila LIFO existe dos veces (`control.js` y `cumplimiento.js`), derivada del mismo §5.2. Los casos puros de L06 replican la secuencia de CA-10 para que una divergencia se note | baja | **Cierre de la implementación** (consolidación) |
| H9 | L06/L04 | `TZ=America/Bogota date` en Git Bash de Windows imprime UTC: las sesiones `LNN-HHMM` salen 5 h adelantadas (`L06-1922` eran las 14:22) | informativa | Gotcha de la metodología, al cierre |

### Del `/code-review` (triados por el gate contra el código)

Destino `L12` = el lote de corrección de la decisión **D5**, sujeto al visto bueno.

| # | Archivo | Hallazgo | Veredicto del gate | Severidad | Destino |
|---|---|---|---|---|---|
| CR2-1 | `turno-entidad.js` + `titulares.js` | Un `rotacion_patron` con un vector malformado hace **imposible cerrar el turno en las dos plantas**: `congelarCumplimiento` corre sin guard dentro de `cerrarTurno`, `titularesDeTurno` parsea **todos** los patrones activos (sin filtro de planta) y `parsearVector` lanza → rollback del cierre entero, cada 60 s | **confirmado** en mecánica; el disparador exige SQL a mano (el POST valida) y la columna `VARCHAR(32)` no tiene CHECK | alta (consecuencia) / baja (disparador) | **L12** — CHECK de formato en `F37.A4` |
| CR2-6 | `control.js` | La re-verificación de `estado = 'ABIERTO'` dentro de la transacción es un `SELECT` sin `UPDLOCK`; con `cerrarTurno` concurrente se forma un ciclo de bloqueos y el `TOMAR` sale **500 `db_error`**, no el `409 turno_cerrado` que promete CA-14 | **confirmado** por lectura, y **corroborado por el deadlock observado** (H4). El arreglo obliga a rehacer el verificador negativo de CA-11 (L05 omitió el `UPDLOCK` a propósito) | media | **L12** |
| CR2-10 | `routes/rotacion.js` + `db.js` | **No existe camino para corregir un patrón cargado con error.** Solo hay `GET`/`POST`; `activo` siempre se escribe en 1; y la UQ `(cargo_id, fecha_inicio)` no filtra por `activo`, así que ni desactivándolo a mano se libera esa fecha | **confirmado** leyendo el router y el DDL. Ya lo había reportado L04 en su cierre | media | **L12** — `PATCH` + UQ filtrada. Contrato en §6.6 |
| CR2-2 | `routes/rotacion.js` + `titulares.js` | `validarEnteroPositivo` no tiene tope de `INT32` ni chequeo de forma: `2147483648`, `'1e2'`, `' 12 '` y `[7]` pasan la validación y revientan dentro del driver → **500 `db_error`** en cinco endpoints en vez del 400 prometido | **confirmado** por lectura (`Number.isInteger` sobre `Number(valor)`, sin cota) | media | **L12** |
| CR2-8 | `routes/rotacion.js` | `GET /patrones` mapea los vectores **fuera** del `try` que traduce los errores del motor: una sola fila malformada convierte el listado entero en **500**, así que el administrador no puede ni listar los patrones para encontrar el malo | **confirmado** por lectura | media | **L12** |
| CR2-7 | `cumplimiento.js` vs `control.js` | Los dos lectores del log de control **no filtran igual**: el del cumplimiento excluye `es_sintetico = 1`, el del popup no. El principal que muestra el popup y el relevo que congela el cierre pueden salir de conjuntos distintos de eventos | **confirmado** por lectura. Solo muerde con una cuenta real cuyo username empiece por `test_` | baja | **L12** |
| CR2-9 | `graph/directorio.js` | El `WHEN MATCHED` del MERGE pisa `nombre_completo` con el UPN o con el GUID crudo cuando Graph devuelve `displayName` vacío — la misma forma de fallo que L11 blindó con `COALESCE` para `azure_upn`/`azure_tid`, dos líneas más abajo | **confirmado** por lectura | media | **L12** |
| CR2-4 | `graph/directorio.js` | El umbral de tolerancia (> 50 %) cuenta **asignaciones**, no personas: 6 de 13 grupos pueden caerse y la sincronización responde 200 con un directorio a medias que parece válido. `omitidas` no llega a la respuesta | **confirmado** por lectura (el contador vive en el bucle sobre asignaciones) | media | **L12** + hecho §6.12 |
| CR2-15 | `routes/rotacion.js` | `GET /titulares` sin parámetros arma el "turno en curso" con **dos lecturas independientes del reloj** y por ventana de pared, no por el turno ABIERTO: puede nombrar un turno distinto del de `/control/estado` y `/cumplimiento` durante una extensión | **confirmado** por lectura | baja | **L12** + hecho §6.14 |
| CR2-5 | tests de L04/L05 | Las dos suites siembran patrones activos sobre cargos **reales** en ventanas que cubren hoy, mientras el `turno-sweeper` del backend de test cierra GEC3/GEC32: un cierre de planta real durante la corrida congelaría titulares de fixture en el histórico | **confirmado** como riesgo; **no ocurrió** en esta corrida (los dos checks nuevos de `residuos.js` salieron en 0). La suite hermana de L06 fija su fixture en marzo de 2025 justamente para evitarlo | media | **Mitigado en el gate** (2 checks en `residuos.js`); anclar las fixturas a una ventana pasada va a **L12** |
| CR2-3 | `routes/rotacion.js` | Una "salida" (`grupo: null`) el mismo día en que empieza una asignación se rechaza con `409 asignacion_conflicto` y un mensaje que describe otro caso; el rodeo deja a la persona como titular fantasma por un día | plausible (no reproducido) | media | **L12** |
| CR2-11 | `routes/rotacion.js` | Un relevo **acotado** (con `vigente_hasta` explícito) trunca la asignación anterior y no repone la cola: la persona sale de la rotación en silencio, con un 200 que parece exitoso. La suite solo ejercita relevos de vigencia abierta | plausible (no reproducido) | media | **L12** |
| CR2-12 | `db.js` | Las FK compuestas de `F37.A3` se agregan `WITH CHECK` sin pre-vuelo: una fila con drift preexistente aborta `initDB` con un 547 pelado y el server no arranca | plausible; solo lo dispara una fila escrita fuera de la app | baja | **L12** |
| CR2-13 | `graph/cliente.js` | El manejo del 429 puede dormir hasta 10 s por llamada sin presupuesto acumulado (16 llamadas por lectura del directorio) dentro de la petición del administrador, que nginx corta a los 60 s | plausible | baja | **L12** |
| CR2-14 | `graph/cliente.js` | `leerJsonAcotado` llama `getReader()` fuera del `try`, así que un cuerpo ya consumido lanza un `TypeError` sin `.codigo` y sale 500 en vez del 503 estable | plausible; ningún camino de producción reusa una `Response` hoy | baja | **L12** |

**Refutados por el revisor mismo o por el gate**, y anotados para que no se redescubran: la degradación
de rol al omitir un grupo, el logueo de chunks parciales, la semántica de abandonar antes de cerrar,
`activo` en `POST /asignaciones` y un supuesto `grupo_invalido → 500` (inalcanzable). Los ~12
hallazgos de limpieza (pila LIFO duplicada, tres listas de slugs, el barrido de FK copiado en quince
tests, `flagsCargo` releyendo lo que ya está en `req.sesion`) van al **cierre**, no a L12.

## 8. Ola siguiente

- **Prompts enmendados en cabecera** ("ENMIENDAS Y HECHOS QUE CAMBIAN — léelas antes que el resto"),
  con el §6 copiado tal cual: `L07-front-configuracion.md`, `L08-front-popup.md`,
  `L09-front-cumplimiento.md`.
- **Reparto revisado — un cambio**, ya escrito en `PLAN-OLAS.md` y `LOTES.json`: **la O3 pasa de 3 a
  4 lotes** con `L12`, el lote de corrección de la O2 (D5). Queda en `pending` dentro de una ola
  `pendiente`, así que **nadie puede reclamarlo** hasta el `ola-abrir O3` — que solo ocurre con el
  visto bueno. Si el visto bueno lo rechaza, se retira con una enmienda encima de este expediente.

  Lo que **no** cambió: las dependencias de L07/L08/L09, que siguen siendo lotes de front puros sin
  compartidos entre sí, y los ocho contratos del `_CONTEXTO-BASE.md`.
- **Visto bueno del usuario: DADO el 2026-09-01.** `L12` aprobado; `ola-abrir O3` ejecutado.

| Lote | Título | Territorio |
|---|---|---|
| L07 | Pantalla de configuración anual (superficie A, front) | `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx` · `src/hooks/useRotacion.js` |
| L08 | Popup de toma de control (superficie B, front) | `src/components/Rotacion/PopupTomaControl.jsx` · `src/components/Rotacion/popup-toma-control.test.jsx` · `src/hooks/useTomaControl.js` |
| L09 | Vista de cumplimiento (superficie C, front) | `src/components/Rotacion/CumplimientoRotacion.jsx` · `src/components/Rotacion/cumplimiento-rotacion.test.jsx` · `src/hooks/useCumplimiento.js` |
| L12 ⭑ | Correcciones de la O2 (endpoints, control, Graph y schema) | `server/routes/rotacion.js` · `server/utils/rotacion/{titulares,control,cumplimiento}.js` · `server/utils/graph/{cliente,directorio}.js` · `server/db.js` · `server/tests/rotacion_correcciones_o2.test.js` · `server/tests/{rotacion_endpoints,rotacion_control}.test.js` · puerto **3118** |

⭑ Lote nuevo, abierto por este gate (D5). **Sin dependencias y sin dependientes**: su chat se abre a
la vez que los otros tres. Es el **único** lote de backend de la O3, así que su territorio es disjunto
de los tres de front por construcción.

## 9. Commit del gate

`{{sha}}` `gate(D-065): O2 cerrada — 4 lotes, 861/861 backend, 324/324 front, 0 violaciones`
