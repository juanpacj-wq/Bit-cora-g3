# D-061 · Ola O4 · Lote L11 — Cerrar las fronteras que dejaron abiertas L09 y L10

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1/O2/O3.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-27. **Lote de corrección** creado por el gate de la O3 (`GATE-O3.md`
> §7, hallazgos H49–H55, H58, H60, H61).

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

- Este prompt nace enmendado: ya incorpora `GATE-O1.md`, `GATE-O2.md` y `GATE-O3.md`. Lee igual el
  §6 y el §7 de los tres.
- **Los tres hallazgos altos que abren este lote son fronteras de arreglos anteriores, no bugs
  nuevos e independientes.** Léelos con esa lente: en cada uno hay un arreglo correcto al que le
  faltó un caso, o que introdujo el problema en el camino de al lado. Antes de tocar nada, lee el
  cierre del lote que hizo ese arreglo (`cierres/L09.md` para H50/H52/H53/H54, `cierres/L10.md`
  para H49/H51/H55/H60/H61): ahí está el razonamiento que hay que **extender**, no revertir.
- **Este lote NO mueve ningún contrato.** C3 conserva el valor de retorno que le dio L10
  (`{ fecha, motivo, sondeos }`), C8 conserva `sweeper: { habilitado }`, C11 solo puede crecer. Si
  te parece que hace falta cambiar uno, es un **bloqueo**, no una decisión tuya.
- **L07 corre en paralelo en esta misma ola** y está documentando lo que tú tocas. Por eso no
  puedes cambiar contratos ni códigos de salida: lo que él escribe tiene que seguir siendo cierto
  cuando cierres.
- **Hay dos backfills vivos** (dev PID 15424 y **prod** PID 23504) escribiendo en `PortalG3_dev` y
  en `PortalG3`. **No los toques, no corras el CLI contra ninguna BD y no mates ningún `node`.**

### Hechos que cambian (copia literal de `GATE-O3.md` §6)

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
  creció, aditivo). **Ninguna pantalla lo consume todavía**, así que el objetivo de H33 no está
  entregado; y el campo reporta la variable de entorno, no si el tick está vivo.
- **`POST /api/combustibles/consumos` ya no se contradice:** la clave `detalle` ausente conserva el
  comentario en **las dos** ramas; presente —aunque venga `null`— manda el body.
- `override.js` tiene **16 exports** (13 funciones + `GAVELA_MS`, `ALTO_TIP`, `ANCHO_TIP`).
- **El diff que la grilla manda al server ya no sale de comparar buffer contra snapshot**, sino del
  conjunto explícito de coordenadas que el operador tocó; cuando vuelve una lectura con una edición
  viva, el buffer se reconcilia celda por celda. `setCelda` es la **única** puerta de escritura del
  buffer y tiene que seguir siéndolo.
- **El lado del popover se decide midiendo** (`ladoPopover`), no por número de periodo ni por índice.
- **La corrida del backfill son DOS pasadas** (la segunda con `--solo-parciales`): con
  `concurrencia 6` sostenida el SIS falla en ~7–10 % de los días.
- **La suite completa son ~38 min** con los dos backfills vivos.
- **`npm test` a secas queda ROJO** desde L10 (H51) — es justamente lo que arreglas en CA-53.
- **CA-45 y `SIS_SWEEPER_ENABLED=0` no caben en el mismo backend**: la pasada con el sweeper
  encendido ensucia la fila de hoy de GEC32 y se auto-sana en el siguiente tick real.
