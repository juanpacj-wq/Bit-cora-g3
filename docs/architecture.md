# Arquitectura — Bit-cora-g3

Sistema web de bitácoras operativas para plantas térmicas GECELCA-3 (GEC3 y GEC32). Reemplaza el registro manual en Excel con trazabilidad, control de turnos y un contrato de eventos hacia el dashboard productivo.

Documentos autoritativos para el modelo de datos y RFs detallados: `BIT-MODBD-2026-001.md` y `BIT-RF-2026-001.md` en la raíz del repo. Este archivo resume lo que un agente necesita para trabajar sin tener que abrirlos.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 19, Vite 5, TailwindCSS 3, lucide-react |
| Backend | Node.js ≥20 ESM, **Express** (modelo de routing único, D-037): `session → cors → csrf → auth OIDC (D-031) → requireEntra → express.json → routers de dominio (`routes/*.js`) → 404 → errorHandler`; `--env-file` |
| BD | SQL Server 2019+ (driver `mssql` con `useUTC=true`) |
| Tests | `node:test` (backend), Vitest (frontend, pendiente) |
| Build frontend | Vite (`npm run dev`, `npm run build`) |
| Backend dev | `node --watch --env-file=../.env server.js` (puerto 3002) |

Frontend habla solo con `/api/*` (proxy de Vite en dev → `localhost:3002`).

---

## Schemas SQL Server

Dos esquemas en la base `bitacora_gec3`:

- **`lov_bit`** (lista de valores / catálogos): `usuario`, `cargo`, `planta`, `bitacora`, `tipo_evento`, `cargo_bitacora_permiso`.
- **`bitacora`** (transaccional): `registro_activo`, `registro_historico`, `sesion_activa`, `sesion_bitacora`, `evento_dashboard`, `disponibilidad_dashboard`, `mand_cierre_log`, `migracion_aplicada`.

### Tablas clave

| Tabla | Propósito |
|---|---|
| `bitacora.registro_activo` | Eventos vigentes (no cerrados). En DISP, el filtered unique index `UQ_disp_vigente_por_planta` garantiza una sola fila por planta con `fecha_fin_estado IS NULL`. |
| `bitacora.registro_historico` | Eventos cerrados. Inmutable salvo la excepción controlada de DISP (PUT vigente que ajusta `fecha_fin_estado` del N-1 histórico). |
| `bitacora.sesion_activa` | Login por usuario. `activa=0` solo en logout explícito. TTL ya NO es vivo: la sesión persiste hasta cierre explícito (F2). |
| `bitacora.sesion_bitacora` | Una fila por `(sesion_id, bitacora_id)` con `finalizada_en NULL` mientras está abierta. Reemplazó el modelo viejo de "usuarios activos por heartbeat". UNIQUE `(sesion_id, bitacora_id)`. |
| `bitacora.evento_dashboard` | **Contrato hacia dashboard-gen-gec3** para AUTH/REDESP/PRUEBA. UPSERT por `(planta_id, fecha, periodo, tipo)`. `tipo CHECK IN ('AUTH','REDESP','PRUEBA')`. `activa=0` en soft-delete. Ver `../../docs/interfaces-cross-repo.md`. |
| `bitacora.disponibilidad_dashboard` | **Contrato hacia dashboard-gen-gec3 para DISP** (separado de `evento_dashboard` porque DISP no tiene periodo). PK = `planta_id` (una fila por planta, UPSERT en cada cambio). |
| `bitacora.mand_cierre_log` | Idempotencia del sweeper diario MAND. PK `(fecha_cerrada, planta_id)`. |
| `bitacora.migracion_aplicada` | Flags de migraciones idempotentes one-time. |

### Convención de columnas comunes (auditoría)

`registro_activo` y `registro_historico` comparten:

- `creado_por INT`, `creado_en DATETIME2` — autor original.
- `modificado_por INT NULL`, `modificado_en DATETIME2 NULL` — último editor (solo se actualiza si `valor_mw` cambió en MAND, según regla 2b).
- `jdts_snapshot`, `jefes_snapshot`, `ingenieros_snapshot` — **JSON inmutable** del personal presente en el momento del evento. Nunca FK directo a `lov_bit.usuario` salvo `creado_por`/`modificado_por`. (Decisión D-001 en `decisions.md`.)
- `fecha_evento DATETIME2` — siempre UTC en BD (`SYSUTCDATETIME()`). Conversión a Bogotá en presentación o comparaciones (`DATEADD(HOUR, -5, ...)`).
- `fecha_fin_estado DATETIME2 NULL` — solo poblado para DISP; para el resto siempre NULL.

---

## Backend — estructura

```
Bit-cora-g3/server/
├── server.js                  Bootstrap: initDB → buildAuthApp → http.Server (WS) → sweepers → listen (D-037)
├── auth/app.js                Compositor Express: sesión + /auth OIDC + requireEntra + montaje de routers
├── db.js                      Conexión + initDB() idempotente (DDL, seeds, migraciones)
├── middleware/
│   ├── auth.js                loadSession() lee la sesión de app (sesion_activa) por identidad Entra
│   └── permissions.js         puedeCrear, puedeVer, puedeCerrarTurno, etc.
├── routes/                    Endpoints por dominio (Express); _middleware.js (requireEntra/loadAppSession/asyncH), _shared.js
├── utils/
│   ├── turno.js               colombiaParts, getTurnoColombia, turnoFromPeriodo, ventanaTurno + helpers de fecha/TZ Bogotá (consolidados en F19; NO existe server/utils/fecha.js)
│   ├── snapshots.js           snapshotJDTs/Jefes/Ingenieros (JSON agregado)
│   ├── notificador.js         find/upsert sobre evento_dashboard y disponibilidad_dashboard
│   ├── ciet.js                registrarEventoCierre (helper compartido)
│   ├── mand-sweeper.js        Cron interno c/60s, detecta cambio de día Bogotá → cerrarDiaMand()
│   ├── turno-sweeper.js       (legacy o coexistente — revisar al tocar)
│   └── ...
└── tests/                     node:test (helpers, auth, disponibilidad, mand batch)
```

### Endpoints principales

| Método + Path | Propósito |
|---|---|
| `POST /api/auth/login` | Login. Crea `sesion_activa`. |
| `POST /api/auth/logout` | Setea `sesion_activa.activa=0`. |
| `POST /api/bitacora/abrir` | UPSERT en `sesion_bitacora`. Idempotente. (F2) |
| `POST /api/bitacora/finalizar` | Finaliza TODAS las `sesion_bitacora` del usuario. Emite CIET tipo 'Finalización'. |
| `GET /api/bitacora/usuarios-en-bitacora` | Para popups de F4 cierre cronológico. |
| `GET /api/registros/activos` | Eventos vigentes con filtros client-side. |
| `POST /api/registros` | Crear evento. Rama especial para DISP (ver flujo transaccional). |
| `PUT /api/registros/:id` | Editar. Rama especial DISP (side-effect en N-1). |
| `DELETE /api/registros/:id` | Eliminar. |
| `POST /api/cierre/bitacora` | Cierre individual por bitácora+turno. **Devuelve 400 si `bitacora.codigo='MAND'`**. |
| `POST /api/cierre/masivo` | Cierra todas las bitácoras del turno (`b.codigo NOT IN ('DISP','MAND')`). |
| `GET /api/disponibilidad?planta_id=` | Vista mini-dashboard DISP (vigente + historial paginado). |
| `POST /api/disponibilidad/deshacer` | Borra vigente + restaura último histórico. Emite CIET 'Deshacer disponibilidad' con audit completo. |
| `GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=` | **D-024/D-026** — tiempo agregado por estado + acumulados (`disponible`, `no_disponible`) en una ventana + `ahora` (reloj UTC del server). Lee directo de `bitacora.disponibilidad_estado` (la vista `v_disp_intervalos` se dropeó en D-026). Consumido por el panel "Acumulado histórico por estado" del mini-dashboard (D-028). |
| `GET /api/sala-de-mando?planta_id=&fecha=` | Grilla MAND del día (siempre hoy). |
| `POST /api/sala-de-mando/guardar` | **Batch atómico**. Body `{planta_id, fecha, filas:[{tipo, detalle, funcionariocnd, periodos:[{periodo, valor_mw}]}]}`. Transacción única. (F16) |
| `POST /api/sala-de-mando/cierre-diario` | Trigger manual del sweeper (tests, recovery). Requiere `puede_cerrar_turno`. |
| `GET /api/eventos-dashboard?tipo=&planta_id=` | Endpoint hacia dashboard-gen-gec3. `tipo ∈ {AUTH,REDESP,PRUEBA}` lee de `evento_dashboard`; `tipo=DISP` lee de `disponibilidad_dashboard`. |
| `GET /api/catalogos/jdt-actual` | Para autocompletado. Lee `sesion_bitacora` con `finalizada_en IS NULL`. |

### Eliminados / obsoletos

- `POST /api/auth/heartbeat`, `POST /api/auth/resume` (F2/F9): el modelo de sesión persistente reemplaza el heartbeat.
- `GET /api/sala-de-mando/dias-pendientes` (F17): MAND solo muestra HOY; no hay paginación entre días.

---

## Frontend — estructura

```
Bit-cora-g3/src/
├── main.jsx                       Entry point
├── BitacorasGecelca3.jsx          Layout principal, routing por bitácora.codigo, header con controles
├── theme.js / colores.js          Paleta corporativa
├── components/
│   ├── GrillaRegistros.jsx        UI genérica para bitácoras con formulario_especial=0
│   ├── SalaDeMando/SalaDeMandoGrid.jsx  UI especial MAND (formulario_especial=1)
│   ├── Disponibilidad/
│   │   ├── DisponibilidadDashboard.jsx  UI especial DISP (orquestador)
│   │   ├── EstadoActualCard.jsx
│   │   ├── AcumuladosPorEstado.jsx  Panel acumulado histórico por estado (D-028)
│   │   ├── HistorialList.jsx
│   │   ├── CambiarEstadoModal.jsx
│   │   ├── TiempoEnEstado.jsx     Counter live (setInterval 1s); exporta formatDiff + useTiempoTranscurrido
│   │   └── colores.js             Paleta de estados DISP
│   ├── historicos/HistoricoTable.jsx
│   └── BarraEstado.jsx            Filtros F11 (fecha+turno) — NO se renderiza para DISP. En MAND se renderiza pero oculta filtros/cierres (la grilla solo muestra HOY) y muestra contador "X registros" sincronizado con el badge.
└── hooks/
    ├── useAuth.js                 Login, logout, sesión persistente
    ├── useBitacoraSesion.js       POST /api/bitacora/abrir al montar
    ├── useUsuariosActivos.js      WS de "usuarios en turno"
    ├── useDisponibilidad.js       getEstado/getMetricas/crear/editar/deshacer para DISP
    ├── useSalaDeMando.js          getGrilla + guardarBatch
    └── useApi.js                  fetch base con manejo de errores estructurados
```

### Routing por bitácora

En `BitacorasGecelca3.jsx`:

```jsx
{bitacora?.codigo === 'MAND' ? <SalaDeMandoGrid ... /> :
 bitacora?.codigo === 'DISP' ? <DisponibilidadDashboard ... /> :
 <GrillaRegistros ... />}
```

El header con controles (`Buscar`, `Todos los tipos`, `+ Nuevo Registro`, `Finalizar Turno`, `Cerrar Turno`, `Cerrar Masivo`) se renderiza condicionalmente: `bitacora?.codigo !== 'MAND'`. **En MAND, el único botón de acción del header es "Guardar"** (controlado por `hayCambios` lift-up del child). Todos los cierres están ocultos porque MAND se cierra automáticamente al fin del día vía sweeper (`server/utils/mand-sweeper.js`); el backend además rechaza `POST /api/cierre/bitacora` con `400 mand_cierre_individual_no_permitido`.

### Popup "Usuarios activos" (Header)

Botón con contador en la barra superior; abre un popup portal (id `header-users-popup`) con:

- Cabecera fija (`Conectados (N)` + contador de coincidencias cuando hay filtro).
- Buscador por nombre (`autoFocus`, case-insensitive sobre `nombre_completo`).
- Lista scrolleable acotada a `max-h: 22rem` (≈ 6 filas) — el resto se ve con la rueda del mouse o la barra del propio `<ul>`.

El popup se cierra con: Esc, click fuera (botón y popup quedan excluidos por `contains`), `resize`, y `scroll` de la página (listener en captura). Cuando el listener de scroll dispara, **se filtra el evento si su `target` es el `<ul>` del popup o un descendiente** — sin ese filtro, mover la rueda dentro del listado o arrastrar su barra de scroll cerraba el popup (regresión documentada). Ver `Header` en `src/BitacorasGecelca3.jsx`.

---

## Mecánica por bitácora

### MAND (Operación 24h)

**Diferenciadora:** grilla 24 periodos × 3 tipos × 2 plantas con batch save atómico. NO acepta cierre individual ni masivo — se cierra automáticamente vía sweeper diario.

**Modelo de guardado (frontend):**

1. Al montar: `GET /api/sala-de-mando?planta_id=&fecha=<hoy_Bogota>` → `setSnapshot` + clonar a `buffer`.
2. Al editar celda: `setBuffer(...)`. NADA va al backend.
3. Diff(snapshot, buffer) determina si el botón "Guardar" está habilitado.
4. Click "Guardar" → `POST /api/sala-de-mando/guardar` con solo el diff → re-fetch → reset snapshot+buffer.
5. `beforeunload` confirm si hay cambios pendientes.
6. Tras `guardarBatch` ok, el hook emite `bitacora:counts-refresh` (CustomEvent en `window`). Consumidores: `useBitacoraCounts` refetchea `/api/bitacora/counts` (badge del tab), y `BitacorasGecelca3` refetchea `/api/registros/activos` para la bitácora activa (sincroniza el contador "X registros" de `BarraEstado` con el badge).

**Backend atómico (`POST /api/sala-de-mando/guardar`):**

Por cada `(tipo, periodo)` del diff:
- existe + `valor_mw != null` + `valor_mw` distinto → UPDATE + `modificado_por=sesion.usuario_id` + UPSERT `evento_dashboard`.
- existe + `valor_mw == null` → DELETE + `evento_dashboard.activa=0`.
- no existe + `valor_mw != null` → INSERT + UPSERT `evento_dashboard`.
- `valor_mw` no cambió pero detalle/funcionariocnd sí → UPDATE solo campos compartidos, NO toca `modificado_por`.

Todo en una transacción única. Si algo falla, rollback completo. Devuelve `{ resumen: { creados, actualizados, eliminados } }` o `400 { errores: [{tipo, periodo?, motivo}] }`.

**Validaciones de negocio (errores específicos):**

- `fecha_no_es_hoy` (solo HOY editable).
- `periodo_bloqueado` (REDESP requiere `periodo >= floor(hora_bogota) + 1`, "periodo actual o posteriores").
- `funcionariocnd_requerido` (AUTH con al menos un valor exige funcionariocnd).
- `funcionariocnd` en PRUEBA/REDESP → server lo fuerza a NULL silenciosamente (no es error).
- `valor_mw_invalido`, `periodo_fuera_rango`, `tipo_invalido`, `periodos_invalido`.

**Lock REDESP (frontend):**

- `isLocked(tipo, periodo) = tipo === 'REDESP' && periodo < periodoActual`.
- `periodoActual = floor(horaBogota()) + 1`, recalculado cada 60s con `setInterval`.
- Celdas locked: `disabled` + tooltip "Solo se pueden registrar redespachos para el periodo actual o posteriores".

**Multi-select Excel-like:**

- Shift+click → rango. Ctrl/Meta+click → toggle individual. Drag con `onMouseEnter` → expandir.
- Enter en cualquier celda seleccionada → replica valor a toda la selección.
- Cross-tipo prohibido: clickear otra fila descarta la selección anterior.
- Esc o clic fuera de la tabla limpia.
- Visual: `border 2px solid <color tipo>`.

**Cierre automático (`server/utils/mand-sweeper.js`):**

- `setInterval(check, 60_000)`. Compara `todayBogota()` con `lastFechaCheck` cacheado.
- Al detectar cambio de día: ejecuta `cerrarDiaMand({ fecha: ayer, planta_id })` para GEC3 y GEC32.
- `cerrarDiaMand` es idempotente vía `bitacora.mand_cierre_log` (PK `(fecha_cerrada, planta_id)`): chequea antes, omite si ya cerrado.
- Pasos de cierre (transacción): INSERT en `registro_historico` con `estado='cerrado'`, DELETE de `registro_activo`, `UPDATE evento_dashboard SET activa=0`, emite CIET con autor `SISTEMA` y snapshots agregados del día (`SELECT DISTINCT` sobre `sesion_activa` del día), INSERT en `mand_cierre_log`.
- Snapshots agregados: incluyen todo el personal que rotó por la guardia, no solo los presentes al momento del cron.

**Usuario SISTEMA:**

- Seed idempotente en `initDB()`: `username='SISTEMA'`, `activo=0`, `password_hash='!disabled!'`. No puede loguearse.
- Cachear `USUARIO_SISTEMA_ID` en `db.js` al arranque.

### DISP (Disponibilidad)

**Diferenciadora:** mini-dashboard interactivo, no grilla. No tiene cierre de turno; se cierra automáticamente al llegar un nuevo evento (el anterior pasa a histórico con `fecha_fin_estado` poblada).

**Invariantes:**

- Una sola fila vigente por planta en `registro_activo` (filtered unique index).
- Todos los registros viejos viven en `registro_historico` con `fecha_fin_estado` cronológica (cierre consecutivo, sin gaps).
- `turno = NULL`, `tipo_evento_id = (tipo 'Cambio de Disponibilidad')` único fijo.
- No se permiten estados consecutivos iguales (409 reactivo).
- `fecha_inicio_estado` solo puede ser presente/pasado (no futuras).

**Flujo transaccional POST DISP (`POST /api/registros` rama DISP):**

1. Validar input (planta ∈ {GEC3,GEC32}, evento ∈ {En Servicio, En Reserva, Indisponible, Mantenimiento}, fecha ≤ now).
2. SELECT vigente con `UPDLOCK, HOLDLOCK`.
3. Si existe vigente: validar `evento != vigente.evento` (409 mismo_estado) y `fecha_inicio_estado > vigente.fecha_inicio_estado` (409 fecha_anterior).
4. Si existe vigente: UPDATE `fecha_fin_estado = nuevo.fecha_inicio_estado`, INSERT a histórico, DELETE de activo.
5. INSERT nuevo en `registro_activo` con `fecha_fin_estado=NULL`, `codigo` derivado (`En Servicio:1, En Reserva:0, Indisponible:-1, Mantenimiento:-1`). Ver D-024 — los 4 estados están en el enum; `Indisponible` y `Mantenimiento` comparten `codigo=-1` y se distinguen por el string `evento`.
6. UPSERT (MERGE) en `disponibilidad_dashboard` por `planta_id`.
7. Commit.

**Flujo PUT DISP (editar vigente):**

- `planta_id` NO editable (422). Cualquier `puede_crear` puede editar (no solo creador).
- Si `fecha_inicio_estado` cambia: validar `>= N-1.fecha_inicio_estado` y `<= now`. **Side-effect controlado**: actualizar `N-1.fecha_fin_estado = nueva_fecha_inicio` en histórico (excepción a la inmutabilidad histórica, documentada).
- Si `evento` cambia: validar `nuevo_evento != N-1.evento` (no consecutivos).
- `modificado_por` y `modificado_en` se actualizan al user actual.

**Endpoint deshacer (`POST /api/disponibilidad/deshacer {planta_id}`):**

- Sin histórico → DELETE vigente + DELETE `disponibilidad_dashboard` (planta queda en empty state). Emite CIET con audit.
- Con histórico → DELETE vigente + INSERT en activo desde el más reciente histórico (con `fecha_fin_estado=NULL`) + DELETE ese del histórico + UPSERT `disponibilidad_dashboard`. Emite CIET con audit completo: autor del delete + JdTs activos en `sesion_activa` + Gerentes de Producción activos.

**Permisos:**

- `puede_ver=1` para TODOS los cargos (operativamente visible para todos).
- `puede_crear=1` solo para cargos 1 (Ingeniero Jefe de Turno) y 2 (Ingeniero de Operación). Gating en frontend (botones desaparecen) y backend (403).

**Frontend:**

- `DisponibilidadDashboard.jsx`: tabs/toggle GEC3↔GEC32 con animación slide horizontal 250ms. Polling 30s para capturar cambios de otros usuarios. Fetchea estado vigente (`getEstado`) + acumulados (`getMetricas`) en paralelo, cacheados por planta en el SWR; metricas se degrada a `null` si falla (el panel no se renderiza, sin tumbar la carga del estado).
- `EstadoActualCard.jsx`: paleta por estado (D-024) — `En Servicio` verde + `CheckCircle2`, `En Reserva` azul + `Clock`, `Indisponible` rojo + `XCircle`, `Mantenimiento` amarillo + `Wrench`. Fade-out/in al cambiar planta.
- `AcumuladosPorEstado.jsx` (D-028): panel "Acumulado histórico por estado" bajo la tarjeta — 4 mini-tarjetas color-coded con el tiempo total por estado (fuente `GET /api/disponibilidad/metricas`). Los 3 estados no vigentes van **congelados** (`tiempo_ms[estado]`); el vigente crece en vivo en lockstep con "Tiempo en estado" via `base + tiempoEnEstado`, donde `base = tiempo_ms[actual] − (ahora − fecha_inicio_estado)`. Reusa el mismo tick de `TiempoEnEstado` (un solo `setInterval`) → sin doble conteo ni salto en el borde.
- `TiempoEnEstado.jsx`: counter live `setInterval(1000ms)`. Formato fijo (D-024): unidades `años, meses, d, hr, min, s`. Plural correcto en `años`/`meses`; abreviaturas invariantes. Omite unidades con valor 0 **excepto segundos** (siempre presentes). Aproximaciones `1 año = 365.25 d`, `1 mes = 30.44 d`. Sin semanas. Exporta `formatDiff` y `useTiempoTranscurrido` para reuso (D-028).
- `HistorialList.jsx`: paginación "Ver más" (+20 vía `historial_offset`).
- `CambiarEstadoModal.jsx`: 3 modos (crear / editar / deshacer-confirm). Manejo de 409 con popups reactivos.
- Planta activa: la persiste el **routing por hash** (`#/disp?planta=GEC3|GEC32`, D-035), fuente única de verdad. El viejo `sessionStorage('disponibilidad.plantaSeleccionada')` se retiró (doble fuente).

### Otras bitácoras (formulario_especial=0)

Usan `GrillaRegistros.jsx` genérico. Aceptan filtros F11 (fecha + chevrons día anterior/siguiente + botón "Hoy" + dropdown turno T1/T2). Filtros persisten en `sessionStorage`, filtrado client-side sobre `/api/registros/activos`.

### CIET (Cierres y Finalizaciones)

Bitácora oculta de auditoría. Nadie tiene `puede_crear=1`; los registros se generan automáticamente desde código.

Tipos de evento:
- `Finalización de turno` (emitido por `POST /api/bitacora/finalizar`).
- `Cierre de turno` (emitido por `POST /api/cierre/bitacora` y `POST /api/cierre/masivo`).
- `Deshacer disponibilidad` (emitido por `POST /api/disponibilidad/deshacer`).

Helper compartido: `server/utils/ciet.js::registrarEventoCierre`. Recibe `transaction, { tipo, sesion, bitacora_origen_id, campos_extra_extras }` y hace el INSERT con snapshots.

Para el cierre automático MAND: autor = `USUARIO_SISTEMA_ID`, snapshots agregados con `SELECT DISTINCT` sobre las sesiones del día.

---

## Sesiones (modelo F2)

**Una sola `sesion_activa` por login + N filas en `sesion_bitacora`.**

- Login crea `sesion_activa` con `activa=1`. NO se vence por TTL — vive hasta logout explícito.
- Al entrar a una bitácora: `POST /api/bitacora/abrir` UPSERTea en `sesion_bitacora` con `finalizada_en=NULL`. Idempotente.
- Al finalizar turno: `POST /api/bitacora/finalizar` actualiza `finalizada_en` en TODAS las `sesion_bitacora` del usuario y emite CIET 'Finalización'.
- `snapshotJDTs`/`snapshotJefes`/`snapshotIngenieros` leen de `sesion_bitacora` con `finalizada_en IS NULL`, sin filtro de TTL.
- El sweeper de cierre cronológico (F4) finaliza turnos vencidos pero NO toca `sesion_activa.activa` (evita forzar re-login al cambio de turno).

---

## Turnos (modelo F1)

2 turnos solamente:

- **Turno 1 (diurno):** hora ∈ [06, 17]. Empieza 06:00.
- **Turno 2 (nocturno):** hora ∈ [18, 23] ∪ [00, 05]. Cruza medianoche. Empieza 18:00.

Helpers en `server/utils/turno.js`:

- `getTurnoColombia()` — `hora ∈ [6,17] → 1; resto → 2`.
- `turnoFromPeriodo(periodo)` — `periodo ∈ [7,18] → 1; resto → 2`. (P1=00:00, P7=06:00, P18=17:00, P19=18:00.)
- `ventanaTurno(turno, fechaRef)` — retorna `{inicio, fin}` Date.
- `colombiaParts()` — offset manual `-5h` con `getUTC*()`. Colombia no tiene DST.

Las "3 ventanas" que el usuario menciona ocasionalmente (madrugada/día/noche) son **narrativas** — el modelo de datos sigue siendo 2 turnos.

---

## TZ y fechas (post F19-F22)

**Convención canónica:** BD guarda UTC, presentación convierte a Bogotá.

- INSERTs siempre `SYSUTCDATETIME()` o `new Date()` (driver mssql con `useUTC=true` lo serializa como UTC).
- Comparaciones de "día Bogotá" en queries: `CAST(DATEADD(HOUR, -5, columna) AS DATE)`.
- Frontend usa `Intl.DateTimeFormat` con `timeZone: 'America/Bogota'` explícito en todos los formatters (`fmtFecha`, `fmtFechaCorta`, `formatFechaHora`).
- Helpers canónicos: `src/utils/fecha.js` (`getTodayBogota`, `horaBogota`, `shiftDate`), `server/utils/turno.js::colombiaParts`, `server/utils/mand-sweeper.js::todayBogota`.
- Inputs `<datetime-local>` se interpretan como **hora Bogotá** (operador escribe "09:30" = "09:30 hora planta"). Patrón helper: appendar `-05:00` antes de `new Date()`.
- Todos los usuarios son colombianos. Render siempre en Bogotá explícito (no según TZ del navegador).
- Vista compat BD: columnas calculadas `fecha_bogota AS DATEADD(HOUR, -5, fecha_evento)` (opción B+C en F22).

---

## Verificación

Tests existentes en `Bit-cora-g3/server/tests/`:

- `auth.test.js` — login/logout, expiración, permisos.
- `reactivate.test.js` — sesiones reactivadas.
- `disponibilidad.test.js` — flujo DISP completo.
- `sala_de_mando_batch.test.js` — batch save + sweeper diario + errores.

Correr con `cd Bit-cora-g3/server && node --test --env-file=../.env tests/`.

Smoke manual: levantar backend (`npm run dev` en `server/`) + frontend (`npm run dev` en `Bit-cora-g3/`), login como cargo 1, recorrer las 4 bitácoras visibles.
