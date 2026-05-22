# Prompt 02 — Backend endpoints (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Pre-requisito:** prompt 01 ya corrido (tabla + catálogo + permisos seedeados).

## Tu tarea

Agregar 3 endpoints HTTP nuevos a `server/server.js`:

1. `GET /api/combustibles/catalogo?planta_id=GEC3|GEC32` — listado de combustibles activos por planta, ordenados.
2. `GET /api/combustibles/consumos?planta_id=&fecha=YYYY-MM-DD` — matriz pivot (periodo × combustible) de consumos para una fecha.
3. `POST /api/combustibles/consumos` — batch save atómico (patrón MAND).

Reusar `hasPermisoBitacora(sesion, COMB_BID, 'puede_ver'|'puede_crear')` para gating. Cachear `COMB_BID` al arranque (similar a `USUARIO_SISTEMA_ID` en `db.js`).

## Patrón del repo

- Otros endpoints siguen el patrón handler async `(req, res) => { const sesion = await loadSession(req); ... }`.
- Batch atómico MAND vive en `server.js` líneas ~1277–1580 (`POST /api/sala-de-mando/guardar`). Es la mejor referencia para el patrón de transacción + validación + diff.
- Utilidades: `parseBody(req)`, `sendJSON(res, status, body)`, `getDB()`.

## Cachear COMB_BID

En `server/db.js` ya existe `USUARIO_SISTEMA_ID` cacheado al arranque. Seguí el patrón:

```js
// En server/db.js (al final de initDB(), después del bloque F26.B1)
const combRow = await db.request().query(
  `SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='COMB'`
);
const COMB_BITACORA_ID = combRow.recordset[0]?.bitacora_id;
if (!COMB_BITACORA_ID) {
  throw new Error('[db.js] bitácora COMB no seedeada — verificar F26.B1');
}
export { COMB_BITACORA_ID };
```

En `server/server.js`:
```js
import { COMB_BITACORA_ID } from './db.js';
```

## Endpoint 1 — `GET /api/combustibles/catalogo`

```js
if (req.method === 'GET' && url.pathname === '/api/combustibles/catalogo') {
  const sesion = await loadSession(req);
  if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
  if (!(await hasPermisoBitacora(sesion, COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }

  const planta_id = url.searchParams.get('planta_id');
  if (!['GEC3','GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
  }

  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);
  return sendJSON(res, 200, { planta_id, combustibles: r.recordset });
}
```

## Endpoint 2 — `GET /api/combustibles/consumos?planta_id=&fecha=`

```js
if (req.method === 'GET' && url.pathname === '/api/combustibles/consumos') {
  const sesion = await loadSession(req);
  if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
  if (!(await hasPermisoBitacora(sesion, COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }

  const planta_id = url.searchParams.get('planta_id');
  const fechaStr  = url.searchParams.get('fecha');
  if (!['GEC3','GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '')) {
    return sendJSON(res, 400, { error: 'fecha requerida (YYYY-MM-DD)' });
  }

  const db = await getDB();

  // Catálogo (siempre devolvemos para que el frontend pivotee aunque no haya consumos)
  const catRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);

  // Consumos para (planta, fecha)
  const conRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('f', sql.Date, fechaStr)
    .query(`
      SELECT
        c.consumo_id, c.periodo, c.combustible_id, c.cantidad, c.detalle,
        c.creado_por, c.creado_en, c.modificado_por, c.modificado_en,
        uc.nombre_completo AS creado_por_nombre,
        um.nombre_completo AS modificado_por_nombre
      FROM bitacora.consumo_combustible c
      LEFT JOIN lov_bit.usuario uc ON uc.usuario_id = c.creado_por
      LEFT JOIN lov_bit.usuario um ON um.usuario_id = c.modificado_por
      WHERE c.planta_id = @p AND c.fecha = @f
      ORDER BY c.periodo, c.combustible_id
    `);

  // Pivot: { "<periodo>": { "<combustible_id>": { consumo_id, cantidad, detalle, modificado_en } } }
  const celdas = {};
  for (const row of conRes.recordset) {
    const p = String(row.periodo);
    if (!celdas[p]) celdas[p] = {};
    celdas[p][String(row.combustible_id)] = {
      consumo_id: row.consumo_id,
      cantidad: Number(row.cantidad),
      detalle: row.detalle,
      creado_por: { usuario_id: row.creado_por, nombre_completo: row.creado_por_nombre },
      creado_en: row.creado_en,
      modificado_por: row.modificado_por
        ? { usuario_id: row.modificado_por, nombre_completo: row.modificado_por_nombre }
        : null,
      modificado_en: row.modificado_en,
    };
  }

  return sendJSON(res, 200, {
    planta_id,
    fecha: fechaStr,
    catalogo: catRes.recordset,
    celdas,
  });
}
```

