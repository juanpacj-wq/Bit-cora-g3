import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { setupSessions, call, PLANTA_ID, TEST_TAG } from './helpers.js';

// D-027: tests del módulo Combustibles → Consumos (F26.B1).
// 12 tests cubren: catálogo (1, 2), batch CRUD (3, 7), validaciones (4, 5, 6),
// vista derivada (8), permisos (9, 10), regla D-019 paridad (11), idempotencia F26.B1 (12).

let ctx;                 // setupSessions output: { sesiones, usuarios, bitByCodigo }
let sesionOpCarbon;      // sesion_id del Operador Carbón y Caliza (cargo no cubierto por setupSessions)
const TEST_FECHA = '2026-04-15';  // fecha fija pasada, fuera del rango de fechas reales en BD

// setupSessions() solo crea 4 cargos (jdt, ingOp, gerente, ingQuim). El cargo
// "Operador de Planta - Carbón y Caliza" lo necesitamos para tests de permisos +
// usuario distinto (test 11). Helper local que crea el user + sesion sin tocar helpers.js.
async function setupOperadorCarbon() {
  const db = await getDB();
  const passwordHash = await hashPassword('1234');
  await db.request()
    .input('nombre', sql.VarChar(200), 'Test Op Carbón y Caliza')
    .input('username', sql.VarChar(50), 'test_opcarbon')
    .input('pwd', sql.VarChar(200), passwordHash)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET
        activo = 1, nombre_completo = @nombre
      WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
        VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1);
    `);
  const u = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = 'test_opcarbon'`)
  ).recordset[0];
  const c = (await db.request()
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = 'Operador de Planta - Carbón y Caliza'`)
  ).recordset[0];

  await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
  const ins = await db.request()
    .input('usuario_id', sql.Int, u.usuario_id)
    .input('planta_id', sql.VarChar(10), PLANTA_ID)
    .input('cargo_id', sql.Int, c.cargo_id)
    .input('turno', sql.TinyInt, 1)
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);
  return { sesion_id: ins.recordset[0].sesion_id, usuario_id: u.usuario_id };
}

async function cleanConsumos(planta, fecha) {
  const db = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), planta)
    .input('f', sql.Date, fecha)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f`);
}

before(async () => {
  ctx = await setupSessions();
  const op = await setupOperadorCarbon();
  sesionOpCarbon = op.sesion_id;
});

after(async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  await cleanConsumos('GEC32', TEST_FECHA);
});

test('1. GET catalogo GEC3 devuelve 8 combustibles en orden correcto', async () => {
  const { status, data } = await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200);
  assert.equal(data.planta_id, 'GEC3');
  assert.equal(data.combustibles.length, 8);
  const codigos = data.combustibles.map((c) => c.codigo);
  assert.deepEqual(codigos, ['ALIM_A','ALIM_B','ALIM_C','ALIM_D','ALIM_E','ALIM_F','CALIZA','ACPM']);
  assert.equal(data.combustibles.find((c) => c.codigo === 'ACPM').unidad, 'Gal');
  assert.equal(data.combustibles.find((c) => c.codigo === 'ALIM_A').unidad, 'Ton');
});

test('2. GET catalogo GEC32 devuelve 10 combustibles en orden correcto', async () => {
  const { status, data } = await call('GET', '/api/combustibles/catalogo?planta_id=GEC32', { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200);
  assert.equal(data.combustibles.length, 10);
  const codigos = data.combustibles.map((c) => c.codigo);
  assert.deepEqual(codigos, ['ALIM_1','ALIM_2','ALIM_3','ALIM_4','ALIM_5','ALIM_6','ALIM_7','ALIM_8','CALIZA','ACPM']);
});

test('3. POST batch insert + update + delete en una transacción', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const alimA = cat.combustibles[0].combustible_id;
  const alimB = cat.combustibles[1].combustible_id;
  const alimC = cat.combustibles[2].combustible_id;

  const r1 = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 12.5 },
      { periodo: 1, combustible_id: alimB, cantidad: 8.3 },
    ]},
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.resumen.creados, 2);

  const r2 = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 15.0 },   // update
      { periodo: 1, combustible_id: alimC, cantidad: 4.7 },    // insert
      { periodo: 1, combustible_id: alimB, cantidad: null },   // delete
    ]},
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.resumen.creados, 1);
  assert.equal(r2.data.resumen.actualizados, 1);
  assert.equal(r2.data.resumen.eliminados, 1);

  const post = (await call('GET', `/api/combustibles/consumos?planta_id=GEC3&fecha=${TEST_FECHA}`, { sesion_id: sesionOpCarbon })).data;
  const fila = post.celdas['1'];
  assert.equal(fila[String(alimA)].cantidad, 15.0);
  assert.equal(fila[String(alimC)].cantidad, 4.7);
  assert.ok(!fila[String(alimB)], 'alimB debe estar borrado');
});

test('4. POST rechaza fecha futura con 400 fecha_futura', async () => {
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: ctx.sesiones.jdt })).data;
  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: 'GEC3', fecha: '2099-12-31', celdas: [
      { periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: 1.0 },
    ]},
  });
  assert.equal(status, 400);
  assert.equal(data.error, 'fecha_futura');
});

