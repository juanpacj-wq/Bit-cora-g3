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

// Puede cerrar/extender/reabrir el turno de la unidad: hoy, Ingeniero Jefe de Turno e Ingeniero de
// Operación. El flag vive en lov_bit.cargo.puede_cerrar_turno; loadSession() lo trae en la sesión.
// D-049: este flag ya NO otorga edición/eliminación de registros ajenos (ver canEditarRegistro).
export function puedeCerrarTurno(sesion) {
  return !!sesion && sesion.puede_cerrar_turno === true;
}

export function plantaMatch(sesion, planta_id) {
  return !!sesion && sesion.planta_id === planta_id;
}

// D-054: ¿el cargo puede cambiar de unidad EN CALIENTE (botón del navbar → POST
// /api/auth/cambiar-unidad)? Hoy: Ingeniero Jefe de Turno y Operador de Planta - Analista, los dos
// cargos que operan GEC3 y GEC32 de forma rutinaria. El flag vive en
// lov_bit.cargo.puede_cambiar_unidad (reconstruido en CADA arranque por el MERGE de cargos de
// db.js, matcheando por nombre) y loadSession() lo trae en la sesión — NUNCA se hardcodea el
// cargo_id ni el nombre del cargo acá ni en el front (convención 12 de CLAUDE.md): agregar o quitar
// un cargo es editar el seed y redesplegar.
//
// Este predicado NO otorga acceso a datos de la otra unidad: gobierna el ATAJO, no la capacidad.
// Cualquier cargo puede cambiar de unidad por el camino largo (cerrar-app → select-context), que es
// el flujo normal de elegir planta al entrar. Es el mismo objeto-sesión el que se evalúa acá y el
// que el front usa para pintar el botón, así que UI y enforcement no pueden divergir.
export function puedeCambiarUnidad(sesion) {
  return !!sesion && sesion.puede_cambiar_unidad === true;
}

// D-040: ¿la sesión de app tiene el turno finalizado y VIGENTE? Fuente única =
// sesion_activa.turno_finalizado_en (NULL = turno vivo), pero acotada a la ventana del turno actual
// (persistencia por ventana): una finalización de un turno pasado ya no bloquea — expira sola al
// arrancar el siguiente turno. Cierra la brecha del borde de turno antes de que el sweeper expulse
// la sesión. Base del write-gate de bitácoras genéricas.
export function turnoFinalizado(sesion) {
  return !!sesion && finalizacionVigente(sesion.turno_finalizado_en);
}

// D-049: política "solo el autor" para bitácoras GENÉRICAS. Editar o eliminar un registro exige,
// todas a la vez: (1) misma planta que la sesión, (2) ser el AUTOR (`creado_por`) y (3) conservar
// permiso de creación vigente (`puede_crear`) en esa bitácora. Se ELIMINÓ el bypass histórico de
// `puede_cerrar_turno` (JdT/IngOp podían editar/borrar cualquier registro ajeno): un cargo con solo
// `puede_ver` es estrictamente lectura, y NADIE tiene excepción — tampoco el rol ADMIN (cero bypass,
// coherente con D-039). DISP/MAND/COMB no pasan por acá: tienen endpoints propios gateados por
// `puede_crear` (edición colaborativa por diseño).
// Este helper es el ENFORCEMENT (PUT/DELETE /api/registros/:id); el GET /api/registros/activos
// expone su espejo por fila (`puede_editar`) solo como affordance de UI — mantener ambos alineados.
export async function canEditarRegistro(sesion, registro) {
  if (!sesion || !registro) return false;
  if (registro.planta_id && registro.planta_id !== sesion.planta_id) return false;
  if (registro.creado_por !== sesion.usuario_id) return false;
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
