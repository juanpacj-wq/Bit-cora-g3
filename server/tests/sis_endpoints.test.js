import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB, initDB } from '../db.js';
import { setupSessions, call, TEST_PLANTA, deactivateSyntheticSessions } from './helpers.js';

// D-061 (L02): endpoints de COMB con el valor del SIS — catálogo de la planta de test, GET con
// `valor_sis`/`sis_owned`/`es_override` + bloque `sis`, vaciar = override a 0 y POST revertir.
//
// TODO corre sobre TEST_PLANTA ('TST', D-030): la suite va contra la BD productiva y ningún test
// puede escribir en GEC3/GEC32 (D-055). Eso es justamente lo que habilita el seed de catálogo de
// este lote — sin sus 10 combustibles, 'TST' no tenía dónde colgar una celda.
//
// Cubre CA-5 (catálogo TST), CA-6 (planta válida en todos los endpoints), CA-7 (shape del GET),
// CA-8 (vaciar), CA-9 (revertir) y la cara de revertir de CA-10 (gating por matriz).

let ctx;                  // setupSessions: { sesiones, usuarios, bitByCodigo }
let sistemaId;            // usuario_id de SISTEMA (dueño de las celdas del scraper)
let catalogo;             // catálogo de TEST_PLANTA (10 filas)
let alim1, alim2, caliza; // combustible_id de la planta de test
let idGEC32;              // combustible_id de GEC32, para el caso "no pertenece a la planta"

const FECHA = '2026-04-20';   // fecha fija pasada, fuera de todo rango real de la BD

async function limpiar() {
  const db = await getDB();
  // Acotado por TEST_PLANTA en el mismo statement (regla dura D-055): jamás por fecha o tag global.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .query(`
      DELETE FROM bitacora.consumo_combustible WHERE planta_id = @tp;
      DELETE FROM bitacora.sis_scrape_log      WHERE planta_id = @tp;
    `);
}

// Siembra una celda por SQL (no por el endpoint) para poder controlar quién la creó y qué valor
// trajo el SIS — el POST siempre escribe con el usuario de la sesión y nunca toca `valor_sis`.
async function sembrarCelda({ periodo, combustible_id, cantidad, valor_sis = null, creado_por, modificado_por = null, detalle = null }) {
  const db = await getDB();
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, FECHA)
    .input('per', sql.TinyInt, periodo)
    .input('cid', sql.Int, combustible_id)
    .input('cant', sql.Decimal(12, 3), cantidad)
    .input('vs', sql.Decimal(12, 3), valor_sis)
    .input('u', sql.Int, creado_por)
    .input('m', sql.Int, modificado_por)
    .input('det', sql.NVarChar(sql.MAX), detalle)
    .query(`
      INSERT INTO bitacora.consumo_combustible
        (planta_id, fecha, periodo, combustible_id, cantidad, detalle, creado_por, modificado_por,
         modificado_en, valor_sis, sis_actualizado_en)
      VALUES (@tp, @f, @per, @cid, @cant, @det, @u, @m,
              CASE WHEN @m IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
              @vs,
              CASE WHEN @vs IS NULL THEN NULL ELSE SYSUTCDATETIME() END)
    `);
}

async function leerCelda(periodo, combustible_id, sesion_id = ctx.sesiones.jdt) {
  const { data } = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id });
  return data.celdas?.[String(periodo)]?.[String(combustible_id)];
}

before(async () => {
  ctx = await setupSessions({ planta: TEST_PLANTA });
  const db = await getDB();
  sistemaId = (await db.request()
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = 'SISTEMA'`)).recordset[0].usuario_id;

  const cat = await call('GET', `/api/combustibles/catalogo?planta_id=${TEST_PLANTA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(cat.status, 200, `el catálogo de ${TEST_PLANTA} debe existir (seed D-061): ${JSON.stringify(cat.data)}`);
  catalogo = cat.data.combustibles;
  alim1 = catalogo.find((c) => c.codigo === 'ALIM_1').combustible_id;
  alim2 = catalogo.find((c) => c.codigo === 'ALIM_2').combustible_id;
  caliza = catalogo.find((c) => c.codigo === 'CALIZA').combustible_id;

  const catG32 = await call('GET', '/api/combustibles/catalogo?planta_id=GEC32', { sesion_id: ctx.sesiones.jdt });
  idGEC32 = catG32.data.combustibles[0].combustible_id;

  await limpiar();
});

after(async () => {
  await limpiar();
  // Esta suite crea sesiones sintéticas sobre TEST_PLANTA: desactivarlas SIEMPRE para no dejarlas
  // en el panel CONECTADOS de producción (D-030/D-044).
  await deactivateSyntheticSessions();
});

// ---------------------------------------------------------------- CA-5 · catálogo TST

test('CA-5. catálogo TST: 10 combustibles espejo de GEC32, sin duplicados', async () => {
  const { status, data } = await call('GET', `/api/combustibles/catalogo?planta_id=${TEST_PLANTA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200);
  assert.equal(data.planta_id, TEST_PLANTA);
  assert.equal(data.combustibles.length, 10, 'el seed C12 son 10 filas');
  assert.deepEqual(
    data.combustibles.map((c) => c.codigo),
    ['ALIM_1', 'ALIM_2', 'ALIM_3', 'ALIM_4', 'ALIM_5', 'ALIM_6', 'ALIM_7', 'ALIM_8', 'CALIZA', 'ACPM'],
  );
  const alim = data.combustibles.find((c) => c.codigo === 'ALIM_1');
  assert.equal(alim.tipo, 'ALIMENTADOR');
  assert.equal(alim.unidad, 'Ton');
  assert.equal(Number(alim.cantidad_max), 25);
  assert.equal(alim.nombre, 'Alimentador 1');
  assert.equal(Number(data.combustibles.find((c) => c.codigo === 'CALIZA').cantidad_max), 40);
  const acpm = data.combustibles.find((c) => c.codigo === 'ACPM');
  assert.equal(acpm.unidad, 'Gal');
  assert.equal(Number(acpm.cantidad_max), 25000);
});

