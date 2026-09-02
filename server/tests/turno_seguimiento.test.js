// D-045 E9 — GET /api/turno/seguimiento + /:turnoId/participantes. Integración contra el server vivo
// (backdoor AUTH_TEST_BYPASS). Opera SOLO sobre TEST_PLANTA (D-030): crea turnos con distintos
// motivo_cierre vía las funciones de dominio y verifica que el endpoint los lista y distingue los
// auto-cerrados, y que el detalle de participantes sale de conformación (cerrado) o turno_participante (vivo).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID, USUARIO_SISTEMA_ID } from '../db.js';
import { abrirTurnoSiFalta, cerrarTurno, marcarParticipante } from '../utils/turno-entidad.js';
import { setupSessions, call, TEST_PLANTA } from './helpers.js';

describe('GET /api/turno/seguimiento (D-045 E9)', () => {
  let pool, ctx;
  const P = TEST_PLANTA_ID;

  async function limpiar() {
    await pool.request().input('p', sql.VarChar(10), P).query(`
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
      -- D-065 (GATE-O2): rotacion_control y rotacion_cumplimiento referencian turno_unidad por FK.
      DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
      DELETE FROM bitacora.rotacion_control WHERE planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
  }

  before(async () => {
    await initDB();
    pool = await getDB();
    ctx = await setupSessions({ planta: TEST_PLANTA });
    await limpiar();
  });

  after(async () => { await limpiar(); });

  test('lista los turnos del rango con estado/motivo_cierre/nº participantes y distingue auto-cerrados', async () => {
    // T1 cerrado MANUAL (con 1 participante) y T2 auto-cerrado AUTO_SIN_PERSONAL, mismo día operativo.
    const a = await abrirTurnoSiFalta(pool, P, 1, '2026-03-01', new Date('2026-03-01T15:00:00Z'));
    await marcarParticipante(pool, { turno_id: a.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: (await pool.request().query(`SELECT TOP 1 cargo_id FROM lov_bit.cargo ORDER BY cargo_id`)).recordset[0].cargo_id, cargo_nombre: 'SISTEMA' });
    await cerrarTurno(pool, a.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA', ahora: new Date('2026-03-01T23:05:00Z'), incluirSinteticos: true });
    // Cerrado a=T1 → la unidad queda libre y b=T2 nace ABIERTO; lo auto-cerramos.
    const b = await abrirTurnoSiFalta(pool, P, 2, '2026-03-01', new Date('2026-03-01T23:10:00Z'));
    await cerrarTurno(pool, b.turno_unidad_id, { motivo: 'AUTO_SIN_PERSONAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA', ahora: new Date('2026-03-02T11:05:00Z') });

    const { status, data } = await call('GET', `/api/turno/seguimiento?planta=${P}&desde=2026-03-01&hasta=2026-03-02`, { sesion_id: ctx.sesiones.jdt });
    assert.equal(status, 200);
    const ta = data.turnos.find((t) => t.turno_unidad_id === a.turno_unidad_id);
    const tb = data.turnos.find((t) => t.turno_unidad_id === b.turno_unidad_id);
    assert.ok(ta && tb, 'ambos turnos aparecen en el rango');
    assert.equal(ta.estado, 'CERRADO');
    assert.equal(ta.motivo_cierre, 'MANUAL');
    assert.equal(ta.n_participantes, 1);
    assert.ok(ta.duracion_real_min > 0, 'duración real calculada');
    assert.equal(tb.motivo_cierre, 'AUTO_SIN_PERSONAL');
  });

  test('participantes: turno CERRADO sale de la conformación congelada', async () => {
    await limpiar();
    const cargo = (await pool.request().query(`SELECT TOP 1 cargo_id FROM lov_bit.cargo ORDER BY cargo_id`)).recordset[0];
    const t = await abrirTurnoSiFalta(pool, P, 1, '2026-03-03', new Date('2026-03-03T15:00:00Z'));
    await marcarParticipante(pool, { turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargo.cargo_id, cargo_nombre: 'SISTEMA' });
    await cerrarTurno(pool, t.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA', ahora: new Date('2026-03-03T23:05:00Z'), incluirSinteticos: true });

    const { status, data } = await call('GET', `/api/turno/seguimiento/${t.turno_unidad_id}/participantes`, { sesion_id: ctx.sesiones.jdt });
    assert.equal(status, 200);
    assert.equal(data.cerrado, true);
    assert.equal(data.participantes.length, 1);
    assert.equal(data.participantes[0].usuario_id, USUARIO_SISTEMA_ID);
  });

  test('participantes: turno VIVO sale de turno_participante (presencia en curso)', async () => {
    await limpiar();
    const cargo = (await pool.request().query(`SELECT TOP 1 cargo_id FROM lov_bit.cargo ORDER BY cargo_id`)).recordset[0];
    const t = await abrirTurnoSiFalta(pool, P, 1, '2026-03-04', new Date('2026-03-04T15:00:00Z'));
    await marcarParticipante(pool, { turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargo.cargo_id, cargo_nombre: 'SISTEMA' });

    const { status, data } = await call('GET', `/api/turno/seguimiento/${t.turno_unidad_id}/participantes`, { sesion_id: ctx.sesiones.jdt });
    assert.equal(status, 200);
    assert.equal(data.cerrado, false);
    assert.equal(data.participantes.length, 1);
    assert.equal(data.participantes[0].usuario_id, USUARIO_SISTEMA_ID);
    await limpiar();
  });

  test('turno inexistente → 404; id inválido → 400', async () => {
    const r404 = await call('GET', '/api/turno/seguimiento/999999999/participantes', { sesion_id: ctx.sesiones.jdt });
    assert.equal(r404.status, 404);
    const r400 = await call('GET', '/api/turno/seguimiento/abc/participantes', { sesion_id: ctx.sesiones.jdt });
    assert.equal(r400.status, 400);
  });
});
