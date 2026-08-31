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
| Tests | `node:test` (backend, `npm test` en `server/`), **Vitest** (frontend, `npm test` en la raíz) |
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
│   ├── asientos/              D-058 — motor PURO del texto del evento (index/formato/plantillas).
│   │                          Fuente única del listado, del reflejo y del libro F03. Sin BD ni reloj.
│   ├── reflejo-sala.js        D-058 + D-063 — la copia en SALAJDT+SALAING de MAND **y DISP**:
│   │                          crear/actualizar/borrar por lote, crear/actualizar/ANULAR por estado.
│   │                          Se compone con la transacción del origen; no abre ni cierra la suya.
│   ├── f03-datos.js           D-058 — armarMes(): las 4 fuentes de las 2 unidades → días y bloques.
│   ├── f03-libro.js           D-058 — clona server/assets/f03-plantilla.xlsx → N hojas (PURO).
│   ├── xlsx.js                D-058 — leerZip/escribirZip OOXML en ESM, sin dependencias.
│   ├── mand-sweeper.js        Cron interno c/60s, detecta cambio de día Bogotá → cerrarDiaMand()
│   ├── turno-sweeper.js       (legacy o coexistente — revisar al tocar)
│   ├── sis/                   D-029/D-060/D-061 — ingesta del carbón GEC32 desde el SIS.
│   │   ├── sis-client.js          SIS_HOST validado, TAGS, buildUrl/periodoBounds/fetchPeriod,
│   │   │                          extraerCarbonValidado (filtra tolvas ≤ 0,5 t/h como 0).
│   │   ├── xls-parser.js          Lector .xls (OLE2/CFB + BIFF8) sin dependencias, endurecido (AUD-08).
│   │   ├── xls-parser-worker.js   El parser corriendo en un Worker...
│   │   ├── parse-isolated.js      ...y el arnés que lo lanza con tope de heap y timeout.
│   │   ├── carbon-scraper.js      scrapeDia(pool, {planta_id, concurrencia 1..6, …}) + leerScrapeLog:
│   │   │                          fase de red (paralelizable) → transacción única con la ownership.
│   │   ├── sis-sweeper.js         Tick horario a HH:02 Bogotá (ejecutarTick puro, sin timers)...
│   │   ├── sis-sweeper-helpers.js ...y sus helpers puros (necesitaCatchup, periodoDesdeDe, marca).
│   │   ├── sis-lock.js            Mutex de PROCESO sin cola entre sweeper y scrape manual.
│   │   ├── sis-job.js             Job del scrape manual: uno a la vez, en memoria, bajo el mutex.
│   │   └── discover.js            Sondeo calibrado de la primera fecha con datos (K en W días).
│   └── ...
├── scripts/backfill-carbon-gec32.js  CLI de backfill/reparación del carbón GEC32 (resumible).
└── tests/                     node:test (helpers, auth, disponibilidad, mand batch, SIS)
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
| `POST /api/cierre/masivo` | **Cierre de turno (único cierre — D-042).** Archiva los borradores de todas las bitácoras genéricas del turno (`b.codigo NOT IN ('DISP','MAND')`). Preview vía `GET /api/cierre/preview-masivo`. |
| `GET /api/disponibilidad?planta_id=` | Vista mini-dashboard DISP (vigente + historial paginado). |
| `POST /api/disponibilidad/deshacer` | Borra vigente + restaura último histórico. Emite CIET 'Deshacer disponibilidad' con audit completo. **D-063:** además **anula** (no borra) las copias en Sala del estado deshecho y devuelve `copias_anuladas: number`. |
| `GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=` | **D-024/D-026** — tiempo agregado por estado + acumulados (`disponible`, `no_disponible`) en una ventana + `ahora` (reloj UTC del server). Lee directo de `bitacora.disponibilidad_estado` (la vista `v_disp_intervalos` se dropeó en D-026). Consumido por el panel "Acumulado histórico por estado" del mini-dashboard (D-028). |
| `GET /api/sala-de-mando/lotes?planta_id=&fecha=` | **Listado del día por lotes** (D-056). Agrupa `registro_activo` por `campos_extra.lote_id`; expone `publicado` **por celda** como indicador derivado. Gated por `puede_ver`. Desde **D-058** cada lote trae su `asiento` ya renderizado (el front no conoce plantillas). |
| `POST /api/sala-de-mando/guardar` | **Batch atómico append-only** (D-056). Body `{planta_id, fecha, filas:[{tipo, hora, detalle, funcionariocnd, periodos:[{periodo, valor_mw}]}]}`. **Solo INSERT**, un `lote_id` por fila. Transacción única. |
| `PUT /api/sala-de-mando/lotes/:lote_id` | **Corrección por lote** (D-057). **Diff quirúrgico**: conserva `registro_id`/`creado_por` de las celdas que sobreviven; recalcula la publicación por celda tocada. Gated por `puede_crear`, **no** por autoría. |
| `DELETE /api/sala-de-mando/lotes/:lote_id?planta_id=` | **Borrado real por lote** (D-057). Recalcula cada celda liberada → lo publicado retrocede al lote anterior vigente, o la fila de `evento_dashboard` se elimina. |
| `GET /api/sala-de-mando/reporte-mensual?mes=YYYY-MM` | **Libro mensual GENE-F03** (D-058). Responde el `.xlsx` (`Content-Disposition: attachment`), una hoja por día, tres bloques de turno, **las dos unidades mezcladas**. `mes` opcional (default: mes Bogotá en curso); `400 mes_invalido` / `mes_futuro`. **Solo lectura**, gated por `puede_crear` (`puede_ver` lo tienen todos los cargos: no gatearía nada). |
| `POST /api/sala-de-mando/cierre-diario` | Trigger manual del sweeper (tests, recovery). Requiere `puede_cerrar_turno`. |
| `GET /api/combustibles/catalogo?planta_id=` | Catálogo activo de la planta (`lov_bit.combustible`, con `cantidad_max`). `planta_id ∈ {GEC3, GEC32, TST}`; el resto → `400 planta_invalida`. |
| `GET /api/combustibles/consumos?planta_id=&fecha=` | Grilla del día. Desde **D-061** cada celda trae `valor_sis`, `sis_actualizado_en`, `sis_owned` y `es_override` (derivados en el backend), y la respuesta agrega el bloque `sis` con la fila de `sis_scrape_log` de ese día. |
| `POST /api/combustibles/consumos` | Batch atómico. Desde **D-061** vaciar una celda **con** `valor_sis` la deja en `cantidad=0` como override humano (solo borra la que nunca tuvo lectura del SIS); la clave `detalle` ausente conserva el comentario. Gated por `puede_crear`. |
| `POST /api/combustibles/consumos/revertir` | **D-061.** Devuelve una celda al valor del SIS: `restaurado` (`valor_sis>0`, con `creado_por=SISTEMA` y `modificado_por=NULL`) · `eliminado` (`valor_sis=0`) · `sin_cambios`. `400 sin_valor_sis` / `404 celda_no_existe`. Gated por `puede_crear`. |
| `POST /api/combustibles/sis/scrape` | **D-061.** Dispara el scrape manual y responde **202 sin esperarlo** (un día son ~24 fetch de ~13 s; el proxy corta a los 60 s). Body `{ planta_id?, fecha }` o `{ planta_id?, from, to }` (≤ 31 días). **409 `scrape_en_curso`** si hay job vivo o el mutex está tomado; `400 planta_sin_sis` para GEC3. Gated por `puede_crear`. |
| `GET /api/combustibles/sis/estado` | **D-061.** `{ job, lock, sweeper: { habilitado } }`. Gated por `puede_ver`. **Sin consumidor de UI todavía** — el chip que ve el operador sale del bloque `sis` del GET de consumos. |
| `GET /api/eventos-dashboard?tipo=&planta_id=` | Endpoint hacia dashboard-gen-gec3. `tipo ∈ {AUTH,REDESP,PRUEBA}` lee de `evento_dashboard`; `tipo=DISP` lee de `disponibilidad_dashboard`. |
| `GET /api/catalogos/jdt-actual` | Para autocompletado. Lee `sesion_bitacora` con `finalizada_en IS NULL`. |

