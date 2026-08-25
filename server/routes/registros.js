// Router de registros (E10, AUD-34/35). El corazón operativo: listar borradores + crear/editar/borrar
// registros de cualquier bitácora, con la rama especial DISP (D-026, storage en disponibilidad_estado)
// dentro de POST y PUT. Montado bajo /api/registros tras requireEntra; todas exigen sesión de app.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora, plantaMatch, canEditarRegistro, esAsientoReflejado } from '../middleware/permissions.js';
import { validateCamposExtra, computeCamposAuto } from '../utils/campos.js';
import { periodoFromFechaBogota, turnoFromPeriodo, fechaBogotaStr } from '../utils/turno.js';
import { resolverTurnoParaEscritura } from '../utils/turno-entidad.js';
import {
  findEventoDashboard, upsertEventoDashboard, hasNotificarDashboard,
  findVigente, findUltimoCerrado, insertNuevoEstado, cerrarVigente, actualizarVigente,
  DISP_ANIO_MIN,
} from '../utils/notificador.js';

// D-051: piso de fecha para DISP — el guard de futuro ya existe; sin este, un año typo (0026
// tecleado en el datetime-local) entra por el 1er registro de una planta vacía o por el PUT del
// vigente sin N-1, e infla el rango del selector de años en cada respuesta del dashboard.
// Año Bogotá = UTC-5 fijo (D-020).
const fechaDispBajoPiso = (fecha) =>
  new Date(fecha.getTime() - 5 * 3600_000).getUTCFullYear() < DISP_ANIO_MIN;
import {
  snapshotJDTs, snapshotJefes, snapshotIngenieros, snapshotGerentesProduccion,
} from '../utils/snapshots.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { notifyDashboard } from '../utils/notify-dashboard.js';
import { asyncH, loadAppSession, bloquearSiTurnoFinalizado, respTurnoCerrado, respTurnoEnTransicion } from './_middleware.js';
import { getDispBitacoraId } from './_shared.js';

// ── Helpers DISP (movidos de server.js — solo los usan las ramas DISP de POST/PUT) ──────────────
// F12/D-024: catálogo cerrado de estados DISP. Indisponible y Mantenimiento comparten codigo=-1 a
// propósito (métrica agregable de indisponibilidad); el string `evento` es el discriminador semántico.
const DISP_EVENTOS_VALIDOS = ['En Servicio', 'En Reserva', 'Indisponible', 'Mantenimiento'];
const DISP_CODIGO_POR_EVENTO = { 'En Servicio': 1, 'En Reserva': 0, Indisponible: -1, Mantenimiento: -1 };

function parseExtra(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// D-026: traduce una fila de `bitacora.disponibilidad_estado` al shape legacy que el frontend consume.
function mapDispRowToLegacyShape(row, bitacoraId) {
  const fechaInicio = row.fecha_inicio_estado instanceof Date
    ? row.fecha_inicio_estado
    : new Date(row.fecha_inicio_estado);
  return {
    registro_id: row.disponibilidad_id,
    bitacora_id: bitacoraId,
    planta_id: row.planta_id,
    fecha_evento: row.fecha_inicio_estado,
    turno: null,
    detalle: row.detalle,
    campos_extra: JSON.stringify({
      evento: row.estado,
      codigo: row.codigo,
      fecha_inicio_estado: fechaInicio.toISOString(),
    }),
    tipo_evento_id: null,
    estado: 'borrador',
    ingenieros_snapshot: row.ingenieros_snapshot,
    jdts_snapshot: row.jdts_snapshot,
    jefes_snapshot: row.jefes_planta_snapshot,
    creado_por: row.creado_por,
    creado_en: row.creado_en,
    modificado_por: row.modificado_por,
    modificado_en: row.modificado_en,
    fecha_fin_estado: row.fecha_fin_estado,
  };
}

const router = express.Router();
router.use(loadAppSession);

// GET /api/registros/activos?planta_id=&bitacora_id=&estado=
router.get('/activos', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  const bitacora_id = req.query.bitacora_id;
  const estado = req.query.estado;
  const db = await getDB();
  const reqQ = db.request();
  // F10: defensa-en-profundidad — los registros de bitácoras ocultas (CIET) no llegan al frontend.
  let where = ['b.oculta = 0'];
  if (planta_id) { reqQ.input('planta_id', sql.VarChar(10), planta_id); where.push('r.planta_id = @planta_id'); }
  if (bitacora_id) { reqQ.input('bitacora_id', sql.Int, parseInt(bitacora_id, 10)); where.push('r.bitacora_id = @bitacora_id'); }
  if (estado) { reqQ.input('estado', sql.VarChar(20), estado); where.push('r.estado = @estado'); }
  // D-049: `puede_editar` es el espejo por fila de canEditarRegistro (autor + misma planta +
  // puede_crear vigente del cargo de la sesión) para que la grilla pinte lápiz/basurero desde la
  // verdad del servidor. Es SOLO affordance de UI: el enforcement real sigue en PUT/DELETE.
  // D-058 (RQ-02.5/6): se le suma la cuarta condición del helper — un asiento REFLEJADO desde
  // Operación 24h no se edita en su destino. El helper y este espejo se cambian JUNTOS: es lo único
  // que impide que la grilla ofrezca un lápiz que el backend va a rechazar.
  // `origen_bitacora_nombre` sale del catálogo por `codigo` (D-052: el nombre visible vive SOLO en el
  // seed, nunca hardcodeado en el front) — es lo que el chip de la fila muestra como origen.
  reqQ.input('ses_usuario', sql.Int, sesion.usuario_id);
  reqQ.input('ses_planta', sql.VarChar(10), sesion.planta_id);
  reqQ.input('ses_cargo', sql.Int, sesion.cargo_id);
  const result = await reqQ.query(`
    SELECT r.*,
           b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
           te.nombre AS tipo_evento_nombre,
           autor.nombre_completo AS creado_por_nombre,
           r.creado_por AS creado_por_id,
           borigen.nombre AS origen_bitacora_nombre,
           CAST(CASE WHEN r.creado_por = @ses_usuario
                      AND r.planta_id = @ses_planta
                      AND COALESCE(perm.puede_crear, 0) = 1
                      AND JSON_VALUE(r.campos_extra, '$.origen_lote_id') IS NULL
                 THEN 1 ELSE 0 END AS BIT) AS puede_editar
    FROM bitacora.registro_activo r
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = r.creado_por
    LEFT JOIN lov_bit.bitacora borigen
      ON borigen.codigo = JSON_VALUE(r.campos_extra, '$.origen_bitacora')
    LEFT JOIN lov_bit.cargo_bitacora_permiso perm
      ON perm.cargo_id = @ses_cargo AND perm.bitacora_id = r.bitacora_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.fecha_evento ASC
  `);
  return sendJSON(res, 200, { registros: result.recordset });
}));

