import sql from 'mssql';
import { ventanaTurno } from './turno.js';

// fecha_operativa es la fecha Bogotá del INICIO del turno (convención del proyecto).
// new Date('YYYY-MM-DD') interpreta como midnight UTC → tras el shift -5h de
// colombiaParts cae en el día Bogotá anterior. Forzar mediodía Bogotá (-05:00) garantiza
// que ventanaTurno() vea hour=12 y use el día correcto para ambos turnos.
function fechaRefBogotaMediodia(fecha_operativa) {
  return new Date(`${fecha_operativa}T12:00:00.000-05:00`);
}

// D-044: `incluirSinteticos` es un escape hatch EXCLUSIVO de los unit tests del agregado puro
// (duración, ventana T2, fin_inferido). Producción NUNCA lo pasa → default false → los usuarios
// sintéticos (es_sintetico=1, fixtures test_*) quedan SIEMPRE excluidos del snapshot real. Un
// guardrail estático (describe 'D-044 blindaje' en conformacion_turno.test.js) falla si algún
// archivo de producción lo setea.
export async function buildConformacionSnapshot(pool, { fecha_operativa, planta_id, turno, incluirSinteticos = false }) {
  const fechaRef = fechaRefBogotaMediodia(fecha_operativa);
  const { inicio: ventanaInicio, fin: ventanaFin } = ventanaTurno(turno, fechaRef);

  const r = await pool.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('turno', sql.TinyInt, turno)
    .input('incluir_sinteticos', sql.Bit, incluirSinteticos ? 1 : 0)
    .input('ventana_inicio', sql.DateTime2, ventanaInicio)
    .input('ventana_fin', sql.DateTime2, ventanaFin)
    .query(`
      WITH SesionesEnTurno AS (
        SELECT
          sa.usuario_id,
          sa.cargo_id,
          sa.inicio_sesion AS inicio_efectivo,
          CASE
            WHEN sa.cerrada_en IS NOT NULL AND sa.cerrada_en < @ventana_fin THEN sa.cerrada_en
            ELSE @ventana_fin
          END AS fin_efectivo,
          CASE
            WHEN sa.cerrada_en IS NOT NULL AND sa.cerrada_en <= @ventana_fin THEN 0
            ELSE 1
          END AS fin_inferido_sesion
        FROM bitacora.sesion_activa sa
        WHERE sa.planta_id = @planta_id
          AND sa.turno = @turno
          -- D-003: el turno se fija al login. Una sesión cuenta para la conformación
          -- del turno X si arrancó DENTRO de la ventana de X. Filtrar por solape
          -- (sesiones de hace meses con activa=1/cerrada_en=NULL) producía sumas
          -- absurdas en testing real contra BD productiva.
          AND sa.inicio_sesion >= @ventana_inicio
          AND sa.inicio_sesion < @ventana_fin
      )
      SELECT
        st.usuario_id,
        u.nombre_completo AS usuario_nombre,
        st.cargo_id,
        c.nombre AS cargo_nombre,
        MIN(st.inicio_efectivo) AS inicio_sesion,
        MAX(st.fin_efectivo)    AS fin_sesion,
        SUM(DATEDIFF(MINUTE, st.inicio_efectivo, st.fin_efectivo)) AS duracion_min,
        MAX(st.fin_inferido_sesion) AS fin_inferido
      FROM SesionesEnTurno st
      INNER JOIN lov_bit.usuario u ON u.usuario_id = st.usuario_id
      INNER JOIN lov_bit.cargo   c ON c.cargo_id   = st.cargo_id
      -- D-044: chokepoint blindado. La suite corre contra la BD productiva (D-030) y siembra
      -- usuarios test_* con sesion_activa sobre plantas reales; sin este filtro el builder los
      -- fotografiaba en el histórico inmutable de GEC3/GEC32. Excluye es_sintetico=1 SIEMPRE en
      -- producción (@incluir_sinteticos=0), independiente de la planta. Solo los unit tests del
      -- agregado puro pasan @incluir_sinteticos=1. NUNCA quitar este predicado.
      -- D-059: los observadores quedan fuera de la conformación SIN escape hatch — la
      -- invisibilidad no tiene excepción ni en unit tests. NUNCA quitar este predicado tampoco.
      WHERE (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
        AND c.es_observador = 0
      GROUP BY st.usuario_id, u.nombre_completo, st.cargo_id, c.nombre
    `);

  return r.recordset.map(row => ({
    fecha_operativa,
    planta_id,
    turno,
    usuario_id: row.usuario_id,
    usuario_nombre: row.usuario_nombre,
    cargo_id: row.cargo_id,
    cargo_nombre: row.cargo_nombre,
    inicio_sesion: row.inicio_sesion,
    fin_sesion: row.fin_sesion,
    duracion_min: row.duracion_min,
    fin_inferido: row.fin_inferido ? 1 : 0,
  }));
}

export async function persistConformacionSnapshot(pool, filas) {
  if (filas.length === 0) return { insertadas: 0, skipped: 0 };

  let insertadas = 0;
  let skipped = 0;
  for (const f of filas) {
    const r = await pool.request()
      .input('fecha_operativa', sql.Date, f.fecha_operativa)
      .input('planta_id', sql.VarChar(10), f.planta_id)
      .input('turno', sql.TinyInt, f.turno)
      .input('usuario_id', sql.Int, f.usuario_id)
      .input('usuario_nombre', sql.VarChar(200), f.usuario_nombre)
      .input('cargo_id', sql.Int, f.cargo_id)
      .input('cargo_nombre', sql.VarChar(100), f.cargo_nombre)
      .input('inicio_sesion', sql.DateTime2, f.inicio_sesion)
      .input('fin_sesion', sql.DateTime2, f.fin_sesion)
      .input('duracion_min', sql.Int, f.duracion_min)
      .input('fin_inferido', sql.Bit, f.fin_inferido)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM bitacora.conformacion_turno
          WHERE fecha_operativa = @fecha_operativa
            AND planta_id = @planta_id
            AND turno = @turno
            AND usuario_id = @usuario_id
        )
        INSERT INTO bitacora.conformacion_turno
          (fecha_operativa, planta_id, turno, usuario_id, usuario_nombre,
           cargo_id, cargo_nombre, inicio_sesion, fin_sesion, duracion_min, fin_inferido)
        VALUES
          (@fecha_operativa, @planta_id, @turno, @usuario_id, @usuario_nombre,
           @cargo_id, @cargo_nombre, @inicio_sesion, @fin_sesion, @duracion_min, @fin_inferido);
      `);
    if (r.rowsAffected[0] > 0) insertadas++;
    else skipped++;
  }
  return { insertadas, skipped };
}
