import sql from 'mssql';
import { ventanaTurno, ventanaActual } from './turno.js';
import { USUARIO_SISTEMA_ID } from '../db.js';

// D-045 — Dominio de la CABECERA de turno (bitacora.turno_unidad) + detalle vivo
// (turno_participante). Lógica de estado puro + operaciones de BD idempotentes/atómicas.
// NO se engancha a endpoints ni al sweeper acá (eso es E3+). Toda la aritmética de tiempo
// se delega a utils/turno.js (offset −5h Bogotá, cruce de medianoche T2) — este módulo NO
// reimplementa ventanas ni offsets.

// Gracia para el auto-cierre AUTO_SIN_RESPUESTA: si al llegar el umbral hay personal en la
// unidad pero nadie decide (cerrar/extender), el sistema cierra solo tras estos minutos.
export const GRACIA_CIERRE_MIN = 60;

// Motivos válidos del cierre (espejo del CHECK de turno_unidad.motivo_cierre).
export const MOTIVOS_CIERRE = ['MANUAL', 'AUTO_SIN_PERSONAL', 'AUTO_SIN_RESPUESTA'];

// fecha_operativa es la fecha Bogotá del INICIO del turno (convención del proyecto). Forzar
// mediodía Bogotá (−05:00) garantiza que ventanaTurno() vea hour=12 y derive la ventana correcta
// para ambos turnos sin depender de "ahora". Mismo patrón que conformacion-snapshot.js.
function fechaRefBogotaMediodia(fecha_operativa) {
  return new Date(`${fecha_operativa}T12:00:00.000-05:00`);
}

// ---------------------------------------------------------------------------
// Lógica pura (sin BD) — testeable con inputs fijos.
// ---------------------------------------------------------------------------

// Próximo umbral 06:00/18:00 Bogotá (en UTC) posterior a `fechaRef`. Es el `fin` de la ventana
// que CONTIENE fechaRef (ventanaActual compone turnoDe + ventanaTurno, incl. cruce de medianoche
// T2). Se usa para fijar/mover fin_nominal al extender. En un instante-umbral exacto (06:00/18:00)
// devuelve el SIGUIENTE umbral, nunca el mismo (la ventana que contiene 18:00 es la T2 → fin 06:00).
export function proximoUmbral(fechaRef = new Date()) {
  return ventanaActual(fechaRef).fin;
}

// ¿La cabecera "requiere decisión" (bloqueo a todos en la unidad)? Puro.
// Bloquea si el turno está ABIERTO y ya se alcanzó su fin_nominal. La extensión NO se consulta
// como flag: al extender, fin_nominal se corre al próximo umbral, así que mientras la extensión
// "cubre" ahora se cumple ahora < fin_nominal (no bloquea) y al llegar el nuevo umbral vuelve a
// bloquear ("re-bloquea al próximo umbral", D-045). Esto subsume el `!extendidoVigente` de la
// especificación: con fin_nominal ya movido, la condición extendido-vigente es equivalente a
// ahora < fin_nominal.
export function estadoBloqueo(turnoRow, ahora = new Date()) {
  if (!turnoRow || turnoRow.estado !== 'ABIERTO' || !turnoRow.fin_nominal) return false;
  const fin = new Date(turnoRow.fin_nominal).getTime();
  if (Number.isNaN(fin)) return false;
  return ahora.getTime() >= fin;
}

// Motivo de auto-cierre a aplicar al llegar el umbral, o null si aún no corresponde. Puro.
// Sin personal en la unidad → cierre inmediato AUTO_SIN_PERSONAL. Con personal pero sin decisión
// pasada la gracia → AUTO_SIN_RESPUESTA. Con personal dentro de la gracia → null (esperar).
export function motivoAutoCierre({ hayPersonal, minutosDesdeUmbral }) {
  if (!hayPersonal) return 'AUTO_SIN_PERSONAL';
  if (minutosDesdeUmbral >= GRACIA_CIERRE_MIN) return 'AUTO_SIN_RESPUESTA';
  return null;
}

// ---------------------------------------------------------------------------
// Operaciones de BD.
// ---------------------------------------------------------------------------

