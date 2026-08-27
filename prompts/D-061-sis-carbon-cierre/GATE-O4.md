# D-061 — GATE-O4 (cierre de la ola O4)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-061 O4`. Es un expediente
> **inmutable**: si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"),
> no se borra. Fecha: `2026-08-27 11:45` (Bogotá). Rama `feat/sis-carbon-cierre-2026-08`.

## 1. Semáforo al cerrar
```
O4 [abierta]
  L07  done        L07-1431     Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm scraper y prompts D-029 ← L04,L05,L06,L08,L09,L10
  L11  done        L11-1431     Cerrar las fronteras que dejaron abiertas L09 y L10 (editadas, ancla del hint, guarda de CA-44, popover) ← L09,L10

test-lock: libre
```
Lotes sin cierre commiteado: **ninguno** (L07 `126f5ba`, L11 `f08f1bd`). **Bloqueos: ninguno.**

## 2. Territorios
```
L07 · 4 commit(s): 126f5ba 1ac2b07 1e49c94 7f924f5
archivos tocados (23): BIT-MODBD-2026-001.md, BIT-RF-2026-001.md, deploy/DEPLOY.md,
  docs/architecture.md, docs/domain-glossary.md, js-scraper-carbon-g32/** (4 · D),
  prompts/D-029-sis-carbon-gec32/** (11 · D), cierres/L07.md
[lotes] territorio respetado

L11 · 3 commit(s): f08f1bd 0c43daf b30885d
archivos tocados (9): cierres/L11.md, server/tests/{sis_discover,sis_scrape_endpoint}.test.js,
  server/utils/sis/{carbon-scraper,discover}.js,
  src/components/Combustibles/{ConsumosGrid.jsx,ConsumosGrid.test.jsx,override.js,override.test.js}
[lotes] territorio respetado
```
Violaciones: **ninguna**.

**Una nota de proceso, declarada por el propio lote:** `1ac2b07` (L07) se hizo con `--no-verify`.
El lote lo anotó él mismo en su cierre y explicó que fue por reflejo, sin necesidad — el mensaje
lleva el scope `(D-061 L07)` y la ruta está en territorio, así que los hooks habrían pasado. El
gate lo verificó: el commit está limpio (sin firmas de IA, scope correcto, una sola ruta). Que el
lote lo declarara en vez de esconderlo es lo que corresponde; **saltar los hooks no**, y queda
como precedente que no se repite (§7 H77).

## 3. Verificación de la ola (bajo test-lock `GATE-O4`)

**Tests enganchados: ninguno.** Los cuatro archivos de test de L11 ya estaban cubiertos (dos en el
script `test` desde la O2, dos en el `include` de vitest). El script sigue con 54 archivos.

**Ediciones del gate en compartidos** (dos, después de la suite, ver **D14**; `node --check` y
`npm run lint` en verde tras ambas):
- `eslint.config.js` — se retiró `'js-scraper-carbon-g32/**'` del `ignores`: la carpeta ya no existe.
- `server/utils/sis/xls-parser.js` — la cabecera decía que ese archivo es la implementación canónica
  y que `js-scraper-carbon-g32/xls.js` "es un MIRROR CommonJS que debe mantenerse en sync". Ese
  mirror se acaba de borrar: la instrucción quedó apuntando a un archivo inexistente.

**Suite backend completa** — efímero `:3199` con el código de la rama, `AUTH_TEST_BYPASS=1`, sin
`SKIP_INITDB`, `SIS_HOST=http://localhost:3154` y `SIS_SWEEPER_ENABLED=0`; `node --test` con el
mismo `SIS_HOST`; BD `PortalG3_dev`:
```
ℹ tests 641 · suites 31 · pass 641 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 1920819.8679
```
**32,0 min.** Los backfills estaban muertos durante esta corrida (ver §5 D15), así que este es el
primer número del flujo sin competencia por la BD desde la O1.

**Contra el baseline** (`637 · pass 637 · skipped 0`, GATE-O3): **+4, todos verdes, sin skips.** Los
4 son de `sis_discover` (16 → 20: dos de CA-52 y dos de CA-54); `sis_scrape_endpoint` queda en 10
porque `CA-44` se recalibró y se renombró a `CA-53`, sin agregar ni quitar casos. **El delta que
propuso L11 (641) coincide exacto con lo que midió el gate** — es el primer cierre del flujo que
acierta su propia suma (contrasta con H64).

