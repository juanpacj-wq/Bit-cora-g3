# Glosario de dominio — Bit-cora-g3

Términos y códigos que aparecen en código y BD. Si un agente nuevo encuentra un código de 3-4 letras (`MAND`, `CIET`, `AUTH`, `REDESP`), debe encontrarlo acá.

---

## Plantas operativas

Solo existen DOS plantas:

| `planta_id` | Nombre |
|---|---|
| `GEC3` | Gecelca 3 (planta principal) |
| `GEC32` | Gecelca 3.2 |

NO hay GEC4, GEC1, GEC2. Cualquier referencia a otras es error de un agente confundido.

> Existen además dos `planta_id` que **no son plantas**, sino fixtures residentes para que la suite no escriba sobre datos reales (D-030/D-055): `TST` (`TEST_PLANTA_ID`) y `TSR` (su reflejo). Desde D-061 `TST` tiene su propio catálogo de combustibles —las 10 filas espejo de GEC32— así que también es scrapeable como si tuviera SIS. `validarPlantaOperable` la rechaza para operar de verdad y `GET /api/eventos-dashboard` devuelve vacío para ella.

---

## Códigos de bitácora (`lov_bit.bitacora.codigo`)

| Código | Nombre | `formulario_especial` | UI | Notas |
|---|---|---|---|---|
| `MAND` | Operación 24h (anteriormente "Sala de Mando") | 1 | `SalaDeMandoGrid.jsx` | Grilla 24p × 3 tipos × 2 plantas. Batch save **append-only** (registra, no edita — D-056): nace vacía y cada Guardar agrupa la fila en un **lote**. Corregir y borrar son **por lote**, desde el listado del día (D-057). No se cierra por turno (sweeper diario). Solo HOY se captura. |
| `DISP` | Disponibilidad | 1 | `DisponibilidadDashboard.jsx` | Mini-dashboard con tabs GEC3/GEC32. Sin cierre de turno. 1 vigente por planta. 4 estados (D-024): `En Servicio` (`1`, verde), `En Reserva` (`0`, azul), `Indisponible` (`-1`, rojo, salida forzada), `Mantenimiento` (`-1`, amarillo, consignación). `Indisponible` y `Mantenimiento` comparten `codigo=-1`; el discriminador es el string `evento`. Panel de acumulado histórico por estado (D-028): el del estado vigente crece en vivo, el resto congelado. |
| `COMB` | Consumos de Combustibles | 1 | `Combustibles/ConsumosGrid.jsx` | **No es una bitácora de eventos: es un reporte numérico** (24 periodos × N combustibles por planta, 8 en GEC3 / 10 en GEC32). Batch save atómico. Sin cierre de turno (endpoint propio). Crean JdT + IngOp + ADMIN (D-048/D-039); el resto ve. El carbón de GEC32 (`ALIM_1..8`) además lo escribe el **SIS** cada hora, con la regla "operador gana" — ver *SIS*, *SIS-owned* y *Override* más abajo. D-027 / D-029 / D-060 / D-061. |
| `CIET` | Cierres y Finalizaciones | 0 | Solo histórico | Auditoría automática. Nadie tiene `puede_crear=1`. Tipos: Finalización de turno, Cierre de turno, Deshacer disponibilidad. |
| `AUTOR` / similar | Autorizaciones (genérica histórica) | 0 | `GrillaRegistros` genérica | Bitácora estándar. |
| (otras) | bitácoras operativas | 0 | `GrillaRegistros` genérica | Con filtros F11 (fecha+turno). |

---

## Tipos de evento dashboard (`bitacora.evento_dashboard.tipo`)

Contrato hacia `dashboard-gen-gec3`. Definidos por `CHECK (tipo IN (...))`:

| Tipo | Significado |
|---|---|
| `AUTH` | Autorización del CND para generar a un MW dado en un periodo. Requiere `funcionariocnd`. |
| `REDESP` | Redespacho — orden del CND de cambiar la generación programada. No requiere funcionariocnd. |
| `PRUEBA` | Prueba de generación interna. No requiere funcionariocnd. |

