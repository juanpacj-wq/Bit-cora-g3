// D-059 — rol "USUARIO DE CONSULTA" (observador): solo lectura total e INVISIBLE.
//
// Fija el contrato completo del rol:
//   (a) flags del cargo (solo_lectura=1, puede_cerrar_turno=0, puede_cambiar_unidad=1,
//       es_observador=1) y el MERGE auto-corrector que los re-fija en cada arranque;
//   (b) matriz [puede_ver=1, puede_crear=0] en TODA bitácora activa (incluido DISP vía F12.A6);
//   (c) gates runtime: GETs 200, escrituras 403, finalizar/revertir 403 estable, /abrir no-op
//       sin fila de presencia, IA 403;
//   (d) cortes de invisibilidad: usuarios-activos (HTTP y WS), preview-masivo, snapshots de
//       ingenieros, participación de turno (sesion-contexto), conformación y hayPersonal.
//
// Todo sobre TEST_PLANTA ('TST', D-030/D-055) — nunca sobre GEC3/GEC32. Las cabeceras de turno
// que este suite crea en TST se limpian SIEMPRE (una cabecera residual en TST hace flakear a
// finalizar_turno — ver docs/decisions.md D-045/D-046).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID, USUARIO_SISTEMA_ID } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { getTurnoColombia } from '../utils/turno.js';
import { setupSessions, call, TEST_PLANTA, deactivateSyntheticSessions } from './helpers.js';
import { establecerContextoSesion } from '../utils/sesion-contexto.js';
import { snapshotIngenieros } from '../utils/snapshots.js';
import { fetchSnapshot } from '../utils/ws-usuarios-activos.js';
import {
  abrirTurnoSiFalta,
  cerrarTurno,
  marcarParticipante,
  transicionarTurnosVencidos,
} from '../utils/turno-entidad.js';

const NOMBRE_CARGO = 'USUARIO DE CONSULTA';

let pool;
let ctx;              // setupSessions(): { sesiones, usuarios, bitByCodigo }
let consulta;         // { sesion_id, usuario_id, cargo_id }
let cargoIngQuim;     // control positivo en snapshots/conformación

// Fixture local del suite (patrón rol_coordinador): usuario sintético test_consulta con sesión
// activa en TEST_PLANTA. El prefijo `test_` es OBLIGATORIO (seed es_sintetico=1, D-044).
async function setupConsulta() {
  const db = await getDB();
  const passwordHash = await hashPassword('inerte-no-login-entra-only');
  await db.request()
    .input('nombre', sql.VarChar(200), 'Test Usuario Consulta')
    .input('username', sql.VarChar(50), 'test_consulta')
    .input('pwd', sql.VarChar(200), passwordHash)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET activo = 1, nombre_completo = @nombre
      WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
        VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1);
    `);
  const u = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = 'test_consulta'`)
  ).recordset[0];
  const c = (await db.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @n`)
  ).recordset[0];
  assert.ok(c, `el cargo '${NOMBRE_CARGO}' debe existir (seed de db.js)`);

  await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
  const ins = await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .input('planta_id', sql.VarChar(10), TEST_PLANTA)
    .input('cargo_id', sql.Int, c.cargo_id)
    .input('turno', sql.TinyInt, getTurnoColombia())
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);
  return { sesion_id: ins.recordset[0].sesion_id, usuario_id: u.usuario_id, cargo_id: c.cargo_id };
}

// Limpia TODO rastro de turnos en TST (patrón turno-entidad.test.js): primero las filas que
// referencian turno_unidad por FK, luego la cabecera. Los DELETE de registro_activo/historico van
// acotados a TEST_PLANTA_ID (guard_no_prod_historico_destruction).
async function limpiarTurnos() {
  await pool.request().input('p', sql.VarChar(10), TEST_PLANTA_ID).query(`
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

async function permiso(codigoBitacora) {
  const r = await pool.request()
    .input('cargo_id', sql.Int, consulta.cargo_id)
    .input('cod', sql.VarChar(10), codigoBitacora)
    .query(`
      SELECT p.puede_ver, p.puede_crear
      FROM lov_bit.cargo_bitacora_permiso p
      JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
      WHERE p.cargo_id = @cargo_id AND b.codigo = @cod
    `);
  return r.recordset[0] || null;
}

const hoyBogota = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  pool = await getDB();
  consulta = await setupConsulta();
  cargoIngQuim = (await pool.request()
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Ingeniero Químico'`)).recordset[0].cargo_id;
  await limpiarTurnos();
});