**Los 5 casos nuevos o recalibrados, nombrados en el log:**
```
✔ CA-52. con el hint a menos de span del techo, su día igual se sondea y el inicio se halla
✔ CA-52. el candidato no se sondea DOS veces cuando la ventana sí cabe
✔ CA-54. cada motivo de MOTIVOS lo sabe explicar el módulo, y uno de fuera NO se cuela
✔ CA-54. carbon-scraper.js ya no re-exporta el sondeo: el nombre viejo no puede dar la forma nueva
✔ CA-53. los casos HTTP no se saltean en silencio: quedan contados y con el comando exacto
```

**Front:** vitest `Test Files 15 passed · Tests 223 passed (223)` — 36,73 s. Baseline O3: 201.
**+22** (`override.test.js` 68→79, `ConsumosGrid.test.jsx` 35→46), exactamente el delta propuesto.
`npm run build`: ✓ `built in 11.30s`.

**Lint:** `npm run lint` → **0 errores**, 15 warnings, todos preexistentes y en archivos que D-061
no tocó (`auth.js`, `f03-libro.js`, los tres sweepers de WS, `BitacorasGecelca3.jsx`,
`CambiarEstadoModal.jsx`). Ninguno viene del `ignores` retirado.

**Residuos en BD: ninguno.** `npm run test:residuos` → 10 checks en `ok`. Query directa: 0 celdas y
0 logs de GEC3/GEC32 en `2026-04-15..20`, 0 sesiones sintéticas activas, catálogo TST = 10.

**Confirmación tardía de D7 y H63:** la fila de hoy de GEC32 que la pasada de CA-45 del gate O3
dejó en `ok=0 err=8` está hoy en `ok=11 err=0`. Se auto-sanó sola en los ticks siguientes del
backend real, exactamente como decía el expediente anterior.

**`/code-review` del diff de la ola** (`01de2b3..HEAD`, nivel high): **13 hallazgos**, y su reparto
es el dato más importante de este gate: **9 de los 13 caen en `ConsumosGrid.jsx` / `override.js`**.
El SIS aporta uno medio (`discover.js`) y uno en la guarda de tests. Dos los verifiqué yo leyendo
el código antes de enrutarlos (H65 y H72). Detalle y lectura del patrón en §5 D16 y §7.

