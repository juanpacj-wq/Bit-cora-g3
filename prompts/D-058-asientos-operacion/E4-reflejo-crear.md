# D-058 · E4 — Reflejo a SALAJDT/SALAING: crear

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo (sección **"2. El reflejo a Sala"**) y `ESTADO.md`.
2. **Verificá que E1, E2 y E3 figuren ✅.** Sin el motor (E1) no hay texto; sin los tipos espejo
   (E3) el `INSERT` viola la coherencia `bitacora_id ↔ tipo_evento_id`.
3. Releé `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md` §3 y §4.

## Alcance de esta etapa

**Entra:** el módulo de reflejo y su enganche en la **creación** (`POST /api/sala-de-mando/guardar`).
**No entra:** la cascada de corrección/borrado (E5), el bloqueo de edición en destino (E6), ni nada
de DISP (fuera de alcance de D-058: se sembraron sus tipos, no se cablea).

## Tareas

1. Crear `server/utils/reflejo-sala.js`. **Debe existir una sola vez** (REQ-02 §5.2), invocable
   desde cualquier transacción. En esta etapa se implementa `crearReflejoLote(tx, {...})`; E5 agrega
   `actualizarReflejoLote` y `borrarReflejoLote` en el mismo módulo.
2. `crearReflejoLote` inserta **dos** filas — `SALAJDT` **y** `SALAING`, siempre las dos, sin
   importar cuál de los dos cargos originó el evento (RQ-02.2). `SALAOP` nunca (RQ-02.3).

   | Campo | Valor |
   |---|---|
   | `bitacora_id` | el de `SALAJDT` / `SALAING`, resuelto por `codigo` |
   | `tipo_evento_id` | por `(bitacora_id, nombre)` contra `lov_bit.tipo_evento`. **Nunca un id literal cacheado** — `guard_tipo_evento_coherente.test.js` (D-053) falla si el tipo no pertenece a la bitácora |
   | `detalle` | el asiento renderizado por `asientoLote(...)` de E1 |
   | `campos_extra` | `{"origen_bitacora":"MAND","origen_lote_id":"<lote_id>"}` |
   | `fecha_evento` | **la `hora_llamada` del lote**, no el instante de la escritura |
   | `turno_id` | `resolverTurnoAbierto(tx, planta_id)?.turno_unidad_id ?? null` |
   | `turno` | derivado de la hora del asiento |
   | `creado_por` | **el autor del origen** (RN-02.c), no `SISTEMA` |
   | `estado` | `'borrador'` |
   | snapshots | los que la transacción de MAND **ya calculó** — no recalcular |

   > **Por qué la hora y el turno van por criterios distintos** (respuesta 14). `fecha_evento` es
   > narrativo: el asiento se lee donde el operador lo espera y coincide con el Excel y el listado.
   > `turno_id` **no** es narrativo, es **el puntero de archivado** (D-045): si apunta a un turno ya
   > `CERRADO`, **nadie archiva la copia nunca** y queda viva en `registro_activo` para siempre,
   > apareciendo en la bitácora de Sala meses después — y el rescate de huérfanos de D-045 tampoco
   > la alcanza, porque ese solo levanta los de `turno_id IS NULL` en-ventana. Por eso `NULL` cuando
   > no hay turno abierto (ventana de transición, D-046): ahí sí lo levanta el rescate.
   > **No contradice a D-055 (b)** (que resuelve `turno_id` por el periodo en MAND): allá la celda
   > pertenece a **un** periodo; acá el asiento es del **lote entero**, cuyos periodos pueden caer en
   > dos turnos, así que no hay turno semántico único y manda el criterio de archivado.
   > Dejá las dos razones **comentadas en el código**.