// POST /api/registros — crea un registro (rama DISP especial + rama genérica).
router.post('/', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const body = req.body || {};
  const { bitacora_id, planta_id, fecha_evento, turno: turnoBody, detalle, campos_extra, tipo_evento_id } = body;
  if (!bitacora_id || !planta_id) {
    return sendJSON(res, 400, { error: 'Campos requeridos faltantes (bitacora_id, planta_id)' });
  }
  const db = await getDB();

  // F12: peek temprano a la bitácora — la rama DISP tiene su propio flujo transaccional.
  const codigoPeek = await db.request()
    .input('bid', sql.Int, bitacora_id)
    .query(`SELECT codigo FROM lov_bit.bitacora WHERE bitacora_id = @bid`);
  const bitacoraCodigo = codigoPeek.recordset[0]?.codigo;
  if (!bitacoraCodigo) {
    return sendJSON(res, 400, { error: 'bitácora no encontrada' });
  }

  if (bitacoraCodigo === 'DISP') {
    // D-026: DISP → `bitacora.disponibilidad_estado`. Mismo shape request/response.
    if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
      return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
    }
    // DISP es cross-planta a propósito: quien tiene puede_crear en Disponibilidad puede cambiar
    // el estado de CUALQUIER planta, sin importar la unidad de su sesión (revierte el guard
    // plantaMatch de AUD-11 solo para DISP; el permiso por cargo sigue vigente).
    const plantaCheck = await db.request()
      .input('p', sql.VarChar(10), planta_id)
      .query(`SELECT 1 AS ok FROM lov_bit.planta WHERE planta_id=@p AND activa=1`);
    if (!plantaCheck.recordset[0]) {
      return sendJSON(res, 400, { error: 'planta_id no es operativa' });
    }

    const extra = parseExtra(campos_extra);
    if (extra === null) {
      return sendJSON(res, 400, { error: 'campos_extra inválido (no es JSON)' });
    }
    const evento = extra?.evento;
    const fechaInicioRaw = extra?.fecha_inicio_estado ?? fecha_evento;
    if (!DISP_EVENTOS_VALIDOS.includes(evento)) {
      return sendJSON(res, 400, {
        error: `evento debe ser uno de: ${DISP_EVENTOS_VALIDOS.join(', ')}`,
      });
    }
    if (!fechaInicioRaw) {
      return sendJSON(res, 400, { error: 'fecha_inicio_estado es requerido' });
    }
    const fechaInicio = new Date(fechaInicioRaw);
    if (Number.isNaN(fechaInicio.getTime())) {
      return sendJSON(res, 400, { error: 'fecha_inicio_estado inválido' });
    }
    if (fechaInicio.getTime() > Date.now()) {
      return sendJSON(res, 422, { error: 'fecha_inicio_estado no puede ser futuro' });
    }
    if (fechaDispBajoPiso(fechaInicio)) {
      return sendJSON(res, 422, { error: `fecha_inicio_estado no puede ser anterior al año ${DISP_ANIO_MIN}` });
    }
    const codigoVal = DISP_CODIGO_POR_EVENTO[evento];

    const transaction = new sql.Transaction(db);
    await transaction.begin();
    try {
      // UPDLOCK+HOLDLOCK (dentro de findVigente) serializa POSTs concurrentes a la misma planta.
      const vigente = await findVigente(transaction, { planta_id });
      let vigenteAnteriorMovidoId = null;

      if (vigente) {
        const vigFechaInicio = vigente.fecha_inicio_estado instanceof Date
          ? vigente.fecha_inicio_estado
          : new Date(vigente.fecha_inicio_estado);

        if (evento === vigente.estado) {
          await transaction.rollback();
          return sendJSON(res, 409, {
            error: 'mismo_estado',
            mensaje: `${planta_id} ya está en estado ${vigente.estado}`,
            vigente: {
              registro_id: vigente.disponibilidad_id,
              evento: vigente.estado,
              fecha_inicio_estado: vigFechaInicio.toISOString(),
            },
          });
        }
        if (fechaInicio.getTime() <= vigFechaInicio.getTime()) {
          await transaction.rollback();
          return sendJSON(res, 409, {
            error: 'fecha_anterior_a_vigente',
            mensaje: `La fecha es anterior o igual al inicio del estado vigente`,
            vigente: {
              registro_id: vigente.disponibilidad_id,
              evento: vigente.estado,
              fecha_inicio_estado: vigFechaInicio.toISOString(),
            },
          });
        }

        await cerrarVigente(transaction, {
          disponibilidad_id: vigente.disponibilidad_id,
          fecha_fin: fechaInicio,
        });
        vigenteAnteriorMovidoId = vigente.disponibilidad_id;
      }

      const reqFactory = () => new sql.Request(transaction);
      const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
      const jefes_planta_snapshot = await snapshotJefes(reqFactory);
      const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
      const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });

      const row = await insertNuevoEstado(transaction, {
        planta_id,
        estado: evento,
        codigo: codigoVal,
        fecha_inicio_estado: fechaInicio,
        detalle: detalle ?? null,
        jdts_snapshot,
        jefes_planta_snapshot,
        gerentes_produccion_snapshot,
        ingenieros_snapshot,
        creado_por: sesion.usuario_id,
      });

      await transaction.commit();
      broadcastConteoBitacoras(planta_id).catch(() => {});

      const registro = mapDispRowToLegacyShape(row, bitacora_id);
      return sendJSON(res, 201, { registro, vigente_anterior_movido_id: vigenteAnteriorMovidoId });
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      throw err;
    }
  }

  // Resto: rama genérica (no-DISP)
  // D-040: write-gate SOLO acá (genéricas). DISP salió arriba con su propio return; MAND/COMB tienen
  // sus propios endpoints (sala-de-mando / combustibles), sin gate. Turno finalizado → 409.
  if (bloquearSiTurnoFinalizado(req, res)) return;
  if (!fecha_evento || !tipo_evento_id) {
    return sendJSON(res, 400, { error: 'Campos requeridos faltantes (fecha_evento, tipo_evento_id)' });
  }
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede crear registros en otra planta' });
  }
  if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
  }
  const creado_por = sesion.usuario_id;

  // F6: lookup expandido — código de bitácora, nombre del tipo y notificar_dashboard_tipo.
  // D-058 (F34.A1): `seleccionable = 1` obligatorio. Los tipos ESPEJO del reflejo de Operación 24h
  // solo los escribe reflejo-sala.js por SQL directo; a mano no se teclean. Esconderlos del selector
  // (GET /tipos-evento) no basta — un cliente que ya conoce el id los postearía igual, y el asiento
  // resultante no reflejaría ningún lote (D-046: lo que solo bloquea el front es evadible).
  const teCheck = await db.request()
    .input('te', sql.Int, tipo_evento_id)
    .input('b', sql.Int, bitacora_id)
    .query(`
      SELECT te.tipo_evento_id, te.nombre AS tipo_evento_nombre,
             te.notificar_dashboard_tipo,
             bb.codigo AS bitacora_codigo
      FROM lov_bit.tipo_evento te
      INNER JOIN lov_bit.bitacora bb ON bb.bitacora_id = te.bitacora_id
      WHERE te.tipo_evento_id = @te AND te.bitacora_id = @b AND te.seleccionable = 1
    `);
  if (teCheck.recordset.length === 0) {
    return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
  }
  const teRow = teCheck.recordset[0];
  const isMAND = teRow.bitacora_codigo === 'MAND';

  // F6/R3: check de fecha futura. MAND acepta cualquier hora del día; el resto no puede caer en un
  // día posterior a hoy (Bogotá) — slug estable `fecha_futura`, paridad con COMB. Se conserva además
  // el guard de 5 min como defensa intra-día (reloj adelantado / hora futura dentro de hoy).
  if (!isMAND) {
    if (fechaBogotaStr(new Date(fecha_evento)) > fechaBogotaStr(new Date())) {
      return sendJSON(res, 400, { error: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
    }
    if (new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
      return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
    }
  }

  const bitRes = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`SELECT codigo, definicion_campos FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id`);
  const bit = bitRes.recordset[0];
  if (!bit) return sendJSON(res, 400, { error: 'bitácora no encontrada' });

  const validation = validateCamposExtra(bit.definicion_campos, campos_extra);
  if (!validation.ok) {
    return sendJSON(res, 400, { error: 'campos_extra inválido', detalles: validation.errors });
  }
  const camposFinal = validation.definicion ? computeCamposAuto(validation.definicion, validation.data) : validation.data;
  // F6: solo AUTH legacy auto-rellena periodo desde fecha. MAND trae periodo del usuario.
  if (camposFinal && hasNotificarDashboard(bit.definicion_campos) && !isMAND && camposFinal.periodo == null) {
    camposFinal.periodo = periodoFromFechaBogota(fecha_evento);
  }
  const camposStr = camposFinal ? JSON.stringify(camposFinal) : null;

  // F6: turno se autoselecciona desde periodo en MAND; para no-MAND viene del body.
  let turno = turnoBody;
  if (isMAND) {
    const periodo = camposFinal?.periodo;
    if (!periodo) return sendJSON(res, 400, { error: 'periodo es requerido para MAND' });
    turno = turnoFromPeriodo(parseInt(periodo, 10));
  }
  if (!turno) {
    return sendJSON(res, 400, { error: 'turno es requerido' });
  }
  // El turno debe corresponder a la hora del evento (T1 [06,17], T2 [18,05]). En MAND se deriva
  // del periodo; solo validamos el camino no-MAND que recibe el turno del body (defensa en
  // profundidad: el front ya lo bloquea, pero la BD es la fuente de verdad).
  if (!isMAND && parseInt(turno, 10) !== turnoFromPeriodo(periodoFromFechaBogota(fecha_evento))) {
    return sendJSON(res, 400, { error: 'La hora no coincide con el turno', codigo: 'turno_no_coincide' });
  }

  // F6: validación funcionariocnd para MAND/Autorización.
  if (isMAND && teRow.tipo_evento_nombre === 'Autorización') {
    const fcnd = camposFinal?.funcionariocnd;
    if (!fcnd || String(fcnd).trim() === '') {
      return sendJSON(res, 400, { error: 'funcionariocnd es requerido para Autorización' });
    }
  }

  // F6: flag de notificación en tipo_evento.notificar_dashboard_tipo (fallback legacy AUTH).
  const dashboardTipo = teRow.notificar_dashboard_tipo
    || (hasNotificarDashboard(bit.definicion_campos) ? 'AUTH' : null);
  const notificar = dashboardTipo != null;
  const fechaEventoDate = new Date(fecha_evento);

  // D-045/D-046 (write-gate por unidad): el registro se estampa con el turno ABIERTO de la unidad. Si la
  // unidad NO tiene turno abierto (cierre manual anticipado o auto-cierre sin sucesor) → 409 turno_cerrado;
  // si el turno cruzó su umbral y está en la gavela de gracia (TRANSICION) → 409 turno_en_transicion (D-046,
  // el bloqueo de la gracia deja de ser solo el modal del front). Antes se insertaba con turno_id=NULL
  // ("crear registros en un turno ya cerrado"). `abrir:true` cubre el borde de ventana (abre el turno
  // vigente si el sweeper aún no lo hizo). EXENTO: MAND (ciclo por día, endpoint propio); DISP/COMB no pasan por acá.
  let turnoIdRegistro = null;
  if (!isMAND) {
    const r = await resolverTurnoParaEscritura(db, planta_id, { abrir: true });
    if (r.estado === 'CERRADO') return respTurnoCerrado(res);
    if (r.estado === 'TRANSICION') return respTurnoEnTransicion(res);
    turnoIdRegistro = r.turno.turno_unidad_id;
  }

  const transaction = new sql.Transaction(db);
  await transaction.begin();
  try {
    const reqFactory = () => new sql.Request(transaction);
    const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
    const jefes_snapshot = await snapshotJefes(reqFactory);
    const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });
    if (jefes_snapshot === '[]') {
      await transaction.rollback();
      return sendJSON(res, 409, { error: 'No hay un Jefe de Planta activo en el sistema. No se puede registrar hasta que se asigne uno.', codigo: 'sin_jefe_planta' });
    }

    if (notificar && camposFinal) {
      const periodo = camposFinal.periodo;
      const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
      if (periodo && valor != null) {
        const existente = await findEventoDashboard(transaction, {
          planta_id, fecha: fechaEventoDate, periodo, tipo: dashboardTipo,
        });
        if (existente && existente.activa) {
          await transaction.rollback();
          return sendJSON(res, 409, {
            error: `Ya existe ${dashboardTipo} vigente para este periodo`,
            evento_id: existente.evento_id,
          });
        }
      }
    }

    const ins = await new sql.Request(transaction)
      .input('bitacora_id', sql.Int, bitacora_id)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('fecha_evento', sql.DateTime2, fechaEventoDate)
      .input('turno', sql.TinyInt, turno)
      .input('detalle', sql.NVarChar(sql.MAX), detalle)
      .input('campos_extra', sql.NVarChar(sql.MAX), camposStr)
      .input('tipo_evento_id', sql.Int, tipo_evento_id)
      .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot)
      .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
      .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
      .input('creado_por', sql.Int, creado_por)
      .input('turno_id', sql.Int, turnoIdRegistro)
      .query(`
        INSERT INTO bitacora.registro_activo
          (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id)
        OUTPUT INSERTED.*
        VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @campos_extra, @tipo_evento_id,
                'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por, @turno_id)
      `);
    const registro = ins.recordset[0];

    let dashboardTocado = false;
    if (notificar && camposFinal) {
      const periodo = camposFinal.periodo;
      const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
      if (periodo && valor != null) {
        await upsertEventoDashboard(transaction, {
          planta_id,
          fecha: fechaEventoDate,
          periodo,
          valor,
          jdts_snapshot,
          jefes_snapshot,
          registro_origen_id: registro.registro_id,
          tipo: dashboardTipo,
        });
        dashboardTocado = true;
      }
    }

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    // Push al dashboard solo si tocamos evento_dashboard (Contrato 3). Fire-and-forget.
    if (dashboardTocado) notifyDashboard({ plantas: [planta_id], fecha: null }).catch(() => {});
    return sendJSON(res, 201, { registro });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// PUT /api/registros/:id — edita un registro borrador (rama DISP peek + rama genérica).
