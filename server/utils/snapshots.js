import sql from 'mssql';

const JSON_EMPTY = '[]';
// F9: SESION_TTL_MIN export eliminado — el modelo de sesión post F2 no usa TTL.

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
        AND u.activo = 1
        AND c.nombre NOT IN ('Ingeniero Jefe de Turno', 'Gerente de Producción')
    `);
  return toJSON(r.recordset);
}

// F16: snapshots agregados del día completo. Capturan TODOS los usuarios cuya sesión
// inició o tuvo actividad durante el día Bogotá @fecha en planta_id. A diferencia de
// snapshotJDTs/snapshotIngenieros (que cierran sobre el momento), estos ven toda la guardia
// que rotó por la grilla MAND ese día. Los consume el sweeper diario (mand-sweeper.js).
//
// Criterio de "presente en el día": inicio_sesion cae el día Bogotá O ultima_actividad
// cae el día Bogotá. Los rangos se calculan con offset -5h (UTC ↔ Bogotá).
export async function snapshotJDTsDelDia(reqFactory, { planta_id, fecha }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id
        AND c.nombre = 'Ingeniero Jefe de Turno'
        AND u.activo = 1
        AND (
          CAST(DATEADD(HOUR, -5, s.inicio_sesion) AS DATE) = @fecha
          OR CAST(DATEADD(HOUR, -5, s.ultima_actividad) AS DATE) = @fecha
        )
    `);
  return toJSON(r.recordset);
}

// Los jefes de planta no se filtran por sesión — son los mismos siempre (es_jefe_planta=1).
// El "del día" se mantiene por simetría con los demás helpers; el resultado es estable.
export async function snapshotJefesDelDia(reqFactory) {
  const r = await reqFactory().query(`
    SELECT usuario_id, nombre_completo FROM lov_bit.usuario
    WHERE es_jefe_planta = 1 AND activo = 1
    ORDER BY usuario_id
  `);
  return toJSON(r.recordset);
}

// IngOp + operadores que rotaron en planta_id durante el día Bogotá @fecha.
// Excluye JdT y Gerente de Producción (capturados en otros snapshots).
export async function snapshotIngenierosDelDia(reqFactory, { planta_id, fecha }) {
  const r = await reqFactory()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.planta_id = @planta_id
        AND u.activo = 1
        AND c.nombre NOT IN ('Ingeniero Jefe de Turno', 'Gerente de Producción')
        AND (
          CAST(DATEADD(HOUR, -5, s.inicio_sesion) AS DATE) = @fecha
          OR CAST(DATEADD(HOUR, -5, s.ultima_actividad) AS DATE) = @fecha
        )
    `);
  return toJSON(r.recordset);
}

// D-026: gerentes de producción con sesión activa global (rol no es por planta).
// A diferencia de snapshotJefes (que usa flag es_jefe_planta sin importar sesión),
// este filtra por sesión viva — refleja "quién estaba presente al momento del evento DISP".
// Sin planta: el rol es global. Devuelve '[]' si no hay nadie — nunca NULL.
export async function snapshotGerentesProduccion(reqFactory) {
  const r = await reqFactory()
    .query(`
      SELECT DISTINCT u.usuario_id, u.nombre_completo
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
      WHERE s.activa = 1
        AND u.activo = 1
        AND c.nombre = 'Gerente de Producción'
    `);
  return toJSON(r.recordset);
}
