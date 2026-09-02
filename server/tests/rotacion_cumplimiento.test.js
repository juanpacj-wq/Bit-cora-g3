// D-065 · L06 — Cumplimiento plan-vs-real y congelado al cerrar el turno (superficie C, backend).
//
// Parte 1: lógica PURA (`evaluarEstado`, `derivarPrincipalDelLog`) — los cuatro escalones y la regla
//          central "por persona, no por conteo" (CA-15/CA-16), sin BD ni HTTP.
// Parte 2: BD contra la planta-fixture 'TST' (D-030/D-055) — el congelado dentro de `cerrarTurno`
//          (CA-17) y la consulta de rango, directa y por HTTP (CA-18). NUNCA se cierra un turno de
//          GEC3/GEC32: un `cerrarTurno` sobre planta real cierra el turno de producción.
//
// Fixture de rotación: un patrón para UN cargo, vigente SOLO en marzo de 2025 (fuera de cualquier
// carga anual real y del "hoy" de la suite), y dos titulares sintéticos asignados al grupo 1. Los
// turnos de prueba se abren en las fechas/turnos donde el grupo 1 está de guardia, que se buscan
// con el propio motor (C1, verificado contra el oráculo del Excel en L01).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID, USUARIO_SISTEMA_ID } from '../db.js';
import { grupoDeTurno, diasEntre } from '../utils/rotacion/patron.js';
import {
  ESTADOS,
  RANGO_MAX_DIAS,
  evaluarEstado,
  derivarPrincipalDelLog,
  fechaOperativaIso,
  congelarCumplimiento,
  consultarCumplimiento,
} from '../utils/rotacion/cumplimiento.js';
import {
  abrirTurnoSiFalta, cerrarTurno, marcarParticipante, reabrirTurno, resolverTurnoAbierto,
} from '../utils/turno-entidad.js';
import { setupSessions, call, deactivateSyntheticSessions, TEST_PLANTA } from './helpers.js';

const A = { usuario_id: 101, nombre: 'Titular A' };
const B = { usuario_id: 102, nombre: 'Titular B' };
const X = { usuario_id: 201, nombre: 'No titular X' };
const Y = { usuario_id: 202, nombre: 'No titular Y' };
const Z = { usuario_id: 203, nombre: 'No titular Z' };

// ---------------------------------------------------------------------------
// Parte 1 — lógica pura
// ---------------------------------------------------------------------------
describe('cumplimiento · evaluarEstado (puro)', () => {
  test('ESTADOS y RANGO_MAX_DIAS son los del contrato', () => {
    assert.deepEqual([...ESTADOS], ['PENDIENTE', 'PARCIAL', 'COMPLETO', 'CUBIERTO_POR_RELEVO']);
    assert.equal(RANGO_MAX_DIAS, 93);
  });

  describe('escalones', () => {
    test('ningún titular entró → PENDIENTE', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [] });
      assert.equal(r.estado, 'PENDIENTE');
      assert.deepEqual(r.titulares.map((t) => t.entro), [false, false]);
      assert.equal(r.relevo, null);
    });

    test('alguno pero no todos → PARCIAL', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [A.usuario_id] });
      assert.equal(r.estado, 'PARCIAL');
      assert.deepEqual(r.titulares, [
        { usuario_id: A.usuario_id, nombre: A.nombre, entro: true },
        { usuario_id: B.usuario_id, nombre: B.nombre, entro: false },
      ]);
    });

    test('todos los titulares → COMPLETO (decisión R9)', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [{ usuario_id: B.usuario_id }, { usuario_id: A.usuario_id }] });
      assert.equal(r.estado, 'COMPLETO');
      assert.ok(r.titulares.every((t) => t.entro));
    });

    test('un no-titular con el control → CUBIERTO_POR_RELEVO, y gana aunque todos los titulares hayan entrado', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [A.usuario_id, B.usuario_id], principal: X });
      assert.equal(r.estado, 'CUBIERTO_POR_RELEVO');
      assert.deepEqual(r.relevo, { usuario_id: X.usuario_id, nombre: X.nombre });
      // Los titulares se siguen reportando con su `entro` real: el relevo no los borra del registro.
      assert.ok(r.titulares.every((t) => t.entro));
    });

    test('un titular que tomó el control explícitamente NO es relevo: se evalúa por escalones', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [A.usuario_id], principal: A });
      assert.equal(r.estado, 'PARCIAL');
      assert.equal(r.relevo, null);
    });
  });

  describe('por persona, no por conteo', () => {
    test('CA-15: tres participantes del rol y NINGUNO titular → sigue PENDIENTE', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: [X.usuario_id, Y.usuario_id, Z.usuario_id] });
      assert.equal(r.estado, 'PENDIENTE');
      assert.deepEqual(r.titulares.map((t) => t.entro), [false, false]);
      assert.equal(r.relevo, null);
    });

    test('el conteo de participantes no importa: un solo titular entre veinte ajenos → PARCIAL', () => {
      const ajenos = Array.from({ length: 20 }, (_, i) => 1000 + i);
      const r = evaluarEstado({ titulares: [A, B], participantes: [...ajenos, B.usuario_id] });
      assert.equal(r.estado, 'PARCIAL');
    });

    test('acepta los participantes como Set (así los entrega la lectura de BD)', () => {
      const r = evaluarEstado({ titulares: [A, B], participantes: new Set([A.usuario_id, B.usuario_id]) });
      assert.equal(r.estado, 'COMPLETO');
    });

    test('sin titulares ni relevo → PENDIENTE con lista vacía (el llamador decide no congelarlo)', () => {
      const r = evaluarEstado({ titulares: [], participantes: [X.usuario_id] });
      assert.equal(r.estado, 'PENDIENTE');
      assert.deepEqual(r.titulares, []);
    });
  });
});