- **Dos cierres de este flujo se equivocaron sumando su propio aporte de tests.** El conteo que
  vale es el de la suite del gate: propón tu delta, no lo certifiques.

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L11 --sesion L11-HHMM
export LOTE_SESION=L11-HHMM
```
Si falla (O4 no abierta, L09/L10 sin `done`, lote reclamado), **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `GATE-O3.md` §4, §6 y §7 (los hallazgos **H49–H55, H58, H60, H61** son tu lista de trabajo).
2. `cierres/L09.md` y `cierres/L10.md` completos.
3. `_CONTEXTO-BASE.md` §6 (filas C1, C3, C4, C5, C6, C7, C8, C11), §9.
4. Tu territorio (abajo). Solo lectura: `src/hooks/useCombustibles.js`,
   `server/routes/combustibles.js`, `server/scripts/backfill-carbon-gec32.js`,
   `server/utils/sis/sis-client.js`, `server/tests/helpers.js`.
5. `CLAUDE.md` del subrepo, convenciones 9, 11, 16, 17, 34.

## 2. Territorio — lo único que puedes crear o editar
- `src/components/Combustibles/ConsumosGrid.jsx`
- `src/components/Combustibles/combustibles.css`
- `src/components/Combustibles/override.js`
- `src/components/Combustibles/override.test.js`
- `src/components/Combustibles/ConsumosGrid.test.jsx`
- `server/utils/sis/discover.js`
- `server/utils/sis/carbon-scraper.js`
- `server/tests/sis_discover.test.js`
- `server/tests/sis_scrape_endpoint.test.js`
- `prompts/D-061-sis-carbon-cierre/cierres/L11.md`

**NO tocas** `server/routes/combustibles.js`, `server/scripts/backfill-carbon-gec32.js`,
`server/utils/sis/{sis-job,sis-lock,sis-sweeper,sis-client}.js`, `server/server.js`, `db.js`,
`helpers.js`, `server/package.json` (es del gate), `BIT-*`, `docs/`, `deploy/` (**L07** vive en
esta ola). Cambio fuera del territorio → `Bloqueos` + `lotes.mjs block`.

## 3. Contrato
> **No produces ni cambias contratos.** C3 y C8 quedan exactamente como los dejó L10; C11 puede
> crecer. Si un arreglo parece exigir cambiar una firma o un vocabulario, es un **bloqueo**.

## 4. Trabajo
Confirma los números de línea con Grep antes de editar.

### Los tres altos

1. **H50 (alta) — `editadasRef` nunca suelta una coordenada, y por ahí vuelve H24.**
   `ConsumosGrid.jsx:256`: `setCelda` hace `editadasRef.current.add(...)` incondicionalmente y nada
   la quita nunca (solo `.clear()` al guardar, descartar o cambiar de coordenada). El comentario de
   `:253` dice que da igual marcar una celda que quedó igual al server "porque `calcularDiff` ya no
   la emite si no difiere" — y eso **solo vale mientras el server no la cambie**.
   - **Escenario verificado por el gate:** el snapshot tiene 3/1 = 20. Durante un GET preservado el
     operador teclea 9 en 5/1 (esto es lo que enciende `hayCambios`) y en 3/1 teclea 2 y luego 20
     otra vez — neto, nada, pero `'3|1'` ya está en el conjunto. La respuesta trae 3/1 = **26**
     (el SIS releyó el periodo). `reconciliarBuffer` **restaura la celda vieja** (20) porque está
     marcada como editada, y `calcularDiff` la emite porque difiere del snapshot nuevo. El POST
     escribe 20 encima de 26, a nombre del operador, y la ownership de D-029 impide que el scraper
     reponga el 26.
   - **Arreglo:** `setCelda` tiene que **desmarcar** la coordenada cuando la celda resultante es
     equivalente a la del snapshot (misma `cantidad` y mismo `detalle`), y marcarla solo cuando no
     lo es. Ojo con el caso "la celda no existe en el snapshot y el operador la vació": ahí
     tampoco hay nada que mandar (`calcularDiff` ya lo contempla con `if (!b && !s) continue`), y
     desmarcarla es lo correcto. **No muevas** `reconciliarBuffer` ni `calcularDiff`: el defecto es
     de quién entra al conjunto, no de qué hace el conjunto.
   - Corrige el comentario de `:253`, que hoy afirma justamente lo que este hallazgo desmiente.

2. **H49 (alta, regresión) — el arreglo de H29 dejó de sondear el día del `hint`.**
   `discover.js:214`: al extender la ventana del ancla hacia atrás, la rejilla de offsets se corre y
   **el día del candidato deja de estar entre los sondeados**. El `hint` es, por definición, el
   único día que el llamador sabe que tiene datos, y ya no se pregunta.
   - **Repro (que tiene que quedar como test):** `discoverEarliestDate(null, { hint: '2026-08-21',
     techo: '2026-08-26', fetchFn })` donde **solo** `2026-08-21` tiene datos → hoy devuelve
     `{ fecha: null, motivo: 'sin-datos', sondeos: 6 }` y la rejilla que sondeó es
     `2026-07-07, -07-17, -07-27, -08-06, -08-16, -08-26`: nunca preguntó por el 21.
   - **Por qué muerde en producción:** el CLI pasa `techo = hoy-2` y
     `hint = MIN(fecha) FROM sis_scrape_log`. En cualquier instalación donde el sweeper lleve pocas
     semanas de log, el `hint` está a menos de 50 días del techo, la ventana del ancla colapsa
     sobre la misma rejilla que la del techo (todos los sondeos ya cacheados) y el `hint` deja de
     aportar redundancia: `--from auto` muere con exit 2 diciendo que ni el hint ni el techo
     respondieron.
   - **Arreglo:** el día del candidato tiene que estar **siempre** entre los sondeos de su ventana,
     se extienda esta hacia donde se extienda. La regla "K sondeos en W días" no se toca; lo que se
     garantiza es que el offset 0 (el candidato) siempre entra. Verifica que CA-42 (el techo en un
     día de parada) **sigue verde** después: los dos casos tienen que convivir.

3. **H51 (alta) — la guarda de CA-44 dejó `npm test` rojo para siempre.**
   `sis_scrape_endpoint.test.js:32` y siguientes. `TEST_BASE_URL` cae a `http://localhost:3002`
   (`tests/helpers.js:7`), que es el backend de dev apuntando al SIS real; el `.env` no trae
   `SIS_HOST` y nada exporta `SIS_STUB_OPCIONAL`. Corrido por el gate:
   `ℹ tests 10 · pass 4 · fail 1 · skipped 5`.
   - **El fin es correcto y no se toca:** un archivo que se saltea entero en silencio deja la suite
     verde y vacía (H31). Lo que está mal calibrado es el medio: **un rojo permanente que no es una
     regresión destruye la señal igual de bien que el skip**, y encima entrena a la gente a ignorar
     el rojo.
   - **Arreglo — el criterio, no la implementación:** la suite canónica (`npm test`, sin variables
     de entorno especiales) tiene que quedar **verde**, y aun así tiene que ser **imposible** que
     los casos HTTP se salteen sin que nadie se entere. Formas que cumplen las dos cosas (elige y
     justifica): (a) que el rojo se dispare solo cuando algo indique que el harness HTTP está en
     juego —por ejemplo, un `TEST_BASE_URL` explícito distinto del default— y que en el resto de
     los casos el archivo reporte los saltados de forma **ruidosa y contable**; (b) que el propio
     archivo levante lo que necesita en vez de exigirlo del entorno, si eso es posible sin tocar
     `server.js`; (c) un tercer camino que se te ocurra. Lo que **no** vale: `SIS_STUB_OPCIONAL=1`
     metido en el script `test` (no es portable entre Windows y Ubuntu, y además es el skip
     silencioso otra vez con otro nombre).
   - Deja en tu cierre, literal, **la línea que el gate tiene que usar** para correr los casos HTTP,
     y el resultado de las dos direcciones (con harness y sin harness).

