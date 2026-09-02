# D-065 · Ola O3 · Lote L08 — Popup de toma de control (superficie B, front)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Copiado **tal cual** del `GATE-O2.md §6` (2026-09-01). Si algo acá contradice al
> `_CONTEXTO-BASE.md` o a tu §4, **manda esto**: el contexto base no se edita, se enmienda desde
> el gate. Lee además el §8 del gate para saber con quién compartes la ola.

1. **Las tres superficies existen y están probadas por HTTP.** Los routers se montan en
   `auth/app.js` en el orden `/api/rotacion/control` → `/api/rotacion/cumplimiento` →
   `/api/rotacion`, y **ese orden es invariante**: si alguien lo cambia, `loadAppSession` correría
   dos veces por request y un 404 de `/control/*` saldría del router equivocado. No lo toques: el
   front no necesita saber más que las rutas.
2. **`puede_configurar_rotacion` YA viaja en la sesión** como booleano, en `/api/me` y en lo que
   devuelven `select-context` y `cambiar-unidad` (los dos SELECT espejo de `middleware/auth.js` y
   `utils/sesion-contexto.js`). L07 lo lee de la sesión, igual que los otros flags de cargo, y
   **nunca** compara nombres de cargo.
3. **`GET /asignaciones` devuelve además `personas`**, la nómina asignable: filas con `azure_oid` y
   `activo = 1`, con `ultimo_cargo_id`/`ultimo_cargo_nombre` (el cargo de su última sesión) y su
   asignación vigente en la fecha. **`ultimo_cargo_id` es `null` para quien nunca ha iniciado
   sesión**, y tras la primera sincronización real eso son ~78 de 81 personas: la pantalla de L07
   **necesita un selector de cargo por persona**, no puede asumir que vienen pre-agrupadas por rol.
4. **`POST /asignaciones`** recibe `{ asignaciones: [{ usuario_id, cargo_id, grupo, vigente_desde?,
   vigente_hasta? }] }` y responde `{ creadas, cerradas, actualizadas, sin_cambio, total }`.
   `vigente_desde` ausente = hoy Bogotá; `vigente_hasta` ausente = vigencia abierta (`9999-12-31`);
   **`grupo: null` = la persona sale de la rotación** (queda supernumeraria). Recargar el mismo lote
   es idempotente (`sin_cambio`). El lote es **atómico** y el 4xx trae el `indice` del elemento malo.
   Tope: 500 asignaciones por solicitud.
5. **`POST /patrones`** acepta los vectores como arreglo o como texto, **ignora** `desfase` y `ancla`
   si el cliente los manda, y responde el patrón con `grupo_t1`/`grupo_t2` derivados (lo que digitó
   el administrador). Los 409 son `patron_duplicado` (misma `fecha_inicio`) y `patron_solapado` (otro
   patrón activo del cargo cubre parte del periodo), y traen `patron_id`.
6. **Hoy NO existe forma de corregir un patrón cargado con error, y eso lo arregla L12 en esta misma
   ola** (decisión D5, hallazgo CR2-10). El router solo tiene `GET` y `POST` de `/patrones`, `activo`
   siempre se escribe en 1, y `UQ_rotacion_patron_natural (cargo_id, fecha_inicio)` **no filtra por
   `activo`**: ni siquiera poner `activo = 0` a mano libera esa fecha de inicio. **Contrato que L12
   entrega y L07 consume:** `PATCH /api/rotacion/patrones/:id` con `{ activo: false }`, gated por
   `puede_configurar_rotacion`, `200 { patron }` · `404 patron_no_encontrado` · `403
   rotacion_no_autorizado`; y la UQ pasa a filtrada por `activo = 1` para que reponer el patrón
   corregido con la misma fecha de inicio sea posible. **L07: escribe la pantalla contra ese
   contrato.** Si al probar todavía no está montado, es coordinación de la ola, no un bloqueo.
7. **`GET /api/rotacion/control/estado` devuelve exactamente las 9 claves de C5, en ese orden**, y
   `principal` es **siempre** `pila[pila.length - 1]` (o `null` si el rol no tiene titulares ni
   tomas). Con el turno cerrado responde **`200 { aplica: false, turno_id: null }`, no 409** — entrar
   en la gavela entre turnos es un caso normal, no un error. Los tres POST van **sin cuerpo** y
   devuelven el mismo shape; `/descartar` agrega además `ok: true`.
8. **Los slugs de 409 del control** son `ya_es_principal`, `no_es_principal`, `titular_no_abandona`,
   `turno_cerrado`, `control_ocupado` y uno que C5 no enumeraba: **`rotacion_no_aplica`** (el cargo
   no rota o está excluido por R12). Todos llegan como `{ error, codigo, mensaje }`: **ramifica por
   `codigo`**, nunca por el texto (D-032).
9. **Cumplimiento (C6):** los 400 son `rango_requerido`, `fecha_invalida`, `rango_invalido`,
   `rango_excesivo` (> 93 días) y `planta_invalida`, más los seis del motor. `resumen` trae
   **siempre** las cuatro claves aunque estén en 0. `congelado: false` marca el turno en curso
   (derivado en vivo); las filas congeladas traen el `cargo_nombre` **de la época**, no el actual, y
   **nunca** incluyen usuarios sintéticos.
10. **Un rol con patrón activo pero sin nadie asignado al grupo de guardia NO produce fila de
    cumplimiento** (decisión D2): 0 de 0 no es un estado, nadie debía venir. Para el popup de L08 ese
    mismo caso llega como `principal: null`. Un rango vacío es un resultado normal, no un error.
11. **Reabrir un turno ahora borra su cumplimiento congelado** (decisión D1), así que el re-cierre lo
    recongela con la verdad nueva. Para L09: una fila que desaparece del reporte porque el turno se
    reabrió es correcto, y vuelve al cerrar.
12. **La sincronización con Entra puede responder `200` con menos gente de la esperada.** Tolera
    fallos **por asignación** y solo lanza `entra_no_disponible` si falla más de la mitad, pero el
    conteo cuenta **asignaciones (14: 13 grupos + 1 usuario directo), no personas** (CR2-4): si se
    caen los grupos grandes, el 200 puede traer 20 personas en vez de 81 y el único rastro es una
    línea en el log. **L07: muestra el `total` y el `por_rol` que devuelve la respuesta, nunca un
    número prometido de antemano**, y deja el conteo por rol a la vista — es lo que le permite al
    administrador notar que falta gente. `503 entra_no_disponible` ya sale saneado por HTTP y debe
    mostrarse como aviso **no bloqueante**: el resto de la pantalla sigue usable.
13. **Un id fuera del rango de `INT` en la query responde 500, no 400** (CR2-2, lo arregla L12):
    `validarEnteroPositivo` no tiene tope de 32 bits, así que `cargo_id=2147483648` pasa la
    validación y revienta en el driver. No construyas la UI apoyándote en un 400 ahí.
14. **`GET /titulares` sin `fecha` ni `turno` resuelve el "turno en curso" por reloj de pared**, no
    por el turno ABIERTO de la unidad (CR2-15), así que durante una extensión (D-046) puede nombrar
    un turno distinto del que dicen `/control/estado` y `/cumplimiento`. **Pásale siempre `fecha` y
    `turno` explícitos** si necesitas que las tres superficies coincidan.
15. **Cero polling, cero `localStorage`/`sessionStorage`, cero tareas recurrentes** (CA-23). El
    "no volver a preguntar" del popup sale de `ya_respondi` del backend, y la ola O2 no agregó ni un
    `setInterval`: no lo estrenes tú.

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
