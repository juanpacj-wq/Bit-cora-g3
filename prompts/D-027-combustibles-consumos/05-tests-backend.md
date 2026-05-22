# Prompt 05 — Tests backend (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Pre-requisitos:** prompts 01–04 corridos. Endpoints funcionando.

## Tu tarea

Crear `server/tests/consumos_combustible.test.js` con 12 tests cubriendo catálogo, batch, permisos, vista, ventana de fechas y paridad con D-019 (`modificado_por`).

NO modifiques tests existentes. NO toques código de producción.

## Referencias

- Patrón de tests: `server/tests/disponibilidad.test.js` y `server/tests/sala_de_mando_batch.test.js`.
- Runner: `node:test` (no vitest). `node --test --env-file=../.env tests/...`.
- Helpers compartidos posibles en `server/tests/helpers.js`.

## Estructura del archivo

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';

// === Helpers locales ===
async function loginAsCargo(cargoNombre, plantaId = 'GEC3') {
  // POST /api/auth/login como cualquier usuario con ese cargo en esa planta.
  // Devuelve { token (cookie), usuario, sesion }
  // Mirá disponibilidad.test.js para el helper exacto que ya existe.
}

async function cleanConsumos(plantaId, fecha) {
  const { db } = await getDB();
  await db.request()
    .input('p', sql.VarChar(10), plantaId)
    .input('f', sql.Date, fecha)
    .query(`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f`);
}

async function postConsumos(token, body) {
  return fetch('http://localhost:3002/api/combustibles/consumos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': token },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

async function getCatalogo(token, plantaId) {
  return fetch(`http://localhost:3002/api/combustibles/catalogo?planta_id=${plantaId}`, {
    headers: { 'Cookie': token },
  }).then(r => r.json());
}

async function getConsumos(token, plantaId, fecha) {
  return fetch(`http://localhost:3002/api/combustibles/consumos?planta_id=${plantaId}&fecha=${fecha}`, {
    headers: { 'Cookie': token },
  }).then(r => r.json());
}

// === Tests ===

test('1. GET catalogo GEC3 devuelve 8 combustibles en orden correcto', async () => {
  const { token } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC3');
  const res = await getCatalogo(token, 'GEC3');
  assert.strictEqual(res.planta_id, 'GEC3');
  assert.strictEqual(res.combustibles.length, 8);
  const codigos = res.combustibles.map(c => c.codigo);
  assert.deepStrictEqual(codigos, ['ALIM_A','ALIM_B','ALIM_C','ALIM_D','ALIM_E','ALIM_F','CALIZA','ACPM']);
  assert.strictEqual(res.combustibles.find(c => c.codigo === 'ACPM').unidad, 'Gal');
  assert.strictEqual(res.combustibles.find(c => c.codigo === 'ALIM_A').unidad, 'Ton');
});

test('2. GET catalogo GEC32 devuelve 10 combustibles en orden correcto', async () => {
  const { token } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC32');
  const res = await getCatalogo(token, 'GEC32');
  assert.strictEqual(res.combustibles.length, 10);
  const codigos = res.combustibles.map(c => c.codigo);
  assert.deepStrictEqual(codigos, ['ALIM_1','ALIM_2','ALIM_3','ALIM_4','ALIM_5','ALIM_6','ALIM_7','ALIM_8','CALIZA','ACPM']);
});

test('3. POST batch insert + update + delete en una transacción', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await cleanConsumos('GEC3', today);
  const { token } = await loginAsCargo('Operador de Planta - Carbón y Caliza', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  const alimA = cat.combustibles[0].combustible_id;
  const alimB = cat.combustibles[1].combustible_id;

  // Insert
  let r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 12.5 },
      { periodo: 1, combustible_id: alimB, cantidad: 8.3 },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.resumen.creados, 2);

  // Update alimA + Insert alim C + Delete alimB
  const alimC = cat.combustibles[2].combustible_id;
  r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [
      { periodo: 1, combustible_id: alimA, cantidad: 15.0 },   // update
      { periodo: 1, combustible_id: alimC, cantidad: 4.7 },    // insert
      { periodo: 1, combustible_id: alimB, cantidad: null },   // delete
    ],
  });
  assert.strictEqual(r.body.resumen.creados, 1);
  assert.strictEqual(r.body.resumen.actualizados, 1);
  assert.strictEqual(r.body.resumen.eliminados, 1);

  // Verificar estado final
  const post = await getConsumos(token, 'GEC3', today);
  const fila = post.celdas['1'];
  assert.ok(fila[String(alimA)].cantidad === 15.0);
  assert.ok(fila[String(alimC)].cantidad === 4.7);
  assert.ok(!fila[String(alimB)]);
});