**`/security-review`: no aplica y no se corrió.** El disparador es "auth, permisos, sesiones, SQL
dinámico o el contrato cross-repo". La O4 **no tiene superficie HTTP**: el territorio de L11 excluye
`routes/combustibles.js` explícitamente, y L07 es documentación y `git rm`. Cero código de servidor
alcanzable por una petición cambió en esta ola. El `/security-review` de la O2 sigue vigente.

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-29 | L07 | `cumple` **con la numeración corregida** | BIT-MODBD **2.5** (§4.9.1 ampliada + changelog) y BIT-RF **2.1** con **RF-076** — no 1.9/RF-071, que estaban tomados por D-057 (ver **D15**). Verificado en los changelogs de los dos documentos |
| CA-30 | L07 | `cumple` | `architecture.md` con la sección de la ingesta SIS, cuatro entradas nuevas en el glosario, y `## 8. Backfill del carbón GEC32 en prod` en `deploy/DEPLOY.md` |
| CA-31 | L07 (`parcial`) | **`cumple`** | El `git rm` está completo (15 rutas en `D`, las dos carpetas retiradas del disco). De las 18 referencias que L07 dejó como hallazgo, las **dos accionables las arregló el gate** (D14) y las 16 restantes son **notas de procedencia** ("Port ESM de …", "heredado de …") o el registro histórico de `BIT-AUDSEG`: deben quedarse, documentan de dónde vino el código |
| CA-48 | L11 | `parcial` → **pendiente de decisión (§5 D16)** | `ConsumosGrid.test.jsx › CA-48` ✔ y `override.test.js › celdaEquivalente` ✔ en la suite. Pero **H65**: la depuración del conjunto de editadas solo ocurre dentro de `setCelda`; un refresco preservado que deja una celda marcada equivalente al snapshot **no la desmarca**, y un refresco posterior la restaura vieja sobre lo que el SIS acaba de escribir. Es **la tercera aparición del mismo modo de falla** (H24 → H50 → H65) |
| CA-49 | L11 | `parcial` → **pendiente (§5 D16)** | el memo de `hayCambios` ✔ en la suite, pero **H66**: memoriza sobre `[buffer, snapshot]` mientras lee el ref mutable, y el efecto de cambio de coordenada limpia el conjunto sin `setBuffer` — si ese GET falla, `hayCambios` queda pegado en `true` con el conjunto vacío. Es el atasco de H52, por otra puerta |
| CA-50 | L11 | `parcial` → **pendiente (§5 D16)** | los casos de fijado/hover ✔, pero **H67** (cerrar con Escape mientras el puntero sigue encima devuelve el popover al lado por defecto) y **H69** (la escritura imperativa de clases sobre un nodo cuyo `className` gobierna React deja clases viejas y no se invalida al hacer scroll) |
| CA-51 | L11 | `cumple` | `override.test.js › ladoPopover` con `margenArriba`/`margenIzquierda` ✔ |
| CA-52 | L11 | `cumple` | `tests/sis_discover.test.js › CA-52` ×2 ✔ en suite completa (el día del `hint` se sondea, y no se sondea dos veces cuando la ventana sí cabe) |
| CA-53 | L11 | `cumple` como criterio, con **H71** anotado | `tests/sis_scrape_endpoint.test.js › CA-53` ✔; `npm test` a secas volvió a ser una corrida honesta. Pero el discriminador elegido (`TEST_BASE_URL` presente) no distingue "levanté un efímero para estos 5 casos" de "lo levanté para los otros 636": el rojo permanente se movió, no desapareció |
| CA-54 | L11 | `cumple` | `tests/sis_discover.test.js › CA-54` ×2 ✔ (`MOTIVOS` verificado; `carbon-scraper.js` ya no re-exporta el sondeo) |

## 5. Decisiones tomadas en este gate

### D14 — Las dos referencias colgantes al scraper retirado se arreglan acá
- **Qué lo provoca:** L07 retiró `js-scraper-carbon-g32/` y dejó 18 referencias como hallazgo,
  porque su prompt le prohíbe editar territorio ajeno. El `/code-review` señaló que dos de esas no
  son referencias históricas sino **defectos**: un `ignores` de ESLint que apunta a una carpeta
  inexistente, y una cabecera que le ordena a quien la lea mantener en sync un archivo borrado.
- **Opciones:** a) arreglarlas acá · b) un lote · c) dejarlas — **Recomendada:** a.
- **Decidido:** a (integrador). Son dos archivos compartidos sin dueño, el cambio es de una línea y
  un comentario, y ninguno afecta comportamiento. Las otras 16 referencias **se quedan**: son
  procedencia ("Port ESM de `js-scraper-carbon-g32/xls.js`") y el registro de auditoría de
  `BIT-AUDSEG`, que documenta lo que se auditó cuando existía.
- **Qué cambia / qué NO cambia:** `npm run lint` sigue en 0 errores y los 15 warnings son los mismos
  de antes. Ningún test cambia de resultado (se hizo después de la suite; ninguno de los dos
  archivos es importado por un test que dependa de su cabecera).

### D15 — La recuperación del backfill NO es `--solo-parciales`: corrige la D13 del gate O3
- **Qué lo provoca:** L07, escribiendo el runbook, encontró que la D13 del GATE-O3 estaba
  incompleta, y tenía razón. El gate lo verificó en las dos bases.
- **El hecho:** cuando la BD se cayó a mitad de corrida (pasó anoche, y **100 días en cada
  corrida**), el CLI logueó `FALLÓ — Failed to connect` y siguió. Esos días **no tienen fila** en
  `sis_scrape_log`. Y `--solo-parciales` está definido como "salta los días **sin** fila". Es decir:
  **el flag que yo mandé usar para la recuperación es exactamente el que se salta los días que hay
  que recuperar.** Verificado: la ventana `2019-04-04..15` de dev y la `2018-12-29..2019-01-09` de
  prod están vacías en `sis_scrape_log`.
- **Opciones:** a) la recuperación es **relanzar el comando original completo**, sin
  `--solo-parciales` (salta lo que ya está 24/24 y rehace todo lo demás, con fila o sin ella) ·
  b) dos pasadas, una con el flag y otra sin él · c) un flag nuevo — **Recomendada:** a.
