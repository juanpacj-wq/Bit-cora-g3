# REQ-04 — Histórico del día dentro del apartado de Operación 24h

| Campo | Valor |
|---|---|
| **Código** | REQ-04 |
| **Título** | Listado del día bajo la grilla, con formato de mensaje, y corrección desde ahí |
| **Estado** | 🟢 **COMPLETO** — corrección por D-057 (2026-07-26) + formato de mensaje, copiar y cascada por **D-058** (2026-07-27). **Sin bloqueantes vivos.** |
| **Origen** | `pendientes_Ernesto.md`: *"histórico en el mismo apartado para ver los registros de autorización, pruebas y redespachos, con formato enviado a whatsapp."* |
| **Depende de** | [REQ-03](./REQ-03-operacion-24h-registros-unicos.md) — ✅ **implementado por D-056** (2026-07-22): el modelo de lotes ya existe. |
| **Alimenta** | [REQ-02](./REQ-02-reflejo-bitacoras-sala.md) — toda corrección hecha acá cascadea a las copias. |
| **Excepciona** | **D-049** — "solo el autor edita/borra" (ver §3.4). |

---

> **Adelanto ya entregado por D-056 (2026-07-22).** Parte de este requerimiento ya está en producción
> como subproducto de REQ-03: existe `GET /api/sala-de-mando/lotes?planta_id=&fecha=` (lotes del día
> agrupados por `lote_id`, solo `registro_activo`, orden `hora_llamada DESC` con los sin-hora al
> final, gated por `puede_ver` sin exigir `puede_crear` — RN-04.f) y el **listado mínimo en solo
> lectura** debajo de la grilla (`src/components/SalaDeMando/LotesDelDia.jsx`), con la marca de
> publicado **por celda** como indicador derivado.
>
> **Corrección entregada por D-057 (2026-07-26).** Ya existen `PUT` y `DELETE
> /api/sala-de-mando/lotes/:lote_id` con el **diff quirúrgico** (RQ-04.8..10, RQ-04.15..18), la
> **excepción acotada a D-049** (RQ-04.11..13 — implementada como gate por `puede_crear`, ver §5.3
> corregida), las acciones en el listado y el modal de corrección + la confirmación de borrado
> (`LoteEditorModal.jsx` / `LoteBorrarModal.jsx`). Los 14 criterios de §6 están cubiertos salvo los
> que dependen de lo que sigue pendiente (2, 8 y la mitad "copias" del 9).
>
> **Cerrado por D-058 (2026-07-27).** El **formato de mensaje** existe (§8.1 resuelta: motor
> server-side único, `FORMATO-ASIENTOS-OPERACION.md`), cada renglón del listado lo muestra con
> **copiar renglón** y **copiar el día** (§8.3), y la **cascada a `SALAJDT`/`SALAING`** quedó cableada
> en los dos puntos que D-057 dejó anotados (RQ-04.14 cumplido). **Este REQ ya no tiene bloqueantes
> vivos**; los criterios 2, 8 y la mitad "copias" del 9 quedan cubiertos.
>
> ⚠️ **La plantilla del mensaje debe tolerar descripción ausente:** `detalle` es **opcional** en la
> captura (D-056) — solo `hora`, tipo y al menos una celda con valor son obligatorios, y
> `funcionariocnd` únicamente en AUTH. Una plantilla que asuma descripción siempre presente va a
> imprimir un rótulo huérfano o un `undefined` en el mensaje real.
>
> ⚠️ **RN-04.a ("orden cronológico") ya tiene una implementación concreta**: `hora_llamada DESC`
> (lo recién registrado arriba, que es lo que el listado viene a resolver), NULLs al final, desempate
> `creado_en DESC`. Si la presentación definitiva quiere ascendente, es un cambio consciente, no un
> arreglo. Y RQ-03.22 **ya viene corregido**: el recálculo de lo publicado es **por celda**, no por
> lote — al editar los periodos de un lote hay que recalcular cada celda tocada, incluidas las que se
> quitaron.

## 1. Contexto y problema

Dos necesidades que resultaron ser **una sola pantalla**:

1. **Ver lo registrado del día sin salir del apartado.** Hoy Operación 24h muestra la grilla y nada
   más; para revisar lo que ya se registró hay que irse a la sección general de Históricos, que
   además no lista MAND por su ciclo de vida propio.
2. **Poder corregir.** Con el modelo append-only de REQ-03 la grilla ya no edita nada. Si no existe
   otro lugar para corregir, un error de digitación queda para siempre.

Además, estos eventos se comunican al grupo operativo por WhatsApp con un formato establecido, que
hoy se redacta a mano cada vez.

**Las tres cosas se resuelven en el mismo listado**: un solo bloque debajo de la grilla que lista lo
del día, lo muestra con el formato del mensaje, y permite corregir y borrar.

## 2. Comportamiento actual

| Aspecto | Situación hoy |
|---|---|
| Bajo la grilla de Operación 24h | No hay nada. |
| Consulta de lo registrado | Los valores se ven en las propias celdas de la grilla, porque el modelo actual es un espejo persistente (`GET /api/sala-de-mando`, `server/routes/mand.js:40-90`). |
| Corrección | En la celda misma, con `PUT` implícito por el batch (máquina de 4 casos, `mand.js:238-393`). |
| Sección general de Históricos | Existe (`src/components/historicos/`, `server/routes/historicos.js`) pero se alimenta de `bitacora.v_historico_busqueda`, que cubre registros archivados por **cierre de turno** — y MAND/DISP quedan fuera de ese flujo (`server/routes/cierre.js:56,123`). |
| Formato de mensaje | No existe en el sistema. Se redacta a mano. |

## 3. Comportamiento requerido

### 3.1 Un solo listado

- **RQ-04.1** — Debajo de la grilla de Operación 24h aparece un **listado del día**.
- **RQ-04.2** — Es **un solo bloque**: la misma lista sirve para consultar, para leer con el formato
  de mensaje y para corregir. No hay dos vistas separadas.
- **RQ-04.3** — Cada renglón se presenta con el **formato establecido de mensaje** (§8.1).

### 3.2 Alcance

- **RQ-04.4** — Lista **únicamente el día en curso** (día Bogotá). Días anteriores no se listan
  acá; se consultan en la sección general de Históricos.
- **RQ-04.5** — Lista **únicamente los tres tipos de la grilla**: Autorización, Prueba y Redespacho.
- **RQ-04.6** — **Disponibilidad NO entra** en este listado. Tiene su propio apartado con su
  historial.
- **RQ-04.7** — Lista los registros de **la planta de la sesión**.

### 3.3 Granularidad: el lote

- **RQ-04.8** — El listado muestra **una fila por lote**, no una por periodo. Un lote que abarcó los
  periodos 14 a 18 es **un** renglón.
- **RQ-04.9** — **Editar y borrar actúan sobre el lote completo**, no sobre un periodo suelto.
- **RQ-04.10** — Al editar un lote se puede cambiar **todo**: los MW, la hora de la llamada, el
  funcionario, la descripción **y también qué periodos abarca** (agregar o quitar periodos del lote).

### 3.4 Quién puede corregir

- **RQ-04.11** — Pueden editar y borrar **el Ingeniero Jefe de Turno y el Ingeniero de Operación,
  indistintamente**: cualquiera de los dos corrige lo del otro. También el rol
  `Administrador y Debugging` por su acceso total (D-039).
- **RQ-04.12** — Esto es una **excepción explícita a D-049**, que estableció que en las bitácoras
  genéricas solo el autor edita o borra sus registros.
  > **Justificación:** Operación 24h es una bitácora de operación continua 24 horas, compartida por
  > los dos cargos que la escriben, y el turno rota. Si el autor de un registro errado ya salió, con
  > la regla de D-049 el error quedaría sin poder corregirse **y seguiría publicado al dashboard de
  > generación**. La corrección compartida es una necesidad operativa, no una comodidad.
- **RQ-04.13** — La excepción es **acotada a MAND**. El resto de bitácoras conserva D-049 intacto, y
  la excepción debe ser legible en el código, no un bypass genérico por cargo.
  > **Corregido por D-057:** el enunciado original mandaba tocar `canEditarRegistro`
  > (`server/middleware/permissions.js`) y su espejo SQL del `GET /activos` "juntos". **No hizo
  > falta tocar ninguno de los dos:** MAND nunca pasa por ese helper (D-049 lo excluye
  > explícitamente, igual que a DISP y COMB). La excepción vive en que el gate del `PUT`/`DELETE`
  > por lote es **`puede_crear` en MAND** (matriz data-driven) y no `creado_por`. Ver la decisión (2)
  > del ADR **D-057**.

