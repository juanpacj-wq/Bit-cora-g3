// D-054 — Cambio de unidad en caliente (POST /api/auth/cambiar-unidad) + permiso de cargo
// `lov_bit.cargo.puede_cambiar_unidad`.
//
// Este endpoint SÍ es testeable end-to-end por el backdoor X-Sesion-Id (a diferencia de
// select-context, que exige la cookie Entra y por eso solo tiene tests que replican su SQL a mano).
// Es una consecuencia deliberada del diseño: cambiar-unidad NO re-deriva el cargo del token, así que
// no depende de `req.session.user` — el gate y la mecánica se ejercitan de verdad, sin copiar SQL.
//
// POR QUÉ ESTA SUITE OPERA SOBRE GEC3/GEC32 Y NO SOBRE LA PLANTA-FIXTURE (excepción consciente a
// D-030, que un auditor va a preguntar):
//   - Lo que se prueba es el salto ENTRE las dos unidades reales, y el endpoint RECHAZA TST por
//     diseño (validarPlantaOperable; ver test 8). No hay forma de ejercitar el flujo real sobre la
//     fixture sin agujerear la propia validación que este cambio introduce.
//   - Lo que D-030 protege es la DESTRUCCIÓN de datos productivos. Esta suite no borra nada real:
//     solo crea/reactiva una `sesion_activa` de un usuario sintético y marca su participación, y
//     ambas cosas se limpian en el `after()`. `abrirTurnoSiFalta` sobre una planta real hace lo
//     mismo que el sweeper haría de todos modos (idempotente), y NUNCA reabre un turno cerrado.
//   - Doble red: `es_sintetico=1` excluye a estos usuarios del builder de conformación (D-044), así
//     que nada de esto puede filtrarse al histórico inmutable; y `zzz_session_leak_guard` (último de
//     la suite) falla nombrando al ofensor si alguna sesión sintética quedara activa en planta real.
//
// NOTA DE ORDEN: estas suites están ACOPLADAS POR ESTADO en la planta-fixture — `abrirTurnoSiFalta`
// devuelve la fila existente aunque esté PROGRAMADO/CERRADO, y solo `cerrarTurno` activa un sucesor,
// así que un turno de TST que quede a medias bloquea las escrituras de las suites siguientes. Corré
// la suite por `npm test` (orden canónico); correr subconjuntos sueltos produce fallos que NO son
// defectos del código.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import {
  setupSessions,
  call,
  PLANTA_ID,
  TEST_PLANTA,
  deactivateSyntheticSessions,
} from './helpers.js';

// Los cargos con el atajo de cambio de unidad: los dos que por definición de negocio (D-054)
// operan ambas unidades de forma rutinaria, más el observador (D-059 — rol 100 % lectura que
// supervisa las dos plantas sin riesgo de escritura).
const CARGOS_CON_PERMISO = ['Ingeniero Jefe de Turno', 'Operador de Planta - Analista', 'USUARIO DE CONSULTA'];

const PLANTA_DESTINO = 'GEC32'; // la otra unidad real; PLANTA_ID es 'GEC3'

let ctx;

before(async () => {
  ctx = await setupSessions(); // sesiones en PLANTA_ID (GEC3)
});

after(async () => {
  const db = await getDB();
  // D-044/D-030: la presencia se limpia por `es_sintetico=1`, NUNCA por username (mismo criterio que
  // el cleanup de conformacion_turno en helpers.js). El cambio de unidad marca participación real en
  // la unidad destino, y esta suite corre contra la BD productiva: hay que retirar esas filas.
  //
  // Acotado a las plantas que ESTA suite toca (las dos reales): un DELETE por `es_sintetico` a secas
  // barrería también la participación que otras suites montan sobre la planta-fixture, y estas
  // suites están acopladas por estado (ver abajo). Limpiar solo lo que ensuciamos.
  //
  // NO se toca `turno_unidad` de GEC3/GEC32 — son cabeceras de PRODUCCIÓN. `abrirTurnoSiFalta` solo
  // hace ahí lo mismo que el sweeper haría igual, así que no hay nada que revertir. Y borrarlas sería
  // destructivo: son el turno real de la planta.
  await db.request().query(`
    DELETE tp FROM bitacora.turno_participante tp
    INNER JOIN lov_bit.usuario  u  ON u.usuario_id = tp.usuario_id
    INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
    WHERE u.es_sintetico = 1 AND tu.planta_id IN ('GEC3', 'GEC32');
  `);
  await deactivateSyntheticSessions();
});