// Lee una fila completa de turno_unidad por id, usando el ejecutor dado (pool o Request-de-tx).
async function _leerTurno(reqFactory, turno_id) {
  const r = await reqFactory()
    .input('id', sql.Int, turno_id)
    .query(`SELECT * FROM bitacora.turno_unidad WHERE turno_unidad_id = @id`);
  return r.recordset[0] ?? null;
}

// UPSERT idempotente de la cabecera para (planta_id, turno, fechaOperativa). Autor SISTEMA.
// Si la fila ya existe (UNIQUE natural) la devuelve sin tocar. Si no existe, decide su estado
// SIN SOLAPE: nace ABIERTO (inicio_real=ahora) sólo si la unidad NO tiene ya un turno ABIERTO;
// si hay uno abierto (p.ej. el anterior extendido), nace PROGRAMADO y esperará a activarSucesor().
// Serializa el chequeo+INSERT con UPDLOCK/HOLDLOCK para no violar el índice único de ABIERTO.
export async function abrirTurnoSiFalta(pool, planta_id, turno, fechaOperativa, ahora = new Date()) {
  if (!USUARIO_SISTEMA_ID) {
    throw new Error('abrirTurnoSiFalta: USUARIO_SISTEMA_ID no inicializado (initDB no corrió)');
  }
  const { inicio, fin } = ventanaTurno(turno, fechaRefBogotaMediodia(fechaOperativa));

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const existente = await new sql.Request(tx)
      .input('f', sql.Date, fechaOperativa)
      .input('p', sql.VarChar(10), planta_id)
      .input('t', sql.TinyInt, turno)
      .query(`
        SELECT TOP 1 turno_unidad_id
        FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK)
        WHERE fecha_operativa = @f AND planta_id = @p AND turno = @t
      `);
    if (existente.recordset[0]) {
      const row = await _leerTurno(() => new sql.Request(tx), existente.recordset[0].turno_unidad_id);
      await tx.commit();
      return row;
    }

    const abierto = await new sql.Request(tx)
      .input('p', sql.VarChar(10), planta_id)
      .query(`
        SELECT TOP 1 turno_unidad_id
        FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK)
        WHERE planta_id = @p AND estado = 'ABIERTO'
      `);
    const naceAbierto = !abierto.recordset[0];

    const ins = await new sql.Request(tx)
      .input('f', sql.Date, fechaOperativa)
      .input('p', sql.VarChar(10), planta_id)
      .input('t', sql.TinyInt, turno)
      .input('estado', sql.VarChar(12), naceAbierto ? 'ABIERTO' : 'PROGRAMADO')
      .input('ini_nom', sql.DateTime2, inicio)
      .input('fin_nom', sql.DateTime2, fin)
      .input('ini_real', sql.DateTime2, naceAbierto ? ahora : null)
      .input('creado_por', sql.Int, USUARIO_SISTEMA_ID)
      .query(`
        INSERT INTO bitacora.turno_unidad
          (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal, inicio_real, creado_por)
        OUTPUT INSERTED.turno_unidad_id
        VALUES (@f, @p, @t, @estado, @ini_nom, @fin_nom, @ini_real, @creado_por)
      `);
    const row = await _leerTurno(() => new sql.Request(tx), ins.recordset[0].turno_unidad_id);
    await tx.commit();
    return row;
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// La fila ABIERTO de la unidad (o null). Max 1 por índice único filtrado.
export async function resolverTurnoAbierto(pool, planta_id) {
  const r = await pool.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1 *
      FROM bitacora.turno_unidad
      WHERE planta_id = @p AND estado = 'ABIERTO'
    `);
  return r.recordset[0] ?? null;
}

// Promueve el PROGRAMADO más antiguo de la unidad a ABIERTO (inicio_real=ahora), pero SÓLO si la
// unidad no tiene ya un ABIERTO (respeta el índice único). Devuelve la fila activada o null.
// Opera sobre una transacción dada (para componerse dentro de cerrarTurno).
async function activarSucesorTx(tx, planta_id, ahora) {
  const abierto = await new sql.Request(tx)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1 turno_unidad_id
      FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK)
      WHERE planta_id = @p AND estado = 'ABIERTO'
    `);
  if (abierto.recordset[0]) return null; // ya hay uno abierto → nada que activar

  const prog = await new sql.Request(tx)
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT TOP 1 turno_unidad_id
      FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK)
      WHERE planta_id = @p AND estado = 'PROGRAMADO'
      ORDER BY inicio_nominal ASC
    `);
  if (!prog.recordset[0]) return null;

  const id = prog.recordset[0].turno_unidad_id;
  await new sql.Request(tx)
    .input('id', sql.Int, id)
    .input('ahora', sql.DateTime2, ahora)
    .query(`
      UPDATE bitacora.turno_unidad
      SET estado = 'ABIERTO', inicio_real = @ahora
      WHERE turno_unidad_id = @id AND estado = 'PROGRAMADO'
    `);
  return _leerTurno(() => new sql.Request(tx), id);
}

// Envoltorio público de activarSucesorTx con su propia transacción.
export async function activarSucesor(pool, planta_id, ahora = new Date()) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const row = await activarSucesorTx(tx, planta_id, ahora);
    await tx.commit();
    return row;
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// Cierre atómico de la cabecera: estado=CERRADO + fin_real + motivo + cerrado_por/en, y activación
// del sucesor PROGRAMADO en la MISMA transacción (el cierre libera el ABIERTO → sin gap). Devuelve
// { cerrado, sucesor }. Idempotente: si ya estaba CERRADO devuelve { cerrado:null, sucesor:null }.
//
// TODO(E6): dentro de esta misma transacción, ANTES de activar el sucesor, enchufar —
//   1) congelar bitacora.conformacion_turno desde turno_participante (turno_id = @id),
//   2) archivar registro_activo con turno_id = @id a registro_historico,
//   3) CIET 'Cierre de turno' con el motivo.
// El punto de extensión es el marcado más abajo; NO archivar todavía en E2.
export async function cerrarTurno(pool, turno_id, { motivo, cerrado_por, ahora = new Date() } = {}) {
  if (!MOTIVOS_CIERRE.includes(motivo)) {
    throw new Error(`cerrarTurno: motivo inválido '${motivo}' (esperado ${MOTIVOS_CIERRE.join('|')})`);
  }
  if (!cerrado_por) throw new Error('cerrarTurno: cerrado_por es requerido');

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const upd = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('motivo', sql.VarChar(20), motivo)
      .input('cerrado_por', sql.Int, cerrado_por)
      .input('ahora', sql.DateTime2, ahora)
      .query(`
        UPDATE bitacora.turno_unidad
        SET estado = 'CERRADO', fin_real = @ahora, motivo_cierre = @motivo,
            cerrado_por = @cerrado_por, cerrado_en = @ahora
        OUTPUT INSERTED.turno_unidad_id, INSERTED.planta_id
        WHERE turno_unidad_id = @id AND estado <> 'CERRADO'
      `);
    if (!upd.recordset[0]) {
      await tx.commit();
      return { cerrado: null, sucesor: null };
    }
    const planta_id = upd.recordset[0].planta_id;

    // ---- PUNTO DE EXTENSIÓN E6 (congelar conformación + archivar + CIET) va AQUÍ ----

    const sucesor = await activarSucesorTx(tx, planta_id, ahora);
    const cerrado = await _leerTurno(() => new sql.Request(tx), turno_id);
    await tx.commit();
    return { cerrado, sucesor };
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// Extiende un turno ABIERTO: extendido=1, veces_extendido+1, fin_nominal=próximo umbral. Devuelve la
// fila actualizada o null si el turno no estaba ABIERTO. `opts.por_usuario`/`opts.detalle` se aceptan
// como parte del contrato pero se consumen en E7 (CIET de extensión + gating puede_cerrar_turno);
// acá sólo mueven el estado de la cabecera.
export async function extenderTurno(pool, turno_id, opts = {}) {
  const { ahora = new Date() } = opts;
  const nuevoFin = proximoUmbral(ahora);
  const r = await pool.request()
    .input('id', sql.Int, turno_id)
    .input('fin', sql.DateTime2, nuevoFin)
    .query(`
      UPDATE bitacora.turno_unidad
      SET extendido = 1, veces_extendido = veces_extendido + 1, fin_nominal = @fin
      OUTPUT INSERTED.turno_unidad_id
      WHERE turno_unidad_id = @id AND estado = 'ABIERTO'
    `);
  if (!r.recordset[0]) return null;
  return _leerTurno(() => pool.request(), turno_id);
}
