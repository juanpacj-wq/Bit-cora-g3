# D-061 — GATE-O3 (cierre de la ola O3)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-061 O3`. Es un expediente
> **inmutable**: si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"),
> no se borra. Fecha: `2026-08-27 09:05` (Bogotá). Rama `feat/sis-carbon-cierre-2026-08`.

## 1. Semáforo al cerrar
```
O3 [abierta]
  L09  done        L09-2344     El refetch preservado no puede convertirse en un borrado al guardar (front COMB) ← L08
  L10  done        L10-2345     Endurecer el descubrimiento del SIS y hacer honesta la cobertura del scrape manual ← L04,L05

O4 [pendiente]
  L07  pending                  Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm scraper y prompts D-029 ← L04,L05,L06,L08,L09,L10

test-lock: libre
```
Lotes sin cierre commiteado: **ninguno** (L09 `fa25807`, L10 `8cf415c`). **Bloqueos: ninguno** —
los dos cierres dicen "Ninguno" y ningún lote necesitó salir de su territorio.

## 2. Territorios
```
L09 · 2 commit(s): fa25807 2520640
archivos tocados (6): cierres/L09.md, src/components/Combustibles/{ConsumosGrid.jsx,
  ConsumosGrid.test.jsx, combustibles.css, override.js, override.test.js}
[lotes] territorio respetado

L10 · 2 commit(s): 8cf415c 2805869
archivos tocados (7): cierres/L10.md, server/routes/combustibles.js,
  server/scripts/backfill-carbon-gec32.js, server/tests/{sis_discover,sis_endpoints,
  sis_scrape_endpoint}.test.js, server/utils/sis/discover.js
[lotes] territorio respetado
```
Violaciones: **ninguna**. L09 no tocó `server/**` y L10 no tocó `src/**`, pese a haber corrido en
paralelo sobre el mismo árbol.

## 3. Verificación de la ola (bajo test-lock `GATE-O3`)

**Tests enganchados a `server/package.json`: ninguno.** Los tres archivos de L10 ya estaban en el
script desde la O2 y los dos de L09 caen solos en el `include` de vitest. El script sigue con 54
archivos y `zzz_session_leak_guard` último.

**Ediciones del gate en compartidos: ninguna.** Este gate no tocó código (ver §5 D11: los hallazgos
confirmados caen todos en territorio de lote, no en un compartido sin dueño).

**Suite backend completa** — efímero `:3199` con el código de la rama, `AUTH_TEST_BYPASS=1`, sin
`SKIP_INITDB`, `SIS_HOST=http://localhost:3154` y `SIS_SWEEPER_ENABLED=0`; el proceso de
`node --test` con el mismo `SIS_HOST`; BD `PortalG3_dev`; corrida desacoplada:
```
ℹ tests 637 · suites 31 · pass 637 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 2277254.4021
```
**38,0 min**, con los **dos** backfills (dev y prod) escribiendo en paralelo — más rápido que los
58 min de la O2 porque las corridas van por 2018–2019, días sin carbón y por eso baratos de escribir.

**Contra el baseline** (`632 · pass 632 · skipped 0`, GATE-O2): **+5 tests, todos verdes, sin rojos
nuevos y sin skips.** Los 5 son `sis_discover` 13→16, `sis_scrape_endpoint` 9→10 y `sis_endpoints`
+1 (CA-47). El cierre de L10 anunció **+2 (634)**: la suma estaba mal —él mismo lista +3, +1 y +1—
y el número real es **637**. Es el segundo cierre de este flujo que se equivoca sumando su propio
aporte (L08 dijo 148 donde eran 160): anotado en §7 como gotcha.

**Los 6 tests nuevos, nombrados en el log:**
```
✔ CA-41. un fetch que falla NO se memoriza como vacío: se reintenta y el segundo intento manda
✔ CA-41. si el SIS insiste en fallar, el sondeo para y lo dice: error-de-sondeo, sin fecha
✔ CA-42. con el techo en un día de parada el ancla igual encuentra el inicio
✔ CA-43. el retorno es { fecha, motivo, sondeos } y el CLI distingue hallada de tope-alcanzado
✔ CA-44. los casos HTTP no se saltean en silencio: sin el stub del SIS la suite queda roja
✔ CA-47. cambiar la cantidad sin la clave detalle tampoco borra el comentario (simetría con CA-36)
```

