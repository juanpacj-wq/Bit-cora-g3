# D-053 · E1 — Catálogo + matriz de permisos + espejo IA

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. Verificá que E0 figure ✅ en el tablero de `ESTADO.md`.
3. Releé "Decisiones / desviaciones acumuladas" y "Datos descubiertos".
4. Creá el branch si no existe: `git checkout -b feat/split-sala-por-rol-2026-07`.

## Alcance de esta etapa

**Entra:** el catálogo pasa de 1 bitácora SALA a 3 (SALAJDT/SALAING/SALAOP), la matriz de permisos
expresa la tabla objetivo, el espejo de IA se sincroniza, y el alias de deep link evita que los
favoritos viejos caigan al fallback mudo.

**NO entra:** la migración de datos (E2), los tests (E3), los docs/ADR (E4). Al terminar E1 las 3
bitácoras existen y los permisos son correctos, pero **todos los registros históricos siguen en
`bitacora_id=14` = SALAJDT** — eso es esperado y lo resuelve E2.

> Ojo con el orden: `npm test` puede quedar rojo al cerrar E1 (`ia_cliente.test.js` itera `'SALA'`
> literal y `registros_solo_autor.test.js` depende del fixture SALA). **Es esperado y se arregla en
> E3.** Documentá el resultado real en `ESTADO.md`; no intentes arreglar tests acá.

## Tareas

1. **Rename previo al MERGE** — `server/db.js`, junto al bloque existente de `db.js:760-761`
   (`CAL`→`CALDERA`, `TURB`→`TURBO`), que es el precedente exacto:
   ```sql
   UPDATE lov_bit.bitacora SET codigo='SALAJDT' WHERE codigo='SALA';
   ```
   **Crítico:** esto NO puede ir dentro del `MERGE` — matchea `ON t.codigo = s.codigo`, así que
   cambiar el código desde el MERGE insertaría una fila nueva y dejaría SALA huérfana. Idempotente:
   tras el primer arranque el `WHERE` no matchea.
   Añadí un comentario corto explicando el porqué (el próximo lector va a querer moverlo al MERGE).

2. **MERGE de bitácoras** — `server/db.js:791-815`. Reemplazá la fila
   `('Sala de Mando Operativa', 'SALA', 'Monitor', 0, NULL, 3, 1)` por tres. Criterios:
   - `codigo`: `SALAJDT`, `SALAING`, `SALAOP` (caben en `VARCHAR(10)`).
   - `nombre`: visible en el sidebar. Propuesta: `'Sala de Mando - Jefe de Turno'`,
     `'Sala de Mando - Ingeniero de Operación'`, `'Sala de Mando - Operador'`. **Anotá el valor final:
     el espejo de `prompts.js` (tarea 4) debe calzar carácter por carácter.**
   - `formulario_especial`: `0` (genéricas). `definicion_campos`: `NULL`.
   - `orden`: SALAJDT conserva `3`. SALAING/SALAOP: valores libres contiguos. **No uses `11`** (ya
     colisiona entre CIET y COMB). Verificá el catálogo antes de elegir.
   - `icono`: **debe estar en `ICON_MAP`** (`src/BitacorasGecelca3.jsx:70-73`: `Activity, Settings,
     Flame, Droplets, Gauge, Zap, Cpu, FlaskConical, Leaf, FileCheck, MonitorCog`). El `'Monitor'`
     actual **no está** y ya cae al fallback `FileText` — no lo repliques.
   - `activa`: `1` en las tres.

3. **Matriz de permisos** — `server/db.js:920-990` (bloque `WITH matriz AS`, transacción `matrizTx`):
   - `puede_ver` (`db.js:946`): `Operador de Planta - Sala de Mando` → `b.codigo='SALAOP'`.
   - `puede_crear` (`db.js:974`): **partí el `IN` compartido**. Hoy JdT e IngOp comparten una cláusula;
     con el split dejan de tener filas idénticas:
     ```sql
     WHEN c.nombre = 'Ingeniero Jefe de Turno' THEN CASE WHEN b.codigo IN ('DISP','SALAJDT') THEN 1 ELSE 0 END
     WHEN c.nombre = 'Ingeniero de Operación'  THEN CASE WHEN b.codigo IN ('DISP','SALAING') THEN 1 ELSE 0 END
     ```
     Sacá `'AUTH'` del `IN`: es código muerto (AUTH está sembrada `activa=0` en `db.js:801` y la matriz
     filtra `WHERE b.activa=1`).
   - `puede_crear` (`db.js:980`): `Operador de Planta - Sala de Mando` → `b.codigo='SALAOP'`.
   - **Corregí el comentario de `db.js:904-905`**, que afirma que JdT e IngOp *"tienen filas idénticas
     (mismo poder operativo)"*. Deja de ser cierto: es justo lo que este ADR cambia.
   - **NO toques** el override defensivo DISP (`db.js:1147-1165`): JdT/IngOp/Admin ya están en su `IN`
     y siguen creando en DISP. Solo verificá que el split no los saque.

