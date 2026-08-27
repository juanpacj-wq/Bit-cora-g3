# D-061 · Ola O5 · Lote L12 — Una sola definición de "esta celda cambió", y que el conjunto de editadas no mienta

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1..O4.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-27. **Último lote de corrección de D-061** (`GATE-O4.md` §5 D16,
> opción c): cierra los tres hallazgos altos que pueden **perder datos** o **atascar al operador**.
> Lote **puro** (vitest + build, sin BD ni backend).

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

- **Lo que este lote NO hace, y es la mitad de su definición: no toca el popover.** Nada de
  `ladoPopover`, `ladoFijo`, `ladoHoverRef`, `medirLado`, `tipClases`, `ALTO_TIP`/`ANCHO_TIP` ni
  `combustibles.css` —que ni siquiera está en tu territorio, a propósito—. La ubicación del popover
  va por su quinta corrección y el gate decidió que eso **sale de D-061** hacia un ADR propio
  (D-062) con un rediseño de raíz: sacarlo a un portal con `position: fixed` para que deje de vivir
  dentro del contenedor que lo recorta. Si tocas esa maquinaria, el gate te lo va a revertir. Los
  hallazgos H67, H69, H70 y H75 **no son tuyos**.
- **El hallazgo H65 es la TERCERA aparición del mismo modo de pérdida de datos** (H24 en la O2 → H50
  en la O3 → H65 ahora). Antes de escribir una línea, lee cómo lo cerraron L09 y L11 y por qué no
  alcanzó: si tu arreglo es "otra puerta más", vamos por el mismo camino. Lo que se te pide es que
  la propiedad quede **cierta por construcción**, no cubierta caso por caso.
- **`celdaEquivalente` es hoy la única definición de "esta celda cambió"** y la consumen cuatro
  cosas a la vez: el botón Guardar, la gavela, el `beforeunload` y el cuerpo del POST. Un error de
  coerción ahí se propaga a las cuatro (eso es H72). Es una ventaja de diseño —una sola fuente— con
  la contracara de que hay que hacerla exacta.
