# D-058 · E3 — `seleccionable` + los 8 tipos de evento espejo

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 y E2 figuren ✅.**
3. Releé la convención 11 y la 26 de `CLAUDE.md` (seed reconstruido en cada arranque; el gotcha de
   `tipo_evento_id` de D-053).

## Alcance de esta etapa

**Entra:** la columna `seleccionable`, el filtro del endpoint de catálogos y el seed de los 8 tipos
espejo. Es la infraestructura que E4 necesita para poder insertar copias.
**No entra:** ninguna copia, ningún enganche en `mand.js`.

## Por qué existe `seleccionable`

`lov_bit.tipo_evento` **no tiene columna de visibilidad**, y
`GET /api/catalogos/bitacoras/:id/tipos-evento` (`routes/catalogos.js:58`) devuelve **todos** los
tipos sin filtrar — ese endpoint alimenta el selector de `GrillaRegistros`. Sin la columna,
**cualquier tipo espejo sembrado se vuelve tecleable a mano**: el JdT vería `Autorización` como
opción en `SALAJDT` y podría crear un asiento que no refleja ningún lote. Sin `origen_lote_id`, esa
fila es indistinguible de un reflejo real para el generador del Excel e imposible de rastrear —
justo la doble digitación que REQ-02 viene a eliminar.

## Tareas

1. Migración idempotente en `server/db.js`, `initDB()` (flag `F33.A1`, patrón `cantidad_max` de
   D-034):
   ```sql
   IF COL_LENGTH('lov_bit.tipo_evento','seleccionable') IS NULL
     ALTER TABLE lov_bit.tipo_evento ADD seleccionable BIT NOT NULL
       CONSTRAINT DF_tipo_evento_seleccionable DEFAULT 1 WITH VALUES;
   ```
   **`seleccionable`, no `activo`** — deliberado: `activo` se confunde con "bitácora activa". Los
   tipos existentes quedan en `1` por el `DEFAULT`.
2. Seed de los **8** tipos espejo (4 tipos × 2 bitácoras) con `seleccionable = 0`, en el bloque de
   catálogos de `db.js` (que se reconstruye en **cada arranque** — un `INSERT` one-shot no sirve).
   Idempotente por `NOT EXISTS (bitacora_id, nombre)`, y con un `UPDATE` complementario que fuerce
   `seleccionable = 0` en esas 8 filas, para que un seteo accidental quede revertido en el próximo
   arranque (mismo patrón que el `oculta` de CIET, `db.js:861`).

   | Bitácora | Tipos |
   |---|---|
   | `SALAJDT` | `Autorización` · `Pruebas` · `Redespacho` · `Cambio de Disponibilidad` |
   | `SALAING` | `Autorización` · `Pruebas` · `Redespacho` · `Cambio de Disponibilidad` |

   > **Nombres literales**: `Autorización` con tilde y `Pruebas` **en plural** — son los exactos de
   > MAND (`Autorización`(20) · `Pruebas`(21) · `Redespacho`(22)) y `Cambio de Disponibilidad` el
   > exacto de DISP (23). Si no se copian literales, el histórico termina con dos etiquetas para lo
   > mismo.
   >
   > El cuarto se siembra **aunque el reflejo de DISP esté fuera de alcance** (respuesta 13): así no
   > hay que volver a tocar el seed cuando llegue su ADR.
   >
   > Sembrar tipos **no** cambia la matriz de permisos: el operador sigue tecleando en
   > `Evento General`.
3. `server/routes/catalogos.js:58`: agregar `WHERE … AND seleccionable = 1` al
   `GET /bitacoras/:id/tipos-evento`. **El reflejo NO pasa por este endpoint**: resuelve el
   `tipo_evento_id` por `(bitacora_id, nombre)` directo contra la tabla.
4. Tests. Extender `server/tests/catalogo_bitacoras.test.js` (o crear
   `server/tests/tipos_evento_espejo.test.js` si queda más limpio) y **engancharlo al script `test`
   de `server/package.json`** si es archivo nuevo — el guard de D-041 existía y no corría por
   olvidar esto:
   - Las 8 filas existen tras `initDB()`, con los nombres literales y `seleccionable = 0`.
   - `GET /api/catalogos/bitacoras/<SALAJDT>/tipos-evento` **no** las devuelve, y **sí** devuelve
     `Evento General`.
   - Los tipos preexistentes de MAND y DISP siguen con `seleccionable = 1`.
   - Correr `initDB()` dos veces no duplica filas (idempotencia).
   - `guard_tipo_evento_coherente.test.js` sigue verde.

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado. **El arranque del servidor corre `initDB()`
  contra la BD productiva**: revisá el log de la migración y confirmá con una query que las 8 filas
  quedaron con `seleccionable = 0` y que ninguna otra fila cambió de valor.
- `npm run build` no hace falta (no se tocó front) — salvo que el selector de tipos rompa por el
  cambio de payload, cosa que no debería: solo desaparecen opciones que nadie usaba todavía.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E3 ✅. Bloque `### E3 — seleccionable + tipos espejo  ✅` con **Archivos tocados**,
  **Verificación** (incluida la query de comprobación en la BD) y **Desviaciones**.
- Anotá en "Datos descubiertos" los `tipo_evento_id` reales que quedaron sembrados — sirven para
  depurar E4, aunque **el código nunca debe cachearlos**.

## Commit
```bash
git add server/db.js server/routes/catalogos.js server/tests/ server/package.json
git commit -m "$(cat <<'EOF'
feat(catalogos): tipos de evento espejo para el reflejo + columna seleccionable

Los asientos reflejados de Operación 24h necesitan un tipo_evento propio en SALAJDT
y SALAING, porque no hay FK ni CHECK que ate registro.bitacora_id con
tipo_evento.bitacora_id y el drift es invisible hasta que alguien edita el registro
(D-053). Se siembran los cuatro nombres literales del catálogo — Autorización,
Pruebas, Redespacho y Cambio de Disponibilidad — en las dos bitácoras.

El problema que resuelve `seleccionable`: la tabla no tenía columna de visibilidad y
el endpoint de catálogos devolvía todos los tipos, así que cualquier tipo sembrado se
volvía tecleable a mano. El JdT habría podido crear "una autorización" en SALAJDT que
no refleja ningún lote — sin origen_lote_id, indistinguible de un reflejo real e
imposible de rastrear: exactamente la doble digitación que REQ-02 elimina.

El cuarto tipo se siembra aunque el reflejo de DISP quede para otro ADR: el seed se
reconstruye en cada arranque y así no hay que volver a tocarlo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
