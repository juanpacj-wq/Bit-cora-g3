// Router de contexto de sesión de app (E10, AUD-34/35). Montado bajo /api/auth tras requireEntra.
//   - POST /select-context: CREA la sesión de app (sesion_activa) tras elegir planta. Solo necesita
//     identidad Entra (req.session.user) — NO loadAppSession (la sesión aún no existe).
//   - POST /cerrar-app: desactiva las sesiones de app del usuario Entra (D-035 "Operar otra unidad").
//   - GET  /usuarios-activos: lista sesiones activas (requiere sesión de app → loadAppSession).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { resolveCargo } from '../utils/entra-roles.js';
import { getTurnoColombia } from '../utils/turno.js';
import { broadcastUsuariosActivos } from '../utils/ws-usuarios-activos.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { aplicarRateLimit } from './_shared.js';

const router = express.Router();

// POST /api/auth/select-context { planta_id }
// Deriva usuario_id de la cookie Entra (req.session.user) y cargo_id de los App Roles del token por
// precedencia. NO recibe usuario_id ni cargo_id del cliente (no son confiables).
router.post('/select-context', asyncH(async (req, res) => {
  // AUD-20: endpoint sensible (crea sesión de app). Límite generoso para no estorbar uso normal.
  if (!aplicarRateLimit(req, res, 'select-context', { max: 60, windowMs: 60_000 })) return;
  const sUser = req.session?.user;
  if (!sUser?.oid || !sUser?.usuario_id) {
    return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
  }
  const { planta_id } = req.body || {};
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }

  // Cargo automático desde los roles del token (precedencia). Sin rol conocido → 403.
  const elegido = resolveCargo(sUser.roles);
  if (!elegido) {
    return sendJSON(res, 403, {
      error: 'Tu cuenta aún no tiene un rol de bitácoras asignado. Pide al administrador que te asigne uno para poder ingresar.',
      codigo: 'sin_cargo_asignado',
      detail: 'Tu cuenta no tiene un App Role de bitácoras asignado en Entra.',
      roles: sUser.roles || [],
    });
  }

  const db = await getDB();
  const valid = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('cargo_nombre', sql.VarChar(100), elegido.cargoNombre)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM lov_bit.planta WHERE planta_id = @planta_id AND activa = 1) AS planta_ok,
        (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @cargo_nombre) AS cargo_id
    `);
  if (!valid.recordset[0].planta_ok) {
    return sendJSON(res, 400, { error: 'planta_id inválido' });
  }
  const cargo_id = valid.recordset[0].cargo_id;
  if (!cargo_id) {
    console.error(`[ERROR] config: cargo '${elegido.cargoNombre}' no existe en lov_bit.cargo`);
    return sendJSON(res, 500, {
      error: 'Hay un problema de configuración del sistema. Contacta a soporte.',
      codigo: 'config_sistema',
    });
  }

  const turno = getTurnoColombia();
  // Dedupe por (usuario_id, planta_id, cargo_id). Sesión de app POR TURNO: al reactivar REFRESCAMOS
  // inicio_sesion y turno. UPDLOCK+HOLDLOCK serializa pestañas.
  const transaction = new sql.Transaction(db);
  await transaction.begin();
  let result;
  try {
    result = await new sql.Request(transaction)
      .input('usuario_id', sql.Int, sUser.usuario_id)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('cargo_id', sql.Int, cargo_id)
      .input('turno', sql.TinyInt, turno)
      .query(`
        -- D-035 (sesión única por persona): al entrar a una unidad, desactivar cualquier OTRA
        -- sesión de app activa de este usuario (otra planta/cargo).
        UPDATE bitacora.sesion_activa
           SET activa = 0, cerrada_en = SYSUTCDATETIME()
         WHERE usuario_id = @usuario_id
           AND activa = 1
           AND NOT (planta_id = @planta_id AND cargo_id = @cargo_id);

        DECLARE @sesion_id INT;
        SELECT TOP 1 @sesion_id = sesion_id
        FROM bitacora.sesion_activa WITH (UPDLOCK, HOLDLOCK)
        WHERE usuario_id = @usuario_id
          AND planta_id  = @planta_id
          AND cargo_id   = @cargo_id
        ORDER BY inicio_sesion DESC;

        IF @sesion_id IS NOT NULL
        BEGIN
          UPDATE bitacora.sesion_activa
             SET activa           = 1,
                 cerrada_en       = NULL,
                 inicio_sesion    = SYSUTCDATETIME(),
                 turno            = @turno,
                 ultima_actividad = SYSUTCDATETIME()
           WHERE sesion_id = @sesion_id;
        END
        ELSE
        BEGIN
          INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
          VALUES (@usuario_id, @planta_id, @cargo_id, @turno);
          SET @sesion_id = SCOPE_IDENTITY();
        END

        SELECT s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
               s.inicio_sesion, s.ultima_actividad,
               u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
               c.nombre AS cargo_nombre, c.solo_lectura,
               CAST(c.puede_cerrar_turno AS BIT) AS puede_cerrar_turno
        FROM bitacora.sesion_activa s
        INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
        INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id
        WHERE s.sesion_id = @sesion_id;
      `);
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
  broadcastUsuariosActivos().catch(() => {});
  return sendJSON(res, 200, { sesion: result.recordset[0] });
}));

// POST /api/auth/cerrar-app — desactiva TODAS las sesiones de app del usuario Entra actual, sin tocar
// la cookie ni hacer logout (D-035 "Operar otra unidad"). Identidad por cookie. Idempotente.
router.post('/cerrar-app', asyncH(async (req, res) => {
  const sUser = req.session?.user;
  if (!sUser?.usuario_id) return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
  const db = await getDB();
  await db.request()
    .input('usuario_id', sql.Int, sUser.usuario_id)
    .query(`
      UPDATE bitacora.sesion_activa
         SET activa = 0, cerrada_en = SYSUTCDATETIME()
       WHERE usuario_id = @usuario_id AND activa = 1;
    `);
  broadcastUsuariosActivos().catch(() => {});
  return sendJSON(res, 200, { ok: true });
}));

// GET /api/auth/usuarios-activos (todas las plantas, requiere sesión de app)
// F2: sin filtro TTL — refleja sesion_activa.activa=1 hasta logout o cierre por sweeper de F4.
router.get('/usuarios-activos', loadAppSession, asyncH(async (req, res) => {
  const db = await getDB();
  const result = await db.request().query(`
    SELECT
      s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno,
      s.inicio_sesion, s.ultima_actividad,
      u.nombre_completo,
      c.nombre AS cargo_nombre,
      p.nombre AS planta_nombre
    FROM bitacora.sesion_activa s
    INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
    INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id
    INNER JOIN lov_bit.planta  p ON p.planta_id  = s.planta_id
    WHERE s.activa = 1
    ORDER BY p.planta_id, s.inicio_sesion DESC
  `);
  return sendJSON(res, 200, { usuarios: result.recordset });
}));

export default router;
