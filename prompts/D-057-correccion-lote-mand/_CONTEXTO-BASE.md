# D-057 — Contexto base (compartido por todas las etapas)

> **Inmutable** una vez cerrada la planificación. Si algo cambia durante la ejecución se registra en
> `ESTADO.md` (desviaciones) y en el commit de la etapa, **no acá**.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md` (estado vivo de avance).
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Vite front, Node ESM + Express backend en el
> puerto 3002, SQL Server con esquemas `lov_bit` + `bitacora`).

## Objetivo

Darle a Operación 24h (MAND) la capacidad de **corregir y borrar lo registrado, por LOTE**: `PUT` y
`DELETE` sobre `/api/sala-de-mando/lotes/:lote_id` + los controles en el listado del día que D-056
dejó en solo lectura. Es la parte de **corrección** de
[`docs/requerimientos/REQ-04-historico-en-apartado.md`](../../docs/requerimientos/REQ-04-historico-en-apartado.md);
cierra la consecuencia (b) de D-056 ("corregir y borrar lo registrado NO existe todavía").

**Explícitamente FUERA de alcance:**

- **El formato de mensaje de WhatsApp** (REQ-04 §8.1, RQ-04.3, §8.3 "copiar el mensaje"): sigue
  bloqueado por falta de la plantilla literal. Va a un flujo posterior (D-058). El listado se queda
  con la presentación tabular que ya tiene.
- **La cascada a SALAJDT/SALAING** (RQ-04.14, REQ-02): esas copias **todavía no existen**. Se deja
  únicamente el **punto de enganche anotado** con un comentario en el lugar exacto de la transacción.
  Cero código muerto, cero feature flag.
- **Rehacer el listado** (`GET /api/sala-de-mando/lotes` + `LotesDelDia.jsx`): ya está en producción
  por D-056. Solo se le agregan acciones.
- Días anteriores al de hoy (viven en la sección general de Históricos) y Disponibilidad.

**No toca contratos cross-repo por shape**: el dashboard sigue leyendo `bitacora.evento_dashboard`
con `UQ_evento_planta_fecha_periodo_tipo` intacto; lo que cambia es **cuándo** se recalcula el
vigente. `../docs/interfaces-cross-repo.md` no requiere edición.

## Fuentes / insumos

| Fuente | Qué aporta |
|---|---|
| `docs/requerimientos/REQ-04-historico-en-apartado.md` | Requisitos RQ-04.8..18, reglas RN-04.a..f, los **14 criterios de aceptación** (§6) y los riesgos (§5.4). |
| `prompts/D-057-correccion-lote-mand/PREGUNTAS-D-057.md` | Las 11 decisiones congeladas de esta planeación. **Autoritativas sobre REQ-04 donde difieran** (ver §5.3 de REQ-04 vs. respuesta 5). |
| `docs/decisions.md` → **D-056** | El modelo de lotes: `lote_id`, `hora_llamada`, publicación por celda, migración `F32.A1`. |
| `docs/decisions.md` → **D-055** | `turno_id` por `fechaOperativaDePeriodo`; huérfanos de `evento_dashboard`; "nunca un 200 mentiroso"; tests de MAND en un solo archivo. |
| `docs/decisions.md` → **D-049** | La política "solo el autor" que este flujo **excepciona para MAND** — y que debe seguir intacta fuera. |
| `docs/decisions.md` → **D-019 / D-016 / D-018** | `modificado_por` selectivo; lock REDESP; `funcionariocnd` obligatorio en AUTH. |

## Destino en BD (lo que ya existe)

**No hay DDL nuevo en este flujo.** Todo opera sobre tablas existentes:

- **`bitacora.registro_activo`** — las N filas de un lote. Columnas relevantes: `registro_id` (PK),
  `bitacora_id`, `planta_id`, `fecha_evento` (**acota el día Bogotá**: `CAST(DATEADD(HOUR,-5,
  fecha_evento) AS DATE)`), `turno`, `turno_id`, `detalle`, `campos_extra` (NVARCHAR JSON:
  `periodo`, `valor_mw`, `funcionariocnd`, `lote_id`, `hora_llamada`), `tipo_evento_id`, `estado`
  (`'borrador'` mientras vive), `creado_por`/`creado_en`, **`modificado_por`/`modificado_en`** (que
  recuperan sentido acá, RN-04.d), los tres `*_snapshot`.
- **`bitacora.evento_dashboard`** — `UQ_evento_planta_fecha_periodo_tipo`. `registro_origen_id`
  **no tiene FK posible** (el origen migra entre `registro_activo` y `registro_historico`, D-055 (c)).
- **`bitacora.registro_historico`** — destino del cierre diario. **Inmutable (RF-032)**: un lote que
  ya está acá **no se corrige** (`409 lote_cerrado`).
- **`lov_bit.cargo_bitacora_permiso`** — matriz data-driven; de acá sale `puede_crear` en MAND.

## Endpoints existentes (lo que ya existe)

Todos en `server/routes/mand.js`, montados bajo `/api/sala-de-mando` tras `requireEntra` +
`loadAppSession`:

| Endpoint | Ref | Rol en este flujo |
|---|---|---|
| `GET /lotes?planta_id=&fecha=` | `mand.js:54-158` | **Fuente del listado.** Agrupa por `lote_id`, deriva metadata **asumiendo coherencia**, expone `publicado` por celda. Gated por `puede_ver` (RN-04.f). No cambia su shape; E4 consume `lote.periodos[].registro_id`. |
| `POST /guardar` | `mand.js:176-434` | **El modelo a imitar**: validaciones de negocio acumuladas (`errores[]`, con `periodo` para errores de celda y sin él para errores de lote), transacción, `recalcularEventoDashboard` por celda tocada, `notifyDashboard` post-commit. |
| `POST /cierre-diario` | `mand.js:438-466` | Sin cambios. Relevante solo porque produce el `409 lote_cerrado`. |
| `GET /api/sala-de-mando` | — | **Ya no existe** (404 desde D-056). No revivirlo. |

## Patrones de infraestructura a reutilizar

- **Transacción canónica**: `const t = new sql.Transaction(db); await t.begin(); try { … await
  t.commit() } catch { await t.rollback(); throw }` — ver `mand.js:344-433`. Los efectos externos
  (`broadcastConteoBitacoras`, `notifyDashboard`) van **después** del commit, fire-and-forget.
- **`recalcularEventoDashboard(transaction, {planta_id, fecha, periodo, tipo})`** —
  `server/utils/notificador.js:123-228`. Resuelve el vigente **desde cero** por celda:
  `ORDER BY (hora IS NULL) , hora DESC, creado_en DESC, registro_id DESC`; `DELETE` de la fila si no
  queda ganador (nunca `activa=0`). **Ya está escrita y probada** — este flujo solo agrega callers.
- **`resolverTurnoUnidadId(transaction, {planta_id, fecha_operativa, turno})`** — `mand.js:27-38`.
  Se usa junto a `turnoFromPeriodo(periodo)` + `fechaOperativaDePeriodo(fecha, periodo)`
  (`server/utils/turno.js`) para las celdas que el diff **inserta**.
- **`fechaBogotaStr(ms)`** — `server/utils/turno.js`. Día Bogotá canónico (D-020).
- **Permisos**: `hasPermisoBitacora(sesion, MAND_ID, 'puede_crear')` + `plantaMatch(sesion,
  planta_id)` (`server/middleware/permissions.js:10,33`). **Nunca** hardcodear cargo ni planta.
- **Errores**: `sendJSON(res, 4xx, {...})` para los de negocio; los inesperados los toma `asyncH` →
  `expressErrorHandler` → `responderError` (D-032). **Nunca** devolver `err.message` crudo.
- **Front**: `api.put/api.del` ya existen en `src/hooks/useApi.js:61-62`. El listado se refresca con
  `refrescarLotes()` (`SalaDeMandoGrid.jsx:112-124`), que también corre en el tick de 60s
  (`:141-149`) — **no agregar un segundo temporizador**.
- **Tests**: `server/tests/sala_de_mando_batch.test.js` (**todos los de MAND van acá**, D-055), con
  `setupSessions`/`call`/`TEST_PLANTA`/`TEST_TAG` de `tests/helpers.js` y el `cleanMand()` local
  (`:51`, hard-codeado a `'TST'`). Suite serial: `cd server && npm test`.

## Diseño D-057 (acordado)

### Schema nuevo / cambios de BD

**Ninguno.** Sin migración, sin flag en `migracion_aplicada`.

### Lógica núcleo — el diff del `PUT`

El lote se identifica por `lote_id`; sus celdas actuales se **re-leen dentro de la transacción**
(nunca se confía en el snapshot que vio el modal — respuesta 7). Contra el body entrante:

| Situación | Acción sobre `registro_activo` | ¿Recalcula la celda? |
|---|---|---|
| Periodo en ambos, **mismo** `valor_mw` | solo metadata (ver abajo) | no |
| Periodo en ambos, `valor_mw` **distinto** | `UPDATE` de `campos_extra.valor_mw` + `modificado_por`/`modificado_en` | **sí** |
| Periodo **solo en el body** | `INSERT` con el **mismo `lote_id`**, heredando `fecha_evento` del lote | **sí** |
| Periodo **solo en la BD** | `DELETE` de esa fila | **sí** (acá retrocede el publicado) |

- **Metadata (hora, funcionario, descripción)**: se aplica **a nivel de lote**, en un solo `UPDATE`
  sobre todas sus celdas vivas, **fuera del loop de periodos** (la lección de D-055 (a)). Si cambió
  cualquiera de las tres, sella `modificado_por`/`modificado_en` en las celdas afectadas
  (respuesta 2). Cambiar la **hora** obliga a recalcular **todas** las celdas del lote: la hora es
  el criterio de desempate de la publicación.
- **`fecha_evento` de las celdas insertadas: hereda la del lote** (respuesta 9) → el lote nunca se
  parte entre dos días Bogotá. `turno`/`turno_id` de la celda nueva salen de
  `fechaOperativaDePeriodo(fechaDelLote, periodo)` (D-055 (b)), **jamás** del instante de la corrección.
- **Lock REDESP — solo sobre el delta** (respuesta 3): rebota `periodo_bloqueado` si un periodo
  `< periodoActual` **cambia de valor**, **se agrega** o **se quita**. Los periodos pasados que
  quedan idénticos, y la hora/funcionario/descripción, pasan siempre.
- **El TIPO es inmutable** (respuesta 11): no se acepta en el body; corregirlo es `DELETE` + volver
  a registrar.
- **Validaciones que se revalidan** igual que en el `POST`: `hora` `HH:mm` Bogotá compuesta
  server-side contra la **fecha del lote** con tolerancia de 5 min
  (`hora_requerida`/`hora_invalida`/`hora_futura`), `funcionariocnd` obligatorio en AUTH y forzado a
  `NULL` en PRUEBA/REDESP, `periodo` 1..24, `valor_mw` finito.
- **Lote sin celdas tras el diff** → `400 lote_sin_celdas`, nada se escribe (respuesta 6).
- **Todo o nada**: una sola transacción cubre diff + recálculo de cada celda tocada (criterio 14).

### Lógica núcleo — el `DELETE`

Borrado **real** de las N filas del lote (RN-04.c: no hay anulación visible en MAND), + recálculo de
**cada** `(periodo, tipo)` que el lote ocupaba → el publicado retrocede al lote anterior vigente de
ese periodo, o la fila de `evento_dashboard` se **elimina** si no queda ninguno (criterio 10).
Mismo gate, misma transacción, misma notificación post-commit. **El lock de REDESP no aplica al
borrado del lote completo**: es la corrección de un registro errado, no la reescritura de un valor
pasado — queda documentado como decisión en el ADR.

### Resolución del lote y sus errores

1. Filas vivas en `registro_activo` con ese `lote_id`, misma planta que la sesión → se opera.
2. Sin filas vivas pero el `lote_id` aparece en `registro_historico` → **`409 lote_cerrado`**
   (respuesta 10). El front refresca el listado.
3. Sin filas en ningún lado → **`404 lote_inexistente`**.
4. Filas de **otra planta** → `403` (nunca revelar contenido de otra unidad).

### Endpoints nuevos

| Método + ruta | Gating | Body | Respuesta |
|---|---|---|---|
| `PUT /api/sala-de-mando/lotes/:lote_id` | `loadAppSession` + `plantaMatch` + `puede_crear` en MAND | `{ planta_id, hora, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }` | `200 { lote_id, resumen: { actualizados, creados, eliminados, celdas_recalculadas } }` · `400 { errores: [...] }` · `403` · `404 lote_inexistente` · `409 lote_cerrado` |
| `DELETE /api/sala-de-mando/lotes/:lote_id` | idem | — (`planta_id` por query) | `200 { lote_id, resumen: { eliminados, celdas_recalculadas } }` · mismos 4xx |

`GET /lotes` **no cambia de shape**.

### Front

- **`LotesDelDia.jsx`** — dos acciones por renglón (lápiz / basurero), visibles **solo si
  `puedeCrear`** (RN-04.f: sin permiso, el listado se ve igual pero sin controles). Nuevas props:
  `puedeCrear`, `onEditar`, `onEliminar`.
- **`LoteEditorModal.jsx` (nuevo)** — hora, funcionario (solo AUTH), descripción y los periodos del
  lote con su valor, más la posibilidad de agregar/quitar periodos. Muestra el tipo pero **no lo deja
  cambiar**. Botón Guardar **deshabilitado si no queda ningún periodo con valor**, señalando
  Eliminar. Pinta los `errores[]` del backend con el mismo mapa de motivos de la grilla.
- **Confirmación de borrado** explícita, con el resumen del lote (tipo, hora, periodos).
- **`useSalaDeMando.js`** — `editarLote(lote_id, payload)` y `eliminarLote(lote_id, planta_id)`;
  ambos disparan `bitacora:counts-refresh` como ya hace `guardarBatch`.
- **`SalaDeMandoGrid.jsx`** — orquesta el modal y llama a `refrescarLotes()` tras cada operación.
  **Sin segundo temporizador**: se reusa el tick de 60s existente.
- La grilla de captura **no se toca**: sigue naciendo vacía y sin cargar nada del servidor.

## Convenciones a respetar

- **TZ (D-020)**: BD en UTC; día Bogotá en SQL con `CAST(DATEADD(HOUR,-5, col) AS DATE)`;
  presentación con `Intl.DateTimeFormat`/`timeZone: 'America/Bogota'`. Prohibidos `getHours()` sin
  shift, `toLocaleString()` para persistir y `getTimezoneOffset()`.
- **Permisos data-driven**: nunca hardcodear cargo, `cargo_id` ni allowlist de plantas (D-055).
- **`registro_historico` no se toca** (RF-032). Ninguna etapa escribe ahí.
- **Ningún test escribe en planta real** (D-055): `TEST_PLANTA` + `TEST_TAG`, y todo `DELETE`/`UPDATE`
  con su acotador de fixture **léxicamente junto al statement** (lo exige
  `guard_no_prod_historico_destruction.test.js`).
- **Saneamiento de errores (D-032)**: `{ error, codigo, mensaje }` con texto amigable; el front
  ramifica por `codigo`/`motivo`, nunca por texto.
- **No revivir** el pivote `GET /api/sala-de-mando` ni convertir la grilla en espejo (D-056).
- Idioma de todo artefacto, comentario y copy: **tuteo colombiano estándar, sin voseo**.
