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
            creado_en = GETDATE()
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