after(async () => {
  await limpiarTurnos();
  await deactivateSyntheticSessions();
});

// ---------------------------------------------------------------------------
// (a) + (b) — cargo y matriz
// ---------------------------------------------------------------------------

test('1. El cargo existe una sola vez con los flags D-059 (solo_lectura=1, cerrar=0, cambiar_unidad=1, es_observador=1)', async () => {
  const r = await pool.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`
      SELECT CAST(solo_lectura AS INT) AS sl, CAST(puede_cerrar_turno AS INT) AS pct,
             CAST(puede_cambiar_unidad AS INT) AS pcu, CAST(es_observador AS INT) AS obs
      FROM lov_bit.cargo WHERE nombre = @n
    `);
  assert.equal(r.recordset.length, 1, 'el cargo debe existir exactamente una vez');
  assert.equal(r.recordset[0].sl, 1, 'solo_lectura debe ser 1');
  assert.equal(r.recordset[0].pct, 0, 'puede_cerrar_turno debe ser 0');
  assert.equal(r.recordset[0].pcu, 1, 'puede_cambiar_unidad debe ser 1 (atajo GEC3↔GEC32)');
  assert.equal(r.recordset[0].obs, 1, 'es_observador debe ser 1');
});

test('2. Matriz: puede_ver=1 y puede_crear=0 en TODA bitácora activa (lectura total, cero escritura)', async () => {
  const r = await pool.request()
    .input('cargo_id', sql.Int, consulta.cargo_id)
    .query(`
      SELECT b.codigo,
             CAST(ISNULL(p.puede_ver, 0)   AS INT) AS ver,
             CAST(ISNULL(p.puede_crear, 0) AS INT) AS crear
      FROM lov_bit.bitacora b
      LEFT JOIN lov_bit.cargo_bitacora_permiso p
        ON p.bitacora_id = b.bitacora_id AND p.cargo_id = @cargo_id
      WHERE b.activa = 1
    `);
  assert.ok(r.recordset.length > 0, 'debe haber bitácoras activas');
  const fallos = r.recordset
    .filter((row) => row.ver !== 1 || row.crear !== 0)
    .map((row) => `${row.codigo}=[${row.ver},${row.crear}]`);
  assert.deepEqual(fallos, [], `toda bitácora activa debe quedar [1,0]; fallan: ${fallos.join(', ')}`);
});

// ---------------------------------------------------------------------------
// (c) — gates runtime (HTTP, sesión del observador)
// ---------------------------------------------------------------------------

test('3. Lectura: los GET responden 200 (registros/activos, históricos, COMB, DISP, MAND, turno/actual)', async () => {
  const s = { sesion_id: consulta.sesion_id };
  const gets = [
    `/api/registros/activos?planta_id=${TEST_PLANTA}`,
    `/api/historicos?planta_id=${TEST_PLANTA}&page=1&limit=5`,
    // El catálogo COMB valida una allowlist GEC3|GEC32 ANTES de todo (hardcode pendiente de
    // D-055) y NO hace plantaMatch: es un catálogo de solo lectura, pedir GEC3 es seguro.
    `/api/combustibles/catalogo?planta_id=GEC3`,
    `/api/disponibilidad?planta_id=${TEST_PLANTA}`,
    // D-056: el pivote GET /api/sala-de-mando ya no existe (404); el listado del día es /lotes.
    `/api/sala-de-mando/lotes?planta_id=${TEST_PLANTA}&fecha=${hoyBogota()}`,
    `/api/turno/actual`,
  ];
  for (const path of gets) {
    const r = await call('GET', path, s);
    assert.equal(r.status, 200, `${path} debía dar 200, llegó ${r.status} ${JSON.stringify(r.data)}`);
  }
});

test('4. /api/turno/actual: puede_decidir=false (no decide cierre/extensión)', async () => {
  const r = await call('GET', '/api/turno/actual', { sesion_id: consulta.sesion_id });
  assert.equal(r.status, 200);
  assert.equal(r.data.puede_decidir, false);
});

