# Decisiones de arquitectura — Bit-cora-g3 (ADR-lite)

Decisiones destiladas de las fases F1–F22. Formato corto: Contexto / Decisión / Consecuencias. Si una decisión afecta la BD o un contrato, también está reflejada en `BIT-MODBD-2026-001.md` o `BIT-RF-2026-001.md`.

---

## D-001 — Snapshots JSON en lugar de FK a usuarios

**Contexto:** los usuarios cambian de cargo con el tiempo; un evento operativo debe conservar el rol de cada participante al momento del evento, no su rol actual.

**Decisión:** `jdts_snapshot`, `jefes_snapshot`, `ingenieros_snapshot` se guardan como JSON (NVARCHAR(MAX)) en `registro_activo` y `registro_historico`. Solo `creado_por` y `modificado_por` son FK a `lov_bit.usuario`.

**Consecuencias:** los consumidores parsean JSON. Auditoría queda fija. Helpers `snapshotJDTs/Jefes/Ingenieros` en `server/utils/snapshots.js`. NO usar `JOIN lov_bit.usuario` para reconstruir participantes.

---

## D-002 — 2 turnos, no 3 (modelo F1)

**Contexto:** el usuario ocasionalmente describe "3 turnos" (madrugada/día/noche). Eso es narrativa operativa, no modelo de datos.

**Decisión:** 2 turnos solamente. T1 diurno [06,17], T2 nocturno [18,23]∪[00,05]. T2 cruza medianoche.

**Consecuencias:** todo el código (cierre cronológico, snapshots, sweepers, autoselección en formularios) asume 2 turnos. Si alguna vez se pide cambiar a 3, rompe F1, F4, F6, F10 y los registros existentes.

---

## D-003 — Sesión persistente sin TTL (F2)

**Contexto:** el modelo viejo dependía de heartbeat cada N segundos para mantener `sesion_activa` viva. Operadores que se quedaban quietos o cerraban la pestaña accidentalmente caían en logout involuntario.

**Decisión:** `sesion_activa.activa=1` hasta logout explícito. Eliminados `POST /api/auth/heartbeat` y `POST /api/auth/resume`. Nuevo modelo de "participación en bitácora" via tabla `bitacora.sesion_bitacora (sesion_id, bitacora_id, abierta_en, finalizada_en)`.

**Consecuencias:** múltiples logins del mismo usuario son válidos. `snapshotJDTs`/`snapshotJefes`/`snapshotIngenieros` y `/api/catalogos/jdt-actual` leen `sesion_bitacora` con `finalizada_en IS NULL`, sin filtro de TTL. El sweeper de cierre cronológico finaliza turnos vencidos pero NO toca `sesion_activa.activa`.

---

## D-004 — Bitácora CIET (Cierres y Finalizaciones) — solo lectura (F3)

**Contexto:** se necesita auditoría de quién cerró/finalizó qué y cuándo, sin que ningún usuario pueda crear esos registros manualmente.

**Decisión:** nueva bitácora `CIET` con `formulario_especial=0`, todos los cargos con `puede_ver=1`, nadie con `puede_crear=1`. Los INSERTs se generan automáticamente desde código vía `server/utils/ciet.js::registrarEventoCierre`. Tipos: `'Finalización de turno'`, `'Cierre de turno'`, `'Deshacer disponibilidad'`.

**Consecuencias:** `detalle` se hizo NULLable porque el helper inserta `detalle=''` o NULL — la info viva en `campos_extra` JSON. Aparece automáticamente en la vista histórica.

---

## D-005 — Cierre cronológico por turno (F4)

**Contexto:** "cerrar la bitácora" tiene que respetar el turno operativo (cuándo ocurrieron los eventos), no la hora del request.

**Decisión:** el cierre de turno agrupa registros por `(planta, turno, bitacora)` y usa `ventanaTurno(turno, fecha_referencia)` para decidir cuáles cerrar. `fecha_cierre_operativo = CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)`. (D-042: el cierre de turno masivo es el único cierre; el cierre individual fue eliminado.)

**Consecuencias:** MAND y DISP están explícitamente excluidos del cierre cronológico (cada uno tiene su propia mecánica). Edge case T4 (`fecha_evento` idéntica) resuelto 2026-05-13 con tiebreaker `, registro_id ASC` en el `SELECT TOP 1` del cierre de turno.

---

## D-006 — Contrato Bitácora ↔ Dashboard: `evento_dashboard` (F5)

**Contexto:** el dashboard productivo necesita leer autorizaciones, redespachos y pruebas en formato uniforme por periodo.

**Decisión:** tabla puente `bitacora.evento_dashboard` con UNIQUE `(planta_id, fecha, periodo, tipo)`. `tipo CHECK IN ('AUTH','REDESP','PRUEBA')`. Renombrada desde `bitacora.autorizacion_dashboard`. Soft-delete con `activa=0`. Detalle del contrato en `../../docs/interfaces-cross-repo.md`.

**Consecuencias:** Bitácora UPSERTea filas; Dashboard consume vía `GET /api/eventos-dashboard?tipo=&planta_id=`. DISP NO usa esta tabla (ver D-009). Vista compat se mantuvo durante la transición y se retiró en F9.

---

## D-007 — "Cancelar autorización" = vaciar celda (F7)

**Contexto:** en la grilla genérica de bitácoras y especialmente en MAND/Autorizaciones, el operador necesita poder revocar una autorización sin un botón explícito de "cancelar".

**Decisión:** vaciar la celda (`valor_mw=null`) en el batch save dispara un DELETE hard del registro + `UPDATE evento_dashboard SET activa=0`. El dashboard detecta `activa=0` y oculta la fila.

**Consecuencias:** no hay confirm dialog por celda vaciada; se confía en el "Guardar" único del batch como punto de no-retorno.

---

## D-008 — DISP como mini-dashboard interactivo, no grilla (F12-F14)

**Contexto:** la grilla genérica de DISP no transmitía el estado actual de cada planta de forma operativa; el operador necesitaba ver de un vistazo el estado vigente, cuándo cambió y hace cuánto.

**Decisión:** `DisponibilidadDashboard.jsx` con tabs GEC3↔GEC32, card de estado actual (paleta verde/amarillo/rojo según estado), counter live "tiempo en este estado", historial paginado, y modal con 3 acciones: Cambiar / Editar / Deshacer último.

**Consecuencias:** `BarraEstado` y los controles genéricos de header (filtros F11, Nuevo Registro, Cerrar) NO se renderizan para DISP. Visibilidad universal (`puede_ver=1` para todos los cargos). Botones gateados a cargos 1 y 2 (front + back).

---

## D-009 — `disponibilidad_dashboard` separada de `evento_dashboard` (F14)

**Contexto:** DISP es semánticamente distinta a AUTH/REDESP/PRUEBA — no tiene `periodo`, es 1 fila por planta, no por hora.

**Decisión:** tabla aparte `bitacora.disponibilidad_dashboard` con PK = `planta_id`. UPSERT en cada POST/PUT/DELETE/Deshacer. El endpoint `GET /api/eventos-dashboard?tipo=DISP&planta_id=` detecta el tipo y lee de esta tabla en lugar de `evento_dashboard`, devolviendo shape compatibilizado.

**Consecuencias:** no se rompe la UNIQUE de `evento_dashboard` por meter NULL en periodo. F15 (badge en dashboard productivo) consumirá este endpoint sin tocar bitácora.

---

## D-010 — DISP: cierre automático al llegar nuevo evento (F12)

**Contexto:** DISP no tiene cierre de turno. Pero un nuevo evento tiene que cerrar al anterior para mantener la cronología y la invariante "1 vigente por planta".

**Decisión:** flujo transaccional con `UPDLOCK, HOLDLOCK`: SELECT vigente → UPDATE `fecha_fin_estado = nuevo.fecha_inicio_estado` → INSERT a histórico → DELETE de activo → INSERT nuevo en activo → UPSERT `disponibilidad_dashboard` → commit. Filtered unique index `UQ_disp_vigente_por_planta` actúa como segunda barrera.

**Consecuencias:** dos POSTs concurrentes para la misma planta se serializan vía UPDLOCK. Si el filtered unique index rechaza, el cliente recibe error útil. No se permiten estados consecutivos iguales (409 `mismo_estado`) ni fechas anteriores al vigente (409 `fecha_anterior_a_vigente`).

---

## D-011 — DISP: edición del vigente puede mutar histórico (excepción a inmutabilidad)

**Contexto:** un operador puede equivocarse al escribir la fecha del nuevo estado. Si la fecha cambia, hay que ajustar `N-1.fecha_fin_estado` para no dejar gap en la cronología.

**Decisión:** PUT al vigente DISP puede actualizar `fecha_inicio_estado`. Si lo hace, el handler también actualiza `N-1.fecha_fin_estado = nueva_fecha_inicio` en `registro_historico` (excepción controlada a la regla de inmutabilidad histórica). `planta_id` nunca es editable (422).

**Consecuencias:** documentado en `BIT-MODBD-2026-001.md` como "excepción controlada en DISP PUT". Cualquier `puede_crear=1` puede editar (no solo el creador). `modificado_por` y `modificado_en` se setean al editor.

---

## D-012 — DISP: deshacer emite CIET con audit ampliado

**Contexto:** "Deshacer último" es destructivo (borra del histórico, restaura el más reciente como vigente). Sin rastro, no hay forma de auditar quién deshizo qué.

**Decisión:** `POST /api/disponibilidad/deshacer` emite un CIET con tipo `'Deshacer disponibilidad'` y `campos_extra = { planta_id, evento_revertido, fecha_revertida, autor_delete, jdts_activos: [...], gerentes_activos: [...] }`. Snapshots se calculan en el momento del deshacer leyendo `sesion_activa` con `activa=1`.

**Consecuencias:** auditoría preserva responsable + contexto de quién más estaba en sesión. Tipo de evento CIET nuevo en seeds.

---

## D-013 — MAND: batch save atómico con diff (F16-F17)

**Contexto:** el modelo viejo (celda-por-celda con onBlur) generaba muchos requests, era no atómico (un fallo a media grilla la dejaba inconsistente), y no permitía operaciones masivas (multi-select para replicar valor).

**Decisión:** frontend mantiene buffer en memoria; backend recibe SOLO el diff vía `POST /api/sala-de-mando/guardar` y lo procesa en una transacción única. `valor_mw=null` significa DELETE; el resto es INSERT/UPDATE según existencia. Si hay errores de negocio, devuelve `400 { errores: [...] }` y no escribe nada.

**Consecuencias:** botón "Guardar" único reemplaza al "Nuevo Registro" en el header de MAND. `beforeunload` confirm si hay cambios pendientes. Frontend descarta cambios al refrescar (memoria pura — opción 1 elegida sobre sessionStorage para mantener simplicidad).

---

## D-014 — MAND: cierre automático fin de día via sweeper (F16)

**Contexto:** MAND no se cierra por turno (los 3 tipos × 24 periodos pertenecen al día calendario, no al turno). Cierre manual sería propenso a olvidos.

**Decisión:** `server/utils/mand-sweeper.js` corre `setInterval` cada 60s, detecta cambio de día Bogotá, y cierra el día anterior moviendo registros a `registro_historico`. Idempotencia vía `bitacora.mand_cierre_log` (PK `fecha_cerrada, planta_id`). Catch-up al reinicio del server.

**Consecuencias:** `POST /api/cierre/bitacora` devuelve 400 para MAND (front oculta los tres botones de cierre del header — "Finalizar Turno", "Cerrar Turno" individual y "Cerrar Masivo" — quedando solo "Guardar"; back defensa en profundidad). `GET /api/sala-de-mando/dias-pendientes` eliminado. MAND solo muestra HOY; no hay paginación entre días. F10 (paginación) queda explícitamente obsoleta por F17. Ajuste 2026-05-15: el botón "Cerrar Turno" individual quedó sin gate `!isMand` al rebrand y se agregó.

---

## D-015 — MAND CIET autor SISTEMA + snapshots agregados

**Contexto:** el cierre automático del día no tiene un usuario humano detrás. Pero el invariante "todo CIET tiene autor no-NULL" debe sostenerse, y el snapshot debe reflejar toda la guardia del día, no solo quien esté logueado a las 00:00:30.

**Decisión:** usuario seedeado `SISTEMA` (`username='SISTEMA'`, `activo=0`, `password_hash='!disabled!'`). Cacheo de `USUARIO_SISTEMA_ID` al arranque. Snapshots agregados via `SELECT DISTINCT u.usuario_id, u.nombre_completo FROM bitacora.sesion_activa s JOIN lov_bit.usuario u ... WHERE planta_id=@p AND CAST(s.creada_en AS DATE)=@fecha AND c.nombre='Ingeniero Jefe de Turno'` (idem para IngOp y Jefes).

**Consecuencias:** RN-13: "MAND no genera CIET por usuario; el CIET diario tiene autor SISTEMA". Snapshots agregados captan rotación de personal por la guardia.

---

## D-016 — MAND lock REDESP por periodo actual

**Contexto:** REDESP es prospectivo (redespacho del CND para periodos futuros). No tiene sentido editar periodos pasados.

**Decisión:** celdas REDESP con `periodo < periodoActual` están `disabled` mostrando el valor existente (no se ocultan). `periodoActual = floor(horaBogota()) + 1` ("periodo actual o posteriores"). El periodo actual SÍ es editable para no romper el caso del P1 al inicio del día. Frontend recalcula `periodoActual` cada 60s. Backend rechaza con `400 periodo_bloqueado` cualquier intento de cruzar la frontera.

**Consecuencias:** AUTH y PRUEBA NO tienen este lock (registros a-posteriori son válidos). RN-14: "REDESP solo edita periodo actual + posteriores en el día".

---

## D-017 — MAND: solo HOY editable, sin días futuros ni anteriores

**Contexto:** el modelo anterior permitía navegar a días pendientes con borradores. Eso era para mitigar olvidos antes del cierre automático. Con D-014 (sweeper), no debería haber días pendientes nunca.

**Decisión:** MAND solo muestra HOY. No hay UI para días anteriores ni futuros. `GET /api/sala-de-mando/dias-pendientes` eliminado. Backend rechaza con `400 fecha_no_es_hoy` cualquier guardar con fecha distinta.

**Consecuencias:** lógica de navegación entre días en `useSalaDeMando.js` borrada. Watcher de medianoche refetch automático al cambio de día (la grilla aparece vacía después del cierre del sweeper).

---

## D-018 — MAND: FuncionarioCND requerido en AUTH, ausente en PRUEBA/REDESP

**Contexto:** "Funcionario CND" tiene sentido solo en autorizaciones del CND. Para pruebas internas y redespachos no es información operativa.

**Decisión:** input deshabilitado y forzado a NULL en filas PRUEBA y REDESP. AUTH lo requiere si hay al menos un `valor_mw != null` en algún periodo. Backend rechaza con `400 funcionariocnd_requerido` si falta en AUTH con valor.

**Consecuencias:** migración one-time limpia `funcionariocnd` de `campos_extra` en registros viejos de PRUEBA/REDESP (datos de prueba, sin pérdida operativa). Frontend muestra placeholder "No aplica" para inputs deshabilitados.

---

## D-019 — MAND: modificado_por se actualiza solo si valor_mw cambió

**Contexto:** propagar detalle/funcionariocnd a todos los registros de una fila no debe "ensuciar" la atribución de quién hizo el cambio del valor.

**Decisión:** en el batch save, `modificado_por` se actualiza SOLO en celdas cuyo `valor_mw` cambió. Si solo cambió detalle o funcionariocnd a nivel fila, esos campos se actualizan en todos los registros pero `modificado_por` queda como estaba.

**Consecuencias:** el CIET de cierre automático refleja autoría real por celda. Documentado en regla 2b de `BIT-RF-2026-001.md`.

---

## D-020 — TZ: BD en UTC, presentación en Bogotá explícito (F19-F22)

**Contexto:** la app es solo para usuarios colombianos. Pero el código tenía mezcla de `GETDATE()` (depende del host), `getHours()` sin TZ explícito (depende del navegador), y comparaciones de fecha sin convertir.

**Decisión:** convención canónica UTC-first en BD (`SYSUTCDATETIME()`) + presentación con `Intl.DateTimeFormat` con `timeZone: 'America/Bogota'` explícito siempre. Inputs `<datetime-local>` se interpretan como hora Bogotá (operador escribe = hora planta). Comparaciones de "día Bogotá" en queries con `DATEADD(HOUR, -5, columna)`.

**Consecuencias:** bugs T1 (grilla MAND vacía 19:00–23:59), T2 (sweep TTL dependiente de TZ host), T5-T7 (formatters frontend) corregidos en F19/F20. Edge case T4 (cierre cronológico ORDER BY) resuelto 2026-05-13 con tiebreaker `, registro_id ASC`. Vista compat BD con columnas calculadas `_bogota AS DATEADD(-5, ...)` para queries SSMS. Tests con matriz TZ (UTC, Bogotá) en F21.

---

## D-021 — Categorías del TabBar hardcoded en frontend

**Fecha:** 2026-05-13

**Contexto:** el TabBar agrupa bitácoras por categoría (hoy: "Sala de Mando" agrupa DISP y MAND). La constante `CATEGORIAS` vive en `src/BitacorasGecelca3.jsx`, junto con el componente `CategoriaTab` que la renderiza como botón con flyout portal. Importante: el nombre de la categoría (menú desplegable) es "Sala de Mando"; el nombre "Operación 24h" corresponde a la bitácora MAND individual (la grilla AUTH/PRUEBA/REDESP), no a la categoría.

**Decisión:** mantener `CATEGORIAS` hardcoded en frontend. NO migrar a tabla `lov_bit.categoria` + columna `categoria_codigo` en `lov_bit.bitacora` por ahora.

**Consecuencias:** una sola categoría, dos bitácoras agrupadas, cambio esperado "una vez al año o menos". Migrar a BD por algo que no cambia es sobreingeniería. Si en fases futuras aparecen >3 categorías o la lista cambia con frecuencia, migrar a `lov_bit.categoria` (codigo, nombre, nombre_corto, icono, orden) + FK opcional `lov_bit.bitacora.categoria_codigo`. Mientras tanto, cambio de categoría requiere redeploy del frontend.

> **Nota (2026-05-26):** la categoría se renombró en UI de "Sala de Mando" a **"Despachos"** (`nombre`/`nombreCorto` en `CATEGORIAS`). El `codigo` interno sigue siendo `SALA_DE_MANDOS`. El cargo "Operador de Planta - Sala de Mando" y la bitácora "Sala de Mando Operativa" (codigo `SALA`) son conceptos distintos y no cambiaron.

---

## D-022 — Bitácoras sin badge numérico hardcoded en frontend

**Fecha:** 2026-05-13

**Contexto:** el TabBar muestra un badge con el count de registros pendientes por bitácora. DISP no tiene noción de "pendiente" — es estado vigente, no count de registros activos — por eso el badge se omite.

**Decisión:** mantener `SIN_BADGE_CODIGOS = new Set(['DISP'])` hardcoded en `src/BitacorasGecelca3.jsx`. NO migrar a flag `mostrar_badge BIT NOT NULL DEFAULT 1` en `lov_bit.bitacora`.

**Consecuencias:** misma lógica que D-021 — una bitácora especial con una mecánica especial. Si en futuro otra bitácora entra en la misma categoría (count semánticamente vacío), agregar al `Set`. Si la lista crece a >3 entradas, migrar a flag en BD.

---

## D-023 — Invariante singleton para `es_jefe_planta` / `es_jdt_default` reforzado en `initDB()`

**Fecha:** 2026-05-14

