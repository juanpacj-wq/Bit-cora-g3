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
//   6. sesion_activa             ← sesiones de los test users.

import sql from 'mssql';
import { getDB } from '../db.js';

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

  // 2. disponibilidad_dashboard: filas asociadas a registro_activo test (FK lógico).
  r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .input('p', sql.VarChar(10), PLANTA_ID)
    .query(`
      DELETE FROM bitacora.disponibilidad_dashboard
      WHERE planta_id = @p
        AND (registro_activo_id IN (
              SELECT registro_id FROM bitacora.registro_activo
              WHERE creado_por IN (${idList}) OR detalle LIKE @tag
            ) OR registro_activo_id IS NULL);
    `);
  counts.disponibilidad_dashboard = r.rowsAffected[0];

  // 3. registro_activo: TEST users + tagged.
  r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE creado_por IN (${idList}) OR detalle LIKE @tag;
    `);
  counts.registro_activo = r.rowsAffected[0];

  // 4. registro_historico: idem.
  r = await db.request()
    .input('tag', sql.NVarChar(200), `%${TAG_LIKE}%`)
    .query(`
      DELETE FROM bitacora.registro_historico
      WHERE creado_por IN (${idList}) OR detalle LIKE @tag;
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

  // 6. sesion_activa: marca inactivas las sesiones de los test users (no DELETE para preservar
  // FK con `sesion_bitacora`, que sí persistirá referenciable si algún test reactivara).
  r = await db.request().query(`
    UPDATE bitacora.sesion_activa SET activa = 0
    WHERE usuario_id IN (${idList}) AND activa = 1;
  `);
  counts.sesion_activa_desactivadas = r.rowsAffected[0];

  // 7. conformacion_turno: snapshots seedeados por tests dirigidos del builder/endpoints.
  r = await db.request().query(`
    DELETE FROM bitacora.conformacion_turno
    WHERE usuario_id IN (${idList});
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
