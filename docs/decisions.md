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

**Consecuencias:** `POST /api/cierre/bitacora` devuelve 400 para MAND (front oculta los tres botones de cierre del header — "Finalizar Turno", "Cerrar Turno" individual y "Cerrar Masivo" — quedando solo "Guardar"; back defensa en profundidad). `GET /api/sala-de-mando/dias-pendientes` eliminado. MAND solo muestra HOY; no hay paginación entre días. F10 (paginación) queda explícitamente obsoleta — `prompts/F10.md` marcado `[OBSOLETO POR F17]`. Ajuste 2026-05-15: el botón "Cerrar Turno" individual quedó sin gate `!isMand` al rebrand y se agregó.

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

**Contexto:** la operación necesita registrar el consumo diario-horario de carbón (por alimentador), caliza y ACPM en cada planta para alimentar reportes regulatorios y de eficiencia. No es una bitácora (no hay estado ni cierre de turno); es un report numérico estructurado por (planta, fecha, periodo). El esquema es asimétrico entre plantas: GEC3 tiene 6 alimentadores nombrados (A–F) y GEC32 tiene 8 numerados (1–8), más caliza y ACPM en ambas. La spec original (`carbon.md`) lista las columnas pedidas.

**Decisión:** modelar como pestaña nueva categoría jerárquica "Combustibles" en el sidebar, con un solo ítem "Consumos" por ahora. Storage en tablas dedicadas siguiendo el patrón híbrido que [[D-026]] establece para DISP: fila marcadora en `lov_bit.bitacora` (codigo `COMB`) para reusar permisos+sidebar+routing, pero datos en tablas propias — catálogo `lov_bit.combustible(planta_id, codigo, nombre, unidad, tipo, orden, activo)` y transaccional `bitacora.consumo_combustible(planta_id, fecha, periodo, combustible_id, cantidad, ...)` en formato long (1 fila por celda) para soportar el catálogo dinámico por planta. Vista `bitacora.v_consumo_periodo` deriva el formato wide para reportes/dashboard y calcula `total_carbon_ton = SUM(tipo='ALIMENTADOR')` sin duplicar storage. Permisos: crean `Operador de Planta - Carbón y Caliza` + `Ingeniero Jefe de Turno`; resto solo ven. Ventana de edición: fecha pasada o hoy; futuro rechazado con `400 fecha_futura`. Auditoría liviana: solo `creado_por`/`modificado_por` (sin snapshots de personal). Migración idempotente `F26.B1` en `initDB()` crea tablas + vista + 18 seeds de combustibles + fila bitácora COMB + permisos seedeados. La matriz canónica de permisos (`cargo_bitacora_permiso`, reconstruida en cada arranque) se extendió con CASE clauses para COMB → los permisos sobreviven a futuros restarts sin depender del flag F26.B1.

**Consecuencias:** (a) categoría jerárquica del sidebar gana una entrada (extensible — futuros ítems pueden agruparse acá). (b) `SIN_BADGE_CODIGOS` se extiende con `'COMB'` (consumos no tiene "pendientes"). (c) Header (`BarraEstado`) tratamiento equivalente a MAND: oculta filtros F11 + botones de turno/cierre — el botón Guardar vive dentro del propio `ConsumosGrid`. (d) Para agregar/quitar un combustible: editar `db.js` (seed + matriz si afecta permisos) + redeploy. Sin UI admin (el catálogo cambia raramente). (e) `modificado_por` se actualiza solo si `cantidad` cambió, no si solo cambió `detalle` — paridad con [[D-019]] de MAND. (f) Frontend bajo `src/components/Combustibles/`: `ConsumosGrid.jsx` (grilla buffer/snapshot/diff + Total Carbón virtual), `SelectorFecha.jsx` (←/→/Hoy con max=today), `useCombustibles.js` (hook con `getCatalogo/getConsumos/guardarBatch` contra `api.*`). Cross-ref: [[D-021]] (categorías hardcoded), [[D-022]] (SIN_BADGE_CODIGOS), [[D-026]] (patrón híbrido bitácora marcadora + tabla propia).

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