test('5. Escritura: POST registros genérico, DISP, MAND guardar y COMB → 403 por matriz', async () => {
  const s = consulta.sesion_id;

  const tipoCaldera = (await pool.request()
    .input('b', sql.Int, ctx.bitByCodigo.CALDERA)
    .query(`SELECT TOP 1 tipo_evento_id FROM lov_bit.tipo_evento WHERE bitacora_id = @b ORDER BY orden`)
  ).recordset[0].tipo_evento_id;
  const generico = await call('POST', '/api/registros', {
    sesion_id: s,
    body: {
      bitacora_id: ctx.bitByCodigo.CALDERA, planta_id: TEST_PLANTA,
      fecha_evento: new Date().toISOString(), turno: getTurnoColombia(),
      detalle: 'no debe insertarse', tipo_evento_id: tipoCaldera,
    },
  });
  assert.equal(generico.status, 403, `registros genérico: ${JSON.stringify(generico.data)}`);

  const disp = await call('POST', '/api/registros', {
    sesion_id: s,
    body: { bitacora_id: ctx.bitByCodigo.DISP, planta_id: TEST_PLANTA },
  });
  assert.equal(disp.status, 403, `DISP: ${JSON.stringify(disp.data)}`);

  const mand = await call('POST', '/api/sala-de-mando/guardar', {
    sesion_id: s,
    body: { planta_id: TEST_PLANTA, fecha: hoyBogota(), filas: [] },
  });
  assert.equal(mand.status, 403, `MAND guardar: ${JSON.stringify(mand.data)}`);

  const comb = await call('POST', '/api/combustibles/consumos', {
    sesion_id: s,
    body: { planta_id: 'GEC3', fecha: hoyBogota(), celdas: [] },
  });
  assert.equal(comb.status, 403, `COMB: ${JSON.stringify(comb.data)}`);
});

test('6. Finalizar/revertir turno → 403 observador_sin_finalizacion (código estable)', async () => {
  const fin = await call('POST', '/api/bitacora/finalizar', { sesion_id: consulta.sesion_id, body: {} });
  assert.equal(fin.status, 403, JSON.stringify(fin.data));
  assert.equal(fin.data.codigo, 'observador_sin_finalizacion');

  const rev = await call('POST', '/api/bitacora/revertir-turno', { sesion_id: consulta.sesion_id, body: {} });
  assert.equal(rev.status, 403, JSON.stringify(rev.data));
  assert.equal(rev.data.codigo, 'observador_sin_finalizacion');
});

test('7. /api/bitacora/abrir → 200 no-op: sesion_bitacora null y CERO filas de presencia', async () => {
  const r = await call('POST', '/api/bitacora/abrir', {
    sesion_id: consulta.sesion_id,
    body: { bitacora_id: ctx.bitByCodigo.CALDERA },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sesion_bitacora, null, 'no debe devolver fila de presencia');
  const filas = await pool.request()
    .input('s', sql.Int, consulta.sesion_id)
    .query(`SELECT COUNT(*) AS n FROM bitacora.sesion_bitacora WHERE sesion_id = @s`);
  assert.equal(filas.recordset[0].n, 0, 'no debe existir fila en sesion_bitacora');
});

test('8. IA mejorar-texto → 403 observador_solo_lectura (antes del check de GEMINI_API_KEY)', async () => {
  const r = await call('POST', '/api/ia/mejorar-texto', {
    sesion_id: consulta.sesion_id,
    body: { texto: 'texto de prueba' },
  });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.codigo, 'observador_solo_lectura');
});

// ---------------------------------------------------------------------------
// (d) — invisibilidad
// ---------------------------------------------------------------------------

test('9. GET /api/auth/usuarios-activos NO lista al observador (los demás sí — control positivo)', async () => {
  const r = await call('GET', '/api/auth/usuarios-activos', { sesion_id: ctx.sesiones.jdt });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ids = r.data.usuarios.map((u) => u.usuario_id);
  assert.ok(!ids.includes(consulta.usuario_id), 'el observador NO debe aparecer en CONECTADOS');
  assert.ok(ids.includes(ctx.usuarios.jdt.usuario_id), 'control: el JdT sintético SÍ debe aparecer');
});

test('10. WS fetchSnapshot (espejo del panel) NO lista al observador', async () => {
  const snap = await fetchSnapshot(TEST_PLANTA);
  const ids = snap.usuarios.map((u) => u.usuario_id);
  assert.ok(!ids.includes(consulta.usuario_id), 'el observador NO debe aparecer en el snapshot WS');
  assert.ok(ids.includes(ctx.usuarios.jdt.usuario_id), 'control: el JdT sintético SÍ debe aparecer');
});

