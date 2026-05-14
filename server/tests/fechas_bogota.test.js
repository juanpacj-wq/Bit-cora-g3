// F21: tests TZ-agnósticos de los helpers Bogotá en utils/turno.js. Cubren las grietas
// que F19 cerró (T1 madrugada, T3 fecha_cerrada Bogotá) a nivel unitario — sin DB ni HTTP.
// Los helpers usan offset puro -5h con getUTC*() y NO dependen de process.env.TZ del host.
//
// T4 (2026-05-13): se agrega al final un describe integration con DB para validar el
// tiebreaker `, registro_id ASC` en el SELECT TOP 1 de cierre cronológico. No es TZ-puro,
// pero conceptualmente pertenece a la serie de regresiones cierre cronológico junto con T1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sql from 'mssql';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, PLANTA_ID, TEST_TAG } from './helpers.js';
import {
  getTurnoColombia,
  turnoFromPeriodo,
  ventanaTurno,
  periodoFromFechaBogota,
  fechaBogotaStr,
  fechaBogotaIso,
} from '../utils/turno.js';

// Fixtures que cubren bordes: medianoche Bogotá, cambios de turno (06:00 y 18:00),
// y madrugada Bogotá donde el UTC ya cruzó al día siguiente (T1).
const FIXTURES = [
  { iso: '2026-05-05T05:00:00.000Z', bogotaH: 0,  bogotaDia: '2026-05-05', periodo: 1,  turno: 2, descr: '00:00 Bogotá del día 5' },
  { iso: '2026-05-05T10:59:59.000Z', bogotaH: 5,  bogotaDia: '2026-05-05', periodo: 6,  turno: 2, descr: '05:59 Bogotá día 5 (último de turno 2 madrugada)' },
  { iso: '2026-05-05T11:00:00.000Z', bogotaH: 6,  bogotaDia: '2026-05-05', periodo: 7,  turno: 1, descr: '06:00 Bogotá día 5 (cambio a turno 1)' },
  { iso: '2026-05-05T22:30:00.000Z', bogotaH: 17, bogotaDia: '2026-05-05', periodo: 18, turno: 1, descr: '17:30 Bogotá día 5' },
  { iso: '2026-05-05T22:59:59.000Z', bogotaH: 17, bogotaDia: '2026-05-05', periodo: 18, turno: 1, descr: '17:59:59 Bogotá día 5 (último de turno 1)' },
  { iso: '2026-05-05T23:00:00.000Z', bogotaH: 18, bogotaDia: '2026-05-05', periodo: 19, turno: 2, descr: '18:00 Bogotá día 5 (cambio a turno 2)' },
  { iso: '2026-05-06T03:30:00.000Z', bogotaH: 22, bogotaDia: '2026-05-05', periodo: 23, turno: 2, descr: '22:30 Bogotá DÍA 5 (UTC ya es día 6)' },
  { iso: '2026-05-06T04:59:59.000Z', bogotaH: 23, bogotaDia: '2026-05-05', periodo: 24, turno: 2, descr: '23:59:59 Bogotá día 5 (último segundo)' },
];

