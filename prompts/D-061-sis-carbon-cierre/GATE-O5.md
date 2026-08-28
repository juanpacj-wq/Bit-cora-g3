# D-061 — GATE-O5 (cierre de la ola O5)

> Expediente **inmutable**: si algo de acá se revierte después, se enmienda encima
> ("REVERTIDA el … por …"), no se borra. Fecha: `2026-08-28 06:55` (Bogotá).
> Ola de un solo lote, la última de código de D-061 (`GATE-O4.md` §5 D16, opción **c**).

## 1. Semáforo al cerrar
```
D-061 · rama feat/sis-carbon-cierre-2026-08

O5 [abierta]
  L12  done        L12-1657     Una sola definición de "esta celda cambió", y que el conjunto de editadas no mienta ← L11

test-lock: libre
```
Lotes sin cierre commiteado: **ninguno**. Ningún lote en `in-progress` ni `blocked`.

**Residuo del lote:** el chat de L12 dejó **dos ediciones de comentario sin commitear** en su propio
territorio (`override.js`, el párrafo del "número no se normaliza"; `ConsumosGrid.test.jsx`, la nota
del 30 → 22 de §Desviaciones 1). Las dos son solo comentarios, ninguna cambia comportamiento y las
dos son correctas: **las commitea este gate**. Se anota porque es la primera vez en el flujo que un
lote deja trabajo sin commitear, y porque un `git status` sucio al abrir el gate es exactamente lo
que el Paso 1 tiene que atrapar.

## 2. Territorios
```
L12 · 3 commit(s): dbc3094 fb2a109 2244670
archivos tocados (5):
  prompts/D-061-sis-carbon-cierre/cierres/L12.md
  src/components/Combustibles/ConsumosGrid.jsx
  src/components/Combustibles/ConsumosGrid.test.jsx
  src/components/Combustibles/override.js
  src/components/Combustibles/override.test.js

[lotes] territorio respetado
```
Violaciones: **ninguna**. Y una prueba lateral que conviene dejar escrita: el hash del CSS compilado
(`index-DF3tohrB.css`) es **idéntico** al de L11 y sigue idéntico después de las ediciones de este
gate — el popover y `combustibles.css` no se tocaron, que es la frontera que D16 puso.

## 3. Verificación de la ola (bajo test-lock `GATE-O5`)

**Tests enganchados a `server/package.json`: ninguno.** Los dos archivos de L12 son front y caen
solos en el `include: ['src/**/*.test.{js,jsx}']` de `vitest.config.js`. El script `test` sigue con
**54 archivos** y el backend no cambió en toda la ola.

**Suite backend completa** — efímero `:3199` con el código de la rama, `AUTH_TEST_BYPASS=1`, sin
`SKIP_INITDB`, `SIS_HOST=http://localhost:3154` y `SIS_SWEEPER_ENABLED=0`; `node --test
--test-concurrency=1` con el mismo `SIS_HOST`; BD `PortalG3_dev`. Corrida en **7 bloques en primer
plano** (los 54 archivos del script, en su orden, sin repetir ni omitir ninguno) porque una sola
corrida excede el techo de los procesos en background de la sesión:

| Bloque | Archivos | `tests` | `fail` | `skipped` | `duration_ms` |
|---|---|---|---|---|---|
| 1 | `guard_no_prod_disp` … `split_sala_permisos` | 52 | 0 | 0 | 208.297,9 |
| 2 | `guard_tipo_evento_coherente` … `fechas_bogota` | 134 | 0 | 0 | 237.827,7 |
| 3 | `turno-entidad` … `conformacion_turno` | 189 | 0 | 0 | 812.526,5 |
| 4 | `consumos_combustible` … `turno_transicion_write_gate` | 82 | 0 | 0 | 752.025,7 |
| 5 | `turno_seguimiento` … `rol_usuario_consulta` | 57 | 0 | 0 | 320.158,8 |
| 6 | `sis_schema` … `sis_concurrencia` | 79 | 0 | 0 | 443.829,1 |
| 7 | `contrato_eventos_dashboard` … `zzz_session_leak_guard` | 48 | 0 | 0 | 115.366,0 |
| **Σ** | **54** | **641** | **0** | **0** | **2.890.031,7 (48,2 min)** |

