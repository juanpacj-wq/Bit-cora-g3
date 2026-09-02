# D-065 — GATE-O5 (cierre de la ola O5)

> Expediente **inmutable** del gate. Lo escribe solo el integrador. Si algo de acá se revierte
> después se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: **2026-09-02 15:55** (Bogotá) · Rama: `feat/rotacion-turnos-2026-08`.

**La O5 fue una ola de un solo lote, abierta por la decisión D3 del GATE-O4 con visto bueno del
usuario.** No agrega funcionalidad: cierra **CR4-4**, el único hallazgo confirmado de la O4 que no
cabía en un gate porque exigía una prop nueva y un modal.

> **Y valió la pena abrirla por una razón que no era la prevista.** L14 entregó su encargo completo y
> sin violaciones, pero el `/code-review` de este gate encontró que la guarda tenía **cuatro agujeros
> más** —uno de ellos la dejaba inalcanzable justo para los dos cargos que pueden usar la pantalla—.
> Los cuatro se cerraron acá, con casos y verificación bidireccional. Queda **una decisión abierta**
> (§5 D5): un segundo borrador de la misma pantalla que nadie reporta.

## 1. Semáforo al cerrar

```
O5 [abierta]
  L14  done        L14-1418     Guarda de borrador sin guardar en la configuracion anual

test-lock: libre
```

Lotes sin cierre commiteado: **ninguno**. L14 entregó `cierres/L14.md` con sus dos SHA (`cb9d6db` +
`5b94ff6`). No quedó `in-progress` ni `blocked`, así que este gate **no reconstruyó ningún cierre y
no resolvió ningún bloqueo de contrato**. Su §Bloqueos dice literalmente "Ninguno" y no pidió una
sola edición sobre un archivo ajeno — el primer lote de toda la implementación que cierra así.

## 2. Territorios

```
L14 · 2 commit(s): 5b94ff6 cb9d6db
archivos tocados (4):
  prompts/D-065-rotacion-turnos/cierres/L14.md
  src/BitacorasGecelca3.jsx
  src/components/Rotacion/ConfiguracionRotacion.jsx
  src/components/Rotacion/configuracion-rotacion.test.jsx
[lotes] territorio respetado
```

**Violaciones: ninguna.** Los tres archivos del §2 de su prompt más su propio cierre. No tocó
`CumplimientoRotacion.jsx`, `PopupTomaControl.jsx`, `useRotacion.js`, `appRoute.js`,
`server/package.json` ni **nada** de `server/` — verificado además por el camino contrario:
`git diff f23ae7b..HEAD -- server/` sale **vacío**. Commiteó por pathspec con `LOTE_SESION=L14-1418`
en el entorno, así que la comprobación de territorio la hizo el `pre-commit` y no la palabra del
chat.

**La libertad que este lote sí tenía, y la usó bien:** era el único de toda la implementación
autorizado a cambiar una firma de props (la regla dura de la O4 expiró al cerrar esa ola y ya no
quedaba nadie cableando en paralelo). Cambió **una**, aditiva y opcional, y es dueño de los dos
lados del contrato — el componente y su único consumidor.

## 3. Verificación de la ola (bajo test-lock `GATE-O5`)

### 3.1 Tests enganchados a `server/package.json`

**Ninguno, y el cierre lo había anticipado.** L14 es front puro: `vitest.config.js` recoge
`configuracion-rotacion.test.jsx` por su `include: ['src/**/*.test.{js,jsx}']`. El script sigue con
**69** archivos y `zzz_session_leak_guard` **último**; `git diff` sobre `server/package.json` sale
vacío. Los mismos **8 `.test.js` del disco fuera del script** que denunció el GATE-O3 (su H2) siguen
fuera — 77 en disco, 69 en el script — y no son territorio de esta ola: van al cierre.

### 3.2 Backend efímero

`M365_CLIENT_SECRET= SIS_HOST=http://localhost:3154 SERVER_PORT=3199 AUTH_TEST_BYPASS=1 node
--env-file=../.env server.js` → `[SERVER] Escuchando en puerto 3199`, `/health` **200**. BD
`PortalG3_dev`. **Las mismas dos condiciones de invocación que costaron una corrida a cada uno de
los dos gates anteriores**, esta vez puestas desde el principio y en los **dos** procesos: sin
credencial de Graph (para que `CA-6` ejercite el camino real en vez de sincronizar el tenant
verdadero) y con el host del stub del SIS. En el arranque:
`[despacho-xm] sweeper DESHABILITADO (AUTH_TEST_BYPASS=1 …)`.

### 3.3 Cifra de backend

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
| 3c | **rotacion_correcciones_o2** | `tests 30 · pass 30 · fail 0` |
| 4a | auth_middleware, auth_reactivate, disponibilidad ×2 | `tests 47 · pass 47 · fail 0` |
| 4b | disponibilidad_reflejo_http, cierre_y_fechas | `tests 16 · pass 16 · fail 0` |
| 4c | sala_de_mando_batch | `tests 85 · pass 85 · fail 0` |
| 5a | conformacion_turno, consumos_combustible, sis_endpoints | `tests 51 · pass 51 · fail 0` |
| 5b | sis_scrape_endpoint (**con stub**), finalizar_turno, cambiar_unidad | `tests 37 · pass 37 · fail 0` |
| 5c | registros ×2, despacho_xm, relleno_despacho_xm | `tests 32 · pass 32 · fail 0` |
| 6 | transición/seguimiento de turno, históricos ×2, 3 guards de no-auto-ejecución | `tests 37 · pass 37 · fail 0` |
| 7 | rol coordinador, rol consulta, sis ×6 | `tests 86 · pass 86 · fail 0` |
| 8 | sis ×2, contrato dashboard, http_hardening, errores, ia ×2, **zzz_session_leak_guard** | `tests 70 · pass 70 · fail 0` |

