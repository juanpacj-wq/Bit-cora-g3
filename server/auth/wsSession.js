/**
 * AUD-21 — Autenticación del handshake WebSocket por la cookie de sesión Entra.
 *
 * El upgrade WS corre FUERA del middleware de Express (no hay req.session), así que resolvemos la
 * identidad a mano: parseamos la cookie firmada del request y la verificamos contra el MISMO store
 * + secreto que usa express-session (inyectados por buildAuthApp en el arranque). Desde el `oid`
 * del usuario derivamos la planta de su sesión de app ACTIVA — SIN confiar en el `sesion_id`
 * (entero IDENTITY enumerable) que mandaba el cliente en el query string, que era el agujero: un
 * usuario same-origin podía conectarse con un sesion_id ajeno y leer el snapshot de otra planta.
 */
import { parse as parseCookie } from 'cookie';
import { unsign } from 'cookie-signature';
import sql from 'mssql';
import { getDB } from '../db.js';

// Contexto inyectado por buildAuthApp: { store, secret, cookieName }. Sin él, todo resuelve a null
// (fail-closed): si el surface de auth no arrancó, ningún WS se autentica.
let _ctx = null;
export function setWsSessionContext(ctx) { _ctx = ctx; }

/**
 * sessionID verificado a partir de la cookie firmada, o null. PURA respecto del ctx que recibe
 * (testeable sin store ni red). `unsign` devuelve false si la firma fue manipulada.
 * @param {{ headers?: { cookie?: string } }} req
 * @param {{ secret: string, cookieName: string }} [ctx]
 */
export function sidFromCookie(req, ctx = _ctx) {
  if (!ctx?.secret || !ctx?.cookieName) return null;
  const header = req?.headers?.cookie;
  if (!header) return null;
  let raw;
  try { raw = parseCookie(header)[ctx.cookieName]; } catch { return null; }
  if (!raw || !raw.startsWith('s:')) return null;
  const val = unsign(raw.slice(2), ctx.secret);
  return val || null;
}

/** Usuario de la sesión Express (cookie Entra) leyendo el store. Promesa → user|null. */
export function userFromCookie(req, ctx = _ctx) {
  return new Promise((resolve) => {
    const sid = sidFromCookie(req, ctx);
    if (!sid || !ctx?.store) return resolve(null);
    ctx.store.get(sid, (err, sess) => {
      if (err || !sess || !sess.user?.oid) return resolve(null);
      resolve(sess.user);
    });
  });
}

/** Planta de la sesión de app ACTIVA del usuario (por azure_oid), o null si no tiene ninguna. */
export async function plantaActivaDeUsuario(oid) {
  if (!oid) return null;
  const db = await getDB();
  const r = await db.request()
    .input('oid', sql.VarChar(64), oid)
    .query(`
      SELECT TOP 1 s.planta_id
      FROM bitacora.sesion_activa s
      INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
      WHERE u.azure_oid = @oid AND s.activa = 1
      ORDER BY s.inicio_sesion DESC
    `);
  return r.recordset[0]?.planta_id || null;
}

/**
 * Resuelve { user, planta_id } para un handshake WS autenticado por cookie, o null si no hay sesión
 * Entra válida o el usuario no tiene una sesión de app activa. Es lo único que deben usar los
 * canales WS para decidir el upgrade.
 */
export async function resolveWsPlanta(req) {
  const user = await userFromCookie(req);
  if (!user?.oid) return null;
  const planta_id = await plantaActivaDeUsuario(user.oid);
  if (!planta_id) return null;
  return { user, planta_id };
}