**Contra el baseline** (`641 · pass 641 · skipped 0`, GATE-O4): **±0, sin un solo rojo nuevo y sin
skips.** Es el delta que L12 propuso ("backend ±0, el delta de la suite completa debería ser
exactamente el delta del front") y es exacto. Segundo cierre seguido del flujo que acierta su propia
suma (contrasta con H64).

**Front:** `npx vitest run src` → `Test Files 15 passed · Tests 304 passed (304)`, 38,7 s.
Baseline O4: 223. **+81**: los **+79** que propuso L12 (`override.test.js` 79 → **149**,
`ConsumosGrid.test.jsx` 46 → **55**), medidos exactos, **+2** de **CA-59**, que agregó este gate
(§5 D17). La carpeta `Combustibles` queda en **206** casos.

**`npm run build`:** ✓ `built in 4,44 s`. `index-DF3tohrB.css` 122,14 kB — **mismo hash que L11 y
que L12**; `index-bzJdO9St.js` 554,25 kB (554,22 en L12: los 30 bytes de la guarda de CA-59).

**Lint:** `npm run lint` → **0 errores**, 15 warnings, los mismos preexistentes de la O4
(`auth.js`, `f03-libro.js`, los tres sweepers de WS, `BitacorasGecelca3.jsx`,
`CambiarEstadoModal.jsx`, `DisponibilidadDashboard.jsx`, `useFlipReorder.js`). Ninguno en
`src/components/Combustibles`: `npx eslint src/components/Combustibles` → exit 0.

**Residuos en BD: ninguno.** `npm run test:residuos` → los 10 checks en `ok`, "cero residuos".
Query directa: 0 celdas y 0 filas de `sis_scrape_log` en `TST`/`TSR`, 0 de `GEC3`/`GEC32` en la
ventana de test `2026-04-15..20`, 0 sesiones sintéticas activas, catálogo `TST` = 10 (residente).

**`/code-review` del diff de la ola** (`91a38b4..HEAD`, nivel high): **12 hallazgos**, todos en los
dos archivos de la grilla. Uno es **alto y lo verificó el gate con un test propio** antes de
enrutarlo (§5 D17). El reparto vuelve a decir lo mismo que dijo la O4 —la grilla concentra todo—,
con una diferencia que importa: **ninguno de los 12 es una reaparición de H24/H50/H65**. El modo de
falla que costó cuatro olas no volvió a salir por otra puerta; lo que sale ahora son fronteras del
arreglo nuevo (lo que el vaciado NO alcanza) y forma (perf, superficie de API, un comentario que
quedó falso). Detalle en §7.

**`/security-review`: no aplica y no se corrió.** El disparador es "auth, permisos, sesiones, SQL
dinámico o el contrato cross-repo". La O5 tocó **dos archivos de front y nada más**: cero código de
servidor, cero superficie HTTP, cero SQL. El `/security-review` de la O2 sigue vigente.

### Verificador bidireccional del arreglo del gate (M5)
Mutación deliberada sobre el arreglo de §5 D17, con restauración verificada:
```
===== M5 (H80/CA-59) el refetch obsoleto vuelve a quemar el seq =====
  × CA-59 > Guardar con un cambio de fecha en vuelo no deja la grilla en blanco
    → expected '' to be '7'
  × CA-59 > Revertir con un cambio de fecha en vuelo tampoco
    → expected '' to be '7'
  Tests  2 failed | 55 skipped (57)

===== restauracion =====
  ConsumosGrid.jsx: identico   (`if (clave !== claveActualRef.current) return;` en :150)
  Tests  304 passed (304)
```

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-55 | L12 | `cumple` | `override.test.js › celdaEquivalente · tabla de casos (L12, CA-55)` — 41 de tabla + 5 con nombre, ✔ en la corrida completa de vitest |
| CA-56 | L12 | `cumple` | `ConsumosGrid.test.jsx › CA-56` (3) + `override.test.js › coordenadasEditadas` (8) ✔ |
| CA-57 | L12 | `cumple` | `ConsumosGrid.test.jsx › CA-57` (3) + `override.test.js › hayEdicion` (11) ✔ |
| CA-58 | L12 | `cumple`, **con la mitad de H68 declarada fuera de alcance de un test** | `override.test.js › repetir una llamada da el mismo resultado (L12, CA-58)` (3) y `› clon` (2) + `ConsumosGrid.test.jsx › CA-58` bajo `<StrictMode>` (3) ✔ |
| **CA-59** | **este gate** | `cumple` | `ConsumosGrid.test.jsx › CA-59 · una lectura que nace obsoleta no puede cancelar a la que sí vale` (2) ✔, con M5 como verificador bidireccional |

**Sobre CA-58 y la mitad de H68 que no se puede probar.** El gate acepta el argumento de L12 y lo
deja escrito porque es un hecho del expediente, no una excusa: `<StrictMode>` repite el actualizador
**desde la misma base**, y sobre esa base `add`/`delete` de un `Set` son idempotentes — que es
exactamente el argumento con el que L11 dio el punto por seguro. Lo que H68 describe es una
repetición **desde otra base**, y eso no se provoca desde un test. Lo que sí cierra el punto es la
propiedad determinista de `override.test.js` (las mismas entradas dan el mismo resultado y ninguna
queda tocada, con M4 poniéndola roja) más la lectura del diff: **el actualizador ya no tiene ningún
efecto secundario que repetir**. Los tres casos bajo `<StrictMode>` son guarda de regresión y el
archivo lo dice antes que este gate.

## 5. Decisiones tomadas en este gate

### D17 — El hallazgo alto del `/code-review` se arregla **acá**, y no en una O6
- **Qué lo provoca:** el `/code-review` reportó que `refetch` incrementa `refetchSeqRef` **antes** de
  mirar si su propia coordenada sigue siendo la actual. El gate **lo reprodujo con un test propio**
  antes de enrutarlo (`expected '' to be '7'`): `onGuardar` y `onRevertir` reanudan con el `refetch`
  del render en que se hizo clic, así que un cambio de fecha mientras el POST viaja hace que esa
  llamada vieja **cancele la lectura de la fecha nueva** que ya está en vuelo. Las dos respuestas se
  descartan —una por `seq`, la otra por `clave`— y no queda ninguna que aplicar.
- **El agravante que sí es de esta ola:** la carrera es **preexistente** (viene del `seq`/`clave` de
  L08/L09), pero L12 le cambió el síntoma. Antes quedaban en pantalla los números de la fecha
  anterior bajo la cabecera nueva; ahora, con los dos estados vaciados al cambiar de coordenada, la
  grilla queda **VACÍA, sin error y sin spinner** — y en una fecha pasada no hay latido que la
  rescate, así que se lee como "ese día no hubo consumo". Para una bitácora, una grilla vacía que
  miente es peor que un número viejo que se nota viejo.
- **Opciones:** a) arreglarlo en este gate (2 líneas + el test de regresión, que ya estaba escrito y
  rojo) · b) abrir una **O6** con un L13 mínimo, que es lo que manda la metodología al pie de la
  letra para un hallazgo en territorio de lote · c) declararlo deuda y mandarlo a **D-062**.
  — **Recomendada: a.**