**Cifra de la ola: `tests 897 · pass 897 · fail 0 · skipped 0 · cancelled 0`.**

**La comparación con el baseline no es una resta: es una identidad.** `git diff f23ae7b..HEAD --
server/` sale **vacío**, o sea que el árbol de backend que midió este gate es **byte a byte** el que
midió el GATE-O4. La cifra tenía que ser 897 y lo fue, bloque por bloque, sin un solo conteo
distinto.

> **Y aun así remedirla dijo algo que no se sabía: es la primera corrida completa de todo D-065 que
> sale verde de una sola pasada.** Cero relanzamientos. No apareció el deadlock que el GATE-O2
> registró contra el `turno-sweeper` (su H4, que el GATE-O3 tampoco reprodujo), no apareció el borde
> de turno de `finalizar_turno`, y ninguna de las dos condiciones de invocación mordió — porque
> estaban escritas y se pusieron desde el primer comando. **Un baseline que se sostiene sin ajustes
> a mano es lo que el cierre necesita para poder decir "897" sin nota al pie.**

### 3.4 Front

**Medido dos veces: al recibir la ola, y otra vez con los cinco arreglos del gate adentro (§5).**

```
· Al recibir la ola (solo L14)
npm run build   → ✓ built in 5.50s   (exit 0)
npx vitest run  → Test Files 20 passed (20) · Tests 422 passed (422)   [12.85 s]

· Con los arreglos del gate
npm run build   → ✓ built in 14.33s  (exit 0)
npx vitest run  → Test Files 21 passed (21) · Tests 442 passed (442)   [59.63 s]

npx eslint src/BitacorasGecelca3.jsx src/components/Rotacion/ConfiguracionRotacion.jsx \
           src/components/Rotacion/configuracion-rotacion.test.jsx \
           src/components/Rotacion/guard-salidas-borrador.test.js
  712:9   warning  The 'activos' logical expression could make the dependencies of useMemo…
  2302:6  warning  React Hook useEffect has a missing dependency: 'catalogos'…
  2309:6  warning  React Hook useEffect has a missing dependency: 'registrosHook'…
  2322:6  warning  React Hook useEffect has a missing dependency: 'registrosHook'…
  2427:6  warning  React Hook useCallback has an unnecessary dependency: 'user'…
✖ 5 problems (0 errors, 5 warnings)
```

**Las dos restas cuadran solas.** `414 → 422` son los **8** casos que L14 agregó a
`configuracion-rotacion.test.jsx` (19 → 27), cuatro del contrato del componente y cuatro de la regla
del raíz, en los mismos 20 archivos. `422 → 442` son los **20** del gate: **10** más en ese mismo
archivo (2 de CR5-2, 2 de CR5-4, 3 de CR5-7, 3 de CR5-11 → 37) y **10** en un archivo nuevo,
`src/components/Rotacion/guard-salidas-borrador.test.js`, que es el único de los cuatro archivos de
front nuevos de toda la implementación que no prueba comportamiento sino **cableado** (§5 D1).

Los cinco warnings de `eslint` son los **mismos cinco** del baseline, en las mismas cinco
declaraciones y por las mismas causas —solo corridos de línea—: el archivo más disputado del repo
salió de su última ola, y de este gate, sin un sexto. `ConfiguracionRotacion.jsx` y los dos archivos
de test siguen en cero.

**Y la guarda entera está en el bundle de producción**, incluidos los textos que estrenó el gate —
verificado por grep sobre `dist/assets/index-*.js`, no por lectura del fuente:

```
todavía no se ha guardado                             → 2      Salir sin guardar   → 1
Todavía hay                                           → 1      Ver bitácoras       → 1
Guarda o descarta antes de ir a                       → 1
Guarda o descarta los cambios antes de mover la fecha → 1
```

**Y la guarda está en el bundle de producción**, que es lo que va a correr la persona que reparta los
grupos — verificado por grep sobre `dist/assets/index-*.js`, no por lectura del fuente:

```
todavía no se ha guardado   → 2   (los dos textos: salir de la pantalla y cambiar de unidad)
Salir sin guardar           → 1
Ver bitácoras               → 1   (el toggle que L14 convirtió en handler)
```

### 3.5 Residuos en BD: ninguno

`npm run test:residuos` → `[residuos] cero residuos`, exit 0, **20 checks en 0**, BD `PortalG3_dev`.
Incluidos los cinco de rotación, los dos que miran *cualquier planta* y el de sesiones sintéticas
activas. Era lo esperable —L14 no abre pool ni escribe una fila: todo su I/O es `globalThis.fetch`
stubeado— pero el chequeo cubre también lo que dejó el **backend efímero** de este gate, que sí
arrancó sus sweepers contra la BD.

### 3.6 CA-23 (cero tareas recurrentes), re-verificado sobre el diff de la ola

`git diff f23ae7b..HEAD -- src server` filtrado por líneas agregadas con
`setInterval|setTimeout|localStorage|sessionStorage|cron`: **cero coincidencias**. La guarda es
estado de React y un `ConfirmModal` que ya existía. **CA-23 sigue en pie.**

### 3.7 `/code-review` del diff de la ola

`f23ae7b..HEAD`, nivel `high`, sobre 110 líneas de front. **12 hallazgos** — más que en cualquier ola
anterior por línea cambiada, y no es ruido: **8 quedaron confirmados leyendo el fuente de los dos
lados**, cinco de ellos con la BD o el seed a la vista. El gate los trió **contra el código, no
contra el reporte**. Detalle en §7 como **CR5-1 … CR5-12**.