- **Decidido:** a (integrador). `--solo-parciales` sigue siendo útil, pero **solo** para una corrida
  en la que se sepa que todos los días tienen fila; no es la herramienta de recuperación. El
  criterio de "terminado" no cambia y sigue siendo el bueno: `COUNT(*) … WHERE completo = 0` en
  cero **más** que el rango tenga tantas filas como días.
- **Qué cambia:** **GATE-O3 §5 D13 queda enmendada por esta decisión** (el expediente es inmutable:
  se enmienda encima, no se corrige allá). `deploy/DEPLOY.md` ya lo dice bien porque L07 lo escribió
  con el hallazgo en la mano.

### D16 — Qué hacer con una pantalla que lleva cuatro olas sin converger
- **Qué lo provoca:** el reparto de los 13 hallazgos. **9 caen en `ConsumosGrid.jsx` /
  `override.js`**, y entre ellos está **la tercera aparición del mismo modo de falla** (H24 en la
  O2 → H50 en la O3 → **H65** ahora): el Guardar escribe un valor viejo del operador encima de una
  lectura que el SIS acaba de hacer. Cada ola cerró la puerta por la que entró la vez anterior y el
  review encontró la siguiente: primero el tecleo, después "tocar y deshacer", ahora la
  reconciliación. En paralelo, la **ubicación del popover va por su quinta corrección**
  (H13 → H26 → H53 → H54 → H58) y dos de los hallazgos de hoy son estado que quedó viejo por los
  términos que agregó la corrección anterior.
- **Lo que dice el contraste:** el resto de D-061 **sí convergió**. La ingesta del SIS —scraper con
  concurrencia, mutex, job manual, CLI de backfill, descubrimiento calibrado, ownership, higiene de
  tests, documentación— lleva **dos olas sin un solo hallazgo alto**. El problema no es el flujo ni
  la metodología: es que esa pantalla tiene dos escritores concurrentes y su estado vive en tres
  estructuras acopladas (`buffer`, `snapshot`, `editadasRef`) cuya invariante hoy la sostiene un
  comentario; y que el popover se corrige en la capa de medición cuando la causa es que vive dentro
  de un contenedor `overflow:auto` que lo recorta.
- **Opciones:**
  - a) **O5 con un lote más de corrección** sobre los 9 hallazgos de la grilla. Es lo que se hizo
    tres veces; la evidencia dice que el review va a encontrar la siguiente puerta.
  - b) **Cerrar D-061 y sacar la grilla a un D-062 propio** con dos rediseños de raíz: el popover a
    un portal con `position: fixed` (se van `ladoPopover`, `ladoFijo`, `ladoHoverRef`, los márgenes
    y la medición en hover — la clase entera de bugs desaparece porque desaparece el recorte), y el
    estado de edición con **una sola** fuente de verdad.
  - c) **Camino intermedio:** una **O5 corta**, acotada a lo único que puede perder datos o dejar
    atascado al operador (**H65, H66** y la coerción de **H72**), sin tocar el popover; y el
    rediseño completo —popover en portal y modelo de edición— a **D-062**.
  - **Recomendada: c.**
- **Decidido:** **PENDIENTE DEL USUARIO** (§8). El argumento de (c): D-061 no debería cerrar con un
  camino conocido de pérdida de datos sobre planta real, y H65/H66/H72 son acotados y verificables.
  Pero parchear la ubicación del popover por sexta vez no es trabajo de este ADR y no está
  convergiendo: eso pide un rediseño, y un rediseño pide su propio ciclo de preguntas, contratos y
  criterios. (a) repite un experimento cuyo resultado ya conocemos; (b) deja pérdida de datos en
  producción esperando a un ADR que todavía no se ha planificado.

## 6. Hechos que cambian lo que dicen los documentos anteriores
- **La numeración que reservó la fase 2 era imposible.** `_CONTEXTO-BASE.md §7` reservó **BIT-RF 1.9
  y RF-071** leyendo un changelog desactualizado: los dos ya estaban tomados por **D-057**. Lo real
  es **BIT-RF 2.1** y **RF-076**, y así quedó escrito. **BIT-MODBD 2.5 sí era correcto.** Es el
  mismo error de clase que ya mordió con los códigos de migración `F-NN`: reservar leyendo una sola
  fuente. Lo verifica el propio changelog del documento, que es donde hay que mirar.
