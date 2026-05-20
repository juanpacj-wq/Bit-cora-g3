import sql from 'mssql';

// F5 deprecó este check por bitácora — F6 lo reemplaza por lookup en
// `lov_bit.tipo_evento.notificar_dashboard_tipo` (un check más fino por tipo de evento dentro de
// la bitácora MAND). Hasta que F6 mergee, AUTH sigue usando esto vía su definicion_campos.
export function hasNotificarDashboard(definicionJSON) {
  if (!definicionJSON) return false;
  let def;
  try {
    def = typeof definicionJSON === 'string' ? JSON.parse(definicionJSON) : definicionJSON;
  } catch {
    return false;
  }
  if (!Array.isArray(def)) return false;
  return def.some(c => c.campo === 'notificar_dashboard' && c.tipo === 'auto' && c.valor === true);
}

const VALID_TIPOS = new Set(['AUTH', 'REDESP', 'PRUEBA']);

function assertTipo(tipo) {
  if (!VALID_TIPOS.has(tipo)) {
    throw new Error(`evento_dashboard tipo inválido '${tipo}' (esperado AUTH | REDESP | PRUEBA)`);
  }
}

// F5: busca evento por (planta, fecha, periodo, tipo). El UNIQUE permite varios tipos en el
// mismo periodo (preguntas2.md respuesta B), así que la consulta DEBE filtrar por tipo.
export async function findEventoDashboard(transaction, { planta_id, fecha, periodo, tipo }) {
  assertTipo(tipo);
  const r = await new sql.Request(transaction)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('tipo', sql.VarChar(10), tipo)
    .query(`
      SELECT evento_id, activa
      FROM bitacora.evento_dashboard
      WHERE planta_id = @planta_id AND fecha = @fecha AND periodo = @periodo AND tipo = @tipo
    `);
  return r.recordset[0] || null;
}

// F5: upsert con tipo. La reactivación (activa=0 → 1) preserva el evento_id y sobreescribe
// valor/snapshots/origen — esto es necesario para F7 (cancelar + reabrir celda en MAND).
export async function upsertEventoDashboard(transaction, {
  planta_id, fecha, periodo, valor, jdts_snapshot, jefes_snapshot, registro_origen_id, tipo,
}) {
  assertTipo(tipo);
  const row = await findEventoDashboard(transaction, { planta_id, fecha, periodo, tipo });

  if (row && row.activa) {
    return { conflict: true, evento_id: row.evento_id };
  }

  if (row && !row.activa) {
    await new sql.Request(transaction)
      .input('id', sql.Int, row.evento_id)
      .input('valor', sql.Float, valor)
      .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
      .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
      .input('origen', sql.Int, registro_origen_id)
      .query(`
        UPDATE bitacora.evento_dashboard
        SET activa = 1,
            valor_mw = @valor,
            jdts_snapshot = @jdts_snapshot,
            jefes_snapshot = @jefes_snapshot,
            registro_origen_id = @origen,
            creado_en = SYSUTCDATETIME()
        WHERE evento_id = @id
      `);
    return { reactivated: true, evento_id: row.evento_id };
  }

  const ins = await new sql.Request(transaction)
    .input('origen', sql.Int, registro_origen_id)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('valor', sql.Float, valor)
    .input('tipo', sql.VarChar(10), tipo)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
    .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
    .query(`
      INSERT INTO bitacora.evento_dashboard
        (registro_origen_id, planta_id, fecha, periodo, valor_mw, tipo, jdts_snapshot, jefes_snapshot)
      OUTPUT INSERTED.evento_id
      VALUES (@origen, @planta_id, @fecha, @periodo, @valor, @tipo, @jdts_snapshot, @jefes_snapshot)
    `);
  return { inserted: true, evento_id: ins.recordset[0].evento_id };
}

// Compat: callers viejos en server.js (POST/PUT registros) pasan AUTH por defecto. F6 los
// parametriza por `tipo_evento.notificar_dashboard_tipo`.
export const findAutorizacion = (transaction, args) =>
  findEventoDashboard(transaction, { ...args, tipo: 'AUTH' });

export const upsertAutorizacion = (transaction, args) =>
  upsertEventoDashboard(transaction, { ...args, tipo: 'AUTH' });

