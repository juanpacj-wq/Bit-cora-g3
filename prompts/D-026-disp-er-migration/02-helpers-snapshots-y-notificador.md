# Prompt 02 — Helpers de snapshots y notificador (D-026)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Pre-requisito:** prompt 01 ya corrido (tabla `bitacora.disponibilidad_estado` existe).

## Tu tarea

(a) Agregar `snapshotGerentesProduccion(reqFactory)` en `server/utils/snapshots.js`.

(b) Reemplazar los helpers de `disponibilidad_dashboard` (tabla ahora vista) en `server/utils/notificador.js` por helpers nuevos que operen sobre `bitacora.disponibilidad_estado`.

## Contexto

La tabla `bitacora.disponibilidad_dashboard` fue reemplazada por una VIEW en el prompt 01. Cualquier código que escribía a ella (helpers `upsertDisponibilidadDashboard`, `deleteDisponibilidadDashboard`) ya no puede hacerlo — fallaría con "cannot UPDATE view". Esos helpers deben eliminarse. La nueva tabla `bitacora.disponibilidad_estado` es la única fuente de escritura para DISP; los handlers van a llamar helpers nuevos que encapsulan SELECT/INSERT/UPDATE/DELETE sobre ella.

## (a) `server/utils/snapshots.js`

Lee el archivo completo primero — vas a seguir el patrón de `snapshotJDTs`, `snapshotJefes`, `snapshotIngenieros` ya exportados.

Agregar:

```js
/**
 * Snapshot de Gerentes de Producción con sesión activa global.
 * Patrón: igual que `snapshotJefes`, pero filtra por cargo y por sesión viva
 * (no por flag `es_jefe_planta`). Sin filtro de planta (rol global).
 *
 * Devuelve JSON string '[]' si no hay nadie — nunca NULL.
 */
export async function snapshotGerentesProduccion(reqFactory) {
  const res = await reqFactory()
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      JOIN lov_bit.cargo c   ON c.cargo_id   = s.cargo_id
      WHERE s.activa = 1
        AND u.activo = 1
        AND c.nombre = 'Gerente de Producción'
    `);
  return JSON.stringify(res.recordset);
}
```

## (b) `server/utils/notificador.js`

### Eliminar (lineas ~108–165 según la auditoría):

- `findDisponibilidadDashboard`
- `upsertDisponibilidadDashboard`
- `deleteDisponibilidadDashboard`

Estos referencian la tabla `bitacora.disponibilidad_dashboard` que ahora es vista de solo lectura. Cualquier import desde `server.js` se va a romper — los handlers se refactorizan en prompts 03 y 04.

### Mantener:

- `hasNotificarDashboard`, `findEventoDashboard`, `upsertEventoDashboard`, `findAutorizacion`, `upsertAutorizacion`. NO TOCAR — son MAND/AUTH, ajenos a DISP.

### Agregar nuevas helpers:

Cada helper recibe `transaction` (o `db` para reads sin lock) y devuelve datos limpios o realiza la mutación. Trabajan exclusivamente sobre `bitacora.disponibilidad_estado`.

```js
import sql from 'mssql';

// Lee el vigente (fecha_fin_estado IS NULL) de una planta con UPDLOCK+HOLDLOCK
// para serializar POSTs concurrentes.
export async function findVigente(transaction, { planta_id }) {
  const r = await new sql.Request(transaction)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1
        disponibilidad_id, planta_id, estado, codigo,
        fecha_inicio_estado, fecha_fin_estado, detalle,
        jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
        creado_por, creado_en, modificado_por, modificado_en
      FROM bitacora.disponibilidad_estado WITH (UPDLOCK, HOLDLOCK)
      WHERE planta_id = @p AND fecha_fin_estado IS NULL
    `);
  return r.recordset[0] || null;
}

// Lee el último cerrado (DESC por fecha_inicio_estado). Sin lock — solo para resolver el N-1.
export async function findUltimoCerrado(transaction, { planta_id }) {
  const r = await new sql.Request(transaction)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1
        disponibilidad_id, estado, codigo,
        fecha_inicio_estado, fecha_fin_estado, detalle
      FROM bitacora.disponibilidad_estado
      WHERE planta_id = @p AND fecha_fin_estado IS NOT NULL
      ORDER BY fecha_inicio_estado DESC
    `);
  return r.recordset[0] || null;
}

// Cierra un vigente (UPDATE fecha_fin_estado).
export async function cerrarVigente(transaction, { disponibilidad_id, fecha_fin }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .input('fin', sql.DateTime2, fecha_fin)
    .query(`UPDATE bitacora.disponibilidad_estado SET fecha_fin_estado=@fin WHERE disponibilidad_id=@id`);
}