- **Decidido:** **a — elegida por el usuario el 2026-08-28.** (b) cuesta un chat y un gate de ~48 min
  para dos líneas, y contradice el D16, donde el propio usuario cerró que L12 era el último lote de
  código. (c) deja D-061 cerrando con un camino confirmado en el que el operador ve un día vacío que
  no lo está. El motivo por el que el **GATE-O3 D11** no arregló nada de código —"ninguno se cierra
  bien sin un test que lo fije"— **no aplica acá**: el test ya existía, es de front (sin BD, sin
  lock, 38 s) y el gate lo corrió en las dos direcciones.
- **Qué cambia:**
  ```js
  const clave = claveRefetch(plantaId, fecha);
  if (clave !== claveActualRef.current) return;   // ← nueva: nace obsoleta, ni sale ni quema seq
  const seq = ++refetchSeqRef.current;
  ```
  Más `CA-59` en `ConsumosGrid.test.jsx` (2 casos: por `Guardar` y por `Revertir`) y el soporte de
  stub que necesitan (`postDiferido`/`colaPost`, `revertirDiferido`/`colaRevertir`), aditivo y
  apagado por defecto.
- **Qué NO cambia:** ningún contrato, ninguna firma, ningún otro camino. En la ruta normal
  `clave === claveActualRef.current` siempre —el efecto de cambio de coordenada escribe la clave
  **antes** de llamar a `refetch`, y el latido usa `refetchRef.current`, que es el del último
  render—, así que la guarda solo puede rechazar una llamada nacida de un closure viejo. Los 302
  casos de front que ya había siguen verdes, con los mismos nombres.