**CA-45 aparte, con el sweeper ENCENDIDO.** L10 dejó el conflicto planteado (H-L10-3): CA-45 exige
el sweeper vivo y la suite grande corre con él apagado (D7), y **no se puede tener las dos cosas en
el mismo backend**. El gate lo resolvió separando: la suite completa con el flag en `0`, y después
un efímero aparte con el sweeper encendido, tres pasadas seguidas, con el tick de los 10 s cayendo
dentro de la corrida:
```
pasada 1 (08:48:59) · ℹ tests 10 · pass 10 · fail 0 · skipped 0
pasada 2 (08:50:10) · ℹ tests 10 · pass 10 · fail 0 · skipped 0
pasada 3 (08:51:11) · ℹ tests 10 · pass 10 · fail 0 · skipped 0
```
**Y esa pasada dejó la prueba de por qué existe D7.** El sweeper del efímero, apuntando al stub,
escribió la fila de HOY de GEC32 (medido antes y después):
```
antes:   2026-08-27 · horario · ok=3  · err=0 · ultimo=3    · completo=0
después: 2026-08-27 · horario · ok=0  · err=8 · ultimo=NULL · completo=0
```
Es exactamente H38, medido por segunda vez y ahora en carne propia. **Se auto-sana**: con
`periodos_error != 0`, `periodoDesdeDe` devuelve 1 y el próximo tick del backend real de dev
(`:3002`, vivo, PID 23116, a las HH:02) re-pide el día entero. Ninguna celda de
`consumo_combustible` se tocó — el scraper solo escribe lecturas exitosas. Alcance: una fila de log
de dev durante menos de una hora.

**Front:**
- vitest: `Test Files 15 passed · Tests 201 passed (201)` — 12,06 s. Baseline O2: 160. **+41**
  (`override.test.js` 40→68, `ConsumosGrid.test.jsx` 22→35).
- `npm run build`: ✓ `built in 4.89s`.

**Residuos en BD: ninguno.** `npm run test:residuos` → 10 checks en `ok`, `cero residuos`. Query
directa: 0 celdas y 0 logs de GEC3/GEC32 en las fechas fijas de los suites (`2026-04-15..20`), 0
sesiones sintéticas activas, catálogo TST = 10 (fixture residente).

**`/code-review` del diff de la ola** (`195e8a4..HEAD`, nivel high): **13 hallazgos**. El revisor
verificó tres corriendo código, y **los tres los confirmé yo también** antes de enrutarlos (§7:
H49, H50, H51). Ninguno cae en un archivo compartido sin dueño, así que el gate no arregló nada
acá. Reparto: **7 → L11** (lote nuevo), **6 → nota/deuda/ADR**.

