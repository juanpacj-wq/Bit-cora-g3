/**
 * Revalidación silenciosa ("problema del egresado").
 *
 * La sesión de login (cookie Entra) puede durar días; si a alguien lo sacan de los grupos o lo
 * deshabilitan en Entra, su cookie seguiría válida hasta expirar. Este middleware, cada
 * REVALIDATE_INTERVAL_MS, usa el refresh token (offline_access) para re-pedir un token a Entra
 * EN SILENCIO:
 *   - Si Entra responde -> el usuario sigue con acceso; actualizamos sus roles actuales y
 *     RE-DERIVAMOS su cargo del token (AUD-10): si el cargo vigente del login ya no coincide con
 *     el cargo congelado en la sesión de app (sesion_activa), invalidamos (downgrade efectivo).
 *   - Si Entra rechaza por revocación (lo deshabilitaron / sin grupos) -> matamos la sesión.
 *   - Si Entra falla de forma transitoria (red/throttling) -> NO matamos al primer blip, pero
 *     llevamos un contador por sesión y, tras MAX_FALLOS_TRANSITORIOS consecutivos, cerramos
 *     fail-closed (AUD-10): dejamos de preservar indefinidamente una sesión que no podemos validar.
 *
 * Throttle por sesión (lastRevalidatedAt) para no pegarle a Entra en cada request.
 * Montar en /api/me, que el front consulta periódicamente.
 */
import sql from 'mssql';
import { refreshSilently } from './m365.js';
import { detectRoles } from './roles.js';
import { resolveCargo } from '../utils/entra-roles.js';
import { loadSession } from '../middleware/auth.js';
import { getDB } from '../db.js';

export const REVALIDATE_INTERVAL_MS = Number(process.env.REVALIDATE_INTERVAL_MS || 20 * 60 * 1000);

// Fail-closed acotado: tras N errores transitorios CONSECUTIVOS para una misma sesión dejamos de
// fallar-abierto y la invalidamos. Un blip aislado (1-2) sigue preservando la sesión.
export const MAX_FALLOS_TRANSITORIOS = Number(process.env.REVALIDATE_MAX_FALLOS || 3);

// Contador de fallos transitorios consecutivos por sesión (req.sessionID). En memoria del proceso
// es suficiente: si el proceso se reinicia, la cookie igual se re-revalida contra Entra. Se borra
// la entrada ante cualquier desenlace terminal (éxito, kill) para que el Map no crezca sin techo.
const fallosTransitorios = new Map();

/**
 * ¿El error del refresh significa que Entra REVOCÓ el acceso (hay que matar la sesión),
 * o es transitorio (red/Entra caído/throttling) y NO debemos desloguear de inmediato?
 * Solo destruimos ante señales claras de revocación; ante lo demás, contamos y reintentamos.
 */
function isRevocation(err) {
  if (!err) return false;
  if (err.message === 'sin_cuenta_en_cache') return true;           // no hay refresh token/cuenta
  if (err.name === 'InteractionRequiredAuthError') return true;     // el refresh ya no sirve -> re-login
  const code = String(err.errorCode || '');
  if (['invalid_grant', 'interaction_required', 'no_tokens_found', 'no_account_in_silent_request'].includes(code)) return true;
  // Códigos AADSTS de revocación/expiración/desasignación explícita:
  return /AADSTS(50173|700082|700084|50105|50076|50078|50079|65001)/.test(String(err.message || ''));
}

/**
 * Decisión PURA (AUD-10): ¿el cargo re-derivado del token vigente obliga a invalidar la sesión?
 * @param {{ sessionCargo: string|null, tokenCargo: string|null }} args
 *   - sessionCargo: cargo (lov_bit.cargo.nombre) congelado en la sesión de app vigente, o null si
 *     el usuario aún no eligió contexto (no hay sesion_activa).
 *   - tokenCargo: cargo derivado AHORA de los App Roles del token (resolveCargo), o null si el
 *     token ya no trae ningún rol mapeable.
 * @returns {{ invalidar: boolean, motivo?: string }}
 */
export function decidirCargo({ sessionCargo, tokenCargo }) {
  if (!sessionCargo) return { invalidar: false };                       // sin sesión de app: nada que comparar
  if (!tokenCargo) return { invalidar: true, motivo: 'sin_cargo' };     // perdió todos los roles -> revocación efectiva
  if (sessionCargo !== tokenCargo) return { invalidar: true, motivo: 'cargo_cambiado' }; // downgrade/upgrade
  return { invalidar: false };
}

