# Prompt 04 — Refactor deshacer + 3 GETs DISP (D-026)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Pre-requisitos:** prompts 01, 02, 03 ya corridos.

## Tu tarea

Reescribir 4 handlers en `server/server.js`:

(a) `POST /api/disponibilidad/deshacer` (líneas ~2151–2275)
(b) `GET /api/disponibilidad?planta_id=&historial_limit=&historial_offset=` (línea ~1938)
(c) `GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=` (línea ~2043)
(d) `GET /api/eventos-dashboard?tipo=DISP` (línea ~2456) — verificar sin cambio

**Shape de request y response BYTE-A-BYTE idéntico** al actual. Los 18 tests existentes deben pasar sin tocarse.

## Contexto

Hasta el prompt 03, los handlers de escritura DISP migraron a `bitacora.disponibilidad_estado`. Quedan los handlers de lectura/deshacer. Estos deben:

- `deshacer` — DELETE del vigente + UPDATE del N-1 (`fecha_fin_estado=NULL`). El CIET sigue escribiéndose en `bitacora.registro_activo` con la bitácora CIET (no DISP), así que el helper `registrarDeshacerDisponibilidad` en `utils/ciet.js` **NO se toca**.
- `GET /api/disponibilidad` — devolver `{vigente, historial, historial_total}` con shape idéntico.
- `GET /api/disponibilidad/metricas` — agregar ms por estado en una ventana. Ya no usa `v_disp_intervalos` (dropeada en prompt 01); query directa sobre `disponibilidad_estado`.
- `GET /api/eventos-dashboard?tipo=DISP` — sigue leyendo `bitacora.disponibilidad_dashboard` (que ahora es vista). El handler NO se modifica.

## (a) POST /api/disponibilidad/deshacer

### Shape de input (sin cambio)
```js
{ planta_id }
```

### Shape de response (sin cambio)
```js
{
  revertido: { registro_id_eliminado, evento },
  restaurado: { registro_id, evento } | null,
  ciet_registro_id
}
```

### Flujo nuevo

```js
// POST /api/disponibilidad/deshacer
const sesion = await loadSession(req);
if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
const body = await parseBody(req);
const { planta_id } = body;
if (!planta_id) return sendJSON(res, 400, { error: 'planta_id requerido' });

const db = await getDB();
const dispBidRes = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'`);
const dispBitacoraId = dispBidRes.recordset[0]?.bitacora_id;

// Permiso puede_crear en DISP
if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_crear'))) {
  return sendJSON(res, 403, { error: 'Sin permiso para deshacer DISP' });
}