**Contexto:** `BIT-RF-2026-001.md` §3 y §6.5 establecen que `es_jefe_planta=1` corresponde a un único usuario (hoy Ernesto Muñoz, `username='emunoz'`) y `es_jdt_default=1` a otro único usuario (hoy Omar Fedullo, `username='ofedullo'`). En testeo se observó que cuentas auxiliares (`test_gerente`, `test_jdt`) habían quedado con esos flags en `1`, contaminando `jefes_snapshot` (D-001 no filtra por sesión) y `jdts_snapshot` (vía fallback). La spec era correcta; la data divergió.

**Decisión:** además de la limpieza one-off (`sql/snippets/limpiar_test_user_flags.sql`), agregar en `initDB()` un bloque idempotente envuelto en `BEGIN TRAN/COMMIT` que asegura el invariante en cada arranque. Sigue el patrón `IF NOT EXISTS`/idempotencia ya usado para `SISTEMA` (D-015) y `seedPersonal()`.

**Consecuencias:** ediciones manuales en BD o seeds futuros mal escritos quedan corregidos al próximo levantamiento del backend. La verdad sobre quién tiene los flags vive ahora en dos lugares coherentes: `server/data/personal-2026.json` (`es_jefe_planta`/`es_jdt_default` por usuario) y este bloque defensivo. Si se cambia el titular de Ernesto o de Omar, hay que actualizar AMBOS: el JSON (cambia el flag del nuevo + del anterior) y este bloque (cambia el `username` excluido del UPDATE). Documentado como gotcha al evolucionar el sistema.

---

## D-024 — DISP: modelo de 4 estados con discriminador por string `evento`

**Fecha:** 2026-05-15

**Contexto:** los tres estados originales de DISP (`Disponible` / `En Reserva` / `Indisponible`) mezclaban dos conceptos distintos dentro de "Disponible": (a) la planta está disponible y generando vs. (b) la planta está disponible pero fuera de servicio. Además, la familia de eventos `codigo=-1` no distinguía entre salida forzada (lo que reporta XM como "horas de indisponibilidad") y consignación programada (mantenimiento planeado), aunque operacionalmente son flujos distintos.

**Decisión:** rebrand a 4 estados:

| `evento` | `codigo` | Significado | Color UI |
|---|---|---|---|
| `En Servicio` | `1` | Disponible y generando | Verde |
| `En Reserva` | `0` | Disponible, no generando | Azul |
| `Indisponible` | `-1` | Salida forzada — imposible generar | Rojo |
| `Mantenimiento` | `-1` | Consignación / salida planeada | Amarillo |

`Indisponible` y `Mantenimiento` **comparten `codigo=-1`** intencionalmente: el campo numérico es la métrica agregable de "horas de indisponibilidad" que se reporta a XM (= `SUM(codigo=-1)` ponderado por duración). El discriminador semántico/visual vive en el string `evento`. **No se introdujo columna nueva** porque ya existe esa información en el `evento`; agregar `subtipo_indisponible` duplicaría datos sin beneficio.

Migración idempotente en `initDB()` (`server/db.js`): drop del CHECK viejo (anónimo) por nombre detectado en `sys.check_constraints`, UPDATE in-place `'Disponible'` → `'En Servicio'` en `disponibilidad_dashboard.evento` y en `campos_extra` JSON de `registro_activo` + `registro_historico` con `JSON_MODIFY`, y ADD del nuevo CHECK nombrado `CK_disp_dashboard_evento` con los 4 strings nuevos.

**Consecuencias:** (a) cualquier consumidor del badge en `dashboard-gen-gec3` (F15 pendiente) que pinte color por evento debe leer el string, no el código (dos eventos comparten `-1`); el contrato cross-repo en `docs/interfaces-cross-repo.md` lo documenta explícitamente. (b) Reporte XM = `SUM(codigo=-1)` sigue funcionando sin cambio porque ambos casos contribuyen al total de horas no-disponibles. (c) Toda capa que use `ESTADO_COLORS` (frontend) o `DISP_EVENTOS_VALIDOS` (backend) lee desde la fuente única — los 4 estados se mantienen sincronizados con la BD. (d) El componente `TiempoEnEstado.jsx` se reescribió en paralelo con un formato más operativo (años/meses/d/hr/min/s, plural correcto, omite ceros excepto segundos, sin semanas).

**Extensión 2026-05-15 (mismo PR de D-024) — cimiento de métricas para el futuro dashboard:**

Para que el dashboard productivo (F15+) pueda mostrar indicadores históricos (tiempo en servicio, tiempo en reserva, tiempo indisponible, tiempo en mantenimiento, y los dos acumulados `disponible` y `no_disponible`), el backend agrega:

- **Vista SQL** `bitacora.v_disp_intervalos` — normaliza `registro_activo` ∪ `registro_historico` (DISP) en intervalos `(planta_id, evento, codigo, fecha_inicio_estado, fecha_fin_estado)`. El vigente tiene `fecha_fin_estado IS NULL`. Aprovecha el invariante `fecha_evento = fecha_inicio_estado` que el backend mantiene en POST/PUT DISP (no re-parsea JSON). Creada con `CREATE OR ALTER VIEW` en `initDB()`, así cada arranque la deja sincronizada.
- **Endpoint** `GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=` — agrega `SUM(DATEDIFF_BIG(MILLISECOND, intersección con [desde,hasta]))` agrupado por `evento`. Defaults: `desde` = primer intervalo de la planta, `hasta` = `SYSUTCDATETIME()`. Devuelve `tiempo_ms` por estado + `acumulados_ms.disponible` (= servicio+reserva) y `acumulados_ms.no_disponible` (= indisponible+mantenimiento). Permiso: `puede_ver` en DISP. Contrato detallado en `PORTAL GENERACIÓN/docs/interfaces-cross-repo.md`.
- **Tests**: `server/tests/disponibilidad.test.js` casos 16–18 (con históricos+vigente, ventana acotada, planta sin registros).

Razón de la vista en vez de query inline: encapsula la unión `activo + histórico` y la extracción JSON (`JSON_VALUE` en `campos_extra`). Cualquier indicador futuro (uptime semanal, MTBF, % por turno) se construye sobre `v_disp_intervalos` sin duplicar lógica de "qué cuenta como un intervalo DISP".

---

## D-025 — Conformación de turno (snapshot histórico de usuarios por turno-planta)

**Fecha:** 2026-05-19

**Contexto:** el repo declara como objetivo de negocio el registro auditable de los usuarios que ingresaron a la app durante un turno (T1/T2 por planta GEC3/GEC32), con cargo, hora de entrada y hora de salida. Hasta este flujo, los datos crudos existían en `sesion_activa` + `sesion_bitacora` pero (a) `sesion_activa.cerrada_en` nunca se llenaba en logout (deuda operativa desde F2), (b) no había vista/tabla agregada por turno, (c) no había endpoint ni UI para consultar la información.

**Decisión:**

1. **Modelo de persistencia (Q1=b):** tabla `bitacora.conformacion_turno` con PK compuesta `(fecha_operativa, planta_id, turno, usuario_id)`. Una fila por usuario por turno por planta. Columnas: `usuario_nombre`, `cargo_id`, `cargo_nombre`, `inicio_sesion`, `fin_sesion`, `duracion_min`, `fin_inferido BIT`, `snapshot_en`. Columnas calculadas `*_bogota` aplicadas en bloque F22.D2 separado (F22.D1 ya marcado aplicado). Inmutable post-snapshot. Patrón idempotente en `initDB()` siguiendo `mand_cierre_log`.

2. **Granularidad (Q2=a):** agregada por (turno, usuario). Re-logins del mismo usuario en el mismo turno colapsan en una fila con `MIN(inicio_sesion)`, `MAX(fin_efectivo)`, `SUM(duracion)`. Auditoría granular sigue disponible vía `sesion_activa` cruda si se necesita.

3. **Filtro semántico del builder (pivot post-implementación):** una sesión cuenta para el turno X si **arrancó dentro de la ventana de X** (`sa.inicio_sesion >= ventana_inicio AND sa.inicio_sesion < ventana_fin`). La alternativa "sesiones que solapan" — explorada inicialmente — incluía sesiones eternas (jefes que nunca cierran sesión por D-003) y sesiones limbo (`activa=0 + cerrada_en=NULL` de cleanups), produciendo duraciones absurdas (>100 días). El modelo `sesion_activa.turno` se fija al login: una sesión es "del turno X" si y solo si arrancó en X.

4. **Trigger híbrido (Q3=d):**
   - `server/utils/turno-sweeper.js` (F4) extendido: tras cerrar `sesion_bitacora` por agotamiento, recopila `(planta_id, turno, fecha_operativa)` únicos y dispara `buildConformacionSnapshot` + `persistConformacionSnapshot` en loops aislados con `try/catch` por conformación.
   - Catchup en `server/db.js::initDB()` al arranque recupera turnos cerrados de los últimos 7 días Bogotá sin snapshot. Filtro de "ventana ya cerró" en JS (`ventanaTurno().fin < ahora`) más legible que un CASE SQL anidado.
   - Idempotencia natural vía PK.

5. **Visualización (Q4=e + extra):** solo backend en W1. Dos endpoints:
   - `GET /api/conformacion-turno?fecha=&turno=&planta_id=` — abierto a cualquier rol con sesión (`puedeVerConformacion=true`, gancho futuro para restringir).
   - `POST /api/conformacion-turno/trigger` — dispara snapshot manual; gated por `puedeTriggerConformacion` (`puede_cerrar_turno=1` o `es_jefe_planta=1`). Por defecto rechaza turnos cuya ventana no cerró; `?force=true` permite bypass marcando `force=true` en response.

6. **Logout no llamado (Q5=c):** si `cerrada_en IS NULL` al snapshot, el builder usa `fin_sesion = ventanaTurno(turno).fin` (UTC del fin de la ventana Bogotá) y setea `fin_inferido=1`. Aproxima ligeramente por arriba pero permite duración usable. La columna `fin_inferido` (deliberadamente conservada contra la Q5 pura, 1 byte) permite auditoría futura sin migración.

7. **Logout explícito (fix retro):** `POST /api/auth/logout` ahora pobla `sesion_activa.cerrada_en = SYSUTCDATETIME()` (era deuda operativa F2 nunca cerrada). El builder usa ese timestamp directamente — `fin_inferido=0`.

**Invariante preservado (cross-ref [[D-003]]):** `sesion_activa.activa=1` sigue siendo indefinida hasta logout explícito o sweeper de turno. Conformación se construye SOBRE la sesión viva, NO la reemplaza ni introduce TTL. Cualquier propuesta futura de TTL debe respetar este invariante.

**Consecuencias:**
- Nueva tabla `bitacora.conformacion_turno` (DDL en `server/db.js::initDB()`, sigue patrón idempotente).
- Sweeper `turno-sweeper.js` gana responsabilidad de snapshot. Sin cambio de comportamiento sobre `sesion_bitacora`.
- `BIT-MODBD-2026-001.md` v1.6 nueva sección §4.7.
- Cobertura backend: 14 tests dirigidos en `server/tests/conformacion_turno.test.js`.
- **Deuda residual:** las ~50 filas que el catchup escribió antes del pivot del filtro (commit `e1d88da`) contienen sumas con la lógica vieja. Greenfield W1 sin consumers → recomendado `DELETE FROM bitacora.conformacion_turno` para que el próximo arranque rellene con la lógica correcta.
- W10 (Lock de pantalla, roadmap) se construye sobre este foundation sin tocar `sesion_activa`; la mitigación regulatoria "operador no presente al firmar" se cumple via W10, NO via TTL.

---

## D-026 — DISP migrado a tabla dedicada con vista de acumulados

**Fecha:** 2026-05-20

**Contexto:** la auditoría del modelo detectó que DISP rompía ~10 invariantes del patrón "bitácora dinámica genérica" — `turno NULL`, columna `fecha_fin_estado` DISP-only en `registro_activo`/`registro_historico`, filtered unique index `UQ_disp_vigente_por_planta`, histórico mutable controlado vía PUT (D-011), vista intermedia `v_disp_intervalos` para reconstruir intervalos, tabla puente paralela `disponibilidad_dashboard`, ~13 de 25 ADRs dedicados a DISP/MAND. DISP es semánticamente una **máquina de estados con intervalos** y no encaja en la abstracción "bitácora con `campos_extra` JSON". Cross-repo aún no consume DISP (F15 pendiente) → blast radius bajo, ventana de oportunidad para refactor.

**Decisión:** mover DISP a una tabla dedicada `bitacora.disponibilidad_estado` (PK `disponibilidad_id`, columnas tipadas `planta_id`, `estado`, `codigo`, `fecha_inicio_estado`, `fecha_fin_estado`, `detalle`, snapshots JSON `jdts_snapshot` / `jefes_planta_snapshot` / `gerentes_produccion_snapshot` / `ingenieros_snapshot`, FKs a `lov_bit.planta` y `lov_bit.usuario`). Acumulados por estado derivados via vista `bitacora.v_disponibilidad_estado` con window functions (`SUM(...) OVER (PARTITION BY planta_id ORDER BY fecha_inicio_estado ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`). La tabla `bitacora.disponibilidad_dashboard` se reemplaza por una VIEW del row vigente (`fecha_fin_estado IS NULL`), preservando el contrato HTTP del endpoint `GET /api/eventos-dashboard?tipo=DISP` (F15) — la vista mapea `disponibilidad_id → registro_activo_id` y `jefes_planta_snapshot → jefes_snapshot` por compat. Migración idempotente `F26.A1` en `db.js::initDB()` (transacción con rollback ante fallo): crea la tabla nueva + índices + vistas, hace backfill desde `registro_activo` ∪ `registro_historico` mapeando campos JSON a columnas tipadas, valida conteo con `THROW`, hace DELETE de rows DISP en origen, DROP de `v_disp_intervalos` y de la vieja tabla `disponibilidad_dashboard`, CREATE de la vista compat, INSERT del flag. Endpoints, frontend y contrato cross-repo quedan idénticos.

**Consecuencias:** (a) §7.8 de `BIT-MODBD` queda como referencia histórica — DISP ya NO rompe esos invariantes porque vive en su propia tabla. (b) Nueva columna `gerentes_produccion_snapshot` (cargo='Gerente de Producción' con sesión activa global) capturada en cada POST/PUT/deshacer. (c) Vista `v_disp_intervalos` dropeada — la nueva tabla ya es plana y la lógica de acumulados se mudó a `v_disponibilidad_estado` (window functions). (d) `HistoricoTable.jsx` genérica ya no muestra DISP (aceptado por el usuario — DISP solo vía mini-dashboard). (e) `jefes_snapshot` renombrado a `jefes_planta_snapshot` en la tabla nueva; la vista `disponibilidad_dashboard` mapea el nombre legacy para compat cross-repo. (f) `POST /api/disponibilidad/deshacer` ya no mueve filas entre tablas: el N-1 se reabre con `UPDATE fecha_fin_estado=NULL` sobre el mismo row (`restaurarComoVigente`); el vigente se borra con DELETE físico. (g) ~600 LoC en `server.js` simplificadas (~22% del archivo). (h) Test 1/2/6/7 de `disponibilidad.test.js` validaban estado interno vía queries directas a `registro_activo`/`registro_historico` filtrados por DISP — esos asserts internos deben re-apuntarse a `disponibilidad_estado` en seguimiento al refactor (el contrato HTTP de los tests sí queda preservado byte-a-byte). Cross-ref: [[D-008]] [[D-009]] [[D-010]] [[D-011]] [[D-012]] [[D-024]].

---

## D-027 — Ingesta de Consumos de Combustibles (pestaña Combustibles → Consumos)

**Fecha:** 2026-05-21

**Contexto:** la operación necesita registrar el consumo diario-horario de carbón (por alimentador), caliza y ACPM en cada planta para alimentar reportes regulatorios y de eficiencia. No es una bitácora (no hay estado ni cierre de turno); es un report numérico estructurado por (planta, fecha, periodo). El esquema es asimétrico entre plantas: GEC3 tiene 6 alimentadores nombrados (A–F) y GEC32 tiene 8 numerados (1–8), más caliza y ACPM en ambas. La spec original del usuario (columnas por planta) quedó plasmada en `BIT-MODBD §2.7`.

**Decisión:** modelar como pestaña nueva categoría jerárquica "Combustibles" en el sidebar, con un solo ítem "Consumos" por ahora. Storage en tablas dedicadas siguiendo el patrón híbrido que [[D-026]] establece para DISP: fila marcadora en `lov_bit.bitacora` (codigo `COMB`) para reusar permisos+sidebar+routing, pero datos en tablas propias — catálogo `lov_bit.combustible(planta_id, codigo, nombre, unidad, tipo, orden, activo)` y transaccional `bitacora.consumo_combustible(planta_id, fecha, periodo, combustible_id, cantidad, ...)` en formato long (1 fila por celda) para soportar el catálogo dinámico por planta. Vista `bitacora.v_consumo_periodo` deriva el formato wide para reportes/dashboard y calcula `total_carbon_ton = SUM(tipo='ALIMENTADOR')` sin duplicar storage. Permisos: crean `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno`; resto solo ven. Ventana de edición: fecha pasada o hoy; futuro rechazado con `400 fecha_futura`. Auditoría liviana: solo `creado_por`/`modificado_por` (sin snapshots de personal). Migración idempotente `F26.B1` en `initDB()` crea tablas + vista + 18 seeds de combustibles + fila bitácora COMB + permisos seedeados. La matriz canónica de permisos (`cargo_bitacora_permiso`, reconstruida en cada arranque) se extendió con CASE clauses para COMB → los permisos sobreviven a futuros restarts sin depender del flag F26.B1.

**Consecuencias:** (a) categoría jerárquica del sidebar gana una entrada (extensible — futuros ítems pueden agruparse acá). (b) `SIN_BADGE_CODIGOS` se extiende con `'COMB'` (consumos no tiene "pendientes"). (c) Header (`BarraEstado`) tratamiento equivalente a MAND: oculta filtros F11 + botones de turno/cierre — el botón Guardar vive dentro del propio `ConsumosGrid`. (d) Para agregar/quitar un combustible: editar `db.js` (seed + matriz si afecta permisos) + redeploy. Sin UI admin (el catálogo cambia raramente). (e) `modificado_por` se actualiza solo si `cantidad` cambió, no si solo cambió `detalle` — paridad con [[D-019]] de MAND. (f) Frontend bajo `src/components/Combustibles/`: `ConsumosGrid.jsx` (grilla buffer/snapshot/diff + Total Carbón virtual), `SelectorFecha.jsx` (←/→/Hoy con max=today), `useCombustibles.js` (hook con `getCatalogo/getConsumos/guardarBatch` contra `api.*`). (g) Ventana de edición **sin límite hacia atrás**: cualquier fecha pasada es editable (no solo los últimos N días), lo que permite reescritura arbitraria del histórico — trade-off de auditoría aceptado explícitamente por el usuario. Cross-ref: [[D-021]] (categorías hardcoded), [[D-022]] (SIN_BADGE_CODIGOS), [[D-026]] (patrón híbrido bitácora marcadora + tabla propia).

---

## D-028 — DISP: panel de acumulado histórico por estado en el mini-dashboard

**Fecha:** 2026-05-26

**Contexto:** el mini-dashboard DISP mostraba el contador "Tiempo en estado" (`TiempoEnEstado.jsx`, intervalo vigente) pero no exponía cuánto tiempo histórico acumulado lleva la unidad en cada uno de los 4 estados. El backend ya calculaba ese dato — `GET /api/disponibilidad/metricas` devuelve `tiempo_ms` por estado sobre toda la historia + `ahora` (reloj UTC del server con que se trunca el intervalo vigente) — pero el frontend no lo consumía; era el "cimiento del futuro dashboard" que [[D-024]] dejó listo.

