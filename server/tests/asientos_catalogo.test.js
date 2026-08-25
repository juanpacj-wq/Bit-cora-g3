// D-058 · E1 — El motor de asientos contra el catálogo REAL. SOLO LECTURA.
//
// El motor (`utils/asientos/`) es puro y se prueba solo en `asientos.test.js`. Este archivo cubre
// lo único que un test puro NO puede cubrir: que sus enums sigan siendo un espejo del catálogo.
//
// Por qué importa: `asientoLote`/`asientoDisponibilidad` LANZAN ante un tipo o un estado
// desconocido — es deliberado (un renglón en blanco en el histórico o en el F03 es peor que un
// error), pero solo es seguro mientras las claves del módulo y los CHECK de la BD digan lo mismo.
// Si alguien agrega un quinto estado de disponibilidad o renombra un tipo de MAND, el motor
// explotaría en producción justo al guardar. Acá falla antes, y nombrando al que faltó.
// Mismo patrón de espejo-vs-catálogo que `catalogo_bitacoras.test.js` (D-052).
//
// Sin escrituras: `initDB()` (el mismo camino del arranque) + SELECTs. No siembra fixtures ni
// sesiones, así que no hay nada que limpiar ni que pueda fugarse (D-030/D-055).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB } from '../db.js';
import { PLANTILLA_DISP, PLANTILLA_LOTE } from '../utils/asientos/plantillas.js';
import { asientoLote, asientoDisponibilidad, asientoLiteralSala } from '../utils/asientos/index.js';

let db;