test('11. preview-masivo NO lista al observador como pendiente de finalizar', async () => {
  const r = await call('GET', `/api/cierre/preview-masivo?planta_id=${TEST_PLANTA}`, {
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ids = r.data.ingenieros_no_finalizados.map((u) => u.usuario_id);
  assert.ok(!ids.includes(consulta.usuario_id),
    'el observador NUNCA finaliza turno — sin el filtro figuraría pendiente para siempre');
  assert.ok(ids.includes(ctx.usuarios.ingQuim.usuario_id), 'control: un operador sin finalizar SÍ figura');
});

test('12. snapshotIngenieros NO incluye al observador (quedaría en el histórico inmutable)', async () => {
  const json = await snapshotIngenieros(() => pool.request(), { planta_id: TEST_PLANTA });
  const ids = JSON.parse(json).map((u) => u.usuario_id);
  assert.ok(!ids.includes(consulta.usuario_id), 'el observador NO debe entrar en ingenieros_snapshot');
  assert.ok(ids.includes(ctx.usuarios.ingQuim.usuario_id), 'control: el Ing. Químico SÍ entra');
});

test('13. establecerContextoSesion: el observador entra SIN turno (turno_id NULL, sin participante, sin abrir cabecera); un operador SÍ', async () => {
  await limpiarTurnos();

  // Observador: no abre cabecera, no participa.
  const sesObs = await establecerContextoSesion(pool, {
    usuario_id: consulta.usuario_id, planta_id: TEST_PLANTA,
    cargo_id: consulta.cargo_id, cargo_nombre: NOMBRE_CARGO,
  });
  assert.equal(sesObs.es_observador, true, 'la sesión debe viajar con es_observador=true');
  consulta.sesion_id = sesObs.sesion_id;
  const filaObs = await pool.request()
    .input('s', sql.Int, sesObs.sesion_id)
    .query(`SELECT turno_id FROM bitacora.sesion_activa WHERE sesion_id = @s`);
  assert.equal(filaObs.recordset[0].turno_id, null, 'sesión del observador SIN turno_id');
  const partObs = await pool.request()
    .input('u', sql.Int, consulta.usuario_id)
    .query(`SELECT COUNT(*) AS n FROM bitacora.turno_participante WHERE usuario_id = @u`);
  assert.equal(partObs.recordset[0].n, 0, 'CERO filas en turno_participante');
  const cab = await pool.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`SELECT COUNT(*) AS n FROM bitacora.turno_unidad WHERE planta_id = @p`);
  assert.equal(cab.recordset[0].n, 0, 'el login del observador NO debe abrir cabeceras de turno');

  // Control positivo: un operador por el MISMO chokepoint sí abre cabecera y participa.
  const sesQuim = await establecerContextoSesion(pool, {
    usuario_id: ctx.usuarios.ingQuim.usuario_id, planta_id: TEST_PLANTA,
    cargo_id: cargoIngQuim, cargo_nombre: 'Ingeniero Químico',
  });
  assert.equal(sesQuim.es_observador, false);
  ctx.sesiones.ingQuim = sesQuim.sesion_id;
  const filaQuim = await pool.request()
    .input('s', sql.Int, sesQuim.sesion_id)
    .query(`SELECT turno_id FROM bitacora.sesion_activa WHERE sesion_id = @s`);
  assert.ok(filaQuim.recordset[0].turno_id != null, 'control: el operador SÍ queda atado a un turno');
  const partQuim = await pool.request()
    .input('u', sql.Int, ctx.usuarios.ingQuim.usuario_id)
    .input('t', sql.Int, filaQuim.recordset[0].turno_id)
    .query(`SELECT COUNT(*) AS n FROM bitacora.turno_participante WHERE usuario_id = @u AND turno_id = @t`);
  assert.equal(partQuim.recordset[0].n, 1, 'control: el operador SÍ participa');

  await limpiarTurnos();
});

test('14. Conformación: aunque exista una fila de participante del observador, cerrarTurno NO la congela (aislado del filtro es_sintetico)', async () => {
  await limpiarTurnos();
  const A = await abrirTurnoSiFalta(pool, TEST_PLANTA_ID, 1, '2026-04-20', new Date('2026-04-20T15:00:00Z'));

  // Sembrar A MANO la fila del observador (simula un bug/dato legacy que se saltó sesion-contexto)
  // + un participante de control.
  await marcarParticipante(pool, {
    turno_id: A.turno_unidad_id, usuario_id: consulta.usuario_id,
    cargo_id: consulta.cargo_id, cargo_nombre: NOMBRE_CARGO,
  });
  await marcarParticipante(pool, {
    turno_id: A.turno_unidad_id, usuario_id: ctx.usuarios.ingQuim.usuario_id,
    cargo_id: cargoIngQuim, cargo_nombre: 'Ingeniero Químico',
  });

  // incluirSinteticos:true (escape hatch SOLO de tests, D-044) para probar es_observador AISLADO:
  // ambos fixtures son sintéticos; sin esto el filtro D-044 enmascararía al D-059.
  await cerrarTurno(pool, A.turno_unidad_id, {
    motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA',
    ahora: new Date('2026-04-20T23:05:00Z'), incluirSinteticos: true,
  });

  const conf = await pool.request()
    .input('t', sql.Int, A.turno_unidad_id)
    .query(`SELECT usuario_id FROM bitacora.conformacion_turno WHERE turno_id = @t`);
  const ids = conf.recordset.map((r) => r.usuario_id);
  assert.ok(ids.includes(ctx.usuarios.ingQuim.usuario_id), 'control: el operador SÍ queda en la conformación');
  assert.ok(!ids.includes(consulta.usuario_id),
    'el observador JAMÁS entra a conformacion_turno (sin escape hatch, ni en tests)');

  await limpiarTurnos();
});

test('15. hayPersonal: un observador solo NO impide el AUTO_SIN_PERSONAL; un operador sí bloquea', async () => {
  await limpiarTurnos();

  // Solo el observador queda activo en TST → la unidad está "vacía" para el auto-cierre.
  await pool.request()
    .input('p', sql.VarChar(10), TEST_PLANTA_ID)
    .input('s', sql.Int, consulta.sesion_id)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE planta_id = @p AND sesion_id <> @s`);

  await abrirTurnoSiFalta(pool, TEST_PLANTA_ID, 1, '2026-04-21', new Date('2026-04-21T15:00:00Z'));
  const sinPersonal = await transicionarTurnosVencidos(pool, {
    ahora: new Date('2026-04-21T23:10:00Z'), plantas: [TEST_PLANTA_ID],
  });
  const t1 = sinPersonal.find((t) => t.planta_id === TEST_PLANTA_ID);
  assert.equal(t1?.accion, 'cerrado', `esperaba auto-cierre, llegó ${JSON.stringify(sinPersonal)}`);
  assert.equal(t1?.motivo, 'AUTO_SIN_PERSONAL', 'el observador NO cuenta como personal');

  // Control: con un operador activo, dentro de la gracia (<60 min) → bloqueo (espera decisión).
  await limpiarTurnos();
  await pool.request()
    .input('s', sql.Int, ctx.sesiones.jdt)
    .query(`UPDATE bitacora.sesion_activa SET activa = 1 WHERE sesion_id = @s`);
  await abrirTurnoSiFalta(pool, TEST_PLANTA_ID, 1, '2026-04-22', new Date('2026-04-22T15:00:00Z'));
  const conPersonal = await transicionarTurnosVencidos(pool, {
    ahora: new Date('2026-04-22T23:10:00Z'), plantas: [TEST_PLANTA_ID],
  });
  const t2 = conPersonal.find((t) => t.planta_id === TEST_PLANTA_ID);
  assert.equal(t2?.accion, 'bloqueo', 'control: con un operador presente el turno espera la decisión');

  await limpiarTurnos();
});

// ---------------------------------------------------------------------------
// (a) — contrato MERGE auto-corrector (al final: re-initDB es pesado)
// ---------------------------------------------------------------------------

test('16. Idempotencia: un UPDATE manual de es_observador NO sobrevive al re-initDB (MERGE lo re-fija)', async () => {
  await pool.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`UPDATE lov_bit.cargo SET es_observador = 0, puede_cambiar_unidad = 0 WHERE nombre = @n`);
  await initDB();
  const r = await pool.request()
    .input('n', sql.VarChar(200), NOMBRE_CARGO)
    .query(`SELECT CAST(es_observador AS INT) AS obs, CAST(puede_cambiar_unidad AS INT) AS pcu FROM lov_bit.cargo WHERE nombre = @n`);
  assert.equal(r.recordset[0].obs, 1, 'el MERGE del arranque debe re-fijar es_observador=1');
  assert.equal(r.recordset[0].pcu, 1, 'el MERGE del arranque debe re-fijar puede_cambiar_unidad=1');
  // Y la matriz reconstruida sigue [1,0]:
  const disp = await permiso('DISP');
  assert.ok(disp && disp.puede_ver === true && disp.puede_crear === false,
    'DISP debe seguir [ver=1, crear=0] tras re-initDB (override F12.A6)');
});