// D-026: DISP migró a `bitacora.disponibilidad_estado` (tabla dedicada, ER nativo). La
// vieja `disponibilidad_dashboard` ahora es VIEW de solo-lectura sobre el vigente — los
// helpers de write (upsert/delete) se reemplazaron por los siguientes, que operan
// directamente sobre la tabla nueva. Cross-repo sigue leyendo la vista (shape preservado).

// Lee el vigente (fecha_fin_estado IS NULL) de una planta con UPDLOCK+HOLDLOCK para
// serializar POSTs concurrentes. Devuelve la fila completa (incluye snapshots) o null.
export async function findVigente(transaction, { planta_id }) {
  const r = await new sql.Request(transaction)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1
        disponibilidad_id, planta_id, estado, codigo,
        fecha_inicio_estado, fecha_fin_estado, detalle,
        jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
        creado_por, creado_en, modificado_por, modificado_en
      FROM bitacora.disponibilidad_estado WITH (UPDLOCK, HOLDLOCK)
      WHERE planta_id = @p AND fecha_fin_estado IS NULL
    `);
  return r.recordset[0] || null;
}

// Lee el último cerrado de una planta (mayor fecha_inicio_estado entre los cerrados).
// Sin lock — solo se usa para resolver el N-1 al deshacer o para mostrar el predecesor.
export async function findUltimoCerrado(transaction, { planta_id }) {
  const r = await new sql.Request(transaction)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1
        disponibilidad_id, estado, codigo,
        fecha_inicio_estado, fecha_fin_estado, detalle
      FROM bitacora.disponibilidad_estado
      WHERE planta_id = @p AND fecha_fin_estado IS NOT NULL
      ORDER BY fecha_inicio_estado DESC
    `);
  return r.recordset[0] || null;
}

// Cierra un vigente seteando fecha_fin_estado (paso previo al INSERT del nuevo vigente).
export async function cerrarVigente(transaction, { disponibilidad_id, fecha_fin }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .input('fin', sql.DateTime2, fecha_fin)
    .query(`UPDATE bitacora.disponibilidad_estado SET fecha_fin_estado=@fin WHERE disponibilidad_id=@id`);
}

// INSERT del nuevo vigente (fecha_fin_estado NULL implícito por DEFAULT del CREATE TABLE).
// Devuelve la fila insertada vía OUTPUT INSERTED.* — los handlers la consumen sin re-query.
export async function insertNuevoEstado(transaction, {
  planta_id, estado, codigo, fecha_inicio_estado, detalle,
  jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
  creado_por,
}) {
  const r = await new sql.Request(transaction)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('estado', sql.VarChar(20), estado)
    .input('codigo', sql.SmallInt, codigo)
    .input('fecha_inicio_estado', sql.DateTime2, fecha_inicio_estado)
    .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot ?? '[]')
    .input('jefes_planta_snapshot', sql.NVarChar(sql.MAX), jefes_planta_snapshot ?? '[]')
    .input('gerentes_produccion_snapshot', sql.NVarChar(sql.MAX), gerentes_produccion_snapshot ?? '[]')
    .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot ?? '[]')
    .input('creado_por', sql.Int, creado_por)
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, detalle,
         jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
         creado_por)
      OUTPUT INSERTED.*
      VALUES (@planta_id, @estado, @codigo, @fecha_inicio_estado, @detalle,
              @jdts_snapshot, @jefes_planta_snapshot, @gerentes_produccion_snapshot, @ingenieros_snapshot,
              @creado_por)
    `);
  return r.recordset[0];
}

// PUT sobre el vigente: actualiza todos los campos editables. modificado_por y modificado_en
// SIEMPRE se setean (el caller debe pasar el usuario). Si el PUT cambia fecha_inicio_estado,
// el handler del prompt 03 también ajusta el N-1 (regla D-011, fuera de este helper).
export async function actualizarVigente(transaction, {
  disponibilidad_id, estado, codigo, fecha_inicio_estado, detalle,
  jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
  modificado_por,
}) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .input('estado', sql.VarChar(20), estado)
    .input('codigo', sql.SmallInt, codigo)
    .input('fecha_inicio_estado', sql.DateTime2, fecha_inicio_estado)
    .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot ?? '[]')
    .input('jefes_planta_snapshot', sql.NVarChar(sql.MAX), jefes_planta_snapshot ?? '[]')
    .input('gerentes_produccion_snapshot', sql.NVarChar(sql.MAX), gerentes_produccion_snapshot ?? '[]')
    .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot ?? '[]')
    .input('modificado_por', sql.Int, modificado_por)
    .query(`
      UPDATE bitacora.disponibilidad_estado
      SET estado=@estado, codigo=@codigo, fecha_inicio_estado=@fecha_inicio_estado, detalle=@detalle,
          jdts_snapshot=@jdts_snapshot, jefes_planta_snapshot=@jefes_planta_snapshot,
          gerentes_produccion_snapshot=@gerentes_produccion_snapshot, ingenieros_snapshot=@ingenieros_snapshot,
          modificado_por=@modificado_por, modificado_en=SYSUTCDATETIME()
      WHERE disponibilidad_id=@id
    `);
}

// DELETE físico (usado por /deshacer: el row se borra, no queda en histórico).
export async function eliminarPorId(transaction, { disponibilidad_id }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id`);
}

