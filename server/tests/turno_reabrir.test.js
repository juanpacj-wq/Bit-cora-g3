// D-045 (reabrir) — test de integración del endpoint POST /api/turno/reabrir contra la BD/servidor
// vivo, sobre TEST_PLANTA ('TST', D-030) — nunca GEC3/GEC32. Cubre la regresión del bug de
// fecha_operativa (Date de BD → 'ventana_vencida' siempre): el flujo cerrar→reabrir por HTTP debe
// devolver la unidad a ABIERTO. Requiere el server en :3002 con AUTH_TEST_BYPASS=1 (harness `call`).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB, TEST_PLANTA_ID } from '../db.js';
import { getTurnoColombia, fechaBogotaStr, ventanaActual } from '../utils/turno.js';
import { abrirTurnoSiFalta } from '../utils/turno-entidad.js';
import { setupSessions, deactivateSyntheticSessions, call } from './helpers.js';

describe('POST /api/turno/reabrir (D-045)', () => {
  let sesiones;
  const P = TEST_PLANTA_ID;

  async function limpiarTurnos() {
    const db = await getDB();
    await db.request().input('p', sql.VarChar(10), P).query(`
      UPDATE sa SET turno_id = NULL
        FROM bitacora.sesion_activa sa
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id
       WHERE tu.planta_id = @p;
      DELETE FROM bitacora.conformacion_turno WHERE planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE planta_id = @p;
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
       WHERE tu.planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
  }

  before(async () => {
    ({ sesiones } = await setupSessions({ planta: P }));
    await limpiarTurnos();
  });

  after(async () => {
    await limpiarTurnos();
    await deactivateSyntheticSessions();
  });

  test('cerrar → reabrir por endpoint devuelve la unidad a ABIERTO (regresión fecha_operativa)', async () => {
    await limpiarTurnos();
    // Abrir el turno de la VENTANA VIGENTE (resolverTurnoReabrible usa el `now` real del server).
    const { inicio } = ventanaActual();
    const abierto = await abrirTurnoSiFalta(await getDB(), P, getTurnoColombia(), fechaBogotaStr(inicio));
    assert.equal(abierto.estado, 'ABIERTO');

    // Cerrar por endpoint (JdT, puede_cerrar_turno).
    const cerrar = await call('POST', '/api/turno/cerrar', { body: { planta_id: P }, sesion_id: sesiones.jdt });
    assert.equal(cerrar.status, 200, `cerrar → ${cerrar.status} ${JSON.stringify(cerrar.data)}`);
    assert.equal(cerrar.data.cerrado, true);

    // La unidad queda sin turno abierto.
    const actualCerrado = await call('GET', '/api/turno/actual', { sesion_id: sesiones.jdt });
    assert.equal(actualCerrado.data.estado, null);

    // Reabrir por endpoint — ANTES del fix esto devolvía 409 'ventana_vencida'.
    const reabrir = await call('POST', '/api/turno/reabrir', { body: { planta_id: P }, sesion_id: sesiones.jdt });
    assert.equal(reabrir.status, 200, `reabrir → ${reabrir.status} ${JSON.stringify(reabrir.data)}`);
    assert.equal(reabrir.data.reabierto, true);
    assert.equal(reabrir.data.turno_id, abierto.turno_unidad_id);

    // La unidad vuelve a ABIERTO.
    const actualReabierto = await call('GET', '/api/turno/actual', { sesion_id: sesiones.jdt });
    assert.equal(actualReabierto.data.estado, 'ABIERTO');
  });

  test('reabrir sin turno cerrado reabrible → 409 sin_turno_reabrible', async () => {
    await limpiarTurnos();
    const r = await call('POST', '/api/turno/reabrir', { body: { planta_id: P }, sesion_id: sesiones.jdt });
    assert.equal(r.status, 409);
    assert.equal(r.data.codigo, 'sin_turno_reabrible');
  });

  test('reabrir sin permiso (Ingeniero Químico) → 403', async () => {
    const r = await call('POST', '/api/turno/reabrir', { body: { planta_id: P }, sesion_id: sesiones.ingQuim });
    assert.equal(r.status, 403);
  });
});