DISP **NO** usa `evento_dashboard` — usa `bitacora.disponibilidad_dashboard` (ver `decisions.md` D-009).

---

## Cargos (`lov_bit.cargo`)

Roles operativos. Los IDs son convención del seed:

| `cargo_id` | Nombre canónico | Permisos típicos |
|---|---|---|
| 1 | Ingeniero Jefe de Turno (JdT) | Ve todas las bitácoras; crea en **SALAJDT**/DISP/MAND/COMB. Cierra/extiende/reabre el turno de la unidad. Es el coordinador del turno. Solo edita/borra sus propios registros (D-049). |
| 2 | Ingeniero de Operación (IngOp) | Ve todo, cierra turno, crea en DISP/MAND/COMB — igual que el JdT **salvo en Sala de Mando**: desde D-053 cada uno escribe en la suya (IngOp → **SALAING**, JdT → SALAJDT) y en la del otro queda en solo-lectura. Ya **no** tienen filas idénticas en la matriz. Solo edita/borra sus propios registros (D-049). |
| 3 | Ingeniero Químico | Visualizador. Crea en su bitácora de laboratorio. |
| 4+ | Jefes de Planta, Gerencia, Otros | Visualizadores universales, audit access. |

> El catálogo real tiene **13 cargos**, no 4 (esta tabla lista solo los transversales). La fuente
> autoritativa es el `MERGE lov_bit.cargo` de `server/db.js` + el mapeo App Role → cargo de
> `server/utils/entra-roles.js` (D-031). Los `cargo_id` son convención del seed, **no** son estables
> entre BDs: la matriz de permisos matchea por `cargo.nombre`, nunca por id.

Permisos efectivos viven en `lov_bit.cargo_bitacora_permiso (cargo_id, bitacora_id, puede_ver, puede_crear)`. La función `puedeCrear(sesion, bitacora_id)` en `server/middleware/permissions.js` resuelve a partir de ahí.

Para DISP: TODOS los cargos tienen `puede_ver=1`; solo 1 y 2 tienen `puede_crear=1` (botones Cambiar/Editar/Deshacer gated en front y back). Ver decisión D-008.

---

## Estados de Disponibilidad (DISP)

4 estados (D-024, 2026-05-15), definidos en JSON de `definicion_campos` y persistidos en `registro_activo.campos_extra.evento`:

| Estado | `codigo` | Color paleta | Semántica |
|---|---|---|---|
| `En Servicio` | 1 | Verde | Disponible y generando |
| `En Reserva` | 0 | Azul | Disponible, no generando |
| `Indisponible` | -1 | Rojo | Salida forzada — imposible generar |
| `Mantenimiento` | -1 | Amarillo | Consignación / salida planeada |

`Indisponible` y `Mantenimiento` comparten `codigo=-1` por diseño (alineación con métrica XM de "horas de indisponibilidad" = `SUM(codigo=-1)`). El discriminador semántico es el string `evento`.

No se permiten estados consecutivos iguales por `evento` (409 `mismo_estado`). Por lo tanto la secuencia `Indisponible → Mantenimiento` (o viceversa) **es válida** — distinto `evento` aunque mismo `codigo`.

---

## Tipos en MAND

La grilla MAND tiene 3 filas correspondientes a 3 `tipo_evento` de la bitácora `MAND`:

| Fila / `tipo` en payload | `tipo_evento.nombre` | Lock por hora | FuncionarioCND |
|---|---|---|---|
| `AUTH` | `Autorización` | No | **Requerido** (si algún valor en la fila) |
| `PRUEBA` | `Pruebas` | No | NULL forzado |
| `REDESP` | `Redespacho` | **Sí** (periodo >= actual) | NULL forzado |

> Los `tipo_evento.nombre` son **literales** y así se copian a los tipos espejo de las bitácoras de Sala (D-058): `Autorización` con tilde y en singular, `Pruebas` en plural. Renombrar uno acá deja el espejo huérfano y el histórico con dos etiquetas para lo mismo — hay test que lo fija.