**Decisión:** agregar un panel "Acumulado histórico por estado" (`AcumuladosPorEstado.jsx`) bajo `EstadoActualCard`, con 4 mini-tarjetas color-coded ([[D-024]]). Fuente: el endpoint `metricas` ya existente — **sin tocar BD, vista `v_disponibilidad_estado` ni el contrato cross-repo `disponibilidad_dashboard`**. Regla de visualización: los 3 estados no vigentes muestran su total **congelado** (`tiempo_ms[estado]`); el estado **vigente** crece en vivo en lockstep con "Tiempo en estado". Para el lockstep sin doble conteo ni salto en el borde, el frontend calcula la base cerrada `base = tiempo_ms[actual] − (ahora − fecha_inicio_estado)` (= suma de sus intervalos ya cerrados) y muestra `base + tiempoEnEstado`, reusando el **mismo** tick `Date.now()-inicio` que ya usa el contador (un solo `setInterval`, mismo reloj/skew cliente↔servidor). `getMetricas` se agrega a `useDisponibilidad`; el fetch va en paralelo con `getEstado`, se cachea por planta en el SWR del dashboard, y se refresca en el poll de 30s y tras crear/editar/deshacer.

**Consecuencias:** (a) cambio **solo frontend** — la BD, `v_disponibilidad_estado` y `disponibilidad_dashboard` quedan intactos; sin coordinación con `dashboard-gen-gec3`. (b) `formatDiff` se exporta desde `TiempoEnEstado.jsx` para reusar el formato (años/meses/d/hr/min/s). (c) Si `metricas` falla, se degrada a `null` y el panel no se renderiza — no tumba la carga del estado vigente. (d) El panel no se muestra en el empty state (planta sin vigente); extensible si se requiere. (e) Segundo endpoint por carga/poll de la planta activa (~3 round-trips), aceptable para un tool interno de pocos usuarios. (f) Suite `node:test` intacta (sin cambio de backend). Cross-ref: [[D-024]] (4 estados + cimiento de métricas), [[D-026]] (DISP en tabla dedicada + acumulados via vista).

---

## D-029 — Rol "Coordinador de carbón y maquinaria"

**Fecha:** 2026-06-20

**Contexto:** la operación necesita un cargo que coordine carbón y maquinaria con permiso de lectura y llenado de las bitácoras `Carbón y Caliza` (CYC) y `Maquinaria` (MAQU), y además pueda registrar en el módulo de Consumos de Combustible (COMB). Hasta ahora COMB solo lo llenaban `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno` ([[D-027]]), y CYC/MAQU eran exclusivas de sus operadores. El nuevo rol no cierra turno ni es solo-lectura.

**Decisión:** agregar el cargo `Coordinador de carbón y maquinaria` (`solo_lectura=0`, `puede_cerrar_turno=0`) al `MERGE` idempotente de `lov_bit.cargo` en `db.js`, y extender la matriz canónica de permisos (`cargo_bitacora_permiso`, reconstruida desde cero en cada arranque dentro de la transacción `matrizTx`) con CASE clauses que le dan `puede_ver=puede_crear=1` en `CYC` y `MAQU`, y lo suman a la lista de creadores de `COMB`. No se tocó el bloque one-shot F26.B1 de [[D-027]]: su MERGE de cargos no privilegiados solo hace `INSERT WHEN NOT MATCHED`, así que no resetea la fila que la matriz ya insertó con `puede_crear=1` para COMB. Sin cambios de frontend: el sidebar/permisos son data-driven (`/api/catalogos/permisos/:cargo_id`) y el flag `puede_cerrar_turno` se lee de `lov_bit.cargo`, desacoplado del nombre del cargo.

**Consecuencias:** (a) el rol aparece automáticamente en el selector de contexto post-login (endpoint `/api/catalogos/cargos`) sin código nuevo. (b) En cada restart la matriz se reconstruye y preserva estos permisos (no depende de seeds one-shot). (c) Sin usuarios seedeados con este cargo todavía — se asignan vía `select-context` o agregándolos a `personal-2026.json`. (d) Nuevo test de integración `server/tests/rol_coordinador_carbon_maquinaria.test.js` (matriz CYC/MAQU/COMB + negativos QUIM/MAND + POST COMB 200 + idempotencia re-initDB), registrado en `npm test`. Cross-ref: [[D-027]] (módulo COMB y matriz extendida), §2.6 BIT-MODBD (matriz canónica reconstruida por arranque).

---

## D-030 — Planta de test reservada `'TST'` para aislar los tests de DISP

**Fecha:** 2026-06-26

**Contexto:** la suite de tests apunta a la **misma BD que producción** (no hay BD de test separada). El helper `cleanDisp()` de `server/tests/disponibilidad.test.js` ejecutaba `DELETE FROM bitacora.disponibilidad_estado WHERE planta_id='GEC3'` (sin filtro de tag) en `before()`, `after()` y entre casi todos los casos — así que **cada corrida borraba la disponibilidad real de GEC3**. Etiquetar las filas de test no alcanza para DISP: el handler de producción del POST (`server.js`) hace `findVigente(planta_id)` → `cerrarVigente(...)` sobre **el vigente real de la planta** antes de insertar, y el índice único `UQ_disp_estado_vigente_por_planta` impide dos vigentes; con tests y datos reales en la misma planta, el handler corrompe el vigente real. El borrado masivo era *load-bearing* solo porque limpiaba ese vigente real de antemano.

**Decisión:** introducir una **planta sintética reservada `'TST'`** (constante `TEST_PLANTA_ID` exportada desde `db.js`) que nunca contiene datos reales. `setupSessions({ planta })` (en `tests/helpers.js`) la siembra idempotentemente en `lov_bit.planta` (`activa=1`, obligatorio porque el POST DISP y `/metricas` validan `planta_id=@p AND activa=1`) y crea las sesiones de test sobre ella; `disponibilidad.test.js` opera 100% sobre `'TST'`. Así el handler de producción y `cleanDisp` solo tocan la planta sintética — GEC3/GEC32 quedan intactas pase lo que pase. El leak cross-repo (que `'TST'` se filtre al dashboard productivo) se corta en el **único borde del contrato**: el endpoint `GET /api/eventos-dashboard` devuelve `{eventos:[]}` para `planta_id===TEST_PLANTA_ID`. **Las vistas `v_disponibilidad_estado` y `disponibilidad_dashboard` NO filtran `'TST'`** a propósito: los tests 20-23 dependen de que `v_disponibilidad_estado` compute acumulados *para la planta de prueba* (la vista es lo que se prueba); filtrarla los rompería. El dashboard no consulta esta BD directo, solo el endpoint, así que filtrar ahí es suficiente y correcto.

**Consecuencias:** (a) ninguna corrida de la suite puede destruir ni corromper disponibilidad productiva. (b) Las definiciones de las dos vistas DISP se hoistearon a consts canónicas (`SQL_VIEW_*`) usadas tanto por la migración one-shot F26.A1 como por un nuevo bloque self-heal que las re-aplica (`CREATE OR ALTER`) en cada arranque gateado por existencia de la tabla — de paso corrige un bug latente: antes un cambio de definición de vista no llegaba a una BD ya migrada sin re-migrar. (c) La fila `'TST'` queda residente en `lov_bit.planta` como fixture (análoga al usuario SISTEMA de [[D-015]]); es inofensiva porque el endpoint cross-repo la ignora y ningún consumidor la consulta. (d) COMB sigue con whitelist hardcodeada `['GEC3','GEC32']`, así que esta planta no sirve para tests de combustibles. (e) **Riesgo residual conocido (fuera de alcance):** los tests de MAND/AUTH (`sala_de_mando_batch`, `auth_middleware`, `cierre_y_fechas`, `fechas_bogota`) borran por `planta_id='GEC3'` en `registro_activo`/`registro_historico` — mismo patrón destructivo en otras bitácoras, no corregido acá. Cross-ref: [[D-026]] (DISP en tabla dedicada), [[D-015]] (usuario SISTEMA como fixture residente).

---

## D-031 — Login con Microsoft Entra ID; rol automático; dos sesiones separadas

**Fecha:** 2026-06-26

**Contexto:** el login local (usuario/contraseña scrypt, 2 pasos con selección manual de planta **y cargo**, identidad transportada en el header `X-Sesion-Id` —entero IDENTITY secuencial, exfiltrable por XSS, sin firma—) era el punto más débil del sistema (ver `docs/auditoria-auth-usuarios-roles-2026-06.md`): login y creación de sesión desacoplados, `select-context` sin verificar entitlement de cargo, password universal `'1234'`. La organización creó en Entra ID los 12 App Roles que calzan 1:1 con los 12 `lov_bit.cargo.nombre`. Se exige reemplazar el login por Entra ID, asignar el cargo automáticamente desde el claim `roles`, eliminar la pantalla de selección de cargo y blindar el modelo frente a auditoría, sin tocar el diseño del front.

**Decisión:** OIDC server-side con cliente confidencial (`@azure/msal-node`, Authorization Code + PKCE + state + nonce), montado como **wrapper Express delgado** (`server/auth/app.js`) que corre `express-session` (cookie httpOnly, store MSSQL `[auth].[AppSessions]`) y las rutas `/auth/login`, `/auth/redirect`, `/api/me`, `/api/logout`, y delega TODO lo demás al if-chain nativo (`legacyHandler`) —que sigue siendo http nativo; el "sin Express" del CLAUDE.md se revierte SOLO para el surface de auth—. `express.json()` se monta acotado a `/auth` para no romper `parseBody()`. **Identidad:** auto-aprovisionamiento por `azure_oid` (nuevas columnas `azure_oid/upn/tid` en `lov_bit.usuario`, índice único filtrado; `password_hash` nullable; `personal-2026.json`/`seedPersonal` retirados); los singletons `es_jefe_planta`/`es_jdt_default` (que NO derivan de App Roles) se fijan por UPN (`M365_JEFE_PLANTA_UPNS`/`M365_JDT_DEFAULT_UPNS`). **Rol automático:** `server/utils/entra-roles.js` mapea value→cargo y resuelve por **precedencia** cuando hay multi-rol (JdT > IngOp > IngQuímico > Coordinador > operadores > Gerente); sin rol conocido → 403. `select-context` ya no recibe `usuario_id`/`cargo_id`: deriva el usuario del oid de la cookie y el cargo del token. `loadSession` resuelve la sesión por `oid` (mismo shape de salida → permissions.js y endpoints intactos). **Dos sesiones separadas:** la cookie Entra (larga) es la identidad; `sesion_activa` es la participación en el turno y el `turno-sweeper` ahora la **expulsa** (`activa=0`) a fin de turno —la cookie sobrevive; reentrar reactiva `sesion_activa` (refrescando `inicio_sesion`+`turno`)—. Revalidación silenciosa (`revalidate.js`) detecta revocación en Entra y mata la sesión.

**Consecuencias:** (a) **Invierte la convención #1 de CLAUDE.md** ("TTL ninguno / `activa=1` hasta logout"): ahora el sweeper baja `activa=0` a fin de turno. (b) El cargo deja de elegirse en el front (pantalla eliminada) y deja de ser arbitrario: lo gobierna Entra. (c) Sin token en `sessionStorage` (XSS-resistente); PKCE/state/nonce/regeneración de sesión/cookie httpOnly+SameSite+Secure(prod). (d) Login local 100% eliminado; SISTEMA queda solo para procesos internos. (e) Rows de usuario legacy (sembrados por la versión vieja) quedan inactivables y solo los referencian registros históricos vía `creado_por`. (f) Tests: nuevo `entra_roles.test.js` (precedencia + 403); `loadSession` expone un backdoor SOLO de test (`AUTH_TEST_BYPASS=1`, resuelve por `X-Sesion-Id`) para que el harness HTTP funcione sin cookie real —jamás activo en prod—. Cross-ref: `docs/auditoria-auth-usuarios-roles-2026-06.md`, §2.3/§3 BIT-MODBD (columnas Entra + ciclo de sesión), [[D-003]] (sesión persistente, superada parcialmente), [[D-025]] (conformación de turno, intacta).

---

## D-032 — Saneamiento central de errores hacia el cliente

**Fecha:** 2026-06-26

**Contexto:** intentar un registro DISP desde una red sin ruta a la BD mostraba en el modal `Failed to connect to REDACTED in 15000ms`. El if-chain devolvía `err.message` crudo en todas las respuestas 5xx (top-level catch de `legacyHandler` + cuatro endpoints: cierre-diario, cierre masivo, conformación-trigger, y `/auth/login`). Era a la vez (a) **brecha de seguridad** —filtraba host/instancia/puerto/credenciales-shape de la BD y del flujo OIDC— y (b) **incomprensible** para un operador. Variantes del mismo patrón: respuestas que usaban el `error` como *slug* (`'sin_cargo_asignado'`) o que filtraban nombres de tabla (`'...no existe en lov_bit.cargo'`, `'Mapeo de tipos MAND incompleto en lov_bit.tipo_evento'`), y el frontend que mostraba el `TypeError: Failed to fetch` crudo cuando el backend está caído.

**Decisión:** módulo `server/utils/errores.js` con `clasificarError(err) → {status, codigo}` y `responderError(res, err, ctx)`: clasifica el error técnico (conexión BD caída → 503 `db_no_disponible`; timeout de request → 503 `db_timeout`; SQL/constraint → 500 `db_error`; body no-JSON → 400 `cuerpo_invalido`; desconocido → 500 `error_interno`), **loguea el detalle crudo server-side** y responde `{ error, codigo, mensaje }` donde `error`/`mensaje` son texto amigable en español y `codigo` es un slug estable. El top-level catch y los cuatro endpoints usan `responderError`/`mensajeUsuario`; los slugs/tablas filtrados se reemplazaron por texto amigable + `codigo` (`sin_cargo_asignado`, `config_sistema`, `sin_jefe_planta`). Frontend: `useApi`/`useDisponibilidad` traducen el rechazo de `fetch` (servidor inalcanzable) a un Error con `codigo:'sin_conexion'` + `body.mensaje` amigable, y propagan `codigo`/`body` del backend.

**Consecuencias:** (a) **Shape de error ampliado**: toda respuesta de error puede traer `codigo` (estable, machine-readable) además de `error`/`mensaje` (humano) — el frontend ramifica por `codigo`, nunca parseando texto. (b) Los 409 de DISP (`mismo_estado`/`fecha_anterior_a_vigente`/`mismo_estado_que_anterior`) **no cambian**: siguen exponiendo su `error`-slug + `vigente`/`n_menos_1` porque `CambiarEstadoModal.buildPopup` los usa para popups específicos; el saneamiento solo toca los caminos inesperados/5xx. (c) `'No hay jefe de planta activo'` pasó de 500 a 409 (es una precondición, no un bug del server). (d) Test sin BD `server/tests/errores.test.js` fija que ningún mensaje al usuario filtre host/instancia/constraint. Cross-ref: convención #16 de CLAUDE.md.

---

## D-033 — COMB: rediseño visual "Blueprint Heatmap"

**Fecha:** 2026-06-29

**Contexto:** la grilla de Consumos de Combustibles (COMB, D-027) usaba estilos Tailwind genéricos (`bg-yellow-50`, `bg-emerald-600`). Existía una propuesta de diseño aprobada — "Blueprint Heatmap", plano técnico azul con heatmap por celda en columnas de alimentador — en `ConsumosGridBlueprint.jsx` (raíz del repo), referencia que NO era producción: catálogo mock, `seedBuffer()`, `loading=false` hardcodeado, `hayCambios` simplificado con `Object.keys`, fechas reimplementadas y fuentes por CDN. La meta era adoptar **solo la piel** sobre el componente real, sin tocar lógica (datos, hook, diff, validaciones, TZ, batch save, errores, permisos, estados), igual que el rediseño previo de DISP.

**Decisión:** restilizado solo-frontend de `src/components/Combustibles/`. (1) **Aislamiento como DISP**: CSS scopeado bajo `.comb-root` (`combustibles.css`, variables en `.comb-root` no `:root`, clases prefijadas) → cero fuga a otras bitácoras; el único estilo inline es el `background` dinámico del tinte por celda. (2) **Fuentes locales** vía `@fontsource/archivo` + `@fontsource/inter` + `@fontsource/jetbrains-mono` importadas en el componente raíz — **sin CDN en runtime**. (3) **Escala heatmap FIJA `HEATMAP_MAX_TON=25`** (tope físico de carga de carbón por alimentador/periodo; reemplaza el mágico `42` del mock) → tonos comparables día a día. Heatmap aplicado **solo a columnas `tipo='ALIMENTADOR'`**. (4) **Leyenda ↔ tinte reconciliados**: una sola rampa `HEATMAP_RAMP` (en `colores.js`) alimenta `tint()` y los chips de la leyenda (el blueprint las tenía desincronizadas). Toda la lógica (snapshot/buffer, `hayCambios` por diff real `JSON.stringify`, `calcularDiff`, `onGuardar` con `e.errores[].motivo`, `totalCarbonPeriodo`, `beforeunload`, gateo `puedeCrear`, `SelectorFecha` con bloqueo de futuro) quedó intacta.

**Consecuencias:** (a) cambio **solo-frontend** — BD, endpoint (`/api/combustibles/*`) y hook (`useCombustibles`) sin tocar; los tests `server/tests/consumos_combustible.test.js` no se ven afectados. (b) 3 dependencias nuevas de fuente (`@fontsource/*`); Vite las bundlea como assets locales en `dist/`. (c) `ConsumosGridBlueprint.jsx` borrado tras servir de referencia (regla 13 de CLAUDE.md; recuperable por git). (d) Patrón replicable: futuras bitácoras con grilla pueden reusar el scoping `.comb-root` + `@fontsource` local + rampa única para heatmap.

---

## D-034 — COMB: límites físicos por combustible (data-driven)

**Fecha:** 2026-06-29

**Contexto:** el POST de Consumos (D-027) solo validaba `cantidad ≥ 0` y finita (`cantidad_invalida`); no había tope superior, así que se podían registrar valores físicamente imposibles. Cada combustible tiene un límite real por celda/periodo: ALIMENTADOR (carbón) 0–25 Ton, CALIZA 0–40 Ton, ACPM (FO líquido) 0–25000 Gal.

**Decisión:** límite **data-driven** en BD como fuente única. Migración idempotente `F28.A1` (`server/db.js`, flag en `bitacora.migracion_aplicada`, patrón F26.B1/F27.A1): `ALTER lov_bit.combustible ADD cantidad_max DECIMAL(12,3) NULL` + `UPDATE ... SET cantidad_max = CASE tipo WHEN 'ALIMENTADOR' THEN 25 WHEN 'CALIZA' THEN 40 WHEN 'ACPM' THEN 25000 END WHERE cantidad_max IS NULL`. `cantidad_max NULL = sin tope` (el server omite el chequeo) para no romper combustibles futuros. **Backend:** los GET `/catalogo` y `/consumos` exponen `cantidad_max`; el POST valida por celda `cantidad > cantidad_max` → `400 { errores:[{ periodo, combustible_id, motivo:'cantidad_excede_max' }] }` (boundary inclusivo, `=max` permitido), acumulado en el mismo array de errores existente. **Frontend (`ConsumosGrid.jsx`):** la celda fuera de rango se marca en rojo (`.comb-cell.invalid`), Guardar se deshabilita mientras haya inválidas y se muestra un mensaje (`.comb-alert`); NO se recorta ni borra lo escrito. El heatmap pasa a escalar desde `cantidad_max` del alimentador (`tint(v, maxAlim)`), eliminando el `25` hardcodeado. Diccionario `motivo→texto` es-CO para los toasts.

**Consecuencias:** (a) doble barrera (front bloquea Guardar, back rechaza). (b) Para cambiar un tope o agregar un combustible con límite: editar el `UPDATE`/seed de la migración (o un bloque nuevo) + redeploy — no hay CRUD admin. (c) Tests `13–15` en `consumos_combustible.test.js` (catálogo expone `cantidad_max`; rechazo por tipo; boundary exacto). (d) Cross-ref: convención #17 de CLAUDE.md, BIT-MODBD §4.9.

