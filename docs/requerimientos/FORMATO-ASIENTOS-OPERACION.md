# Formato normalizado de asientos de operación — análisis del F03 y propuestas de plantilla

| Campo | Valor |
|---|---|
| **Qué es** | Insumo de decisión previo a **D-058**. No es un REQ: es la especificación del **texto** que va a generar el sistema. |
| **Desbloquea** | [REQ-02 §8.1](./REQ-02-reflejo-bitacoras-sala.md) (plantilla del asiento en Sala) · [REQ-04 §8.1](./REQ-04-historico-en-apartado.md) (mensaje del listado) · [REQ-06 §8.1](./REQ-06-excel-eventos-operacion.md) (layout de la hoja) |
| **Fuente analizada** | `2026_01_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx` — 32 hojas (enero 2026), **342 eventos reales** |
| **Estado** | ✅ **Implementado por D-058** (2026-07-27) — las decisiones A..O están **cerradas y en código**. Este documento queda como la **especificación viva del texto**: si una plantilla o una convención cambia, se edita acá y en `server/utils/asientos/`, juntos. |

---

## 1. Qué es el F03 y cómo está armado

Formato controlado **GENE-F03** ("Estado G3 y eventos diarios de operación", versión 0, 2017),
diligenciado a mano en `\\pl-prduccion-12\OneDrive\…\SIGE G3\`. **Un libro por mes, una hoja por
día.** Cada hoja tiene:

```
FECHA: <dd/mm/aaaa>

TURNO: 00:00-06:00        JEFE DE TURNO: <nombre>   INGENIERO DE TURNO: <nombre> - <nombre>
HH:MM | DESCRIPCIÓN EVENTO Y/O ACTIVIDAD
06:00 | Se entrega unidad G3.0 E/L generando 142 MWh …

TURNO: 06:00 - 18:00      JEFE DE TURNO: …          INGENIERO DE TURNO: …
HH:MM | DESCRIPCIÓN EVENTO Y/O ACTIVIDAD
…

