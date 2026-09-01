# D-065 · Ola O2 · Lote L05 — Toma de control del rol (superficie B, backend)

> **Un lote = un chat.** Es el lote con más matiz del flujo. Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O1.)*

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L05 --sesion L05-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O1.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.1, §5.2 (la parte de la pila y el
   alcance del popup), §5.4, §6 (C2, C4, C5), §7, §8, §9**.
3. `server/utils/turno-entidad.js` — **solo lectura, y solo** `resolverTurnoAbierto` :144,
   `estadoBloqueo` :53 y la firma de `cerrarTurno` :257. **No lo edites: es territorio de L06 en
   esta misma ola.**
4. `server/routes/disponibilidad.js` — **el modelo a copiar** para 409 de dominio que exponen su
   slug a propósito (convención 16, la excepción explícita de DISP).
5. `server/routes/_middleware.js` — `loadAppSession` :90, `asyncH` :156, `respTurnoCerrado` :132.
6. `server/tests/helpers.js` — `setupSessions` :215, `call()` :151, `TEST_TAG` :107.
7. `CLAUDE.md`, convenciones **21** (el turno es una entidad: `turno_unidad`, `turno_participante`),
   **33** (rol observador `es_observador`) y **16** (errores).

## 2. Territorio — lo único que puedes crear o editar

- `server/routes/rotacion-control.js` *(nuevo)*
- `server/utils/rotacion/control.js` *(nuevo)*
- `server/tests/rotacion_control.test.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L05.md`

**NO tocas** nada más. En particular: `server/auth/app.js` — **L04 monta tu router**, tú no; ni
`server/routes/rotacion.js` ni `server/utils/rotacion/titulares.js` (L04, esta ola); ni
`server/routes/rotacion-cumplimiento.js`, `server/utils/rotacion/cumplimiento.js` ni
`server/utils/turno-entidad.js` (L06, esta ola); ni `server/db.js`, `server/package.json`,
`ESTADO.md`, `docs/decisions.md`, `CLAUDE.md`, `BIT-*`, ni nada del front.

Tu router **tiene que llamarse exactamente** `server/routes/rotacion-control.js` y exportar el
router por `default`: L04 lo monta por ese nombre. Cambiarlo es un bloqueo, no una decisión tuya.

## 3. Contrato

**Produces** — `_CONTEXTO-BASE.md §6 · C5`, montado como `/api/rotacion/control`:

```jsonc
// GET /api/rotacion/control/estado  →  200
{
  "aplica": true,
  "turno_id": 231,
  "cargo_id": 8,
  "cargo_nombre": "Operador de Planta - Sala de Mando",
  "principal": { "usuario_id": 61, "nombre": "Jefferson Ceballos Sanchez" },
  "soy_principal": false,
  "soy_titular": false,
  "ya_respondi": false,
  "pila": [ { "usuario_id": 61, "nombre": "…", "es_titular": true } ]
}
```

| Método + ruta | Respuesta |
|---|---|
| `POST /api/rotacion/control/tomar` | `{ principal }` · 409 `ya_es_principal` / `turno_cerrado` / `control_ocupado` |
| `POST /api/rotacion/control/abandonar` | `{ principal }` · 409 `no_es_principal` / `titular_no_abandona` / `turno_cerrado` |
| `POST /api/rotacion/control/descartar` | `{ ok: true }` |

Los tres `POST` van **sin cuerpo**: el turno, la planta y el cargo salen de `req.sesion`. Los tres
devuelven el mismo shape que `/estado`.

**Consumes:** C2 (`bitacora.rotacion_control` y su índice) y C4 (`titularesDeTurno`, de L04).

## 4. Trabajo

**Qué se sabe:**

- **La pila se DERIVA del log, nunca se materializa.** Algoritmo, tal cual `_CONTEXTO-BASE.md §5.2`:
  ```
  eventos = rotacion_control WHERE (turno_id, planta_id, cargo_id) AND accion IN ('TOMAR','ABANDONAR')
            ORDER BY rotacion_control_id
  pila = []
  por cada evento:  TOMAR → push(usuario);  ABANDONAR → pop() si el tope es ese usuario
  principal = pila.tope  ||  (pila vacía → el titular del patrón)
  ```
- **El fondo conceptual es el titular y no está en el log.** Por eso no puede abandonar
  (`409 titular_no_abandona`, CA-12): la pila nunca queda vacía.
- **`aplica = false`** cuando: el cargo no tiene patrón activo para esa fecha (`titularesDeTurno` no
  lo devuelve), o el cargo es `es_observador = 1`, `Administrador y Debugging` o
  `Gerente de Producción` (decisión R12). El `Ingeniero Químico` y el
  `Coordinador de carbón y maquinaria` **sí aplican** si tienen patrón: no son un caso especial.
- **Los dos cargos excluidos por nombre son la única excepción a "nada hardcodeado por cargo"**, y
  aun así resuélvelo por dato donde puedas: `es_observador = 1` cubre a USUARIO DE CONSULTA, y
  `puede_configurar_rotacion = 1` cubre exactamente a Administrador y Gerente. **Usa esos dos flags,
  no los nombres.** Déjalo comentado: quien configura la malla no compite por un puesto en ella.