router.put('/:id(\\d+)', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const registro_id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { detalle, turno, fecha_evento, campos_extra, tipo_evento_id } = body;

  const db = await getDB();

  // D-026: peek primero contra disponibilidad_estado; si match → rama DISP.
  const dispPeek = await db.request()
    .input('id', sql.Int, registro_id)
    .query(`
      SELECT disponibilidad_id, planta_id, estado, codigo,
             fecha_inicio_estado, fecha_fin_estado, detalle,
             jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
             creado_por, creado_en, modificado_por, modificado_en
      FROM bitacora.disponibilidad_estado
      WHERE disponibilidad_id = @id
    `);

  if (dispPeek.recordset[0]) {
    const reg = dispPeek.recordset[0];
    const dispBid = await getDispBitacoraId(db);

    if (reg.fecha_fin_estado !== null) {
      return sendJSON(res, 422, { error: 'Solo se puede editar el registro vigente de DISP' });
    }
    if (!(await hasPermisoBitacora(sesion, dispBid, 'puede_crear'))) {
      return sendJSON(res, 403, { error: 'Sin permiso para editar registros de Disponibilidad' });
    }
    // DISP es cross-planta a propósito: quien tiene puede_crear puede editar el vigente de
    // CUALQUIER planta, sin importar la unidad de su sesión (revierte el guard plantaMatch de
    // AUD-11 solo para DISP). El check de abajo sigue impidiendo MOVER el registro de planta.
    const { planta_id: bodyPlanta } = body;
    if (bodyPlanta != null && bodyPlanta !== reg.planta_id) {
      return sendJSON(res, 422, { error: 'planta_id no editable en DISP' });
    }

    const extraIn = parseExtra(campos_extra);
    if (extraIn === null) {
      return sendJSON(res, 400, { error: 'campos_extra inválido (no es JSON)' });
    }
    const eventoActual = reg.estado;
    const fechaInicioActual = reg.fecha_inicio_estado instanceof Date
      ? reg.fecha_inicio_estado
      : new Date(reg.fecha_inicio_estado);

    const eventoNuevo = (extraIn && 'evento' in extraIn) ? extraIn.evento : eventoActual;
    // Preservación de detalle previo cuando el body no lo manda (compat pre-D-026 COALESCE).
    const detalleNuevo = (detalle != null) ? detalle : reg.detalle;
    const fechaInicioNuevoRaw =
      (extraIn && 'fecha_inicio_estado' in extraIn) ? extraIn.fecha_inicio_estado
      : (fecha_evento ?? null);
    const fechaInicioNueva = fechaInicioNuevoRaw ? new Date(fechaInicioNuevoRaw) : fechaInicioActual;

    if (!DISP_EVENTOS_VALIDOS.includes(eventoNuevo)) {
      return sendJSON(res, 400, {
        error: `evento debe ser uno de: ${DISP_EVENTOS_VALIDOS.join(', ')}`,
      });
    }
    if (Number.isNaN(fechaInicioNueva.getTime())) {
      return sendJSON(res, 400, { error: 'fecha_inicio_estado inválido' });
    }
    if (fechaInicioNueva.getTime() > Date.now()) {
      return sendJSON(res, 422, { error: 'fecha_inicio_estado no puede ser futuro' });
    }
    if (fechaDispBajoPiso(fechaInicioNueva)) {
      return sendJSON(res, 422, { error: `fecha_inicio_estado no puede ser anterior al año ${DISP_ANIO_MIN}` });
    }
    const codigoVal = DISP_CODIGO_POR_EVENTO[eventoNuevo];

    const transaction = new sql.Transaction(db);
    await transaction.begin();
    try {
      const eventoCambia = eventoNuevo !== eventoActual;
      const fechaCambia = fechaInicioNueva.getTime() !== fechaInicioActual.getTime();

      let nMinus1 = null;
      if (eventoCambia || fechaCambia) {
        nMinus1 = await findUltimoCerrado(transaction, { planta_id: reg.planta_id });
      }

      if (eventoCambia && nMinus1 && eventoNuevo === nMinus1.estado) {
        await transaction.rollback();
        return sendJSON(res, 409, {
          error: 'mismo_estado_que_anterior',
          mensaje: `El estado anterior ya era ${nMinus1.estado}; no se permite la secuencia ${nMinus1.estado} → ${eventoNuevo}`,
          n_menos_1: { registro_id: nMinus1.disponibilidad_id, evento: nMinus1.estado },
        });
      }
      if (fechaCambia && nMinus1) {
        const nMinus1FechaInicio = nMinus1.fecha_inicio_estado instanceof Date
          ? nMinus1.fecha_inicio_estado
          : new Date(nMinus1.fecha_inicio_estado);
        if (fechaInicioNueva.getTime() < nMinus1FechaInicio.getTime()) {
          await transaction.rollback();
          return sendJSON(res, 409, {
            error: 'fecha_anterior_a_n_menos_1',
            mensaje: 'La nueva fecha es anterior al inicio del estado previo',
            n_menos_1: {
              registro_id: nMinus1.disponibilidad_id,
              fecha_inicio_estado: nMinus1FechaInicio.toISOString(),
            },
          });
        }
        // D-011: mantener cronología sin gap — el N-1 cierra exactamente cuando arranca el vigente.
        await cerrarVigente(transaction, {
          disponibilidad_id: nMinus1.disponibilidad_id,
          fecha_fin: fechaInicioNueva,
        });
      }

      const reqFactory = () => new sql.Request(transaction);
      const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: reg.planta_id });
      const jefes_planta_snapshot = await snapshotJefes(reqFactory);
      const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
      const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id: reg.planta_id });

      await actualizarVigente(transaction, {
        disponibilidad_id: reg.disponibilidad_id,
        estado: eventoNuevo,
        codigo: codigoVal,
        fecha_inicio_estado: fechaInicioNueva,
        detalle: detalleNuevo,
        jdts_snapshot,
        jefes_planta_snapshot,
        gerentes_produccion_snapshot,
        ingenieros_snapshot,
        modificado_por: sesion.usuario_id,
      });

      const after = await new sql.Request(transaction)
        .input('id', sql.Int, reg.disponibilidad_id)
        .query(`
          SELECT disponibilidad_id, planta_id, estado, codigo,
                 fecha_inicio_estado, fecha_fin_estado, detalle,
                 jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
                 creado_por, creado_en, modificado_por, modificado_en
          FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id
        `);
      const actualizado = after.recordset[0];

      await transaction.commit();
      return sendJSON(res, 200, { registro: mapDispRowToLegacyShape(actualizado, dispBid) });
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      throw err;
    }
  }

  // No-DISP: lookup tradicional en registro_activo.
  // D-040: write-gate SOLO en la rama genérica (la rama DISP salió arriba con su propio return).
  if (bloquearSiTurnoFinalizado(req, res)) return;
  const check = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`
      SELECT ra.registro_id, ra.estado, ra.bitacora_id, ra.planta_id, ra.creado_por,
             ra.fecha_evento, ra.turno, ra.fecha_fin_estado, ra.campos_extra, b.codigo AS bitacora_codigo
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.registro_id = @registro_id
    `);
  if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
  const reg = check.recordset[0];

  // D-045/D-046 write-gate por unidad: turno cerrado (sin ABIERTO) → 409 turno_cerrado; turno en la gavela
  // de gracia (TRANSICION) → 409 turno_en_transicion. Nadie edita en genéricas hasta reabrir/extender.
  // MAND fuera (ciclo por día, sin cabecera de turno).
  if (reg.bitacora_codigo !== 'MAND') {
    const r = await resolverTurnoParaEscritura(db, reg.planta_id, { abrir: false });
    if (r.estado === 'CERRADO') return respTurnoCerrado(res);
    if (r.estado === 'TRANSICION') return respTurnoEnTransicion(res);
  }

  if (reg.estado !== 'borrador') {
    return sendJSON(res, 409, { error: 'Solo se pueden editar registros en borrador' });
  }
  // D-058 (RQ-02.5/6): el asiento reflejado se corrige en su ORIGEN. `canEditarRegistro` ya lo
  // rechaza —es la MISMA condición, el enforcement no está partido— y acá solo se elige el `codigo`
  // y el mensaje: responderle "solo el autor puede editarlo" a quien ES el autor sería falso y lo
  // dejaría sin saber a dónde ir a corregirlo.
  if (esAsientoReflejado(reg)) {
    return sendJSON(res, 403, {
      error: 'Este asiento se generó en Operación 24h y no se edita acá',
      codigo: 'asiento_reflejado',
      mensaje: 'Este asiento se generó en Operación 24h. Corrígelo allá y se actualiza acá solo.',
    });
  }
  // D-049: solo el autor (con puede_crear vigente) edita. Código estable para que el front ramifique.
  if (!(await canEditarRegistro(sesion, reg))) {
    return sendJSON(res, 403, {
      error: 'Solo el autor de este registro puede editarlo',
      codigo: 'solo_autor',
      mensaje: 'Solo el autor de este registro puede editarlo.',
    });
  }
  // R3: día futuro bloqueado (slug `fecha_futura`, paridad COMB) + guard de 5 min intra-día.
  if (fecha_evento) {
    if (fechaBogotaStr(new Date(fecha_evento)) > fechaBogotaStr(new Date())) {
      return sendJSON(res, 400, { error: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
    }
    if (new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
      return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
    }
  }
  if (tipo_evento_id) {
    // D-058 (F34.A1): mismo gate que el POST — un PUT que cambie el tipo tampoco puede aterrizar en
    // un tipo espejo del reflejo (`seleccionable = 0`).
    const teCheck = await db.request()
      .input('te', sql.Int, tipo_evento_id)
      .input('b', sql.Int, reg.bitacora_id)
      .query(`
        SELECT 1 AS ok FROM lov_bit.tipo_evento
        WHERE tipo_evento_id = @te AND bitacora_id = @b AND seleccionable = 1
      `);
    if (teCheck.recordset.length === 0) {
      return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
    }
  }
  const modificado_por = sesion.usuario_id;

  // F6: lookup del tipo_evento (del body o el original) para saber si reescribir evento_dashboard.
  const teEffectiveId = tipo_evento_id != null
    ? tipo_evento_id
    : (await db.request()
        .input('rid', sql.Int, registro_id)
        .query(`SELECT tipo_evento_id FROM bitacora.registro_activo WHERE registro_id = @rid`)
      ).recordset[0]?.tipo_evento_id;
  const teInfo = await db.request()
    .input('te', sql.Int, teEffectiveId)
    .query(`
      SELECT te.nombre AS tipo_evento_nombre, te.notificar_dashboard_tipo,
             b.codigo AS bitacora_codigo, b.definicion_campos
      FROM lov_bit.tipo_evento te
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
      WHERE te.tipo_evento_id = @te
    `);
  const teRow = teInfo.recordset[0] || {};
  const isMAND = teRow.bitacora_codigo === 'MAND';

  let camposStr = null;
  let camposFinal = null;
  if (campos_extra !== undefined && campos_extra !== null) {
    const validation = validateCamposExtra(teRow.definicion_campos, campos_extra);
    if (!validation.ok) {
      return sendJSON(res, 400, { error: 'campos_extra inválido', detalles: validation.errors });
    }
    camposFinal = validation.definicion ? computeCamposAuto(validation.definicion, validation.data) : validation.data;
    // F6: solo AUTH legacy auto-rellena periodo desde fecha en PUT.
    if (camposFinal && hasNotificarDashboard(teRow.definicion_campos) && !isMAND) {
      const fechaEfectiva = fecha_evento ? new Date(fecha_evento) : reg.fecha_evento;
      camposFinal.periodo = periodoFromFechaBogota(fechaEfectiva);
    }
    if (isMAND && teRow.tipo_evento_nombre === 'Autorización') {
      const fcnd = camposFinal?.funcionariocnd;
      if (!fcnd || String(fcnd).trim() === '') {
        return sendJSON(res, 400, { error: 'funcionariocnd es requerido para Autorización' });
      }
    }
    camposStr = camposFinal ? JSON.stringify(camposFinal) : null;
  }

  // F6: turno NO se reactualiza en PUT; si llega en el body se respeta.
  // El turno efectivo debe corresponder a la hora efectiva del evento (mismo criterio que el POST).
  // Solo no-MAND (MAND deriva el turno del periodo). Con COALESCE, "efectivo" = body ?? valor actual.
  if (!isMAND) {
    const turnoEfectivo = turno != null ? parseInt(turno, 10) : reg.turno;
    const fechaEfectiva = fecha_evento ? new Date(fecha_evento) : reg.fecha_evento;
    if (fechaEfectiva && turnoEfectivo !== turnoFromPeriodo(periodoFromFechaBogota(fechaEfectiva))) {
      return sendJSON(res, 400, { error: 'La hora no coincide con el turno', codigo: 'turno_no_coincide' });
    }
  }
  const transaction = new sql.Transaction(db);
  await transaction.begin();
  try {
    const upd = await new sql.Request(transaction)
      .input('registro_id', sql.Int, registro_id)
      .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
      .input('turno', sql.TinyInt, turno)
      .input('fecha_evento', sql.DateTime2, fecha_evento ? new Date(fecha_evento) : null)
      .input('campos_extra', sql.NVarChar(sql.MAX), camposStr)
      .input('tipo_evento_id', sql.Int, tipo_evento_id)
      .input('modificado_por', sql.Int, modificado_por)
      .query(`
        UPDATE bitacora.registro_activo
        SET detalle = COALESCE(@detalle, detalle),
            turno = COALESCE(@turno, turno),
            fecha_evento = COALESCE(@fecha_evento, fecha_evento),
            campos_extra = COALESCE(@campos_extra, campos_extra),
            tipo_evento_id = COALESCE(@tipo_evento_id, tipo_evento_id),
            modificado_por = @modificado_por,
            modificado_en = SYSUTCDATETIME()
        OUTPUT INSERTED.*
        WHERE registro_id = @registro_id AND estado = 'borrador'
      `);

    // F6: si notifica al dashboard y cambió valor/periodo, reescribir evento_dashboard.
    const dashboardTipo = teRow.notificar_dashboard_tipo
      || (hasNotificarDashboard(teRow.definicion_campos) ? 'AUTH' : null);
    let dashboardTocado = false;
    if (camposFinal && dashboardTipo) {
      const periodo = camposFinal.periodo;
      const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
      if (periodo && valor != null) {
        const reqFactory = () => new sql.Request(transaction);
        const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: reg.planta_id });
        const jefes_snapshot = await snapshotJefes(reqFactory);
        await upsertEventoDashboard(transaction, {
          planta_id: reg.planta_id,
          fecha: fecha_evento ? new Date(fecha_evento) : reg.fecha_evento,
          periodo,
          valor,
          jdts_snapshot,
          jefes_snapshot,
          registro_origen_id: registro_id,
          tipo: dashboardTipo,
        });
        dashboardTocado = true;
      }
    }

    await transaction.commit();
    // Push al dashboard solo si tocamos evento_dashboard (Contrato 3). Fire-and-forget.
    if (dashboardTocado) notifyDashboard({ plantas: [reg.planta_id], fecha: null }).catch(() => {});
    return sendJSON(res, 200, { registro: upd.recordset[0] });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// DELETE /api/registros/:id — soft-delete (solo borrador). F5: cubre todos los tipos.
router.delete('/:id(\\d+)', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const registro_id = parseInt(req.params.id, 10);
  // D-040: write-gate. DELETE opera sobre registro_activo (genéricas; DISP vive en otra tabla → 404).
  // Turno finalizado → 409 antes de tocar nada.
  if (bloquearSiTurnoFinalizado(req, res)) return;
  const db = await getDB();
  const check = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`
      SELECT ra.registro_id, ra.estado, ra.bitacora_id, ra.planta_id, ra.creado_por,
             ra.campos_extra, b.codigo AS bitacora_codigo
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.registro_id = @registro_id
    `);
  if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
  const reg = check.recordset[0];

  // D-045/D-046 write-gate por unidad: turno cerrado → 409 turno_cerrado; en gavela de gracia (TRANSICION)
  // → 409 turno_en_transicion. Nadie borra en genéricas hasta reabrir/extender. MAND fuera.
  if (reg.bitacora_codigo !== 'MAND') {
    const r = await resolverTurnoParaEscritura(db, reg.planta_id, { abrir: false });
    if (r.estado === 'CERRADO') return respTurnoCerrado(res);
    if (r.estado === 'TRANSICION') return respTurnoEnTransicion(res);
  }

  if (reg.estado !== 'borrador') {
    return sendJSON(res, 409, { error: 'Solo se pueden eliminar registros en borrador' });
  }
  // D-058 (RQ-02.5/6): el asiento reflejado se BORRA borrando su lote de origen, que cascadea a las
  // dos copias (E5). Mismo criterio que el PUT: `canEditarRegistro` ya lo rechaza; acá solo se le
  // pone nombre al motivo, porque el autor de la copia es el autor del origen y "solo el autor"
  // sería una explicación falsa.
  if (esAsientoReflejado(reg)) {
    return sendJSON(res, 403, {
      error: 'Este asiento se generó en Operación 24h y no se elimina acá',
      codigo: 'asiento_reflejado',
      mensaje: 'Este asiento se generó en Operación 24h. Elimina allá el lote y esta copia se va con él.',
    });
  }
  // D-049: solo el autor (con puede_crear vigente) elimina. Código estable para que el front ramifique.
  if (!(await canEditarRegistro(sesion, reg))) {
    return sendJSON(res, 403, {
      error: 'Solo el autor de este registro puede eliminarlo',
      codigo: 'solo_autor',
      mensaje: 'Solo el autor de este registro puede eliminarlo.',
    });
  }

  const del = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`
      UPDATE bitacora.evento_dashboard SET activa = 0 WHERE registro_origen_id = @registro_id;
      DELETE FROM bitacora.registro_activo WHERE registro_id = @registro_id AND estado = 'borrador';
    `);
  broadcastConteoBitacoras(reg.planta_id).catch(() => {});
  // rowsAffected[0] = filas de evento_dashboard desactivadas (el UPDATE es el 1er statement). Solo
  // avisamos al dashboard si de verdad se soft-deleteó un evento visible (Contrato 3). Fire-and-forget.
  if ((del.rowsAffected?.[0] ?? 0) > 0) notifyDashboard({ plantas: [reg.planta_id], fecha: null }).catch(() => {});
  return sendJSON(res, 200, { ok: true });
}));

export default router;