**El de la ola es CR5-1, y tiene la forma exacta del CR4-1 del gate anterior: dos mitades
defendibles que no se encuentran.** L14 puso la guarda del cambio de unidad en `handleIrAUnidad` —el
**atajo** del navbar de D-054, el botón que dice "Ir a GEC32"— convencido de estar cubriendo
"Cambiar de unidad". El ítem del menú que se llama literalmente así es **otro handler**,
`handleCambiarUnidad`, y estaba sin guarda: mata la sesión de app (`clearSesion`), cae en
`LoginScreen` y se lleva el reparto sin una palabra.

> **Y lo que lo vuelve grave no está en el diff, está en el seed.** El atajo solo se dibuja con
> `cargo.puede_cambiar_unidad = 1`, y en el MERGE de cargos de `db.js` los **dos** cargos que pueden
> abrir la configuración anual —`Gerente de Producción` y `Administrador y Debugging`— lo tienen en
> **0**. Para ellos `resolverOtraUnidad` devuelve `null`, el botón no existe, y la guarda que L14
> escribió para el cambio de unidad era **código inalcanzable**… mientras la puerta que sí ven
> quedaba abierta. Es el mismo pliegue de D-054(f) que el `_CONTEXTO-BASE` ya documentaba, leído
> desde el otro lado. Ver §5 D1.

El segundo, **CR5-2**, es de la misma familia y se verificó ejecutando el motor: `calcularCambios`
descarta a quien tiene grupo y todavía no rol, así que la pantalla podía estar mostrando su propio
aviso *"hay N personas con grupo pero sin rol"* mientras la guarda contestaba *"no hay nada que
perder"* — y ese es el estado normal de la primera carga anual, porque tras la primera sincronización
casi nadie llega con cargo (hecho §6.3 del GATE-O2).

### 3.8 `/security-review` — acotado a mano al diff de la ola

Corrido porque el diff toca **`handleIrAUnidad`**, que es el camino del cambio de unidad en caliente
(D-054, contexto de sesión), y porque estrena una prop y un export en el componente raíz. El criterio
del `02-paralelismo.md §9` no lo exigía —L14 no toca auth, permisos, sesiones, SQL dinámico ni el
contrato cross-repo, y `git diff … -- server/` sale vacío— pero es el último gate y los cuatro
anteriores lo corrieron.

> **Y hay un hecho de método que registrar: el skill apuntó al diff completo de la RAMA, no al de la
> ola.** 3,2 MB, 200+ archivos, todo lo que los cuatro gates anteriores ya revisaron con cero
> hallazgos. Eso no es una revisión más amplia: es diluir la atención sobre las **110 líneas** que
> esta ola de verdad estrenó. **El gate acotó la revisión a mano** a `f23ae7b..HEAD -- src/` y la
> sostuvo con evidencia literal, no con lectura. Al runbook del cierre (§6.20).

**Resultado: cero hallazgos.** Lo verificado, con la salida de cada comprobación:

- **Sinks de ejecución/HTML en las líneas AGREGADAS** —
  `dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|eval(|new Function|document.write`:
  **cero**. Los dos textos nuevos son literales que viajan por `message` y `ConfirmModal` los pinta
  como nodo de texto JSX (`<p>{message}</p>`). La única interpolación es `${otraUnidad.nombre}`, que
  sale de `resolverOtraUnidad(sesion, catalogos.plantas)` —el catálogo del servidor— y es el **mismo
  patrón que ya tenía ese modal**: React escapa.
- **Superficie nueva de red, almacenamiento o navegación** — `fetch(|window.location|localStorage|
  sessionStorage|postMessage|href =` en las líneas agregadas: **cero**. La guarda no habla con nadie:
  es estado de React y un modal que ya existía.
- **Gates de permiso**: el diff **no toca ninguno**. El único cambio de firma es la prop
  `onDirtyChange` añadida; `puedeConfigurar = false` conserva su **default cerrado** y
  `puedeConfigurarRotacion` sigue derivándose en un solo sitio (CR4-12). Nada de `routes/rotacion.js`,
  `_middleware.js` ni la allowlist pública entra en el diff.
- **El bloqueo del cambio de unidad quedó estrictamente MÁS ANCHO**, que es la dirección segura:
  `if (hayCambiosSinGuardar)` → `if (hayCambiosSinGuardar || hayBorradorRotacion)`. Una disyunción no
  puede dejar pasar nada que antes bloqueara. Y aunque alguien saltara la guarda desde la consola, el
  corte real del cambio de unidad está en el backend (`POST /api/auth/cambiar-unidad` con
  `loadAppSession` + `validarPlantaOperable`, D-054): esto es UX contra pérdida de trabajo, no un
  control de acceso.
- **Exposición de datos**: los mensajes no llevan ids, nombres de personas, códigos de error ni
  internals; `onDirtyChange` reporta **un booleano**. El export nuevo es una función pura sin efectos
  al importarse.

## 4. Criterios confirmados (solo lo que el gate vio en verde)

**L14 no tiene CA propios** (`"criterios": []`): es un lote de corrección. Lo que entrega es
**CR4-4**, y lo que el gate confirma son los CA que la ola tocó de refilón, más el cierre del propio
CR4-4.