### Los cuatro medios

4. **H52 (media) — `hayCambios` y `calcularDiff` no están de acuerdo sobre qué es "sucio".**
   `ConsumosGrid.jsx:152`: `hayCambios` compara `JSON.stringify(buffer) !== JSON.stringify(snapshot)`
   —o sea **toda** la celda, metadata incluida— mientras `calcularDiff` mira solo las editadas y
   solo `cantidad`/`detalle`. Escenario: el operador teclea en una celda, la respuesta del GET trae
   esa misma celda con la misma `cantidad` pero `modificado_en`/`valor_sis`/`es_override`
   refrescados; `reconciliarBuffer` conserva la del operador (con metadata vieja), `JSON.stringify`
   difiere → Guardar habilitado, gavela corriendo, `beforeunload` armado; y al hacer clic en
   Guardar el diff sale vacío y responde "Sin cambios para guardar" sin refrescar nada. El operador
   queda atascado hasta que descarta o se le vence la gavela de 10 minutos, que además le anuncia
   que "se descartaron cambios sin guardar" cuando no había ninguno.
   - **Arreglo:** que la única definición de "sucio" sea la misma que usa el POST. Deriva
     `hayCambios` de `calcularDiff(...).length > 0` (o del conjunto de editadas con la misma regla
     de equivalencia de H50 — con ese arreglo puesto, las dos coinciden por construcción).
     Cuida que la gavela y el auto-refresco sigan cumpliendo CA-13/CA-14, que son CA confirmados en
     la O1.

