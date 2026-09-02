# D-065 · Ola O3 · Lote L12 — Correcciones de la O2 (endpoints, control, Graph y schema)

> **Un lote = un chat.** Lo abrió el **GATE-O2**, decisión **D5**, para los hallazgos del
> `/code-review` que caen sobre territorios de lotes ya cerrados (L04, L05, L06, L11) y que por eso
> no tienen escritor en la O3 — que es entera de front. Eres el **único lote de backend de la ola**.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

Lee el **§6 completo del `GATE-O2.md`**. De ese bloque, lo que te toca directo:

- El **punto 6** es tu contrato con L07: el `PATCH /api/rotacion/patrones/:id` lo entregas tú y esa
  pantalla lo consume **en esta misma ola**. Respétalo al pie de la letra.
- Los puntos **12, 13 y 14** describen tres de los defectos que vienes a arreglar (la tolerancia de
  Graph que cuenta asignaciones, el 500 por un id fuera de rango, y los dos relojes de
  `GET /titulares`). Están escritos como advertencia para el front porque hoy son verdad; cuando
  cierres, dejan de serlo, y el gate de la O3 lo va a verificar.
- El **punto 11**: `reabrirTurno` ya borra el cumplimiento congelado. **No lo vuelvas a tocar.**

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L12 --sesion L12-HHMM
```

> La hora del id de sesión: `TZ=America/Bogota date` **miente en Git Bash de Windows** (imprime UTC).
> Usa `powershell -NoProfile -Command "Get-Date -Format HHmm"`.

## 1. Lee, en este orden y solo esto

1. **`GATE-O2.md` completo**, con especial cuidado en el **§7** (la tabla `CR2-1…CR2-15`: es tu lista
   de trabajo, con el veredicto que el gate ya le dio a cada uno).
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§4, §5.1, §5.2, §6 (C1…C7), §7, §9**.
3. Los cierres `cierres/L04.md`, `cierres/L05.md` y `cierres/L11.md` — **las secciones "Desviaciones"
   y "Hallazgos"**. Varios de tus arreglos ya están razonados ahí por quien escribió el código.
4. `CLAUDE.md`, convenciones **12** (nunca hardcodear un cargo), **16** (`utils/errores.js`, jamás
   `err.message` crudo), **21** (`cerrarTurno` es el único camino de cierre) y **55** (ningún test
   escribe en planta real).

## 2. Territorio — lo único que puedes crear o editar

- `server/routes/rotacion.js`
- `server/utils/rotacion/titulares.js`
- `server/utils/rotacion/control.js`
- `server/utils/rotacion/cumplimiento.js`
- `server/utils/graph/cliente.js`
- `server/utils/graph/directorio.js`
- `server/db.js`
- `server/tests/rotacion_correcciones_o2.test.js` *(nuevo)*
- `server/tests/rotacion_endpoints.test.js` · `server/tests/rotacion_control.test.js`
- `prompts/D-065-rotacion-turnos/cierres/L12.md`

**NO tocas** nada más. En particular: **todo `src/`** (los tres lotes de front de esta ola),
`server/utils/turno-entidad.js` (lo cerró el GATE-O2 y no se reabre), `server/auth/app.js`,
`server/middleware/auth.js`, `server/utils/sesion-contexto.js`, `server/utils/errores.js`,
`server/tests/helpers.js`, `server/tests/residuos.js`, los guards estáticos, y `server/package.json`
(lo engancha el gate).

**Puerto:** **3118**. **Migración nueva:** **`F37.A4`** (verificada libre en las 8 ramas).

## 3. Contrato

**Produces** — un endpoint nuevo, que L07 consume en esta misma ola:

```jsonc
// PATCH /api/rotacion/patrones/:id     gate: puede_configurar_rotacion
// body: { "activo": false }
// 200 { patron }                       ← el patrón con su nuevo estado, mismo shape que GET /patrones
// 400 <slug> · 403 rotacion_no_autorizado · 404 patron_no_encontrado
```

**No cambias ningún otro contrato.** C1…C7 quedan como están: todo lo demás de este lote son
correcciones **detrás** de los shapes ya pactados (un 400 donde hoy sale 500 no es cambio de
contrato: es el contrato cumpliéndose).

## 4. Trabajo

Los 15 hallazgos están en `GATE-O2.md §7` con su severidad y su veredicto. **Empieza por los
confirmados**; los plausibles verifícalos tú antes de tocar nada (si uno resulta refutado, dilo en el
cierre con la evidencia y **no lo arregles** — un arreglo sin defecto es deuda nueva).

**El más serio es CR2-1** y merece que entiendas la cadena entera antes de escribir: un
`rotacion_patron` con un vector malformado hace **imposible cerrar el turno en las dos plantas**,
porque `congelarCumplimiento` corre sin guard dentro de `cerrarTurno`. Hoy solo lo dispara SQL a
mano, pero la consecuencia es exactamente el sistema "incerrable" que el prompt de L06 mandó no
construir. **El arreglo va en la BD (`F37.A4`, CHECK de formato sobre los dos vectores), no en un
`try/catch` alrededor del congelado**: tragarse el error dejaría turnos sellados sin cumplimiento,
que es justo lo que L06 decidió evitar. Aditiva e idempotente, como `F37.A3`: `ALTER TABLE … ADD
CONSTRAINT` gateado, **jamás** editando el `CREATE TABLE` de `F37.A1`.

**CR2-6 tiene un costo que no puedes ignorar:** el arreglo (`WITH (UPDLOCK)` en la re-verificación de
estado de `control.js`) **rompe el verificador negativo de CA-11** — L05 omitió ese `UPDLOCK` a
propósito para que quitar el `sp_getapplock` pusiera el test en rojo, y con el lock de fila el test
seguiría verde por la razón equivocada. Si lo arreglas, **rehaces el verificador** para que siga
midiendo el applock (por ejemplo, con dos `TOMAR` sobre el mismo turno y cargos distintos, donde el
bloqueo de fila no serializa). Dilo en el cierre con las dos corridas.

**CR2-10 es el que le importa al usuario**: es la carga anual, y hoy un error de digitación no tiene
arreglo por la app. Necesita las dos mitades: el `PATCH` **y** que la UQ
`UQ_rotacion_patron_natural` pase a **filtrada por `activo = 1`** (en `F37.A4`), o desactivar el
patrón no libera esa fecha de inicio y el reemplazo corregido sigue dando 409. Cuidado al recrearla:
un índice único filtrado no es la misma constraint, así que el `IF NOT EXISTS` tiene que mirar el
nombre nuevo y el viejo.

Lo demás es más corto de lo que parece: un tope de `INT32` y un chequeo de forma en
`validarEnteroPositivo` (CR2-2), mover un `map` dentro del `try` (CR2-8), un `COALESCE` (CR2-9),
contar **personas** en vez de asignaciones y devolver `omitidas` en la respuesta (CR2-4), un solo
`ahora` para las dos lecturas del reloj (CR2-15), igualar el filtro de los dos lectores del log
(CR2-7), y anclar las fixturas de `rotacion_endpoints`/`rotacion_control` a una ventana **pasada**
como ya hace la suite de L06 (CR2-5).

## 5. Criterios de aceptación y su verificador

Este lote **no tiene CA propios**: protege los que ya están confirmados (CA-5 a CA-18) y entrega el
endpoint que CA-19 necesitará en la O3. Por cada hallazgo que arregles, el verificador es
**bidireccional y obligatorio**: el caso tiene que estar **rojo contra el código de hoy** (déjalo
escrito en el cierre, con la salida literal) y verde después. Un arreglo sin rojo previo no está
verificado, y el gate lo va a devolver.

## 6. Verificación que corres (solo la tuya)

```bash
# Backend efímero propio, sin credencial de Graph (varios casos lo exigen) y sin DDL ajeno.
# La PRIMERA corrida va SIN SKIP_INITDB: es la que aplica F37.A4.
M365_CLIENT_SECRET= SERVER_PORT=3118 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js

