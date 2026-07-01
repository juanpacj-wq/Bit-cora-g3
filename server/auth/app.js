/**
 * Surface de autenticación Entra ID montado como wrapper Express delgado.
 *
 * El backend de bitácoras es http nativo (un if-chain en server.js). Para reusar el patrón
 * probado de la implementación de referencia (express-session + @azure/msal-node + store MSSQL)
 * montamos un Express que:
 *   1. corre el middleware de sesión (cookie httpOnly) para TODA request → req.session,
 *   2. resuelve las rutas de auth (/auth/login, /auth/redirect, /api/me, /api/logout),
 *   3. delega TODO lo demás al if-chain actual (legacyHandler), que ahora puede leer req.session.
 *
 * `express.json()` se monta ACOTADO a las rutas de auth: el if-chain usa parseBody() (lee el
 * stream crudo) y un body-parser global lo rompería.
 */
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import sql from 'mssql';

import { getDB } from '../db.js';
import { loadSession } from '../middleware/auth.js';
import { provisionEntraUser } from './provision.js';
import { buildSessionStore } from './sessionStore.js';
import { revalidate, REVALIDATE_INTERVAL_MS } from './revalidate.js';
import { setWsSessionContext } from './wsSession.js';
import { expressErrorHandler } from '../utils/errores.js';
import { corsMiddleware, csrfMiddleware, requireEntra } from '../routes/_middleware.js';
import { detectRoles } from './roles.js';
import {
  isConfigured as m365Configured, m365Config,
  getAuthCodeUrl, acquireTokenByCode, getLogoutUrl,
} from './m365.js';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, SESSION_COOKIE_SECURE } from './entra-config.js';

// Importado de forma perezosa para no crear ciclo con server.js (que importa este módulo).
let _broadcast = () => Promise.resolve();
export function setBroadcastUsuariosActivos(fn) { _broadcast = fn; }

function clearAuthTransients(s) {
  delete s.pkceVerifier; delete s.authState; delete s.authNonce; delete s.silent;
}

