# D-065 · Ola O2 · Lote L06 — Cumplimiento y congelado al cerrar (superficie C, backend)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O1.)*

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L06 --sesion L06-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O1.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.1, §5.2 (los estados), §5.4, §6 (C1,
   C2, C4, C6, C7), §7, §8, §9**.
3. `server/utils/turno-entidad.js` — **`cerrarTurno` completo (:257-427)**. Es tu territorio, y el
   único punto donde lo vas a tocar. Fíjate en cómo la transacción congela la conformación: tu
   congelado va **justo después**, en la misma transacción.
4. `server/utils/conformacion-snapshot.js` — **el modelo a copiar** para un congelado idempotente
   por `NOT EXISTS`, con el filtro `es_sintetico = 0` (D-044) y `es_observador = 0` (D-059).
5. `server/utils/rotacion/patron.js` (C1) y `server/utils/rotacion/titulares.js` (C4) — solo lectura.
6. `server/tests/helpers.js` y `server/tests/conformacion_turno.test.js` — el modelo de test.
7. `CLAUDE.md`, convenciones **21** (entidad turno; `cerrarTurno` es el único camino de cierre),
   **33** (`es_observador`) y la nota de D-044 sobre `es_sintetico`.

## 2. Territorio — lo único que puedes crear o editar

- `server/routes/rotacion-cumplimiento.js` *(nuevo)*
- `server/utils/rotacion/cumplimiento.js` *(nuevo)*
- `server/utils/turno-entidad.js` — **solo para añadir la llamada al congelado**
- `server/tests/rotacion_cumplimiento.test.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L06.md`

**Eres el único lote que toca `server/utils/turno-entidad.js` en esta ola.** Es un archivo
load-bearing: por ahí pasa **todo** cierre de turno de la app.

**NO tocas** nada más. En particular: `server/auth/app.js` — **L04 monta tu router**, tú no; ni
`server/routes/rotacion.js` / `utils/rotacion/titulares.js` (L04, esta ola); ni
`server/routes/rotacion-control.js` / `utils/rotacion/control.js` (L05, esta ola); ni
`server/db.js`, `server/package.json`, `ESTADO.md`, `docs/decisions.md`, `CLAUDE.md`, `BIT-*`, ni el
front.

Tu router **tiene que llamarse exactamente** `server/routes/rotacion-cumplimiento.js` y exportar el
router por `default`: L04 lo monta por ese nombre.

## 3. Contrato

**Produces C6** (`GET /api/rotacion/cumplimiento?desde=&hasta=&planta_id=`):

```jsonc
{
  "filas": [
    { "fecha_operativa": "2026-08-15", "turno": 1, "planta_id": "GEC3",
      "cargo_id": 8, "cargo_nombre": "Operador de Planta - Sala de Mando",
      "grupo": 3, "estado": "PARCIAL",
      "titulares": [ { "usuario_id": 61, "nombre": "…", "entro": true },
                     { "usuario_id": 77, "nombre": "…", "entro": false } ],
      "relevo": null,
      "congelado": true }
  ],
  "resumen": { "PENDIENTE": 4, "PARCIAL": 9, "COMPLETO": 51, "CUBIERTO_POR_RELEVO": 2 }
}
```

Rango máximo **93 días**; más → `400 rango_excesivo`. Turnos cerrados salen de
`rotacion_cumplimiento` (`congelado: true`); el turno en curso se deriva en vivo (`congelado: false`).

**Produces C7:**

```js
/** Se invoca DENTRO de la transacción de cerrarTurno, después de congelar la conformación.
 *  Idempotente por la PK de rotacion_cumplimiento (NOT EXISTS). `filas = 0` NO es error. */
export async function congelarCumplimiento(tx, { turno_id, fecha_operativa, planta_id, turno })
 : Promise<{ filas: number }>
```

**Consumes:** C1 (`patron.js`), C2 (las tablas), C4 (`titularesDeTurno`, de L04).

## 4. Trabajo

**Qué se sabe:**

- **La regla central, y es lo que hace medible al módulo (CA-15):** el estado se resuelve **por
  `usuario_id`**, no por conteo de cargo. Si entran tres operadores de Planta de Agua y **ninguno**
  es titular, el estado sigue `PENDIENTE`. Los demás se siguen registrando como participantes, pero
  **no satisfacen el slot**. Es lo contrario de lo que haría un scheduler comercial, y es deliberado.
- Escalones (CA-16): ningún titular en `turno_participante` → `PENDIENTE`; alguno pero no todos →
  `PARCIAL`; **todos** → `COMPLETO` (decisión R9); un no-titular con el control → `CUBIERTO_POR_RELEVO`,
  que **gana sobre los otros tres**.
- "Entró" = existe fila en `bitacora.turno_participante` para `(turno_id, usuario_id)`.
- `cerrarTurno` está en `turno-entidad.js:257` y ya es atómico: sella la cabecera, acumula presencia,
  congela la conformación, archiva registros, escribe el CIET y activa el sucesor. Tu llamada va
  **dentro de esa misma transacción**, después de la conformación.
- El titular es **el mismo en GEC3 y GEC32** (decisión R3), pero el **cumplimiento se mide por
  planta**: hay una fila de `rotacion_cumplimiento` por cada `(fecha, planta, turno, cargo)`.

