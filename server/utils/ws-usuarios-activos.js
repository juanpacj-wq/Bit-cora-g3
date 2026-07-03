import { WebSocketServer } from 'ws';
import sql from 'mssql';
import { getDB } from '../db.js';
import { resolveWsPlanta } from '../auth/wsSession.js';

// ws -> { planta_id }  (AUD-42: cada cliente recuerda su planta para acotar el snapshot)
const clients = new Map();

/**
 * AUD-21 — Validación de Origin del handshake WS (anti Cross-Site WebSocket Hijacking).
 * Función pura y testeable (sin red/BD).
 *
 * Regla:
 *  - Origin ausente → se permite. Los navegadores SIEMPRE envían Origin en el
 *    handshake WS; un Origin ausente NO proviene de un navegador (cliente
 *    no-browser: scripts internos, healthchecks), así que no puede ser el
 *    vector CSWSH que esto busca cerrar.
 *  - Same-origin: el host del Origin coincide con el Host del request → se permite.
 *  - Allowlist por env `WS_ALLOWED_ORIGINS` (lista separada por comas; acepta
 *    origin completo "http://localhost:5174" o host pelado "localhost:5174")
 *    para orígenes legítimos adicionales (p.ej. el front de Vite en dev).
 *  - Cualquier otro Origin presente → se rechaza.
 *
 * @param {string|undefined} origin   req.headers.origin
 * @param {string|undefined} host     req.headers.host
 * @param {string|undefined} allowEnv lista CSV de orígenes permitidos (default: env)
 * @returns {boolean}
 */
export function originPermitido(origin, host, allowEnv = process.env.WS_ALLOWED_ORIGINS) {
  if (!origin) return true; // cliente no-navegador (ver doc arriba)

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // Origin presente pero malformado → rechazar
  }

  if (host && originHost === host) return true; // same-origin

  // DEV ONLY: el proxy de Vite (changeOrigin:true) reescribe el Host a localhost:3002 mientras el
  // navegador manda Origin localhost:5174. Ambos loopback del mismo equipo → same-origin en dev. En
  // producción no aplica (front y back comparten host real).
  if (process.env.NODE_ENV !== 'production') {
    const loop = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1';
    let oH = '', hH = '';
    try { oH = new URL(origin).hostname; } catch { /* ya validado arriba */ }
    try { hH = new URL(`http://${host}`).hostname; } catch { /* host inválido */ }
    if (loop(oH) && loop(hH)) return true;
  }

  if (allowEnv) {
    for (const raw of allowEnv.split(',')) {
      const a = raw.trim();
      if (!a) continue;
      if (a === origin) return true;
      let aHost = '';
      try { aHost = new URL(a).host; } catch { /* no era URL completa */ }
      // Entrada sin esquema ("localhost:5174", "app.com"): new URL la parsea como
      // scheme y deja host vacío, o lanza. En ambos casos tratarla como host pelado.
      if (!aHost) aHost = a;
      if (aHost === originHost) return true;
    }
  }

  return false;
}

// F2: sin TTL — sesion_activa.activa=1 es la única señal de presencia.
// AUD-42: acotado a la planta del cliente; el snapshot ya NO es cross-planta.
async function fetchSnapshot(planta_id) {
  const db = await getDB();
  const r = await db.request()
    .input('planta', sql.VarChar(10), planta_id)
    .query(`
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
      WHERE s.activa = 1 AND s.planta_id = @planta
      ORDER BY s.inicio_sesion DESC
    `);
  return { type: 'snapshot', usuarios: r.recordset, ts: Date.now() };
}

export async function broadcastUsuariosActivos() {
  if (clients.size === 0) return;
  // AUD-42: snapshot POR CLIENTE según su planta. Cacheamos por planta para no
  // recalcular cuando varios clientes comparten planta.
  const cache = new Map(); // planta_id -> JSON string
  for (const [ws, meta] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    let msg = cache.get(meta.planta_id);
    if (msg === undefined) {
      try {
        msg = JSON.stringify(await fetchSnapshot(meta.planta_id));
      } catch (e) {
        console.error('[ws] broadcast snapshot error:', e.message);
        continue; // saltar este cliente; intentar con los demás
      }
      cache.set(meta.planta_id, msg);
    }
    try { ws.send(msg); } catch {}
  }
}

export function attachWSS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/usuarios-activos') return;

    // AUD-21: validar Origin ANTES del upgrade (anti-CSWSH). Cheap, sin BD.
    if (!originPermitido(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // AUD-21: autenticación del handshake por la cookie de sesión Entra (no por el sesion_id
    // enumerable del cliente). resolveWsPlanta verifica la cookie firmada contra el store de sesión
    // y deriva la planta de la sesión de app ACTIVA del usuario. Sin cookie válida o sin sesión de
    // app → 401. El sesion_id del query string ya NO se usa para autorizar.
    let auth = null;
    try { auth = await resolveWsPlanta(req); } catch { auth = null; }
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const planta_id = auth.planta_id;

    wss.handleUpgrade(req, socket, head, async (ws) => {
      clients.set(ws, { planta_id });
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      try {
        ws.send(JSON.stringify(await fetchSnapshot(planta_id)));
      } catch {}
    });
  });

  setInterval(() => {
    broadcastUsuariosActivos().catch(() => {});
  }, 60_000);
}
