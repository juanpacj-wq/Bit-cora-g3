// D-053 — GUARD permanente de coherencia `registro.bitacora_id` ↔ `tipo_evento.bitacora_id`.
//
// POR QUÉ EXISTE (el riesgo #1 del split, y de cualquier migración futura que mueva bitacora_id):
// `registro_activo.tipo_evento_id` es FK a la PK de lov_bit.tipo_evento, NO a la pareja
// (bitacora_id, tipo_evento_id). No existe FK compuesta, ni CHECK, ni trigger que ate el tipo a la
// bitácora del registro. Y NINGUNA lectura lo verifica: registros.js hace
// `INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id` (sin
// `AND te.bitacora_id = r.bitacora_id`), y la vista v_historico_busqueda joinea `b` y `te` de forma
// independiente. registro_historico ni siquiera tiene FKs (es tabla de archivo).
//
// Consecuencia: un UPDATE que mueva `bitacora_id` sin remapear `tipo_evento_id` produce filas que se
// RENDEREAN PERFECTAS (bitácora nueva + "Evento General") y solo explotan cuando alguien abre el
// editor — momento en que el dato corrupto ya viajó al histórico inmutable vía cierre de turno.
//
// Este guard es la red que no existía: barato (dos COUNT) y permanente. Si se pone rojo, alguien
// movió registros entre bitácoras sin remapear el tipo. Ver D-053 y la migración F30.A1 en db.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB } from '../db.js';

before(async () => { await initDB(); });

test('ningún registro_activo tiene un tipo_evento de OTRA bitácora', async () => {
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT TOP 20 r.registro_id, r.bitacora_id AS bit_registro, te.bitacora_id AS bit_tipo,
           b.codigo AS codigo_registro, r.planta_id
    FROM bitacora.registro_activo r
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    WHERE te.bitacora_id <> r.bitacora_id
  `);
  assert.equal(recordset.length, 0,
    'Drift tipo_evento_id ↔ bitacora_id en registro_activo. Alguien movió registros de bitácora sin ' +
    'remapear el tipo (ver F30.A1/D-053). Filas:\n' +
    recordset.map((r) => `  registro ${r.registro_id} (${r.codigo_registro}/${r.planta_id}): ` +
      `bitácora ${r.bit_registro} vs tipo de bitácora ${r.bit_tipo}`).join('\n'));
});

test('ningún registro_historico tiene un tipo_evento de OTRA bitácora', async () => {
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT TOP 20 r.registro_id, r.bitacora_id AS bit_registro, te.bitacora_id AS bit_tipo,
           b.codigo AS codigo_registro, r.planta_id
    FROM bitacora.registro_historico r
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
    WHERE te.bitacora_id <> r.bitacora_id
  `);
  assert.equal(recordset.length, 0,
    'Drift tipo_evento_id ↔ bitacora_id en registro_historico. Esta tabla es append-only (RF-032): un ' +
    'drift acá ya es permanente salvo reparación explícita. Filas:\n' +
    recordset.map((r) => `  registro ${r.registro_id} (${r.codigo_registro}/${r.planta_id}): ` +
      `bitácora ${r.bit_registro} vs tipo de bitácora ${r.bit_tipo}`).join('\n'));
});

test('meta: el guard está mirando datos reales (si no, no probaría nada)', async () => {
  const db = await getDB();
  const { recordset } = await db.request().query(`
    SELECT (SELECT COUNT(*) FROM bitacora.registro_activo)    AS activos,
           (SELECT COUNT(*) FROM bitacora.registro_historico) AS historicos
  `);
  const { activos, historicos } = recordset[0];
  assert.ok(activos + historicos > 0,
    'no hay registros en la BD: los dos tests de arriba pasarían vacíos y el guard sería decorativo');
});