TURNO: 18:00 - 00:00      JEFE DE TURNO: …          INGENIERO DE TURNO: …
HH:MM | DESCRIPCIÓN EVENTO Y/O ACTIVIDAD
…
```

**Dos observaciones estructurales que condicionan el diseño:**

1. **El papel tiene TRES bloques de turno; el sistema tiene DOS.** Los bloques `00:00-06:00` y
   `18:00-00:00` son las **dos mitades del mismo T2** partido por la medianoche del calendario. El
   sistema fecha el T2 por su día de inicio (D-045). Al generar la hoja del día F hay que **partir el
   T2**: su cola (00:00–06:00) va arriba en la hoja de F, y su cabeza (18:00–24:00) va abajo.
2. **Todo va en una sola tabla cronológica.** Los eventos de Operación 24h, los de Disponibilidad y
   los que el ingeniero escribe libremente **conviven mezclados y ordenados por hora**. El generador
   tiene que **fusionar cuatro fuentes** (SALAJDT, SALAING, MAND, DISP) en un único orden por hora.

---

## 2. Inventario real: qué escriben, cuántas veces

| Familia | Filas | % | ¿Existe hoy en el sistema? |
|---|---:|---:|---|
| **Relevo de turno** (`Se entrega/recibe unidad …`) | 122 | 36 % | Parcialmente: la **conformación de turno** (D-045) ya sabe quién entrega y quién recibe |
| **Rutina diaria** (SIO, reporte a Gerencia, despacho XM, envío de disponibilidad al día siguiente) | 123 | 36 % | **No.** Nadie los captura hoy |
| **Eventos operativos libres** (disparos, sincronizaciones, fugas, transferencias, quemadores…) | ~40 | 12 % | Sí — es lo que se teclea en `SALAJDT` / `SALAING` |
| **Estado de la unidad** (F/L, E/L, indisponible, en pruebas) | ~50 | 15 % | Sí — es **DISP** |
| **Operación 24h** (AUTH / REDESP / PRUEBA) | **5** | 1,5 % | Sí — es **MAND** |

> **El hallazgo que más pesa en el alcance:** solo el **1,5 %** de las filas del F03 sale hoy de
> Operación 24h. Un Excel que exporte únicamente AUTH/PRUEBA/REDESP/DISP —lo que pide REQ-06— produce
> una hoja que **no se parece** al F03 que el ingeniero conoce: le faltarían el relevo de turno y la
> rutina diaria, que son el 72 % de los renglones. Hay que decidir explícitamente qué se hace con eso
> (ver §6, decisión D).

---

## 3. Los seis problemas de normalización (evidencia)

**(a) La unidad se escribe de nueve formas distintas.**
`G3.0` · `G3,0` · `G30` · `UG3.0` · `UG30` · `G3.2` · `G3,2` · `UG3.2` · `UG32`

**(b) Los MW se escriben de cuatro formas.** `150 MWh` · `90MW` · `164 MW` · `1383,92MWh`
(y se usa **MWh** donde la magnitud es **MW** — potencia, no energía).

**(c) Los periodos, de cinco formas.**
`P17 al P19` · `P14 al 18` · `en perido 20` (sic) · `del 01 al 24` · `Periodo 7=164MW, Periodo 8=140MW, …`

**(d) El mismo evento se narra distinto según quién escribe.** Las cinco filas de Operación 24h de
enero, tal cual:

| Fecha | Hora | Texto real |
|---|---|---|
| 06/01 | 19:45 | `Se redespacha en aplicativo RIO los periodos del 01 al 24 del 07/01/2025 en 0MW.` |
| 27/01 | 13:18 | `CND solicita subir maxima carga UG3.0 con P14 al 18 autorizados, Ivan Hernandez` |
| 27/01 | 17:00 | `CND informa redespachos como sigue P17: 109 MWh; P18: 134 MWh y P19: 164 MWh. Aplicativo.` |
| 30/01 | 16::38 | `Se recibe llamdaa CND (Jair Pardo) autorizando G3.0 a subir carga a 150 MWh P17 al P19` |
| 30/01 | 18:06 | `Se recibe llamdaa CND (Jair Pardo) autorizando G3.0 a bajar la carga a 115 MWh en perido 20` |

Cinco eventos, cinco estructuras: el funcionario va entre paréntesis, al final tras una coma, o no
va; el verbo es *autorizando* / *solicita* / *informa* / *se redespacha*; el año está mal en uno
(`07/01/2025` en un libro de 2026) y la hora tiene un typo (`16::38`).

**(e) Hay errores de digitación que sobreviven al archivo controlado.** `llamdaa`, `perido`,
`nuecamente`, `/S quemador A3`, `ramppa`, y una hoja duplicada (`2026-01-24 (2)`).

**(f) "Disponibilidad" nombra dos cosas distintas.** En el F03, `Se envía disponibilidad G3,0 en 164
MWh …` es el **trámite** de declarar al CND la disponibilidad del día siguiente. En el sistema, DISP
es el **estado** de la unidad (En Servicio / En Reserva / Indisponible / Mantenimiento). **No son lo
mismo y no deben mezclarse en el mismo template.**

---

## 4. Convenciones canónicas propuestas (transversales)

Aplican a **todas** las plantillas de abajo.

| Elemento | Canónico | Por qué |
|---|---|---|
| Unidad | **`GEC3`** · **`GEC32`** ✅ *decidido* | Un solo nombre en toda la app: el mismo de la BD, los permisos y el contrato cross-repo. Se descarta `G3.0`/`G3.2` pese a ser el habla del papel — dos nomenclaturas conviviendo es lo que produjo las nueve variantes de §3(a) |
| Potencia | **`150 MW`** (entero, espacio antes de la unidad) | Es potencia por periodo, no energía. `MWh` queda solo para la generación diaria acumulada |
| Periodo suelto | **`P20`** | |
| Rango contiguo | **`P17 al P19`** | La forma más frecuente hoy |
| No contiguos | **`P3, P7 y P19`** | Los lotes no contiguos se permiten (D-057) |
| Valores distintos | **`P17: 109 MW; P18: 134 MW; P19: 164 MW`** | Calcado del texto real del 27/01 |
| Hora | **`HH:MM`** Bogotá, 24 h | Sale de `hora_llamada` (D-056), no del momento de guardado |
| Cierre | Punto final siempre | |

**Regla de compactación:** si **todas** las celdas del lote comparten el mismo valor → forma
compacta (`a 150 MW P17 al P19`). Si difieren → lista con valor por periodo. El sistema ya tiene el
dato para decidirlo solo; el operador no elige.

---

## 5. Plantillas propuestas

Notación: `{campo}` es un dato que el sistema ya captura. `[…]` es un tramo que se omite si el dato
no existe.

### 5.1 Operación 24h — AUTORIZACIÓN (`AUTH`)

Datos disponibles: `hora_llamada`, `funcionariocnd` (obligatorio en AUTH, D-018), planta, periodos
con `valor_mw`, `detalle` (opcional).

```
Se recibe llamada del CND ({funcionariocnd}) autorizando {unidad} a {carga}[. {detalle}]
```

Donde `{carga}` es:
- mismo valor en todas las celdas → `generar 150 MW del P17 al P19`
- valores distintos → `generar P17: 109 MW; P18: 134 MW; P19: 164 MW`

**Ejemplo renderizado** (el caso real del 30/01, ya normalizado):

> `16:38 — Se recibe llamada del CND (Jair Pardo) autorizando GEC3 a generar 150 MW del P17 al P19.`

> ✅ **Decidido (A): sin verbo de sentido.** El original dice *"a **subir** carga"* / *"a **bajar** la
> carga"*, pero el sistema **no sabe** cuál de los dos es: conoce el valor autorizado, no el vigente
> contra el cual compararlo. Se escribe **"a generar {X} MW"**, que es lo único cierto. Si el
> ingeniero quiere dejar el matiz, lo escribe en el `detalle` y sale al final de la frase.

### 5.2 Operación 24h — REDESPACHO (`REDESP`)

Datos: `hora_llamada`, planta, periodos con `valor_mw`, `detalle`. **Sin funcionario** — D-018 fuerza
`funcionariocnd = NULL` en REDESP.

```
Se recibe del CND redespacho para {unidad}: {carga}[. {detalle}]
```

**Ejemplo** (caso real del 27/01):

> `17:00 — Se recibe del CND redespacho para GEC3: P17: 109 MW; P18: 134 MW; P19: 164 MW.`

Y el caso de redespacho plano a cero (06/01):

> `19:45 — Se recibe del CND redespacho para GEC3: 0 MW del P1 al P24. Aplicado en RIO.`
> (el `Aplicado en RIO` viene del `detalle` que escribe el operador — decisión C: **al final, tras
> punto**; si no hay `detalle`, la frase termina en el dato duro y no queda rastro del hueco)

### 5.3 Operación 24h — PRUEBA (`PRUEBA`)

Datos: `hora_llamada`, planta, periodos con `valor_mw`, `detalle`. Sin funcionario (D-018).

```
Se declara prueba de {unidad} a {carga}[. {detalle}]
```

**Ejemplo:**

> `08:00 — Se declara prueba de GEC32 a 270 MW del P9 al P11.`

> ⚠️ **Sin evidencia en el F03 de enero:** ninguna de las 342 filas registra una prueba del tipo
> Operación 24h (las 62 menciones de "prueba" son estado de la unidad: *"en pruebas"*). Esta
> plantilla es una propuesta a validar, no una observación.

### 5.4 Disponibilidad (`DISP`) — cuatro estados

Datos: `evento` (uno de los 4), `fecha_inicio_estado`, `detalle` (opcional). **No hay MW en DISP.**

| Estado | Plantilla | Ejemplo renderizado |
|---|---|---|
| `En Servicio` | `{unidad} E/L en servicio.[ {detalle}]` | `14:20 — GEC32 E/L en servicio. Sincronizada.` |
| `En Reserva` | `{unidad} disponible en reserva, sin generar.[ {detalle}]` | `03:15 — GEC3 disponible en reserva, sin generar.` |
| `Indisponible` | `{unidad} F/L indisponible.[ {detalle}]` | `16:29 — GEC3 F/L indisponible. Fuga en ducto de descarga del alimentador de carbón C.` |
| `Mantenimiento` | `{unidad} F/L en mantenimiento programado.[ {detalle}]` | `06:00 — GEC32 F/L en mantenimiento programado. Consignación C2048713.` |

Se conserva la jerga real del formato: **E/L** (en línea) y **F/L** (fuera de línea), que aparecen en
casi todas las filas de estado del F03.

### 5.5 Bitácoras de Sala (`SALAJDT` / `SALAING`) — **literal**

```
{hora} — {lo que escribió el ingeniero, tal cual}
```

**Sin plantilla, sin normalización, sin corrección ortográfica automática.** Son los eventos propios
del turno (disparos, maniobras, coordinaciones) y su valor está en el detalle que solo esa persona
puede describir. Ejemplos reales que se copiarían sin tocar:

> `06:09 — Disparo de ventilador inducido #2 por falla en unidad de lubricación.`
> `21:10 — Se coordina con Transelca (Freidel Villa) normalización de campo de salida de generación para unidad fuera de línea.`