## Endpoint 3 — `POST /api/combustibles/consumos`

Body:
```js
{
  planta_id: 'GEC3' | 'GEC32',
  fecha: 'YYYY-MM-DD',
  celdas: [
    { periodo: 1..24, combustible_id: <int>, cantidad: <decimal|null|0>, detalle?: <string> }
  ]
}
```

Response 200:
```js
{ resumen: { creados: N, actualizados: M, eliminados: K } }
```

Response 400:
```js
{ errores: [{ periodo?, combustible_id?, motivo }] }
```

```js
if (req.method === 'POST' && url.pathname === '/api/combustibles/consumos') {
  const sesion = await loadSession(req);
  if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
  if (!(await hasPermisoBitacora(sesion, COMB_BITACORA_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear Consumos' });
  }

  const body = await parseBody(req);
  const { planta_id, fecha, celdas } = body || {};
  if (!['GEC3','GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id inválido' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    return sendJSON(res, 400, { error: 'fecha inválida (YYYY-MM-DD)' });
  }
  if (!Array.isArray(celdas)) {
    return sendJSON(res, 400, { error: 'celdas debe ser un array' });
  }

  // Validar fecha <= hoy Bogotá
  // (importar/usar el helper de turno.js o fecha.js que ya calcula hoy Bogotá; ver server/utils/turno.js::fechaBogotaStr)
  const hoyBogota = fechaBogotaStr(new Date());
  if (fecha > hoyBogota) {
    return sendJSON(res, 400, { error: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
  }

  const db = await getDB();

  // Pre-load catálogo de la planta para validar combustible_id
  const cat = (await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT combustible_id FROM lov_bit.combustible WHERE planta_id=@p AND activo=1`)
  ).recordset.map(r => r.combustible_id);
  const catSet = new Set(cat);

  // Validar celdas
  const errores = [];
  for (const c of celdas) {
    if (!Number.isInteger(c.periodo) || c.periodo < 1 || c.periodo > 24) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'periodo_fuera_rango' });
      continue;
    }
    if (!catSet.has(c.combustible_id)) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'combustible_no_pertenece_planta' });
      continue;
    }
    if (c.cantidad !== null && c.cantidad !== 0) {
      if (typeof c.cantidad !== 'number' || !Number.isFinite(c.cantidad) || c.cantidad < 0) {
        errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'cantidad_invalida' });
        continue;
      }
    }
  }
  if (errores.length > 0) {
    return sendJSON(res, 400, { errores });
  }

  // Batch atómico
  const tx = new sql.Transaction(db);
  await tx.begin();
  let creados = 0, actualizados = 0, eliminados = 0;
  try {
    for (const c of celdas) {
      const existente = (await new sql.Request(tx)
        .input('p', sql.VarChar(10), planta_id)
        .input('f', sql.Date, fecha)
        .input('per', sql.TinyInt, c.periodo)
        .input('cid', sql.Int, c.combustible_id)
        .query(`
          SELECT consumo_id, cantidad, detalle
          FROM bitacora.consumo_combustible
          WHERE planta_id=@p AND fecha=@f AND periodo=@per AND combustible_id=@cid
        `)).recordset[0];

      const esNull = c.cantidad === null || c.cantidad === 0;

      if (esNull) {
        if (existente) {
          await new sql.Request(tx)
            .input('id', sql.Int, existente.consumo_id)
            .query(`DELETE FROM bitacora.consumo_combustible WHERE consumo_id=@id`);
          eliminados++;
        }
        continue;
      }

      if (!existente) {
        await new sql.Request(tx)
          .input('p', sql.VarChar(10), planta_id)
          .input('f', sql.Date, fecha)
          .input('per', sql.TinyInt, c.periodo)
          .input('cid', sql.Int, c.combustible_id)
          .input('cant', sql.Decimal(12, 3), c.cantidad)
          .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
          .input('u', sql.Int, sesion.usuario_id)
          .query(`
            INSERT INTO bitacora.consumo_combustible
              (planta_id, fecha, periodo, combustible_id, cantidad, detalle, creado_por)
            VALUES (@p, @f, @per, @cid, @cant, @det, @u)
          `);
        creados++;
      } else {
        // UPDATE — modificado_por SOLO si cantidad cambió (paridad D-019)
        const cantidadCambio = Number(existente.cantidad) !== c.cantidad;
        if (cantidadCambio) {
          await new sql.Request(tx)
            .input('id', sql.Int, existente.consumo_id)
            .input('cant', sql.Decimal(12, 3), c.cantidad)
            .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
            .input('u', sql.Int, sesion.usuario_id)
            .query(`
              UPDATE bitacora.consumo_combustible
              SET cantidad=@cant, detalle=@det,
                  modificado_por=@u, modificado_en=SYSUTCDATETIME()
              WHERE consumo_id=@id
            `);
          actualizados++;
        } else if ((existente.detalle ?? null) !== (c.detalle ?? null)) {
          // Solo detalle cambió: actualizar sin tocar modificado_por (igual que MAND)
          await new sql.Request(tx)
            .input('id', sql.Int, existente.consumo_id)
            .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
            .query(`UPDATE bitacora.consumo_combustible SET detalle=@det WHERE consumo_id=@id`);
          actualizados++;
        }
      }
    }
    await tx.commit();
    return sendJSON(res, 200, { resumen: { creados, actualizados, eliminados } });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}