M365_CLIENT_SECRET= TEST_BASE_URL=http://localhost:3118 node --env-file=../.env --test \
  tests/rotacion_correcciones_o2.test.js tests/rotacion_endpoints.test.js tests/rotacion_control.test.js

# Tocas db.js: corre también la regresión del schema y la sincronización.
M365_CLIENT_SECRET= TEST_BASE_URL=http://localhost:3118 node --env-file=../.env --test \
  tests/rotacion_schema.test.js tests/rotacion_sync_entra.test.js tests/rotacion_correcciones.test.js

# Y como tocas el módulo que cerrarTurno invoca:
M365_CLIENT_SECRET= TEST_BASE_URL=http://localhost:3118 node --env-file=../.env --test \
  --test-concurrency=1 tests/rotacion_cumplimiento.test.js tests/turno-entidad.test.js

node --check <cada archivo tocado>
npm run test:residuos    # cero residuos, exit 0, antes de commitear
```

Todo bajo **test-lock** (`lotes.mjs test-lock --sesion L12-HHMM`), y suéltalo al terminar. Sin
`npm run build`: no tocas front.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L12.md` con la plantilla `CIERRE-LOTE.md`, y **una tabla
   `CR2-N → estado`** como la que dejó L11: `arreglado` · `refutado` (con evidencia) · `no aplica`.
2. `git commit -m "fix(D-065 L12): correcciones de la O2 — …" -- <tus rutas>` (cuerpo multilínea,
   **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L12 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`: qué enganchar en `server/package.json`, y
   **si el contrato del `PATCH` cambió en algo respecto al §3** — eso L07 tiene que saberlo antes de
   que cierre la ola.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **Toda constraint nueva va en `F37.A4`, aditiva e idempotente.** Nunca editando un `CREATE TABLE`
  ya gateado por `IF OBJECT_ID`: se salta en toda BD viva y el test pasa en una virgen mientras la
  real se queda sin la constraint.
- **Ningún arreglo sin verificador bidireccional.** Si no lo puedes poner rojo, no lo puedes declarar
  arreglado.
- Un hallazgo que resulte refutado **se documenta y no se toca**.
- Ningún test escribe en planta REAL (D-055): fixturas en `'TST'`, usuarios `test_rot%` u oids
  `00000000-d065-…` — son los acotadores que cuentan el guard estático y `residuos.js`.
- Tuteo colombiano estándar en todo texto visible; sin voseo.
- No te asciendas solo: propones el estado de cada hallazgo; lo confirma el gate.