| Ítem | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| **CR4-4** | L14 | **cerrado**, y **más ancho de lo que L14 lo dejó** | `configuracion-rotacion.test.jsx` (37 casos) + `guard-salidas-borrador.test.js` (10) ✔ en la corrida completa (442/442). El lote cubrió 4 salidas; el gate encontró y cerró la quinta —la que de verdad usa quien configura (CR5-1)—, la del control de fecha (CR5-4), la del navegador (CR5-7) y el caso en que la guarda no se enteraba (CR5-2) |
| CA-19 | L07 → regresión | **`cumple`**, sin cambio | los 27 casos que el archivo ya tenía siguen verdes dentro de los 37; la pantalla sigue compilando y entrando al bundle |
| CA-22 | L10 → regresión | **`cumple`**, sin cambio | `appRoute.test.js` (37 casos) ✔ y los dos `grilla-*.test.jsx` que importan el raíz ✔, en la corrida completa |
| CA-23 | L10 → regresión | **`cumple`**, se mantiene | §3.6: cero `setInterval`/`setTimeout`/`localStorage`/`sessionStorage` en todo el diff de la ola. **Los arreglos del gate tampoco los introducen**: el `beforeunload` de CR5-7 es un listener de evento, no una tarea recurrente — no despierta solo, no consulta al servidor y muere con el componente |
| CA-20, CA-21 | L08 / L09 | **`cumple`**, sin cambio | `popup-toma-control.test.jsx` (33) y `cumplimiento-rotacion.test.jsx` (30) ✔; la ola no tocó ninguno de los dos |

**Los 23 CA de `PREGUNTAS-D-065.md` siguen en `cumple`**, ninguno `parcial` ni `bloqueado`. La
salvedad del `GATE-O4 §4` sigue viva y **no la levanta este gate**: el smoke con **backend vivo,
datos reales y login Entra** no lo ha corrido nadie todavía. Es del cierre.

## 5. Decisiones tomadas en este gate

### D1 — CR5-1: la guarda del cambio de unidad estaba en el botón equivocado. Arreglado acá.

- **Qué lo provoca:** el `/code-review`, confirmado leyendo los dos handlers **y el seed de cargos**.
  Hay dos caminos para cambiar de unidad y L14 guardó el que no era: `handleIrAUnidad` es el atajo en
  caliente de D-054 y solo se dibuja con `cargo.puede_cambiar_unidad = 1`; los dos cargos que pueden
  configurar la rotación lo tienen en **0**. El ítem del menú llamado "Cambiar de unidad" es
  `handleCambiarUnidad` y no consultaba nada: `clearSesion()` → `LoginScreen` → desmonte → reparto
  perdido. **La guarda existía y era inalcanzable justo para quien tiene el borrador.**
- **Opciones:** a) guardar `handleCambiarUnidad` con la misma puerta · b) dar el atajo a los cargos
  que configuran · c) documentarlo como limitación.
  **Recomendada: (a).** (b) cambia un permiso de dominio para tapar un bug de UI —y `puede_cambiar_unidad`
  gobierna el atajo, no la capacidad (convención 27)—; (c) deja abierta la única salida real.
- **Decidido: (a)**, y **confirma** en vez de bloquear, al revés que el atajo. La asimetría es
  deliberada y queda escrita: el atajo **no desmonta nada** (`LoginScreen` es un early return del
  mismo componente) así que ahí no hay dos opciones que ofrecer y bloquear es correcto; el ítem del
  menú **sí** es una salida de la pantalla, así que ofrece las dos de verdad.
- **Un detalle que no es de estilo:** `salirDeRotacion` se movió **arriba** de `handleCambiarUnidad`.
  Las deps de un `useCallback` se evalúan en cada render, así que referenciar desde arriba una
  `const` declarada más abajo revienta por **TDZ**, no por convención. Hay un caso que fija el orden.
- **Verificador:** archivo nuevo `guard-salidas-borrador.test.js`, **10 casos**. No prueba
  comportamiento sino **cableado**, porque montar el raíz exige auth, catálogos, WS y media docena de
  hooks con red — es el mismo argumento por el que el backend tiene `guard_marcador_reflejo`.
  Enumera las cinco salidas, exige que las cuatro que navegan pasen por la puerta y que el atajo
  consulte la regla, fija el orden de declaración y fija el cable `onDirtyChange={setRotacionDirty}`
  (que es **CR5-9**: borrarlo dejaba la suite entera en verde). Trae además su **meta-test**: el
  stripper de comentarios parte con `/\r?\n/` y hay dos casos que lo prueban, porque con `.split('\n')`
  quedaría inerte y el guard pasaría leyendo prosa — el gotcha exacto de D-055, y este archivo nombra
  `salirDeRotacion` en sus comentarios a cada rato. Bidireccional: quitando la guarda de
  `handleCambiarUnidad` → `1 failed | 9 passed`; rompiendo el stripper → `1 failed | 9 passed`;
  restaurados → `10 passed`.

### D2 — CR5-2: lo que se puede PERDER es más ancho que lo que se puede GUARDAR. Arreglado acá.

- **Qué lo provoca:** L14 reportó `hayCambios`, o sea el diff que el router acepta, con el argumento
  —correcto pero incompleto— de que "no puede haber un borrador que el botón vea y la guarda no".
  Cierto; lo que falta es la tercera cosa: **ediciones que el buffer tiene y que ninguno de los dos
  ve.** `calcularCambios` descarta a quien tiene grupo y todavía no rol (`POST /asignaciones` exige
  `cargo_id`), que es exactamente el conjunto `sinRol` **que la pantalla ya pinta en un aviso**. La
  pantalla decía "hay N personas con grupo pero sin rol" y la guarda decía "no hay nada que perder".