test('5. POST rechaza combustible_id que no pertenece a la planta', async () => {
  const catG32 = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC32', { sesion_id: ctx.sesiones.jdt })).data;
  const idGEC32 = catG32.combustibles[0].combustible_id;
  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: idGEC32, cantidad: 5.0 },
    ]},
  });
  assert.equal(status, 400);
  assert.ok(Array.isArray(data.errores));
  assert.ok(data.errores.some((e) => e.motivo === 'combustible_no_pertenece_planta'),
    `esperado motivo combustible_no_pertenece_planta, recibido ${JSON.stringify(data.errores)}`);
});

test('6. POST rechaza cantidad negativa', async () => {
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: ctx.sesiones.jdt })).data;
  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: -3.0 },
    ]},
  });
  assert.equal(status, 400);
  assert.ok(data.errores?.some((e) => e.motivo === 'cantidad_invalida'),
    `esperado motivo cantidad_invalida, recibido ${JSON.stringify(data.errores)}`);
});

test('7. GET consumos devuelve celdas pivot correctas', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const idA = cat.combustibles[0].combustible_id;
  const idB = cat.combustibles[1].combustible_id;
  await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: idA, cantidad: 10.0 },
      { periodo: 1, combustible_id: idB, cantidad: 5.5 },
      { periodo: 2, combustible_id: idA, cantidad: 11.0 },
    ]},
  });

  const { data } = await call('GET', `/api/combustibles/consumos?planta_id=GEC3&fecha=${TEST_FECHA}`, { sesion_id: sesionOpCarbon });
  assert.equal(data.celdas['1'][String(idA)].cantidad, 10.0);
  assert.equal(data.celdas['1'][String(idB)].cantidad, 5.5);
  assert.equal(data.celdas['2'][String(idA)].cantidad, 11.0);
  assert.ok(!data.celdas['3'], 'periodo 3 no debe existir');
});

test('8. v_consumo_periodo calcula total_carbon_ton, caliza_ton, acpm_gal correctamente', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const alims = cat.combustibles.filter((c) => c.tipo === 'ALIMENTADOR');
  const caliza = cat.combustibles.find((c) => c.tipo === 'CALIZA');
  const acpm = cat.combustibles.find((c) => c.tipo === 'ACPM');
  await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alims[0].combustible_id, cantidad: 10.0 },
      { periodo: 1, combustible_id: alims[1].combustible_id, cantidad: 5.5 },
      { periodo: 1, combustible_id: alims[2].combustible_id, cantidad: 3.2 },
      { periodo: 1, combustible_id: caliza.combustible_id, cantidad: 0.8 },
      { periodo: 1, combustible_id: acpm.combustible_id, cantidad: 50.0 },
    ]},
  });

  const db = await getDB();
  const r = (await db.request()
    .input('p', sql.VarChar(10), 'GEC3')
    .input('f', sql.Date, TEST_FECHA)
    .query(`SELECT total_carbon_ton, caliza_ton, acpm_gal FROM bitacora.v_consumo_periodo WHERE planta_id=@p AND fecha=@f AND periodo=1`)
  ).recordset[0];

  assert.ok(Math.abs(Number(r.total_carbon_ton) - 18.7) < 0.001,
    `total_carbon esperado 18.7, recibido ${r.total_carbon_ton}`);
  assert.ok(Math.abs(Number(r.caliza_ton) - 0.8) < 0.001,
    `caliza esperado 0.8, recibido ${r.caliza_ton}`);
  assert.ok(Math.abs(Number(r.acpm_gal) - 50.0) < 0.001,
    `acpm esperado 50.0, recibido ${r.acpm_gal}`);
});

test('9. Permiso: Operador Carbón y Caliza puede crear (puede_crear=true)', async () => {
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const { status } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 23, combustible_id: cat.combustibles[0].combustible_id, cantidad: 1.0 },
    ]},
  });
  assert.equal(status, 200);
});

test('10. Permiso: Ingeniero Químico solo ve (POST devuelve 403, GET 200)', async () => {
  const cat = await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: ctx.sesiones.ingQuim });
  assert.equal(cat.status, 200);
  assert.equal(cat.data.combustibles.length, 8);

  const post = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.ingQuim,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: cat.data.combustibles[0].combustible_id, cantidad: 1.0 },
    ]},
  });
  assert.equal(post.status, 403);
});