### D18 — Los dos comentarios que quedaron mintiendo se corrigen acá; el resto de los hallazgos sale a D-062
- **Qué lo provoca:** dos de los 12 hallazgos no son defectos de comportamiento sino **texto que le
  dice al próximo lector algo que ya no es cierto**. Es la misma clase que el gate O4 arregló en D14
  (una cabecera que ordenaba sincronizar un archivo borrado).
  1. `override.js` — el comentario de `calcularDiff` sigue prometiendo "recorre `editadas`, NO la
     unión de buffer y snapshot", y su `if (celdaEquivalente(b, s)) continue;` **ya no puede
     dispararse** en el único llamador de producción, que le pasa exactamente el conjunto de
     diferencias. El filtro es tautológico y la defensa contra H24 vive hoy **entera** en
     `reconciliarBuffer`. Quien lea el comentario creería que hay dos líneas de defensa y hay una.
  2. `ConsumosGrid.test.jsx` — una línea del caso de CA-56 seguía explicando la afirmación en
     términos de un `30` que el test ya no usa (L12 lo bajó a `22` porque `cantidad_max` es 25).
- **Opciones:** a) corregir los dos comentarios en el gate · b) dejarlos y anotarlos ·
  c) mandarlos a D-062 con el resto. — **Recomendada: a.**
- **Decidido:** a (integrador). Son comentarios, no cambian comportamiento, `npx eslint
  src/components/Combustibles` y los 304 casos siguen en verde después. Dejar escrita una garantía
  que el código no da es precisamente lo que produjo H24 → H50 → H65: una invariante viviendo en un
  comentario.
- **Los otros 10 hallazgos NO se tocan** y salen a **D-062** o al checklist del smoke visual (§7).
  Ninguno pierde datos ni atasca al operador, y varios son justamente lo que el rediseño va a
  reescribir: no tiene sentido pagarlos dos veces.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> **O5 es la última ola: no hay prompts de una ola siguiente que enmendar.** Este bloque se copia
> tal cual al `/cerrar-implementacion D-061`, que es quien tiene que hacerlo verdad en el ADR,
> en `docs/architecture.md` y en `CLAUDE.md`.

1. **`override.js` tiene 20 exports** (17 funciones + `GAVELA_MS`, `ALTO_TIP`, `ANCHO_TIP`), no 17:
   se sumaron `coordenadasEditadas`, `hayEdicion` y `clon`. **C11 crece; ninguna firma cambió.**