- Después de este lote **no queda más código de D-061**: sigue el cierre de la implementación.
  Lo que dejes anotado en `### Aporte al ADR` va derecho al ADR.

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L12 --sesion L12-HHMM
export LOTE_SESION=L12-HHMM
```
Si falla (O5 no abierta, L11 sin `done`, lote reclamado), **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `GATE-O4.md` §4 (los tres CA en `parcial`), §5 **D16** y §7 (**H65, H66, H68, H72, H73, H74** son
   tu lista; el resto **no**).
2. `cierres/L09.md` y `cierres/L11.md` — cómo se cerró este mismo defecto dos veces y qué invariante
   declaró cada uno. El comentario que hoy vive en `ConsumosGrid.jsx` sobre `hayCambios` **afirma
   una invariante que el código no cumple**: esa es exactamente H66.
3. `_CONTEXTO-BASE.md` §6 (filas C4, C5, C6, C11), §9.
4. Tu territorio. Solo lectura: `src/hooks/useCombustibles.js`, `server/routes/combustibles.js`.
5. `CLAUDE.md` del subrepo, convenciones 9, 11, 16, 17.

## 2. Territorio — lo único que puedes crear o editar
- `src/components/Combustibles/ConsumosGrid.jsx`
- `src/components/Combustibles/override.js`
- `src/components/Combustibles/override.test.js`
- `src/components/Combustibles/ConsumosGrid.test.jsx`
- `prompts/D-061-sis-carbon-cierre/cierres/L12.md`

**NO tocas** `src/components/Combustibles/combustibles.css` (queda fuera **a propósito**: es la
señal de que el popover no es tuyo), `src/hooks/useCombustibles.js`, `server/**`, `package.json`,
`vitest.config.js`, `ESTADO.md`, `docs/`. Cambio fuera del territorio → `Bloqueos` + `lotes.mjs
block`.

## 3. Contrato
> No produces ni cambias contratos. C4/C5/C6 se consumen tal cual; **C11 puede crecer**, y las 17
> exportaciones actuales conservan nombre y firma salvo `celdaEquivalente`, cuyo **comportamiento**
> corriges (la firma no cambia).

## 4. Trabajo
Confirma los números de línea con Grep antes de editar.

1. **H72 (alta) — `celdaEquivalente` funde valores que no son iguales y separa valores que sí lo
   son.** `override.js:170-175`:
   - `Number(celdaBuffer.cantidad) === Number(celdaSnap.cantidad)`: `Number(null)` es **0**, así que
     una celda del snapshot con `cantidad: null` se declara equivalente a un `0` del buffer. Una
     edición real se descarta en silencio — no aparece en el POST y el operador nunca se entera.
   - `(celdaBuffer.detalle ?? null) === (celdaSnap.detalle ?? null)`: `''` y `null` quedan
     **distintos**, así que si el server devuelve `''` donde el buffer tiene `null` la celda queda
     marcada para siempre y se reescribe sola en cada Guardar.
   - **Arreglo:** normaliza los dos lados de forma explícita antes de comparar. Decide y escribe qué
     significa cada forma: `null`, `undefined`, `''` y `0` son cuatro cosas y hoy se mezclan de a
     pares. Como este predicado gobierna cuatro comportamientos, deja **una tabla de casos** en el
     test: cada combinación de `{ausente, null, '', 0, número}` × `{ausente, null, '', texto}` con
     su veredicto esperado.

2. **H65 (alta) — el conjunto de editadas no se depura cuando el mundo cambia debajo.**
   `ConsumosGrid.jsx:142` y la rama `preservarEdicion` del `refetch` (`:128-150`). Hoy la única
   depuración vive dentro de `setCelda`: si el operador teclea y el server termina coincidiendo con
   lo tecleado, la coordenada **se queda marcada**, y el refresco siguiente la restaura vieja encima
   de un valor nuevo del SIS. El Guardar lo manda al POST a nombre del operador y la ownership de
   D-029 impide reponerlo.
   - **Escenario que tiene que quedar como test:** snapshot X=20. El operador teclea X=25 y también
     Y=9 (Y es lo que mantiene la edición viva). Refresco preservado #1 devuelve **X=25** — el
     server ya coincide. Refresco preservado #2 devuelve **X=30** (el SIS releyó el periodo). Hoy la
     pantalla sigue mostrando 25, el diff emite X=25 y el Guardar pisa el 30. **Debe** ganar el 30:
     el operador ya no tiene nada pendiente en X.
   - **Arreglo — el criterio, no la implementación:** la pertenencia al conjunto tiene que
     **derivarse** del estado, no acumularse por eventos. Una coordenada está "editada" si y solo si
     su celda del buffer **no es equivalente** a la del snapshot vigente. Si eso se cumple por
     construcción —depurando en el mismo punto donde entra el snapshot nuevo, o derivando el
     conjunto en vez de mantenerlo— H65 deja de tener puerta, y también H24 y H50. Cuidado con lo
     único que el conjunto sí aporta y no se puede derivar: distinguir "el operador vació esta
     celda" de "esta celda nunca existió". Resuélvelo explícitamente y déjalo escrito.

3. **H66 (alta) — `hayCambios` memoriza sobre `[buffer, snapshot]` y lee un ref mutable.**
   `ConsumosGrid.jsx:175`. El comentario de arriba declara la invariante ("TODA mutación del
   conjunto va acompañada de un `setBuffer`") y el efecto de cambio de planta/fecha la rompe: limpia
   el conjunto y llama a `refetch()` sin tocar el buffer. Si ese GET falla, el `catch` solo hace
   `setError` y el memo **nunca se recalcula**: `hayCambios` queda pegado en `true` con el conjunto
   vacío. Guardar encendido, "Sin cambios para guardar" al pulsarlo, todos los Revertir apagados, y
   a los 10 minutos la gavela anuncia que descartó cambios que no existían.
   - **Arreglo:** que `hayCambios` no dependa de una invariante que hay que recordar sostener. Si el
     arreglo de H65 deriva el conjunto del estado, esto sale gratis. Si no, el conjunto tiene que
     ser estado de React, no un ref. **No lo resuelvas agregando el ref a las dependencias del
     memo** (un `Set` mutable no cambia de identidad y no serviría).
   - De paso, **H74**: ese memo construye y **ordena** el diff entero para responder un booleano, en
     cada tecla. Con la misma definición compartida, un corto-circuito al primer no-equivalente hace
     el trabajo sin asignar ni ordenar.

4. **H68 (media) — la mutación del conjunto vive dentro del updater de `setBuffer`.**
   `ConsumosGrid.jsx:323`. React puede invocar un updater más de una vez y desde otra base
   (StrictMode, camino de estado ansioso), y la rama que se toma —y por tanto si la coordenada queda
   marcada o no— depende de esa base. La idempotencia de `add`/`delete` no cubre una repetición que
   tome la otra rama. Además ese updater lee `snapshotRef.current`, que escribe un efecto posterior
   al commit: el resultado depende del orden de los commits, no de sus entradas.
   - **Arreglo:** el updater de `setBuffer` tiene que ser **puro**. Si el arreglo de H65 deriva el
     conjunto, esto desaparece solo; si no, saca el efecto secundario del updater.

5. **H73 (baja) — `deepClone` del componente duplica `clon` de `override.js`.** Son el mismo
   `JSON.parse(JSON.stringify(x))` y el diff de L11 retiró la justificación que las ataba. Exporta
   una y usa esa.

6. Tuteo colombiano en todo texto nuevo, comentarios incluidos. Sin voseo. **Y corrige los
   comentarios que afirmen invariantes que el código ya no cumple** — el de `hayCambios` es el caso
   vivo, pero revisa los que toques: un comentario que miente es peor que ninguno.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-55 | `celdaEquivalente` trata `null`, `undefined`, `''` y `0` de forma explícita y documentada; ninguna edición real se descarta y ninguna celda queda marcada para siempre. | `override.test.js › celdaEquivalente` con la **tabla de casos** completa de §4.1 |
| CA-56 | Una celda que el operador tocó y que el server terminó igualando **deja de estar pendiente**: un refresco posterior con un valor nuevo del SIS se ve en pantalla y el Guardar **no** lo pisa. | `ConsumosGrid.test.jsx › CA-56` con el escenario literal de §4.2 (dos refrescos), afirmando sobre el **body real del POST** y sobre lo que se pinta |
| CA-57 | `hayCambios` no puede quedar desincronizado del diff: no existe un estado con Guardar encendido y nada que mandar, ni siquiera si un refresco falla justo después de cambiar de fecha. | `ConsumosGrid.test.jsx › CA-57` (cambiar de fecha con edición viva + GET que rechaza) |
| CA-58 | El updater de `setBuffer` es puro (invocarlo dos veces con la misma base da el mismo resultado) y hay una sola función de clonado. | `override.test.js` + lectura del diff + `npx vitest run src/components/Combustibles` |

## 6. Verificación que corres (solo la tuya)
```bash
npx vitest run src/components/Combustibles      # 3 pasadas seguidas, sin intermitencias
npx vitest run src                              # la suite front completa, que no baje de 223
npx eslint src/components/Combustibles
npm run build
```
**Verificador bidireccional obligatorio** para CA-55, CA-56 y CA-57: rompe cada arreglo, pega el
rojo literal, restaura y vuelve a correr.

**Prueba explícitamente el doble render.** H68 solo se manifiesta cuando React invoca el updater dos
veces: si tu arreglo lo deja dentro, escribe el caso que lo invoca dos veces desde la misma base.
Si lo sacaste, dilo en el cierre y explica por qué ya no aplica.

Lote **puro**: no abras backend, no toques la BD, **no tomes el test-lock**. Hay un backfill
corriendo contra producción — no mates procesos `node` ajenos.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L12.md` (plantilla `CIERRE-LOTE.md`). En
   `### Aporte al ADR`, **este es el último aporte de código de D-061**: cuenta la historia
   completa del modelo de edición de la grilla —por qué hicieron falta tres intentos y qué lo
   volvió cierto por construcción al final—, porque va derecho al ADR.
   Propón tu delta de tests; no lo certifiques (H64).
2. `git commit -- src/components/Combustibles/ prompts/D-061-sis-carbon-cierre/cierres/L12.md`
   con el scope `(D-061 L12)` en el título. **Sin `--no-verify`** (H77). Sin firmas de IA.
3. `lotes.mjs --impl D-061 done L12 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L12 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A` ni `git add .`; nada de stash, reset,
  checkout, restore, switch, rebase, amend, push, merge, `--no-verify`.
- **El popover no es tuyo.** Tocar `ladoPopover`/`ladoFijo`/`ladoHoverRef`/`medirLado` es salirse
  del alcance aunque el archivo sea tuyo.
- Un cambio fuera del territorio es un **bloqueo**, no una excepción.
- No te asciendas solo: los CA los confirma el gate.
- Tuteo colombiano estándar; sin voseo.
