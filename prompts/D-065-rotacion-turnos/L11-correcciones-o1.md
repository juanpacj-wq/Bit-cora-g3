# D-065 · Ola O2 · Lote L11 — Correcciones de la O1 (schema, cliente de Graph y tests)

> **Un lote = un chat.** Redactado por el **GATE-O1** el 2026-09-01, no en la fase 2: este lote no
> existía en el `PLAN-OLAS.md` original. Lo abrió la decisión **D5** del gate, con el visto bueno del
> usuario, para los **13 hallazgos confirmados** del `/code-review` de la O1 que caen sobre
> territorios de lotes **ya cerrados** (L01, L02, L03) y que por eso no tienen escritor en ninguna ola.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

Este prompt **ya nace enmendado** (lo escribió el gate). Lo que tienes que saber de la O1 está en
`GATE-O1.md`, que es tu lectura número uno. Tres cosas que cambian lo que dirían los documentos
viejos, y que te tocan directo:

1. **`utils/errores.js` ya clasifica `entra_no_disponible` → 503** (lo hizo el gate). No lo toques.
2. **`rotacion_cumplimiento.grupo` no lleva CHECK, y la razón que dio L02 era falsa.** El gate lo
   midió contra la BD: un `CHECK (grupo BETWEEN 1 AND 4)` sobre columna NULLABLE **acepta `NULL`**.
   Ese CHECK es tuyo (CR-9).