### Eliminados / obsoletos

- `POST /api/auth/heartbeat`, `POST /api/auth/resume` (F2/F9): el modelo de sesión persistente reemplaza el heartbeat.
- `GET /api/sala-de-mando/dias-pendientes` (F17): MAND solo muestra HOY; no hay paginación entre días.
- `GET /api/sala-de-mando` (D-056): el pivote `{AUTH: {valores: Array(24), detalle, funcionariocnd}, …}` que alimentaba la grilla-espejo. Devuelve **404**; la grilla ya no carga nada del servidor y el listado del día lo reemplaza. No revivirlo.

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
│   ├── Combustibles/
│   │   ├── ConsumosGrid.jsx     UI COMB (24 periodos × N combustibles). Badge de override, popover
│   │   │                        con autoría + valor SIS + Revertir, auto-refresco con gavela, chip SIS.
│   │   ├── override.js          Módulo PURO de la mecánica de override (16 exports; ver abajo).
│   │   ├── SelectorFecha.jsx    Fecha controlada (default hoy Bogotá, futuro bloqueado).
│   │   ├── combustibles.css     Piel "Blueprint Heatmap" (D-033), scopeada bajo `.comb-root`.
│   │   └── colores.js           Rampa del heatmap compartida por `tint()` y la leyenda.
│   ├── historicos/HistoricoTable.jsx
│   └── BarraEstado.jsx            Filtros F11 (fecha+turno) — NO se renderiza para DISP. En MAND se renderiza pero oculta filtros/cierres (la grilla solo muestra HOY) y muestra contador "X registros" sincronizado con el badge.
└── hooks/
    ├── useAuth.js                 Login, logout, sesión persistente
    ├── useBitacoraSesion.js       POST /api/bitacora/abrir al montar
    ├── useUsuariosActivos.js      WS de "usuarios en turno"
    ├── useDisponibilidad.js       getEstado/getMetricas/crear/editar/deshacer para DISP
    ├── useSalaDeMando.js          getGrilla + guardarBatch
    ├── useCombustibles.js         getCatalogo/getConsumos/guardarBatch/revertirCelda (COMB)
    └── useApi.js                  fetch base con manejo de errores estructurados
