// Router de Sala de Mando / MAND (E9, AUD-34/35). Grilla 3×24 (AUTH|PRUEBA|REDESP) + captura
// append-only por lotes (D-056) + cierre diario manual. Montado bajo /api/sala-de-mando tras
// requireEntra.

import express from 'express';
import sql from 'mssql';
import { randomUUID } from 'node:crypto';
import * as dbBindings from '../db.js';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { responderError } from '../utils/errores.js';
import { hasPermisoBitacora, plantaMatch, puedeCerrarTurno } from '../middleware/permissions.js';
import { turnoFromPeriodo, fechaOperativaDePeriodo, fechaBogotaStr } from '../utils/turno.js';
import { snapshotJDTs, snapshotJefes, snapshotIngenieros } from '../utils/snapshots.js';
import { recalcularEventoDashboard } from '../utils/notificador.js';
import { cerrarDiaMand } from '../utils/mand-sweeper.js';
import { broadcastConteoBitacoras } from '../utils/ws-conteo-bitacoras.js';
import { notifyDashboard } from '../utils/notify-dashboard.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// D-055: turno_unidad_id de la cabecera que gobierna (planta, fecha_operativa, turno), o null si no
// existe. Lectura pura, dentro de la transacción del batch. NO abre turnos: MAND se archiva por día
// (cerrarDiaMand), no por turno, así que acá el turno es trazabilidad — no ciclo de vida.
async function resolverTurnoUnidadId(transaction, { planta_id, fecha_operativa, turno }) {
  const r = await new sql.Request(transaction)
    .input('p', sql.VarChar(10), planta_id)
    .input('f', sql.Date, fecha_operativa)
    .input('t', sql.TinyInt, turno)
    .query(`
      SELECT TOP 1 turno_unidad_id
      FROM bitacora.turno_unidad
      WHERE planta_id = @p AND fecha_operativa = @f AND turno = @t
    `);
  return r.recordset[0]?.turno_unidad_id ?? null;
}

// GET /api/sala-de-mando?planta_id=&fecha=
// Grilla 3×24 (AUTH|PRUEBA|REDESP) del día para el frontend de Sala de Mando.
router.get('/', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  const fecha = req.query.fecha;
  if (!planta_id || !fecha) return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
  }
  const db = await getDB();
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, new Date(fecha))
    .query(`
      SELECT ra.registro_id, ra.detalle, ra.creado_en, ra.fecha_evento,
             te.notificar_dashboard_tipo AS tipo,
             te.nombre AS tipo_evento_nombre,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT) AS periodo,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
             JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE b.codigo = 'MAND'
        AND ra.planta_id = @planta_id
        AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @fecha
        AND ra.estado = 'borrador'
      ORDER BY ra.creado_en DESC
    `);

  const buildEmpty = () => ({
    valores: Array(24).fill(null),
    detalle: null,
    funcionariocnd: null,
    registros: {},
  });
  const out = { AUTH: buildEmpty(), PRUEBA: buildEmpty(), REDESP: buildEmpty() };
  for (const row of r.recordset) {
    const fila = out[row.tipo];
    if (!fila) continue;
    if (row.periodo && row.periodo >= 1 && row.periodo <= 24) {
      // El primer recordset (más reciente) gana para una celda dada.
      if (fila.valores[row.periodo - 1] == null) {
        fila.valores[row.periodo - 1] = row.valor_mw;
        fila.registros[row.periodo] = row.registro_id;
      }
    }
    if (fila.detalle == null && row.detalle) fila.detalle = row.detalle;
    if (fila.funcionariocnd == null && row.funcionariocnd) fila.funcionariocnd = row.funcionariocnd;
  }
  return sendJSON(res, 200, out);
}));

// Formato de la hora de la llamada tal como la manda el front (`<input type="time">`): HH:mm en
// wallclock Bogotá. El instante se compone en el SERVIDOR (nunca se confía en el reloj del cliente).
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Tolerancia hacia el futuro para `hora_llamada`. Absorbe el desfase entre el reloj del navegador
// (que precarga el campo) y el del servidor; no habilita registrar llamadas futuras.
const TOLERANCIA_HORA_MS = 5 * 60 * 1000;

