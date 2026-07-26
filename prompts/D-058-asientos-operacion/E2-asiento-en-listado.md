# D-058 · E2 — El asiento en el listado del día + copiar (REQ-04 §8.1 y §8.3)

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 figure ✅.** Esta etapa consume el motor; sin él no hay nada que pintar.
3. Releé "Decisiones / desviaciones acumuladas" y "Datos descubiertos" de `ESTADO.md`.

## Alcance de esta etapa

**Entra:** el campo `asiento` en `GET /api/sala-de-mando/lotes`, su presentación en el listado del
día y las dos acciones de copiar. Cierra el último bloqueante vivo de REQ-04 (§8.1) y su §8.3.
**No entra:** el reflejo a Sala, el Excel, ni ningún cambio a la captura o a la corrección.

## Tareas

1. `server/routes/mand.js`, `GET /lotes` (`:124`): agregar `asiento` a cada objeto de `lotes`,
   armado con `asientoLote(...)` del motor de E1, a partir de la metadata que el endpoint ya
   deriva del grupo (`tipo`, `funcionariocnd`, `detalle`, `periodos`) más el `planta_id` del query.
   - **El backend arma el texto y el front solo lo pinta** (respuesta 6): una sola implementación.
   - **No** meter la hora dentro de `asiento`: `hora_llamada` ya viaja aparte y el front la pinta en
     su columna. Un lote sin hora (migrado por `F32.A1`) igual tiene asiento.
   - No cambiar el orden del listado (`hora_llamada DESC`, sin-hora al final, desempate
     `creado_en DESC`): sigue siendo el correcto para pantalla (RN-04.a).
2. `src/components/SalaDeMando/LotesDelDia.jsx`: mostrar el asiento en el renglón.
   - Que sea **legible y seleccionable**, con el texto completo (no truncado con `…`).
   - Las columnas existentes (tipo, hora, funcionario, descripción, periodos, valores, autor, y las
     acciones con `puedeCrear`) **no se quitan**: el asiento se suma, no reemplaza.
3. Acciones de copiar (REQ-04 §8.3):
   - Botón por renglón → copia **ese** asiento.
   - Botón de cabecera → copia **el día completo**: un renglón por lote, cada uno como
     `HH:MM — <asiento>`, en el mismo orden que se ve en pantalla. Los lotes sin hora van sin
     prefijo (nunca `null —`).
   - Usar `navigator.clipboard.writeText` con **fallback** silencioso si no está disponible (el
     portapapeles exige contexto seguro; en HTTP plano no existe). Feedback breve de "copiado", sin
     modal.
   - Los botones son visibles para **cualquiera que vea el listado**, con o sin `puedeCrear`:
     copiar no es escribir (RN-04.f).
4. `src/hooks/useSalaDeMando.js`: si hace falta exponer el nuevo campo, hacerlo sin cambiar la forma
   del resto de la respuesta.

## Verificación (antes de commitear)
- `npm run build` (raíz) verde. **Un build roto bloquea el commit.** (`npm run lint` no existe.)
- `cd server && npm test` con el baseline esperado. La cobertura de MAND va **en
  `sala_de_mando_batch.test.js`** (D-055 — todos los tests de MAND viven ahí; dos archivos sobre la
  misma fixture se dan 401 mutuo por sesión única).
  Casos: un lote de AUTH devuelve `asiento` con el texto esperado; un lote **sin `hora_llamada`**
  también trae `asiento`; el asiento **no** contiene la hora.
- Smoke manual para el autor: registrar un lote y verificar que el renglón muestra el asiento y que
  los dos botones de copiar dejan en el portapapeles lo esperado.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E2 ✅ con resumen de una línea.
- Bloque `### E2 — El asiento en el listado del día  ✅` con **Archivos tocados**, **Verificación** y
  **Desviaciones**.

## Commit
```bash
git add server/routes/mand.js src/components/SalaDeMando/LotesDelDia.jsx src/hooks/useSalaDeMando.js server/tests/sala_de_mando_batch.test.js
git commit -m "$(cat <<'EOF'
feat(MAND): el listado del día muestra el asiento normalizado y se puede copiar

Cierra el último bloqueante vivo de REQ-04 (§8.1): el "formato de WhatsApp" con el
que estos eventos se comunican al grupo operativo dejaba de redactarse a mano cada
vez. El texto lo arma el backend con el motor de asientos y lo devuelve en
GET /lotes; el front solo lo pinta, para que el renglón de pantalla, la copia en
Sala y el libro mensual no puedan divergir.

La hora NO viaja dentro del asiento: hora_llamada ya va aparte y cada consumidor la
ubica donde corresponde. Un lote migrado sin hora igual tiene asiento.

Se suman copiar-renglón y copiar-el-día (§8.3), visibles para cualquiera que vea el
listado: copiar no es escribir.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
