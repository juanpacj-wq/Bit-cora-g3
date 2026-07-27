// Router de Sala de Mando / MAND (E9, AUD-34/35). Captura append-only por lotes (D-056) sobre la
// grilla 3×24 (AUTH|PRUEBA|REDESP) + listado del día en solo lectura + cierre diario manual.
// Montado bajo /api/sala-de-mando tras requireEntra.

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
import { asientoLote } from '../utils/asientos/index.js';
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

// D-057: las N celdas VIVAS de un lote — las filas de `registro_activo` que comparten
// `campos_extra.lote_id` (el lote no tiene tabla propia ni DDL). `ctx` puede ser el pool o una
// transacción; el `PUT`/`DELETE` la llaman SIEMPRE con la transacción, porque el diff se calcula
// contra el estado REAL de la BD y no contra el snapshot que vio el modal (decisión 7): con dos
// personas corrigiendo a la vez la última escritura gana, pero ninguna revive una celda que la otra
// ya borró.
async function resolverLoteVivo(ctx, { lote_id, mand_id }) {
  const r = await new sql.Request(ctx)
    .input('mand', sql.Int, mand_id)
    .input('lote', sql.NVarChar(64), lote_id)
    .query(`
      SELECT ra.registro_id, ra.planta_id, ra.fecha_evento, ra.detalle, ra.tipo_evento_id,
             te.notificar_dashboard_tipo AS tipo,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT)    AS periodo,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
             JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd,
             JSON_VALUE(ra.campos_extra, '$.hora_llamada')   AS hora_llamada
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      WHERE ra.bitacora_id = @mand
        AND ra.estado = 'borrador'
        AND JSON_VALUE(ra.campos_extra, '$.lote_id') = @lote
      ORDER BY ra.registro_id
    `);
  return r.recordset;
}

// D-057 (decisión 10): un lote sin celdas vivas puede estar ARCHIVADO (el cierre diario lo migró a
// `registro_historico`, inmutable por RF-032) o no haber existido nunca. La distinción importa: el
// `409 lote_cerrado` le dice al front "refrescá el listado, el día se cerró" y el `404
// lote_inexistente` "esto ya no está". Nunca se corrige el histórico.
async function loteEstaArchivado(ctx, { lote_id, mand_id }) {
  const r = await new sql.Request(ctx)
    .input('mand', sql.Int, mand_id)
    .input('lote', sql.NVarChar(64), lote_id)
    .query(`
      SELECT TOP 1 1 AS existe
      FROM bitacora.registro_historico
      WHERE bitacora_id = @mand AND JSON_VALUE(campos_extra, '$.lote_id') = @lote
    `);
  return r.recordset.length > 0;
}

// D-057: resolución + los cuatro desenlaces de error del `PUT`/`DELETE`, en un solo lugar para que
// las dos rutas respondan idéntico. Devuelve `{ filas }` o `{ error: { status, cuerpo } }`.
// El 403 de otra planta va DESPUÉS de resolver: nunca se revela el contenido de otra unidad, pero
// tampoco se confunde "no es tuyo" con "no existe".
async function resolverLoteParaEscritura(ctx, { lote_id, mand_id, planta_id }) {
  const filas = await resolverLoteVivo(ctx, { lote_id, mand_id });
  if (filas.length === 0) {
    if (await loteEstaArchivado(ctx, { lote_id, mand_id })) {
      return { error: { status: 409, cuerpo: {
        error: 'El día ya se cerró: este registro pasó al histórico y no se puede corregir.',
        codigo: 'lote_cerrado',
      } } };
    }
    return { error: { status: 404, cuerpo: {
      error: 'El registro ya no existe. Actualiza el listado.',
      codigo: 'lote_inexistente',
    } } };
  }
  if (filas.some((f) => f.planta_id !== planta_id)) {
    return { error: { status: 403, cuerpo: {
      error: 'El registro pertenece a otra unidad.',
      codigo: 'lote_de_otra_planta',
    } } };
  }
  return { filas };
}