describe('cumplimiento · derivarPrincipalDelLog (puro)', () => {
  const ev = (u, accion) => ({ usuario_id: u.usuario_id, nombre: u.nombre, accion });

  test('log vacío → null (el principal es el titular del patrón)', () => {
    assert.equal(derivarPrincipalDelLog([]), null);
    assert.equal(derivarPrincipalDelLog(), null);
  });

  test('TOMAR apila; el tope es el último TOMAR sin su ABANDONAR', () => {
    assert.deepEqual(derivarPrincipalDelLog([ev(X, 'TOMAR')]), { usuario_id: X.usuario_id, nombre: X.nombre });
    assert.equal(derivarPrincipalDelLog([ev(X, 'TOMAR'), ev(Y, 'TOMAR'), ev(Y, 'ABANDONAR')]).usuario_id, X.usuario_id);
  });

  test('A toma, B toma, C toma, C abandona → B; B abandona → A; A abandona → null (CA-10 en espejo)', () => {
    const base = [ev(X, 'TOMAR'), ev(Y, 'TOMAR'), ev(Z, 'TOMAR'), ev(Z, 'ABANDONAR')];
    assert.equal(derivarPrincipalDelLog(base).usuario_id, Y.usuario_id);
    assert.equal(derivarPrincipalDelLog([...base, ev(Y, 'ABANDONAR')]).usuario_id, X.usuario_id);
    assert.equal(derivarPrincipalDelLog([...base, ev(Y, 'ABANDONAR'), ev(X, 'ABANDONAR')]), null);
  });

  test('ABANDONAR de quien no es el tope se ignora; DESCARTAR nunca entra en la pila', () => {
    assert.equal(derivarPrincipalDelLog([ev(X, 'TOMAR'), ev(Y, 'ABANDONAR')]).usuario_id, X.usuario_id);
    assert.equal(derivarPrincipalDelLog([ev(X, 'DESCARTAR')]), null);
    assert.equal(derivarPrincipalDelLog([ev(X, 'TOMAR'), ev(Z, 'DESCARTAR')]).usuario_id, X.usuario_id);
  });
});

