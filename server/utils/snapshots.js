import sql from 'mssql';

const JSON_EMPTY = '[]';
export const SESION_TTL_MIN = 5;

const toJSON = (rows) =>
  rows?.length
    ? JSON.stringify(
        rows.map((r) => ({ usuario_id: r.usuario_id, nombre_completo: r.nombre_completo }))
      )
    : JSON_EMPTY;

// snapshotJDTs captura qué Ingenieros Jefes de Turno estaban en sesión activa cuando se creó
// el registro. NOTA: `es_jdt_default` es sólo un fallback de identidad (hoy Omar Fedullo) para
// poblar el snapshot cuando ningún JdT tiene sesión activa — NO es un flag de permiso. Los
// permisos operativos (cerrar turno, editar cualquier registro) viven en
// `lov_bit.cargo.puede_cerrar_turno`, que está en 1 tanto para 'Ingeniero Jefe de Turno' como
// 'Ingeniero de Operación'. No expandir `es_jdt_default` a más usuarios sin evaluar impacto en
// trazabilidad: un fallback con 20 nombres ensucia el audit trail más de lo que lo aclara.
export async function snapshotJDTs(reqFactory, { planta_id }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id AND s.activa = 1
        AND s.ultima_actividad > DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
        AND c.nombre = 'Ingeniero Jefe de Turno' AND u.activo = 1
    `);
  if (r.recordset.length > 0) return toJSON(r.recordset);
  const fb = await reqFactory().query(`
    SELECT usuario_id, nombre_completo FROM lov_bit.usuario
    WHERE es_jdt_default = 1 AND activo = 1
  `);
  return toJSON(fb.recordset);
}

export async function snapshotJefes(reqFactory) {
  const r = await reqFactory().query(`
    SELECT usuario_id, nombre_completo FROM lov_bit.usuario
    WHERE es_jefe_planta = 1 AND activo = 1
    ORDER BY usuario_id
  `);
  return toJSON(r.recordset);
}

export async function snapshotIngenieros(reqFactory, { planta_id }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id AND s.activa = 1
        AND s.ultima_actividad > DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
        AND u.activo = 1
        AND c.nombre NOT IN ('Ingeniero Jefe de Turno', 'Gerente de Producción')
    `);
  return toJSON(r.recordset);
}
