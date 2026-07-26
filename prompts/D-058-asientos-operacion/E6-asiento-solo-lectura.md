# D-058 · E6 — El asiento reflejado es de solo lectura en su destino

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1..E5 figuren ✅.**
3. Releé la convención 24 de `CLAUDE.md` (D-049) y `REQ-02` §3.2 y §5.1-3.

## Alcance de esta etapa

**Entra:** que el asiento reflejado no se pueda editar ni borrar desde la bitácora de Sala — ni por
el front ni por el endpoint — y que se identifique visiblemente como reflejado.
**No entra:** filtrar u ocultar los reflejados en la grilla (REQ-02 §8.3, no pedido).

## El problema concreto

El autor de la copia **es el autor del origen** (RN-02.c). Y `canEditarRegistro` (D-049) autoriza
justamente al autor. O sea: **hoy, sin este cambio, quien registró el lote podría editar o borrar su
propio asiento reflejado desde SALAJDT/SALAING**, desincronizándolo del origen — lo contrario de
RQ-02.6.

Ojo con el matiz: esto **no** es reintroducir un bypass por cargo. D-049 y D-057 prohíben *ampliar*
quién puede editar; acá se *restringe*. La excepción de MAND sigue viviendo donde vive (el gate
`puede_crear` del endpoint por lote) y **no se toca**.

## Tareas

1. `server/middleware/permissions.js`, `canEditarRegistro`: agregar la condición de que el registro
   **no sea un asiento reflejado** (`campos_extra.origen_lote_id` presente → `false`), antes o
   después de las tres que ya están. Comentar el porqué en una línea, con la trampa del autor.
   - **Sin bypass por cargo. Sin excepción para ADMIN** (cero bypass, D-039/D-049).
2. `server/routes/registros.js`, `GET /activos` (`:91`): el espejo SQL por fila `puede_editar` debe
   dar `0` para los reflejados. **El helper y su espejo se cambian JUNTOS** — es la regla de D-049 y
   es lo único que impide que la UI y el enforcement divergan.
3. `PUT`/`DELETE /api/registros/:id`: verificar que el rechazo llega por `canEditarRegistro` y que
   el mensaje es útil (`codigo` estable, texto amigable en español; nada de `err.message` crudo —
   D-032). El front ramifica por `codigo`, nunca por texto.
4. Front — `src/BitacorasGecelca3.jsx` (`GrillaRegistros` / `RegistroRow`):
   - El asiento reflejado **no muestra lápiz ni basurero** (ya deriva del flag advisory
     `puede_editar`, D-049: si el backend manda `0`, la fila queda sin controles). Verificalo, no lo
     asumas.
   - Se identifica visiblemente como **asiento reflejado, con su origen** (RQ-02.5): un chip o
     rótulo tipo "Operación 24h" es suficiente. No inventar iconografía nueva; reusar el patrón del
     chip "Bloqueado" que ya existe.
   - El ojo sigue expandiendo la descripción en lectura, como en cualquier fila ajena.
5. Tests:
   - En `server/tests/registros_solo_autor.test.js` (la **cara negativa** del par, D-057): el
     **autor** de un asiento reflejado recibe error al hacer `PUT` y al hacer `DELETE` sobre su
     copia. Es el caso que sin este cambio pasaría.
   - Que `GET /activos` devuelve `puede_editar = false` para la copia y `true` para un registro
     tecleado a mano por el mismo usuario en la misma bitácora (el contraste es el test).
   - Regresión: en el resto de bitácoras sigue rigiendo "solo el autor" (D-049 intacto) y en MAND
     sigue funcionando la corrección por no-autor (`sala_de_mando_batch`, criterio 5 de REQ-04). **El
     par se lee junto**: no toques uno sin correr el otro.

## Verificación (antes de commitear)
- `npm run build` verde.
- `cd server && npm test` con el baseline esperado, con atención a `registros_solo_autor.test.js` y
  `sala_de_mando_batch.test.js`.
- Smoke manual: abrir `SALAJDT` con el usuario que registró el lote y confirmar que la fila del
  asiento se ve identificada y sin controles de edición.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E6 ✅. Bloque con **Archivos tocados**, **Verificación** y **Desviaciones**.

## Commit
```bash
git add server/middleware/permissions.js server/routes/registros.js src/BitacorasGecelca3.jsx server/tests/
git commit -m "$(cat <<'EOF'
fix(SALA): el asiento reflejado no se edita ni se borra en su destino (RQ-02.5/6)

Con el reflejo activo aparecía un hueco real: el autor de la copia es el autor del
origen (RN-02.c) y canEditarRegistro autoriza justamente al autor, así que quien
registró el lote podía editar su propio asiento en SALAJDT/SALAING y
desincronizarlo del origen.

Esto NO reintroduce un bypass por cargo: D-049 prohíbe AMPLIAR quién edita, y acá se
restringe. La excepción de MAND sigue donde vive, en el gate puede_crear del endpoint
por lote, y no se tocó.

El helper y su espejo SQL del GET /activos se cambian juntos, como manda D-049: es lo
único que impide que la UI ofrezca una acción que el backend rechaza. La grilla ya
deriva lápiz y basurero de ese flag, así que la fila queda identificada por su origen
y sin controles.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