/**
 * Registra un fallo transitorio para una sesión y devuelve el conteo CONSECUTIVO acumulado.
 * PURA respecto del Map que se le pasa (el caller decide si alcanzó el umbral). El reseteo se hace
 * borrando la entrada (revalidación exitosa) — no acá.
 * @param {Map<string, number>} map
 * @param {string} sessionId
 * @returns {number} fallos consecutivos tras contar este
 */
export function contarFallo(map, sessionId) {
  const n = (map.get(sessionId) || 0) + 1;
  map.set(sessionId, n);
  return n;
}

/**
 * Mata la sesión: desactiva la sesión de app (sesion_activa, para que el privilegio NO sobreviva al
 * cambio/revocación — el corazón de AUD-10), borra el contador y destruye la cookie de login. La
 * desactivación de la sesión de app es best-effort: si la BD falla igual destruimos la cookie, que
 * por sí sola ya bloquea todo acceso (loadSession resuelve por oid de la cookie).
 */
async function matarSesion(req, res, reason) {
  const uid = req.session.user?.usuario_id;
  if (uid != null) {
    try {
      const db = await getDB();
      await db.request().input('uid', sql.Int, uid).query(
        `UPDATE bitacora.sesion_activa SET activa=0, cerrada_en=SYSUTCDATETIME() WHERE usuario_id=@uid AND activa=1`
      );
    } catch (e) {
      // No filtramos detalle al cliente (D-032); logueamos server-side y seguimos a destruir la cookie.
      console.error('[revalidate] no se pudo desactivar la sesión de app:', e.message);
    }
  }
  fallosTransitorios.delete(req.sessionID);
  return req.session.destroy(() =>
    res.status(401).json({ authenticated: false, reason })
  );
}

export async function revalidate(req, res, next) {
  if (!req.session.user) return next(); // sin sesión: lo resuelve el guard de la ruta

  const last = req.session.lastRevalidatedAt || 0;
  if (Date.now() - last < REVALIDATE_INTERVAL_MS) return next(); // dentro de la ventana: no revalida

  const sid = req.sessionID;
  try {
    const result = await refreshSilently(req.session);
    const roles = detectRoles(result.idTokenClaims || {});
    req.session.user.roles = roles;
    req.session.lastRevalidatedAt = Date.now();
    fallosTransitorios.delete(sid); // revalidación OK -> resetea el contador fail-closed

    // AUD-10: re-derivar el cargo del token vigente y compararlo con el congelado en la sesión de
    // app. resolveCargo es la MISMA función que usa select-context, así no hay deriva entre lo que
    // se autorizó al elegir contexto y lo que el token dice ahora.
    const elegido = resolveCargo(roles);            // { role, cargoNombre } | null
    const tokenCargo = elegido?.cargoNombre || null;

    let sessionCargo;
    try {
      const sesionApp = await loadSession(req);     // sesion_activa vigente (o null si no eligió contexto)
      sessionCargo = sesionApp?.cargo_nombre || null;
    } catch (e) {
      // No pudimos leer la sesión de app (BD intermitente): no forzamos invalidación por el cargo
      // este ciclo. La revalidación contra Entra ya pasó, así que no contamos un fallo transitorio.
      console.warn(`[revalidate] no se pudo leer la sesión de app de ${req.session.user.upn}; omito chequeo de cargo: ${e.message}`);
      return next();
    }

    const { invalidar, motivo } = decidirCargo({ sessionCargo, tokenCargo });
    if (invalidar) {
      console.warn(`[revalidate] cargo desactualizado para ${req.session.user.upn} (${motivo}: sesión='${sessionCargo}' token='${tokenCargo || '(ninguno)'}') -> invalido sesión`);
      return matarSesion(req, res, 'cargo_cambiado');
    }
    return next();
  } catch (err) {
    if (isRevocation(err)) {
      console.warn(`[revalidate] acceso REVOCADO para ${req.session.user.upn}: ${err.errorCode || err.message}`);
      return matarSesion(req, res, 'sesion_revocada');
    }
    // Transitorio (red/Entra caído/throttling): fail-closed acotado. NO tocamos lastRevalidatedAt
    // (reintenta en el próximo poll). Tras MAX_FALLOS_TRANSITORIOS consecutivos, dejamos de
    // preservar y cerramos.
    const fallos = contarFallo(fallosTransitorios, sid);
    if (fallos >= MAX_FALLOS_TRANSITORIOS) {
      console.warn(`[revalidate] ${fallos} fallos transitorios consecutivos para ${req.session.user.upn} -> fail-closed, invalido sesión`);
      return matarSesion(req, res, 'revalidacion_fallida');
    }
    console.warn(`[revalidate] error transitorio (${fallos}/${MAX_FALLOS_TRANSITORIOS}) para ${req.session.user.upn} (sesión preservada): ${err.errorCode || err.message}`);
    return next();
  }
}