- **Por qué importa y no es una esquina:** tras la primera sincronización real casi nadie llega con
  cargo (GATE-O2 §6.3), así que **repartir grupos antes de asignar roles es el camino normal de la
  primera carga anual** — la que hace gente aprendiendo. Encima, `Descartar` está detrás de
  `{hayCambios && …}`: en ese estado no había ni botón para soltar el trabajo.
- **Opciones:** a) comparar el buffer entero contra el servidor · b) `hayBorrador = hayCambios ||
  sinRol.length > 0` · c) dejarlo y documentarlo.
  **Recomendada: (b).** (a) obliga a un segundo diff que puede divergir del primero —el error que
  D-061 documenta en la convención 35— y además revertiría una decisión deliberada de L14 (elegir un
  rol *sin* grupo no ensucia, con test propio); (b) reusa un memo que ya existía y cambia solo lo que
  el reporte prueba que está mal.
- **Decidido: (b).** Quedan dos nociones con un dueño cada una: **`hayCambios` habilita Guardar**
  (solo se manda lo que el router acepta, y sigue bloqueado con `sinRol`) y **`hayBorrador` gobierna
  todo lo que destruye el buffer** — el aviso al raíz, Descartar, el refetch de Entra y la fecha. El
  caso de L14 *"elegir un rol sin grupo no lo cuenta como borrador"* **sigue verde sin tocarlo**.
- **Verificador:** dos casos nuevos (el grupo sin rol ES borrador con Guardar aún bloqueado; y
  Descartar aparece y lo deshace). Bidireccional: con `hayBorrador = hayCambios` →
  `3 failed | 34 passed`; restaurado → `37 passed`.

### D3 — CR5-4 y CR5-7: las otras dos formas de perder el reparto. Arregladas acá.

- **CR5-4 · el control de fecha destruía el buffer y estaba disponible.** Mover "Vigente desde"
  re-dispara el efecto `[fecha]`, que hace `setBuffer(bufferDesde(lista))`: exactamente lo mismo que
  hace "Actualizar desde Entra", **que dos líneas más abajo ya se gateaba con `hayCambios` y un
  `title` que lo explica**. Se repartían 40 personas, se corregía la fecha y desaparecían. Arreglado
  con el mismo `disabled` y el mismo `title` que su hermano, ahora los dos sobre `hayBorrador`. La
  pista de que era un olvido y no una decisión estaba en el propio archivo.
- **CR5-7 · la salida que no pasa por ningún handler.** F5, cerrar la pestaña, seguir un enlace que
  no es SPA. `SalaDeMandoGrid` —el componente cuyo contrato esta pantalla copia, y al que L14 cita
  como precedente— **ya traía** su `beforeunload`; el reparto anual, que es trabajo de ~81 filas, se
  iba sin que el navegador dijera nada. Se copió el patrón, gateado por `hayBorrador` y con cleanup.
  **No compromete CA-23:** un listener de evento no es una tarea recurrente — no despierta solo, no
  consulta al servidor y muere con el componente.
- **Verificadores:** dos casos de CR5-4 y tres de CR5-7 (incluido que suelta el listener al
  desmontarse: se cuelga de `window`, que sobrevive al componente). Bidireccional: devolviendo la
  fecha a `disabled={ocupado}` → `1 failed | 36 passed`; vaciando el handler del `beforeunload` →
  `2 failed | 35 passed`; restaurados → `37 passed`.

### D4 — CR5-11: un aviso que bloquea tiene que decir TODO lo que hay que resolver. Arreglado acá.

- **Qué lo provoca:** los dos borradores pueden coexistir —el `_dirty` de una bitácora vive en el
  raíz y sobrevive al cambio de sección— y el ternario del modal nombraba solo el reparto. La persona
  lo guardaba, reintentaba, y chocaba otra vez con un texto distinto sin que nadie le hubiera dicho
  que eran dos cosas. Bloquea igual y no se pierde nada: lo que falla es la guía.
- **Decidido:** el texto se arma desde los dos flags. Y se extrajo a una función pura exportada,
  `mensajeCambiosSinGuardar`, por la misma razón que L14 extrajo `planearSalidaDeRotacion`: es una
  regla del raíz y probarla no debería exigir montar el dashboard entero.
- **Verificador:** tres casos (los dos pendientes, uno solo, y la voz — tuteo colombiano y la unidad
  destino nombrada). Bidireccional: volviendo el segundo término a excluirse cuando hay reparto →
  `1 failed | 36 passed`.

### D5 — CR5-8 y las salidas del efecto (a): **NO se arreglan acá, y una necesita tu decisión.**

- **CR5-8 · la pantalla tiene un SEGUNDO borrador que nadie reporta.** El `form` de la zona de
  patrones (rol, dos fechas, dos vectores de 8 números y dos grupos) no entra en `hayCambios` ni en
  `hayBorrador`, así que teclearlo y salir sin apretar "Cargar patrón" lo pierde **con la guarda
  puesta y sin preguntar**. Confirmado leyendo el estado. Es menos trabajo que el reparto (16 números
  contra 81 filas) pero es el mismo agujero, y arreglarlo bien no es una condición más: hay que
  decidir qué cuenta como "empezado" en un formulario de 7 campos, y eso es diseño con casos.
  **Es trabajo de lote, no de gate** — la misma razón por la que el GATE-O4 no arregló CR4-4.
- **CR5-5 · `H-L14-1` con un disparador que su cierre no nombra.** El efecto (a) también corre ante
  un cambio de `puedeConfigurarRotacion` (está en sus deps desde CR4-12): si `revalidate` corrige el
  cargo y quita el permiso con un borrador abierto, cae a bitácoras y se lleva el buffer. El propio
  L14 lo escribió en un comentario de `handleIrAUnidad` **para justificar bloquear ahí**, y no lo
  llevó a su hallazgo. Sigue exigiendo un *blocker* de historial sobre los dos efectos de D-035.
