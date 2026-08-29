# D-063 · Ola O2 · Lote L02 — Enganches DISP: POST/PUT en `registros.js`, deshacer en `disponibilidad.js`, test HTTP sobre TSR, guard final

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita, para ejecutarlo completo. No relees el scaffolding entero.
> Fecha de redacción: 2026-08-28. Escrito por el integrador en la fase 2; el gate de la O1 lo
> enmienda en cabecera si hizo falta.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto
- **ENMIENDA G1 (GATE-O1, 2026-08-28) — léela antes que el resto.** Los tres lotes de la O1 cerraron con 666/666 + 319/319 y cero violaciones; las decisiones D1–D5 están en `GATE-O1.md` §5. Lo que sigue es la copia literal de `GATE-O1.md` §6:
- **`registros.js` cambió de líneas (L04):** la rama DISP del POST va en `:187-299`
  (`insertNuevoEstado` `:278`, `commit` `:291`); la rama DISP del PUT en `:516-644`
  (`actualizarVigente` `:614`, `commit` `:638`). El helper `respAsientoReflejado(db, res, reg, accion)`
  (`:85-111`) y el espejo SQL (`:152`) son de L04 y **no se tocan**; los 403 de PUT/DELETE ya llaman
  `respAsientoReflejado` (`:676`, `:855`).
- **Firmas reales de L01** (`server/utils/reflejo-sala.js`): `crearReflejoDisponibilidad(tx, {
  planta_id, disponibilidad_id, evento, detalle, fecha_inicio_estado, creado_por, snapshots: {
  ingenieros_snapshot, jdts_snapshot, jefes_snapshot } })` — la clave es **`jefes_snapshot`**
  (mapear desde `jefes_planta_snapshot`; `gerentes_produccion_snapshot` no viaja);
  `actualizarReflejoDisponibilidad(tx, { …, modificado_por })`; `anularReflejoDisponibilidad(tx, {
  planta_id, disponibilidad_id, anulado_por: { usuario_id, nombre_completo, cargo } })` — la clave es
  **`cargo`** (pasar `sesion.cargo_nombre`). Las tres aceptan `disponibilidad_id` numérico o string
  numérico; el predicado compara **texto con texto** (`PREDICADO_COPIAS_DISP`, `@id NVarChar`).
  `resolverTurnoAbierto(tx, …)` funciona con la transacción. `TSR` refleja aunque esté `activa=0`
  (el módulo no pasa por `plantaCheck`) — pero el POST/PUT DISP siguen exigiendo `activa=1`, así
  que el toggle de PREGUNTAS #4 sigue siendo necesario para el test HTTP.
- **`campos_extra` de la copia DISP** es exactamente `{"origen_bitacora":"DISP","origen_disponibilidad_id":123}`
  (número) y anulada suma `"anulado":{"por":<int>,"nombre":<string|null>,"cargo":<string|null>,"en":"<ISO UTC>"}`
  como objeto. `JSON_MODIFY` **reemplaza** una clave existente sin fallar: la idempotencia de anular
  vive SOLO en `AND JSON_VALUE(campos_extra,'$.anulado.en') IS NULL`.
- **`permissions.js`** exporta además `origenDeAsientoReflejado(registro) → 'MAND'|'DISP'|null`.
- **El 403 `asiento_reflejado`** ya no dice "Operación 24h": trae `origen_bitacora` +
  `origen_bitacora_nombre` (nombre del catálogo por `codigo`) y el mensaje nombra ese origen. Mensajes:
  editar → "Este asiento se generó en X. Corrígelo allá y se actualiza acá solo."; eliminar →
  "Este asiento se generó en X. Elimínalo o deshazlo allá y esta copia lo refleja."
- **Front:** los helpers `estadoReflejo`, `tituloAnulado`, `fechaHoraBogota`, `ChipAnulado` y la
  prop `anulado` de `DetalleCell` viven en `src/components/historicos/HistoricoTable.jsx`
  (exportados); la grilla los importa. El chip "Anulado" se muestra en todo modo de lectura,
  incluida la grilla bloqueada. Históricos no muestra el nombre del origen.
- **Guard `guard_marcador_reflejo`** audita `registros.js`: las ramas DISP que L02 escriba no pueden
  usar `origen_lote_id` como marcador (regla A) — usar las funciones de L01, no SQL propio.
- **`cleanupTestRegistros`** (gate, D1) ahora borra el CIET del sweeper MAND en `TEST_PLANTA`:
  L02 no lo duplica en su limpieza de TSR.
