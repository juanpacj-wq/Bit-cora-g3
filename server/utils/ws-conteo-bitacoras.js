import { WebSocketServer } from 'ws';
import sql from 'mssql';
import { getDB } from '../db.js';
import { originPermitido } from './ws-usuarios-activos.js'; // AUD-21: misma lógica de allowlist
import { resolveWsPlanta } from '../auth/wsSession.js';     // AUD-21: auth del handshake por cookie

const clients = new Map();

async function fetchSnapshot(planta_id) {
  const db = await getDB();
  // F10: bitácoras ocultas (CIET) no se muestran en tabs, no deben contar para los badges.
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT r.bitacora_id, COUNT(*) AS total
      FROM bitacora.registro_activo r
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
      WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
        AND b.oculta = 0
      GROUP BY r.bitacora_id
    `);
  const counts = {};
  for (const row of r.recordset) counts[row.bitacora_id] = row.total;
  return { type: 'snapshot', counts, ts: Date.now() };
}

export async function broadcastConteoBitacoras(planta_id) {
  if (!planta_id) return;
  const targets = [];
  for (const [ws, meta] of clients) {
    if (meta.planta_id === planta_id && ws.readyState === ws.OPEN) targets.push(ws);
  }
  if (targets.length === 0) return;
  let msg;
  try {
    msg = JSON.stringify(await fetchSnapshot(planta_id));
  } catch (e) {
    console.error('[ws-conteo] snapshot error:', e.message);
    return;
  }
  for (const ws of targets) {
    try { ws.send(msg); } catch {}
  }
}

export function attachWSConteoBitacoras(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return;
    }
    if (url.pathname !== '/ws/conteo-bitacoras') return;

    // AUD-21: validar Origin ANTES del upgrade (anti-CSWSH). Cheap, sin BD.
    if (!originPermitido(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // AUD-21: autenticación del handshake por la cookie de sesión Entra (no por el sesion_id
    // enumerable del cliente). Deriva la planta de la sesión de app ACTIVA del usuario autenticado.
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
}
