// D-065 · L05 — Toma de control del rol (superficie B, backend): pila LIFO derivada del log
// append-only `bitacora.rotacion_control`, serializada con `sp_getapplock`.
//
// Dos bloques:
//   1. Derivación PURA (sin BD): `derivarTomas`, `ordenarFondo`, `armarEstado`, `fechaOperativaIso`.
//   2. HTTP contra el backend efímero del lote (`TEST_BASE_URL`, `AUTH_TEST_BYPASS=1`) y la BD viva,
//      sobre la planta-fixture 'TST' (D-030/D-055): NUNCA GEC3/GEC32. Usuarios propios con prefijo
//      `test_rotctl_` y `es_sintetico = 1` explícito (convención 28); sesiones insertadas directo en
//      `sesion_activa`; cabecera `turno_unidad` ABIERTO creada en el `before()` y borrada en el
//      `after()`, acotada por `planta_id = 'TST'` (no se depende del sweeper ni de lo que haya).
//
// Consume C4 (`titularesDeTurno`, L04) a través del módulo de dominio: el patrón y las asignaciones
// del rol se siembran acá, en las tablas de C2, y el grupo de guardia se calcula con el motor de
// L01 (`grupoDeTurno`) para no hardcodear cuál toca hoy.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import { initDB, getDB, TEST_PLANTA_ID } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { getTurnoColombia } from '../utils/turno.js';
import { abrirTurnoSiFalta } from '../utils/turno-entidad.js';
import { grupoDeTurno, parsearVector } from '../utils/rotacion/patron.js';
import {
  derivarTomas, ordenarFondo, armarEstado, fechaOperativaIso, LOCK_TIMEOUT_MS,
} from '../utils/rotacion/control.js';
import { call, deactivateSyntheticSessions } from './helpers.js';

const P = TEST_PLANTA_ID;
const RUTA = '/api/rotacion/control';

// Cargos de la fixture. Ninguno se hardcodea por id: se resuelven por nombre (o por flag) contra
// `lov_bit.cargo` en el `before()`, y se verifica que sus flags sean los que el escenario necesita.
const CARGO_ROL = 'Operador de Planta - Turbogrupo';      // rol CON patrón: aplica
const CARGO_SIN_PATRON = 'Operador Maquinaria Pesada';     // rol SIN patrón: no rota
const CARGO_ADMIN = 'Administrador y Debugging';           // puede_configurar_rotacion = 1
const CARGO_GERENTE = 'Gerente de Producción';             // puede_configurar_rotacion = 1
// El observador se resuelve por `es_observador = 1`, no por nombre (convención 33).

const VECTOR_T1 = '1,1,3,3,4,4,2,2';
const VECTOR_T2 = '4,2,2,1,1,3,3,4';

// CR2-5 (GATE-O2 → L12): la ventana del patrón-fixture va ENTERA EN EL PASADO, y la cabecera de
// 'TST' con ella. Antes el patrón cubría [hoy−3, hoy+30] sobre cargos REALES, y mientras esta suite
// corría, el turno-sweeper del backend efímero cerraba GEC3/GEC32 (deuda D4 del GATE-O1: no mira
// AUTH_TEST_BYPASS). Cada uno de esos cierres congela cumplimiento, `titularesDeTurno` NO filtra por
// planta (R3) y el patrón de fixture aplicaba a hoy → filas de `rotacion_cumplimiento` de planta
// REAL con titulares sintéticos, que el `after()` de acá deja después apuntando a usuarios que ya no
// existen. La suite hermana de L06 fija su fixture en marzo de 2025 por exactamente esto.
// Nada del escenario depende de que la fecha sea hoy: `resolverTurnoAbierto` busca la cabecera
// ABIERTO de la unidad, sin mirar el calendario, y el grupo de guardia se calcula con el motor.
// `rotacion_correcciones_o2.test.js` verifica que estas dos fechas sigan en el pasado.
const FECHA_OP_FIXTURE = '2025-06-10';
const PATRON_FIXTURE = { inicio: '2025-06-07', fin: '2025-07-10' };

// Prefijo `test_` → el seed de db.js lo marca `es_sintetico = 1` en cada arranque; acá además se
// pone explícito al crearlos. El LIKE usa `[_]` para que el guion bajo no sea comodín.
const PREFIJO = 'test_rotctl_';
const LIKE_MIOS = 'test[_]rotctl[_]%';

const SHAPE_C5 = [
  'aplica', 'turno_id', 'cargo_id', 'cargo_nombre', 'principal',
  'soy_principal', 'soy_titular', 'ya_respondi', 'pila',
];