```

### Routing por bitácora

En `BitacorasGecelca3.jsx`:

```jsx
{bitacora?.codigo === 'MAND' ? <SalaDeMandoGrid ... /> :
 bitacora?.codigo === 'DISP' ? <DisponibilidadDashboard ... /> :
 <GrillaRegistros ... />}
```

El header con controles (`Buscar`, `Todos los tipos`, `+ Nuevo Registro`, `Finalizar Turno`, `Cerrar Turno`) se renderiza condicionalmente: `bitacora?.codigo !== 'MAND'`. **En MAND, el único botón de acción del header es "Guardar"** (controlado por `hayCambios` lift-up del child). El cierre está oculto porque MAND se cierra automáticamente al fin del día vía sweeper (`server/utils/mand-sweeper.js`) y queda excluido del cierre de turno (`b.codigo NOT IN ('DISP','MAND')`). El botón "Cerrar Turno" dispara el cierre de turno masivo (D-042: único cierre; el cierre individual por bitácora fue eliminado).

### Popup "Usuarios activos" (Header)

Botón con contador en la barra superior; abre un popup portal (id `header-users-popup`) con:

- Cabecera fija (`Conectados (N)` + contador de coincidencias cuando hay filtro).
- Buscador por nombre (`autoFocus`, case-insensitive sobre `nombre_completo`).
- Lista scrolleable acotada a `max-h: 22rem` (≈ 6 filas) — el resto se ve con la rueda del mouse o la barra del propio `<ul>`.

El popup se cierra con: Esc, click fuera (botón y popup quedan excluidos por `contains`), `resize`, y `scroll` de la página (listener en captura). Cuando el listener de scroll dispara, **se filtra el evento si su `target` es el `<ul>` del popup o un descendiente** — sin ese filtro, mover la rueda dentro del listado o arrastrar su barra de scroll cerraba el popup (regresión documentada). Ver `Header` en `src/BitacorasGecelca3.jsx`.

---

## Mecánica por bitácora

### MAND (Operación 24h)

**Diferenciadora:** grilla 24 periodos × 3 tipos × 2 plantas con batch save atómico. No se cierra por turno — se cierra automáticamente vía sweeper diario. Desde **D-056** la grilla es un **formulario de captura append-only** (registra, no edita) y desde **D-057** corregir y borrar existen **fuera de la grilla, por lote, desde el listado del día**. Son dos planos separados: capturar nunca lee del servidor; corregir siempre re-lee dentro de la transacción.

**Modelo de captura (frontend, D-056):**

1. Al montar: la grilla nace **vacía**. No hay `GET` que la alimente (el pivote se dio de baja) ni par `snapshot`/`buffer`: `dirty` deriva solo del buffer de captura.
2. Al editar celda: `setBuffer(...)`. NADA va al backend.
3. Click "Guardar" → `POST /api/sala-de-mando/guardar` → la grilla se vacía **solo tras la confirmación**; ante un `400` **conserva lo capturado** (el operador no pierde lo escrito por un error de validación).
4. `beforeunload` confirm si hay cambios pendientes.
5. Tras `guardarBatch` ok, el hook emite `bitacora:counts-refresh` (CustomEvent en `window`). Consumidores: `useBitacoraCounts` refetchea `/api/bitacora/counts` (badge del tab), y `BitacorasGecelca3` refetchea `/api/registros/activos` para la bitácora activa (sincroniza el contador "X registros" de `BarraEstado` con el badge).
6. Debajo, `LotesDelDia` lista los lotes del día — se refresca al montar, tras cada guardado y en el **mismo tick de 60s** de la grilla (no hay segundo temporizador).

**Backend append-only (`POST /api/sala-de-mando/guardar`, D-056):**

Por cada fila válida el servidor genera un `lote_id` (GUID) y hace **un INSERT por celda con valor** — nunca UPDATE, nunca DELETE. Las celdas vacías se omiten. La metadata del lote (`hora_llamada` ISO UTC compuesta server-side, `funcionariocnd`, `detalle`) viaja **replicada en cada celda** dentro de `campos_extra`. Por cada celda tocada se recalcula el vigente publicado **por celda** (`recalcularEventoDashboard`). Devuelve `{ resumen: { lotes, registros } }` o `400 { errores: [{tipo, periodo?, motivo}] }`.

**Corrección por lote (`PUT`/`DELETE /api/sala-de-mando/lotes/:lote_id`, D-057):**

El lote se re-lee **dentro de la transacción** (nunca se confía en el snapshot que vio el modal) y se diffea contra el body:

- periodo en ambos, mismo `valor_mw` → solo metadata; no recalcula.
- periodo en ambos, valor distinto → `UPDATE` + `modificado_por`/`modificado_en`; recalcula.
- periodo solo en el body → `INSERT` con el **mismo `lote_id`** y `fecha_evento` **heredado** del lote; recalcula.
- periodo solo en la BD → `DELETE` de esa fila; recalcula (ahí retrocede lo publicado).

La metadata (hora / funcionario / descripción) se aplica **a nivel de lote**, recorriendo sus celdas vivas fuera del loop de periodos; cambiar la **hora** obliga a recalcular **todas** las celdas (es el criterio de desempate de la publicación). El `DELETE` borra las N filas y recalcula cada celda liberada. Ambos gated por `puede_crear` + planta de la sesión, **no** por autoría (excepción acotada a MAND de D-049). Desenlaces compartidos: `404 lote_inexistente` · `409 lote_cerrado` · `403 lote_de_otra_planta`.

**Reflejo a las bitácoras de Sala (`utils/reflejo-sala.js`, D-058 + D-063):**

Los tres endpoints de arriba llaman al reflejo **dentro de su misma transacción y sin `try/catch`**: guardar crea la copia del asiento en `SALAJDT` **y** `SALAING`, corregir la regenera en las dos y borrar las borra; si el reflejo falla, se revierte también el lote. La copia es un registro real (cuenta en el contador, cierra por turno, viaja al histórico), se ata al origen por `campos_extra.origen_lote_id` —**por lote, nunca por `registro_id`**: también migra al histórico, así que no hay FK posible— y lleva `fecha_evento` = **hora de la llamada** pero `turno_id` = el turno **ABIERTO** (el puntero de archivado; apuntarlo a uno cerrado la dejaría viva para siempre). `rowsAffected = 0` **no es error**: el cierre de turno de Sala ya archivó las copias, el histórico no se reescribe y la corrección del origen procede igual. En su destino la copia **no se edita ni se borra, tampoco por su autor** (`403 asiento_reflejado`; `canEditarRegistro` + el espejo SQL del `GET /activos`, cambiados juntos).

**Disponibilidad también se refleja (D-063).** Tres enganches más, cada uno dentro de la transacción de su origen y sin `try/catch`: `POST /api/registros` rama DISP crea las dos copias tras `insertNuevoEstado`, `PUT /api/registros/:id` rama DISP las regenera tras `actualizarVigente`, y `POST /api/disponibilidad/deshacer` **las anula en vez de borrarlas** antes de eliminar el estado — la copia queda visible y tachada, con `campos_extra.anulado {por, nombre, cargo, en}`, y el endpoint devuelve `copias_anuladas` (verificado en GATE-O2 con `tests/disponibilidad_reflejo_http.test.js`). La copia DISP va a la planta del **origen** (DISP es cross-planta), su `fecha_evento` es `fecha_inicio_estado` y su `turno_id` sigue siendo el turno ABIERTO o `NULL`. Anular es **idempotente por SQL** (`AND JSON_VALUE(campos_extra,'$.anulado.en') IS NULL`): `JSON_MODIFY` reemplaza una clave existente sin fallar, así que una segunda pasada borraría quién deshizo de verdad. Desde D-063 el marcador que decide si una fila es copia es el **universal `campos_extra.origen_bitacora`** (`'MAND'`/`'DISP'`); `origen_lote_id` y `origen_disponibilidad_id` son solo punteros al origen. Detalle en BIT-MODBD §7.11 y RF-077. Del lado del front, el vocabulario del asiento reflejado y de la copia anulada (`parseCamposExtra`, `estadoReflejo`, `tituloOrigen`, `tituloAnulado`, `fechaHoraBogota`, `ChipAnulado`) vive en **`src/utils/reflejo.js`** (un módulo puro, D-063 L06) y lo importan la grilla de Sala y Históricos; el guard `tests/guard_marcador_reflejo.test.js` audita los cinco puntos y acepta el marcador vía ese import.

**Validaciones de negocio (errores específicos):**

- `fecha_no_es_hoy` (solo HOY se captura).
- `periodo_bloqueado` (REDESP requiere `periodo >= floor(hora_bogota) + 1`, "periodo actual o posteriores"). En la corrección se evalúa **sobre el delta**; no aplica al `DELETE` del lote.
- `hora_requerida` / `hora_invalida` / `hora_futura` (hora de la llamada al CND, validada contra el reloj del **servidor** con 5 min de tolerancia; error de **lote**, sin `periodo`).
- `funcionariocnd_requerido` (AUTH con al menos un valor exige funcionariocnd).
- `funcionariocnd` en PRUEBA/REDESP → server lo fuerza a NULL silenciosamente (no es error).
- `lote_sin_celdas` (metadata sin ninguna celda con valor — nunca un 200 mentiroso), `periodo_duplicado` (solo en el `PUT`), `valor_mw_invalido`, `periodo_fuera_rango`, `tipo_invalido`, `periodos_invalido`.

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

**Libro mensual GENE-F03 (`GET /api/sala-de-mando/reporte-mensual`, D-058):**

Dos módulos que no se conocen entre sí. `utils/f03-datos.js::armarMes` **consulta** (solo lectura): MAND (`registro_activo` ∪ `registro_historico`, agrupado por lote), DISP (tabla base, por `fecha_inicio_estado`), las dos bitácoras de Sala **excluyendo los reflejados** (`origen_bitacora IS NULL` desde D-063 — antes el puntero `origen_lote_id`, que dejaba pasar la copia DISP; o el evento saldría tres veces) y el personal del bloque (`conformacion_turno` ∪ `turno_participante`, sin sintéticos). `utils/f03-libro.js::construirLibroF03` **escribe**: clona `server/assets/f03-plantilla.xlsx` (derivada offline del F03 real) y emite una hoja por día con `inlineStr`, recalculando `dimension`, `mergeCells`, el `codeName` de cada hoja y **un `Print_Area` por hoja**; el paquete sale **DEFLATE** (como cualquier `.xlsx`) y se **relee antes de devolverse**, así un paquete roto nunca llega al operador. Tres reglas del armado: la hora de MAND es `hora_llamada` (**nunca** `fecha_evento`; ausente en los migrados → se deriva del primer periodo), el bloque se elige **por hora de calendario** y no por `turno_id` (el **T2 se parte por medianoche**, cada evento aparece una sola vez en el libro), y el orden dentro del bloque es **ascendente** — al revés del listado, a propósito. El alcance sale de la constante `PLANTAS_F03`, así que las plantas-fixture nunca se exportan sin que producción las nombre.

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
- **D-063:** en ambos casos, antes de borrar el vigente **anula** sus copias en `SALAJDT`/`SALAING` (`anularReflejoDisponibilidad`, misma transacción) y devuelve `copias_anuladas`. La copia del estado N-1 restaurado **no se toca**: nunca se anuló.

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

### COMB (Consumos de combustible) e ingesta SIS de carbón GEC32

Grilla de 24 periodos × N combustibles por planta (8 en GEC3, 10 en GEC32, desde `lov_bit.combustible`). No es una bitácora de eventos: es un reporte numérico con batch save atómico. Lo que la hace especial es que **tiene dos escritores**: el operador y el SIS.

**El SIS** es el historiador industrial interno (`http://192.168.18.201`, HTTP plano sin auth, allowlist en `validarSisHost`). Exporta un `.xls` por rango horario; un periodo pesa ~830 KB (3.601 filas) y tarda ~13 s. De ahí salen las 8 tolvas (`ALIM_1..8`) de GEC32. **GEC3 no tiene SIS.**

