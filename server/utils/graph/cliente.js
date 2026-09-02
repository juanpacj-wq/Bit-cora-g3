/**
 * D-065: cliente de Microsoft Graph (flujo client_credentials).
 *
 * Lee el directorio de la Enterprise App `LOGIN_PORTAL_GENERACIÓN` con los permisos DE APLICACIÓN
 * `User.Read.All` + `GroupMember.Read.All` (consentimiento de admin, 2026-07-15). Son de
 * aplicación, no delegados: en client_credentials los delegados no aplican — el claim `roles` sale
 * vacío y Graph responde 403 Authorization_RequestDenied.
 *
 * Tres invariantes que este módulo sostiene, copiados de `utils/ia/gemini-client.js` (D-047):
 *
 *  1. **El secret vive SOLO acá.** Nunca llega al front, nunca a una URL, nunca a un log. Además
 *     de credencial es llave de lectura de todo el directorio.
 *  2. **No se loguean UPNs, nombres ni el cuerpo de la respuesta.** Una sola respuesta de
 *     `transitiveMembers` trae los UPN de ~90 personas. Solo conteos.
 *  3. **Degrada, no tumba el server.** Sin credencial o con Graph caído lanza un Error con
 *     `.codigo = 'entra_no_disponible'`; nadie llama a Graph desde `initDB` ni desde el bootstrap.
 *
 * `fetchImpl` es inyectable para probar sin red (mismo patrón DI de gemini-client). Sin
 * dependencias nuevas: `fetch` es nativo en Node >= 20.
 */

import { createHash } from 'node:crypto';

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH_HOST = 'https://graph.microsoft.com';
const GRAPH_BASE = `${GRAPH_HOST}/v1.0`;
const SCOPE = 'https://graph.microsoft.com/.default';

const TIMEOUT_MS = 20_000;
// El token dura ~1h; lo renovamos un minuto antes para no usar uno que expire en vuelo.
const MARGEN_EXPIRACION_MS = 60_000;
// El directorio real cabe en una página con $top=999. El tope existe para que un @odata.nextLink
// circular, o un tenant que crezca de golpe, no deje el proceso girando.
const MAX_PAGINAS = 25;
// Tope del cuerpo de UNA respuesta, contado sobre el stream MIENTRAS se lee (L11, CR-10). Graph
// responde chunked, sin content-length, así que un tope que solo mirara la cabecera no dispararía
// nunca. El cuerpo más grande de verdad (transitiveMembers de un grupo de 14) pesa unos pocos KB.
const MAX_RESPUESTA_BYTES = 8 * 1024 * 1024;
// 429: Graph estrangula las lecturas de directorio y manda `Retry-After` en segundos. Se honra UNA
// sola vez y solo si la espera es corta; una espera larga se trata como fallo de esa petición (y
// `directorio.js` omite esa asignación en vez de tumbar la lectura entera). Sin tope, un
// Retry-After de minutos dejaría colgada la petición HTTP del administrador hasta el timeout.
const MAX_REINTENTOS_429 = 1;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRY_AFTER_DEFAULT_MS = 1_000;
// Presupuesto TOTAL de espera por 429 para UNA lectura del directorio (CR2-13). El tope por llamada
// no alcanza: una lectura del directorio son ~16 peticiones (SP + asignaciones + 13 grupos + 1
// usuario) y, con Graph estrangulando de verdad, 16 × 10 s = 160 s de sueño dentro de la petición
// HTTP del administrador — que nginx corta a los 60 s, así que el navegador ve un 504 y el server
// sigue durmiendo. Con presupuesto compartido, las primeras esperas se honran y las siguientes
// simplemente no se reintentan: esa asignación se omite y `directorio.js` la cuenta.
export const PRESUPUESTO_429_MS = 10_000;

// tenant y client son GUIDs y se interpolan: el tenant en la URL del token, el client dentro de un
// $filter de OData. Validarlos con charset estricto es lo que impide que un `.env` con un typo —o
// manipulado— altere la ruta o inyecte en el filtro. Mismo criterio que MODEL_RE en gemini-client.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** ¿Es un GUID? Lo usa `directorio.js` para no interpolar en una URL un id que no vino de Graph. */
export function esGuid(valor) {
  return GUID_RE.test(String(valor || '').trim());
}

// Sentinela para la asignación cuyo appRoleId no está entre los appRoles del service principal:
// es el "Default Access" de Entra. La persona aparece asignada pero no puede entrar (D-031), así
// que `ROLE_TO_CARGO` no la mapea y su `cargo_nombre` queda en null.
export const ROLE_DEFAULT_ACCESS = 'DEFAULT_ACCESS';

/** Error normalizado de esta capa. TODO fallo de Graph sale con este `codigo`. */
export function errEntra(detalle) {
  const err = new Error(`[graph] ${detalle}`);
  err.codigo = 'entra_no_disponible';
  return err;
}

/**
 * ¿Están las tres variables de entorno? La feature es opcional y degradable, así que la lectura es
 * en call-time (no al cargar el módulo) y los tests pueden togglearla.
 */
