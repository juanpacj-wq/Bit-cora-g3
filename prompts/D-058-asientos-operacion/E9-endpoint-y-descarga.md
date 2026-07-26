# D-058 · E9 — Endpoint del libro mensual + selector de mes y botón de descarga

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md` (en particular el **mapa de índices de estilo** que
   E7 anotó en "Datos descubiertos").
2. **Verificá que E1..E8 figuren ✅.**
3. Releé §3 y §6 de `docs/requerimientos/REQ-06-excel-eventos-operacion.md`.

## Alcance de esta etapa

**Entra:** el endpoint que arma y sirve el `.xlsx`, y el selector de mes + botón en Operación 24h.
Es la etapa que junta E7 (cómo se escribe) con E8 (qué se escribe).
**No entra:** nada de Combustibles (REQ-01), ni un apartado de Reportes, ni envío por correo.

## Tareas

### Backend

1. `server/utils/f03-libro.js` (E7) gana el render de las filas: recibe la estructura de `armarMes`
   (E8) y produce el `sheetData` de cada hoja según el layout de §7, usando los índices de estilo
   que E7 documentó.
   - `FECHA:` = el día de la hoja en `dd/mm/aaaa`. **`Fecha: 01/06/2017` de la fila 4 NO se toca**:
     es la fecha de emisión del formato controlado.
   - La hora se escribe como **número con formato `HH:MM`** (fracción de día), como el original —
     no como texto. Es lo que permite ordenar y filtrar en Excel.
   - Los tres bloques **crecen hacia abajo**: recalcular `dimension`, `mergeCells` y `Print_Area`
     con el alto real (E7 ya expone esos recálculos).
   - Un bloque sin eventos deja su encabezado y ninguna fila (§7.2-5 / criterio 5 de REQ-06).
2. Endpoint en `server/routes/mand.js` (**no tocar `server.js`** — D-037):
   ```
   GET /api/sala-de-mando/reporte-mensual?mes=YYYY-MM
   ```
   - **Gate:** `hasPermisoBitacora(sesion, MAND_ID, 'puede_crear')` → `403` si no (RQ-06.11/12).
     **Data-driven, nunca por cargo.** Ojo: MAND es visible para **todos** por la matriz
     (`WHEN b.codigo = 'MAND' THEN 1` en `puede_ver`), así que el gate de descarga **no** puede
     derivarse de la visibilidad.
   - Validación `^\d{4}-(0[1-9]|1[0-2])$` → `400` si no matchea.
   - **Mes futuro** → `400 mes_futuro` (paridad con el `fecha_futura` de COMB). El mes se compara
     contra el mes **Bogotá** en curso, con `fechaBogotaStr` — **nunca** `new Date().getMonth()`
     (D-020).
   - **No** exige `planta_id`: el libro trae **las dos unidades** siempre, sin importar en qué
     unidad esté la sesión (RQ-06.3, decisión E).
   - Respuesta: el `Buffer` con
     `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` y
     `Content-Disposition: attachment; filename*=UTF-8''…`. Nombre calcado del original:
     `YYYY_MM_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx` (el `filename*` es necesario
     por la tilde y los espacios).
   - Errores por `responderError` (D-032): jamás `err.message` crudo.
   - **Un mes vacío no es error**: devuelve el libro con todas sus hojas (RN-06.h).
   - Generación **en memoria**, sin streaming; el volumen es de cientos de KB (REQ-06 §5.4).

### Front

3. `src/components/SalaDeMando/SalaDeMandoGrid.jsx`: en la barra superior, `<input type="month">` +
   botón **Descargar**.
   - Default: el mes en curso **en Bogotá**. `max` = ese mismo mes (el futuro no se puede pedir).
   - Gateado por `puedeCrear` (el mismo flag que ya gobierna la corrección). Sin permiso, el botón
     no se pinta — y si alguien invoca el endpoint igual, el backend responde `403` (criterio 2).
   - Estado de carga mientras se genera, y manejo de error ramificando por `codigo`, nunca por texto.
4. Subestado en el hash (D-035): `#/op24h?mes=YYYY-MM` con `replaceState`.
   - Tocar `src/routing/appRoute.js` para que `op24h` acepte el parámetro `mes`.
   - **No** reutilizar el `fecha` de COMB ni el día de la grilla: son cosas distintas. La grilla
     sigue siendo siempre hoy (D-017 / D-056) y **no** se le agrega selector de fecha.
5. `src/hooks/useSalaDeMando.js`: la descarga (fetch con credenciales → `blob` → `URL.createObjectURL`
   → click sintético → `revokeObjectURL`). Nada de abrir la URL directo: el endpoint va tras
   `requireEntra` y necesita la cookie de sesión.

## Verificación (antes de commitear)
- `npm run build` verde.
- `cd server && npm test` con el baseline esperado. Tests en `sala_de_mando_batch.test.js` (D-055):
  - `403` para un cargo con solo `puede_ver` en MAND (criterio 2 de REQ-06).
  - `200` + `Content-Type` correcto para un cargo con `puede_crear`.
  - `400 mes_futuro`; `400` por formato inválido.
  - Un mes de 31 días produce **31 hojas** en orden (criterio 4); uno de 30, 30; febrero, 28.
  - La descarga **no cambió nada en la BD** (criterio 10 / RN-06.f).
- **Smoke manual del autor** (no automatizable sin Playwright; dejalo escrito en `ESTADO.md`):
  1. Entrar como JdT → aparece el selector con el mes en curso y el botón.
  2. Descargar el mes en curso → el archivo abre en Excel **sin advertencia de corrupto**
     (criterio 9), con el logo y el encabezado GENE-F03.
  3. Cambiar el mes en el selector → la URL muestra `#/op24h?mes=…` y sobrevive a F5.
  4. Entrar con un cargo de solo lectura → el botón no está.
  5. Revisar una hoja con eventos: dos unidades mezcladas, orden ascendente, tres bloques
     (criterio 6). Con la adopción actual va a salir casi vacío — **es correcto**.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E9 ✅. Bloque con **Archivos tocados**, **Verificación** (incluido el resultado real del
  smoke, punto por punto) y **Desviaciones**.

## Commit
```bash
git add server/routes/mand.js server/utils/f03-libro.js src/components/SalaDeMando/SalaDeMandoGrid.jsx src/hooks/useSalaDeMando.js src/routing/appRoute.js server/tests/sala_de_mando_batch.test.js
git commit -m "$(cat <<'EOF'
feat(MAND): descarga del libro mensual F03 con las dos unidades (REQ-06)

Los eventos del mes se consolidaban a mano en un formato controlado externo aunque el
dato ya estuviera todo en el sistema. Ahora se descargan como un solo libro por mes,
con GEC3 y GEC32 dentro: el formato de referencia las nombra juntas en la misma frase
y partirlo por planta obligaría a duplicar o mutilar esos renglones.

El selector de mes existe porque RQ-06.4, leído literal, falla en su caso de uso
principal: pedía "el mes de la fecha en curso del apartado", pero Operación 24h no
tiene selector de fecha — es siempre hoy —, así que el mes cerrado quedaba inalcanzable
el día 1, justo cuando el F03 se consolida. El mes viaja en el hash como subestado, así
que la vista sobrevive a F5.

El gate es puede_crear en MAND y no puede derivarse de la visibilidad: la bitácora es
visible para todos los cargos por la matriz. Un mes sin eventos no es error: devuelve el
libro con todas sus hojas vacías.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
