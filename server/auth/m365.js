/**
 * Login con Microsoft 365 / Entra ID — flujo OIDC Authorization Code + PKCE
 * (cliente confidencial, server-side con @azure/msal-node).
 *
 * Por qué este flujo y no ROPC: el tenant GECELCA.COM.CO EXIGE MFA (AADSTS50076), así que el
 * flujo usuario+contraseña directo (ROPC) NO puede completar el login. El Auth Code Flow
 * redirige al login hospedado de Microsoft, que sí resuelve el segundo factor, y nos devuelve
 * un código que canjeamos por tokens.
 *
 * Seguridad / buenas prácticas aplicadas:
 *   - Cliente CONFIDENCIAL: los tokens viven en el backend, nunca en el navegador.
 *   - PKCE (code_verifier/challenge) además del client_secret (defensa en capas).
 *   - `state` aleatorio (anti-CSRF) y `nonce` (anti token-injection/replay) en el callback.
 *   - Caché de tokens MSAL particionada POR SESIÓN (no global) vía cachePlugin.
 *   - offline_access => refresh token para renovar y revalidar sin re-preguntar.
 *
 * Requiere un App Registration en Entra (ver .env.example):
 *   M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_REDIRECT_URI.
 */
import { ConfidentialClientApplication, CryptoProvider, LogLevel } from '@azure/msal-node';

const TENANT = process.env.M365_TENANT_ID || 'common';
const CLIENT_ID = process.env.M365_CLIENT_ID || '';
const CLIENT_SECRET = process.env.M365_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.M365_REDIRECT_URI || 'http://localhost:5174/auth/redirect';
const POST_LOGOUT_REDIRECT_URI =
  process.env.M365_POST_LOGOUT_REDIRECT_URI || 'http://localhost:5174/';
const AUTHORITY = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}`;

// Scopes mínimos: identidad + correo + refresh token (offline_access habilita la revalidación).
export const SCOPES = (process.env.M365_SCOPES || 'openid profile email offline_access')
  .split(/\s+/)
  .filter(Boolean);

const cryptoProvider = new CryptoProvider();

export function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && TENANT);
}

export function m365Config() {
  return {
    configured: isConfigured(),
    tenant: TENANT,
    clientIdSet: Boolean(CLIENT_ID),
    clientSecretSet: Boolean(CLIENT_SECRET),
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT_URI,
    scopes: SCOPES,
  };
}

/**
 * Construye un cliente MSAL cuya caché de tokens se serializa en la sesión Express recibida.
 * Así cada usuario tiene su propia caché aislada (no una global).
 */
function buildClient(session) {
  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      ctx.tokenCache.deserialize(session.msalCache || '');
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) session.msalCache = ctx.tokenCache.serialize();
    },
  };
  return new ConfidentialClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY, clientSecret: CLIENT_SECRET },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) console.error('[msal]', message);
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Warning,
      },
    },
  });
}

/**
 * Paso 1: genera la URL de autorización y los secretos PKCE/state/nonce que el llamador debe
 * guardar en la sesión hasta el callback.
 * @param {object} session  req.session (para la caché de tokens)
 * @param {object} opts     { silent?, select?, fresh? }
 */
export async function getAuthCodeUrl(session, opts = {}) {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = cryptoProvider.createNewGuid();
  const nonce = cryptoProvider.createNewGuid();

  const client = buildClient(session);
  const request = {
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    nonce,
  };
  if (opts.silent) request.prompt = 'none';
  else if (opts.fresh) request.prompt = 'login';
  else if (opts.select) request.prompt = 'select_account';
  const url = await client.getAuthCodeUrl(request);

  return { url, pkceVerifier: verifier, state, nonce };
}

/**
 * Paso 2: canjea el `code` del callback por tokens y devuelve los claims del id_token.
 */
export async function acquireTokenByCode(session, { code, pkceVerifier, nonce }) {
  const client = buildClient(session);
  const result = await client.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: pkceVerifier,
  });

  const claims = result.idTokenClaims || {};

  // Validación de nonce (defensa contra token injection / replay). El nonce SIEMPRE se genera en
  // getAuthCodeUrl y se guarda en la sesión hasta el callback; si aquí llega ausente, la sesión se
  // perdió o fue manipulada → error DURO, en vez de saltarnos silenciosamente la verificación.
  if (!nonce || claims.nonce !== nonce) {
    throw new Error('nonce_mismatch');
  }

  // AUD-22: cuando el tenant está FIJADO (M365_TENANT_ID seteado y distinto de 'common'), exigimos
  // que el id_token provenga de ESE tenant. Cierra el riesgo de que, en una configuración
  // multi-tenant accidental, un token emitido por otro tenant pase el canje. No filtramos detalle
  // (el handler de /auth/redirect lo traduce a un redirect genérico — D-032).
  const expectedTid = process.env.M365_TENANT_ID;
  if (expectedTid && expectedTid !== 'common' && claims.tid !== expectedTid) {
    throw new Error('tenant_mismatch');
  }
  return result;
}

/**
 * Revalidación silenciosa: usa el refresh token cacheado en la sesión para pedir un token fresco
 * a Entra. `forceRefresh: true` fuerza una llamada de red real, por lo que Entra RE-EVALÚA si el
 * usuario sigue asignado a la app. Si lo revocaron/deshabilitaron, Entra rechaza el refresh y
 * esto LANZA (lo aprovecha revalidate.js para matar la sesión).
 */
export async function refreshSilently(session) {
  const client = buildClient(session);
  const accounts = await client.getTokenCache().getAllAccounts();
  if (!accounts.length) throw new Error('sin_cuenta_en_cache');
  return client.acquireTokenSilent({ account: accounts[0], scopes: SCOPES, forceRefresh: true });
}

/**
 * URL de cierre de sesión de Microsoft (front-channel logout). Al navegar a ella, Entra cierra
 * la sesión M365 del navegador y vuelve a postLogoutRedirectUri.
 */
export function getLogoutUrl() {
  const u = new URL(`${AUTHORITY}/oauth2/v2.0/logout`);
  u.searchParams.set('post_logout_redirect_uri', POST_LOGOUT_REDIRECT_URI);
  return u.toString();
}
