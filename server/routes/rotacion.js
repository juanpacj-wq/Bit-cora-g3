// D-065 · Superficie A — configuración anual de la rotación de turnos. Montado en auth/app.js como
// /api/rotacion, DESPUÉS de requireEntra (nace cerrado, D-037) y con loadAppSession: todo handler
// tiene `req.sesion`.
//
// Gate de escritura: `puede_configurar_rotacion` (lov_bit.cargo, F37.A2), data-driven — nunca por
// nombre de cargo ni por cargo_id (convención 12). NO mira `solo_lectura`: la malla no es una
// bitácora, y el Gerente de Producción configura con solo_lectura = 1 (CA-8).
//
// Fechas: todas viajan como 'YYYY-MM-DD' en día Bogotá (C1); a SQL entran como VARCHAR + CAST y
// salen con CONVERT(..., 23). Ningún `Date` de JS en el camino de persistencia.
//
// Errores: los 4xx de dominio exponen su slug a propósito (el front ramifica por `codigo`, D-032).
// Los seis códigos del motor (C1 + D1 del GATE-O1) se traducen a 400 acá y nunca llegan crudos.
// Todo lo demás sube por asyncH al expressErrorHandler, que ya clasifica `entra_no_disponible`
// como 503 (D2 del GATE-O1).

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { derivarDesfase, diasEntre, parsearVector, serializarVector } from '../utils/rotacion/patron.js';
import { titularesDeTurno } from '../utils/rotacion/titulares.js';
import { sincronizarDirectorio } from '../utils/graph/directorio.js';
import { fechaBogotaStr, getTurnoColombia, ventanaActual } from '../utils/turno.js';

const router = express.Router();
router.use(loadAppSession);

// Vigencia "sin fecha de fin": la asignación sigue hasta que un relevo la cierre. Es un DATE real
// (la columna es NOT NULL) y así "vigente en la fecha X" es siempre un BETWEEN, sin ramas por NULL.
const FECHA_ABIERTA = '9999-12-31';
// Un lote anual son ~81 personas; el tope solo evita un cuerpo absurdo, no limita el uso real.
const MAX_ASIGNACIONES_POR_LOTE = 500;

const MENSAJES = {
  rotacion_no_autorizado: 'Tu cargo no puede configurar la rotación de turnos.',
  vector_invalido: 'Cada vector del patrón debe traer exactamente 8 grupos entre 1 y 4.',
  desfase_imposible: 'Ningún día del ciclo tiene esa combinación de grupos en el turno 1 y el turno 2. Revisa los vectores y los grupos de inicio.',
  desfase_ambiguo: 'Esa combinación de grupos aparece en más de un día del ciclo y el patrón no puede resolverse. Revisa los vectores.',
  turno_invalido: 'El turno debe ser 1 o 2.',
  fecha_invalida: 'La fecha debe tener el formato AAAA-MM-DD y existir en el calendario.',
  patron_invalido: 'El patrón no es válido.',
  grupo_invalido: 'El grupo debe ser un número entero entre 1 y 4.',
  cargo_invalido: 'El cargo indicado no existe.',
  usuario_invalido: 'La persona indicada no existe o no tiene cuenta de Entra: solo se asigna a quien puede iniciar sesión.',
  rango_invalido: 'La fecha de fin debe ser posterior a la fecha de inicio.',
  vigencia_invalida: 'La vigencia debe terminar en la misma fecha en que empieza o después.',
  lote_vacio: 'Envía al menos una asignación.',
  lote_excesivo: `Envía como máximo ${MAX_ASIGNACIONES_POR_LOTE} asignaciones por solicitud.`,
  patron_duplicado: 'Ya existe un patrón para ese cargo con esa misma fecha de inicio.',
  patron_solapado: 'Ya hay un patrón activo para ese cargo que cubre parte de ese periodo.',
  asignacion_conflicto: 'Esa persona ya tiene una asignación que empieza después de la fecha indicada. Corrige primero esa asignación.',
};

// Los seis códigos que lanza el motor (C1 + D1 del GATE-O1)…
const CODIGOS_MOTOR = new Set([
  'vector_invalido', 'desfase_imposible', 'desfase_ambiguo', 'turno_invalido',
  'fecha_invalida', 'patron_invalido',
]);
// …más los de validación de este router y de titulares.js, que viajan igual: Error('slug').
// Cualquier otro Error NO está acá y sube al error-handler global (500 saneado).
const CODIGOS_400 = new Set([
  ...CODIGOS_MOTOR,
  'grupo_invalido', 'cargo_invalido', 'usuario_invalido', 'rango_invalido', 'vigencia_invalida',
  'lote_vacio', 'lote_excesivo',
]);

