import http from 'http';
import { initDB, getDB } from './db.js';
import { sendJSON } from './utils/http.js';
import { responderError } from './utils/errores.js';
import { attachWSS, broadcastUsuariosActivos } from './utils/ws-usuarios-activos.js';
import { attachWSConteoBitacoras } from './utils/ws-conteo-bitacoras.js';
// F9: turno-sweeper reemplazó al viejo sesion-sweeper (eliminado). Finaliza sesion_bitacora
// cuando la ventana del turno termina, sin tocar sesion_activa.activa.
import { startTurnoSweeper, stopTurnoSweeper } from './utils/turno-sweeper.js';
// F16: sweeper diario MAND.
import { startMandSweeper, stopMandSweeper } from './utils/mand-sweeper.js';
import { startSisSweeper, stopSisSweeper } from './utils/sis/sis-sweeper.js';
// Login Entra ID: wrapper Express (sesión cookie + rutas /auth + routers de dominio) que
// envuelve este handler mínimo. AUD-34/35: TODOS los dominios migraron a routes/<dominio>.js;
// el if-chain se vació y solo queda /health + el 404 de fallback.
import { buildAuthApp, setBroadcastUsuariosActivos } from './auth/app.js';

const PORT = parseInt(process.env.SERVER_PORT || '3002', 10);

// El cuerpo del router nativo (legacyHandler). Antes era el callback de http.createServer; hoy es
// una función a la que el wrapper Express (auth/app.js) delega SOLO lo que ningún router de dominio
// matcheó. Tras AUD-34/35 (E1–E10) su único endpoint propio es /health; el resto responde 404.
async function legacyHandler(req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    }

    // ── AUD-34/35 (E1–E10): if-chain vaciado ──────────────────────────────────────────────
    // Todos los dominios migraron a routers Express en server/routes/*.js, montados por
    // buildAuthApp (auth/app.js) ANTES de este catch-all: auth/context (sesion.js), bitácora
    // (bitacora.js), registros + rama DISP (registros.js), catálogos, cierre, históricos,
    // autorizaciones, eventos-dashboard, conformación, combustibles, disponibilidad y MAND.
    // Lo que llega hasta acá no matcheó ningún router → 404.

    sendJSON(res, 404, { error: 'Not Found' });
  } catch (err) {
    // Saneamiento central: clasifica el error (conexión BD caída, timeout, parse, etc.) en una
    // etiqueta apta para usuario final + codigo estable. NUNCA devuelve err.message crudo (era una
    // brecha de seguridad: filtraba host/instancia/puerto de la BD) ni texto técnico incomprensible.
    responderError(res, err, `${method} ${pathname}`);
  }
}

initDB()
  .then(async () => {
    // Inyecta el broadcaster al surface de auth (logout dispara refresh de usuarios activos).
    setBroadcastUsuariosActivos(broadcastUsuariosActivos);
    // Wrapper Express: sesión cookie + rutas /auth, delegando el if-chain (legacyHandler).
    const app = await buildAuthApp(legacyHandler);
    const server = http.createServer(app);
    attachWSS(server);
    attachWSConteoBitacoras(server);
    const db = await getDB();
    startTurnoSweeper(db);
    startMandSweeper(db);
    startSisSweeper(db);
    server.listen(PORT, () => {
      console.log(`[SERVER] Escuchando en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Error de conexión:', err);
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopTurnoSweeper();
    stopMandSweeper();
    stopSisSweeper();
    process.exit(0);
  });
}
