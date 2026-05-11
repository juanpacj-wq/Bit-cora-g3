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

**Consecuencias:** MAND y DISP están explícitamente excluidos del cierre cronológico (cada uno tiene su propia mecánica). Edge case T4 (turnos solapados ordenados por UTC) declarado deuda en `BIT-MODBD-2026-001.md`.

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

**Consecuencias:** `POST /api/cierre/bitacora` devuelve 400 para MAND (front oculta botón, back defensa en profundidad). `GET /api/sala-de-mando/dias-pendientes` eliminado. MAND solo muestra HOY; no hay paginación entre días. F10 (paginación) queda explícitamente obsoleta — `prompts/F10.md` marcado `[OBSOLETO POR F17]`.

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

**Consecuencias:** bugs T1 (grilla MAND vacía 19:00–23:59), T2 (sweep TTL dependiente de TZ host), T5-T7 (formatters frontend) corregidos en F19/F20. Edge case T4 (cierre cronológico ORDER BY UTC) declarado deuda. Vista compat BD con columnas calculadas `_bogota AS DATEADD(-5, ...)` para queries SSMS. Tests con matriz TZ (UTC, Bogotá) en F21.

---

## D-021 — Roadmap ejecutado: F1–F22

| Fase | Tema | Estado |
|---|---|---|
| F1 | Modelo de turnos (06:00/18:00, 2 turnos) | Ejecutada |
| F2 | Sesión persistente + sesion_bitacora | Ejecutada |
| F3 | Bitácora CIET (auditoría auto) | Ejecutada |
| F4 | Cierre cronológico por turno | Ejecutada |
| F5 | Renombrar contrato → `evento_dashboard` | Ejecutada |
| F6 | Bitácora MAND (Sala de Mando) inicial | Ejecutada |
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
- **T3** (CIET `fecha_cerrada` en UTC vs Bogotá): pendiente decisión en B5 de `preguntasfecha.md` original. Por ahora UTC.
- **T4** (cierre cronológico ORDER BY UTC): deuda documentada, edge case poco probable.