function responderDominio(res, status, codigo, extra = {}) {
  return sendJSON(res, status, { error: codigo, codigo, mensaje: MENSAJES[codigo] || codigo, ...extra });
}

function esError400(err) {
  return err instanceof Error && CODIGOS_400.has(err.message);
}

// Gate de los tres POST. Mira ÚNICAMENTE el flag del cargo que viaja en la sesión (SELECT_SESION
// de middleware/auth.js y su espejo en utils/sesion-contexto.js). Devuelve false si ya respondió.
function exigeConfigurarRotacion(req, res) {
  if (req.sesion?.puede_configurar_rotacion === true) return true;
  responderDominio(res, 403, 'rotacion_no_autorizado');
  return false;
}

// ── Validación de entrada (lanza Error('slug'); el handler lo vuelve 400) ─────────────────────
function validarFecha(valor) {
  if (typeof valor !== 'string') throw new Error('fecha_invalida');
  diasEntre(valor, valor); // formato + existencia del día, con el criterio estricto del motor
  return valor;
}

function validarEnteroPositivo(valor, codigo) {
  // Acepta el número o su forma string (viene de la query) pero no vacíos ni decimales.
  if (valor == null || valor === '' || typeof valor === 'boolean') throw new Error(codigo);
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new Error(codigo);
  return n;
}

const validarCargoId = (v) => validarEnteroPositivo(v, 'cargo_invalido');
const validarUsuarioId = (v) => validarEnteroPositivo(v, 'usuario_invalido');

// Estricto a propósito (CR-8 del GATE-O1): un "3" en string o un "" no llegan al motor como
// `desfase_imposible` ("esa combinación no existe") sino que se rechazan como entrada inválida.
function validarGrupo(valor) {
  if (!Number.isInteger(valor) || valor < 1 || valor > 4) throw new Error('grupo_invalido');
  return valor;
}

// El cliente puede mandar el vector como '1,1,3,3,4,4,2,2' o como [1,1,3,3,4,4,2,2].
function normalizarVector(valor) {
  if (typeof valor === 'string') return parsearVector(valor);
  if (Array.isArray(valor)) {
    serializarVector(valor); // valida 8 enteros en 1..4
    return valor;
  }
  throw new Error('vector_invalido');
}

// ── Proyecciones compartidas por GET y POST ──────────────────────────────────────────────────
const SELECT_PATRON = `
  SELECT p.rotacion_patron_id, p.cargo_id, c.nombre AS cargo_nombre,
         CONVERT(VARCHAR(10), p.fecha_inicio, 23) AS fecha_inicio,
         CONVERT(VARCHAR(10), p.fecha_fin, 23)    AS fecha_fin,
         p.vector_t1, p.vector_t2, p.desfase, CAST(p.activo AS BIT) AS activo,
         p.creado_por, u.nombre_completo AS creado_por_nombre, p.creado_en, p.creado_en_bogota
  FROM bitacora.rotacion_patron p
  INNER JOIN lov_bit.cargo   c ON c.cargo_id   = p.cargo_id
  INNER JOIN lov_bit.usuario u ON u.usuario_id = p.creado_por`;

// Los vectores salen como arreglos (la BD los guarda como '1,1,3,…') y se agregan los grupos del
// día de inicio: el día del ciclo de `fecha_inicio` es exactamente `desfase`, así que la pantalla
// puede mostrar "arrancó con el grupo X en T1 y el Y en T2", que fue lo que el administrador digitó.
function mapPatron(row) {
  const vector_t1 = parsearVector(row.vector_t1);
  const vector_t2 = parsearVector(row.vector_t2);
  return {
    ...row,
    vector_t1,
    vector_t2,
    grupo_t1: vector_t1[row.desfase],
    grupo_t2: vector_t2[row.desfase],
  };
}

