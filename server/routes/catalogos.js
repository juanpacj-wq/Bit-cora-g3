// Router de catálogos (LOV) — AUD-34/35 E2, primera migración de dominio del if-chain a Express.
//
// Montado bajo `/api/catalogos` DESPUÉS de requireEntra. Las rutas no-PII (plantas/cargos/bitácoras/
// tipos-evento/permisos) están en la allowlist pública (routes/_middleware.js) → el LoginScreen las
// consume sin sesión. jdt-actual/jefe devuelven email (PII) → NO son públicas: requireEntra ya exige
// identidad Entra antes de llegar aquí (por eso los handlers ya no repiten el check de oid).

import express from 'express';
import sql from 'mssql';
import { getDB, TEST_PLANTA_ID } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { asyncH } from './_middleware.js';

const router = express.Router();

// GET /api/catalogos/plantas
router.get('/plantas', asyncH(async (req, res) => {
  const db = await getDB();
  // D-030: la planta reservada de test (TEST_PLANTA_ID='TST') queda residente en lov_bit.planta
  // cuando la suite corre contra la BD productiva. NUNCA debe aparecer en el selector de planta
  // del login — solo GEC3/GEC32 son plantas reales operables.
  const result = await db.request()
    .input('testPlanta', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
    SELECT planta_id, nombre, activa
    FROM lov_bit.planta
    WHERE activa = 1 AND planta_id <> @testPlanta
    ORDER BY planta_id
  `);
  return sendJSON(res, 200, { plantas: result.recordset });
}));

// GET /api/catalogos/cargos
router.get('/cargos', asyncH(async (req, res) => {
  const db = await getDB();
  const result = await db.request().query(`
    SELECT cargo_id, nombre, solo_lectura, CAST(puede_cerrar_turno AS BIT) AS puede_cerrar_turno
    FROM lov_bit.cargo
    ORDER BY cargo_id
  `);
  return sendJSON(res, 200, { cargos: result.recordset });
}));

// GET /api/catalogos/bitacoras
// F10: oculta=0 esconde bitácoras de auditoría interna (CIET) del frontend.
router.get('/bitacoras', asyncH(async (req, res) => {
  const db = await getDB();
  const result = await db.request().query(`
    SELECT bitacora_id, nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa
    FROM lov_bit.bitacora
    WHERE activa = 1 AND oculta = 0
    ORDER BY orden
  `);
  return sendJSON(res, 200, { bitacoras: result.recordset });
}));

// GET /api/catalogos/bitacoras/:id/tipos-evento
router.get('/bitacoras/:id/tipos-evento', asyncH(async (req, res) => {
  const bitacora_id = parseInt(req.params.id, 10);
  const db = await getDB();
  const result = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`
      SELECT tipo_evento_id, bitacora_id, nombre, es_default, orden
      FROM lov_bit.tipo_evento
      WHERE bitacora_id = @bitacora_id
      ORDER BY orden
    `);
  return sendJSON(res, 200, { tipos_evento: result.recordset });
}));

// GET /api/catalogos/permisos/:cargo_id
router.get('/permisos/:cargo_id', asyncH(async (req, res) => {
  const cargo_id = parseInt(req.params.cargo_id, 10);
  const db = await getDB();
  const result = await db.request()
    .input('cargo_id', sql.Int, cargo_id)
    .query(`
      SELECT b.bitacora_id, b.nombre, b.codigo, b.icono, b.formulario_especial, b.orden,
             ISNULL(p.puede_ver, 0) AS puede_ver,
             ISNULL(p.puede_crear, 0) AS puede_crear
      FROM lov_bit.bitacora b
      LEFT JOIN lov_bit.cargo_bitacora_permiso p
        ON p.bitacora_id = b.bitacora_id AND p.cargo_id = @cargo_id
      WHERE b.activa = 1 AND b.oculta = 0
      ORDER BY b.orden
    `);
  return sendJSON(res, 200, { permisos: result.recordset });
}));

// GET /api/catalogos/jdt-actual?planta_id=GEC3  (PII → gateado por requireEntra)
router.get('/jdt-actual', asyncH(async (req, res) => {
  const planta_id = req.query.planta_id;
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  const db = await getDB();
  const activo = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1 u.usuario_id, u.nombre_completo, u.email, u.es_jefe_planta, u.es_jdt_default,
             s.inicio_sesion, s.ultima_actividad
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id AND s.activa = 1 AND c.nombre = 'Jefe de Turno'
      ORDER BY s.inicio_sesion DESC
    `);
  if (activo.recordset.length > 0) {
    return sendJSON(res, 200, { jdt: activo.recordset[0], origen: 'sesion_activa' });
  }
  const fallback = await db.request().query(`
    SELECT TOP 1 usuario_id, nombre_completo, email, es_jefe_planta, es_jdt_default
    FROM lov_bit.usuario
    WHERE es_jdt_default = 1 AND activo = 1
  `);
  if (fallback.recordset.length === 0) {
    return sendJSON(res, 404, { error: 'No hay JdT disponible' });
  }
  return sendJSON(res, 200, { jdt: fallback.recordset[0], origen: 'default' });
}));

// GET /api/catalogos/jefe  (PII → gateado por requireEntra)
router.get('/jefe', asyncH(async (req, res) => {
  const db = await getDB();
  const result = await db.request().query(`
    SELECT TOP 1 usuario_id, nombre_completo, email, es_jefe_planta, es_jdt_default
    FROM lov_bit.usuario
    WHERE es_jefe_planta = 1 AND activo = 1
  `);
  if (result.recordset.length === 0) {
    return sendJSON(res, 404, { error: 'No hay jefe de planta' });
  }
  return sendJSON(res, 200, { jefe: result.recordset[0] });
}));

export default router;
