# D-063 — Contexto base (compartido por todos los lotes)

> Bloque de contexto que cada prompt de lote referencia **por sección** (un lote no lo relee
> entero: su prompt dice qué secciones). **Inmutable** desde el 2026-08-28: si algo cambia durante
> la ejecución, se registra en el cierre del lote y el gate lo propaga como "hecho que cambia" en
> `GATE-On.md`, no acá.
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Node ESM/Express + MSSQL; backend :3002).
> Rama del flujo: `feat/reflejo-disp-sala-2026-08`, nacida de `feat/integrar-asientos-D-059 @ 6d7e1e2`.

## 1. Objetivo
Reflejar los eventos de **Disponibilidad (DISP)** hacia las bitácoras de Sala `SALAJDT` y `SALAING`
—la mitad de REQ-02 que D-058 dejó fuera—: **crear** un estado genera dos copias (RQ-02.10),
**editar** el vigente las actualiza (RQ-02.11) y **deshacer** las deja **visibles y anuladas** con
constancia de quién deshizo (RQ-02.12), reusando el motor `server/utils/asientos/` y el módulo
`server/utils/reflejo-sala.js` que ya hace esto para Operación 24h. Fuera de alcance: `SALAOP`,
retroactividad, editar la copia en destino, reflejo de COMB, cambiar quién escribe en Sala (D-053).
**No toca el contrato cross-repo** (`evento_dashboard` / `disponibilidad_dashboard` intactos;
RN-02.a). **Sin DDL, sin migración, sin `db.js`.**

## 2. Fuentes / insumos
- `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md` §3.4, §4, §5.1, §6 (criterios 1–10), §8.
- `docs/decisions.md` → **D-058** (decisiones 3, 4, 5, 7 y Consecuencias (a)); D-055 (c) (sin FK
  posible); D-049 (solo el autor + espejo SQL); D-053 (coherencia `tipo_evento_id`); D-045 (turno_id
  = puntero de archivado); D-026/D-041 (DISP en tabla base, vistas de solo lectura).
- BIT-RF §RF-074 (reflejo MAND) y BIT-MODBD §7.11 (asientos reflejados) — se amplían en L05.
- `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md` §5.4 (plantillas DISP, ya en el motor).
- `PREGUNTAS-D-063.md` (respuestas congeladas y CA-1…CA-16).

## 3. Lo que ya existe (snapshot 2026-08-28 — confirma líneas con Grep antes de editar)

### 3.1 Motor y módulo de reflejo
- `server/utils/asientos/index.js:45` — `asientoDisponibilidad({ planta_id, evento, detalle })` →
  p. ej. `GEC3 F/L indisponible. <detalle>.` Lanza `TypeError` ante estado desconocido. Probado en
  `tests/asientos.test.js:160-163`.
- `server/utils/reflejo-sala.js` (338 líneas) — exporta `BITACORAS_REFLEJO`, `TIPO_ESPEJO_MAND`,
  `plantaRefleja(planta_id)` (`:45`, RN-02.e: `!== TEST_PLANTA_ID`), `crearReflejoLote` (`:164`),
  `actualizarReflejoLote` (`:249`), `borrarReflejoLote` (`:314`). Internos: `resolverBitacorasDestino`
  (`:73`), `resolverDestinos(tx,{nombreTipo})` (`:91`, resuelve `(bitacora_id, tipo_evento_id)` por
  nombre en cada llamada), `normalizarLote` (`:116`). El INSERT de las copias está inline en
  `crearReflejoLote` (`:198-222`). Los DML de MAND acotan por `origen_lote_id` + `planta_id` +
  `bitacora_id IN (@salajdt,@salaing)` (`:294-296`, `:330-332`).
- `campos_extra` de una copia MAND hoy: `{ "origen_bitacora": "MAND", "origen_lote_id": "<GUID>" }`.

### 3.2 DISP (origen)
- Tabla base `bitacora.disponibilidad_estado` (`db.js:1871-1889`): `disponibilidad_id INT IDENTITY`,
  `planta_id`, `estado` (CHECK: `En Servicio | En Reserva | Indisponible | Mantenimiento`), `codigo`,
  `fecha_inicio_estado`, `fecha_fin_estado` (NULL = vigente), `detalle`, `jdts_snapshot`,
  `jefes_planta_snapshot`, `gerentes_produccion_snapshot`, `ingenieros_snapshot`, `creado_por`,
  `creado_en`, `modificado_por`, `modificado_en`. Los ids **nunca se reusan** (IDENTITY).