test('CA-5. el seed es idempotente: re-initDB no duplica ni cambia el conteo', async () => {
  const db = await getDB();
  const contar = async () => (await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .query(`SELECT COUNT(*) AS n FROM lov_bit.combustible WHERE planta_id = @tp`)).recordset[0].n;

  const antes = await contar();
  assert.equal(antes, 10);

  await initDB();

  assert.equal(await contar(), 10, 'conteo estable tras re-ejecutar initDB');

  // La UQ (planta_id, codigo) hace imposible el duplicado, pero el conteo por código lo prueba
  // sin depender de que la constraint siga ahí.
  const dups = (await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .query(`
      SELECT codigo, COUNT(*) AS n FROM lov_bit.combustible
      WHERE planta_id = @tp GROUP BY codigo HAVING COUNT(*) > 1
    `)).recordset;
  assert.equal(dups.length, 0, `códigos duplicados en ${TEST_PLANTA}: ${JSON.stringify(dups)}`);
});

// ---------------------------------------------------------------- CA-6 · planta válida

test('CA-6. planta: TST vale en los cuatro endpoints; una planta desconocida da 400 planta_invalida', async () => {
  const jdt = ctx.sesiones.jdt;

  const okCatalogo = await call('GET', `/api/combustibles/catalogo?planta_id=${TEST_PLANTA}`, { sesion_id: jdt });
  assert.equal(okCatalogo.status, 200);
  const okConsumos = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id: jdt });
  assert.equal(okConsumos.status, 200);
  const okPost = await call('POST', '/api/combustibles/consumos', {
    sesion_id: jdt, body: { planta_id: TEST_PLANTA, fecha: FECHA, celdas: [] },
  });
  assert.equal(okPost.status, 200);

  const malos = [
    ['GET', `/api/combustibles/catalogo?planta_id=XXX`, undefined],
    ['GET', `/api/combustibles/consumos?planta_id=XXX&fecha=${FECHA}`, undefined],
    ['POST', '/api/combustibles/consumos', { planta_id: 'XXX', fecha: FECHA, celdas: [] }],
    ['POST', '/api/combustibles/consumos/revertir', { planta_id: 'XXX', fecha: FECHA, periodo: 1, combustible_id: alim1 }],
  ];
  for (const [metodo, ruta, body] of malos) {
    const { status, data } = await call(metodo, ruta, { sesion_id: jdt, body });
    assert.equal(status, 400, `${metodo} ${ruta} debe rechazar la planta`);
    assert.equal(data.codigo, 'planta_invalida', `${metodo} ${ruta}: ${JSON.stringify(data)}`);
  }
});