- **La recuperación de un backfill interrumpido es relanzar el comando completo**, no
  `--solo-parciales` (D15). Ese flag salta los días sin fila, que son justo los que deja un corte de
  BD. Enmienda la D13 del GATE-O3.
- **`carbon-scraper.js` ya no re-exporta `discoverEarliestDate`.** El sondeo se importa solo de
  `server/utils/sis/discover.js`. C3 no cambia de forma; cambia dónde está el único punto de entrada.
- **`override.js` tiene 17 exports** (14 funciones + `GAVELA_MS`, `ALTO_TIP`, `ANCHO_TIP`): se sumó
  `celdaEquivalente`, que es ahora **la única definición de "esta celda cambió"** — la usan el botón
  Guardar, la gavela, el `beforeunload` y el cuerpo del POST. Un error en ese predicado se propaga a
  los cuatro a la vez (H72).
- **`ladoPopover` acepta `margenArriba` y `margenIzquierda`** (opcionales, default 0): lo que la
  cabecera y la primera columna pegajosas tapan del recuadro.
- **`npm test` a secas volvió a ser una corrida honesta** (no hay rojo permanente). Los 5 casos HTTP
  del scrape manual solo corren con el stub, y quedan **contados y anunciados** por stderr.
- **El scraper standalone y el scaffolding de D-029 ya no existen.** Quedan referencias de
  procedencia en `sis-client.js`, `xls-parser.js`, `xlsx.js` y `BIT-AUDSEG`: son historia, no deuda.
- **La suite completa son ~32 min sin backfills compitiendo** (38 con uno, 58 con dos).