- Helpers en `server/utils/notificador.js`: `findVigente` (`:237`, UPDLOCK), `findUltimoCerrado`
  (`:254`), `cerrarVigente` (`:269`), `insertNuevoEstado` (`:278`, `OUTPUT INSERTED.*`),
  `actualizarVigente` (`:310`), `eliminarPorId` (`:337`), `restaurarComoVigente` (`:344`).
- **Crear**: `POST /api/registros` rama DISP (`server/routes/registros.js:147-259`): gate
  `hasPermisoBitacora(puede_crear)` por cargo, **cross-planta** (no `plantaMatch`), `plantaCheck`
  `activa=1` (`:157-162`), validaciones, transacción: `findVigente` → 409 `mismo_estado` /
  `fecha_anterior_a_vigente` → `cerrarVigente` → snapshots → `insertNuevoEstado` (`:238`) →
  `commit` (`:251`) → `broadcastConteoBitacoras`. Responde `201 { registro (shape legacy vía
  mapDispRowToLegacyShape :46), vigente_anterior_movido_id }`.
- **Editar**: `PUT /api/registros/:id` rama DISP (`registros.js:464-604`): solo el VIGENTE (422 si
  `fecha_fin_estado` no es NULL), gate `puede_crear`, cross-planta, no mueve de planta; puede cambiar
  `evento`, `fecha_inicio_estado`, `detalle`; ajusta N-1 (D-011); `actualizarVigente` (`:574`) →
  re-lee → `commit` (`:598`) → `200 { registro }`.
- **Deshacer**: `POST /api/disponibilidad/deshacer { planta_id }` (`server/routes/disponibilidad.js:109-170`):
  gate `puede_crear`, cross-planta, transacción: `findVigente` (422 `sin_vigente` si no hay) →
  `findUltimoCerrado` → `eliminarPorId(vigente)` (`:135`) → `restaurarComoVigente(nMenos1)` →
  `registrarDeshacerDisponibilidad` (CIET, `utils/ciet.js:83`, guarda `autor_delete: { usuario_id,
  nombre_completo, cargo }`) → `commit` → `200 { revertido, restaurado, ciet_registro_id }`.
- `req.sesion` (vía `loadAppSession`) trae `usuario_id`, `planta_id`, `cargo_id`, `nombre_completo`,
  `cargo_nombre`, `turno`.

### 3.3 Predicado "asiento reflejado" (hoy por `origen_lote_id`) — los CINCO puntos
1. `server/middleware/permissions.js:80-91` — `CLAVE_ORIGEN_REFLEJO = 'origen_lote_id'`,
   `esAsientoReflejado(registro)`; `canEditarRegistro` (`:102-115`) lo consulta primero.
2. `server/routes/registros.js:112` — espejo SQL de `GET /activos`:
   `AND JSON_VALUE(r.campos_extra, '$.origen_lote_id') IS NULL` dentro del `CASE` de `puede_editar`;
   `:118-119` `LEFT JOIN lov_bit.bitacora borigen ON borigen.codigo = JSON_VALUE(…'$.origen_bitacora')`
   → `origen_bitacora_nombre` (ya sirve para cualquier origen). Los 403 `asiento_reflejado` del PUT
   (`:637-642`) y DELETE (`:822-827`) tienen el texto **hardcodeado "Operación 24h"**.
3. `server/utils/f03-datos.js:320` — `eventosSala` excluye copias con
   `AND JSON_VALUE(r.campos_extra, '$.origen_lote_id') IS NULL`.
4. `src/BitacorasGecelca3.jsx:1545-1546` — `const esReflejado = !!camposExtraValores.origen_lote_id;`
   + chip (`:1755-1765`: `Lock` + `origenNombre`), `puedeEditar` viene de `reg.puede_editar`
   (`:1429-1430`). `parseCamposExtra` ya parsea el JSON.