**Próxima fase (plasmado, NO implementado aún):**
1. **Tope agregado de Total Carbón por periodo y planta** — columna `carbon_max_periodo_ton` en `lov_bit.planta` (GEC3=150 UG3.0 / GEC32=200 UG3.2), validado en el POST (motivo `total_carbon_excede_max`, error a nivel periodo) y marcado en la columna virtual "Total Carbón" del front. Hoy es redundante con el per-celda (6×25=150, 8×25=200) pero es el límite físico de la **caldera**, atado a la unidad y no al conteo de alimentadores.
2. **Editabilidad de alimentadores según la unidad del login** — según la unidad (GEC3 = 6 alimentadores de carbón / GEC32 = 8), bloquear en front y back qué alimentadores pueden recibir ingesta/edición (algunos pueden estar fuera de servicio). Bloqueos en ambos lados.

---

## D-035 — Routing por hash (deep-link/F5) + botón "Cambiar unidad"

**Fecha:** 2026-06-29

**Contexto:** la sección activa del dashboard (`activeBitacora`) era estado local de React: un F5 o un deep-link volvían siempre a la primera bitácora permitida, y el subestado de las secciones con UI propia (planta de DISP, fecha de COMB) se perdía. DISP además persistía su planta en `sessionStorage` (`disponibilidad.plantaSeleccionada`), una segunda fuente de verdad. En paralelo, el modal de logout ofrecía "No, salir sin finalizar" (cleanup de cliente que conserva la cookie Entra), pero no había forma de **cambiar de unidad** (GEC3↔GEC32) sin re-loguearse.

**Decisión:** (1) **Capa de rutas por hash, sin dependencia nueva** (NO react-router). Módulo puro `src/routing/appRoute.js` (`parseHash`/`buildHash` + validadores) con forma canónica `#/op24h` (MAND), `#/disp?planta=GEC3|GEC32`, `#/comb?fecha=YYYY-MM-DD`, `#/b/<codigo>` (genéricas), `#/historicos`; vacío/desconocido/no-permitido → fallback a la primera permitida. Hook `src/hooks/useAppRoute.js` (lee el hash, se suscribe a `hashchange`+`popstate`, expone `navigate(next,{replace})` con guarda anti-loop). El hash es la **fuente única de verdad**: el dashboard deriva su estado desde la ruta (permission-gated) y escribe la ruta ante cambios (subestado → `replaceState`, cambio de sección → `pushState`). Validación estricta de params: planta ∈ {GEC3,GEC32}; fecha bien formada y no futura (paridad con el `400 fecha_futura` de COMB) — param inválido se descarta. Se eligió el hash porque: 0 deps, deep-linkable, back/forward del navegador, y **no colisiona con el redirect OIDC** (el `#` no viaja al server ni choca con `?auth=…`; Entra sigue aterrizando en `/`). (2) **DISP y COMB pasan a controlados** por el dashboard (`planta`/`onPlantaChange`, `fecha`/`onFechaChange`); **se retira el `sessionStorage` de planta de DISP** para no tener doble fuente. (3) **"Operar otra unidad"** (originalmente "Cambiar unidad") reemplaza a "salir sin finalizar" en el modal de logout: conserva el login Entra pero **mata la sesión de app** server-side — `auth.clearSesion()` limpia el estado de cliente y dispara `POST /api/auth/cerrar-app` (`activa=0`, sin tocar la cookie Entra), y el render cae en `LoginScreen` paso "planta". Al re-elegir unidad, `select-context` reactiva/crea la sesión de la nueva unidad **y desactiva cualquier otra sesión activa del usuario** (invariante: una persona no puede estar iniciada en 2 unidades a la vez). *(Refinado el 2026-06-30: la versión original era solo-cliente y dejaba la sesión anterior `activa=1`, produciendo 2 sesiones activas por persona; se corrigió añadiendo el endpoint de cierre + el barrido en `select-context`.)*

**Consecuencias:** (a) el routing es **solo-frontend** (sin backend ni contrato cross-repo; tests de combustibles verdes); la corrección de sesión única (2026-06-30) sí toca backend: nuevo `POST /api/auth/cerrar-app` + barrido en `select-context` (ver decisión 3). (b) F5 y deep-link preservan sección + subestado; back/forward navega. (c) Sincronización ruta↔estado con dos efectos guardados por refs de igualdad (el "derive" no depende de `activeBitacora` para no revertir un clic; el "write" no escribe sin sesión → el routing solo vive en el dashboard). (d) "Cambiar unidad" descarta buffers no guardados del cliente sin aviso cross-componente — consistente con la navegación SPA de hoy (no hay reload, `beforeunload` no aplica). (e) Tests `src/routing/appRoute.test.js` (round-trip parse/build, validación de planta/fecha, fallback). (f) Cross-ref: convención de navegación en CLAUDE.md.

**Addendum (2026-06-30) — Rediseño del modal de logout.** El logout dejó de usar el `ConfirmModal` genérico (botones apiñados en multifila) y pasó a un componente dedicado `src/components/LogoutModal.jsx`: más ancho/alto (`max-w-lg`), ilustración hero (`public/logout-ilustracion.png` — mujer abriendo la puerta + gato saliendo + planta) y los **botones en una sola fila** (`Cancelar` | `Sí, finalizar y salir`). "Operar otra unidad" se reubica como **enlace inline** dentro del texto (paridad estructural con el patrón "switch account"), con su acción `auth.clearSesion()` (que ahora además mata la sesión de app, ver decisión 3). El `ConfirmModal` genérico queda intacto para el resto de confirmaciones; el estado de logout vive en `logoutOpen` (separado de `modal`). Copy en es-CO: "Si solo necesitas **operar otra unidad**, puedes cambiarla sin cerrar sesión" (enlace en "operar otra unidad"; *unidad* ≠ *planta* en el dominio).

---

## D-036 — Ronda de remediación de seguridad (auditoría BIT-AUDSEG-2026-001)

**Fecha:** 2026-06-30

**Contexto:** una auditoría estricta de principio a fin (`BIT-AUDSEG-2026-001.md`, 42 hallazgos AUD-01..42 en 7 olas) detectó vulnerabilidades de seguridad y deuda de arquitectura. Se ejecutó un pipeline de remediación en la rama `sec/audseg-remediation`, ítem por ítem con contexto aislado por subagente, verificación con tests y commit por hallazgo.

**Decisión:** resolver por orden de prioridad+dependencias, con tres clases de cierre: ✅ resuelto en código+test; 🟡 parcial (la parte de código hecha + un runbook para la acción de infra/ops o cross-repo que el pipeline no puede/debe hacer solo); ⬜ diferido (refactor arquitectónico grande que no se hace a ciegas sin la suite plena). Cambios clave:
- **Auth/identidad:** sesión exigida en 8 endpoints que la omitían (AUD-05); backdoor de test fail-closed en prod (AUD-06); cookie `Secure` forzada + `SESSION_SECRET` obligatorio + validación `tid`/`nonce` (AUD-09/22); revalidación de privilegios efectiva que re-deriva el cargo y mata la sesión ante downgrade (AUD-10); scope de planta en DISP (AUD-11).
- **Transporte/datos:** cifrado SQL env-driven con default no-rompedor (AUD-07, encender = infra/cert); rate-limit + tope de body + CORS allowlist + Origin-check anti-CSRF (AUD-15/16/19/20); `campos_extra` sin mass-assignment (AUD-39).
- **Scraper SIS/WS:** parser BIFF8 endurecido contra `.xls` maliciosos (ciclos/sectorSize/topes) cortando el DoS del backend (AUD-08); validación de rango de datos SIS (AUD-14); handshake WS con validación de `Origin` anti-CSWSH + snapshot por planta (AUD-21/42); SSRF allowlist + escape XML (AUD-25/26).
- **Robustez BD:** `HOLDLOCK` en el MERGE de provisión, `XACT_ABORT`/transacción en `enforceSingletonFlag`, guards por datos antes de borrados destructivos (AUD-29/30/31).
- **Higiene:** secretos/PII/screenshot sacados del árbol + `dist` untrackeado (AUD-01/02/03/04, con runbook de rotación de clave + purga de historial como acción humana); `ws` 8.18→8.21 (CVE) y `engines` (AUD-37); drift de docs (AUD-38).

**Consecuencias:** (a) **24 hallazgos ✅** (código+test verde), **7 🟡** (con runbook: rotación/purga de historial AUD-01, cert TLS AUD-07, cifrado-at-rest de sesión AUD-13, token cross-repo AUD-18, split de logins BD AUD-12, worker/canal del scraper AUD-08, cookie-handshake WS AUD-21), **3 ⬜** diferidos (BD de test dedicada AUD-33 —login sin `dbcreator`—, split de `server.js` AUD-34, unificación de routing AUD-35). (b) **8 suites de tests puros nuevas, 51+ casos verde**, sin tocar la BD productiva; la verificación HTTP plena queda atada a AUD-33 (BD de test dedicada). (c) Se introdujeron varias env de seguridad: `DB_ENCRYPT`/`DB_TRUST_SERVER_CERT`, `CORS_ALLOWED_ORIGINS`, `WS_ALLOWED_ORIGINS`, `DASHBOARD_API_TOKEN`, `TEST_DB_DEDICATED`, `REVALIDATE_MAX_FALLOS` (todas con default no-rompedor). (d) El tablero vivo y el detalle por ítem están en `BIT-AUDSEG-2026-001.md` y `prompts/AUDSEG-PIPELINE/ESTADO.md`. Cross-ref: [[D-031]] (auth Entra), [[D-032]] (saneo de errores), [[D-030]] (planta TST).

## D-037 — Routing unificado en Express + `server.js` modularizado (AUD-34/35)

**Fecha:** 2026-07-01

**Contexto:** cierre de los dos ítems de arquitectura que D-036 dejó ⬜ diferidos. `server/server.js` era un monolito (~2849 líneas): un único if-chain (`legacyHandler`) con ~43 endpoints, cada uno repitiendo a mano `loadSession` + `parseBody` + checks de permiso/planta (AUD-34). Tras D-031 convivían **dos modelos de routing** — el wrapper Express delgado solo para `/auth` y el if-chain nativo para el resto — con dos body parsers (`express.json` acotado vs. `parseBody` crudo) y dos posturas de middleware (AUD-35). El god-file era la **causa estructural** de que la autenticación fuera opt-in y fácil de olvidar (raíz de AUD-05).

**Decisión:** **un solo modelo = Express.** Migración strangler por dominio (E1–E10): cada familia de endpoints se extrajo a `server/routes/<dominio>.js` (catálogos, cierre, históricos, autorizaciones, eventos-dashboard, conformación, combustibles, disponibilidad, MAND, registros —con la rama DISP inline, D-026—, bitácora y contexto de sesión), montada en `auth/app.js` **antes** del catch-all; sus rutas se borraban del if-chain en el mismo commit. Piezas clave:
- **Auth-por-defecto (fix estructural de AUD-05):** middleware global `requireEntra` (`routes/_middleware.js`) cierra el acceso anónimo salvo una **allowlist pública explícita** (`/health`, catálogos no-PII, `eventos-dashboard`); honra el backdoor de test (`AUTH_TEST_BYPASS` + `X-Sesion-Id`, fail-closed); si no, exige identidad Entra (`req.session.user.oid`) → 401. Un endpoint nuevo nace cerrado.
- **Pipeline único:** `session → cors → csrf → /health → auth (login/redirect/me/logout) → requireEntra → express.json (global, 1 MB) → routers de dominio → 404 → expressErrorHandler`. CORS/preflight y CSRF de mutadores pasaron de ramas del if-chain a middleware Express global (`corsMiddleware`/`csrfMiddleware`).
- **Body parsing unificado:** durante la migración `express.json` se montó **por router** (para no consumir el stream de las rutas aún en el if-chain con `parseBody`); en E11 se **hoistó a global** post-auth y se **eliminó `parseBody`** (su tope AUD-15 lo enforcea `express.json({ limit: '1mb' })` → 413 vía `clasificarError` con `type:'entity.too.large'`). `legacyHandler` se borró; `server.js` quedó en **bootstrap** (initDB → buildAuthApp → http.Server para los WS → sweepers → listen), ~73 líneas.
- **Middleware reutilizable:** `loadAppSession` (setea `req.sesion` o 401) reemplaza el idiom `loadSession` repetido ~34 veces; `asyncH` enruta el throw de un handler async a `expressErrorHandler`.

**Consecuencias:** (a) `server.js` 2849 → ~73 líneas; 13 routers nuevos + `_middleware.js`/`_shared.js`; `routes/.gitkeep` borrado. (b) Autenticación **cerrada por defecto** (no más opt-in). (c) **Verificación "proceder ahora"** (decisión del usuario, sin bloquear en AUD-33): por etapa `node --check` + tests puros (`routes_middleware`, `errores`, `http_hardening`, …) + smoke autenticado en `:3099` contra la planta `'TST'` (D-030) sin tocar `:3002` ni datos reales. **La suite HTTP completa (`server npm test`) sigue diferida a la BD de test dedicada (AUD-33)** — riesgo aceptado y documentado. (d) `parseBody`/`MAX_BODY_BYTES` eliminados de `utils/http.js` (`sendJSON` permanece). Cross-ref: [[D-031]] (wrapper Express /auth de origen), [[D-032]] (saneo de errores/`expressErrorHandler`), [[D-036]] (ronda que difirió AUD-34/35), [[D-026]] (rama DISP migrada dentro de registros).

---

## D-038 — Despliegue bajo sub-path `/bitacora` en el reverse proxy compartido (pgen.gecelca.com.co)

**Fecha:** 2026-07-01

**Contexto:** Bitácora comparte servidor Ubuntu y nginx con `dashboard-gen-gec3` bajo un solo
dominio (`pgen.gecelca.com.co`), separados por ruta (`/bitacora` con auth, `/dashboard` sin auth) —
contrato en `../docs/deployment-unificado.md`. El backend compara `req.url` por string exacto y la
cookie de sesión es `Secure` (OIDC exige HTTPS), así que el prefijo no puede llegar al backend ni
la app puede asumir la raíz del dominio.

**Decisión:** el sub-path es **configurable por env `APP_BASE_PATH`** (`/bitacora` en prod, vacío
= `/` en dev) y se aplica en tres capas: (a) **build** — `vite.config.js` lo usa como `base` y
`src/config/paths.js` centraliza `withBase`/`wsUrl`/`asset` sobre `import.meta.env.BASE_URL`
(ningún literal `/api`, `/ws`, ni `src="/img"` en el código; `asset()` existe porque Vite NO
reescribe string literals de JSX con el `base`); (b) **backend** — `entra-config.js` exporta
`APP_BASE_PATH` para los redirects post-OIDC (`home()`) y el `path` de la cookie
(`bitacora.sid` acotada a `path=/bitacora`); (c) **nginx** — `deploy/nginx-bitacora.conf` quita el
prefijo (barra final en `proxy_pass`) y reenvía `Host`/`Origin`/`X-Forwarded-Proto` (CSRF/CSWSH +
cookie Secure tras proxy; `trust proxy=1`). TLS con **certificado corporativo** (renovación
manual, runbook `deploy/DEPLOY.md §6`). Fallback SPA con named location (pitfall
`alias`+`try_files`).

**Consecuencias:** (a) un solo build sirve cualquier base; dev queda intacto (base `/`, proxies
Vite sin strip). (b) Azure App Registration necesita los Redirect URIs con el sub-path
(`https://pgen.gecelca.com.co/bitacora/auth/redirect`). (c) El deploy es por runbook
(`deploy/DEPLOY.md`, systemd `bitacora-api.service`, locations pegadas en el server block del
dashboard). (d) La cookie no viaja a `/dashboard` (aislamiento entre apps). Cross-ref: [[D-031]]
(OIDC), [[D-036]]/[[D-037]] (hardening del pipeline que este despliegue expone).

---

## D-039 — Rol ADMIN (`Administrador y Debugging`) con acceso total, data-driven

**Fecha:** 2026-07-03

**Contexto:** se necesitaba un rol de administrador/debugging para pruebas funcionales que pudiera **ver, crear, editar y borrar en todo lo que la app permite**, y quedar **blindado ante auditoría**. En Entra se creó el grupo de seguridad `AMINISTRADOR_DEBUGGING` (`dfc61859-cef1-45f9-8b89-8b4658bbf56f`). El control de acceso de Bitácora es 100% data-driven (App Role → `ROLE_TO_CARGO` → `lov_bit.cargo` → matriz `cargo_bitacora_permiso` + flags `puede_cerrar_turno`/`solo_lectura`), sin superusuarios por código.

**Decisión:** modelar el admin como **un cargo real más** — NO un bypass. Cambios:
- **Entra:** un App Role con `value = ADMINISTRADOR_DEBUGGING` (el grupo se asigna a ese App Role; "Assignment required = Yes" sigue siendo el gate de acceso). El claim `roles` transporta ese `value`, no el id del grupo.
- **`entra-roles.js`:** `ROLE_TO_CARGO['ADMINISTRADOR_DEBUGGING'] = 'Administrador y Debugging'` y **primero** en `PRECEDENCE` (gana en multi-rol).
- **`db.js`:** cargo sembrado con `solo_lectura=0`, `puede_cerrar_turno=1`; en la matriz (`WITH matriz AS`) una cláusula `WHEN c.nombre='Administrador y Debugging' THEN 1` como **primer WHEN** de `puede_ver` y `puede_crear` (gana sobre las de código). **Gotcha:** el override defensivo DISP (F12.A6) recomputa `puede_crear` de toda fila DISP, así que el admin también se agregó a ese `IN (...)` o quedaría en 0 en DISP.
- **Sin cambios de frontend:** el sidebar filtra por `puede_ver`, los botones por `puede_crear`, y cerrar turno / conformación por `sesion.puede_cerrar_turno` — todo se activa solo con los datos del nuevo cargo.

**Consecuencias:** (a) toda acción del admin pasa por los MISMOS gates (auth/CSRF/rate-limit/permiso) y queda **atribuida** (`creado_por`/`modificado_por`) — auditable, cero código de bypass. (b) El admin obtiene el **máximo borrado que la app ya soporta** (borradores, soft-deletes de eventos, celdas de MAND/COMB, cierre); **NO se añadió hard-delete de registros cerrados/históricos** — la app es append-only por diseño de auditoría y romper eso contradiría el requisito. (c) La bitácora `AUTH` (`activa=0`) queda fuera para todos, incluido admin (esperado). (d) Los singletons `es_jefe_planta`/`es_jdt_default` NO se tocan (son identidad por-UPN para snapshots, no gates; `puede_cerrar_turno` ya cubre lo que habilitan). (e) Tests: `entra_roles.test.js` (13 roles + precedencia admin) y `rol_admin_debugging.test.js` (matriz completa + regresión override DISP + idempotencia). Verificado end-to-end vía backdoor de test: crear (201) y borrar (200) en QUIM, bitácora ajena a operadores. Cross-ref: [[D-031]] (login Entra / rol automático), [[D-029]] (patrón de rol nuevo en matriz), [[D-037]] (auth-por-defecto).

---

## D-040 — Finalizar turno revertible (fuente única `sesion_activa.turno_finalizado_en`) + write-gate genérico

**Fecha:** 2026-07-03

**Contexto:** la finalización de turno estaba **sobrecargada** sobre `sesion_bitacora.finalizada_en`, que mezclaba dos cosas: *presencia por-bitácora* y *decisión de "terminé mi turno"*. Como `POST /api/bitacora/abrir` (disparado por `useBitacoraSesion` en CADA apertura/cambio de bitácora) hacía `MERGE ... UPDATE SET finalizada_en = NULL`, **con solo ver una bitácora el ingeniero se des-finalizaba** y reaparecía como pendiente en el cierre del JdT. Además el estado de finalización del front salía 100% de `localStorage`/`shiftInstanceId` (divergía del backend tras F5 y tras el reset de `/abrir`), no había forma de **revertir**, y finalizar no inhibía registrar.

