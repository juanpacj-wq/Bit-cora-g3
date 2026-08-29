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
//
// D-063 L02 (contrato C6) — SEGUNDO invariante, mismo espíritu: la planta-fixture del reflejo
// ('TSR') queda APAGADA (`activa = 0`) al cerrar la suite. `activa = 0` es lo único que la mantiene
// invisible fuera de los tests: `GET /api/catalogos/plantas` y `validarPlantaOperable` filtran por
// `activa = 1`, así que encendida aparecería en el selector de unidad del login de PRODUCCIÓN como
// una planta más. Y encenderla es necesario: `disponibilidad_reflejo_http` la prende para poder
// postear DISP (el POST/PUT exigen `activa = 1`), igual que otras suites crean sesiones — con la
// misma doble función, detección en test() y limpieza incondicional en after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID } from '../db.js';
import { deactivateSyntheticSessions, TEST_PLANTA_REFLEJO } from './helpers.js';

let db;
before(async () => { await initDB(); db = await getDB(); });

// La red de seguridad va en after() para que corra aunque el test de detección falle. Las dos
// limpiezas son independientes: la de TSR va primero y en su propio try, para que un fallo suyo no
// impida desactivar las sesiones (que es lo que ensucia el panel CONECTADOS real).
after(async () => {
  try {
    await db.request()
      .input('tsr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
      .query(`UPDATE lov_bit.planta SET activa = 0 WHERE planta_id = @tsr`);
  } finally {
    await deactivateSyntheticSessions();
  }
});

test('ninguna sesión sintética queda activa en una planta real al cerrar la suite', async () => {
  // D-058 E4: la segunda planta-fixture ('TSR', la que SÍ refleja) también queda fuera. No es una
  // grieta en el invariante: se siembra con `activa = 0`, así que ni el selector del login
  // (`GET /api/catalogos/plantas`) ni `validarPlantaOperable` la aceptan — una sesión sintética ahí
  // no puede aparecer en el panel CONECTADOS de nadie, que es lo que este guard protege. El `after()`
  // la desactiva igual.
  const { recordset: leaks } = await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      SELECT u.username, sa.planta_id, sa.turno, COUNT(*) AS n
      FROM bitacora.sesion_activa sa
      JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
      WHERE sa.activa = 1 AND u.es_sintetico = 1 AND sa.planta_id NOT IN (@tp, @tpr)
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

// D-063 L02 (contrato C6). Detección: si TSR quedó encendida, el suite que la prendió no la apagó.
// El after() de arriba la apaga igual —producción no se queda sucia—, pero el test sale ROJO para
// que el olvido se arregle en el archivo que lo cometió y no dependa de esta red de seguridad.
test('la planta-fixture TSR queda apagada (activa = 0) al cerrar la suite', async () => {
  const { recordset } = await db.request()
    .input('tsr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`SELECT activa FROM lov_bit.planta WHERE planta_id = @tsr`);
  // Si la fila no existe, nadie sembró la fixture en esta corrida: no hay nada que apagar.
  if (recordset.length === 0) return;
  // `!` y no `=== false`: el driver puede entregar el BIT como boolean o como 0/1 según la versión.
  assert.ok(
    !recordset[0].activa,
    `La planta-fixture ${TEST_PLANTA_REFLEJO} quedó ACTIVA. Encendida aparece en el selector de ` +
      `unidad del login de producción. El suite que la prendió (hoy disponibilidad_reflejo_http, ` +
      `que la necesita activa para postear DISP) DEBE devolverla a activa = 0 en su after().`,
  );
});