24 periodos × 3 tipos × 2 plantas = 144 celdas posibles. El periodo P1 cubre 00:00–00:59, P2 cubre 01:00–01:59, …, P15 cubre 14:00–14:59, …, P24 cubre 23:00–23:59 (hora Bogotá).

---

## Lote (MAND)

**Lote** = el conjunto de registros nacidos de una misma fila/tipo en un mismo Guardar. Es la unidad de captura y de corrección desde D-056/D-057; representa **una llamada del CND**.

| Concepto | Dónde vive | Nota |
|---|---|---|
| `lote_id` | `campos_extra.lote_id` (GUID de 36 chars) | Lo genera el **servidor**. Sin DDL: `campos_extra` viaja tal cual al histórico. |
| `hora_llamada` | `campos_extra.hora_llamada` (ISO UTC) | Hora de la **llamada al CND**, distinta de `fecha_evento` (instante de guardado). En los registros migrados por `F32.A1` la clave está **AUSENTE** (ni `null` ni `""`). |
| Metadata del lote | `detalle`, `funcionariocnd`, `hora_llamada` | **Replicada en cada celda**, sin constraint que la mantenga coherente: la sostiene un guard de test (`verificarCoherenciaDeLotes`). |

Varios lotes **coexisten** en el mismo `(tipo, periodo, día, planta)` — el CND llama varias veces por el mismo periodo. Lo que el dashboard publica se resuelve **por celda**, no por lote (gana la mayor `hora_llamada`; los sin hora van últimos). Corregir y borrar actúan sobre **el lote completo**, nunca sobre un periodo suelto. Un lote no se parte entre dos días Bogotá: sus celdas comparten `fecha_evento`.

---

## Asiento (D-058)

**Asiento** = el texto con que se narra un evento de operación, **armado por el servidor** y no por la persona. Nace en `server/utils/asientos/` (módulo puro) y es el **mismo** en los tres lugares donde aparece: el renglón del listado del día de Operación 24h, la copia en las bitácoras de Sala y la fila del libro mensual GENE-F03.

| Fuente | Cómo se arma |
|---|---|
| MAND (`AUTH` / `REDESP` / `PRUEBA`) | Plantilla por tipo + unidad + carga. Ej.: `Se recibe llamada del CND (Juan Pérez) autorizando GEC3 a generar 150 MW del P17 al P19.` |
| DISP (4 estados) | Una frase por estado. Ej.: `GEC3 E/L en servicio.` |
| Bitácoras de Sala | **Literal**, tal como lo escribió el ingeniero — sin normalizar ni corregir. Se le antepone `{UNIDAD} — ` **solo si el texto no nombra ya la unidad**. |

Convenciones canónicas: unidad `GEC3`/`GEC32` (nunca `G3.0`/`G3.2`), potencia **entera en `MW`** (es potencia por periodo, **no `MWh`**), periodos compactados (`del P17 al P19`) cuando todo el lote comparte valor y desplegados (`P17: 109 MW; P18: 134 MW`) cuando difieren, `detalle` al final tras punto. **La hora nunca va dentro del asiento**: es una columna aparte. Especificación completa: `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md`.

---

## Asiento reflejado / copia anulada / tipo espejo (D-058 + D-063)

**Asiento reflejado** = la **copia** de un evento de **Operación 24h** (por lote) o de **Disponibilidad** (por estado) en `SALAJDT` y `SALAING` (nunca `SALAOP`). Es un registro real de esa bitácora —cuenta en el contador, cierra por turno, viaja al histórico— pero **derivado**: muestra un chip con su bitácora de origen y **no se edita ni se borra en su destino, tampoco por su autor** (`403 asiento_reflejado`). La única fuente de verdad es el origen.

**Marcador vs. puntero (D-063).** Son dos cosas y se confunden fácil:

