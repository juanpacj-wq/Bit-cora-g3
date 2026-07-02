/**
 * Configuración central del login con Microsoft Entra ID.
 *
 * Reemplaza el login local (usuario/contraseña). La identidad y los roles los provee Entra;
 * acá solo vive la lectura de variables de entorno y las dos listas de "singletons de
 * identidad" que NO se pueden derivar de App Roles (ver abajo).
 *
 * Variables de entorno (ver .env.example):
 *   M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET  — App Registration (cliente confidencial).
 *   M365_REDIRECT_URI, M365_POST_LOGOUT_REDIRECT_URI    — callbacks OIDC.
 *   M365_SCOPES                                         — scopes solicitados (incluye offline_access).
 *   SESSION_SECRET, SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE, SESSION_MAX_AGE_MS — cookie de sesión.
 *   M365_JEFE_PLANTA_UPNS, M365_JDT_DEFAULT_UPNS        — listas (coma/espacio) de UPN singleton.
 */

function parseList(raw) {
  return [...new Set(
    String(raw || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )];
}

// es_jefe_planta y es_jdt_default son flags de IDENTIDAD por persona (Jefe de Planta titular y
// JdT por defecto para el fallback de snapshots), NO App Roles. Por eso se configuran por UPN.
// Vacío => se conserva el comportamiento legacy por username (emunoz/ofedullo) para dev sin Entra.
export const JEFE_PLANTA_UPNS = parseList(process.env.M365_JEFE_PLANTA_UPNS);
export const JDT_DEFAULT_UPNS = parseList(process.env.M365_JDT_DEFAULT_UPNS);

// Sub-path de despliegue (debe calzar con el `base` de Vite / import.meta.env.BASE_URL). Vacío
// en dev (app en la raíz '/'), '/bitacora' en prod detrás del reverse proxy. Se usa para (a) los
// redirects del callback OIDC (que deben volver al SPA bajo su ruta, no a la raíz del dominio,
// que es del dashboard) y (b) el `path` de la cookie de sesión (la acota al namespace). Se
// normaliza sin barra final para concatenar: `${APP_BASE_PATH}/?auth=ok`.
export const APP_BASE_PATH = String(process.env.APP_BASE_PATH || '').replace(/\/+$/, '');

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bitacora.sid';
export const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 30 * 24 * 60 * 60 * 1000);
export const SESSION_COOKIE_SECURE =
  String(process.env.SESSION_COOKIE_SECURE).toLowerCase() === 'true';

export function isJefePlantaUpn(upn) {
  return JEFE_PLANTA_UPNS.includes(String(upn || '').trim().toLowerCase());
}
export function isJdtDefaultUpn(upn) {
  return JDT_DEFAULT_UPNS.includes(String(upn || '').trim().toLowerCase());
}
