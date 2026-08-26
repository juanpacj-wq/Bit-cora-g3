// R3: POST/PUT /api/registros rechaza días futuros con 400 `fecha_futura` (paridad con COMB,
// server/routes/combustibles.js). Solo la rama no-MAND. El rechazo ocurre ANTES de cualquier
// INSERT, así que este test NO escribe registros en la BD (D-030: la suite corre contra prod).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDB } from '../db.js';
import { setupSessions, cleanupTestRegistros, call, PLANTA_ID, TEST_TAG } from './helpers.js';

let ctx;
let BIT_ID, TIPO_ID, SESION;

const DIA = 24 * 3600 * 1000;

// Los 4 cargos que siembra setupSessions() → su clave de sesión en ctx.sesiones.
const CARGO_TO_KEY = {
  'Ingeniero Jefe de Turno': 'jdt',
  'Ingeniero de Operación': 'ingOp',
  'Gerente de Producción': 'gerente',
  'Ingeniero Químico': 'ingQuim',
};

before(async () => {
  ctx = await setupSessions();
  const db = await getDB();
  // Bitácora no-especial (no MAND/DISP/COMB) creable por ALGUNO de los cargos de test, con al menos
  // un tipo_evento — para que su sesión pase el permiso y lleguemos al guard de fecha_futura.
  const cargos = Object.keys(CARGO_TO_KEY).map((n) => `'${n}'`).join(',');
  const r = await db.request().query(`
    SELECT TOP 1 c.nombre AS cargo, b.bitacora_id, te.tipo_evento_id
    FROM lov_bit.cargo c
    JOIN lov_bit.cargo_bitacora_permiso p ON p.cargo_id = c.cargo_id AND p.puede_crear = 1
    JOIN lov_bit.bitacora b ON b.bitacora_id = p.bitacora_id
     AND b.activa = 1 AND b.codigo NOT IN ('MAND','DISP','COMB')
    JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
    WHERE c.nombre IN (${cargos})
    ORDER BY c.nombre, b.bitacora_id, te.tipo_evento_id
  `);
  assert.ok(r.recordset.length > 0, 'Debe existir una bitácora no-especial creable por algún cargo de test');
  BIT_ID = r.recordset[0].bitacora_id;
  TIPO_ID = r.recordset[0].tipo_evento_id;
  SESION = ctx.sesiones[CARGO_TO_KEY[r.recordset[0].cargo]];
  assert.ok(SESION, `Sesión de test para cargo ${r.recordset[0].cargo}`);
});

after(async () => {
  await cleanupTestRegistros();
});

test('POST /api/registros con fecha de mañana → 400 fecha_futura', async () => {
  const maniana = new Date(Date.now() + DIA);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: SESION,
    body: {
      bitacora_id: BIT_ID,
      planta_id: PLANTA_ID,
      fecha_evento: maniana.toISOString(),
      turno: 1,
      detalle: `${TEST_TAG} fecha-futura-no-debe-insertar`,
      tipo_evento_id: TIPO_ID,
    },
  });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.error, 'fecha_futura', JSON.stringify(data));
});

test('POST /api/registros con fecha de ayer → NO da fecha_futura', async () => {
  // Ayer es un día válido: el guard de fecha_futura NO debe dispararse. (Puede fallar por otras
  // validaciones de la bitácora, p.ej. funcionariocnd, pero nunca con el slug `fecha_futura`.)
  const ayer = new Date(Date.now() - DIA);
  const { status, data } = await call('POST', '/api/registros', {
    sesion_id: SESION,
    body: {
      bitacora_id: BIT_ID,
      planta_id: PLANTA_ID,
      fecha_evento: ayer.toISOString(),
      turno: 1,
      detalle: `${TEST_TAG} fecha-ayer`,
      tipo_evento_id: TIPO_ID,
    },
  });
  assert.notEqual(data.error, 'fecha_futura', `No debe ser fecha_futura (status ${status}): ${JSON.stringify(data)}`);
});