describe('F21.A — helpers Bogotá (turno.js)', () => {
  describe('periodoFromFechaBogota', () => {
    for (const f of FIXTURES) {
      test(`${f.iso} → P${f.periodo} (${f.descr})`, () => {
        assert.equal(periodoFromFechaBogota(new Date(f.iso)), f.periodo);
      });
    }
  });

  describe('fechaBogotaStr (F19.C — base de campos_extra.fecha_cerrada)', () => {
    for (const f of FIXTURES) {
      test(`${f.iso} → ${f.bogotaDia} (${f.descr})`, () => {
        assert.equal(fechaBogotaStr(new Date(f.iso)), f.bogotaDia);
      });
    }

    test('acepta string ISO además de Date', () => {
      assert.equal(fechaBogotaStr('2026-05-06T04:59:59.000Z'), '2026-05-05');
    });
  });

  describe('fechaBogotaIso (F19.C — base de campos_extra.fecha_revertida)', () => {
    test('emite wallclock Bogotá con sufijo -05:00', () => {
      // 14:30 UTC = 09:30 Bogotá.
      assert.equal(fechaBogotaIso(new Date('2026-05-05T14:30:00.000Z')), '2026-05-05T09:30:00-05:00');
    });

    test('madrugada Bogotá (UTC del día siguiente) emite el día Bogotá correcto', () => {
      // 04:59:59 UTC del 6 = 23:59:59 Bogotá del 5.
      assert.equal(fechaBogotaIso(new Date('2026-05-06T04:59:59.000Z')), '2026-05-05T23:59:59-05:00');
    });

    test('medianoche Bogotá (05:00 UTC) emite 00:00 del mismo día', () => {
      assert.equal(fechaBogotaIso(new Date('2026-05-05T05:00:00.000Z')), '2026-05-05T00:00:00-05:00');
    });

    test('roundtrip con new Date(iso) preserva el instante', () => {
      const original = new Date('2026-08-15T03:45:12.000Z');
      const wallclock = fechaBogotaIso(original);
      const reparsed = new Date(wallclock);
      assert.equal(reparsed.toISOString(), original.toISOString());
    });
  });

  describe('turnoFromPeriodo cubre 1..24', () => {
    test('P1..P6 → turno 2 (00:00..05:59 Bogotá, madrugada)', () => {
      for (let p = 1; p <= 6; p++) assert.equal(turnoFromPeriodo(p), 2, `P${p}`);
    });
    test('P7..P18 → turno 1 (06:00..17:59 Bogotá, diurno)', () => {
      for (let p = 7; p <= 18; p++) assert.equal(turnoFromPeriodo(p), 1, `P${p}`);
    });
    test('P19..P24 → turno 2 (18:00..23:59 Bogotá, nocturno)', () => {
      for (let p = 19; p <= 24; p++) assert.equal(turnoFromPeriodo(p), 2, `P${p}`);
    });
  });

  describe('ventanaTurno', () => {
    test('turno 1 con fechaRef diurna → [06:00 Bogotá, 18:00 Bogotá) del mismo día', () => {
      const w = ventanaTurno(1, new Date('2026-05-05T15:00:00.000Z')); // 10:00 Bogotá
      assert.equal(w.inicio.toISOString(), '2026-05-05T11:00:00.000Z');
      assert.equal(w.fin.toISOString(),    '2026-05-05T23:00:00.000Z');
    });

    test('turno 2 con fechaRef nocturna (>=18 Bogotá) → [18:00 día N, 06:00 día N+1)', () => {
      const w = ventanaTurno(2, new Date('2026-05-06T01:00:00.000Z')); // 20:00 Bogotá día 5
      assert.equal(w.inicio.toISOString(), '2026-05-05T23:00:00.000Z'); // 18:00 Bogotá día 5
      assert.equal(w.fin.toISOString(),    '2026-05-06T11:00:00.000Z'); // 06:00 Bogotá día 6
    });

    test('turno 2 con fechaRef en madrugada (<06 Bogotá) retrocede al 18:00 del día anterior', () => {
      // 02:00 Bogotá día 5 = 07:00 UTC día 5. La ventana arrancó AYER 18:00 Bogotá (día 4).
      const w = ventanaTurno(2, new Date('2026-05-05T07:00:00.000Z'));
      assert.equal(w.inicio.toISOString(), '2026-05-04T23:00:00.000Z'); // 18:00 Bogotá día 4
      assert.equal(w.fin.toISOString(),    '2026-05-05T11:00:00.000Z'); // 06:00 Bogotá día 5
    });
  });

  describe('getTurnoColombia (depende del Date.now() — smoke)', () => {
    test('devuelve 1 ó 2', () => {
      const t = getTurnoColombia();
      assert.ok(t === 1 || t === 2, `esperado 1|2, got ${t}`);
    });
  });
});

// El TZ del host se controla con la env var TZ, pero Node solo la lee al startup. Para
// validar TZ-agnosticismo de los helpers de offset puro -5h necesitamos correr el test
// sub-process con TZ alterno y confirmar que el resultado es idéntico.
describe('F21.A — helpers TZ-agnósticos en sub-proceso (UTC, Bogotá, Tokyo, NY)', () => {
  const TZS = ['UTC', 'America/Bogota', 'Asia/Tokyo', 'America/New_York'];
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const turnoPath = path.join(__dirname, '..', 'utils', 'turno.js')
    .replaceAll('\\', '/')
    .replaceAll("'", "\\'");

  // Un solo string que importa los helpers y reporta los resultados como JSON. Lo corremos
  // con TZ distintos y assert que el output es siempre idéntico al esperado.
  const probe = `
    import('file:///${turnoPath}').then((mod) => {
      const out = {
        // 23:59:59 Bogotá del 5 (UTC ya es día 6) → debe seguir siendo "2026-05-05".
        fechaBogotaStr: mod.fechaBogotaStr(new Date('2026-05-06T04:59:59.000Z')),
        fechaBogotaIso: mod.fechaBogotaIso(new Date('2026-05-05T14:30:00.000Z')),
        periodoMadrugada: mod.periodoFromFechaBogota(new Date('2026-05-06T04:59:59.000Z')),
        ventanaT1: mod.ventanaTurno(1, new Date('2026-05-05T15:00:00.000Z')),
      };
      console.log(JSON.stringify({
        fechaBogotaStr: out.fechaBogotaStr,
        fechaBogotaIso: out.fechaBogotaIso,
        periodoMadrugada: out.periodoMadrugada,
        ventanaT1Inicio: out.ventanaT1.inicio.toISOString(),
        ventanaT1Fin:    out.ventanaT1.fin.toISOString(),
      }));
    });
  `;

  const EXPECTED = {
    fechaBogotaStr: '2026-05-05',
    fechaBogotaIso: '2026-05-05T09:30:00-05:00',
    periodoMadrugada: 24,
    ventanaT1Inicio: '2026-05-05T11:00:00.000Z',
    ventanaT1Fin:    '2026-05-05T23:00:00.000Z',
  };

  for (const tz of TZS) {
    test(`TZ=${tz} → resultados idénticos`, () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `subproceso TZ=${tz} falló: ${r.stderr}`);
      const got = JSON.parse(r.stdout.trim());
      assert.deepEqual(got, EXPECTED);
    });
  }
});

