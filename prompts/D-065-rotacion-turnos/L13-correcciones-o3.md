# D-065 · Ola O4 · Lote L13 — Correcciones de la O3 (configuración, popup, cumplimiento y schema)

> **Un lote = un chat.** Abierto por el **GATE-O3**, decisión **D5**, con visto bueno del usuario del
> 2026-09-02. Compartes la ola con **L10** (cableado en el componente raíz) y **no comparten un solo
> archivo**. Redactado por el integrador el 2026-09-02.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Lee el **`GATE-O3.md` §6 completo** (17 puntos). Es el mismo bloque que recibió L10 y describe el
> estado real del módulo tras la O3. Si algo de ahí contradice al `_CONTEXTO-BASE.md`, **manda el
> gate**: el contexto base no se edita, se enmienda desde el gate.

Lo que más te toca de ese §6:

- **Punto 14:** `GET /patrones` puede traer una fila con `vector_invalido: true`, y en ese caso sus
  `vector_t1`/`vector_t2` vienen **como texto crudo, no como arreglo**. Es deliberado. Ese es tu CR3-1.
- **Punto 12:** `POST /sincronizar-entra` devuelve `omitidas { total, grupos, usuarios,
  personas_estimadas }` y la pantalla no la lee. Ese es tu CR3-4.
- **Punto 5:** `useTomaControl(ready, plantaId)` reconsulta al cambiar de unidad en caliente, y **hoy
  no descarta la respuesta obsoleta**. Ese es tu CR3-2.
- **Punto 16:** cero polling, cero `localStorage`/`sessionStorage`, cero tareas recurrentes (CA-23).
  **No lo estrenes tú**, tampoco arreglando.
- **Punto 17:** `--test-concurrency=1` no es opcional. Sin él, `initDB()` concurrente produce rojos
  espurios (`There is already an object named 'autorizacion_dashboard'`) que **no** se parecen a una
  carrera. El script `test` ya lo lleva; si corres archivos sueltos, pásalo.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L13 --sesion L13-HHMM