## 7. Hallazgos consolidados (deduplicados)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H65 | code-review (confirmado por el gate) | **Tercera aparición de H24/H50.** La depuración del conjunto de editadas solo ocurre dentro de `setCelda`: un refresco preservado que deja una celda marcada **equivalente** al snapshot no la desmarca, y un refresco posterior con un valor nuevo del SIS la restaura vieja. El Guardar escribe el valor del operador encima de la lectura fresca, y D-029 impide reponerla. | **alta** | **§5 D16** |
| H66 | code-review | `hayCambios` memoriza sobre `[buffer, snapshot]` pero lee el ref mutable `editadasRef.current`; el efecto de cambio de planta/fecha limpia el conjunto **sin** `setBuffer`. Si ese GET falla, el memo nunca se recalcula y `hayCambios` queda pegado en `true` sobre un conjunto vacío: Guardar encendido, "Sin cambios para guardar", todos los Revertir apagados y la gavela anunciando un descarte que no existió. Es H52 por otra puerta, y contradice la invariante que el propio comentario del código declara. | **alta** | **§5 D16** |
| H72 | code-review (confirmado por el gate) | `celdaEquivalente` compara con `Number()` —que funde `null` y `0`— y `detalle` con `??` —que separa `''` de `null`—. Como es la **única** definición de "cambió", una edición real puede descartarse en silencio, o una celda puede quedar marcada para siempre y reescribirse en cada Guardar. Se propaga al botón, la gavela, el `beforeunload` y el POST a la vez. | **alta** | **§5 D16** |
| H67 | code-review | Cerrar el popover con Escape o con un segundo clic **mientras el puntero sigue encima** lo devuelve al lado por defecto (la regla `:hover` del CSS lo mantiene visible) y vuelve a recortarse. El test nuevo afirma que las clases desaparecen, así que **codifica el defecto** en vez de atraparlo (jsdom no tiene hover real). | media | **§5 D16** |
| H69 | code-review | El `onMouseEnter` escribe clases imperativamente sobre un nodo cuyo `className` gobierna React: quedan clases viejas en banderines que ya no se apuntan, y nada invalida la medición al hacer scroll sin salir del banderín. | media | **§5 D16** |
| H68 | code-review | La mutación del conjunto de editadas se hace **dentro** del updater de `setBuffer`, que React puede invocar más de una vez y desde otra base (StrictMode, camino de estado ansioso). La idempotencia de `add`/`delete` no cubre una repetición que tome la otra rama. El mismo updater lee `snapshotRef.current`, escrito por un efecto posterior al commit. | media | **§5 D16** |
| H70 | code-review | `medirLado` vuelve a consultar y medir la cabecera y la primera columna pegajosas en **cada** entrada del puntero: dos `querySelector` y tres `getBoundingClientRect` por banderín rozado, cada rect forzando un layout síncrono. Justo lo que H58 pedía evitar. | baja | **§5 D16** |
| H73 | code-review | `celdaEquivalente` deja `deepClone` del componente duplicando `clon` de `override.js`, ahora sin la justificación que las ataba (el propio diff la retiró). Dos copias sin export. | baja | **§5 D16** |
| H74 | code-review | `hayCambios` construye y **ordena** el diff entero para responder un booleano, en cada tecla. | baja | **§5 D16** |
| H75 | code-review (altitud) | **La ubicación del popover se corrige por quinta vez** (H13 → H26 → H53 → H54 → H58) porque `.comb-tip` vive dentro de `.comb-scroll`, que es `overflow:auto` y lo recorta. Cada arreglo agrega otro término de corrección y otro estado que puede quedar viejo — dos de los hallazgos de hoy son exactamente eso. Un portal con `position: fixed` (o la Popover API) elimina el contenedor que recorta y con él toda la clase de bugs. | **estructural** | **§5 D16** — es el argumento central de la opción (b)/(c) |
| H71 | code-review | El discriminador de CA-53 (`TEST_BASE_URL` presente = "hay harness") no distingue "levanté un efímero para estos 5 casos" de "lo levanté para los otros 636": una corrida canónica contra un efímero sin `SIS_HOST` vuelve a quedar roja. El rojo permanente se movió, no desapareció. | media | **deuda declarada**: el gate corre siempre con `SIS_HOST`, así que no le pega a este flujo. Va al ADR y a `CLAUDE.md` como la segunda mitad de la convención de L11 |
| H76 | code-review | El bucle coarse de `discover.js` soltó la guarda `v.primera < conDatos` apoyándose en una precondición no documentada (`span < 365`) que el parámetro público `ventanaDias` puede violar (con W≈800 el rango se rompe). | media | **ADR** como invariante a documentar; `ventanaDias` no lo expone el CLI, así que no es alcanzable desde la operación |
| H77 | gate | Un commit del flujo (`1ac2b07`, L07) se hizo con `--no-verify`. El lote lo declaró; el commit está limpio. | nota | **convención para `CLAUDE.md`** (cierre): los hooks no se saltan, y si se saltan se declara — lo segundo se cumplió, lo primero no |
| H78 | gate + L07 | La reserva de **BIT-RF 1.9 / RF-071** de la fase 2 era imposible: ya las usaba D-057. L07 lo detectó y usó **2.1 / RF-076**. | media (metodológica) | **§6** + **convención**: una reserva de versión se verifica contra el **changelog del propio documento**, no contra la memoria del planificador |
| H79 | gate (medido) | La caída de BD de anoche costó **100 días en cada corrida**, y esos días **no tienen fila**, así que `--solo-parciales` los salta. | media | **D15** — enmienda la D13 del GATE-O3 |

## 8. Ola siguiente / cierre
- **La decisión de §5 D16 es del usuario**, y de ella depende si hay O5 o si D-061 pasa directo al
  cierre. Las tres opciones están arriba, con la recomendación (c).
- **Pendientes operativos vivos, independientes de esa decisión:**
  1. **Los dos backfills están muertos** desde esta mañana, con **prod en 246 de 2.996 días**.
     Relanzar el comando completo (D15) — y conviene correr **solo prod**: dev ya cumplió su
     función de canario (CA-24, confirmado en GATE-O2) y competir por el SIS solo alarga el que
     importa.
  2. **El smoke visual** de CA-12/CA-35. Se aplazó tres veces por la misma razón; si se toma (c) o
     (b), esa pantalla se vuelve a mover y conviene esperar otra vez. Si se toma "cerrar ya", el
     smoke es lo último antes del cierre.
- **Visto bueno del usuario:** {{pendiente}}.

## 9. Commit del gate
`gate(D-061): O4 cerrada — 2 lotes, 641/641 en verde, 0 violaciones, 9 de 13 hallazgos en la misma pantalla`
