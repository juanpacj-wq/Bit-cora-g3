// Router de Sala de Mando / MAND (E9, AUD-34/35). Grilla 3×24 (AUTH|PRUEBA|REDESP) + batch save
// atómico + cierre diario manual. Montado bajo /api/sala-de-mando tras requireEntra.

import express from 'express';
import sql from 'mssql';
import * as dbBindings from '../db.js';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { responderError } from '../utils/errores.js';
import { hasPermisoBitacora, plantaMatch, puedeCerrarTurno } from '../middleware/permissions.js';
import { turnoFromPeriodo, fechaOperativaDePeriodo } from '../utils/turno.js';
import { snapshotJDTs, snapshotJefes, snapshotIngenieros } from '../utils/snapshots.js';
import { upsertEventoDashboard } from '../utils/notificador.js';
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

// POST /api/sala-de-mando/guardar — batch save atómico para la grilla MAND.
// Body: { planta_id, fecha, filas: [{ tipo, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }] }
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

  // Validación: fecha = hoy en TZ Bogotá. Calculamos hoy con offset -5h.
  const nowMs = Date.now();
  const nowBogota = new Date(nowMs - 5 * 3600 * 1000);
  const hoyStr = `${nowBogota.getUTCFullYear()}-${String(nowBogota.getUTCMonth() + 1).padStart(2, '0')}-${String(nowBogota.getUTCDate()).padStart(2, '0')}`;
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

  // Validaciones de negocio (acumulan errores, NO escriben si hay alguno).
  const errores = [];
  const filasNorm = [];
  for (const fila of filas) {
    const { tipo, detalle, funcionariocnd, periodos } = fila || {};
    if (!['AUTH', 'PRUEBA', 'REDESP'].includes(tipo)) {
      errores.push({ tipo: tipo ?? null, motivo: 'tipo_invalido' });
      continue;
    }
    if (!Array.isArray(periodos)) {
      errores.push({ tipo, motivo: 'periodos_invalido' });
      continue;
    }
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
      // Validación REDESP: rechaza periodo bloqueado solo si valor_mw != null.
      if (tipo === 'REDESP' && v !== null && p < periodoActual) {
        errores.push({ tipo, periodo: p, motivo: 'periodo_bloqueado' });
        continue;
      }
      periodosNorm.push({ periodo: p, valor_mw: v });
    }

    // funcionariocnd: AUTH lo requiere si hay al menos un valor != null. PRUEBA/REDESP → null.
    let funcEff = funcionariocnd;
    if (tipo === 'AUTH') {
      const hayValor = periodosNorm.some((x) => x.valor_mw !== null);
      if (hayValor && (!funcEff || String(funcEff).trim() === '')) {
        errores.push({ tipo, motivo: 'funcionariocnd_requerido' });
      }
      if (funcEff != null && String(funcEff).trim() === '') funcEff = null;
    } else {
      funcEff = null;
    }

    filasNorm.push({
      tipo, detalle: detalle ?? null, funcionariocnd: funcEff, periodos: periodosNorm,
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

    let creados = 0, actualizados = 0, eliminados = 0;
    const erroresFila = [];

    for (const fila of filasNorm) {
      const teInfo = tipoMap[fila.tipo];
      const tipoEventoId = teInfo.tipo_evento_id;
      const dashboardTipo = fila.tipo;
      const eliminadosAntes = eliminados;

      for (const { periodo, valor_mw } of fila.periodos) {
        const existRes = await new sql.Request(transaction)
          .input('mand', sql.Int, MAND_ID)
          .input('planta', sql.VarChar(10), planta_id)
          .input('fecha', sql.Date, fecha)
          .input('periodo', sql.Int, periodo)
          .input('te', sql.Int, tipoEventoId)
          .query(`
            SELECT TOP 1 ra.registro_id, ra.detalle,
                   TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw_old,
                   JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd_old
            FROM bitacora.registro_activo ra
            WHERE ra.bitacora_id = @mand
              AND ra.planta_id = @planta
              AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @fecha
              AND ra.tipo_evento_id = @te
              AND TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT) = @periodo
              AND ra.estado = 'borrador'
            ORDER BY ra.creado_en DESC
          `);
        const existing = existRes.recordset[0];
        const turno = turnoFromPeriodo(periodo);

        if (existing && valor_mw === null) {
          // Caso B: existe + valor null (el operador vació la celda) → se destruye el borrador.
          //
          // D-055: antes hacía `activa=0` y dejaba la fila de evento_dashboard con
          // `registro_origen_id` apuntando a un registro que este mismo statement borraba → HUÉRFANA
          // para siempre. Así nacieron las 35 filas colgadas del 2026-07-06 en prod. No hay FK que
          // lo impida y no puede haberla: el origen VIVE en registro_activo y MIGRA a
          // registro_historico al cerrar el día — dos padres posibles, ninguna FK los cubre. La
          // integridad se sostiene acá y la fija `mand_integridad.test.js`.
          //
          // Se BORRA la fila en vez de desactivarla: su origen deja de existir, y para el dashboard
          // (que filtra activa=1) borrar y desactivar son indistinguibles. El soft-delete sigue
          // siendo correcto en `cerrarDiaMand`, donde el origen NO desaparece — migra al histórico y
          // el puntero sigue resolviendo.
          await new sql.Request(transaction)
            .input('rid', sql.Int, existing.registro_id)
            .query(`
              DELETE FROM bitacora.evento_dashboard WHERE registro_origen_id = @rid;
              DELETE FROM bitacora.registro_activo WHERE registro_id = @rid;
            `);
          eliminados++;
          continue;
        }

        if (existing && valor_mw !== null) {
          // Caso A: existe + valor != null. modificado_por SOLO si valor_mw cambió (regla 2b).
          const valorCambio = (existing.valor_mw_old !== valor_mw);
          const detalleCambio = (existing.detalle ?? null) !== (fila.detalle ?? null);
          const funcCambio = (existing.funcionariocnd_old ?? null) !== (fila.funcionariocnd ?? null);
          if (!valorCambio && !detalleCambio && !funcCambio) continue; // no-op

          const camposExtra = JSON.stringify({
            periodo,
            valor_mw,
            ...(fila.funcionariocnd != null ? { funcionariocnd: fila.funcionariocnd } : { funcionariocnd: null }),
          });
          if (valorCambio) {
            await new sql.Request(transaction)
              .input('rid', sql.Int, existing.registro_id)
              .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
              .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
              .input('mod_por', sql.Int, sesion.usuario_id)
              .query(`
                UPDATE bitacora.registro_activo
                SET detalle = @detalle,
                    campos_extra = @campos_extra,
                    modificado_por = @mod_por,
                    modificado_en = SYSUTCDATETIME()
                WHERE registro_id = @rid
              `);
          } else {
            // Solo cambió detalle/funcionariocnd — actualizamos sin tocar modificado_por.
            await new sql.Request(transaction)
              .input('rid', sql.Int, existing.registro_id)
              .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
              .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
              .query(`
                UPDATE bitacora.registro_activo
                SET detalle = @detalle,
                    campos_extra = @campos_extra
                WHERE registro_id = @rid
              `);
          }

          // UPSERT evento_dashboard. Reusa fila si existía (preserva evento_id).
          await upsertEventoDashboard(transaction, {
            planta_id,
            fecha,
            periodo,
            valor: valor_mw,
            jdts_snapshot,
            jefes_snapshot,
            registro_origen_id: existing.registro_id,
            tipo: dashboardTipo,
          });
          actualizados++;
          continue;
        }

        if (!existing && valor_mw === null) {
          // Caso D: no existe + valor null → no-op.
          continue;
        }

        // Caso C: no existe + valor != null → INSERT registro_activo + UPSERT evento_dashboard.
        const camposExtra = JSON.stringify({
          periodo,
          valor_mw,
          ...(fila.funcionariocnd != null ? { funcionariocnd: fila.funcionariocnd } : { funcionariocnd: null }),
        });
        // D-055: estampar turno_id. MAND era la ÚNICA bitácora que insertaba con turno_id=NULL
        // (la rama genérica de registros.js sí lo estampa) → sus 10 filas de histórico en prod
        // tenían 10/10 NULL, rompiendo todo JOIN por turno. Se resuelve por (planta,
        // fecha_operativa, turno) con `fechaOperativaDePeriodo`, que sabe que los periodos 1..6
        // pertenecen al T2 del día ANTERIOR. Degrada a NULL si la cabecera no existe: la columna es
        // nullable y un registro nunca debe perderse por no poder atarlo a un turno.
        const turnoIdCelda = await resolverTurnoUnidadId(transaction, {
          planta_id, fecha_operativa: fechaOperativaDePeriodo(fecha, periodo), turno,
        });
        const ins = await new sql.Request(transaction)
          .input('mand', sql.Int, MAND_ID)
          .input('planta', sql.VarChar(10), planta_id)
          .input('turno', sql.TinyInt, turno)
          .input('turno_id', sql.Int, turnoIdCelda)
          .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
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
            OUTPUT INSERTED.registro_id
            VALUES (@mand, @planta, SYSUTCDATETIME(), @turno, @detalle, @campos_extra, @te,
                    'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por,
                    @turno_id)
          `);
        const newId = ins.recordset[0].registro_id;
        await upsertEventoDashboard(transaction, {
          planta_id,
          fecha,
          periodo,
          valor: valor_mw,
          jdts_snapshot,
          jefes_snapshot,
          registro_origen_id: newId,
          tipo: dashboardTipo,
        });
        creados++;
      }

      // ── D-055: metadata (detalle / funcionariocnd) a nivel de FILA ────────────────────────
      // `detalle` y `funcionariocnd` son atributos de la fila (tipo × día × planta), pero el modelo
      // los persiste REPLICADOS en cada celda con valor — no tienen storage propio. Antes solo se
      // escribían de refilón, dentro del loop de `periodos`, así que una fila cuyo `periodos` venía
      // vacío no guardaba NADA y el endpoint respondía 200 {creados:0,...}: el front mostraba
      // "Guardado" y el refetch revertía el texto. Se perdía de dos formas reales:
      //   (a) fila sin ningún valor (PRUEBA/REDESP con solo un comentario) → el front no tenía
      //       ninguna celda que propagar;
      //   (b) REDESP con todos sus valores en periodos ya bloqueados (p < periodoActual) → el front
      //       los omitía para no rebotar contra el guard `periodo_bloqueado`.
      // Ahora la metadata se aplica UNA vez sobre TODAS las celdas vivas de la fila, sin pasar por
      // `periodos`: el lock de REDESP protege el VALOR (dato operativo), nunca el comentario.
      // `modificado_por` NO se toca — D-019: solo un cambio de valor_mw marca modificación.
      const metaRes = await new sql.Request(transaction)
        .input('mand', sql.Int, MAND_ID)
        .input('planta', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, fecha)
        .input('te', sql.Int, tipoEventoId)
        .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
        .input('func', sql.NVarChar(sql.MAX), fila.funcionariocnd ?? null)
        .query(`
          UPDATE bitacora.registro_activo
          SET detalle = @detalle,
              campos_extra = JSON_MODIFY(campos_extra, '$.funcionariocnd', @func)
          WHERE bitacora_id = @mand
            AND planta_id = @planta
            AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = @fecha
            AND tipo_evento_id = @te
            AND estado = 'borrador'
            AND (
              ISNULL(detalle, '') <> ISNULL(@detalle, '')
              OR ISNULL(JSON_VALUE(campos_extra, '$.funcionariocnd'), '') <> ISNULL(@func, '')
            )
        `);
      const celdasConMetadata = metaRes.rowsAffected[0] || 0;

      // Si la fila no tiene NINGUNA celda donde anclar el comentario, decirlo en vez de tragárselo.
      // Excepción: si esta fila acaba de borrar celdas, se está vaciando y su comentario queda moot
      // — bloquear ahí impediría el flujo legítimo "limpiar la fila".
      if (celdasConMetadata === 0 && eliminados === eliminadosAntes) {
        const pideMetadata = (fila.detalle != null && String(fila.detalle).trim() !== '')
          || (fila.funcionariocnd != null && String(fila.funcionariocnd).trim() !== '');
        if (pideMetadata) {
          const hayCeldas = await new sql.Request(transaction)
            .input('mand', sql.Int, MAND_ID)
            .input('planta', sql.VarChar(10), planta_id)
            .input('fecha', sql.Date, fecha)
            .input('te', sql.Int, tipoEventoId)
            .query(`
              SELECT COUNT(*) AS n FROM bitacora.registro_activo
              WHERE bitacora_id = @mand AND planta_id = @planta
                AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = @fecha
                AND tipo_evento_id = @te AND estado = 'borrador'
            `);
          if ((hayCeldas.recordset[0]?.n || 0) === 0) {
            erroresFila.push({ tipo: fila.tipo, motivo: 'detalle_sin_celdas' });
          }
        }
      }
      actualizados += celdasConMetadata;
    }

    // Rechazo atómico: si alguna fila quiso guardar un comentario sin celdas, no se commitea nada.
    if (erroresFila.length > 0) {
      await transaction.rollback();
      return sendJSON(res, 400, { errores: erroresFila });
    }

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    // Push cross-repo al dashboard (fire-and-forget) SOLO si algo cambió: evita ruido cuando el
    // guardar fue no-op. Nunca bloquea la respuesta al operador (ver notify-dashboard.js).
    if (creados + actualizados + eliminados > 0) {
      notifyDashboard({ plantas: [planta_id], fecha }).catch(() => {});
    }
    return sendJSON(res, 200, { resumen: { creados, actualizados, eliminados } });
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