### 3.5 Efectos de corregir

- **RQ-04.14** — Corregir o borrar un lote **cascadea a las copias en `SALAJDT` y `SALAING`**
  ([REQ-02](./REQ-02-reflejo-bitacoras-sala.md)).
- **RQ-04.15** — Corregir o borrar un lote **recalcula lo publicado al dashboard de generación**
  según RQ-03.22/23: gana el lote más reciente por hora de llamada; al borrar el publicado, se
  retrocede al anterior vigente.
- **RQ-04.16** — Las tres cosas (registro, copias, publicación) se actualizan de forma **atómica**.

### 3.6 Restricciones que se heredan

- **RQ-04.17** — Al editar un lote de **Redespacho**, el lock de periodos pasados sigue aplicando al
  **valor** (RQ-03.17). La hora, el funcionario y la descripción se pueden corregir siempre.
- **RQ-04.18** — La corrección está disponible **aunque el turno esté finalizado o cerrado**, igual
  que el registro (RQ-03.18). Operación 24h mantiene su exención.

## 4. Reglas de negocio y casos borde

- **RN-04.a** — El listado es **cronológico**, ordenado por hora de la llamada.
- **RN-04.b** — Si un lote queda **sin ningún periodo** tras una edición, eso equivale a borrarlo:
  se rechaza como edición inválida o se confirma como borrado, pero **nunca queda un lote vacío**.
- **RN-04.c** — Borrar es **borrado real** del lote, no una anulación visible. (La anulación visible
  existe solo para Disponibilidad — RQ-02.12.)
- **RN-04.d** — Toda corrección debe quedar auditada: quién y cuándo. `modificado_por` /
  `modificado_en` recuperan sentido acá (a diferencia de la grilla, que ya no modifica nada).
  Aplica el criterio de D-019 solo si se decide que cambiar el comentario no cuenta como
  modificación — ver §8.2.
- **RN-04.e** — Al cruzar la medianoche de Bogotá el listado se vacía solo (empieza el nuevo día) y
  lo del día anterior queda congelado por el cierre automático (sweeper, RF-061).
- **RN-04.f** — Un usuario sin permiso de crear en MAND ve el listado en **solo lectura** (la
  bitácora es visible para todos los cargos por la matriz), sin controles de edición.

## 5. Impacto técnico

### 5.1 Consulta

Hace falta un endpoint que devuelva **los lotes del día** para una planta, agrupando los registros
de `bitacora.registro_activo` por su identificador de lote (REQ-03 §5.2).

Reemplaza funcionalmente al actual `GET /api/sala-de-mando` (`mand.js:40-90`), que hoy devuelve un
pivote `{AUTH: {valores: Array(24), detalle, funcionariocnd}, ...}` pensado para pintar la grilla —
un shape que con el nuevo modelo deja de tener sentido (ya no hay "un valor por celda" ni metadata
única de fila).

### 5.2 Corrección

`PUT` y `DELETE` **por lote**, no por registro. Cada uno debe, en una sola transacción:
1. aplicar el cambio a los registros del lote (crear/borrar filas si cambiaron los periodos),
2. cascadear a las copias de SALAJDT/SALAING,
3. recalcular la publicación en `evento_dashboard`,
4. notificar al dashboard post-commit.

### 5.3 Archivos a tocar

