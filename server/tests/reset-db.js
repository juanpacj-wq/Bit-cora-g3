// Rescate manual: limpia tablas test-affected cuando una corrida se aborta antes de
// `after()` (Ctrl+C, panic, kill -9). Idempotente, sin prompt — apto para scripting.
//
// Whitelist hardcoded por seguridad: solo borra filas creadas por los usuarios test
// y/o tagged con TEST_TAG en el detalle. NO afecta producción.
//
// Uso:
//   npm run test:reset-db
//
// Tablas barridas (orden FK-safe):
//   1. evento_dashboard          ← origen_id puede apuntar a un registro_activo a borrar.
//   2. disponibilidad_dashboard  ← idem registro_activo_id.
//   3. registro_activo           ← entradas creadas por test users o tagged TEST-RUN.
//   4. registro_historico        ← idem.
//   5. mand_cierre_log           ← (planta=GEC3, fecha_cerrada >= 2026-05-01).
//   6. sesion_activa             ← TODAS las sesiones sintéticas (es_sintetico=1), no solo las 4.
//   7. conformacion_turno        ← snapshots sintéticos (es_sintetico=1).

import sql from 'mssql';
import { getDB, TEST_PLANTA_ID } from '../db.js';

const TEST_USERNAMES = ['test_jdt', 'test_ingop', 'test_gerente', 'test_ingquim'];
const PLANTA_ID = 'GEC3';
const MAND_CIERRE_LOG_DESDE = '2026-05-01';
const TAG_LIKE = 'TEST-RUN-%';

async function main() {
  const db = await getDB();
  console.log(`[reset-db] Conectado. Whitelist: ${TEST_USERNAMES.join(', ')}`);

  // Resolver usuario_ids para evitar borrar por nombre (defensa contra typos / vista compat).
  const ur = await db.request().query(`
    SELECT usuario_id, username FROM lov_bit.usuario
    WHERE username IN (${TEST_USERNAMES.map((u) => `'${u}'`).join(',')})
  `);
  const idsByUsername = Object.fromEntries(ur.recordset.map((r) => [r.username, r.usuario_id]));
  const userIds = Object.values(idsByUsername);
  if (userIds.length === 0) {
    console.log('[reset-db] Ningún usuario test encontrado en lov_bit.usuario — nada que borrar.');
    process.exit(0);
  }
  console.log(`[reset-db] Resueltos ${userIds.length} usuarios: ${JSON.stringify(idsByUsername)}`);

  // Construir IN list con bindings safe.
  const idList = userIds.join(',');

  const counts = {};

  // 1. evento_dashboard: filas que apuntan a registro_activo creado por test users o tagged.
  let r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .query(`
      DELETE FROM bitacora.evento_dashboard
      WHERE registro_origen_id IN (
        SELECT registro_id FROM bitacora.registro_activo
        WHERE creado_por IN (${idList}) OR detalle LIKE @tag
      )
        OR registro_origen_id IN (
        SELECT registro_id FROM bitacora.registro_historico
        WHERE creado_por IN (${idList}) OR detalle LIKE @tag
      );
    `);
  counts.evento_dashboard = r.rowsAffected[0];

  // 2. disponibilidad_estado (D-041): TABLA BASE, acotado a la PLANTA DE TEST. Los tests solo
  // escriben DISP en TEST_PLANTA, así que ese es el único borrado seguro. NUNCA GEC3/GEC32.
  // La versión anterior borraba a través de la VISTA disponibilidad_dashboard con planta_id=GEC3 y
  // un join roto (`registro_activo_id` = disponibilidad_id, distinto id-space que registro_activo):
  // podía eliminar el vigente REAL de GEC3 por colisión de ids. La vista ahora es de solo lectura
  // (trigger en BD), así que ese DELETE ni siquiera compilaría.
  r = await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @tp;`);
  counts.disponibilidad_estado = r.rowsAffected[0];

  // 3. registro_activo: TEST users + tagged.
  r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE creado_por IN (${idList}) OR detalle LIKE @tag
        OR planta_id IN ('${TEST_PLANTA_ID}', 'TSR');   -- plantas de test (D-030/D-058): todo lo que haya ahí es residuo, incluidos los CIET del sweeper
    `);
  counts.registro_activo = r.rowsAffected[0];

  // 4. registro_historico: idem.
  r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .query(`
      DELETE FROM bitacora.registro_historico
      WHERE creado_por IN (${idList}) OR detalle LIKE @tag
        OR planta_id IN ('${TEST_PLANTA_ID}', 'TSR');   -- plantas de test (D-030/D-058): todo lo que haya ahí es residuo, incluidos los CIET del sweeper
    `);
  counts.registro_historico = r.rowsAffected[0];

  // 5. mand_cierre_log: planta GEC3 desde 2026-05-01 (rango cubre fechas determinísticas y
  // cualquier día Bogotá donde el sweeper haya disparado durante runs test).
  r = await db.request()
    .input('p', sql.VarChar(10), PLANTA_ID)
    .input('desde', sql.Date, new Date(MAND_CIERRE_LOG_DESDE))
    .query(`
      DELETE FROM bitacora.mand_cierre_log
      WHERE planta_id = @p AND fecha_cerrada >= @desde;
    `);
  counts.mand_cierre_log = r.rowsAffected[0];

  // 6. sesion_activa: marca inactivas TODAS las sesiones sintéticas (es_sintetico=1), no solo las de
  // los 4 TEST_USERNAMES — cubre también test_opcarbon/test_coord_cym/… que suites puntuales siembran
  // en GEC3 y que la whitelist de 4 dejaba activas en el panel CONECTADOS de prod (bug 2026-07-05).
  // No DELETE: preserva la FK con `sesion_bitacora`. es_sintetico=1 jamás matchea un operador real (D-044).
  r = await db.request().query(`
    UPDATE bitacora.sesion_activa SET activa = 0
    WHERE activa = 1
      AND usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE es_sintetico = 1);
  `);
  counts.sesion_activa_desactivadas = r.rowsAffected[0];

  // 7. conformacion_turno: snapshots seedeados por tests dirigidos del builder/endpoints. Por
  // es_sintetico=1 (paridad con cleanupTestRegistros): cubre cualquier fixture, no solo los 4.
  r = await db.request().query(`
    DELETE FROM bitacora.conformacion_turno
    WHERE usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE es_sintetico = 1);
  `);
  counts.conformacion_turno = r.rowsAffected[0];

  console.log('[reset-db] Resumen:');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(30)} ${v}`);
  }
  console.log('[reset-db] OK.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[reset-db] ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
