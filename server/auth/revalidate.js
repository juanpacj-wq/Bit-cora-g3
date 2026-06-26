/**
 * Revalidación silenciosa ("problema del egresado").
 *
 * La sesión de login (cookie Entra) puede durar días; si a alguien lo sacan de los grupos o lo
 * deshabilitan en Entra, su cookie seguiría válida hasta expirar. Este middleware, cada
 * REVALIDATE_INTERVAL_MS, usa el refresh token (offline_access) para re-pedir un token a Entra
 * EN SILENCIO:
 *   - Si Entra responde -> el usuario sigue con acceso; actualizamos sus roles actuales.
 *   - Si Entra rechaza (lo revocaron / deshabilitaron / sin grupos) -> matamos la sesión.
 *
 * Throttle por sesión (lastRevalidatedAt) para no pegarle a Entra en cada request.
 * Montar en /api/me, que el front consulta periódicamente.
 */
import { refreshSilently } from './m365.js';
import { detectRoles } from './roles.js';

export const REVALIDATE_INTERVAL_MS = Number(process.env.REVALIDATE_INTERVAL_MS || 20 * 60 * 1000);

/**
 * ¿El error del refresh significa que Entra REVOCÓ el acceso (hay que matar la sesión),
 * o es transitorio (red/Entra caído/throttling) y NO debemos desloguear?
 * Solo destruimos ante señales claras de revocación; ante lo demás, reintentamos luego.
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

export async function revalidate(req, res, next) {
  if (!req.session.user) return next(); // sin sesión: lo resuelve el guard de la ruta

  const last = req.session.lastRevalidatedAt || 0;
  if (Date.now() - last < REVALIDATE_INTERVAL_MS) return next(); // dentro de la ventana: no revalida

  try {
    const result = await refreshSilently(req.session);
    req.session.user.roles = detectRoles(result.idTokenClaims || {});
    req.session.lastRevalidatedAt = Date.now();
    return next();
  } catch (err) {
    if (isRevocation(err)) {
      console.warn(`[revalidate] acceso REVOCADO para ${req.session.user.upn}: ${err.errorCode || err.message}`);
      return req.session.destroy(() =>
        res.status(401).json({ authenticated: false, reason: 'sesion_revocada' })
      );
    }
    // Transitorio (red/Entra caído/throttling): NO deslogueamos. No tocamos lastRevalidatedAt,
    // así reintenta en el próximo poll en vez de matar una sesión válida por un blip.
    console.warn(`[revalidate] error transitorio para ${req.session.user.upn} (sesión preservada): ${err.errorCode || err.message}`);
    return next();
  }
}
