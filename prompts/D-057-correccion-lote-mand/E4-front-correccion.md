# D-057 · E4 — Front: acciones en el listado + modal de corrección

## Antes de empezar (obligatorio)

1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1, E2 y E3 figuren ✅.** El front no se construye contra endpoints sin probar.
3. Releé "Decisiones / desviaciones acumuladas": si el shape de request/response cambió en E1/E2, el
   front sigue **lo ejecutado**.

## Alcance de esta etapa

**Entra:** los controles de corrección en el listado del día y el modal de edición, más el hook.
**NO entra:** el formato de mensaje ni el botón de copiar (REQ-04 §8.1/§8.3, bloqueados → D-058).
La grilla de captura **no se toca**: sigue naciendo vacía y sin cargar nada del servidor (D-056).

## Tareas

1. **`src/hooks/useSalaDeMando.js`** — dos operaciones nuevas junto a `getLotes`/`guardarBatch`:
   - `editarLote(lote_id, { planta_id, hora, detalle, funcionariocnd, periodos })` →
     `api.put('/api/sala-de-mando/lotes/' + encodeURIComponent(lote_id), body)`.
   - `eliminarLote(lote_id, planta_id)` → `api.del('/api/sala-de-mando/lotes/…?planta_id=…')`.
   - Las dos disparan `window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'))` como ya hace
     `guardarBatch`, y propagan el error tal cual (el `errores[]` del backend viaja en la excepción).

2. **`src/components/SalaDeMando/LoteEditorModal.jsx` (nuevo)**:
   - Props: `lote`, `plantaId`, `periodoActual`, `onGuardar`, `onEliminar`, `onCerrar`.
   - Campos: **hora** (`<input type="time">`, precargada con la del lote), **funcionario CND** (solo
     habilitado si `lote.tipo === 'AUTH'`, requerido ahí), **descripción**, y la lista de **periodos
     con su valor**, con posibilidad de **agregar** y **quitar** periodos (1..24).
   - El **tipo se muestra pero no se puede cambiar** (decisión 11). Poné el motivo en un `title`:
     para corregir el tipo hay que eliminar el lote y registrarlo de nuevo.
   - **REDESP**: las celdas de periodos `< periodoActual` se marcan y se deshabilita **el valor**
     (no la hora ni la descripción) — mismo criterio visual que la grilla (`isLocked`).
   - **Guardar deshabilitado si no queda ningún periodo con valor**, con el texto que señala el botón
     Eliminar (decisión 6: vaciar ≠ borrar). El backend igual lo rechaza con `lote_sin_celdas`; esto
     es affordance, no la regla.
   - Pinta los `errores[]` del backend reusando el mapa de motivos: extendé `MOTIVO_MSG` de
     `SalaDeMandoGrid.jsx` (o movelo a un módulo compartido si queda más limpio) con
     `lote_cerrado`, `lote_inexistente` y `periodo_bloqueado` en su redacción de corrección.
   - Copys en **tuteo colombiano, sin voseo**.

3. **`src/components/SalaDeMando/LotesDelDia.jsx`** — props nuevas `puedeCrear`, `onEditar`,
   `onEliminar`; columna de acciones al final con lápiz y basurero **visibles solo si `puedeCrear`**
   (RN-04.f: sin permiso el listado se ve igual, sin controles). No cambiar la presentación existente
   (los renglones, el resumen de periodos, la marca de publicado por celda).

4. **Confirmación de borrado**: modal simple con el resumen del lote (tipo, hora, periodos y sus
   valores) antes de llamar `eliminarLote`. Borrar es real e irreversible (RN-04.c).

5. **`src/components/SalaDeMando/SalaDeMandoGrid.jsx`** — orquesta: estado del lote en edición,
   render del modal, y `await refrescarLotes(fechaCargada)` tras cada operación exitosa.
   - **Ante `409 lote_cerrado`**: cerrar el modal, avisar con `showToast`/`onError` y **refrescar el
     listado** para que la fila archivada desaparezca de la pantalla que quedó abierta (decisión 10).
   - **Sin segundo temporizador**: se reusa el tick de 60s que ya existe (`SalaDeMandoGrid.jsx:141`).
   - La corrección **no ensucia** la grilla: `dirty` sigue derivando solo del buffer de captura.

## Verificación (antes de commitear)

- `npm run build` (raíz del subrepo) — **verde obligatorio**, un build roto bloquea el commit.
- `npm test` (vitest, raíz) si tocaste helpers puros.
- **Smoke UI manual** (checklist para el autor; Claude no lo automatiza):
  1. Registrar un lote AUTH de 3 periodos → aparece en el listado con sus valores.
  2. Lápiz → modal precargado (hora, funcionario, descripción, periodos correctos).
  3. Cambiar un valor, agregar un periodo, quitar otro, editar la descripción → Guardar → el listado
     refleja los cinco cambios sin recargar la página.
  4. Vaciar todos los periodos → Guardar deshabilitado, el texto señala Eliminar.
  5. Basurero → confirmación → el renglón desaparece y, si estaba publicado, la marca verde pasa al
     lote anterior de ese periodo.
  6. Lote REDESP con periodos pasados: el valor está bloqueado, la hora y la descripción no.
  7. Entrar con un cargo solo-lectura → el listado se ve completo **sin** lápiz ni basurero.

## Actualizar ESTADO.md (obligatorio antes de cerrar)

- Marcá E4 ✅ + bloque con Archivos tocados / Verificación (build + resultado del smoke manual) /
  Desviaciones.

## Commit

```bash
git add src/ prompts/D-057-correccion-lote-mand/ESTADO.md
git commit -m "$(cat <<'EOF'
feat(MAND): corrección y borrado por lote desde el listado del día

<por qué: el modal mantiene separada la captura (grilla append-only, nace vacía)
de la corrección (histórico del día); cargar el lote en la grilla habría revivido
el espejo persistente que D-056 eliminó a propósito>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