// ---------------------------------------------------------------- CA-7 · shape del GET

test('CA-7. shape GET: celda del SIS → sis_owned, celda humana con otro valor → es_override', async () => {
  await limpiar();
  const humano = ctx.usuarios.jdt.usuario_id;

  // 1. Celda intacta del scraper: la creó SISTEMA y nadie la tocó.
  await sembrarCelda({ periodo: 1, combustible_id: alim1, cantidad: 12.5, valor_sis: 12.5, creado_por: sistemaId });
  // 2. Override humano: valor distinto del que trajo el SIS.
  await sembrarCelda({ periodo: 1, combustible_id: alim2, cantidad: 20, valor_sis: 8.25, creado_por: humano, modificado_por: humano });
  // 3. Celda humana que COINCIDE con el SIS: no es override (el valor es el mismo), pero tampoco
  //    es del SIS — el badge no debe encenderse por el solo hecho de tener dueño humano.
  await sembrarCelda({ periodo: 2, combustible_id: alim1, cantidad: 5, valor_sis: 5, creado_por: humano });
  // 4. Celda 100 % humana, sin lectura del SIS (el caso de GEC3 y de cualquier periodo sin scrape).
  await sembrarCelda({ periodo: 2, combustible_id: caliza, cantidad: 3.5, valor_sis: null, creado_por: humano });

  const { status, data } = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(status, 200);

  const delSis = data.celdas['1'][String(alim1)];
  assert.equal(delSis.valor_sis, 12.5);
  assert.equal(delSis.sis_owned, true);
  assert.equal(delSis.es_override, false);
  assert.ok(delSis.sis_actualizado_en, 'sis_actualizado_en debe venir poblado');

  const override = data.celdas['1'][String(alim2)];
  assert.equal(override.valor_sis, 8.25);
  assert.equal(override.sis_owned, false);
  assert.equal(override.es_override, true);
  assert.equal(override.cantidad, 20);

  const igual = data.celdas['2'][String(alim1)];
  assert.equal(igual.sis_owned, false);
  assert.equal(igual.es_override, false, 'mismo valor que el SIS ⇒ no hay override que mostrar');

  const sinSis = data.celdas['2'][String(caliza)];
  assert.equal(sinSis.valor_sis, null);
  assert.equal(sinSis.sis_actualizado_en, null);
  assert.equal(sinSis.sis_owned, false);
  assert.equal(sinSis.es_override, false);

  await limpiar();
});

test('CA-7. shape GET: bloque sis es null sin lectura y trae el log cuando existe', async () => {
  await limpiar();

  const vacio = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(vacio.status, 200);
  assert.equal(vacio.data.sis, null, 'sin fila en sis_scrape_log el bloque debe ser null, no un objeto vacío');

  const db = await getDB();
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA)
    .input('f', sql.Date, FECHA)
    .query(`
      INSERT INTO bitacora.sis_scrape_log
        (planta_id, fecha, scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo)
      VALUES (@tp, @f, 'horario', 23, 1, 23, 0)
    `);

  const conLog = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id: ctx.sesiones.jdt });
  assert.equal(conLog.data.sis.scrape_tipo, 'horario');
  assert.equal(conLog.data.sis.periodos_ok, 23);
  assert.equal(conLog.data.sis.periodos_error, 1);
  assert.equal(conLog.data.sis.ultimo_periodo, 23);
  assert.equal(conLog.data.sis.completo, false, 'completo ⇔ 24/24 sin errores (D-060)');
  assert.ok(conLog.data.sis.scraped_en, 'scraped_en debe venir');

  await limpiar();
});

// ---------------------------------------------------------------- CA-8 · vaciar