| Archivo | Cambio |
|---|---|
| `server/routes/mand.js` | Endpoint de listado por lotes (D-056); `PUT`/`DELETE` por lote con recálculo (D-057). La **cascada** queda anotada como punto de enganche, sin código (REQ-02 no existe). |
| ~~`server/middleware/permissions.js`~~ | ❌ **NO se tocó, y no debe tocarse.** El plan asumía que la excepción a D-049 iba en `canEditarRegistro` + su espejo SQL del `GET /activos`; **MAND no pasa por ese helper**. La excepción vive en el gate `puede_crear` del endpoint por lote — ver RQ-04.13 y la decisión (2) del ADR **D-057**. |
| `server/utils/notificador.js` | Recálculo del vigente publicado (compartido con REQ-03 §5.3). **Sin cambios en D-057:** `recalcularEventoDashboard` ya estaba escrita y probada por D-056; la corrección solo agrega callers. |
| `src/components/SalaDeMando/` | Listado (`LotesDelDia.jsx`, D-056) + `LoteEditorModal.jsx`, `LoteBorrarModal.jsx` y `motivos.js` (D-057). |
| `src/hooks/useSalaDeMando.js` | Listado, edición y borrado por lote. |
| `server/tests/sala_de_mando_batch.test.js` | Cobertura. **Todos los tests de MAND van en este archivo** (D-055). La cara negativa del criterio 6 vive en `registros_solo_autor.test.js`: son un **par**, se leen juntos. |

### 5.4 Riesgos

- **La excepción a D-049 es un precedente peligroso.** D-049 eliminó a propósito el bypass por
  `puede_cerrar_turno` con el que JdT e IngOp editaban registros ajenos en bitácoras donde solo
  tienen `puede_ver`. La excepción de este requerimiento **debe ser específica de MAND**, no una
  reapertura de ese bypass. Conviene un test de regresión que verifique que en el resto de bitácoras
  sigue rigiendo "solo el autor".
  > **Mitigado en D-057:** el gate es `puede_crear` en MAND (matriz data-driven), nunca un cargo
  > hardcodeado, y `permissions.js` no se tocó. El par de tests fija las dos caras: no-autor **sí**
  > corrige en MAND (`sala_de_mando_batch`, criterio 5) y **no** en una bitácora genérica
  > (`registros_solo_autor`, criterio 6).
- **Editar los periodos de un lote** es la operación más delicada: agregar un periodo puede
  colisionar con el lock de Redespacho, y quitar uno puede dejar sin publicar un periodo que estaba
  siendo el vigente en el dashboard. Ambos caminos necesitan test.
  > **Cubierto en D-057:** el lock se evalúa **sobre el delta** y rebota las tres ramas (valor
  > cambiado, periodo agregado, periodo quitado) — criterio 11 a/b/c; y quitar el periodo publicado
  > **retrocede** lo publicado al lote anterior vigente, o borra la fila de `evento_dashboard` si no
  > queda ninguno — criterio 10, probado con la cadena completa A→B→A→sin fila.

## 6. Criterios de aceptación

1. **Dado** que registro un lote de Autorización para los periodos 14 a 18, **cuando** miro el
   listado, **entonces** aparece **un** renglón (no cinco), indicando el rango de periodos.
2. **Dado** ese renglón, **entonces** se muestra con el formato de mensaje establecido.
3. **Dado** el listado, **entonces** solo aparecen registros del día de hoy y de la planta de la
   sesión.
4. **Dado** el listado, **entonces** no aparece ningún evento de Disponibilidad.
5. **Dado** un lote creado por el Ing. de Operación, **cuando** el Jefe de Turno lo edita,
   **entonces** puede hacerlo.
6. **Dado** un registro en cualquier **otra** bitácora creado por otra persona, **cuando** intento
   editarlo, **entonces** sigue prohibido (D-049 intacto fuera de MAND).
7. **Dado** un lote, **cuando** lo edito, **entonces** puedo cambiar MW, hora, funcionario,
   descripción y el conjunto de periodos.
8. **Dado** que edito un lote, **cuando** reviso `SALAJDT` y `SALAING`, **entonces** las dos copias
   quedan actualizadas.
9. **Dado** que borro un lote, **entonces** desaparece del listado **y** desaparecen sus dos copias.
10. **Dado** que borro el lote que estaba publicado en el dashboard, **entonces** el dashboard
    retrocede al lote anterior vigente de ese periodo.
11. **Dado** un lote de Redespacho, **cuando** intento cambiar el valor de un periodo ya pasado,
    **entonces** se rechaza; **pero cuando** solo cambio la hora o la descripción, **entonces** se
    permite.
12. **Dado** que finalicé mi turno, **cuando** corrijo un lote, **entonces** funciona (exención
    intacta).