// T4 (2026-05-13) — regresión: el SELECT TOP 1 del cierre cronológico
// (server.js:1741 cierre individual y :1840 cierre masivo) ordenaba sólo por fecha_evento
// ASC. Dos registros con fecha_evento idéntica (posible en batch insert con un mismo
// SYSUTCDATETIME() o en seeds) producían orden no-determinístico en SQL Server.
// Tiebreaker aplicado: `ORDER BY fecha_evento ASC, registro_id ASC`. Este test inserta
// 3 registros CALDERA con la misma fecha_evento y verifica que el SELECT TOP 1 con el
// mismo predicado del endpoint retorna determinísticamente el de menor registro_id.
describe('T4 — tiebreaker registro_id ASC en cierre cronológico', () => {
  test('C5: SELECT TOP 1 con fecha_evento idéntica retorna el menor registro_id', async () => {
    const ctx = await setupSessions();
    const CALDERA = ctx.bitByCodigo.CALDERA;
    assert.ok(CALDERA, 'CALDERA bitacora_id debe existir');

    const db = await getDB();
    const tipoEv = (await db.request()
      .input('b', sql.Int, CALDERA)
      .query(`SELECT TOP 1 tipo_evento_id FROM lov_bit.tipo_evento WHERE bitacora_id=@b`)
    ).recordset[0].tipo_evento_id;

    // Setup: clean CALDERA tagged.
    await db.request()
      .input('b', sql.Int, CALDERA)
      .input('p', sql.VarChar(10), PLANTA_ID)
      .query(`
        DELETE FROM bitacora.registro_activo WHERE bitacora_id=@b AND planta_id=@p;
        DELETE FROM bitacora.registro_historico WHERE bitacora_id=@b AND planta_id=@p;
      `);

    const fechaEvento = new Date('2026-05-10T14:00:00Z');
    async function insertCaldera(suffix) {
      const r = await db.request()
        .input('b', sql.Int, CALDERA)
        .input('p', sql.VarChar(10), PLANTA_ID)
        .input('fe', sql.DateTime2, fechaEvento)
        .input('t', sql.TinyInt, 1)
        .input('d', sql.NVarChar(sql.MAX), `${TEST_TAG} C5-${suffix}`)
        .input('te', sql.Int, tipoEv)
        .input('cp', sql.Int, ctx.usuarios.jdt.usuario_id)
        .query(`
          INSERT INTO bitacora.registro_activo
            (bitacora_id, planta_id, fecha_evento, turno, detalle, tipo_evento_id, estado,
             ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
          OUTPUT INSERTED.registro_id
          VALUES (@b, @p, @fe, @t, @d, @te, 'borrador', '[]', '[]', '[]', @cp);
        `);
      return r.recordset[0].registro_id;
    }
    const idA = await insertCaldera('A');
    const idB = await insertCaldera('B');
    const idC = await insertCaldera('C');
    assert.ok(idA < idB && idB < idC, `IDs deben ser ASC por IDENTITY: ${idA}, ${idB}, ${idC}`);

    // Predicado idéntico al de server.js:1741 / :1840 (post-tiebreaker).
    const r = await db.request()
      .input('b', sql.Int, CALDERA)
      .input('p', sql.VarChar(10), PLANTA_ID)
      .query(`
        SELECT TOP 1 registro_id, fecha_evento, turno
        FROM bitacora.registro_activo
        WHERE bitacora_id = @b AND planta_id = @p AND estado = 'borrador'
        ORDER BY fecha_evento ASC, registro_id ASC
      `);
    assert.equal(r.recordset.length, 1);
    assert.equal(
      r.recordset[0].registro_id,
      idA,
      `Tiebreaker registro_id ASC debe retornar idA=${idA}, obtuvo ${r.recordset[0].registro_id}`
    );

    // Cleanup.
    await cleanupTestRegistros();
    await db.request()
      .input('b', sql.Int, CALDERA)
      .input('p', sql.VarChar(10), PLANTA_ID)
      .query(`
        DELETE FROM bitacora.registro_activo WHERE bitacora_id=@b AND planta_id=@p;
        DELETE FROM bitacora.registro_historico WHERE bitacora_id=@b AND planta_id=@p;
      `);
  });
});
