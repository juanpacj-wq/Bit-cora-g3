# D-058 · E8 — Consulta unificada de las cuatro fuentes y armado del día

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo (sección **"5. El armado del libro"**) y `ESTADO.md`.
2. **Verificá que E1..E7 figuren ✅.** En particular E4: el filtro que excluye los reflejados
   depende de que la marca `origen_lote_id` ya exista y esté poblada.
3. Releé §7.1 y §7.2 del insumo de formato y §5.2 de REQ-06.

## Alcance de esta etapa

**Entra:** el módulo que, dado un mes, devuelve la **estructura de datos** de cada día: los tres
bloques, su encabezado de personal y sus renglones ya renderizados y ordenados.
**No entra:** el `.xlsx` (E7 ya lo puede escribir), el endpoint ni el front (E9). Se prueba como
datos, que es donde vive toda la lógica delicada.

## Por qué es la etapa de más trabajo real

**No existe hoy ninguna consulta que combine las fuentes** (REQ-06 §5.2), y hay dos ejes de
complejidad cruzados: cuatro fuentes con hora canónica distinta, y dos tablas por antigüedad
(`registro_activo` para el día en curso, `registro_historico` para los cerrados) que hay que unir
**sin duplicar** (RN-06.d).

## Tareas

1. Crear `server/utils/f03-datos.js` con la consulta y el armado. Firma sugerida:
   `armarMes(pool, { mes })` → `[{ fecha, bloques: [{ turno_literal, jefe, ingenieros, filas: [{ hora, asiento }] }] }]`.
2. **Las cuatro fuentes**, de **ambas unidades** (`GEC3` y `GEC32`), con su hora canónica:

   | Fuente | Dónde | Hora canónica |
   |---|---|---|
   | MAND | `registro_activo` + `registro_historico`, bitácora `MAND`, agrupado por `campos_extra.lote_id` | `campos_extra.hora_llamada` |
   | DISP | `bitacora.disponibilidad_estado` | `fecha_inicio_estado` |
   | Sala | `registro_activo` + `registro_historico`, bitácoras `SALAJDT` y `SALAING` | `fecha_evento` |

   - **`TST` nunca se exporta** (RN-06.g).
   - **De Sala se EXCLUYEN los reflejados**: `JSON_VALUE(campos_extra,'$.origen_lote_id') IS NULL`.
     Sin esto, un evento de MAND sale **tres veces** en la hoja (respuesta 2).
   - `SALAOP` **no** entra: las cuatro fuentes son MAND, DISP, SALAJDT y SALAING (§7.2).
   - Un lote de MAND es **un** renglón, no uno por periodo (RQ-04.8, y el motor ya lo asume).
   - **Varios lotes por periodo conviven** (RN-06.a): el archivo debe mostrarlos todos, no aplanar a
     un valor por periodo — aplanarlo vaciaría de sentido a REQ-03/D-056.
3. **La hora de MAND es `hora_llamada`, NUNCA `fecha_evento`** (D-056): un lote registrado a las
   17:05 por una llamada de las 16:38 va en la fila de las **16:38**. Y puede estar **AUSENTE** en
   los migrados por `F32.A1` — la clave **no existe**, no es `null` —, en cuyo caso se **deriva del
   primer periodo del lote** (P17 → 16:00), que es dato real del registro (respuesta 5).
4. **Los tres bloques del día F** (decisión F), por **hora de calendario** y no por `turno_id`:
   `[F 00:00, F 06:00)` · `[F 06:00, F 18:00)` · `[F 18:00, F+1 00:00)`.
   Literales **exactos**, con los espacios tal como el original: `00:00-06:00`, `06:00 - 18:00`,
   `18:00 - 00:00`.
   > El T2 **cruza medianoche** y el sistema lo fecha por su día de inicio (D-045). El generador lo
   > **parte por medianoche**: cada evento cae en el día de calendario en que ocurrió y aparece
   > **exactamente una vez** en todo el libro (criterio 6b de REQ-06). El primer bloque del día F es
   > la **cola del T2 que arrancó el F-1**; el tercero es la **cabeza del T2 de F**.
