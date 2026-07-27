// D-058 (F33.A1) — los tipos de evento ESPEJO del reflejo de Operación 24h y la columna
// `seleccionable` que los mantiene fuera del alcance del teclado.
//
// POR QUÉ EXISTE: `lov_bit.tipo_evento` no tenía columna de visibilidad y
// GET /api/catalogos/bitacoras/:id/tipos-evento devolvía TODOS los tipos — ese endpoint alimenta el
// selector de tipo de GrillaRegistros. Sembrar los tipos espejo sin la columna los volvería
// tecleables a mano: el JdT vería `Autorización` como opción en SALAJDT y podría crear un asiento
// que no refleja ningún lote. Sin `origen_lote_id`, esa fila es indistinguible de un reflejo real
// para el generador del Excel e imposible de rastrear — justo la doble digitación que REQ-02 elimina.
//
// Los nombres son LITERALES de sus catálogos de origen (MAND y DISP): si divergen, el histórico
// termina con dos etiquetas para lo mismo. El test 3 fija ese espejo contra el catálogo real.
//
// Escrituras: NINGUNA sobre datos operativos. Corre initDB() (el MISMO camino del arranque, que es
// justamente lo que se prueba: el seed se reconstruye en cada arranque) + SELECTs + un GET público +
// un POST que debe ser RECHAZADO (400 antes de tocar turnos o insertar). La sesión del POST es
// sintética y va sobre TEST_PLANTA ('TST', D-030).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDB, getDB } from '../db.js';
import {
  setupSessions, call, TEST_PLANTA, TEST_TAG, deactivateSyntheticSessions,
} from './helpers.js';

const DIR = dirname(fileURLToPath(import.meta.url));

const NOMBRES_ESPEJO = ['Autorización', 'Pruebas', 'Redespacho', 'Cambio de Disponibilidad'];
const BITACORAS_ESPEJO = ['SALAJDT', 'SALAING'];

let tipos; // todas las filas de lov_bit.tipo_evento + el código de su bitácora
let ctx;

const deBitacora = (codigo) => tipos.filter((t) => t.codigo === codigo);
const espejosDe = (codigo) => deBitacora(codigo).filter((t) => NOMBRES_ESPEJO.includes(t.nombre));