test('CA-8. vaciar una celda CON valor_sis la deja viva en 0 (override), no la borra', async () => {
  await limpiar();
  await sembrarCelda({ periodo: 3, combustible_id: alim1, cantidad: 12.5, valor_sis: 12.5, creado_por: sistemaId });

  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, celdas: [{ periodo: 3, combustible_id: alim1, cantidad: null }] },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.resumen.actualizados, 1, 'vaciar con valor_sis cuenta como actualización');
  assert.equal(data.resumen.eliminados, 0, 'la fila NO se borra: el próximo scrape la repondría');

  const celda = await leerCelda(3, alim1);
  assert.ok(celda, 'la celda debe seguir existiendo');
  assert.equal(celda.cantidad, 0);
  assert.equal(celda.valor_sis, 12.5, 'valor_sis se conserva como sombra para poder revertir');
  assert.equal(celda.modificado_por?.usuario_id, ctx.usuarios.jdt.usuario_id, 'el override queda atribuido al humano');
  assert.equal(celda.sis_owned, false, 'ya no es del SIS: el scrape debe respetarla');
  assert.equal(celda.es_override, true);

  await limpiar();
});

test('CA-8. vaciar una celda SIN valor_sis la borra (comportamiento histórico D-027)', async () => {
  await limpiar();
  await sembrarCelda({ periodo: 4, combustible_id: caliza, cantidad: 7, valor_sis: null, creado_por: ctx.usuarios.jdt.usuario_id });

  const { status, data } = await call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, celdas: [{ periodo: 4, combustible_id: caliza, cantidad: null }] },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.resumen.eliminados, 1);
  assert.equal(data.resumen.actualizados, 0);
  assert.equal(await leerCelda(4, caliza), undefined, 'la celda debe desaparecer del pivot');

  await limpiar();
});

test('CA-36. vaciar sin la clave detalle conserva el comentario; con la clave manda el body', async () => {
  await limpiar();
  await sembrarCelda({
    periodo: 11, combustible_id: alim1, cantidad: 12.5, valor_sis: 12.5,
    creado_por: sistemaId, detalle: 'Tolva atascada',
  });

  const vaciar = (celda) => call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, celdas: [celda] },
  });

  // 1. Lo que manda el front cuando el operador solo borra el número: `{ cantidad: null }` SIN la
  //    clave `detalle`. Tomar esa ausencia como "detalle = null" borraba en silencio la nota que
  //    explicaba por qué la celda está vacía (H9 del code-review de la O1).
  const sinClave = await vaciar({ periodo: 11, combustible_id: alim1, cantidad: null });
  assert.equal(sinClave.status, 200, JSON.stringify(sinClave.data));
  assert.equal(sinClave.data.resumen.actualizados, 1);
  const vaciada = await leerCelda(11, alim1);
  assert.equal(vaciada.cantidad, 0, 'sigue siendo el override a 0 de C6');
  assert.equal(vaciada.detalle, 'Tolva atascada', 'vaciar el número no borra la nota que lo explica');
  assert.equal(vaciada.es_override, true);

  // 2. Repetir el mismo vaciado no escribe nada: sin la clave no hay comentario que cambiar.
  const repetido = await vaciar({ periodo: 11, combustible_id: alim1, cantidad: null });
  assert.equal(repetido.data.resumen.actualizados, 0, 'un no-op no puede contar como actualización');
  assert.equal((await leerCelda(11, alim1)).detalle, 'Tolva atascada');

  // 3. Con la clave presente manda el body, como hasta ahora.
  const conTexto = await vaciar({ periodo: 11, combustible_id: alim1, cantidad: null, detalle: 'Vaciada en revisión' });
  assert.equal(conTexto.data.resumen.actualizados, 1);
  assert.equal((await leerCelda(11, alim1)).detalle, 'Vaciada en revisión');

  // 4. ...incluido el null explícito, que es como se borra un comentario a propósito.
  const conNull = await vaciar({ periodo: 11, combustible_id: alim1, cantidad: null, detalle: null });
  assert.equal(conNull.data.resumen.actualizados, 1);
  assert.equal((await leerCelda(11, alim1)).detalle, null, 'la clave en null sí borra el comentario');

  await limpiar();
});

