// Bootstrap del backend de bitácoras (AUD-34/35). server.js dejó de tener rutas: toda la app HTTP
// vive en el compositor Express (auth/app.js) + los routers de dominio (routes/*.js). Acá solo
// queda el arranque: initDB → buildAuthApp → http.Server (para colgar los WS) → sweepers → listen.
import http from 'http';
import { initDB, getDB } from './db.js';
import { attachWSS, broadcastUsuariosActivos } from './utils/ws-usuarios-activos.js';
import { attachWSConteoBitacoras } from './utils/ws-conteo-bitacoras.js';
import { attachWSTurnoTransicion } from './utils/ws-turno-transicion.js'; // D-045 E7
// F9: turno-sweeper reemplazó al viejo sesion-sweeper (eliminado). Finaliza sesion_bitacora
// cuando la ventana del turno termina, sin tocar sesion_activa.activa.
import { startTurnoSweeper, stopTurnoSweeper } from './utils/turno-sweeper.js';
// F16: sweeper diario MAND.
import { startMandSweeper, stopMandSweeper } from './utils/mand-sweeper.js';
import { startSisSweeper, stopSisSweeper } from './utils/sis/sis-sweeper.js';
// D-064: barrido c/5 min que asienta la llegada del despacho económico del día siguiente.
import {
  startDespachoXMSweeper, stopDespachoXMSweeper, sweeperHabilitado as despachoXMHabilitado,
} from './utils/despacho-xm/sweeper.js';
import { buildAuthApp, setBroadcastUsuariosActivos } from './auth/app.js';

const PORT = parseInt(process.env.SERVER_PORT || '3002', 10);

// D-061 (GATE-O2, hallazgos H-L04-1 y H-L06-3): todo backend efímero de test arranca el sweeper del
// SIS a los 10 s y sale a la red con el `SIS_HOST` que tenga configurado. Con `SIS_HOST` apuntando a
// un stub, el tick deja la fila de HOY de GEC32 en `sis_scrape_log` con 24 periodos en error; con
// varios backends de lote vivos, son varios scrapes simultáneos del mismo día contra el SIS real
// (el mutex `sis-lock` es de proceso, no excluye entre procesos). `SIS_SWEEPER_ENABLED=0` lo apaga.
// Solo ese valor exacto apaga: la ausencia de la variable —o cualquier otro valor— lo deja
// encendido, para que ningún despliegue pierda la ingesta por omisión. El apagado se anuncia en el
// log de arranque, porque un sweeper mudo es indistinguible de uno roto.
const SIS_SWEEPER_ENABLED = process.env.SIS_SWEEPER_ENABLED !== '0';

initDB()
  .then(async () => {
    // Inyecta el broadcaster al surface de auth (logout dispara refresh de usuarios activos).
    setBroadcastUsuariosActivos(broadcastUsuariosActivos);
    // Compositor Express: sesión cookie + rutas /auth + routers de dominio + 404 + errorHandler.
    const app = await buildAuthApp();
    const server = http.createServer(app);
    attachWSS(server);
    attachWSConteoBitacoras(server);
    attachWSTurnoTransicion(server); // D-045 E7: canal de bloqueo/extensión/cierre por planta
    const db = await getDB();
    startTurnoSweeper(db);
    startMandSweeper(db);
    if (SIS_SWEEPER_ENABLED) startSisSweeper(db);
    else console.log('[SIS] sweeper DESHABILITADO (SIS_SWEEPER_ENABLED=0)');
    // D-064: la decisión vive en el módulo (función pura, testeable). Es el único sweeper que
    // escribe FILAS en las bitácoras de Sala de plantas reales, así que en un backend de test viene
    // apagado por defecto; el motivo se anuncia siempre.
    const despachoXM = despachoXMHabilitado();
    if (despachoXM.habilitado) startDespachoXMSweeper(db);
    else console.log(`[despacho-xm] sweeper DESHABILITADO (${despachoXM.motivo})`);
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
    stopDespachoXMSweeper();
    process.exit(0);
  });
}