5. Históricos: `server/routes/historicos.js` lee `v_historico_busqueda` (incluye `campos_extra`,
   `db.js:2506-2507`); `src/components/historicos/HistoricoTable.jsx:70` renderiza
   `<DetalleCell texto={r.detalle} />` (`DetalleCell` en `:111`), sin mirar `campos_extra`.
- Tests que fijan este predicado con `origen_lote_id`: `tests/registros_solo_autor.test.js:196-232`
  (`marcarComoReflejado` escribe `{ origen_bitacora:'MAND', origen_lote_id }`; tests 6–7),
  `tests/f03_datos.test.js:187-195, 404-405` (`seedSala({ origen_lote_id })`),
  `src/components/grilla-solo-autor-gate.test.jsx` (fixture `campos_extra`).

### 3.4 Archivado, conteo, catálogo
- `cerrarTurno` (`server/utils/turno-entidad.js:257`) archiva `registro_activo` → `registro_historico`
  copiando `campos_extra` tal cual (`:372-386`), por `turno_id = @id` (o `turno_id IS NULL` en
  ventana), `estado='borrador'`, `codigo NOT IN ('DISP','MAND')`. `resolverTurnoAbierto(pool, planta)`
  (`:144`) y `resolverOAbrirTurnoAbierto` (`:160`). El sweeper solo transiciona GEC3/GEC32.
- `server/utils/ws-conteo-bitacoras.js:15-18` cuenta `registro_activo` por bitácora con
  `estado='borrador'` (una copia anulada sigue contando: es un registro real).
- Tipos espejo (F34.A1, `db.js:1068-1109`): `Cambio de Disponibilidad` en SALAJDT y SALAING con
  `seleccionable=0`, reafirmado en cada arranque. Guard `tests/tipos_evento_espejo.test.js`.
- Fixtures de test (`server/tests/helpers.js`): `TEST_PLANTA='TST'` (`activa=1`, **no refleja**),
  `TEST_PLANTA_REFLEJO='TSR'` (`activa=0`, refleja; `setupSesionReflejo({cargo})` `:45` siembra
  planta+usuario `test_reflejo_jdt`+sesión y **reapaga `activa=0` en cada corrida**),
  `cleanupTestRegistros` (`:313`), `deactivateSyntheticSessions` (`:128`), `TEST_TAG`, `call`.
  Patrón de limpieza de TSR: `cleanReflejo()` en `tests/sala_de_mando_batch.test.js:2892-2903`
  (DELETE de `evento_dashboard`/`registro_activo`/`registro_historico`/`mand_cierre_log` por
  `@p = TEST_PLANTA_REFLEJO`). Guards estáticos: `guard_no_prod_historico_destruction` acepta
  `TEST_PLANTA_REFLEJO` como acotador (`:62-63`); `guard_no_prod_disp_destruction` regla B solo
  prohíbe literales `'GEC3'/'GEC32'` en DML de `disponibilidad_estado`. `tests/residuos.js` cuenta
  `TST` y `TSR` en `registro_activo/historico/disponibilidad_estado/evento_dashboard`.
- `tests/zzz_session_leak_guard.test.js` (último del script `test`) ya importa
  `TEST_PLANTA_REFLEJO` y desactiva sesiones sintéticas en `after()`.

## 4. Patrones de infraestructura a reutilizar
- Transacción `mssql`: `new sql.Transaction(db)` → `begin` → `new sql.Request(tx).input(...).query(...)`
  → `commit`; `rollback` en `catch` y `throw err` (lo hacen los tres handlers de DISP). El módulo de
  reflejo **nunca** abre ni cierra transacciones ni se traga errores.
- Sello de auditoría por `CASE` contra el valor anterior (`reflejo-sala.js:287-290`).
- `JSON_MODIFY(campos_extra, '$.anulado', JSON_QUERY(@json))` para insertar un objeto en JSON
  existente (modo lax; **setear `null` borra la clave**, D-057). `JSON_VALUE` lanza ante texto no-JSON:
  la premisa "campos_extra de una copia siempre es JSON" (D-058 (g)) se conserva.
- TZ: BD en UTC; `turnoFromPeriodo(periodoFromFechaBogota(date))` (`utils/turno.js`) para la
  columna `turno`; front con `Intl.DateTimeFormat`/`timeZone:'America/Bogota'` (`src/utils/fecha.js`).