---

## 6. Decisiones

### 6.1 Resueltas (ronda 1, 2026-07-26)

| # | Decisión | Resultado |
|---|---|---|
| **A** | El verbo subir/bajar en AUTH | ✅ **Omitirlo.** Se escribe *"autorizando GEC3 a generar 150 MW"*. El sistema no conoce el valor vigente contra el cual comparar; el matiz, si importa, va en el `detalle` |
| **B** | Nomenclatura de la unidad | ✅ **`GEC3` / `GEC32`.** Un solo nombre en toda la app, aunque el papel diga `G3.0`/`G3.2` |
| **C** | Dónde va el `detalle` libre | ✅ **Al final, tras punto.** La parte generada es siempre idéntica y el hueco no se nota cuando no hay detalle |
| **D** | El 72 % de filas del F03 que no salen de MAND ni DISP | ✅ **Son eventos de las bitácoras de Sala**, tecleados a mano por el JdT y el Ing. de Operación. Entran al Excel por la **vía literal** (§5.5): **no llevan plantilla, no se autogeneran, no se derivan de la conformación de turno.** El sistema no inventa un evento que nadie registró |

### 6.2 Estado de adopción — lo que el generador va a encontrar hoy

Consulta a la BD productiva el 2026-07-26:

| Fuente | Registros reales | Lectura |
|---|---:|---|
| `MAND` (GEC3 + GEC32) | 26 filas / 10 lotes | **En uso real** desde D-056 |
| `DISP` (GEC3 + GEC32) | 1 evento, fechado 2017-07-06 | Dato de prueba; sin uso operativo |
| `SALAJDT` + `SALAING` + `SALAOP` | 6 registros, todos de prueba (`as9doas`, `test ing de operación`) | **Sin uso operativo todavía** |