13. **Dado** un cargo sin permiso de crear en MAND, **cuando** abro el apartado, **entonces** veo el
    listado sin controles de edición, y el endpoint me rechaza si lo invoco directo.
14. **Dado** que una corrección falla a mitad, **entonces** no queda aplicada parcialmente en
    registro, copias ni publicación.

## 7. Fuera de alcance

- Listar o corregir días anteriores al de hoy (eso vive en la sección general de Históricos).
- Incluir eventos de Disponibilidad en este listado.
- Corregir registros desde las bitácoras de Sala (son solo lectura ahí, REQ-02).
- Enviar el mensaje a WhatsApp desde la aplicación (ver §8.3).
- Cambiar la regla de edición de las demás bitácoras.

## 8. Preguntas abiertas

### 8.1 ✅ RESUELTA por D-058 — plantilla del mensaje

Faltaba el texto literal del formato con que estos eventos se comunican hoy por WhatsApp: orden de
los campos, rótulos, mayúsculas, separadores, cómo se expresa un rango de periodos, cómo se escriben
las unidades y la hora.

> **Respuesta: lo arma el servidor con un motor único** (`server/utils/asientos/`) y `GET
> /api/sala-de-mando/lotes` devuelve el campo `asiento` ya renderizado — el front **no conoce ninguna
> plantilla**. Las plantillas y convenciones (unidad `GEC3`/`GEC32`, potencia entera en `MW`,
> compactación `del P17 al P19` vs. lista por periodo, `detalle` al final tras punto) están en
> [`FORMATO-ASIENTOS-OPERACION.md`](./FORMATO-ASIENTOS-OPERACION.md) §4 y §5, derivadas de 342
> eventos reales del formato GENE-F03. **La hora no va dentro del texto**: es una columna propia, y
> al copiar el día se antepone como `HH:MM — asiento` (los lotes sin hora salen sin prefijo, jamás un
> `null —`). El mismo motor alimenta el reflejo a Sala (REQ-02) y el libro mensual (REQ-06). Ver
> **D-058**.

### 8.2 ✅ RESUELTA por D-057 — auditoría de la corrección

D-019 estableció para MAND que `modificado_por` solo se actualiza si cambió el valor en MW, no si
cambió el comentario — porque audita cambios numéricos al despacho. ¿Se mantiene ese criterio en la
corrección por lote, o ahora cualquier cambio debe marcar modificación?

> **Respuesta: cualquier cambio marca modificación.** Valor, hora, funcionario o descripción sellan
> `modificado_por`/`modificado_en` en las celdas afectadas (RN-04.d). **D-019 se levanta acá y sigue
> vigente solo en la captura**, donde ya no hay nada que modificar. Razón: corregir es un acto
> deliberado, y la **hora decide qué se publica** al dashboard — no es metadata cosmética. Ver la
> decisión (3) del ADR **D-057**.

### 8.3 ✅ RESUELTA por D-058 — copiar el mensaje

¿Debe existir una acción para copiar el mensaje al portapapeles (de un renglón o de todo el día), o
basta con que el texto sea seleccionable en pantalla?

> **Respuesta: las dos acciones existen** — copiar el renglón y **copiar el día completo** (los
> asientos del día, cada uno con su `HH:MM —` adelante). **Copiar no es escribir**: los botones se
> muestran aunque el cargo no tenga `puede_crear` (RN-04.f), porque quien consulta también reporta.
> Detalle de implementación que importa: el portapapeles lleva **fallback** con `textarea` +
> `execCommand`, porque `navigator.clipboard` exige contexto seguro y por HTTP plano no existe — sin
> él el botón sería decorativo justo donde más se usa. Ver **D-058**.

### 8.4 ✅ RESUELTA por D-057 — presentación del rango de periodos

Un lote sobre periodos no contiguos (p. ej. 3, 7 y 19) — ¿se muestra como lista, o se impide crear
lotes no contiguos desde la captura?

> **Respuesta: se muestra como lista y los lotes no contiguos se permiten.** Prohibirlos en la
> captura obligaría al operador a partir en tres registros una sola llamada del CND — falsearía la
> operación real por una comodidad de presentación. El modal de corrección agrega y quita periodos
> sueltos por la misma razón. Ver **D-057**.