- Tests HTTP: backend efímero `SERVER_PORT=31NN AUTH_TEST_BYPASS=1 SKIP_INITDB=1
  node --env-file=../.env server.js` + `TEST_BASE_URL`; `call(method, path, { body, sesion_id })`;
  `DB_HOST=192.168.17.20 DB_PORT=1433` si la conexión cuelga. Test-lock del semáforo para todo lo
  que toque BD. `SKIP_INITDB=1` en todos los lotes (nadie es dueño de `db.js`).
- Front: vitest + jsdom montando el componente REAL (`src/components/grilla-solo-autor-gate.test.jsx`
  como plantilla: `createRoot` + `act`, `makeRegistro()`); `npm run build` antes de commitear.

## 5. Diseño acordado

### 5.1 Schema / cambios de BD
**Ninguno.** Todo vive en `campos_extra` (NVARCHAR JSON) de la copia. `F35.A1` no se consume.

### 5.2 Lógica núcleo
- **Marcador universal:** una fila de Sala es *asiento reflejado* ⇔ `campos_extra.origen_bitacora`
  es una cadena no vacía (`'MAND'` o `'DISP'`). El **puntero** al origen es específico:
  `origen_lote_id` (MAND, GUID) u `origen_disponibilidad_id` (DISP, INT). Los cinco puntos de §3.3
  cambian a `origen_bitacora` **juntos** (L04 backend + L03 front) y un guard estático lo fija.
- **Copia DISP** = fila de `registro_activo` en SALAJDT y en SALAING con:
  `detalle = asientoDisponibilidad({ planta_id, evento, detalle })`; `tipo_evento_id` del tipo
  `Cambio de Disponibilidad` de **esa** bitácora (resuelto por nombre en cada llamada);
  `campos_extra = { origen_bitacora:'DISP', origen_disponibilidad_id:<int> }`;
  `fecha_evento = fecha_inicio_estado`; `turno = turnoFromPeriodo(periodoFromFechaBogota(fecha))`;
  `turno_id = resolverTurnoAbierto(tx, planta_id)?.turno_unidad_id ?? null`; `estado='borrador'`;
  `creado_por` = autor del origen; snapshots los de la transacción DISP.
- **Editar** (vigente): `UPDATE` de `detalle`, `fecha_evento`, `turno` en las copias vivas
  (predicado: `JSON_VALUE(campos_extra,'$.origen_disponibilidad_id') = @id AND planta_id = @p AND
  bitacora_id IN (@salajdt,@salaing)`); `modificado_por/en` por `CASE`; `tipo_evento_id` y
  `turno_id` **no** se tocan. `rowsAffected = 0` no es error.
- **Anular** (deshacer): `UPDATE campos_extra = JSON_MODIFY(campos_extra,'$.anulado',JSON_QUERY(@a)),
  modificado_por=@u, modificado_en=SYSUTCDATETIME()` con el mismo predicado **más**
  `JSON_VALUE(campos_extra,'$.anulado.en') IS NULL` (idempotente). `@a = JSON.stringify({ por:
  usuario_id, nombre: nombre_completo|null, cargo: cargo_nombre|null, en: <ISO UTC del servidor> })`.
  `detalle` intacto. No borra. La copia del N-1 restaurado no se toca. `rowsAffected = 0` no es error.
- **Solo lectura en destino** (también para el autor): `canEditarRegistro` → `false`; `PUT`/`DELETE`
  → `403 { error, codigo:'asiento_reflejado', mensaje, origen_bitacora, origen_bitacora_nombre }`
  con mensaje que nombra el origen real (p. ej. "Este asiento se generó en Disponibilidad…").
- **Atomicidad** (RQ-02.9): enganches sin `try/catch` dentro de la transacción del origen.
- **RN-02.d/e:** DISP está exenta de gates de turno → la copia se crea igual (`turno_id` NULL si no
  hay abierto). `TEST_PLANTA` no refleja (guard dentro del módulo, `plantaRefleja`).