**La sospecha (verifícala, no te la creas):** que dos `TOMAR` concurrentes se resuelvan con un
`UNIQUE` o con un reintento optimista. **No** — el requerimiento pide *"serialización real, no
optimismo"* y CA-11 lo prueba. Un `UNIQUE` no sirve: el log es append-only y **ambos** eventos deben
quedar registrados; lo que hay que serializar es el **cálculo del principal**, no la escritura. Usa
`sp_getapplock` **dentro** de la transacción:

```sql
EXEC sp_getapplock @Resource = 'rotacion-control-<turno_id>-<cargo_id>',
     @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 5000;
```

Un retorno `< 0` es timeout → `409 control_ocupado`. Con `@LockOwner='Transaction'` el lock se suelta
solo en el commit o el rollback: **no lo liberes a mano**.

1. `utils/rotacion/control.js` — la derivación de la pila (función pura sobre el arreglo de eventos,
   así se puede testear sin BD) + los tres verbos transaccionales.
2. `routes/rotacion-control.js` — cuatro handlers en `asyncH`, con `router.use(loadAppSession)`.
3. **`DESCARTAR`** es el "No" del popup: no entra en la pila, solo hace que `ya_respondi` sea `true`
   en ese turno (CA-13). `ya_respondi` es `true` tras **cualquiera** de los tres verbos.
4. **Turno CERRADO** → los tres responden `409 turno_cerrado` (CA-14) y el congelado de L06 no se
   altera. Resuelve el turno con `resolverTurnoAbierto`; si no hay abierto, es turno cerrado.

## 5. Criterios de aceptación y sus verificadores

| CA | Criterio | Verificador |
|---|---|---|
| **CA-10** | Pila LIFO: el principal es el último `TOMAR` sin su `ABANDONAR`; abandonar devuelve el control al anterior | `tests/rotacion_control.test.js › "pila LIFO"` — secuencia de 3 usuarios: A toma, B toma, C toma, C abandona → principal B; B abandona → principal A; A abandona → principal **el titular** |
| **CA-11** | Dos `TOMAR` concurrentes → **exactamente un** principal, y el log conserva los dos eventos en orden | `tests/rotacion_control.test.js › "concurrencia"` — `Promise.all` de dos `POST /tomar` con sesiones distintas; luego `GET /estado` tiene un solo `principal` y `COUNT(*)` del log es 2 |
| **CA-12** | El titular del fondo **no puede abandonar** (`409 titular_no_abandona`); la pila nunca queda vacía | `tests/rotacion_control.test.js › "el titular no abandona"` |
| **CA-13** | El popup se ofrece **una sola vez por turno por usuario**: tras `DESCARTAR`, `ya_respondi = true` | `tests/rotacion_control.test.js › "descartar"` — y sigue en `true` tras un segundo `GET /estado` |
| **CA-14** | Con el turno CERRADO, los tres verbos responden **409 `turno_cerrado`** | `tests/rotacion_control.test.js › "turno cerrado"` |

**Verificador bidireccional** en cada uno. Para CA-11, el caso negativo es contundente: **quita el
`sp_getapplock`** y confirma que el test se pone rojo (dos principales o un evento perdido); si
sigue verde sin el lock, tu test no está probando concurrencia — arréglalo antes de seguir.

## 6. Verificación que corres (solo la tuya)

```bash
cd server
node --check routes/rotacion-control.js && node --check utils/rotacion/control.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-lock --sesion <tu sesión>
SERVER_PORT=3115 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js &
TEST_BASE_URL=http://localhost:3115 node --env-file=../.env --test tests/rotacion_control.test.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-unlock --sesion <tu sesión>
```

**No corras `npm test` completo.** Fixtures en planta `'TST'` con `TEST_TAG`, **jamás** `'GEC3'`
(D-055). Sesiones sintéticas por `es_sintetico = 1`, nunca por username (convención 28). Cero
residuos: deja la query en tu cierre.

**Gotcha del entorno:** tus tests necesitan un `turno_unidad` ABIERTO en `'TST'`. La suite tiene
historial de flakies justo ahí — una cabecera residual de TST en estado `PROGRAMADO`/`CERRADO` hace
fallar cosas por `turno_cerrado`. Crea tu cabecera explícitamente en el `before()` y **bórrala en el
`after()`**, acotada por `planta_id = TEST_PLANTA`; no dependas del sweeper ni de lo que haya quedado.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L05.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L05): toma de control del rol — pila LIFO derivada del log" -- server/routes/rotacion-control.js server/utils/rotacion/control.js server/tests/rotacion_control.test.js prompts/D-065-rotacion-turnos/cierres/L05.md`
   (cuerpo multilínea con el porqué; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L05 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **No toques `server/auth/app.js`**: L04 monta tu router. Si al final de la ola no quedó montado,
  es un hallazgo para el gate, no una licencia para editarlo.
- **La pila no se materializa nunca.** Si te ves creando una columna `es_principal`, para: eso es
  exactamente lo que el log append-only evita, y es el defecto nº 4 del legacy.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
- Tuteo colombiano estándar; sin voseo.