// D-058 — asiento normalizado de un lote para el LISTADO del día (REQ-04 §8.1).
//
// El motor LANZA ante un tipo desconocido y eso está bien donde el texto se PERSISTE (el reflejo a
// Sala): publicar un renglón en blanco en el histórico es peor que fallar. Acá, en cambio, se degrada
// a `null` y se loguea: este endpoint es el único lugar donde el operador ve lo que registró hoy, y
// `notificar_dashboard_tipo` es NULLABLE —`db.js` anticipa explícitamente "tipos que NO notifican"—,
// así que un tipo MAND nuevo dejaría el día ENTERO en blanco con un 500. Se pierde un renglón, no la
// jornada; el front pinta el resto de las columnas igual.
function asientoDeLote(lote, planta_id) {
  try {
    return asientoLote({
      tipo: lote.tipo,
      planta_id,
      periodos: lote.periodos,
      funcionariocnd: lote.funcionariocnd,
      detalle: lote.detalle,
    });
  } catch (e) {
    console.warn(`[mand] asiento no renderizable para el lote ${lote.lote_id}:`, e?.message ?? e);
    return null;
  }
}

// D-056: acá vivía el pivote `GET /api/sala-de-mando` — devolvía la grilla 3×24 con UN valor por
// celda (desempatando "el más reciente gana") para que el front la pintara como espejo editable.
// Se dio de baja junto con `getGrilla`: la grilla ya no refleja lo guardado (es un formulario de
// captura append-only) y el modelo dejó de tener "un valor por celda" — varios lotes coexisten para
// el mismo (tipo, periodo, día, planta). Lo registrado se consulta por `GET /lotes`.