// POST /api/sala-de-mando/guardar — captura APPEND-ONLY de Operación 24h (D-056).
// Body: { planta_id, fecha, filas: [{ tipo, hora, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }] }
//
// Cada fila/tipo de un mismo Guardar produce UN lote (`campos_extra.lote_id`, GUID generado acá) y
// un registro NUEVO e inmutable por celda con valor. Nunca UPDATE, nunca DELETE: varios lotes
// coexisten para el mismo (tipo, periodo, día, planta) — un periodo recibe varias llamadas del CND
// en el día y hasta D-056 la segunda pisaba a la primera. Lo publicado al dashboard lo decide
// `recalcularEventoDashboard` por CELDA (mayor hora_llamada), no el orden de guardado.
router.post('/guardar', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const { planta_id, fecha, filas } = req.body || {};

  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  // D-055: la allowlist de plantas NO se hardcodea. `plantaMatch` ya acota a la unidad de la
  // sesión, y `sesion_activa.planta_id` tiene FK a `lov_bit.planta` — una planta inexistente no
  // puede llegar hasta acá. Hardcodear ['GEC3','GEC32'] forzaba a la suite (que corre contra la
  // BD productiva, D-030) a escribir en una planta REAL, y su limpieza destruía histórico real.
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede guardar en otra planta' });
  }
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD' });
  }
  if (!Array.isArray(filas)) {
    return sendJSON(res, 400, { error: 'filas debe ser un array' });
  }

  // Validación: fecha = hoy en TZ Bogotá. Offset puro -5h (mismo cómputo que fechaBogotaStr).
  const nowMs = Date.now();
  const nowBogota = new Date(nowMs - 5 * 3600 * 1000);
  const hoyStr = fechaBogotaStr(nowMs);
  if (fecha !== hoyStr) {
    return sendJSON(res, 400, {
      errores: [{ motivo: 'fecha_no_es_hoy', mensaje: `fecha debe ser hoy (${hoyStr} en zona Bogotá)` }],
    });
  }

  // Periodo actual = floor(hora_bogota_now) + 1. Se usa para validar el lock REDESP.
  const periodoActual = nowBogota.getUTCHours() + 1;

  const db = await getDB();

  // Lookup MAND + tipos de evento → mapeo notificar_dashboard_tipo (AUTH/PRUEBA/REDESP).
  const meta = await db.request().query(`
    SELECT b.bitacora_id AS mand_id,
           te.tipo_evento_id, te.nombre AS tipo_nombre, te.notificar_dashboard_tipo AS tipo_dashboard
    FROM lov_bit.bitacora b
    INNER JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
    WHERE b.codigo = 'MAND'
  `);
  if (meta.recordset.length === 0) {
    console.error('[ERROR] config: bitácora MAND no encontrada en lov_bit.bitacora');
    return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  }
  const MAND_ID = meta.recordset[0].mand_id;
  const tipoMap = {};
  for (const row of meta.recordset) {
    if (row.tipo_dashboard) tipoMap[row.tipo_dashboard] = {
      tipo_evento_id: row.tipo_evento_id,
      tipo_nombre: row.tipo_nombre,
    };
  }
  if (!tipoMap.AUTH || !tipoMap.PRUEBA || !tipoMap.REDESP) {
    console.error('[ERROR] config: mapeo de tipos MAND incompleto en lov_bit.tipo_evento');
    return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  }

  // Permiso: puede_crear en MAND. plantaMatch ya validado arriba.
  if (!(await hasPermisoBitacora(sesion, MAND_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear/editar en MAND' });
  }

  // ── Validaciones de negocio (acumulan errores, NO escriben si hay alguno; RN-03.b) ────────────
  // La unidad de captura es el LOTE (una fila/tipo dentro de un Guardar). Los errores de CELDA
  // llevan `periodo`; los de la FILA entera (hora, funcionario, lote sin celdas) viajan SIN
  // `periodo` — el front los pinta en la cabecera de la fila, no sobre una celda.
  const errores = [];
  const filasNorm = [];
  for (const fila of filas) {
    const { tipo, hora, detalle, funcionariocnd, periodos } = fila || {};
    if (!['AUTH', 'PRUEBA', 'REDESP'].includes(tipo)) {
      errores.push({ tipo: tipo ?? null, motivo: 'tipo_invalido' });
      continue;
    }
    if (!Array.isArray(periodos)) {
      errores.push({ tipo, motivo: 'periodos_invalido' });
      continue;
    }

    const erroresAntesDeLaFila = errores.length;
    const periodosNorm = [];
    for (const item of periodos) {
      const p = parseInt(item?.periodo, 10);
      if (!Number.isInteger(p) || p < 1 || p > 24) {
        errores.push({ tipo, periodo: item?.periodo ?? null, motivo: 'periodo_fuera_rango' });
        continue;
      }
      const v = (item.valor_mw === null || item.valor_mw === undefined || item.valor_mw === '')
        ? null
        : Number(item.valor_mw);
      if (v !== null && !Number.isFinite(v)) {
        errores.push({ tipo, periodo: p, motivo: 'valor_mw_invalido' });
        continue;
      }
      // Lock REDESP (RQ-03.17 / RN-03.c): protege el VALOR, jamás la hora ni el comentario.
      if (tipo === 'REDESP' && v !== null && p < periodoActual) {
        errores.push({ tipo, periodo: p, motivo: 'periodo_bloqueado' });
        continue;
      }
      if (v !== null) periodosNorm.push({ periodo: p, valor_mw: v });
    }
    const huboErrorDeCelda = errores.length > erroresAntesDeLaFila;

    const detalleEff = (detalle != null && String(detalle).trim() !== '') ? detalle : null;
    const pideMetadata = detalleEff != null
      || (funcionariocnd != null && String(funcionariocnd).trim() !== '');

    // Fila intacta (sin valores y sin metadata): no hay lote que registrar ni nada que perder. La
    // hora viene PRECARGADA por el front (RQ-03.13), así que por sí sola no ensucia la fila.
    if (periodosNorm.length === 0 && !pideMetadata && !huboErrorDeCelda) continue;
    // Ya hay un motivo explícito para esta fila; no lo sepultamos bajo errores derivados.
    if (huboErrorDeCelda) continue;

    // RN-03.a: metadata sin ninguna celda con valor → rechazo explícito, NUNCA un 200 mentiroso.
    // Es la regla que D-055 introdujo como `detalle_sin_celdas`: cambia el punto de validación
    // (antes: no había dónde anclar el comentario), no la regla.
    if (periodosNorm.length === 0) {
      errores.push({ tipo, motivo: 'lote_sin_celdas' });
      continue;
    }

    // Hora de la llamada al CND (RQ-03.11..14): atributo del LOTE, obligatorio, validado contra el
    // reloj del SERVIDOR. `fecha` ya está fijada a hoy Bogotá, así que el instante compuesto cae
    // dentro del día de la grilla por construcción — igual se verifica antes de persistirlo.
    const horaTxt = hora == null ? '' : String(hora).trim();
    if (horaTxt === '') {
      errores.push({ tipo, motivo: 'hora_requerida' });
      continue;
    }
    const horaLlamada = RE_HORA.test(horaTxt) ? new Date(`${fecha}T${horaTxt}:00.000-05:00`) : null;
    if (!horaLlamada || Number.isNaN(horaLlamada.getTime()) || fechaBogotaStr(horaLlamada) !== fecha) {
      errores.push({ tipo, motivo: 'hora_invalida' });
      continue;
    }
    if (horaLlamada.getTime() > nowMs + TOLERANCIA_HORA_MS) {
      errores.push({ tipo, motivo: 'hora_futura' });
      continue;
    }

    // funcionariocnd (RQ-03.16, sin cambios): AUTH lo exige — acá el lote ya tiene ≥1 celda con
    // valor —; PRUEBA y REDESP lo fuerzan a NULL en silencio.
    let funcEff = null;
    if (tipo === 'AUTH') {
      funcEff = (funcionariocnd != null && String(funcionariocnd).trim() !== '') ? funcionariocnd : null;
      if (funcEff == null) {
        errores.push({ tipo, motivo: 'funcionariocnd_requerido' });
        continue;
      }
    }

    filasNorm.push({
      tipo,
      detalle: detalleEff,
      funcionariocnd: funcEff,
      hora_llamada: horaLlamada.toISOString(),
      periodos: periodosNorm,
    });
  }

  if (errores.length > 0) {
    return sendJSON(res, 400, { errores });
  }

  // Procesamiento atómico.
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

    // ── Escritura APPEND-ONLY: un lote por fila, un registro NUEVO por celda con valor ──────────
    // Desapareció la máquina de 4 casos por celda (INSERT/UPDATE/DELETE/no-op) y con ella el
    // `modificado_por` selectivo de D-019 y el UPDATE de metadata a nivel de fila de D-055 (2):
    // acá nada se modifica ni se borra, la metadata NACE con el lote. Las celdas vacías se omiten
    // (ya no borran nada) y las correcciones viven en el histórico del apartado (D-057 / REQ-04).
    let registrosCreados = 0;
    const celdasTocadas = new Map(); // `${tipo}|${periodo}` → { tipo, periodo } (dedupe para el recálculo)

    for (const fila of filasNorm) {
      const tipoEventoId = tipoMap[fila.tipo].tipo_evento_id;
      // El lote_id lo genera el SERVIDOR (uno por fila y por Guardar): el cliente no participa en
      // la identidad del lote. Sin DDL — viaja dentro de campos_extra y por eso llega solo al
      // histórico en el cierre diario (mand-sweeper copia campos_extra tal cual).
      const lote_id = randomUUID();

      for (const { periodo, valor_mw } of fila.periodos) {
        const turno = turnoFromPeriodo(periodo);
        const camposExtra = JSON.stringify({
          periodo,
          valor_mw,
          funcionariocnd: fila.funcionariocnd,
          lote_id,
          hora_llamada: fila.hora_llamada,
        });
        // D-055 (3) / RN-03.e: turno_id se resuelve por (planta, fecha_operativa, turno) con
        // `fechaOperativaDePeriodo` — los periodos 1..6 de la grilla del día F pertenecen al T2 que
        // arrancó a las 18:00 de F-1. JAMÁS por `hora_llamada` (dato declarado por el operador) ni
        // por `inicio_nominal`/`fin_nominal` (los muta extenderTurno, D-046, y dejan de particionar).
        // Degrada a NULL si la cabecera no existe: un registro nunca se pierde por no poder atarlo.
        const turnoIdCelda = await resolverTurnoUnidadId(transaction, {
          planta_id, fecha_operativa: fechaOperativaDePeriodo(fecha, periodo), turno,
        });
        await new sql.Request(transaction)
          .input('mand', sql.Int, MAND_ID)
          .input('planta', sql.VarChar(10), planta_id)
          .input('turno', sql.TinyInt, turno)
          .input('turno_id', sql.Int, turnoIdCelda)
          .input('detalle', sql.NVarChar(sql.MAX), fila.detalle)
          .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
          .input('te', sql.Int, tipoEventoId)
          .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot)
          .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
          .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
          .input('creado_por', sql.Int, sesion.usuario_id)
          .query(`
            INSERT INTO bitacora.registro_activo
              (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id)
            VALUES (@mand, @planta, SYSUTCDATETIME(), @turno, @detalle, @campos_extra, @te,
                    'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por,
                    @turno_id)
          `);
        registrosCreados++;
        celdasTocadas.set(`${fila.tipo}|${periodo}`, { tipo: fila.tipo, periodo });
      }
    }

    // Publicación al dashboard: el vigente de cada celda tocada se resuelve DESDE CERO (D-056 E2),
    // dentro de esta misma transacción. Por CELDA y no por lote: dos lotes pueden solaparse
    // parcialmente y cada periodo compartido lo gana el de mayor `hora_llamada`. Reemplaza a
    // `upsertEventoDashboard`, que devolvía `conflict` ante una fila ya activa y por lo tanto nunca
    // habría dejado que un lote posterior desplazara al publicado.
    for (const { tipo, periodo } of celdasTocadas.values()) {
      await recalcularEventoDashboard(transaction, { planta_id, fecha, periodo, tipo });
    }

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    // Push cross-repo al dashboard (fire-and-forget) SOLO si se escribió algo. Nunca bloquea la
    // respuesta al operador (ver notify-dashboard.js).
    if (registrosCreados > 0) {
      notifyDashboard({ plantas: [planta_id], fecha }).catch(() => {});
    }
    return sendJSON(res, 200, { resumen: { lotes: filasNorm.length, registros: registrosCreados } });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// POST /api/sala-de-mando/cierre-diario — dispara el cierre del día MAND para una planta (mismo
// helper que el sweeper diario). Útil para tests, recovery operativo y reproducción manual.
router.post('/cierre-diario', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!puedeCerrarTurno(sesion)) {
    return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar el día MAND' });
  }
  const { fecha, planta_id } = req.body || {};
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD' });
  }
  // D-055: sin allowlist hardcodeada — ver el comentario de POST /guardar. `plantaMatch` acota.
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede cerrar el día de otra planta' });
  }
  const pool = await getDB();
  try {
    const result = await cerrarDiaMand(pool, {
      fecha,
      planta_id,
      usuarioCierre: dbBindings.USUARIO_SISTEMA_ID,
    });
    broadcastConteoBitacoras(planta_id).catch(() => {});
    return sendJSON(res, 200, result);
  } catch (err) {
    return responderError(res, err, 'POST /api/sala-de-mando/cierre-diario');
  }
}));

export default router;