**Decisión:** la finalización de turno pasa a **`sesion_activa.turno_finalizado_en DATETIME2 NULL`** (fuente única; NULL = turno vivo, no-NULL = finalizado). `sesion_bitacora.finalizada_en` vuelve a ser **SOLO presencia por-bitácora** (nunca reusar uno por el otro). Es **revertible self-service** vía **`POST /api/bitacora/revertir-turno`** (sin permiso especial, CIET `reapertura`). `POST /api/bitacora/finalizar` y `finalizar-forzado` setean la columna (CIET idempotente, solo si cambió). El fix del bug: `ingenieros_no_finalizados` filtra por `sa.turno_finalizado_en IS NULL` (ya no lee `sesion_bitacora`), conservando `bitacoras_abiertas` vía `OUTER APPLY`. **Write-gate 409 `turno_finalizado` solo en la rama GENÉRICA de `registros.js`** (POST/PUT/DELETE); MAND/DISP/COMB quedan operables (endpoints propios). El front deriva `turnoFinalizado` de `sesion.turno_finalizado_en` (se eliminó `localStorage`/`shiftInstanceId`/tick), refleja finalizar/revertir con `useAuth.patchSesion` y rehidrata por `/api/me`; el botón togglea a "Revertir finalización" + banner, y el gate de UI se acota a "Nuevo Registro" + `GrillaRegistros`.

**Consecuencias:** (a) el estado **muere solo**: el turno-sweeper expulsa `activa=0` a fin de turno y `select-context` reactiva/crea sesión fresca con la columna en NULL (reset explícito en la rama de reactivación — sin él, volver por "Operar otra unidad" a la misma planta dejaba el turno "finalizado", bug simétrico). (b) Revertir tras ser **forzado** es posible y NO traba el cierre del JdT (que opera sobre `registro_activo`, no sobre esta columna). (c) MAND/DISP/COMB no se bloquean, alineado front↔back. (d) Idempotencia: doble finalizar / doble revertir no duplican CIET (guardas `IS NULL`/`IS NOT NULL` + CIET solo si hubo fila). (e) Se sembró el tipo CIET `'Reapertura de turno'`. (f) Tests: `finalizar_turno.test.js` (11, incl. la regresión del bug: finalizar → `/abrir` → sigue finalizado y no reaparece en `preview-masivo`); suite canónica **218/217✔/1skip**. Cross-ref: [[D-031]] (sesión de app / sweeper / `select-context`), [[D-035]] (sesión única por persona / "Operar otra unidad"), [[D-032]] (shape `{error,codigo,mensaje}` del 409), [[D-037]] (auth-por-defecto + routers), [[D-030]] (tests planta `TST`).

**Addendum 2026-07-03 — blindaje del gate de UI (paridad total front↔back):** el gate de UI original solo ocultaba "Nuevo Registro"; el **row-level** de `GrillaRegistros` quedaba abierto (`puedeEditar` miraba solo `estado==='borrador'`, ignoraba `turnoFinalizado`). Efecto: con el turno finalizado la grilla se veía editable — Editar/Eliminar seguían pintados y clicables. El backend bloqueaba PUT/DELETE de registros persistidos (409), pero el **descarte de un borrador local NUEVO** (sin `registro_id`) es front-only (no pega al backend) → se podía "eliminar" con la X aun finalizado; y entrar en modo edición de borradores guardados confundía al usuario aunque el guardado 409-eara. Además **`handleFinalizarTurno` no verificaba borradores sin guardar** → se podía finalizar con un borrador abierto, que quedaba atrapado (ni se guarda ni se descarta tras el bloqueo). Fixes (solo-front, salvo tests): (1) **guard al finalizar** — si `registrosDeBitacora.some(r => r._dirty)` (draftLocal nuevo **o** edición en curso de un registro existente; solo la bitácora activa puede tener estado sucio), se bloquea con popup "Hay un registro borrador sin guardar. Guárdalo o descártalo antes de finalizar el turno." (2) **`bloqueado` prop** propagado a `GrillaRegistros`→`RegistroRow`: pone TODA la grilla en solo-lectura — `isEditing`/`puedeEditar` llevan `!bloqueado`, `onStartEdit` es no-op, `editingId` se resetea vía efecto (no reabre al revertir), y cada fila muestra un chip "Bloqueado" (Lock) en vez de acciones; los datos siguen visibles en modo lectura. Backend intacto (ya estaba blindado); se **añadieron tests de gate PUT y DELETE** (`4a2`/`4a3`, antes solo POST tenía cobertura) → `finalizar_turno.test.js` 13/13✔. Flujo garantizado: **guardar todo → finalizar → solo lectura (sin editar/borrar/crear)**, revertible.

**Addendum 2026-07-03 (2) — persistencia por VENTANA de turno:** la finalización debe mantenerse hasta que empiece el siguiente turno o el usuario la revierta. No se cumplía: el re-ingreso SIEMPRE pasa por `select-context`, cuya rama de reactivación ejecutaba **incondicionalmente** `turno_finalizado_en = NULL` (`sesion.js:106`) — no condicionado a que el turno cambiara. Logout→login misma unidad y "Operar otra unidad"→volver **reabrían** el turno dentro del MISMO turno (logout/`cerrar-app`/sweeper preservan el flag; solo `select-context` lo borraba). **Decisión:** acotar la finalización a la **ventana `[inicio, fin)` del turno actual** reutilizando `ventanaTurno()` — el timestamp ya codifica *cuándo* se finalizó, así que está **vigente** solo si cae en la ventana del turno de "ahora". Helper puro `finalizacionVigente(finalizadoEn, ahora)` en `utils/turno.js` (fuente única). Cambios: (1) `select-context` reemplaza el reset por un **CASE acotado a la ventana** (preserva si misma ventana → re-login / volver a la unidad; limpia si turno pasado → siguiente turno). (2) Guards de `/finalizar`·`/finalizar-forzado` (`IS NULL OR fuera-de-ventana`) y `/revertir-turno` (`dentro-de-ventana`) — idempotencia intacta. (3) `permissions.turnoFinalizado` y `loadSession` (serving a `/api/me`) son **window-aware** → el write-gate y el front ven el valor EFECTIVO sin lógica de TZ en el cliente. **Alcance: por unidad** (confirmado) — sale natural porque `turno_finalizado_en` vive en la fila `sesion_activa` de cada `(usuario, planta, cargo)`; cambiar de unidad muestra la otra abierta y volver a la original la muestra finalizada. Frontend **sin cambios** (ya deriva de `sesion.turno_finalizado_en`). Edge aceptado: app abierta cruzando el borde de turno muestra "finalizado" hasta el próximo `/api/me`/re-login forzado por el sweeper. Tests: `turno_vigencia.test.js` (7 unit, incl. cruce de medianoche T2 y bordes) + `finalizar_turno.test.js` `4f` (finalización de turno pasado NO bloquea) y `7` (reactivación preserva vigente / limpia stale). Cross-ref: [[D-035]], [[D-031]].

---

## D-041 — Vistas dashboard/reporting = SOLO LECTURA (fix "GEC3 sin disponibilidad tras tests" + blindaje anti-destrucción en prod)

**Fecha:** 2026-07-03

**Contexto:** la suite corre contra la BD **productiva** (D-030). Reportado (dos veces): tras correr los tests, **GEC3 quedaba sin estado de disponibilidad vigente** ("Sin estado registrado" en el dashboard). Causa raíz encontrada por auditoría: `bitacora.disponibilidad_dashboard` es una **VISTA actualizable de una sola tabla** (`SELECT … FROM disponibilidad_estado WHERE fecha_fin_estado IS NULL`, sin agregación ni `INSTEAD OF`). En SQL Server, `DELETE`/`UPDATE` a través de una vista así **cascada silenciosamente a la tabla base**. `cierre_y_fechas.test.js` corría con `setupSessions()` en la planta **default GEC3** y su `cleanAll()` (en `before` **y** `after`) ejecutaba `DELETE FROM bitacora.disponibilidad_dashboard WHERE planta_id='GEC3'` → borraba el **vigente real de GEC3** en cada corrida (además el test ni siquiera escribe DISP — daño colateral puro). Vectores gemelos: `auth_middleware.test.js` (mismo DELETE-por-vista, ya en TEST_PLANTA → inocuo), `reset-db.js` (utilitario manual, DELETE-por-vista en GEC3 con join roto `registro_activo_id`=`disponibilidad_id` de distinto id-space), y `cleanupTestRegistros` que borraba `disponibilidad_estado` por tag **sin acotar planta** (amplificador).

**Decisión:** las vistas de reporte son **de solo lectura**, con defensa en profundidad en cuatro capas: (1) **Backstop en BD (blindaje real):** trigger `INSTEAD OF INSERT,UPDATE,DELETE` con `THROW 50041` en `disponibilidad_dashboard`, `autorizacion_dashboard` y `v_disponibilidad_estado` (idempotente en `initDB`, `CREATE OR ALTER`, gateado por existencia de la vista). Cualquier escritura por la vista —test, app o SSMS manual— ahora **falla ruidosamente**; los `SELECT` no se afectan. La app siempre escribe la tabla base (`notificador.js`), nunca la vista (verificado). (2) **Fix del test:** `cierre_y_fechas.test.js` migrado a `TEST_PLANTA` y su `cleanAll` ya no toca `disponibilidad_estado` (no la escribe). (3) **Cleanup blindado:** `cleanupTestRegistros` borra DISP acotado a `TEST_PLANTA` (no por tag global) y escribe la base `evento_dashboard` (no la vista `autorizacion_dashboard`); nuevo helper `cleanDispTestPlanta()` (hard-coded a la planta de test, sin parámetro → imposible pasar GEC3/GEC32). `reset-db.js` reescrito a `disponibilidad_estado` por `TEST_PLANTA`. (4) **Guardrail estático en CI:** `guard_no_prod_disp_destruction.test.js` escanea el fuente de los tests (comentarios stripped) y **falla** ante (A) cualquier DML por una vista dashboard, o (B) un `DELETE/UPDATE` de `disponibilidad_estado` con literal de planta real.

**Consecuencias:** (a) **Reparación de datos:** se reabrió el último estado de GEC3 (`disponibilidad_id=475`, "En Reserva", `fecha_fin_estado=NULL`) restaurando su vigente; GEC32 estaba intacto. (b) Correr la suite ya no puede dejar una planta real sin disponibilidad (verificado: GEC3/GEC32 conservan su vigente tras la corrida). (c) La invariante "vistas dashboard = solo lectura" queda enforced a nivel BD, no solo por convención. (d) Deuda relacionada de D-030 (tests MAND/cierre que aún escriben `registro_activo` en GEC3 por tag) sigue pendiente pero **no** causa pérdida de disponibilidad (registros, no DISP); el guardrail no la cubre (fuera de alcance de este fix). Cross-ref: [[D-030]] (planta `TST` / suite sobre prod), [[D-026]] (DISP en `disponibilidad_estado` + vistas derivadas), [[D-020]] (TZ).

---

## D-042 — Eliminación del cierre individual de bitácora (cierre de turno = único cierre)

**Fecha:** 2026-07-03

**Contexto:** existían dos formas de cerrar registros al histórico: (a) **cierre individual** por bitácora (`POST /api/cierre/bitacora`, botón "Cerrar Turno" por pestaña) y (b) **cierre de turno masivo** (`POST /api/cierre/masivo`, botón "Cerrar Masivo"). Los dos botones convivían en el header de cada bitácora genérica, con lógica idéntica de cierre cronológico duplicada. Operativamente el cierre individual no aportaba valor —el turno se cierra completo, no bitácora por bitácora— y los dos botones casi iguales generaban ruido y confusión de usabilidad. El cierre individual además arrastraba un aparato de rechazos por bitácora automática (`400 mand_cierre_individual_no_permitido`, `422 bitacora_no_cerrable`) que solo existía para gatear ese botón.

**Decisión:** eliminar por completo el cierre individual —backend, frontend, tests y documentación—. El **cierre de turno masivo es el único cierre** del sistema. Concretamente: (1) se borraron del router `server/routes/cierre.js` el endpoint `POST /api/cierre/bitacora` y el `GET /api/cierre/preview` (preview individual); sobreviven `POST /api/cierre/masivo` y `GET /api/cierre/preview-masivo`. (2) Se borraron del hook `src/hooks/useCierre.js` `cerrarBitacora`, `previewCierre` y el `cierreMasivo` muerto (no consumido); sobreviven `previewMasivo` y `cerrarMasivoConFinalizacionForzada`. (3) En `BitacorasGecelca3.jsx` se eliminó el botón/handler de cierre individual (`handleCerrarTurno`, prop `onCerrarTurno`); el único botón de cierre —renombrado a **"Cerrar Turno"**— dispara el masivo con su modal de pendientes (`CierrePendientesModal`). (4) Con el endpoint fuera, desaparecen los códigos de rechazo del cierre individual (`mand_cierre_individual_no_permitido`, `bitacora_no_cerrable`): MAND/DISP simplemente quedan excluidos del cierre de turno vía `AND b.codigo NOT IN ('DISP','MAND')` (la única regla vigente). (5) Tests: los 4 tests de gating `puede_cerrar_turno` de `auth_middleware.test.js` se migraron al endpoint sobreviviente `/api/cierre/masivo`; el test de TZ de cierre (`cierre_y_fechas.test.js::B2`) se migró a `/api/cierre/masivo`; se removieron los tests que probaban los rechazos del cierre individual (A2, A3 y el test 7 de `sala_de_mando_batch.test.js`). La exclusión MAND/DISP del cierre sigue cubierta por A1/A4.

**Consecuencias:** (a) Superficie de API más chica y una sola ruta de cierre → menos código duplicado y menos confusión de UX (un botón, una acción). (b) **RF-030** (cierre individual) y **RF-065** (sus rechazos) quedan retirados/actualizados en `BIT-RF-2026-001.md`; **RF-031** pasa a describir el cierre de turno como acción autónoma (ya no "iteración de RF-030"). (c) El cierre cronológico por ventana de turno (D-005) es intacto: vive ahora solo en el bucle de `/api/cierre/masivo`. (d) Ningún cambio de esquema de BD: `registro_historico`, snapshots y CIET `'Cierre de turno'` siguen igual. Cross-ref: [[D-005]] (cierre cronológico), [[D-040]] (finalizar turno), [[D-004]] (CIET).

---

## D-043 — Push `eventos-changed` al dashboard (emisor del webhook)

**Fecha:** 2026-07-04

**Contexto:** el dashboard reflejaba los eventos MAND (`evento_dashboard`) solo por polling de 60s
(su hook `useEventosBitacora`). Se pidió reflejo casi instantáneo sin subir la carga. Bitácora es
el escritor de `evento_dashboard`, así que es el único que sabe *cuándo* cambió — el lugar natural
para emitir la señal.

**Decisión:** tras cada `commit` que toca `evento_dashboard`, disparar un webhook
**fire-and-forget** al backend del dashboard (`notifyDashboard()` en `utils/notify-dashboard.js`:
`fetch` POST, timeout 1.5s, **nunca lanza ni bloquea** la respuesta al operador; no-op si
`DASHBOARD_NOTIFY_URL` está vacío → instancia sin dashboard local). Enganchado en **todos** los
puntos de mutación de `evento_dashboard`, cada uno guardado para no emitir en no-ops:
`sala-de-mando/guardar` (`routes/mand.js`, si `creados+actualizados+eliminados>0`), `POST` y
`PUT /api/registros` (flag `dashboardTocado` cuando corre el upsert), `DELETE /api/registros`
(si `rowsAffected[0]>0`), `DELETE /api/eventos-dashboard/:id` (F7 vacía celdas MAND por acá) y
`DELETE /api/autorizaciones/:id` (deprecated F9, aún montado). NO se engancha el sweeper diario
(`utils/mand-sweeper.js`): su soft-delete es del rollover de día, no afecta la vista "hoy". Env:
`DASHBOARD_NOTIFY_URL` +
`DASHBOARD_NOTIFY_TOKEN` opcional (debe coincidir con `INTERNAL_NOTIFY_TOKEN` del dashboard).

**Consecuencias:** (a) reflejo ~0s manteniendo el poll del dashboard como red de seguridad.
(b) Fire-and-forget: si el dashboard está caído, el guardar de bitácora igual responde 200.
(c) DISP (Contrato 2) **no** emite todavía — su consumo en el dashboard es F15 pendiente; se
extiende igual cuando exista. (d) Contrato nuevo = **Contrato 3** en
`../../docs/interfaces-cross-repo.md`; lado receptor en dashboard [[DASH D-122]]. Cross-ref:
[[D-006]], [[D-009]] (contrato `evento_dashboard`).

---

## D-044 — Blindaje de `conformacion_turno` contra usuarios sintéticos (`es_sintetico`)

**Fecha:** 2026-07-04

**Contexto:** la tabla `bitacora.conformacion_turno` acumulaba usuarios de test (`test_jdt`,
`test_ingop`, `test_opcarbon`, `test_coord_cym`, …) en el histórico **inmutable** de plantas
**reales** (GEC3/GEC32) y de la planta de test (TST). Causa raíz: la suite corre contra la BD
productiva (D-030) y sus fixtures escriben sesiones directamente en `bitacora.sesion_activa` sobre
GEC3 (`helpers.js` defaultea `planta='GEC3'`; `consumos_combustible`/`rol_coordinador` la
hardcodean). `buildConformacionSnapshot` fotografía **toda** `sesion_activa` de la ventana sin
distinguir real de fixture; el sweeper (cada 60s) y el catchup de arranque (7 días) la disparan de
continuo, así que cualquier sesión de test viva al cierre de un turno real quedaba grabada para
siempre (PK idempotente). La limpieza (`cleanupTestRegistros`) sólo cubría 4 de los 6 usuarios test
y perdía la carrera contra el sweeper. (La "diferencia de 1 día" entre `fecha_operativa` y
`snapshot_en` en filas T2 **no** es bug: T2 cruza medianoche, así que `fecha_operativa`=día de
inicio (§4.7) y el snapshot cae el día calendario siguiente — inevitable en cualquier convención.)

**Decisión:** columna `lov_bit.usuario.es_sintetico BIT NOT NULL DEFAULT 0` como **chokepoint
blindado**. (1) Migración idempotente (`db.js`, `migrateSnapshots`) + seed en cada arranque:
`UPDATE es_sintetico=1 WHERE username LIKE 'test\_%'` (convención dura: todo fixture nace
`test_*`). (2) `buildConformacionSnapshot` filtra `WHERE (@incluir_sinteticos=1 OR
u.es_sintetico=0)`; **producción NUNCA pasa `incluirSinteticos`** → default `false` → sintéticos
excluidos siempre, viva donde viva la sesión. El flag es un escape hatch **exclusivo de los unit
tests** del agregado puro (duración/ventana T2/`fin_inferido`), custodiado por un guardrail
estático que falla si algún archivo de producción lo activa. (3) Reparación one-shot idempotente
(`db.js`, guardada por `migracion_aplicada 'D043.repair'`): purga de `conformacion_turno` las filas
sintéticas y las de planta TST ya grabadas. (4) `cleanupTestRegistros` limpia por `es_sintetico=1`
(cubre los 6 usuarios). (5) Se **conserva** la convención de `fecha_operativa`=día de inicio para T2
(sin migración de datos).