```

Exporta `LOTE_SESION=L13-HHMM` en el entorno de este chat **antes del primer commit**: es lo que hace
que el `pre-commit` verifique tu territorio y el `commit-msg` exija el scope `(D-065 L13)`.

## 1. Lee, en este orden y solo esto

1. **`GATE-O3.md`**: §5 (decisiones **D4** y **D5**), §6 completo, §7 (tus cinco entradas:
   **CR3-1**, **CR3-2**, **CR3-4**, **CR3-5**, y **H-L09-2**, que es la enmienda de D4).
2. `cierres/L07.md`, `cierres/L08.md`, `cierres/L09.md` — el porqué de lo que vas a tocar.
3. Los archivos de tu territorio, completos.
4. `server/utils/rotacion/patron.js` (**solo lectura**): `parsearVector` y su docstring son la mitad
   del contrato de CR3-5.
5. `server/routes/rotacion.js` (**solo lectura**): `mapPatron` es la otra mitad de CR3-1.

**No leas** `src/BitacorasGecelca3.jsx` ni `src/routing/appRoute.js`: son de L10 y los está editando
otro chat ahora mismo.

## 2. Territorio — lo único que puedes crear o editar

- `src/components/Rotacion/ConfiguracionRotacion.jsx`
- `src/components/Rotacion/configuracion-rotacion.test.jsx`
- `src/hooks/useTomaControl.js`
- `src/components/Rotacion/popup-toma-control.test.jsx`
- `src/hooks/useCumplimiento.js`
- `src/components/Rotacion/CumplimientoRotacion.jsx`
- `src/components/Rotacion/cumplimiento-rotacion.test.jsx`
- `server/db.js`
- `server/tests/rotacion_correcciones_o2.test.js`

Puerto para tu backend efímero, si lo necesitas: **3119**.

**Todo lo demás es de otro.** Si necesitas una edición fuera de esto, **no la hagas**: descríbela
exacta en el §Bloqueos de tu cierre y sigue. El integrador la aplica en el GATE-O4.

## 3. Regla dura de esta ola

**No cambies la firma de props de ningún componente.** L10 está cableando `ConfiguracionRotacion`,
`PopupTomaControl` y `CumplimientoRotacion` **en este mismo momento**, contra las props que fijaron
los cierres de la O3 y que el `GATE-O3.md §6` copia en sus puntos 2, 3 y 6. Un arreglo que necesite
una prop nueva **no es de este lote**: te detienes, lo escribes en §Bloqueos y se coordina en el
GATE-O4. Lo mismo para `modoPopup`, `rangoPorDefecto`, `parsearVectorTexto` y `calcularCambios`, que
son exports públicos que L10 puede estar importando.

## 4. Trabajo

### CR3-1 · La pantalla revienta con la fila que el backend le manda para que la muestre

`mapPatron` (`server/routes/rotacion.js`) devuelve, para una fila corrupta, los vectores **en crudo**
(string) con `grupo_t1`/`grupo_t2` en `null` y `vector_invalido: true`. Lo hace a propósito: es CR2-8,
y su razón es que el administrador **pueda listar** los patrones para encontrar el malo. La pantalla
hace `p.vector_t1.join(', ')` (`ConfiguracionRotacion.jsx:620-621`) y `origen.vector_t1.join(',')` al
copiar de otro rol (`:567`), y **nunca lee `vector_invalido`** → `TypeError` → pantalla en blanco.

**Se cambió un 500 por un vidrio roto, que es peor: el 500 al menos quedaba en el log.** Lo que tienes
que lograr es lo que el backend ya prometió — que la fila mala **se vea**, marcada como dañada, con
su texto crudo a la vista para que se pueda identificar y corregir con el `PATCH`. Que no se pueda
"copiar de" ella es correcto; que tumbe la pantalla, no.

### CR3-2 · `useTomaControl` no descarta la respuesta obsoleta

`refrescar()` solo se protege con `desmontadoRef`, y el efecto lo **resetea a `false`** al principio
para la unidad nueva: el `GET` de la unidad vieja aterriza después y pisa el estado. Al cambiar
GEC3→GEC32 en caliente (D-054 **no** desmonta el componente), el popup queda con el `turno_id` y el
`principal` de la unidad anterior, y su `useEffect([turnoId])` lo **vuelve a abrir**. El `.finally` de
la promesa vieja además apaga el `cargando` de la petición nueva.

**El patrón correcto ya existe en el repo, en el hook hermano de la misma ola:** `secuenciaRef` en
`src/hooks/useCumplimiento.js:113`. Úsalo — dos hooks del mismo módulo resolviendo distinto el mismo
problema es exactamente lo que este lote viene a cerrar.

**Prioridad: este es el que no puede quedarse afuera.** Hoy el bug es **inalcanzable** porque nadie
monta el popup; L10 lo está montando en esta misma ola. Arreglarlo después de montarlo es publicar un
bug a sabiendas.

### CR3-4 · `omitidas` no llega a la pantalla

L12 lo agregó a la respuesta de `POST /sincronizar-entra` justo para que esta superficie pudiera decir
"faltaron N" (era la mitad de transparencia de CR2-4). L07 se escribió en paralelo y no lo lee.

El escenario que hay que cerrar: **un grupo de 14 personas que no respondió se ve hoy idéntico a una
sincronización completa**, porque un grupo omitido aporta cero al `por_rol` y no hay contra qué
comparar. El panel de resultado dice *"Revisa el conteo por rol: si un grupo del directorio no
respondió, acá se nota"* — y no se nota. Muestra `omitidas` y arregla ese copy.

### CR3-5 · El CHECK es más estricto que el parser que espeja

`parsearVector` **tolera espacios alrededor de cada número** (está en su docstring), así que
`'1, 1, 3, 3, 4, 4, 2, 2'` funciona perfecto en runtime. El `CK_rotacion_patron_vector_*` de `F37.A4`
lo rechaza (`LIKE` + `DATALENGTH = 15`).

Consecuencia, y es peor de lo que suena: una fila así —solo alcanzable por SQL a mano, **que es justo
el escenario para el que existe el CHECK**— hace que `agregarConstraintConPrevuelo` **omita la
constraint en cada arranque, para siempre**, y que `F37.A4` nunca se registre en `migracion_aplicada`.
El invariante de CR2-1 no se instala nunca, en silencio, y el remedio que imprime pide corregir una
fila que no está mal.

Decide y justifica en el cierre: **normalizar** en el pre-vuelo (y en la escritura) o **aceptar los
espacios en el predicado**. Lo que no puede quedar es la divergencia. Recuerda **H-L12-1** (el `LIKE`
ignora los blancos **finales** del valor, y `LEN` tampoco los cuenta: por eso está el `DATALENGTH`) y
**H-L12-2**: **una constraint gateada por su nombre nunca adopta un cambio de definición**. Si el
predicado cambia, va como migración **`F37.A5`** con **nombre nuevo de constraint**, aditiva e
idempotente, **jamás** editando el `CREATE TABLE` de `F37.A1` ni la definición de `F37.A4` en sitio.

### D4 (enmienda del usuario) · El panel de ausencias pasa a medir asistencia

Hoy "Titulares que no entraron" se alimenta solo de las filas `PENDIENTE` y `PARCIAL`, así que un
titular que faltó en un turno **que alguien más cubrió** no aparece (se ve en la tabla, con su ✗, pero
no en el resumen). El usuario decidió el 2026-09-02 que **sí debe contarse**: el panel responde
*"¿quién faltó?"*, no *"¿quién dejó el rol sin cubrir?"*.

El cambio de lógica es chico —`ausenciasPorTitular` en `src/hooks/useCumplimiento.js`— pero **el copy
no lo es**: la etiqueta del panel, su subtítulo y el conteo describen hoy lo que medía antes y
quedarían mintiendo. Revísalos todos. Y el caso `› el panel de ausencias agrupa por persona, cuenta
sus turnos y los nombra` de L09 fija el comportamiento viejo: tiene que cambiar contigo, con un
fixture que incluya una fila `CUBIERTO_POR_RELEVO` con su titular ausente.

## 5. Criterios de aceptación

Este lote **no tiene CA propios**. Protege **CA-19**, **CA-20** y **CA-21**, ya confirmados por el
GATE-O3: los tres tienen que seguir en verde al terminar, con sus tres archivos de test.

## 6. Verificación que corres (solo la tuya)

1. **Rojo previo primero.** Antes de arreglar nada, escribe el caso que falla con el código de hoy y
   **pega su salida literal** en el cierre. Un arreglo sin rojo previo no está verificado.
2. `npx vitest run src/components/Rotacion/` — los tres archivos de front.
3. Para `db.js`: backend efímero en **3119** con `AUTH_TEST_BYPASS=1` y **sin `M365_CLIENT_SECRET`**
   en los dos procesos, y `tests/rotacion_correcciones_o2.test.js`. **Toma el `test-lock`** antes
   (`test-lock --sesion L13-HHMM`) y suéltalo al terminar. `--test-concurrency=1`.
4. `npm run build` y `npx eslint` sobre lo que tocaste.
5. **Verificador bidireccional** de cada arreglo: rompe el arreglo, muestra el rojo, restaura, muestra
   el verde.
6. `npm run test:residuos` → cero.

## 7. Cierre (obligatorio, en este orden)

1. Commit por **pathspec** (`git commit -- <rutas>`), nunca `git add -A`: L10 está trabajando sobre el
   mismo árbol y sus archivos van a estar sucios al lado de los tuyos.
2. Escribe `cierres/L13.md` con la plantilla `CIERRE-LOTE.md`: estado de **CR3-1, CR3-2, CR3-4, CR3-5
   y D4** uno por uno con su verificador, desviaciones, hallazgos nuevos con escenario concreto,
   bloqueos con la edición exacta, y qué necesita el gate.
3. `lotes.mjs --impl D-065 done L13`.

## Reglas (no negociables)

- **Sin firmas de IA en los commits.** El hook las rechaza.
- **No toques `server/package.json`**: si tu test necesita engancharse, pídelo en §Para el gate.
- **No cambies ninguna firma de props ni ningún export público** (§3).
- **Nada de `localStorage`/`sessionStorage`, `setInterval` ni polling** (CA-23).
- **Errores por `codigo`, nunca por texto** (D-032 / convención 16).
- **Fechas en Bogotá explícito** (D-020 / convención 9).