async function cargarTipos() {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT te.tipo_evento_id, te.nombre, te.orden, te.seleccionable,
           te.notificar_dashboard_tipo, b.codigo
    FROM lov_bit.tipo_evento te
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
  `);
  return r.recordset;
}

before(async () => {
  await initDB();
  tipos = await cargarTipos();
  ctx = await setupSessions({ planta: TEST_PLANTA });
});

after(async () => { await deactivateSyntheticSessions(); });

test('1. las 8 filas espejo existen — 4 tipos × 2 bitácoras, con los nombres literales', () => {
  for (const codigo of BITACORAS_ESPEJO) {
    const nombres = espejosDe(codigo).map((t) => t.nombre).sort();
    assert.deepEqual(nombres, [...NOMBRES_ESPEJO].sort(),
      `${codigo} debe traer los 4 tipos espejo sembrados por F33.A1`);
  }
  assert.equal(
    BITACORAS_ESPEJO.reduce((n, c) => n + espejosDe(c).length, 0), 8,
    'deben ser exactamente 8 filas espejo (4 tipos × 2 bitácoras), sin duplicados',
  );
});

test('2. los 8 tipos espejo NO son seleccionables', () => {
  for (const codigo of BITACORAS_ESPEJO) {
    for (const t of espejosDe(codigo)) {
      assert.equal(t.seleccionable, false,
        `${codigo}/"${t.nombre}" quedó seleccionable: aparecería en el selector de tipo y se podría ` +
        'teclear un asiento que no refleja ningún lote');
    }
  }
});

test('3. anti-drift: los nombres espejo son literales de MAND y DISP', () => {
  // Si mañana alguien renombra 'Pruebas' en MAND, el espejo queda huérfano y el histórico termina
  // con dos etiquetas para lo mismo — sin este guard, en silencio.
  const enMand = deBitacora('MAND').map((t) => t.nombre);
  const enDisp = deBitacora('DISP').map((t) => t.nombre);
  for (const nombre of ['Autorización', 'Pruebas', 'Redespacho']) {
    assert.ok(enMand.includes(nombre),
      `MAND ya no tiene el tipo "${nombre}": el espejo de SALAJDT/SALAING quedó desalineado`);
  }
  assert.ok(enDisp.includes('Cambio de Disponibilidad'),
    'DISP ya no tiene "Cambio de Disponibilidad": el espejo quedó desalineado');
});

test('4. ningún tipo espejo notifica al dashboard (RN-02.a)', () => {
  // El cableado F6 de notificar_dashboard_tipo matchea por b.codigo='MAND', así que los espejo
  // nacen en NULL — pero el día que alguien amplíe ese UPDATE, el reflejo empezaría a escribir
  // evento_dashboard por su cuenta y duplicaría lo que ya publica el origen. Es barato fijarlo.
  for (const codigo of BITACORAS_ESPEJO) {
    for (const t of espejosDe(codigo)) {
      assert.equal(t.notificar_dashboard_tipo, null,
        `${codigo}/"${t.nombre}" notificaría al dashboard: la copia reflejada no publica nada, ` +
        'el origen en Operación 24h ya lo hace');
    }
  }
});

test('5. los tipos preexistentes de MAND y DISP siguen seleccionables', () => {
  for (const codigo of ['MAND', 'DISP']) {
    for (const t of deBitacora(codigo)) {
      assert.equal(t.seleccionable, true,
        `${codigo}/"${t.nombre}" perdió seleccionable=1: el DEFAULT WITH VALUES de F33.A1 debe dejar ` +
        'intactos todos los tipos que ya existían');
    }
  }
});

test('6. Evento General sigue seleccionable en las dos bitácoras de Sala', () => {
  for (const codigo of BITACORAS_ESPEJO) {
    const eg = deBitacora(codigo).find((t) => t.nombre === 'Evento General');
    assert.ok(eg, `${codigo} debe conservar su tipo 'Evento General'`);
    assert.equal(eg.seleccionable, true,
      `${codigo} se quedó sin tipo tecleable: el operador no podría registrar nada`);
  }
});

test('7. idempotencia: correr initDB() de nuevo no duplica filas ni cambia los flags', async () => {
  await initDB();
  const despues = await cargarTipos();
  assert.equal(despues.length, tipos.length,
    'un segundo arranque duplicó filas de tipo_evento: el seed no es idempotente');
  const clave = (t) => `${t.codigo}|${t.nombre}|${t.seleccionable}`;
  assert.deepEqual(despues.map(clave).sort(), tipos.map(clave).sort(),
    'un segundo arranque cambió nombres o flags de tipo_evento');
});

test('8. el selector no ofrece los tipos espejo, y sí Evento General', async () => {
  for (const codigo of BITACORAS_ESPEJO) {
    const bitacora_id = ctx.bitByCodigo[codigo];
    const { status, data } = await call('GET', `/api/catalogos/bitacoras/${bitacora_id}/tipos-evento`);
    assert.equal(status, 200, `GET tipos-evento de ${codigo} debe responder 200`);
    const nombres = data.tipos_evento.map((t) => t.nombre);
    assert.ok(nombres.includes('Evento General'),
      `${codigo} debe seguir ofreciendo 'Evento General' en el selector`);
    for (const espejo of NOMBRES_ESPEJO) {
      assert.ok(!nombres.includes(espejo),
        `el selector de ${codigo} ofrece "${espejo}": es un tipo espejo del reflejo y no se teclea`);
    }
  }
});

test('9. POST /api/registros rechaza un tipo espejo aunque se pase el id directo', async () => {
  // Esconderlo del selector no es la defensa (D-046: lo que solo bloquea el front es evadible con
  // devtools). El rechazo llega ANTES de resolver turno o insertar, así que este POST no escribe nada.
  const bitacora_id = ctx.bitByCodigo.SALAJDT;
  const espejo = espejosDe('SALAJDT').find((t) => t.nombre === 'Autorización');
  assert.ok(espejo, 'precondición: SALAJDT debe tener el tipo espejo Autorización');
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: ctx.sesiones.jdt,
    body: {
      bitacora_id,
      planta_id: TEST_PLANTA,
      fecha_evento: new Date().toISOString(),
      turno: 1,
      detalle: `${TEST_TAG} intento de asiento tecleado a mano`,
      tipo_evento_id: espejo.tipo_evento_id,
    },
  });
  assert.equal(status, 400,
    `el POST con un tipo espejo debe rechazarse; respondió ${status} ${JSON.stringify(data)}`);
});

test('10. guard estático: los dos lookups de tipo_evento de registros.js exigen seleccionable = 1', () => {
  // El POST y el PUT validan (tipo_evento_id, bitacora_id) con la misma consulta. Si una de las dos
  // pierde el filtro, el hueco vuelve por ese lado sin que ningún test funcional se ponga rojo.
  const src = readFileSync(join(DIR, '..', 'routes', 'registros.js'), 'utf8');
  const queries = [...src.matchAll(/`([^`]*lov_bit\.tipo_evento[^`]*)`/g)].map((m) => m[1]);
  const validadores = queries.filter((q) => /@te\b/.test(q) && /@b\b/.test(q));
  assert.ok(validadores.length >= 2,
    `se esperaban al menos 2 lookups (tipo_evento_id, bitacora_id) en registros.js y hay ` +
    `${validadores.length}: ¿se renombraron los parámetros? Revisa este guard antes que el código`);
  for (const q of validadores) {
    assert.match(q, /seleccionable\s*=\s*1/,
      'un lookup de tipo_evento de registros.js no filtra por seleccionable = 1:\n' + q.trim());
  }
});

test('11. guard estático: el GET de catálogos filtra por seleccionable = 1', () => {
  const src = readFileSync(join(DIR, '..', 'routes', 'catalogos.js'), 'utf8');
  const query = [...src.matchAll(/`([^`]*lov_bit\.tipo_evento[^`]*)`/g)].map((m) => m[1])[0];
  assert.ok(query, 'no se encontró la consulta de tipos-evento en routes/catalogos.js');
  assert.match(query, /seleccionable\s*=\s*1/,
    'GET /bitacoras/:id/tipos-evento dejó de filtrar por seleccionable: los tipos espejo volverían ' +
    'al selector de tipo de la grilla');
});