### 5.3 Módulos nuevos / tocados
| Ruta | Lote | Responsabilidad |
|---|---|---|
| `server/utils/reflejo-sala.js` | L01 | + `TIPO_ESPEJO_DISP`, `CLAVE_ORIGEN_DISP`, `crearReflejoDisponibilidad`, `actualizarReflejoDisponibilidad`, `anularReflejoDisponibilidad`; helper interno `insertarCopias` compartido con MAND (refactor sin cambio de comportamiento). |
| `server/tests/reflejo_disponibilidad.test.js` (nuevo) | L01 | Tests del módulo con transacción directa sobre `TSR` (sin HTTP). |
| `server/middleware/permissions.js` | L04 | `CLAVE_ORIGEN_REFLEJO = 'origen_bitacora'`; `esAsientoReflejado` por ese marcador. |
| `server/routes/registros.js` | L04 (O1) / L02 (O2) | O1: espejo SQL de `GET /activos` + 403 origin-aware. O2: enganches en POST/PUT DISP. |
| `server/utils/f03-datos.js` | L04 | Exclusión por `origen_bitacora`. |
| `server/tests/guard_marcador_reflejo.test.js` (nuevo) | L04 | Guard estático de los cinco puntos. |
| `server/tests/registros_solo_autor.test.js`, `server/tests/f03_datos.test.js` | L04 | Casos DISP + fixtures con el marcador nuevo. |
| `server/routes/disponibilidad.js` | L02 | Deshacer → `anularReflejoDisponibilidad` + `copias_anuladas`. |
| `server/tests/disponibilidad_reflejo_http.test.js` (nuevo) | L02 | HTTP sobre `TSR` (activa temporal). |
| `server/tests/zzz_session_leak_guard.test.js` | L02 | Guard final: `TSR.activa = 0`. |
| `src/BitacorasGecelca3.jsx`, `src/components/historicos/HistoricoTable.jsx` | L03 | Marcador `origen_bitacora`; estado visual "Anulado". |
| `src/components/grilla-asiento-anulado.test.jsx`, `src/components/historicos/historico-anulado.test.jsx` (nuevos), `src/components/grilla-solo-autor-gate.test.jsx` | L03 | Vitest. |
| `BIT-MODBD-2026-001.md`, `BIT-RF-2026-001.md`, `docs/architecture.md`, `docs/requerimientos/REQ-02-*.md`, `docs/requerimientos/REQ-06-*.md` | L05 | Docs. |

### 5.4 Endpoints (cambios)
- `POST /api/registros` (DISP): mismo request/response; efecto lateral: 2 copias. 
- `PUT /api/registros/:id` (DISP): mismo request/response; efecto lateral: copias actualizadas.
- `POST /api/disponibilidad/deshacer`: response **+ `copias_anuladas: number`**.
- `PUT`/`DELETE /api/registros/:id` (genérico) sobre copia: `403 asiento_reflejado` **+
  `origen_bitacora`, `origen_bitacora_nombre`** y mensaje con el nombre del origen.
- `GET /api/registros/activos`: `puede_editar=false` para toda fila con `origen_bitacora`;
  `origen_bitacora_nombre` como hoy.

### 5.5 Front
- Grilla (`RegistroRow`): `esReflejado = !!campos.origen_bitacora`; `esAnulado = !!campos.anulado`
  (objeto). Fila anulada: `detalle` con `line-through` + atenuado, chip "Anulado" (`Ban` de
  lucide) con `title` = `Deshecho por ${anulado.nombre ?? 'usuario ' + anulado.por} el
  ${fechaBogota(anulado.en)}`; el chip de origen y el ojo se conservan; sin lápiz/basurero (ya lo
  manda `puede_editar`). Históricos (`HistoricoTable`): parsea `campos_extra`; misma marca
  (tachado + chip con tooltip), sin nombre del origen. Sin cambios de routing ni hooks.

## 6. Contratos entre lotes (fijos durante la ola)
> Precisión de `.d.ts`. Cambiarlos es un **bloqueo** (`lotes.mjs block`) que decide el gate.