**`/security-review`: no se corrió, y esta es la razón.** El disparador de la metodología es "auth,
permisos, sesiones, SQL dinámico o el contrato cross-repo". El único diff con superficie HTTP de la
O3 es `routes/combustibles.js`, y lo leí entero: son dos cambios: (a) CA-47, que iguala el manejo de
`detalle` en la rama de UPDATE con la de vaciado —sin SQL nuevo, con `.input()` tipado, sin tocar el
gate de permisos—, y (b) `sweeper: { habilitado }` en `GET /sis/estado`, un booleano derivado de una
variable de entorno detrás del mismo `puede_ver` que ya protegía el resto del cuerpo. Cero cambios
en auth, sesiones, matriz de permisos, construcción de SQL o el contrato cross-repo. El
`/security-review` de la O2, que sí cubrió estos dos endpoints de punta a punta, sigue vigente.

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-37 | L09 | `parcial` → **L11 CA-48** | `ConsumosGrid.test.jsx › CA-37` (6 casos) y `override.test.js › calcularDiff`/`reconciliarBuffer` ✔ en la suite front. Pero **H50**: `editadasRef` nunca suelta una coordenada, así que una celda tocada y devuelta a su valor original sigue anclada al buffer viejo y el Guardar siguiente la escribe encima de lo que el SIS puso. Es el mismo modo de falla de H24, más estrecho y vivo |
| CA-38 | L09 | `cumple` | `ConsumosGrid.test.jsx › CA-38` (3 casos) ✔ |
| CA-39 | L09 | `parcial` → **L11 CA-50/CA-51** | `override.test.js › ladoPopover` (9) y `ConsumosGrid.test.jsx › CA-39` (6) ✔. Pero **H53** (el lado medido vive en una sola entrada: pasar el puntero por otro banderín le quita el lado al popover fijado) y **H54** (`ladoPopover` cuenta el `thead` sticky como espacio libre y el popover volteado hacia arriba pinta encima de la cabecera) |
| CA-40 | L09 | `cumple` con la desviación declarada | lectura del diff (`nAlim` se retiró y quedó un solo `alimentadores`, del que salen columnas, Total Carbón y heatmap) + vitest 201/201 + build ✔ |
| CA-41 | L10 | `cumple` | `tests/sis_discover.test.js › CA-41` ×2 ✔ en suite completa |
| CA-42 | L10 | `parcial` → **L11 CA-52** | `tests/sis_discover.test.js › CA-42` ✔, pero **H49**: la misma ventana hacia atrás que arregla el techo hace que el **día del `hint` no se sondee nunca** si cae a menos de `span` (50 d) del techo. Es una regresión que el arreglo introdujo |
| CA-43 | L10 | `cumple` | `tests/sis_discover.test.js › CA-43` ✔ (compara las líneas literales de `explicarDescubrimiento` contra un `discoverEarliestDate` real sobre `fetchFn` simulado) |
| CA-44 | L10 | `parcial` → **L11 CA-53** | `tests/sis_scrape_endpoint.test.js › CA-44` ✔ en la corrida del gate (con el stub). Pero **H51**: la guarda deja `npm test` **permanentemente rojo** por defecto — `TEST_BASE_URL` cae a `localhost:3002` y nadie exporta `SIS_HOST`. Lo corrí: `pass 4 · fail 1`. El fin (que un skip duela) es correcto; el medio destruye la misma señal que quería salvar |
| CA-45 | L10 | `cumple` | tres pasadas 10/10 con el sweeper encendido, corridas por el gate (§3) |
| CA-46 | L10 | `cumple` como contrato, `parcial` como objetivo → **H56** | `tests/sis_scrape_endpoint.test.js › CA-17` ✔: `GET /sis/estado` devuelve `sweeper: { habilitado }`. Pero `grep -rn "sis/estado" src/` no devuelve **nada**: ninguna pantalla consume ese endpoint, así que el objetivo de H33 —que el operador distinga un sweeper apagado de uno roto— no está entregado |
| CA-47 | L10 | `cumple` | `tests/sis_endpoints.test.js › CA-47` ✔ + lectura del diff (la ausencia de la clave `detalle` conserva el comentario en **las dos** ramas) |
| CA-12 / CA-35 | L03 / L08 (arrastrados) | siguen `parcial` | el smoke visual del usuario. **Ya no se puede hacer todavía**: L11 vuelve a mover el popover (H53, H54). Conviene después de L11 |

## 5. Decisiones tomadas en este gate

### D11 — El gate no arregla nada de código, aunque tres hallazgos sean altos
- **Qué lo provoca:** de los 13 hallazgos, 3 son altos (H49, H50, H51) y 4 medios de los mismos
  archivos. La regla de §9 de la metodología es: si el hallazgo cae en un archivo compartido sin
  dueño, lo arregla el gate; si no, abre lote de corrección.
- **Opciones:** a) arreglarlos acá (son ~10 líneas entre los tres) · b) lote de corrección ·
  c) mitad y mitad: H51 acá (porque deja la suite canónica roja) y los otros dos en lote —
  **Recomendada:** b.
- **Decidido:** b (integrador). Los tres viven en territorio de lote (`ConsumosGrid.jsx`,
  `discover.js`, `sis_scrape_endpoint.test.js`) y —más importante— **ninguno se puede arreglar
  bien sin un test que lo fije**. Un arreglo del gate sin verificador bidireccional es
  exactamente lo que produjo H50: L09 cerró H24 con dos cerrojos y dejó abierta la puerta de al
  lado porque nadie escribió el caso "tocar y deshacer". (c) tienta con H51, pero su arreglo no es
  de una línea: hay que decidir **cómo** sabe el archivo que el harness está en juego, y esa
  decisión merece un test.
- **Qué cambia / qué NO cambia:** nada de código en este commit. `server/package.json` queda igual
  (54 archivos).