**Medición del libro real ya generado (2026-07-27, D-058 E9):** julio 2026 rinde **31 hojas y 20
renglones**, repartidos en 6 días (08, 09, 14, 15, 23 y 26); mayo y junio, **cero**. Cuadra exacto
con la BD: 15 lotes de MAND + 5 registros de Sala (`SALAOP` queda fuera por diseño). DISP no aporta
ninguno porque su único estado real arranca en 2017. El encabezado `JEFE DE TURNO` /
`INGENIERO DE TURNO` sale **en blanco casi todo el mes** y tampoco es defecto: la única presencia
registrada esos días es de un cargo que el F03 no nombra — el 2026-07-08, que sí tiene
`Ingeniero Jefe de Turno`, lo muestra en sus dos bloques.

Consecuencia que **debe** quedar dicha en D-058: el generador es correcto aunque la hoja salga casi
vacía. El F03 se llena hoy a mano y las bitácoras de Sala todavía no se usan — la hoja se parecerá al
formato conocido **cuando la gente registre ahí**, no cuando el código exista. Es adopción, no
software; y es la razón por la que **no** hay que compensar el hueco autogenerando texto.

### 6.3 Resueltas (ronda 2, 2026-07-26)

| # | Decisión | Resultado |
|---|---|---|
| **E** | Un libro por planta, o uno solo con las dos unidades | ✅ **Un solo libro con las dos unidades.** El formato de referencia las nombra juntas en la misma frase (*"Se entrega unidad G3.0 E/L … y G3.2 F/L …"*); partirlo por planta obligaría a duplicar o mutilar ese renglón. **Corrige RQ-06.3, RQ-06.6, RQ-06.9 y el criterio 3** de REQ-06, que pedían dos archivos |
| **F** | Cómo se parte el T2 en la hoja | ✅ **Tres bloques, como el papel** (`00:00-06:00` = cola del T2 de ayer · `06:00-18:00` = T1 de hoy · `18:00-00:00` = cabeza del T2 de hoy). El sistema fecha el T2 por su día de inicio (D-045), así que el generador **parte el T2 por medianoche**: cada evento cae en el día de calendario en que ocurrió y aparece **exactamente una vez** en todo el libro |
| **G** | La plantilla de PRUEBA (sin evidencia en las 342 filas) | ✅ **`Se declara prueba de {unidad} a {carga}`** — redacción neutra, sin suponer que la origina el CND (coherente con D-018, que fuerza `funcionariocnd = NULL` en PRUEBA: si la autorizara el CND, habría que registrar quién) |
| **H** | Corrección (D-057) y asiento ya replicado en Sala | ✅ **Reescribir el asiento.** Corregir el lote regenera el texto; borrarlo borra el asiento. La bitácora de Sala refleja **siempre** el estado actual — es justo lo que REQ-02 pide (*"sin que puedan desincronizarse"*). El rastro de la corrección vive en `modificado_por`/`modificado_en` del registro MAND, no en un renglón duplicado |

### 6.4 Resueltas (ronda 3, 2026-07-26) — consecuencias de E y H

#### I — La unidad en los renglones que vienen de Sala

**Decisión: prefijo `{UNIDAD} — ` solo en los asientos de Sala.** MAND y DISP **no** se prefijan: sus
plantillas ya nombran la unidad dentro de la frase, y prefijarlos produciría
`GEC3 — Se recibe llamada del CND … autorizando GEC3 a …`.

**Por qué no la columna extra:** el layout GENE-F03 tiene **dos** columnas y el área de impresión es
`A6:I2x`; pero el argumento que la mata no es la fidelidad sino un dato: **hay renglones que hablan de
las dos unidades a la vez** (`Se entrega unidad G3.0 E/L generando 142 MWh y G3.2 F/L en
mantenimiento`). Una columna "UNIDAD" exige un valor único que en esos casos **no existe**.

**Cómo:**

- La unidad del prefijo sale de `registro_activo.planta_id` — la unidad de la **sesión que escribió**
  el registro. Es honesto: dice de qué unidad **es el asiento**, no de qué habla el texto.