| | Clave en `campos_extra` | Para qué sirve |
|---|---|---|
| **Marcador** | `origen_bitacora` — `"MAND"` o `"DISP"` (el `codigo` del origen, cadena no vacía) | **Lo único que decide si una fila es una copia.** Es el mismo para todos los orígenes, y es lo que leen los cinco consumidores: `canEditarRegistro`, el espejo SQL del `GET /activos`, la exclusión del libro F03, la grilla de Sala e Históricos. |
| **Puntero** | `origen_lote_id` (GUID del lote, MAND) · `origen_disponibilidad_id` (INT del estado, DISP) | Solo el camino de vuelta al origen para corregir, borrar o anular. **No decide nada.** |

D-058 marcaba por `origen_lote_id` porque MAND era el único origen; con la copia DISP —otro puntero— cada consumidor la habría dejado editable, publicable en el libro y sin rótulo. D-063 separó las dos ideas y un guard estático (`server/tests/guard_marcador_reflejo.test.js`) fija los cinco puntos.

**Copia anulada** (D-063, RQ-02.12) = el asiento reflejado de un estado de disponibilidad **que se deshizo en su origen**. Deshacer **no la borra**: le agrega `campos_extra.anulado = { por, nombre, cargo, en }` y la copia sigue **visible, tachada y atenuada**, con un chip **"Anulado"** cuyo tooltip nombra quién la deshizo y cuándo (hora Bogotá), tanto en la grilla de Sala como en Históricos. El evento sí ocurrió durante el turno; borrarlo dejaría un hueco en la narrativa. `detalle`, el puntero y `fecha_evento` quedan intactos, y la anulación es **idempotente por SQL** (una segunda pasada no re-sella al primero). No existe el caso simétrico en MAND: ahí borrar el lote **sí borra** las copias.

**Tipo espejo** = los `lov_bit.tipo_evento` que existen en `SALAJDT`/`SALAING` con los nombres literales de MAND y DISP (`Autorización`, `Pruebas`, `Redespacho`, `Cambio de Disponibilidad`) para que la copia tenga un tipo coherente con su bitácora. Van con **`seleccionable = 0`**: existen para el sistema, pero **nadie los puede elegir a mano** — si se pudieran, alguien crearía "una autorización" sin origen, indistinguible de un reflejo real e imposible de rastrear.

> El reflejo de **Disponibilidad** lo cerró **D-063** sobre esos mismos tipos espejo ya sembrados: mismo módulo, mismo INSERT, con la **copia anulada** como única diferencia de fondo. Ver RF-077 y BIT-MODBD §7.11.

---

## Asiento de sistema / hora estimada (D-064)

**Asiento de sistema** = una fila de `SALAJDT`/`SALAING` que **no la escribió nadie**: la pone un barrido interno a partir de un hecho ocurrido **fuera** de Bitácora. Hoy hay un solo origen —la llegada del despacho económico del día siguiente que publica XM y detecta el dashboard—, con el texto literal del F03: `Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA`. Su autor es **`SISTEMA`**, y por eso **nadie lo edita ni lo borra** (D-049 limita la edición al autor y `SISTEMA` nunca tiene sesión): no hizo falta programar nada para conseguirlo.

**No es un asiento reflejado, y su marcador es otro a propósito:**

| | Asiento **reflejado** (D-058/D-063) | Asiento **de sistema** (D-064) |
|---|---|---|
| Marcador | `campos_extra.origen_bitacora` (`"MAND"`/`"DISP"`) | **`campos_extra.origen_sistema`** (`"DESPACHO_XM"`) |
| Qué es | **Copia** de un registro que vive en otra bitácora | **Registro original** de Sala; no hay origen que copiar |
| Libro GENE-F03 | **Excluido** (se publicaría tres veces) | **Incluido**, con el `detalle` **literal** (sin el prefijo `GEC3 — `) |
| Por qué no se edita | `403 asiento_reflejado` (el origen manda) | Autoría: el autor es `SISTEMA` |

Reusar `origen_bitacora` habría **excluido el asiento del libro**, que es justo donde tiene que salir.