### D12 — El reparto de la O4: un solo lote de corrección, y L07 en paralelo
- **Qué lo provoca:** es la **tercera** ola seguida en la que el `/code-review` encuentra defectos
  en las correcciones de la anterior (O1 → L08; O2 → L09 y L10; O3 → esto). Hay que decidir si eso
  significa abrir otra ola de corrección y otra más después, o cortar.
- **Lectura del patrón, que es lo que importa para decidir:** los tres altos de esta ronda **no son
  del mismo tipo**. H50 y H49 son *fronteras del arreglo anterior* (el caso que el arreglo no
  contempló, la regresión que el arreglo introdujo en el camino de al lado), y esos aparecen porque
  la pantalla COMB tiene dos escritores concurrentes —el operador y el SIS— y `discover` decide
  sobre una red que falla: son dominios donde cada arreglo estrecha el hueco sin cerrarlo del todo.
  H51 es otra cosa: un arreglo correcto en la intención y mal calibrado en el medio. Ninguno es un
  fallo del proceso; los tres los encontró la revisión, que es su trabajo.
- **Opciones:** a) **O4 = L11 (los 3 altos + 4 medios) y L07 en paralelo**, luego el cierre ·
  b) O4 = L11 solo, O5 = L07 (un día más de calendario, cero riesgo de que L07 documente algo que
  L11 mueva) · c) cortar: cerrar D-061 con los tres altos como deuda documentada —
  **Recomendada:** a.
- **Decidido:** **a — aprobada por el usuario el 2026-08-27 09:14** (§8). Razones para (a): L11 y L07 son territorios
  completamente disjuntos (`src/**` + `utils/sis` + tests, contra `BIT-*` + `docs/` + `deploy/`), y
  **L11 no mueve ningún contrato**: no toca C3 (el valor de retorno queda como lo dejó L10), ni C8,
  ni el vocabulario de `MOTIVOS`, ni los códigos de salida del CLI — arregla el ancla por dentro y
  el resto es front y tests. Lo que L07 documenta no se mueve bajo sus pies. Razón contra (c):
  H50 es **pérdida de datos sobre planta real** y H51 deja la suite canónica en rojo permanente;
  ninguna de las dos es deuda aceptable para un ADR que se va a cerrar.
- **Qué cambia / qué NO cambia:** L07 pasa de ser la única de O4 a compartirla, y gana una
  dependencia de lectura (no de bloqueo) sobre `cierres/L11.md`.
- **Enmiendas que produce:** `L11-cierre-de-fronteras.md` (nuevo), cabecera de
  `L07-docs-cleanup.md`, `PLAN-OLAS.md`, `LOTES.json`.

### D13 — El backfill con `concurrencia 6` sostenida sí produce errores, y el runbook tiene que decirlo
- **Qué lo provoca:** las dos corridas vivas los muestran. Medido por el gate:
  **dev 22 días con `err>0` de 331 procesados** y **prod 23 de 235** (~7 % y ~10 %). La calibración
  de L05 (CA-23) midió 24 periodos de **un** día con 0 errores; sostenido durante horas no es cero,
  y correr dos backfills a la vez duplica la carga sobre el SIS.
- **Opciones:** a) bajar la concurrencia y relanzar · b) dejarlas correr y cerrar los días
  incompletos con una segunda pasada · c) tratar los días con error como pérdida —
  **Recomendada:** b.
- **Decidido:** b (integrador). **No se pierde nada**: esos días quedan `completo=0` y, como
  `periodos_error != 0` hace que `periodoDesdeDe` devuelva 1 (verificado en
  `sis-sweeper-helpers.js:23`), una segunda pasada del **mismo comando** los re-pide **enteros**.
  El flag `--solo-parciales` acota esa pasada exactamente a los días que ya tienen fila, o sea a
  los incompletos. Bajar la concurrencia costaría días de calendario para evitar un reintento de
  minutos.
- **Qué cambia / qué NO cambia:** nada de código. **L07 tiene que escribirlo en el runbook de
  `deploy/DEPLOY.md`: la corrida grande son DOS pasadas, la segunda con `--solo-parciales`**, y el
  criterio de "terminado" es `SELECT COUNT(*) … WHERE completo = 0` en cero, no que el proceso haya
  salido.

## 6. Hechos que cambian lo que dicen los documentos anteriores
> Este bloque se copia **tal cual** al inicio de cada prompt de la ola O4.

