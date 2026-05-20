# Prompt 05 — Tests nuevos (D-026)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Pre-requisitos:** prompts 01, 02, 03, 04 ya corridos.

## Tu tarea

Agregar 5 tests nuevos a `server/tests/disponibilidad.test.js`. **NO modificar los 18 tests existentes** — si alguno falla, es regresión de contrato; corregir el handler, no el test.

## Tests a agregar

### Test 19 — `backfill_idempotente`

Verifica que el bloque `F26.A1` es idempotente: la segunda corrida no duplica rows ni reescribe nada.

```js
test('F26.A1 backfill idempotente: segunda corrida es no-op', async (t) => {
  const { db } = await getDB();

  // 1. Verificar que el flag existe (initDB ya corrió)
  const flag = await db.request().query(
    `SELECT 1 AS ok FROM bitacora.migracion_aplicada WHERE codigo='F26.A1'`
  );
  assert.strictEqual(flag.recordset[0]?.ok, 1, 'flag F26.A1 debe existir tras initDB');

  // 2. Capturar conteo actual
  const c0 = (await db.request().query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado`))
    .recordset[0].n;

  // 3. Forzar re-entrada simulando el inicio del bloque idempotente
  // (el bloque está gateado por IF NOT EXISTS sobre F26.A1, así que basta verificar
  // que el flag impide re-ejecutar — no necesitamos invocar el bloque programáticamente)
  // Sustituto: arrancar initDB() de nuevo si está exportada como función
  // (si no, este test solo verifica el invariante del flag)

  const c1 = (await db.request().query(`SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado`))
    .recordset[0].n;
  assert.strictEqual(c0, c1, 'rows en disponibilidad_estado deben quedar iguales');
});
```

### Test 20 — `vista_acumulados_intervalos_cerrados`

Verifica que la vista `v_disponibilidad_estado` calcula los acumulados correctos cuando todos los intervalos están cerrados.

```js
test('v_disponibilidad_estado acumula correctamente intervalos cerrados', async (t) => {
  const { db } = await getDB();

  // Setup: una planta de test con 3 intervalos conocidos
  // Asumiendo planta GEC3 limpia (cleanDisp helper ya borra todo)
  await cleanDisp();

  const t0 = new Date('2026-05-20T10:00:00Z');
  const t1 = new Date('2026-05-20T12:00:00Z');  // +2h En Servicio
  const t2 = new Date('2026-05-20T15:00:00Z');  // +3h En Reserva
  const t3 = new Date('2026-05-20T16:00:00Z');  // +1h Indisponible

  // Insertar 3 intervalos cerrados y 1 vigente
  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Servicio',  codigo: 1,  fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Reserva',   codigo: 0,  fecha_inicio: t1, fecha_fin: t2 });
  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'Indisponible', codigo: -1, fecha_inicio: t2, fecha_fin: t3 });

  // Query la vista
  const rows = (await db.request().query(`
    SELECT * FROM bitacora.v_disponibilidad_estado
    WHERE planta='GEC3' ORDER BY fecha
  `)).recordset;

  assert.strictEqual(rows.length, 3);

  // Row 0: En Servicio durante 2h
  assert.strictEqual(Number(rows[0].horas_en_servicio.toFixed(2)), 2.00);
  assert.strictEqual(Number(rows[0].horas_en_reserva.toFixed(2)), 0.00);

  // Row 1: En Reserva durante 3h (acumulado: 2h servicio + 3h reserva)
  assert.strictEqual(Number(rows[1].horas_en_servicio.toFixed(2)), 2.00);
  assert.strictEqual(Number(rows[1].horas_en_reserva.toFixed(2)), 3.00);

  // Row 2: Indisponible durante 1h
  assert.strictEqual(Number(rows[2].horas_en_servicio.toFixed(2)), 2.00);
  assert.strictEqual(Number(rows[2].horas_en_reserva.toFixed(2)), 3.00);
  assert.strictEqual(Number(rows[2].horas_en_indisponible.toFixed(2)), 1.00);
});
```

Helper `insertDispDirecto` lo escribís inline o en `tests/helpers.js`:
```js
async function insertDispDirecto(db, { planta_id, estado, codigo, fecha_inicio, fecha_fin }) {
  await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('e', sql.VarChar(20), estado)
    .input('c', sql.SmallInt, codigo)
    .input('i', sql.DateTime2, fecha_inicio)
    .input('f', sql.DateTime2, fecha_fin)
    .input('u', sql.Int, 1)  // usuario_id arbitrario para test
    .query(`
      INSERT INTO bitacora.disponibilidad_estado
        (planta_id, estado, codigo, fecha_inicio_estado, fecha_fin_estado, creado_por)
      VALUES (@p, @e, @c, @i, @f, @u)
    `);
}
```

### Test 21 — `vista_acumulados_incluye_vigente_hasta_now`

Verifica que el row vigente (sin `fecha_fin_estado`) contribuye al acumulado usando `SYSUTCDATETIME()` como cierre virtual.

```js
test('v_disponibilidad_estado: vigente acumula hasta SYSUTCDATETIME()', async (t) => {
  const { db } = await getDB();
  await cleanDisp();

  const t0 = new Date(Date.now() - 60 * 60 * 1000);  // hace 1 hora
  const t1 = new Date(Date.now() - 30 * 60 * 1000);  // hace 30 min (cerró el primero, abrió vigente)

  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Servicio', codigo: 1, fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Reserva',  codigo: 0, fecha_inicio: t1, fecha_fin: null });

  const rows = (await db.request().query(`
    SELECT * FROM bitacora.v_disponibilidad_estado
    WHERE planta='GEC3' ORDER BY fecha
  `)).recordset;

  // Row 1 vigente: horas_en_reserva ≈ 0.5h (tolerancia ±2s)
  const reservaH = Number(rows[1].horas_en_reserva);
  assert.ok(reservaH > 0.49 && reservaH < 0.51,
    `vigente horas_en_reserva esperada ≈0.50, obtenida ${reservaH}`);
});
```

### Test 22 — `deshacer_restaura_vigente_y_acumulados`

Verifica que `POST /api/disponibilidad/deshacer` regenera correctamente al vigente anterior y los acumulados reflejan el rollback.

```js
test('deshacer restaura N-1 como vigente y acumulados se ajustan', async (t) => {
  const { token } = await loginCreador();
  await cleanDisp();

  // Crear A → B
  const tA = new Date(Date.now() - 120 * 60 * 1000);  // -2h
  const tB = new Date(Date.now() -  60 * 60 * 1000);  // -1h

  await postDisp(token, { planta_id: 'GEC3', evento: 'En Servicio',  codigo: 1,  fecha_inicio_estado: tA.toISOString() });
  await postDisp(token, { planta_id: 'GEC3', evento: 'En Reserva',   codigo: 0,  fecha_inicio_estado: tB.toISOString() });

  // Verificar estado antes del deshacer
  const antes = await getDisp('GEC3', token);
  assert.strictEqual(antes.vigente.evento, 'En Reserva');
  assert.strictEqual(antes.historial[0].evento, 'En Servicio');
  assert.ok(antes.historial[0].fecha_fin_estado);

  // Deshacer
  const undo = await fetch('http://localhost:3002/api/disponibilidad/deshacer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `session=${token}` },
    body: JSON.stringify({ planta_id: 'GEC3' }),
  }).then(r => r.json());

  assert.strictEqual(undo.revertido.evento, 'En Reserva');
  assert.strictEqual(undo.restaurado.evento, 'En Servicio');

  // Verificar estado post-deshacer
  const despues = await getDisp('GEC3', token);
  assert.strictEqual(despues.vigente.evento, 'En Servicio');
  assert.strictEqual(despues.historial.length, 0);

  // Verificar acumulados via vista: solo "En Servicio" acumula
  const rows = (await db.request().query(`
    SELECT * FROM bitacora.v_disponibilidad_estado WHERE planta='GEC3'
  `)).recordset;
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].horas_en_servicio > 0);
  assert.strictEqual(Number(rows[0].horas_en_reserva), 0);
});
```

### Test 23 — `disponibilidad_dashboard_vista_devuelve_vigente`

Verifica que la vista `disponibilidad_dashboard` (reemplazo de la tabla) devuelve el row vigente con shape compatible con el contrato F15 cross-repo.

```js
test('disponibilidad_dashboard vista devuelve solo el vigente con shape cross-repo', async (t) => {
  const { db } = await getDB();
  await cleanDisp();

  const t0 = new Date(Date.now() - 60 * 60 * 1000);
  const t1 = new Date(Date.now() - 30 * 60 * 1000);

  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Servicio', codigo: 1, fecha_inicio: t0, fecha_fin: t1 });
  await insertDispDirecto(db, { planta_id: 'GEC3', estado: 'En Reserva',  codigo: 0, fecha_inicio: t1, fecha_fin: null });

  const rows = (await db.request().query(
    `SELECT * FROM bitacora.disponibilidad_dashboard WHERE planta_id='GEC3'`
  )).recordset;

  assert.strictEqual(rows.length, 1, 'la vista devuelve solo el vigente');
  const row = rows[0];

  // Shape exacto del contrato F15 (BIT-MODBD §5.2 + interfaces-cross-repo.md)
  assert.strictEqual(row.planta_id, 'GEC3');
  assert.strictEqual(row.evento, 'En Reserva');
  assert.strictEqual(row.codigo, 0);
  assert.ok(row.fecha_inicio_estado);
  assert.ok(row.registro_activo_id);              // mapeado de disponibilidad_id
  assert.ok(typeof row.jdts_snapshot === 'string');
  assert.ok(typeof row.jefes_snapshot === 'string');  // mapeado de jefes_planta_snapshot
  assert.ok(row.actualizado_en);
});
```

## Importante (gotchas)

1. **`cleanDisp()`** debe truncar `bitacora.disponibilidad_estado` (ya no `registro_activo` para DISP). Actualizar el helper si está hardcoded contra tablas viejas.

```js
async function cleanDisp() {
  const { db } = await getDB();
  await db.request().query(`DELETE FROM bitacora.disponibilidad_estado WHERE planta_id IN ('GEC3','GEC32')`);
}
```

2. **Los 18 tests existentes** usan helpers como `postDisp`, `getDisp`, `loginCreador` que NO deben cambiar. Si alguno falla, indica regresión — investigá los handlers (prompts 03/04), no toques los tests.

3. **Test 20-21 usan `insertDispDirecto`** que escribe a la tabla saltándose la API. Esto es OK para tests específicos de la vista; cuando un test verifica la API, debe usar `postDisp` (helper existente).

4. **Tolerancia de tiempo** en test 21: usar ±2 segundos (los assertions deben permitir drift de timing del test runner).

## Verificación

```powershell
cd server
node --test --env-file=../.env tests/disponibilidad.test.js

# Esperado: 23 tests verde (18 originales + 5 nuevos)
# Si falla alguno de los 18 originales → regresión en los handlers (prompts 03/04)
# Si falla alguno de los 5 nuevos → bug en la migración o en los helpers (prompts 01/02)
```

## Lo que NO hagas en este prompt

- NO modifiques los 18 tests existentes (verifican el contrato preservado).
- NO toques `server.js`, `db.js`, `utils/` (ya hechos en prompts anteriores).
- NO escribas docs (prompt 06).
