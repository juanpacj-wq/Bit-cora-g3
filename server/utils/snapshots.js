import sql from 'mssql';

const JSON_EMPTY = '[]';

const toJSON = (rows) =>
  rows?.length
    ? JSON.stringify(
        rows.map((r) => ({ usuario_id: r.usuario_id, nombre_completo: r.nombre_completo }))
      )
    : JSON_EMPTY;

export async function snapshotJDTs(reqFactory, { planta_id }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id AND s.activa = 1
        AND c.nombre = 'Jefe de Turno' AND u.activo = 1
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

export async function snapshotIngenieros(reqFactory, { planta_id, bitacora_id }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      INNER JOIN lov_bit.cargo_bitacora_permiso p
        ON p.cargo_id = c.cargo_id AND p.bitacora_id = @bitacora_id
      WHERE s.planta_id = @planta_id AND s.activa = 1 AND u.activo = 1
        AND p.puede_crear = 1
        AND c.nombre NOT IN ('Jefe de Turno', 'Gerente de Producción')
    `);
  return toJSON(r.recordset);
}
