# D-065 · Ola O5 · Lote L14 — Guarda de borrador sin guardar en la configuración anual

> **Un lote = un chat.** Abierto por el **GATE-O4**, decisión **D3**, con visto bueno del usuario del
> 2026-09-02. Redactado por el integrador el 2026-09-02.
>
> **Vas solo en la O5, y la O5 es la última.** No hay ningún otro chat trabajando sobre este árbol:
> las cuatro olas de construcción están cerradas y los 23 CA de la implementación están en `cumple`.
> Lo único que queda después de ti es `/cerrar-implementacion D-065` (ADR + docs + `git rm` del
> scaffolding). Eso te da una libertad que ningún lote de corrección tuvo antes — ver §3.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Copiado **tal cual** del `GATE-O4.md §6`. Si algo de acá contradice al `_CONTEXTO-BASE.md`,
> **manda el gate**: el contexto base no se edita, se enmienda desde el gate.

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
   módulo eso hace `ROLLBACK` del cierre de las **dos** plantas cada 60 s.
6. **Un pre-vuelo que "se reintenta en el próximo arranque" puede no reintentarse nunca.** Si el
   drift es permanente, la constraint se omite para siempre, en silencio salvo una línea de log, y
   la migración no llega a `migracion_aplicada`. Acá esa respuesta es F37.A5.
7. **F37.A5 es la primera migración de `initDB()` que escribe filas de datos de operación**, no solo
   DDL. Lo que la hace segura: la transformación pasa por el **motor puro** y el `catch` **no
   adivina**.
8. **`secuenciaRef` no cubre el indicador de carga.** Descarta la respuesta obsoleta, pero el
   `.finally` de la promesa vieja no sabe de secuencias y apaga el `cargando` de la petición
   **nueva**. El guard del indicador es del **efecto** (`let vigente = true` + cleanup).
9. **Las degradaciones del backend son contrato, no cortesía.** Si un endpoint responde con una fila
   marcada como dañada o con un conteo de lo que no pudo leer, la pantalla **tiene** que mostrarlo.
10. **Y su corolario: el remedio que muestra una pantalla de diagnóstico tiene que seguir siendo
    verdad DESPUÉS de que alguien lo siga.** El aviso del vector dañado pedía desactivar; desactivar
    apaga el efecto operativo y no libera el CHECK, así que se quedaba pidiendo lo mismo sobre una
    fila ya desactivada y sin botón para hacerlo (CR4-2, arreglado en el GATE-O4).
11. **`migracion_aplicada` gana `F37.A5`.** Las migraciones de D-065 son **cuatro**: `F37.A1`,
    `F37.A3`, `F37.A4`, `F37.A5`.
12. **Un test que baja una constraint de producción se auto-repara en el arranque siguiente, pero
    durante la ventana la BD real se queda sin el invariante.** Ver H6 del `GATE-O4.md`.
13. **Dos rojos de este flujo, en dos gates seguidos, fueron condiciones de INVOCACIÓN y no
    regresiones:** el `--test-concurrency=1` que falta en `CLAUDE.md:22` y el `M365_CLIENT_SECRET=`
    que hay que poner **en los dos procesos** para `CA-6`.