- **`discoverEarliestDate` devuelve `{ fecha, motivo, sondeos }`** (C3 enmendado por L10). `motivo` ∈
  `hallada | tope-alcanzado | sin-datos | error-de-sondeo`; `fecha` es `null` en los dos últimos y
  **nunca** se devuelve una fecha después de un error de red. `discover.js` exporta además `MOTIVOS`
  y `explicarDescubrimiento` (la función pura de la que salen el texto del CLI y su código de
  salida). **Ojo:** `carbon-scraper.js` sigue re-exportando el símbolo con el nombre viejo y la
  forma nueva — hoy nadie lo consume por ahí, pero es una trampa (H55).
- **El CLI tiene tres códigos de salida en `--from auto`:** `3` (inicio hallado, falta
  `--confirm-from`), **`4` (tope alcanzado**: la fecha que muestra es el día con datos más antiguo
  que vio, puede haber historia más atrás), `2` (el sondeo no sirve). El `4` es nuevo.
- **`GET /api/combustibles/sis/estado` responde `{ job, lock, sweeper: { habilitado } }`** (C8
  creció, aditivo). **Ninguna pantalla lo consume todavía** (`grep sis/estado src/` → vacío), así
  que el objetivo de H33 —distinguir un sweeper apagado de uno roto desde la UI— **no está
  entregado**; y el campo reporta la variable de entorno, no si el tick está vivo.
- **`POST /api/combustibles/consumos` ya no se contradice:** la clave `detalle` ausente conserva el
  comentario en **las dos** ramas (vaciar y cambiar la cantidad); presente —aunque venga `null`—
  manda el body.
- `src/components/Combustibles/override.js` tiene **16 exports** (13 funciones + `GAVELA_MS`,
  `ALTO_TIP`, `ANCHO_TIP`), no 10: L09 agregó `claveCelda`, `reconciliarBuffer`, `calcularDiff` y
  `ladoPopover`. C11 tiene que reflejarlo.
- **El diff que la grilla manda al server ya no sale de comparar buffer contra snapshot**, sino del
  conjunto explícito de coordenadas que el operador tocó; y cuando vuelve una lectura con una
  edición viva, el buffer se reconcilia celda por celda contra el snapshot nuevo. `setCelda` es la
  **única** puerta de escritura del buffer y tiene que seguir siéndolo.
- **El lado del popover se decide midiendo** (`ladoPopover`, función pura que recibe los dos rects),
  no por número de periodo ni por índice de columna. La regla vieja (`p >= 19`, `idx >= nAlim - 2`)
  ya no existe y sus dos tests se reescribieron.
- **La corrida del backfill son DOS pasadas.** Con `concurrencia 6` sostenida el SIS falla en ~7–10 %
  de los días (medido: 22/331 en dev, 23/235 en prod, con las dos corridas simultáneas). Esos días
  quedan `completo=0` y una segunda pasada del mismo comando con **`--solo-parciales`** los re-pide
  enteros. El criterio de "terminado" es `COUNT(*) WHERE completo = 0` en cero, **no** que el
  proceso haya salido. **L07 lo escribe en el runbook** (D13).
- **La suite completa son ~38 min** con los dos backfills vivos (58 min en la O2 con uno solo; el
  número no escala con la carga porque depende de qué años esté escribiendo el backfill).
- **`npm test` a secas queda ROJO** desde L10 (H51): la guarda de CA-44 exige
  `SIS_HOST=http://localhost:3154` y el `.env` no la trae. Hasta que L11 lo arregle, toda corrida
  honesta de la suite tiene que exportar esa variable **en el proceso de tests y en el efímero**,
  y el efímero además `SIS_SWEEPER_ENABLED=0` (D7) salvo que se esté probando CA-45.
- **CA-45 y D7 no caben en el mismo backend:** CA-45 exige el sweeper encendido y D7 lo apaga. Se
  corren aparte, y la pasada con el sweeper encendido **ensucia la fila de hoy de GEC32** (medido:
  `ok=3` → `ok=0/err=8`). Se auto-sana en el siguiente tick del backend real.
- **Dos cierres de este flujo se han equivocado sumando su propio aporte de tests** (L08 dijo 148
  donde eran 160; L10 dijo 634 donde eran 637). El conteo que vale es el de la suite del gate.

