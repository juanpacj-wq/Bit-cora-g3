# D-064 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-08-31. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en el cierre del lote + el gate, no acá.

## Fuente del requerimiento

`docs/requerimientos/REQ-05-asiento-cambio-despacho.md`, reescrito por completo el 2026-08-31 y
marcado 🟢 **sin preguntas abiertas**. Sus criterios de aceptación (§6, 1–12) **son la fuente** y
no se reabrieron. Las cuatro decisiones de §8.1 y las dos de §8.2/§8.3 ya venían cerradas por el
autor.

Por eso la ronda 1 **no pregunta comportamiento**: pregunta solo las decisiones de
implementación que el documento no toma y que, medidas contra el código, resultaron tener más de
una salida razonable.

## Ronda 1 — decisiones que el documento no cierra

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **El texto literal choca con el motor de asientos.** `asientoLiteralSala` (`utils/asientos/index.js:70`) le antepone la unidad a todo renglón de Sala salvo que el texto ya la nombre, y el regex `UNIDAD_YA_NOMBRADA` (`formato.js:19`) NO matchea `"Se recibe del XM…"` — verificado corriéndolo. Tal cual, el libro imprimiría `GEC3 — Se recibe del XM…`, rompiendo RQ-05.4 y el criterio 2. (a) Marcador propio en `campos_extra` y que `eventosSala` no prefije cuando lo ve; (b) ampliar el regex; (c) aceptar el prefijo. **Recomendada: (a)** — es la misma llave que ya hace falta para agrupar (RQ-05.10), no agrega concepto nuevo y no toca el regex del que depende el 40 % de los eventos libres de Sala. | **(a) Marcador en `campos_extra`.** El motor no prefija los asientos de sistema; `UNIDAD_YA_NOMBRADA` queda intacto. |
| 2 | **¿En qué unidad viven las filas?** El documento dice "un registro en `SALAJDT` y otro en `SALAING`" (RQ-05.8) y "las dos filas" (RQ-05.10) — dos filas — pero no dice qué `planta_id` llevan, y la columna es `NOT NULL`. En el libro da igual (mezcla las dos unidades); en pantalla no, porque la grilla de Sala filtra por la planta de la sesión. (a) 2 filas en `GEC3`; (b) 4 filas = 2 bitácoras × 2 plantas, colapsadas a un renglón por la clave de agrupación; (c) 2 filas en `GEC32`. | **(b) 4 filas: 2 bitácoras × 2 plantas.** Cada unidad ve el asiento en su propia bitácora de Sala; la clave lo colapsa a UN renglón en el libro. **Es una desviación consciente de la letra de RQ-05.8/RQ-05.10** — ver "Desviaciones" abajo. |
| 3 | **Contrato de la tabla nueva del esquema `dashboard`**, que los dos repos van a fijar literal. El motor de la base corre en hora Bogotá y todas las tablas vecinas del esquema usan `GETDATE()`. (a) Mínima con `GETDATE()` y Bitácora convierte una sola vez al leer; (b) mínima pero en UTC con `SYSUTCDATETIME()`; (c) con trazabilidad (`archivo`, `revisado_en`). | **(a) Mínima, `GETDATE()`.** `dashboard.despacho_recibido (fecha_despacho DATE PK, detectado_en DATETIME2 NOT NULL DEFAULT GETDATE())`. La conversión a UTC la hace Bitácora al leer, explícita y una sola vez (RN-05.f). |
| 4 | **¿Dónde se nota que las `15:00` del relleno son convención y no medición?** (a) Bandera en `campos_extra` y el CLI la reporta; (b) bandera + distintivo en la grilla de Sala, al estilo del chip de "anulado" de D-063; (c) bandera + sufijo `(hora estimada)` en el texto. | **(a) Bandera en `campos_extra`.** El texto del asiento no cambia y el libro sale idéntico, así que el criterio 2 se mantiene intacto para los días de relleno. Sin trabajo de front. |

## Ronda 2 — reparto en olas