```

## Importante (gotchas)

1. **`fechaBogotaStr`**: ya existe en `server/utils/turno.js` o `server/utils/fecha.js`. Importalo en `server.js`; no reinventes.
2. **`COMB_BITACORA_ID` undefined al arranque**: si exportás antes de seedear, queda undefined. Asegurate de que el `SELECT` corra DESPUÉS del bloque F26.B1.
3. **DECIMAL(12,3) en `mssql` driver**: usá `sql.Decimal(12, 3)`. El número JS se convierte automáticamente.
4. **Validación de fecha string vs hoy Bogotá**: ambos en formato `YYYY-MM-DD`. La comparación lexicográfica funciona porque el formato es padded zero (`'2026-05-19' < '2026-05-20'` es `true`).
5. **`modificado_por` solo si cantidad cambió** (regla D-019 — paridad con MAND). Documentado en el plan.
6. **Sin auth/permiso para `puede_crear`**: rechaza 403 incluso si el endpoint POST llegó. Defense in depth.
7. **No re-validar permisos por celda**: el `puede_crear` ya cubre el endpoint completo. No introducir gating per-periodo o per-combustible.

## Verificación

```powershell
cd server
node --check server.js  # valida sintaxis
node --watch --env-file=../.env server.js

# En otra terminal:
# Como cargo con puede_ver (cualquier login):
curl http://localhost:3002/api/combustibles/catalogo?planta_id=GEC3 \
  -H "Cookie: <session>"
# Esperado: { planta_id: 'GEC3', combustibles: [{...8 items...}] }

# Como cargo con puede_crear (Operador Carbón y Caliza o JdT):
curl -X POST http://localhost:3002/api/combustibles/consumos \
  -H "Cookie: <session>" -H "Content-Type: application/json" \
  -d '{"planta_id":"GEC3","fecha":"2026-05-20","celdas":[
    {"periodo":1,"combustible_id":1,"cantidad":12.5},
    {"periodo":1,"combustible_id":2,"cantidad":8.3}
  ]}'
# Esperado: { resumen: { creados: 2, actualizados: 0, eliminados: 0 } }

# Verificar GET:
curl "http://localhost:3002/api/combustibles/consumos?planta_id=GEC3&fecha=2026-05-20" \
  -H "Cookie: <session>"
# Esperado: { planta_id, fecha, catalogo: [...], celdas: { "1": { "1": {...}, "2": {...} } } }

# Fecha futura:
curl -X POST http://localhost:3002/api/combustibles/consumos \
  -H "Content-Type: application/json" \
  -d '{"planta_id":"GEC3","fecha":"2099-01-01","celdas":[]}'
# Esperado: 400 { error: 'fecha_futura' }
```

## Lo que NO hagas en este prompt

- NO toques frontend (prompts 03–04).
- NO toques `server/db.js` (ya hecho en prompt 01, salvo la línea de cacheo de COMB_BITACORA_ID que SÍ va en db.js).
- NO escribas tests (prompt 05).
- NO escribas docs (prompt 06).
