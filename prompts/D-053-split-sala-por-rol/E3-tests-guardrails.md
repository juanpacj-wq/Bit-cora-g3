# D-053 · E3 — Tests + guardrails

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 y E2 figuren ✅.**
3. Releé "Datos descubiertos": E1 anotó los `nombre`/`orden`/`bitacora_id` finales.

## Alcance de esta etapa

**Entra:** reparar los tests que el split rompe, **cerrar el falso verde** de `registros_solo_autor`,
fijar la matriz objetivo con un test nuevo, y dejar un guard permanente de integridad
`tipo_evento_id` ↔ `bitacora_id`. Al cerrar E3 la suite vuelve a verde.

**NO entra:** docs/ADR (E4).

## El punto crítico: el falso verde de `registros_solo_autor`

`server/tests/registros_solo_autor.test.js` tiene un test que **va a seguir pasando en verde mientras
deja de probar lo que dice probar**. Es el riesgo más sutil de todo el flujo.

Su test 2 —*"No-autor **CON** `puede_crear` en la misma bitácora (JdT sobre registro de IngOp en SALA)
→ 403 `solo_autor`"*— usa SALA precisamente porque hoy es la **única bitácora del catálogo donde dos
cargos comparten `puede_crear`**. El comentario de `:41-43` lo dice explícito. Tras el split ese
fixture **desaparece del catálogo entero**: JdT ya no tiene `puede_crear` en la bitácora del IngOp, así
que el test pasaría por la rama *"sin permiso"* y colapsaría en un duplicado del test 3 — sin que nada
se ponga rojo.

**Arreglo:** usar **`Administrador y Debugging` como el no-autor**. Tiene `puede_crear=1` en todas las
bitácoras activas (D-039, contrato fijado por `rol_admin_debugging.test.js:52-71`), así que cualquier
bitácora vuelve a ser un fixture válido. Además el test pasa a probar **directamente** la afirmación
más fuerte de D-049: *"NADIE tiene excepción — tampoco el rol ADMIN"*. Queda mejor cubierto que antes.

## Tareas

1. **Fixtures nuevos** — `server/tests/helpers.js`. Hoy `TEST_USERS` (`:61-66`) solo trae `jdt`,
   `ingOp`, `gerente`, `ingQuim`. Agregá:
   - `opSala` → cargo `'Operador de Planta - Sala de Mando'`
   - `admin` → cargo `'Administrador y Debugging'`

   **Regla dura (convención 14 de CLAUDE.md, D-044):** nacen con **`es_sintetico=1`** y se limpian por
   **`deactivateSyntheticSessions()`**, NUNCA por username. La suite corre contra la BD productiva
   (D-030); el guard `zzz_session_leak_guard.test.js` (último del script `test`) falla nombrando al
   ofensor si una sesión sintética queda activa en planta real, y `es_sintetico=1` es lo que impide que
   el builder de `conformacion_turno` los grabe en el histórico inmutable.

2. **Reescribir `registros_solo_autor.test.js`** (ver arriba):
   - Test 1 (autor edita/elimina lo suyo): el IngOp crea en **SALAING** (donde sí tiene `puede_crear`).
   - Test 2: **Admin** como no-autor sobre el registro del IngOp en **SALAING** → 403 `solo_autor`.
     Actualizá el comentario `:41-43` para que explique el nuevo fixture y **por qué** (si no, el
     próximo lector lo "arregla" de vuelta a un cargo sin permiso y reintroduce el falso verde).
   - Test 3 (regresión del bypass `puede_cerrar_turno`): sigue con QUIM, intacto.
   - Test 4 (Gerente sobre ajeno) y test 5 (espejo `puede_editar`): reapuntar de `BIT_SALA` a
     `BIT_SALAING`. El test 5 necesita además que el JdT **siga viendo** la bitácora — se cumple
     (`puede_ver=1` transversal), pero verificalo explícitamente.
   - El guard `:46` (`assert.ok(BIT_SALA && BIT_QUIM)`) pasa a las nuevas. **Ojo:** `helpers.js:158-161`
     hace `SELECT … FROM lov_bit.bitacora` **sin filtrar `activa`** → un guard de existencia no detecta
     una bitácora muerta. Si querés blindarlo, filtrá `activa=1`.

3. **`server/tests/ia_cliente.test.js:76`** — el array
   `['CALDERA','ANAL','SALA','AGUA','TURBO','MAQU','CYC','QUIM']` itera `'SALA'` literal y **rompe el
   CI**. Pasa a 10 códigos con las tres SALA*. Actualizá el texto del test ("las 8 bitácoras genéricas"
   → 10).