**Lo que más te toca de ese §6: los puntos 2 y 3.** Vas a tocar el `HeaderMenu` y los dos efectos de
sincronización ruta↔estado, que son exactamente lo que describen.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L14 --sesion L14-HHMM
```

Exporta `LOTE_SESION=L14-HHMM` en el entorno de este chat **antes del primer commit**: es lo que hace
que el `pre-commit` verifique tu territorio y el `commit-msg` exija el scope `(D-065 L14)`.

## 1. Lee, en este orden y solo esto

1. **`GATE-O4.md`**: §5 **D3** (que es tu encargo entero, con su escenario y sus tres opciones), §6
   completo, y en §7 la fila **CR4-4**.
2. `cierres/L07.md` (por qué el buffer es interno y qué significa "controlado de verdad") y
   `cierres/L10.md` (§Desviaciones 2 y 3: por qué las entradas están en el `HeaderMenu` y por qué el
   toggle pregunta "¿estoy en bitácoras?").
3. Los tres archivos de tu territorio, **completos**. `src/BitacorasGecelca3.jsx` son ~2.780 líneas;
   te interesan cuatro zonas: el `HeaderMenu`, la declaración de `vista` y sus handlers
   (`handleIrARotacion` / `handleIrACumplimiento` / `onToggleVista`), los dos efectos de
   sincronización ruta↔estado, y `handleIrAUnidad` — que es **el ejemplo a copiar**, porque ya
   implementa la guarda de "Cambios sin guardar" para el caso de las bitácoras.
4. `src/components/Rotacion/CumplimientoRotacion.jsx` (**solo lectura**): es la otra pantalla a la
   que se puede navegar desde el menú, y no tiene borrador — no la toques.

## 2. Territorio — lo único que puedes crear o editar

- `src/components/Rotacion/ConfiguracionRotacion.jsx`
- `src/components/Rotacion/configuracion-rotacion.test.jsx`
- `src/BitacorasGecelca3.jsx`

**Lote puro:** no abre BD, no levanta backend, no necesita `test-lock` ni puerto. Tus tests son
vitest.

**Todo lo demás es de otro.** Si necesitas una edición fuera de esto, **no la hagas**: descríbela
exacta en el §Bloqueos de tu cierre y sigue. La aplica el `/cerrar-implementacion`.

## 3. La regla que SÍ puedes romper (y es la única vez en toda la implementación)

**Puedes cambiar la firma de props de `ConfiguracionRotacion`.** La regla dura de la O4 —"ningún
lote de corrección cambia una firma de props"— existía porque L10 estaba cableando en paralelo
contra ellas. **Esa ola cerró y no queda nadie cableando.** Eres dueño de los dos lados: el
componente y su único consumidor (`BitacorasGecelca3.jsx`), y los dos están en tu territorio.

Lo que **no** puedes hacer:

- Cambiar la firma de `CumplimientoRotacion` ni de `PopupTomaControl`. No los necesitas.
- Cambiar `parsearVectorTexto` ni `calcularCambios` (exports públicos de tu propio archivo, con casos
  que los fijan).
- Cambiar el contrato de ningún endpoint. **Este lote no toca backend.**

## 4. El encargo: CR4-4

### 4.1 Qué está roto

`ConfiguracionRotacion` guarda el reparto en un `buffer` **interno**, detrás de un Guardar explícito
(así lo diseñó L07 y está bien: `calcularCambios(personas, buffer)` es el diff que se envía). Pero:

- `handleIrARotacion` y `handleIrACumplimiento` (las dos entradas nuevas del `HeaderMenu`) y el
  toggle `onToggleVista` **solo mueven `vista`**.
- Cambiar `vista` **desmonta** `ConfiguracionRotacion`. El buffer se va con él, sin una palabra.
- La guarda de "Cambios sin guardar" que ya existe en `handleIrAUnidad` mira
  `registrosDeBitacora._dirty` y `mandDirty`. **El buffer de rotación no es ninguno de los dos**, así
  que no la dispara nadie.

**Escenario concreto, y es *el* caso de uso del módulo:** alguien reparte los grupos G1–G4 de ~81
personas —la carga anual, que se hace una vez al año y la primera vez la hace gente aprendiendo—,
abre el menú para mirar el cumplimiento, y al volver la pantalla está en blanco. No hay deshacer.

Es la misma clase de pérdida para la que D-040 puso su guarda ("Guárdalo o descártalo antes de
finalizar") y D-054 la suya en el cambio de unidad. Este es el tercer caso y el único sin cubrir.

### 4.2 Qué tienes que entregar

**Que no se pueda perder el borrador sin haberlo dicho.** El cómo es tuyo, pero el resultado tiene
que cumplir estas cinco cosas:

1. **La suciedad la reporta el componente, no la adivina el raíz.** El raíz no puede mirar dentro del
   buffer, y `hayCambios` ya está calculado adentro (`cambios.length > 0`). Súbelo — una prop de
   callback es lo natural, y `handleMandError`/`onError` son el precedente de forma.
2. **La guarda cubre TODAS las salidas por navegación**, no solo la que se te ocurra primero: las dos
   entradas del menú, el toggle "Ver bitácoras", y "Cambiar de unidad" (`handleIrAUnidad`, que ya
   tiene el modal — ahí es sumar una condición, no inventar otra).
3. **Ofrece las dos salidas de verdad**: volver a la pantalla (cancelar) o irse perdiendo el
   borrador. **No** inventes un "guardar automáticamente": guardar dispara un `POST` con efectos
   sobre la malla real y eso no se hace sin que alguien lo pida (la carga anual es escritura, no
   borrador).
4. **En tuteo colombiano**, con la voz del resto de la app. Mira los textos de D-040 y del
   `LogoutModal` para el tono.
5. **Cero warnings nuevos de eslint.** El baseline de `BitacorasGecelca3.jsx` son **5** warnings de
   `react-hooks/exhaustive-deps`. Mídelos antes de tocar nada (`npx eslint src/BitacorasGecelca3.jsx`)
   y compara al final. Si tu cambio agrega uno, arréglalo — no lo silencies con un comentario.

### 4.3 Las tres trampas de `BitacorasGecelca3.jsx` (D-035, documentadas y con cicatriz)

Es el archivo más disputado del repo. Las tres cosas que muerden:

- **Los dos efectos de sincronización ruta↔estado usan refs de igualdad** para no entrar en bucle ni
  revertir un clic. **No metas estado nuevo en las deps del efecto "derive"** sin entender por qué
  `activeBitacoraRef`/`dispPlantaRef`/`cumplRangoRef` existen: leen el estado actual **sin** ponerlo
  en deps, justamente para eso.
- **El efecto "derive" le da prioridad a `route.params` sobre el estado de sesión.** Si tu guarda
  cancela una navegación, asegúrate de que el hash **no** quedó ya escrito por el efecto (b): una
  navegación cancelada que dejó la URL cambiada es peor que no tener guarda, porque el F5 se va igual.
- **`transicionAbierta` gobierna dos overlays a la vez** (punto 3 del §6). Si tu modal es un tercer
  `z-50`, decide y **escribe** qué pasa si coincide con la transición de turno. Lo más probable es
  que tu caso no pueda coincidir (la transición no cambia `vista`), pero dilo en el cierre en vez de
  dejarlo al azar.

## 5. Qué NO es de este lote

- Los hallazgos con destino **Cierre** del `GATE-O4.md §7`: **CR4-6** (el popup se desmonta en vez de
  esconderse), **CR4-5** (F37.A5 aborta la fila entera), **H4**, **H5**, **H6**, **H-L07-2**,
  **H-L09-1/3**, **H1/H2** del GATE-O3. Ninguno es tuyo. Si te cruzas con uno, anótalo y sigue.
- El smoke con backend vivo y datos reales: es del cierre.
- Cualquier cosa en `server/`. Este lote no toca backend, no abre pool y no corre la suite de Node.

## 6. Verificación que tienes que dejar por escrito

1. **Rojo previo**: escribe primero el caso que reproduce la pérdida y muéstralo fallando **antes**
   de tocar el componente. Sin eso no sabes que tu caso mide lo que crees.
2. `npx vitest run src/components/Rotacion/configuracion-rotacion.test.jsx` en verde.
3. `npx vitest run` **completo** — tu cambio toca el raíz, y `grilla-asiento-anulado.test.jsx` y
   `grilla-solo-autor-gate.test.jsx` son los únicos dos archivos de front que lo importan
   (`GrillaRegistros` vive inline ahí). Son tu red de regresión. **Baseline: 414/414 en 20
   archivos.**
4. `npm run build` (exit 0) y `npx eslint` sobre los tres archivos, comparando warnings contra el
   baseline de 5.
5. **Verificador bidireccional**: rompe la guarda, muestra el rojo, restaura, muestra el verde.
6. Residuos: **n/a**, y dilo — lote puro de front, no abre BD.

## 7. Cierre (obligatorio, en este orden)

1. Commit por **pathspec** (`git commit -- <rutas>`), nunca `git add -A`.
2. Escribe `cierres/L14.md` con la plantilla `CIERRE-LOTE.md`: **CR4-4** con su verificador, la firma
   de props final de `ConfiguracionRotacion` (el cierre de la implementación la va a citar en el
   ADR), desviaciones, hallazgos nuevos con escenario concreto, bloqueos con la edición exacta, y
   qué necesita el gate.
3. `lotes.mjs --impl D-065 done L14`.

## Reglas (no negociables)

- **Sin firmas de IA en los commits.** El hook las rechaza.
- **No toques `server/package.json`** ni nada de `server/`.
- **Nada de `localStorage`/`sessionStorage`, `setInterval` ni polling** (CA-23 está en `cumple` y lo
  vas a mantener así: un borrador persistido en el navegador **no** es la solución acá — D-040 ya
  decidió que el estado de este tipo vive en el server o no vive).
- **Errores por `codigo`, nunca por texto** (D-032 / convención 16).
- **Tuteo colombiano estándar**, sin voseo.
