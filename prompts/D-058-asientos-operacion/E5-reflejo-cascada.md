# D-058 · E5 — Reflejo a Sala: corregir y borrar (la cascada)

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md` (en particular cómo quedó resuelta la planta de
   fixture que sí refleja, anotada en E4).
2. **Verificá que E1..E4 figuren ✅.**
3. Mirá los dos puntos de enganche **ya anotados sin código** en `server/routes/mand.js`:
   `:532` (dentro del `PUT`) y `:645` (dentro del `DELETE`). **Ahí va, y en ningún otro lado.**

## Alcance de esta etapa

**Entra:** `actualizarReflejoLote` y `borrarReflejoLote` en `server/utils/reflejo-sala.js`, más sus
dos enganches. Cierra RQ-02.7/8/9 y RQ-04.14.
**No entra:** el bloqueo de edición en destino (E6) ni nada del Excel.

## Tareas

1. `actualizarReflejoLote(tx, { lote_id, ... })`: reescribe el `detalle` (el asiento re-renderizado
   con el estado **posterior** al diff) y, si cambió, la `fecha_evento` (la nueva `hora_llamada`).
   **Decisión H**: corregir el lote **regenera el texto**; no se agrega un renglón de corrección
   — el rastro vive en `modificado_por`/`modificado_en` del registro MAND.
   Sella `modificado_por`/`modificado_en` de las copias con el usuario que corrigió.
2. `borrarReflejoLote(tx, { lote_id })`: `DELETE` de las copias vivas.
3. **La búsqueda es por `lote_id`, nunca por `registro_id`** (la copia también migra al histórico;
   no hay FK posible — mismo argumento de D-055 (c)):
   ```sql
   FROM bitacora.registro_activo
   WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote_id
     AND bitacora_id IN (@salajdt, @salaing)
   ```
   > **Comentario obligatorio en el código:** `rowsAffected = 0` **NO es error** — es el caso
   > **esperado** tras el cierre de turno de Sala, que ya archivó las copias. Es exactamente la clase
   > de "cero filas" que alguien va a querer "arreglar" con un `throw`. **No lo arregles.**
4. Enganchar en los dos puntos anotados, **dentro de la transacción existente**, reemplazando el
   comentario de marcador por la llamada (y conservando la explicación que ya está escrita ahí,
   actualizada al hecho de que ahora sí hay código).
   - El `PUT` llama a `actualizarReflejoLote` **después** del diff y del recálculo por celda.
   - El `DELETE` llama a `borrarReflejoLote` **después** del borrado por PK y del recálculo.
   - Atómico con la operación de origen (RQ-04.16 / RQ-02.9).
   - `TEST_PLANTA` sigue sin reflejar (RN-02.e): el mismo guard de E4.
5. **Lo que NO cambia, y hay que dejar dicho:** si alguna copia ya se archivó, **el histórico no se
   toca** (RF-032) y la corrección del origen **procede igual** (respuesta 10). Rechazar con `409`
   volvería incorregible un lote a las 18:01 por el estado de su reflejo — invierte la jerarquía y
   contradice el **criterio 12 de REQ-04**, ya implementado y probado en D-057: MAND está **exenta**
   de los gates de turno, y un `409` por "turno cerrado" reintroduciría por la puerta de atrás lo que
   se excluyó por diseño.
6. Tests en `server/tests/sala_de_mando_batch.test.js` (D-055):
   - `PUT` de un lote → las **dos** copias quedan con el asiento nuevo (criterio 5 y 8 de REQ-02;
     criterio 8 de REQ-04).
   - `PUT` que cambia solo la **hora** → las copias mueven su `fecha_evento`.
   - `PUT` que cambia solo el **detalle** → el asiento cambia (el lock de REDESP protege el valor,
     **nunca** el comentario).
   - `DELETE` del lote → las **dos** copias desaparecen (criterio 6 de REQ-02; criterio 9 de REQ-04).
   - **Copia ya archivada**: simulá el archivado (mové la copia a `registro_historico` con el
     acotador de fixture correspondiente) y verificá que el `PUT` responde **200**, que el histórico
     **no cambió**, y que no se lanzó ningún error por `rowsAffected = 0`.
   - Corrección que falla a mitad → no queda aplicada parcialmente en registro, copias ni
     publicación (criterio 14 de REQ-04).
   - Regresión: los criterios de D-057 (diff quirúrgico, retroceso del publicado, lock sobre el
     delta, `lote_sin_celdas`) siguen verdes.
   - `verificarCoherenciaDeLotes()` sigue corriendo en los dos escenarios (tras capturar y tras
     corregir) — **no lo borres** (D-056 (c)).

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado.
- `guard_no_prod_historico_destruction.test.js` verde: todo `DELETE`/`UPDATE` sobre
  `registro_activo`/`registro_historico` de los tests nuevos lleva su acotador de fixture
  **léxicamente junto al statement** (en `mssql` el binding está en los `.input(...)` previos).

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E5 ✅. Bloque con **Archivos tocados**, **Verificación** y **Desviaciones**.

## Commit
```bash
git add server/utils/reflejo-sala.js server/routes/mand.js server/tests/sala_de_mando_batch.test.js
git commit -m "$(cat <<'EOF'
feat(MAND): corregir o borrar un lote cascadea a sus copias en Sala (REQ-02/RQ-04.14)

Ocupa los dos puntos de enganche que D-057 dejó anotados sin código. Corregir el lote
regenera el asiento en las dos copias y borrarlo las borra, todo en la misma
transacción del origen: o se aplica en los tres lados o en ninguno. La bitácora de
Sala refleja siempre el estado actual, que es lo que REQ-02 pide; el rastro de la
corrección vive en modificado_por/modificado_en, no en un renglón duplicado.

La búsqueda va por origen_lote_id y nunca por registro_id: la copia también migra al
histórico y no hay FK posible.

Cero filas afectadas NO es error, y está comentado en el código para que nadie lo
"arregle": es el caso esperado cuando el cierre de turno ya archivó las copias. El
histórico no se reescribe y la corrección del origen procede igual — rechazarla con
409 volvería incorregible un lote a las 18:01 por el estado de su reflejo, y
contradiría el criterio 12 de REQ-04, que ya exime a MAND de los gates de turno.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