| # | Contrato | Productor | Consumidores | Definición |
|---|---|---|---|---|
| C1 | `server/utils/reflejo-sala.js` — DISP | L01 | L02 | `export const TIPO_ESPEJO_DISP = 'Cambio de Disponibilidad'`; `export const CLAVE_ORIGEN_DISP = 'origen_disponibilidad_id'`. **`crearReflejoDisponibilidad(tx, { planta_id: string, disponibilidad_id: number, evento: 'En Servicio'\|'En Reserva'\|'Indisponible'\|'Mantenimiento', detalle: string\|null, fecha_inicio_estado: Date\|string, creado_por: number, snapshots?: { ingenieros_snapshot?, jdts_snapshot?, jefes_snapshot? } }) → Promise<{ copias: 2, asiento: string } \| { copias: 0, omitido: 'planta_de_test' }>`**; lanza `TypeError` si falta `disponibilidad_id`/`creado_por`, si la fecha es inválida o si `evento` no tiene plantilla; `Error` si falta el tipo espejo. **`actualizarReflejoDisponibilidad(tx, { planta_id, disponibilidad_id, evento, detalle, fecha_inicio_estado, modificado_por: number }) → Promise<{ copias: number, asiento: string }>`** (`copias` puede ser 0). **`anularReflejoDisponibilidad(tx, { planta_id, disponibilidad_id, anulado_por: { usuario_id: number, nombre_completo?: string\|null, cargo?: string\|null } }) → Promise<{ copias: number }>`** (0 si no hay copias vivas o ya estaban anuladas). Las tres devuelven `{ copias: 0, omitido: 'planta_de_test' }` para `TEST_PLANTA` sin tocar la BD. Ninguna abre/cierra transacción ni captura errores. |
| C2 | `campos_extra` de una copia DISP | L01 | L03, L04, L05 | Viva: `{ "origen_bitacora": "DISP", "origen_disponibilidad_id": 123 }` (número, no string). Anulada: además `"anulado": { "por": <usuario_id>, "nombre": <string\|null>, "cargo": <string\|null>, "en": "<ISO UTC>" }`. Nunca otras claves. Las copias MAND siguen con `{ origen_bitacora:'MAND', origen_lote_id }`. |
| C3 | Marcador universal | L04 | L01, L02, L03 | `permissions.js`: `export const CLAVE_ORIGEN_REFLEJO = 'origen_bitacora'`; `esAsientoReflejado(registro)` ⇔ `campos_extra` parseado tiene `origen_bitacora` string no vacía. Espejo SQL de `GET /activos`: `JSON_VALUE(r.campos_extra, '$.origen_bitacora') IS NULL`. Exclusión F03: idem. Front: `!!campos.origen_bitacora`. |
| C4 | `403 asiento_reflejado` | L04 | L03 (front ramifica por `codigo`) | `PUT`/`DELETE /api/registros/:id` sobre copia → `403 { error: string, codigo: 'asiento_reflejado', mensaje: string, origen_bitacora: 'MAND'\|'DISP', origen_bitacora_nombre: string\|null }`. `mensaje` en tuteo colombiano y nombra `origen_bitacora_nombre` (fallback "su bitácora de origen"). |
| C5 | Enganches DISP | L02 | — | POST DISP: tras `insertNuevoEstado`, antes del `commit`: `crearReflejoDisponibilidad(transaction, { planta_id, disponibilidad_id: row.disponibilidad_id, evento, detalle: detalle ?? null, fecha_inicio_estado: fechaInicio, creado_por: sesion.usuario_id, snapshots: { ingenieros_snapshot, jdts_snapshot, jefes_snapshot: jefes_planta_snapshot } })`. PUT DISP: tras `actualizarVigente`: `actualizarReflejoDisponibilidad(transaction, { planta_id: reg.planta_id, disponibilidad_id: reg.disponibilidad_id, evento: eventoNuevo, detalle: detalleNuevo, fecha_inicio_estado: fechaInicioNueva, modificado_por: sesion.usuario_id })`. Deshacer: antes de `eliminarPorId`: `const { copias } = await anularReflejoDisponibilidad(transaction, { planta_id, disponibilidad_id: vigente.disponibilidad_id, anulado_por: { usuario_id: sesion.usuario_id, nombre_completo: sesion.nombre_completo ?? null, cargo: sesion.cargo_nombre ?? null } })` → respuesta `+ copias_anuladas: copias`. **Sin `try/catch`** alrededor. |
| C6 | Guard final TSR | L02 | gate | `zzz_session_leak_guard.test.js`: test "la planta-fixture TSR queda apagada" → falla si `lov_bit.planta.activa = 1` para `TEST_PLANTA_REFLEJO`; su `after()` ejecuta `UPDATE lov_bit.planta SET activa = 0 WHERE planta_id = @tsr` pase lo que pase. |
| C7 | Shape de fila para el front | L04 (backend ya lo da) | L03 | `GET /activos` → `registro.campos_extra` (string JSON o null), `registro.origen_bitacora_nombre` (string\|null), `registro.puede_editar` (bool). `GET /api/historicos…` → fila con `campos_extra` (string JSON o null) y `detalle`. El front NO recibe `anulado` como columna: lo parsea de `campos_extra` (C2). |

