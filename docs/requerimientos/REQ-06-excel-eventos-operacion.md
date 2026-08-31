# REQ-06 — Excel mensual de eventos de operación

| Campo | Valor |
|---|---|
| **Código** | REQ-06 |
| **Título** | Descarga del libro mensual con redespachos, autorizaciones, pruebas y eventos de disponibilidad |
| **Estado** | ✅ **IMPLEMENTADO por D-058** (2026-07-27) — `GET /api/sala-de-mando/reporte-mensual?mes=YYYY-MM` + selector de mes y botón de descarga en Operación 24h. Libro verificado abriéndolo en Excel real. |
| **Origen** | `pendientes_Ernesto.md`: *"crear archivo Excel con valores registrados en redespachos, autorizaciones y eventos de disponibilidad."* |
| **Depende de** | [REQ-03](./REQ-03-operacion-24h-registros-unicos.md) ✅ — define qué se exporta. **La dependencia con [REQ-01](./REQ-01-descarga-combustibles.md) se invirtió:** el plan era que REQ-01 construyera la infraestructura `.xlsx` y este la reutilizara, pero REQ-01 sigue bloqueado por el layout de su formato, así que **la construyó D-058** (`server/utils/xlsx.js` + el patrón "derivar plantilla offline / clonar bytes en runtime"). REQ-01 la hereda. |

---

## 1. Contexto y problema

Los eventos de operación del mes —lo que se autorizó, se probó, se redespachó y los cambios de
estado de la unidad— se consolidan hoy a mano en un formato controlado externo. La información ya
está toda en el sistema, dispersa en dos lugares distintos, y nadie la puede sacar sin transcribir.

## 2. Comportamiento actual

| Aspecto | Situación hoy |
|---|---|
| Descarga | **No existe** (ver REQ-01 §1: no hay ningún export en el proyecto). |
| Autorizaciones / Pruebas / Redespachos | Viven en `bitacora.registro_activo` (día en curso) y migran a `bitacora.registro_historico` al cierre diario del sweeper. |
| Disponibilidad | Vive en tabla dedicada `bitacora.disponibilidad_estado` (D-026), con intervalos tipados `fecha_inicio_estado` / `fecha_fin_estado`. |
| Consulta unificada | **No existe.** La vista `bitacora.v_historico_busqueda` que alimenta la sección de Históricos **no** cubre estos datos: MAND y DISP quedan fuera del flujo de cierre de turno que la alimenta (`server/routes/cierre.js:56,123`), porque tienen ciclo de vida propio. |

## 3. Comportamiento requerido

### 3.1 Ubicación y disparo

- **RQ-06.1** — El botón de descarga vive en el apartado **Operación 24h**, junto a los controles de
  la barra superior.
- **RQ-06.2** — **Disponibilidad no lleva botón propio.** Sus eventos salen dentro de este mismo
  archivo. (Combustibles sí tiene el suyo — [REQ-01](./REQ-01-descarga-combustibles.md).)
- **RQ-06.3** — Al pulsarlo se descarga **un solo archivo**, con **las dos unidades (GEC3 y GEC32)
  dentro**, independientemente de en qué unidad esté la sesión.
  > **Corregido 2026-07-26** (antes decía "dos archivos, uno por planta"). El formato de referencia
  > es **un único libro** que cubre las dos unidades: sus propias frases las nombran juntas
  > (*"Se entrega unidad G3.0 E/L generando 142 MWh y G3.2 F/L en mantenimiento programado"*).
  > Partirlo por planta obligaría a duplicar o mutilar esos renglones. Ver
  > [`FORMATO-ASIENTOS-OPERACION.md`](./FORMATO-ASIENTOS-OPERACION.md) §6.3-E.
- **RQ-06.4** — El periodo descargado es **el mes de la fecha en curso del apartado**.

### 3.2 Estructura del archivo

- **RQ-06.5** — Formato **`.xlsx` real**.
- **RQ-06.6** — **Un archivo por mes** con **ambas unidades**, cubriendo el mes completo.
- **RQ-06.7** — Dentro del archivo, **una hoja de cálculo por día del mes**.
- **RQ-06.8** — **Todas** las hojas del mes están presentes. Un día sin eventos lleva su hoja con
  encabezados y sin filas de datos.