// ---------------------------------------------------------------------------
// El permiso es DATO, no código
// ---------------------------------------------------------------------------

test('1. el permiso vive en lov_bit.cargo y lo tienen EXACTAMENTE los cargos de D-054 + D-059', async () => {
  // setupSessions() corre initDB(), así que el MERGE de cargos acaba de reconstruir la matriz: este
  // test verifica el estado tras un arranque real, no un seed one-shot.
  const db = await getDB();
  const r = await db.request().query(`
    SELECT nombre FROM lov_bit.cargo WHERE puede_cambiar_unidad = 1 ORDER BY nombre
  `);
  assert.deepEqual(
    r.recordset.map((x) => x.nombre).sort(),
    [...CARGOS_CON_PERMISO].sort(),
    'si agregás o quitás un cargo del permiso, actualizá el MERGE de db.js Y este test — el cambio debe ser consciente'
  );
});

test('2. el permiso se RECONSTRUYE en cada arranque (un UPDATE manual no sobrevive)', async () => {
  // Contrato de la convención 12: la matriz de cargos se rehace en cada initDB. Sin esto, alguien
  // podría "conceder" el permiso a mano en la BD y creer que quedó — hasta el próximo redeploy.
  const db = await getDB();
  await db.request().query(`
    UPDATE lov_bit.cargo SET puede_cambiar_unidad = 1 WHERE nombre = 'Ingeniero Químico'
  `);
  await setupSessions(); // dispara initDB() → MERGE de cargos
  const r = await db.request().query(`
    SELECT CAST(puede_cambiar_unidad AS BIT) AS p FROM lov_bit.cargo WHERE nombre = 'Ingeniero Químico'
  `);
  assert.equal(r.recordset[0].p, false, 'el arranque debe revertir el permiso concedido a mano');
  ctx = await setupSessions(); // refrescar sesiones (el setup anterior las rotó)
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test('3. sin sesión de app → 401 (no es un camino de ingreso)', async () => {
  const { status } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: PLANTA_DESTINO },
    sesion_id: 999999999,
  });
  assert.equal(status, 401);
});

test('4. cargo SIN el permiso → 403, aunque sea un cargo de alto poder', async () => {
  // ingOp = 'Ingeniero de Operación': tiene puede_cerrar_turno=1, o sea que NO es un cargo débil.
  // Prueba que el permiso es independiente de la jerarquía: se concede por necesidad operativa
  // (operar dos unidades a diario), no por rango.
  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: PLANTA_DESTINO },
    sesion_id: ctx.sesiones.ingOp,
  });
  assert.equal(status, 403, JSON.stringify(data));
  assert.equal(data.codigo, 'sin_permiso_cambio_unidad');
});

test('5. el 403 no cambia nada: la sesión del cargo sin permiso sigue en su planta', async () => {
  const db = await getDB();
  const r = await db.request()
    .input('s', sql.Int, ctx.sesiones.ingOp)
    .query(`SELECT planta_id, activa FROM bitacora.sesion_activa WHERE sesion_id = @s`);
  assert.equal(r.recordset[0].planta_id, PLANTA_ID);
  assert.equal(r.recordset[0].activa, true);
});

// ---------------------------------------------------------------------------
// Validación de la planta destino
// ---------------------------------------------------------------------------

test('6. planta inexistente → 400', async () => {
  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: 'NOEXISTE' },
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.codigo, 'planta_invalida');
});

test('7. planta_id ausente → 400', async () => {
  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: {},
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.codigo, 'planta_requerida');
});

test('8. la planta de TEST se rechaza aunque esté activa=1 (D-030)', async () => {
  // TST es residente y activa=1 por necesidad de la FK y del POST DISP. El selector del login la
  // esconde, pero eso es UI: el server debe rechazarla por su cuenta.
  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: TEST_PLANTA },
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.codigo, 'planta_invalida');
});

