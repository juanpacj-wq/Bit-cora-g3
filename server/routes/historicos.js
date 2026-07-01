// Router de históricos (E5, AUD-34/35). Búsqueda paginada + resumen + detalle por id.
// Montado bajo /api/historicos tras requireEntra. Todas exigen sesión de app (loadAppSession).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { aplicarRateLimit } from './_shared.js';

const router = express.Router();
router.use(loadAppSession);

// GET /api/historicos/resumen?planta_id=&fecha=
// F10: oculta=0 esconde bitácoras de auditoría interna (CIET) del histórico visible.
// (definido antes de /:id para que 'resumen' no sea capturado como parámetro)
router.get('/resumen', asyncH(async (req, res) => {
  const planta_id = req.query.planta_id;
  const fecha = req.query.fecha;
  if (!planta_id || !fecha) {
    return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
  }
  const db = await getDB();
  const result = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, new Date(fecha))
    .query(`
      SELECT b.bitacora_id, b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
             COUNT(h.registro_id) AS total_registros,
             MAX(h.cerrado_en) AS fecha_cierre
      FROM lov_bit.bitacora b
      LEFT JOIN bitacora.registro_historico h
        ON h.bitacora_id = b.bitacora_id
       AND h.planta_id = @planta_id
       AND h.fecha_cierre_operativo = @fecha
      WHERE b.activa = 1 AND b.oculta = 0
      GROUP BY b.bitacora_id, b.nombre, b.codigo, b.orden
      HAVING COUNT(h.registro_id) > 0
      ORDER BY b.orden
    `);
  return sendJSON(res, 200, { resumen: result.recordset });
}));

// GET /api/historicos?filtros&page&limit
router.get('/', asyncH(async (req, res) => {
  // AUD-20: búsqueda paginada (consulta pesada). Límite generoso para no estorbar el filtrado.
  if (!aplicarRateLimit(req, res, 'historicos', { max: 120, windowMs: 60_000 })) return;
  const params = new URLSearchParams(req.query);
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(500, Math.max(1, parseInt(params.get('limit') || '50', 10)));
  const offset = (page - 1) * limit;

  const db = await getDB();
  // F10: filtro base oculta=0 — registros de bitácoras de auditoría interna (CIET) NO
  // aparecen en históricos visibles aunque alguien envíe filtros que los matcheen.
  const where = ['bitacora_oculta = 0'];
  const reqData = db.request();
  const reqCount = db.request();
  const addInput = (name, type, value) => { reqData.input(name, type, value); reqCount.input(name, type, value); };

  if (params.get('planta_id')) { addInput('planta_id', sql.VarChar(10), params.get('planta_id')); where.push('planta_id = @planta_id'); }
  if (params.get('bitacora_id')) { addInput('bitacora_id', sql.Int, parseInt(params.get('bitacora_id'), 10)); where.push('bitacora_id = @bitacora_id'); }
  if (params.get('creado_por_id')) { addInput('creado_por_id', sql.Int, parseInt(params.get('creado_por_id'), 10)); where.push('creado_por_id = @creado_por_id'); }
  if (params.get('turno')) { addInput('turno', sql.TinyInt, parseInt(params.get('turno'), 10)); where.push('turno = @turno'); }
  if (params.get('tipo_evento_id')) { addInput('tipo_evento_id', sql.Int, parseInt(params.get('tipo_evento_id'), 10)); where.push('tipo_evento_id = @tipo_evento_id'); }
  if (params.get('fecha_desde')) { addInput('fecha_desde', sql.Date, new Date(params.get('fecha_desde'))); where.push('fecha_cierre_operativo >= @fecha_desde'); }
  if (params.get('fecha_hasta')) { addInput('fecha_hasta', sql.Date, new Date(params.get('fecha_hasta'))); where.push('fecha_cierre_operativo <= @fecha_hasta'); }
  if (params.get('busqueda')) { addInput('busqueda', sql.NVarChar(200), params.get('busqueda')); where.push("detalle LIKE '%' + @busqueda + '%'"); }

  const whereSql = where.join(' AND ');
  reqData.input('offset', sql.Int, offset).input('limit', sql.Int, limit);

  const dataResult = await reqData.query(`
    SELECT *
    FROM bitacora.v_historico_busqueda
    WHERE ${whereSql}
    ORDER BY fecha_cierre_operativo DESC, fecha_evento DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);
  const countResult = await reqCount.query(`
    SELECT COUNT(*) AS total FROM bitacora.v_historico_busqueda WHERE ${whereSql}
  `);

  return sendJSON(res, 200, {
    data: dataResult.recordset,
    total: countResult.recordset[0].total,
    page,
    limit,
  });
}));

// GET /api/historicos/:id
// F10: rechaza el registro si su bitácora es oculta — coherente con "no aparece en histórico".
router.get('/:id', asyncH(async (req, res) => {
  const registro_id = parseInt(req.params.id, 10);
  const db = await getDB();
  const result = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`SELECT * FROM bitacora.v_historico_busqueda WHERE registro_id = @registro_id AND bitacora_oculta = 0`);
  if (result.recordset.length === 0) {
    return sendJSON(res, 404, { error: 'Histórico no encontrado' });
  }
  return sendJSON(res, 200, { registro: result.recordset[0] });
}));

export default router;
