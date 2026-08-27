// npm run test:residuos — cuenta lo que una corrida de tests NO debió dejar en la BD del .env.
// Solo lectura. Exit 0 = cero residuos · 2 = hay residuos (los lista) · 1 = error.
// Lo cita el gate de cada ola (metodología v2, GATE.md §3) y el cierre de la implementación.
import { getDB, TEST_PLANTA_ID } from '../db.js';

const db = await getDB();
const q = async (sql) => (await db.request().query(sql)).recordset[0].n;

const checks = [
  ['registro_activo en planta de test', `SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['registro_historico en planta de test', `SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['registro_activo con TEST_TAG en detalle (planta real)', `SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id NOT IN ('${TEST_PLANTA_ID}','TSR') AND detalle LIKE '%TEST-RUN%'`],
  ['registro_historico con TEST_TAG en detalle (planta real)', `SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE planta_id NOT IN ('${TEST_PLANTA_ID}','TSR') AND detalle LIKE '%TEST-RUN%'`],
  ['sesiones sintéticas activas', `SELECT COUNT(*) AS n FROM bitacora.sesion_activa s JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id WHERE s.activa = 1 AND u.es_sintetico = 1`],
  ['conformacion_turno de usuarios sintéticos', `SELECT COUNT(*) AS n FROM bitacora.conformacion_turno c JOIN lov_bit.usuario u ON u.usuario_id = c.usuario_id WHERE u.es_sintetico = 1`],
  ['disponibilidad_estado en planta de test', `SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['evento_dashboard en planta de test', `SELECT COUNT(*) AS n FROM bitacora.evento_dashboard WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  // D-061 (L06 · CA-28): COMB y el SIS. El gate de la O1 tuvo que contar estas dos tablas con una
  // query a mano porque el script no las miraba, y son justo las que las suites de COMB/SIS
  // escriben ahora sobre la fixture. `lov_bit.combustible` de 'TST' NO se cuenta: es un catálogo
  // RESIDENTE (seed idempotente de db.js, igual que la fila 'TST' de lov_bit.planta), no residuo.
  ['consumo_combustible en planta de test', `SELECT COUNT(*) AS n FROM bitacora.consumo_combustible WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['sis_scrape_log en planta de test', `SELECT COUNT(*) AS n FROM bitacora.sis_scrape_log WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
];

let total = 0;
console.log(`[residuos] BD ${process.env.DB_NAME} · ${new Date().toISOString()}`);
for (const [nombre, sql] of checks) {
  try {
    const n = await q(sql);
    total += n;
    console.log(`  ${n === 0 ? 'ok ' : 'RES'} ${String(n).padStart(6)}  ${nombre}`);
  } catch (err) {
    console.log(`  n/a      -  ${nombre} (${err.message.split('\n')[0]})`);
  }
}
console.log(total === 0 ? '[residuos] cero residuos' : `[residuos] ${total} filas residuales — limpia con npm run test:reset-db antes de certificar`);
process.exit(total === 0 ? 0 : 2);