describe('cumplimiento · fechaOperativaIso (puro)', () => {
  test('string canónico pasa tal cual; Date de columna DATE (medianoche UTC) usa las partes UTC', () => {
    assert.equal(fechaOperativaIso('2026-05-17'), '2026-05-17');
    assert.equal(fechaOperativaIso(new Date('2026-05-17T00:00:00.000Z')), '2026-05-17');
  });
  test('cualquier otra cosa → fecha_invalida', () => {
    assert.throws(() => fechaOperativaIso('2026-05-17T10:00'), /fecha_invalida/);
    assert.throws(() => fechaOperativaIso(null), /fecha_invalida/);
    assert.throws(() => fechaOperativaIso(new Date('no')), /fecha_invalida/);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — BD (TEST_PLANTA) + HTTP
// ---------------------------------------------------------------------------
describe('cumplimiento · congelado y reporte (BD, TEST_PLANTA)', () => {
  let pool;
  let ctx;
  let CARGO_ID;
  let CARGO_OBSERVADOR_ID;
  const P = TEST_PLANTA_ID;
  const CARGO_FIXTURE = 'Operador de Planta - Sala de Mando';

  // Patrón OPS real (§2.2), pero vigente SOLO en marzo de 2025: ningún turno real cae en ese rango.
  const PATRON = {
    fecha_inicio: '2025-03-01',
    fecha_fin: '2025-03-31',
    vector_t1: [1, 1, 3, 3, 4, 4, 2, 2],
    vector_t2: [4, 2, 2, 1, 1, 3, 3, 4],
    desfase: 3,
  };
  const GRUPO_FIXTURE = 1;
  const FECHA_SIN_PATRON = '2025-04-10'; // fuera de [fecha_inicio, fecha_fin]

  // Los (fecha, turno) de marzo de 2025 donde el grupo 1 está de guardia, en orden cronológico.
  function slotsDelGrupo(n) {
    const out = [];
    for (let d = 1; d <= 31 && out.length < n; d += 1) {
      const fecha = `2025-03-${String(d).padStart(2, '0')}`;
      for (const turno of [1, 2]) {
        if (out.length < n && grupoDeTurno(PATRON, fecha, turno) === GRUPO_FIXTURE) out.push({ fecha, turno });
      }
    }
    assert.equal(out.length, n, `se necesitan ${n} slots del grupo ${GRUPO_FIXTURE} en marzo`);
    return out;
  }
  const SLOTS = slotsDelGrupo(6);
  const ahoraApertura = (s) => new Date(s.turno === 1 ? `${s.fecha}T15:00:00Z` : `${s.fecha}T23:30:00Z`);
  const ahoraCierre = (s) => new Date(ahoraApertura(s).getTime() + 60 * 60 * 1000);

  async function limpiarFixtureRotacion() {
    // Orden de FK: cumplimiento y control cuelgan de turno_unidad; asignación y patrón, de los catálogos.
    await pool.request()
      .input('p', sql.VarChar(10), P)
      .input('cargo', sql.Int, CARGO_ID)
      .input('desde', sql.Date, PATRON.fecha_inicio)
      .query(`
        DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
        DELETE FROM bitacora.rotacion_control      WHERE planta_id = @p;
        DELETE ra FROM bitacora.rotacion_asignacion ra
          INNER JOIN lov_bit.usuario u ON u.usuario_id = ra.usuario_id
         WHERE u.es_sintetico = 1 AND ra.cargo_id = @cargo AND ra.vigente_desde = @desde;
        DELETE FROM bitacora.rotacion_patron WHERE cargo_id = @cargo AND fecha_inicio = @desde;
      `);
  }

  // Espejo de `limpiarTurnos` de turno-entidad.test.js, con las dos tablas de rotación por delante
  // (las dos referencian turno_unidad por FK). Acotado a la planta-fixture.
  async function limpiarTurnosTST() {
    await pool.request().input('p', sql.VarChar(10), P).query(`
      DELETE FROM bitacora.rotacion_cumplimiento WHERE planta_id = @p;
      DELETE FROM bitacora.rotacion_control      WHERE planta_id = @p;
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

  // Idempotente: siembra el patrón y los dos titulares solo si el patrón no está. Cada test de
  // congelado la llama, así que corren solos (p. ej. con --test-name-pattern) sin depender del orden.
  // Los tests de REPORTE sí son una secuencia a propósito: cuentan lo que congelaron los anteriores.
  async function asegurarFixtureRotacion() {
    const existe = (await pool.request()
      .input('cargo', sql.Int, CARGO_ID)
      .input('desde', sql.Date, PATRON.fecha_inicio)
      .query(`SELECT 1 AS x FROM bitacora.rotacion_patron WHERE cargo_id = @cargo AND fecha_inicio = @desde`)).recordset[0];
    if (existe) return;
    await pool.request()
      .input('cargo', sql.Int, CARGO_ID)
      .input('ini', sql.Date, PATRON.fecha_inicio)
      .input('fin', sql.Date, PATRON.fecha_fin)
      .input('v1', sql.VarChar(32), PATRON.vector_t1.join(','))
      .input('v2', sql.VarChar(32), PATRON.vector_t2.join(','))
      .input('desfase', sql.TinyInt, PATRON.desfase)
      .input('por', sql.Int, USUARIO_SISTEMA_ID)
      .query(`
        INSERT INTO bitacora.rotacion_patron
          (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
        VALUES (@cargo, @ini, @fin, @v1, @v2, @desfase, 1, @por)
      `);
    for (const u of [ctx.usuarios.jdt, ctx.usuarios.ingOp]) {
      await pool.request()
        .input('u', sql.Int, u.usuario_id)
        .input('cargo', sql.Int, CARGO_ID)
        .input('grupo', sql.TinyInt, GRUPO_FIXTURE)
        .input('desde', sql.Date, PATRON.fecha_inicio)
        .input('hasta', sql.Date, PATRON.fecha_fin)
        .input('por', sql.Int, USUARIO_SISTEMA_ID)
        .query(`
          INSERT INTO bitacora.rotacion_asignacion
            (usuario_id, cargo_id, grupo, vigente_desde, vigente_hasta, creado_por)
          VALUES (@u, @cargo, @grupo, @desde, @hasta, @por)
        `);
    }
  }

  async function sembrarPatronYTitulares() {
    await limpiarFixtureRotacion();
    await asegurarFixtureRotacion();
  }

  async function insertarControl(turno_id, usuario_id, accion) {
    await pool.request()
      .input('t', sql.Int, turno_id)
      .input('p', sql.VarChar(10), P)
      .input('cargo', sql.Int, CARGO_ID)
      .input('u', sql.Int, usuario_id)
      .input('accion', sql.VarChar(12), accion)
      .query(`
        INSERT INTO bitacora.rotacion_control (turno_id, planta_id, cargo_id, usuario_id, accion)
        VALUES (@t, @p, @cargo, @u, @accion)
      `);
  }

  // Abre el turno del slot en TST, marca participantes (con el cargo dado o el de la fixture), escribe
  // eventos de control y lo cierra por el ÚNICO camino de cierre (`cerrarTurno`, convención 21).
  async function abrirYCerrar(slot, { participantes = [], control = [] } = {}) {
    const t = await abrirTurnoSiFalta(pool, P, slot.turno, slot.fecha, ahoraApertura(slot));
    assert.equal(t.estado, 'ABIERTO', 'la fixture no debe tener otro turno ABIERTO');
    for (const p of participantes) {
      await marcarParticipante(pool, {
        turno_id: t.turno_unidad_id, usuario_id: p.usuario_id,
        cargo_id: p.cargo_id ?? CARGO_ID, cargo_nombre: p.cargo_nombre ?? CARGO_FIXTURE,
      });
    }
    for (const c of control) await insertarControl(t.turno_unidad_id, c.usuario_id, c.accion);
    const res = await cerrarTurno(pool, t.turno_unidad_id, {
      motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA', ahora: ahoraCierre(slot),
      incluirSinteticos: true, // D-044: los titulares/participantes de la fixture son usuarios test_*
    });
    assert.equal(res.cerrado?.estado, 'CERRADO');
    return t;
  }

  async function filasDe(turno_id) {
    const r = await pool.request().input('t', sql.Int, turno_id).query(`
      SELECT fecha_operativa, planta_id, turno, cargo_id, cargo_nombre, grupo, estado, titulares_json,
             relevo_usuario_id, turno_id, snapshot_en
      FROM bitacora.rotacion_cumplimiento WHERE turno_id = @t
    `);
    return r.recordset.map((row) => ({ ...row, titulares: JSON.parse(row.titulares_json) }));
  }

  const entroDe = (fila, usuario_id) => fila.titulares.find((t) => t.usuario_id === usuario_id)?.entro;

  before(async () => {
    await initDB();
    pool = await getDB();
    ctx = await setupSessions({ planta: TEST_PLANTA });
    const cargos = (await pool.request().query(`SELECT cargo_id, nombre, es_observador FROM lov_bit.cargo`)).recordset;
    CARGO_ID = cargos.find((c) => c.nombre === CARGO_FIXTURE)?.cargo_id;
    CARGO_OBSERVADOR_ID = cargos.find((c) => c.es_observador)?.cargo_id;
    assert.ok(CARGO_ID, `existe el cargo '${CARGO_FIXTURE}'`);
    assert.ok(CARGO_OBSERVADOR_ID, 'existe un cargo con es_observador = 1 (D-059)');
    await limpiarTurnosTST();
    await limpiarFixtureRotacion();
  });

  after(async () => {
    await limpiarTurnosTST();
    await limpiarFixtureRotacion();
    await deactivateSyntheticSessions();
  });

  // ── CA-17 ──────────────────────────────────────────────────────────────────────────────────────
  test('congelado · un cierre con CERO patrones activos NO falla: filas = 0 y el turno queda CERRADO', async () => {
    await limpiarTurnosTST();
    const slot = { fecha: FECHA_SIN_PATRON, turno: 1 };
    const t = await abrirTurnoSiFalta(pool, P, slot.turno, slot.fecha, ahoraApertura(slot));

    // Contrato C7 directo, dentro de una transacción propia: devuelve { filas: 0 } sin lanzar.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    let directo;
    try {
      directo = await congelarCumplimiento(tx, {
        turno_id: t.turno_unidad_id, fecha_operativa: slot.fecha, planta_id: P, turno: slot.turno,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    assert.deepEqual(directo, { filas: 0 });

    // Y por el camino real: el cierre entero no se cae por falta de patrones.
    const res = await cerrarTurno(pool, t.turno_unidad_id, {
      motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, ahora: ahoraCierre(slot),
    });
    assert.equal(res.cerrado.estado, 'CERRADO', 'sin patrones el turno se cierra igual');
    assert.equal((await filasDe(t.turno_unidad_id)).length, 0);
  });

  // ── GATE-O2 (hallazgo 1 de L06): reabrir borra el congelado; el re-cierre lo recongela fresco ──
  test('reabrir · reabrirTurno borra el cumplimiento congelado y el re-cierre lo recongela con la verdad nueva', async () => {
    await limpiarTurnosTST();
    await sembrarPatronYTitulares();
    const slot = SLOTS[0];
    // Primer cierre: entró un solo titular → PARCIAL congelado.
    const t = await abrirYCerrar(slot, { participantes: [ctx.usuarios.jdt] });
    assert.equal((await filasDe(t.turno_unidad_id))[0]?.estado, 'PARCIAL');

    // Reabrir dentro de la ventana del turno (30 min después del cierre).
    const ahoraReapertura = new Date(ahoraCierre(slot).getTime() + 30 * 60 * 1000);
    const r = await reabrirTurno(pool, t.turno_unidad_id, { por_usuario: USUARIO_SISTEMA_ID, ahora: ahoraReapertura });
    assert.equal(r.reabierto?.estado, 'ABIERTO', `reabrió (motivo: ${r.motivo ?? '-'})`);
    assert.equal((await filasDe(t.turno_unidad_id)).length, 0, 'reabrir deja el turno SIN cumplimiento congelado');

    // Entra el segundo titular y se vuelve a cerrar: la fila nueva dice COMPLETO, no la vieja PARCIAL.
    await marcarParticipante(pool, {
      turno_id: t.turno_unidad_id, usuario_id: ctx.usuarios.ingOp.usuario_id,
      cargo_id: CARGO_ID, cargo_nombre: CARGO_FIXTURE,
    });
    const res = await cerrarTurno(pool, t.turno_unidad_id, {
      motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: 'SISTEMA',
      ahora: new Date(ahoraReapertura.getTime() + 30 * 60 * 1000), incluirSinteticos: true,
    });
    assert.equal(res.cerrado?.estado, 'CERRADO');
    const filas = await filasDe(t.turno_unidad_id);
    assert.equal(filas.length, 1, 'una sola fila tras el re-cierre');
    assert.equal(filas[0].estado, 'COMPLETO', 'el re-cierre congela la verdad nueva, no la vieja');
    assert.equal(entroDe(filas[0], ctx.usuarios.ingOp.usuario_id), true);
  });

  test('congelado · cerrarTurno deja UNA fila por (fecha, planta, turno, cargo), con el titular ausente marcado; cerrar dos veces no duplica', async () => {
    await limpiarTurnosTST();
    await sembrarPatronYTitulares();
    const slot = SLOTS[0];
    const t = await abrirYCerrar(slot, { participantes: [ctx.usuarios.jdt] });

    const filas = await filasDe(t.turno_unidad_id);
    assert.equal(filas.length, 1, 'exactamente una fila para el único rol con patrón');
    const f = filas[0];
    assert.equal(fechaOperativaIso(f.fecha_operativa), slot.fecha);
    assert.equal(f.planta_id, P);
    assert.equal(f.turno, slot.turno);
    assert.equal(f.cargo_id, CARGO_ID);
    assert.equal(f.cargo_nombre, CARGO_FIXTURE, 'cargo_nombre congelado (D-052)');
    assert.equal(f.grupo, GRUPO_FIXTURE);
    assert.equal(f.estado, 'PARCIAL');
    assert.equal(f.titulares.length, 2);
    assert.equal(entroDe(f, ctx.usuarios.jdt.usuario_id), true);
    assert.equal(entroDe(f, ctx.usuarios.ingOp.usuario_id), false, 'el titular que no entró queda marcado');
    assert.equal(f.relevo_usuario_id, null);
    assert.equal(f.turno_id, t.turno_unidad_id);
    assert.ok(f.snapshot_en instanceof Date);

    // Segundo cierre del mismo turno: idempotente (cerrado:null) y sigue habiendo UNA fila.
    const otra = await cerrarTurno(pool, t.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID });
    assert.equal(otra.cerrado, null);
    assert.equal((await filasDe(t.turno_unidad_id)).length, 1);

    // Y el congelado directo sobre un turno ya congelado tampoco duplica: NOT EXISTS por la PK.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const r = await congelarCumplimiento(tx, {
        turno_id: t.turno_unidad_id, fecha_operativa: slot.fecha, planta_id: P, turno: slot.turno, incluirSinteticos: true,
      });
      await tx.commit();
      assert.deepEqual(r, { filas: 0 }, 'ya estaba congelado: 0 filas nuevas');
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    assert.equal((await filasDe(t.turno_unidad_id)).length, 1);
  });

  // ── CA-15 ──────────────────────────────────────────────────────────────────────────────────────
  test('por persona, no por conteo · tres participantes del rol y ninguno titular → PENDIENTE (end-to-end)', async () => {
    await asegurarFixtureRotacion();
    const slot = SLOTS[1];
    const t = await abrirYCerrar(slot, {
      participantes: [ctx.usuarios.opSala, ctx.usuarios.ingQuim, ctx.usuarios.admin],
    });
    const [f] = await filasDe(t.turno_unidad_id);
    assert.ok(f, 'hay fila congelada');
    assert.equal(f.estado, 'PENDIENTE', 'tres del rol pero ninguno titular: el slot sigue vacío');
    assert.deepEqual(f.titulares.map((x) => x.entro), [false, false]);
    assert.equal(f.relevo_usuario_id, null);
  });

  // ── CA-16 (end-to-end; los cuatro escalones puros están en la Parte 1) ────────────────────────
  test('escalones · los dos titulares entran → COMPLETO', async () => {
    await asegurarFixtureRotacion();
    const slot = SLOTS[2];
    const t = await abrirYCerrar(slot, { participantes: [ctx.usuarios.jdt, ctx.usuarios.ingOp] });
    const [f] = await filasDe(t.turno_unidad_id);
    assert.equal(f.estado, 'COMPLETO');
    assert.ok(f.titulares.every((x) => x.entro));
  });

  test('escalones · un no-titular con TOMAR en el log → CUBIERTO_POR_RELEVO gana y queda relevo_usuario_id', async () => {
    await asegurarFixtureRotacion();
    const slot = SLOTS[3];
    const t = await abrirYCerrar(slot, {
      participantes: [ctx.usuarios.jdt, ctx.usuarios.opSala],
      control: [{ usuario_id: ctx.usuarios.opSala.usuario_id, accion: 'TOMAR' }],
    });
    const [f] = await filasDe(t.turno_unidad_id);
    assert.equal(f.estado, 'CUBIERTO_POR_RELEVO');
    assert.equal(f.relevo_usuario_id, ctx.usuarios.opSala.usuario_id);
    assert.equal(entroDe(f, ctx.usuarios.jdt.usuario_id), true, 'el titular que sí entró se conserva en el registro');
  });

  test('D-059 · un titular que entra como OBSERVADOR no satisface el slot → PENDIENTE', async () => {
    await asegurarFixtureRotacion();
    const slot = SLOTS[4];
    const t = await abrirYCerrar(slot, {
      participantes: [{ ...ctx.usuarios.ingOp, cargo_id: CARGO_OBSERVADOR_ID, cargo_nombre: 'observador' }],
    });
    const [f] = await filasDe(t.turno_unidad_id);
    assert.equal(f.estado, 'PENDIENTE');
    assert.equal(entroDe(f, ctx.usuarios.ingOp.usuario_id), false);
  });

  // ── CA-18 (consulta directa: congelados + en vivo) ──────────────────────────────────────────────
  test('reporte de rango · consultarCumplimiento devuelve los congelados del rango con congelado:true y el resumen', async () => {
    const { filas, resumen } = await consultarCumplimiento(pool, {
      desde: PATRON.fecha_inicio, hasta: PATRON.fecha_fin, planta_id: P, turnoAbierto: null,
    });
    assert.equal(filas.length, 5, 'los cinco turnos cerrados de la fixture');
    assert.ok(filas.every((f) => f.congelado === true && f.planta_id === P && f.cargo_id === CARGO_ID));
    assert.deepEqual(resumen, { PENDIENTE: 2, PARCIAL: 1, COMPLETO: 1, CUBIERTO_POR_RELEVO: 1 });

    // Orden cronológico y shape C6.
    const claves = filas.map((f) => `${f.fecha_operativa}|${f.turno}`);
    assert.deepEqual(claves, SLOTS.slice(0, 5).map((s) => `${s.fecha}|${s.turno}`));
    const parcial = filas.find((f) => f.estado === 'PARCIAL');
    assert.deepEqual(Object.keys(parcial).sort(), [
      'cargo_id', 'cargo_nombre', 'congelado', 'estado', 'fecha_operativa', 'grupo', 'planta_id', 'relevo', 'titulares', 'turno',
    ]);
    assert.equal(parcial.titulares.find((t) => t.usuario_id === ctx.usuarios.ingOp.usuario_id).entro, false,
      'el reporte dice qué titular no entró y en qué turno');
    const relevo = filas.find((f) => f.estado === 'CUBIERTO_POR_RELEVO');
    assert.equal(relevo.relevo.usuario_id, ctx.usuarios.opSala.usuario_id);
    assert.equal(relevo.relevo.nombre, ctx.usuarios.opSala.nombre_completo);

    // Fuera del rango no hay nada, y el resumen trae las cuatro claves en cero.
    const vacio = await consultarCumplimiento(pool, { desde: '2025-05-01', hasta: '2025-05-02', planta_id: P });
    assert.deepEqual(vacio, { filas: [], resumen: { PENDIENTE: 0, PARCIAL: 0, COMPLETO: 0, CUBIERTO_POR_RELEVO: 0 } });
  });

  test('reporte de rango · el turno ABIERTO se deriva en vivo (congelado:false) y al cerrarlo pasa a congelado sin duplicarse', async () => {
    await asegurarFixtureRotacion();
    const slot = SLOTS[5];
    const t = await abrirTurnoSiFalta(pool, P, slot.turno, slot.fecha, ahoraApertura(slot));
    assert.equal(t.estado, 'ABIERTO');
    await marcarParticipante(pool, {
      turno_id: t.turno_unidad_id, usuario_id: ctx.usuarios.jdt.usuario_id, cargo_id: CARGO_ID, cargo_nombre: CARGO_FIXTURE,
    });
    const turnoAbierto = await resolverTurnoAbierto(pool, P);
    assert.equal(turnoAbierto.turno_unidad_id, t.turno_unidad_id);

    const vivo = await consultarCumplimiento(pool, {
      desde: PATRON.fecha_inicio, hasta: PATRON.fecha_fin, planta_id: P, turnoAbierto,
    });
    const filaViva = vivo.filas.filter((f) => f.fecha_operativa === slot.fecha && f.turno === slot.turno);
    assert.equal(filaViva.length, 1, 'una sola fila para el turno en curso');
    assert.equal(filaViva[0].congelado, false);
    // D-044: la consulta es camino de PRODUCCIÓN y no incluye sintéticos, así que el titular test_*
    // que acaba de entrar es invisible para ella. El estado en vivo correcto es PENDIENTE.
    assert.equal(filaViva[0].estado, 'PENDIENTE');
    assert.equal(vivo.filas.length, 6);

    await cerrarTurno(pool, t.turno_unidad_id, {
      motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, ahora: ahoraCierre(slot), incluirSinteticos: true,
    });
    const cerrado = await consultarCumplimiento(pool, {
      desde: PATRON.fecha_inicio, hasta: PATRON.fecha_fin, planta_id: P, turnoAbierto: await resolverTurnoAbierto(pool, P),
    });
    const filaCongelada = cerrado.filas.filter((f) => f.fecha_operativa === slot.fecha && f.turno === slot.turno);
    assert.equal(filaCongelada.length, 1, 'sigue siendo una sola fila');
    assert.equal(filaCongelada[0].congelado, true);
    assert.equal(filaCongelada[0].estado, 'PARCIAL', 'congelado con incluirSinteticos: el titular sí entró');
    assert.equal(cerrado.filas.length, 6);
  });

  // ── CA-18 (HTTP) — el router lo monta L04 en auth/app.js como /api/rotacion/cumplimiento ─────────
  const URL = '/api/rotacion/cumplimiento';
  const q = (desde, hasta, planta = P) => `${URL}?desde=${desde}&hasta=${hasta}&planta_id=${planta}`;

  test('GET /cumplimiento · sin sesión → 401', async () => {
    const { status } = await call('GET', q(PATRON.fecha_inicio, PATRON.fecha_fin));
    assert.equal(status, 401);
  });

  test('GET /cumplimiento · 94 días → 400 rango_excesivo; 93 días → 200', async () => {
    assert.equal(diasEntre('2025-03-01', '2025-06-02') + 1, 94);
    const malo = await call('GET', q('2025-03-01', '2025-06-02'), { sesion_id: ctx.sesiones.jdt });
    assert.equal(malo.status, 400, JSON.stringify(malo.data));
    assert.equal(malo.data.codigo, 'rango_excesivo');
    assert.equal(malo.data.error, 'rango_excesivo');
    assert.ok(malo.data.mensaje);

    assert.equal(diasEntre('2025-03-01', '2025-06-01') + 1, RANGO_MAX_DIAS);
    const bueno = await call('GET', q('2025-03-01', '2025-06-01'), { sesion_id: ctx.sesiones.jdt });
    assert.equal(bueno.status, 200, `el router debe estar montado como ${URL} (lo monta L04): ${JSON.stringify(bueno.data)}`);
  });

  test('GET /cumplimiento · validaciones: fecha inventada, rango invertido, planta inexistente → 400 con slug', async () => {
    const s = { sesion_id: ctx.sesiones.jdt };
    const fecha = await call('GET', q('2025-02-30', '2025-03-05'), s);
    assert.equal(fecha.status, 400);
    assert.equal(fecha.data.codigo, 'fecha_invalida');
    const invertido = await call('GET', q('2025-03-10', '2025-03-09'), s);
    assert.equal(invertido.status, 400);
    assert.equal(invertido.data.codigo, 'rango_invalido');
    const planta = await call('GET', q('2025-03-01', '2025-03-05', 'NOPE'), s);
    assert.equal(planta.status, 400);
    assert.equal(planta.data.codigo, 'planta_invalida');
    const sinRango = await call('GET', `${URL}?planta_id=${P}`, s);
    assert.equal(sinRango.status, 400);
    assert.equal(sinRango.data.codigo, 'rango_requerido');
  });

  test('GET /cumplimiento · 200 con el shape C6: filas congeladas del rango, quién no entró, y el resumen; lo ve un cargo de solo lectura', async () => {
    const { status, data } = await call('GET', q(PATRON.fecha_inicio, PATRON.fecha_fin), { sesion_id: ctx.sesiones.ingQuim });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(Array.isArray(data.filas));
    assert.equal(data.filas.length, 6, 'los seis turnos cerrados de la fixture');
    assert.ok(data.filas.every((f) => f.congelado === true && f.planta_id === P));
    assert.deepEqual(data.resumen, { PENDIENTE: 2, PARCIAL: 2, COMPLETO: 1, CUBIERTO_POR_RELEVO: 1 });
    const total = Object.values(data.resumen).reduce((a, b) => a + b, 0);
    assert.equal(total, data.filas.length);

    const primera = data.filas[0];
    assert.equal(primera.fecha_operativa, SLOTS[0].fecha);
    assert.equal(primera.turno, SLOTS[0].turno);
    assert.equal(primera.cargo_nombre, CARGO_FIXTURE);
    assert.equal(primera.grupo, GRUPO_FIXTURE);
    assert.equal(primera.estado, 'PARCIAL');
    const ausente = primera.titulares.find((t) => t.usuario_id === ctx.usuarios.ingOp.usuario_id);
    assert.deepEqual(ausente, { usuario_id: ctx.usuarios.ingOp.usuario_id, nombre: ctx.usuarios.ingOp.nombre_completo, entro: false });
    assert.equal(primera.relevo, null);

    const conRelevo = data.filas.find((f) => f.estado === 'CUBIERTO_POR_RELEVO');
    assert.equal(conRelevo.relevo.usuario_id, ctx.usuarios.opSala.usuario_id);
  });

  test('GET /cumplimiento · otra planta del catálogo no ve las filas de TST', async () => {
    const { status, data } = await call('GET', q(PATRON.fecha_inicio, PATRON.fecha_fin, 'GEC32'), { sesion_id: ctx.sesiones.jdt });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.filas.every((f) => f.planta_id === 'GEC32'), 'ninguna fila de la fixture se cuela en otra planta');
  });
});
