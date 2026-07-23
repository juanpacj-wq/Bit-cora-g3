# D-057 · E2 — `DELETE /api/sala-de-mando/lotes/:lote_id` (borrado real)

## Antes de empezar (obligatorio)

1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 figure ✅.** Esta etapa reusa `resolverLoteVivo` y el patrón transaccional que
   E1 introdujo — si E1 no está, detenete.
3. Releé "Decisiones / desviaciones acumuladas": E1 pudo haber movido algo del diseño.

## Alcance de esta etapa

**Entra:** `DELETE /api/sala-de-mando/lotes/:lote_id` — borrado **real** de las N filas del lote,
recálculo de la publicación de **cada** celda que ocupaba (el publicado retrocede al lote anterior
vigente, o la fila de `evento_dashboard` se elimina si no queda ninguno), notificación post-commit,
**más su prueba de humo happy-path**.

**NO entra:** el front (E4), la matriz completa de criterios (E3), la cascada REQ-02 (solo el
comentario de enganche).

## Tareas

1. **Handler `DELETE /lotes/:lote_id`** en `server/routes/mand.js`, inmediatamente después del `PUT`:
   - `asyncH` + `loadAppSession` (ya aplicado por el router).
   - `planta_id` por **query string** (`req.query.planta_id`) — un `DELETE` no lleva body fiable.
   - Mismo gate que el `PUT`: `plantaMatch` → 403 · `hasPermisoBitacora(sesion, MAND_ID,
     'puede_crear')` → 403. **Sin** chequeo de `creado_por` (excepción a D-049, decisión 5).
   - Misma resolución del lote vía `resolverLoteVivo`: `404 lote_inexistente` · `409 lote_cerrado`
     (decisión 10) · `403` si es de otra planta.
   - **Sin gate de turno** (MAND exento, criterio 12).

2. **El lock de REDESP NO aplica al borrado del lote completo.** Es una decisión explícita, no un
   olvido: borrar es la corrección de un registro errado (RN-04.c, borrado real), no la reescritura
   del valor de un periodo pasado; si el lock aplicara, un redespacho mal digitado quedaría publicado
   para siempre — exactamente el problema que REQ-04 vino a resolver. **Dejalo comentado en el
   código** y llevalo al ADR en E5.

3. **Transacción única**:
   - Capturar antes del borrado la lista de celdas `(periodo, tipo)` del lote y su `fecha` (día
     Bogotá de `fecha_evento`).
   - `DELETE FROM bitacora.registro_activo WHERE registro_id IN (…)` — **acotado por PK**, con los
     `registro_id` bindeados en `.input(...)` **léxicamente junto al statement** (lo exige
     `guard_no_prod_historico_destruction.test.js`; ver el gotcha de D-055 sobre `stripComments`).
     Nunca por `planta_id` ni por `lote_id` suelto.
   - `recalcularEventoDashboard(transaction, { planta_id, fecha, periodo, tipo })` para **cada** celda
     liberada. Es acá donde se materializa el criterio 10: si otro lote cubría ese periodo con hora
     anterior, pasa a publicar; si no queda ninguno, la fila de `evento_dashboard` se **borra**
     (nunca `activa=0` — D-056 (6)).
   - Comentario del punto de enganche REQ-02 (borrado de las copias SALAJDT/SALAING), sin código.

4. **Post-commit**: `broadcastConteoBitacoras` + `notifyDashboard`, fire-and-forget.

5. **Respuesta**: `200 { lote_id, resumen: { eliminados, celdas_recalculadas } }`.

6. **Prueba de humo** en `server/tests/sala_de_mando_batch.test.js` (sección `D-057 · E2`): dos lotes
   AUTH solapados sobre el mismo periodo con horas distintas; borrar el que está publicado y
   verificar que `evento_dashboard` **retrocede** al otro (mismo `periodo`, `registro_origen_id` del
   lote sobreviviente); borrar también ese y verificar que la fila **desaparece**. `TEST_PLANTA` +
   `TEST_TAG`.

## Verificación (antes de commitear)

- `cd server && npm test` con el baseline esperado. No degradar.
- Query de sanidad: tras los borrados de la prueba, `SELECT` sobre `evento_dashboard` para la celda
  usada no debe dejar filas con `registro_origen_id` inexistente.

## Actualizar ESTADO.md (obligatorio antes de cerrar)

- Marcá E2 ✅ con resumen de una línea + bloque `### E2 — DELETE /lotes/:lote_id ✅` con Archivos
  tocados / Verificación / Desviaciones.

## Commit

```bash
git add server/routes/mand.js server/tests/sala_de_mando_batch.test.js prompts/D-057-correccion-lote-mand/ESTADO.md
git commit -m "$(cat <<'EOF'
feat(MAND): DELETE por lote — borrado real con retroceso del publicado

<por qué: RN-04.c pide borrado real (la anulación visible existe solo en DISP);
al liberar cada celda, recalcularEventoDashboard hace que el dashboard retroceda
al lote anterior vigente o elimine la fila si no queda ninguno>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
