// Router de contexto de sesión de app (E10, AUD-34/35). Montado bajo /api/auth tras requireEntra.
//   - POST /select-context: CREA la sesión de app (sesion_activa) tras elegir planta. Solo necesita
//     identidad Entra (req.session.user) — NO loadAppSession (la sesión aún no existe).
//   - POST /cambiar-unidad: cambia la unidad EN CALIENTE (D-054). Exige sesión de app YA existente
//     (loadAppSession) + permiso de cargo `puede_cambiar_unidad`.
//   - POST /cerrar-app: desactiva las sesiones de app del usuario Entra (D-035 "Cambiar de unidad").
//   - GET  /usuarios-activos: lista sesiones activas (requiere sesión de app → loadAppSession).
//
// D-054: select-context y cambiar-unidad comparten TODA la mecánica de contexto vía
// utils/sesion-contexto.js (sesión única D-035 + CASE de ventana D-040 + turno/presencia D-045).
// Acá solo quedan la autenticación, la validación y el gate de permiso: la diferencia entre ambos
// es QUIÉN puede llamarlos y con qué precondición, no QUÉ hacen.

import express from 'express';
import sql from 'mssql';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { resolveCargo } from '../utils/entra-roles.js';
import { acumularPresenciaSesiones } from '../utils/turno-entidad.js';
import { validarPlantaOperable, resolverCargoId, establecerContextoSesion } from '../utils/sesion-contexto.js';
import { puedeCambiarUnidad } from '../middleware/permissions.js';
import { broadcastUsuariosActivos } from '../utils/ws-usuarios-activos.js';
import { asyncH, loadAppSession } from './_middleware.js';
import { aplicarRateLimit } from './_shared.js';

const router = express.Router();

// Respuesta 403 compartida: sin App Role de bitácoras no hay cargo → no hay contexto posible.
function responderSinCargo(res, roles) {
  return sendJSON(res, 403, {
    error: 'Tu cuenta aún no tiene un rol de bitácoras asignado. Pide al administrador que te asigne uno para poder ingresar.',
    codigo: 'sin_cargo_asignado',
    detail: 'Tu cuenta no tiene un App Role de bitácoras asignado en Entra.',
    roles: roles || [],
  });
}

// POST /api/auth/select-context { planta_id }
// Deriva usuario_id de la cookie Entra (req.session.user) y cargo_id de los App Roles del token por
// precedencia. NO recibe usuario_id ni cargo_id del cliente (no son confiables).
router.post('/select-context', asyncH(async (req, res) => {
  // AUD-20: endpoint sensible (crea sesión de app). Límite generoso para no estorbar uso normal.
  if (!aplicarRateLimit(req, res, 'select-context', { max: 60, windowMs: 60_000 })) return;
  const sUser = req.session?.user;
  if (!sUser?.oid || !sUser?.usuario_id) {
    return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
  }
  const { planta_id } = req.body || {};
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido' });
  }

  // Cargo automático desde los roles del token (precedencia). Sin rol conocido → 403.
  const elegido = resolveCargo(sUser.roles);
  if (!elegido) return responderSinCargo(res, sUser.roles);

  const db = await getDB();
  if (!(await validarPlantaOperable(db, planta_id))) {
    return sendJSON(res, 400, { error: 'planta_id inválido' });
  }
  const cargo_id = await resolverCargoId(db, elegido.cargoNombre);
  if (!cargo_id) {
    console.error(`[ERROR] config: cargo '${elegido.cargoNombre}' no existe en lov_bit.cargo`);
    return sendJSON(res, 500, {
      error: 'Hay un problema de configuración del sistema. Contacta a soporte.',
      codigo: 'config_sistema',
    });
  }

  const sesion = await establecerContextoSesion(db, {
    usuario_id: sUser.usuario_id,
    planta_id,
    cargo_id,
    cargo_nombre: elegido.cargoNombre,
  });

  broadcastUsuariosActivos().catch(() => {});
  return sendJSON(res, 200, { sesion });
}));