- **RQ-06.9** — Cada hoja contiene los eventos de ese día de **las dos unidades**, mezclados en
  **orden cronológico** dentro de su bloque de turno: **redespachos, autorizaciones, pruebas y
  eventos de disponibilidad**, más los eventos de las bitácoras de Sala (texto literal).
  > *Nota:* las **pruebas** se incluyen aunque la nota original solo mencionaba tres.
- **RQ-06.10** — Cada hoja lleva **tres bloques de turno** (`00:00-06:00`, `06:00-18:00`,
  `18:00-00:00`), como el formato de referencia: el primero es la **cola del T2 que arrancó el día
  anterior** y el tercero la **cabeza del T2 de hoy**. El sistema tiene dos turnos y fecha el T2 por
  su día de inicio (D-045), así que el generador **parte el T2** para que cada evento caiga en el
  día de calendario en que ocurrió — y aparezca **exactamente una vez** en todo el libro.

### 3.3 Permisos

- **RQ-06.11** — Puede descargar **únicamente quien tiene permiso de crear en Operación 24h**: hoy
  `Ingeniero Jefe de Turno`, `Ingeniero de Operación` y `Administrador y Debugging`.
- **RQ-06.12** — Enforcement **data-driven** vía `hasPermisoBitacora(sesion, MAND_BITACORA_ID,
  'puede_crear')`. Sin permisos nuevos, sin hardcodear cargos, con rechazo **403** en el backend
  aunque el front se evada.
  > Ojo: Operación 24h es **visible para todos** los cargos por la matriz (cláusula global
  > `WHEN b.codigo = 'MAND' THEN 1` en `puede_ver`), así que el gate de descarga **no** puede
  > derivarse de la visibilidad.

## 4. Reglas de negocio y casos borde

- **RN-06.a** — Los eventos de **Autorización, Prueba y Redespacho** se exportan con el modelo nuevo
  de REQ-03: **puede haber varios por periodo**, cada uno con su hora de llamada, funcionario,
  descripción y valor. El archivo debe reflejar esa superposición, no aplanarla a un valor por
  periodo — perder eso vaciaría de sentido a REQ-03.
- **RN-06.b** — Los eventos de **Disponibilidad** no tienen periodo: son intervalos con inicio y
  fin. Su bloque en la hoja tiene naturaleza distinta al de los otros tres y debe reflejarlo.
- **RN-06.c** — Un evento de disponibilidad puede **cruzar la medianoche**. Hay que definir en qué
  hoja aparece — ver §8.2.
- **RN-06.d** — Los datos salen de dos lugares según la antigüedad: los del día en curso de
  `registro_activo`, los de días ya cerrados de `registro_historico`. La consulta debe cubrir ambos
  sin duplicar.
- **RN-06.e** — Un evento de disponibilidad deshecho (`POST /api/disponibilidad/deshacer`) **no**
  aparece como vigente. Ver §8.3 sobre si debe aparecer marcado.
- **RN-06.f** — La generación es **solo lectura**: no modifica datos ni deja registro.
- **RN-06.g** — La planta de test `TST` (D-030) nunca se exporta.
- **RN-06.h** — Un mes vacío igual produce el archivo, con todas sus hojas vacías. No es un error.

## 5. Impacto técnico

### 5.1 Infraestructura compartida

Reutiliza **el mismo** `server/utils/xlsx.js` que construye [REQ-01](./REQ-01-descarga-combustibles.md)
(port ESM del escritor OOXML de `js-scraper-carbon-g32/xlsx-write.js`, con soporte multi-hoja,
devolviendo `Buffer`). **Cero dependencias nuevas.**

Si REQ-01 se implementa primero, este requerimiento hereda la infraestructura completa y solo aporta
las consultas y el layout.

### 5.2 El dato hay que unirlo

Es el punto de más trabajo real de este requerimiento: **no existe hoy ninguna consulta que combine
las dos fuentes.**