| # | Pregunta | Respuesta |
|---|---|---|
| R1 | El trabajo son 6 piezas: (1) tabla + persistencia en el dashboard, (2) plantilla del texto y marcador, (3) seed del `tipo_evento`, (4) colapso por clave en el libro, (5) lector + creador + barrido c/5 min, (6) CLI de relleno. Las cuatro primeras no dependen de nada; el creador depende de ellas; el CLI depende del creador. (a) **2 olas, 5 lotes** — O1 con 3 lotes realmente paralelos, O2 con L04 y L05 declarando dependencia de L04 (el semáforo la hace cumplir: L05 no puede reclamar hasta que L04 esté `done`, así que se abre apenas L04 cierre, sin esperar un gate); (b) 3 olas; (c) 2 olas y 4 lotes metiendo el CLI dentro de L04. | **(a) 2 olas, 5 lotes.** Dos gates en total. |
| R2 | Las 4 filas necesitan un `tipo_evento` propio en `SALAJDT`/`SALAING` con `seleccionable = 0`, mismo patrón que los 4 tipos espejo de `F34.A1`. El nombre queda visible en el histórico: (a) `Despacho económico`; (b) `Recepción de despacho XM`; (c) `Despacho del día siguiente`. | **(a) `Despacho económico`.** Calcado del vocabulario del F03 y del propio asiento; se distingue sin ambigüedad de `Redespacho`, que ya existe como tipo espejo en las mismas dos bitácoras. |
| R3 | El repo `dashboard-gen-gec3` está en `main`, limpio y al día (`d8f8f5e`). ¿Rama propia desde `main` o commit directo sobre `main`? | **Rama propia desde `main`:** `feat/asiento-despacho-xm-2026-08`, con el mismo nombre que la de Bitácora para que el despliegue conjunto las encuentre. |

## Criterios de aceptación congelados

Son los 12 de `REQ-05 §6`, sin reabrir. La columna del verificador es lo que se fijó en esta
sesión; el lote responsable propone `cumple`, el gate confirma.

| CA | Criterio (falsable) | Verificador previsto | Lote |
|---|---|---|---|
| CA-1 | Detectado el despacho, aparece el asiento en `SALAJDT` y `SALAING`, autor `SISTEMA`, sin que nadie teclee. | `tests/despacho_xm.test.js` › "crea los asientos con autor SISTEMA" | L04 |
| CA-2 | El texto es exactamente `Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA`, con la fecha del día siguiente. | `tests/asiento_despacho_xm.test.js` › "texto literal" (puro) | L02 |
| CA-3 | En el libro GENE-F03 del mes aparece **una sola vez**, en la hoja del día en que se recibió, a la hora de detección. | `tests/f03_despacho_xm.test.js` › "colapsa las 4 filas en un renglón" | L03 |
| CA-4 | El detector corre varias veces el mismo día → existe **un solo** asiento. | `tests/despacho_xm.test.js` › "idempotente ante repeticiones" | L04 |
| CA-5 | El relleno deja los días pasados a las `15:00` marcados como estimada, sin pisar ninguno con hora real, y re-correrlo no duplica. | `tests/relleno_despacho_xm.test.js` › "resumible e idempotente" | L05 |
| CA-6 | Un despacho de `TGJ1`/`TGJ2` no produce asiento en Bitácora. | `tests/despacho_xm.test.js` › "solo GEC3 y GEC32" | L04 |
| CA-7 | Un día sin despacho no produce renglón. | `tests/despacho_xm.test.js` › "sin hecho no hay asiento" | L04 |
| CA-8 | Si la tabla del dashboard no existe o está caído, Bitácora opera normal y solo deja de recibir asientos. | `tests/despacho_xm.test.js` › "degrada sin tabla" | L04 |
| CA-9 | Las celdas de la grilla de captura de Operación 24h siguen vacías. | `tests/despacho_xm.test.js` › "no toca MAND" | L04 |
| CA-10 | No se republica nada al dashboard por causa del asiento. | `tests/despacho_xm.test.js` › "no escribe evento_dashboard" | L04 |
| CA-11 | El asiento no tiene lápiz ni basurero, y un `PUT`/`DELETE` directo contra la API tampoco lo deja tocar. | `tests/despacho_xm.test.js` › "403 por autoría" | L04 |
| CA-12 | `docs/interfaces-cross-repo.md` describe el shape real de `GET /api/eventos-dashboard` y el contrato nuevo por BD compartida. | Revisión del gate contra `tests/contrato_eventos_dashboard.test.js` | integrador |