test('4. POST rechaza fecha futura con 400 fecha_futura', async () => {
  const { token } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  const r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: '2099-12-31',
    celdas: [{ periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: 1.0 }],
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'fecha_futura');
});

test('5. POST rechaza combustible_id que no pertenece a la planta', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { token } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC3');
  const catG32 = await getCatalogo(token, 'GEC32');
  const idGEC32 = catG32.combustibles[0].combustible_id;
  const r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: idGEC32, cantidad: 5.0 }],
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.errores.some(e => e.motivo === 'combustible_no_pertenece_planta'));
});

test('6. POST rechaza cantidad negativa', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { token } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  const r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: -3.0 }],
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.errores.some(e => e.motivo === 'cantidad_invalida'));
});

test('7. GET consumos devuelve celdas pivot correctas', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await cleanConsumos('GEC3', today);
  const { token } = await loginAsCargo('Operador de Planta - Carbón y Caliza', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [
      { periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: 10.0 },
      { periodo: 1, combustible_id: cat.combustibles[1].combustible_id, cantidad: 5.5 },
      { periodo: 2, combustible_id: cat.combustibles[0].combustible_id, cantidad: 11.0 },
    ],
  });

  const res = await getConsumos(token, 'GEC3', today);
  assert.strictEqual(res.celdas['1'][String(cat.combustibles[0].combustible_id)].cantidad, 10.0);
  assert.strictEqual(res.celdas['1'][String(cat.combustibles[1].combustible_id)].cantidad, 5.5);
  assert.strictEqual(res.celdas['2'][String(cat.combustibles[0].combustible_id)].cantidad, 11.0);
  assert.ok(!res.celdas['3']);
});

test('8. v_consumo_periodo calcula total_carbon_ton correctamente', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await cleanConsumos('GEC3', today);
  const { token } = await loginAsCargo('Operador de Planta - Carbón y Caliza', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  const alims = cat.combustibles.filter(c => c.tipo === 'ALIMENTADOR');
  const caliza = cat.combustibles.find(c => c.tipo === 'CALIZA');
  const acpm = cat.combustibles.find(c => c.tipo === 'ACPM');
  await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [
      { periodo: 1, combustible_id: alims[0].combustible_id, cantidad: 10.0 },
      { periodo: 1, combustible_id: alims[1].combustible_id, cantidad: 5.5 },
      { periodo: 1, combustible_id: alims[2].combustible_id, cantidad: 3.2 },
      { periodo: 1, combustible_id: caliza.combustible_id, cantidad: 0.8 },
      { periodo: 1, combustible_id: acpm.combustible_id, cantidad: 50.0 },
    ],
  });

  const { db } = await getDB();
  const r = (await db.request()
    .input('p', sql.VarChar(10), 'GEC3')
    .input('f', sql.Date, today)
    .query(`SELECT * FROM bitacora.v_consumo_periodo WHERE planta_id=@p AND fecha=@f AND periodo=1`)
  ).recordset[0];

  assert.ok(Math.abs(Number(r.total_carbon_ton) - 18.7) < 0.001, `total_carbon ${r.total_carbon_ton}`);
  assert.ok(Math.abs(Number(r.caliza_ton) - 0.8) < 0.001);
  assert.ok(Math.abs(Number(r.acpm_gal) - 50.0) < 0.001);
});

test('9. Permiso: Operador Carbón y Caliza puede crear', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { token } = await loginAsCargo('Operador de Planta - Carbón y Caliza', 'GEC3');
  const cat = await getCatalogo(token, 'GEC3');
  const r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 23, combustible_id: cat.combustibles[0].combustible_id, cantidad: 1.0 }],
  });
  assert.strictEqual(r.status, 200);
});

test('10. Permiso: otros cargos solo ven (POST devuelve 403)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { token } = await loginAsCargo('Ingeniero Químico', 'GEC3');

  // GET catálogo OK
  const cat = await getCatalogo(token, 'GEC3');
  assert.ok(cat.combustibles.length === 8);

  // POST 403
  const r = await postConsumos(token, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: cat.combustibles[0].combustible_id, cantidad: 1.0 }],
  });
  assert.strictEqual(r.status, 403);
});