- **Opciones para las dos:** a) una **O6** de un lote que cierre CR5-8 y, si se puede, el blocker de
  historial de H-L14-1/CR5-5 · b) al cierre como **deuda declarada**, con su escenario escrito en el
  ADR · c) nada.
  **Recomendada: (b).** El precedente de D3 en el GATE-O4 empujaría a (a), pero la asimetría manda:
  allá se perdía **el** caso de uso del módulo (repartir ~81 personas) por la vía más natural —abrir
  el menú— y hoy eso está cubierto de sobra, con cinco salidas y el navegador. Lo que queda es un
  formulario de 16 números y un camino (el back) que **ya no es la forma normal de salir**, porque
  las cinco entradas del menú ahora preguntan. Abrir una sexta ola por eso, después de que la quinta
  encontró cuatro agujeros en la anterior, cuesta más de lo que protege — y `/cerrar-implementacion`
  es quien tiene el smoke con backend vivo, que es donde esto se ve de verdad.
- **Decidido: PENDIENTE del visto bueno.**

## 6. Hechos que cambian lo que dicen los documentos anteriores

> **La O5 es la última ola.** Este bloque no enmienda prompts de una ola siguiente —no hay— sino que
> va **al `/cerrar-implementacion D-065`**, que es quien escribe el ADR, `CLAUDE.md`, `BIT-MODBD` y
> `BIT-RF`. Se copia tal cual, **encima** de los 13 puntos del `GATE-O4.md §6`, que siguen todos en
> pie.

14. **Esta app tiene TRES borradores, y los tres usan la misma forma.**
    `registro_activo._dirty` (D-040), `mandDirty` (F17) y ahora el reparto de la configuración anual.
    El tercero es el primero cuya suciedad **no vive en el raíz**, y de ahí sale la regla que queda
    escrita: **la reporta quien la tiene** —`onDirtyChange(bool)`, el mismo nombre y la misma firma
    con que `SalaDeMandoGrid` levanta su diff— y **la decide una sola función pura** que llaman todas
    las salidas. Cuatro copias de la condición en cuatro handlers es *exactamente* cómo nació CR4-4:
    dos entradas de menú nuevas que no supieron del borrador que ya existía.
15. **Y su otra mitad, que es la que se olvida: el componente tiene que DESMENTIR su aviso al
    desmontarse.** Sin el `false` del cleanup, quien acepta perder el borrador deja el flag del raíz
    encendido para siempre — el dueño del buffer ya no existe y nadie más puede apagarlo. El flag
    queda además acotado a su sección (`vistaActual !== 'rotacion' → 'seguir'`), así que ni colgado
    puede estorbar la navegación del resto.
16. **Una guarda de navegación cubre los HANDLERS, no los EFECTOS — y en esta app las dos cosas
    mueven `vista`.** Las salidas que pasan por el **efecto (a)** de sincronización ruta→estado
    siguen desmontando la pantalla sin preguntar, y son **tres**: el back/forward del navegador, el
    hash editado o pegado a mano, y —la que nadie ve venir— **un `revalidate` que corrija el cargo y
    quite `puede_configurar_rotacion`**, porque esa constante está en las deps del efecto desde
    CR4-12 y su rama cae a `setVista('bitacoras')`. Taparlas exige un *blocker* de historial sobre
    los dos efectos que D-035 mantiene con refs de igualdad para no entrar en bucle: es un lote
    propio, no una condición más. Ver **H-L14-1**.
17. **Cuando dos borradores pueden coexistir, el aviso que bloquea tiene que nombrarlos a los dos.**
    En "Cambiar de unidad" el mensaje elige por ternario y el reparto gana, así que un `_dirty` de
    bitácora abierto al mismo tiempo queda sin mencionar: la persona guarda el reparto, reintenta y
    choca otra vez, ahora con el otro texto. No pierde nada —bloquea igual— pero la guía es falsa a
    medias. Ver **CR5-11**, arreglado en este gate.
18. **La firma final de `ConfiguracionRotacion`, para el ADR** (las tres props son opcionales; la
    pantalla sigue sin leer ni escribir el hash):
    ```jsx
    <ConfiguracionRotacion
      puedeConfigurar={puedeConfigurarRotacion}   // gate de UI (F37.A2). Default false: falla cerrada
      onError={handleRotacionError}               // (codigo | null) => void. D-032: código, nunca texto
      onDirtyChange={setRotacionDirty}            // (bool) => void. D-065 L14 · CR4-4
    />
    ```
    Y `BitacorasGecelca3.jsx` exporta ahora **dos** cosas además del default: `GrillaRegistros` y
    `planearSalidaDeRotacion({ vistaActual, destino, hayBorrador }) → 'seguir' | 'confirmar'`.
19. **Remedir un árbol idéntico no es ritual: valida las condiciones de invocación.** El backend de
    esta ola es byte a byte el de la anterior y la cifra tenía que repetirse — pero la corrida
    también demostró que, con `--test-concurrency=1` y `M365_CLIENT_SECRET=` puestos **en los dos
    procesos desde el primer comando**, la suite de D-065 sale verde de una sola pasada. Los dos
    gates anteriores perdieron una corrida cada uno por no tenerlos. **Van al runbook del cierre como
    comando, no como advertencia.**