const SELECT_ASIGNACION = `
  SELECT a.rotacion_asignacion_id, a.usuario_id, u.nombre_completo AS nombre,
         CAST(u.activo AS BIT) AS usuario_activo,
         a.cargo_id, c.nombre AS cargo_nombre, a.grupo,
         CONVERT(VARCHAR(10), a.vigente_desde, 23) AS vigente_desde,
         CONVERT(VARCHAR(10), a.vigente_hasta, 23) AS vigente_hasta,
         a.creado_por, a.creado_en, a.creado_en_bogota
  FROM bitacora.rotacion_asignacion a
  INNER JOIN lov_bit.usuario u ON u.usuario_id = a.usuario_id
  INNER JOIN lov_bit.cargo   c ON c.cargo_id   = a.cargo_id`;

// ── GET /api/rotacion/patrones?cargo_id= ─────────────────────────────────────────────────────
// Cualquier sesión. Trae activos e inactivos (con su flag) para que la pantalla muestre el histórico.
router.get('/patrones', asyncH(async (req, res) => {
  let cargoFiltro = null;
  try {
    if (req.query.cargo_id != null && req.query.cargo_id !== '') cargoFiltro = validarCargoId(req.query.cargo_id);
  } catch (err) {
    if (esError400(err)) return responderDominio(res, 400, err.message);
    throw err;
  }
  const pool = await getDB();
  const r = await pool.request()
    .input('cargo_id', sql.Int, cargoFiltro)
    .query(`${SELECT_PATRON}
      WHERE (@cargo_id IS NULL OR p.cargo_id = @cargo_id)
      ORDER BY c.nombre, p.fecha_inicio DESC`);
  return sendJSON(res, 200, { patrones: r.recordset.map(mapPatron) });
}));

// ── POST /api/rotacion/patrones ──────────────────────────────────────────────────────────────
// { cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, grupo_t1, grupo_t2 }
// El desfase se DERIVA con el motor (CA-2). `desfase` y `ancla` NUNCA se leen del cuerpo
// (requerimiento §4): si el cliente los manda, se ignoran.
// 200 { patron } · 403 rotacion_no_autorizado · 400 <slug> · 409 patron_duplicado / patron_solapado
router.post('/patrones', asyncH(async (req, res) => {
  if (!exigeConfigurarRotacion(req, res)) return undefined;
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  let cargo_id;
  let fecha_inicio;
  let fecha_fin;
  let vectorT1;
  let vectorT2;
  let desfase;
  try {
    cargo_id = validarCargoId(body.cargo_id);
    fecha_inicio = validarFecha(body.fecha_inicio);
    fecha_fin = validarFecha(body.fecha_fin);
    if (diasEntre(fecha_inicio, fecha_fin) <= 0) throw new Error('rango_invalido');
    vectorT1 = normalizarVector(body.vector_t1);
    vectorT2 = normalizarVector(body.vector_t2);
    const grupoT1 = validarGrupo(body.grupo_t1);
    const grupoT2 = validarGrupo(body.grupo_t2);
    desfase = derivarDesfase({ vectorT1, vectorT2, grupoT1, grupoT2 });
  } catch (err) {
    if (esError400(err)) return responderDominio(res, 400, err.message);
    throw err;
  }

  const pool = await getDB();
  const cargo = await pool.request()
    .input('cargo_id', sql.Int, cargo_id)
    .query('SELECT cargo_id FROM lov_bit.cargo WHERE cargo_id = @cargo_id');
  if (!cargo.recordset[0]) return responderDominio(res, 400, 'cargo_invalido');

  // Chequeo + INSERT en la misma transacción, con UPDLOCK/HOLDLOCK sobre las filas del cargo:
  // dos POST simultáneos no pueden dejar dos patrones activos sobre las mismas fechas (hueco
  // CR-6 del GATE-O1: la BD no lo impide todavía). Sin un patrón vigente único, "quién debía
  // estar" tendría dos respuestas.
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let conflicto = null;
  let nuevoId = null;
  try {
    const rq = new sql.Request(tx)
      .input('cargo_id', sql.Int, cargo_id)
      .input('inicio', sql.VarChar(10), fecha_inicio)
      .input('fin', sql.VarChar(10), fecha_fin);
    const previos = await rq.query(`
      SELECT TOP 1 rotacion_patron_id,
             CASE WHEN fecha_inicio = CAST(@inicio AS DATE) THEN 'patron_duplicado'
                  ELSE 'patron_solapado' END AS conflicto
      FROM bitacora.rotacion_patron WITH (UPDLOCK, HOLDLOCK)
      WHERE cargo_id = @cargo_id
        AND (fecha_inicio = CAST(@inicio AS DATE)
             OR (activo = 1 AND fecha_inicio <= CAST(@fin AS DATE) AND fecha_fin >= CAST(@inicio AS DATE)))
      ORDER BY CASE WHEN fecha_inicio = CAST(@inicio AS DATE) THEN 0 ELSE 1 END, fecha_inicio DESC
    `);
    if (previos.recordset[0]) {
      conflicto = previos.recordset[0];
    } else {
      const ins = await new sql.Request(tx)
        .input('cargo_id', sql.Int, cargo_id)
        .input('inicio', sql.VarChar(10), fecha_inicio)
        .input('fin', sql.VarChar(10), fecha_fin)
        .input('v1', sql.VarChar(32), serializarVector(vectorT1))
        .input('v2', sql.VarChar(32), serializarVector(vectorT2))
        .input('desfase', sql.TinyInt, desfase)
        .input('creado_por', sql.Int, req.sesion.usuario_id)
        .query(`
          INSERT INTO bitacora.rotacion_patron
            (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
          OUTPUT INSERTED.rotacion_patron_id
          VALUES (@cargo_id, CAST(@inicio AS DATE), CAST(@fin AS DATE), @v1, @v2, @desfase, 1, @creado_por)
        `);
      nuevoId = ins.recordset[0].rotacion_patron_id;
    }
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw err;
  }

  if (conflicto) {
    return responderDominio(res, 409, conflicto.conflicto, { patron_id: conflicto.rotacion_patron_id });
  }
  const creado = await pool.request()
    .input('id', sql.Int, nuevoId)
    .query(`${SELECT_PATRON} WHERE p.rotacion_patron_id = @id`);
  return sendJSON(res, 200, { patron: mapPatron(creado.recordset[0]) });
}));

