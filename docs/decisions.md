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

**Decisión:** el cierre individual y masivo agrupa registros por `(planta, turno, bitacora)` y usa `ventanaTurno(turno, fecha_referencia)` para decidir cuáles cerrar. `fecha_cierre_operativo = CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)`.

**Consecuencias:** MAND y DISP están explícitamente excluidos del cierre cronológico (cada uno tiene su propia mecánica). Edge case T4 (`fecha_evento` idéntica) resuelto 2026-05-13 con tiebreaker `, registro_id ASC` en el `SELECT TOP 1` (cierre individual + masivo).

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
- **T4 (cierre cronológico tiebreaker): CERRADO 2026-05-13 — `ORDER BY fecha_evento ASC, registro_id ASC`.** Razón: dos registros con `fecha_evento` idéntica (posible en batch insert con un mismo `SYSUTCDATETIME()` o seeds) producían orden no-determinístico en SQL Server. Tiebreaker `registro_id ASC` garantiza determinismo. Aplicado en `server/server.js:1741` (cierre individual) y `:1840` (cierre masivo). Test de regresión: `server/tests/fechas_bogota.test.js::C5`.