5. **H53 (media) + H58 (baja) — el lado medido del popover es uno solo, y medirlo re-renderiza toda
   la grilla.** `ConsumosGrid.jsx:79` (`ladoTip`), `:362` (`medirLado`), `:571`. `ladoTip` guarda una
   sola entrada con su `clave`, pero `tipAbierto` es independiente: con un popover fijado por clic,
   pasar el puntero por **cualquier** otro banderín reescribe `ladoTip.clave` y el popover fijado
   deja de matchear, vuelve al default abajo-derecha y se recorta — el defecto de H13 otra vez,
   ahora alcanzable con el popover abierto. `setTipAbierto(null)` (Escape, Revertir) tampoco limpia
   `ladoTip`. Y de paso: cada `onMouseEnter` produce un `setLadoTip` con objeto nuevo (el
   corto-circuito por identidad no salta al moverse **entre** banderines), o sea un re-render de las
   ~240 celdas por cada banderín que el puntero roza, donde L08 tenía hover de CSS puro a costo cero.
   - **Arreglo:** que el lado del popover **fijado** no dependa de por dónde ande el puntero. Dos
     caminos razonables: llevar el lado por clave (un mapa, no una entrada) y limpiarlo al cerrar; o
     mantener el hover fuera de React —midiendo y escribiendo la clase en el nodo— y usar estado
     solo para el popover fijado. Elige, justifica, y deja un test que **fije un popover, pase el
     puntero por otro banderín y compruebe que el primero conserva su lado**.

6. **H54 (media) — la medición cuenta la cabecera sticky como espacio libre.**
   `override.js:215`: `libreArriba = banderin.top - contenedor.top` trata como disponible los ~34 px
   de `thead` con `position:sticky; top:0` (y lo mismo la primera columna sticky por la izquierda).
   En un `.comb-scroll` bajo, un banderín con poco espacio abajo voltea hacia arriba y el popover
   —`z-index:5` contra el `2` del `thead`— se pinta **encima de los nombres de columna** en vez de
   evitarlos.
   - **Arreglo:** descontar el alto de la cabecera pegajosa (y el ancho de la columna pegajosa) del
     rectángulo contra el que se mide, de forma que la región "libre" sea la que de verdad lo está.
     `ladoPopover` sigue siendo pura: los márgenes entran por parámetro, no los lee del DOM.

7. **H55 (media) + H60 (baja) + H61 (baja) — limpieza en `discover.js` y su re-export.**
   - `carbon-scraper.js:25` re-exporta `discoverEarliestDate` "para no romper" a quien lo importara
     de ahí, pero desde L10 entrega `{ fecha, motivo, sondeos }` bajo el nombre viejo: un
     `if (!inicio) bail()` recibe un objeto siempre truthy. Verificado: **hoy nadie lo consume por
     esa vía**, así que es una trampa dormida. Ciérrala como prefieras —retirar el re-export, o
     renombrarlo dejando claro que cambió de forma— y di en tu cierre por qué elegiste eso, porque
     **L07 lo tiene que documentar**.
   - `MOTIVOS` se exporta y se documenta como el punto donde se hace cumplir el vocabulario cerrado,
     pero nadie lo importa: un motivo mal escrito cae al `default` de `explicarDescubrimiento` y
     sale con `codigo: 2` y una suite verde. Un assert en `sis_discover.test.js` que recorra
     `MOTIVOS` y exija que cada uno produzca líneas y un código coherente cierra el hueco.
   - `discover.js:278`: la guarda `v.primera < conDatos` del coarse es inalcanzable desde el arreglo
     de H30 (el cursor retrocede 365 días por vuelta y `v.primera ≤ cursor + 50`). La del fino, que
     se ve igual, **sí** está viva. Deja la del coarse en su forma honesta y comenta la diferencia,
     para que nadie lea las dos como el mismo caso.

