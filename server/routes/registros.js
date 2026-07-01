// Router de registros (E10, AUD-34/35). El corazón operativo: listar borradores + crear/editar/borrar
// registros de cualquier bitácora, con la rama especial DISP (D-026, storage en disponibilidad_estado)
// dentro de POST y PUT. Montado bajo /api/registros tras requireEntra; todas exigen sesión de app.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora, plantaMatch, canEditarRegistro } from '../middleware/permissions.js';
import { validateCamposExtra, computeCamposAuto } from '../utils/campos.js';
import { periodoFromFechaBogota, turnoFromPeriodo } from '../utils/turno.js';
import {
  findEventoDashboard, upsertEventoDashboard, hasNotificarDashboard,
  findVigente, findUltimoCerrado, insertNuevoEstado, cerrarVigente, actualizarVigente,
} from '../utils/notificador.js';
import {
  snapshotJDTs, snapshotJefes, snapshotIngenieros, snapshotGerentesProduccion,
} from '../utils/snapshots.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { jsonBody, getDispBitacoraId } from './_shared.js';

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
router.use(jsonBody);
router.use(loadAppSession);

// GET /api/registros/activos?planta_id=&bitacora_id=&estado=
router.get('/activos', asyncH(async (req, res) => {
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
  const result = await reqQ.query(`
    SELECT r.*,
           b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
           te.nombre AS tipo_evento_nombre,
           autor.nombre_completo AS creado_por_nombre,
           r.creado_por AS creado_por_id
    FROM bitacora.registro_activo r
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = r.creado_por
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
    // AUD-11: IDOR cross-planta. D-035: una persona opera UNA sola unidad.
    if (!plantaMatch(sesion, planta_id)) {
      return sendJSON(res, 403, { error: 'No autorizado para esta planta' });
    }
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
  const teCheck = await db.request()
    .input('te', sql.Int, tipo_evento_id)
    .input('b', sql.Int, bitacora_id)
    .query(`
      SELECT te.tipo_evento_id, te.nombre AS tipo_evento_nombre,
             te.notificar_dashboard_tipo,
             bb.codigo AS bitacora_codigo
      FROM lov_bit.tipo_evento te
      INNER JOIN lov_bit.bitacora bb ON bb.bitacora_id = te.bitacora_id
      WHERE te.tipo_evento_id = @te AND te.bitacora_id = @b
    `);
  if (teCheck.recordset.length === 0) {
    return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
  }
  const teRow = teCheck.recordset[0];
  const isMAND = teRow.bitacora_codigo === 'MAND';

  // F6: check de fecha futura. MAND acepta cualquier hora del día; el resto guard de 5 min.
  if (!isMAND && new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
    return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
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
      .query(`
        INSERT INTO bitacora.registro_activo
          (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
        OUTPUT INSERTED.*
        VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @campos_extra, @tipo_evento_id,
                'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por)
      `);
    const registro = ins.recordset[0];

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
      }
    }

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
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
    // AUD-11: IDOR cross-planta.
    if (!plantaMatch(sesion, reg.planta_id)) {
      return sendJSON(res, 403, { error: 'No autorizado para esta planta' });
    }
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
  const check = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`
      SELECT ra.registro_id, ra.estado, ra.bitacora_id, ra.planta_id, ra.creado_por,
             ra.fecha_evento, ra.fecha_fin_estado, ra.campos_extra, b.codigo AS bitacora_codigo
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE ra.registro_id = @registro_id
    `);
  if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
  const reg = check.recordset[0];

  if (reg.estado !== 'borrador') {
    return sendJSON(res, 409, { error: 'Solo se pueden editar registros en borrador' });
  }
  if (!(await canEditarRegistro(sesion, reg))) {
    return sendJSON(res, 403, { error: 'Sin permiso para editar este registro' });
  }
  if (fecha_evento && new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
    return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
  }
  if (tipo_evento_id) {
    const teCheck = await db.request()
      .input('te', sql.Int, tipo_evento_id)
      .input('b', sql.Int, reg.bitacora_id)
      .query(`SELECT 1 AS ok FROM lov_bit.tipo_evento WHERE tipo_evento_id = @te AND bitacora_id = @b`);
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
      }
    }

    await transaction.commit();
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
  const db = await getDB();
  const check = await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`SELECT registro_id, estado, bitacora_id, planta_id, creado_por FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
  if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
  const reg = check.recordset[0];
  if (reg.estado !== 'borrador') {
    return sendJSON(res, 409, { error: 'Solo se pueden eliminar registros en borrador' });
  }
  if (!(await canEditarRegistro(sesion, reg))) {
    return sendJSON(res, 403, { error: 'Sin permiso para eliminar este registro' });
  }

  await db.request()
    .input('registro_id', sql.Int, registro_id)
    .query(`
      UPDATE bitacora.evento_dashboard SET activa = 0 WHERE registro_origen_id = @registro_id;
      DELETE FROM bitacora.registro_activo WHERE registro_id = @registro_id AND estado = 'borrador';
    `);
  broadcastConteoBitacoras(reg.planta_id).catch(() => {});
  return sendJSON(res, 200, { ok: true });
}));

export default router;