## Detalles operativos confirmados

Hechos medidos el 2026-08-31 contra el código y la BD `PortalG3_dev`, que el diseño da por
ciertos:

- **El esquema `dashboard` es visible con las credenciales de Bitácora** (verificado por query:
  `sys.schemas` devuelve la fila). Es lo que sostiene §5.1 del REQ: la comunicación es por BD y
  no hay endpoint nuevo.
- **`dashboard.despacho_recibido` no existe todavía** (verificado): el nombre está libre.
- **`asientoLiteralSala` prefijaría la unidad** al texto literal: `UNIDAD_YA_NOMBRADA` no matchea
  `"Se recibe del XM…"`. De ahí la respuesta 1.
- **`eventosSala` deduplica solo por `registro_id`** (`f03-datos.js:333-341`) y excluye los
  reflejados con `JSON_VALUE(campos_extra,'$.origen_bitacora') IS NULL`. Por eso el marcador nuevo
  **no puede llamarse `origen_bitacora`**: usarlo excluiría el asiento del libro (RQ-05.9).
- **La restricción de edición (CA-11) sale sola**: `canEditarRegistro` (`middleware/permissions.js:134`)
  exige `registro.creado_por === sesion.usuario_id`, y `SISTEMA` (`activo = 0`) nunca tiene sesión.
  No se programa nada nuevo — se **verifica**, tal como dice §8.2 del REQ.
- **El seed de tipos espejo es idempotente por `NOT EXISTS`** (`db.js:1080`) y lleva un `UPDATE`
  complementario que fuerza `seleccionable = 0` en cada arranque (`db.js:1101`). El tipo nuevo se
  agrega a **las dos** listas o el flag se pierde en el siguiente restart.
- **`#refreshTomorrow()` construye su `tomorrowStr` con `getFullYear/getMonth/getDate`**
  (`despachoscraper.js:303-304`), **sin** `.toISOString()`: ese camino **no** tiene el bug de fecha
  de §5.2.3 del REQ. El bug existe en otros usos de `getColombiaDate()` y queda fuera de alcance;
  L01 no lo arregla y tampoco construye encima suponiendo que no existe.
- **Baseline de la suite**: 681/681 backend + 324/324 front, medido en el gate O2 de D-063
  (`9dfbbe3`, 2026-08-29), sobre la rama que se mergeó a la base de este flujo. No se vuelve a
  correr en planeación.

## Desviaciones conscientes respecto del REQ-05

Se registran acá porque el REQ es la fuente y estas dos respuestas se apartan de su letra. **El
cierre (`/cerrar-implementacion`) actualiza el REQ**; los lotes no lo tocan.

1. **Cuatro filas en vez de dos** (respuesta 2). RQ-05.8 dice "un registro en `SALAJDT` y otro en
   `SALAING`" y RQ-05.10 habla de "las dos filas". Se implementan **cuatro** (las dos bitácoras en
   cada una de las dos plantas) para que el asiento sea visible en la bitácora de Sala de las dos
   unidades, no solo de una. **El espíritu de RQ-05.5 se conserva**: sigue habiendo UN asiento —
   un solo texto que nombra las dos unidades, y un solo renglón en el libro. Lo que cambia es el
   conteo de filas de respaldo, y el mecanismo que lo colapsa (la clave de agrupación de RQ-05.10)
   es exactamente el mismo.
2. **El marcador no es `origen_bitacora`** (respuesta 1). RQ-05.9 lo prohíbe con razón y el diseño
   lo respeta: el asiento **no** es una copia reflejada. Se introduce un marcador distinto
   (`origen_sistema`) que cumple otras dos funciones que el REQ pide por separado — no prefijar la
   unidad (RQ-05.4) y agrupar las filas (RQ-05.10).