// ── GET /api/rotacion/asignaciones?cargo_id=&fecha= ──────────────────────────────────────────
// Cualquier sesión. `asignaciones` = las vigentes en `fecha` (hoy Bogotá por defecto).
// `personas` = la nómina asignable: filas de lov_bit.usuario con azure_oid (las únicas que pueden
// iniciar sesión y por tanto aparecer en turno_participante, §2.3) y activas, con el cargo con el
// que entraron por última vez (sesion_activa: lov_bit.usuario NO tiene cargo_id y el directorio de
// Graph no se persiste) y su asignación vigente si la tiene. Sin esto la pantalla de L07 no tiene
// de dónde sacar a quién repartir en los grupos.
router.get('/asignaciones', asyncH(async (req, res) => {
  let cargoFiltro = null;
  let fecha;
  try {
    if (req.query.cargo_id != null && req.query.cargo_id !== '') cargoFiltro = validarCargoId(req.query.cargo_id);
    fecha = req.query.fecha ? validarFecha(req.query.fecha) : fechaBogotaStr(new Date());
  } catch (err) {
    if (esError400(err)) return responderDominio(res, 400, err.message);
    throw err;
  }
  const pool = await getDB();
  const r = await pool.request()
    .input('cargo_id', sql.Int, cargoFiltro)
    .input('fecha', sql.VarChar(10), fecha)
    .query(`
      ${SELECT_ASIGNACION}
      WHERE (@cargo_id IS NULL OR a.cargo_id = @cargo_id)
        AND a.vigente_desde <= CAST(@fecha AS DATE)
        AND a.vigente_hasta >= CAST(@fecha AS DATE)
      ORDER BY c.nombre, a.grupo, u.nombre_completo;

      SELECT u.usuario_id, u.nombre_completo AS nombre,
             s.cargo_id AS ultimo_cargo_id, cs.nombre AS ultimo_cargo_nombre,
             a.rotacion_asignacion_id, a.cargo_id AS asignacion_cargo_id,
             ca.nombre AS asignacion_cargo_nombre, a.grupo,
             CONVERT(VARCHAR(10), a.vigente_desde, 23) AS vigente_desde,
             CONVERT(VARCHAR(10), a.vigente_hasta, 23) AS vigente_hasta
      FROM lov_bit.usuario u
      OUTER APPLY (SELECT TOP 1 sa.cargo_id
                     FROM bitacora.sesion_activa sa
                    WHERE sa.usuario_id = u.usuario_id
                    ORDER BY sa.inicio_sesion DESC) s
      LEFT JOIN lov_bit.cargo cs ON cs.cargo_id = s.cargo_id
      OUTER APPLY (SELECT TOP 1 ra.rotacion_asignacion_id, ra.cargo_id, ra.grupo,
                                ra.vigente_desde, ra.vigente_hasta
                     FROM bitacora.rotacion_asignacion ra
                    WHERE ra.usuario_id = u.usuario_id
                      AND ra.vigente_desde <= CAST(@fecha AS DATE)
                      AND ra.vigente_hasta >= CAST(@fecha AS DATE)
                    ORDER BY ra.vigente_desde DESC, ra.rotacion_asignacion_id DESC) a
      LEFT JOIN lov_bit.cargo ca ON ca.cargo_id = a.cargo_id
      WHERE u.azure_oid IS NOT NULL AND u.activo = 1
        AND (@cargo_id IS NULL OR s.cargo_id = @cargo_id OR a.cargo_id = @cargo_id)
      ORDER BY u.nombre_completo, u.usuario_id;
    `);
  return sendJSON(res, 200, {
    fecha,
    cargo_id: cargoFiltro,
    asignaciones: r.recordsets[0],
    personas: r.recordsets[1],
  });
}));