## 7. Hallazgos consolidados (deduplicados)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H49 | code-review (confirmado por el gate) | **La ventana hacia atrás del ancla (arreglo de H29) hace que el día del `hint` no se sondee nunca** si cae a menos de `span` (50 d) del techo: la rejilla se corre y el único día que el llamador sabe que tiene datos queda fuera. El repro devuelve `sin-datos` sin haberlo preguntado. En una instalación donde el sweeper solo lleve unas semanas de log, `hint = MIN(fecha)` está siempre dentro de esa distancia y `--from auto` muere con exit 2. | **alta (regresión)** | **L11** CA-52 |
| H50 | code-review (confirmado por el gate) | **`editadasRef` nunca suelta una coordenada.** Una celda que el operador tocó y devolvió a su valor original queda anclada al buffer viejo; si el SIS la cambia durante un GET preservado, `reconciliarBuffer` restaura la versión vieja y `calcularDiff` la emite: el Guardar escribe el valor viejo encima del fresco, a nombre del operador, y la ownership de D-029 impide reponerlo. **Es H24 otra vez**, por la puerta de al lado. El comentario de `:253` afirma que es seguro "porque `calcularDiff` ya no la emite si no difiere", y eso solo vale mientras el server no cambie. | **alta** | **L11** CA-48 |
| H51 | code-review (confirmado por el gate) | **La guarda de CA-44 deja `npm test` permanentemente rojo.** `TEST_BASE_URL` cae a `localhost:3002` (el backend de dev, que apunta al SIS real), el `.env` no trae `SIS_HOST` y nada exporta `SIS_STUB_OPCIONAL`. Corrido por el gate: `pass 4 · fail 1`. Un rojo permanente que no es una regresión destruye la señal igual de bien que el skip silencioso que H31 quería evitar. | **alta** | **L11** CA-53 |
| H52 | code-review | `hayCambios` (compara `JSON.stringify` del buffer entero) y `calcularDiff` (solo las editadas, y solo `cantidad`/`detalle`) discrepan sobre qué es "sucio": basta que la respuesta traiga metadata refrescada de una celda editada para que Guardar quede habilitado, la gavela corriendo y el `beforeunload` armado, mientras el diff sale vacío y el botón responde "Sin cambios para guardar". El operador no puede salir del estado salvo con Descartar o esperando 10 minutos. | media | **L11** CA-49 |
| H53 | code-review (confirmado por el gate) | El lado medido del popover vive en **una sola entrada** (`ladoTip`, con su `clave`), pero `tipAbierto` es independiente: mover el puntero sobre cualquier otro banderín le quita el lado al popover fijado, que vuelve al default abajo-derecha y se recorta. `setTipAbierto(null)` tampoco limpia `ladoTip`. | media | **L11** CA-50 |
| H54 | code-review | `ladoPopover` mide contra la caja completa de `.comb-scroll`, contando el `thead` sticky como espacio libre: un popover volteado hacia arriba se pinta **encima de la cabecera** (gana por `z-index:5` contra el `2` del `thead`) en vez de evitarla. | media | **L11** CA-51 |
| H55 | code-review | `carbon-scraper.js` re-exporta `discoverEarliestDate` "para no romper" a nadie, pero ahora entrega la forma nueva con el nombre viejo: quien haga `if (!inicio)` recibe un objeto siempre truthy. Hoy nadie lo consume por esa vía (verificado), o sea que es una trampa dormida, no un bug vivo. | media | **L11** CA-54 |
| H56 | code-review (confirmado por el gate) | `sweeper.habilitado` no lo consume **ninguna** pantalla: el objetivo de H33 (que el operador distinga apagado de roto) no está entregado; el chip que menciona el comentario se alimenta de `GET /consumos`, no de `/sis/estado`. | media | **nota + L07**: documentar que `/sis/estado` no tiene consumidor de UI todavía. Cablearlo es decisión de producto, no de este flujo → **deuda con REQ propio** |
| H57 | code-review | El campo reporta `process.env` por request, no si el tick está vivo: si `startSisSweeper` reventó al arrancar, responde `habilitado: true` — justo el caso "roto" que decía separar. | media | **ADR** + la misma deuda de H56 (lo que hay que exponer es una señal de vida, como ya hacen `estadoScrapeJob()`/`estadoSisLock()`) |
| H58 | code-review | Cada `onMouseEnter` sobre un banderín dispara `setLadoTip` y re-renderiza la grilla entera (24×N); el hover de L08 era CSS puro y costaba cero. El corto-circuito por identidad no salta al moverse **entre** banderines, que es el caso normal. | baja | **L11** CA-50 (mismo archivo y misma estructura que H53) |
| H59 | code-review + `cierres/L09.md` (sospecha propia) | `ALTO_TIP`/`ANCHO_TIP` fijan la caja del popover en JS sin ninguna atadura al CSS que la dimensiona: cambiar `max-width` o agregar un renglón desincroniza la decisión en silencio. | baja | **ADR** como deuda declarada (L09 ya la anotó); el arreglo bueno —leerlo de custom properties— no cabe en L11 sin tocar el CSS a fondo |
| H60 | code-review | `MOTIVOS` se exporta y se documenta como el punto donde se hace cumplir el vocabulario cerrado, pero nadie lo importa —ni los tests—, y el `default` de `explicarDescubrimiento` se traga un motivo mal escrito devolviendo `codigo: 2`. | baja | **L11** CA-54 (un assert en `sis_discover.test.js`) |
| H61 | code-review | Guarda muerta en el coarse (`v.primera < conDatos` es siempre cierto tras el arreglo de H30) que se parece a la del fino, donde sí está viva. | baja | **L11** CA-54 (limpieza) |
| H62 | gate (medido en los backfills vivos) | **`concurrencia 6` sostenida sí produce errores**: 22 días de 331 en dev y 23 de 235 en prod. No se pierde nada —quedan `completo=0` y una segunda pasada los re-pide enteros— pero la corrida son **dos** pasadas, no una. | media | **D13** + **L07** (runbook) + ADR |
| H63 | gate (medido en la pasada de CA-45) | El efímero con el sweeper encendido y `SIS_HOST` al stub dejó la fila de hoy de GEC32 en `ok=0 err=8` (antes `ok=3 err=0`). Confirma H38 y H-L10-3 por segunda vez. Se auto-sana en el siguiente tick real. | baja | **ADR** (es la justificación de D7) + §6 |
| H64 | gate | Dos cierres seguidos sumaron mal su propio aporte de tests (L08: 148 vs 160; L10: 634 vs 637). | nota | **convención para `CLAUDE.md`** (cierre): el conteo que vale es el de la suite del gate; un cierre propone su delta, no lo certifica |