export function entraConfigurado() {
  return !!(process.env.M365_TENANT_ID && process.env.M365_CLIENT_ID && process.env.M365_CLIENT_SECRET);
}

/** Lee y valida la configuración. Lanza `entra_no_disponible` si falta o está malformada. */
export function leerConfigEntra() {
  const tenantId = String(process.env.M365_TENANT_ID || '').trim();
  const clientId = String(process.env.M365_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.M365_CLIENT_SECRET || '').trim();

  // Se nombra la variable que falta (es un nombre, no un valor); jamás se imprime el secret.
  const faltan = [
    !tenantId && 'M365_TENANT_ID',
    !clientId && 'M365_CLIENT_ID',
    !clientSecret && 'M365_CLIENT_SECRET',
  ].filter(Boolean);
  if (faltan.length) throw errEntra(`falta configuración: ${faltan.join(', ')}`);

  if (!GUID_RE.test(tenantId)) throw errEntra('M365_TENANT_ID no tiene forma de GUID');
  if (!GUID_RE.test(clientId)) throw errEntra('M365_CLIENT_ID no tiene forma de GUID');

  return { tenantId, clientId, clientSecret };
}

// Cache en memoria del token de app. La clave incluye tenant+client para que un cambio de
// configuración (o un test que la mueva) no reutilice el token del anterior, y una HUELLA del
// secreto (L11, CR-13): rotar M365_CLIENT_SECRET invalida la cache en el acto, en vez de seguir
// sirviendo hasta 1 h el token minteado con el secreto retirado. Va hasheado para que el secreto
// en claro no viva en memoria como clave.
let cacheToken = null; // { clave, token, expiraEn }

function huellaSecreto(secreto) {
  return createHash('sha256').update(secreto).digest('hex').slice(0, 16);
}

/** Vacía la cache del token. La usan los tests; en producción el token expira solo. */
export function limpiarCacheToken() {
  cacheToken = null;
}

/**
 * Token de aplicación por client_credentials, cacheado hasta `expires_in` menos el margen.
 * @returns {Promise<string>} el access_token (no se loguea nunca).
 */