4. **Espejo de IA** — `server/utils/ia/prompts.js:19-22`. La entrada `SALA` se vuelve tres
   (`SALAJDT`, `SALAING`, `SALAOP`). El `nombre` debe ser **idéntico carácter por carácter** al del
   seed de la tarea 2 o falla el guard `catalogo_bitacoras.test.js:39-49` en ambas direcciones
   (declara-rol-sin-bitácora / drift de nombre). El `rol` se redacta por puesto, en el estilo de las
   entradas vecinas: JdT → coordinación del turno, consignas de despacho y comunicación con el CND;
   IngOp → maniobras operativas y seguimiento de la unidad; Op → operación de sala, alarmas y
   maniobras de campo. Mantené el comentario de cabecera (D-047/D-052) que explica por qué se duplica.

5. **Alias de deep link** — `src/routing/appRoute.js`. Mapa de alias para que `#/b/SALA` resuelva a
   `SALAJDT` en `parseHash`. Sin él, un favorito viejo cae al fallback mudo `bitacorasPermitidas[0]`
   (`BitacorasGecelca3.jsx:1944`) y `replaceState` reescribe la URL sin avisar. Mantenelo como dato
   (un objeto literal) para que el test lo cubra sin montar el dashboard.

## Verificación (antes de commitear)

- `npm run build` (front) verde — el alias es lo único que se toca de `src/`.
- Reiniciá el backend (`cd server && node --watch --env-file=../.env server.js`) y confirmá en BD:
  ```sql
  SELECT bitacora_id, nombre, codigo, orden, activa, oculta
  FROM lov_bit.bitacora WHERE codigo LIKE 'SALA%' ORDER BY orden;
  -- Esperado: 3 filas; SALAJDT conserva bitacora_id=14 y orden=3.

  SELECT b.codigo, te.tipo_evento_id, te.nombre, te.es_default
  FROM lov_bit.bitacora b JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
  WHERE b.codigo LIKE 'SALA%';
  -- Esperado: cada una con su 'Evento General' propio (es_default=1). SALAJDT sigue con el id 17.

  SELECT c.nombre AS cargo, b.codigo, p.puede_ver, p.puede_crear
  FROM lov_bit.cargo_bitacora_permiso p
  JOIN lov_bit.cargo c ON c.cargo_id = p.cargo_id
  JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
  WHERE b.codigo LIKE 'SALA%' ORDER BY c.nombre, b.codigo;
  -- Contrastá contra la matriz objetivo de PREGUNTAS-D-053.md.
  ```
- **Confirmá que el arranque es idempotente**: reiniciá una segunda vez y verificá que sigue habiendo
  exactamente 3 filas SALA* (si el rename estuviera mal puesto, aparecería una 4.ª o SALA huérfana).
- Verificá que JdT e IngOp **conservan** `puede_crear` en DISP (que el split no los sacó).
- `cd server && npm test` — **se espera rojo** en `ia_cliente` y `registros_solo_autor` (ver Alcance).
  Registrá el resultado exacto en `ESTADO.md`; se arregla en E3.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E1 ✅ con resumen de una línea.
- Bloque `### E1 — Catálogo + matriz + espejo IA  ✅` con **Archivos tocados**, **Verificación**
  (resultado real de build/tests, incluidos los rojos esperados) y **Desviaciones**.
- En "Datos descubiertos": los `bitacora_id` y `orden` finales de SALAING/SALAOP, y los `nombre`
  exactos elegidos (E2 y E4 los necesitan).

## Commit

```bash
git add server/db.js server/utils/ia/prompts.js src/routing/appRoute.js prompts/D-053-split-sala-por-rol/ESTADO.md
git commit -m "$(cat <<'EOF'
feat(SALA): partir SALA en SALAJDT/SALAING/SALAOP (catálogo + matriz)

SALA era la única bitácora del catálogo donde varios cargos compartían puede_crear
(JdT, IngOp y Op de Sala escribían en la misma grilla), lo que mezclaba tres
responsabilidades operativas en un solo hilo e impedía leer el histórico por rol.

Cada rol pasa a tener su bitácora: SALAJDT (solo JdT), SALAING (solo IngOp),
SALAOP (solo Op de Sala). El resto de cargos las ve en solo-lectura; el rol ADMIN
crea en las tres por la misma matriz data-driven (D-039, sin bypass).

SALA se renombra a SALAJDT conservando bitacora_id=14 y orden=3; SALAING y SALAOP
son nuevas. El rename va como UPDATE previo al MERGE (patrón de CAL→CALDERA,
db.js:760): el MERGE matchea por codigo, así que hacerlo adentro habría insertado
una fila nueva y dejado SALA huérfana.

Consecuencia estructural: JdT e IngOp dejan de tener filas idénticas en la matriz
— se parte el IN compartido preservando DISP para ambos. Se retira 'AUTH' de esa
cláusula: es código muerto (AUTH está activa=0 y la matriz filtra activa=1).

Los registros existentes siguen en SALAJDT; su reparto por cargo del autor va en
la migración F30.A1 (E2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias — eso es exclusivo de `E4` y requiere
> confirmación humana.