#### Los módulos y quién le pide días al SIS

| Camino | Módulo | Cuándo | `scrape_tipo` |
|---|---|---|---|
| Sweeper horario | `utils/sis/sis-sweeper.js` | tick a **HH:02 Bogotá** (el primero 10 s tras arrancar): completa AYER si su log no dice 24/24, después re-scrapea HOY. Lo arranca `server.js` salvo `SIS_SWEEPER_ENABLED=0` | `horario` |
| Job manual | `utils/sis/sis-job.js` + `POST /api/combustibles/sis/scrape` | a pedido, día a día, rango ≤ 31 días; responde **202** y el avance se lee en `GET /sis/estado` | `manual` |
| CLI de backfill | `scripts/backfill-carbon-gec32.js` | corridas históricas largas, a mano | `backfill` |

Los tres llaman a `scrapeDia(pool, { fecha, planta_id='GEC32', concurrencia=1, periodoDesde, soloHoy, … })`, que hace **fase de red** (paralelizable hasta 6 periodos; las lecturas se ordenan por periodo antes de escribir) y después **una sola transacción** con la regla de ownership. El resumen del día va a `bitacora.sis_scrape_log` (una fila por `planta+fecha`, UQ).

**`sis-lock.js` es un mutex de proceso y sin cola.** El tick del sweeper corre entero adentro; el job manual también. Quien lo encuentre tomado **no espera**: el sweeper omite el tick completo y vuelve en una hora, el endpoint responde `409 scrape_en_curso` con `job` y `lock` para poder decir *cuál* de los dos está corriendo y desde cuándo. El CLI es **otro proceso** y el mutex no lo alcanza: su exclusión con el sweeper es `--to ≤ hoy-2` (D-060).

