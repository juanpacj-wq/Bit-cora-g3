# D-065 · Ola O4 · Lote L10 — Cableado en el componente raíz y rutas hash

> **Un lote = un chat, y es el único de su ola.** Va solo porque `src/BitacorasGecelca3.jsx`
> (2.682 líneas) es el archivo más disputado del repo y un error ahí tumba la app para todos.
> Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O3. Presta atención especial a **qué props espera cada uno de los tres
componentes** de L07, L08 y L09: es lo que vas a cablear, y el gate lo consolidó de sus cierres.)*

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
