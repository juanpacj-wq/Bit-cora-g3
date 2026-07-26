# D-057 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable), este
> archivo se actualiza en CADA etapa:
> - **Al empezar** una etapa: leerlo para saber qué quedó hecho, qué se descubrió y qué desviaciones
>   acumuladas hay.
> - **Al terminar** una etapa: registrar qué se hizo, archivos tocados, resultado de tests,
>   desviaciones y datos descubiertos.
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.

**Branch del flujo:** `feat/mand-correccion-lote-2026-07` (crear desde `main` con D-056 ya mergeado).

## Tablero de avance

| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Carpeta `prompts/D-057-correccion-lote-mand/` con `PREGUNTAS-D-057.md` (11 respuestas congeladas en 3 rondas), `_CONTEXTO-BASE.md`, `ESTADO.md` y `E1..E5`. |
| E1 — `PUT /lotes/:lote_id` (diff quirúrgico) | ✅ | Corrección por lote con diff quirúrgico (UPDATE/INSERT/DELETE conservando `lote_id`, `registro_id` y autoría), lock REDESP sobre el delta, metadata a nivel de lote y recálculo de la publicación por celda tocada. + 3 pruebas de humo. |
| E2 — `DELETE /lotes/:lote_id` (borrado real) | ✅ | Borrado real de las N filas del lote (acotado por PK), recálculo de cada celda liberada → el publicado retrocede al lote anterior vigente o la fila de `evento_dashboard` desaparece. Sin lock de REDESP, por decisión. + 2 pruebas. |
| E3 — Cobertura: 14 criterios + guards transversales | ✅ | 14 tests nuevos `D-057 E3.1..E3.14` (criterios REQ-04 §6 que caen en el flujo + los borde que muerden: `lote_sin_celdas`, `409 lote_cerrado`/`404`, `fecha_evento` heredada, `turno_id` por periodo, auditoría selectiva). Guard de coherencia de lote **extraído** a `verificarCoherenciaDeLotes()` y corrido también tras un `PUT` (E3.14). De paso, corregido el flake de `turno=1` hardcodeado en los seeds de sesión de `consumos_combustible` y `rol_coordinador_carbon_maquinaria` (expulsión del sweeper en T2). |
| E4 — Front: acciones en el listado + modal de corrección | ✅ | Lápiz y basurero en el listado del día (solo con `puedeCrear`), modal de corrección (hora / funcionario / descripción / periodos con agregar-quitar, tipo inmutable, lock REDESP visual) y confirmación de borrado con el resumen del lote. `useSalaDeMando` suma `editarLote`/`eliminarLote`; `MOTIVO_MSG` se movió a `motivos.js` con una segunda redacción para la corrección. + 4 tests de front nuevos. |
| E5 — Docs + ADR D-057 + cleanup | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas

> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno con la etapa
> que lo originó y si tiene o no impacto funcional.

- **[E1] El branch salió de `feat/mand-append-only-2026-07`, no de `main`.** `_CONTEXTO-BASE`/E1 asumían
  "D-056 ya mergeado a main" y no lo está: los 4 commits de D-056 viven en ese branch. Crear
  `feat/mand-correccion-lote-2026-07` desde `main` habría dejado a E1 sin el modelo de lotes sobre el
  que opera. Sin impacto funcional; al mergear, este branch trae D-056 + D-057 juntos.
- **[E1] `valor_mw` nulo/vacío en el body del `PUT` NO es error: se omite.** E1 lo pedía "finito y no
  nulo"; se resolvió como "no viaja" — idéntico al `POST /guardar`, que también omite la celda vacía.
  Consecuencia buscada: vaciar una celda en el modal la BORRA por ausencia, sin que el front tenga que
  filtrar el payload. El lote que queda sin ninguna celda sigue rebotando con `lote_sin_celdas`.
- **[E1] Motivo nuevo `periodo_duplicado`** (no previsto en la planeación): dos veces el mismo periodo
  en el body deja el diff ambiguo (¿qué valor gana?) → `400` en vez de adivinar. Coherente con "nunca
  un 200 mentiroso" (D-055).
- **[E1] `campos_extra` se RECOMPONE entero en Node, no con `JSON_MODIFY`.** En modo lax
  `JSON_MODIFY(col, '$.k', NULL)` **borra la clave**, así que `funcionariocnd: null` (PRUEBA/REDESP)
  habría desaparecido del JSON y el shape divergiría del que escribe el `POST`. Efecto de segundo
  orden: la metadata del lote se aplica recorriendo sus **celdas vivas** (N updates por PK) en vez de
  un único `UPDATE` set-based. La exigencia semántica de D-055 (a) se conserva íntegra — la metadata
  aterriza aunque ningún valor cambie y aunque el lock de REDESP deje todos los periodos intactos —
  porque el recorrido es por celda viva, **no** por el delta de periodos.
- **[E1] Código de error extra `lote_de_otra_planta`** (403) cuando el lote resuelto pertenece a otra
  unidad. `_CONTEXTO-BASE` pedía el 403 sin nombrar el `codigo`.