- **Anti-duplicado obligatorio:** si el texto ya empieza nombrando la unidad, no se prefija. Sin esto
  salen renglones como `GEC3 — G3.0 sincronizada.` (pasa seguido: el 40 % de los eventos libres
  de enero arranca con la unidad).
  ```js
  const YA_NOMBRA_UNIDAD = /^\s*(GEC3\b|GEC32\b|U?G\s?3[.,]?[02]\b)/i;
  const asiento = YA_NOMBRA_UNIDAD.test(texto) ? texto.trim() : `${unidad} — ${texto.trim()}`;
  ```
- Guion largo `—` con espacios a ambos lados, nunca `-`, para no chocar con el separador de nombres
  de ingenieros (`Jose Saavedra - Luis Zapata`).

#### J — Qué mes se descarga

**Decisión: selector de mes** (`<input type="month">`) junto al botón, con el mes en curso por
defecto.

**Por qué:** RQ-06.4 dice *"el mes de la fecha en curso del apartado"*, pero Operación 24h **no tiene
selector de fecha** — solo muestra HOY (D-017, reafirmado por D-056). Así que "la fecha en curso" es
siempre hoy y **el mes cerrado queda inalcanzable el día 1**, que es exactamente cuando el F03 se
consolida y se archiva. El requisito, leído literal, falla en su caso de uso principal.

**Cómo:**

- Subestado en el **hash** (`#/op24h?mes=YYYY-MM`), con `replaceState` — es subestado, no sección
  (D-035). **No** reutilizar el `fecha` de COMB ni el día de la grilla: son controles distintos.
- El mes se calcula en **Bogotá** (`fechaBogotaStr`), nunca con `new Date().getMonth()` (D-020).
- Endpoint `GET /api/sala-de-mando/reporte-mensual?mes=YYYY-MM`, gated por `puede_crear` en MAND
  (RQ-06.11/12, data-driven). Validación server-side: formato estricto `^\d{4}-(0[1-9]|1[0-2])$`,
  **rechazo de mes futuro** con `400 mes_futuro` (paridad con el `fecha_futura` de COMB) y tope
  inferior en el primer registro existente.
- Un mes sin ningún evento **no es error**: devuelve el libro con sus hojas vacías (RQ-06.8).

#### K — La cascada a Sala frente al histórico inmutable

**Decisión: la cascada alcanza solo las copias VIVAS** (`registro_activo`). Si la copia ya se
archivó, **el histórico no se toca** (RF-032 intacto) y la corrección del origen **procede igual**.

**Por qué no el 409:** haría que un lote se vuelva **incorregible a las 18:01** por el estado de su
*reflejo* — invierte la jerarquía, el reflejo pasaría a gobernar al origen. Y contradice el criterio
12 de REQ-04, ya implementado y probado en D-057: MAND es **exenta** de los gates de turno; un 409 por
"turno cerrado" reintroduce por la puerta de atrás justo lo que se excluyó por diseño.

**Cómo:**

- Vínculo copia↔origen: `campos_extra.origen_lote_id` (+ `origen_bitacora: 'MAND'`) en la copia.
  **Por `lote_id`, nunca por `registro_id`**: el mismo argumento de D-055 (c) / D-057 (1) — la copia
  *también* migra a `registro_historico`, así que no hay FK posible y el `registro_id` del origen
  cambia de tabla.
- El `UPDATE`/`DELETE` de la cascada va **dentro de la misma transacción** del PUT/DELETE de MAND,
  acotado así:
  ```sql
  ... FROM bitacora.registro_activo
  WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote_id
    AND bitacora_id IN (@salajdt, @salaing)
  ```
- **`rowsAffected = 0` NO es error** — significa que las copias ya se archivaron, que es el caso
  esperado después del cierre de turno. Documentarlo en el código: es exactamente la clase de "cero
  filas" que alguien va a querer "arreglar" con un `throw`.
- El punto de enganche ya está **anotado sin código** en `server/routes/mand.js` (≈L532 en el `PUT`,
  ≈L645 en el `DELETE`), puesto ahí por D-057.

#### L — Qué `tipo_evento` llevan los asientos reflejados

**Decisión: tipos espejo por bitácora**, sembrados en el `MERGE` de `db.js` (no un `INSERT`
one-shot: los catálogos se reconstruyen en cada arranque).

**Corrección sobre el planteo original — son 8 filas, no 6.** El catálogo real (verificado en BD el
2026-07-26) es:

| Bitácora | `tipo_evento` existentes |
|---|---|
| `MAND` | `Autorización` (20) · `Pruebas` (21) · `Redespacho` (22) |
| `DISP` | `Evento General` (1) · `Cambio de Disponibilidad` (23) |
| `SALAJDT` | `Evento General` (17) |
| `SALAING` | `Evento General` (28) |