// ── POST /api/rotacion/asignaciones ──────────────────────────────────────────────────────────
// { asignaciones: [ { usuario_id, cargo_id, grupo, vigente_desde?, vigente_hasta? } ] }
//   · grupo 1..4            → asigna (o releva) a la persona desde `vigente_desde` (hoy Bogotá si falta)
//   · grupo null            → la persona SALE de la rotación desde `vigente_desde` (queda supernumeraria)
//   · vigente_hasta ausente → vigencia abierta (FECHA_ABIERTA), hasta que un relevo la cierre
//
// Un relevo NO reescribe la asignación anterior (CA-9, decisión R1): cierra su `vigente_hasta` al
// día anterior e inserta una fila nueva, las dos cosas en la MISMA transacción. El UPDATE solo mueve
// el fin de la vigencia —nunca usuario_id ni grupo—, que es el mismo patrón del cierre cronológico
// de disponibilidad_estado (D-026): el titular de una fecha pasada no cambia.
//
// Casos que NO son relevo:
//   · misma persona, mismo cargo y mismo grupo ya vigentes → `sin_cambio` (recargar el lote anual
//     con la misma nómina es idempotente y no infla la tabla);
//   · una fila que EMPIEZA el mismo día → se corrige en sitio (`actualizadas`): es el error de
//     digitación del día de carga, no un relevo, y cerrarla un día antes de que empiece es imposible;
//   · una fila que empieza DESPUÉS → 409 asignacion_conflicto: no se insertan asignaciones "por
//     detrás" de una futura.
// Todo el lote es atómico: cualquier 4xx deshace lo hecho y trae el `indice` del elemento que falló.
// 200 { creadas, cerradas, actualizadas, sin_cambio, total } · 403 · 400 · 409
router.post('/asignaciones', asyncH(async (req, res) => {
  if (!exigeConfigurarRotacion(req, res)) return undefined;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const items = Array.isArray(body.asignaciones) ? body.asignaciones : null;
  if (!items || items.length === 0) return responderDominio(res, 400, 'lote_vacio');
  if (items.length > MAX_ASIGNACIONES_POR_LOTE) return responderDominio(res, 400, 'lote_excesivo');

  // Toda la validación de forma ANTES de abrir la transacción: un cuerpo mal formado no toca la BD.
  const hoy = fechaBogotaStr(new Date());
  const pedidos = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] && typeof items[i] === 'object' ? items[i] : {};
    try {
      const usuario_id = validarUsuarioId(item.usuario_id);
      const cargo_id = validarCargoId(item.cargo_id);
      const grupo = item.grupo === null ? null : validarGrupo(item.grupo);
      const desde = item.vigente_desde == null ? hoy : validarFecha(item.vigente_desde);
      const hasta = item.vigente_hasta == null ? FECHA_ABIERTA : validarFecha(item.vigente_hasta);
      if (diasEntre(desde, hasta) < 0) throw new Error('vigencia_invalida');
      pedidos.push({ usuario_id, cargo_id, grupo, desde, hasta });
    } catch (err) {
      if (esError400(err)) return responderDominio(res, 400, err.message, { indice: i });
      throw err;
    }
  }

  const pool = await getDB();
  const conteo = { creadas: 0, cerradas: 0, actualizadas: 0, sin_cambio: 0, total: pedidos.length };
  let rechazo = null; // { status, codigo, extra }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (let i = 0; i < pedidos.length && !rechazo; i += 1) {
      const p = pedidos[i];

      const usuario = await new sql.Request(tx)
        .input('usuario_id', sql.Int, p.usuario_id)
        .query('SELECT usuario_id, azure_oid FROM lov_bit.usuario WHERE usuario_id = @usuario_id');
      if (!usuario.recordset[0] || !usuario.recordset[0].azure_oid) {
        rechazo = { status: 400, codigo: 'usuario_invalido', extra: { indice: i, usuario_id: p.usuario_id } };
        break;
      }
      const cargo = await new sql.Request(tx)
        .input('cargo_id', sql.Int, p.cargo_id)
        .query('SELECT cargo_id FROM lov_bit.cargo WHERE cargo_id = @cargo_id');
      if (!cargo.recordset[0]) {
        rechazo = { status: 400, codigo: 'cargo_invalido', extra: { indice: i, cargo_id: p.cargo_id } };
        break;
      }

      // Las asignaciones de la persona que alcanzan `desde` (en cualquier cargo: si cambió de rol,
      // la del rol viejo también se cierra). UPDLOCK/HOLDLOCK: dos lotes simultáneos sobre la
      // misma persona se serializan en vez de dejar dos vigencias solapadas.
      const previas = await new sql.Request(tx)
        .input('usuario_id', sql.Int, p.usuario_id)
        .input('desde', sql.VarChar(10), p.desde)
        .query(`
          SELECT rotacion_asignacion_id, cargo_id, grupo,
                 CONVERT(VARCHAR(10), vigente_desde, 23) AS vigente_desde,
                 CONVERT(VARCHAR(10), vigente_hasta, 23) AS vigente_hasta
          FROM bitacora.rotacion_asignacion WITH (UPDLOCK, HOLDLOCK)
          WHERE usuario_id = @usuario_id AND vigente_hasta >= CAST(@desde AS DATE)
          ORDER BY vigente_desde
        `);
      const filas = previas.recordset;
      const futura = filas.find((f) => f.vigente_desde > p.desde);
      if (futura) {
        rechazo = {
          status: 409,
          codigo: 'asignacion_conflicto',
          extra: { indice: i, usuario_id: p.usuario_id, asignacion_id: futura.rotacion_asignacion_id },
        };
        break;
      }
      const mismoDia = filas.find((f) => f.vigente_desde === p.desde);
      const vigentes = filas.filter((f) => f.vigente_desde < p.desde);

      const cerrar = async (lista) => {
        for (const f of lista) {
          await new sql.Request(tx)
            .input('id', sql.Int, f.rotacion_asignacion_id)
            .input('desde', sql.VarChar(10), p.desde)
            .query(`
              UPDATE bitacora.rotacion_asignacion
                 SET vigente_hasta = DATEADD(DAY, -1, CAST(@desde AS DATE))
               WHERE rotacion_asignacion_id = @id
            `);
          conteo.cerradas += 1;
        }
      };

      if (p.grupo === null) {
        // Salida de la rotación: solo se cierran vigencias, no se inserta nada.
        if (mismoDia) {
          rechazo = {
            status: 409,
            codigo: 'asignacion_conflicto',
            extra: { indice: i, usuario_id: p.usuario_id, asignacion_id: mismoDia.rotacion_asignacion_id },
          };
          break;
        }
        if (vigentes.length === 0) conteo.sin_cambio += 1;
        await cerrar(vigentes);
        continue;
      }

      if (mismoDia) {
        const igual = mismoDia.cargo_id === p.cargo_id && mismoDia.grupo === p.grupo && mismoDia.vigente_hasta === p.hasta;
        await cerrar(vigentes);
        if (igual) { conteo.sin_cambio += 1; continue; }
        await new sql.Request(tx)
          .input('id', sql.Int, mismoDia.rotacion_asignacion_id)
          .input('cargo_id', sql.Int, p.cargo_id)
          .input('grupo', sql.TinyInt, p.grupo)
          .input('hasta', sql.VarChar(10), p.hasta)
          .input('creado_por', sql.Int, req.sesion.usuario_id)
          .query(`
            UPDATE bitacora.rotacion_asignacion
               SET cargo_id = @cargo_id, grupo = @grupo, vigente_hasta = CAST(@hasta AS DATE),
                   creado_por = @creado_por, creado_en = SYSUTCDATETIME()
             WHERE rotacion_asignacion_id = @id
          `);
        conteo.actualizadas += 1;
        continue;
      }

      const yaIgual = vigentes.length === 1
        && vigentes[0].cargo_id === p.cargo_id
        && vigentes[0].grupo === p.grupo
        && vigentes[0].vigente_hasta === p.hasta;
      if (yaIgual) { conteo.sin_cambio += 1; continue; }

      await cerrar(vigentes);
      await new sql.Request(tx)
        .input('usuario_id', sql.Int, p.usuario_id)
        .input('cargo_id', sql.Int, p.cargo_id)
        .input('grupo', sql.TinyInt, p.grupo)
        .input('desde', sql.VarChar(10), p.desde)
        .input('hasta', sql.VarChar(10), p.hasta)
        .input('creado_por', sql.Int, req.sesion.usuario_id)
        .query(`
          INSERT INTO bitacora.rotacion_asignacion
            (usuario_id, cargo_id, grupo, vigente_desde, vigente_hasta, creado_por)
          VALUES (@usuario_id, @cargo_id, @grupo, CAST(@desde AS DATE), CAST(@hasta AS DATE), @creado_por)
        `);
      conteo.creadas += 1;
    }

    if (rechazo) await tx.rollback();
    else await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw err;
  }

  if (rechazo) return responderDominio(res, rechazo.status, rechazo.codigo, rechazo.extra);
  return sendJSON(res, 200, conteo);
}));

