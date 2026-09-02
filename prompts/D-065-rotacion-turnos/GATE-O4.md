# D-065 — GATE-O4 (cierre de la ola O4)

> Expediente **inmutable** del gate. Lo escribe solo el integrador. Si algo de acá se revierte
> después se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: **2026-09-02 12:50** (Bogotá) · Rama: `feat/rotacion-turnos-2026-08`.

**O4 es la última ola de construcción de D-065.** Lo que sigue no es una O5 sino
`/cerrar-implementacion D-065` — salvo que el visto bueno decida lo contrario sobre la única
decisión abierta de este gate (**D3**).

## 1. Semáforo al cerrar

```
O4 [abierta]
  L10  done        L10-0948     Cableado en el componente raíz y rutas hash ← L07,L08,L09
  L13  done        L13-0948     Correcciones de la O3 (pantalla de configuracion, hook del popup y schema)

test-lock: libre
```

Lotes sin cierre commiteado: **ninguno**. Los dos entregaron `cierres/L10.md` y `cierres/L13.md`
con sus SHA (`7c8a9d8`+`d1a83ac` y `54cefc0`+`60d3d9b`). Ninguno quedó `in-progress` ni `blocked`,
así que este gate no reconstruyó ningún cierre ni resolvió ningún bloqueo de contrato.

**El único pedido sobre archivo ajeno que dejó un cierre** (L13 §Bloqueos: adjuntar
`omitidasResumen` al error del umbral en `server/utils/graph/directorio.js`) **NO se aplicó**, y el
propio cierre explica por qué es lo correcto: la mitad de backend sin la de front deja el dato
viajando hasta un 503 que nadie lee. Va a **H4**, con destino al cierre.

## 2. Territorios

```
L10 · 2 commit(s): d1a83ac 7c8a9d8
archivos tocados (4):
  prompts/D-065-rotacion-turnos/cierres/L10.md
  src/BitacorasGecelca3.jsx
  src/routing/appRoute.js
  src/routing/appRoute.test.js
[lotes] territorio respetado

L13 · 2 commit(s): 60d3d9b 54cefc0
archivos tocados (10):
  prompts/D-065-rotacion-turnos/cierres/L13.md
  server/db.js
  server/tests/rotacion_correcciones_o2.test.js
  src/components/Rotacion/ConfiguracionRotacion.jsx
  src/components/Rotacion/CumplimientoRotacion.jsx
  src/components/Rotacion/configuracion-rotacion.test.jsx
  src/components/Rotacion/cumplimiento-rotacion.test.jsx
  src/components/Rotacion/popup-toma-control.test.jsx
  src/hooks/useCumplimiento.js
  src/hooks/useTomaControl.js
[lotes] territorio respetado
```

**Violaciones: ninguna.** Y la regla dura de la ola se cumplió: **L13 no cambió la firma de props de
ningún componente**, así que las cuatro props de `PopupTomaControl` (con `onAbandonar`) y las cinco
de `CumplimientoRotacion` contra las que L10 cableó en paralelo son las que fijaron los cierres de
la O3. Los dos lotes commitearon **por pathspec** con los archivos del otro sucios en el árbol al
lado y ninguno se coló — L13 además con `LOTE_SESION` puesto, así que la comprobación la hizo el
`pre-commit`, no la palabra del chat.

## 3. Verificación de la ola (bajo test-lock `GATE-O4`)

### 3.1 Tests enganchados a `server/package.json`

**Ninguno.** Los dos cierres lo dijeron y se verificó: `tests/rotacion_correcciones_o2.test.js` ya
estaba enganchado desde el GATE-O3 y solo creció (27 → 30 casos), y los cuatro archivos de front los
recoge `vitest.config.js` por su `include`. El script sigue con **69** archivos y
`zzz_session_leak_guard` **último**. Los mismos **8 archivos del disco fuera del script** que
denunció el GATE-O3 (H2) siguen fuera: no es territorio de esta ola.

### 3.2 Backend efímero

`M365_CLIENT_SECRET= SIS_HOST=http://localhost:3154 SERVER_PORT=3199 AUTH_TEST_BYPASS=1 node
--env-file=../.env server.js` → `[SERVER] Escuchando en puerto 3199`, `/health` 200. BD
`PortalG3_dev`. Sin credencial de Graph (para que CA-6 ejercite el camino real) y con el host del
stub del SIS, igual que los dos gates anteriores. En el arranque:
`[despacho-xm] sweeper DESHABILITADO (AUTH_TEST_BYPASS=1 …)`.

> **Se perdió una corrida por una condición del ENTORNO de test, no del código, y vale escribirla.**
> El bloque 2b salió `51 · pass 50 · fail 1`: `CA-6 (mitad HTTP)`. El caso empieza con
> `assert.equal(entraConfigurado(), false, …)` porque **exige que los DOS procesos** —el backend
> efímero **y** el `node --test`— corran sin `M365_CLIENT_SECRET`: con la credencial puesta, el POST
> sincronizaría el tenant REAL contra la BD (≈80 personas, sin limpieza posible). El gate había
> puesto la variable solo en el backend. Relanzado con `M365_CLIENT_SECRET=` también en el proceso
> de tests: **51/51**. El propio mensaje del assert imprime el comando exacto — por eso costó un
> minuto y no una hora. Es el hermano del H1 del GATE-O3 (`--test-concurrency=1`): las dos veces, un
> rojo que se lee como regresión y es una condición de invocación.