20. **La lista de salidas de una guarda se arma mirando QUIÉN USA la pantalla, no qué handler tiene
    el nombre parecido.** Hay dos caminos para cambiar de unidad —el atajo en caliente de D-054 y el
    ítem del menú— y el que *se llama* "Cambiar de unidad" es el segundo. Peor: el atajo depende de
    `cargo.puede_cambiar_unidad`, que los dos cargos que configuran la rotación tienen en **0**, así
    que guardar el atajo dejó la guarda **inalcanzable justo para quien tiene el borrador**. El
    chequeo que lo habría evitado no está en el diff sino en el seed: *¿este control lo ve la persona
    de la que estoy hablando?* (CR5-1).
21. **"Lo que se puede GUARDAR" y "lo que se puede PERDER" son dos nociones distintas, y una guarda
    que use la primera falla en silencio.** El diff que el router acepta descarta las filas
    incompletas; el trabajo perdido las incluye. En esta pantalla eso hacía que la propia interfaz se
    contradijera —un aviso decía "hay N personas con grupo pero sin rol" y la guarda decía "nada que
    perder"— y encima escondía `Descartar`. La regla que queda: **cada control se ata a la noción que
    le corresponde** (Guardar → lo guardable; todo lo que destruye el buffer → lo perdible), y las dos
    se derivan de lo mismo para que no puedan divergir (CR5-2, y es la lección de la convención 35).
22. **El cable entre dos mitades necesita su propio guard, porque su ausencia no pone nada en rojo.**
    `onDirtyChange={setRotacionDirty}` es el único punto donde el componente que reporta y el raíz que
    decide se encuentran: borrarlo dejaba 442 casos en verde y la guarda sin dispararse jamás. Cuando
    montar el consumidor real no es viable, el sustituto honesto es un **guard estático** sobre el
    fuente —el patrón que el backend ya usa en `guard_marcador_reflejo`—, con su meta-test del
    stripper (CR5-9, CR5-1).
23. **Un control que RELEE del servidor destruye el buffer igual que una navegación, y se gatea
    igual.** El refetch de Entra ya lo hacía; el selector de fecha, dos líneas más abajo en el mismo
    archivo, no. Cuando dos controles hacen lo mismo y solo uno está protegido, el desprotegido es un
    olvido, no una decisión (CR5-4).
24. **El `/security-review` apunta por defecto al diff de la RAMA, no al de la ola.** En este repo
    eso son 3,2 MB y 200+ archivos que los cuatro gates anteriores ya cerraron: no es una revisión
    más amplia, es diluir la atención sobre las líneas que la ola de verdad estrenó. **El gate acotó
    la revisión a mano** al diff de la ola, con evidencia literal por grep (§3.8). Al runbook: el
    argumento de ese skill es el rango, no la rama.

## 7. Hallazgos consolidados (deduplicados entre el lote y el gate)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| **CR5-1** | `/code-review` | **La guarda del cambio de unidad estaba en el botón equivocado.** L14 guardó `handleIrAUnidad` (el atajo de D-054); el ítem del menú llamado "Cambiar de unidad" es `handleCambiarUnidad` y no consultaba nada. Y el atajo **no existe** para los dos cargos que configuran la rotación (`puede_cambiar_unidad = 0` en el seed), así que la guarda era inalcanzable justo para quien tiene el borrador | **alta** — confirmado en los dos handlers y en el MERGE de cargos de `db.js` | **Arreglado en el gate** (D1), con guard nuevo de 10 casos y bidireccional |
| **CR5-2** | `/code-review` | **La guarda no se enteraba del estado normal de la primera carga anual.** `calcularCambios` descarta a quien tiene grupo y aún no rol, así que la pantalla mostraba su aviso de `sinRol` mientras la guarda decía "nada que perder" — y `Descartar` ni se dibujaba | **media**, consecuencia alta | **Arreglado en el gate** (D2), con dos casos |
| **CR5-4** | `/code-review` | **El control "Vigente desde" destruía el buffer y estaba disponible.** Mover la fecha relee y hace `setBuffer(bufferDesde(lista))`; su hermano "Actualizar desde Entra", dos líneas más abajo, ya se gateaba | media | **Arreglado en el gate** (D3), con dos casos |
| **CR5-7** | `/code-review` | **F5 y cerrar la pestaña se llevaban el reparto sin que el navegador dijera nada**, mientras `SalaDeMandoGrid` —el contrato que esta pantalla copia— ya traía su `beforeunload` | media | **Arreglado en el gate** (D3), con tres casos |
| **CR5-11** | `/code-review` + gate | Con los dos borradores pendientes, el modal del cambio de unidad nombraba solo el reparto: se resolvía uno y se chocaba de nuevo con otro texto | baja | **Arreglado en el gate** (D4), con tres casos |
| **CR5-9** | `/code-review` | **El cable `onDirtyChange={setRotacionDirty}` no tenía test**: borrarlo dejaba la suite entera en verde mientras la guarda no se disparaba nunca | media | **Cerrado de paso** por el guard de D1 |
| **CR5-8** | `/code-review` | **La pantalla tiene un SEGUNDO borrador sin reportar:** el `form` de la zona de patrones (rol, 2 fechas, 2 vectores de 8 números, 2 grupos) se pierde sin preguntar aunque la guarda esté puesta. Además `onCrearPatron` no resetea `form` tras crear, así que un segundo clic re-POSTea el mismo patrón para un 409 | media | **DECISIÓN D5** — O6 de un lote, o deuda declarada al cierre |
| **CR5-5 / H-L14-1** | `/code-review` + L14 | Las salidas por el **efecto (a)** siguen sin guarda: back/forward, hash a mano y —el disparador que el cierre de L14 no nombra— un `revalidate` que quite `puede_configurar_rotacion`. Entrar a `#/rotacion` hace `pushState`, así que el back es una salida natural | media | **DECISIÓN D5** — con CR5-8 |
| **CR5-3** | `/code-review` | Las dos entradas nuevas del menú son salidas sin guarda **para el buffer de MAND** (24 periodos de captura), que también es estado local y muere al desmontar. **No es regresión de esta ola:** el toggle "Ver históricos" ya lo hacía desde antes de D-065 | media | **Cierre** — es el problema general que D-065 resolvió solo para su pantalla |
| **CR5-6** | `/code-review` | `SalaDeMandoGrid` **nunca reporta `false` al desmontarse**, así que `mandDirty` queda pegado en `true` y bloquea el cambio de unidad con un mensaje sobre una grilla que ya no está en pantalla. Es el defecto que L14 sí evitó en su componente ("nadie más podría apagarlo") | media | **Cierre** — otro archivo, otra feature (F17) |
| **CR5-10** | `/code-review` | `planearSalidaDeRotacion` (y ahora `mensajeCambiosSinGuardar`) viven dentro de una vista de 3.000 líneas, contra la convención 36 ("no lo vuelvas a alojar en una vista"); el test del componente arrastra todo el árbol del dashboard para importarlas. Y las dos llamadas interpretan el enum con defaults opuestos: `!== 'seguir'` → confirma (falla cerrada) vs. `!== 'confirmar'` → sigue (falla abierta) | baja | **Cierre** — mover las dos a `src/routing/` o `src/utils/` es una consolidación, no un arreglo |
| **CR5-12** | `/code-review` | El modal de la guarda no se cierra si la ruta cambia por debajo: con el modal abierto y un back del navegador, queda un aviso sobre una pantalla que ya se desmontó, y "Salir sin guardar" navega con el `destino` de antes | baja (ventana de segundos) | **Cierre**, como limitación conocida |
| H-L14-2 | L14 | "Cerrar sesión" no consulta la guarda | informativa | **Cierre**. El propio cierre argumenta que **no debe** arreglarse: el `LogoutModal` ya es una confirmación explícita y encadenar dos enseña a despacharlas sin leerlas |
| H-L14-3 | L14 | El flag del raíz es de la sección, no de la app (`rotacionDirty` solo se consulta en `vista === 'rotacion'`) | informativa | Ninguno. Es a propósito y tiene caso |