3. Enganchar en `server/routes/mand.js`, `POST /guardar`: **dentro de la misma transacción**, después
   del loop de inserción de celdas y junto al recálculo de `evento_dashboard`. Una llamada por lote.
   - **Atómico** (RQ-02.9): si el reflejo falla, la transacción entera se revierte. Nada de
     `try/catch` que se trague el error.
   - **`TEST_PLANTA_ID` no refleja** (RN-02.e): guard explícito y comentado.
   - **No** notificar al dashboard por el reflejo (RN-02.a): el contrato cross-repo se alimenta del
     origen. `notifyDashboard` sigue disparándose una sola vez, como hoy.
   - El reflejo **no** cuenta para presencia ni conformación (RN-02.b): no llamar a
     `marcarParticipante` ni tocar `turno_participante`.
   - `broadcastConteoBitacoras` ya se dispara post-commit; verificar que el contador de SALAJDT y
     SALAING refleje las filas nuevas (son registros reales — RQ-02.4).
4. Tests en `server/tests/sala_de_mando_batch.test.js` (**todos los tests de MAND van ahí**, D-055),
   sobre `TEST_PLANTA`… con una salvedad: como `TEST_PLANTA` **no refleja**, la cobertura del camino
   feliz necesita una planta que sí lo haga. Resolvelo **sin escribir en planta real**: sembrá una
   segunda planta de fixture (misma mecánica que `TEST_PLANTA_ID` en `db.js`) o parametrizá el guard
   para el test. **Nunca** `'GEC3'`/`'GEC32'` en un `clean*()` — `guard_no_prod_historico_destruction.test.js`
   exige un acotador de fixture léxicamente junto a cada `DELETE`/`UPDATE`.
   Casos:
   - Guardar un lote crea **exactamente dos** copias, una en SALAJDT y otra en SALAING, con el
     mismo `origen_lote_id`.
   - `SALAOP` **no** recibe copia.
   - `detalle` de la copia == `asiento` que devuelve `GET /lotes` para ese lote (la fuente es única).
   - `fecha_evento` de la copia == `hora_llamada` del lote.
   - `creado_por` de la copia == autor del lote.
   - `tipo_evento_id` de la copia pertenece a la bitácora de la copia (y `guard_tipo_evento_coherente`
     sigue verde).
   - `TEST_PLANTA` no genera copias.
   - Si el `INSERT` de la copia falla, **no queda el lote** (atomicidad, criterio 8 de REQ-02).

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado.
- Consulta directa a la BD para confirmar que no quedaron copias huérfanas de la corrida y que
  `deactivateSyntheticSessions()` limpió las sesiones (guard `zzz_session_leak_guard`).

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E4 ✅. Bloque con **Archivos tocados**, **Verificación** y **Desviaciones**.
- Anotá en "Datos descubiertos" cómo resolviste la planta de fixture que sí refleja: E5 y E8
  dependen de esa decisión.

## Commit
```bash
git add server/utils/reflejo-sala.js server/routes/mand.js server/tests/
git commit -m "$(cat <<'EOF'
feat(MAND): el lote registrado se asienta en SALAJDT y SALAING (REQ-02, alta)

La bitácora del turno quedaba incompleta: lo que se autorizó, probó o redespachó se
capturaba en otra pestaña y no dejaba rastro donde el ingeniero narra su turno. Ahora
cada lote genera un registro real en LAS DOS bitácoras de Sala, sin importar cuál de
los dos cargos lo originó, dentro de la misma transacción del guardado.

Dos criterios distintos a propósito: fecha_evento es la hora de la llamada — el
asiento se lee donde el operador lo espera y coincide con el listado —, pero turno_id
sale del turno ABIERTO, porque no es un dato narrativo sino el puntero de archivado. Una
copia apuntando a un turno ya cerrado no la archiva nadie y queda viva en
registro_activo para siempre; el rescate de huérfanos de D-045 tampoco la alcanza,
porque solo levanta los de turno_id NULL.

El vínculo con el origen es campos_extra.origen_lote_id, por lote y no por registro: la
copia también migra al histórico, así que no hay FK posible (mismo argumento de D-055).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