const FIXTURE = {
  titular:    { nombre: 'Test RotCtl Titular' },
  a:          { nombre: 'Test RotCtl A' },
  b:          { nombre: 'Test RotCtl B' },
  c:          { nombre: 'Test RotCtl C' },
  sinPatron:  { nombre: 'Test RotCtl Sin Patron' },
  observador: { nombre: 'Test RotCtl Observador' },
  admin:      { nombre: 'Test RotCtl Admin' },
  gerente:    { nombre: 'Test RotCtl Gerente' },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Derivación pura
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('D-065 L05 · derivación pura de la pila', () => {
  const T = { usuario_id: 1, nombre: 'Titular' };
  const A = { usuario_id: 11, nombre: 'Ana' };
  const B = { usuario_id: 12, nombre: 'Beto' };
  const C = { usuario_id: 13, nombre: 'Caro' };
  const ev = (u, accion) => ({ usuario_id: u.usuario_id, nombre: u.nombre, accion });

  test('derivarTomas: LIFO — el tope es el último TOMAR sin su ABANDONAR', () => {
    const eventos = [ev(A, 'TOMAR'), ev(B, 'TOMAR'), ev(C, 'TOMAR'), ev(C, 'ABANDONAR')];
    assert.deepEqual(derivarTomas(eventos).map((t) => t.usuario_id), [11, 12]);
    eventos.push(ev(B, 'ABANDONAR'));
    assert.deepEqual(derivarTomas(eventos).map((t) => t.usuario_id), [11]);
    eventos.push(ev(A, 'ABANDONAR'));
    assert.deepEqual(derivarTomas(eventos), []);
  });

  test('derivarTomas: un ABANDONAR de quien no es tope es inerte; DESCARTAR no toca la pila', () => {
    const eventos = [ev(A, 'TOMAR'), ev(B, 'TOMAR'), ev(A, 'ABANDONAR'), ev(C, 'DESCARTAR'), ev(C, 'ABANDONAR')];
    assert.deepEqual(derivarTomas(eventos).map((t) => t.usuario_id), [11, 12], 'A no era tope: su ABANDONAR no desapila a B');
    assert.deepEqual(derivarTomas([]), []);
  });

  test('ordenarFondo: el primero por nombre queda de último (tope del fondo); desempate por usuario_id', () => {
    const fondo = ordenarFondo([{ usuario_id: 3, nombre: 'Zoe' }, { usuario_id: 1, nombre: 'ana' }, { usuario_id: 2, nombre: 'Luis' }]);
    assert.deepEqual(fondo.map((t) => t.nombre), ['Zoe', 'Luis', 'ana']);
    const empate = ordenarFondo([{ usuario_id: 9, nombre: 'Ana' }, { usuario_id: 4, nombre: 'Ana' }]);
    assert.deepEqual(empate.map((t) => t.usuario_id), [9, 4]);
  });

  test('armarEstado: sin tomas el principal es el tope del fondo; con tomas es el último TOMAR', () => {
    const titulares = [{ usuario_id: 3, nombre: 'Zoe' }, { usuario_id: 1, nombre: 'Ana' }];
    const base = { aplica: true, turno_id: 231, cargo_id: 8, cargo_nombre: 'Rol' };

    const sinTomas = armarEstado({ ...base, titulares, eventos: [], usuario_id: 1 });
    assert.deepEqual(Object.keys(sinTomas), SHAPE_C5);
    assert.deepEqual(sinTomas.principal, { usuario_id: 1, nombre: 'Ana' });
    assert.equal(sinTomas.soy_principal, true);
    assert.equal(sinTomas.soy_titular, true);
    assert.equal(sinTomas.ya_respondi, false);
    assert.deepEqual(sinTomas.pila.map((p) => [p.usuario_id, p.es_titular]), [[3, true], [1, true]]);

    const conToma = armarEstado({ ...base, titulares, eventos: [ev(A, 'TOMAR')], usuario_id: 11 });
    assert.deepEqual(conToma.principal, { usuario_id: 11, nombre: 'Ana' });
    assert.equal(conToma.soy_principal, true);
    assert.equal(conToma.soy_titular, false);
    assert.equal(conToma.ya_respondi, true);
    assert.deepEqual(conToma.pila.map((p) => [p.usuario_id, p.es_titular]), [[3, true], [1, true], [11, false]]);

    // Quien solo DESCARTÓ ya respondió, pero no cambió el principal.
    const descarto = armarEstado({ ...base, titulares, eventos: [ev(C, 'DESCARTAR')], usuario_id: 13 });
    assert.equal(descarto.ya_respondi, true);
    assert.equal(descarto.principal.usuario_id, 1);
    // Sin titulares ni tomas no hay principal.
    assert.equal(armarEstado({ ...base, titulares: [], eventos: [], usuario_id: 13 }).principal, null);
  });

  test('armarEstado: aplica=false sale neutro (el popup no se ofrece)', () => {
    const e = armarEstado({ aplica: false, turno_id: null, cargo_id: 14, cargo_nombre: 'Admin', titulares: [T], eventos: [ev(T, 'TOMAR')], usuario_id: 1 });
    assert.deepEqual(e, {
      aplica: false, turno_id: null, cargo_id: 14, cargo_nombre: 'Admin',
      principal: null, soy_principal: false, soy_titular: false, ya_respondi: false, pila: [],
    });
  });

  test('fechaOperativaIso: un DATE de mssql (medianoche UTC) se lee por partes UTC, sin shift −5h', () => {
    assert.equal(fechaOperativaIso(new Date(Date.UTC(2026, 8, 1))), '2026-09-01');
    assert.equal(fechaOperativaIso(new Date(Date.UTC(2026, 0, 1))), '2026-01-01', 'con el shift −5h saldría 2025-12-31');
    assert.equal(fechaOperativaIso('2026-09-01'), '2026-09-01');
    assert.equal(fechaOperativaIso('2026-09-01T00:00:00.000Z'), '2026-09-01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. HTTP — superficie B contra el backend efímero y la BD viva (planta 'TST')
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('D-065 L05 · superficie B por HTTP (planta TST)', () => {
  let db;
  const ids = {};       // key → usuario_id
  const ses = {};       // key → sesion_id
  const cargo = {};     // rol | sinPatron | observador | admin | gerente → { cargo_id, nombre }
  let turno;            // fila ABIERTO de turno_unidad en TST
  let fechaOp;          // 'YYYY-MM-DD' de la cabecera
  let turnoNum;         // 1 | 2
  let grupoGuardia;     // grupo que el patrón pone de guardia hoy

  const estado = (k) => call('GET', `${RUTA}/estado`, { sesion_id: ses[k] });
  const tomar = (k) => call('POST', `${RUTA}/tomar`, { sesion_id: ses[k] });
  const abandonar = (k) => call('POST', `${RUTA}/abandonar`, { sesion_id: ses[k] });
  const descartar = (k) => call('POST', `${RUTA}/descartar`, { sesion_id: ses[k] });
  const ok200 = (r, ctx) => assert.equal(r.status, 200, `${ctx}: ${r.status} ${JSON.stringify(r.data)}`);
  const es409 = (r, codigo, ctx) => {
    assert.equal(r.status, 409, `${ctx}: esperaba 409 ${codigo}, fue ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.codigo, codigo, `${ctx}: codigo`);
    assert.equal(r.data.error, codigo, `${ctx}: el slug va también en error (convención 16, como DISP)`);
    assert.ok(typeof r.data.mensaje === 'string' && r.data.mensaje.length > 0, `${ctx}: mensaje de usuario`);
  };
  const tomasDe = (pila) => pila.filter((p) => !p.es_titular).map((p) => p.usuario_id);

  async function leerLog() {
    const r = await db.request()
      .input('t', sql.Int, turno.turno_unidad_id)
      .input('p', sql.VarChar(10), P)
      .input('c', sql.Int, cargo.rol.cargo_id)
      .query(`
        SELECT rotacion_control_id, usuario_id, accion
        FROM bitacora.rotacion_control
        WHERE turno_id = @t AND planta_id = @p AND cargo_id = @c
        ORDER BY rotacion_control_id
      `);
    return r.recordset;
  }

  async function limpiarLog() {
    await db.request().input('p', sql.VarChar(10), P)
      .query(`DELETE FROM bitacora.rotacion_control WHERE planta_id = @p`);
  }

  // Deja la BD sin rastro de esta suite. Acotado a la planta-fixture y a los usuarios `test_rotctl_*`.
  // Corre en el before() ADEMÁS del after(): una corrida abortada se limpia en la siguiente. El bloque
  // de cabeceras replica `limpiarTurnos` de turno_transicion_write_gate.test.js (TST es desechable).
  // Va en TRES requests a propósito (GATE-O2 de D-065): el guard estático de D-055 exige ver el acotador
  // de fixture (`P`) a menos de 700 caracteres de cada DELETE sobre registro_activo/registro_historico,
  // y en un solo batch esos dos quedaban fuera de la ventana (el guard salía rojo en toda la suite).
  const SQL_MIOS = `
      DECLARE @mios TABLE (usuario_id INT PRIMARY KEY);
      INSERT INTO @mios SELECT usuario_id FROM lov_bit.usuario WHERE username LIKE '${LIKE_MIOS}';`;
  async function limpiarTodo() {
    // Rotación: el log entero de la planta-fixture; patrón y asignaciones que sembró esta suite.
    await db.request().input('p', sql.VarChar(10), P).query(`
      ${SQL_MIOS}
      DELETE FROM bitacora.rotacion_control WHERE planta_id = @p;
      DELETE FROM bitacora.rotacion_asignacion
        WHERE creado_por IN (SELECT usuario_id FROM @mios) OR usuario_id IN (SELECT usuario_id FROM @mios);
      DELETE FROM bitacora.rotacion_patron WHERE creado_por IN (SELECT usuario_id FROM @mios);
    `);
    // Cabeceras de TST y todo lo que las referencia por FK (rotacion_cumplimiento la escribe L06 al
    // cerrar; acá solo se barre lo de la planta-fixture para poder borrar la cabecera).
    await db.request().input('p', sql.VarChar(10), P).query(`
      DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
      UPDATE ra SET turno_id = NULL FROM bitacora.registro_activo ra
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = ra.turno_id WHERE tu.planta_id = @p;
      UPDATE sa SET turno_id = NULL FROM bitacora.sesion_activa sa
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id WHERE tu.planta_id = @p;
      DELETE FROM bitacora.conformacion_turno WHERE planta_id = @p;
      DELETE FROM bitacora.registro_historico WHERE planta_id = @p;
      DELETE FROM bitacora.registro_activo WHERE planta_id = @p;
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id WHERE tu.planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
    // Sesiones y usuarios propios de la suite (se recrean en cada corrida).
    await db.request().query(`
      ${SQL_MIOS}
      DELETE sb FROM bitacora.sesion_bitacora sb
        INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
        WHERE sa.usuario_id IN (SELECT usuario_id FROM @mios);
      DELETE FROM bitacora.sesion_activa WHERE usuario_id IN (SELECT usuario_id FROM @mios);
      DELETE FROM lov_bit.usuario WHERE usuario_id IN (SELECT usuario_id FROM @mios);
    `);
  }

  before(async () => {
    await initDB();
    db = await getDB();
    await limpiarTodo();

    // Planta-fixture (idempotente; misma forma que setupSessions).
    await db.request().input('planta', sql.VarChar(10), P).query(`
      MERGE lov_bit.planta AS t
      USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
      WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
    `);

    // Cargos, por nombre o por flag; se afirma que sus flags son los del escenario.
    const { recordset: cargos } = await db.request().query(`
      SELECT cargo_id, nombre, CAST(es_observador AS BIT) AS es_observador,
             CAST(puede_configurar_rotacion AS BIT) AS puede_configurar_rotacion
      FROM lov_bit.cargo
    `);
    const porNombre = (n) => cargos.find((c) => c.nombre === n);
    cargo.rol = porNombre(CARGO_ROL);
    cargo.sinPatron = porNombre(CARGO_SIN_PATRON);
    cargo.admin = porNombre(CARGO_ADMIN);
    cargo.gerente = porNombre(CARGO_GERENTE);
    cargo.observador = cargos.find((c) => c.es_observador);
    for (const [k, c] of Object.entries(cargo)) assert.ok(c, `cargo de la fixture '${k}' no existe en lov_bit.cargo`);
    assert.equal(cargo.rol.es_observador || cargo.rol.puede_configurar_rotacion, false, `${CARGO_ROL} debe ser un rol corriente`);
    assert.equal(cargo.sinPatron.es_observador || cargo.sinPatron.puede_configurar_rotacion, false);
    assert.equal(cargo.admin.puede_configurar_rotacion, true, 'F37.A2: el Administrador configura la malla');
    assert.equal(cargo.gerente.puede_configurar_rotacion, true, 'F37.A2: el Gerente configura la malla');

    // Usuarios sintéticos propios (es_sintetico = 1 explícito, hash aleatorio inerte: AUD-40).
    const CARGO_DE = {
      titular: cargo.rol, a: cargo.rol, b: cargo.rol, c: cargo.rol,
      sinPatron: cargo.sinPatron, observador: cargo.observador, admin: cargo.admin, gerente: cargo.gerente,
    };
    const password_hash = await hashPassword(randomBytes(24).toString('hex'));
    for (const [k, f] of Object.entries(FIXTURE)) {
      const r = await db.request()
        .input('nombre', sql.VarChar(200), f.nombre)
        .input('username', sql.VarChar(50), `${PREFIJO}${k.toLowerCase()}`)
        .input('pwd', sql.VarChar(200), password_hash)
        .query(`
          INSERT INTO lov_bit.usuario
            (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo, es_sintetico)
          OUTPUT INSERTED.usuario_id
          VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1, 1)
        `);
      ids[k] = r.recordset[0].usuario_id;
    }

    // Cabecera ABIERTO en TST, con `fecha_operativa` en el pasado (CR2-5). Se crea explícitamente
    // (no se depende del sweeper, que además no toca 'TST'). El NÚMERO de turno sí es el del reloj:
    // las sesiones de la fixture se insertan con ese mismo `turno` y su `inicio_sesion` es AHORA, y
    // la expulsión del sweeper se calcula como `ventanaTurno(sesion.turno, sesion.inicio_sesion)` —
    // con un turno que no es el vigente, esa ventana ya venció y las sesiones se caerían a mitad de
    // la corrida (401 en todos los casos).
    fechaOp = FECHA_OP_FIXTURE;
    turnoNum = getTurnoColombia();
    turno = await abrirTurnoSiFalta(db, P, turnoNum, fechaOp);
    assert.equal(turno.estado, 'ABIERTO', 'la fixture necesita la cabecera ABIERTO');
    assert.equal(fechaOperativaIso(turno.fecha_operativa), fechaOp, 'la DATE de la cabecera se lee sin correrse un día');

    // Patrón (C2) para el rol de la fixture y, a propósito, también para el Administrador y el
    // observador: así se falsea que la exclusión de R12 es por FLAG y no por "no tener patrón".
    const patron = {
      fecha_inicio: PATRON_FIXTURE.inicio, fecha_fin: PATRON_FIXTURE.fin,
      vector_t1: parsearVector(VECTOR_T1), vector_t2: parsearVector(VECTOR_T2), desfase: 0,
    };
    grupoGuardia = grupoDeTurno(patron, fechaOp, turnoNum);
    const grupoLibre = (grupoGuardia % 4) + 1;  // otro grupo válido, que hoy no está de guardia
    for (const c of [cargo.rol, cargo.admin, cargo.observador]) {
      await db.request()
        .input('cargo_id', sql.Int, c.cargo_id)
        .input('ini', sql.Date, patron.fecha_inicio)
        .input('fin', sql.Date, patron.fecha_fin)
        .input('v1', sql.VarChar(32), VECTOR_T1)
        .input('v2', sql.VarChar(32), VECTOR_T2)
        .input('desfase', sql.TinyInt, patron.desfase)
        .input('creado_por', sql.Int, ids.titular)
        .query(`
          INSERT INTO bitacora.rotacion_patron
            (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
          VALUES (@cargo_id, @ini, @fin, @v1, @v2, @desfase, 1, @creado_por)
        `);
    }
    const asignar = (k, c, grupo) => db.request()
      .input('usuario_id', sql.Int, ids[k])
      .input('cargo_id', sql.Int, c.cargo_id)
      .input('grupo', sql.TinyInt, grupo)
      .input('desde', sql.Date, patron.fecha_inicio)
      .input('hasta', sql.Date, patron.fecha_fin)
      .input('creado_por', sql.Int, ids.titular)
      .query(`
        INSERT INTO bitacora.rotacion_asignacion
          (usuario_id, cargo_id, grupo, vigente_desde, vigente_hasta, creado_por)
        VALUES (@usuario_id, @cargo_id, @grupo, @desde, @hasta, @creado_por)
      `);
    await asignar('titular', cargo.rol, grupoGuardia);       // el titular de hoy
    await asignar('a', cargo.rol, grupoLibre);               // del rol, pero hoy no de guardia
    await asignar('admin', cargo.admin, grupoGuardia);       // "titular" de su rol, excluido por flag
    await asignar('observador', cargo.observador, grupoGuardia);
    // b, c y sinPatron no tienen asignación: supernumerarios.

    // Sesiones de app directo en sesion_activa (turno ACTUAL para que el sweeper no las expulse).
    for (const k of Object.keys(FIXTURE)) {
      const r = await db.request()
        .input('usuario_id', sql.Int, ids[k])
        .input('planta_id', sql.VarChar(10), P)
        .input('cargo_id', sql.Int, CARGO_DE[k].cargo_id)
        .input('turno', sql.TinyInt, turnoNum)
        .query(`
          INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
          OUTPUT INSERTED.sesion_id
          VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
        `);
      ses[k] = r.recordset[0].sesion_id;
    }

    // El backend efímero está arriba y L04 montó este router (si sale 404, es un hallazgo para el gate).
    const health = await call('GET', '/health');
    assert.equal(health.status, 200, `backend en TEST_BASE_URL no responde /health: ${health.status}`);
    const sonda = await estado('a');
    assert.notEqual(sonda.status, 404, `${RUTA} no está montado en auth/app.js (lo monta L04)`);
  });

  after(async () => {
    await limpiarTodo();
    await deactivateSyntheticSessions();
  });

  test('GET /estado: shape C5 exacto y estado inicial (el fondo es el titular del patrón)', async () => {
    await limpiarLog();
    const r = await estado('a');
    ok200(r, 'estado a');
    assert.deepEqual(Object.keys(r.data), SHAPE_C5, 'las claves del contrato C5, ni más ni menos');
    assert.equal(r.data.aplica, true);
    assert.equal(r.data.turno_id, turno.turno_unidad_id);
    assert.equal(r.data.cargo_id, cargo.rol.cargo_id);
    assert.equal(r.data.cargo_nombre, CARGO_ROL);
    assert.deepEqual(r.data.principal, { usuario_id: ids.titular, nombre: FIXTURE.titular.nombre });
    assert.equal(r.data.soy_principal, false);
    assert.equal(r.data.soy_titular, false);
    assert.equal(r.data.ya_respondi, false);
    assert.deepEqual(r.data.pila, [{ usuario_id: ids.titular, nombre: FIXTURE.titular.nombre, es_titular: true }]);

    const t = await estado('titular');
    ok200(t, 'estado titular');
    assert.equal(t.data.soy_titular, true);
    assert.equal(t.data.soy_principal, true, 'sin tomas, el titular es el principal');
    assert.equal(t.data.ya_respondi, false);
  });

  test('aplica = false por flag (observador, Administrador, Gerente) y por falta de patrón; los verbos → 409 rotacion_no_aplica', async () => {
    for (const k of ['observador', 'admin', 'gerente', 'sinPatron']) {
      const r = await estado(k);
      ok200(r, `estado ${k}`);
      assert.equal(r.data.aplica, false, `${k}: aplica`);
      assert.equal(r.data.turno_id, turno.turno_unidad_id, `${k}: el turno sí se reporta`);
      assert.equal(r.data.principal, null, `${k}: principal`);
      assert.deepEqual(r.data.pila, [], `${k}: pila`);
      assert.equal(r.data.soy_titular, false, `${k}: aunque tenga asignación de guardia, un excluido no es titular`);
    }
    // admin y observador TIENEN patrón y asignación de guardia: lo que los excluye es el flag.
    es409(await tomar('admin'), 'rotacion_no_aplica', 'tomar admin');
    es409(await tomar('observador'), 'rotacion_no_aplica', 'tomar observador');
    es409(await tomar('sinPatron'), 'rotacion_no_aplica', 'tomar sinPatron');
    es409(await abandonar('gerente'), 'rotacion_no_aplica', 'abandonar gerente');
    es409(await descartar('sinPatron'), 'rotacion_no_aplica', 'descartar sinPatron');
    assert.equal((await leerLog()).length, 0, 'ningún excluido dejó rastro en el log');
    assert.equal(
      (await db.request().input('p', sql.VarChar(10), P).query(`SELECT COUNT(*) AS n FROM bitacora.rotacion_control WHERE planta_id = @p`)).recordset[0].n,
      0, 'tampoco en otros cargos de la planta-fixture',
    );
  });

  test('CA-10 · pila LIFO: A, B, C toman; C, B, A abandonan y el control vuelve al titular', async () => {
    await limpiarLog();

    let r = await tomar('a');
    ok200(r, 'tomar a');
    assert.equal(r.data.principal.usuario_id, ids.a);
    assert.equal(r.data.soy_principal, true);
    assert.equal(r.data.ya_respondi, true);
    assert.deepEqual(tomasDe(r.data.pila), [ids.a]);
    assert.equal(r.data.pila[0].es_titular, true, 'el fondo sigue siendo el titular');

    r = await tomar('b');
    ok200(r, 'tomar b');
    assert.equal(r.data.principal.usuario_id, ids.b);

    r = await tomar('c');
    ok200(r, 'tomar c');
    assert.equal(r.data.principal.usuario_id, ids.c);
    assert.deepEqual(tomasDe(r.data.pila), [ids.a, ids.b, ids.c]);

    // Reglas negativas sobre esta pila.
    es409(await tomar('c'), 'ya_es_principal', 'c toma dos veces');
    es409(await abandonar('a'), 'no_es_principal', 'a no es el tope');
    es409(await abandonar('titular'), 'no_es_principal', 'el titular tampoco es el tope mientras haya tomas');

    r = await abandonar('c');
    ok200(r, 'abandonar c');
    assert.equal(r.data.principal.usuario_id, ids.b, 'el control vuelve al tenedor inmediatamente anterior');
    assert.deepEqual(tomasDe(r.data.pila), [ids.a, ids.b]);

    r = await abandonar('b');
    ok200(r, 'abandonar b');
    assert.equal(r.data.principal.usuario_id, ids.a);

    r = await abandonar('a');
    ok200(r, 'abandonar a');
    assert.equal(r.data.principal.usuario_id, ids.titular, 'pila vacía de tomas → el titular del patrón');
    assert.deepEqual(r.data.pila, [{ usuario_id: ids.titular, nombre: FIXTURE.titular.nombre, es_titular: true }]);
    assert.equal(r.data.soy_principal, false);
    assert.equal(r.data.ya_respondi, true, 'a ya respondió en este turno');

    // El log conserva TODO, en orden: nada se borró ni se actualizó (append-only).
    const log = await leerLog();
    assert.deepEqual(
      log.map((e) => [e.usuario_id, e.accion]),
      [[ids.a, 'TOMAR'], [ids.b, 'TOMAR'], [ids.c, 'TOMAR'], [ids.c, 'ABANDONAR'], [ids.b, 'ABANDONAR'], [ids.a, 'ABANDONAR']],
    );
    const est = await estado('b');
    ok200(est, 'estado b');
    assert.equal(est.data.principal.usuario_id, ids.titular);
    assert.equal(est.data.ya_respondi, true);
  });

  test('CA-12 · el titular del fondo no abandona (409 titular_no_abandona): la pila nunca queda vacía', async () => {
    await limpiarLog();
    es409(await abandonar('titular'), 'titular_no_abandona', 'titular abandona con la pila sin tomas');
    assert.equal((await leerLog()).length, 0, 'el rechazo no deja evento');
    let r = await estado('titular');
    ok200(r, 'estado titular');
    assert.equal(r.data.soy_principal, true, 'sigue siendo el principal');
    assert.equal(r.data.pila.length, 1);

    // Un no-titular con la pila sin tomas tampoco puede abandonar, pero el código es otro.
    es409(await abandonar('b'), 'no_es_principal', 'b abandona sin haber tomado');

    // Con una toma encima, el titular no es el tope: no_es_principal. Al desapilarse, vuelve a ser el
    // fondo y otra vez titular_no_abandona.
    ok200(await tomar('a'), 'tomar a');
    es409(await abandonar('titular'), 'no_es_principal', 'titular con a encima');
    r = await abandonar('a');
    ok200(r, 'abandonar a');
    assert.equal(r.data.principal.usuario_id, ids.titular);
    es409(await abandonar('titular'), 'titular_no_abandona', 'titular de nuevo en el fondo');
    assert.deepEqual((await leerLog()).map((e) => e.accion), ['TOMAR', 'ABANDONAR']);
  });

  test('CA-11 · concurrencia: dos TOMAR simultáneos se serializan — un solo principal y los dos eventos en orden', async () => {
    await limpiarLog();

    // (a) Dos usuarios DISTINTOS a la vez: los dos eventos son legítimos y ambos quedan; el principal
    //     es el ÚLTIMO del log, y la respuesta de quien comprometió segundo ya vio la toma del primero
    //     (sin serialización, la lectura del segundo puede no verla y su pila sale corta).
    const [ra, rb] = await Promise.all([tomar('a'), tomar('b')]);
    ok200(ra, 'tomar a (concurrente)');
    ok200(rb, 'tomar b (concurrente)');
    let log = await leerLog();
    assert.deepEqual(log.map((e) => e.accion), ['TOMAR', 'TOMAR'], 'el log conserva los dos eventos');
    assert.deepEqual(new Set(log.map((e) => e.usuario_id)), new Set([ids.a, ids.b]));
    const est = await estado('c');
    ok200(est, 'estado c');
    assert.equal(est.data.principal.usuario_id, log[1].usuario_id, 'exactamente un principal: el último TOMAR del log');
    assert.deepEqual(tomasDe(est.data.pila), log.map((e) => e.usuario_id), 'la pila derivada sigue el orden del log');
    const respDelUltimo = log[1].usuario_id === ids.a ? ra : rb;
    const respDelPrimero = log[1].usuario_id === ids.a ? rb : ra;
    assert.equal(tomasDe(respDelUltimo.data.pila).length, 2, 'quien comprometió segundo vio la toma del primero');
    assert.equal(respDelUltimo.data.soy_principal, true);
    assert.equal(tomasDe(respDelPrimero.data.pila).length, 1, 'quien comprometió primero solo se vio a sí mismo');

    // (b) El MISMO usuario N veces a la vez (el doble clic del popup): sin serialización real, todas
    //     leen "no soy principal" antes de que alguna inserte y el log queda con N TOMAR del mismo
    //     usuario. Con el applock: exactamente un 200, N−1 `ya_es_principal`, UNA fila.
    await limpiarLog();
    const N = 6;
    const rs = await Promise.all(Array.from({ length: N }, () => tomar('c')));
    const exitos = rs.filter((r) => r.status === 200);
    const rechazos = rs.filter((r) => r.status === 409 && r.data.codigo === 'ya_es_principal');
    const otros = rs.filter((r) => !exitos.includes(r) && !rechazos.includes(r));
    assert.equal(otros.length, 0, `respuestas inesperadas: ${JSON.stringify(otros.map((r) => [r.status, r.data]))}`);
    assert.equal(exitos.length, 1, `exactamente un TOMAR exitoso (hubo ${exitos.length})`);
    assert.equal(rechazos.length, N - 1);
    log = await leerLog();
    assert.deepEqual(log.map((e) => [e.usuario_id, e.accion]), [[ids.c, 'TOMAR']], 'una sola fila: el cálculo del principal se serializó');
    assert.ok(LOCK_TIMEOUT_MS >= 1000, 'el timeout del applock deja margen a la cola de transacciones');
  });

  // CA-11, verificador NEGATIVO — rehecho por CR2-6 (GATE-O2, decisión D4 → L12).
  //
  // El de antes eran los N TOMAR concurrentes de arriba: si alguien quitaba el `sp_getapplock`,
  // aparecían N filas y el caso se ponía rojo. Desde que la re-verificación del estado toma
  // `WITH (UPDLOCK)` sobre la cabecera —el arreglo del deadlock, CR2-6— eso ya NO mide el applock:
  // el bloqueo de FILA del turno serializa por sí solo dos escrituras del mismo turno, así que el
  // caso seguiría verde sin applock, por la razón equivocada.
  //
  // Lo que sí lo mide es la GRANULARIDAD: el applock es de (turno, cargo) y el U lock es del turno
  // entero. Se toma el applock DESDE AFUERA, en una transacción de este test que no toca ninguna
  // tabla, y se mira si el verbo lo respeta. Sin `sp_getapplock` en producción, (c) sale 200 y el
  // caso se pone rojo; el U lock no puede taparlo porque esta transacción no lockea la cabecera.
  async function conApplock(recurso, fn) {
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      const r = await new sql.Request(tx)
        .input('recurso', sql.NVarChar(255), recurso)
        .query(`
          DECLARE @rc INT;
          EXEC @rc = sp_getapplock
            @Resource = @recurso, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 2000;
          SELECT @rc AS rc;
        `);
      assert.ok(r.recordset[0].rc >= 0, `el test no pudo tomar el applock '${recurso}' (rc=${r.recordset[0].rc})`);
      return await fn();
    } finally {
      await tx.rollback();
    }
  }

  test('CA-11 (c) · con el applock de (turno, cargo) tomado desde afuera, TOMAR responde 409 control_ocupado', async () => {
    await limpiarLog();
    const recurso = `rotacion-control-${turno.turno_unidad_id}-${cargo.rol.cargo_id}`;
    const r = await conApplock(recurso, () => tomar('a'));
    es409(r, 'control_ocupado', 'tomar con el applock ocupado');
    assert.equal((await leerLog()).length, 0, 'el timeout del applock no deja evento');

    // Y al soltarlo, el mismo TOMAR pasa: lo que bloqueaba era el lock, no otra cosa.
    ok200(await tomar('a'), 'tomar tras soltar el applock');
    assert.deepEqual((await leerLog()).map((e) => [e.usuario_id, e.accion]), [[ids.a, 'TOMAR']]);
  });

  test('CA-11 (d) · el applock es POR (turno, cargo): con otro recurso tomado, TOMAR pasa sin esperar', async () => {
    await limpiarLog();
    // Mismo turno, otro cargo. Si el recurso fuera global (o si el verbo esperara al lock de fila de
    // la cabecera, que sí es por turno) esto saldría 409 y el caso (c) no probaría granularidad.
    const otroCargo = `rotacion-control-${turno.turno_unidad_id}-${cargo.sinPatron.cargo_id}`;
    const t0 = Date.now();
    const r = await conApplock(otroCargo, () => tomar('b'));
    ok200(r, 'tomar con el applock de OTRO cargo tomado');
    assert.ok(Date.now() - t0 < LOCK_TIMEOUT_MS, 'no esperó al lock ajeno');
    assert.deepEqual((await leerLog()).map((e) => e.usuario_id), [ids.b]);
  });

  test('CR2-6 · el verbo toma la cabecera del turno con UPDLOCK antes de escribir el log (orden fijo vs. cerrarTurno)', async () => {
    await limpiarLog();
    // `cerrarTurno` X-lockea la cabecera y DESPUÉS lee `rotacion_control`; el verbo lee la cabecera y
    // DESPUÉS inserta en `rotacion_control`. Con la re-verificación sin UPDLOCK esos dos órdenes se
    // abrazan y la víctima sale 500 `db_error` en vez del 409 `turno_cerrado` de CA-14 (el GATE-O2 lo
    // vio en su corrida, H4). Reproducir el deadlock sería una carrera; lo determinista es medir el
    // ORDEN: con un U lock ajeno sobre la cabecera, el TOMAR tiene que QUEDARSE ESPERANDO. Sin el
    // UPDLOCK toma un lock compartido —compatible con el U— y pasa de largo: ahí el caso se pone rojo.
    const tx = new sql.Transaction(db);
    await tx.begin();
    let resuelta = false;
    let pendiente;
    try {
      await new sql.Request(tx)
        .input('id', sql.Int, turno.turno_unidad_id)
        .query(`
          SELECT turno_unidad_id FROM bitacora.turno_unidad WITH (UPDLOCK)
          WHERE turno_unidad_id = @id
        `);
      pendiente = tomar('c').then((r) => { resuelta = true; return r; });
      await new Promise((resolver) => setTimeout(resolver, 1500));
      assert.equal(
        resuelta, false,
        'el TOMAR NO esperó al U lock de la cabecera: la re-verificación del estado está leyendo sin UPDLOCK '
        + '(CR2-6), y ese es el orden de bloqueos que se abraza con cerrarTurno',
      );
      assert.equal((await leerLog()).length, 0, 'y tampoco alcanzó a escribir el log');
    } finally {
      await tx.rollback();
    }
    const r = await pendiente;
    ok200(r, 'al soltar el U lock, el TOMAR sigue y compromete');
    assert.deepEqual((await leerLog()).map((e) => [e.usuario_id, e.accion]), [[ids.c, 'TOMAR']]);
  });

  test('CA-13 · descartar: ya_respondi queda en true para ese usuario en este turno, sin tocar la pila', async () => {
    await limpiarLog();
    let r = await estado('a');
    ok200(r, 'estado a');
    assert.equal(r.data.ya_respondi, false);

    r = await descartar('a');
    ok200(r, 'descartar a');
    assert.equal(r.data.ok, true, 'el contrato de /descartar trae ok: true');
    assert.deepEqual(Object.keys(r.data).filter((k) => k !== 'ok'), SHAPE_C5, 'y además el mismo shape que /estado');
    assert.equal(r.data.ya_respondi, true);
    assert.equal(r.data.principal.usuario_id, ids.titular, 'descartar no entra en la pila');
    assert.deepEqual(tomasDe(r.data.pila), []);

    r = await estado('a');
    ok200(r, 'estado a (2)');
    assert.equal(r.data.ya_respondi, true, 'sigue en true en el siguiente GET');
    r = await estado('a');
    assert.equal(r.data.ya_respondi, true, 'y en el que sigue');
    r = await estado('b');
    ok200(r, 'estado b');
    assert.equal(r.data.ya_respondi, false, 'es por usuario: b no ha respondido');

    // Idempotente: un segundo "No" no agrega otra fila.
    ok200(await descartar('a'), 'descartar a (2)');
    const log = await leerLog();
    assert.deepEqual(log.map((e) => [e.usuario_id, e.accion]), [[ids.a, 'DESCARTAR']]);
  });

  test('CA-14 · turno CERRADO: los tres verbos → 409 turno_cerrado y el log no se altera; /estado → aplica false', async () => {
    await limpiarLog();
    ok200(await tomar('a'), 'tomar a (turno abierto)');
    const antes = await leerLog();
    assert.equal(antes.length, 1);

    // Se sella la cabecera directo (el cierre real es `cerrarTurno`, territorio de L06 en esta ola).
    await db.request()
      .input('id', sql.Int, turno.turno_unidad_id)
      .input('por', sql.Int, ids.titular)
      .query(`
        UPDATE bitacora.turno_unidad
        SET estado = 'CERRADO', fin_real = SYSUTCDATETIME(), motivo_cierre = 'MANUAL',
            cerrado_por = @por, cerrado_en = SYSUTCDATETIME()
        WHERE turno_unidad_id = @id
      `);

    es409(await tomar('b'), 'turno_cerrado', 'tomar con turno cerrado');
    es409(await abandonar('a'), 'turno_cerrado', 'abandonar con turno cerrado');
    es409(await descartar('c'), 'turno_cerrado', 'descartar con turno cerrado');

    const despues = await leerLog();
    assert.deepEqual(despues, antes, 'el log (lo que L06 congela) no cambió');

    const r = await estado('a');
    ok200(r, 'estado a con turno cerrado');
    assert.equal(r.data.aplica, false, 'sin turno abierto el popup no se ofrece');
    assert.equal(r.data.turno_id, null);
    assert.equal(r.data.principal, null);
  });
});
