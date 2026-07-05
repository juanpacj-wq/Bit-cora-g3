// D-045 E7 — canal WS `turno-transicion`: avisa al front (por planta) cuando un turno de la unidad
// entra en bloqueo (pasó fin_nominal), se extiende o se cierra. Mismo patrón que
// ws-conteo-bitacoras.js: WebSocketServer en modo `noServer`, allowlist de Origin (anti-CSWSH) y
// auth del handshake por la cookie de sesión Entra (deriva la planta de la sesión de app activa).
// El broadcast recibe el payload ya armado por el caller (sweeper / endpoints) — NO consulta BD, así
// evita el ciclo de imports con turno-entidad.js (que sí se usa solo para el snapshot on-connect).
import { WebSocketServer } from 'ws';
import { getDB } from '../db.js';
import { estadoTurnoActual } from './turno-entidad.js';
import { originPermitido } from './ws-usuarios-activos.js'; // misma allowlist de Origin
import { resolveWsPlanta } from '../auth/wsSession.js';     // auth del handshake por cookie

const clients = new Map();

// Broadcast por planta. `payload` = { estado, bloqueo, motivo? }. Puro (no toca BD) → seguro de llamar
// desde el sweeper/tests aunque no haya clientes conectados (no-op).
export function broadcastTurnoTransicion(planta_id, payload) {
  if (!planta_id) return;
  const targets = [];
  for (const [ws, meta] of clients) {
    if (meta.planta_id === planta_id && ws.readyState === ws.OPEN) targets.push(ws);
  }
  if (targets.length === 0) return;
  const msg = JSON.stringify({ type: 'turno-transicion', planta_id, ...payload, ts: Date.now() });
  for (const ws of targets) {
    try { ws.send(msg); } catch { /* cliente muerto: se limpia en 'close' */ }
  }
}

async function snapshot(planta_id) {
  const db = await getDB();
  const estado = await estadoTurnoActual(db, planta_id);
  return { type: 'turno-transicion', planta_id, estado: estado.estado, bloqueo: estado.bloqueo, snapshot: estado, ts: Date.now() };
}

export function attachWSTurnoTransicion(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return;
    }
    if (url.pathname !== '/ws/turno-transicion') return;

    if (!originPermitido(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

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
        ws.send(JSON.stringify(await snapshot(planta_id)));
      } catch { /* snapshot best-effort */ }
    });
  });
}