// ── POST /api/rotacion/sincronizar-entra ─────────────────────────────────────────────────────
// Sin cuerpo. Baja el directorio de la Enterprise App a lov_bit.usuario (C3).
// Se llama EXACTAMENTE con `{ por_usuario }` (GATE-O1 §6.5): las opciones `directorio` y
// `fetchImpl` de sincronizarDirectorio existen solo para los tests y jamás pueden venir del
// cliente — nada de req.body ni req.query entra en esta llamada.
// 200 { creados, actualizados, total, por_rol } · 403 · 503 entra_no_disponible (vía errores.js)
router.post('/sincronizar-entra', asyncH(async (req, res) => {
  if (!exigeConfigurarRotacion(req, res)) return undefined;
  const pool = await getDB();
  const resultado = await sincronizarDirectorio(pool, { por_usuario: req.sesion.usuario_id });
  return sendJSON(res, 200, resultado);
}));

// ── GET /api/rotacion/titulares?fecha=&turno=&planta_id=&cargo_id= ───────────────────────────
// Cualquier sesión. Sin `fecha`/`turno` resuelve el turno EN CURSO (la fecha operativa es el día en
// que arrancó, D-055(b): a la 1 a.m. es el T2 de ayer). `planta_id` se acepta por el contrato y se
// devuelve tal cual, pero NO cambia el resultado: el titular es el mismo en GEC3 y GEC32 (R3).
router.get('/titulares', asyncH(async (req, res) => {
  let fecha;
  let turno;
  let cargoFiltro = null;
  try {
    const { inicio } = ventanaActual();
    fecha = req.query.fecha ? validarFecha(req.query.fecha) : fechaBogotaStr(inicio);
    if (req.query.turno == null || req.query.turno === '') {
      turno = getTurnoColombia();
    } else {
      turno = Number(req.query.turno);
      if (turno !== 1 && turno !== 2) throw new Error('turno_invalido');
    }
    if (req.query.cargo_id != null && req.query.cargo_id !== '') cargoFiltro = validarCargoId(req.query.cargo_id);
  } catch (err) {
    if (esError400(err)) return responderDominio(res, 400, err.message);
    throw err;
  }
  const planta_id = typeof req.query.planta_id === 'string' && req.query.planta_id
    ? req.query.planta_id
    : req.sesion.planta_id;

  const pool = await getDB();
  let titulares;
  try {
    titulares = await titularesDeTurno(pool, { fechaOperativa: fecha, turno, cargo_id: cargoFiltro });
  } catch (err) {
    if (esError400(err)) return responderDominio(res, 400, err.message);
    throw err;
  }
  return sendJSON(res, 200, { fecha, turno, planta_id, titulares });
}));

export default router;
