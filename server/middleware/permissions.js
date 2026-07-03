import sql from 'mssql';
import { getDB } from '../db.js';
import { finalizacionVigente } from '../utils/turno.js';

// AUD-23 (BIT-AUDSEG-2026-001): el nombre de columna NUNCA debe provenir del valor recibido,
// ni siquiera tras la allowlist. Mapeamos accion → literal de columna vía objeto fijo: el string
// que se interpola es un literal del código (COL), nunca la entrada `accion`.
const COL_PERMISO = { puede_ver: 'puede_ver', puede_crear: 'puede_crear' };

export async function hasPermisoBitacora(sesion, bitacora_id, accion = 'puede_crear') {
  if (!sesion || !bitacora_id) return false;
  const COL = COL_PERMISO[accion];
  if (!COL) return false;
  const db = await getDB();
  const r = await db.request()
    .input('cargo_id', sql.Int, sesion.cargo_id)
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`
      SELECT ${COL} AS ok
      FROM lov_bit.cargo_bitacora_permiso
      WHERE cargo_id = @cargo_id AND bitacora_id = @bitacora_id
    `);
  return !!r.recordset[0]?.ok;
}

// Puede cerrar turno y editar cualquier registro: hoy, Ingeniero Jefe de Turno e Ingeniero de Operación.
// El flag vive en lov_bit.cargo.puede_cerrar_turno; loadSession() lo trae en la sesión.
export function puedeCerrarTurno(sesion) {
  return !!sesion && sesion.puede_cerrar_turno === true;
}

export function plantaMatch(sesion, planta_id) {
  return !!sesion && sesion.planta_id === planta_id;
}

// D-040: ¿la sesión de app tiene el turno finalizado y VIGENTE? Fuente única =
// sesion_activa.turno_finalizado_en (NULL = turno vivo), pero acotada a la ventana del turno actual
// (persistencia por ventana): una finalización de un turno pasado ya no bloquea — expira sola al
// arrancar el siguiente turno. Cierra la brecha del borde de turno antes de que el sweeper expulse
// la sesión. Base del write-gate de bitácoras genéricas.
export function turnoFinalizado(sesion) {
  return !!sesion && finalizacionVigente(sesion.turno_finalizado_en);
}

export async function canEditarRegistro(sesion, registro) {
  if (!sesion || !registro) return false;
  if (registro.planta_id && registro.planta_id !== sesion.planta_id) return false;
  if (registro.creado_por === sesion.usuario_id) return true;
  if (puedeCerrarTurno(sesion)) return true;
  return hasPermisoBitacora(sesion, registro.bitacora_id, 'puede_crear');
}

// conformacion-turno-2026-05 (Q4=e): la conformación de turno es información operativa
// pública dentro de la app — cualquier cargo con sesión válida puede consultarla. Helper
// agregado como gancho futuro si más adelante se quiere restringir (ej. solo Gerente/JdT).
export function puedeVerConformacion(/* sesion */) {
  return true;
}

// conformacion-turno-2026-05 (Q4 extra): trigger manual del snapshot reservado a cargos
// responsables — JdT/IngOp (puede_cerrar_turno=1) o Jefe de Planta (es_jefe_planta=1).
export function puedeTriggerConformacion(sesion) {
  if (!sesion) return false;
  if (sesion.puede_cerrar_turno) return true;
  if (sesion.es_jefe_planta) return true;
  return false;
}