Dos consecuencias: **(a)** los nombres exactos son `Autorización` / `Pruebas` / `Redespacho` — con
tilde y `Pruebas` en plural, no "Prueba"; si no se copian literales, el histórico muestra dos
etiquetas para lo mismo. **(b)** REQ-02 refleja **también DISP**, que el planteo original no
contempló: hace falta un cuarto tipo espejo `Cambio de Disponibilidad`. Total: **4 tipos × 2
bitácoras = 8 filas** de seed.

**Cómo:**

- Resolver `tipo_evento_id` **por `(bitacora_id, nombre)` en el momento de insertar**, jamás cachear
  un id literal: `guard_tipo_evento_coherente.test.js` (D-053) falla si el tipo no pertenece a la
  bitácora del registro, y los ids nuevos los asigna la BD.
- Los tipos espejo **no** habilitan escritura manual: el operador sigue teclando en `Evento General`.
  Que existan en el catálogo no cambia la matriz de permisos.

### 6.5 Resueltas (ronda 4, 2026-07-26) — implementación del reflejo y del generador

#### M — Los 8 tipos espejo vs. "solo MAND se cablea"

**Decisión: sembrar los 8, cablear solo MAND — y agregar `lov_bit.tipo_evento.seleccionable`.**

El planteo "6 u 8" **esconde el problema real**, que aplica igual a las dos cifras. Verificado en la
BD el 2026-07-26: `lov_bit.tipo_evento` tiene `(tipo_evento_id, bitacora_id, nombre, es_default,
orden, notificar_dashboard_tipo)` — **no hay columna de visibilidad**, y
`GET /api/catalogos/bitacoras/:id/tipos-evento` (`routes/catalogos.js:58`) devuelve **todos** los
tipos de la bitácora sin filtrar. Ese endpoint alimenta el selector de tipo de `GrillaRegistros`.

Consecuencia: **cualquier** tipo espejo que se siembre se vuelve **tecleable a mano**. El JdT vería
`Autorización` como opción en SALAJDT y podría crear un asiento que **no refleja ningún lote** — sin
`origen_lote_id`, indistinguible de un reflejo real para el Excel, e imposible de rastrear al origen.
Es la doble digitación que REQ-02 viene a eliminar y la mezcla de responsabilidades que D-053 separó.

**Cómo:**

- Columna nueva `seleccionable BIT NOT NULL DEFAULT 1` en `lov_bit.tipo_evento` (migración
  idempotente en `initDB()`, patrón de `cantidad_max` en D-034). Nombre deliberado: **no** `activo`,
  que se confunde con "bitácora activa" — dice exactamente qué controla, si aparece en el selector de
  captura manual.
- El endpoint de catálogos filtra `WHERE seleccionable = 1`. Los 8 espejo se siembran con
  `seleccionable = 0`: existen para el reflejo, para el histórico y para filtrar por tipo, pero
  **nadie los puede elegir a mano**.
- El reflejo resuelve el id por `(bitacora_id, nombre)` directo contra la tabla, sin pasar por el
  endpoint, así que el filtro no lo afecta.
- Sembrar los 8 de una vez (incluido `Cambio de Disponibilidad`) **no** deja filas ruidosas, porque
  con `seleccionable = 0` son invisibles — y evita volver a tocar el seed cuando se cablee DISP.
- **D-058 cablea solo MAND.** El reflejo de DISP (crear / editar / deshacer, con la copia marcada
  como anulada) es su propio ADR: suma un estado visual nuevo a la grilla de Sala y tres enganches
  más, y no comparte casi nada con el generador del Excel.

#### N — Qué hora y qué turno lleva el asiento copiado a Sala

**Decisión: `fecha_evento = hora_llamada` (16:38) — pero `turno_id` = el turno ABIERTO de la unidad
al momento de insertar, no el que corresponde a esa hora.**

**La hora**, porque el asiento tiene que leerse donde el operador lo espera y coincidir con el Excel
y con el listado del día. Es para lo que D-056 creó `hora_llamada`.

**El turno, porque `turno_id` no es un dato narrativo: es el puntero de archivado.** El cierre archiva
**por `turno_id`** (D-045). Si la copia apunta a un turno ya `CERRADO`, **nadie la archiva nunca**:
queda viva en `registro_activo` para siempre, apareciendo en la bitácora de Sala meses después. Y el
rescate de huérfanos de D-045 no la alcanza — ese solo levanta los de `turno_id IS NULL` en-ventana,
y esta *tiene* turno.

No contradice a [[D-055]] (b), que resuelve `turno_id` por el **periodo** en MAND: allá la celda
pertenece semánticamente a un periodo. Acá el asiento es del **lote entero**, cuyos periodos pueden
caer en dos turnos distintos — no hay turno semántico único, así que manda el criterio de archivado.

**Cómo:**