### 3.3 Cifra

Suite corrida en **16 bloques en primer plano** (la corrida completa excede el tope por comando de
esta sesión), **todos con `--test-concurrency=1`**, que es el flag que el propio script `test` lleva
escrito (H1 del GATE-O3).

| Bloque | Archivos | Resultado |
|---|---|---|
| 1 | guards ×2, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split sala | `tests 52 · pass 52 · fail 0` |
| 2a | guards ×2, campos_validate, **rotación O1 ×3** | `tests 75 · pass 75 · fail 0` |
| 2b | **rotacion_correcciones, rotacion_endpoints, rotacion_control** | `tests 51 · pass 51 · fail 0` |
| 2c | asientos ×2, asiento_despacho_xm, reflejo_disponibilidad | `tests 58 · pass 58 · fail 0` |
| 3a | F03 ×3, revalidate, fechas_bogota | `tests 105 · pass 105 · fail 0` |
| 3b | turno-entidad, **rotacion_cumplimiento** | `tests 65 · pass 65 · fail 0` |
| 3c | **rotacion_correcciones_o2** (creció con F37.A5) | `tests 30 · pass 30 · fail 0` |
| 4a | auth_middleware, auth_reactivate, disponibilidad ×2 | `tests 47 · pass 47 · fail 0` |
| 4b | disponibilidad_reflejo_http, cierre_y_fechas | `tests 16 · pass 16 · fail 0` |
| 4c | sala_de_mando_batch | `tests 85 · pass 85 · fail 0` |
| 5a | conformacion_turno, consumos_combustible, sis_endpoints | `tests 51 · pass 51 · fail 0` |
| 5b | sis_scrape_endpoint (**con stub**), finalizar_turno, cambiar_unidad | `tests 37 · pass 37 · fail 0` |
| 5c | registros ×2, despacho_xm, relleno_despacho_xm | `tests 32 · pass 32 · fail 0` |
| 6 | transición/seguimiento de turno, históricos ×2, 3 guards de no-auto-ejecución | `tests 37 · pass 37 · fail 0` |
| 7 | rol coordinador, rol consulta, sis ×6 | `tests 86 · pass 86 · fail 0` |
| 8 | sis ×2, contrato dashboard, http_hardening, errores, ia ×2, **zzz_session_leak_guard** | `tests 70 · pass 70 · fail 0` |

**Cifra de la ola: `tests 897 · pass 897 · fail 0 · skipped 0`.**

**Comparación con el baseline. `897 − 894 = 3` y la resta cuadra sola, otra vez sin residuo:** los
tres casos son los que L13 agregó a `rotacion_correcciones_o2.test.js` por **F37.A5** (27 → 30).
Ningún otro archivo cambió de conteo, y **este gate no tocó un solo archivo de `server/`** (sus
cuatro arreglos son de front), así que la cifra de backend se midió una vez y no hubo que remedirla.

### 3.4 Front

```
npm run build   → ✓ built in 3.45s   (exit 0)
npx vitest run  → Test Files 20 passed (20) · Tests 414 passed (414)
npx eslint <los 7 archivos tocados> → 5 warnings en BitacorasGecelca3.jsx, los MISMOS del baseline
```

**392 → 414**, y la resta también cuadra: **+8** de L10 (`appRoute.test.js` 29 → 37) **+9** de L13
(configuración 5, popup 2, cumplimiento 2) **+5 de este gate** (1 por H-L10-1, 1 por CR4-9, 2 por
CR4-2 y 1 por CR4-1). `392 + 8 + 9 + 5 = 414`.

**Y por primera vez el `npm run build` significa algo para este módulo.** El GATE-O3 avisó que su
build verde no probaba nada de las tres pantallas porque nadie las importaba y Rollup no las metía
al grafo. Con L10 cableado, el bundle de producción **sí** las contiene — verificado por grep sobre
`dist/assets/index-*.js`, y con las correcciones de L13 adentro:

```
Titulares que no entraron                   → 1      Mide asistencia         → 1
Rotación de turnos · Configuración anual    → 1      cubierto por relevo     → 1
Toma de control del rol                     → 1      Vector dañado           → 1
Cumplimiento de rotación                    → 1      rotacion/cumplimiento   → 1
```

### 3.5 Residuos en BD: ninguno

`npm run test:residuos` → `[residuos] cero residuos`, exit 0, **20 checks en 0**, incluidos los
cinco de rotación y los dos que miran *cualquier planta*. BD `PortalG3_dev`.

### 3.6 Estado real del schema de rotación, medido contra la BD

No es una lectura de código: es la consulta. **F37.A5 hizo exactamente lo que prometía** — las
cuatro migraciones registradas y **los dos CHECK del vector instalados**, que es el invariante que
CR3-5 denunció como imposible de instalar:

