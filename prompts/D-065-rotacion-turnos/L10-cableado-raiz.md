# D-065 · Ola O4 · Lote L10 — Cableado en el componente raíz y rutas hash

> **Un lote = un chat, y es el único de su ola.** Va solo porque `src/BitacorasGecelca3.jsx`
> (2.682 líneas) es el archivo más disputado del repo y un error ahí tumba la app para todos.
> Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Copiado **tal cual** del `GATE-O3.md §6` (2026-09-02). Si algo acá contradice al
> `_CONTEXTO-BASE.md` o a tu §4, **manda esto**: el contexto base no se edita, se enmienda desde el
> gate. Los puntos **2, 3 y 6 son las props exactas** de los tres componentes que vas a cablear —el
> gate las consolidó de los cierres de L07, L08 y L09—, y el **8** es una decisión que te toca tomar
> a ti. Lee además el §8 del gate para saber con quién compartes la ola.

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

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L10 --sesion L10-HHMM
```

Falla si L07, L08 o L09 no están `done`. **Detente y reporta** si eso pasa.

## 1. Lee, en este orden y solo esto

1. **`GATE-O3.md` completo**, y los `cierres/L07.md`, `cierres/L08.md` y `cierres/L09.md`
   (las props exactas de cada componente).
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.5, §6 (C8), §8, §9**.
3. Los tres componentes que vas a montar, **solo lectura**:
   `src/components/Rotacion/ConfiguracionRotacion.jsx` · `PopupTomaControl.jsx` ·
   `CumplimientoRotacion.jsx`, y sus hooks.
4. `src/routing/appRoute.js` completo — `parseHash` :54, `buildHash` :97, `SLUG_BY_CODIGO` :17.
5. `src/BitacorasGecelca3.jsx` — **no lo leas entero**. Lee: los imports de modales (:23-25), el
   `ConfirmModal` (:197), el efecto "derive" que sincroniza ruta↔estado, y el bloque de render de
   secciones. Ubícalos con Grep, no leyendo 2.682 líneas.
6. `CLAUDE.md`, convención **17** completa (D-035: navegación por hash, fuente única, y **los dos
   gotchas de la sincronización**).

## 2. Territorio — lo único que puedes crear o editar

- `src/BitacorasGecelca3.jsx`
- `src/routing/appRoute.js`
- `src/routing/appRoute.test.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L10.md`

**NO tocas** nada más. Los tres componentes de la O3 son **solo lectura**: si uno necesita un cambio
para poder cablearse, eso es un **bloqueo** (`lotes.mjs block L10 --motivo "…"`) con la edición
exacta en tu cierre — no lo edites tú. Tampoco: `package.json` (gate), `ESTADO.md`,
`docs/decisions.md`, `CLAUDE.md`, `BIT-*`, ni nada del backend.

## 3. Contrato

**Produces C8** — las rutas hash:

- `'#/rotacion'` → `{ vista: 'rotacion', params: {} }`
- `'#/rotacion/cumplimiento?desde=&hasta=&planta='` →
  `{ vista: 'rotacion-cumplimiento', params: { desde, hasta, planta } }`

`buildHash` es su inverso exacto. Los parámetros se validan con los helpers que ya existen
(`plantaValida` :37, `fechaValida` :40); un parámetro inválido se ignora y cae al default, **no
rompe la ruta**.

**Consumes** los tres componentes de la O3, con las props que sus cierres documentan.

## 4. Trabajo

**Qué se sabe:**

- La sección nueva del sidebar tiene **dos entradas**: "Rotación de turnos" (configuración, visible
  solo si `puede_configurar_rotacion`) y "Cumplimiento" (visible para todos, incluido el observador).
- El popup **no es una sección**: se dispara al montar el dashboard con sesión de app viva, en una
  sola consulta, sin polling (CA-23).
- El permiso llega en la sesión (`/api/me`), igual que `turnoFinalizado` y `esObservador`. **No lo
  vuelvas a pedir por su cuenta.**

**Los dos gotchas de D-035, medidos y documentados, que muerden justo acá:**

1. **La sincronización ruta↔estado usa refs de igualdad** para no entrar en loop ni revertir un
   clic. **No metas la sección nueva en las deps del efecto "derive"** — la convención 17 lo dice
   con esas palabras y ya costó un bug. Copia el patrón que ya usan MAND/DISP/COMB, no inventes uno.
2. **El hash no colisiona con el callback OIDC**: Entra aterriza en `/` con `?auth=…`, que es
   *search*, no *hash*. No hace falta defensa extra, pero tampoco asumas que el hash está vacío al
   montar.

Y uno tercero, de D-054, que aplica a la vista de cumplimiento: **si la sección activa depende de la
planta, hay que reescribir el hash al cambiar de unidad en caliente**, porque el efecto ruta→estado
le da prioridad a `route.params.planta` sobre la planta de sesión. Mira cómo lo resuelve DISP.

1. `appRoute.js` — extiende `parseHash`/`buildHash` con las dos vistas. **No toques** el manejo de
   las vistas existentes: solo agregas ramas.
2. `appRoute.test.js` — el archivo **no existe todavía**: lo creas tú. Cubre las dos rutas nuevas
   ida y vuelta, más una regresión de las rutas viejas (`#/op24h`, `#/disp?planta=GEC3`,
   `#/comb?fecha=…`, `#/b/<codigo>`, `#/historicos`) para demostrar que no rompiste nada.
