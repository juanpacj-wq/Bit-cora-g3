import sql from 'mssql';
import { getDB } from '../db.js';

// AUD-06: el backdoor de test (resolver identidad por header X-Sesion-Id, entero enumerable) SOLO
// puede activarse en entornos no-productivos. Función pura y exportada para poder testearla aislada.
export function bypassHabilitado(env = process.env) {
  return env.AUTH_TEST_BYPASS === '1' && env.NODE_ENV !== 'production';
}

// Fail-closed: si alguien arranca con el bypass encendido en producción, abortamos el proceso en la
// carga del módulo en vez de degradar silenciosamente a un backdoor enumerable.
if (process.env.AUTH_TEST_BYPASS === '1' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_TEST_BYPASS=1 está prohibido con NODE_ENV=production: el backdoor de test por X-Sesion-Id no puede activarse en producción.'
  );
}

// Login Entra ID: la identidad ya NO viaja en el header X-Sesion-Id (entero exfiltrable), sino
// en la cookie httpOnly de sesión (req.session.user.oid, poblada por express-session). Desde el
// oid resolvemos la sesión de app vigente (sesion_activa.activa=1). El objeto devuelto mantiene
// EXACTAMENTE el mismo shape que la versión por header, así permissions.js y los endpoints del
// if-chain quedan intactos. Sin sesión de app vigente → null → el endpoint responde 401 y el
// front pide selección de planta (que reactiva sesion_activa).
const SELECT_SESION = `
  s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
  u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
  c.nombre AS cargo_nombre, c.solo_lectura,
  CAST(c.puede_cerrar_turno AS BIT) AS puede_cerrar_turno
  FROM bitacora.sesion_activa s
  INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
  INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id`;

async function loadByOid(db, oid) {
  const r = await db.request()
    .input('oid', sql.VarChar(64), oid)
    .query(`SELECT TOP 1 ${SELECT_SESION} WHERE u.azure_oid = @oid AND s.activa = 1 ORDER BY s.inicio_sesion DESC`);
  return r.recordset[0] || null;
}

// Backdoor SOLO de test (AUTH_TEST_BYPASS=1): el harness HTTP usa el header X-Sesion-Id para
// resolver la sesión por id, ya que no puede establecer la cookie Entra real. NUNCA se activa en
// producción (la var solo se setea en el script `test`). Mantiene blindado el camino real.
async function loadBySesionIdTest(db, sesion_id) {
  if (Number.isNaN(sesion_id)) return null;
  const r = await db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`SELECT ${SELECT_SESION} WHERE s.sesion_id = @sesion_id AND s.activa = 1`);
  return r.recordset[0] || null;
}

export async function loadSession(req) {
  const db = await getDB();
  let row = null;
  if (bypassHabilitado() && req.headers?.['x-sesion-id'] != null) {
    row = await loadBySesionIdTest(db, parseInt(req.headers['x-sesion-id'], 10));
  } else {
    const oid = req.session?.user?.oid;
    if (!oid) return null;
    row = await loadByOid(db, oid);
  }
  if (!row) return null;
  db.request()
    .input('sesion_id', sql.Int, row.sesion_id)
    .query(`UPDATE bitacora.sesion_activa SET ultima_actividad = SYSUTCDATETIME() WHERE sesion_id = @sesion_id`)
    .catch(() => {});
  return row;
}
