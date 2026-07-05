// GUARD FINAL de fuga de sesiones de test — DEBE ir ÚLTIMO en el script `test` de package.json.
//
// Invariante: al terminar la suite, NINGUNA sesión sintética (`es_sintetico=1`) debe quedar ACTIVA
// en una planta real (≠ TEST_PLANTA). La suite corre contra la BD de PRODUCCIÓN (D-030), así que una
// sesión de test activa en GEC3/GEC32 aparece en el panel CONECTADOS real de los operadores. Ese fue
// el bug del 2026-07-05: `test_opcarbon`/`test_coord_cym` quedaban colgadas en GEC3 porque su cleanup
// era una whitelist de 4 usernames que no las contemplaba.
//
// Doble función (por eso detección en test() y limpieza en after()):
//   1. DETECCIÓN (test): FALLA —nombrando al ofensor— si algún suite dejó una sesión sintética activa
//      en una planta real. Una regresión futura (un test nuevo que olvide desactivar sus sesiones)
//      sale ROJA de inmediato, con el username/planta que hay que arreglar.
//   2. RED DE SEGURIDAD (after): desactiva TODA sesión sintética pase lo que pase, de modo que prod
//      SIEMPRE queda limpia al terminar la corrida — incluso si un test crasheó antes de su after().
//
// El fix de raíz es que cada suite que cree sesiones llame `deactivateSyntheticSessions()` en su
// after(); este guard es la garantía de que el olvido nunca vuelva a ensuciar producción.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID } from '../db.js';
import { deactivateSyntheticSessions } from './helpers.js';

let db;
before(async () => { await initDB(); db = await getDB(); });

// La red de seguridad va en after() para que corra aunque el test de detección falle.
after(async () => { await deactivateSyntheticSessions(); });

test('ninguna sesión sintética queda activa en una planta real al cerrar la suite', async () => {
  const { recordset: leaks } = await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      SELECT u.username, sa.planta_id, sa.turno, COUNT(*) AS n
      FROM bitacora.sesion_activa sa
      JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      WHERE sa.activa = 1 AND u.es_sintetico = 1 AND sa.planta_id <> @tp
      GROUP BY u.username, sa.planta_id, sa.turno
      ORDER BY sa.planta_id, u.username
    `);
  const detalle = leaks.map((l) => `${l.username}@${l.planta_id} T${l.turno} (x${l.n})`).join(', ');
  assert.equal(
    leaks.length,
    0,
    `Sesiones sintéticas activas filtradas a planta real. El suite que las creó DEBE llamar ` +
      `deactivateSyntheticSessions() en su after(): ${detalle}`,
  );
});