5. **Encabezado de cada bloque** (respuesta 4): `JEFE DE TURNO` = cargo `Ingeniero Jefe de Turno`;
   `INGENIERO DE TURNO` = cargo `Ingeniero de Operación`, unidos por ` - `.
   - **Unión deduplicada de las dos unidades**, sin etiquetar (como el papel).
   - Fuente: `bitacora.conformacion_turno` del turno que cubre el bloque. El bloque `00:00-06:00`
     del día F corresponde a `(planta, fecha_operativa = F-1, turno = 2)`.
   - Si el turno **no cerró** (`conformacion_turno` se escribe **al cerrar**, D-045), se completa con
     `bitacora.turno_participante`. Si no hay nada, **celda en blanco** — no inventar.
6. **Renderizado** con el motor de E1: plantilla para MAND y DISP; **literal** para Sala, con el
   prefijo de unidad condicional (`GEC32 — …`, guion largo, solo si el texto no la nombra ya).
   MAND y DISP **no** se prefijan: sus plantillas ya nombran la unidad.
7. **Orden ascendente por hora** dentro del bloque. El listado en pantalla va **descendente**
   (RN-04.a): **son órdenes distintos a propósito** — dejalo comentado, o alguien lo va a "arreglar".
8. **Solo lectura**: la función no escribe nada (RN-06.f). Un mes sin eventos devuelve la estructura
   completa con bloques vacíos, **no es error** (RN-06.h / RQ-06.8).
9. Tests `server/tests/f03_datos.test.js` — enganchado al script `test` de `server/package.json`.
   Sembrar sobre planta de fixture (**nunca** `'GEC3'`/`'GEC32'` en un `clean*()`; acotador de
   fixture léxicamente junto a cada `DELETE`/`UPDATE`, D-055). Casos:
   - **Un evento del T2 a las 03:15 aparece en el bloque `00:00-06:00` de ESE día de calendario, y
     una sola vez en todo el mes** (criterio 6b). Es el test más importante de la etapa.
   - Un evento a las 18:30 va al tercer bloque del mismo día; uno a las 05:59 al primero; uno a las
     06:00 al segundo (bordes cerrados/abiertos).
   - **El día de la transición**: un mes que incluye hoy trae el día de hoy completo (desde
     `registro_activo`) y ningún día duplicado (criterio 8 de REQ-06 / RN-06.d).
   - Un lote MAND **sin `hora_llamada`** cae en el bloque de su primer periodo.
   - Dos autorizaciones del mismo periodo el mismo día → **dos** renglones (criterio 7).
   - Un asiento reflejado en SALAJDT **no** aparece (no hay duplicado).
   - `TST` no aparece nunca.
   - Un día sin eventos devuelve sus tres bloques con `filas: []`.
   - Encabezado: turno cerrado → nombres de `conformacion_turno`; turno abierto → de
     `turno_participante`; sin datos → vacío. Dos unidades con el mismo JdT → **un** nombre.
   - Orden ascendente dentro del bloque.

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado.
- `guard_no_prod_historico_destruction.test.js` verde.
- Corrida manual contra el mes en curso de la BD real (solo lectura) e inspección del resultado:
  con la adopción actual va a salir casi vacío — **eso es correcto**, no lo compenses.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E8 ✅. Bloque con **Archivos tocados**, **Verificación** y **Desviaciones**.
- Anotá en "Datos descubiertos" cuántos eventos reales trajo el mes en curso: es el dato con el que
  se juzga la salida de E9.

## Commit
```bash
git add server/utils/f03-datos.js server/tests/f03_datos.test.js server/package.json
git commit -m "$(cat <<'EOF'
feat(F03): consulta unificada de las cuatro fuentes y armado del día en tres bloques

Es el trabajo real de REQ-06: no existía ninguna consulta que combinara Operación 24h,
Disponibilidad y las dos bitácoras de Sala, y cada una tiene su hora canónica y su
tabla. MAND y Sala viven partidas entre registro_activo (día en curso) y
registro_historico (días cerrados), y hay que unirlas sin duplicar el día de la
transición.

Dos cosas que se ven fáciles y no lo son. La hora de MAND es hora_llamada y nunca
fecha_evento: un lote registrado a las 17:05 por una llamada de las 16:38 va en la
fila de las 16:38, que es para lo que D-056 creó el campo; y en los registros migrados
la clave está ausente, así que la hora se deriva del primer periodo del lote. Y el T2
cruza medianoche y se fecha por su día de inicio (D-045), así que el generador lo parte
por medianoche para que cada evento caiga en el día en que ocurrió y aparezca
exactamente una vez en todo el libro.

De las bitácoras de Sala se excluyen los asientos reflejados: sin ese filtro un evento
de Operación 24h saldría tres veces en la misma hoja.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