3. **`db.js` es tuyo en esta ola, y de nadie más.** L04, L05 y L06 corren en paralelo contigo pero
   ninguno lo toca. Lo que sí hacen es **escribir contra las tablas a las que tú les vas a poner
   constraints** — lee el §4.0, que es la regla más importante de este lote.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L11 --sesion L11-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O1.md` completo.** En especial **§7** (la tabla `CR-1…CR-15`: es tu lista de trabajo
   literal, con el veredicto del gate sobre cada uno) y **§5 D5** (por qué existes).
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§5.1 (el schema), §6 (C2 y C3), §7, §8, §9**.
3. `server/utils/graph/directorio.js` y `server/utils/graph/cliente.js` — **enteros**. Son tuyos.
4. `server/db.js`: el bloque de la migración **`F37.A1`** y el **MERGE de cargos** (`F37.A2`). Y
   `enforceSingletonFlag` — es el otro extremo de CR-1 y está a ~3.000 líneas de distancia.
5. `server/auth/provision.js` — `provisionEntraUser`. Es el espejo del MERGE que vas a arreglar: te
   dice cómo se hace el `HOLDLOCK` acá y qué escribe el login que la sincronización **no** debe escribir.
6. `server/tests/rotacion_sync_entra.test.js` y `server/tests/rotacion_schema.test.js` — los amplías.
7. `server/tests/residuos.js` — le agregas dos checks.
8. `CLAUDE.md`, convenciones **12** (permisos data-driven), **27** (un flag de cargo vive en el
   MERGE), **28** (ningún test escribe en planta real) y **31** (login Entra, `azure_oid`).

## 2. Territorio — lo único que puedes crear o editar

- `server/db.js` — **solo** para agregar la migración `F37.A3` y arreglar el log de CR-15
- `server/utils/graph/cliente.js`
- `server/utils/graph/directorio.js`
- `server/tests/rotacion_correcciones.test.js` *(nuevo)*
- `server/tests/rotacion_schema.test.js` — lo amplías
- `server/tests/rotacion_sync_entra.test.js` — lo amplías
- `server/tests/residuos.js`
- `prompts/D-065-rotacion-turnos/cierres/L11.md`

**NO tocas** nada más. En particular: `server/auth/app.js`, `server/routes/**`,
`server/utils/rotacion/**` (el motor es de L01 y CR-8 **no** es tuyo: es de L04),
`server/middleware/auth.js` ni `server/utils/sesion-contexto.js` (**L04**, esta ola),
`server/utils/turno-entidad.js` (**L06**, esta ola), `server/utils/errores.js` (ya lo hizo el gate),
`server/server.js` (H3 es deuda de D-064, **fuera de alcance**), `server/package.json` (gate),
`ESTADO.md`, `docs/decisions.md`, `CLAUDE.md`, `BIT-*`, ni el front.

## 3. Contrato

**No produces ni cambias ningún contrato.** Los siete del `_CONTEXTO-BASE.md §6` quedan intactos:
mismas firmas, mismos nombres, mismos códigos de error. Si algo de lo que vas a arreglar te obliga a
cambiar una firma, **eso es un bloqueo** (`lotes.mjs block`), no una licencia.

Un matiz sobre C2: tú **agregas** constraints al schema que C2 describe. Eso no lo contradice —
C2 fija nombres y tipos, y ninguna de tus constraints cambia uno.

## 4. Trabajo

### 4.0 La regla que manda sobre todo lo demás

**Toda constraint, índice o columna nueva va como migración `F37.A3`, aditiva e idempotente**
(`IF NOT EXISTS (…) ALTER TABLE … ADD CONSTRAINT …`), con su fila en `bitacora.migracion_aplicada`.

**JAMÁS edites el `CREATE TABLE` de `F37.A1`.** No es una preferencia de estilo: no funcionaría. Ese
bloque está gateado por `IF OBJECT_ID(...) IS NULL`, y las cuatro tablas **ya existen** en toda BD
donde el server arrancó desde el 2026-09-01 — o sea, todas las vivas. Tu cambio se saltaría en
silencio y el test pasaría en una BD virgen mientras la real se queda sin la constraint.

Y una segunda razón: **L04, L05 y L06 están escribiendo contra esas tablas en este mismo momento.**
Una constraint tuya puede chocar con lo que inserta un test suyo. Si pasa, **no es tu culpa ni la
suya y no lo arregles invadiendo su territorio**: sale en el GATE-O2 y se resuelve ahí. Lo tuyo es
que la constraint sea correcta y esté declarada de forma que no rompa datos preexistentes.

### 4.1 CR-1 — el `MERGE` pisa `azure_upn` con `NULL` (ALTA, lo más serio de la ola)

En `directorio.js`, el `WHEN MATCHED` escribe `azure_upn = @upn` y `azure_tid = @tid`
**incondicionalmente**, y los dos bindings pueden ser `NULL` (`upn || null`; `tenantId` es
`process.env.M365_TENANT_ID || null`).

La cadena de fallo, que el gate siguió de punta a punta: una persona que Graph devuelva sin
`userPrincipalName` —soft-deleted, cuenta B2B/shadow, o un `$select` que el tenant recorte— queda con
`azure_upn = NULL`. En el **siguiente arranque del server**, `enforceSingletonFlag` corre
`UPDATE lov_bit.usuario SET es_jefe_planta = 0 WHERE es_jefe_planta = 1 AND (azure_upn IS NULL OR …)`
y **degrada al Jefe de Planta**, que no vuelve hasta que esa persona se loguee otra vez.

Arreglo: `COALESCE(@upn, t.azure_upn)` y `COALESCE(@tid, t.azure_tid)`.

**El test tiene que reproducir la cadena completa, no solo el `COALESCE`.** Un test que afirme "el
UPN no quedó NULL" es débil; el que vale siembra una fila con `azure_upn` y `es_jefe_planta = 1`,
sincroniza un directorio donde esa persona viene **sin UPN**, y comprueba que tras
`enforceSingletonFlag` la persona **sigue** siendo Jefe de Planta. Ojo con D-055: hazlo con oids de
fixture (`00000000-d065-…`), nunca con una persona real.

### 4.2 CR-2 — un solo 404 de Graph tumba la lectura de las 89 personas

`leerDirectorioEntra` hace un `GET /users/{principalId}` o un `transitiveMembers` por asignación,
**sin try/catch**. Entra conserva las `appRoleAssignments` de un usuario borrado hasta 30 días, así
que un 404 en una sola asignación obsoleta aborta el directorio entero. Igual un 429 (Graph
estrangula las lecturas de directorio con ganas, y el cliente ni honra `Retry-After` ni reintenta).

Tolerancia **por asignación**: una que falle se omite y se cuenta; el directorio sale con el resto.
Pero **el fallo global sigue siendo global**: si el token no se obtiene, o si fallan *todas*, eso
sigue siendo `entra_no_disponible`. Decide un umbral y **justifícalo en el cierre**; no lo dejes
implícito. Loguea cuántas se omitieron (conteos, jamás UPNs — convención de L03).

### 4.3 CR-9 — el CHECK que faltaba en `rotacion_cumplimiento.grupo`

`CHECK (grupo IS NULL OR grupo BETWEEN 1 AND 4)`, vía `F37.A3`, con nombre explícito siguiendo la
convención de L02 (`CK_rotacion_cumpl_grupo`). `NULL` sigue siendo legítimo — es el caso "el rol no
tenía patrón" que L06 necesita escribir. Deja en tu cierre la evidencia de que las tres cosas se
cumplen: acepta `NULL`, acepta `1..4`, rechaza `0` y `5`.

### 4.4 CR-6 y CR-7 — integridad del schema: **evalúa antes de escribir**

Estos dos son los únicos del lote donde **no te doy la solución**, porque el gate no está seguro de
que la buena sea declarativa. Tu trabajo empieza por decidirlo, y **la decisión razonada es
entregable aunque el código no salga**.

- **CR-6 (solapamiento).** Nada impide hoy dos `rotacion_asignacion` vigentes a la vez para la misma
  persona con grupos distintos, ni dos `rotacion_patron` con `activo = 1` que cubran la misma fecha.
  "Quién debía estar" pasa a tener dos respuestas. **El problema:** el no-solapamiento de rangos
  **no se expresa con una constraint declarativa** en SQL Server. Las salidas son un trigger, un
  índice único filtrado que sea más estrecho de lo que el dominio permite, o validación en el
  endpoint — y esa última **sería de L04, no tuya**.
- **CR-7 (drift `planta_id` ↔ `turno_id`).** `turno_unidad` ya está unívocamente determinada por
  `(fecha_operativa, planta_id, turno)`, así que `rotacion_control.turno_id` ya implica la planta, y
  nada ata el par. Una fila puede nombrar el turno de GEC3 con `planta_id = 'GEC32'` y la pila LIFO
  devuelve vacío **en silencio** — el mismo drift invisible de D-053(iii), que en este repo ya costó
  una migración de reparación. La vía declarativa existe (UNIQUE compuesta en `turno_unidad
  (turno_id, planta_id)` + FK compuesta desde `rotacion_control`), **pero toca `turno_unidad`**, que
  es la tabla de D-045 por la que pasa todo cierre de turno de la app.

**Cómo quiero que lo resuelvas:** si concluyes que la constraint declarativa es segura, hazla en
`F37.A3`. Si concluyes que el costo o el riesgo no lo justifica —muy en particular tocar
`turno_unidad`—, **no la hagas**: escribe el caso como test que documenta el hueco, y déjalo en tu
cierre como hallazgo con destino propuesto (L04/L05 para validación en endpoint, o el cierre de la
implementación). **Las dos salidas son respuestas correctas; la que no lo es, es hacerlo a medias o
en silencio.**

### 4.5 Los de menor calado (todos confirmados por el gate)

| # | Qué | Dónde |
|---|---|---|
| CR-3 | ~81 `MERGE … WITH (HOLDLOCK)` dentro de UNA transacción acumulan range locks: es el bloqueo de logins que el comentario de al lado dice estar evitando. Batch o commit por tramos — sin perder la protección anti-doble-INSERT que el `HOLDLOCK` da (AUD-30) | `directorio.js` |
| CR-13 | La clave del cache del token es `${tenantId}\|${clientId}`: rotar el `client_secret` no invalida nada y se sigue sirviendo hasta 1 h el token minteado con el secreto retirado. Mete un **hash** del secreto en la clave — el secreto en claro no, ni siquiera en memoria como clave | `cliente.js` |
| CR-10 | `MAX_RESPUESTA_BYTES` es inerte: `Number(null) === 0` cuando falta `content-length`, y Graph responde chunked, así que nunca dispara. **O lo haces de verdad** (contador de bytes sobre el stream) **o lo quitas** y el comentario deja de prometer lo que no cumple. Las dos son válidas; elegir y no decirlo, no | `cliente.js` |
| CR-15 | `[F37.A1] schema de rotación creado` se imprime aunque el DDL no haya creado nada (si alguien borró el flag a mano para forzar el re-chequeo, que el propio comentario presenta como escenario soportado). Un log de arranque que afirma una migración que no ocurrió, justo en el despliegue donde alguien lo está mirando para confirmarla | `db.js` |
| CR-5 | El test pone `puede_configurar_rotacion = 1` en un cargo **real de producción** (`Ingeniero Químico`) y confía en dos reversiones best-effort. El MERGE lo repara en cada arranque, pero la ventana existe. Y `lov_bit.cargo` no está en ningún guard | `rotacion_schema.test.js` |
| CR-14 | Tres statements arman el `WHERE` por **interpolación** en vez de `.input()`, en un `UPDATE` contra el catálogo de producción. Hoy es una constante de módulo y no es explotable; es el patrón que el repo ya eliminó en todos lados | `rotacion_schema.test.js` |
| CR-4 | Las filas que crea el `MERGE` durante el test quedan con `es_sintetico = 0`, mientras la cabecera del archivo dice que van con `1`. **El gate refutó la mitad grave**: `limpiarFixture()` acota por los GUIDs `…-d065-…` (más fuerte que `es_sintetico`) y corre también en el `before()`. Corrige la cabecera para que diga la verdad | `rotacion_sync_entra.test.js` |
| CR-11 | El `after()` restaura una env var no definida como el string literal `'undefined'` (Node convierte todo a string al asignar a `process.env`). `if (v === undefined) delete … else …` | `rotacion_sync_entra.test.js` |

### 4.6 `residuos.js` — dos checks nuevos

CR-4 y CR-5 comparten causa: **`npm run test:residuos` no mira ni `lov_bit.usuario` ni
`lov_bit.cargo`**, así que el gate pudo decir "cero residuos" con toda razón y aun así no habría
visto a un fixture de Entra ni un flag de cargo colgado. Agrega:

- usuarios con `azure_oid` de fixture (`00000000-d065-…`) o `username LIKE 'test_rot%'`;
- cargos con `puede_configurar_rotacion = 1` **fuera** de los dos del contrato.

Acota por el patrón de fixture, **nunca** por `nombre_completo` ni por nombre de cargo, y que
ninguno de los dos pueda alcanzar una fila real (esa es la lección de D-055 y la razón de que el
guard estático exista).

## 5. Criterios de aceptación y sus verificadores

**Este lote no tiene CA propios**: los 23 están congelados desde la fase 1 y ninguno habla de estas
correcciones. Lo que haces es **proteger** CA-3, CA-4, CA-5 y CA-6, ya confirmados en el GATE-O1.

Por eso tu vara es distinta y más exigente: **cada hallazgo que arregles necesita un test que falle
con el código de hoy**. Es el mismo estándar de verificador bidireccional de los tres cierres de la
O1: rompes a propósito, muestras el rojo con su mensaje, restauras, muestras el verde. Un arreglo sin
rojo previo demostrado no cuenta como arreglado — y en un lote que es todo correcciones, eso es
literalmente lo único que lo separa de un refactor a ciegas.

Los `CR-*` que decidas **no** arreglar (CR-6/CR-7 si concluyes que no vale, o la mitad de CR-10 que
descartes) no son deuda oculta: van a tu cierre con el razonamiento y un destino propuesto.

## 6. Verificación que corres (solo la tuya)

```bash
cd server
node --check db.js && node --check utils/graph/cliente.js && node --check utils/graph/directorio.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-lock --sesion <tu sesión>
# SIN SKIP_INITDB: eres el dueño de db.js en esta ola y F37.A3 tiene que correr de verdad
SERVER_PORT=3117 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js &
TEST_BASE_URL=http://localhost:3117 node --env-file=../.env --test tests/rotacion_correcciones.test.js
# Regresión obligatoria: tocaste db.js y los dos módulos de Graph
TEST_BASE_URL=http://localhost:3117 node --env-file=../.env --test tests/rotacion_schema.test.js tests/rotacion_sync_entra.test.js
# Los guards estáticos, porque agregas DML en tests contra tablas vigiladas
node --test tests/guard_no_prod_historico_destruction.test.js tests/guard_no_prod_disp_destruction.test.js
npm run test:residuos    # y tiene que seguir dando cero CON tus dos checks nuevos
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-unlock --sesion <tu sesión>
```

**Arranca el server dos veces seguidas** y deja las dos salidas en el cierre: `F37.A3` es idempotente
y CR-15 es justamente un mensaje de arranque, así que el segundo arranque es la prueba de los dos.

**No corras `npm test` completo** — lo corre el gate. Y **no toques `server/package.json`**: dile al
gate en tu cierre dónde enganchar `tests/rotacion_correcciones.test.js`.

Cero residuos: deja la query en tu cierre, incluidos los dos checks que agregaste.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L11.md` con la plantilla `CIERRE-LOTE.md`. **Tabla
   `CR-1…CR-15` con el estado final de cada uno** (arreglado / no aplica / decidido no hacer + por
   qué): es la forma en que el gate va a cerrar la lista, y sin ella no hay manera de saber qué quedó.
2. `git commit -m "fix(D-065 L11): correcciones de la O1 — MERGE que borraba el UPN, tolerancia de Graph y constraints" -- server/db.js server/utils/graph/cliente.js server/utils/graph/directorio.js server/tests/rotacion_correcciones.test.js server/tests/rotacion_schema.test.js server/tests/rotacion_sync_entra.test.js server/tests/residuos.js prompts/D-065-rotacion-turnos/cierres/L11.md`
   (cuerpo multilínea con el porqué; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L11 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`, di explícito: **tocaste `db.js`**, así que
   el gate debe correr la suite completa mirando cualquier rojo en L04/L05/L06 como posible choque
   con tus constraints nuevas — y **dale el veredicto de CR-6 y CR-7**, que es lo que el GATE-O2
   necesita para cerrar el tema o escalarlo.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **Nunca edites el `CREATE TABLE` de `F37.A1`** (§4.0). Todo va en `F37.A3`.
- **Ningún test escribe ni borra en planta real ni sobre una persona real** (D-055): oids de fixture
  `00000000-d065-…`, y las sesiones sintéticas se desactivan por `es_sintetico = 1`, jamás por
  username (convención 28).
- **No arregles nada fuera de tu lista**, por tentador que sea: `server.js` (H3) y el motor del
  patrón (CR-8) tienen dueño y no eres tú.
- Un arreglo sin su rojo previo demostrado **no está arreglado**.
- No te asciendas solo: propones el estado; lo confirma el gate.
- Tuteo colombiano estándar; sin voseo.
