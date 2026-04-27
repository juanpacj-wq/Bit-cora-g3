import sql from 'mssql';
import { getDB } from '../db.js';

export async function loadSession(req) {
  const raw = req.headers['x-sesion-id'];
  if (!raw) return null;
  const sesion_id = parseInt(raw, 10);
  if (Number.isNaN(sesion_id)) return null;
  const db = await getDB();
  // F2: sin TTL — sesión queda activa hasta logout explícito o cierre por sweeper de F4.
  const r = await db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`
      SELECT s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
             u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
             c.nombre AS cargo_nombre, c.solo_lectura,
             CAST(c.puede_cerrar_turno AS BIT) AS puede_cerrar_turno
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.sesion_id = @sesion_id AND s.activa = 1
    `);
  const row = r.recordset[0];
  if (!row) return null;
  db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`UPDATE bitacora.sesion_activa SET ultima_actividad = GETDATE() WHERE sesion_id = @sesion_id`)
    .catch(() => {});
  return row;
}
