import sql from 'mssql';
import { ventanaTurno, ventanaActual, getTurnoColombia, fechaBogotaStr } from './turno.js';
import { USUARIO_SISTEMA_ID } from '../db.js';
import { registrarEventoCierre } from './ciet.js';

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
// Acepta string 'YYYY-MM-DD' (abrirTurnoSiFalta) o un Date (columna DATE leída de la BD, que mssql
// devuelve a MEDIANOCHE UTC). En el caso Date leemos las partes UTC directas —NO el shift −5h de
// fechaBogotaStr—: un DATE no tiene hora, su valor ya ES la fecha operativa; aplicarle el offset la
// correría un día atrás. Sin esta normalización, interpolar un Date daba `Invalid Date` y el guard de
// ventana de reabrirTurno fallaba siempre con 'ventana_vencida'.
function fechaRefBogotaMediodia(fecha_operativa) {
  const ymd = fecha_operativa instanceof Date
    ? `${fecha_operativa.getUTCFullYear()}-${String(fecha_operativa.getUTCMonth() + 1).padStart(2, '0')}-${String(fecha_operativa.getUTCDate()).padStart(2, '0')}`
    : fecha_operativa;
  return new Date(`${ymd}T12:00:00.000-05:00`);
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

// D-045 (write-gate) — resuelve el turno ABIERTO de la unidad, abriendo el de la ventana vigente si
// aún no existe (borde de ventana: el sweeper corre c/60s, un registro puede llegar antes). Devuelve
// la fila ABIERTO o `null` si la unidad NO tiene turno abierto — cierre manual anticipado o auto-cierre
// sin sucesor (la ventana ya tiene su fila CERRADA, así que abrirTurnoSiFalta la devuelve sin reabrir).
// Un `null` es la señal de "turno cerrado → bloquear escritura en bitácoras genéricas".
export async function resolverOAbrirTurnoAbierto(pool, planta_id, { ahora = new Date() } = {}) {
  let t = await resolverTurnoAbierto(pool, planta_id);
  if (!t) {
    const { inicio } = ventanaActual(ahora);
    await abrirTurnoSiFalta(pool, planta_id, getTurnoColombia(), fechaBogotaStr(inicio), ahora);
    t = await resolverTurnoAbierto(pool, planta_id);
  }
  return t;
}

// D-046 (write-gate de transición) — resuelve el turno de la unidad para una ESCRITURA, distinguiendo
// TRES estados operables (no solo abierto/cerrado):
//   ABIERTO    → dentro de ventana, se puede escribir. Devuelve la fila en `turno`.
//   TRANSICION → ABIERTO pero ya cruzó `fin_nominal` (gavela de gracia: esperando cerrar/extender). El
//                turno sigue ABIERTO en BD (bloqueo es computado por estadoBloqueo), pero la escritura
//                debe bloquearse igual que si estuviera cerrado — cierra el hueco de que la gracia solo
//                la tapara el modal del front (evadible) y el de ≤60s de latencia del sweeper.
//   CERRADO    → la unidad NO tiene turno ABIERTO (cierre manual anticipado o auto-cierre sin sucesor).
// `abrir=true` abre el turno de la ventana vigente si falta (paridad con resolverOAbrirTurnoAbierto, para
// el POST); PUT/DELETE usan `abrir=false` (no se abre un turno solo para editar/borrar). Se evalúa con
// `estadoBloqueo` por-request, así el bloqueo actúa al instante de cruzar el umbral, sin depender del tick
// del sweeper. Al extender (fin_nominal → próximo umbral) estadoBloqueo vuelve a false → se desbloquea solo.
export async function resolverTurnoParaEscritura(pool, planta_id, { abrir = false, ahora = new Date() } = {}) {
  let t = await resolverTurnoAbierto(pool, planta_id);
  if (!t && abrir) {
    const { inicio } = ventanaActual(ahora);
    await abrirTurnoSiFalta(pool, planta_id, getTurnoColombia(), fechaBogotaStr(inicio), ahora);
    t = await resolverTurnoAbierto(pool, planta_id);
  }
  if (!t) return { estado: 'CERRADO', turno: null };
  if (estadoBloqueo(t, ahora)) return { estado: 'TRANSICION', turno: t };
  return { estado: 'ABIERTO', turno: t };
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

// D-045 E6 — CIERRE UNIFICADO ATÓMICO. En UNA transacción: sella la cabecera (CERRADO + fin_real +
// motivo + cerrado_por/en), congela `conformacion_turno` desde `turno_participante` (incluye a quien
// entró aunque no estuviera al cierre), archiva los registros del turno (por `turno_id`) a
// `registro_historico`, emite el CIET 'Cierre de turno' con el motivo, y activa el sucesor PROGRAMADO
// (→ ABIERTO, sin gap). Idempotente: si ya estaba CERRADO devuelve `{ cerrado:null, ... }`.
//
// Reemplaza el modelo viejo (cierre por ventana en cierre.js + conformación por sweeper/catchup) y
// CIERRA los hallazgos H1/H2 de la auditoría 2026-07-04: la fecha de conformación ya no se deriva del
// login (post-medianoche T2), sale de la cabecera (`fecha_operativa`, `turno`). MAND/DISP no tienen
// `turno_id` → el filtro por turno_id ya los excluye del archivado (más el guard `codigo NOT IN`).
//
// `incluirSinteticos` (D-044): escape hatch EXCLUSIVO de unit tests; producción NUNCA lo pasa → los
// usuarios `es_sintetico=1` (fixtures test_*) quedan fuera de la conformación real. `cargo_nombre` es
// el del actor (para el CIET); en auto-cierre (E7) lo pasa SISTEMA.
export async function cerrarTurno(pool, turno_id, {
  motivo, cerrado_por, cargo_nombre = null, ahora = new Date(), incluirSinteticos = false,
} = {}) {
  if (!MOTIVOS_CIERRE.includes(motivo)) {
    throw new Error(`cerrarTurno: motivo inválido '${motivo}' (esperado ${MOTIVOS_CIERRE.join('|')})`);
  }
  if (!cerrado_por) throw new Error('cerrarTurno: cerrado_por es requerido');

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // 1) Sellar la cabecera (idempotente: 0 filas → ya cerrado).
    const upd = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('motivo', sql.VarChar(20), motivo)
      .input('cerrado_por', sql.Int, cerrado_por)
      .input('ahora', sql.DateTime2, ahora)
      .query(`
        UPDATE bitacora.turno_unidad
        SET estado = 'CERRADO', fin_real = @ahora, motivo_cierre = @motivo,
            cerrado_por = @cerrado_por, cerrado_en = @ahora
        OUTPUT INSERTED.turno_unidad_id, INSERTED.planta_id, INSERTED.fecha_operativa, INSERTED.turno,
               INSERTED.inicio_nominal
        WHERE turno_unidad_id = @id AND estado <> 'CERRADO'
      `);
    if (!upd.recordset[0]) {
      await tx.commit();
      return { cerrado: null, sucesor: null, archivados: [], conformados: 0 };
    }
    const { planta_id, fecha_operativa, turno, inicio_nominal } = upd.recordset[0];

    // 2) Cerrar el lapso de presencia de los participantes AÚN activos en este turno (para que
    //    duracion_min/fin_sesion queden completos al congelar). Espejo de acumularPresenciaSesiones,
    //    acotado al turno.
    await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('ahora', sql.DateTime2, ahora)
      .query(`
        UPDATE tp
          SET presencia_acumulada_min = tp.presencia_acumulada_min + DATEDIFF(MINUTE, sa.inicio_sesion, @ahora),
              ultimo_egreso = @ahora
        FROM bitacora.turno_participante tp
        INNER JOIN bitacora.sesion_activa sa ON sa.turno_id = tp.turno_id AND sa.usuario_id = tp.usuario_id
        WHERE tp.turno_id = @id AND sa.activa = 1 AND sa.turno_id = @id;
      `);

    // 3) Congelar conformación desde turno_participante (inmutable, idempotente por la PK natural).
    //    Mapea primer_ingreso→inicio_sesion, COALESCE(ultimo_egreso, ahora)→fin_sesion,
    //    presencia_acumulada_min→duracion_min. Excluye sintéticos salvo en unit tests (D-044).
    //    D-059: excluye también a los cargos observadores (defensa en profundidad: por construcción
    //    no tienen fila en turno_participante — sesion-contexto no los marca — pero si una fila
    //    llegara a existir, NO se congela; sin escape hatch, la invisibilidad no tiene excepción).
    const conf = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('fecha_op', sql.Date, fecha_operativa)
      .input('planta', sql.VarChar(10), planta_id)
      .input('turno', sql.TinyInt, turno)
      .input('ahora', sql.DateTime2, ahora)
      .input('incluir_sinteticos', sql.Bit, incluirSinteticos ? 1 : 0)
      .query(`
        INSERT INTO bitacora.conformacion_turno
          (fecha_operativa, planta_id, turno, usuario_id, usuario_nombre, cargo_id, cargo_nombre,
           inicio_sesion, fin_sesion, duracion_min, fin_inferido, turno_id)
        SELECT @fecha_op, @planta, @turno, tp.usuario_id, tp.usuario_nombre, tp.cargo_id, tp.cargo_nombre,
               tp.primer_ingreso, COALESCE(tp.ultimo_egreso, @ahora), tp.presencia_acumulada_min, 0, @id
        FROM bitacora.turno_participante tp
        INNER JOIN lov_bit.usuario u ON u.usuario_id = tp.usuario_id
        INNER JOIN lov_bit.cargo   cg ON cg.cargo_id = tp.cargo_id
        WHERE tp.turno_id = @id
          AND (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
          AND cg.es_observador = 0
          AND NOT EXISTS (
            SELECT 1 FROM bitacora.conformacion_turno ct
            WHERE ct.fecha_operativa = @fecha_op AND ct.planta_id = @planta
              AND ct.turno = @turno AND ct.usuario_id = tp.usuario_id
          );
      `);
    const conformados = conf.rowsAffected[0] || 0;

    // 4) Archivar los registros del turno a registro_historico, preservando registro_id + turno_id.
    //    Criterio combinado: (a) registros ESTAMPADOS con este turno (turno_id = @id) — el camino normal;
    //    (b) BORRADORES HUÉRFANOS (turno_id NULL) de la unidad cuya fecha_evento cae en la ventana de este
    //    turno [inicio_nominal, ahora]. (b) rescata legacy pre-write-gate: un borrador creado cuando la
    //    unidad NO tenía turno abierto se insertaba con turno_id=NULL y, archivando SÓLO por turno_id,
    //    quedaba huérfano para siempre (nunca pasaba al histórico). El write-gate ya evita crear nuevos
    //    NULL, pero esto garantiza que un cierre no deje NINGÚN borrador visible atrás. MAND/DISP quedan
    //    fuera (codigo NOT IN + oculta) — incluido CIET, que es oculta=1. Los huérfanos se atribuyen a
    //    este turno (COALESCE(turno_id, @id)) en el histórico. Se capturan los conteos por bitácora.
    const archivadosRes = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('planta', sql.VarChar(10), planta_id)
      .input('ini', sql.DateTime2, inicio_nominal)
      .input('ahora', sql.DateTime2, ahora)
      .query(`
        SELECT ra.bitacora_id, b.nombre, COUNT(*) AS n
        FROM bitacora.registro_activo ra
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
        WHERE ra.estado = 'borrador'
          AND b.oculta = 0 AND b.codigo NOT IN ('DISP','MAND')
          AND (ra.turno_id = @id
               OR (ra.turno_id IS NULL AND ra.planta_id = @planta
                   AND ra.fecha_evento >= @ini AND ra.fecha_evento <= @ahora))
        GROUP BY ra.bitacora_id, b.nombre;
      `);
    const archivados = archivadosRes.recordset.map((r) => ({
      bitacora_id: r.bitacora_id, nombre: r.nombre, registros_cerrados: r.n,
    }));

    await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('planta', sql.VarChar(10), planta_id)
      .input('ini', sql.DateTime2, inicio_nominal)
      .input('cerrado_por', sql.Int, cerrado_por)
      .input('ahora', sql.DateTime2, ahora)
      .query(`
        INSERT INTO bitacora.registro_historico
          (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
           modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo, turno_id)
        SELECT ra.registro_id, ra.bitacora_id, ra.planta_id, ra.fecha_evento, ra.turno, ra.detalle,
               ra.campos_extra, ra.tipo_evento_id, 'cerrado', ra.ingenieros_snapshot, ra.jdts_snapshot,
               ra.jefes_snapshot, ra.creado_por, ra.creado_en, ra.modificado_por, ra.modificado_en,
               @cerrado_por, @ahora, CAST(DATEADD(HOUR, -5, @ahora) AS DATE), COALESCE(ra.turno_id, @id)
        FROM bitacora.registro_activo ra
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
        WHERE ra.estado = 'borrador'
          AND b.oculta = 0 AND b.codigo NOT IN ('DISP','MAND')
          AND (ra.turno_id = @id
               OR (ra.turno_id IS NULL AND ra.planta_id = @planta
                   AND ra.fecha_evento >= @ini AND ra.fecha_evento <= @ahora));

        DELETE ra
        FROM bitacora.registro_activo ra
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
        WHERE ra.estado = 'borrador'
          AND b.oculta = 0 AND b.codigo NOT IN ('DISP','MAND')
          AND (ra.turno_id = @id
               OR (ra.turno_id IS NULL AND ra.planta_id = @planta
                   AND ra.fecha_evento >= @ini AND ra.fecha_evento <= @ahora));
      `);

    // 5) CIET 'Cierre de turno' con el motivo. La sesión del CIET se arma desde la cabecera + el actor.
    await registrarEventoCierre(tx, {
      tipo: 'cierre',
      sesion: { usuario_id: cerrado_por, planta_id, turno, cargo_nombre },
      forzado: motivo !== 'MANUAL',
      motivo,
    });

    // 6) Activar el sucesor PROGRAMADO (el cierre liberó el ABIERTO de la unidad).
    const sucesor = await activarSucesorTx(tx, planta_id, ahora);
    const cerrado = await _leerTurno(() => new sql.Request(tx), turno_id);
    await tx.commit();
    return { cerrado, sucesor, archivados, conformados };
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// D-045 (reabrir) — el turno CERRADO de la VENTANA VIGENTE de la unidad (el único reabrible: su
// ventana aún contiene `ahora`). Devuelve la fila o null si el turno de la ventana no está CERRADO
// (no existe, sigue ABIERTO o ya rotó a la ventana siguiente).
export async function resolverTurnoReabrible(pool, planta_id, { ahora = new Date() } = {}) {
  const { inicio } = ventanaActual(ahora);
  const r = await pool.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('t', sql.TinyInt, getTurnoColombia())
    .input('f', sql.Date, fechaBogotaStr(inicio))
    .query(`
      SELECT TOP 1 *
      FROM bitacora.turno_unidad
      WHERE planta_id = @p AND turno = @t AND fecha_operativa = @f AND estado = 'CERRADO'
    `);
  return r.recordset[0] ?? null;
}

// D-045 (reabrir) — DES-CIERRE de un turno CERRADO de la ventana vigente: revierte el cierre para que
// la unidad vuelva a operar SIN crear un turno nuevo (el UNIQUE natural (fecha,planta,turno) lo impide).
// Espejo inverso de cerrarTurno, atómico:
//   1) valida: estado CERRADO, sin otro ABIERTO en la unidad, y la ventana aún contiene `ahora`.
//   2) des-archiva los registros del turno (registro_historico → registro_activo, estado 'borrador',
//      preservando registro_id vía IDENTITY_INSERT).
//   3) borra la conformación congelada del turno (un cierre posterior la recongela fresca).
//   4) reabre la cabecera (ABIERTO, limpia fin_real/motivo/cerrado_*, fin_nominal ← fin de la ventana,
//      extendido=0; veces_extendido se conserva como historial).
//   5) CIET 'reapertura'.
// Devuelve { reabierto, desarchivados } o { reabierto:null, motivo } si no aplica (el endpoint lo mapea
// a 409 con `codigo` estable). NUNCA reabre si hay otro ABIERTO (el sucesor ya arrancó → reabrir no aplica).
export async function reabrirTurno(pool, turno_id, { por_usuario, cargo_nombre = null, ahora = new Date() } = {}) {
  if (!por_usuario) throw new Error('reabrirTurno: por_usuario es requerido');
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const cur = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .query(`SELECT * FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK) WHERE turno_unidad_id = @id`);
    const row = cur.recordset[0];
    if (!row) { await tx.commit(); return { reabierto: null, motivo: 'no_existe' }; }
    if (row.estado !== 'CERRADO') { await tx.commit(); return { reabierto: null, motivo: 'no_cerrado' }; }

    // No puede haber otro ABIERTO en la unidad (el índice único lo bloquearía; error claro antes de fallar).
    const abierto = await new sql.Request(tx)
      .input('p', sql.VarChar(10), row.planta_id)
      .query(`SELECT TOP 1 turno_unidad_id FROM bitacora.turno_unidad WITH (UPDLOCK, HOLDLOCK) WHERE planta_id = @p AND estado = 'ABIERTO'`);
    if (abierto.recordset[0]) { await tx.commit(); return { reabierto: null, motivo: 'ya_abierto' }; }

    // La ventana del turno debe seguir conteniendo `ahora` (no reabrir un turno de una ventana pasada).
    const { inicio, fin } = ventanaTurno(row.turno, fechaRefBogotaMediodia(row.fecha_operativa));
    if (!(ahora >= inicio && ahora < fin)) { await tx.commit(); return { reabierto: null, motivo: 'ventana_vencida' }; }

    // 2) Des-archivar los registros del turno (preserva registro_id → IDENTITY_INSERT).
    const des = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .query(`
        SET IDENTITY_INSERT bitacora.registro_activo ON;
        INSERT INTO bitacora.registro_activo
          (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
           modificado_por, modificado_en, turno_id)
        SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               'borrador', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
               modificado_por, modificado_en, turno_id
        FROM bitacora.registro_historico
        WHERE turno_id = @id AND estado = 'cerrado';
        SET IDENTITY_INSERT bitacora.registro_activo OFF;

        DELETE FROM bitacora.registro_historico WHERE turno_id = @id AND estado = 'cerrado';
      `);
    const desarchivados = des.rowsAffected?.[0] ?? 0;

    // 3) Borrar la conformación congelada del turno (se recongela fresca en un cierre posterior).
    await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .query(`DELETE FROM bitacora.conformacion_turno WHERE turno_id = @id`);

    // 4) Reabrir la cabecera.
    await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('fin', sql.DateTime2, fin)
      .query(`
        UPDATE bitacora.turno_unidad
        SET estado = 'ABIERTO', fin_real = NULL, motivo_cierre = NULL, cerrado_por = NULL,
            cerrado_en = NULL, fin_nominal = @fin, extendido = 0
        WHERE turno_unidad_id = @id
      `);

    // 4b) Reabrir = unidad operativa para TODOS: limpiar la finalización individual (D-040) que el
    //     cierre haya forzado (o que un usuario haya marcado), para que nadie quede bloqueado tras reabrir.
    await new sql.Request(tx)
      .input('p', sql.VarChar(10), row.planta_id)
      .query(`
        UPDATE bitacora.sesion_activa SET turno_finalizado_en = NULL
        WHERE planta_id = @p AND activa = 1 AND turno_finalizado_en IS NOT NULL
      `);

    // 5) CIET 'reapertura' (atribuido al actor).
    await registrarEventoCierre(tx, {
      tipo: 'reapertura',
      sesion: { usuario_id: por_usuario, planta_id: row.planta_id, turno: row.turno, cargo_nombre },
      motivo: 'reapertura-manual',
    });

    const reabierto = await _leerTurno(() => new sql.Request(tx), turno_id);
    await tx.commit();
    return { reabierto, desarchivados };
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// D-045 E4 — PARTICIPACIÓN VIVA.
// UPSERT del participante de un turno: entrar a la unidad marca participación aunque el usuario no
// registre nada ni esté al cierre. Idempotente (MERGE + HOLDLOCK, serializa pestañas/re-login). NUNCA
// pisa primer_ingreso en el re-ingreso — solo refresca el cargo (por si cambió el App Role). El
// usuario_nombre se desnormaliza desde lov_bit.usuario al insertar. Devuelve la fila. No-op si turno_id
// es null (borde de ventana sin turno resuelto → participación no marcada, login sigue).
export async function marcarParticipante(pool, { turno_id, usuario_id, cargo_id, cargo_nombre }) {
  if (!turno_id) return null;
  await pool.request()
    .input('turno_id', sql.Int, turno_id)
    .input('usuario_id', sql.Int, usuario_id)
    .input('cargo_id', sql.Int, cargo_id)
    .input('cargo_nombre', sql.VarChar(100), cargo_nombre)
    .query(`
      MERGE bitacora.turno_participante WITH (HOLDLOCK) AS t
      USING (SELECT @turno_id AS turno_id, @usuario_id AS usuario_id) AS s
        ON t.turno_id = s.turno_id AND t.usuario_id = s.usuario_id
      WHEN MATCHED THEN
        UPDATE SET cargo_id = @cargo_id, cargo_nombre = @cargo_nombre
      WHEN NOT MATCHED THEN
        INSERT (turno_id, usuario_id, cargo_id, usuario_nombre, cargo_nombre, primer_ingreso)
        VALUES (@turno_id, @usuario_id, @cargo_id,
                (SELECT nombre_completo FROM lov_bit.usuario WHERE usuario_id = @usuario_id),
                @cargo_nombre, SYSUTCDATETIME());
    `);
  const r = await pool.request()
    .input('turno_id', sql.Int, turno_id)
    .input('usuario_id', sql.Int, usuario_id)
    .query(`SELECT * FROM bitacora.turno_participante WHERE turno_id = @turno_id AND usuario_id = @usuario_id`);
  return r.recordset[0] ?? null;
}

// D-045 E4 — acumula la presencia del lapso activo `[sesion_activa.inicio_sesion, ahora)` en el
// turno_participante correspondiente (por turno_id vigente de la sesión) y marca ultimo_egreso.
// DEBE llamarse ANTES de poner activa=0 (necesita inicio_sesion y turno_id de la sesión aún activa).
// El modelo de presencia usa inicio_sesion como "último ingreso": select-context lo refresca en cada
// (re)ingreso, así que cada lapso [ingreso, egreso) se suma en su egreso sin doble conteo. Filtra
// activa=1 → una sesión ya inactiva (lapso ya sumado en su expulsión) se ignora (idempotente).
export async function acumularPresenciaSesiones(pool, sesionIds) {
  if (!sesionIds || sesionIds.length === 0) return;
  const req = pool.request();
  const ph = sesionIds.map((id, i) => { req.input('sid' + i, sql.Int, id); return '@sid' + i; }).join(',');
  await req.query(`
    UPDATE tp
      SET presencia_acumulada_min = tp.presencia_acumulada_min
            + DATEDIFF(MINUTE, sa.inicio_sesion, SYSUTCDATETIME()),
          ultimo_egreso = SYSUTCDATETIME()
    FROM bitacora.turno_participante tp
    INNER JOIN bitacora.sesion_activa sa
      ON sa.turno_id = tp.turno_id AND sa.usuario_id = tp.usuario_id
    WHERE sa.activa = 1 AND sa.turno_id IS NOT NULL AND sa.sesion_id IN (${ph});
  `);
}

// D-045 E7 — EXTIENDE un turno ABIERTO: `extendido=1`, `veces_extendido+1`, `fin_nominal=próximo
// umbral`, en UNA transacción que además emite el CIET 'Extensión de turno' si viene `por_usuario`
// (la extensión es siempre manual/gateada, así que producción siempre lo pasa; los unit tests que
// solo verifican el movimiento del umbral lo omiten y no se emite CIET). Devuelve la fila actualizada
// o null si el turno no estaba ABIERTO. `detalle` opcional va como `motivo` del CIET.
export async function extenderTurno(pool, turno_id, opts = {}) {
  const { ahora = new Date(), por_usuario = null, cargo_nombre = null, detalle = null } = opts;
  const nuevoFin = proximoUmbral(ahora);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const r = await new sql.Request(tx)
      .input('id', sql.Int, turno_id)
      .input('fin', sql.DateTime2, nuevoFin)
      .query(`
        UPDATE bitacora.turno_unidad
        SET extendido = 1, veces_extendido = veces_extendido + 1, fin_nominal = @fin
        OUTPUT INSERTED.turno_unidad_id, INSERTED.planta_id, INSERTED.turno
        WHERE turno_unidad_id = @id AND estado = 'ABIERTO'
      `);
    if (!r.recordset[0]) {
      await tx.commit();
      return null;
    }
    const { planta_id, turno } = r.recordset[0];
    if (por_usuario) {
      await registrarEventoCierre(tx, {
        tipo: 'extension',
        sesion: { usuario_id: por_usuario, planta_id, turno, cargo_nombre },
        forzado: false,
        motivo: detalle || null,
      });
    }
    const row = await _leerTurno(() => new sql.Request(tx), turno_id);
    await tx.commit();
    return row;
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}

// D-045 E7 — ESTADO del turno vigente de una unidad, para `GET /api/turno/actual` y `/api/me`. Toma la
// fila ABIERTO (máx 1 por índice único) y deriva `bloqueo` con la lógica pura `estadoBloqueo`. Sin la
// fila ABIERTO devuelve un estado "vacío" (nadie operando aún). `puede_decidir` lo agrega el caller
// (depende del cargo de la sesión, no de la cabecera).
export async function estadoTurnoActual(pool, planta_id, { ahora = new Date() } = {}) {
  const row = await resolverTurnoAbierto(pool, planta_id);
  if (!row) {
    return { estado: null, turno: null, fecha_operativa: null, fin_nominal: null, extendido: false, veces_extendido: 0, bloqueo: false };
  }
  return {
    turno_unidad_id: row.turno_unidad_id,
    estado: row.estado,
    turno: row.turno,
    fecha_operativa: row.fecha_operativa,
    fin_nominal: row.fin_nominal,
    extendido: !!row.extendido,
    veces_extendido: row.veces_extendido,
    bloqueo: estadoBloqueo(row, ahora),
  };
}

// D-045 E7 — TRANSICIONES del sweeper (flujo 6-a-6). Recorre los turnos ABIERTO de las `plantas` dadas
// que ya pasaron su `fin_nominal` (`estadoBloqueo`) y decide, por unidad:
//   - sin personal (0 `sesion_activa activa=1`) → cierre inmediato AUTO_SIN_PERSONAL.
//   - con personal y `minutosDesdeUmbral >= GRACIA_CIERRE_MIN` → cierre AUTO_SIN_RESPUESTA.
//   - con personal dentro de la gracia → NO cierra: reporta `accion:'bloqueo'` (el caller avisa por WS).
// Cierra con `cerrado_por=SISTEMA` (acto atómico `cerrarTurno` → sella+congela+archiva+CIET+sucesor).
// NO transmite por WS (evita ciclo de imports): devuelve el resumen y el sweeper hace el broadcast.
// `plantas` por defecto = las unidades con cabecera; los tests pasan `[TEST_PLANTA]` para no tocar prod.
// Error boundary por unidad: un fallo en una no impide las demás. Idempotente (cerrar un CERRADO no-op).
export async function transicionarTurnosVencidos(pool, { ahora = new Date(), plantas } = {}) {
  if (!USUARIO_SISTEMA_ID) {
    throw new Error('transicionarTurnosVencidos: USUARIO_SISTEMA_ID no inicializado (initDB no corrió)');
  }
  const filtroPlantas = Array.isArray(plantas) && plantas.length > 0;
  const req = pool.request();
  let where = `estado = 'ABIERTO'`;
  if (filtroPlantas) {
    where += ' AND planta_id IN (' + plantas.map((p, i) => { req.input('p' + i, sql.VarChar(10), p); return '@p' + i; }).join(',') + ')';
  }
  const abiertos = (await req.query(`SELECT * FROM bitacora.turno_unidad WHERE ${where}`)).recordset;

  const transiciones = [];
  for (const row of abiertos) {
    if (!estadoBloqueo(row, ahora)) continue; // aún dentro de su ventana (o extendido) → nada
    try {
      // D-059: un observador conectado NO cuenta como personal — sin este filtro, su sola
      // presencia impediría el AUTO_SIN_PERSONAL de una unidad realmente vacía (la haría esperar
      // la gracia completa como si hubiera operadores).
      const hay = await pool.request()
        .input('p', sql.VarChar(10), row.planta_id)
        .query(`
          SELECT TOP 1 1 AS x FROM bitacora.sesion_activa sa
          INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
          WHERE sa.planta_id = @p AND sa.activa = 1 AND c.es_observador = 0
        `);
      const hayPersonal = !!hay.recordset[0];
      const minutosDesdeUmbral = Math.floor((ahora.getTime() - new Date(row.fin_nominal).getTime()) / 60000);
      const motivo = motivoAutoCierre({ hayPersonal, minutosDesdeUmbral });
      if (!motivo) {
        transiciones.push({ planta_id: row.planta_id, turno_unidad_id: row.turno_unidad_id, accion: 'bloqueo' });
        continue;
      }
      const res = await cerrarTurno(pool, row.turno_unidad_id, {
        motivo, cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA', ahora,
      });
      transiciones.push({
        planta_id: row.planta_id, turno_unidad_id: row.turno_unidad_id, accion: 'cerrado', motivo,
        sucesor_id: res.sucesor?.turno_unidad_id ?? null,
      });
    } catch (err) {
      console.error(`[turno-transicion] error en ${row.planta_id} #${row.turno_unidad_id}:`, err.message);
    }
  }
  return transiciones;
}