**Consecuencias:** (a) es estructuralmente imposible que un usuario de test contamine la
conformación real, incluso si un fixture se desvía a GEC3/GEC32 — no depende de disciplina de
limpieza. (b) La reparación borra la contaminación histórica una sola vez y queda auditable.
(c) Regresión codificada: el test E2E del trigger ahora **asegura la exclusión** (antes aseguraba
la inclusión). (d) Fix **backend-only** por decisión del owner; no existe UI que consuma la tabla
(se lee cruda) — la legibilidad de T2 (renderizar sólo columnas `*_bogota`, rotular el cruce de
medianoche) queda como fase de front pendiente. (e) **Pendiente/hallazgo lateral:** `setupOpCarbon`
y `setupCoordinador` hardcodean `turno:1` (deberían usar `getTurnoColombia()` como `setupSessions`)
→ flakiness 401 dependiente de la hora; y mover esos seeders a `TEST_PLANTA` (B1, verificado sin
acople sesión↔body) es higiene D-030 aún deseable aunque el chokepoint ya cierra el bug. Cross-ref:
[[D-025]] (conformación), [[D-030]] (planta de test), [[D-041]] (misma clase: suite vs BD prod).

---

## D-045 — Entidad explícita de turno (`turno_unidad`): apertura/cierre/extensión con ciclo de vida propio

**Fecha:** 2026-07-05

**Contexto:** el turno era **implícito y disperso** (`sesion_activa.turno` fijado al login [[D-003]], ventana
derivada en `utils/turno.js`, conformación reconstruida por sweeper + catchup, cierre por bucle masivo
[[D-042]]). La auditoría 2026-07-04 halló dos bugs de esa dispersión: **H1** (el catchup de conformación
derivaba `fecha_operativa` de `sesion_activa.inicio_sesion` = hora del **login**, así que un T2 con logins
post-medianoche quedaba mal/sin conformar) y **H2** (el sweeper disparaba conformación en paralelo, pudiendo
snapshotear un turno todavía sin sellar). No existía forma de responder "¿qué turnos NO cerró un coordinador?".

**Decisión:** convertir el turno en **entidad de primera clase**. (1) Cabecera `bitacora.turno_unidad` (1 fila
por `(fecha_operativa, planta, turno)`, estado `PROGRAMADO→ABIERTO→CERRADO`, `inicio/fin_nominal`,
`inicio/fin_real`, `extendido`/`veces_extendido`, `motivo_cierre ∈ {MANUAL, AUTO_SIN_PERSONAL,
AUTO_SIN_RESPUESTA}`, `cerrado_por`) + detalle vivo `bitacora.turno_participante` (UPSERT al entrar =
participación viva) + FK `turno_id` nullable en `sesion_activa`/`registro_activo`/`registro_historico`/
`conformacion_turno`. (2) **Apertura automática** por el `turno-sweeper` (sin solape: sucesor nace PROGRAMADO
mientras el actual sigue extendido). (3) **Cierre unificado atómico** (`cerrarTurno`): sella la cabecera +
**congela `conformacion_turno` desde `turno_participante`** (no desde `sesion_activa` — cierra H1/H2) + archiva
los registros del turno por `turno_id` + CIET + activa el sucesor, todo en una transacción. (4) **Flujo 6-a-6**:
al pasar `fin_nominal` el sweeper cierra `AUTO_SIN_PERSONAL` (sin gente) o `AUTO_SIN_RESPUESTA` (tras 60 min de
gracia con gente sin decidir), o mantiene un **bloqueo** (modal front) mientras haya gente en gracia; JdT/IngOp
extienden (`fin_nominal → próximo umbral`) o cierran. (5) `GET /api/turno/seguimiento` (+ vista
`v_turno_seguimiento`) da la visibilidad de turnos por día/unidad. (6) El front migra "Cerrar Turno" a
`POST /api/turno/cerrar` (retira `useCierre`/`CierrePendientesModal` del masivo [[D-042]]) + modal bloqueante
`TurnoTransicionModal`. (7) Purga one-time de arranque limpio (script manual `sql/snippets/`, ejecutada
2026-07-05: registros/histórico/conformación/`evento_dashboard`/turno_unidad → 0; DISP intacto).

**Consecuencias:** (a) H1/H2 quedan cerrados **por construcción**: la conformación es un producto atómico del
cierre, con `fecha_operativa`/`turno` de la cabecera (no del login). (b) La finalización individual [[D-040]]
convive (es presencia por-bitácora, ortogonal al cierre de la cabecera). (c) La conformación conserva el
blindaje anti-sintéticos [[D-044]] (`incluirSinteticos` sólo en unit tests). (d) MAND (cierre diario) y DISP
(estado continuo) siguen **fuera**: nunca reciben `turno_id`. (e) El `/api/cierre/masivo` backend sobrevive
hasta que se retire junto a sus tests; el front ya no lo usa. (f) La UI de seguimiento vive como sub-pestaña de
Históricos (sin routing hash [[D-035]]). (g) Baseline de tests full-green; +34 tests nuevos (dominio + endpoint
+ guardrail de purga). Cross-ref: [[D-003]] (turno al login), [[D-025]] (conformación), [[D-040]]
(finalización), [[D-042]] (cierre masivo reemplazado), [[D-044]] (sintéticos), [[D-035]] (sesión única/routing).

---

## D-046 — Bloqueo real de la ventana de transición + herramienta de prueba del umbral

**Fecha:** 2026-07-05

**Contexto:** en [[D-045]] la gavela de gracia (turno que cruzó `fin_nominal` pero aún `ABIERTO`, esperando
cerrar/extender) se resolvió con un **bloqueo solo en el front** (`TurnoTransicionModal`). Una revisión de
auditoría halló que ese bloqueo es **puramente visual**: durante la gracia el turno sigue `ABIERTO`, y los
tres write-gates de `registros.js` [[D-045]] solo consultan si existe turno `ABIERTO` — no miran
`estadoBloqueo`. Por lo tanto el backend **aceptaba** POST/PUT/DELETE en bitácoras genéricas durante la
gracia; el modal era evadible (devtools, o cualquier cliente fuera de la SPA). Además había un hueco de
≤60s (latencia del sweeper) donde el umbral ya se cruzó pero el modal aún no aparecía. "Todos bloqueados en
la gavela" era cierto solo visualmente.

**Decisión:** hacer el bloqueo de la transición **real en backend + front**. (1) Nuevo helper
`resolverTurnoParaEscritura` (`utils/turno-entidad.js`) que distingue tres estados de escritura —
`ABIERTO`/`TRANSICION`/`CERRADO`— evaluando `estadoBloqueo` **por request** (bloqueo instantáneo al cruzar
`fin_nominal`, sin depender del tick del sweeper → cierra el hueco de ≤60s). (2) Los tres write-gates
responden `409 turno_en_transicion` (nuevo, hermano de `turno_cerrado`; `respTurnoEnTransicion` en
`routes/_middleware.js`) cuando el estado es `TRANSICION`. Se levanta solo al **extender** (`fin_nominal →
próximo umbral` → `estadoBloqueo=false`) o pasa a `turno_cerrado` al **cerrar**. MAND/DISP/COMB siguen
exentos (igual que el gate `turno_cerrado`). (3) Front: `turnoEnTransicion = turnoHook.bloqueo` entra al
gate de la grilla (`bloqueado`), que pasa a solo-lectura **real** (no solo el overlay); el manejo de error
de guardar/borrar (`surfaceWriteError`) muestra el `mensaje` y refetchea el estado del turno para que el
modal aparezca al instante para quien intentó escribir. (4) Herramienta de prueba manual: snippet
`sql/snippets/simular-umbral-turno-D046.sql` adelanta `fin_nominal` del turno ABIERTO (modo `BLOQUEO` =
ahora; `AUTOCIERRE` = ahora−61 min) para disparar el flujo real a cualquier hora; reversible con
Extender/Reabrir. Guardrail estático `guard_simular_umbral_no_auto_ejecutable.test.js` impide que se
auto-ejecute. Runbook multi-usuario en `docs/pruebas/prueba-umbral-cierre.md`.

**Consecuencias:** (a) durante la gracia nadie escribe en genéricas: el backend rechaza y la grilla es
read-only para todos — auditable en toda capa. (b) El bloqueo es **instantáneo** al umbral, ya no atado a la
latencia del sweeper (el sweeper sigue siendo la fuente del broadcast WS y del auto-cierre). (c) Dos códigos
distinguibles: `turno_en_transicion` (gracia, se levanta al extender) vs `turno_cerrado` (cerrado, requiere
reabrir). (d) Sin estados nuevos en BD: `estadoBloqueo` sigue siendo computado; `TRANSICION` es una lectura,
no una columna. (e) +2 tests (integración del gate en TEST_PLANTA + guardrail del snippet). Cross-ref:
[[D-045]] (entidad de turno), [[D-040]] (finalización individual), [[D-032]] (códigos de error estables).

---

## D-047 — "Mejorar con IA": corrección ortográfica de `detalle` vía Google Gemini (server-side)

**Fecha:** 2026-07-05

**Contexto:** las descripciones (`detalle`) de las bitácoras genéricas se escriben a mano en turno y llegan
con ortografía/puntuación dispareja al histórico inmutable y a los reportes. Se quería asistencia de IA
100% gratis, sin dependencias npm nuevas y sin exponer credenciales al navegador. Anthropic/Claude quedó
descartado por no tener tier gratuito; se eligió Gemini (`gemini-2.5-flash-lite`, free tier de AI Studio).

**Decisión:** endpoint único `POST /api/ia/mejorar-texto` (router `routes/ia.js`, tras `requireEntra` +
`loadAppSession`, cualquier cargo) que llama a Gemini desde `server/utils/ia/` con fetch nativo. La key
(`GEMINI_API_KEY`) vive solo en el `.env` del server (header `x-goog-api-key`, jamás en URL); el front
manda `{texto, bitacora_codigo}` y recibe `{texto_corregido}` que reemplaza el textarea (guardar sigue
siendo manual, con "Deshacer" local en `RegistroRow`). El prompt de rol por bitácora se resuelve
**server-side** (`prompts.js` — el cliente no puede inyectar el rol); solo corrige ortografía/tildes/
puntuación, nunca terminología/cifras/tags, y ordena no obedecer instrucciones embebidas en el texto.
Blindaje: rate limit 10/min-IP + 14/min y 400/día globales (`aplicarRateLimitGlobal`, cuota free tier
compartida), tope 2000 chars (`MAX_TEXTO_CHARS`), timeout 12 s, `redirect:'error'`, rechazo de salida
truncada (`finishReason≠STOP`) o >3× la entrada, `temperature 0.1` + thinking off, log de uso sin
contenido (solo longitudes). Errores [[D-032]]: `ia_no_configurada`/`ia_no_disponible` (503). En prod el
FortiGate intercepta TLS saliente → CA corporativa vía `NODE_EXTRA_CA_CERTS` en el unit systemd
(DEPLOY.md §7); NUNCA desactivar la verificación TLS.

**Consecuencias:** (a) feature opcional y degradable: sin key el endpoint responde 503 estable y el
operador escribe a mano. (b) La cuota es compartida por instancia (limiter en memoria — se resetea al
reiniciar, aceptable). (c) El texto del operador viaja a un servicio externo de Google: solo el campo
`detalle`, nunca identidad/planta/sesión. (d) +tests: unit del cliente con `fetchFn` inyectado +
integración de auth/validaciones/429 (el camino feliz determinista es unit-only para no depender de la
red ni gastar cuota); `errores.test.js` entró a la lista curada del script `test` (estaba omitido).
Cross-ref: [[D-032]] (saneamiento), [[D-037]] (routing), [[D-040]]/[[D-046]] (el botón vive dentro del
gate `isEditing`, que ya respeta `bloqueado`).

---

## D-048 — Escritura de COMB (Consumos de Combustibles) restringida a JdT + Ingeniero de Operación

**Fecha:** 2026-07-07

**Contexto:** desde D-027/D-029 la escritura (crear/editar/borrar) de `COMB` la tenían el `Operador de
Planta - Carbón y Caliza`, el `Ingeniero Jefe de Turno` y el `Coordinador de carbón y maquinaria`. Por
control operativo se decidió que el registro de consumos lo lleven únicamente los cargos de ingeniería de
turno; los operadores (incluido Carbón y Caliza) y el Coordinador deben quedar en **solo-lectura** sobre
ese módulo, igual que el resto de operadores.

**Decisión:** en la matriz canónica `cargo_bitacora_permiso` (reconstruida en cada arranque, `db.js`) la
CASE clause de `puede_crear` para `b.codigo='COMB'` pasa a `c.nombre IN ('Ingeniero Jefe de Turno',
'Ingeniero de Operación')`; `puede_ver` sigue en 1 para todos. El bootstrap one-shot F26.B1 se alineó a la
misma regla y se hizo auto-corrector (ambas ramas con `WHEN MATCHED THEN UPDATE`). El rol
`Administrador y Debugging` conserva escritura porque su WHEN de acceso total ([[D-039]]) va primero —
es god-mode por diseño, con toda acción atribuida, ortogonal a los cargos operativos. **No hay cambio de
código de enforcement:** el endpoint `POST /api/combustibles/consumos` (crear/editar/borrar en un solo
batch) ya valida `hasPermisoBitacora(..., 'puede_crear')` (data-driven), y el front deriva `puedeCrear`
de la misma matriz (`BitacorasGecelca3.jsx` → `ConsumosGrid`), así que el cambio se propaga solo. El front
además muestra un chip "Solo lectura" cuando `!puedeCrear` (comunicación, no gate — los inputs ya van
`disabled` y el backend responde 403 aunque se evada el cliente).

**Consecuencias:** (a) el `Operador de Planta - Carbón y Caliza` y el `Coordinador de carbón y maquinaria`
pasan a solo-lectura en COMB (POST → 403); siguen viendo la grilla. (b) Se agregó al `Ingeniero de
Operación` como escritor (antes no lo era). (c) Tests: `consumos_combustible.test.js` mueve sus POST de
setup a un escritor (JdT/IngOp), invierte el caso del Op. Carbón (GET 200 / POST 403), suma el caso IngOp
(POST 200) y un test-candado de la matriz completa de escritores; `rol_coordinador_carbon_maquinaria.test.js`
invierte sus casos COMB. (d) El manual `CAPACITACIÓN.docx` queda desactualizado en el apartado de quién
edita COMB (regenerar en la próxima pasada). Cross-ref: [[D-027]] (módulo COMB), [[D-029]] (Coordinador),
[[D-039]] (rol ADMIN god-mode).

---

## D-049 — Edición/eliminación de registros genéricos: SOLO el autor (se retira el bypass JdT/IngOp)

**Fecha:** 2026-07-08

**Contexto:** `canEditarRegistro` (gate de `PUT/DELETE /api/registros/:id`) permitía a cualquier cargo con
`puede_cerrar_turno=1` (JdT, IngOp y ADMIN) editar y **borrar físicamente** registros ajenos en CUALQUIER
bitácora, incluidas aquellas donde solo tienen `puede_ver` (CALDERA, ANAL, AGUA, TURBO, MAQU, CYC, QUIM).
El bypass venía del diseño original (`isJdT()`, generalizado en el commit `c36e573`) y contradecía RF-022
(edición: solo cargos con `puede_crear`); el DELETE además no deja rastro (borrado físico sin CIET). El
front agravaba el hueco: el gate por fila de la grilla mostraba Editar/Eliminar a cualquier viewer y el
"Ver detalle" entraba en modo edición.

**Decisión:** política **"solo el autor"** para bitácoras genéricas. `canEditarRegistro` exige (1) misma
planta, (2) `creado_por = usuario de la sesión` y (3) `puede_crear` vigente en la bitácora — sin excepción
para JdT/IngOp ni ADMIN (cero bypass; coherente con [[D-039]]). DISP/MAND/COMB quedan fuera: endpoints
propios gateados por `puede_crear` (edición colaborativa por diseño). El GET `/api/registros/activos`
expone el espejo por fila **`puede_editar`** (advisory, misma regla en SQL) y la grilla renderiza
lápiz/basurero SOLO desde ese flag — la UI nunca decide; en filas ajenas el ojo "Ver detalle" expande la
descripción en lectura (ya no abre inputs). Los 403 llevan `codigo: 'solo_autor'` (D-032).

**Consecuencias:** (a) JdT/IngOp conservan cierre/extensión/reapertura de turno, MAND, DISP, COMB y
`finalizar-forzado` — solo pierden la edición/borrado de registros ajenos; en SALA (compartida con el
Op. SDM) cada quien edita únicamente lo suyo. (b) Cargos con solo `puede_ver` (Gerente, IngQuímico fuera
de QUIM) dejan de ver affordances de edición que morían en 403. (c) Un borrador cuyo autor no está queda
intacto hasta el cierre de turno (archivado normal) — no hay "edición delegada"; si se necesitara, sería
una decisión nueva. (d) Tests: `registros_solo_autor.test.js` (autor 200; no-autor con permiso 403;
regresión del bypass JdT/IngOp 403; Gerente 403; espejo del GET). (e) RF-022/RF-023 actualizados a la
política de autoría. Cross-ref: [[D-032]] (códigos estables), [[D-039]] (ADMIN sin bypass), [[D-048]]
(COMB solo JdT/IngOp).

---

## D-050 — Históricos: columna Campos solo-UI, `participantes` derivado server-side, filtro por autor y detalle expandible

**Fecha:** 2026-07-08

**Contexto:** la vista de Históricos mostraba (a) la columna "Campos" (`campos_extra`), percibida como
legacy — aunque para MAND/AUTH históricos contiene `periodo`/`valor_mw`/`funcionariocnd`; (b) la columna
"Ingenieros" con `ingenieros_snapshot` crudo, que en realidad captura a *todos* los presentes salvo
JdT/Gerente (operadores incluidos) y duplicaba gente que ya sale en las columnas JdTs/Jefes; (c) el
detalle completo solo por hover (`title`), invisible en táctil/impresión; y (d) sin filtro por autor,
pese a que el backend ya aceptaba `creado_por_id`.

**Decisión:** (1) La columna "Campos" se elimina **SOLO de la UI**: `v_historico_busqueda` y la API siguen
exponiendo `campos_extra` (los datos MAND/AUTH quedan auditables por API). (2) La columna pasa a
"Participantes": los snapshots son INMUTABLES (RF §6.5), así que la exclusión se **deriva en el router**
(`utils/participantes.js`: `ingenieros − (jdts ∪ jefes)` por `usuario_id`) y sale como campo
`participantes` junto a los snapshots crudos — regla única server-side, corrige también el histórico
viejo sin reescribirlo. (3) Celda Detalle con "Ver más"/"Ver menos" inline, umbral fijo 160 chars
(`DETALLE_PREVIEW_MAX`). (4) Nuevo parámetro `?creado_por=` con `LIKE` sobre `creado_por_nombre`,
escapado con `utils/sql-like.js` (`ESCAPE '\'`) — hardening aplicado también al `busqueda` existente
para que `%`/`_`/`[` matcheen literal.

**Consecuencias:** (a) `JsonPopover` → `UsuariosPopover` (murió la variante "campos"). (b) El front
renderiza `r.participantes` ya derivado — si la regla cambia, se toca solo el util del server y su test.
(c) Tests: `historicos_participantes.test.js` (unit puro; no importa `routes/historicos.js` porque
`db.js` abre el pool al importarse), `historicos_endpoint.test.js` (HTTP sobre TEST_PLANTA con
`registro_id` negativos — imposible colisionar con la IDENTITY real) y `detalle-cell.test.jsx` (vitest).
Cross-ref: [[D-030]] (aislamiento TEST_PLANTA), [[D-026]] (por qué DISP ya no usa `campos_extra`).