// Inserta un row nuevo. Devuelve el row insertado.
export async function insertNuevoEstado(transaction, {
  planta_id, estado, codigo, fecha_inicio_estado, detalle,
  jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
  creado_por,
}) {
  const r = await new sql.Request(transaction)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('estado', sql.VarChar(20), estado)
    .input('codigo', sql.SmallInt, codigo)
    .input('fecha_inicio_estado', sql.DateTime2, fecha_inicio_estado)
    .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot ?? '[]')
    .input('jefes_planta_snapshot', sql.NVarChar(sql.MAX), jefes_planta_snapshot ?? '[]')
    .input('gerentes_produccion_snapshot', sql.NVarChar(sql.MAX), gerentes_produccion_snapshot ?? '[]')
    .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot ?? '[]')
    .input('creado_por', sql.Int, creado_por)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, detalle,
         jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
         creado_por)
      OUTPUT INSERTED.*
      VALUES (@planta_id, @estado, @codigo, @fecha_inicio_estado, @detalle,
              @jdts_snapshot, @jefes_planta_snapshot, @gerentes_produccion_snapshot, @ingenieros_snapshot,
              @creado_por)
    `);
  return r.recordset[0];
}

// PUT del vigente: actualiza campos editables. `modificado_por` y `modificado_en` siempre se setean.
export async function actualizarVigente(transaction, {
  disponibilidad_id, estado, codigo, fecha_inicio_estado, detalle,
  jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
  modificado_por,
}) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .input('estado', sql.VarChar(20), estado)
    .input('codigo', sql.SmallInt, codigo)
    .input('fecha_inicio_estado', sql.DateTime2, fecha_inicio_estado)
    .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot ?? '[]')
    .input('jefes_planta_snapshot', sql.NVarChar(sql.MAX), jefes_planta_snapshot ?? '[]')
    .input('gerentes_produccion_snapshot', sql.NVarChar(sql.MAX), gerentes_produccion_snapshot ?? '[]')
    .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot ?? '[]')
    .input('modificado_por', sql.Int, modificado_por)
    .query(`
      UPDATE bitacora.disponibilidad_estado
      SET estado=@estado, codigo=@codigo, fecha_inicio_estado=@fecha_inicio_estado, detalle=@detalle,
          jdts_snapshot=@jdts_snapshot, jefes_planta_snapshot=@jefes_planta_snapshot,
          gerentes_produccion_snapshot=@gerentes_produccion_snapshot, ingenieros_snapshot=@ingenieros_snapshot,
          modificado_por=@modificado_por, modificado_en=SYSUTCDATETIME()
      WHERE disponibilidad_id=@id
    `);
}

// DELETE de un row específico (usado por deshacer sobre el vigente).
export async function eliminarPorId(transaction, { disponibilidad_id }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id`);
}

// Restaura un cerrado como vigente (UPDATE fecha_fin_estado=NULL).
export async function restaurarComoVigente(transaction, { disponibilidad_id }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .query(`UPDATE bitacora.disponibilidad_estado SET fecha_fin_estado=NULL WHERE disponibilidad_id=@id`);
}

// GET /api/disponibilidad — devuelve vigente + página de historial + total.
// Resuelve creado_por.nombre_completo y modificado_por.nombre_completo con LEFT JOIN.
// El shape de retorno debe matchear el que consume el frontend (ver doc del prompt).
export async function getEstadoCompleto(db, { planta_id, historial_limit = 20, historial_offset = 0 }) {
  // SELECT vigente con JOINs a usuario para nombre_completo
  // SELECT histórico paginado DESC fecha_inicio_estado, con JOINs
  // SELECT COUNT(*) histórico total
  // Construir objeto { vigente, historial, historial_total }
  // ... (implementación detallada en el prompt 04, este helper solo encapsula la query)
}

// GET /api/disponibilidad/metricas — ms en cada estado en la ventana [desde, hasta].
// Suma DATEDIFF_BIG(MILLISECOND, GREATEST(fecha_inicio_estado, desde),
//                                LEAST(COALESCE(fecha_fin_estado, ahora), hasta))
// agrupado por estado, donde fecha_fin > desde AND fecha_inicio < hasta.
export async function getMetricas(db, { planta_id, desde, hasta }) {
  // ... (implementación detallada en el prompt 04)
}
```

Para `getEstadoCompleto` y `getMetricas`, podés dejar el stub vacío en este prompt si querés y completarlos en el 04 — pero la firma debe quedar definida desde acá para que los handlers ya importen el nombre correcto.

## Importante (gotchas)

1. **No eliminar `hasNotificarDashboard`** ni los helpers de `evento_dashboard` (MAND/AUTH). Solo los 3 de `disponibilidad_dashboard`.
2. **Las nuevas helpers DEBEN preservar el shape** de los objetos que retornan, porque los handlers de prompts 03 y 04 los consumen directamente (sin transformar).
3. **`fecha_inicio_estado` siempre como Date object UTC**, no string.
4. **`snapshotGerentesProduccion` NO recibe `planta_id`** — los gerentes son rol global. Si más adelante necesitás filtrar por planta, agregar parámetro opcional.

## Verificación

```powershell
# Restart server: no debe crashear al arrancar (los handlers viejos siguen importando los helpers eliminados,
# pero los reemplazaremos en prompt 03. Por ahora basta que el archivo notificador.js sea sintácticamente válido.)
cd server
node --check utils/notificador.js
node --check utils/snapshots.js

# Si algún test corre en este punto, va a fallar por los imports rotos en server.js. Eso se arregla en prompt 03.
```

## Lo que NO hagas en este prompt

- NO toques `server/server.js` (prompts 03 y 04).
- NO toques `server/db.js` (prompt 01 — ya hecho).
- NO modifiques tests (prompt 05).
- NO completes los stubs `getEstadoCompleto` / `getMetricas` con la query real si te resulta más cómodo dejarlos para el 04 (la firma sí debe quedar definida).