2. **`celdaEquivalente` cambió de comportamiento sin cambiar de firma.** La frase correcta para el
   ADR: las formas vacías de cada campo (`ausente`, `null`, `''`) son una sola cosa; `0` es un
   valor —el override 0 de C6—, no una ausencia; un texto que no parsea cuenta como ausencia; un
   número y su string son el mismo valor.
3. **La grilla ya NO mantiene un conjunto de coordenadas editadas.** `editadasRef` no existe. Si
   `docs/architecture.md` o el ADR describen "el conjunto explícito de celdas editadas" como la
   estructura de la pantalla —lo decía el aporte de L09—, **eso dejó de ser cierto**: hoy es una
   **función** de `(buffer, snapshot)`.
4. **`ConsumosGrid.jsx` ya no tiene `deepClone`**; usa `clon` de `override.js`.
5. **`snapshotRef` ya no lo escribe un efecto**, lo escribe `adoptarSnapshot` junto con el estado.
   Un efecto menos en el componente.
6. **(gate) Una lectura que nace obsoleta ni sale ni quema número de secuencia.** `refetch` compara
   su clave contra `claveActualRef` **antes** del `++`. Es lo que impide que el `await refetch()` de
   `onGuardar`/`onRevertir` cancele la lectura de la coordenada nueva (CA-59).
7. **(gate) El vaciado al cambiar de coordenada alcanza a `buffer` y `snapshot`, y NO a `catalogo`,
   `sis` ni `error`.** Consecuencia visible y deliberada: durante el GET nuevo la grilla parpadea
   vacía y el chip del SIS sigue describiendo la fecha anterior por ~1 s; con un GET que falla, las
   columnas en pantalla pueden ser las de la otra planta. Va al **checklist del smoke visual**
   (H81), y decidir si el chip también debe vaciarse es una decisión de producto de un renglón.
8. **(gate) La defensa contra H24 es hoy UNA sola línea, no dos.** El `editadas` que recibe
   `calcularDiff` en producción es tautológico; lo que impide que una escritura del SIS viaje en el
   POST es que `reconciliarBuffer` siembra el buffer desde el snapshot nuevo. **La invariante
   "todo lo que escriba el buffer viene del operador o del snapshot" pasó de ser un cerrojo a ser
   una regla que hay que respetar al escribir código nuevo.** El ADR tiene que decirlo así, y D-062
   tiene que volverla estructural. El comentario de `calcularDiff` ya lo advierte in situ.
9. **La suite backend completa son ~48 min en 7 bloques** en esta máquina, sin backfills
   compitiendo (32 min de la O4 fueron en una sola corrida; el troceo cuesta el arranque del runner
   siete veces). El front completo son 38,7 s.
10. **El delta de tests que propone un cierre volvió a ser exacto**, por segunda ola seguida
    (H64 sigue siendo un hecho de las olas 2 y 3, no de las 4 y 5).