**Addendum blindaje (2026-07-09, auditoría de datos dev+prod):** los datos reales (106 históricos
prod) están limpios, pero se blindó preventivamente: `participantesVisibles` compara `usuario_id`
normalizado a String (snapshots de versiones viejas podrían mezclar string/número — la exclusión
sería silenciosamente inerte) y los inputs LIKE (`busqueda`/`creado_por`) se capan a 200 chars antes
de escapar (el peor caso escapado = 400 = tamaño exacto del parámetro; sin cap → 500 del driver).

---

## D-051 — DISP: los años del selector viajan en la respuesta del dashboard (se retira /anios)

**Fecha:** 2026-07-08

**Contexto:** el filtro de AÑO del dashboard DISP se poblaba con `GET /api/disponibilidad/anios`
consultado **una sola vez al montar** el componente. Crear (backfill de planta vacía), editar o
deshacer un registro retro-fechado no actualizaba el selector hasta un F5 — el resto del dashboard
sí se refrescaba (fetch post-mutación + polling 30 s), pero los años no viajaban en ese refresh.

**Decisión:** los años se calculan en `getAniosDisponibles` (`utils/notificador.js`, misma SQL:
rango contiguo desc desde el MIN global Bogotá hasta el año actual) y viajan como campo `anios`
**dentro de la respuesta de `GET /api/disponibilidad`** — la unidad de refresh del dashboard. El
front sincroniza el selector desde cada respuesta de `getEstado` (post-crear/editar/deshacer y
cada tick de polling) y aplica clamp: si el año seleccionado desapareció (deshacer encogió el
rango), vuelve a "Todos" (`anioVigente`). El endpoint `/anios` y `useDisponibilidad.getAnios` se
**eliminaron** (único consumidor: el efecto de montaje causante del bug). Lógica pura del filtro
extraída a `src/components/Disponibilidad/anios.js`.

**Consecuencias:** (a) cero requests extra: los años montan en el GET existente (una consulta MIN
barata en el mismo handler, en paralelo). (b) Escrituras de OTRO cliente aparecen a más tardar en
el siguiente tick de polling (30 s) — misma cadencia que el resto del dashboard; DISP no tiene
canal WS y este fix no introduce uno. (c) Tests: `disponibilidad_anios.test.js` (e2e TEST_PLANTA:
retro extiende `anios` en la misma respuesta, cleanup restaura baseline, `/anios` → 404) y
`anios.test.js` (vitest puro). Cross-ref: [[D-026]] (storage DISP), [[D-030]] (TEST_PLANTA),
[[D-020]] (año Bogotá = UTC-5).

**Addendum blindaje (2026-07-09, auditoría de datos dev+prod):** piso de dominio `DISP_ANIO_MIN=2000`
(exportado de `utils/notificador.js`) aplicado en DOBLE capa. Escritura: la rama DISP de POST/PUT
`/api/registros` rechaza con 422 un `fecha_inicio_estado` con año Bogotá < 2000 — antes, un año typo
(`0026` tecleado en el datetime-local) entraba por el 1er registro de una planta vacía o el PUT del
vigente sin N-1 (solo existía el guard de futuro). Lectura: `construirRangoAnios` (función pura,
unit-testeada) clampa el rango a `[2000, añoActual]`, así una fila corrupta PREEXISTENTE tampoco
infla `anios` (~2000 entradas) en cada respuesta del dashboard. Front: el modal DISP pone
`min=2000-01-01T00:00` en el datetime-local cuando no hay min cronológico (defensa en navegador;
el backend es la fuente de verdad). Prod auditada 2026-07-09: 2 filas DISP, ambas 2026, sin anomalías.

---

## D-052 — La bitácora ANAL se llama "Analista" (la etiqueta vive solo en el seed)

**Fecha:** 2026-07-14

**Contexto:** la bitácora `codigo='ANAL'` se sembraba con `nombre='Análisis'`, pero el resto del
sistema ya la nombraba por el **puesto** y no por la actividad: el cargo `Operador de Planta -
Analista` (el único con `puede_ver`/`puede_crear` sobre ANAL), su App Role de Entra
`OPERADOR_PLANTA_ANALISTA` (D-031) y el rol IA ("un analista de laboratorio…", D-047). El sidebar
mostraba "Análisis" mientras la persona que registra allí es el Analista — la etiqueta era la
inconsistente. (Ortografía: "analista" es palabra llana terminada en vocal → sin tilde.)

**Decisión:** renombrar **solo la etiqueta visible** — `lov_bit.bitacora.nombre = 'Analista'` en el
seed MERGE de `db.js`. El `codigo='ANAL'` queda **intacto**: es la identidad estable de la bitácora
(la matriz de permisos matchea por `b.codigo`, y los registros la referencian por `bitacora_id`).
El rename aterriza por el `WHEN MATCHED … SET nombre` del MERGE, que corre en **cada arranque** →
idempotente, sin migración one-shot ni `UPDATE` manual en prod. Fuente única: el seed. El front no
cambia (es data-driven: `/api/catalogos/bitacoras` → `b.nombre`) y históricos/cierre/turno tampoco
(resuelven la etiqueta por `JOIN … b.nombre`). La **única** copia literal del nombre es
`utils/ia/prompts.js`, espejo deliberado (D-047: `buildSystemPrompt` debe ser puro y el nombre
jamás puede venir del cliente) — se sincroniza y queda fijada por guard.

**Consecuencias:** (a) el rename es **retroactivo en el histórico y eso es lo correcto**: un
registro de marzo se muestra bajo "Analista" porque `registro_historico` referencia `bitacora_id`,
no el texto. No se reescribe ningún dato ni se pierde trazabilidad — el identificador auditable
sigue siendo `ANAL`. (b) **Permisos intactos por construcción**: la matriz de §2.6 nunca matchea la
bitácora por nombre, así que renombrar no puede dejar un cargo sin su bitácora. (c) Nuevo guard
`server/tests/catalogo_bitacoras.test.js`, **cableado a `npm test`** (`server/package.json`): fija
ANAL='Analista', la ausencia del nombre anterior, el espejo `prompts.js` ↔ catálogo (ante drift
falla nombrando el código y ambos valores) y la neutralidad de permisos. Verificado **en negativo**
(drift inyectado a propósito → rojo; revertido). (d) Observación de auditoría, no tocada: el
`INSERT` de bitácoras de `BIT-MODBD-2026-001.md` §2 es la draft original (códigos `CAL`, `SINC`,
`TURB`, inexistentes en el catálogo real) — ya estaba superado por el seed de `db.js` y ni siquiera
lista ANAL, así que el rename no lo afecta. Cross-ref: [[D-047]] (IA), [[D-031]] (App Roles).

---

## D-053 — La bitácora SALA se parte por rol: SALAJDT / SALAING / SALAOP

**Fecha:** 2026-07-14

**Contexto:** `SALA` ("Sala de Mando Operativa") era la **única bitácora del catálogo donde varios
cargos compartían `puede_crear`**: Ingeniero Jefe de Turno, Ingeniero de Operación y Operador de
Planta - Sala de Mando escribían todos en la misma grilla. Eso mezclaba tres responsabilidades
operativas distintas en un solo hilo e impedía leer el histórico por rol.

**Decisión:** una bitácora por rol — `SALAJDT` (crea solo el JdT), `SALAING` (solo el IngOp), `SALAOP`
(solo el Op de Sala). Los demás cargos las ven en solo-lectura; `Administrador y Debugging` crea en las
tres por la MISMA matriz data-driven (D-039, cero bypass). El Op de Sala **no ve** SALAJDT ni SALAING.
`SALA` se **renombra** a `SALAJDT` conservando `bitacora_id=14`, `orden=3` y su `tipo_evento`: es la
misma fila, así que su histórico no se mueve ni se reescribe. `SALAING`/`SALAOP` nacen nuevas y el seed
de `tipo_evento` les siembra su `'Evento General'` propio. El rename va como **`UPDATE` previo al
`MERGE`** (patrón `CAL`→`CALDERA`, "Paso 1" de `db.js`), NO dentro del `MERGE`: este matchea
`ON t.codigo = s.codigo`, así que poner el código nuevo en el `VALUES` habría insertado una fila y
dejado `SALA` huérfana con sus registros colgando.