export async function buildAuthApp(legacyHandler) {
  const app = express();
  app.set('trust proxy', 1);

  const isProduction = process.env.NODE_ENV === 'production';

  // AUD-22: en producción SESSION_SECRET es OBLIGATORIO. Un fallback efímero por proceso mata las
  // sesiones en cada reinicio y rompe multi-instancia (cada réplica firma con un secreto distinto).
  // Fuera de prod conservamos el fallback efímero + warn para no estorbar el dev local.
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error(
      'SESSION_SECRET es obligatorio en producción (NODE_ENV=production). ' +
      'Genera uno con `openssl rand -hex 32` y configúralo en el entorno antes de arrancar.'
    );
  }
  const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

  // AUD-09: en producción se FUERZA secure:true derivado de NODE_ENV (no depende de que el
  // operador recuerde poner la env). `trust proxy` (arriba) hace que express-session reconozca la
  // terminación TLS del proxy y no descarte la cookie por verse "sobre HTTP".
  const { store, kind: storeKind } = await buildSessionStore();
  // AUD-21: comparte store + secreto + nombre de cookie con el resolver del handshake WS, que corre
  // fuera de este middleware y necesita verificar la MISMA cookie de sesión.
  setWsSessionContext({ store, secret: sessionSecret, cookieName: SESSION_COOKIE_NAME });
  app.use(session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    store,                 // undefined => MemoryStore (solo dev)
    resave: false,
    saveUninitialized: false,
    rolling: true,         // renueva la expiración en cada request
    cookie: {
      httpOnly: true,
      sameSite: 'lax',     // permite que la cookie viaje en la redirección OIDC (navegación top-level)
      secure: isProduction ? true : SESSION_COOKIE_SECURE,
      maxAge: SESSION_MAX_AGE_MS,
    },
  }));

  // ── Cross-cutting global (AUD-34/35): CORS+preflight y CSRF de mutadores ──────────────────────
  // Antes vivían dentro del if-chain (legacyHandler); ahora son middleware Express único que aplica
  // a TODAS las rutas (incluidas las de /auth y los routers de dominio). Van justo tras la sesión.
  app.use(corsMiddleware);
  app.use(csrfMiddleware);

  // Avisos de hardening
  if (!process.env.SESSION_SECRET) {
    console.warn('  ⚠  SESSION_SECRET no está en .env — se generó uno efímero (las sesiones mueren al reiniciar).');
  }
  if (isProduction && storeKind === 'memory') {
    console.warn('  ⚠  PRODUCCIÓN con store en MEMORIA: usa SESSION_STORE=mssql.');
  }

  // ── Paso 1: arranca el login OIDC ──────────────────────────────────────────
  app.get('/auth/login', async (req, res) => {
    if (!m365Configured()) {
      return res.status(503).json({ ok: false, reason: 'm365_no_configurado',
        detail: 'Faltan M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET en el .env.' });
    }
    try {
      const silent = req.query.silent === '1' || req.query.silent === 'true';
      const select = req.query.switch === '1' || req.query.select === '1';
      const fresh = req.query.fresh === '1';
      const { url, pkceVerifier, state, nonce } = await getAuthCodeUrl(req.session, { silent, select, fresh });
      req.session.pkceVerifier = pkceVerifier;
      req.session.authState = state;
      req.session.authNonce = nonce;
      req.session.silent = silent;
      req.session.save(() => res.redirect(url));
    } catch (err) {
      // No filtramos err.message (puede contener config/secretos del flujo OIDC). Detalle al log.
      console.error('[auth/login]', err);
      res.status(500).json({ ok: false, reason: 'error_auth_url',
        detail: 'No se pudo iniciar sesión con Microsoft. Intenta de nuevo; si continúa, contacta a soporte.' });
    }
  });

  // ── Paso 2: callback de Microsoft con el código de autorización ─────────────
  app.get('/auth/redirect', async (req, res) => {
    const wasSilent = Boolean(req.session.silent);

    if (req.query.error) {
      const e = String(req.query.error);
      clearAuthTransients(req.session);
      if (e === 'login_required' || e === 'interaction_required' || e === 'consent_required') {
        return req.session.save(() => res.redirect('/?auth=interactive_required'));
      }
      const desc = String(req.query.error_description || '');
      if (desc.includes('AADSTS50105')) {
        // Autenticó (y pasó MFA) pero NO está asignado a la Enterprise App ("Asignación
        // requerida = Sí"). Este es el gate de acceso que reemplaza al allowlist local.
        console.warn(`[auth/redirect] usuario no asignado a la app (AADSTS50105)`);
        return req.session.destroy(() => res.redirect('/?auth=no_acceso'));
      }
      console.warn(`[auth/redirect] error de Entra: ${e} — ${desc}`);
      return req.session.save(() => res.redirect('/?auth=error'));
    }

    const { code, state } = req.query;
    if (!code || !state || state !== req.session.authState) {
      clearAuthTransients(req.session);
      return req.session.save(() => res.redirect('/?auth=' + (wasSilent ? 'interactive_required' : 'state_invalido')));
    }

    try {
      const result = await acquireTokenByCode(req.session, {
        code: String(code),
        pkceVerifier: req.session.pkceVerifier,
        nonce: req.session.authNonce,
      });

      const claims = result.idTokenClaims || {};
      const upn = claims.preferred_username || claims.upn || claims.email || result.account?.username || '';
      const fullName = claims.name || result.account?.name || '';
      const email = claims.email || upn;
      const oid = claims.oid || result.account?.localAccountId || '';
      const tenantId = claims.tid || '';
      const roles = detectRoles(claims);

      // Auto-aprovisionamiento: sincroniza lov_bit.usuario por azure_oid. Devuelve el
      // usuario_id local que las sesiones de app (sesion_activa) necesitan.
      const db = await getDB();
      let provisioned;
      try {
        provisioned = await provisionEntraUser(db, { oid, upn, name: fullName, email, tid: tenantId });
      } catch (err) {
        console.error('[auth/redirect] provisionEntraUser', err);
        clearAuthTransients(req.session);
        return req.session.save(() => res.redirect('/?auth=error'));
      }

      // Auditoría de login (oid, upn, roles): trazabilidad para cumplimiento.
      console.log(`[login] ${upn} oid=${oid} roles=[${roles.join(', ') || '(ninguno)'}] usuario_id=${provisioned?.usuario_id}`);

      const user = {
        usuario_id: provisioned?.usuario_id,
        nombre_completo: provisioned?.nombre_completo || fullName,
        upn, email, oid, tenantId, roles,
        loginAt: new Date().toISOString(),
        via: 'm365',
      };

      // Sesión NUEVA (anti session-fixation), preservando la caché de tokens MSAL recién obtenida.
      const msalCache = req.session.msalCache;
      req.session.regenerate((err) => {
        if (err) {
          console.error('[auth/redirect] regenerate', err);
          return res.redirect('/?auth=error');
        }
        req.session.user = user;
        req.session.msalCache = msalCache;
        req.session.lastRevalidatedAt = Date.now();
        req.session.save(() => res.redirect('/?auth=ok'));
      });
    } catch (err) {
      console.error('[auth/redirect]', err);
      clearAuthTransients(req.session);
      req.session.save(() => res.redirect('/?auth=error'));
    }
  });

  // ── Identidad + contexto de sesión de app ──────────────────────────────────
  // `revalidate` re-chequea en silencio contra Entra (cada REVALIDATE_INTERVAL_MS) que el
  // usuario sigue con acceso y actualiza sus roles; si lo revocaron, mata la sesión (401).
  app.get('/api/me', revalidate, async (req, res) => {
    const u = req.session.user;
    if (!u) return res.status(401).json({ authenticated: false });
    // Adjuntamos la sesión de app vigente (sesion_activa.activa=1) si existe, y la última
    // planta usada (para que reentrar en un turno nuevo sea de un clic).
    let sesion = null, ultimaPlanta = null;
    try {
      sesion = await loadSession(req);
      const db = await getDB();
      const r = await db.request()
        .input('uid', sql.Int, u.usuario_id)
        .query(`SELECT TOP 1 planta_id FROM bitacora.sesion_activa WHERE usuario_id=@uid ORDER BY inicio_sesion DESC`);
      ultimaPlanta = r.recordset[0]?.planta_id ?? null;
    } catch (err) {
      console.error('[api/me]', err.message);
    }
    res.json({ authenticated: true, user: u, sesion, ultimaPlanta });
  });

  // ── Logout: cierra la sesión de app + destruye la cookie + front-channel a Microsoft ──
  app.post('/api/logout', async (req, res) => {
    const logoutUrl = getLogoutUrl();
    const uid = req.session.user?.usuario_id;
    if (uid) {
      try {
        const db = await getDB();
        await db.request().input('uid', sql.Int, uid)
          .query(`UPDATE bitacora.sesion_activa SET activa=0, cerrada_en=SYSUTCDATETIME() WHERE usuario_id=@uid AND activa=1`);
        _broadcast().catch(() => {});
      } catch (err) { console.error('[api/logout]', err.message); }
    }
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME);
      res.json({ ok: true, logoutUrl });
    });
  });

  // ── Gate de autenticación por defecto (AUD-05/AUD-34): cierra el acceso anónimo ──────────────
  // Va DESPUÉS de las rutas de auth (login/me/logout son self-gating) y ANTES de los routers de
  // datos + el catch-all. Todo lo que no esté en la allowlist pública exige identidad Entra.
  app.use(requireEntra);

  // ── Delegación: TODO lo demás al if-chain nativo (req.session ya está poblado) ──
  // Transitorio (AUD-34/35): a medida que cada dominio migre a routes/<dominio>.js montado arriba,
  // el if-chain se encoge hasta quedar vacío y este catch-all se elimina.
  app.use((req, res) => legacyHandler(req, res));

  // ── Error-handler de la capa Express (D-032) ────────────────────────────────
  // Debe ir de ÚLTIMO. Express enruta acá (firma de 4 args) cualquier error propagado vía
  // next(err) por un middleware previo — en la práctica, el middleware de express-session cuando
  // el store mssql NO puede conectar a la BD al cargar la sesión. Sin este handler, ese error subía
  // al handler POR DEFECTO de Express, que responde el stack en HTML y FILTRA el host/instancia de
  // la BD ("Failed to connect to 192.168...\mssqlg3"). expressErrorHandler lo sanea con el mismo
  // criterio del if-chain (clasifica → loguea server-side → { error, codigo, mensaje } amigable).
  app.use(expressErrorHandler);

  console.log(`  [auth] Entra ID ${m365Config().configured ? 'CONFIGURADO (tenant ' + m365Config().tenant + ')' : 'NO configurado (faltan M365_* en .env)'}`);
  console.log(`  [auth] store de sesión: ${storeKind}${storeKind === 'memory' ? ' (solo dev)' : ''} · revalidación cada ${Math.round(REVALIDATE_INTERVAL_MS / 60000)} min`);

  return app;
}