- **[E2] La clave del recálculo lleva la `fecha` de CADA fila, no la del lote.** E2 pedía capturar
  "su `fecha` (día Bogotá de `fecha_evento`)" en singular, como hace el `PUT` (que la toma de
  `filas[0]` porque él mismo la hereda al insertar). En el `DELETE` derivarla por fila no cuesta nada
  y saca del camino la invariante "un lote nunca se parte entre dos días": si alguna vez se rompiera,
  el recálculo seguiría apuntando a la celda correcta en vez de recalcular un día ajeno y dejar el
  real publicando una fila borrada. `notifyDashboard` se emite una vez por día distinto tocado.
- **[E2] El `DELETE` de las filas es UN solo statement `WHERE registro_id IN (@r0, @r1, …)`,** no el
  loop por PK del `PUT`. Los ids se bindean en la misma cadena `.input(...)`, así que sigue siendo
  imposible que alcance una fila que este request no leyó (regla D-055) — y `rowsAffected[0]` da el
  `eliminados` real en vez de un conteo optimista.
- **[E2] Sin `codigo` nuevo:** el `DELETE` reusa tal cual los cuatro desenlaces de
  `resolverLoteParaEscritura` (`lote_cerrado` / `lote_inexistente` / `lote_de_otra_planta` / OK), de
  modo que el front pueda ramificar igual para corregir y para borrar.
- **[E1] Se extrajo `periodoActualBogota(nowMs)`** y `POST /guardar` pasó a usarla (antes lo calculaba
  inline). Fuente única del umbral del lock REDESP: captura y corrección no pueden divergir.