export async function obtenerToken({ fetchImpl = fetch } = {}) {
  const { tenantId, clientId, clientSecret } = leerConfigEntra();
  const clave = `${tenantId}|${clientId}|${huellaSecreto(clientSecret)}`;

  if (cacheToken && cacheToken.clave === clave && cacheToken.expiraEn > Date.now()) {
    return cacheToken.token;
  }

  const cuerpo = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: SCOPE,
  });

  let resp;
  try {
    resp = await fetchImpl(`${LOGIN_HOST}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: cuerpo.toString(),
      redirect: 'error', // no seguir 30x: el secret viaja en el cuerpo
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Sin e.message: puede traer la URL. e.cause.code sí es seguro y es lo que ops necesita
    // (SELF_SIGNED_CERT_IN_CHAIN = falta la CA corporativa del FortiGate, ENOTFOUND = DNS...).
    const causa = e?.cause?.code || e?.cause?.name;
    throw errEntra(`token: fetch falló ${e?.name || 'Error'}${causa ? ` (${causa})` : ''}`);
  }
  // El cuerpo del error de Entra puede citar la petición (y con ella el secret): solo el status.
  if (!resp.ok) throw errEntra(`token: HTTP ${resp.status}`);

  let data;
  try {
    data = await resp.json();
  } catch {
    throw errEntra('token: respuesta no-JSON');
  }

  const token = data?.access_token;
  if (typeof token !== 'string' || !token) throw errEntra('token: respuesta sin access_token');

  const duracionSeg = Number(data?.expires_in);
  const duracionMs = Number.isFinite(duracionSeg) && duracionSeg > 0 ? duracionSeg * 1000 : 0;
  cacheToken = { clave, token, expiraEn: Date.now() + Math.max(0, duracionMs - MARGEN_EXPIRACION_MS) };

  return token;
}

/** Espera que pide un 429, en ms; `null` si el header no es interpretable (no se reintenta). */
function esperaRetryAfterMs(headers) {
  const crudo = headers?.get?.('retry-after');
  if (crudo == null || String(crudo).trim() === '') return RETRY_AFTER_DEFAULT_MS;
  const segundos = Number(crudo);
  // Formato fecha HTTP (raro en Graph): no se interpreta y por tanto no se reintenta.
  if (!Number.isFinite(segundos) || segundos < 0) return null;
  return segundos * 1000;
}

/**
 * Lee el cuerpo como JSON contando los bytes SOBRE EL STREAM: si supera `MAX_RESPUESTA_BYTES` se
 * cancela la lectura y se lanza, sin haber acumulado más de eso en memoria. Un transporte sin
 * stream (un fixture de test que solo trae `json()`) se lee tal cual: no hay bytes que contar.
 */
async function leerJsonAcotado(resp) {
  const cuerpo = resp.body;
  if (!cuerpo || typeof cuerpo.getReader !== 'function') {
    try {
      return await resp.json();
    } catch {
      throw errEntra('respuesta no-JSON');
    }
  }

  // `getReader()` va DENTRO del try (CR2-14): sobre un cuerpo ya consumido o bloqueado lanza un
  // TypeError, y ese error no lleva `.codigo`, así que salía del módulo crudo y terminaba en un 500
  // en vez del 503 `entra_no_disponible` estable que promete esta capa. Ningún camino de producción
  // reusa hoy una `Response`, pero el contrato de este módulo es que TODO fallo de Graph sale con
  // el mismo código: una excepción que se escapa de esa regla es la que rompe al llamador.
  const trozos = [];
  let bytes = 0;
  let lector = null;
  try {
    lector = cuerpo.getReader();
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPUESTA_BYTES) {
        throw errEntra(`respuesta demasiado grande: supera ${MAX_RESPUESTA_BYTES} bytes`);
      }
      trozos.push(value);
    }
  } catch (e) {
    try { await lector?.cancel(); } catch { /* ya cerrado, o nunca se abrió */ }
    if (e?.codigo === 'entra_no_disponible') throw e;
    throw errEntra(`lectura del cuerpo falló ${e?.name || 'Error'}`);
  }

  try {
    return JSON.parse(Buffer.concat(trozos).toString('utf8'));
  } catch {
    throw errEntra('respuesta no-JSON');
  }
}

/**
 * Bolsa de espera por 429 compartida por todas las peticiones de UNA operación (CR2-13). Quien la
 * crea es el llamador de más arriba (`leerDirectorioEntra`); si no llega ninguna, cada `graphGet` /
 * `graphGetTodo` arma la suya y el comportamiento es el de una llamada suelta.
 */
export function nuevoPresupuesto429(totalMs = PRESUPUESTO_429_MS) {
  return { restanteMs: totalMs };
}

/** Una petición GET a Graph. `url` absoluta o ruta que arranca en '/' (relativa a /v1.0). */
async function graphFetch(url, { fetchImpl, token, presupuesto }, intento = 0) {
  const destino = url.startsWith('http') ? url : `${GRAPH_BASE}${url}`;

  // Un @odata.nextLink es una URL que viene en la respuesta: se sigue solo si sigue apuntando a
  // Graph. El Bearer es de aplicación y lee todo el directorio; no se manda a ningún otro host.
  if (!destino.startsWith(`${GRAPH_HOST}/`)) throw errEntra('destino fuera de graph.microsoft.com');

  let resp;
  try {
    resp = await fetchImpl(destino, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const causa = e?.cause?.code || e?.cause?.name;
    throw errEntra(`fetch falló ${e?.name || 'Error'}${causa ? ` (${causa})` : ''}`);
  }

  // Estrangulado: se honra Retry-After una vez, si es corto (L11, CR-2) Y si queda presupuesto de
  // espera para la operación entera (L12, CR2-13). Sin lo segundo, dieciséis peticiones podían
  // dormir diez segundos cada una dentro de la misma petición HTTP del administrador.
  if (resp.status === 429 && intento < MAX_REINTENTOS_429) {
    const espera = esperaRetryAfterMs(resp.headers);
    if (espera !== null && espera <= MAX_RETRY_AFTER_MS && espera <= presupuesto.restanteMs) {
      presupuesto.restanteMs -= espera;
      try { await resp.body?.cancel?.(); } catch { /* sin cuerpo que soltar */ }
      await new Promise((resolver) => setTimeout(resolver, espera));
      return graphFetch(url, { fetchImpl, token, presupuesto }, intento + 1);
    }
  }
  if (!resp.ok) throw errEntra(`HTTP ${resp.status}`);

  // Atajo barato cuando el servidor sí declara el tamaño; el tope real es el del stream de abajo.
  const cl = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(cl) && cl > MAX_RESPUESTA_BYTES) throw errEntra(`respuesta demasiado grande: ${cl} bytes`);

  return leerJsonAcotado(resp);
}

/** GET a Graph que devuelve un recurso único (ej. `/users/{id}`). */
export async function graphGet(ruta, { fetchImpl = fetch, token = null, presupuesto = null } = {}) {
  const bearer = token || await obtenerToken({ fetchImpl });
  return graphFetch(ruta, { fetchImpl, token: bearer, presupuesto: presupuesto || nuevoPresupuesto429() });
}

/** GET a una colección de Graph, siguiendo `@odata.nextLink`. Devuelve el `value` concatenado. */
export async function graphGetTodo(ruta, { fetchImpl = fetch, token = null, presupuesto = null } = {}) {
  const bearer = token || await obtenerToken({ fetchImpl });
  const bolsa = presupuesto || nuevoPresupuesto429();

  const acumulado = [];
  let siguiente = ruta;
  for (let pagina = 0; pagina < MAX_PAGINAS && siguiente; pagina++) {
    const data = await graphFetch(siguiente, { fetchImpl, token: bearer, presupuesto: bolsa });
    if (Array.isArray(data?.value)) acumulado.push(...data.value);
    siguiente = data?.['@odata.nextLink'] || null;
  }
  if (siguiente) throw errEntra(`la colección superó ${MAX_PAGINAS} páginas`);

  return acumulado;
}