test('11. modificado_por solo se setea si cantidad cambió (paridad D-019 con MAND)', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const alimA = cat.combustibles[0].combustible_id;

  // Insert original como Op Carbón.
  await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 10.0, detalle: `${TEST_TAG} inicial` },
    ]},
  });

  // Cambio SOLO el detalle desde otro usuario (JdT). modificado_por debe seguir null.
  await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 10.0, detalle: `${TEST_TAG} cambio detalle` },
    ]},
  });
  const sinCambio = (await call('GET', `/api/combustibles/consumos?planta_id=GEC3&fecha=${TEST_FECHA}`, { sesion_id: ctx.sesiones.jdt })).data;
  assert.equal(sinCambio.celdas['1'][String(alimA)].modificado_por, null,
    'modificado_por debe seguir null si solo cambió detalle (paridad D-019)');

  // Ahora cambio cantidad → modificado_por debe poblarse.
  await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 12.0 },
    ]},
  });
  const conCambio = (await call('GET', `/api/combustibles/consumos?planta_id=GEC3&fecha=${TEST_FECHA}`, { sesion_id: ctx.sesiones.jdt })).data;
  const mod = conCambio.celdas['1'][String(alimA)].modificado_por;
  assert.ok(mod !== null && typeof mod === 'object' && mod.usuario_id,
    `modificado_por debe ser objeto con usuario_id cuando cantidad cambia; recibido ${JSON.stringify(mod)}`);
});

test('12. F26.B1 idempotente: flag presente + 18 combustibles + 1 fila COMB', async () => {
  const db = await getDB();
  const flag = await db.request().query(
    `SELECT 1 AS ok FROM bitacora.migracion_aplicada WHERE codigo='F26.B1'`
  );
  assert.equal(flag.recordset[0]?.ok, 1, 'flag F26.B1 debe existir tras initDB');

  const flagCount = (await db.request().query(
    `SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo='F26.B1'`
  )).recordset[0].n;
  assert.equal(flagCount, 1, 'flag F26.B1 debe estar exactamente 1 vez (PK migracion_aplicada.codigo)');

  const n = (await db.request().query(`SELECT COUNT(*) AS n FROM lov_bit.combustible`)).recordset[0].n;
  assert.equal(n, 18, '18 combustibles (8 GEC3 + 10 GEC32)');

  const nComb = (await db.request().query(`SELECT COUNT(*) AS n FROM lov_bit.bitacora WHERE codigo='COMB'`)).recordset[0].n;
  assert.equal(nComb, 1, '1 fila COMB en lov_bit.bitacora');

  // Re-ejecutar initDB() no debe cambiar conteos (idempotencia del bloque F26.B1).
  const { initDB } = await import('../db.js');
  await initDB();
  const n2 = (await db.request().query(`SELECT COUNT(*) AS n FROM lov_bit.combustible`)).recordset[0].n;
  assert.equal(n2, n, 'conteo de combustibles estable tras re-initDB');
});

test('13. F28.A1: GET catalogo expone cantidad_max por tipo (25/40/25000)', async () => {
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: ctx.sesiones.jdt })).data;
  const alim = cat.combustibles.find((c) => c.tipo === 'ALIMENTADOR');
  const caliza = cat.combustibles.find((c) => c.tipo === 'CALIZA');
  const acpm = cat.combustibles.find((c) => c.tipo === 'ACPM');
  assert.equal(Number(alim.cantidad_max), 25, 'ALIMENTADOR max = 25');
  assert.equal(Number(caliza.cantidad_max), 40, 'CALIZA max = 40');
  assert.equal(Number(acpm.cantidad_max), 25000, 'ACPM max = 25000');
});

test('14. POST rechaza ALIMENTADOR > 25 (cantidad_excede_max) y acepta exactamente 25', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const alimA = cat.combustibles.find((c) => c.tipo === 'ALIMENTADOR').combustible_id;

  // 25.001 → rechazo
  const over = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 25.001 },
    ]},
  });
  assert.equal(over.status, 400);
  assert.ok(over.data.errores?.some((e) => e.motivo === 'cantidad_excede_max'),
    `esperado motivo cantidad_excede_max, recibido ${JSON.stringify(over.data.errores)}`);

  // 25 exacto → OK (boundary inclusivo)
  const ok = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 25 },
    ]},
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.resumen.creados, 1);
});

test('15. POST rechaza CALIZA > 40 y ACPM > 25000; acepta límites exactos', async () => {
  await cleanConsumos('GEC3', TEST_FECHA);
  const cat = (await call('GET', '/api/combustibles/catalogo?planta_id=GEC3', { sesion_id: sesionOpCarbon })).data;
  const caliza = cat.combustibles.find((c) => c.tipo === 'CALIZA').combustible_id;
  const acpm = cat.combustibles.find((c) => c.tipo === 'ACPM').combustible_id;

  const over = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 2, combustible_id: caliza, cantidad: 40.5 },
      { periodo: 2, combustible_id: acpm, cantidad: 25001 },
    ]},
  });
  assert.equal(over.status, 400);
  const motivos = over.data.errores.map((e) => e.motivo);
  assert.ok(motivos.every((m) => m === 'cantidad_excede_max'),
    `todos cantidad_excede_max, recibido ${JSON.stringify(over.data.errores)}`);
  assert.equal(over.data.errores.length, 2, 'una por celda fuera de rango');

  const ok = await call('POST', '/api/combustibles/consumos', {
    sesion_id: sesionOpCarbon,
    body: { planta_id: 'GEC3', fecha: TEST_FECHA, celdas: [
      { periodo: 2, combustible_id: caliza, cantidad: 40 },
      { periodo: 2, combustible_id: acpm, cantidad: 25000 },
    ]},
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.resumen.creados, 2);
});
