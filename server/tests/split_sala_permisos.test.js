// D-053 — la matriz de permisos del split de Sala de Mando.
//
// SALA era la ÚNICA bitácora del catálogo donde varios cargos compartían puede_crear (JdT + IngOp +
// Op de Sala escribían en la misma grilla). Se partió en una por rol: SALAJDT, SALAING, SALAOP.
// Este test fija la matriz objetivo contra la BD (la matriz se reconstruye en CADA arranque desde las
// CASE clauses de db.js, así que un cambio ahí aterriza acá sin migración... y una regresión también).
//
// Estático contra BD (no levanta el server, no crea sesiones): mismo estilo que rol_admin_debugging.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB } from '../db.js';

const SALAS = ['SALAJDT', 'SALAING', 'SALAOP'];

// La matriz objetivo, tal cual se acordó en D-053. [puede_ver, puede_crear] por (cargo, bitácora).
// `null` = no debe existir fila con acceso (ver=0, crear=0).
const ESPERADO = {
  'Administrador y Debugging':            { SALAJDT: [1, 1], SALAING: [1, 1], SALAOP: [1, 1] },
  'Ingeniero Jefe de Turno':              { SALAJDT: [1, 1], SALAING: [1, 0], SALAOP: [1, 0] },
  'Ingeniero de Operación':               { SALAJDT: [1, 0], SALAING: [1, 1], SALAOP: [1, 0] },
  'Ingeniero Químico':                    { SALAJDT: [1, 0], SALAING: [1, 0], SALAOP: [1, 0] },
  'Gerente de Producción':                { SALAJDT: [1, 0], SALAING: [1, 0], SALAOP: [1, 0] },
  'Operador de Planta - Sala de Mando':   { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [1, 1] },
  'Operador de Planta - Caldera':         { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Operador de Planta - Analista':        { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Operador de Planta - Planta de Agua':  { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Operador de Planta - Turbogrupo':      { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Operador Maquinaria Pesada':           { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Operador de Planta - Carbón y Caliza': { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  'Coordinador de carbón y maquinaria':   { SALAJDT: [0, 0], SALAING: [0, 0], SALAOP: [0, 0] },
  // D-059: el observador ve TODO en solo-lectura, también las tres Salas.
  'USUARIO DE CONSULTA':                  { SALAJDT: [1, 0], SALAING: [1, 0], SALAOP: [1, 0] },
};

let matriz;  // { [cargo]: { [codigo]: [ver, crear] } }

before(async () => {
  await initDB();
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT c.nombre AS cargo, b.codigo,
           CAST(ISNULL(p.puede_ver, 0)   AS INT) AS ver,
           CAST(ISNULL(p.puede_crear, 0) AS INT) AS crear
    FROM lov_bit.cargo c
    CROSS JOIN lov_bit.bitacora b
    LEFT JOIN lov_bit.cargo_bitacora_permiso p
      ON p.cargo_id = c.cargo_id AND p.bitacora_id = b.bitacora_id
    WHERE b.codigo IN ('SALAJDT','SALAING','SALAOP','DISP')
  `);
  matriz = {};
  for (const r of recordset) {
    (matriz[r.cargo] ||= {})[r.codigo] = [r.ver, r.crear];
  }
});

test('1. El catálogo tiene las 3 bitácoras de Sala y ya NO tiene la vieja SALA', async () => {
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT codigo, bitacora_id, activa, oculta FROM lov_bit.bitacora
    WHERE codigo IN ('SALA','SALAJDT','SALAING','SALAOP')
  `);
  const byCodigo = Object.fromEntries(recordset.map((r) => [r.codigo, r]));
  assert.equal(byCodigo.SALA, undefined,
    'la bitácora SALA no debe existir: se renombró a SALAJDT (UPDATE previo al MERGE). Si aparece, el ' +
    'rename se movió dentro del MERGE y quedó una fila huérfana con los registros colgando.');
  for (const cod of SALAS) {
    assert.ok(byCodigo[cod], `${cod} debe existir en el catálogo`);
    assert.equal(byCodigo[cod].activa, true, `${cod} debe estar activa`);
    assert.equal(byCodigo[cod].oculta, false, `${cod} no debe estar oculta`);
  }
});

test('2. SALAJDT conserva la identidad de SALA (misma fila renombrada, no una nueva)', async () => {
  const db = await getDB();
  // El histórico referencia bitacora_id, no el código: si SALAJDT fuera una fila NUEVA, los registros
  // viejos de Sala habrían quedado huérfanos en una bitácora inexistente/inactiva.
  const { recordset } = await db.request().query(`
    SELECT b.bitacora_id, b.orden,
           (SELECT COUNT(*) FROM lov_bit.tipo_evento te
             WHERE te.bitacora_id = b.bitacora_id AND te.nombre = 'Evento General') AS tipos
    FROM lov_bit.bitacora b WHERE b.codigo = 'SALAJDT'
  `);
  assert.equal(recordset[0].orden, 3, 'SALAJDT conserva el orden=3 que tenía SALA');
  assert.equal(recordset[0].tipos, 1, 'SALAJDT tiene exactamente un Evento General');
});

test('3. Cada bitácora de Sala tiene su propio tipo_evento (no comparten el de SALA)', async () => {
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT b.codigo, te.tipo_evento_id
    FROM lov_bit.bitacora b
    JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id AND te.nombre = 'Evento General'
    WHERE b.codigo IN ('SALAJDT','SALAING','SALAOP')
  `);
  assert.equal(recordset.length, 3, 'las 3 deben tener su Evento General');
  const ids = new Set(recordset.map((r) => r.tipo_evento_id));
  assert.equal(ids.size, 3,
    'los 3 tipo_evento_id deben ser DISTINTOS: si dos bitácoras comparten tipo, un registro migrado ' +
    'apuntaría al tipo de otra bitácora y el drift es invisible hasta que alguien lo edita');
});

test('4. La matriz de Sala es EXACTAMENTE la objetivo de D-053', () => {
  const fallos = [];
  for (const [cargo, esperadoPorCod] of Object.entries(ESPERADO)) {
    for (const cod of SALAS) {
      const [ver, crear] = esperadoPorCod[cod];
      const real = matriz[cargo]?.[cod];
      assert.ok(real, `falta la combinación ${cargo} × ${cod} en la BD`);
      if (real[0] !== ver || real[1] !== crear) {
        fallos.push(`${cargo} × ${cod}: esperado ver=${ver} crear=${crear}, real ver=${real[0]} crear=${real[1]}`);
      }
    }
  }
  assert.equal(fallos.length, 0, `La matriz divergió de D-053:\n  ${fallos.join('\n  ')}`);
});

test('5. Cada rol de Sala crea SOLO en la suya (el núcleo del split)', () => {
  const dueño = {
    SALAJDT: 'Ingeniero Jefe de Turno',
    SALAING: 'Ingeniero de Operación',
    SALAOP:  'Operador de Planta - Sala de Mando',
  };
  for (const [cod, cargoDueño] of Object.entries(dueño)) {
    // Los que pueden crear en `cod` = su dueño + el admin (acceso total por matriz, D-039). Nadie más.
    const creadores = Object.entries(matriz)
      .filter(([, porCod]) => porCod[cod]?.[1] === 1)
      .map(([cargo]) => cargo)
      .sort();
    assert.deepEqual(creadores, ['Administrador y Debugging', cargoDueño].sort(),
      `en ${cod} solo deben crear su dueño (${cargoDueño}) y el admin; encontrados: ${creadores.join(', ')}`);
  }
});

test('6. Regresión DISP: partir el IN compartido no le quitó DISP a JdT ni a IngOp', () => {
  // El IN de puede_crear era `('DISP','AUTH','SALA')` para JdT+IngOp juntos. Al partirlo en dos
  // cláusulas es fácil olvidar DISP en una. Además el override defensivo F12.A6 recomputa puede_crear
  // de TODA fila DISP: si un cargo saliera de su lista, perdería DISP en silencio al arrancar.
  for (const cargo of ['Ingeniero Jefe de Turno', 'Ingeniero de Operación', 'Administrador y Debugging']) {
    assert.deepEqual(matriz[cargo]?.DISP, [1, 1], `${cargo} debe conservar ver+crear en DISP`);
  }
  assert.deepEqual(matriz['Gerente de Producción']?.DISP, [1, 0],
    'el Gerente sigue viendo DISP sin crear');
});