// Reabre un cerrado como vigente. Usado por /deshacer cuando hay N-1 a restaurar.
export async function restaurarComoVigente(transaction, { disponibilidad_id }) {
  await new sql.Request(transaction)
    .input('id', sql.Int, disponibilidad_id)
    .query(`UPDATE bitacora.disponibilidad_estado SET fecha_fin_estado=NULL WHERE disponibilidad_id=@id`);
}

function safeJsonParseArr(s) {
  if (s == null) return [];
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string') return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// GET /api/disponibilidad — vigente + página de historial + total. Lee directo de
// `bitacora.disponibilidad_estado` (post D-026): vigente = fecha_fin_estado IS NULL,
// histórico = fecha_fin_estado IS NOT NULL, ordenado DESC. Snapshots se devuelven como
// arrays parseados (el frontend espera arrays, no strings JSON).
export async function getEstadoCompleto(db, { planta_id, historial_limit = 20, historial_offset = 0 }) {
  const vigRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1
        de.disponibilidad_id, de.planta_id, de.estado, de.codigo,
        de.fecha_inicio_estado, de.fecha_fin_estado, de.detalle,
        de.creado_por, de.creado_en, de.modificado_por, de.modificado_en,
        de.ingenieros_snapshot, de.jdts_snapshot, de.jefes_planta_snapshot,
        autor.nombre_completo AS creado_por_nombre,
        modu.nombre_completo  AS modificado_por_nombre
      FROM bitacora.disponibilidad_estado de
      LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = de.creado_por
      LEFT JOIN lov_bit.usuario modu  ON modu.usuario_id  = de.modificado_por
      WHERE de.planta_id = @p AND de.fecha_fin_estado IS NULL
    `);
  const vigRow = vigRes.recordset[0] || null;
  const vigente = vigRow ? {
    registro_id: vigRow.disponibilidad_id,
    planta_id: vigRow.planta_id,
    evento: vigRow.estado,
    codigo: vigRow.codigo,
    fecha_inicio_estado: vigRow.fecha_inicio_estado,
    detalle: vigRow.detalle,
    creado_por: { usuario_id: vigRow.creado_por, nombre_completo: vigRow.creado_por_nombre },
    creado_en: vigRow.creado_en,
    modificado_por: vigRow.modificado_por
      ? { usuario_id: vigRow.modificado_por, nombre_completo: vigRow.modificado_por_nombre }
      : null,
    modificado_en: vigRow.modificado_en,
    ingenieros_snapshot: safeJsonParseArr(vigRow.ingenieros_snapshot),
    jdts_snapshot: safeJsonParseArr(vigRow.jdts_snapshot),
    // BD: jefes_planta_snapshot. Frontend lee 'jefes_snapshot' (compat legacy).
    jefes_snapshot: safeJsonParseArr(vigRow.jefes_planta_snapshot),
  } : null;

  const histRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('limit', sql.Int, historial_limit)
    .input('offset', sql.Int, historial_offset)
    .query(`
      SELECT de.disponibilidad_id, de.estado, de.codigo,
             de.fecha_inicio_estado, de.fecha_fin_estado, de.detalle,
             de.creado_por, de.creado_en,
             autor.nombre_completo AS creado_por_nombre
      FROM bitacora.disponibilidad_estado de
      LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = de.creado_por
      WHERE de.planta_id = @p AND de.fecha_fin_estado IS NOT NULL
      ORDER BY de.fecha_inicio_estado DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
  const historial = histRes.recordset.map(row => ({
    registro_id: row.disponibilidad_id,
    evento: row.estado,
    codigo: row.codigo,
    fecha_inicio_estado: row.fecha_inicio_estado,
    fecha_fin_estado: row.fecha_fin_estado,
    detalle: row.detalle,
    creado_por: { usuario_id: row.creado_por, nombre_completo: row.creado_por_nombre },
    creado_en: row.creado_en,
  }));

  const totalRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT COUNT(*) AS total FROM bitacora.disponibilidad_estado
      WHERE planta_id = @p AND fecha_fin_estado IS NOT NULL
    `);
  return { vigente, historial, historial_total: totalRes.recordset[0].total };
}

// GET /api/disponibilidad/metricas — ms acumulado por estado en la ventana [desde, hasta].
// Sustituye la vieja query sobre `v_disp_intervalos` (dropeada en F26.A1): suma DATEDIFF_BIG
// directo sobre `disponibilidad_estado` truncando cada intervalo a la ventana. El vigente se
// recorta a `@ahora` (NOW UTC del server) para que el cliente conozca el reloj usado.
//
// `desde`/`hasta` pueden venir null: defaults = MIN(fecha_inicio_estado) y NOW UTC.
// Si la planta no tiene rows → todo 0 (con desde=null en la respuesta).
export async function getMetricas(db, { planta_id, desde, hasta }) {
  if (!hasta) hasta = new Date();
  let efectivoDesde = desde;
  if (!efectivoDesde) {
    const minRow = await db.request()
      .input('p', sql.VarChar(10), planta_id)
      .query(`SELECT MIN(fecha_inicio_estado) AS d FROM bitacora.disponibilidad_estado WHERE planta_id=@p`);
    efectivoDesde = minRow.recordset[0]?.d ? new Date(minRow.recordset[0].d) : null;
  }
  if (!efectivoDesde) {
    return {
      planta_id,
      desde: null,
      hasta: hasta.toISOString(),
      ahora: hasta.toISOString(),
      tiempo_ms: { 'En Servicio': 0, 'En Reserva': 0, Indisponible: 0, Mantenimiento: 0 },
      acumulados_ms: { disponible: 0, no_disponible: 0 },
      total_ms: 0,
    };
  }

  const ahoraDb = await db.request().query(`SELECT SYSUTCDATETIME() AS ahora`);
  const ahora = ahoraDb.recordset[0].ahora;

  const aggRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('desde', sql.DateTime2, efectivoDesde)
    .input('hasta', sql.DateTime2, hasta)
    .input('ahora', sql.DateTime2, ahora)
    .query(`
      SELECT
        estado AS evento,
        SUM(
          DATEDIFF_BIG(
            MILLISECOND,
            CASE WHEN fecha_inicio_estado < @desde THEN @desde ELSE fecha_inicio_estado END,
            CASE
              WHEN COALESCE(fecha_fin_estado, @ahora) > @hasta THEN @hasta
              ELSE COALESCE(fecha_fin_estado, @ahora)
            END
          )
        ) AS tiempo_ms
      FROM bitacora.disponibilidad_estado
      WHERE planta_id = @p
        AND fecha_inicio_estado < @hasta
        AND COALESCE(fecha_fin_estado, @ahora) > @desde
      GROUP BY estado
    `);

  const tiempo_ms = { 'En Servicio': 0, 'En Reserva': 0, Indisponible: 0, Mantenimiento: 0 };
  for (const row of aggRes.recordset) {
    if (row.evento && row.evento in tiempo_ms) {
      tiempo_ms[row.evento] = Number(row.tiempo_ms) || 0;
    }
  }
  const acumulados_ms = {
    disponible: tiempo_ms['En Servicio'] + tiempo_ms['En Reserva'],
    no_disponible: tiempo_ms.Indisponible + tiempo_ms.Mantenimiento,
  };
  const total_ms = acumulados_ms.disponible + acumulados_ms.no_disponible;
  return {
    planta_id,
    desde: efectivoDesde.toISOString(),
    hasta: hasta.toISOString(),
    ahora: new Date(ahora).toISOString(),
    tiempo_ms,
    acumulados_ms,
    total_ms,
  };
}