## 8. Ola siguiente
- **Lote nuevo:** `L11-cierre-de-fronteras.md` (D12), con los 3 altos y 4 medios.
- **Prompt enmendado:** `L07-docs-cleanup.md` (cabecera, ENMIENDA G2: las dos pasadas del backfill,
  los códigos de salida del CLI, `/sis/estado` sin consumidor, y que lea `cierres/L11.md` si ya
  existe cuando escriba).
- **Reparto propuesto:** **O4 = L11 + L07 en paralelo**, y después el cierre.

| Ola | Lote | Título | Territorio | Depende de |
|---|---|---|---|---|
| O4 | L11 | Cerrar las fronteras que dejaron abiertas L09 y L10 | `src/components/Combustibles/**`, `server/utils/sis/{discover,carbon-scraper}.js`, `server/tests/{sis_discover,sis_scrape_endpoint}.test.js` | L09, L10 |
| O4 | L07 | Docs + cleanup | `BIT-*`, `docs/`, `deploy/DEPLOY.md`, `js-scraper-carbon-g32/**`, `prompts/D-029-*` | L04, L05, L06, L08, L09, L10 |

- **Pendiente del usuario, además del visto bueno:** el **smoke visual** de CA-12/CA-35. Ya se
  aplazó dos veces por la misma razón y vuelve a pasar: L11 mueve otra vez el popover (H53, H54).
  **Después de L11 es la buena** — ahí se acaba el trabajo sobre esa pantalla.
- **Visto bueno del usuario:** dado el **2026-08-27 09:14** (Bogotá) — **O4 abierta** con L11 y L07
  en paralelo. Con eso queda decidida también la **D12** (un solo lote de corrección, no una ola por
  hallazgo).

## 9. Commit del gate
`gate(D-061): O3 cerrada — 2 lotes, 637/637 en verde, 0 violaciones, 3 altos a L11`