## 7. Hallazgos consolidados (deduplicados)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H80 | code-review + **reproducido por el gate** | `refetch` incrementa `refetchSeqRef` antes de comprobar su propia coordenada. El `await refetch()` de `onGuardar`/`onRevertir`, atado por closure a la fecha vieja, cancela la lectura de la fecha nueva: las dos respuestas se descartan y la grilla queda **vacía, sin error y sin spinner**. En una fecha pasada no hay latido que la rescate y se lee como "no hubo consumo ese día". | **alta** | **arreglado en el gate** (§5 D17) — CA-59 + M5 |
| H81 | code-review (+ H-L12-2 del cierre) | El vaciado de coordenada alcanza a `buffer`/`snapshot` pero no a `catalogo`, `sis` ni `error`: el chip del SIS sigue afirmando "18/24 · 15:42" de la fecha que se acaba de dejar, y con un GET que falla las columnas en pantalla son las de la otra planta. `catalogo` ya quedaba viejo antes de L12; el chip lo conserva **a propósito** (CA-33 lo usa como observable). | media | **checklist del smoke visual** + **D-062** |
| H82 | code-review (+ H-L12-4) | `calcularDiff(buffer, snapshot, coordenadasEditadas(buffer, snapshot))` hace tautológico el parámetro: el `continue` que era la guarda de H24 no puede dispararse en producción, y el comentario que lo promete quedó falso. La defensa entera pasó a `reconciliarBuffer`. | media | **comentario corregido en el gate** (§5 D18); la forma `calcularDiff(buffer, snapshot)` es de **D-062** |
| H83 | code-review | Cambiar de fecha o de planta borra las ediciones sin guardar **de la pantalla**, sin confirmación: `SelectorFecha` llama a `onChange` sin chequeo de sucio y el `beforeunload` no cubre navegación interna. Antes de L12 los números seguían en pantalla hasta que volvía el GET —pero se perdían igual cuando volvía—, así que **no es una pérdida nueva**: es la misma pérdida, ahora instantánea y silenciosa. | media | **D-062** (el dirty-check vive en la cadena `BitacorasGecelca3 → SelectorFecha`, fuera de esta pantalla) |
| H84 | code-review | Durante la ventana de carga que abre el vaciado, la columna virtual "Total Carbón" pinta `0.000` en los 24 periodos — un cero medido, no una ausencia. Las celdas reales sí distinguen (`?? ''`). | baja | **checklist del smoke visual** + **D-062** |
| H85 | code-review | `clon` se promovió a export público conservando `JSON.parse(JSON.stringify(x))` sin guarda: `clon(undefined)` lanza `SyntaxError`. Los tres llamadores de hoy están protegidos, pero la función ya es API con una invitación a reusarla. `structuredClone` está disponible en todos los runtimes soportados. | baja | **D-062** |
| H86 | code-review | `recorrerCoordenadas` arma `claveCelda(p, cid)` en cada coordenada aunque el llamador la descarte: `hayEdicion` —que corre en cada tecla— paga ~240 strings y ~48 `Set` antes de cortar. | baja (perf) | **D-062** |
| H87 | code-review | Cada Guardar recorre la grilla dos veces para la misma respuesta: `coordenadasEditadas` evalúa `celdaEquivalente` en todas las coordenadas y `calcularDiff` la vuelve a evaluar en cada clave que acaba de recibir. | baja (perf) | **D-062**, junto con H82 |
| H88 | code-review | `celdaEquivalente` y `claveCelda` siguen exportados y ya no los importa ningún módulo de producción: solo los usa `override.js` por dentro y el archivo de tests. Superficie exportada sin consumidor es lo que dejó que tres sitios se hicieran su propia idea de "sucio". | baja | **D-062** |
| H89 | code-review | `adoptarSnapshot` escribe `snapshotRef.current` de forma síncrona, así que ahora el ref **adelanta** al render en vez de atrasarse. `descartar` lo lee desde el timer de la gavela, fuera del batch de React. El gate no encontró un camino en el que los dos diverjan de forma observable (los `setState` convergen en el mismo commit), y el propio cierre lo anotó como sospecha no reproducida. | baja | **nota del ADR** |
| H90 | code-review | Un comentario del caso de CA-56 seguía explicando la afirmación con un `30` que el test ya no usa. | nota | **corregido en el gate** (§5 D18) |
| H91 | code-review | El árbol de trabajo traía el `test_lock` de `GATE-O5` sin soltar dentro de `LOTES.json`, y `cierres/L12.md` declara que el lote fue puro y no tomó lock. | nota | **soltado antes del commit** (`test-unlock`); el `LOTES.json` que se commitea no lleva lock |
| H-L12-1 | L12 | H65 solo es alcanzable por **dos** ventanas seguidas de "teclear mientras el GET viaja" (con la grilla sucia no sale ningún GET: `politica.autoRefresco = enVivo && !hayCambios` y el efecto se desmonta entero). Explica por qué el defecto sobrevivió cuatro olas: raro y silencioso. | baja (acota H65) | **material del ADR** |
| H-L12-3 | L12 | `hayCambiosRef` se sigue escribiendo desde un efecto y ahora es su **único** lector (la guarda del latido, CA-13). Puede ir un commit atrasado; desde L12 eso ya no pierde datos —la rama preservada es incondicional y reconcilia— y a lo sumo cuesta un GET de más. Es el último resto de "estado del render leído desde fuera del render" en esta pantalla. | baja | **D-062** |