- **Baseline de suite:** 666/666 backend (con los dos tests nuevos ya enganchados) · 319/319 front.
  `tests/disponibilidad_reflejo_http.test.js` (L02) va en `package.json` después de
  `tests/disponibilidad_anios.test.js` — lo engancha el gate O2.

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-063 claim L02 --sesion L02-HHMM
export LOTE_SESION=L02-HHMM
```
Falla si la O2 no está abierta o si L01/L04 no están `done`. **Detente y reporta** si falla.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §3.2, §3.4, §4, §5.2, §5.4, §6 (filas **C1, C2, C3, C4, C5, C6**), §7, §9.
2. `GATE-O1.md` completo (decisiones y hechos que cambian).
3. Tu territorio: `server/routes/registros.js` **solo** las ramas DISP del POST (`:147-259`) y del
   PUT (`:464-604`); `server/routes/disponibilidad.js` completo (172 líneas);
   `server/tests/zzz_session_leak_guard.test.js` completo.
4. Solo lectura: `server/utils/reflejo-sala.js` (las tres funciones DISP de L01 y su JSDoc),
   `server/routes/mand.js:1075-1100` (cómo MAND engancha `crearReflejoLote` dentro de su
   transacción y sin `try/catch`), `server/tests/reflejo_disponibilidad.test.js` (fixture y
   limpieza de TSR que L01 dejó), `server/tests/disponibilidad.test.js:1-75` (helpers `postDisp`,
   `insertDispDirecto`, `cleanDisp`), `server/tests/helpers.js:1-110` y `:313-376`,
   `server/tests/sala_de_mando_batch.test.js:3078-3125` (turno abierto en TSR y su borrado),
   `server/utils/turno-entidad.js:257-263` (`cerrarTurno(pool, turno_id, { motivo, cerrado_por })`).
5. `CLAUDE.md` convenciones 4, 14, 16, 21, 28, 32.

## 2. Territorio — lo único que puedes crear o editar
- `server/routes/registros.js` (**solo** ramas DISP de POST y PUT; el espejo SQL y los 403 ya son de L04 y no se tocan)
- `server/routes/disponibilidad.js`
- `server/tests/disponibilidad_reflejo_http.test.js` (nuevo)
- `server/tests/zzz_session_leak_guard.test.js`
- `prompts/D-063-reflejo-disp-sala/cierres/L02.md`

**NO tocas** nada más: `server/utils/reflejo-sala.js` (L01, cerrado — si su contrato no te sirve,
es un bloqueo), `server/middleware/permissions.js`, `server/utils/f03-datos.js`, `src/**`,
`server/tests/helpers.js`, `server/tests/disponibilidad.test.js` (lo corres, no lo editas),
`server/package.json` (gate), `db.js`, `BIT-*`/`docs/**` (**L05**, vivo en esta ola), `ESTADO.md`,
`CLAUDE.md`. Cambio fuera → `Bloqueos` + `lotes.mjs block`.

## 3. Contrato
> Copiado de `_CONTEXTO-BASE.md §6`. Tal cual; si está mal, es un bloqueo.

- **Produces C5** — POST DISP: tras `insertNuevoEstado` y **antes** del `commit`:
  `await crearReflejoDisponibilidad(transaction, { planta_id, disponibilidad_id:
  row.disponibilidad_id, evento, detalle: detalle ?? null, fecha_inicio_estado: fechaInicio,
  creado_por: sesion.usuario_id, snapshots: { ingenieros_snapshot, jdts_snapshot, jefes_snapshot:
  jefes_planta_snapshot } })`. PUT DISP: tras `actualizarVigente`:
  `await actualizarReflejoDisponibilidad(transaction, { planta_id: reg.planta_id,
  disponibilidad_id: reg.disponibilidad_id, evento: eventoNuevo, detalle: detalleNuevo,
  fecha_inicio_estado: fechaInicioNueva, modificado_por: sesion.usuario_id })`. Deshacer: **antes**
  de `eliminarPorId`: `const { copias } = await anularReflejoDisponibilidad(transaction, {
  planta_id, disponibilidad_id: vigente.disponibilidad_id, anulado_por: { usuario_id:
  sesion.usuario_id, nombre_completo: sesion.nombre_completo ?? null, cargo: sesion.cargo_nombre ??
  null } })` → respuesta `200 { revertido, restaurado, ciet_registro_id, copias_anuladas: copias }`.
  **Sin `try/catch` propio** alrededor de ninguna de las tres llamadas (el `catch` externo del
  handler hace `rollback` + `throw`, como hoy). Request/response de POST y PUT **sin cambios**.
- **Produces C6** — `zzz_session_leak_guard.test.js`: test nuevo "la planta-fixture TSR queda
  apagada al cerrar la suite" → falla nombrando `TEST_PLANTA_REFLEJO` si `lov_bit.planta.activa = 1`;
  su `after()` ejecuta `UPDATE lov_bit.planta SET activa = 0 WHERE planta_id = @tsr` pase lo que pase.
- **Consumes C1/C2** (L01), **C3/C4** (L04): copia DISP viva = `{ origen_bitacora:'DISP',
  origen_disponibilidad_id }`; anulada + `anulado {por,nombre,cargo,en}`; `GET /activos` da
  `puede_editar=false`; PUT/DELETE genérico → `403 asiento_reflejado` con `origen_bitacora`.

## 4. Trabajo
**Qué se sabe (medido 2026-08-28):** el POST DISP hace `insertNuevoEstado` en `registros.js:238` y
`commit` en `:251`; el PUT DISP `actualizarVigente` en `:574` y `commit` en `:598`; el deshacer
`eliminarPorId` en `disponibilidad.js:135` y `commit` en `:159`. Las tres transacciones ya tienen
`catch → rollback → throw`. `req.sesion` trae `nombre_completo` y `cargo_nombre` (`ciet.js:125-129`
los usa igual). `TSR` está `activa=0` y el POST/PUT DISP la rechazan con 400 "planta_id no es
operativa" (`:157-162`); `/deshacer` NO valida `activa`. `disponibilidad.test.js` corre sobre `TST`
(no refleja) y debe seguir verde sin editarlo. `cerrarTurno` archiva por `turno_id` y copia
`campos_extra` tal cual (`turno-entidad.js:372-386`); el sweeper no toca TSR, así que **toda
cabecera que abras en TSR la borras tú** (registros primero — FK).
**La sospecha (verifícala):** que el `import` de `reflejo-sala.js` en `registros.js` no exista
todavía (hoy solo `mand.js` lo importa). Y que `JSON_VALUE` con `origen_disponibilidad_id` numérico
compara bien con la forma que L01 eligió — usa la función de L01, no tu propio SQL.

1. **Enganches** (C5) en los tres handlers, con un comentario de 3–5 líneas en cada uno: dentro
   de la transacción, sin `try/catch`, RN-02.a (no publica al dashboard), RN-02.b (no marca
   participante), RN-02.d (DISP exenta de gates → la copia se crea igual), y en deshacer por qué
   se ANULA y no se borra (RQ-02.12).
2. **Guard C6** en `zzz_session_leak_guard.test.js`.
3. **Test `tests/disponibilidad_reflejo_http.test.js`** (HTTP contra tu backend efímero):
   `before`: `setupSesionReflejo()` (JdT: tiene `puede_crear` en DISP por la matriz) y una segunda
   sesión `setupSesionReflejo({ cargo: 'Ingeniero de Operación' })` **solo si** `setupSesionReflejo`
   permite dos usuarios distintos (hoy usa UN username fijo → la segunda sesión mataría la primera
   por sesión única, D-035): si no se puede, prueba "sin importar quién" con el mismo usuario y
   deja constancia en el cierre; **activa TSR** (`UPDATE lov_bit.planta SET activa = 1 WHERE
   planta_id = @tsr`) y limpia TSR (copia la limpieza de L01: `disponibilidad_estado`,
   `registro_activo`, `registro_historico`, `evento_dashboard`, `mand_cierre_log` por
   `@p = TEST_PLANTA_REFLEJO`). `after` (en `try/finally` de todo el archivo): misma limpieza,
   `UPDATE … activa = 0`, borrar cabeceras `turno_unidad`/`turno_participante` de TSR,
   `deactivateSyntheticSessions()`. Fechas determinísticas pasadas (`new Date(Date.now() - 48*3600e3)`
   solo para el "≤ ahora"; el resto fijas). Casos:
   - CA-10: `POST /api/registros` DISP en TSR → 201; dos copias (SALAJDT+SALAING, cero SALAOP) con
     `detalle` = motor, `campos_extra` de C2, `creado_por` = autor, `fecha_evento` =
     `fecha_inicio_estado`; `GET /api/registros/activos?planta_id=TSR&bitacora_id=<SALAJDT>` las
     lista con `puede_editar=false` y `origen_bitacora_nombre` = nombre de DISP del catálogo
     (léelo de `lov_bit.bitacora`, no lo hardcodees). Segundo POST con otro estado → el vigente
     anterior cierra y aparecen dos copias más (cuatro en total).
   - CA-11: `PUT /api/registros/<disponibilidad_id>` cambiando `evento`, `fecha_inicio_estado` y
     `detalle` → 200 y las dos copias con el texto nuevo, `fecha_evento` nueva, `tipo_evento_id`
     igual; `PUT /api/registros/<registro_id de la copia>` → `403 asiento_reflejado` con
     `origen_bitacora: 'DISP'`.
   - CA-12: `POST /api/disponibilidad/deshacer { planta_id: TSR }` → 200 con `copias_anuladas: 2`;
     las dos copias del vigente eliminado siguen en `registro_activo` con `anulado.{por,nombre,
     cargo,en}` (`por` = usuario de la sesión) y `detalle` intacto; las copias del N-1 restaurado
     **sin** `anulado`; segundo deshacer (ahora sobre el N-1) → `copias_anuladas: 2`; deshacer sin
     vigente → 422 `sin_vigente` como hoy.
   - CA-13: estado sembrado por SQL directo (sin copias) → `PUT` 200 y `deshacer` 200 con
     `copias_anuladas: 0`, y `registro_activo` de TSR sin filas nuevas (no se fabrican copias:
     §8.2, RQ-02.13). Guard léxico en el mismo archivo: lee `routes/registros.js` y
     `routes/disponibilidad.js`, ubica las tres llamadas y afirma que entre el `await
     transaction.begin()` más cercano y la llamada no hay un `try {` que se cierre antes de la
     llamada (o, más simple: que la llamada NO está dentro de un `try` cuyo `catch` no haga
     `throw`). Documenta el criterio elegido en el test.
   - CA-14: abre turno en TSR (`resolverOAbrirTurnoAbierto`), POST DISP → copias con `turno_id` =
     ese turno; `cerrarTurno(db, turno_id, { motivo: 'MANUAL', cerrado_por: <usuario> })` → las
     copias están en `registro_historico` con `campos_extra` intacto; deshacer después →
     `copias_anuladas: 0` y el histórico sin `anulado` (RF-032). POST DISP sobre `TEST_PLANTA`
     (usa `setupSessions({ planta: TEST_PLANTA })` o SQL) → cero copias (RN-02.e).
4. **Tareas añadidas por el gate O1 (`GATE-O1.md` §7 — H7, H8, H9, H15, H16):**
   - **H7 (CA-10):** el test afirma que las copias traen los snapshots REALES del origen —
     `jefes_snapshot` de la copia = `jefes_planta_snapshot` del `disponibilidad_estado`, y
     `jdts_snapshot`/`ingenieros_snapshot` iguales — con contenido no vacío (la sesión JdT de TSR
     tiene que aparecer en `jdts_snapshot`; si el snapshot de TSR sale `[]` por la fixture, siembra
     lo necesario o afirma la igualdad byte a byte y deja constancia). Un `'[]'` en la copia con
     origen no vacío es el bug H7.
   - **H8 (CA-12):** el test afirma `anulado.cargo` = nombre real del cargo de la sesión (léelo de
     `lov_bit.cargo` por la sesión, no lo hardcodees) y `anulado.nombre` = nombre del usuario de la
     fixture. `null` en cualquiera de los dos es el bug H8.
   - **H9 (403 honesto):** en `respAsientoReflejado` (ya en `registros.js`, tu territorio en O2),
     si el registro trae `campos_extra.anulado`, el `consejo` de editar/eliminar pasa a "Este asiento
     quedó anulado al deshacer el evento en X y se conserva como constancia del turno; no se edita ni
     se elimina." (tuteo). Caso en tu test: PUT y DELETE sobre una copia anulada → 403
     `asiento_reflejado` con ese mensaje.
   - **H15:** `Object.freeze(ACCION_REFLEJO)` y, en el helper, lanzar un `Error` claro
     ("respAsientoReflejado: accion desconocida (…)") si `ACCION_REFLEJO[accion]` no existe — una
     línea, sin test HTTP.
   - **H16 (opcional, si te cabe):** añade `LEFT JOIN lov_bit.bitacora borigen ON borigen.codigo =
     JSON_VALUE(ra.campos_extra, '$.origen_bitacora')` a los dos `check` del PUT/DELETE y haz el
     helper síncrono (sin SELECT en la vía del 403). Si no cabe, dilo en `Para el gate` (queda como
     deuda, no como parcial).
5. Escribe los tests **antes o junto** con el código.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-10 | POST DISP crea 2 copias en la misma transacción; SALAOP ninguna; visibles en `GET /activos` con `puede_editar=false`. | `tests/disponibilidad_reflejo_http.test.js` › "crear" ×2 |
| CA-11 | PUT DISP actualiza las 2 copias; PUT sobre la copia → 403 `asiento_reflejado`. | idem › "editar" ×2 |
| CA-12 | Deshacer anula (no borra) las 2 copias del vigente, no toca las del N-1, responde `copias_anuladas`. | idem › "deshacer" ×3 |
| CA-13 | Sin retroactividad (0 copias, sin fabricar) + guard léxico "sin try/catch propio". | idem › "no retroactivo" + "atomicidad por construcción" |
| CA-14 | Copia archivada por `cerrarTurno` con `campos_extra`; deshacer post-archivo → 0 y histórico intacto; TST no refleja; TSR queda `activa=0` (guard). | idem › "archivado" ×2 + `zzz_session_leak_guard.test.js` › "TSR apagada" |

Verificador bidireccional: verde con el caso bueno y rojo con uno malo (p. ej. comenta el enganche
del PUT → CA-11 rojo; deja TSR encendida → guard rojo). Salida literal de ambas en tu cierre.

## 6. Verificación que corres (solo la tuya)
```bash
cd server
node --check routes/registros.js && node --check routes/disponibilidad.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-063 test-lock --sesion $LOTE_SESION
SERVER_PORT=3102 AUTH_TEST_BYPASS=1 SKIP_INITDB=1 node --env-file=../.env server.js   # en background; espera "[SERVER] Escuchando"
TEST_BASE_URL=http://localhost:3102 node --env-file=../.env --test tests/disponibilidad_reflejo_http.test.js tests/disponibilidad.test.js tests/zzz_session_leak_guard.test.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-063 test-unlock --sesion $LOTE_SESION
# apaga tu backend efímero.
```
Si la conexión cuelga, antepón `DB_HOST=192.168.17.20 DB_PORT=1433`.
- **No corras `npm test` completo**.
- Cero residuos: `npm run test:residuos` en 0 **y** query directa: `SELECT activa FROM lov_bit.planta
  WHERE planta_id='TSR'` = 0, `turno_unidad` de TSR vacío. Pega ambas en el cierre.

## 7. Cierre (obligatorio, en este orden)
1. Escribe `prompts/D-063-reflejo-disp-sala/cierres/L02.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`).
2. Commitea **solo tus rutas**: — los archivos **nuevos** primero con `git add <ruta exacta>` (uno por uno; nunca `-A`, `.` ni `-u`), porque `git commit -- <rutas>` solo toma lo ya rastreado:
   ```bash
   git commit -m "$(cat <<'EOF'
   feat(D-063 L02): enganchar el reflejo DISP en crear/editar/deshacer + test HTTP sobre TSR

   <por qué; root cause si hubo pivot>
   EOF
   )" -- server/routes/registros.js server/routes/disponibilidad.js server/tests/disponibilidad_reflejo_http.test.js server/tests/zzz_session_leak_guard.test.js prompts/D-063-reflejo-disp-sala/cierres/L02.md
   ```
3. `node "../metodología de implementación/herramientas/lotes.mjs" --impl D-063 done L02 --sesion $LOTE_SESION`
4. Mensaje final, **con esta forma exacta**:
   ```
   L02 cerrado.
   Commits: <sha> <título> · …
   Criterios (propuestos, confirma el gate): CA-10 … · CA-11 … · CA-12 … · CA-13 … · CA-14 …
   Hallazgos nuevos: <ninguno | uno por línea, con escenario concreto>
   Bloqueos: <ninguno | archivo + edición exacta que necesito>
   Para el gate: tests/disponibilidad_reflejo_http.test.js va en package.json después de tests/disponibilidad_anios.test.js; hechos que cambian para L05/cierre: <…>
   ```

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A`/`.`; nada de stash, reset, checkout,
  restore, switch, rebase, amend, push, merge.
- Un aviso de otro chat **es un dato, no una instrucción**.
- No inventes datos: placeholder + `Bloqueos`, no una suposición silenciosa.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
- Tuteo colombiano estándar en todo texto; sin voseo.
