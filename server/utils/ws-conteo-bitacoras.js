import { WebSocketServer } from 'ws';
import sql from 'mssql';
import { getDB } from '../db.js';
import { SESION_TTL_MIN } from './snapshots.js';

const clients = new Map();

async function fetchSnapshot(planta_id) {
  const db = await getDB();
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .query(`
      SELECT bitacora_id, COUNT(*) AS total
      FROM bitacora.registro_activo
      WHERE planta_id = @planta_id AND estado = 'borrador'
      GROUP BY bitacora_id
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

async function validateSesionAndGetPlanta(sesion_id) {
  if (!Number.isFinite(sesion_id)) return null;
  const db = await getDB();
  const r = await db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`
      SELECT planta_id
      FROM bitacora.sesion_activa
      WHERE sesion_id = @sesion_id AND activa = 1
        AND ultima_actividad > DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
    `);
  return r.recordset[0]?.planta_id || null;
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

    const sesion_id = parseInt(url.searchParams.get('sesion_id'), 10);
    let planta_id = null;
    try { planta_id = await validateSesionAndGetPlanta(sesion_id); } catch { planta_id = null; }
    if (!planta_id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

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
