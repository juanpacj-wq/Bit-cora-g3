// D-052: el nombre VISIBLE de una bitácora vive en UN solo lugar — el seed MERGE de db.js, que
// materializa lov_bit.bitacora.nombre en cada arranque (idempotente). Todo consumidor lo deriva:
// el front por GET /api/catalogos/bitacoras, e históricos/cierre/turno por JOIN a b.nombre. La
// ÚNICA copia literal del nombre es `utils/ia/prompts.js` (debe ser puro y jamás aceptar el nombre
// del cliente, D-047) — este guard la fija contra el catálogo y falla ante el drift.
//
// Además fija que el rename es NEUTRO para permisos: la matriz de §2.6 matchea la bitácora por
// `b.codigo`, nunca por `b.nombre`, así que renombrar no puede dejar a un cargo sin su bitácora.
//
// Sin escrituras: solo initDB() (el MISMO camino que corre el server al arrancar → prueba que el
// rename viaja por el seed, sin migración manual) + SELECTs. No siembra fixtures ni sesiones.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB } from '../db.js';
import { ROL_POR_BITACORA } from '../utils/ia/prompts.js';

let catalogo; // Map codigo → { codigo, nombre, activa }

before(async () => {
  await initDB();
  const db = await getDB();
  const r = await db.request().query(`SELECT codigo, nombre, activa FROM lov_bit.bitacora`);
  catalogo = new Map(r.recordset.map((b) => [b.codigo, b]));
});

test('1. ANAL se llama "Analista" y el MERGE del seed lo reaplica en cada arranque', () => {
  const anal = catalogo.get('ANAL');
  assert.ok(anal, 'la bitácora ANAL debe existir en el catálogo');
  assert.equal(anal.nombre, 'Analista', 'D-052: el nombre visible de ANAL es "Analista"');
  assert.equal(anal.activa, true, 'ANAL debe seguir activa tras el rename');
});

test('2. ninguna bitácora conserva el nombre anterior "Análisis"', () => {
  const rastros = [...catalogo.values()].filter((b) => b.nombre === 'Análisis').map((b) => b.codigo);
  assert.deepEqual(rastros, [], `el rename D-052 dejó rastros del nombre anterior en: ${rastros}`);
});

test('3. el espejo de nombres de prompts.js (IA) no derivó del catálogo', () => {
  for (const [codigo, { nombre }] of Object.entries(ROL_POR_BITACORA)) {
    const b = catalogo.get(codigo);
    assert.ok(b, `prompts.js declara un rol para '${codigo}', que no existe en lov_bit.bitacora`);
    assert.equal(
      nombre, b.nombre,
      `drift en ${codigo}: prompts.js dice '${nombre}' y el catálogo '${b.nombre}'. ` +
      'Sincroniza el espejo de utils/ia/prompts.js con el seed de db.js.',
    );
  }
});

test('4. el rename es neutro para permisos: el Operador Analista conserva ANAL', async () => {
  const db = await getDB();
  const r = await db.request().query(`
    SELECT p.puede_ver, p.puede_crear
    FROM lov_bit.cargo_bitacora_permiso p
    JOIN lov_bit.cargo c    ON c.cargo_id    = p.cargo_id
    JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
    WHERE c.nombre = 'Operador de Planta - Analista' AND b.codigo = 'ANAL';
  `);
  assert.equal(r.recordset.length, 1, 'debe existir exactamente una fila de permiso Analista×ANAL');
  assert.equal(r.recordset[0].puede_ver, true, 'el Operador Analista debe seguir viendo ANAL');
  assert.equal(r.recordset[0].puede_crear, true, 'el Operador Analista debe seguir creando en ANAL');
});