**Lo que el gate NO encontró:** ni un solo hallazgo de backend —no había diff que revisar— y ninguno
de seguridad (§3.8). Los cuatro hallazgos arreglados acá son todos de la misma familia y se leen
juntos como una sola frase: **una guarda contra la pérdida de trabajo vale lo que valga su lista de
salidas, y la lista se arma mirando quién usa la pantalla, no qué handler tiene el nombre parecido.**

## 8. Ola siguiente

**Depende de la decisión D5, y es la única pregunta abierta de este gate.**

- **Si el visto bueno elige la deuda declarada (recomendado):** no hay O6. Lo que sigue es
  `/cerrar-implementacion D-065`, que escribe el ADR **D-065**, la convención **38** de `CLAUDE.md`,
  `BIT-MODBD v2.8`, `BIT-RF v2.4 / RF-079` y hace el `git rm` del scaffolding — con **CR5-8** y
  **CR5-5 / H-L14-1** escritos en el ADR con su escenario, no como una nota al pie.
- **Si elige cerrarlos antes**, la O6 lleva **un solo lote**:

| Lote | Título | Territorio |
|---|---|---|
| L15 | El segundo borrador de la configuración anual y las salidas por el efecto (a) | `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx` · `src/BitacorasGecelca3.jsx` · `src/components/Rotacion/guard-salidas-borrador.test.js` |

En cualquiera de los dos casos, **nada de esto bloquea el despliegue**: la pérdida que motivó toda la
ola —repartir ~81 personas y salir por el menú— está cubierta por cinco salidas y por el navegador.

**Lo que el cierre hereda** (nada de esto es de esta ola; se repite acá para que no haya que
reconstruirlo desde cinco gates):

| Qué | De dónde |
|---|---|
| El **smoke con backend vivo, datos reales y login Entra** — el único "end-to-end" que ningún gate pudo correr | H-L07-4 + salvedad del `GATE-O4 §4` |
| **CR5-8** (el segundo borrador de la pantalla) y **CR5-5 / H-L14-1** (las salidas por el efecto (a)) — si el visto bueno elige la deuda | esta ola, §5 D5 |
| Runbook: las **dos condiciones de invocación** de la suite y el rango del `/security-review` | `GATE-O4 §6.13` + §6.19/§6.20 de acá |
| El grupo de Entra `ADMINISTRADOR Y DEBUGGING` **vacío** y las **13 personas duplicadas** en `lov_bit.usuario` | fase 2 |
| **H1 / H2** del GATE-O3: `CLAUDE.md:22` sin `--test-concurrency=1`; **8 `.test.js` fuera del script** (77 en disco, 69 enganchados) | `GATE-O3 §7` — verificados otra vez acá, siguen abiertos |
| **H6** (un test baja un CHECK de producción), **CR4-5**, **CR4-6**, **H4**, **H5**, **H-L07-2**, **H-L09-1/3**, **H-L13-2**, **H-L14-2/3** | `GATE-O4 §7` + `cierres/L14.md` |
| `prompts/rotacion-turnos/PROMPT.txt` — el documento de arranque del usuario, **sin versionar**, fuera del scaffolding que el cierre borra | árbol |

## 9. Commit del gate

`d0ee9c7` `gate(D-065): O5 cerrada — 1 lote, 897/897 backend, 442/442 front, 4 arreglos del gate`