**Clave de asiento** = `campos_extra.clave_asiento`, de la forma `DESPACHO_XM|YYYY-MM-DD` y **determinística**: la misma fecha de despacho produce siempre la misma clave. Hace dos trabajos a la vez — es la **clave de colapso** del libro (las **cuatro** filas del hecho, `SALAJDT`/`SALAING` × `GEC3`/`GEC32`, salen como **un** renglón, agrupadas por `sys|<día Bogotá>|<clave>`) y la **clave de idempotencia** (antes de escribir se busca en `registro_activo` **y** en `registro_historico`; en una sola de las dos, el relleno duplicaría todo lo que el cierre de turno ya archivó).

**Hora estimada** = `campos_extra.hora_estimada`. `false` cuando la hora del asiento es la que el dashboard **midió** al detectar el archivo; `true` cuando es la **convención** de las **15:00 Bogotá** que usa el relleno del mes para los días cuya hora real nunca se guardó. Va **siempre presente** (nunca ausente) y **no se pinta en el front**: el único lugar donde se dice con todas las letras es el resumen del CLI (`[relleno] OJO: N asiento(s) quedaron con HORA ESTIMADA`). Por eso el relleno es una **pasada única de puesta al día**, no una rutina: un día que XM nunca publicó quedaría indistinguible de uno real.

> El asiento pertenece al día en que **se recibió**, no al que anuncia: `14:41 … para el 14-07-2026` vive en la hoja del **13** — y, como corolario, **el asiento del día 1 de un mes sale en el libro del mes anterior**. Ver D-064, RF-078 y BIT-MODBD §5.3 / §7.12.

---

## SIS

**SIS** = el **historiador industrial interno** de la planta (`http://192.168.18.201`, HTTP plano, sin autenticación; hay una allowlist en `validarSisHost` y se puede apuntar a otro host con la variable `SIS_HOST`). Guarda las lecturas de sensores minuto a minuto y las exporta como `.xls` por rango horario.

De ahí sale el **carbón horario de GEC32**: las 8 tolvas `ALIM_1..8`. Un periodo (una hora) pesa ~830 KB y tarda ~13 s en llegar. **GEC3 no tiene SIS** — es planta válida de COMB, con captura manual, pero pedirle un scrape responde `400 planta_sin_sis`.

No confundir con el **dashboard** (`dashboard-gen-gec3`), que es otro sistema y otro contrato: al SIS **le leemos**, al dashboard **le escribimos**.

| Término | Qué es |
|---|---|
| **Periodo** (en el SIS) | El mismo P1..P24 de toda la app: `P{N}` cubre `(N-1):00..(N-1):59` Bogotá. **El P24 de un día solo se puede leer al día siguiente** (23:00→00:00), por eso el día en curso nunca está completo. |
| **Scrape** | Una corrida que le pide al SIS los periodos de un día y los persiste. Tres sabores según quién la dispara: `horario` (sweeper), `manual` (endpoint) y `backfill` (CLI). |
| **Sweeper del SIS** | `server/utils/sis/sis-sweeper.js`. Tick a **HH:02 Bogotá**: completa AYER si le falta algo y re-scrapea HOY. Se apaga con `SIS_SWEEPER_ENABLED=0`, que es un **flag para backends efímeros de test, no de producción**. |
| **`sis-lock`** | Mutex de **proceso y sin cola** entre el sweeper y el scrape manual. Quien lo encuentra tomado no espera: el sweeper omite el tick entero, el endpoint responde `409 scrape_en_curso`. No alcanza al CLI de backfill, que es otro proceso. |
| **Backfill** | `server/scripts/backfill-carbon-gec32.js`. Carga histórico día a día, es **resumible** (salta lo que ya está 24/24) y nunca escribe más allá de `hoy-2`, para no competir con el sweeper. Runbook en `deploy/DEPLOY.md`. |

---

## SIS-owned / humano-owned (COMB)

Cuál de los dos escritores manda en una celda de carbón de GEC32.