**Consecuencias:**
(a) **Invariante roto a propósito:** JdT e IngOp **dejan de tener filas idénticas** en la matriz — se
parte el `IN` compartido de `puede_crear`, preservando DISP para ambos. `db.js` y
`docs/domain-glossary.md` afirmaban esa simetría ("mismo poder operativo"); corregidos. Se retira
`'AUTH'` de esa cláusula: era código muerto (se siembra `activa=0` y la matriz filtra `activa=1`).
(b) **Migración `F30.A1`** (one-shot, gateada por `migracion_aplicada`): reparte los registros por el
cargo del autor. **El cargo NO se persiste** — `creado_por` es un `usuario_id` y el cargo se resuelve
del App Role de Entra en cada login (`lov_bit.usuario` no tiene `cargo_id`; la auditoría de roles del
login es un `console.log`). Se reconstruye **por evidencia**, en escalera: `turno_participante` →
`conformacion_turno` (ambas por `turno_id`, exactas) → `sesion_activa` solo si el autor usó un único
cargo. Política: **move-out por atribución positiva** — solo se mueve lo atribuible a IngOp/Op de Sala;
lo demás (JdT, Admin, irresoluble) **no se toca** y se reporta en el log. **Sin `THROW` por
ambigüedad**: tumbaría el arranque en prod. Se descartó la clave natural `(autor, planta, turno, fecha)`
porque el turno 2 cruza medianoche y `fecha_operativa` es el día en que **arrancó** el turno.
(c) **Gotcha permanente:** no existe FK ni CHECK que ate `registro.bitacora_id` ↔
`tipo_evento.bitacora_id`, y **ninguna lectura lo verifica** (`registros.js` y `v_historico_busqueda`
joinean `te` por `tipo_evento_id` a secas). Mover `bitacora_id` sin remapear `tipo_evento_id` produce
filas que **se ven perfectas** y solo explotan al editarlas — con el dato corrupto ya en el histórico.
Toda migración que mueva `bitacora_id` **debe remapear el tipo en el mismo statement**. Fijado por
`guard_tipo_evento_coherente.test.js` (verificado en negativo).
(d) **Excepción explícita a RF-032:** `F30.A1` hace `UPDATE` sobre `registro_historico` (append-only por
convención organizativa, sin trigger). Las filas afectadas se respaldan en
`bitacora.registro_historico_backup_D053` dentro de la misma transacción. **Esa tabla es residente: no
se borra** — es el rastro de auditoría y habilita el rollback.
(e) **Falso verde cerrado:** `registros_solo_autor` test 2 ("no-autor **CON** `puede_crear` → 403
`solo_autor`") usaba SALA por ser el único fixture con `puede_crear` compartido. El split lo borraba
del catálogo: el test habría seguido **verde** pasando por la rama "sin permiso". Reescrito con el rol
**ADMIN** como no-autor (único cargo con `puede_crear` en todas), lo que además fija la afirmación más
fuerte de [[D-049]]: nadie tiene excepción, tampoco el admin. Fixtures nuevos `test_opsala`/`test_admin`
con `es_sintetico=1` (D-044/D-030).
(f) **Front sin cambios**: es data-driven y el literal `'SALA'` no existía en `src/` (`SALA_DE_MANDOS`
es la categoría "Despachos" = DISP+MAND, sin relación). Único añadido: alias `#/b/SALA` → `SALAJDT` en
`appRoute.js`, porque un deep-link retirado no falla ni avisa — cae al fallback mudo
`bitacorasPermitidas[0]` y `replaceState` borra la URL original.
(g) **Prod:** `sql/snippets/reporte-split-sala-D053.sql` (solo lectura, guardrail de no-auto-ejecución)
se corre **antes** del deploy y expone cuántos registros quedarían **sin atribuir**; ese número es la
puerta de decisión. Luego el deploy + reinicio aplica todo en un arranque.
Cross-ref: [[D-039]] (rol ADMIN), [[D-049]] (solo el autor), [[D-052]] (espejo `prompts.js` ↔ catálogo),
[[D-031]] (cargo desde App Role), [[D-045]] (`turno_id`, fuente de la atribución).

---

## D-054 — Cambio de unidad en caliente para los cargos que operan ambas plantas

**Fecha:** 2026-07-15

**Contexto:** cambiar de unidad (GEC3 ↔ GEC32) costaba tres pasos: menú → "Cambiar de unidad" →
`clearSesion` (mata la sesión de app) → caer en `LoginScreen` → volver a elegir planta ([[D-035]]).
Es razonable como camino universal, pero el **Ingeniero Jefe de Turno** y el **Operador de Planta -
Analista** alternan entre las dos unidades muchas veces por turno, y para ellos ese rodeo —pasar por
una pantalla de login sin re-loguearse— es fricción pura. Además, el camino largo tiene un costo
oculto: al pasar por `LoginScreen` la sesión de app queda muerta unos segundos, y en esa ventana
`cargo_id` es `undefined` → `catalogos.permisos` cae a `[]` → `bitacorasPermitidas` degrada a **todas**
las bitácoras (fail-open transitorio de la UI).

**Decisión:** (1) **El permiso es DATO, no código**: columna `lov_bit.cargo.puede_cambiar_unidad`
(BIT, default 0), fijada por el **MERGE de cargos de `db.js` que corre en CADA arranque** y matchea
por `nombre` — mismo contrato que `solo_lectura`/`puede_cerrar_turno`. Hoy en 1 para JdT y Operador
Analista; el `WHEN MATCHED` la baja a 0 en el resto (auto-correctora). **Nunca** se hardcodea el
`cargo_id` ni el nombre del cargo en un endpoint ni en el front (convención 12). Cambiar la política
= editar el seed + redesplegar. (2) **Endpoint propio**: `POST /api/auth/cambiar-unidad`, con
`loadAppSession` (exige sesión de app **ya existente**: no es un camino de ingreso, es un cambio de
contexto de quien ya opera), gate `puedeCambiarUnidad(req.sesion)`, rate limit 30/min, y respuesta
200 idempotente si ya estás en esa unidad (double-click safe, no rota `inicio_sesion`). (3) **Toda la
mecánica se extrae a `server/utils/sesion-contexto.js`** (`establecerContextoSesion`), compartida con
`select-context`: el barrido de sesión única ([[D-035]]), el `CASE` de ventana ([[D-040]]) y el
turno/presencia/participación ([[D-045]]) existen **una sola vez**. Antes vivían inline en el router;
duplicarlos habría dejado dos copias que driftean en silencio. (4) **El cargo NO se re-deriva del
token** en `cambiar-unidad` (sí en `select-context`): esta operación cambia la **unidad**, no la
identidad — re-derivarlo aplicaría un cambio de App Role como efecto colateral de un botón de
navegación. La divergencia de cargo contra Entra la sigue resolviendo `revalidate` (AUD-10), igual
que para cualquier otro endpoint. (5) **Front**: botón en el navbar visible solo si
`sesion.puede_cambiar_unidad` (el mismo objeto que gatea el server → UI y enforcement no pueden
divergir), con la unidad destino **derivada del catálogo** (no de una lista hardcodeada): si hubiera
más de dos unidades, "la otra" deja de estar definida y el botón se oculta solo. Esa regla vive en
`src/utils/unidades.js` (`resolverOtraUnidad`), módulo **puro** con tests — mismo patrón que
`routing/appRoute.js`: lo que decide si el atajo existe debe poder probarse sin montar el dashboard.

**Alcance del permiso (leerlo bien):** NO restringe la capacidad de operar ambas unidades —
cualquier cargo puede cambiar de unidad por el camino largo, y así debe seguir (todos eligen planta
al entrar). Gobierna el **atajo**. El gate del server existe para que el botón no sea una promesa que
el backend no cumple, no como frontera de datos.

**Consecuencias:** (a) El cambio en caliente **no desmonta el componente** (`LoginScreen` es un early
return del mismo componente), así que el estado obsoleto no se limpia solo: `handleIrAUnidad`
invalida `draftLocal` y `dispPlanta`, y **reescribe el hash** cuando la sección activa es DISP —
sin eso el efecto ruta→estado revierte `dispPlanta` a la unidad vieja en el mismo render
(`route.params.planta || dispPlantaRef.current || sesion.planta_id`), dejando el header en GEC32 y
DISP en GEC3. Los filtros **no** se resetean a propósito: ver la misma bitácora con el mismo filtro
en la otra unidad es justo el flujo que esto habilita. (b) **Bug corregido de paso**: `useTurno` no
limpiaba `turno` al cambiar `plantaId`. Con el cambio en caliente eso dejaba los write-gates globales
(`turnoUnidadCerrado`/`turnoEnTransicion`), los badges y el modal de transición de la unidad **nueva**
gobernados por el turno de la **vieja**, hasta que resolviera el refetch — e indefinidamente si
fallaba. La invalidación se hace por **identidad** (cambió `plantaId`), en el efecto, y **no** en el
`catch` del refetch: `refetch` también corre en cada mensaje del WS, así que limpiar ahí haría que un
blip de red borrara un estado válido y el header dijera "Turno cerrado" bloqueando escrituras sin que
nada haya cerrado. Ante un fallo se conserva lo último conocido de ESA unidad. El guard
`plantaCargadaRef.current !== null` es load-bearing: preserva el `initialTurno` sembrado por
`/api/me` ([[D-045]] E8), que es lo que hace reaparecer el modal al recargar en pleno bloqueo. (c) **Bug corregido de paso**: `useBitacoraSesion` dependía solo de
`[bitacora_id]`; la presencia es de la pareja (sesión, bitácora) — `sesion_bitacora` tiene UNIQUE
`(sesion_id, bitacora_id)` — así que cambiar de unidad sin cambiar de pestaña no re-disparaba
`/api/bitacora/abrir` y el usuario quedaba sin registrar en la unidad nueva. Antes lo tapaba el
`setActiveBitacora(null)` del camino por `LoginScreen`, un acoplamiento implícito del que la
correctitud ya no depende. (d) **Endurecimiento de paso**: la validación de planta (ahora única,
`validarPlantaOperable`) **excluye `TEST_PLANTA_ID`**. Es residente con `activa=1` por necesidad de
[[D-030]], así que filtrar solo por `activa=1` la dejaba pasar; el selector del login la escondía,
pero eso era una barrera de UI. Aplica también a `select-context`. (e) `cambiar-unidad` **sí** es
testeable end-to-end por el backdoor `X-Sesion-Id` — consecuencia directa de no depender de
`req.session.user`. Contrasta con `select-context`, cuyo único test replica su SQL a mano.
**21 tests nuevos**: 12 de backend (`server/tests/cambiar_unidad.test.js`) que ejercitan el gate y el
cambio real ida-y-vuelta, incluidos dos que fijan el permiso como dato — que lo tengan **exactamente**
esos dos cargos, y que un `UPDATE` manual en la BD **no sobreviva** al arranque — y 9 de front
(`src/utils/unidades.test.js`) sobre el gate de UI. (f) ADMIN (`Administrador y Debugging`) queda **fuera** del permiso pese a su acceso total
por matriz ([[D-039]]) — se pidió explícitamente para dos cargos. Es la única asimetría con D-039;
si molesta, es una línea del seed. Cross-ref: [[D-035]] (sesión única, routing), [[D-040]]
(finalización por ventana), [[D-045]] (turno/presencia), [[D-030]] (planta de test), [[D-031]]
(cargo desde App Role).

---

## D-055 — Integridad de MAND: la suite deja de destruir histórico real, y el `detalle` deja de perderse en silencio

**Fecha:** 2026-07-15

**Contexto:** se reportó que `registro_historico` (bitácora 16 = MAND) y `evento_dashboard` guardan
información parecida pero con conteos distintos en prod (10 vs 45 filas), que el histórico "solo
guarda autorizaciones y no todas", que REDESP/PRUEBA pierden el comentario, y que MAND tiene
`turno_id` NULL. La auditoría confirmó tres defectos, refutó uno, y destapó tres más que nadie había
pedido mirar.

**Lo que NO era un bug:** `cerrarDiaMand` archiva por día **sin filtrar por tipo** — archiva AUTH,
PRUEBA y REDESP, y preserva su `detalle`. El histórico solo tenía AUTH porque en los días que
llegaron a archivarse (07-12/13/14) solo se capturaron autorizaciones. Fijado por test para que
quede **probado** y no argumentado. La diferencia 45 vs 10 eran, exactamente, 35 filas huérfanas.

**Decisión (seis hallazgos, seis correcciones):**

**(1) CRÍTICO — la suite destruía `registro_historico` real.** `sala_de_mando_batch` hacía
`DELETE FROM registro_historico WHERE bitacora_id=@mand AND planta_id=@p` con `@p = PLANTA_ID =
'GEC3'` (planta REAL), sin fecha ni tag, ~7 veces por corrida; `fechas_bogota` (T4/C5) lo mismo para
CALDERA (176 filas reales en riesgo). Con la suite corriendo contra la BD productiva ([[D-030]]),
cada `npm test` aniquilaba el libro inmutable (RF-032). **La raíz no era el test: era `mand.js`
hardcodeando `['GEC3','GEC32']`**, lo que hacía *imposible* usar la planta-fixture `'TST'` como sí
hace DISP. Se retira la allowlist (la rama genérica de `registros.js` ya confía solo en
`plantaMatch`; `sesion_activa.planta_id` tiene FK a `lov_bit.planta`) y ambas suites migran a `TST`.
Nota de coherencia con [[D-054]](d): `validarPlantaOperable` **excluye** `TST` del login/select-context
— TST no es operable por un humano; los tests insertan `sesion_activa` directamente. Las dos reglas
conviven: el borde de **identidad** rechaza TST, el de **datos** no la necesita hardcodeada.

**(2) El `detalle` no tiene storage propio y se perdía en silencio.** `detalle`/`funcionariocnd` son
atributos de la FILA (tipo × día × planta) pero el modelo los replica en cada celda con valor. Se
escribían solo dentro del loop de `periodos`, así que una fila con `periodos: []` no guardaba nada y
respondía **200** — el front decía "Guardado" y el refetch revertía el texto. Dos caminos reales:
(a) fila sin ningún valor; (b) **REDESP con todos sus valores en periodos bloqueados**, que el front
omitía para no rebotar contra `periodo_bloqueado` — el caso exacto del reporte. Ahora la metadata se
aplica **a nivel de fila**, una vez, sobre todas sus celdas: **el lock de REDESP protege el VALOR,
nunca el comentario**. Sin celdas donde anclarlo → `400 detalle_sin_celdas` explícito, nunca un 200
mentiroso. `modificado_por` sigue intacto ([[D-019]]: solo un cambio de `valor_mw` marca modificación).

**(3) `turno_id` NULL — y el join ingenuo estaba mal.** MAND era la única bitácora que insertaba sin
`turno_id` (`registros.js` sí lo estampa) y `cerrarDiaMand` no lo copiaba → 10/10 NULL. Se resuelve
por `(planta, fecha_operativa, turno)` con `fechaOperativaDePeriodo` (`utils/turno.js`, pura), que
sabe que **los periodos 1..6 de la grilla del día F pertenecen al T2 que arrancó a las 18:00 de
F-1**: T2 cruza medianoche. Resolver por el día de la grilla manda la madrugada al turno equivocado
(12h después) — **no es teórico: el registro 4722 de prod (GEC3, P3, grilla del 07-14) pertenece al
turno del 07-13**, y el join ingenuo lo mandaba al del 07-14. **NO** se resuelve contra
`inicio_nominal`/`fin_nominal` guardados: `extenderTurno` ([[D-046]]) los MUTA, así que las ventanas
almacenadas se solapan y dejan de particionar; la definición del dominio sí es estable.

**(4) `evento_dashboard` huérfano — y por qué no hay FK.** Vaciar una celda hacía `activa=0` + DELETE
del borrador, dejando `registro_origen_id` colgando: 35 filas en prod (07-06) = **exactamente** la
discrepancia reportada. Borrar el borrador es correcto por diseño (`DELETE /api/registros/:id`
tampoco archiva: el borrador es mutable, solo lo *cerrado* es inmutable). Lo incorrecto era el
puntero. Ahora se **borra** la fila (para el dashboard, que filtra `activa=1`, borrar y desactivar
son indistinguibles); el soft-delete sigue siendo correcto en `cerrarDiaMand`, donde el origen no
desaparece sino que migra al histórico. **No puede haber FK**: el origen vive en `registro_activo` y
migra a `registro_historico` — dos padres posibles. La integridad se sostiene en código + test.

**(5) El guardrail de [[D-041]] llevaba tiempo inerte, por dos motivos independientes.** (a) Su
`stripComments` partía con `.split('\n')`, dejando un `\r` (el repo es CRLF); en JS el `.` de una
regex **no matchea `\r`**, así que en `//.*$` el `.*` frenaba antes del `\r` y `$` —sin flag `m`—
solo ancla al final del string: nunca había match y **el strip no borraba nada**. No producía falsos
negativos (no strippear lo hace más estricto), pero bastaba documentar un patrón prohibido en un
comentario para romperlo. (b) **Nunca estaba enganchado**: `guard_no_prod_disp_destruction` no
figuraba en el script `test` — el guard escrito para blindar prod jamás corría. Ambos corregidos, con
meta-tests que fijan que el strip funciona y que el detector dispara.

**(6) Guardrail nuevo `guard_no_prod_historico_destruction`.** Regla única: todo DELETE/UPDATE sobre
tabla operativa (`registro_historico`/`registro_activo`/`evento_dashboard`/`mand_cierre_log`) debe
llevar un acotador de fixture (`TEST_PLANTA`, `TEST_TAG`, `es_sintetico`, o PK-equality) **léxicamente
visible** en la ventana del statement — mira hacia atrás además de adelante porque en `mssql` el
binding vive en los `.input(...)` que preceden al `.query(...)`. Acepta alias verificables
(`const P = TEST_PLANTA_ID`) pero **no** alias a planta real: ese es justo el patrón que causó todo.

**Reparación de datos (`F31.A1`, idempotente):** backfill de `turno_id` en MAND (espejo SQL de
`fechaOperativaDePeriodo`; lo no resoluble se deja NULL — nunca se adivina, criterio [[D-053]]) +
purga de `evento_dashboard` huérfano **solo si `activa=0`** (una fila activa jamás se toca). Toca
`registro_historico` como excepción a RF-032, igual que F30.A1: es trazabilidad, no altera valores,
autores ni fechas. **Verificado en prod:** 10/10 `turno_id` backfilleados —con el 4722 resuelto al
turno correcto del 07-13, no al ingenuo del 07-14—, 35 huérfanas purgadas (45 → 10 filas), 0 filas
activas perdidas.

**Consecuencias:** (a) La suite de MAND ya corre contra prod sin destruir nada — verificado
ejecutándola repetidamente y comprobando que el histórico queda idéntico al baseline (176/2/137/49/9/
10/16/24). (b) **Los tests de MAND viven todos en `sala_de_mando_batch.test.js`, no en un archivo
aparte**: `setupSessions()` desactiva las otras sesiones del mismo usuario-fixture (sesión única,
[[D-035]]), así que dos archivos que compartan la fixture se invalidan la sesión mutuamente
(401 "Sesión no válida") apenas se solapan. Un archivo = un dueño de la fixture. (c) El front dejó de
propagar metadata por `periodos`, y `periodoActual` salió del diff (menos re-renders). (d) Sigue
**pendiente** el mismo patrón peligroso en `consumo_combustible` (3 suites escriben en GEC3/GEC32 con
fechas fijas): su raíz es idéntica —`combustibles.js` hardcodea `['GEC3','GEC32']`— y su fix es el
mismo, pero exige sembrar el catálogo de combustibles para TST. Cross-ref: [[D-030]] (planta de test),
[[D-041]] (guardrail DISP), [[D-045]] (entidad turno), [[D-046]] (extensión muta `fin_nominal`),
[[D-019]] (`modificado_por` solo por valor).

---

## D-059 — Rol "USUARIO DE CONSULTA": observador solo-lectura e invisible (`cargo.es_observador`)

**Fecha:** 2026-08-10

**Contexto:** se necesita un rol de supervisión que vea TODO (bitácoras, históricos, Op24h, COMB,
DISP) sin interactuar: no participa en conformaciones de turno, no finaliza turno y no aparece como
usuario activo para los operadores. El Gerente de Producción (solo-lectura por matriz) no basta:
su sesión deja huella en 7 superficies genéricas (`WHERE activa=1` sin mirar cargo) — panel
CONECTADOS (HTTP+WS), `preview-masivo` (figuraría pendiente ETERNAMENTE al nunca finalizar),
`usuarios-en-bitacora`, `ingenieros_snapshot` (histórico inmutable), `turno_participante` →
conformación, y el `hayPersonal` del auto-cierre (su presencia impediría `AUTO_SIN_PERSONAL`).

**Decisión:** flag data-driven **`lov_bit.cargo.es_observador`** (MERGE auto-corrector en cada
arranque; NUNCA se filtra por nombre de cargo), expuesto en el objeto-sesión por los DOS espejos
(`SELECT_SESION` de `middleware/auth.js` ↔ SELECT final de `utils/sesion-contexto.js`) y evaluado
por el helper `esObservador()` (`middleware/permissions.js`). Invisibilidad en dos capas:
**(1) prevención** — `establecerContextoSesion` (chokepoint único de contexto, cubre select-context
y cambiar-unidad) no resuelve ni abre turno para el observador: sesión con `turno_id=NULL`, sin
`marcarParticipante`, y `POST /api/bitacora/abrir` responde 200 no-op sin fila `sesion_bitacora`;
**(2) defensa en profundidad** — `AND c.es_observador = 0` en usuarios-activos (HTTP y WS, espejos
comentados), `preview-masivo`, `usuarios-en-bitacora`, `snapshotIngenieros(DelDia)` (se SUMA al
`NOT IN` de identidad, no lo reemplaza), el INSERT de conformación de `cerrarTurno` (junto al
filtro `es_sintetico` de [[D-044]], sin escape hatch), `buildConformacionSnapshot`, `hayPersonal`
de `transicionarTurnosVencidos` y la vista `v_ingenieros_en_turno`. Gates 403 estables:
`observador_sin_finalizacion` (finalizar/revertir) y `observador_solo_lectura` (IA). La escritura ya
la niega la matriz (`[puede_ver=1, puede_crear=0]` en toda bitácora, cláusulas junto al Gerente).
Entra: App Role `USUARIO_CONSULTA` → cargo homónimo, ÚLTIMO en `PRECEDENCE`. `puede_cambiar_unidad=1`
(atajo GEC3↔GEC32: rol 100 % lectura, sin riesgo). Front: `esObservador` deriva de la sesión —
oculta Finalizar/Revertir, no finaliza al salir, no llama `/abrir`, queda EXENTO del modal
bloqueante de transición ([[D-046]] no le aplica: no escribe) y muestra chip "Solo consulta".

**Consecuencias:** el observador es invisible para la operación y neutro para el ciclo de turnos
(su login no abre cabeceras y no bloquea auto-cierres). Pendiente al reconciliar con main (D-056/58):
permitirle la descarga del libro F03 (`puede_crear OR es_observador` en el gate de
`reporte-mensual`) — decidido que SÍ descarga, la feature no existe en esta base. Los dos pares de
espejos (sesión y HTTP/WS) deben cambiar JUNTOS. Tests: `rol_usuario_consulta.test.js` fija flags,
matriz, gates e invisibilidad (con controles positivos); `entra_roles` pasa a 14 roles. Cross-ref:
[[D-039]] (mismo principio data-driven, sin bypass), [[D-040]], [[D-044]], [[D-045]], [[D-054]].

---

## D-060 — El periodo 24 del carbón GEC32 nunca se cargaba: `completo` pasa a significar 24/24 y el sweeper repesca "ayer" en cada tick

**Fecha:** 2026-08-25

**Contexto:** la grilla COMB de GEC32 mostraba la fila P24 (23h) vacía TODOS los días aunque la
unidad generara las 24 horas (prod: 08-10→08-20 con despacho P24 = 250 MW y ~241 MWh en la hora 23,
0 celdas P24). Auditoría en `PortalG3_dev` y `PortalG3`: 41 días de prod (53 de 68 en
`sis_scrape_log`) terminaban `ultimo_periodo=23, completo=1`; los únicos días con P24 eran los que
rescató el catchup de "ayer" al reiniciar el server al día siguiente. **No había desfase de hora**:
el mapeo `periodo p ↔ [p-1, p)` cuadra hora a hora contra `dashboard.generacion_periodos` (bajones
de MWh y de carbón coinciden; en la parada del 08-21 a las 10:29 la última celda es P10) y el SIS
sí sirve el P24 (`t2` = 00:00 del día siguiente). Tres defectos encadenados en el scraper: (1) el
horizonte de "hoy" es `1..horaBogotaActual()` ∈ 0..23, y el P24 (23:00→00:00) solo es legible
cuando ya es "mañana", momento en que el sweeper solo barre `hoy`; (2) `completo` se calculaba
contra ese horizonte truncado (`ultimoOk === nEsperado`), así que el tick de las 23h dejaba
`completo=1` — y un reinicio a las 15h, `completo=1` con `ultimo_periodo=15`; (3) la única repesca
(catchup de "ayer") corría solo en el primer tick tras un reinicio y gateada por ese flag mentiroso
→ nunca se disparaba. Además `setTimeout(tick, 1h)` tras cada corrida derivaba ≈ la duración del
scrape (4-5 min/día) y, al cruzar medianoche, perdía también el P23 (08-10 quedó en 22).

**Decisión:** (a) **`sis_scrape_log.completo` ⇔ 24 periodos sin errores**, nunca "hasta la hora
actual" (para `hoy` con `soloHoy` queda siempre 0); (b) `scrapeDia` gana `periodoDesde` (solo se
honra si el log previo es contiguo — `periodos_error=0 && ultimo_periodo=periodoDesde-1` —, si no
cae a 1; el log acumula `periodos_ok`/`ultimo_periodo`) y un reloj inyectable `ahora` para testear
el caso "hoy" sin tocar la fecha real; (c) el sweeper (`sis-sweeper.js`) **repesca "ayer" en CADA
tick** cuando `necesitaCatchup` (sin fila, `completo=0` o `ultimo_periodo≠24`) pidiendo solo
`ultimo_periodo+1..24` — en operación normal 1 fetch del P24 a las 00:02 — y luego barre `hoy` como
antes; (d) el tick se alinea a **HH:02 Bogotá** (`msHastaProximaMarca`, helpers puros en
`sis-sweeper-helpers.js` fijados por `sis_sweeper.test.js`); (e) migración **F33.A1** baja a
`completo=0` toda fila que no tenga 24/24 (dev 24, prod 62) para que sweeper y backfill las vean
pendientes; (f) CLI `server/scripts/backfill-carbon-gec32.js` (E7 reducido, resumible, `--dry-run`,
`--full`, guardrail `--confirm-db` = `DB_NAME`, `--to` ≤ hoy−2 para no competir con el tick) que
completa los días históricos con los periodos que faltan. **Regla dura:** nunca gatear una repesca
con un flag que dependa de la hora actual; la hora 24 de un día solo existe al día siguiente.

**Consecuencias:** el P24 aparece ~00:02 del día siguiente en vez de nunca; un reinicio a media
tarde ya no "cierra" el día (el tick siguiente lo completa desde `ultimo_periodo+1`); el barrido de
`hoy` sigue re-leyendo `1..H` cada hora (optimizarlo con `periodoDesde` es follow-up, igual que el
DELETE de celdas SIS-owned cuando la lectura de fin de hora da fuera de servicio — FOLLOW-UP AUD-14
— y la carga histórica pre-2026-06-02 de E7). `DB_NAME_PROD` del `.env` es una variable **inerte**
(nadie la lee): prod se selecciona con `DB_NAME`. Tests: `sis_scraper_ownership` +4 (T7 horizonte
de hoy sin P24 y `completo=false`, T8 `periodoDesde=24` = 1 fetch y 24/24, T9/T10 no contiguo o
con errores ⇒ día completo), `sis_sweeper.test.js` nuevo (11, puros). Cross-ref: [[D-027]] (COMB),
[[D-029]] (scraper SIS), [[D-034]] (`cantidad_max`, el scraper clampa), [[D-055]] (misma familia:
un bug de horizonte temporal que solo se ve auditando datos).

---

## Apéndice — Roadmap ejecutado: F1–F22

| Fase | Tema | Estado |
|---|---|---|
| F1 | Modelo de turnos (06:00/18:00, 2 turnos) | Ejecutada |
| F2 | Sesión persistente + sesion_bitacora | Ejecutada |
| F3 | Bitácora CIET (auditoría auto) | Ejecutada |
| F4 | Cierre cronológico por turno | Ejecutada |
| F5 | Renombrar contrato → `evento_dashboard` | Ejecutada |
| F6 | Bitácora MAND (Operación 24h) inicial | Ejecutada |
| F7 | Cancelar autorización vaciando celda | Ejecutada |
| F8 | Dashboard consume `evento_dashboard` | Ejecutada |
| F9 | Limpieza vista compat + heartbeat/resume | Ejecutada |
| F10 | Paginación MAND entre días | **Obsoleta por F17** |
| F11 | Filtros fecha+turno bitácoras genéricas | Ejecutada |
| F12 | DISP backend (mini-dashboard) | Ejecutada |
| F13 | DISP frontend | Ejecutada |
| F14 | DISP cimientos cross-repo (`disponibilidad_dashboard`) | Ejecutada |
| F15 | Badge DISP en dashboard productivo | **Pendiente** (en `dashboard-gen-gec3`) |
| F16 | MAND batch save + sweeper diario | Ejecutada |
| F17 | MAND frontend refactor (buffer, multi-select, lock REDESP) | Ejecutada |
| F18 | MAND cleanup + docs | Ejecutada |
| F19 | TZ backend bugs (T1, T2) | Ejecutada |
| F20 | TZ frontend formatters (T5, T6, T7) | Ejecutada |
| F21 | TZ tests (matriz TZ vitest) | Ejecutada |
| F22 | TZ cleanup + docs (vista compat BD) | Ejecutada |

---

## Próximas decisiones pendientes

- **F15**: definir cómo el dashboard productivo va a renderizar el badge de disponibilidad por planta. Ver `dashboard-gen-gec3/docs/decisions.md` cuando se aborde.
- **T3 (CIET `fecha_cerrada`): CERRADO 2026-05-13 — formato Bogotá.** El sweeper diario corre a 23:59:59 hora Bogotá (= 04:59 UTC del día siguiente); registrar `fecha_cerrada` en UTC desfasaría el día operativo (un cierre del 2026-05-13 23:59 Bogotá quedaría como 2026-05-14 04:59 UTC). Implementación: `server/utils/ciet.js:184-186` usa `fechaBogotaStr(fecha)` desde F19. Este es el único campo de la BD que NO es UTC; documentado como excepción justificada al patrón global "BD en UTC, presentación con offset Bogotá" (D-020).
- **T4 (cierre cronológico tiebreaker): CERRADO 2026-05-13 — `ORDER BY fecha_evento ASC, registro_id ASC`.** Razón: dos registros con `fecha_evento` idéntica (posible en batch insert con un mismo `SYSUTCDATETIME()` o seeds) producían orden no-determinístico en SQL Server. Tiebreaker `registro_id ASC` garantiza determinismo. Aplicado en el cierre de turno (`server/routes/cierre.js`). Test de regresión: `server/tests/fechas_bogota.test.js::C5`.
