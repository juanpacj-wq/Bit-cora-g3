// D-045 E5 — el INSERT genérico de /api/registros estampa registro_activo.turno_id = turno ABIERTO
// de la unidad. MAND (endpoint propio) y DISP (tabla disponibilidad_estado) quedan exentos. Corre
// contra la BD productiva → SOLO TEST_PLANTA ('TST', D-030) y usuarios test_*.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, call, TEST_PLANTA, TEST_TAG } from './helpers.js';
import { periodoFromFechaBogota, turnoFromPeriodo } from '../utils/turno.js';

const turnoAhora = () => turnoFromPeriodo(periodoFromFechaBogota(new Date()));
const CARGO_TO_KEY = { 'Ingeniero Jefe de Turno': 'jdt', 'Ingeniero de Operación': 'ingOp' };

let ctx, BIT_GEN, TIPO_GEN, GEN_SESION;

async function limpiar() {
  const db = await getDB();
  const inUids = Object.values(ctx.usuarios).map((u) => u.usuario_id).join(',');
  await db.request().query(
    `DELETE FROM bitacora.registro_activo WHERE creado_por IN (${inUids}) AND planta_id='${TEST_PLANTA}'`);
  // Romper refs a los turnos de TST antes de borrarlos (FK turno_id → turno_unidad).
  await db.request().input('p', sql.VarChar(10), TEST_PLANTA).query(`
    UPDATE ra SET turno_id=NULL FROM bitacora.registro_activo ra
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=ra.turno_id WHERE tu.planta_id=@p;
    UPDATE sa SET turno_id=NULL FROM bitacora.sesion_activa sa
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=sa.turno_id WHERE tu.planta_id=@p;
    DELETE tp FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id=tp.turno_id WHERE tu.planta_id=@p;
    DELETE FROM bitacora.turno_unidad WHERE planta_id=@p;
  `);
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  const db = await getDB();
  // Bitácora genérica (no MAND/DISP/COMB) creable por un cargo de test + su tipo_evento y sesión.
  const cargos = Object.keys(CARGO_TO_KEY).map((n) => `'${n}'`).join(',');
  const r = await db.request().query(`
    SELECT TOP 1 c.nombre AS cargo, b.bitacora_id, te.tipo_evento_id
    FROM lov_bit.cargo c
    JOIN lov_bit.cargo_bitacora_permiso p ON p.cargo_id=c.cargo_id AND p.puede_crear=1
    JOIN lov_bit.bitacora b ON b.bitacora_id=p.bitacora_id
      AND b.activa=1 AND b.codigo NOT IN ('MAND','DISP','COMB')
    JOIN lov_bit.tipo_evento te ON te.bitacora_id=b.bitacora_id
    WHERE c.nombre IN (${cargos})
    ORDER BY c.nombre, b.bitacora_id, te.tipo_evento_id`);
  assert.ok(r.recordset.length > 0, 'debe existir bitácora genérica creable por un cargo de test');
  BIT_GEN = r.recordset[0].bitacora_id;
  TIPO_GEN = r.recordset[0].tipo_evento_id;
  GEN_SESION = ctx.sesiones[CARGO_TO_KEY[r.recordset[0].cargo]];
  await limpiar();
});

after(async () => { await limpiar(); });

test('POST genérico en TST estampa turno_id = cabecera ABIERTO de la unidad (no-MAND/DISP)', async () => {
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: GEN_SESION,
    body: {
      bitacora_id: BIT_GEN, planta_id: TEST_PLANTA, fecha_evento: new Date().toISOString(),
      turno: turnoAhora(), detalle: `${TEST_TAG} e5 turno_id`, tipo_evento_id: TIPO_GEN,
    },
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.ok(data.registro.turno_id != null, 'registro.turno_id estampado');

  // Debe coincidir con la única cabecera ABIERTO de TST (creada por abrirTurnoSiFalta en el borde).
  const db = await getDB();
  const t = (await db.request().input('p', sql.VarChar(10), TEST_PLANTA)
    .query(`SELECT turno_unidad_id FROM bitacora.turno_unidad WHERE planta_id=@p AND estado='ABIERTO'`)).recordset;
  assert.equal(t.length, 1, 'exactamente una cabecera ABIERTO en TST');
  assert.equal(data.registro.turno_id, t[0].turno_unidad_id, 'turno_id coincide con la cabecera ABIERTO');
});