test('CA-47. cambiar la cantidad sin la clave detalle tampoco borra el comentario (simetría con CA-36)', async () => {
  await limpiar();
  const humano = ctx.usuarios.jdt.usuario_id;
  await sembrarCelda({
    periodo: 12, combustible_id: alim1, cantidad: 10, creado_por: humano, detalle: 'Molino en mantenimiento',
  });

  const guardar = (celda) => call('POST', '/api/combustibles/consumos', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, celdas: [celda] },
  });

  // 1. Escribir un número nuevo SIN la clave `detalle`. Hasta L10 esta rama hacía `c.detalle ?? null`
  //    y borraba la nota en silencio: la MISMA ausencia significaba "conservar" al vaciar (CA-36) y
  //    "borrar" acá. Una API no puede contradecirse consigo misma en el mismo endpoint (H25).
  const sinClave = await guardar({ periodo: 12, combustible_id: alim1, cantidad: 15 });
  assert.equal(sinClave.status, 200, JSON.stringify(sinClave.data));
  assert.equal(sinClave.data.resumen.actualizados, 1);
  let celda = await leerCelda(12, alim1);
  assert.equal(Number(celda.cantidad), 15, 'la cantidad sí es la del body');
  assert.equal(celda.detalle, 'Molino en mantenimiento', 'cambiar el número no borra la nota que lo explica');

  // 2. Con la clave presente manda el body, igual que en la rama de vaciado.
  const conTexto = await guardar({ periodo: 12, combustible_id: alim1, cantidad: 16, detalle: 'Molino al 60%' });
  assert.equal(conTexto.data.resumen.actualizados, 1);
  celda = await leerCelda(12, alim1);
  assert.equal(Number(celda.cantidad), 16);
  assert.equal(celda.detalle, 'Molino al 60%');

  // 3. ...incluido el null explícito, que es como se borra un comentario a propósito.
  const conNull = await guardar({ periodo: 12, combustible_id: alim1, cantidad: 17, detalle: null });
  assert.equal(conNull.data.resumen.actualizados, 1);
  celda = await leerCelda(12, alim1);
  assert.equal(Number(celda.cantidad), 17);
  assert.equal(celda.detalle, null, 'la clave en null sí borra el comentario');

  // 4. Misma cantidad y sin la clave: no hay nada que escribir (no puede contarse como actualización).
  await guardar({ periodo: 12, combustible_id: alim1, cantidad: 18, detalle: 'Nota final' });
  const noop = await guardar({ periodo: 12, combustible_id: alim1, cantidad: 18 });
  assert.equal(noop.data.resumen.actualizados, 0, 'un no-op no puede contar como actualización');
  assert.equal((await leerCelda(12, alim1)).detalle, 'Nota final');

  await limpiar();
});

// ---------------------------------------------------------------- CA-9 · revertir

test('CA-9. revertir: restaurado devuelve la celda al valor del SIS y le devuelve la propiedad', async () => {
  await limpiar();
  const humano = ctx.usuarios.jdt.usuario_id;
  await sembrarCelda({ periodo: 5, combustible_id: alim1, cantidad: 20, valor_sis: 8.25, creado_por: humano, modificado_por: humano });

  const { status, data } = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 5, combustible_id: alim1 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.accion, 'restaurado');
  assert.equal(data.celda.cantidad, 8.25);
  assert.equal(data.celda.valor_sis, 8.25);
  assert.equal(data.celda.sis_owned, true, 'tras revertir la celda vuelve a ser del SIS');
  assert.equal(data.celda.es_override, false);
  assert.equal(data.celda.modificado_por, null);
  assert.equal(data.celda.modificado_en, null);
  assert.equal(data.celda.creado_por.usuario_id, sistemaId);

  // La celda del GET y la que devuelve revertir son la misma forma (mismo mapeo).
  const desdeGet = await leerCelda(5, alim1);
  assert.deepEqual(Object.keys(desdeGet).sort(), Object.keys(data.celda).sort());
  assert.equal(desdeGet.cantidad, 8.25);

  await limpiar();
});

