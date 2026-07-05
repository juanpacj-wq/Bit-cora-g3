// D-045 E2 — dominio de la cabecera de turno (utils/turno-entidad.js).
// Parte 1: lógica pura (umbral, bloqueo, auto-cierre) sin DB ni HTTP, con foco en el cruce de
// medianoche T2 y los bordes de umbral 06:00/18:00 Bogotá.
// Parte 2: operaciones de BD contra TEST_PLANTA ('TST', D-030) — nunca sobre GEC3/GEC32.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID, USUARIO_SISTEMA_ID } from '../db.js';
import { getTurnoColombia } from '../utils/turno.js';
import {
  GRACIA_CIERRE_MIN,
  MOTIVOS_CIERRE,
  proximoUmbral,
  estadoBloqueo,
  motivoAutoCierre,
  abrirTurnoSiFalta,
  resolverTurnoAbierto,
  activarSucesor,
  cerrarTurno,
  extenderTurno,
  marcarParticipante,
  acumularPresenciaSesiones,
} from '../utils/turno-entidad.js';

const iso = (d) => new Date(d).toISOString();

// ---------------------------------------------------------------------------
// Parte 1 — lógica pura
// ---------------------------------------------------------------------------
describe('turno-entidad · lógica pura', () => {
  test('GRACIA_CIERRE_MIN y MOTIVOS_CIERRE son las constantes esperadas', () => {
    assert.equal(GRACIA_CIERRE_MIN, 60);
    assert.deepEqual(MOTIVOS_CIERRE, ['MANUAL', 'AUTO_SIN_PERSONAL', 'AUTO_SIN_RESPUESTA']);
  });

  describe('proximoUmbral — bordes de umbral y cruce de medianoche T2', () => {
    // Bogotá = UTC−5. Umbrales 06:00 y 18:00 Bogotá.
    test('T1 mediodía (12:00 Bogotá) → 18:00 Bogotá mismo día', () => {
      // 12:00 Bogotá 2026-04-10 = 17:00Z
      assert.equal(iso(proximoUmbral(new Date('2026-04-10T17:00:00Z'))), '2026-04-10T23:00:00.000Z');
    });
    test('umbral 18:00 Bogotá exacto → SIGUIENTE umbral 06:00 día+1 (no el mismo)', () => {
      // 18:00 Bogotá 2026-04-10 = 23:00Z → próximo = 06:00 Bogotá 2026-04-11 = 11:00Z
      assert.equal(iso(proximoUmbral(new Date('2026-04-10T23:00:00Z'))), '2026-04-11T11:00:00.000Z');
    });
    test('medianoche (00:00 Bogotá, T2 tras cruzar) → 06:00 Bogotá mismo día', () => {
      // 00:00 Bogotá 2026-04-11 = 05:00Z → próximo = 06:00 Bogotá 2026-04-11 = 11:00Z
      assert.equal(iso(proximoUmbral(new Date('2026-04-11T05:00:00Z'))), '2026-04-11T11:00:00.000Z');
    });
    test('05:59 Bogotá (T2, aún antes del umbral) → 06:00 Bogotá mismo día', () => {
      // 05:59 Bogotá 2026-04-11 = 10:59Z → 06:00 Bogotá 2026-04-11 = 11:00Z
      assert.equal(iso(proximoUmbral(new Date('2026-04-11T10:59:00Z'))), '2026-04-11T11:00:00.000Z');
    });
    test('umbral 06:00 Bogotá exacto → SIGUIENTE umbral 18:00 mismo día', () => {
      // 06:00 Bogotá 2026-04-11 = 11:00Z → 18:00 Bogotá 2026-04-11 = 23:00Z
      assert.equal(iso(proximoUmbral(new Date('2026-04-11T11:00:00Z'))), '2026-04-11T23:00:00.000Z');
    });
  });

  describe('estadoBloqueo', () => {
    const finT1 = '2026-04-10T23:00:00Z'; // 18:00 Bogotá
    test('ABIERTO antes del fin_nominal → no bloquea', () => {
      const row = { estado: 'ABIERTO', fin_nominal: finT1 };
      assert.equal(estadoBloqueo(row, new Date('2026-04-10T22:00:00Z')), false);
    });
    test('ABIERTO justo en el fin_nominal → bloquea', () => {
      const row = { estado: 'ABIERTO', fin_nominal: finT1 };
      assert.equal(estadoBloqueo(row, new Date('2026-04-10T23:00:00Z')), true);
    });
    test('ABIERTO pasado el fin_nominal → bloquea', () => {
      const row = { estado: 'ABIERTO', fin_nominal: finT1 };
      assert.equal(estadoBloqueo(row, new Date('2026-04-10T23:30:00Z')), true);
    });
    test('PROGRAMADO/CERRADO nunca bloquean', () => {
      assert.equal(estadoBloqueo({ estado: 'PROGRAMADO', fin_nominal: finT1 }, new Date('2026-04-11T00:00:00Z')), false);
      assert.equal(estadoBloqueo({ estado: 'CERRADO', fin_nominal: finT1 }, new Date('2026-04-11T00:00:00Z')), false);
    });
    test('tras extender (fin_nominal movido al próximo umbral) deja de bloquear y RE-bloquea al nuevo umbral', () => {
      // Extendido: fin_nominal ahora 06:00 Bogotá día+1 = 2026-04-11T11:00:00Z
      const extendido = { estado: 'ABIERTO', fin_nominal: '2026-04-11T11:00:00Z' };
      // 23:30Z (18:30 Bogotá) < nuevo fin → no bloquea (la extensión cubre ahora)
      assert.equal(estadoBloqueo(extendido, new Date('2026-04-10T23:30:00Z')), false);
      // Al llegar el nuevo umbral 06:00 → vuelve a bloquear
      assert.equal(estadoBloqueo(extendido, new Date('2026-04-11T11:00:00Z')), true);
    });
    test('entradas nulas/incompletas → no bloquea', () => {
      assert.equal(estadoBloqueo(null, new Date()), false);
      assert.equal(estadoBloqueo({ estado: 'ABIERTO', fin_nominal: null }, new Date()), false);
    });
  });

  describe('motivoAutoCierre', () => {
    test('sin personal → AUTO_SIN_PERSONAL (inmediato)', () => {
      assert.equal(motivoAutoCierre({ hayPersonal: false, minutosDesdeUmbral: 0 }), 'AUTO_SIN_PERSONAL');
    });
    test('con personal, dentro de la gracia (<60) → null', () => {
      assert.equal(motivoAutoCierre({ hayPersonal: true, minutosDesdeUmbral: 30 }), null);
      assert.equal(motivoAutoCierre({ hayPersonal: true, minutosDesdeUmbral: 59 }), null);
    });
    test('con personal, alcanzada la gracia (>=60) → AUTO_SIN_RESPUESTA', () => {
      assert.equal(motivoAutoCierre({ hayPersonal: true, minutosDesdeUmbral: 60 }), 'AUTO_SIN_RESPUESTA');
      assert.equal(motivoAutoCierre({ hayPersonal: true, minutosDesdeUmbral: 90 }), 'AUTO_SIN_RESPUESTA');
    });
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — operaciones de BD (TEST_PLANTA)
// ---------------------------------------------------------------------------
describe('turno-entidad · cabecera (BD, TEST_PLANTA)', () => {
  let pool;
  const P = TEST_PLANTA_ID;

  async function limpiarTurnos() {
    await pool.request().input('p', sql.VarChar(10), P).query(`
      -- NULL-ear turno_id de cualquier sesion_activa que apunte a un turno de TST antes de borrar el
      -- turno (evita violación de FK sesion_activa.turno_id → turno_unidad).
      UPDATE sa SET turno_id = NULL
        FROM bitacora.sesion_activa sa
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = sa.turno_id
       WHERE tu.planta_id = @p;
      DELETE tp FROM bitacora.turno_participante tp
        INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
       WHERE tu.planta_id = @p;
      DELETE FROM bitacora.turno_unidad WHERE planta_id = @p;
    `);
  }

  before(async () => {
    await initDB();
    pool = await getDB();
    // Sembrar TEST_PLANTA idempotentemente (FK de turno_unidad → lov_bit.planta).
    await pool.request().input('planta', sql.VarChar(10), P).query(`
      MERGE lov_bit.planta AS t USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
      WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
    `);
    await limpiarTurnos();
  });

  after(async () => {
    await limpiarTurnos();
  });

  test('abrirTurnoSiFalta crea ABIERTO cuando la unidad no tiene ninguno (ventana + inicio_real + SISTEMA)', async () => {
    await limpiarTurnos();
    const ahora = new Date('2026-04-10T15:00:00Z');
    const row = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', ahora);
    assert.equal(row.estado, 'ABIERTO');
    assert.equal(row.turno, 1);
    // T1 2026-04-10 → [06:00, 18:00) Bogotá = [11:00Z, 23:00Z)
    assert.equal(iso(row.inicio_nominal), '2026-04-10T11:00:00.000Z');
    assert.equal(iso(row.fin_nominal), '2026-04-10T23:00:00.000Z');
    assert.equal(iso(row.inicio_real), iso(ahora));
    assert.equal(row.creado_por, USUARIO_SISTEMA_ID);
    assert.equal(row.extendido, false);
    assert.equal(row.veces_extendido, 0);
  });

  test('abrirTurnoSiFalta es idempotente: 2ª llamada devuelve la misma fila sin duplicar', async () => {
    await limpiarTurnos();
    const a = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    const b = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T16:00:00Z'));
    assert.equal(a.turno_unidad_id, b.turno_unidad_id);
    const c = await pool.request().input('p', sql.VarChar(10), P).query(
      `SELECT COUNT(*) AS n FROM bitacora.turno_unidad WHERE planta_id=@p AND fecha_operativa='2026-04-10' AND turno=1`
    );
    assert.equal(c.recordset[0].n, 1);
  });

  test('abrirTurnoSiFalta crea PROGRAMADO (sin solape) si la unidad ya tiene un ABIERTO', async () => {
    await limpiarTurnos();
    const abierto = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    assert.equal(abierto.estado, 'ABIERTO');
    // Segunda ventana (T2 mismo día) mientras la T1 sigue abierta → nace PROGRAMADO.
    const prog = await abrirTurnoSiFalta(pool, P, 2, '2026-04-10', new Date('2026-04-10T15:05:00Z'));
    assert.equal(prog.estado, 'PROGRAMADO');
    assert.equal(prog.inicio_real, null);
    // T2 2026-04-10 → [18:00 día, 06:00 día+1) = [23:00Z, 11:00Z día+1)
    assert.equal(iso(prog.inicio_nominal), '2026-04-10T23:00:00.000Z');
    assert.equal(iso(prog.fin_nominal), '2026-04-11T11:00:00.000Z');
  });

  test('resolverTurnoAbierto devuelve el ABIERTO de la unidad (o null si no hay)', async () => {
    await limpiarTurnos();
    assert.equal(await resolverTurnoAbierto(pool, P), null);
    const abierto = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    const r = await resolverTurnoAbierto(pool, P);
    assert.equal(r.turno_unidad_id, abierto.turno_unidad_id);
    assert.equal(r.estado, 'ABIERTO');
  });

  test('activarSucesor no hace nada mientras haya un ABIERTO; cerrarTurno cierra y activa el PROGRAMADO', async () => {
    await limpiarTurnos();
    const A = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    const B = await abrirTurnoSiFalta(pool, P, 2, '2026-04-10', new Date('2026-04-10T15:05:00Z'));
    // Con A abierto, no se puede activar el sucesor todavía.
    assert.equal(await activarSucesor(pool, P), null);

    const cierre = new Date('2026-04-10T23:10:00Z');
    const { cerrado, sucesor } = await cerrarTurno(pool, A.turno_unidad_id, {
      motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, ahora: cierre,
    });
    assert.equal(cerrado.estado, 'CERRADO');
    assert.equal(cerrado.motivo_cierre, 'MANUAL');
    assert.equal(cerrado.cerrado_por, USUARIO_SISTEMA_ID);
    assert.equal(iso(cerrado.fin_real), iso(cierre));
    // El cierre activó el sucesor B → ahora es el ABIERTO de la unidad.
    assert.equal(sucesor.turno_unidad_id, B.turno_unidad_id);
    assert.equal(sucesor.estado, 'ABIERTO');
    assert.equal(iso(sucesor.inicio_real), iso(cierre));
    const vigente = await resolverTurnoAbierto(pool, P);
    assert.equal(vigente.turno_unidad_id, B.turno_unidad_id);
  });

  test('cerrarTurno es idempotente (2º cierre → cerrado:null) y valida motivo/cerrado_por', async () => {
    await limpiarTurnos();
    const A = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    const primero = await cerrarTurno(pool, A.turno_unidad_id, { motivo: 'AUTO_SIN_PERSONAL', cerrado_por: USUARIO_SISTEMA_ID });
    assert.equal(primero.cerrado.estado, 'CERRADO');
    const segundo = await cerrarTurno(pool, A.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID });
    assert.equal(segundo.cerrado, null);
    await assert.rejects(() => cerrarTurno(pool, A.turno_unidad_id, { motivo: 'XXX', cerrado_por: USUARIO_SISTEMA_ID }), /motivo inválido/);
    await assert.rejects(() => cerrarTurno(pool, A.turno_unidad_id, { motivo: 'MANUAL' }), /cerrado_por/);
  });

  test('extenderTurno mueve fin_nominal al próximo umbral y marca extendido/veces; sobre no-ABIERTO → null', async () => {
    await limpiarTurnos();
    const A = await abrirTurnoSiFalta(pool, P, 1, '2026-04-10', new Date('2026-04-10T15:00:00Z'));
    // Extender al llegar el umbral 18:00 (23:00Z) → nuevo fin = 06:00 día+1 = 2026-04-11T11:00:00Z
    const ext = await extenderTurno(pool, A.turno_unidad_id, { ahora: new Date('2026-04-10T23:00:00Z') });
    assert.equal(ext.extendido, true);
    assert.equal(ext.veces_extendido, 1);
    assert.equal(iso(ext.fin_nominal), '2026-04-11T11:00:00.000Z');
    // Extender de nuevo en el nuevo umbral 06:00 (11:00Z día+1) → fin = 18:00 día+1 = 23:00Z día+1
    const ext2 = await extenderTurno(pool, A.turno_unidad_id, { ahora: new Date('2026-04-11T11:00:00Z') });
    assert.equal(ext2.veces_extendido, 2);
    assert.equal(iso(ext2.fin_nominal), '2026-04-11T23:00:00.000Z');
    // Cerrar y volver a extender → null (no está ABIERTO).
    await cerrarTurno(pool, A.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID });
    assert.equal(await extenderTurno(pool, A.turno_unidad_id, { ahora: new Date('2026-04-11T11:00:00Z') }), null);
  });

  // --- D-045 E4: participación viva ---
  test('marcarParticipante crea la fila (primer_ingreso) y en el re-ingreso NO pisa primer_ingreso ni duplica', async () => {
    await limpiarTurnos();
    const cargos = (await pool.request().query(`SELECT TOP 2 cargo_id, nombre FROM lov_bit.cargo ORDER BY cargo_id`)).recordset;
    const t = await abrirTurnoSiFalta(pool, P, 1, '2026-04-12', new Date('2026-04-12T15:00:00Z'));

    const p1 = await marcarParticipante(pool, {
      turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargos[0].cargo_id, cargo_nombre: cargos[0].nombre,
    });
    assert.ok(p1.primer_ingreso, 'primer_ingreso seteado');
    assert.equal(p1.usuario_id, USUARIO_SISTEMA_ID);
    assert.equal(p1.cargo_nombre, cargos[0].nombre);
    assert.equal(p1.presencia_acumulada_min, 0);

    // Re-ingreso: cambia cargo → se refresca; primer_ingreso NO se pisa; sigue habiendo 1 sola fila.
    const p2 = await marcarParticipante(pool, {
      turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargos[1].cargo_id, cargo_nombre: cargos[1].nombre,
    });
    assert.equal(iso(p2.primer_ingreso), iso(p1.primer_ingreso), 'primer_ingreso preservado');
    assert.equal(p2.cargo_nombre, cargos[1].nombre, 'cargo refrescado');
    const n = (await pool.request().input('t', sql.Int, t.turno_unidad_id)
      .query(`SELECT COUNT(*) AS n FROM bitacora.turno_participante WHERE turno_id=@t`)).recordset[0].n;
    assert.equal(n, 1);

    // turno_id null → no-op.
    assert.equal(await marcarParticipante(pool, { turno_id: null, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargos[0].cargo_id, cargo_nombre: 'x' }), null);
  });

  test('acumularPresenciaSesiones suma [inicio_sesion, ahora) y marca ultimo_egreso; ignora sesiones inactivas', async () => {
    await limpiarTurnos();
    const cargo = (await pool.request().query(`SELECT TOP 1 cargo_id, nombre FROM lov_bit.cargo ORDER BY cargo_id`)).recordset[0];
    const t = await abrirTurnoSiFalta(pool, P, 1, '2026-04-12', new Date('2026-04-12T15:00:00Z'));
    await marcarParticipante(pool, { turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargo.cargo_id, cargo_nombre: cargo.nombre });

    // Sesión de app en TST para SISTEMA, turno=actual (no la expulsa el sweeper), inicio 10 min atrás.
    const ins = await pool.request()
      .input('u', sql.Int, USUARIO_SISTEMA_ID)
      .input('p', sql.VarChar(10), P)
      .input('c', sql.Int, cargo.cargo_id)
      .input('turno', sql.TinyInt, getTurnoColombia())
      .input('tid', sql.Int, t.turno_unidad_id)
      .query(`
        INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno, turno_id, inicio_sesion)
        OUTPUT INSERTED.sesion_id
        VALUES (@u, @p, @c, @turno, @tid, DATEADD(MINUTE, -10, SYSUTCDATETIME()))
      `);
    const sesionId = ins.recordset[0].sesion_id;
    try {
      await acumularPresenciaSesiones(pool, [sesionId]);
      let tp = (await pool.request().input('t', sql.Int, t.turno_unidad_id)
        .query(`SELECT presencia_acumulada_min, ultimo_egreso FROM bitacora.turno_participante WHERE turno_id=@t AND usuario_id=${USUARIO_SISTEMA_ID}`)).recordset[0];
      assert.ok(tp.presencia_acumulada_min >= 9 && tp.presencia_acumulada_min <= 11, `~10 min (fue ${tp.presencia_acumulada_min})`);
      assert.ok(tp.ultimo_egreso, 'ultimo_egreso seteado');

      // Sesión inactiva → no vuelve a acumular (filtro activa=1).
      await pool.request().input('s', sql.Int, sesionId).query(`UPDATE bitacora.sesion_activa SET activa=0 WHERE sesion_id=@s`);
      const antes = tp.presencia_acumulada_min;
      await acumularPresenciaSesiones(pool, [sesionId]);
      tp = (await pool.request().input('t', sql.Int, t.turno_unidad_id)
        .query(`SELECT presencia_acumulada_min FROM bitacora.turno_participante WHERE turno_id=@t AND usuario_id=${USUARIO_SISTEMA_ID}`)).recordset[0];
      assert.equal(tp.presencia_acumulada_min, antes, 'sesión inactiva no acumula');
    } finally {
      await pool.request().input('s', sql.Int, sesionId).query(`UPDATE bitacora.sesion_activa SET turno_id=NULL WHERE sesion_id=@s; DELETE FROM bitacora.sesion_activa WHERE sesion_id=@s;`);
    }
  });

  // --- D-045 E6: cierre unificado atómico (congela conformación + archiva registros + sella) ---
  test('cerrarTurno congela conformación desde turno_participante, archiva registros por turno_id y sella la cabecera', async () => {
    await limpiarTurnos();
    const fechaOp = '2026-04-13';
    // Limpiar conformación + histórico residual de TST antes de empezar (FK turno_id de F29.A2).
    await pool.request().input('p', sql.VarChar(10), P).query(`
      DELETE FROM bitacora.conformacion_turno WHERE planta_id=@p;
      DELETE FROM bitacora.registro_historico WHERE planta_id=@p;
      DELETE FROM bitacora.registro_activo WHERE planta_id=@p;
    `);

    const cargo = (await pool.request().query(`SELECT TOP 1 cargo_id, nombre FROM lov_bit.cargo ORDER BY cargo_id`)).recordset[0];
    // Una bitácora archivable (visible, no DISP/MAND) con un tipo_evento válido.
    const bit = (await pool.request().query(`
      SELECT TOP 1 b.bitacora_id, b.codigo, te.tipo_evento_id
      FROM lov_bit.bitacora b
      INNER JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
      WHERE b.oculta = 0 AND b.codigo NOT IN ('DISP','MAND')
      ORDER BY b.bitacora_id, te.tipo_evento_id
    `)).recordset[0];
    assert.ok(bit, 'existe una bitácora archivable con tipo_evento');

    const t = await abrirTurnoSiFalta(pool, P, 1, fechaOp, new Date(`${fechaOp}T15:00:00Z`));

    // Participante (SISTEMA) que ya participó y se fue: presencia acumulada + egreso marcado.
    await marcarParticipante(pool, {
      turno_id: t.turno_unidad_id, usuario_id: USUARIO_SISTEMA_ID, cargo_id: cargo.cargo_id, cargo_nombre: cargo.nombre,
    });
    await pool.request().input('t', sql.Int, t.turno_unidad_id).query(`
      UPDATE bitacora.turno_participante
        SET presencia_acumulada_min = 120, ultimo_egreso = DATEADD(MINUTE, -30, SYSUTCDATETIME())
      WHERE turno_id=@t AND usuario_id=${USUARIO_SISTEMA_ID}
    `);

    // Un registro borrador del turno, con turno_id estampado (como haría registros.js E5).
    const reg = await pool.request()
      .input('b', sql.Int, bit.bitacora_id)
      .input('p', sql.VarChar(10), P)
      .input('te', sql.Int, bit.tipo_evento_id)
      .input('u', sql.Int, USUARIO_SISTEMA_ID)
      .input('tid', sql.Int, t.turno_unidad_id)
      .query(`
        INSERT INTO bitacora.registro_activo
          (bitacora_id, planta_id, fecha_evento, turno, detalle, tipo_evento_id, estado,
           ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id)
        OUTPUT INSERTED.registro_id
        VALUES (@b, @p, SYSUTCDATETIME(), 1, 'registro de prueba D-045 E6', @te, 'borrador',
                '[]', '[]', '[]', @u, @tid)
      `);
    const registroId = reg.recordset[0].registro_id;

    try {
      const cierre = new Date(`${fechaOp}T23:10:00Z`);
      const res = await cerrarTurno(pool, t.turno_unidad_id, {
        motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID, cargo_nombre: cargo.nombre,
        ahora: cierre, incluirSinteticos: true, // SISTEMA no es sintético, pero lo forzamos por robustez del test
      });

      // Cabecera sellada.
      assert.equal(res.cerrado.estado, 'CERRADO');
      assert.equal(res.cerrado.motivo_cierre, 'MANUAL');
      assert.equal(iso(res.cerrado.fin_real), iso(cierre));

      // Conformación congelada desde turno_participante: mapea primer_ingreso→inicio_sesion,
      // ultimo_egreso→fin_sesion, presencia_acumulada_min→duracion_min, fin_inferido=0, turno_id anclado.
      assert.equal(res.conformados, 1);
      const conf = (await pool.request().input('t', sql.Int, t.turno_unidad_id)
        .query(`SELECT * FROM bitacora.conformacion_turno WHERE turno_id=@t`)).recordset;
      assert.equal(conf.length, 1);
      assert.equal(conf[0].usuario_id, USUARIO_SISTEMA_ID);
      assert.equal(conf[0].duracion_min, 120);
      assert.equal(conf[0].fin_inferido, false);
      assert.equal(conf[0].turno, 1);
      assert.equal(conf[0].planta_id, P);

      // Registro archivado por turno_id: preserva registro_id + turno_id y sale del activo.
      assert.equal(res.archivados.length, 1);
      assert.equal(res.archivados[0].bitacora_id, bit.bitacora_id);
      assert.equal(res.archivados[0].registros_cerrados, 1);
      const enActivo = (await pool.request().input('r', sql.Int, registroId)
        .query(`SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE registro_id=@r`)).recordset[0].n;
      assert.equal(enActivo, 0, 'el registro salió del activo');
      const enHist = (await pool.request().input('r', sql.Int, registroId)
        .query(`SELECT registro_id, turno_id, estado FROM bitacora.registro_historico WHERE registro_id=@r`)).recordset[0];
      assert.ok(enHist, 'el registro está en el histórico');
      assert.equal(enHist.turno_id, t.turno_unidad_id, 'turno_id preservado en el histórico');
      assert.equal(enHist.estado, 'cerrado');

      // Cierre idempotente: 2ª llamada no re-congela ni re-archiva.
      const otra = await cerrarTurno(pool, t.turno_unidad_id, { motivo: 'MANUAL', cerrado_por: USUARIO_SISTEMA_ID });
      assert.equal(otra.cerrado, null);
      assert.equal(otra.conformados, 0);
      assert.deepEqual(otra.archivados, []);
    } finally {
      await pool.request().input('p', sql.VarChar(10), P).query(`
        DELETE FROM bitacora.conformacion_turno WHERE planta_id=@p;
        DELETE FROM bitacora.registro_historico WHERE planta_id=@p;
        DELETE FROM bitacora.registro_activo WHERE planta_id=@p;
      `);
    }
  });
});