```
F37.A1 · F37.A3 · F37.A4 · F37.A5   (bitacora.migracion_aplicada)
CK_rotacion_patron_vector_t1, CK_rotacion_patron_vector_t2, CK_rotacion_patron_desfase,
CK_rotacion_patron_rango, CK_rotacion_asig_grupo, CK_rotacion_asig_rango,
CK_rotacion_control_accion, CK_rotacion_cumpl_turno, CK_rotacion_cumpl_estado, CK_rotacion_cumpl_grupo
```

### 3.7 CA-23 (cero tareas recurrentes), re-verificado sobre el diff de la ola

`grep -nE "^\+.*(setInterval|setTimeout|localStorage|sessionStorage|cron)"` sobre
`git diff 985be2e..HEAD -- src server`: **cero coincidencias reales**. Las cinco líneas que matchean
son la palabra "sin**cron**ización". **CA-23 sigue en pie**, y ahora con el disparador montado: el
popup hace **una** consulta al montar y sus únicas reconsultas son un cambio de unidad o una acción
de la persona.

### 3.8 `/code-review` del diff de la ola

`985be2e..HEAD`, nivel `high`. **13 hallazgos.** El gate los trió **contra el fuente, no contra el
reporte**: leyó el código de los dos lados de cada uno. Resultado: **8 confirmados** (cuatro
arreglados acá, uno abierto como decisión, tres con destino), **3 con la premisa inalcanzable en
este repo** y **2 de estilo**. Detalle en §7 como **CR4-1 … CR4-13**.

El más serio con diferencia es **CR4-1**, y es el hallazgo de la ola: **el popup no tenía salida.**
Ver §5 D1.

### 3.9 `/security-review`

Corrido porque la ola estrena una migración que **escribe filas de operación en cada arranque**
(F37.A5, con SQL dinámico vía `predicadoVector`), cablea un gate de permiso en el componente raíz y
mete parámetros de la URL en el estado de una pantalla.

**Resultado: cero hallazgos.** Lo verificado, por archivo:

- **`server/db.js` (F37.A5)** — las **cuatro** invocaciones de `predicadoVector` del repo reciben
  literales (`'vector_t1'`/`'vector_t2'` inline, o el `for` sobre un arreglo literal de F37.A4);
  `VECTOR_LIKE`/`VECTOR_LARGO` son `export const` del módulo. **Nada de `req`, `process.env` ni de
  la BD alcanza el DDL.** El `UPDATE` va 100 % parametrizado (`sql.Int`, `sql.VarChar(32)` sobre una
  columna `VARCHAR(32)`) y el valor escrito **no puede ser arbitrario aunque el driver fallara**:
  es la salida de `serializarVector(parsearVector(x))`, un viaje redondo que solo produce la cadena
  canónica de 15 caracteres o lanza. Los logs emiten **conteos e ids enteros**, nunca el vector.
- **Superficie de ataque de la fila candidata: no existe.** La única fila que F37.A5 puede tocar es
  una que **no** pudo escribir la app (`POST /patrones` normaliza antes de insertar), y la
  transformación es **preservadora de valor**, así que no hay escenario en que alguien induzca al
  arranque a alterar la malla de otro.
- **`BitacorasGecelca3.jsx`** — el diff **no retira ninguna comprobación de servidor** (no toca
  `routes/rotacion.js`, `_middleware.js` ni la allowlist pública). Punto que el revisor miró expreso:
  el popup se monta para **toda** sesión de app, incluido el observador de D-059 — y eso **no** es
  escalada porque el corte está en el backend (`utils/rotacion/control.js`: `if (!flags ||
  flags.es_observador || flags.puede_configurar_rotacion) return { aplica: false }`, y
  `ejecutarAccion` lanza `rotacion_no_aplica`). El observador no toma el control ni con `curl`.
- **`appRoute.js`** — `desde`/`hasta` pasan por `fechaValida` (regex + tope de hoy) y `planta` por
  una allowlist literal; lo que no pasa nunca entra a `params`. Seguido hasta el sink: terminan en
  `new URLSearchParams` sobre un **path fijo**, sin control de host ni de protocolo.
- **`ConfiguracionRotacion.jsx`** — el vector **crudo** de la BD se renderiza como nodo de texto
  JSX. Grep negativo de `dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|eval|new
  Function` sobre los cinco archivos JS/JSX del diff: **cero**.
- **`useTomaControl.js`** — `secuenciaRef`/`vigente` **añaden** defensa; y descartar una respuesta
  vieja no puede dejar en pantalla un estado *más permisivo*, porque las tres acciones son POST cuyo
  resultado decide el servidor dentro de la transacción con `sp_getapplock`.

**Nota que el revisor dejó para el ADR, no como vulnerabilidad:** F37.A5 es la **primera migración
de `initDB()` que escribe filas de datos de operación** y no solo DDL. Es segura acá por dos
propiedades que hay que conservar si alguien copia el patrón: la transformación pasa por el **motor
puro**, y el `catch` **no adivina**.

## 4. Criterios confirmados (solo lo que el gate vio en verde)

| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| **CA-22** | L10 | **`cumple`** | `src/routing/appRoute.test.js` (37 casos) ✔ en la corrida completa de vitest (414/414) + `npm run build` ✔. Cubre las dos rutas nuevas ida y vuelta, los tres params del cumplimiento, cada param inválido descartado por separado, y la **regresión de las siete rutas viejas** por el bloque `round-trip parse∘build` |
| **CA-19** | L07 → **end-to-end** | **`cumple`** | `configuracion-rotacion.test.jsx` (19 casos) ✔ · la pantalla **compila y entra al bundle de producción** por primera vez (§3.4) · smoke con clics de L10 §6 paso 4 |
| **CA-20** | L08 → **end-to-end** | **`cumple`** | `popup-toma-control.test.jsx` (33 casos) ✔ · smoke de L10 §6 pasos 1, 2, 8 y 9 (el popup se dispara al entrar, el "No" viaja al backend y no reaparece, y cede ante la transición) · **y este gate le cerró la única salida que no salía** (CR4-1) |
| **CA-21** | L09 → **end-to-end** | **`cumple`** | `cumplimiento-rotacion.test.jsx` (30 casos) ✔, incluidos los dos de la **enmienda D4** (el panel mide asistencia) · smoke de L10 §6 paso 5 con los tres params por deep-link |
| **CA-23** | L10 | **`cumple`** (se mantiene) | §3.7: cero `setInterval`/`setTimeout`/`localStorage`/`sessionStorage` en todo el diff de la ola |

**Con esto, los 23 CA de `PREGUNTAS-D-065.md` quedan `cumple`.** Ninguno queda `parcial` ni
`bloqueado`.

> **Salvedad honesta sobre el "end-to-end" de CA-19/20/21, y es de este gate:** el smoke con clics
> reales lo corrió **L10**, contra el bundle real pero con un backend **simulado** y —lo dice su
> propio cierre— con los cambios de L13 a medio camino en el árbol. **Este gate NO repitió ese smoke
> sobre el árbol integrado**: el arnés vivía en el scratchpad de esa sesión y no se commiteó.
> Lo que el gate **sí** midió sobre el árbol ya integrado es (a) que el bundle de producción
> contiene las tres superficies **con** las correcciones de L13 (§3.4, incluidas las cadenas de la
> enmienda D4, que es justo lo que el paso 5 miraba), (b) 414/414 de front y 897/897 de backend, y
> (c) el diff del cableado leído línea por línea. **El smoke contra el backend vivo, con datos
> reales y login Entra, es del cierre** — donde ya estaba pedido por H-L07-4.

## 5. Decisiones tomadas en este gate

### D1 — CR4-1: "Cerrar" del popup no cerraba nada, y eso tapaba la app. Arreglado acá.

- **Qué lo provoca:** el `/code-review`, confirmado leyendo los dos lados. En la rama `abandonar`
  del popup, el botón "Cerrar" era `onClick={() => onCerrar?.()}` — **avisaba al padre y no tocaba
  su propio estado `cerrado`**. L08 lo escribió asumiendo que el padre haría algo; L10 cableó
  `onCerrar={NOOP}` razonando —con razón— que "el componente ya se oculta solo". Las dos mitades son
  defendibles por separado y juntas dejan un overlay `fixed inset-0 z-50`, sin clic en el fondo ni
  Escape, **sin salida**. Y no es un instante: `modoPopup` devuelve `'abandonar'` mientras
  `soy_principal === true`, o sea **todo el turno**, y un F5 lo reabre. Las únicas salidas reales
  eran abandonar el control recién tomado, o quedarse. **La víctima es exactamente la persona para
  la que existe el módulo: la que acaba de tomar el rol.**
- **Por qué no lo vio nadie:** el caso que lo cubría se llama *"el botón dispara onAbandonar;
  'Cerrar' solo cierra"* y afirmaba `expect(onCerrar).toHaveBeenCalledTimes(1)`. Verde, midiendo el
  callback en vez del efecto. Es el mismo patrón de CR2-8/CR3-1: **dos mitades correctas construidas
  en olas distintas que no se encuentran.**
- **Opciones:** a) que el raíz desmonte el popup desde `onCerrar` · b) que el botón ponga
  `setCerrado(true)` además de avisar · c) dejarlo y documentarlo.
  **Recomendada: (b).**
- **Decidido: (b).** El dueño de "no repreguntar dentro de este montaje" es el componente —lo dice
  su propio comentario y lo hacen ya sus otros dos caminos de cierre (`ejecutar` y `cerrarAviso`)—.
  (a) pondría esa regla en dos sitios y contradiría el estado que el componente ya guarda.
- **Verificador:** caso nuevo `CR4-1 · "Cerrar" quita el diálogo aunque el padre no haga nada con el
  aviso`, que mira el **DOM** (`[role="dialog"]` desaparece), no el callback. Bidireccional:
  quitando el `setCerrado(true)` → `1 failed | 32 passed`; restaurado → `33 passed`.

### D2 — CR4-2: el aviso del vector dañado seguía pidiendo lo que ya se hizo. Arreglado acá.

- **Qué lo provoca:** el remedio que L13 escribió ("Desactívalo y vuelve a cargar el patrón…") es
  correcto para la mitad **operativa** y **no libera** la mitad de **schema**: un CHECK aplica a
  todas las filas de la tabla, activas o no, así que el pre-vuelo de F37.A4 sigue contando la fila
  desactivada — y con razón, porque el `ALTER` fallaría igual. Sumado a que `GET /patrones` devuelve
  también las inactivas y a que el botón "Desactivar" solo sale en las activas, el administrador que
  **obedece el aviso** se queda con una advertencia permanente que le pide hacer algo que ya hizo y
  sin ningún botón que apretar.
