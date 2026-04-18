import sql from 'mssql';
import { getDB } from '../db.js';

export async function hasPermisoBitacora(sesion, bitacora_id, accion = 'puede_crear') {
  if (!sesion || !bitacora_id) return false;
  if (accion !== 'puede_ver' && accion !== 'puede_crear') return false;
  const db = await getDB();
  const r = await db.request()
    .input('cargo_id', sql.Int, sesion.cargo_id)
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`
      SELECT ${accion} AS ok
      FROM lov_bit.cargo_bitacora_permiso
      WHERE cargo_id = @cargo_id AND bitacora_id = @bitacora_id
    `);
  return !!r.recordset[0]?.ok;
}

export function isJdT(sesion) {
  return !!sesion && sesion.cargo_nombre === 'Jefe de Turno';
}

export function plantaMatch(sesion, planta_id) {
  return !!sesion && sesion.planta_id === planta_id;
}

export async function canEditarRegistro(sesion, registro) {
  if (!sesion || !registro) return false;
  if (registro.planta_id && registro.planta_id !== sesion.planta_id) return false;
  if (registro.ingeniero_id === sesion.usuario_id) return true;
  if (isJdT(sesion)) return true;
  return hasPermisoBitacora(sesion, registro.bitacora_id, 'puede_crear');
}
