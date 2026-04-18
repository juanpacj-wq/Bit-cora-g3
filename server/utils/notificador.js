import sql from 'mssql';

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

export async function findAutorizacion(transaction, { planta_id, fecha, periodo }) {
  const existente = await new sql.Request(transaction)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .query(`
      SELECT autorizacion_id, activa
      FROM bitacora.autorizacion_dashboard
      WHERE planta_id = @planta_id AND fecha = @fecha AND periodo = @periodo
    `);
  return existente.recordset[0] || null;
}

export async function upsertAutorizacion(transaction, { planta_id, fecha, periodo, valor, jdts_snapshot, jefes_snapshot, registro_origen_id }) {
  const row = await findAutorizacion(transaction, { planta_id, fecha, periodo });

  if (row && row.activa) {
    return { conflict: true, autorizacion_id: row.autorizacion_id };
  }

  if (row && !row.activa) {
    await new sql.Request(transaction)
      .input('id', sql.Int, row.autorizacion_id)
      .input('valor', sql.Float, valor)
      .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
      .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
      .input('origen', sql.Int, registro_origen_id)
      .query(`
        UPDATE bitacora.autorizacion_dashboard
        SET activa = 1,
            valor_autorizado_mw = @valor,
            jdts_snapshot = @jdts_snapshot,
            jefes_snapshot = @jefes_snapshot,
            registro_origen_id = @origen,
            creado_en = GETDATE()
        WHERE autorizacion_id = @id
      `);
    return { reactivated: true, autorizacion_id: row.autorizacion_id };
  }

  const ins = await new sql.Request(transaction)
    .input('origen', sql.Int, registro_origen_id)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('valor', sql.Float, valor)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
    .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
    .query(`
      INSERT INTO bitacora.autorizacion_dashboard
        (registro_origen_id, planta_id, fecha, periodo, valor_autorizado_mw, jdts_snapshot, jefes_snapshot)
      OUTPUT INSERTED.autorizacion_id
      VALUES (@origen, @planta_id, @fecha, @periodo, @valor, @jdts_snapshot, @jefes_snapshot)
    `);
  return { inserted: true, autorizacion_id: ins.recordset[0].autorizacion_id };
}
