// D-046 — Write-gate de TRANSICIÓN: durante la gavela de gracia (turno ABIERTO pero ya cruzó
// `fin_nominal`) el backend debe RECHAZAR POST/PUT/DELETE en bitácoras genéricas con 409
// `turno_en_transicion` — antes la gracia solo la tapaba el modal del front (evadible). Al extender se
// desbloquea; al cerrar cambia a `turno_cerrado` (código distinto). Corre contra la BD/servidor vivos
// (:3002, AUTH_TEST_BYPASS=1) sobre TEST_PLANTA ('TST', D-030) — nunca GEC3/GEC32.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { getTurnoColombia, fechaBogotaStr, ventanaActual, periodoFromFechaBogota, turnoFromPeriodo } from '../utils/turno.js';
import { abrirTurnoSiFalta } from '../utils/turno-entidad.js';
import { setupSessions, call, deactivateSyntheticSessions, TEST_PLANTA, TEST_TAG } from './helpers.js';

const turnoAhora = () => turnoFromPeriodo(periodoFromFechaBogota(new Date()));
const CARGO_TO_KEY = { 'Ingeniero Jefe de Turno': 'jdt', 'Ingeniero de Operación': 'ingOp' };

describe('Write-gate de transición (D-046)', () => {
  const P = TEST_PLANTA;
  let sesiones, BIT_GEN, TIPO_GEN, GEN_SESION;

  async function limpiarTurnos() {
    const db = await getDB();
    await db.request().input('p', sql.VarChar(10), P).query(`
      UPDATE ra SET turno_id = NULL FROM bitacora.registro_activo ra
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = ra.turno_id WHERE tu.planta_id = @p;
      UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
      DELETE FROM bitacora.conformacion_turno WHERE planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE planta_id = @p;
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
      -- D-065 (GATE-O2): rotacion_control y rotacion_cumplimiento referencian turno_unidad por FK.
      DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
      DELETE FROM bitacora.rotacion_control WHERE planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
  }

  // Deja la unidad con EXACTAMENTE un turno ABIERTO de la ventana vigente (fin_nominal futuro → sin gracia).
  async function abrirTurnoLimpio() {
    await limpiarTurnos();
    const { inicio } = ventanaActual();
    const t = await abrirTurnoSiFalta(await getDB(), P, getTurnoColombia(), fechaBogotaStr(inicio));
    assert.equal(t.estado, 'ABIERTO');
    return t;
  }

  // Adelanta/atrasa fin_nominal del turno ABIERTO de la unidad (simula el cruce del umbral).
  async function setFinNominal(fin) {
    const db = await getDB();
    await db.request()
      .input('p', sql.VarChar(10), P)
      .input('fin', sql.DateTime2, fin)
      .query(`UPDATE bitacora.turno_unidad SET fin_nominal = @fin WHERE planta_id = @p AND estado = 'ABIERTO'`);
  }

  const enGracia = () => new Date(Date.now() - 5 * 60_000);   // fin_nominal 5 min en el pasado
  const crearBorrador = () => call('POST', '/api/registros', {
    sesion_id: GEN_SESION,
    body: {
      bitacora_id: BIT_GEN, planta_id: P, fecha_evento: new Date().toISOString(),
      turno: turnoAhora(), detalle: `${TEST_TAG} d046 transicion`, tipo_evento_id: TIPO_GEN,
    },
  });

  before(async () => {
    ({ sesiones } = await setupSessions({ planta: P }));
    const db = await getDB();
    // Bitácora genérica (no MAND/DISP/COMB) creable por un cargo de test + su tipo_evento y sesión.
    const cargos = Object.keys(CARGO_TO_KEY).map((n) => `'${n}'`).join(',');
    const r = await db.request().query(`
      SELECT TOP 1 c.nombre AS cargo, b.bitacora_id, te.tipo_evento_id
      FROM lov_bit.cargo c
      JOIN lov_bit.cargo_bitacora_permiso p ON p.cargo_id = c.cargo_id AND p.puede_crear = 1
      JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
        AND b.activa = 1 AND b.codigo NOT IN ('MAND','DISP','COMB')
      JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
      WHERE c.nombre IN (${cargos})
      ORDER BY c.nombre, b.bitacora_id, te.tipo_evento_id`);
    assert.ok(r.recordset.length > 0, 'debe existir bitácora genérica creable por un cargo de test');
    BIT_GEN = r.recordset[0].bitacora_id;
    TIPO_GEN = r.recordset[0].tipo_evento_id;
    GEN_SESION = sesiones[CARGO_TO_KEY[r.recordset[0].cargo]];
  });

  after(async () => {
    await limpiarTurnos();
    await deactivateSyntheticSessions();
  });

  test('POST en la gracia → 409 turno_en_transicion (no se cuela)', async () => {
    await abrirTurnoLimpio();
    await setFinNominal(enGracia());
    const { status, data } = await crearBorrador();
    assert.equal(status, 409, `esperaba 409, fue ${status} ${JSON.stringify(data)}`);
    assert.equal(data.codigo, 'turno_en_transicion');
  });

  test('PUT y DELETE en la gracia → 409 turno_en_transicion', async () => {
    await abrirTurnoLimpio();
    // Crear el borrador ANTES de la gracia (fin_nominal futuro → POST permitido), luego cruzar el umbral.
    const creado = await crearBorrador();
    assert.equal(creado.status, 201, JSON.stringify(creado.data));
    const registro_id = creado.data.registro.registro_id;
    await setFinNominal(enGracia());

    const put = await call('PUT', `/api/registros/${registro_id}`, {
      sesion_id: GEN_SESION, body: { detalle: `${TEST_TAG} d046 editado`, turno: turnoAhora() },
    });
    assert.equal(put.status, 409, `PUT esperaba 409, fue ${put.status} ${JSON.stringify(put.data)}`);
    assert.equal(put.data.codigo, 'turno_en_transicion');

    const del = await call('DELETE', `/api/registros/${registro_id}`, { sesion_id: GEN_SESION });
    assert.equal(del.status, 409, `DELETE esperaba 409, fue ${del.status} ${JSON.stringify(del.data)}`);
    assert.equal(del.data.codigo, 'turno_en_transicion');
  });

  test('extender levanta el bloqueo → POST vuelve a 201', async () => {
    await abrirTurnoLimpio();
    await setFinNominal(enGracia());
    // Extender por el flujo real (JdT): fin_nominal salta al próximo umbral → estadoBloqueo=false.
    const ext = await call('POST', '/api/turno/extender', { sesion_id: sesiones.jdt, body: { planta_id: P } });
    assert.equal(ext.status, 200, `extender → ${ext.status} ${JSON.stringify(ext.data)}`);
    const { status, data } = await crearBorrador();
    assert.equal(status, 201, `tras extender esperaba 201, fue ${status} ${JSON.stringify(data)}`);
  });

  test('turno cerrado → 409 turno_cerrado (código distinto al de transición)', async () => {
    await abrirTurnoLimpio();
    const cerrar = await call('POST', '/api/turno/cerrar', { sesion_id: sesiones.jdt, body: { planta_id: P } });
    assert.equal(cerrar.status, 200, `cerrar → ${cerrar.status} ${JSON.stringify(cerrar.data)}`);
    const { status, data } = await crearBorrador();
    assert.equal(status, 409, `esperaba 409, fue ${status} ${JSON.stringify(data)}`);
    assert.equal(data.codigo, 'turno_cerrado');
  });
});