**`SIS_SWEEPER_ENABLED=0` apaga el sweeper.** Existe para los **backends efímeros de test** (con `SIS_HOST` apuntando a un stub, el tick real ensucia la fila de hoy de GEC32) y **no es un flag de producción**. Solo el string exacto `'0'` apaga; la ausencia de la variable deja la ingesta encendida y el apagado se anuncia en el log de arranque, porque un sweeper mudo es indistinguible de uno roto.

#### La regla de ownership ("operador gana")

Una celda es **SIS-owned** ⇔ `creado_por = SISTEMA AND (modificado_por IS NULL OR = SISTEMA)`. El SIS escribe siempre la sombra `valor_sis`, pero solo manda en `cantidad` mientras la celda sea suya; en una celda editada por un humano actualiza **únicamente** la sombra. Un cero del SIS **borra** la fila si es SIS-owned (la ausencia de fila es su representación canónica de "no hubo consumo") y solo baja la sombra si es humana. Tabla completa de las seis ramas y el resto de la semántica: **BIT-MODBD §4.9.1**.

`sis_owned` y `es_override` los calcula el backend en `GET /consumos` (`es_override = !sis_owned AND valor_sis IS NOT NULL AND cantidad <> valor_sis`): **el front pinta, no decide**. Vaciar una celda con lectura del SIS la deja en `cantidad = 0` como override; `POST /consumos/revertir` es el único camino de vuelta.