## 7. Reservas (consumidas al planificar)
| Qué | Valor reservado | Verificado en |
|---|---|---|
| ADR | `D-063` (stub en `docs/decisions.md`) | último ADR = D-061 en las 6 ramas locales; D-062 reservado por el usuario para la grilla COMB |
| Migraciones | **ninguna** (`F35.A1` queda libre; en `migrations/README.md` es solo ejemplo) | `migracion_aplicada`: dev F30–F33, prod F30–F31 |
| Convención `CLAUDE.md` | **36** | última = 35 en todas las ramas |
| `BIT-MODBD` / `BIT-RF` | **2.6** / **2.2** (+ **RF-077**) | changelogs: 2.5 (2026-08-27) / 2.1 (2026-08-27, RF-076) |
| Archivos de test nuevos | `server/tests/reflejo_disponibilidad.test.js` (L01), `server/tests/disponibilidad_reflejo_http.test.js` (L02), `server/tests/guard_marcador_reflejo.test.js` (L04), `src/components/grilla-asiento-anulado.test.jsx`, `src/components/historicos/historico-anulado.test.jsx` (L03) | no existen |
| Puertos de test | L01 → 3101 · L02 → 3102 · L03 → 3103 · L04 → 3104 · L05 → 3105 | libres |
| Códigos de error | `asiento_reflejado` (existente, payload ampliado) | — |
| Claves JSON | `origen_disponibilidad_id`, `anulado` | no existen en ninguna fila |

## 8. Archivos compartidos y su escritor en cada ola
| Archivo | O1 | O2 | Cierre |
|---|---|---|---|
| `server/db.js` | — (nadie) | — | — |
| `server/package.json` (script `test`) | gate | gate | gate |
| `server/routes/registros.js` | **L04** | **L02** | — |
| `server/routes/disponibilidad.js` | — | L02 | — |
| `server/middleware/permissions.js` | L04 | — | — |
| `server/utils/reflejo-sala.js` | L01 | — | — |
| `server/utils/f03-datos.js` | L04 | — | — |
| `server/tests/zzz_session_leak_guard.test.js` | — | L02 | — |
| `src/BitacorasGecelca3.jsx` | L03 | — | — |
| `docs/decisions.md`, `CLAUDE.md` | — | — | integrador |
| `BIT-*`, `docs/architecture.md`, REQ-02, REQ-06 | — | L05 | integrador revisa |
| `ESTADO.md`, `PLAN-OLAS.md`, `GATE-On.md`, `LOTES.json` | integrador / `lotes.mjs` | idem | idem |

## 9. Convenciones a respetar
- TZ: BD en UTC; presentación Bogotá explícita; `anulado.en` ISO UTC del servidor.
- Nada de DML sobre vistas dashboard; nada de literales `'GEC3'/'GEC32'` en tests (D-041/D-055);
  toda limpieza acotada por `TEST_PLANTA` / `TEST_PLANTA_REFLEJO` / `TEST_TAG` / `es_sintetico`.
- `SKIP_INITDB=1` en todo backend efímero de este flujo; test-lock para todo lo que toque BD.
- No reintroducir bypass por cargo en `canEditarRegistro` (D-049); helper y espejo SQL **juntos**.
- No hardcodear nombres de bitácora ni de cargo (D-052, D-039); el chip usa el nombre del catálogo.
- El texto de la copia lo arma SOLO el motor; ningún prefijo ni sufijo manual (D-058 (1)).
- Commits `tipo(D-063 LNN): …` con `git commit -- <rutas>`; sin firmas de IA; sin `--amend`,
  `stash`, `reset`, `checkout --`, `restore`, `rebase`, `push`.
- Tuteo colombiano estándar, sin voseo, en todo texto (código, comentarios, UI, docs).
