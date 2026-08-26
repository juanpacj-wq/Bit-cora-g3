# REQ-03 — Operación 24h: registros únicos e inmutables (captura append-only)

| Campo | Valor |
|---|---|
| **Código** | REQ-03 |
| **Título** | Rediseño del modelo de captura de Operación 24h: la grilla registra, no edita |
| **Estado** | ✅ **Implementado por [D-056](../decisions.md#d-056--operación-24h-append-only-la-grilla-registra-no-edita)** (2026-07-22) — E1..E6 sobre `feat/mand-append-only-2026-07`. Las tres preguntas de §8 quedaron resueltas (ver §8). |
| **Origen** | `pendientes_Ernesto.md`: *"Operación 24 hr debería tener registros únicos (dinámica registrar->Guardar->registros se envían, pero funcionario y detalle son generales para los periodos, no debería ser así) pensar cómo hacerlo bien"* |
| **Depende de** | Nada. Es la base del bloque. |
| **Habilita** | [REQ-02](./REQ-02-reflejo-bitacoras-sala.md), [REQ-04](./REQ-04-historico-en-apartado.md), [REQ-05](./REQ-05-asiento-cambio-despacho.md), [REQ-06](./REQ-06-excel-eventos-operacion.md) |
| **Revierte** | **D-055 (2)** — que fijó `detalle`/`funcionariocnd` como atributos de FILA. |
| **Excepciona** | **RF-032** — histórico inmutable (por la migración, §5.4). |

---

## 1. Contexto y problema

La grilla de **Operación 24h** (MAND) tiene tres filas — Autorización, Prueba, Redespacho — por 24
periodos. Hoy funciona como una **hoja de cálculo persistente**: cada celda guarda un valor, se puede
volver a entrar y cambiarlo, y el comentario (`detalle`) y el funcionario del CND son **de la fila
entera**, compartidos por todos los periodos.

Ese modelo no representa la realidad operativa. Un mismo periodo puede recibir **varias llamadas del
CND en el mismo día**: una autorización a las 09:12 por 140 MW, otra a las 09:40 por 155 MW, con
funcionarios y motivos distintos. Hoy la segunda **pisa** a la primera y el comentario de una
contamina a los demás periodos de la fila. Lo que ocurrió se pierde.

> **Nota histórica:** D-055 (2026-07-15) formalizó hace pocos días que `detalle`/`funcionariocnd`
> son atributos de fila, porque en ese momento el defecto real era que **se perdían en silencio**.
> La corrección fue correcta para el modelo de entonces. Este requerimiento cambia el modelo: el
> comentario deja de ser de la fila y pasa a ser **del lote**, y el lote deja de ser único por
> periodo. Es una reversión deliberada, no un olvido.

## 2. Comportamiento actual

| Aspecto | Situación hoy | Referencia |
|---|---|---|
| Naturaleza de la grilla | Espejo persistente del estado guardado: se carga desde la BD al abrir | `GET /api/sala-de-mando` — `server/routes/mand.js:40-90` |
| Unicidad | **Un registro por (tipo, periodo, día, planta).** Segunda escritura = UPDATE | Máquina de 4 casos, `mand.js:238-393` |
| Edición | Se edita en la propia celda y se vuelve a guardar | `SalaDeMandoGrid.jsx` (buffer/snapshot/diff, `:28-86`) |
| Borrado | Vaciar la celda borra el registro y su fila en `evento_dashboard` | Caso B, `mand.js:261-283` |
| `detalle` / `funcionariocnd` | De la **fila** (tipo × día × planta); se replican en cada celda con valor, aplicados por un UPDATE a nivel de fila | `mand.js:395-454` (D-055) |
| Storage por celda | Fila de `bitacora.registro_activo` con `campos_extra = {"periodo","valor_mw","funcionariocnd"}` | `mand.js:292-296` |
| Hora del evento | **No existe.** Solo hay `fecha_evento` (momento de guardado) | — |
| Funcionario CND | Obligatorio solo en AUTH; PRUEBA y REDESP lo fuerzan a `NULL` | `mand.js:195-205` |
| Lock REDESP | Solo periodo actual o posteriores (`periodo >= floor(horaBogota)+1`) | `mand.js:187-191` |
| Turno | MAND exenta de `turno_finalizado` / `turno_cerrado` | D-040, D-045 |
| Publicación al dashboard | UPSERT en `bitacora.evento_dashboard`, único por `(planta, fecha, periodo, tipo)` | `server/utils/notificador.js:45-91` |

## 3. Comportamiento requerido

### 3.1 La grilla es un formulario de captura, no un espejo

- **RQ-03.1** — La grilla **arranca vacía** al entrar al apartado. Ya no reconstruye el estado
  guardado desde la base de datos.
- **RQ-03.2** — Al pulsar **Guardar**, y una vez confirmada la escritura, **la grilla se vacía por
  completo**, lista para capturar el siguiente conjunto de eventos.
- **RQ-03.3** — **No se edita ni se borra desde la grilla.** No hay celdas "cargadas" que se puedan
  modificar. La corrección de lo ya registrado vive en el histórico del apartado
  ([REQ-04](./REQ-04-historico-en-apartado.md)).
- **RQ-03.4** — Lo ya registrado en el día se consulta en ese mismo histórico, debajo de la grilla.

### 3.2 Lote: la unidad de captura

- **RQ-03.5** — La metadata sigue siendo **por tipo/fila**: cada una de las tres filas (Autorización,
  Prueba, Redespacho) tiene sus propios campos de **hora**, **funcionario** y **descripción**.
- **RQ-03.6** — Un mismo **Guardar** puede llevar hasta **tres juegos de metadata**, uno por tipo.
- **RQ-03.7** — Al guardar, **cada celda con valor genera un registro propio e independiente**. El
  conjunto de registros nacidos de la misma fila en el mismo Guardar se denomina **lote** y comparte
  esa metadata.
- **RQ-03.8** — Un lote es la unidad de corrección y de presentación en el histórico (REQ-04); los
  registros individuales son la unidad de dato.

### 3.3 Superposición: varios registros por periodo

- **RQ-03.9** — **Pueden coexistir varios lotes para el mismo (tipo, periodo, día, planta)**, con
  valores en MW, horas de llamada, funcionarios y descripciones distintas. Registrar **no pisa**
  lo anterior: agrega.
- **RQ-03.10** — Los registros son **inmutables desde la grilla**. La única vía de modificación es la
  corrección explícita desde el histórico.

### 3.4 Campo nuevo: hora de la llamada

- **RQ-03.11** — Se agrega el campo **hora**, que representa **la hora a la que se hizo la llamada
  con el CND**. Es distinto del momento de guardado.
- **RQ-03.12** — Aplica a los **tres tipos**: Autorización, Prueba y Redespacho.
- **RQ-03.13** — Se **precarga con la hora actual de Bogotá** y es **editable**, para poder registrar
  una llamada ocurrida antes.
- **RQ-03.14** — Es **obligatoria**: no se puede guardar un lote sin hora.
- **RQ-03.15** — **Disponibilidad no cambia** — no lleva este campo (su tabla ya modela intervalos
  con `fecha_inicio_estado` / `fecha_fin_estado`).

### 3.5 Lo que NO cambia

- **RQ-03.16** — **Funcionario CND:** se mantiene como hoy. Obligatorio en Autorización si hay al
  menos un valor; en Prueba y Redespacho se sigue forzando a vacío (`mand.js:195-205`, RF-064).
- **RQ-03.17** — **Lock de Redespacho:** se mantiene. Solo se registra en el periodo actual o
  posteriores (`mand.js:187-191`, RF-063 / RN-14). Autorización y Prueba siguen sin restricción
  dentro del día.
- **RQ-03.18** — **Exención de turno:** se mantiene. Operación 24h se puede seguir registrando
  aunque el ingeniero haya finalizado su turno o la unidad tenga el turno cerrado (D-040, D-045). Es
  una bitácora de operación continua 24 horas.
- **RQ-03.19** — **Solo el día de hoy es registrable** (`fecha_no_es_hoy`, RF de F17). El cierre
  automático de fin de día por sweeper se mantiene (RF-061).
- **RQ-03.20** — **Permisos:** siguen creando en MAND únicamente `Ingeniero Jefe de Turno`,
  `Ingeniero de Operación` y `Administrador y Debugging`, por la matriz data-driven.

### 3.6 Publicación al dashboard de generación

- **RQ-03.21** — Se **conserva** la restricción de unicidad `UQ_evento_planta_fecha_periodo_tipo` de
  `bitacora.evento_dashboard`. El dashboard sigue viendo **un solo valor** por periodo y tipo.
- **RQ-03.22** — El valor publicado se decide **por celda `(planta, fecha, periodo, tipo)`**, no por
  lote: gana el **registro vivo de esa celda con la hora de llamada más reciente** (no por orden de
  guardado). Si dos registros tienen la misma hora, desempata el creado más recientemente. Los
  registros **sin hora** (migrados) van **últimos** y **nunca ganan por hora**.
  > ⚠️ **Corrección de redacción (D-056).** La versión original decía "el **lote** más reciente por
  > hora". Los lotes se solapan **parcialmente**: si A cubre P14–P18 a las 09:12 y B cubre P16–P20 a
  > las 09:40, entonces **P14–P15 publican A y P16–P20 publican B**. Leído "por lote", el
  > implementador publica mal los periodos solapados. **D-057 hereda esta redacción corregida**: al
  > editar o borrar un lote, el recálculo es celda por celda.
- **RQ-03.23** — Al **borrar** el registro que estaba publicado, el dashboard **retrocede al
  anterior vigente** de esa celda (el siguiente más reciente por hora). Si no queda ninguno, la fila
  de `evento_dashboard` se **borra** y el periodo queda sin evento.
- **RQ-03.24** — Toda mutación que cambie lo publicado dispara la notificación al dashboard
  (`notifyDashboard`, Contrato 3), post-commit y fire-and-forget, como hoy.

## 4. Reglas de negocio y casos borde

- **RN-03.a** — Un lote sin ninguna celda con valor **no se guarda**. Si el usuario llenó metadata
  pero ninguna celda, se rechaza con un mensaje explícito. **Nunca un 200 mentiroso** (lección de
  D-055 (2): el error `detalle_sin_celdas` existe justamente por esto).
- **RN-03.b** — El guardado es **atómico**: o entran todos los lotes del Guardar o no entra ninguno.
  Si un lote es inválido, se rechaza la operación completa con el detalle por celda, y **la grilla
  NO se vacía** (RQ-03.2 solo aplica tras confirmación exitosa) — el usuario no puede perder lo que
  escribió por un error de validación.
- **RN-03.c** — El lock de Redespacho protege **el valor**, nunca el comentario ni la hora (principio
  heredado de D-055 (2)).
- **RN-03.d** — La hora de llamada es un dato del **día de la grilla**. Debe interpretarse en zona
  horaria de Bogotá explícita (D-020 / §7.10 del modelo de BD), nunca en la zona del navegador.
- **RN-03.e** — Los periodos 1..6 de la grilla del día F pertenecen al **turno T2 que arrancó a las
  18:00 del día F-1** (T2 cruza medianoche). La resolución de `turno_id` debe seguir usando
  `fechaOperativaDePeriodo` (`server/utils/turno.js:49-57`) y **no** resolverse por el día de la
  grilla ni por `inicio_nominal`/`fin_nominal` — esos los muta `extenderTurno` (D-046) y las
  ventanas dejan de particionar. Caso real: registro 4722 (D-055 (3)).
- **RN-03.f** — Cada registro del lote se refleja a `SALAJDT` y `SALAING` (REQ-02).
- **RN-03.g** — La planta de test `TST` (D-030) opera con el mismo modelo; ninguna prueba debe
  escribir en `GEC3`/`GEC32` (D-055 (1)).

## 5. Impacto técnico

### 5.1 El cambio es estructural, no cosmético

Buena parte de la mecánica actual de MAND **deja de tener sentido**, no se adapta:

| Pieza | Qué pasa |
|---|---|
| Máquina de 4 casos por celda (`mand.js:238-393`) | Desaparece. Existía para decidir INSERT / UPDATE / DELETE / no-op sobre el registro único del periodo. En append-only **siempre es INSERT**. |
| `GET /api/sala-de-mando` (`mand.js:40-90`) | Deja de alimentar la grilla (que nace vacía). Su consulta —con el desempate "el primero gana" por celda— se reemplaza por la del histórico (REQ-04). |
| UPDATE de metadata a nivel de fila (`mand.js:395-454`) | Desaparece: la metadata nace con el lote, no se re-aplica. Con ella se va el error `detalle_sin_celdas` en su forma actual (se conserva la regla, cambia el punto de validación — RN-03.a). |
| `modificado_por` selectivo (D-019) | Pierde sentido en la grilla (nada se modifica al registrar). Sigue vigente para las correcciones desde el histórico (REQ-04). |
| Buffer / snapshot / diff (`SalaDeMandoGrid.jsx:28-86`) | Se simplifica: ya no hay `snapshot` del servidor contra el que diferenciar. Solo hay buffer de captura. |
| `beforeunload` con `dirty` (`SalaDeMandoGrid.jsx:159-166`) | Se conserva: sigue habiendo captura sin guardar que se puede perder. |
| Multi-select estilo Excel y replicado con Enter (`:204-309`) | Se conservan: siguen siendo la forma cómoda de llenar un rango de periodos del mismo lote. |

### 5.2 Storage

`campos_extra` de cada registro (hoy `{periodo, valor_mw, funcionariocnd}`) necesita al menos:
- la **hora de la llamada**,
- un **identificador de lote**, para poder agrupar en el histórico y corregir/borrar en bloque
  (REQ-04).

Decisión abierta para el implementador: si el lote se modela como un campo más en `campos_extra` o
como una entidad propia. **Recomendación:** identificador en `campos_extra` (sigue el patrón vigente
de MAND, no requiere DDL nuevo y mantiene el registro autocontenido); una entidad `lote` solo se
justifica si el histórico necesita atributos propios del lote que no se puedan derivar.

### 5.3 `upsertEventoDashboard` debe cambiar

`server/utils/notificador.js:45-91` hoy tiene tres caminos: si existe fila `activa=1` **devuelve
`conflict` y no actualiza**; si existe `activa=0` la reactiva; si no existe, inserta.

Con RQ-03.22 el comportamiento requerido es distinto: la fila publicada debe **actualizarse** cuando
llega un lote más reciente por hora de llamada, y debe **retroceder** al anterior cuando el
publicado se borra (RQ-03.23). Eso implica que la resolución de "cuál es el vigente" pase a ser una
consulta sobre los registros del periodo, no un simple upsert ciego.

> ⚠️ **No borres el soft-delete donde corresponde.** D-055 (4) estableció: `evento_dashboard` se
> **borra** cuando el registro de origen desaparece (el puntero quedaría huérfano — 35 filas reales
> en producción), pero se **desactiva** (`activa=0`) en `cerrarDiaMand`, donde el origen no
> desaparece sino que migra al histórico. Esa distinción se mantiene.

### 5.4 🔴 Migración de datos — excepción a RF-032

**Los registros existentes se convierten al modelo nuevo, incluidos los ya archivados en
`bitacora.registro_historico`.**

Esto toca el libro inmutable (RF-032). Es aceptable con el mismo criterio y las mismas garantías que
las migraciones F30.A1 (D-053) y F31.A1 (D-055):

- **No altera valores, autores ni fechas** — es reestructuración de trazabilidad.
- **Tabla de respaldo residente** antes de tocar nada (precedente:
  `registro_historico_backup_D053`, que **no se borra**).
- **Nunca adivina.** La **hora de llamada de los registros previos se deja vacía**: ese dato no
  existía y no se puede inferir. Lo no resoluble se registra en log, no se rellena.
- **Idempotente**, marcada en `bitacora.migracion_aplicada`.
- Cada registro previo se convierte en un lote de un solo periodo, conservando su `detalle` y
  `funcionariocnd`.

### 5.5 Archivos a tocar

| Archivo | Cambio |
|---|---|
| `server/routes/mand.js` | Reescritura del `POST /guardar` (append-only) y del `GET` (deja de alimentar la grilla). |
| `server/utils/notificador.js` | Nueva resolución del vigente publicado (§5.3). |
| `server/utils/mand-sweeper.js` | El cierre diario debe archivar el nuevo modelo, arrastrando `turno_id` (ya lo hace) y la hora. |
| `server/db.js` | Migración de conversión + respaldo residente. |
| `src/components/SalaDeMando/SalaDeMandoGrid.jsx` | Grilla de captura: campo hora, vaciado post-guardado, sin edición. |
| `src/hooks/useSalaDeMando.js` | Nuevo shape del payload; el `GET` de grilla deja de usarse como fuente. |
| `server/tests/sala_de_mando_batch.test.js` | Suite completa. **Todos los tests de MAND van en este archivo** (D-055: `setupSessions()` mata las otras sesiones de la misma fixture → dos archivos sobre la misma fixture se dan 401 mutuo). |

### 5.6 Guardarraíles que deben seguir pasando

- `guard_no_prod_historico_destruction.test.js` — todo DELETE/UPDATE sobre `registro_historico` /
  `registro_activo` / `evento_dashboard` / `mand_cierre_log` exige un acotador de fixture léxicamente
  visible (D-055 (6)).
- `guard_no_prod_disp_destruction.test.js`
- `zzz_session_leak_guard.test.js` (último del script `test`)
- **No reintroducir una allowlist de plantas en el endpoint.** D-055 (1) la retiró de `mand.js`
  precisamente porque hacía imposible usar la fixture `TST` y provocaba que la suite borrara
  histórico real.

## 6. Criterios de aceptación

1. **Dado** que entro a Operación 24h, **entonces** las 3×24 celdas están vacías, aunque el día ya
   tenga registros.
2. **Dado** que selecciono los periodos 14 a 18 de la fila Autorización, escribo 150 MW, hora,
   funcionario y descripción, **cuando** guardo, **entonces** se crean **cinco** registros con esa
   misma metadata, **y** la grilla queda vacía.
3. **Dado** el mismo periodo 14, **cuando** registro una segunda autorización con otro valor, otra
   hora y otro funcionario, **entonces** **coexisten los dos** — el primero no se pisó ni se borró.
4. **Dado** un lote guardado, **cuando** intento modificarlo desde la grilla, **entonces** no hay
   forma de hacerlo (la grilla no carga lo guardado).
5. **Dado** que abro la fila Autorización, **entonces** el campo hora viene precargado con la hora
   actual de Bogotá y puedo cambiarlo.
6. **Dado** un lote sin hora, **cuando** intento guardar, **entonces** se rechaza con mensaje claro.
7. **Dado** un lote de Redespacho con un valor en un periodo ya pasado, **cuando** guardo,
   **entonces** se rechaza con `periodo_bloqueado` (el lock sigue vigente).
8. **Dado** un lote de Prueba o Redespacho, **cuando** reviso lo guardado, **entonces** el
   funcionario del CND está vacío (regla sin cambios).
9. **Dado** metadata llena pero ninguna celda con valor, **cuando** guardo, **entonces** se rechaza
   con mensaje explícito y **no** se responde éxito.
10. **Dado** un error de validación en cualquier lote, **cuando** guardo, **entonces** no se escribe
    nada **y la grilla conserva lo que había escrito**.
11. **Dado** dos autorizaciones para el periodo 14 con horas 09:12 y 09:40, **cuando** consulto el
    dashboard de generación, **entonces** muestra el valor de las **09:40**.
12. **Dado** ese escenario, **cuando** borro el lote de las 09:40, **entonces** el dashboard pasa a
    mostrar el de las **09:12**; **y cuando** borro también ese, **entonces** el periodo queda sin
    evento.
13. **Dado** un registro de la madrugada (periodo 3) de la grilla del día F, **cuando** reviso su
    `turno_id`, **entonces** apunta al turno T2 iniciado el día F-1.
14. **Dado** que el ingeniero finalizó su turno o la unidad tiene el turno cerrado, **cuando**
    registro en Operación 24h, **entonces** funciona (exención intacta).
15. **Dado** el despliegue de la migración, **cuando** reviso los registros previos, **entonces**
    quedaron convertidos, con hora vacía, sin cambios en valores/autores/fechas, y existe la tabla
    de respaldo.
16. **Dado** `npm test`, **entonces** pasa la suite completa incluidos los guardarraíles de §5.6,
    y **ningún** dato de `GEC3`/`GEC32` fue modificado por la corrida.

## 7. Fuera de alcance

- El listado, la corrección y el borrado de lo registrado → [REQ-04](./REQ-04-historico-en-apartado.md).
- La copia hacia las bitácoras de Sala → [REQ-02](./REQ-02-reflejo-bitacoras-sala.md).
- El asiento de cambio de despacho → [REQ-05](./REQ-05-asiento-cambio-despacho.md).
- La exportación a Excel → [REQ-06](./REQ-06-excel-eventos-operacion.md).
- Cambiar el modelo de Disponibilidad (no se toca).
- Cambiar quién puede escribir en Operación 24h.
- Registrar en días distintos de hoy.

## 8. Preguntas abiertas — **las tres quedaron RESUELTAS en D-056**

### 8.1 Modelado del lote — ✅ resuelta: `campos_extra.lote_id`

¿Identificador de lote dentro de `campos_extra` o entidad propia? Ver §5.2 — hay recomendación, no
decisión cerrada. Conviene resolverlo junto con REQ-04, que es quien consume la agrupación.

> **Resuelto (D-056):** identificador **en `campos_extra`** — `lote_id`, un GUID de 36 chars que
> genera el **servidor** por fila/tipo en cada Guardar. Sin DDL: `campos_extra` viaja tal cual al
> histórico. Se descartó explícitamente optimizarlo con columna computada o índice sobre
> `JSON_VALUE(...,'$.lote_id')` — las consultas ya filtran por bitácora + planta + día. Contrapartida
> asumida: la metadata del lote queda **replicada en cada celda** sin constraint que la mantenga
> coherente; la sostiene un **guard de coherencia** (test) en `sala_de_mando_batch.test.js`, que es
> la red que D-057 va a necesitar al introducir la edición por lote.

### 8.2 Desempate de horas iguales — ✅ resuelta: gana el creado más reciente, **por celda**

RQ-03.22 propone "gana el creado más recientemente" cuando dos lotes comparten hora de llamada.
¿Es correcto operativamente, o debería impedirse registrar dos lotes del mismo tipo y periodo con la
misma hora?

> **Resuelto (D-056):** se conserva "gana el creado más recientemente" y **no** se impide registrar
> dos veces la misma hora — prohibirlo rechazaría una captura legítima por una coincidencia de
> minuto. Con la aclaración que importa: **la decisión es por celda, no por lote** (ver la corrección
> de RQ-03.22). Orden completo:
> `CASE WHEN hora IS NULL THEN 1 ELSE 0 END, hora DESC, creado_en DESC, registro_id DESC`.

### 8.3 Límite de superposición — ✅ resuelta: sin tope y sin aviso

¿Hay un tope razonable de lotes por periodo y tipo en un día, o es abierto? Un tope no es necesario
funcionalmente, pero sirve como detector de digitación errónea.

> **Resuelto (D-056): abierto, sin tope y sin aviso de digitación.** Cualquier N sería arbitrario y
> le agregaría UI al listado mínimo. Se reevalúa solo si la operación real muestra el problema.
