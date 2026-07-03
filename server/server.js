// Bootstrap del backend de bitácoras (AUD-34/35). server.js dejó de tener rutas: toda la app HTTP
// vive en el compositor Express (auth/app.js) + los routers de dominio (routes/*.js). Acá solo
// queda el arranque: initDB → buildAuthApp → http.Server (para colgar los WS) → sweepers → listen.
import http from 'http';
import { initDB, getDB } from './db.js';
import { attachWSS, broadcastUsuariosActivos } from './utils/ws-usuarios-activos.js';
import { attachWSConteoBitacoras } from './utils/ws-conteo-bitacoras.js';
// F9: turno-sweeper reemplazó al viejo sesion-sweeper (eliminado). Finaliza sesion_bitacora
// cuando la ventana del turno termina, sin tocar sesion_activa.activa.
import { startTurnoSweeper, stopTurnoSweeper } from './utils/turno-sweeper.js';
// F16: sweeper diario MAND.
import { startMandSweeper, stopMandSweeper } from './utils/mand-sweeper.js';
import { startSisSweeper, stopSisSweeper } from './utils/sis/sis-sweeper.js';
import { buildAuthApp, setBroadcastUsuariosActivos } from './auth/app.js';

const PORT = parseInt(process.env.SERVER_PORT || '3002', 10);

initDB()
  .then(async () => {
    // Inyecta el broadcaster al surface de auth (logout dispara refresh de usuarios activos).
    setBroadcastUsuariosActivos(broadcastUsuariosActivos);
    // Compositor Express: sesión cookie + rutas /auth + routers de dominio + 404 + errorHandler.
    const app = await buildAuthApp();
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