#### El front (`Combustibles/ConsumosGrid.jsx` + `override.js`)

Toda la lógica que se puede equivocar —formato de fecha Bogotá, política de refresco, aritmética de la gavela, reconciliación del buffer, lado del popover— vive en el módulo **puro** `override.js` (16 exports), probado sin DOM ni backend; la grilla lo consume.

- **Badge de override**: banderín ámbar en la esquina de las celdas ALIM con `es_override`, leído del **snapshot del server** y no del buffer local, así que mientras alguien teclea la marca no parpadea. El popover muestra autoría, fecha Bogotá y el valor SIS, y lleva el botón **Revertir** (solo con `puede_crear`). Hacia dónde abre se decide **midiendo** el banderín contra el recuadro que lo recorta (`ladoPopover`, función pura que recibe los dos rects), no por índice de fila.
- **Auto-refresco**: solo en GEC32 viendo hoy, cada 5 min y al volver a la pestaña. **Nunca pisa una edición**: toda lectura lleva número de secuencia y la coordenada `(planta, fecha)` con la que salió, y se descarta sola si dejó de ser la última o si la coordenada cambió. Lo que **siempre** se aplica es el snapshot, el catálogo y el estado del SIS (la verdad del server, de donde sale el badge); el buffer solo si nadie está escribiendo.
- **Gavela**: con cambios sin guardar el refresco se detiene y arranca una cuenta regresiva de 10 min en la topbar, con salida explícita (Guardar / Descartar) y descarte automático al vencer.
- **Lo que se guarda es lo que el operador tocó**, no la diferencia entre dos estructuras: la grilla lleva el conjunto explícito de coordenadas editadas, `setCelda` es la **única** puerta de escritura del buffer, y cuando vuelve una lectura con una edición viva el buffer se reconcilia celda por celda contra el snapshot nuevo. Sin eso, un refresco de fondo convertía el Guardar siguiente en un borrado de lo que el SIS acababa de escribir. Cualquier camino nuevo que escriba el buffer sin pasar por `setCelda` quedaría fuera del conjunto y **sus cambios no se guardarían, en silencio**.
- **Chip SIS**: `SIS 24/24 ✓` / `SIS n/24 · HH:mm` / `SIS · sin lectura`, alimentado por el bloque `sis` del GET. **No** se alimenta de `GET /sis/estado`, que hoy no tiene consumidor de UI.
- No hay botón de scrape manual en la pantalla: el endpoint existe, la UI no lo expone.

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
- COMB / SIS: `consumos_combustible.test.js`, `sis_endpoints.test.js` (GET con `valor_sis`, vaciar, revertir), `sis_scrape_endpoint.test.js` (202/409/estado contra un stub local del SIS), `sis_scraper_ownership.test.js`, `sis_concurrencia.test.js`, `sis_lock.test.js`, `sis_sweeper.test.js`, `sis_discover.test.js`, `sis_parser*.test.js`, `sis_schema.test.js`. Front: `src/components/Combustibles/override.test.js` y `ConsumosGrid.test.jsx` (Vitest).

Correr con `cd Bit-cora-g3/server && npm test` (la lista y el orden viven en el script `test` de `server/package.json`, con `--test-concurrency=1`: dos archivos HTTP en paralelo sobre la misma fixture se dan 401 mutuo por la sesión única de D-035).

**Escribir en la BD desde un test va SIEMPRE a la planta-fixture `'TST'`** (D-030/D-055): la suite corre contra la base productiva. Desde D-061 `'TST'` tiene su propio catálogo de combustibles, así que también es scrapeable. `npm run test:residuos` cuenta lo que quedó vivo.

Smoke manual: levantar backend (`npm run dev` en `server/`) + frontend (`npm run dev` en `Bit-cora-g3/`), login como cargo 1, recorrer las 4 bitácoras visibles.