- **Opciones:** a) filtrar el pre-vuelo por `activo = 1` · b) partir el aviso en dos según `activo` ·
  c) esconder del listado las dañadas inactivas.
  **Recomendada: (b).** (a) es **incorrecta** —dejaría instalar un CHECK que la tabla viola, y el
  `ALTER` fallaría— y (c) esconde justo la fila que hay que encontrar, que es lo contrario de CR2-8.
- **Decidido: (b).** Activas → el remedio de siempre. Desactivadas → "ya no afectan el cálculo de
  guardias; para que el sistema pueda volver a validar el formato hay que corregir el vector a mano.
  El arranque lo recuerda en el log", que es **la verdad completa** y coincide con lo que F37.A4
  imprime. De paso el aviso pasa a usar el helper `plural()` que L13 introdujo dos líneas más
  arriba, lo que cierra **CR4-13** sin un cambio aparte.
- **Verificador:** dos casos nuevos (activa / ya desactivada). Bidireccional: volviendo el primer
  aviso a `patronesDanados` → `1 failed | 18 passed`; restaurado → `19 passed`.

### D3 — CR4-4: el borrador de la carga anual se pierde sin aviso al navegar. **NO se arregló acá: necesita tu decisión.**

- **Qué es:** `ConfiguracionRotacion` guarda el reparto en un `buffer` **interno**, detrás de un
  Guardar explícito. Las dos entradas nuevas del menú (`handleIrARotacion`/`handleIrACumplimiento`)
  y el toggle "Ver bitácoras" solo mueven `vista`, y eso **desmonta el componente**: el buffer se va
  con él, en silencio. La guarda de "Cambios sin guardar" que ya existe mira
  `registrosDeBitacora._dirty` y `mandDirty`, y el buffer de rotación no es ninguno de los dos.
  Escenario concreto: alguien reparte los grupos de ~81 personas, abre el menú para mirar el
  cumplimiento, y al volver la pantalla está en blanco. Es la misma clase de pérdida para la que
  D-040 y D-054 pusieron sus guardas.
- **Por qué no lo arregla el gate:** la única solución honesta es que el componente **reporte su
  suciedad hacia arriba** (una prop nueva) y que el raíz confirme antes de cambiar de `vista`. Eso
  es un cambio de firma de props y un modal — **trabajo de lote, no de gate**, y encima sobre el
  archivo más disputado del repo.
- **Opciones:** a) **una O5 con un solo lote de corrección** que lo cierre antes de desplegar ·
  b) aceptarlo como deuda declarada y llevarlo a un REQ después del cierre · c) no hacer nada.
  **Recomendada: (a)** — la carga anual es *el* caso de uso del módulo y la primera vez la hace
  gente aprendiendo; perder ese trabajo sin aviso es caro y no se recupera.
- **Decidido: PENDIENTE del visto bueno.**

### D4 — H-L10-1: la vista de cumplimiento no decía cómo se llamaba. Arreglado acá.

- **Qué lo provoca:** lo levantó L10 y no podía arreglarlo (el archivo era territorio de L13, que
  corría en paralelo). `CumplimientoRotacion` arrancaba directo en su barra de filtros, sin `<h1>`
  ni `<h2>`, a diferencia de `ConfiguracionRotacion` y de `HistoricoView`. **Y es la vista más
  deep-linkable del módulo:** quien recibe `#/rotacion/cumplimiento?...` pegado en un correo
  aterriza en cuatro tarjetas de colores y una tabla, sin nada que las nombre.
- **Decidido:** encabezado propio ("Rotación de turnos · Cumplimiento" + una línea de qué mide), con
  el **mismo ícono de la entrada del menú** que lleva ahí. Se hizo en el gate porque el archivo se
  queda sin escritor al cerrar la ola y es markup aditivo, no una prop.
- **Verificador:** caso nuevo que exige un `h2` real y que vaya **antes** de los filtros en el orden
  del DOM. Bidireccional: degradando el `h2` a `div` → `1 failed | 28 passed`.

### D5 — CR4-9, CR4-8 y CR4-12: tres alineaciones chicas, arregladas acá.

- **CR4-9 · el control y el validador de la ruta aceptaban cosas distintas.** El input "Hasta" no
  tenía `max`, y `fechaValida` **descarta** una fecha futura: se podía elegir un "hasta" con el que
  la pantalla consultaba pero que el hash **no podía representar**, así que la URL quedaba sin el
  parámetro y un F5 —o el enlace copiado— volvían al rango por defecto **en silencio**. Es el
  síntoma visible de **H-L10-2**, que L10 dejó anotado como riesgo teórico. Arreglado con
  `max={getTodayBogota()}`, que es exactamente el tope del validador; "Desde" ya lo heredaba por su
  `max={hasta}`. Con su caso.