4. **Test nuevo de la matriz** — `server/tests/split_sala_permisos.test.js`. Estático contra BD (como
   `rol_admin_debugging.test.js`), fija la tabla objetivo de `PREGUNTAS-D-053.md`:
   - JdT: `puede_crear=1` **solo** en SALAJDT de las tres; `puede_ver=1` en las tres.
   - IngOp: `puede_crear=1` **solo** en SALAING; `puede_ver=1` en las tres.
   - Op de Sala de Mando: `puede_crear=1` **solo** en SALAOP; y **`puede_ver=0` en SALAJDT y SALAING**
     (la matriz objetivo dice `—`, no `V` — este es el assert que más fácil se rompe por accidente).
   - Admin: `puede_ver=1` y `puede_crear=1` en las tres.
   - Gerente e IngQuímico: `puede_ver=1`, `puede_crear=0` en las tres.
   - **Regresión de DISP**: JdT e IngOp conservan `puede_crear=1` en DISP (que el split del `IN` no los
     sacó, y que el override F12.A6 no los pisó).
   - Que **no quede** ninguna bitácora `codigo='SALA'` en el catálogo.

5. **Guard de integridad** — `server/tests/guard_tipo_evento_coherente.test.js`. Cierra el Riesgo #1 de
   forma permanente, más allá de esta migración: ningún registro de `registro_activo` ni de
   `registro_historico` puede tener un `tipo_evento_id` cuya `bitacora_id` difiera de la del registro.
   Es barato (dos `COUNT`) y protege a cualquier migración futura que mueva `bitacora_id`.

6. **Cableado**: verificá que los tests nuevos entren al script `test` de `server/package.json` si la
   suite los enumera explícitamente (precedente: D-052 tuvo que cablear `catalogo_bitacoras.test.js` a
   mano). El guard `zzz_session_leak_guard.test.js` **debe seguir siendo el último**.

## Verificación (antes de commitear)

- `cd server && npm test` — **verde completo**. Es la etapa que devuelve la suite al baseline.
  Documentá el conteo real (`N/N`) en `ESTADO.md`.
- **Verificación en negativo del guard nuevo** (precedente D-052, que lo hizo así): inyectá a mano un
  drift `tipo_evento_id` en una fila de la planta de test `'TST'`, confirmá que
  `guard_tipo_evento_coherente` se pone **rojo**, y revertí. Un guard que nunca se vio fallar no es un
  guard. Anotá el resultado en `ESTADO.md`.
- **Verificación en negativo del test de matriz**: cambiá temporalmente un `WHEN` de la matriz en
  `db.js`, reiniciá, confirmá que `split_sala_permisos` se pone rojo, revertí.
- Confirmá que **ninguna sesión sintética quedó activa** en GEC3/GEC32: el guard
  `zzz_session_leak_guard` debe cerrar limpio (es la red que atrapa los fixtures nuevos de la tarea 1).
- `npm run build` (front) verde.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E3 ✅ con resumen.
- Bloque `### E3 — Tests + guardrails  ✅` con **Archivos tocados**, **Verificación** (conteo real de la
  suite + resultado de las dos verificaciones en negativo) y **Desviaciones**.

## Commit

```bash
git add server/tests/ server/package.json prompts/D-053-split-sala-por-rol/ESTADO.md
git commit -m "$(cat <<'EOF'
test(SALA): fixtures por rol + regresión del split

Cierra el falso verde de registros_solo_autor. Su test 2 ("no-autor CON puede_crear
→ 403 solo_autor") usaba SALA porque era la única bitácora donde dos cargos
compartían puede_crear. El split borra ese fixture del catálogo: el test habría
seguido verde pasando por la rama "sin permiso", colapsando en un duplicado del
test 3 y dejando de probar lo que dice probar.

Pasa a usar el rol ADMIN como no-autor: tiene puede_crear en todas las bitácoras
(D-039), así que el fixture vuelve a ser válido y además prueba directamente la
afirmación más fuerte de D-049 — que nadie tiene excepción, tampoco el admin.

Fixtures nuevos (Operador de Sala de Mando y Admin) nacen con es_sintetico=1 y se
limpian por deactivateSyntheticSessions(), nunca por username: la suite corre
contra la BD productiva (D-030) y una sesión de test filtrada aparece como operador
CONECTADO real.

ia_cliente iteraba 'SALA' literal y rompía el CI; pasa a los 10 códigos genéricos.

Tests nuevos: split_sala_permisos fija la matriz objetivo (incluida la regresión de
que JdT/IngOp conservan DISP tras partir el IN compartido), y
guard_tipo_evento_coherente cierra de forma permanente el riesgo de que una
migración mueva bitacora_id sin remapear tipo_evento_id — drift que ninguna lectura
detecta. Ambos verificados en negativo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