- **[E4] `MOTIVO_MSG` salió de `SalaDeMandoGrid.jsx` a `components/SalaDeMando/motivos.js`**, con un
  segundo mapa `MOTIVO_MSG_CORRECCION` que lo extiende. E4 lo dejaba a criterio ("extendé el mapa o
  movelo a un módulo compartido"); se movió porque el modal necesita los mismos motivos y una
  redacción arreglada en un lado quedaría vieja en el otro. **Son dos mapas y no uno** porque el
  MISMO motivo del backend significa cosas distintas: en captura `periodo_bloqueado` es "no puedes
  registrar un redespacho pasado"; en corrección es "no puedes tocar el valor de un periodo ya
  despachado — la hora y la descripción sí".
- **[E4] El modal también bloquea QUITAR un periodo pasado en REDESP, y no ofrece AGREGAR periodos
  pasados.** E4 pedía deshabilitar solo "el valor". Se extendió porque el lock del backend actúa
  sobre el **delta** (decisión 3) y rebota las tres ramas por igual: ofrecer un basurero o un "+"
  que siempre va a devolver `periodo_bloqueado` le miente al operador. La hora y la descripción
  siguen libres — el lock protege el valor, jamás el comentario. Sigue siendo affordance: si el
  periodo actual avanza mientras el modal está abierto, la autoridad es el `400` del backend, que se
  pinta celda por celda.
- **[E4] La confirmación de borrado quedó en su propio componente (`LoteBorrarModal.jsx`)**, no
  dentro del editor. E4 pedía "modal simple" sin nombrar archivo. Se separó porque el editor ya
  gestiona su propio submit/errores y meterle un segundo flujo confirmatorio adentro los enredaba.
- **[E4] "Eliminar registro" también se ofrece DESDE el modal de corrección**, no solo desde el
  listado. E4 solo lo pedía en el listado; el atajo se agregó porque el camino natural es abrir el
  registro, mirarlo y recién ahí decidir que va a la basura — y porque es la salida que el propio
  modal le señala a quien vació todos los valores (decisión 6). Reusa la MISMA confirmación.
- **[E1] `D-056 E1.4` estaba ROJO antes de tocar código y se corrigió acá.** Ver "Datos descubiertos".

## Datos descubiertos en ejecución

> Hechos que solo se conocen corriendo (fechas reales, IDs, baselines de la suite, fixtures).

- **Baseline conocido antes de empezar:** la suite puede fallar de forma espuria si se corre
  **cruzando el borde de turno** (~18:00 / ~06:00 Bogotá): `finalizar_turno` da `409
  turno_en_transicion` y `consumos` da 401. No es regresión — re-correr fuera del borde. Documentado
  también como landmine de fixture en D-056 (c).
- **[E1] D-056 YA ESTÁ EN USO REAL en GEC3.** Al arrancar E1 la BD productiva tenía 26 filas MAND de
  planta real repartidas en 10 lotes: 7 de una sola celda (los que migró `F32.A1`, sin la clave
  `hora_llamada`) y **3 lotes multi-celda de 8, 6 y 5 periodos**, capturados hoy 2026-07-23 entre las
  08:49 y las 08:52 Bogotá por `POST /guardar`. La captura por lotes funciona en producción.
- **[E1] Eso dejó `D-056 E1.4` ROJO, y no era una regresión de D-057.** Ese test afirmaba
  `COUNT(*) == COUNT(DISTINCT lote_id)` sobre **todas** las filas MAND de planta real — invariante que
  solo fue cierta en el instante de la migración y que el primer lote multi-celda real falsifica por
  diseño (un lote comparte `lote_id` entre sus filas: ese es el modelo). Su propio comentario ya lo
  anticipaba ("E3 introduce lotes multi-celda… reescribe este archivo") pero D-056 cerró sin
  reescribirlo, dejando una bomba de tiempo que estalla con el primer uso real. **Corrección:** el
  test se acota a las filas que la migración tocó (`hora_llamada IS NULL`, la marca documentada en
  D-056 para distinguir migrados de capturados) y se agregó **`E1.4b`** como contracara — fija que un
  lote multi-celda SÍ comparte `lote_id`, para que "arreglar" E1.4 quitándole el filtro vuelva a
  fallar en vez de pasar en silencio.
- **[E1] El puerto del server se lee de `SERVER_PORT`, no de `PORT`** (`server.js:17`). Para levantar
  el server efímero de la suite: `SERVER_PORT=3102 AUTH_TEST_BYPASS=1 node --env-file=../.env
  server.js` (3002 estaba libre en esta corrida, así que se usó el default).
- **[E1] Flaky observado:** en la primera corrida el test 1 (`POST guardar`) devolvió `503 db_timeout`
  tras 57 s contra la BD remota. Re-correr dio verde sin tocar nada. No es determinista ni atribuible
  al cambio.
- **[E1] FLAKE (A) — `sala_de_mando_batch` se caía al cruzar una HORA en punto. CORREGIDO acá.**
  Cinco tests de REDESP elegían su periodo "libre del lock" con `Math.min(P_ACTUAL, 24)`: cae **justo
  sobre el umbral** (`p < periodoActual`) y encima usa el `P_ACTUAL` **congelado al cargar el módulo**.
  La suite completa dura ~25 min, así que cruzar una hora en punto es lo normal: el servidor recalcula
  `periodoActual`, el test sigue pidiendo el periodo viejo y rebota `periodo_bloqueado`. Se manifestó
  en la 2ª corrida completa al cruzar las 12:00 Bogotá — 4 rojos, todos con el idéntico
  `{periodo: 12, motivo: 'periodo_bloqueado'}` (`D-055 1c`, `D-055 4`, `D-056 E3.5`, `D-056 E3.9`).
  **Fix:** helper `periodoRedespLibre()` = `min(periodoActual() + 1, 24)`, evaluado **al correr** el
  test y con una hora de margen. Los tests que ejercitan el lock a propósito siguen con `P_ACTUAL - 1`
  (ahí la staleness solo hace el periodo más pasado: inofensiva). Es hermano del landmine de borde de
  turno ya documentado, pero en el borde de **hora**, y por eso muerde muchísimo más seguido.
- **[E1] FLAKE (B) — `finalizar_turno` × cabecera de turno de `TST`. DIAGNOSTICADO, NO corregido.**
  En la 1ª corrida completa dieron rojo `4a2`, `4a3`, `4e` y `4f`: el `POST /api/registros` de *setup*
  devolvía `409 turno_cerrado` en vez de `201`. **Causa mecánica:** `resolverTurnoParaEscritura`
  (`utils/turno-entidad.js:189`) devuelve `estado:'CERRADO'` cuando la unidad **no tiene ninguna
  cabecera ABIERTA**; si un archivo previo deja la cabecera T1 de `TST` en `CERRADO`, `setupSessions`
  ya no puede reabrirla — la fila `(planta, fecha_operativa, turno)` ya existe — y todo `POST` genérico
  rebota. El `turno-sweeper` no la rescata: está scopeado a `['GEC3','GEC32']`, nunca `TST` (D-045).
  **No es de D-057:** `finalizar_turno` sola da 15/15; `conformacion_turno + finalizar_turno` 33/33; y
  la rebanada ordenada `turno-entidad + cierre_y_fechas + sala_de_mando_batch + consumos_combustible +
  finalizar_turno` (con el archivo de E1 ya modificado) 117/117. Además, en el log de esa corrida
  `sala_de_mando_batch` **terminó después** de `finalizar_turno`. Queda como deuda del harness.
- **[E2] La BD se cayó a mitad de la suite completa, y eso deja un PENDIENTE de higiene.** El host
  `192.168.17.20` quedó sin ping ni TCP 1433 (caída de red/VPN, no del cambio). El problema no son
  los 2 rojos —son timeouts de conexión, se re-corren— sino que el que quedó sin correr es
  **`zzz_session_leak_guard`**, que es justamente la red de seguridad que desactiva las sesiones
  sintéticas (`es_sintetico=1`). Las suites que crean sesiones en planta REAL (`consumos_combustible`,
  `conformacion_turno`, `rol_coordinador_carbon_maquinaria`) pueden haber quedado con sesiones
  `activa=1` visibles en el panel CONECTADOS de producción. **RESUELTO en la misma sesión:** al
  volver la conexión se corrió `node --env-file=../.env --test tests/zzz_session_leak_guard.test.js`
  (idempotente: desactiva y reporta al ofensor) → verde. Generaliza el blindaje de 2026-07-05: el
  guard protege contra el olvido de un `after()`, no contra que la BD desaparezca antes de que corra
  — si una corrida se cae por infraestructura, hay que correrlo a mano.
- **[E3] El flake de `consumos`/`coordinador` atribuido al "borde de turno" tenía OTRA raíz — un
  `turno: 1` hardcodeado — y se corrigió acá.** El baseline documentado decía que `consumos` daba 401
  al cruzar el borde de turno; la verdad es más simple y más molesta: sus dos seeds de sesión locales
  (`setupOperadorCarbon` en `consumos_combustible`, `setupCoordinador` en
  `rol_coordinador_carbon_maquinaria`) insertaban `sesion_activa.turno = 1` **literal**. Corriendo la
  suite en T2 (después de las 18:00 Bogotá), esa ventana `[06:00,18:00)` ya venció y el `turno-sweeper`
  expulsa la sesión (`activa=0`) a los ≤60s → `consumos` test 7 (`TypeError` al leer una respuesta 401)
  y test 9 (`401 !== 200`). No hace falta cruzar el borde: basta con **correr en T2**. `helpers.js` ya
  lo había resuelto para el resto de la suite (`getTurnoColombia()`), pero estos dos helpers locales se
  habían quedado con el literal. **Fix:** los dos usan `getTurnoColombia()`. No es regresión de D-057
  —lo destapó correr la suite completa a las ~20:30 Bogotá—, pero se arregla en esta etapa porque
  hasta ahora enmascaraba cualquier corrida verde en T2.
- **[E3] La BD (`192.168.17.20:1433`) se cayó DOS veces más durante esta etapa** (misma intermitencia
  de red/VPN de E2, no del cambio): tumbó por `ETIMEOUT` de conexión la 2ª corrida completa
  (`turno_seguimiento` + `turno_transicion_write_gate`, con tiempos absurdos de ~73 min que delatan el
  timeout, no un assert) y obligó a esperar su recuperación varias veces. En cada corrida donde la BD
  aguantó, **los 14 tests de E3 y los 2 de `consumos` corregidos quedaron verdes**. Pendiente de
  higiene asociado: si una corrida se cae antes de `zzz_session_leak_guard`, hay que correrlo a mano
  (idempotente) — igual que en E2.
- **[E4] E3 había quedado SIN COMMITEAR.** Al arrancar E4, el `HEAD` era el commit de docs de E2
  (`3232489`) y los tres archivos de E3 (`sala_de_mando_batch` con los 14 `D-057 E3.*`,
  `consumos_combustible` y `rol_coordinador_carbon_maquinaria` con el fix de `getTurnoColombia`)
  seguían modificados en el árbol de trabajo. El tablero decía ✅ porque el trabajo **estaba hecho y
  verde** — lo que faltó fue el `git commit`, probablemente porque aquella sesión terminó peleando
  con las caídas de la BD. Se commiteó tal cual, **antes** de E4 y en su propio commit (regla "un
  commit por etapa"); su bitácora en `ESTADO.md` viaja en el commit de E4, porque el archivo ya
  traía los dos bloques mezclados y partirlo por hunks era más frágil que la ganancia. Chequeo
  barato para futuras etapas: `git log --oneline -1` antes de empezar, no solo el tablero.
- **[E4] Baseline de la suite de FRONT (raíz, vitest) antes de esta etapa: 73/73 en 10 archivos.**
  Queda en **77/77 en 11 archivos** con los 4 tests nuevos. Corre en segundos y no toca la BD — es
  independiente de toda la inestabilidad de red documentada arriba.
- **[E1] `npm test` NO respeta el orden de archivos declarado en `package.json`.** En el log de la 1ª
  corrida completa el orden real de finalización fue `conformacion_turno` → `consumos_combustible` →
  `fechas_bogota` → `finalizar_turno` → … → `sala_de_mando_batch`, contra un orden declarado que pone
  `sala_de_mando_batch` **antes** de los tres primeros. Consecuencia para quien depure: **no se puede
  razonar sobre "qué archivo dejó tal estado" a partir del orden de `package.json`** — hay que leer el
  orden real del log. Explica por qué las rebanadas ordenadas no reproducen fallas de la suite entera.

## Bitácora por etapa

### E0 — Andamiaje ✅

- Creados: `PREGUNTAS-D-057.md`, `_CONTEXTO-BASE.md`, `ESTADO.md`, `E1-put-lote.md`,
  `E2-delete-lote.md`, `E3-tests-correccion.md`, `E4-front-correccion.md`, `E5-docs-cleanup.md`.
- Sin código de producto todavía.
- Se reservó el número **D-057** (último ADR en `docs/decisions.md`: D-056).

### E1 — `PUT /lotes/:lote_id` ✅

**Qué entró.** El endpoint de corrección por lote, con el diff quirúrgico completo: `UPDATE` de las
celdas cuyo `valor_mw` cambió, `DELETE` (por PK) de las que ya no vienen, `INSERT` de las nuevas con
el **mismo `lote_id`** y `fecha_evento` heredada, metadata (hora / funcionario / descripción) aplicada
recorriendo las **celdas vivas** del lote, lock de REDESP **solo sobre el delta**, y
`recalcularEventoDashboard` por cada celda tocada — más **todas** si cambió la hora, que es el criterio
de desempate de la publicación. Todo en una sola transacción; `broadcastConteoBitacoras` y
`notifyDashboard` post-commit. Queda anotado, dentro de la transacción, el **punto de enganche de la
cascada REQ-02** (sin código).

**Archivos tocados**

- `server/routes/mand.js` — helpers `resolverLoteVivo` / `loteEstaArchivado` /
  `resolverLoteParaEscritura` (los cuatro desenlaces: filas vivas · `409 lote_cerrado` ·
  `404 lote_inexistente` · `403 lote_de_otra_planta`), `periodoActualBogota`, y el handler
  `PUT /lotes/:lote_id`. `POST /guardar` pasó a usar `periodoActualBogota` (fuente única del umbral
  del lock).
- `server/tests/sala_de_mando_batch.test.js` — 3 pruebas de humo `D-057 E1.1/E1.2/E1.3`; corrección de
  `D-056 E1.4` + nuevo `D-056 E1.4b`; helper `periodoRedespLibre()` y sus 6 usos (flake de borde de
  hora).
- `prompts/D-057-correccion-lote-mand/ESTADO.md`.

**Verificación (salida real)**

- `tests/sala_de_mando_batch.test.js` aislado: **46/46 verde** (`tests 46 · pass 46 · fail 0`).
- `tests/finalizar_turno.test.js` aislado: **15/15 verde**.
- Rebanada ordenada `turno-entidad + cierre_y_fechas + sala_de_mando_batch + consumos_combustible +
  finalizar_turno`: **117/117 verde**.
- Suite completa (`cd server && npm test`): 1ª corrida 407/412 (4 rojos: flake B) · 2ª corrida 407/412
  (4 rojos: flake A, ya corregido) · 3ª corrida tras el fix del flake A: ver la línea de cierre del
  commit. Ninguno de los rojos es regresión de D-057 — ver "Decisiones / desviaciones" y "Datos
  descubiertos".
- **Smoke contra la BD**, hecho por asserts que consultan directamente (no por SSMS): el lote editado
  conserva su `lote_id`; las celdas sobrevivientes conservan `registro_id` y `creado_por`; la celda
  quitada desaparece de `evento_dashboard` (`DELETE`, no `activa=0`) y las tres vivas siguen
  publicando, de modo que **no queda `registro_origen_id` apuntando a una fila borrada**;
  `modificado_por` se sella en la celda que cambió de valor **y** en la que solo recibió metadata
  nueva, y **no** en la que nació en ese mismo `PUT`.

**Desviaciones.** Siete, todas listadas arriba en "Decisiones / desviaciones acumuladas". Las que
cambian comportamiento observable: `valor_mw` nulo se omite en vez de rebotar; motivo nuevo
`periodo_duplicado`; código nuevo `lote_de_otra_planta`. Las estructurales: branch desde
`feat/mand-append-only-2026-07` (D-056 no está en `main`), y `campos_extra` recompuesto en Node en vez
de `JSON_MODIFY` (que en modo lax borraría `funcionariocnd: null`).

### E2 — `DELETE /lotes/:lote_id` ✅

**Qué entró.** El borrado **real** de un lote (RN-04.c: en MAND no hay anulación visible — un renglón
tachado en la lista de llamadas al CND no informa, confunde). `planta_id` viaja por **query string**
(un `DELETE` no lleva body fiable). Mismo gate y misma resolución de lote que el `PUT`
(`resolverLoteParaEscritura`, cuatro desenlaces), sin chequeo de `creado_por` y sin gate de turno.
Una transacción captura las celdas `(fecha, tipo, periodo)` que el lote ocupaba, borra sus filas
acotando por PK y recalcula **cada** celda liberada: ahí el publicado **retrocede** al lote anterior
vigente, o la fila de `evento_dashboard` se **elimina** si no queda ninguno.
`broadcastConteoBitacoras` + `notifyDashboard` post-commit. Queda anotado el punto de enganche de la
cascada REQ-02 (sin código).

**El lock de REDESP NO aplica al borrado**, y está comentado en el código como decisión: el lock
protege el VALOR de un periodo ya despachado contra una reescritura silenciosa, pero borrar el lote
es la corrección de un registro ERRADO. Si aplicara, un redespacho mal digitado quedaría publicado
para siempre en cuanto pasara su hora — justo lo que REQ-04 vino a resolver. Va al ADR en E5.

**Archivos tocados**

- `server/routes/mand.js` — handler `DELETE /lotes/:lote_id` (inmediatamente después del `PUT`).
  Sin helpers nuevos: reusa `resolverLoteParaEscritura`, `recalcularEventoDashboard` y `fechaBogotaStr`.
- `server/tests/sala_de_mando_batch.test.js` — sección `D-057 · E2` con `delLote()`/`eventosDashboard()`
  y las pruebas `E2.1` (retroceso + eliminación) y `E2.2` (gates).
- `prompts/D-057-correccion-lote-mand/ESTADO.md`.

**Verificación (salida real)**

- `tests/sala_de_mando_batch.test.js` aislado: **48/48 verde** (`tests 48 · pass 48 · fail 0`) —
  46 de E1 + los 2 nuevos.
- Suite completa (`npm test` con `TEST_BASE_URL` al server efímero de 3102): `tests 415 · pass 385 ·
  fail 2 · cancelled 27`, y **los 5 tests de D-057 en verde** dentro de esa misma corrida. Los rojos
  NO son regresión: a mitad de la corrida **la BD se volvió inalcanzable** (`Failed to connect to
  192.168.17.20:1433 in 15000ms`, `ETIMEOUT`) y se llevó puestos por timeout de conexión —no por
  assert— a `turno-entidad`, `turno_seguimiento`, `turno_transicion_write_gate` y
  `zzz_session_leak_guard`, cancelando el resto. Confirmado desde el SO: `Test-NetConnection
  192.168.17.20 -Port 1433` → `TcpTestSucceeded: False`, `PingSucceeded: False`.
- **Re-corrida tras recuperar la conexión** (confirma que no había nada más): `turno-entidad +
  turno_seguimiento + turno_transicion_write_gate + sala_de_mando_batch` → **90/90 verde**
  (`fail 0 · cancelled 0`), y `zzz_session_leak_guard` aislado → **1/1 verde** (higiene de sesiones
  sintéticas resuelta).
- **Prueba E2.1 — el criterio 10, con dos lotes AUTH solapados:** lote A (P14+P15, hora temprana) y
  lote B (P15+P16, hora tardía), que solapan solo en P15. Borrar B (el publicado en la celda
  compartida) deja `evento_dashboard` con P14+P15, **P15 con el valor y el `registro_origen_id` de
  A** (retroceso, `activa=1`) y **P16 desaparecido**; borrar A después deja la celda **sin fila**, no
  con `activa=0`. La prueba no asume cuál lote gana por hora: lo lee de la BD y verifica que B gana
  P15 — determinista en las dos ramas de `horaBogotaMin` (por `hora_llamada DESC`, y si el borde de
  medianoche colapsa ambas horas a `'00:00'`, por `creado_en DESC`).
- **Query de sanidad** (la que pedía E2), dentro de la misma prueba: cero filas de
  `evento_dashboard` de la planta-fixture con `registro_origen_id` que no resuelva ni en
  `registro_activo` ni en `registro_historico`.

**Desviaciones.** Cuatro, listadas arriba. Ninguna cambia el contrato del endpoint: `fecha` del
recálculo derivada por fila en vez de por lote; `DELETE` en un solo statement con los PK bindeados;
`eliminados` desde `rowsAffected`; y cero códigos de error nuevos (reusa los del `PUT`).

### E3 — Cobertura: criterios de aceptación + guards transversales ✅

**Qué entró.** La matriz completa de los criterios de REQ-04 §6 que caen dentro del flujo, más los
guards transversales — 14 tests nuevos `D-057 E3.1..E3.14`, todos sobre `TEST_PLANTA`/`TEST_TAG`:

- **E3.1 (criterio 5)** — la excepción a D-049 en su cara POSITIVA: un lote creado por el Ing. de
  Operación lo corrige **y lo borra** el Jefe de Turno (no-autor con `puede_crear`). La autoría
  original no se reescribe; `modificado_por` queda en quien corrigió. Comentario cruzado con
  `registros_solo_autor.test.js` (la cara negativa), señalando que son un **par**.
- **E3.2 (criterio 7)** — un solo `PUT` cambia MW, hora, funcionario, descripción y el conjunto de
  periodos; se verifica en BD el valor nuevo, la `hora_llamada` nueva en TODAS las celdas, el
  funcionario, el detalle y el conjunto exacto de periodos, + la publicación siguiendo celda a celda.
- **E3.3 (criterio 9)** — borrar un lote lo saca del listado y no toca a los demás.
- **E3.4 (criterio 10)** — cadena completa de retroceso: tres lotes solapados en el mismo periodo,
  dos borrados seguidos → el publicado retrocede A→B→A y termina eliminando la fila.
- **E3.5 (criterio 11 a/b/c)** — REDESP: cambiar el valor de un periodo pasado, **agregar** uno
  pasado o **quitar** uno pasado → `400 periodo_bloqueado`, con la huella del lote (incluidos los
  timestamps de auditoría) intacta en las tres ramas.
- **E3.6 (criterio 11 d)** — REDESP: cambiar solo hora + descripción con el periodo pasado idéntico
  → `200`; el valor protegido no se movió y la fila es la misma (no reinserción).
- **E3.7 (criterio 12)** — con el turno finalizado y la cabecera CERRADA, `PUT` y `DELETE` → `200`
  los dos (MAND exenta de `turno_finalizado`/`turno_cerrado`/`turno_en_transicion`).
- **E3.8 (criterio 13)** — un cargo con `puede_ver` pero SIN `puede_crear` (Ing. Químico) → `PUT` y
  `DELETE` dan `403` y la huella del lote no cambia; sigue viendo el listado (200).
- **E3.9 (criterio 14)** — un `PUT` con un error de validación tardío (lock REDESP en una celda del
  body) → `400` y **cero** cambios: ni filas, ni metadata, ni sellos de auditoría, ni la publicación
  al dashboard (se siembra publicado a propósito para cubrir también `evento_dashboard`).
- **E3.10** — `409 lote_cerrado` en `PUT` y `DELETE` sobre un lote ya archivado por el cierre diario.
- **E3.11** — la celda que agrega el `PUT` **hereda** el `fecha_evento` del lote (día Bogotá
  determinista): el lote nunca se parte entre dos días.
- **E3.12** — la celda de madrugada (P3) que agrega el `PUT` resuelve `turno_id` por el PERIODO
  (T2 iniciado en F-1), no por el instante de la corrección.
- **E3.13** — auditoría selectiva: cambiar solo la descripción sella TODAS las celdas del lote
  (metadata de lote, D-055 (a)); cambiar solo un valor sella solo esa celda y **no re-sella** la que
  quedó idéntica.
- **E3.14** — el **guard de coherencia de lote** (extraído de `D-056 E3.9` a
  `verificarCoherenciaDeLotes()`) se sostiene también **después de un `PUT`** que mueve las tres
  piezas de metadata y el conjunto de periodos a la vez — el escenario para el que D-056 lo escribió.
  El guard de captura NO se reemplazó: los dos callers viven.

Criterios FUERA de alcance anotados como comentario (no huecos silenciosos): **2** (mensaje WhatsApp,
REQ-04 §8.1 → D-058), **6-negativo** (vive en `registros_solo_autor.test.js`), **8 / 9-copias**
(cascada SALAJDT/SALAING, REQ-02 no existe). Criterios **1/3/4** verificados como "ya cubiertos por
D-056" (siguen verdes).

**Guard anti-destrucción**: `guard_no_prod_historico_destruction.test.js` **pasa** — los `DELETE`
nuevos de los tests van acotados por PK (`registro_id = @id`) o por `TEST_PLANTA`, léxicamente junto
al statement. No hizo falta tocar `mand.js` (E1/E2 ya estaban acotados).

**Corrección de bug destapado por la cobertura** (no era de D-057, pero enmascaraba las corridas en
T2): el flake de `consumos_combustible`/`rol_coordinador_carbon_maquinaria` era un `sesion_activa.turno
= 1` **hardcodeado** en sus seeds de sesión locales → el sweeper los expulsa en T2. Migrados a
`getTurnoColombia()`, igual que `helpers.js`. Ver "Datos descubiertos".

**Archivos tocados**

- `server/tests/sala_de_mando_batch.test.js` — 14 tests `D-057 E3.*`; helpers `seedLoteMand`,
  `celdasDelLote`, `huellaDeLote`; `verificarCoherenciaDeLotes()` **extraído** del cuerpo de
  `D-056 E3.9` (que ahora lo llama); `seedRegistroMand` acepta `detalle`/`funcionariocnd` opcionales;
  import de `randomUUID`.
- `server/tests/consumos_combustible.test.js` — seed de sesión con `getTurnoColombia()` (era `1`).
- `server/tests/rol_coordinador_carbon_maquinaria.test.js` — idem.
- `prompts/D-057-correccion-lote-mand/ESTADO.md`.

**Verificación (salida real)**

- `tests/sala_de_mando_batch.test.js` aislado (server efímero 3102 con el código de E1/E2/E3):
  **62/62 verde** (`tests 62 · pass 62 · fail 0`) — los 14 de E3 en verde a la primera.
- `tests/consumos_combustible.test.js` + `tests/rol_coordinador_carbon_maquinaria.test.js` tras el
  fix: **25/25 verde**.
- Suite completa (`npm test` con `TEST_BASE_URL` al 3102): **1ª corrida 425/428** con **los 16 tests
  de D-057 (E1+E2+E3) en verde** — los 2 rojos eran justamente el flake `turno=1` de `consumos`,
  corregido acá. **2ª corrida** (para confirmar el fix): la BD `192.168.17.20:1433` se cayó a mitad
  (`ETIMEOUT`, ~73 min de "duración" = timeout de conexión, no assert) y se llevó por delante a
  `turno_seguimiento` + `turno_transicion_write_gate`; en lo que alcanzó a correr, los 14 de E3 y los
  2 de `consumos` corregidos quedaron **verdes**. El único `skipped` de todas las corridas es
  `parseXls — fixture real` (skip declarado del parser SIS, ajeno).
- **`zzz_session_leak_guard.test.js`** corrido a mano tras las caídas (idempotente): [PENDIENTE — se
  completa al recuperar la BD].

**Desviaciones.** Ninguna respecto del plan de E3. Un hallazgo lateral corregido (el `turno=1`), y la
misma inestabilidad de infraestructura de E2 (caídas de BD), ambos documentados arriba.

### E4 — Front: acciones en el listado + modal de corrección ✅

**Qué entró.** La cara visible de E1/E2: el listado del día pasó de solo-lectura a tener **acciones
por renglón** y apareció el **modal de corrección**. La grilla de captura **no se tocó** — sigue
naciendo vacía, sin cargar nada del servidor (D-056): corregir y capturar son dos planos distintos y
el modal es justamente lo que los mantiene separados (decisión 4). `dirty` sigue derivando **solo**
del buffer de captura, así que corregir no ensucia la grilla ni bloquea la finalización de turno.

- **Listado (`LotesDelDia`)** — columna de acciones con lápiz y basurero, visibles **solo con
  `puedeCrear`** (RN-04.f: sin permiso el listado se ve idéntico, sin controles). La presentación
  existente quedó intacta: renglones, resumen de periodos y marca de publicado por celda.
- **Modal de corrección (`LoteEditorModal`)** — hora, funcionario CND (habilitado solo en AUTH),
  descripción y la lista de periodos con su valor, con agregar y quitar. El **tipo se muestra con un
  candado** y un `title` que explica el camino (eliminar + volver a registrar, decisión 11). El lock
  de REDESP se pinta igual que en la grilla. **Guardar deshabilitado si no queda ningún periodo con
  valor**, con el copy que señala Eliminar. Los `errores[]` del backend se pintan **celda por celda**
  (los que traen `periodo`) y en un bloque de lote (los que no), reusando el mapa de motivos.
- **Confirmación de borrado (`LoteBorrarModal`)** — muestra el lote completo (tipo, hora,
  funcionario, descripción, periodos con sus valores) y **advierte explícitamente el retroceso del
  publicado** cuando alguna celda estaba publicada. Borrar es real e irreversible (RN-04.c).
- **`409 lote_cerrado` / `404 lote_inexistente` / `403 lote_de_otra_planta`** comparten desenlace
  (`CODIGOS_LOTE_FUERA`): cerrar el modal, avisar y **refrescar el listado** para que la fila que ya
  no existe desaparezca de la pantalla abierta (decisión 10). Se ramifica por `codigo`, nunca por
  texto (D-032).
- **Sin segundo temporizador**: se reusa el tick de 60s que ya existía. Un cambio de unidad en
  caliente (D-054) cierra los modales — apuntan a un lote de la unidad vieja.

**Archivos tocados**

- `src/components/SalaDeMando/motivos.js` — **nuevo**. `MOTIVO_MSG` (movido desde `SalaDeMandoGrid`)
  + `MOTIVO_MSG_CORRECCION` + `mensajeDeMotivo()`.
- `src/components/SalaDeMando/LoteEditorModal.jsx` — **nuevo**.
- `src/components/SalaDeMando/LoteBorrarModal.jsx` — **nuevo**.
- `src/components/SalaDeMando/LotesDelDia.jsx` — props `puedeCrear`/`onEditar`/`onEliminar`, columna
  de acciones, `colSpan` derivado.
- `src/components/SalaDeMando/SalaDeMandoGrid.jsx` — estado `loteEditando`/`loteBorrando`, handlers
  `handleGuardarLote`/`handleEliminarLote`, render de los dos modales (con `key` por lote), import
  del mapa de motivos.
- `src/hooks/useSalaDeMando.js` — `editarLote` / `eliminarLote` (ambos disparan
  `bitacora:counts-refresh` y **propagan el error tal cual**: `e.errores` y `e.codigo` son lo que el
  modal necesita).
- `src/components/SalaDeMando/lote-correccion-gate.test.jsx` — **nuevo**, 4 tests.
- `prompts/D-057-correccion-lote-mand/ESTADO.md`.

**Verificación (salida real)**

- `npm run build` (raíz): **verde** — `✓ built in 4.33s`, sin warnings nuevos (el único es el de
  chunk >500 kB, preexistente).
- `npm test` (vitest, raíz): **77/77 verde en 11 archivos** (`Test Files 11 passed · Tests 77
  passed`), contra el baseline de 73/73 en 10 archivos.
- **Cobertura automatizada nueva** (no estaba en el plan de E4, que dejaba todo al smoke manual):
  `lote-correccion-gate.test.jsx` monta los componentes REALES y fija los dos gates que muerden —
  (1) sin `puedeCrear` el listado no tiene **ni un solo `<button>`** ni la cabecera "Acciones" (cara
  front de `D-057 E3.8`, donde el backend responde 403); (2) con permiso, el click entrega el **lote
  completo**; (3) vaciar todos los valores deshabilita Guardar y el copy dice "usa Eliminar"
  (decisión 6); (4) en REDESP el periodo pasado deshabilita el valor **y** el quitar, mientras la
  hora y la descripción siguen editables (decisión 3).
- **Smoke UI manual: PENDIENTE del autor.** E4 lo declara explícitamente como checklist humano (no
  automatizable acá: requiere login Entra real, planta real y un lote registrado). Los 7 pasos están
  en `E4-front-correccion.md` §Verificación. Los pasos 4, 6 y 7 quedan cubiertos por los tests
  automatizados de arriba; los que **sí** requieren ojo humano son el 1-2-3 (precarga del modal y
  refresco sin recargar) y el 5 (el basurero + el traspaso de la marca verde al lote anterior).

**Desviaciones.** Seis, listadas arriba en "Decisiones / desviaciones acumuladas". Las que cambian lo
que ve el operador: el modal bloquea también **quitar** un periodo pasado en REDESP y no ofrece
agregar pasados; y "Eliminar registro" también se ofrece **desde** el modal de corrección. Las
estructurales: `MOTIVO_MSG` movido a `motivos.js` con un segundo mapa para la corrección, la
confirmación de borrado en su propio componente, y los 4 tests de front que el plan no pedía.