- `resolverTurnoAbierto(t, planta_id)` (`utils/turno-entidad.js`) dentro de la **misma transacción**.
- Si no hay turno abierto (ventana de transición, D-046): `turno_id = NULL` y `fecha_evento` en la
  hora de llamada → ahí sí lo levanta el archivado de huérfanos en-ventana de D-045.
- En el caso normal —llamada y registro en el mismo turno— los dos criterios coinciden. La
  divergencia aparece **solo** al cruzar el umbral, que es exactamente cuando importa.

#### O — Quién produce la plantilla `.xlsx`

**Decisión: derivarla por script, con el script versionado en el repo.** Reproducible, regenerable si
el formato controlado cambia, y no bloquea la etapa del generador esperando un archivo hecho a mano.

**Corrección de la premisa:** [REQ-01 §5.1](./REQ-01-descarga-combustibles.md) ya decidió **no agregar
dependencias** (`exceljs`/`xlsx` prohibidas; el backend tiene seis deps y así se queda) y reutilizar
`Bit-cora-g3/js-scraper-carbon-g32/xlsx-write.js` — escritor OOXML propio con CRC32 y ZIP **stored**.
Ese escritor **emite pero no lee**, y un `.xlsx` de Excel viene en **deflate**. Entonces:

- **El script de derivación corre offline** (en el repo, no en runtime): lee el F03 de enero
  descomprimiendo con **`zlib.inflateRawSync`** — nativo de Node, sin dependencias —, borra las filas
  de datos de una hoja conservando encabezado, logo, estilos, merges y área de impresión, y **re-emite
  el artefacto como ZIP *stored*** con el escritor existente.
- Así el archivo que queda en `server/assets/` es **directamente consumible**: en runtime el generador
  solo clona sus partes e inyecta los `sheetN.xml`. **Cero dependencias en producción.**
  > **Corregido el 2026-07-28:** el libro que se entrega sale **comprimido (DEFLATE)**, no `stored`.
  > Un paquete OOXML sin comprimir es legal pero **ningún `.xlsx` real viene así**, y en el camino de
  > una descarga corporativa (antivirus, DLP, proxy) conviene que el archivo se vea como cualquier
  > otro; de paso pesa 3× menos. `deflateRawSync` también es nativo, así que la premisa de cero
  > dependencias no cambia. Ver el addendum de **D-058**.
- **Usar `inlineStr` para las filas de datos**, no `sharedStrings`: evita reindexar la tabla de
  strings de la plantilla y el riesgo de corromperla. El `sharedStrings.xml` heredado queda intacto.
- El logo vive en `xl/media/` y se copia tal cual; su `drawing` referencia por `rId` y no hay que
  tocarlo mientras no se muevan las filas del encabezado.
- **La trampa que hay que atender:** el área de impresión es **por hoja**
  (`<definedName name="_xlnm.Print_Area" localSheetId="N">`) y en el original hay **una por cada uno
  de los 32 sheets**, con rangos distintos (`$A$6:$I$25` … `$A$6:$I$32`) según cuántos eventos tuvo el
  día. El generador tiene que **emitir un `definedName` por hoja con su `localSheetId` y su rango
  final calculado**. Si se clona el bloque de la plantilla sin recalcular, Excel imprime rangos
  vacíos o corta los días largos.

### 6.6 Sin resolver — se trata al abordar el segundo formato

- **REQ-01 (descarga de Combustibles)** sigue diciendo **"un archivo por planta"** (RQ-01.3, RQ-01.5).
  **No se tocó**: su formato de referencia es el otro libro
  (`2026_04 Reporte diario de generación y combustible G3 y G32.xlsx`), que **por su propio nombre
  parece cubrir también las dos unidades** — pero eso hay que verificarlo contra el archivo, no
  suponerlo por analogía con el F03. Queda anotado para la sesión del formato 2.

**Lo que D-058 deja construido y esa sesión NO tiene que rehacer:**

- **El escritor/lector OOXML en ESM** (`server/utils/xlsx.js`): `leerZip` (recorre el central
  directory, soporta `stored` y `deflate`) y `escribirZip` (**emite DEFLATE**, devuelve `Buffer`),
  sin dependencias.
- **El patrón "derivar plantilla offline + clonar bytes en runtime"**, con su script versionado
  (`scripts/derivar-plantilla-f03.mjs`). El formato 2 replica el patrón con **su** archivo real.
- **Las trampas ya pagadas**, que valen para cualquier libro clonado: `inlineStr` en vez de
  `sharedStrings` (agregar entradas reindexa la tabla y corrompe el encabezado clonado);
  `Print_Area` **por hoja** con su rango recalculado junto a `dimension`/`mergeCells`; el alto de
  fila **estimado** porque Excel no autoajusta una celda combinada con `wrapText`; el
  `sheetPr/@codeName` **único por hoja** (clonar N hojas del mismo modelo las deja compartiendo la
  identidad VBA); el paquete **comprimido**; y, del lado del navegador, **no revocar el object URL en
  el mismo tick del `click()`** — eso trunca la descarga.
