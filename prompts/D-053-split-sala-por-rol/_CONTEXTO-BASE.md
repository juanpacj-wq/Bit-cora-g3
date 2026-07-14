# D-053 — Contexto base (compartido por todas las etapas)

> Bloque de contexto acumulado que cada prompt de etapa referencia. **Inmutable** una vez cerrada la
> planificación: si algo cambia al ejecutar, se registra en `ESTADO.md` (desviaciones), no acá.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md`.
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Vite front, Node ESM + Express back puerto 3002,
> SQL Server con esquemas `lov_bit` + `bitacora`).

## Objetivo

Partir la bitácora `SALA` ("Sala de Mando Operativa", `bitacora_id=14`, `orden=3`) en tres bitácoras
por rol: **SALAJDT** (crea solo Ingeniero Jefe de Turno), **SALAING** (crea solo Ingeniero de
Operación), **SALAOP** (crea solo Operador de Planta - Sala de Mando). Hoy SALA es la **única bitácora
del catálogo donde varios cargos comparten `puede_crear`**, lo que mezcla tres responsabilidades
operativas en un solo hilo e impide leer el histórico por rol.

Incluye la **migración de los registros existentes** de `bitacora_id=14` a su bitácora destino según el
cargo del autor (`creado_por`), en `registro_activo` y `registro_historico`.

**Fuera de alcance:** DISP, MAND (Op24h) y COMB. No se crean cargos ni App Roles de Entra. No cambia
D-049 (editar/eliminar = solo el autor). **No toca contratos cross-repo** (`evento_dashboard` /
`disponibilidad_dashboard` no se rozan: SALA nunca notificó al dashboard).

## Fuentes / insumos

- **Matriz objetivo**: tabla en `PREGUNTAS-D-053.md` → "Detalles operativos confirmados".
- **El cargo NO está en el registro.** `creado_por` es `usuario_id`; el cargo se resuelve desde el App
  Role de Entra en cada login y **no se persiste** (`server/auth/app.js:212` es un `console.log`).
  `lov_bit.usuario` no tiene `cargo_id`; no hay tabla puente ni auditoría de roles en BD.
- **Fuentes durables de atribución** (verificadas en dev):
  - `bitacora.turno_participante` (`turno_id`, `usuario_id`, `cargo_id`, `cargo_nombre`) — presencia
    viva por unidad. UNIQUE `(turno_id, usuario_id)`.
  - `bitacora.conformacion_turno` (`turno_id`, `usuario_id`, `cargo_id`, `cargo_nombre`, …) — snapshot
    inmutable congelado en `cerrarTurno`. PK `(fecha_operativa, planta_id, turno, usuario_id)`.
  - `bitacora.sesion_activa` (`usuario_id`, `planta_id`, `cargo_id`) — estado actual por combinación;
    las filas **no se borran** (se marcan `activa=0`). Sirve solo si el autor tiene **un único**
    `cargo_id` distinto: su `inicio_sesion` es last-write, así que no permite fechar nada.
- **Descartadas**: los snapshots JSON del registro (`jdts_snapshot`, `ingenieros_snapshot`,
  `jefes_snapshot`, `server/utils/snapshots.js`) describen **a los demás presentes**, no al autor;
  shape `[{usuario_id, nombre_completo}]`, sin cargo.
- **La BD de planeación fue dev.** Prod tiene datos reales y desconocidos → el reporte pre-flight (E2)
  es la fuente de verdad antes de desplegar.

## Destino en BD (lo que ya existe)

| Objeto | Ruta | Notas |
|---|---|---|
| `lov_bit.bitacora` | `db.js:409-419` (DDL), `db.js:791-815` (MERGE) | `MERGE` matchea `ON t.codigo = s.codigo`. `WHEN MATCHED … SET activa = s.activa` → **cada arranque reaplica `activa`**. |
| Rename de códigos | `db.js:760-761` | Precedente: `UPDATE … SET codigo='CALDERA' WHERE codigo='CAL'`. **El rename va acá, NUNCA dentro del MERGE.** |
| `lov_bit.tipo_evento` | `db.js:432-445` (DDL), `db.js:832-841` (seed) | Siembra `'Evento General'` a toda bitácora `NOT IN ('CIET','MAND')` que no lo tenga, en cada arranque → las 3 nuevas lo reciben solas. Índice `IX_tipo_evento_bit` **no único**. |
| `lov_bit.cargo_bitacora_permiso` | `db.js:448-455` (DDL), `db.js:914-996` (matriz) | Se **reconstruye desde cero** cada arranque (`DELETE … WITH (TABLOCKX, HOLDLOCK)` + `INSERT`), en la transacción `matrizTx`. Filtra `WHERE b.activa = 1`. Matchea por `c.nombre` y `b.codigo`. |
| Override defensivo DISP | `db.js:1147-1165` (F12.A6) | Recomputa `puede_crear` de **toda** fila DISP en cada arranque. JdT/IngOp/Admin ya están en su `IN` → **no se toca**, pero verificar que el split no los saque. |
| `bitacora.registro_activo` | `db.js:552-570` | FKs en `bitacora_id`, `planta_id`, `tipo_evento_id`, `creado_por`. `turno_id` estampado desde D-045. |
| `bitacora.registro_historico` | `db.js:585-620` | **Sin FKs a propósito** (tabla de archivo). Sin triggers. `registro_id` es PK, no IDENTITY. Tiene `bitacora_id` y `tipo_evento_id`. |
| `bitacora.migracion_aplicada` | `db.js:1398-1404` | Flag one-shot: `codigo VARCHAR(50) PK`, `aplicada_en`. |
| Purga de obsoletas | `db.js:764-779` | Lista literal cerrada `('SINC','ELEC','IC','MA')` con `THROW 50001/50002`. **SALA no está** → no se dispara. No tocar. |

**Riesgo #1 verificado:** **no existe FK ni CHECK que ate `registro.bitacora_id` ↔
`tipo_evento.bitacora_id`**, y ninguna lectura lo verifica (`registros.js:107-112` y la vista
`v_historico_busqueda`, `db.js:2300-2304`, joinean `te` por `tipo_evento_id` a secas). Un registro
movido sin remapear su tipo **se ve perfecto** y solo explota cuando alguien lo edita — cuando el drift
ya viajó al histórico.

## Endpoints existentes (lo que ya existe)

Ninguno se modifica. Todos resuelven por `bitacora_id`/`b.codigo` dinámico:

- `GET /api/catalogos/bitacoras` (`catalogos.js:46-55`) — `WHERE activa=1 AND oculta=0`, `ORDER BY orden`.
- `GET /api/catalogos/permisos/:cargo_id` (`catalogos.js:73-89`) — `LEFT JOIN` + `ISNULL(...,0)`.
- `GET /api/catalogos/bitacoras/:id/tipos-evento` (`catalogos.js:58-70`).
- `POST/PUT/DELETE /api/registros` (`registros.js`) — gating: `plantaMatch` → `hasPermisoBitacora(…,'puede_crear')` → gates de turno; edición/borrado por `canEditarRegistro` (D-049, solo autor).
- `GET /api/registros/activos` (`registros.js:79-117`) — expone el espejo por fila `puede_editar`.

## Patrones de infraestructura a reutilizar

- **Migración one-shot**: patrón F26.B1 / **F28.A1 (`db.js:2103-2147`, el molde más limpio)** — guard
  `SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='FXX.YY'` → `new sql.Transaction(db)` →
  cada paso en su propio `new sql.Request(tx).batch(...)` y **internamente idempotente** → validación
  con `THROW` → `INSERT INTO migracion_aplicada` como **último statement antes del commit** →
  `console.log('[FXX.YY] …')` post-commit → `catch { try { await tx.rollback(); } catch {} throw err; }`.
- **Doble mitad obligatoria** (comentario `db.js:1978-1984`): el `MERGE` del seed es autoritativo en
  cada restart; el bootstrap one-shot cubre el **primer** arranque de una BD fresca. **Ambas deben
  expresar la MISMA regla** o divergen.
- **Snippets manuales**: `sql/snippets/` (ej. `simular-umbral-turno-D046.sql`,
  `purga-arranque-limpio-D045.sql`) + guardrail estático que impide que `initDB`/CI los invoque
  (`server/tests/guard_purga_no_auto_ejecutable.test.js` es el molde).
- **Cierre de turno**: `cerrarTurno` (`utils/turno-entidad.js`, guard `b.oculta = 0 AND b.codigo NOT IN
  ('DISP','MAND')` en 3 sitios: ~350, ~378, ~387). Es **lista de exclusión** → las 3 SALA* entran al
  archivado solas. **No se toca.**
- **Tests**: suite serial (`npm test` lleva `--test-concurrency=1`), corre contra la **BD productiva**
  (D-030) → planta de test `TEST_PLANTA_ID='TST'`. `TEST_TAG` sin `[` ni `]`. Fechas UTC literales.
  Helpers en `server/tests/helpers.js` (`setupSessions`, `cleanupTestRegistros`,
  `deactivateSyntheticSessions`).
- **Sesiones sintéticas (regla dura, convención 14 de CLAUDE.md)**: todo fixture que cree sesiones va
  con `es_sintetico=1` y se limpia por `deactivateSyntheticSessions()`, **NUNCA por username**. El
  guard `zzz_session_leak_guard.test.js` (último del script `test`) falla nombrando al ofensor.
- **Front**: data-driven. `useCatalogos.js` (bitácoras + permisos, sin hardcode de códigos);
  dispatch por `codigo` en `BitacorasGecelca3.jsx:2433-2485` = allowlist de excepciones con `else`
  genérico → `GrillaRegistros` (definida **inline** en ese mismo archivo, `:1281`, NO en
  `components/GrillaRegistros.jsx`). Routing puro en `src/routing/appRoute.js` + `appRoute.test.js`.

## Diseño D-053 (acordado)

### Cambios de catálogo (`server/db.js`)

1. **Rename previo al MERGE** (patrón `db.js:760-761`), idempotente:
   ```sql
   UPDATE lov_bit.bitacora SET codigo='SALAJDT' WHERE codigo='SALA';
   ```
2. **MERGE**: la fila de SALA se vuelve tres. SALAJDT conserva `orden=3`; SALAING/SALAOP toman valores
   libres contiguos — **no reusar `11`** (ya colisiona entre CIET y COMB). Iconos **dentro de
   `ICON_MAP`** (`src/BitacorasGecelca3.jsx:70-73`): el `Monitor` actual **no está en el mapa** y ya cae
   al fallback genérico `FileText`.
3. `tipo_evento` no requiere acción: el seed de `db.js:832-841` siembra su `'Evento General'` propio.

### Matriz de permisos (`db.js:920-990`)

- `puede_ver` (`db.js:946`): `Operador de Planta - Sala de Mando` → `b.codigo='SALAOP'`.
- `puede_crear`: **se parte el `IN` compartido de `db.js:974`**, preservando DISP para ambos:
  ```sql
  WHEN c.nombre = 'Ingeniero Jefe de Turno' THEN CASE WHEN b.codigo IN ('DISP','SALAJDT') THEN 1 ELSE 0 END
  WHEN c.nombre = 'Ingeniero de Operación'  THEN CASE WHEN b.codigo IN ('DISP','SALAING') THEN 1 ELSE 0 END
  ```
  `'AUTH'` sale del `IN`: es código muerto (AUTH está sembrada `activa=0` en `db.js:801` y la matriz
  filtra `WHERE b.activa=1`).
- `puede_crear` (`db.js:980`): `Operador de Planta - Sala de Mando` → `b.codigo='SALAOP'`.
- `Administrador y Debugging` cubre las tres por su `WHEN` de acceso total (primero en ambos `CASE`, D-039).

### Lógica núcleo — escalera de atribución (migración `F30.A1`)

Tras el rename, **todos los registros quedan en id=14 = SALAJDT**. La migración es un **move-out por
atribución positiva**: solo mueve lo atribuible a IngOp (→SALAING) o a Op de Sala (→SALAOP). Lo demás
**no se toca** (identidad) y se cuenta en el log. Sin `THROW` por ambigüedad → cero riesgo de tumbar el
arranque de prod.

`COALESCE`, la primera que resuelve gana:

1. `turno_participante` por `(turno_id, usuario_id)` → `cargo_id`.
2. `conformacion_turno` por `(turno_id, usuario_id)` → `cargo_id`.
3. `sesion_activa` con `HAVING COUNT(DISTINCT cargo_id) = 1` → ese `cargo_id`.
4. Sin resolver → se queda en SALAJDT, se reporta.

**Descartada a propósito** la vía "clave natural `(creado_por, planta_id, turno, fecha)` →
`conformacion_turno`": el turno 2 cruza medianoche y `fecha_operativa` es el día en que **arrancó** el
turno, así que derivarla desde `fecha_evento` es una trampa. Los pasos 1–2 cubren todo lo post-D-045.

**Regla dura:** todo `UPDATE` de `bitacora_id` **remapea `tipo_evento_id` en el mismo statement**,
resolviendo el `'Evento General'` de la bitácora destino (ver Riesgo #1 arriba).

**Respaldo (RF-032):** antes del primer `UPDATE` a `registro_historico`, copiar las filas afectadas a
`bitacora.registro_historico_backup_D053` (`SELECT * INTO`, dentro de la transacción). Queda residente
como evidencia y habilita rollback.

### Módulos nuevos

- `sql/snippets/reporte-split-sala-D053.sql` — reporte **solo lectura** para correr contra prod antes
  del deploy: conteos por tabla, cuántos resuelve cada escalón, desglose por cargo destino y —el dato
  que decide— **cuántos quedan sin atribuir**.
- `server/tests/guard_reporte_split_sala_no_auto_ejecutable.test.js` — guardrail estático.
- `server/tests/split_sala_permisos.test.js` — fija la matriz objetivo.
- `server/tests/guard_tipo_evento_coherente.test.js` — ningún registro con `tipo_evento_id` de otra bitácora.

### Endpoints nuevos / cambios

**Ninguno.** Todo el gating es data-driven sobre la matriz.

### Front

**Sin cambios obligatorios** (decisión: tres pestañas sueltas). Verificado: **el literal `'SALA'` no
existe en `src/`** — el único match uppercase es `SALA_DE_MANDOS`, que es la **categoría "Despachos"**
(agrupa DISP+MAND) y no tiene relación con la bitácora. Las 3 caen solas en `GrillaRegistros` por el
`else` del dispatch, y los banners/write-gates de D-040/D-045/D-046 las cubren por exclusión.

**Único añadido:** alias de deep link `#/b/SALA` → `SALAJDT` en `src/routing/appRoute.js`. Sin él, un
favorito viejo no falla ni avisa: cae al fallback mudo `bitacorasPermitidas[0]`
(`BitacorasGecelca3.jsx:1944`) y reescribe la URL con `replaceState`.

## Convenciones a respetar

- **TZ canónica**: BD en UTC (`SYSUTCDATETIME()`), presentación Bogotá explícita. Comparación de día
  Bogotá en SQL: `CAST(DATEADD(HOUR, -5, columna) AS DATE)`. Prohibidos `getHours()` sin shift,
  `toLocaleString()` para persistir, `getTimezoneOffset()`.
- **Migraciones idempotentes** (`IF NOT EXISTS` / `WHERE … IS NULL` / `MERGE`) **y** gated por flag: el
  flag es cinturón, la idempotencia es tirantes.
- **Saneamiento de errores (D-032)**: nunca devolver `err.message` crudo; `{error, codigo, mensaje}`.
- **NO tocar**: `utils/turno-entidad.js` (el guard de cierre es por exclusión), `entra-roles.js` (no hay
  cargos nuevos), el override DISP F12.A6, la purga de obsoletas `db.js:764-779`, ni las vistas
  dashboard (D-041: son SOLO LECTURA, con trigger `INSTEAD OF … THROW`).
- Idioma de todo artefacto, comentario y copy: **tuteo colombiano estándar, sin voseo**.