// Extrae los literales entre comillas simples de la definición de un CHECK. La definición que
// devuelve SQL Server viene normalizada (`([estado]='Mantenimiento' OR ...)`), así que los
// literales son el enum autoritativo.
function literalesDelCheck(definicion) {
  return [...String(definicion ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
}

async function definicionCheck(nombre) {
  const r = await db.request()
    .input('nombre', nombre)
    .query(`SELECT definition FROM sys.check_constraints WHERE name = @nombre`);
  return r.recordset[0]?.definition ?? null;
}

before(async () => {
  await initDB();
  db = await getDB();
});

test('1. los cuatro estados de PLANTILLA_DISP son EXACTAMENTE el CHECK de disponibilidad_estado', async () => {
  const def = await definicionCheck('CK_disp_estado_evento');
  assert.ok(def, 'no se encontró el CHECK CK_disp_estado_evento en la BD');
  assert.deepEqual(
    literalesDelCheck(def),
    Object.keys(PLANTILLA_DISP).sort(),
    'drift: los estados del CHECK y las claves de PLANTILLA_DISP dejaron de coincidir. '
    + 'Sincroniza utils/asientos/plantillas.js con el CHECK de db.js — el motor LANZA ante un estado desconocido.',
  );
});

test('2. los tres tipos de PLANTILLA_LOTE son EXACTAMENTE el CHECK de notificar_dashboard_tipo', async () => {
  const def = await definicionCheck('CK_te_notificar_dashboard_tipo');
  assert.ok(def, 'no se encontró el CHECK CK_te_notificar_dashboard_tipo en la BD');
  assert.deepEqual(
    literalesDelCheck(def),
    Object.keys(PLANTILLA_LOTE).sort(),
    'drift: los tipos del CHECK y las claves de PLANTILLA_LOTE dejaron de coincidir.',
  );
});

test('3. MAND cablea sus tres tipos, uno por valor, con los nombres literales del catálogo', async () => {
  const r = await db.request().query(`
    SELECT te.nombre, te.notificar_dashboard_tipo AS tipo
    FROM lov_bit.tipo_evento te
    JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo = 'MAND' AND te.notificar_dashboard_tipo IS NOT NULL
  `);
  const porTipo = Object.fromEntries(r.recordset.map((x) => [x.tipo, x.nombre]));
  // Los nombres son el insumo del seed de tipos espejo de E3 (decisión L): `Autorización` con
  // tilde y `Pruebas` en PLURAL. Si no se copian literales, el histórico termina con dos
  // etiquetas para lo mismo.
  assert.deepEqual(porTipo, { AUTH: 'Autorización', PRUEBA: 'Pruebas', REDESP: 'Redespacho' });
  assert.equal(r.recordset.length, 3, 'MAND debe tener exactamente tres tipos que notifican');
});

test('4. smoke con los lotes REALES de MAND: el motor no lanza ni produce texto vacío', async () => {
  // Reproduce la agrupación por lote de `GET /api/sala-de-mando/lotes`, sobre las DOS tablas: el
  // día en curso vive en `registro_activo` y lo cerrado en `registro_historico`. Es exactamente
  // la doble fuente que va a consultar el libro mensual (RN-06.d).
  const r = await db.request().query(`
    SELECT ra.planta_id, te.notificar_dashboard_tipo AS tipo, ra.detalle,
           TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT)    AS periodo,
           TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
           JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd,
           JSON_VALUE(ra.campos_extra, '$.lote_id')        AS lote_id
    FROM bitacora.registro_activo ra
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
    JOIN lov_bit.bitacora b     ON b.bitacora_id     = ra.bitacora_id
    WHERE b.codigo = 'MAND'
    UNION ALL
    SELECT rh.planta_id, te.notificar_dashboard_tipo AS tipo, rh.detalle,
           TRY_CAST(JSON_VALUE(rh.campos_extra, '$.periodo') AS INT)    AS periodo,
           TRY_CAST(JSON_VALUE(rh.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
           JSON_VALUE(rh.campos_extra, '$.funcionariocnd') AS funcionariocnd,
           JSON_VALUE(rh.campos_extra, '$.lote_id')        AS lote_id
    FROM bitacora.registro_historico rh
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = rh.tipo_evento_id
    JOIN lov_bit.bitacora b     ON b.bitacora_id     = rh.bitacora_id
    WHERE b.codigo = 'MAND'
  `);

  const porLote = new Map();
  for (const row of r.recordset) {
    // Sin `lote_id` no hay agrupación posible; F32.A1 le dio uno propio a cada fila migrada.
    const clave = row.lote_id ?? `sin-lote:${row.planta_id}:${row.tipo}:${row.periodo}`;
    let lote = porLote.get(clave);
    if (!lote) {
      lote = {
        tipo: row.tipo,
        planta_id: row.planta_id,
        funcionariocnd: row.funcionariocnd,
        detalle: row.detalle,
        periodos: [],
      };
      porLote.set(clave, lote);
    }
    lote.periodos.push({ periodo: row.periodo, valor_mw: row.valor_mw });
  }

  const lotes = [...porLote.values()];
  console.log(`   ℹ MAND real: ${r.recordset.length} celdas en ${lotes.length} lotes`);
  for (const lote of lotes) {
    const txt = asientoLote(lote); // si el dato real tuviera una forma inesperada, lanza acá
    assert.notEqual(txt, '', `lote sin texto: ${JSON.stringify(lote)}`);
    assert.doesNotMatch(txt, /undefined|NaN|MWh/, txt);
    assert.doesNotMatch(txt, / \.|\.\./, txt);
    assert.match(txt, /[.!?…]$/, txt);
  }
});

test('5. smoke con los estados REALES de DISP: el motor no lanza ni produce texto vacío', async () => {
  const r = await db.request().query(`
    SELECT planta_id, estado, detalle FROM bitacora.disponibilidad_estado
  `);
  console.log(`   ℹ DISP real: ${r.recordset.length} estados`);
  for (const row of r.recordset) {
    const txt = asientoDisponibilidad({ planta_id: row.planta_id, evento: row.estado, detalle: row.detalle });
    assert.notEqual(txt, '', `estado sin texto: ${JSON.stringify(row)}`);
    assert.doesNotMatch(txt, /undefined|NaN|MWh/, txt);
    assert.doesNotMatch(txt, / \.|\.\./, txt);
  }
});

test('6. smoke con los registros REALES de Sala: pasan literales y sin prefijo duplicado', async () => {
  const r = await db.request().query(`
    SELECT ra.planta_id, ra.detalle
    FROM bitacora.registro_activo ra
    JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
    WHERE b.codigo IN ('SALAJDT','SALAING')
    UNION ALL
    SELECT rh.planta_id, rh.detalle
    FROM bitacora.registro_historico rh
    JOIN lov_bit.bitacora b ON b.bitacora_id = rh.bitacora_id
    WHERE b.codigo IN ('SALAJDT','SALAING')
  `);
  console.log(`   ℹ Sala real: ${r.recordset.length} registros`);
  for (const row of r.recordset) {
    const txt = asientoLiteralSala({ planta_id: row.planta_id, texto: row.detalle });
    // El texto del ingeniero sobrevive ENTERO: literal, sin normalizar ni corregir.
    assert.ok(txt.includes(String(row.detalle ?? '').trim()), `se perdió texto del operador: ${txt}`);
    // Y nunca queda `GEC3 — GEC3 …`.
    assert.doesNotMatch(txt, /^(\S+) — \1\b/, txt);
  }
});