- **CR4-8 · el toast mandaba a revisar la red por una BD caída.** `handleRotacionError` respondía
  *"Revisa tu conexión e intenta de nuevo"* a los tres códigos del Set, y dos de ellos
  (`db_no_disponible`, `db_timeout`) son la base de datos con el servidor vivo — mientras el aviso
  de la propia pantalla, que sí ramifica por `codigo`, decía lo correcto **en la misma pantalla**.
  El texto queda neutro salvo para `sin_conexion`, que sí es la red.
- **CR4-12 · el gate de la ruta re-derivaba el permiso.** El comentario de `puedeConfigurarRotacion`
  promete ser la derivación única "para que la entrada del menú y el gate de los POST no puedan
  divergir", y el efecto de ruta repetía la expresión al lado. Ahora usa la constante (y entra a las
  deps del efecto, donde es un no-op: se deriva de `sesion`, que ya estaba). `eslint` vuelve a los
  **mismos 5 warnings** del baseline.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> **O4 es la última ola de construcción.** Este bloque no enmienda prompts de una ola siguiente
> —no hay— sino que va **al `/cerrar-implementacion D-065`**, que es quien escribe el ADR,
> `CLAUDE.md`, `BIT-MODBD` y `BIT-RF`. Se copia tal cual.

1. **Una sección que no es una bitácora viaja en `vista`, no en `codigo`.** No tiene fila en
   `lov_bit.bitacora` ni permiso por bitácora, así que su gate sale de un **flag del cargo** en la
   sesión y su entrada vive en el `HeaderMenu`, **no** en `BitacoraTabs`. `parseHash`/`buildHash`
   conocen ahora dos `vista` más (`'rotacion'`, `'rotacion-cumplimiento'`), las dos con
   `codigo: null`, y ese es el patrón para cualquier sección futura.
2. **El corolario que descubrió L10: el toggle del menú tiene que preguntar "¿estoy en
   bitácoras?".** Preguntar por una sección concreta ("¿estoy en históricos?") deja sin camino de
   vuelta a todas las demás — con dos vistas nuevas, quien estuviera en Rotación leía "Ver
   históricos" y no existía ningún item que dijera "Ver bitácoras".
3. **La precedencia entre los dos overlays `z-50` es UNA expresión, no dos.**
   `transicionAbierta = turnoHook.bloqueo && !esObservador` gobierna a la vez el `open` del
   `TurnoTransicionModal` y el montaje del popup. Manda la transición, porque bloquea la unidad
   entera (D-046). Deliberadamente no es una copia: si cambia la condición del modal, cambia sola la
   del popup.
4. **El costo aceptado del gate por flag de cargo:** el módulo **no hereda `solo_lectura`**. El
   Gerente de Producción, que es solo-lectura en todas las bitácoras, **sí** configura la rotación —
   y eso es deliberado: es la razón por la que el flag existe aparte de la matriz.
5. **Un CHECK que espeja a un parser se mantiene igual o MÁS ESTRICTO que él, y cuando divergen lo
   que se corrige es el DATO.** Más estricto cuesta una migración que no se instala (ruidosa,
   visible en el log); más permisivo deja entrar la fila que el runtime no puede leer — y en este
   módulo eso hace `ROLLBACK` del cierre de las **dos** plantas cada 60 s. La normalización se hace
   **con el propio parser** (parsear + reserializar), nunca con un `REPLACE` en SQL que solo tapa el
   síntoma que se vio.
6. **Un pre-vuelo que "se reintenta en el próximo arranque" puede no reintentarse nunca.** Si el
   drift es permanente, la constraint se omite para siempre, en silencio salvo una línea de log, y
   la migración no llega a `migracion_aplicada`. Todo pre-vuelo necesita una respuesta a "¿y si el
   drift no se corrige solo?" — acá esa respuesta es F37.A5.
7. **F37.A5 es la primera migración de `initDB()` que escribe filas de datos de operación**, no solo
   DDL. Lo que la hace segura y hay que conservar si alguien copia el patrón: la transformación pasa
   por el **motor puro** (así cubre todo lo que el parser tolera, no solo el blanco que se vio) y el
   `catch` **no adivina** — lo ilegible se deja intacto y lo denuncia el pre-vuelo.
8. **`secuenciaRef` no cubre el indicador de carga.** Descarta la respuesta obsoleta, pero el
   `.finally` de la promesa vieja no sabe de secuencias y apaga el `cargando` de la petición
   **nueva**. El guard del indicador es del **efecto** (`let vigente = true` + cleanup). Son dos
   cosas distintas aunque arreglen el mismo cruce.
9. **Las degradaciones del backend son contrato, no cortesía.** Si un endpoint responde con una fila
   marcada como dañada o con un conteo de lo que no pudo leer, la pantalla **tiene** que mostrarlo:
   leerlo a medias cambia un 500 —que queda en el log— por una pantalla en blanco, y un 200
   incompleto por uno que se ve completo.
10. **Y su corolario, que es de este gate: el remedio que muestra una pantalla de diagnóstico tiene
    que seguir siendo verdad DESPUÉS de que alguien lo siga.** El aviso del vector dañado pedía
    desactivar; desactivar apaga el efecto operativo y no libera el CHECK, así que el aviso se
    quedaba pidiendo lo mismo sobre una fila ya desactivada y sin botón para hacerlo (CR4-2).