- **SIS-owned** ⇔ `creado_por = SISTEMA AND (modificado_por IS NULL OR modificado_por = SISTEMA)`. La creó la máquina y ningún humano la tocó después: el scrape puede pisar `cantidad`.
- **humano-owned** = cualquier otra combinación. El scrape actualiza **solo** la sombra `valor_sis` y deja `cantidad` intacta.

La regla se llama **"operador gana"**: entre el número que puso una persona y el que reporta el medidor, en pantalla queda el de la persona, y el del medidor se conserva al lado para poder compararlos y volver. La ownership se decide **por autor, no por fecha**: revertir devuelve la celda al SISTEMA justamente para que el scrape vuelva a mandar en ella.

> **Cuidado:** revertir conserva `creado_en` y `detalle` humanos aunque el autor pase a SISTEMA. Y como la ownership es solo por autor, un scrape posterior que reporte 0 **borra** esa fila con su comentario.

---

## Override (COMB)

**Override** = una celda de carbón cuyo número lo puso una persona y **difiere** de lo que reporta el SIS. El backend lo expone por celda como `es_override` (`= !sis_owned AND valor_sis IS NOT NULL AND cantidad <> valor_sis`) y el front lo pinta con un banderín ámbar + un popover con quién la editó, cuándo y cuál era el valor del SIS. **El front pinta, no decide.**

**Override 0** = el caso de vaciar. Vaciar una celda que tiene lectura del SIS **no la borra**: la deja viva en `cantidad = 0` con `modificado_por` humano. Si se borrara, quedaría sin dueño humano y el siguiente scrape la repondría — el operador vería revivir lo que acaba de vaciar. Una celda sin `valor_sis` sí se borra, como desde D-027.

**Revertir** (`POST /api/combustibles/consumos/revertir`, gate `puede_crear`) es el único camino de vuelta: `restaurado` si `valor_sis > 0`, `eliminado` si `valor_sis = 0` (para el SIS un cero es la **ausencia de fila**, no un 0 guardado) y `sin_cambios` si ya coincidía.

> Un **override 0 deja de verse como override** en cuanto el propio SIS reporta 0 para esa celda: los dos números coinciden y el banderín se apaga, aunque la fila siga siendo humano-owned.

---

## `valor_sis` / `sis_scrape_log`

Las dos huellas que deja la ingesta en la BD (DDL completo y semántica en **BIT-MODBD §4.9.1**):

| Qué | Dónde | Para qué |
|---|---|---|
| **`valor_sis`** (+ `sis_actualizado_en`) | columnas de `bitacora.consumo_combustible` | La **sombra**: lo último que reportó el SIS para esa celda, se haya aplicado a `cantidad` o no. Es lo que hace posibles el badge de override y el botón Revertir. `NULL` = esa celda nunca tuvo lectura del SIS. |
| **`bitacora.sis_scrape_log`** | tabla propia, UQ `(planta_id, fecha)` | El **resumen del último scrape de cada día**: `scrape_tipo`, `periodos_ok`, `periodos_error`, `ultimo_periodo`, `completo`, `scraped_en`. Alimenta el chip "SIS 24/24 ✓" de la grilla y es la **verdad persistente** de qué se leyó (el estado del job manual vive en memoria y se pierde con un reinicio). |

**`completo = 1` significa 24/24 sin errores**, jamás "scrapeado hasta la hora actual". El día en curso queda siempre en `completo = 0` y lo cierra la repesca de "ayer" del sweeper. Un flag que se calculaba contra el horizonte de "hoy" dejó 41 días de producción sin su P24 (D-060); no gatees nunca una repesca con algo que dependa de la hora.

---

## Tipos de evento CIET

Insertados solo desde código vía `server/utils/ciet.js::registrarEventoCierre`:

| Tipo | Disparador |
|---|---|
| `Finalización de turno` | `POST /api/bitacora/finalizar` (manual por usuario). |
| `Cierre de turno` | `POST /api/cierre/bitacora`, `POST /api/cierre/masivo`. Cierre cronológico F4. |
| `Deshacer disponibilidad` | `POST /api/disponibilidad/deshacer`. Audit ampliado con jdts+gerentes activos. |
| (MAND cierre diario) | sweeper diario, autor=SISTEMA, snapshots agregados del día. Se inserta como `Cierre de turno` con marca SISTEMA. |

---

## Usuario SISTEMA

Seed idempotente: `username='SISTEMA'`, `activo=0`, `password_hash='!disabled!'`. No puede loguearse. Existe únicamente para que el CIET de cierre automático MAND tenga `creado_por != NULL`.

`USUARIO_SISTEMA_ID` se cachea en `db.js` al arranque y se reutiliza.

---

## Periodo / Hora / Turno

Conceptos atados a hora Bogotá:

- **Periodo P{N}**: hora del día como entero 1..24. `P{N}` cubre `(N-1):00..(N-1):59` Bogotá. P1=00:00, P7=06:00, P15=14:00, P24=23:00.
- **Turno**: 1 (diurno, P7..P18 = 06:00..17:59) o 2 (nocturno, P19..P24+P1..P6 = 18:00..05:59). Solo 2 turnos. Cualquier referencia a "3 turnos" es narrativa, no datos.
- **`periodo_actual`** en lock REDESP: `floor(hora_bogota_ahora) + 1`. A las 14:30 → P15 (editable). A las 14:59:59 → P15. A las 15:00:00 → P16.

Helpers:
- `turnoFromPeriodo(periodo)` — convierte periodo a turno 1/2.
- `getTurnoColombia()` — turno actual.
- `colombiaParts()` — extrae año/mes/día/hora/minuto Bogotá vía offset manual `-5h`.
- `getTodayBogota()` — frontend, fecha YYYY-MM-DD Bogotá.

Colombia no tiene DST. Offset puro `-5h` es seguro.

---

## Snapshots JSON (auditoría)

Tres columnas JSON en `registro_activo` y `registro_historico`:

- `jdts_snapshot` — array de `{ usuario_id, nombre_completo }` de los Ingeniero Jefe de Turno presentes.
- `jefes_snapshot` — Jefes de Planta (cargo 4+) presentes.
- `ingenieros_snapshot` — Ingenieros de Operación (cargo 2) presentes.

Calculados al INSERT desde `sesion_bitacora` con `finalizada_en IS NULL` (post F2) — sin filtro TTL. Para CIET de cierre automático MAND: agregados de todas las sesiones del día (rotación de personal).

Nunca FK directo a `lov_bit.usuario` para reconstruir presencia. Ver decisión D-001.

---

## evento_dashboard `activa`

`bitacora.evento_dashboard.activa BIT`:

- `1` — registro vivo, el dashboard lo muestra.
- `0` — soft-delete. Pasó cuando la celda fue vaciada en MAND, o el registro fue eliminado en otra bitácora.

El dashboard productivo filtra `WHERE activa=1`. No hay hard-delete excepto por DBA manual.

---

## Códigos de error de negocio (HTTP 400)

Los endpoints devuelven `{ error: 'codigo', ... }` o `{ errores: [{ tipo?, periodo?, motivo }, ...] }`. Códigos relevantes:

| Código | Endpoint | Significado |
|---|---|---|
| `mismo_estado` | POST DISP | Nuevo estado igual al vigente. |
| `fecha_anterior_a_vigente` | POST DISP | `fecha_inicio_estado` <= vigente. |
| `sin_vigente` | POST deshacer DISP | No hay registro vigente para deshacer. |
| `fecha_no_es_hoy` | POST MAND guardar | Fecha != hoy Bogotá. |
| `tipo_invalido` | POST MAND guardar | tipo ∉ {AUTH,PRUEBA,REDESP}. |
| `periodos_invalido` | POST MAND guardar | Array de periodos malformado. |
| `periodo_fuera_rango` | POST MAND guardar | periodo ∉ [1,24]. |
| `valor_mw_invalido` | POST MAND guardar | valor_mw no es número o es negativo. |
| `periodo_bloqueado` | POST MAND guardar · PUT lote | REDESP sobre periodo < actual. En el `PUT` se evalúa **sobre el delta** (valor cambiado, periodo agregado o quitado); no aplica al `DELETE` del lote. |
| `funcionariocnd_requerido` | POST MAND guardar · PUT lote | AUTH con valor sin funcionariocnd. |
| `hora_requerida` / `hora_invalida` / `hora_futura` | POST MAND guardar · PUT lote | Hora de la llamada al CND: falta, no es `HH:mm`/fuera del día del lote, o posterior a "ahora"+5 min (reloj del **servidor**). Error de **lote** (sin `periodo`). |
| `lote_sin_celdas` | POST MAND guardar · PUT lote | Metadata sin ninguna celda con valor. Nunca un 200 mentiroso; vaciar no borra — para eso está el `DELETE`. |
| `periodo_duplicado` | PUT lote | El mismo periodo dos veces en el body: el diff quedaría ambiguo. |
| `lote_inexistente` (404) · `lote_cerrado` (409) · `lote_de_otra_planta` (403) | PUT/DELETE lote | El lote no existe · ya lo archivó el cierre diario (histórico inmutable) · pertenece a otra unidad. |
| `asiento_reflejado` (403) | PUT/DELETE registro | Es la **copia** de un evento de Operación 24h: se corrige en su origen, no en la bitácora de Sala. Se rechaza **también a su autor** (que es el del origen) — por eso no reusa `solo_autor`, que sería una explicación falsa. |
| `mes_invalido` · `mes_futuro` | GET reporte-mensual | `mes` no cumple `YYYY-MM` · el mes pedido es posterior al mes Bogotá en curso. **Un mes sin eventos no es error**: devuelve el libro con las hojas vacías. `mes` ausente = mes en curso. |
| `sin_permiso_descarga` (403) | GET reporte-mensual | El cargo no tiene `puede_crear` en MAND. Sigue pudiendo **consultar** el listado del día: consultar no es descargar. |
| `planta_invalida` | GET/POST COMB | `planta_id ∉ {GEC3, GEC32, TST}`. Ojo: el mismo `codigo` ya existía en `POST /api/auth/cambiar-unidad` — no es un estreno de D-061. |
| `fecha_invalida` · `fecha_futura` | GET/POST COMB · POST scrape SIS | La fecha no cumple `YYYY-MM-DD` · es posterior a hoy Bogotá. |
| `cantidad_invalida` · `cantidad_excede_max` | POST COMB | La cantidad no es un número finito ≥ 0 · supera el `cantidad_max` del combustible (D-034, boundary inclusivo). Viajan dentro de `errores[]`. |
| `combustible_no_pertenece_planta` · `periodo_fuera_rango` | POST COMB · POST revertir | El combustible no está en el catálogo de esa planta · `periodo ∉ [1,24]`. |
| `sin_valor_sis` (400) · `celda_no_existe` (404) | POST revertir | La celda nunca tuvo lectura del SIS, así que no hay a qué volver · la celda ya no está. |
| `planta_sin_sis` | POST scrape SIS | La planta existe en COMB pero **no tiene SIS** (GEC3). Predicado más estricto que el de `planta_invalida`. |
| `rango_invalido` · `rango_excede_max` | POST scrape SIS | `from > to` · el rango pasa de **31 días** (más que eso es trabajo del CLI de backfill, no de un botón). |
| `scrape_en_curso` (409) | POST scrape SIS | Ya hay un job vivo **o** el mutex `sis-lock` está tomado por el tick del sweeper. La respuesta trae `job` y `lock` para poder decir cuál de los dos y desde cuándo. |
| `sis_ocupado` | interno (no HTTP) | `.codigo` del `Error` que lanza `withSisLock` cuando el mutex está tomado. Nadie hace cola: es la causa del `409 scrape_en_curso` y de que el sweeper omita su tick. |