**Lo que el reparto dice, y que vale para el ADR.** Los 12 hallazgos vuelven a caer todos en la
grilla, como en la O4. La diferencia que importa: **ninguno es una reaparición de H24/H50/H65**. La
familia de defectos que costó cuatro olas —el conjunto de editadas que quedaba viejo— no volvió a
salir por otra puerta, porque el conjunto ya no existe. Lo que aparece ahora es de otras dos clases:
**fronteras del vaciado nuevo** (qué NO alcanza: H81, H83, H84) y **forma** (perf, superficie, un
comentario falso: H82, H85–H88, H90). El único alto es una **carrera preexistente** a la que L12 le
cambió el síntoma, y está arreglada. Eso es lo que hacía falta para poder cerrar.

## 8. Ola siguiente / cierre
- **No hay ola siguiente.** O5 era la última de código (`GATE-O4.md` §5 D16, opción c, elegida por
  el usuario). Lo que sigue es **`/cerrar-implementacion D-061`**.
- **Prompts enmendados: ninguno** (no hay O6). `PLAN-OLAS.md` se actualiza con las enmiendas de
  este gate; `LOTES.json` queda con O5 cerrada.
- **Pendientes operativos vivos que hereda el cierre:**
  1. **Los dos backfills siguen muertos**, con **prod en 246 de 2.996 días**. La recuperación es
     **relanzar el comando completo** (D15), y conviene correr **solo prod**. Los conteos finales
     los certifica `/cerrar-implementacion`.
     > **ENMENDADO el 2026-08-28 07:20 por el propio gate.** El "246" venía del GATE-O4 y ya estaba
     > viejo: hubo una reanudación el 2026-08-27 11:53 (PID 22548) que **también murió**, a las
     > 16:07, en `2019-04-01 p11` (`fetch falló … This operation was aborted`). Medido contra
     > `PortalG3` al cerrar este gate: `sis_scrape_log` de GEC32 tiene **368 filas, las 368
     > `completo=1`, 0 parciales**, de `2018-06-13` a `2026-08-28`. O sea **368 de 2.996 días
     > (12,3 %)** y ninguno a medias — el corte no dejó basura, dejó ausencia, que es justo lo que
     > la D15 dice: se recupera relanzando el comando completo, no con `--solo-parciales`.
  2. **El smoke visual** de CA-12/CA-35, aplazado cuatro veces. **Ahora sí toca**: esta fue la
     última mano sobre la pantalla. Al checklist de `cierres/L03.md`, `L08.md` y `L09.md` hay que
     agregarle **tres puntos nuevos**: el parpadeo vacío al cambiar de fecha con la grilla llena
     (H-L12-2/H81), el chip del SIS desincronizado durante ese ~1 s (H81), y el `0.000` de Total
     Carbón mientras carga (H84).
  3. **`CLAUDE.md`** — el cierre decide sobre las tres convenciones que propuso L12 (el conjunto que
     hay que acordarse de depurar, el marco de referencia al derivar "qué cambió", y buffer y
     snapshot describiendo siempre la misma coordenada) más las dos que dejó pendientes la O4
     (H71/H77) y la de H78.
  4. **`D-062`** hereda 9 hallazgos de este gate (H81–H89, H-L12-3) más los cuatro del popover de la
     O4 (H67, H69, H70, **H75**). El cierre de D-061 deja la cross-referencia.
- **Visto bueno del usuario:** {{pendiente}}.

## 9. Commit del gate
`gate(D-061): O5 cerrada — 1 lote, 641/641 backend y 304/304 front, 0 violaciones, el último alto arreglado acá`