**La sospecha (verifícala, no te la creas):** que `filas = 0` en el congelado sea un error que deba
abortar el cierre. **No lo es**, y confundirlo tiene una consecuencia fea: si ningún rol tiene
patrón activo para esa fecha — que es **exactamente el estado del sistema antes de la primera carga
anual** — un `THROW` ahí volvería **incerrable todo turno de la planta**. `filas = 0` es el caso
normal de un sistema recién desplegado. Lo mismo vale si el rol existe pero nadie tiene grupo
asignado. Regístralo en el log con un conteo y sigue. (Precedente literal en D-063: `copias = 0`
nunca es error.)

1. `utils/rotacion/cumplimiento.js` — `evaluarEstado(...)` como **función pura** sobre
   `{titulares, participantes, principal}` (así los cuatro escalones se prueban sin BD), más
   `congelarCumplimiento(tx, ...)` y la query del rango.
2. `routes/rotacion-cumplimiento.js` — un handler en `asyncH`, con `router.use(loadAppSession)`.
   Sin gate por flag: la vista es de **consulta y la ve cualquier rol** (incluido el observador).
3. `turno-entidad.js` — **una sola llamada añadida**, dentro de la transacción, envuelta en su
   `try/catch` propio solo si decides que un fallo del congelado no debe tumbar el cierre.
   **Recomendación: NO lo envuelvas.** Si el congelado falla, que caiga la transacción entera: un
   turno sellado sin su cumplimiento es peor que un cierre que hay que reintentar. Documenta la
   decisión en el commit.
4. `titulares_json` se guarda con `NVARCHAR(MAX)`; el nombre del cargo se **congela** en
   `cargo_nombre` porque la etiqueta puede cambiar (D-052) y el histórico no se reescribe.
5. **Filtros que hay que heredar:** al contar participantes, excluye `es_sintetico = 1` (D-044) y
   `es_observador = 1` (D-059), igual que hace `buildConformacionSnapshot`. Un observador que entra
   **no** satisface un slot ni cuenta como relevo.

## 5. Criterios de aceptación y sus verificadores

| CA | Criterio | Verificador |
|---|---|---|
| **CA-15** | El estado se resuelve **por `usuario_id`**: 3 participantes del rol y ninguno titular → `PENDIENTE` | `tests/rotacion_cumplimiento.test.js › "por persona, no por conteo"` |
| **CA-16** | Los cuatro escalones son correctos, y `CUBIERTO_POR_RELEVO` gana sobre los otros | `tests/rotacion_cumplimiento.test.js › "escalones"` — cuatro casos sobre `evaluarEstado` puro + uno end-to-end |
| **CA-17** | `cerrarTurno` congela una fila por `(fecha_operativa, planta_id, turno, cargo_id)` en la MISMA transacción, y es **idempotente** | `tests/rotacion_cumplimiento.test.js › "congelado"` — cerrar un turno de `'TST'` dos veces deja **una** fila por clave; y un cierre con **cero** patrones activos **no falla** (`filas = 0`) |
| **CA-18** | `GET /cumplimiento` responde, para un rango, qué titulares no entraron y en qué turnos | `tests/rotacion_cumplimiento.test.js › "reporte de rango"` — incluye `400 rango_excesivo` con 94 días |

**Verificador bidireccional** en cada uno. Para CA-17, el caso negativo más valioso: haz que
`congelarCumplimiento` lance con `filas = 0` y confirma que el test de "cierre sin patrones" se pone
**rojo**; restaura y míralo verde. Ese es justo el bug que este prompt te pide no cometer.

## 6. Verificación que corres (solo la tuya)

```bash
cd server
node --check routes/rotacion-cumplimiento.js && node --check utils/rotacion/cumplimiento.js && node --check utils/turno-entidad.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-lock --sesion <tu sesión>
SERVER_PORT=3116 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js &
TEST_BASE_URL=http://localhost:3116 node --env-file=../.env --test tests/rotacion_cumplimiento.test.js
# Regresión obligatoria: tocaste turno-entidad.js, así que corré también su suite:
TEST_BASE_URL=http://localhost:3116 node --env-file=../.env --test tests/turno-entidad.test.js tests/conformacion_turno.test.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-unlock --sesion <tu sesión>
```

**Esos dos archivos de regresión son parte de tu verificación aunque no sean tu territorio**: los
corres, no los editas. Si alguno se pone rojo por tu cambio, es tuyo arreglarlo (en tu archivo, no
en el suyo).

**No corras `npm test` completo.** Cierras turnos **solo en planta `'TST'`** (D-055): un
`cerrarTurno` sobre `'GEC3'` cierra el turno REAL de producción. Es el riesgo más caro de este lote.
Cero residuos: deja la query en tu cierre.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L06.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L06): cumplimiento plan-vs-real y congelado al cerrar el turno" -- server/routes/rotacion-cumplimiento.js server/utils/rotacion/cumplimiento.js server/utils/turno-entidad.js server/tests/rotacion_cumplimiento.test.js prompts/D-065-rotacion-turnos/cierres/L06.md`
   (cuerpo multilínea con el porqué; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L06 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`, dilo explícito: **tocaste
   `turno-entidad.js`**, así que el gate debe mirar con lupa el diff de `cerrarTurno` y correr la
   suite completa de turnos.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **No cambies nada de lo que `cerrarTurno` ya hace.** Solo añades una llamada. Cualquier
  reordenamiento de lo existente es un bloqueo, no una mejora de paso.
- **Nunca cierres un turno de `'GEC3'` o `'GEC32'` en un test.** Solo `TEST_PLANTA`.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
- Tuteo colombiano estándar; sin voseo.