3. `BitacorasGecelca3.jsx` — el sidebar, el render de las dos secciones (pasándoles las props que
   sus cierres documentan), y el disparo del popup. **Cambios mínimos y localizados**: cada línea que
   toques ahí la va a mirar el gate.
4. **Gating de la sección:** deriva de la sesión; si el usuario no puede configurar, la entrada no se
   muestra **y** la ruta `#/rotacion` cae a la primera permitida (es el comportamiento que ya tiene
   el dashboard para bitácoras sin permiso — reúsalo, no lo reimplementes).
5. Smoke manual al final (§6): es la primera vez que las tres superficies se ven juntas.

## 5. Criterios de aceptación y sus verificadores

| CA | Criterio | Verificador |
|---|---|---|
| **CA-22** | `#/rotacion` y `#/rotacion/cumplimiento` sobreviven a F5 y son deep-linkables; la sección se esconde a quien no tiene permiso y cae a la primera permitida | `src/routing/appRoute.test.js` — ida y vuelta de las dos rutas + parámetros inválidos ignorados + **regresión de las 5 rutas existentes**; y `npm run build` verde |
| **CA-19/20/21 (confirmación end-to-end)** | Las tres superficies funcionan montadas en la app real, no solo en sus tests aislados | **Smoke manual** del §6, con la evidencia en tu cierre |

**Verificador bidireccional:** rompe una ruta existente a propósito (cambia un slug) y confirma que
el test de regresión la atrapa; restaura.

## 6. Verificación que corres (solo la tuya)

```bash
npm test -- src/routing/appRoute.test.js
npm run build
```

**Smoke manual, obligatorio y con evidencia en el cierre.** Levanta el backend de dev
(`cd server && node --watch --env-file=../.env server.js`) y `npm run dev`, y verifica:

1. Login normal → el dashboard carga y **el popup aparece** si tu cargo aplica.
2. "No" en el popup → no vuelve a aparecer al recargar (`ya_respondi` del backend, no del navegador).
3. `#/rotacion` con un cargo **sin** `puede_configurar_rotacion` → cae a la primera sección permitida
   y la entrada del sidebar no está.
4. `#/rotacion` con el Gerente de Producción → **entra** (es el caso que demuestra que el gate no
   mira `solo_lectura`).
5. `#/rotacion/cumplimiento?desde=…&hasta=…&planta=GEC3` pegado en la barra de direcciones → carga
   con ese estado.
6. F5 en cada una de las dos rutas → el estado sobrevive.
7. Las rutas viejas (`#/op24h`, `#/disp`, `#/comb`, `#/historicos`) siguen funcionando.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L10.md` con la plantilla `CIERRE-LOTE.md`, **incluyendo el
   resultado punto por punto del smoke manual**.
2. `git commit -m "feat(D-065 L10): cablear las tres superficies de rotación en el dashboard" -- src/BitacorasGecelca3.jsx src/routing/appRoute.js src/routing/appRoute.test.js prompts/D-065-rotacion-turnos/cierres/L10.md`
   (cuerpo multilínea; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L10 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **No edites los componentes de la O3.** Si uno no encaja, es un bloqueo con la edición exacta.
- **Cambios mínimos en `BitacorasGecelca3.jsx`.** No aproveches para refactorizar nada: es el archivo
  que más chats han tocado y el gate revisa cada línea del diff.
- **Cero polling nuevo.** Una consulta al montar para el popup, y nada más (CA-23).
- **Tuteo colombiano estándar en todo copy visible**; sin voseo.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