test('11. modificado_por solo se actualiza si cantidad cambió (paridad D-019)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await cleanConsumos('GEC3', today);
  const { token: t1, usuario: u1 } = await loginAsCargo('Operador de Planta - Carbón y Caliza', 'GEC3');
  const cat = await getCatalogo(t1, 'GEC3');
  const alimA = cat.combustibles[0].combustible_id;

  // Insert por usuario 1
  await postConsumos(t1, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: alimA, cantidad: 10.0, detalle: 'inicial' }],
  });

  const { token: t2 } = await loginAsCargo('Ingeniero Jefe de Turno', 'GEC3');

  // Solo cambiar detalle (cantidad igual)
  await postConsumos(t2, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: alimA, cantidad: 10.0, detalle: 'cambio detalle' }],
  });

  const post1 = await getConsumos(t2, 'GEC3', today);
  assert.strictEqual(post1.celdas['1'][String(alimA)].modificado_por, null,
    'modificado_por debe seguir null si cantidad no cambió');

  // Ahora cambiar cantidad
  await postConsumos(t2, {
    planta_id: 'GEC3', fecha: today,
    celdas: [{ periodo: 1, combustible_id: alimA, cantidad: 12.0 }],
  });

  const post2 = await getConsumos(t2, 'GEC3', today);
  assert.ok(post2.celdas['1'][String(alimA)].modificado_por !== null,
    'modificado_por debe poblarse cuando cantidad cambia');
});

test('12. F26.B1 idempotente: segundo arranque no duplica seeds', async () => {
  const { db } = await getDB();
  // Flag debe existir
  const flag = await db.request().query(
    `SELECT 1 AS ok FROM bitacora.migracion_aplicada WHERE codigo='F26.B1'`
  );
  assert.strictEqual(flag.recordset[0]?.ok, 1, 'flag F26.B1 debe existir tras initDB');

  // Conteo de combustibles exacto
  const n = (await db.request().query(`SELECT COUNT(*) AS n FROM lov_bit.combustible`)).recordset[0].n;
  assert.strictEqual(n, 18, 'debe haber exactamente 18 combustibles (8 GEC3 + 10 GEC32)');

  // Conteo de bitácora COMB
  const nComb = (await db.request().query(`SELECT COUNT(*) AS n FROM lov_bit.bitacora WHERE codigo='COMB'`)).recordset[0].n;
  assert.strictEqual(nComb, 1, 'debe existir exactamente 1 fila COMB en lov_bit.bitacora');
});
```

## Importante (gotchas)

1. **Helper `loginAsCargo(cargoNombre, plantaId)`**: si no existe, hay que escribirlo. Mirá cómo `disponibilidad.test.js` hace login (probablemente usando un fixture user). Necesitarás un user fixture por cada cargo distinto que use el test. Si no querés crearlos, usá `personal-2026.json` para encontrar usernames existentes con esos cargos.

2. **`today`**: usá hora Bogotá para que pase aunque el test runner esté en otra TZ. Patrón: `new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' }).format(new Date())`.

3. **Cleanup**: el `cleanConsumos` borra solo la fecha del test para no chocar con consumos reales. Usá `beforeEach` o cleanup explícito por test.

4. **Tolerancia float**: `DECIMAL(12,3)` retorna como string en algunos drivers. Castear con `Number(r.cantidad)`. Tolerancia 0.001 para comparaciones.

5. **Tests 11**: para verificar `modificado_por`, podés exponerlo en el GET de consumos. Si el endpoint no lo devuelve hoy (porque el response shape lo omite), agregalo — es info de auditoría que el frontend probablemente quiera mostrar también ("Modificado por: X").

6. **Test 12 idempotencia "real"**: como el flag ya está marcado tras initDB, no podés re-ejecutar el bloque desde el test. Lo más que se puede chequear es que el conteo sea correcto y que el flag exista — esos son invariantes que sobreviven a múltiples arranques.

## Verificación

```powershell
cd server
node --test --env-file=../.env tests/consumos_combustible.test.js
# Esperado: 12 tests verde

# Suite completa para verificar que no rompimos nada:
node --test --env-file=../.env tests/
# Esperado: todos los tests previos (DISP, MAND, auth, etc.) siguen verde.
```

## Lo que NO hagas en este prompt

- NO modifiques código de producción (server.js, db.js, etc.) salvo agregar `modificado_por_nombre` al GET de consumos si te hace falta para el test 11 — y en ese caso es un cambio chico documentado.
- NO toques tests existentes.
- NO escribas docs (prompt 06).
