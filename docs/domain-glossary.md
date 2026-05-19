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

---

## Códigos de bitácora (`lov_bit.bitacora.codigo`)

| Código | Nombre | `formulario_especial` | UI | Notas |
|---|---|---|---|---|
| `MAND` | Operación 24h (anteriormente "Sala de Mando") | 1 | `SalaDeMandoGrid.jsx` | Grilla 24p × 3 tipos × 2 plantas. Batch save. No tiene cierre individual ni masivo (sweeper diario). Solo HOY editable. |
| `DISP` | Disponibilidad | 1 | `DisponibilidadDashboard.jsx` | Mini-dashboard con tabs GEC3/GEC32. Sin cierre de turno. 1 vigente por planta. 4 estados (D-024): `En Servicio` (`1`, verde), `En Reserva` (`0`, azul), `Indisponible` (`-1`, rojo, salida forzada), `Mantenimiento` (`-1`, amarillo, consignación). `Indisponible` y `Mantenimiento` comparten `codigo=-1`; el discriminador es el string `evento`. |
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
| 1 | Ingeniero Jefe de Turno (JdT) | Crear/editar/cerrar en la mayoría de bitácoras. Es el coordinador del turno. |
| 2 | Ingeniero de Operación (IngOp) | Crear/editar en operativa. Cierra turno propio. |
| 3 | Ingeniero Químico | Visualizador. Crea en su bitácora de laboratorio. |
| 4+ | Jefes de Planta, Gerencia, Otros | Visualizadores universales, audit access. |

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
| `AUTH` | Autorizaciones | No | **Requerido** (si algún valor en la fila) |
| `PRUEBA` | Pruebas | No | NULL forzado |
| `REDESP` | Redespacho | **Sí** (periodo >= actual) | NULL forzado |

24 periodos × 3 tipos × 2 plantas = 144 celdas posibles. El periodo P1 cubre 00:00–00:59, P2 cubre 01:00–01:59, …, P15 cubre 14:00–14:59, …, P24 cubre 23:00–23:59 (hora Bogotá).

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
| `periodo_bloqueado` | POST MAND guardar | REDESP intentando editar periodo < actual. |
| `funcionariocnd_requerido` | POST MAND guardar | AUTH con valor sin funcionariocnd. |
| `mand_cierre_individual_no_permitido` | POST /api/cierre/bitacora con MAND | MAND no acepta cierre individual. |
