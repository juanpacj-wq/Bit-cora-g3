import sql from 'mssql';
import { snapshotJDTs, snapshotJefes, snapshotIngenieros } from './snapshots.js';

const CIET_CODE = 'CIET';
const TIPO_NOMBRE = {
  finalizacion: 'Finalización de turno',
  cierre: 'Cierre de turno',
};

// F3: registra un evento en la bitácora CIET dentro de la transacción que se le pasa.
// El caller es responsable de manejar commit/rollback. Esto permite que:
//   - el INSERT al histórico (F4 cierre cronológico) y el evento CIET sean atómicos.
//   - una falla en el seed de CIET no deje a medias el cierre.
// `tipo` puede ser 'finalizacion' o 'cierre'. `bitacora_origen_id` es opcional (la bitácora que
// se cerró/finalizó; null para finalización global). `forzado=true` cuando el cierre se origina
// en sweeper/popup forzado de F4 — sirve para distinguir en histórico.
export async function registrarEventoCierre(transaction, { tipo, sesion, bitacora_origen_id = null, forzado = false }) {
  const tipoNombre = TIPO_NOMBRE[tipo];
  if (!tipoNombre) {
    throw new Error(`registrarEventoCierre: tipo inválido '${tipo}' (esperado 'finalizacion' | 'cierre')`);
  }

  const ids = await new sql.Request(transaction)
    .input('codigo', sql.VarChar(10), CIET_CODE)
    .input('tipo_nombre', sql.VarChar(100), tipoNombre)
    .query(`
      SELECT b.bitacora_id, te.tipo_evento_id
      FROM lov_bit.bitacora b
      INNER JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
      WHERE b.codigo = @codigo AND te.nombre = @tipo_nombre
    `);
  if (!ids.recordset[0]) {
    throw new Error(`registrarEventoCierre: bitácora ${CIET_CODE} o tipo '${tipoNombre}' no encontrado en BD`);
  }
  const { bitacora_id, tipo_evento_id } = ids.recordset[0];

  const reqFactory = () => new sql.Request(transaction);
  const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: sesion.planta_id });
  const jefes_snapshot = await snapshotJefes(reqFactory);
  const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id: sesion.planta_id });

  const camposExtra = JSON.stringify({
    usuario_id: sesion.usuario_id,
    rol: sesion.cargo_nombre,
    bitacora_origen: bitacora_origen_id,
    forzado: !!forzado,
  });

  const ins = await new sql.Request(transaction)
    .input('bitacora_id', sql.Int, bitacora_id)
    .input('planta_id', sql.VarChar(10), sesion.planta_id)
    .input('turno', sql.TinyInt, sesion.turno)
    .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
    .input('tipo_evento_id', sql.Int, tipo_evento_id)
    .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot)
    .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
    .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
    .input('creado_por', sql.Int, sesion.usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      OUTPUT INSERTED.registro_id, INSERTED.bitacora_id, INSERTED.tipo_evento_id, INSERTED.fecha_evento
      VALUES (@bitacora_id, @planta_id, GETDATE(), @turno, NULL, @campos_extra, @tipo_evento_id,
              'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por)
    `);
  return ins.recordset[0];
}