| Bloque | Fuente |
|---|---|
| Autorizaciones / Pruebas / Redespachos | `bitacora.registro_activo` (día en curso) + `bitacora.registro_historico` (días cerrados), filtrando por la bitácora MAND y agrupando por lote (REQ-03) |
| Disponibilidad | `bitacora.disponibilidad_estado`, con `fecha_inicio_estado` / `fecha_fin_estado` |

Ambas deben resolverse por **día Bogotá** con el patrón canónico
`CAST(DATEADD(HOUR, -5, columna_utc) AS DATE)` (D-020 / §7.10 del modelo de BD). Los antipatrones de
zona horaria documentados ahí están prohibidos.

### 5.3 Archivos a tocar

| Archivo | Cambio |
|---|---|
| `server/utils/xlsx.js` | Ya existe si REQ-01 va primero; si no, se crea acá. |
| `server/routes/mand.js` | Endpoint de exportación mensual (gate `puede_crear` sobre MAND). |
| `src/components/SalaDeMando/SalaDeMandoGrid.jsx` (o la barra superior del apartado) | Botón **Descargar**, gateado por `puedeCrear`. |

### 5.4 Riesgos

- **Volumen.** Un mes × 31 hojas × cuatro bloques, con superposición de lotes por periodo, es más
  pesado que el de Combustibles pero sigue en el orden de cientos de KB. Se genera en memoria; no
  hay streaming.
- **Doble fuente.** El día en curso vive en `registro_activo` y el resto en `registro_historico`.
  Un mes que incluya hoy consulta las dos: hay riesgo de duplicar o de perder el día del cierre si
  la consulta no se escribe con cuidado. Necesita test explícito para el día de la transición.

## 6. Criterios de aceptación

1. **Dado** un usuario con permiso de crear en Operación 24h, **cuando** abre el apartado,
   **entonces** ve el botón Descargar.
2. **Dado** un cargo que solo puede ver Operación 24h, **entonces** **no** ve el botón; y si invoca
   el endpoint, recibe **403**.
3. **Dado** que pulso Descargar en julio de 2026, **entonces** obtengo **un** archivo `.xlsx` del mes
   completo, con los eventos de **GEC3 y GEC32** dentro.
4. **Dado** un mes de 31 días, **cuando** lo abro, **entonces** tiene 31 hojas, una por día, en orden.
5. **Dado** un día sin eventos, **cuando** abro su hoja, **entonces** tiene los encabezados y ninguna
   fila (no está ausente, no da error).
6. **Dado** un día con eventos, **cuando** abro su hoja, **entonces** contiene los eventos de las dos
   unidades mezclados en orden cronológico dentro de sus tres bloques de turno: redespachos,
   autorizaciones, pruebas, disponibilidad y los eventos de Sala.
6b. **Dado** un evento del T2 ocurrido a las 03:15, **entonces** aparece en el bloque `00:00-06:00`
   de la hoja de **ese** día de calendario, **una sola vez** en todo el libro (no en la hoja del día
   en que arrancó el turno).
7. **Dado** un periodo con **dos** autorizaciones registradas ese día, **entonces** el archivo
   muestra **las dos**, con sus horas, funcionarios y valores respectivos.
8. **Dado** un mes que incluye el día de hoy, **entonces** el día de hoy aparece completo y ningún
   día aparece duplicado.
9. **Dado** el archivo generado, **cuando** lo abro en Excel, **entonces** abre sin advertencias de
   archivo corrupto.
10. **Dado** cualquier descarga, **cuando** reviso la base de datos, **entonces** no cambió nada.

## 7. Fuera de alcance

- Cualquier formato que no sea `.xlsx`.
- Rangos que no sean un mes calendario.
- Un botón de descarga propio en el apartado de Disponibilidad.
- Un apartado centralizado de "Reportes".
- Envío automático del reporte por correo.
- Exportar Combustibles (eso es [REQ-01](./REQ-01-descarga-combustibles.md)).

## 8. Preguntas abiertas

### 8.1 ✅ RESUELTA 2026-07-26 — layout de la hoja

El contenido y la estructura de cada hoja replican **1 a 1** el formato de referencia:

> `2026_01_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx` (raíz del repositorio)

**Analizado** (32 hojas, 342 eventos reales) y especificado en
[`FORMATO-ASIENTOS-OPERACION.md`](./FORMATO-ASIENTOS-OPERACION.md): estructura de la hoja
(encabezado GENE-F03 + tres bloques de turno con `JEFE DE TURNO` / `INGENIERO DE TURNO` + tabla
`HH:MM | DESCRIPCIÓN EVENTO Y/O ACTIVIDAD`), las **plantillas de texto** por tipo de evento, las
convenciones canónicas (unidad, MW, periodos, hora) y qué queda en blanco.

**Lo que el sistema no puede llenar hoy:** los eventos de rutina diaria y el relevo de turno se
escriben a mano en las **bitácoras de Sala** y entran a la hoja como **texto literal**. Si nadie los
registra ahí, esas filas simplemente no existen — el generador **no las inventa**. Ver §6.2 del
documento de formato (estado de adopción real).

### 8.2 ✅ RESUELTA por D-058 (por construcción) — eventos de disponibilidad que cruzan la medianoche

Un estado que empieza a las 23:40 y termina a las 06:00 del día siguiente — ¿aparece en la hoja del
día de inicio, en la del día de fin, o en ambas?

> **Respuesta: en la del día de inicio, y una sola vez.** El F03 registra **eventos**, no intervalos:
> lo que se asienta es *"la unidad quedó indisponible"*, un hecho puntual que ocurrió a las 23:40. La
> hora canónica de DISP es `fecha_inicio_estado` y ahí queda la fila; el fin del estado no genera
> renglón propio porque no es un evento nuevo — el evento siguiente es el **cambio** a otro estado, y
> ese sí se asienta en su propia hora. Es coherente con el criterio 6b (cada evento aparece
> **exactamente una vez** en todo el libro) y con cómo el papel se llenó siempre.

### 8.3 ✅ RESUELTA por D-058 (por construcción) — eventos deshechos

¿Los eventos de disponibilidad que se deshicieron deben aparecer en el archivo marcados como
anulados, o el archivo solo refleja el estado final correcto?

> **Respuesta: no aparecen — y no por decisión del generador, sino porque no existen.** `POST
> /api/disponibilidad/deshacer` **borra** la fila de `disponibilidad_estado` y reabre la anterior: el
> libro lee esa tabla, así que un evento deshecho simplemente no está. Esto **no contradice a
> RQ-02.12** (que conserva la *copia en la bitácora de Sala* visible y marcada como anulada): son dos
> superficies distintas — la bitácora narra el turno, incluido lo que se corrigió; el F03 consolida
> el estado de la unidad.
>
> **Actualización D-063 (2026-08-28):** RQ-02.12 ya está implementada, así que **desde D-063 la copia
> en Sala SÍ existe y queda anulada** (visible, tachada, con quién la deshizo y cuándo). El libro
> sigue **sin mostrarla**, y por partida doble: lee la tabla base `disponibilidad_estado` —donde el
> evento deshecho ya no está— y además **excluye toda copia** de las bitácoras de Sala por
> `campos_extra.origen_bitacora` (antes por el puntero `origen_lote_id`, que dejaba pasar la copia
> DISP). La respuesta sigue siendo la misma; lo que cambió es que ahora hay algo que excluir.

### 8.4 ✅ RESUELTA por D-058 (por construcción) — lotes corregidos

Si un lote de Operación 24h se corrigió durante el día, ¿el archivo refleja solo el valor final, o
debe dejar constancia de que hubo corrección?

> **Respuesta: solo el valor final** — es la decisión H del documento de formato, aplicada de punta a
> punta: corregir **regenera** el asiento (no agrega un renglón de corrección) tanto en la bitácora
> de Sala como en el libro. El rastro de la corrección vive en `modificado_por`/`modificado_en` del
> registro, que es auditoría, no narrativa. Un F03 con el renglón viejo tachado y el nuevo debajo
> confundiría a quien lo lee para saber **qué pasó**, que es para lo que existe.