test('CA-9. revertir: valor_sis = 0 elimina la celda (el SIS no reporta fila para un cero)', async () => {
  await limpiar();
  const humano = ctx.usuarios.jdt.usuario_id;
  await sembrarCelda({ periodo: 6, combustible_id: alim1, cantidad: 14, valor_sis: 0, creado_por: humano, modificado_por: humano });

  const { status, data } = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 6, combustible_id: alim1 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.accion, 'eliminado');
  assert.equal(data.celda, null);
  assert.equal(await leerCelda(6, alim1), undefined);

  await limpiar();
});

test('CA-9. revertir: una celda que ya es del SIS y coincide con su lectura no cambia nada', async () => {
  await limpiar();
  await sembrarCelda({ periodo: 7, combustible_id: alim1, cantidad: 9.75, valor_sis: 9.75, creado_por: sistemaId });
  const antes = await leerCelda(7, alim1);

  const { status, data } = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 7, combustible_id: alim1 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.accion, 'sin_cambios');
  assert.equal(data.celda.cantidad, 9.75);
  assert.equal(data.celda.sis_owned, true);

  const despues = await leerCelda(7, alim1);
  assert.equal(despues.consumo_id, antes.consumo_id, 'no se recrea la fila');
  assert.deepEqual(despues.modificado_en, antes.modificado_en, 'no se toca la auditoría');

  await limpiar();
});

test('CA-9. revertir: celda inexistente → 404 celda_no_existe', async () => {
  await limpiar();
  const { status, data } = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 8, combustible_id: alim1 },
  });
  assert.equal(status, 404);
  assert.equal(data.codigo, 'celda_no_existe');
});

test('CA-9. revertir: celda sin lectura del SIS → 400 sin_valor_sis; periodo fuera de rango → 400', async () => {
  await limpiar();
  await sembrarCelda({ periodo: 9, combustible_id: caliza, cantidad: 4, valor_sis: null, creado_por: ctx.usuarios.jdt.usuario_id });

  const sinSis = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 9, combustible_id: caliza },
  });
  assert.equal(sinSis.status, 400);
  assert.equal(sinSis.data.codigo, 'sin_valor_sis');
  assert.equal((await leerCelda(9, caliza)).cantidad, 4, 'un rechazo no puede tocar la celda');

  const periodoMalo = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 25, combustible_id: caliza },
  });
  assert.equal(periodoMalo.status, 400);
  assert.equal(periodoMalo.data.codigo, 'periodo_fuera_rango');

  const fechaMala = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: '20/04/2026', periodo: 9, combustible_id: caliza },
  });
  assert.equal(fechaMala.status, 400);
  assert.equal(fechaMala.data.codigo, 'fecha_invalida');

  await limpiar();
});

test('CA-9. revertir: un combustible de GEC32 sobre TST → 400 combustible_no_pertenece_planta', async () => {
  const { status, data } = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.jdt,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 1, combustible_id: idGEC32 },
  });
  assert.equal(status, 400);
  assert.equal(data.codigo, 'combustible_no_pertenece_planta');
});

// ---------------------------------------------------------------- CA-10 · gating

test('CA-10. revertir respeta la matriz: Ingeniero Químico lee pero no revierte (403)', async () => {
  await limpiar();
  const humano = ctx.usuarios.jdt.usuario_id;
  await sembrarCelda({ periodo: 10, combustible_id: alim1, cantidad: 18, valor_sis: 6, creado_por: humano, modificado_por: humano });

  // Ve el consumo (puede_ver = 1)...
  const get = await call('GET', `/api/combustibles/consumos?planta_id=${TEST_PLANTA}&fecha=${FECHA}`, { sesion_id: ctx.sesiones.ingQuim });
  assert.equal(get.status, 200);
  assert.equal(get.data.celdas['10'][String(alim1)].es_override, true);

  // ...pero revertir escribe, así que va por `puede_crear` igual que el batch.
  const revertir = await call('POST', '/api/combustibles/consumos/revertir', {
    sesion_id: ctx.sesiones.ingQuim,
    body: { planta_id: TEST_PLANTA, fecha: FECHA, periodo: 10, combustible_id: alim1 },
  });
  assert.equal(revertir.status, 403);

  const intacta = await leerCelda(10, alim1);
  assert.equal(intacta.cantidad, 18, 'el 403 no puede haber tocado la celda');

  await limpiar();
});