test('9. misma unidad → 200 idempotente, sin rotar la sesión', async () => {
  const db = await getDB();
  const antes = (await db.request()
    .input('s', sql.Int, ctx.sesiones.jdt)
    .query(`SELECT inicio_sesion FROM bitacora.sesion_activa WHERE sesion_id = @s`)).recordset[0].inicio_sesion;

  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: PLANTA_ID },
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.sin_cambio, true);

  const despues = (await db.request()
    .input('s', sql.Int, ctx.sesiones.jdt)
    .query(`SELECT inicio_sesion FROM bitacora.sesion_activa WHERE sesion_id = @s`)).recordset[0].inicio_sesion;
  assert.deepEqual(despues, antes, 'un no-op no debe rotar inicio_sesion (cerraría un lapso de presencia vacío)');
});

// ---------------------------------------------------------------------------
// El cambio real (ida y vuelta)
// ---------------------------------------------------------------------------

test('10. cargo CON permiso: cambia de unidad y la sesión anterior queda desactivada (sesión única, D-035)', async () => {
  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: PLANTA_DESTINO },
    sesion_id: ctx.sesiones.jdt,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.sesion.planta_id, PLANTA_DESTINO);
  assert.equal(data.sesion.activa, true);
  assert.equal(data.sesion.puede_cambiar_unidad, true, 'el flag debe viajar en la sesión que consume el front');

  const db = await getDB();
  // Invariante D-035: UNA sola sesión activa por persona, y es la de la unidad nueva.
  const activas = await db.request()
    .input('u', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`SELECT sesion_id, planta_id FROM bitacora.sesion_activa WHERE usuario_id = @u AND activa = 1`);
  assert.equal(activas.recordset.length, 1, 'no puede quedar iniciado en dos unidades');
  assert.equal(activas.recordset[0].planta_id, PLANTA_DESTINO);

  const vieja = await db.request()
    .input('s', sql.Int, ctx.sesiones.jdt)
    .query(`SELECT activa, cerrada_en FROM bitacora.sesion_activa WHERE sesion_id = @s`);
  assert.equal(vieja.recordset[0].activa, false);
  assert.ok(vieja.recordset[0].cerrada_en, 'la sesión desactivada debe quedar fechada');
});

test('11. la vuelta REUSA la fila original (dedupe por usuario+planta+cargo, no crea filas nuevas)', async () => {
  const db = await getDB();
  const nueva = (await db.request()
    .input('u', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`SELECT TOP 1 sesion_id FROM bitacora.sesion_activa WHERE usuario_id = @u AND activa = 1`))
    .recordset[0].sesion_id;

  const { status, data } = await call('POST', '/api/auth/cambiar-unidad', {
    body: { planta_id: PLANTA_ID },
    sesion_id: nueva,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.sesion.planta_id, PLANTA_ID);
  // La clave del dedupe: volver a GEC3 reactiva la MISMA fila, no acumula sesiones por viaje.
  assert.equal(data.sesion.sesion_id, ctx.sesiones.jdt);

  const activas = await db.request()
    .input('u', sql.Int, ctx.usuarios.jdt.usuario_id)
    .query(`SELECT COUNT(*) AS n FROM bitacora.sesion_activa WHERE usuario_id = @u AND activa = 1`);
  assert.equal(activas.recordset[0].n, 1);
});

test('12. el cambio marca participación en el turno de la unidad destino (D-045)', async () => {
  // La presencia es lo que alimenta la conformación al cerrar: si el cambio de unidad no marcara
  // participación, quien opera GEC32 media hora no aparecería en su conformación.
  const db = await getDB();
  const r = await db.request()
    .input('u', sql.Int, ctx.usuarios.jdt.usuario_id)
    .input('p', sql.VarChar(10), PLANTA_DESTINO)
    .query(`
      SELECT COUNT(*) AS n
      FROM bitacora.turno_participante tp
      INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
      WHERE tp.usuario_id = @u AND tu.planta_id = @p
    `);
  assert.ok(r.recordset[0].n >= 1, 'debe existir participación en la unidad destino tras el cambio');
});