const tx = new sql.Transaction(db);
await tx.begin();
try {
  const vigente = await findVigente(tx, { planta_id });
  if (!vigente) {
    await tx.rollback();
    return sendJSON(res, 404, { error: 'No hay estado vigente para esta planta' });
  }
  const nMenos1 = await findUltimoCerrado(tx, { planta_id });

  // DELETE vigente
  await new sql.Request(tx)
    .input('id', sql.Int, vigente.disponibilidad_id)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id`);

  // Restaurar N-1 como vigente (si existe)
  let restaurado = null;
  if (nMenos1) {
    await restaurarComoVigente(tx, { disponibilidad_id: nMenos1.disponibilidad_id });
    restaurado = { registro_id: nMenos1.disponibilidad_id, evento: nMenos1.estado };
  }

  // Emitir CIET (helper sin cambio — sigue escribiendo en registro_activo bitácora CIET)
  const ciet_registro_id = await registrarDeshacerDisponibilidad(tx, {
    sesion,
    planta_id,
    evento_revertido: vigente.estado,
    fecha_revertida: vigente.fecha_inicio_estado,
    autor_delete: { usuario_id: sesion.usuario_id, nombre_completo: sesion.nombre_completo },
  });

  await tx.commit();
  broadcastConteoBitacoras(planta_id).catch(() => {});

  return sendJSON(res, 200, {
    revertido: { registro_id_eliminado: vigente.disponibilidad_id, evento: vigente.estado },
    restaurado,
    ciet_registro_id,
  });
} catch (err) {
  try { await tx.rollback(); } catch {}
  throw err;
}
```

## (b) GET /api/disponibilidad

### Shape de response (sin cambio — verificar contra tests 10–14)

```js
{
  vigente: {
    registro_id,
    planta_id,
    evento,
    codigo,
    fecha_inicio_estado,           // ISO UTC
    detalle,
    creado_por: { usuario_id, nombre_completo },
    creado_en,                     // ISO UTC
    modificado_por: { usuario_id, nombre_completo } | null,
    modificado_en,                 // ISO UTC | null
    ingenieros_snapshot,           // JSON array
    jdts_snapshot,                 // JSON array
    jefes_snapshot,                // JSON array (= jefes_planta_snapshot en BD)
    // OPCIONAL: agregar gerentes_produccion_snapshot si los tests no lo rechazan
  } | null,
  historial: [
    {
      registro_id,
      evento,
      codigo,
      fecha_inicio_estado,
      fecha_fin_estado,
      detalle,
      creado_por: { usuario_id, nombre_completo },
      creado_en
    }, ...
  ],
  historial_total
}
```

### Query nueva

```sql
-- Vigente con JOINs a usuario
SELECT TOP 1
  de.disponibilidad_id AS registro_id,
  de.planta_id,
  de.estado AS evento,
  de.codigo,
  de.fecha_inicio_estado,
  de.detalle,
  de.creado_en,
  de.modificado_en,
  uc.usuario_id AS creado_por_id,
  uc.nombre_completo AS creado_por_nombre,
  um.usuario_id AS modificado_por_id,
  um.nombre_completo AS modificado_por_nombre,
  de.ingenieros_snapshot,
  de.jdts_snapshot,
  de.jefes_planta_snapshot AS jefes_snapshot
FROM bitacora.disponibilidad_estado de
LEFT JOIN lov_bit.usuario uc ON uc.usuario_id = de.creado_por
LEFT JOIN lov_bit.usuario um ON um.usuario_id = de.modificado_por
WHERE de.planta_id = @planta AND de.fecha_fin_estado IS NULL;

-- Histórico paginado
SELECT
  de.disponibilidad_id AS registro_id,
  de.estado AS evento,
  de.codigo,
  de.fecha_inicio_estado,
  de.fecha_fin_estado,
  de.detalle,
  de.creado_en,
  uc.usuario_id AS creado_por_id,
  uc.nombre_completo AS creado_por_nombre
FROM bitacora.disponibilidad_estado de
LEFT JOIN lov_bit.usuario uc ON uc.usuario_id = de.creado_por
WHERE de.planta_id = @planta AND de.fecha_fin_estado IS NOT NULL
ORDER BY de.fecha_inicio_estado DESC
OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

-- Total histórico
SELECT COUNT(*) AS total FROM bitacora.disponibilidad_estado
WHERE planta_id = @planta AND fecha_fin_estado IS NOT NULL;
```

Construir el objeto response transformando filas planas a `{ usuario_id, nombre_completo }` objects para `creado_por` y `modificado_por`. Parsear `*_snapshot` con `JSON.parse` (devolver array directamente, no string).

Mover esta lógica a `getEstadoCompleto(db, ...)` en `notificador.js` (stub creado en prompt 02).

## (c) GET /api/disponibilidad/metricas

### Shape de response (sin cambio)

```js
{
  planta_id,
  desde,             // ISO UTC
  hasta,             // ISO UTC
  ahora,             // ISO UTC
  tiempo_ms: {
    "En Servicio":   <ms>,
    "En Reserva":    <ms>,
    "Indisponible":  <ms>,
    "Mantenimiento": <ms>
  },
  acumulados_ms: {
    disponible:    <suma servicio + reserva>,
    no_disponible: <suma indisponible + mantenimiento>
  },
  total_ms
}
```

### Query nueva (sin `v_disp_intervalos`, que fue dropeada)

```sql
-- Calcular intersección con [@desde, @hasta] por estado
SELECT
  estado,
  SUM(DATEDIFF_BIG(MILLISECOND,
                   CASE WHEN fecha_inicio_estado > @desde THEN fecha_inicio_estado ELSE @desde END,
                   CASE WHEN COALESCE(fecha_fin_estado, @ahora) < @hasta
                        THEN COALESCE(fecha_fin_estado, @ahora) ELSE @hasta END)) AS ms
FROM bitacora.disponibilidad_estado
WHERE planta_id = @planta
  AND fecha_inicio_estado < @hasta
  AND COALESCE(fecha_fin_estado, @ahora) > @desde
GROUP BY estado;
```

Defaults (igual que hoy):
- `@desde` = `(SELECT MIN(fecha_inicio_estado) FROM disponibilidad_estado WHERE planta_id=@planta)` si no viene en query.
- `@hasta` = `SYSUTCDATETIME()` si no viene.
- `@ahora` = `SYSUTCDATETIME()`.

Si la planta no tiene rows: devolver todos los `tiempo_ms[*]` en 0, `acumulados_ms.{disponible, no_disponible}` en 0, `total_ms` en 0.

Mover esta lógica a `getMetricas(db, ...)` en `notificador.js` (stub creado en prompt 02).

## (d) GET /api/eventos-dashboard?tipo=DISP

**Sin cambio en código.** El handler hace `SELECT ... FROM bitacora.disponibilidad_dashboard WHERE planta_id=@planta`. La tabla fue reemplazada por una VIEW del mismo nombre con shape preservado (mapea `disponibilidad_id → registro_activo_id`, `jefes_planta_snapshot → jefes_snapshot`, etc.). Verificar manualmente con curl:

```powershell
curl http://localhost:3002/api/eventos-dashboard?tipo=DISP&planta_id=GEC3
```

El JSON devuelto debe matchear el de antes del refactor.

## Importante (gotchas)

1. **CIET de deshacer**: `registrarDeshacerDisponibilidad` en `server/utils/ciet.js` sigue escribiendo en `bitacora.registro_activo` con `bitacora_id = <CIET>` (no DISP). NO toques ese helper.

2. **`vigente.fecha_inicio_estado`** sale del driver `mssql` como Date object si la columna es `DATETIME2`. Llamá `.toISOString()` al serializar a JSON.

3. **Si `historial_offset >= historial_total`**: devolver `historial: []` con `historial_total` real (no error). Test 13 cubre este caso.

4. **Snapshot parsing**: `*_snapshot` columns son `NVARCHAR(MAX)` con JSON string. El frontend espera arrays parseados. `JSON.parse(row.jdts_snapshot)` en el response builder, NO en el GET handler crudo.

5. **`broadcastConteoBitacoras`**: llamarlo después del commit en `deshacer` (DISP nunca contribuye al badge, pero el patrón es consistente).

## Verificación

```powershell
cd server

# Levantar server
node --watch --env-file=../.env server.js

# Correr los 18 tests existentes — deben pasar sin tocarse
node --test --env-file=../.env tests/disponibilidad.test.js

# Tests específicos por funcionalidad:
# Tests 10-14 cubren GET /api/disponibilidad (vigente, historial, paginación, permisos)
# Tests 16-18 cubren GET /api/disponibilidad/metricas
# (Faltan tests específicos para deshacer y eventos-dashboard?tipo=DISP — los nuevos del prompt 05 los cubrirán)

# Smoke manual:
# 1. POST estado A → POST estado B → deshacer → verificar vigente=A, B borrado
# 2. GET /api/disponibilidad?planta_id=GEC3 → shape idéntico al anterior
# 3. GET /api/disponibilidad/metricas?planta_id=GEC3 → suma de tiempo_ms ≈ total_ms
# 4. GET /api/eventos-dashboard?tipo=DISP&planta_id=GEC3 → 1 row por planta
```

## Lo que NO hagas en este prompt

- NO toques POST/PUT DISP (prompt 03 — ya hechos).
- NO toques `registrarDeshacerDisponibilidad` en `utils/ciet.js`.
- NO modifiques tests (prompt 05).
- NO toques docs (prompt 06).
