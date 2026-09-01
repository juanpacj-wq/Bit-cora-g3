# D-065 · Ola O3 · Lote L08 — Popup de toma de control (superficie B, front)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O2.)*

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L08 --sesion L08-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O2.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.2 (la pila y el alcance del popup),
   §5.4 (los endpoints de L05), §5.5, §6 (C5), §9**.
3. `src/components/TurnoTransicionModal.jsx` completo (147 líneas) — **el modelo a copiar**:
   estructura del modal, botones, estados de envío.
4. `src/hooks/useTurno.js` (135 líneas) — el modelo del hook que consulta estado de turno.
5. `src/hooks/useApi.js` — el cliente HTTP.
6. `CLAUDE.md`, convenciones **19** (la finalización de turno se deriva del backend, **sin
   `localStorage`** — mismo criterio acá) y **33** (el observador está exento de los modales).

## 2. Territorio — lo único que puedes crear o editar

- `src/components/Rotacion/PopupTomaControl.jsx` *(nuevo)*
- `src/components/Rotacion/popup-toma-control.test.jsx` *(nuevo)*
- `src/hooks/useTomaControl.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L08.md`

**NO tocas** nada más. En particular: `src/BitacorasGecelca3.jsx` y `src/routing/appRoute.js`
(**L10**, O4 — tu popup todavía no se dispara en la app y eso está bien),
`src/components/Rotacion/ConfiguracionRotacion.jsx` y `src/hooks/useRotacion.js` (**L07**, esta ola),
`src/components/Rotacion/CumplimientoRotacion.jsx` y `src/hooks/useCumplimiento.js` (**L09**, esta
ola), `src/components/TurnoTransicionModal.jsx` (lo lees, no lo editas), `package.json` (gate), y
todo el backend.

## 3. Contrato

**Produces** — un componente **controlado**:

```jsx
<PopupTomaControl
  estado={estadoDelControl}   // el shape de C5, o null mientras carga
  onTomar={async () => {}}
  onDescartar={async () => {}}
  onCerrar={() => {}}
/>
```

**Consumes C5** (`_CONTEXTO-BASE.md §6`), producido por L05 y ya probado en la O2:

```jsonc
// GET /api/rotacion/control/estado  →  200
{ "aplica": true, "turno_id": 231, "cargo_id": 8,
  "cargo_nombre": "Operador de Planta - Sala de Mando",
  "principal": { "usuario_id": 61, "nombre": "Jefferson Ceballos Sanchez" },
  "soy_principal": false, "soy_titular": false, "ya_respondi": false,
  "pila": [ { "usuario_id": 61, "nombre": "…", "es_titular": true } ] }
```

`POST /tomar`, `/abandonar` y `/descartar` van **sin cuerpo** y devuelven el mismo shape.

## 4. Trabajo

**Qué se sabe:**

- **La copia exacta, en tuteo** (decisión R11):
  ```
  Toma de control del rol

  Durante este turno el {cargo_nombre} principal es {principal.nombre}.

  ¿Deseas tomar el control del rol en este turno?

                              [ No ]   [ Sí, tomarlo ]
  ```
  El usuario lo escribió originalmente en usted y **eligió tuteo** al confirmarlo. No lo cambies.
- **El popup se muestra si y solo si** `estado.aplica === true` **y** `estado.ya_respondi === false`
  **y** `estado.soy_titular === false`. El backend ya resuelve `aplica` (excluye observador,
  Administrador, Gerente y los roles sin patrón): **no repliques esa lógica en el front**, solo
  respeta el flag. Replicarla es cómo se desincroniza.
- **"No" llama a `POST /descartar`**, no a un `setState` local.

**La sospecha (verifícala, no te la creas):** que el "no volver a preguntar en este turno" se pueda
guardar en `localStorage`. **No.** La fuente es `ya_respondi` del backend, exactamente por la razón
de D-040: el estado de turno en almacenamiento del navegador se desincroniza del servidor y produce
la clase de bug más cara del repo (un turno que se ve de una forma en una pestaña y de otra en la
BD). Además el usuario puede entrar desde otro equipo. **Cero `localStorage`, cero `sessionStorage`.**

1. `useTomaControl.js` — una consulta a `GET /control/estado`, más `tomar()`, `abandonar()` y
   `descartar()`. **Una sola consulta al montar; sin polling** (CA-23: cero tareas recurrentes).
2. `PopupTomaControl.jsx` — el modal, con la forma de `TurnoTransicionModal.jsx`. Deshabilita los
   botones mientras el `POST` está en vuelo; un 409 se muestra y **cierra el popup** refrescando el
   estado (si alguien más tomó el control mientras tanto, el mensaje tiene que decirlo).
3. **Muestra la pila** cuando tiene más de un elemento: "Antes lo tenía {…}". Es información barata
   y es la mitad del valor del log append-only.
4. Si `soy_principal === true` y **no** eres el titular, el popup no pregunta: ofrece
   **"Abandonar el control"**. Es la otra mitad del ciclo y sin ella la pila no se puede deshacer
   desde la UI.
5. El test se escribe **junto** con el componente.

## 5. Criterios de aceptación y su verificador

| CA | Criterio | Verificador |
|---|---|---|
| **CA-20** | El popup aparece **solo** a los cargos con patrón que no son titulares del turno en curso; **nunca** a `Administrador y Debugging`, `Gerente de Producción` ni `USUARIO DE CONSULTA` | `src/components/Rotacion/popup-toma-control.test.jsx` — casos: `aplica:false` → no renderiza nada; `ya_respondi:true` → no renderiza; `soy_titular:true` → no renderiza; caso feliz → renderiza con el nombre del principal y **la copia en tuteo**; "No" dispara `onDescartar` (no un estado local); `soy_principal:true && !soy_titular` → muestra "Abandonar el control" |

**Verificador bidireccional:** pon `aplica:false` y confirma que el test del caso feliz se pone
rojo; restaura. Y añade una aserción literal sobre el texto `"¿Deseas tomar el control"` — así, si
alguien lo pasa a "¿Desea…" en el futuro, el test lo atrapa.

## 6. Verificación que corres (solo la tuya)

```bash
npm test -- src/components/Rotacion/popup-toma-control.test.jsx
npm run build
```

`npm run build` verde **antes de commitear**: un build roto bloquea a los otros dos chats de la ola.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L08.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L08): popup de toma de control del rol" -- src/components/Rotacion/PopupTomaControl.jsx src/components/Rotacion/popup-toma-control.test.jsx src/hooks/useTomaControl.js prompts/D-065-rotacion-turnos/cierres/L08.md`
   (cuerpo multilínea; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L08 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`: enganchar el test de vitest, y **cuándo
   exactamente debe dispararse el popup**, que es lo que L10 va a cablear en la O4.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **Cero `localStorage`/`sessionStorage`** para el estado del popup. La fuente es el backend.
- **Cero polling.** Una consulta al montar.
- **Tu componente es controlado y no toca el componente raíz.** Si te ves importando
  `BitacorasGecelca3.jsx`, para: es territorio de L10.
- **Tuteo colombiano estándar en todo copy visible**; sin voseo.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