11. **`migracion_aplicada` gana `F37.A5`.** Las migraciones de D-065 son **cuatro**: `F37.A1`,
    `F37.A3`, `F37.A4`, `F37.A5`. Cualquier chequeo de despliegue que las enumere se actualiza.
    Medido contra la BD: las cuatro registradas y los dos CHECK del vector instalados.
12. **Un test que baja una constraint de producción se auto-repara en el arranque siguiente, pero
    durante la ventana la BD real se queda sin el invariante.** `rotacion_correcciones_o2` hace
    `DROP CONSTRAINT` + siembra filas corruptas y solo lo sostiene su `finally { borrarMios();
    initDB(); }`. Las filas sí están cubiertas (`residuos.js:51` mira `rotacion_patron` creado por
    usuario sintético) y `--test-concurrency=1` evita el cruce dentro de la suite; lo que **no**
    tiene red es la constraint caída si el runner muere. Ver **H6**.
13. **Dos rojos de este flujo, en dos gates seguidos, fueron condiciones de INVOCACIÓN y no
    regresiones:** el `--test-concurrency=1` que falta en `CLAUDE.md:22` (H1 del GATE-O3) y el
    `M365_CLIENT_SECRET=` que hay que poner **en los dos procesos** para `CA-6` (§3.2). Los dos se
    leen como un fallo del código y no lo son. Al runbook del cierre.

## 7. Hallazgos consolidados (deduplicados entre lotes)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| **CR4-1** | `/code-review` | **El popup no tenía salida.** "Cerrar" (rama `abandonar`) solo llamaba `onCerrar`, que el raíz cablea a un no-op; el overlay es `fixed inset-0 z-50` sin clic en el fondo ni Escape, y `soy_principal` sostiene ese modo **todo el turno** (un F5 lo reabre). El test que lo cubría afirmaba sobre el callback, no sobre el DOM | **alta** — confirmado leyendo los dos lados | **Arreglado en el gate** (D1), con caso nuevo y bidireccional |
| **CR4-2** | `/code-review` | **El remedio del vector dañado dejaba de ser verdad al seguirlo.** Desactivar apaga el efecto operativo y no libera el CHECK (aplica a toda la tabla); el aviso quedaba pidiendo lo mismo sobre una fila ya desactivada, cuyo botón "Desactivar" ya no existe | media | **Arreglado en el gate** (D2), con dos casos |
| **CR4-4** | `/code-review` | **El borrador de la carga anual se pierde sin aviso al navegar.** El `buffer` es interno, las entradas del menú solo mueven `vista` y eso desmonta el componente; la guarda de "Cambios sin guardar" solo mira `_dirty`/`mandDirty` | **media**, consecuencia alta (el reparto de ~81 personas) | **DECISIÓN D3** — O5 de un lote, o deuda a REQ |
| **CR4-9** | `/code-review` | **El control y el validador de la ruta aceptaban cosas distintas:** "Hasta" sin `max`, `fechaValida` descarta el futuro → el hash pierde el parámetro y un F5 vuelve al default en silencio. Es el síntoma de **H-L10-2** | media | **Arreglado en el gate** (D5), con caso |
| **CR4-8** | `/code-review` | El toast global decía "revisa tu conexión" ante `db_no_disponible`/`db_timeout`, contradiciendo al aviso correcto de la misma pantalla | baja | **Arreglado en el gate** (D5) |
| **CR4-12** | `/code-review` | El efecto de ruta re-derivaba `puede_configurar_rotacion` en vez de usar la constante que su propio comentario declara única | baja | **Arreglado en el gate** (D5) |
| **CR4-13** | `/code-review` | El aviso de patrones dañados repetía a mano la pluralización que el helper `plural()` ya encapsula, dos líneas más abajo | informativa | **Cerrado de paso** por D2 |
| **H-L10-1** | L10 | La vista de cumplimiento no tenía título, siendo la más deep-linkable del módulo | baja | **Arreglado en el gate** (D4), con caso |
| **CR4-6** | `/code-review` | `{!transicionAbierta && <PopupTomaControl/>}` **desmonta** en vez de esconder: un `aviso` que la persona está leyendo desaparece si el turno cruza `fin_nominal` en ese momento, y al volver se repregunta algo ya respondido dentro de ese montaje | baja (ventana de segundos) | **Cierre**, como limitación conocida. Esconder en vez de desmontar es una prop nueva |
| **CR4-5** | `/code-review` | F37.A5 aborta **la fila entera** si una de las dos columnas es ilegible, aunque el pre-vuelo de F37.A4 es **por columna**: con `t1` legible-no-canónico y `t2` ilegible, `t1` se queda sin normalizar y bloquea su CHECK sin necesidad | baja (esquina de una esquina) | **Cierre**, como deuda con su razón |
| **H4** | L13 | `omitidas` se pierde **justo en el caso grave**: cruzado el umbral, `leerDirectorioEntra` lanza y el 503 no lleva conteos — con 3 personas faltantes se dice cuántas, con 60 no | baja | **Cierre**. El propio cierre de L13 explica por qué media mitad (solo backend) es peor que nada |
| **H5** | L13 | `GET /patrones` marca la **fila**, no la columna: con `vector_t1` roto y `t2` sano los dos salen crudos y `vector_invalido` no dice cuál falla | informativa | **Cierre** (cambiaría el contrato) |
| **H6** | gate (de CR4-3) | **Un test baja una constraint de producción.** `rotacion_correcciones_o2` hace `DROP CONSTRAINT CK_rotacion_patron_vector_t1` + siembra filas corruptas, sostenido solo por su `finally`. Las **filas** sí tienen red (`residuos.js:51`) y `--test-concurrency=1` evita el cruce interno; la **constraint caída** no la ve nadie hasta el arranque siguiente | baja (se auto-repara en `initDB`) | **Cierre** → gotcha de `CLAUDE.md`. *La parte del hallazgo que decía "`test:residuos` no lo ve" es falsa y se descartó leyendo el script* |
| **CR4-7** | `/code-review` | "El directorio respondió completo" se afirma desde `omitidas` **ausente** (`?? {}` colapsa "no vino" con "cero") | **premisa inalcanzable** | **Descartado**: `sincronizarDirectorio` **siempre** devuelve `omitidas`, y le pone el objeto de ceros por defecto si el directorio no lo trae. No hay front desplegado contra otro backend |
| **CR4-10** | `/code-review` | El aviso puede decir "faltan aproximadamente 0 personas" | **premisa casi inalcanzable** | **Descartado como accionable**: exige `medianaGrupo === 0` con lecturas exitosas (todos los grupos leídos vacíos); con grupos poblados el umbral ya habría abortado. Cosmético, sin escenario realista |
| **CR4-11** | `/code-review` | F37.A5 inserta su flag en `migracion_aplicada` aunque haya dejado filas ilegibles, mientras F37.A4 gatea el suyo al éxito: un DBA lee "A5 aplicada, A4 ausente" e invierte la causalidad | informativa | **Descartado como cambio**: el significado audit-only está escrito en el sitio y gatearlo rompería la auto-sanación. Se anota como lectura del log para el runbook |
| **CR4-3** | `/code-review` | (ver **H6** — se reclasificó tras verificar que `residuos.js` sí cubre las filas y que el script corre con `--test-concurrency=1`) | — | — |
| H-L10-2 | L10 | `fechaValida` rechaza el futuro y para un rango de consulta es una regla prestada de COMB | baja | **Su síntoma se arregló** (CR4-9). Partir el validador en dos sigue siendo del cierre, si algún día se quiere consultar "hasta fin de mes" |
| H-L13-3 | L13 | La lectura de F37.A5 no es indexable (scan de `rotacion_patron` en cada arranque) | informativa | Ninguno. Decenas de filas; crece con una carga anual |
| H-L07-2 | L07 (abierto desde el GATE-O3) | `POST /asignaciones` exige un `cargo_id` que la salida (`grupo: null`) ignora | baja | **Cierre** — sigue abierto, L13 no lo tocó (fuera de territorio) |
| H-L09-1 / H-L13-2 | L09 / L13 | Los formateadores de fecha y la pluralización están duplicados por pantalla; `src/utils/` no tuvo escritor en ninguna ola | baja | **Cierre** (consolidación) |
| H-L09-3 | L09 | `ESTADOS` vive dos veces (front y backend) sin nada que los ate | baja | **Cierre** (con guard, si se decide fijarlo) |
| H15 | GATE-O3 | El deadlock del GATE-O2 no se reprodujo; la otra mitad del abrazo (el `turno-sweeper` arrancando bajo `AUTH_TEST_BYPASS`) sigue siendo deuda heredada | baja | Observación. **Tampoco se reprodujo en esta ola** |
| H1 / H2 | GATE-O3 | `CLAUDE.md:22` sin `--test-concurrency=1`; 8 `.test.js` fuera del script `test` | media | **Cierre** — siguen abiertos, no son territorio de esta ola |