- **El mapa de índices de estilo** del F03 vive en la cabecera del script y en la constante `S` de
  `server/utils/f03-libro.js` — el formato 2 necesita el suyo, medido igual, no adivinado.

**Cerrado (D-063, 2026-08-29):** el reflejo de **Disponibilidad** a las bitácoras de Sala —con su
copia anulada, RQ-02.12— quedó implementado sobre estas mismas plantillas y el mismo módulo, y ya no
hay nada abierto del lado del texto. Ver **D-063** y RF-077.

---

## 7. Layout de la hoja generada (1:1 con el F03)

Medido sobre las hojas reales. Columnas **A..I**; el área de impresión del original va de `A6` hasta
`I25`..`I32` según cuántos eventos tenga el día.

```
 fila  A                        B / D
 ────────────────────────────────────────────────────────────────────────────
  1    Código: GENE-F03         D: Título: Estado G3 y eventos diarios de operación
  2    Versión: 0
  3    Página 1 de 1            D: Responsable: Gerente de Producción
  4    Fecha: 01/06/2017        (fecha de emisión del FORMATO, no del día — es fija)
  6    FECHA:                   B: <día de la hoja, dd/mm/aaaa>
 ────────────────────────────────────────────────────────────────────────────  bloque 1
  9    TURNO:                   D: 00:00-06:00      ← cola del T2 que arrancó AYER
 10    JEFE DE TURNO:           D: <nombre>
 11    INGENIERO DE TURNO:      D: <nombre> - <nombre>
 12    HH:MM                    B: DESCRIPCIÓN EVENTO Y/O ACTIVIDAD
 13..  <hora>                   B: <asiento>        ← n filas, orden ASCENDENTE por hora
 ────────────────────────────────────────────────────────────────────────────  bloque 2
  +1   TURNO:                   D: 06:00 - 18:00    ← T1 de HOY
  …    (mismo patrón: jefe, ingenieros, encabezado, n filas)
 ────────────────────────────────────────────────────────────────────────────  bloque 3
  +1   TURNO:                   D: 18:00 - 00:00    ← cabeza del T2 de HOY
  …    (mismo patrón)
```

**Detalles que se calcaron del original:** el logo va en `xl/media`; `Fecha: 01/06/2017` es la fecha
de emisión del formato controlado y **no cambia**; los tres bloques **crecen hacia abajo** según los
eventos, así que las filas 13+ no son fijas; la hora se guarda como **fracción de día** con formato
`HH:MM` (no como texto).

### 7.1 De dónde sale cada celda

| Celda | Fuente en el sistema |
|---|---|
| `FECHA:` | El día de la hoja (día Bogotá) |
| `TURNO:` | Literal fijo por bloque (`00:00-06:00`, `06:00 - 18:00`, `18:00 - 00:00`) |
| `JEFE DE TURNO:` | `conformacion_turno` del turno que cubre ese bloque — cargo `Ingeniero Jefe de Turno` |
| `INGENIERO DE TURNO:` | Ídem, cargo `Ingeniero de Operación`, unidos por ` - ` |
| `HH:MM` | `hora_llamada` en MAND (D-056) · `fecha_inicio_estado` en DISP · `fecha_evento` en Sala |
| `DESCRIPCIÓN` | La plantilla de §5 según el origen, o el texto **literal** si viene de Sala |

### 7.2 Algoritmo de armado

1. Para el día **F**, resolver los tres bloques: `[F 00:00, F 06:00)` (pertenece al T2 abierto el día
   **F-1**), `[F 06:00, F 18:00)` (T1 de F) y `[F 18:00, F+1 00:00)` (T2 de F).
2. Traer los eventos de las **cuatro** fuentes (MAND, DISP, SALAJDT, SALAING) de **ambas unidades**,
   con su hora canónica, y asignar cada uno a su bloque **por la hora del calendario**, no por el
   `turno_id`. Un evento cae en **un solo** bloque de **un solo** día.
3. Renderizar cada evento: plantilla de §5 para MAND y DISP; texto literal para Sala.
4. Ordenar **ascendente por hora** dentro del bloque (el listado en pantalla va descendente por
   `hora_llamada` — RN-04.a — pero el papel va ascendente; **son órdenes distintos a propósito**).
5. Escribir el bloque; si no tiene eventos, quedan el encabezado y ninguna fila.

> **La fuente de la hora importa.** En MAND es `hora_llamada` (cuándo llamó el CND), **no**
> `fecha_evento` (cuándo se guardó): un lote registrado a las 17:05 por una llamada de las 16:38 va en
> la fila de las **16:38**. Es exactamente para lo que D-056 creó el campo.
