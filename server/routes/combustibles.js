// Router de Combustibles → Consumos (E7, AUD-34/35; D-027/D-034). Montado bajo /api/combustibles
// tras requireEntra. catálogo (read) + consumos GET (pivot planta×fecha) + consumos POST (batch).
// COMB_BITACORA_ID se resuelve vía dbBindings (live binding, asignado al final de initDB).

import express from 'express';
import sql from 'mssql';
import * as dbBindings from '../db.js';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora } from '../middleware/permissions.js';
import { fechaBogotaStr } from '../utils/turno.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/combustibles/catalogo?planta_id=GEC3|GEC32
router.get('/catalogo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }
  const planta_id = req.query.planta_id;
  if (!['GEC3', 'GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
  }
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden, cantidad_max
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);
  return sendJSON(res, 200, { planta_id, combustibles: r.recordset });
}));

// GET /api/combustibles/consumos?planta_id=&fecha=YYYY-MM-DD
// Devuelve catálogo (siempre) + pivot de celdas keyed por periodo→combustible_id.
router.get('/consumos', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }
  const planta_id = req.query.planta_id;
  const fechaStr = req.query.fecha;
  if (!['GEC3', 'GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '')) {
    return sendJSON(res, 400, { error: 'fecha requerida (YYYY-MM-DD)' });
  }

  const db = await getDB();

  const catRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden, cantidad_max
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);

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

  // Pivot: { "<periodo>": { "<combustible_id>": { ... } } }
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
}));

// POST /api/combustibles/consumos — batch atómico (patrón MAND).
// Body: { planta_id, fecha, celdas: [{ periodo, combustible_id, cantidad, detalle? }] }
// cantidad=null o 0 ⇒ DELETE de la celda si existía; existente ⇒ UPDATE; nueva ⇒ INSERT.
// modificado_por solo se setea si cantidad cambió (paridad D-019 con MAND).
router.post('/consumos', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear Consumos' });
  }

  const { planta_id, fecha, celdas } = req.body || {};
  if (!['GEC3', 'GEC32'].includes(planta_id)) {
    return sendJSON(res, 400, { error: 'planta_id inválido' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    return sendJSON(res, 400, { error: 'fecha inválida (YYYY-MM-DD)' });
  }
  if (!Array.isArray(celdas)) {
    return sendJSON(res, 400, { error: 'celdas debe ser un array' });
  }

  // Ventana: hoy o pasado en TZ Bogotá (D-027 decisión). Comparación lexicográfica
  // funciona porque ambos están en YYYY-MM-DD padded.
  const hoyBogota = fechaBogotaStr(new Date());
  if (fecha > hoyBogota) {
    return sendJSON(res, 400, { error: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
  }

  const db = await getDB();

  // Pre-load catálogo activo de la planta — el frontend podría mandar IDs de la otra
  // planta por bug; rechazamos con motivo específico. cantidad_max (D-034) gobierna el
  // tope físico por combustible: ALIMENTADOR=25, CALIZA=40, ACPM=25000 (NULL = sin tope).
  const catRows = (await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT combustible_id, cantidad_max FROM lov_bit.combustible WHERE planta_id=@p AND activo=1`)
  ).recordset;
  const catMax = new Map(catRows.map(r => [r.combustible_id, r.cantidad_max === null ? null : Number(r.cantidad_max)]));

  const errores = [];
  for (const c of celdas) {
    if (!Number.isInteger(c.periodo) || c.periodo < 1 || c.periodo > 24) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'periodo_fuera_rango' });
      continue;
    }
    if (!catMax.has(c.combustible_id)) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'combustible_no_pertenece_planta' });
      continue;
    }
    if (c.cantidad !== null && c.cantidad !== 0 && c.cantidad !== undefined) {
      if (typeof c.cantidad !== 'number' || !Number.isFinite(c.cantidad) || c.cantidad < 0) {
        errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'cantidad_invalida' });
        continue;
      }
      // Tope físico (D-034): cantidad_max NULL = sin límite; boundary inclusivo (=max OK).
      const max = catMax.get(c.combustible_id);
      if (max !== null && c.cantidad > max) {
        errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'cantidad_excede_max' });
        continue;
      }
    }
  }
  if (errores.length > 0) {
    return sendJSON(res, 400, { errores });
  }

  // Batch atómico. Patrón MAND: por celda, lookup existente → INSERT / UPDATE / DELETE.
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

      const esVacio = c.cantidad === null || c.cantidad === 0 || c.cantidad === undefined;

      if (esVacio) {
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
        // UPDATE — modificado_por solo si cantidad cambió (paridad D-019 con MAND).
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
          // Solo detalle cambió: actualizar sin tocar modificado_por (igual que MAND).
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
}));

export default router;