// POST /api/auth/cambiar-unidad { planta_id } — D-054
//
// Cambia la unidad EN CALIENTE: una sola operación atómica, sin pasar por el LoginScreen (el camino
// largo sigue existiendo: cerrar-app → select-context). Reservado a los cargos que operan las dos
// plantas de forma rutinaria (`lov_bit.cargo.puede_cambiar_unidad`, hoy JdT y Operador Analista).
//
// A diferencia de select-context, EXIGE una sesión de app ya existente (loadAppSession): esto no es
// un camino de ingreso, es un cambio de contexto de quien ya está operando. Nace cerrado por
// `requireEntra` (D-037) y se cierra otra vez por el gate de cargo.
//
// ALCANCE del permiso (importante para no leerlo como más de lo que es): NO restringe la capacidad
// de operar ambas unidades — cualquier cargo puede cambiar de unidad por el camino largo, y así debe
// seguir siendo (todos eligen planta al entrar). Lo que este permiso gobierna es el ATAJO. Por eso
// el gate no intenta ser una frontera de seguridad sobre los datos: es un gate de capacidad de UI
// con enforcement real en el server, para que el botón no sea una promesa que el backend no cumple.
router.post('/cambiar-unidad', loadAppSession, asyncH(async (req, res) => {
  // AUD-20: endpoint sensible (rota la sesión de app). Acción deliberada de usuario: 30/min sobra
  // para un humano y acota el abuso automatizado.
  if (!aplicarRateLimit(req, res, 'cambiar-unidad', { max: 30, windowMs: 60_000 })) return;
  const sesionActual = req.sesion;
  const { planta_id } = req.body || {};
  if (!planta_id) {
    return sendJSON(res, 400, { error: 'planta_id es requerido', codigo: 'planta_requerida' });
  }

  // Gate D-054, ANTES de validar la planta: a quien no tiene el permiso no se le confirma ni se le
  // niega qué plantas existen.
  //
  // El permiso sale de `req.sesion`, que NO es un dato del cliente: loadAppSession lo resuelve en
  // CADA request desde la cookie y lo joinea contra lov_bit.cargo, así que el flag viene fresco de
  // la BD. Quitarle el permiso a un cargo (editar el seed + redesplegar) surte efecto en el request
  // siguiente, sin re-login.
  if (!puedeCambiarUnidad(sesionActual)) {
    return sendJSON(res, 403, {
      error: 'Tu cargo no permite cambiar de unidad desde el menú.',
      codigo: 'sin_permiso_cambio_unidad',
    });
  }

  const db = await getDB();
  if (!(await validarPlantaOperable(db, planta_id))) {
    return sendJSON(res, 400, { error: 'planta_id inválido', codigo: 'planta_invalida' });
  }

  // No-op idempotente: ya estás en esa unidad. Devolver 200 con la sesión vigente (en vez de 400)
  // hace que un doble clic o un reintento de red no produzcan un error espurio en la UI, y evita
  // rotar `inicio_sesion` sin motivo (lo que cerraría un lapso de presencia de cero minutos).
  if (planta_id === sesionActual.planta_id) {
    return sendJSON(res, 200, { sesion: sesionActual, sin_cambio: true });
  }

  // El CARGO NO se re-deriva del token acá, a diferencia de select-context, y es deliberado: esta
  // operación cambia la UNIDAD, no la identidad. Re-derivarlo haría que un cambio de App Role se
  // aplicara como efecto colateral de tocar un botón de navegación — sorpresivo y difícil de
  // auditar ("¿por qué cambió de cargo?" → "cambió de unidad"). El cargo viaja con la sesión, que
  // ya lo trae fresco de la BD; la divergencia de cargo contra Entra es responsabilidad de
  // `revalidate` (AUD-10), que la detecta en /api/me y mata la sesión — mismo tratamiento que
  // recibe cualquier otro endpoint de la app, ni más débil ni más fuerte.
  const sesion = await establecerContextoSesion(db, {
    usuario_id: sesionActual.usuario_id,
    planta_id,
    cargo_id: sesionActual.cargo_id,
    cargo_nombre: sesionActual.cargo_nombre,
  });

  broadcastUsuariosActivos().catch(() => {});
  return sendJSON(res, 200, { sesion });
}));

// POST /api/auth/cerrar-app — desactiva TODAS las sesiones de app del usuario Entra actual, sin tocar
// la cookie ni hacer logout (D-035 "Operar otra unidad"). Identidad por cookie. Idempotente.
router.post('/cerrar-app', asyncH(async (req, res) => {
  const sUser = req.session?.user;
  if (!sUser?.usuario_id) return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
  const db = await getDB();
  // D-045 E4 (presencia): cerrar el lapso de presencia antes de expulsar (necesita inicio_sesion +
  // turno_id de las sesiones aún activas). Best-effort — un fallo acá no debe impedir el cierre de app.
  try {
    const activas = await db.request()
      .input('usuario_id', sql.Int, sUser.usuario_id)
      .query(`SELECT sesion_id FROM bitacora.sesion_activa WHERE usuario_id = @usuario_id AND activa = 1 AND turno_id IS NOT NULL`);
    await acumularPresenciaSesiones(db, activas.recordset.map((r) => r.sesion_id));
  } catch (err) {
    console.error('[cerrar-app] no se pudo acumular presencia:', err.message);
  }
  await db.request()
    .input('usuario_id', sql.Int, sUser.usuario_id)
    .query(`
      UPDATE bitacora.sesion_activa
         SET activa = 0, cerrada_en = SYSUTCDATETIME()
       WHERE usuario_id = @usuario_id AND activa = 1;
    `);
  broadcastUsuariosActivos().catch(() => {});
  return sendJSON(res, 200, { ok: true });
}));

// GET /api/auth/usuarios-activos (todas las plantas, requiere sesión de app)
// F2: sin filtro TTL — refleja sesion_activa.activa=1 hasta logout o cierre por sweeper de F4.
router.get('/usuarios-activos', loadAppSession, asyncH(async (req, res) => {
  const db = await getDB();
  const result = await db.request().query(`
    SELECT
      s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno,
      s.inicio_sesion, s.ultima_actividad,
      u.nombre_completo,
      c.nombre AS cargo_nombre,
      p.nombre AS planta_nombre
    FROM bitacora.sesion_activa s
    INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
    INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id
    INNER JOIN lov_bit.planta  p ON p.planta_id  = s.planta_id
    WHERE s.activa = 1
    ORDER BY p.planta_id, s.inicio_sesion DESC
  `);
  return sendJSON(res, 200, { usuarios: result.recordset });
}));

export default router;