// GET /api/sala-de-mando/lotes?planta_id=&fecha=
// Listado del día agrupado por LOTE (D-056 §5). Solo lectura: con la grilla convertida en formulario
// de captura (nace vacía y no refleja lo guardado), este endpoint es el único lugar donde el operador
// ve lo que ya registró. Fuente: SOLO `registro_activo` — el día en curso; el histórico del día
// anterior vive en el apartado de REQ-04, no acá (RQ-04.4 / RN-04.e).
//
// Lo ve cualquier cargo con `puede_ver` en MAND: consultar lo registrado no es escribirlo, así que
// NO se exige `puede_crear` (RN-04.f). El permiso sale de la matriz data-driven, nunca del cargo.
router.get('/lotes', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const planta_id = req.query.planta_id;
  if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
  // D-055: sin allowlist de plantas. `plantaMatch` acota a la unidad de la sesión.
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
  }
  // `fecha` es opcional: por defecto, el día Bogotá en curso (D-020).
  const fecha = (req.query.fecha == null || req.query.fecha === '')
    ? fechaBogotaStr(Date.now())
    : String(req.query.fecha);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return sendJSON(res, 400, { error: 'fecha debe venir en formato YYYY-MM-DD' });
  }

  const db = await getDB();
  const bit = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo = 'MAND'`);
  const MAND_ID = bit.recordset[0]?.bitacora_id;
  if (!MAND_ID) {
    console.error('[ERROR] config: bitácora MAND no encontrada en lov_bit.bitacora');
    return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  }
  if (!(await hasPermisoBitacora(sesion, MAND_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para consultar MAND' });
  }

  // `publicado` sale de un LEFT JOIN a evento_dashboard por `registro_origen_id`. Es un INDICADOR
  // DERIVADO, no un control: no se convierte en filtro, ni en parámetro, ni en acción. Existe para
  // poder detectar en producción —sin abrir la BD ni el dashboard— una implementación "por lote" de
  // la regla de publicación, que es por CELDA (D-056 §3): con dos lotes solapados parcialmente, el
  // flag tiene que caer en unas celdas de un lote y en otras del otro.
  const r = await db.request()
    .input('mand', sql.Int, MAND_ID)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('fecha', sql.Date, fecha)
    .query(`
      SELECT ra.registro_id, ra.detalle, ra.creado_en, ra.creado_por,
             te.notificar_dashboard_tipo AS tipo,
             te.nombre AS tipo_nombre,
             u.nombre_completo AS creado_por_nombre,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT)    AS periodo,
             TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
             JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd,
             JSON_VALUE(ra.campos_extra, '$.lote_id')        AS lote_id,
             JSON_VALUE(ra.campos_extra, '$.hora_llamada')   AS hora_llamada,
             CASE WHEN ed.evento_id IS NULL THEN 0 ELSE 1 END AS publicado
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
      LEFT JOIN lov_bit.usuario u ON u.usuario_id = ra.creado_por
      LEFT JOIN bitacora.evento_dashboard ed
             ON ed.registro_origen_id = ra.registro_id AND ed.activa = 1
      WHERE ra.bitacora_id = @mand
        AND ra.planta_id = @planta_id
        AND ra.estado = 'borrador'
        AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @fecha
      ORDER BY ra.registro_id
    `);

  // Agrupación por lote_id. La metadata (hora, funcionario, descripción, autor) se deriva ASUMIENDO
  // COHERENCIA del lote: se toma de la primera celda del grupo, sin el desempate ad-hoc "el primero
  // no-nulo gana" que hacía el pivote viejo. Si la metadata divergiera dentro de un lote, acá se
  // nota — para eso está el guard de coherencia de E3, no para taparlo con un fallback.
  // Los registros que migró F32.A1 tienen su propio lote_id (uno por fila) y `hora_llamada` ausente:
  // aparecen como lotes de un solo periodo con `hora_llamada: null`.
  const porLote = new Map();
  for (const row of r.recordset) {
    if (!row.lote_id) continue; // sin lote_id no hay agrupación posible (no debería quedar ninguno)
    let lote = porLote.get(row.lote_id);
    if (!lote) {
      lote = {
        lote_id: row.lote_id,
        tipo: row.tipo,
        tipo_nombre: row.tipo_nombre,
        hora_llamada: row.hora_llamada ?? null,
        funcionariocnd: row.funcionariocnd ?? null,
        detalle: row.detalle ?? null,
        creado_en: row.creado_en,
        creado_por: { usuario_id: row.creado_por, nombre_completo: row.creado_por_nombre ?? null },
        periodos: [],
      };
      porLote.set(row.lote_id, lote);
    }
    lote.periodos.push({
      periodo: row.periodo,
      valor_mw: row.valor_mw,
      registro_id: row.registro_id,
      publicado: row.publicado === 1,
    });
  }

  // Orden: lo recién registrado arriba (hora_llamada DESC, los sin hora al final, desempate por
  // creado_en DESC). El orden definitivo de la presentación lo fija D-057 (RN-04.a).
  const lotes = [...porLote.values()];
  for (const lote of lotes) {
    lote.periodos.sort((a, b) => a.periodo - b.periodo);
    // D-058: el texto lo arma el BACKEND y el front solo lo pinta (respuesta 6). El mismo asiento
    // alimenta este renglón, la copia reflejada a las bitácoras de Sala (REQ-02) y la columna
    // DESCRIPCIÓN del libro F03 (REQ-06): una sola implementación es lo único que garantiza que no
    // diverjan. La hora NO va adentro — `hora_llamada` viaja aparte y cada consumidor la ubica en su
    // columna—, así que un lote migrado por F32.A1 (sin hora) igual tiene su asiento.
    lote.asiento = asientoDeLote(lote, planta_id);
  }
  lotes.sort((a, b) => {
    if ((a.hora_llamada == null) !== (b.hora_llamada == null)) return a.hora_llamada == null ? 1 : -1;
    if (a.hora_llamada != null && a.hora_llamada !== b.hora_llamada) {
      return a.hora_llamada < b.hora_llamada ? 1 : -1;
    }
    return new Date(b.creado_en).getTime() - new Date(a.creado_en).getTime();
  });

  return sendJSON(res, 200, { planta_id, fecha, lotes });
}));

// Formato de la hora de la llamada tal como la manda el front (`<input type="time">`): HH:mm en
// wallclock Bogotá. El instante se compone en el SERVIDOR (nunca se confía en el reloj del cliente).
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Tolerancia hacia el futuro para `hora_llamada`. Absorbe el desfase entre el reloj del navegador
// (que precarga el campo) y el del servidor; no habilita registrar llamadas futuras.
const TOLERANCIA_HORA_MS = 5 * 60 * 1000;

// Periodo actual = floor(hora_bogota) + 1 (D-020: offset puro -5h, sin DST). Es el umbral del lock
// de REDESP, tanto en la captura como en la corrección.
function periodoActualBogota(nowMs) {
  return new Date(nowMs - 5 * 3600 * 1000).getUTCHours() + 1;
}

// PUT /api/sala-de-mando/lotes/:lote_id — CORRECCIÓN de un lote ya registrado (D-057).
// Body: { planta_id, hora, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }
//
// Contracara de la captura append-only de D-056: la grilla registra y nunca edita, así que la única
// forma de arreglar un error de digitación es acá, sobre el listado del día. El TIPO no viaja en el
// body — es INMUTABLE (decisión 11): equivocarse de tipo se arregla borrando el lote y volviéndolo a
// registrar, no moviendo `tipo_evento_id` (tocaría dos claves del dashboard y el guard de coherencia
// tipo_evento↔bitácora de D-053).
//
// El diff es QUIRÚRGICO (decisión 1), nunca DELETE+INSERT del lote entero: conserva `lote_id`,
// `registro_id`, `creado_por` y `creado_en` de las celdas que sobreviven. Reinsertar dejaría
// huérfano `evento_dashboard.registro_origen_id`, que NO tiene FK posible (el origen migra entre
// `registro_activo` y `registro_historico`, D-055 (c)).
//
// Gate: `puede_crear` en MAND (matriz data-driven) + `plantaMatch`. SIN chequeo de `creado_por` —
// esta es la excepción a D-049, y es acotada a MAND por construcción: MAND no pasa por
// `canEditarRegistro`, tiene endpoints propios. Corregir Operación 24h es colaborativo por diseño
// (el turno entrante corrige lo que dejó mal el saliente). Tampoco hay gate de turno: MAND está
// exento de `turno_finalizado`/`turno_cerrado`/`turno_en_transicion` (D-040/D-045/D-046).
router.put('/lotes/:lote_id', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const lote_id = String(req.params.lote_id ?? '');
  const { planta_id, hora, detalle, funcionariocnd, periodos } = req.body || {};

  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  // D-055: sin allowlist de plantas. `plantaMatch` acota a la unidad de la sesión.
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede corregir registros de otra planta' });
  }
  // Un `lote_id` fuera de rango no puede existir: se corta antes de ir a la BD (y sin revelar más).
  if (lote_id === '' || lote_id.length > 64) {
    return sendJSON(res, 404, { error: 'El registro ya no existe. Actualiza el listado.', codigo: 'lote_inexistente' });
  }
  if (!Array.isArray(periodos)) {
    return sendJSON(res, 400, { error: 'periodos debe ser un array' });
  }

  const db = await getDB();
  const bit = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo = 'MAND'`);
  const MAND_ID = bit.recordset[0]?.bitacora_id;
  if (!MAND_ID) {
    console.error('[ERROR] config: bitácora MAND no encontrada en lov_bit.bitacora');
    return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  }
  if (!(await hasPermisoBitacora(sesion, MAND_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para corregir registros de MAND' });
  }

  const nowMs = Date.now();
  const transaction = new sql.Transaction(db);
  await transaction.begin();
  try {
    const resuelto = await resolverLoteParaEscritura(transaction, { lote_id, mand_id: MAND_ID, planta_id });
    if (resuelto.error) {
      await transaction.rollback();
      return sendJSON(res, resuelto.error.status, resuelto.error.cuerpo);
    }
    const filas = resuelto.filas;

    // Invariantes del lote: los aporta la BD, no el cliente. `fecha` es el día Bogotá del lote y
    // gobierna TODO — la validación de la hora, el `fecha_evento` que heredan las celdas nuevas y la
    // clave de `recalcularEventoDashboard`. Jamás "hoy": un lote se corrige dentro de su propio día.
    const tipo = filas[0].tipo;
    const tipoEventoId = filas[0].tipo_evento_id;
    const fechaEvento = filas[0].fecha_evento;
    const fecha = fechaBogotaStr(fechaEvento);
    if (!tipo || !['AUTH', 'PRUEBA', 'REDESP'].includes(tipo)) {
      await transaction.rollback();
      console.error('[ERROR] config: lote MAND sin notificar_dashboard_tipo válido:', lote_id);
      return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
    }

    const horaAnterior = filas[0].hora_llamada ?? null;
    const detalleAnterior = filas[0].detalle ?? null;
    const funcAnterior = filas[0].funcionariocnd ?? null;

    // ── Validaciones de negocio (acumulan, NO escriben si hay alguna) ────────────────────────────
    // Mismo contrato que `POST /guardar`: los errores de CELDA llevan `periodo`, los del LOTE no.
    const errores = [];
    const entrantes = new Map(); // periodo → valor_mw
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
      // Celda sin valor = celda que el operador vació en el modal: no viaja al diff y por lo tanto
      // se BORRA por ausencia (mismo criterio que el POST, que simplemente la omite).
      if (v === null) continue;
      // Dos veces el mismo periodo hace el diff ambiguo (¿cuál valor gana?): se rechaza en vez de
      // adivinar — "nunca un 200 mentiroso" (D-055).
      if (entrantes.has(p)) {
        errores.push({ tipo, periodo: p, motivo: 'periodo_duplicado' });
        continue;
      }
      entrantes.set(p, v);
    }
    const huboErrorDeCelda = errores.length > 0;

    // Hora de la llamada: se recompone SERVER-SIDE contra la fecha DEL LOTE (no contra hoy) con la
    // misma tolerancia que la captura. Es el criterio de desempate de la publicación, así que
    // cambiarla es un cambio con consecuencias — por eso se revalida entera.
    const horaTxt = hora == null ? '' : String(hora).trim();
    let horaIso = null;
    if (horaTxt === '') {
      errores.push({ tipo, motivo: 'hora_requerida' });
    } else if (!RE_HORA.test(horaTxt)) {
      errores.push({ tipo, motivo: 'hora_invalida' });
    } else {
      const horaLlamada = new Date(`${fecha}T${horaTxt}:00.000-05:00`);
      if (Number.isNaN(horaLlamada.getTime()) || fechaBogotaStr(horaLlamada) !== fecha) {
        errores.push({ tipo, motivo: 'hora_invalida' });
      } else if (horaLlamada.getTime() > nowMs + TOLERANCIA_HORA_MS) {
        errores.push({ tipo, motivo: 'hora_futura' });
      } else {
        horaIso = horaLlamada.toISOString();
      }
    }

    // funcionariocnd (D-018): AUTH lo exige; PRUEBA y REDESP lo fuerzan a NULL en silencio.
    let funcEff = null;
    if (tipo === 'AUTH') {
      funcEff = (funcionariocnd != null && String(funcionariocnd).trim() !== '') ? String(funcionariocnd) : null;
      if (funcEff == null) errores.push({ tipo, motivo: 'funcionariocnd_requerido' });
    }

    const detalleEff = (detalle != null && String(detalle).trim() !== '') ? String(detalle) : null;

    // Lock REDESP SOBRE EL DELTA (decisión 3): protege el VALOR ya despachado, jamás el comentario.
    // Rebota si un periodo pasado cambia de valor, se agrega o se quita (quitarlo retira lo
    // publicado = cambio de valor). Un periodo pasado IDÉNTICO pasa, y hora/funcionario/descripción
    // pasan siempre. Solo REDESP: AUTH y PRUEBA no tienen lock (D-016).
    const actuales = new Map(); // periodo → fila viva
    for (const f of filas) if (Number.isInteger(f.periodo)) actuales.set(f.periodo, f);
    if (tipo === 'REDESP') {
      const periodoActual = periodoActualBogota(nowMs);
      const afectados = [...new Set([...actuales.keys(), ...entrantes.keys()])].sort((a, b) => a - b);
      for (const p of afectados) {
        if (p >= periodoActual) continue;
        const antes = actuales.has(p) ? actuales.get(p).valor_mw : null;
        const ahora = entrantes.has(p) ? entrantes.get(p) : null;
        if (antes !== ahora) errores.push({ tipo, periodo: p, motivo: 'periodo_bloqueado' });
      }
    }

    // Vaciar ≠ borrar (decisión 6): un lote sin celdas no se persiste ni se interpreta como baja —
    // borrar es el DELETE explícito y confirmado. No se sepulta bajo un error de celda ya explícito.
    if (entrantes.size === 0 && !huboErrorDeCelda) {
      errores.push({ tipo, motivo: 'lote_sin_celdas' });
    }

    if (errores.length > 0) {
      await transaction.rollback();
      return sendJSON(res, 400, { errores });
    }

    // ── Diff quirúrgico, todo dentro de esta transacción ─────────────────────────────────────────
    const celdasTocadas = new Map(); // `${tipo}|${periodo}` → { tipo, periodo } (dedupe del recálculo)
    const marcar = (periodo) => celdasTocadas.set(`${tipo}|${periodo}`, { tipo, periodo });
    let actualizados = 0;
    let creados = 0;
    let eliminados = 0;

    // (1) Periodos que ya no vienen → DELETE. Acotado por `registro_id` (PK): no puede alcanzar
    //     ninguna fila que este mismo request no haya leído (regla D-055).
    for (const [p, fila] of actuales) {
      if (entrantes.has(p)) continue;
      await new sql.Request(transaction)
        .input('registro_id', sql.Int, fila.registro_id)
        .query(`DELETE FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
      eliminados++;
      marcar(p);
    }

    // (2) Periodos nuevos → INSERT con el MISMO `lote_id`. `fecha_evento` se HEREDA del lote
    //     (decisión 9): así el lote nunca se parte entre dos días Bogotá, aunque la corrección
    //     ocurra horas después. Que ese instante quede "en el pasado" es correcto — `fecha_evento`
    //     identifica el DÍA del lote, no el momento de escritura (eso vive en `modificado_*`).
    const nuevos = [...entrantes.entries()].filter(([p]) => !actuales.has(p));
    if (nuevos.length > 0) {
      const reqFactory = () => new sql.Request(transaction);
      const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
      const jefes_snapshot = await snapshotJefes(reqFactory);
      const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });
      if (jefes_snapshot === '[]') {
        await transaction.rollback();
        return sendJSON(res, 409, { error: 'No hay un Jefe de Planta activo en el sistema. No se puede registrar hasta que se asigne uno.', codigo: 'sin_jefe_planta' });
      }
      for (const [periodo, valor_mw] of nuevos) {
        const turno = turnoFromPeriodo(periodo);
        // D-055 (b): el turno sale del PERIODO, nunca del instante de la corrección — los periodos
        // 1..6 de la grilla del día F son del T2 que arrancó a las 18:00 de F-1.
        const turnoIdCelda = await resolverTurnoUnidadId(transaction, {
          planta_id, fecha_operativa: fechaOperativaDePeriodo(fecha, periodo), turno,
        });
        const camposExtra = JSON.stringify({
          periodo, valor_mw, funcionariocnd: funcEff, lote_id, hora_llamada: horaIso,
        });
        await new sql.Request(transaction)
          .input('mand', sql.Int, MAND_ID)
          .input('planta', sql.VarChar(10), planta_id)
          .input('fecha_evento', sql.DateTime2, fechaEvento)
          .input('turno', sql.TinyInt, turno)
          .input('turno_id', sql.Int, turnoIdCelda)
          .input('detalle', sql.NVarChar(sql.MAX), detalleEff)
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
            VALUES (@mand, @planta, @fecha_evento, @turno, @detalle, @campos_extra, @te,
                    'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por,
                    @turno_id)
          `);
        creados++;
        marcar(periodo);
      }
    }

    // (3) Celdas que SOBREVIVEN: valor (si cambió) + metadata del lote.
    //     La metadata (hora, funcionario, descripción) vive REPLICADA en cada celda y no tiene
    //     storage propio, así que se aplica recorriendo las celdas VIVAS del lote — no el delta de
    //     periodos. Es la lección de D-055 (a): aplicarla dentro del loop del delta perdía el
    //     comentario en silencio cuando ningún valor cambiaba o cuando el lock de REDESP dejaba
    //     todos los periodos intactos. `campos_extra` se RECOMPONE entero (en vez de JSON_MODIFY)
    //     para garantizar el mismo shape que escribe el POST: JSON_MODIFY en modo lax BORRA la
    //     clave cuando el valor es NULL, y `funcionariocnd: null` desaparecería del JSON.
    const cambioHora = horaIso !== horaAnterior;
    const cambioMetadata = cambioHora
      || detalleEff !== detalleAnterior
      || funcEff !== funcAnterior;
    for (const [p, fila] of actuales) {
      if (!entrantes.has(p)) continue; // ya se borró en (1)
      const valorNuevo = entrantes.get(p);
      const cambioValor = fila.valor_mw !== valorNuevo;
      // D-019 rige la CAPTURA (donde `modificado_por` solo lo movía el valor); en la corrección
      // deliberada cualquier cambio queda atribuido, porque la hora decide qué lote se publica al
      // dashboard (decisión 2). Solo se sella la celda AFECTADA, no todo el lote.
      const sella = cambioValor || cambioMetadata;
      const camposExtra = JSON.stringify({
        periodo: p, valor_mw: valorNuevo, funcionariocnd: funcEff, lote_id, hora_llamada: horaIso,
      });
      await new sql.Request(transaction)
        .input('registro_id', sql.Int, fila.registro_id)
        .input('detalle', sql.NVarChar(sql.MAX), detalleEff)
        .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
        .input('sella', sql.Bit, sella ? 1 : 0)
        .input('modificado_por', sql.Int, sesion.usuario_id)
        .query(`
          UPDATE bitacora.registro_activo
          SET detalle = @detalle,
              campos_extra = @campos_extra,
              modificado_por = CASE WHEN @sella = 1 THEN @modificado_por ELSE modificado_por END,
              modificado_en  = CASE WHEN @sella = 1 THEN SYSUTCDATETIME() ELSE modificado_en END
          WHERE registro_id = @registro_id
        `);
      if (cambioValor) {
        actualizados++;
        marcar(p);
      }
    }

    // Cambiar la HORA reordena la competencia de TODAS las celdas del lote, no solo las que el diff
    // tocó: es el primer criterio de desempate de `recalcularEventoDashboard`. Las borradas y las
    // creadas ya están marcadas; acá entran las que sobrevivieron sin cambiar de valor.
    if (cambioHora) for (const p of entrantes.keys()) marcar(p);

    // Publicación al dashboard: el vigente de cada celda tocada se resuelve DESDE CERO, por CELDA y
    // nunca por lote (D-056 §3) — los lotes se solapan PARCIALMENTE. Acá es donde el publicado
    // RETROCEDE al lote anterior en las celdas que este diff quitó, o desaparece si no queda ninguno.
    for (const { tipo: t, periodo } of celdasTocadas.values()) {
      await recalcularEventoDashboard(transaction, { planta_id, fecha, periodo, tipo: t });
    }

    // REQ-02 / RQ-04.14 — punto de enganche de la CASCADA a las copias de SALAJDT/SALAING: cuando
    // esas copias existan, su corrección va acá, dentro de esta misma transacción (mismo diff, mismo
    // todo-o-nada). Hoy no existen, así que no hay código que ejecutar: ni muerto, ni tras un flag.

    await transaction.commit();
    if (creados + eliminados > 0) broadcastConteoBitacoras(planta_id).catch(() => {});
    // Push cross-repo fire-and-forget, SOLO si la publicación pudo moverse. Nunca dentro de la
    // transacción (ver notify-dashboard.js).
    if (celdasTocadas.size > 0) notifyDashboard({ plantas: [planta_id], fecha }).catch(() => {});

    return sendJSON(res, 200, {
      lote_id,
      resumen: { actualizados, creados, eliminados, celdas_recalculadas: celdasTocadas.size },
    });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

// DELETE /api/sala-de-mando/lotes/:lote_id?planta_id= — BORRADO REAL de un lote (D-057).
//
// `planta_id` viaja por query string: un DELETE no lleva body fiable (fetch lo permite, pero
// proxies e intermediarios pueden descartarlo).
//
// Borrado REAL, no anulación (RN-04.c): en MAND no existe el concepto de "registro anulado visible"
// que sí tiene DISP — el listado del día muestra lo que hay que llamar al CND, y un renglón tachado
// ahí no informa, confunde. La trazabilidad de lo borrado vive en el histórico del día cuando el
// cierre diario lo archiva; un lote borrado antes del cierre simplemente nunca existió para el
// dashboard.
//
// EL LOCK DE REDESP NO APLICA ACÁ, y es una decisión explícita (no un olvido): el lock protege el
// VALOR de un periodo ya despachado contra una reescritura silenciosa, pero borrar el lote es la
// corrección de un registro ERRADO. Si el lock aplicara, un redespacho mal digitado quedaría
// publicado para siempre en cuanto pasara su hora — exactamente el problema que REQ-04 vino a
// resolver. El `PUT` sí lo aplica sobre el delta, porque ahí sí hay reescritura de valor.
//
// Mismo gate que el `PUT`: `puede_crear` en MAND (matriz data-driven) + `plantaMatch`, sin chequeo
// de `creado_por` (excepción a D-049, acotada a MAND) y sin gate de turno (MAND exento de
// `turno_finalizado`/`turno_cerrado`/`turno_en_transicion`).
router.delete('/lotes/:lote_id', asyncH(async (req, res) => {
  const sesion = req.sesion;
  const lote_id = String(req.params.lote_id ?? '');
  const planta_id = req.query.planta_id;

  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }
  // D-055: sin allowlist de plantas. `plantaMatch` acota a la unidad de la sesión.
  if (!plantaMatch(sesion, planta_id)) {
    return sendJSON(res, 403, { error: 'No puede borrar registros de otra planta' });
  }
  if (lote_id === '' || lote_id.length > 64) {
    return sendJSON(res, 404, { error: 'El registro ya no existe. Actualiza el listado.', codigo: 'lote_inexistente' });
  }

  const db = await getDB();
  const bit = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo = 'MAND'`);
  const MAND_ID = bit.recordset[0]?.bitacora_id;
  if (!MAND_ID) {
    console.error('[ERROR] config: bitácora MAND no encontrada en lov_bit.bitacora');
    return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
  }
  if (!(await hasPermisoBitacora(sesion, MAND_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para borrar registros de MAND' });
  }

  const transaction = new sql.Transaction(db);
  await transaction.begin();
  try {
    // Mismos cuatro desenlaces que el `PUT`, resueltos DENTRO de la transacción: 404 si nunca
    // existió, 409 si el cierre diario ya lo archivó (el histórico no se corrige, RF-032), 403 si es
    // de otra unidad.
    const resuelto = await resolverLoteParaEscritura(transaction, { lote_id, mand_id: MAND_ID, planta_id });
    if (resuelto.error) {
      await transaction.rollback();
      return sendJSON(res, resuelto.error.status, resuelto.error.cuerpo);
    }
    const filas = resuelto.filas;

    // Las celdas que el lote ocupaba, capturadas ANTES de borrarlo — después ya no hay de dónde
    // leerlas. La clave incluye la `fecha` de CADA fila (no la del lote): `recalcularEventoDashboard`
    // se identifica por `(planta, fecha, periodo, tipo)`, y aunque un lote no se parte entre dos días
    // por construcción (el `PUT` hereda `fecha_evento`), derivarla por fila hace el recálculo
    // independiente de esa invariante.
    const celdas = new Map();
    for (const f of filas) {
      if (!Number.isInteger(f.periodo) || !f.tipo) continue;
      const fecha = fechaBogotaStr(f.fecha_evento);
      celdas.set(`${fecha}|${f.tipo}|${f.periodo}`, { fecha, tipo: f.tipo, periodo: f.periodo });
    }

    // Borrado acotado por PK (`registro_id`), con los ids bindeados acá mismo: no puede alcanzar
    // ninguna fila que este request no haya leído. Nunca por `planta_id` ni por `lote_id` suelto
    // (regla D-055 — la suite corre contra la BD productiva).
    const del = new sql.Request(transaction);
    const params = filas.map((f, i) => {
      del.input(`r${i}`, sql.Int, f.registro_id);
      return `@r${i}`;
    });
    const res_del = await del.query(
      `DELETE FROM bitacora.registro_activo WHERE registro_id IN (${params.join(', ')})`,
    );
    const eliminados = res_del.rowsAffected[0] ?? filas.length;

    // Acá se materializa el criterio 10: cada celda liberada se resuelve DESDE CERO. Si otro lote la
    // cubría, ese pasa a publicar (el vigente RETROCEDE); si no queda ninguno, la fila de
    // `evento_dashboard` se ELIMINA — nunca `activa=0`, porque su origen dejó de existir y el
    // puntero quedaría huérfano (`registro_origen_id` no tiene FK posible, D-055 (c)).
    for (const { fecha, tipo, periodo } of celdas.values()) {
      await recalcularEventoDashboard(transaction, { planta_id, fecha, periodo, tipo });
    }

    // REQ-02 / RQ-04.14 — punto de enganche de la CASCADA a las copias de SALAJDT/SALAING: cuando
    // esas copias existan, su borrado va acá, dentro de esta misma transacción. Hoy no existen, así
    // que no hay código que ejecutar: ni muerto, ni tras un flag.

    await transaction.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});
    // Push cross-repo fire-and-forget, una vez por día tocado. Nunca dentro de la transacción.
    for (const fecha of new Set([...celdas.values()].map((c) => c.fecha))) {
      notifyDashboard({ plantas: [planta_id], fecha }).catch(() => {});
    }

    return sendJSON(res, 200, {
      lote_id,
      resumen: { eliminados, celdas_recalculadas: celdas.size },
    });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}));

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
  const hoyStr = fechaBogotaStr(nowMs);
  if (fecha !== hoyStr) {
    return sendJSON(res, 400, {
      errores: [{ motivo: 'fecha_no_es_hoy', mensaje: `fecha debe ser hoy (${hoyStr} en zona Bogotá)` }],
    });
  }

  // Periodo actual = floor(hora_bogota_now) + 1. Se usa para validar el lock REDESP. Misma fuente
  // que el lock de la corrección (D-057), para que captura y corrección no puedan divergir.
  const periodoActual = periodoActualBogota(nowMs);

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