## 8. Ola siguiente

**No hay O5 planificada: la O4 era la última ola de construcción.** Lo que sigue es
`/cerrar-implementacion D-065`, que escribe el ADR **D-065**, la convención **38** de `CLAUDE.md`,
`BIT-MODBD v2.8`, `BIT-RF v2.4 / RF-079` y hace el `git rm` del scaffolding.

**Salvo que el visto bueno decida la opción (a) de D3**, en cuyo caso la O5 lleva **un solo lote**:

| Lote | Título | Territorio |
|---|---|---|
| L14 | Guarda de borrador sin guardar en la configuración anual (CR4-4) | `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx` · `src/BitacorasGecelca3.jsx` |

Es el único caso de toda la implementación en que un lote de corrección **tendría** que cambiar una
firma de props — y puede hacerlo sin riesgo justamente porque ya no hay nadie cableando en paralelo.

**Lo que el cierre hereda pase lo que pase:** el smoke con **backend vivo y datos reales** (H-L07-4
y la salvedad del §4), el runbook con las dos condiciones de invocación del §6.13, el grupo de Entra
`ADMINISTRADOR Y DEBUGGING` vacío, y las 13 personas duplicadas en `lov_bit.usuario`.

**Visto bueno del usuario: PENDIENTE.**

## 9. Commit del gate

`f23ae7b` `gate(D-065): O4 cerrada — 2 lotes, 897/897 backend, 414/414 front, 0 violaciones`
