import { WebSocketServer } from 'ws';
import sql from 'mssql';
import { getDB } from '../db.js';
import { SESION_TTL_MIN } from './snapshots.js';

const clients = new Set();

async function fetchSnapshot() {
  const db = await getDB();
  const r = await db.request().query(`
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
    WHERE s.activa = 1
      AND s.ultima_actividad > DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
    ORDER BY p.planta_id, s.inicio_sesion DESC
  `);
  return { type: 'snapshot', usuarios: r.recordset, ts: Date.now() };
}

export async function broadcastUsuariosActivos() {
  if (clients.size === 0) return;
  let msg;
  try {
    msg = JSON.stringify(await fetchSnapshot());
  } catch (e) {
    console.error('[ws] broadcast snapshot error:', e.message);
    return;
  }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}

async function validateSesion(sesion_id) {
  if (!Number.isFinite(sesion_id)) return false;
  const db = await getDB();
  const r = await db.request()
    .input('sesion_id', sql.Int, sesion_id)
    .query(`
      SELECT 1 AS ok
      FROM bitacora.sesion_activa
      WHERE sesion_id = @sesion_id AND activa = 1
        AND ultima_actividad > DATEADD(MINUTE, -${SESION_TTL_MIN}, GETDATE())
    `);
  return r.recordset.length > 0;
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

    const sesion_id = parseInt(url.searchParams.get('sesion_id'), 10);
    let ok = false;
    try { ok = await validateSesion(sesion_id); } catch { ok = false; }
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      try {
        ws.send(JSON.stringify(await fetchSnapshot()));
      } catch {}
    });
  });

  setInterval(() => {
    broadcastUsuariosActivos().catch(() => {});
  }, 60_000);
}