8. Tuteo colombiano en todo texto nuevo, comentarios incluidos. Sin voseo.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-48 | Una celda tocada y devuelta a su valor original **no** viaja en el POST, ni siquiera cuando el server la cambió durante un GET preservado: gana la lectura fresca del SIS. | `ConsumosGrid.test.jsx › CA-48` con el escenario literal de §4.1, afirmando sobre el **body real del POST** |
| CA-49 | Guardar está habilitado **si y solo si** hay algo que mandar: nunca queda encendido con un diff vacío, y la gavela no arranca por metadata refrescada. | `ConsumosGrid.test.jsx › CA-49` (el escenario de §4.4) + `override.test.js` |
| CA-50 | Un popover fijado por clic conserva su lado aunque el puntero pase por otros banderines; cerrarlo limpia el estado; el hover no re-renderiza la grilla entera. | `ConsumosGrid.test.jsx › CA-50` (fijar, pasar el puntero por otro, comprobar el primero) + un conteo de renders |
| CA-51 | El popover volteado hacia arriba **no** invade la cabecera sticky; `ladoPopover` sigue siendo pura y recibe los márgenes por parámetro. | `override.test.js › ladoPopover` (casos con margen superior) + humo de render |
| CA-52 | El día del candidato se sondea **siempre**, y con un `hint` a menos de 50 días del techo el descubrimiento lo encuentra; **CA-42 sigue verde**. | `tests/sis_discover.test.js › CA-52` (el repro literal de §4.2) + la suite entera del archivo |
| CA-53 | `npm test` sin variables especiales queda **verde**, y aun así es imposible que los casos HTTP se salteen sin que quede constancia contable. | las dos direcciones corridas y pegadas: `npm test` limpio y la corrida con harness |
| CA-54 | El re-export de compat no puede entregar la forma nueva bajo el nombre viejo; `MOTIVOS` está verificado por un test; la guarda muerta del coarse quedó honesta. | `tests/sis_discover.test.js` + `grep` del re-export |

## 6. Verificación que corres (solo la tuya)
```bash
# Front (puro)
npx vitest run src/components/Combustibles      # 3 pasadas seguidas, sin intermitencias
npx eslint src/components/Combustibles
npm run build

# SIS puro
cd server && node --check utils/sis/discover.js utils/sis/carbon-scraper.js
node --test tests/sis_discover.test.js

# CA-53: las dos direcciones
npm test                                         # tiene que quedar VERDE
# y con harness, efímero propio en :3111 (NO :3199, que es del gate):
#   SERVER_PORT=3111 AUTH_TEST_BYPASS=1 SKIP_INITDB=1 SIS_HOST=http://localhost:3154 node --env-file=../.env server.js
#   TEST_BASE_URL=http://localhost:3111 SIS_HOST=http://localhost:3154 node --env-file=../.env --test --test-concurrency=1 tests/sis_scrape_endpoint.test.js
```
Toma el test-lock (`lotes.mjs test-lock --sesion L11-HHMM`) **solo** para la parte con BD y
suéltalo al terminar. Si levantas un efímero con el sweeper encendido, sabé que va a ensuciar la
fila de hoy de GEC32 en dev (se auto-sana): prefiere `SIS_SWEEPER_ENABLED=0` salvo que estés
probando esa cara.

**Verificador bidireccional obligatorio** para CA-48, CA-49, CA-52 y CA-53: rompe cada arreglo, pega
el rojo literal, restaura y vuelve a correr.

**No corras `npm test` completo más de lo necesario:** son ~38 min y hay dos backfills compitiendo
por la BD. Para CA-53 basta con el archivo, salvo la pasada final que confirme el verde.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L11.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`). **Propón tu delta de tests; no lo certifiques** — el conteo que vale es el
   de la suite del gate (H64).
2. `git commit -- src/components/Combustibles/ server/utils/sis/discover.js server/utils/sis/carbon-scraper.js server/tests/sis_discover.test.js server/tests/sis_scrape_endpoint.test.js prompts/D-061-sis-carbon-cierre/cierres/L11.md`
   con el scope `(D-061 L11)` en el título. Sin firmas de IA.
3. `lotes.mjs --impl D-061 done L11 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L11 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A` ni `git add .`; nada de stash, reset,
  checkout, restore, switch, rebase, amend, push, merge.
- Un cambio fuera del territorio es un **bloqueo**, no una excepción. Cambiar un contrato, también.
- No mates procesos `node` ajenos: hay dos backfills corriendo.
- No te asciendas solo: los CA los confirma el gate.
- Tuteo colombiano estándar; sin voseo.
