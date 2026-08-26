// Contrato cross-repo: GET /api/eventos-dashboard (lo consume dashboard-gen-gec3).
// Fija el SHAPE documentado en <umbrella>/docs/interfaces-cross-repo.md — si este test se rompe,
// el doc y el dashboard tienen que cambiar juntos. Es de solo lectura: no crea fixtures ni toca la BD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_PLANTA_ID } from '../db.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';

// Con DASHBOARD_API_TOKEN seteado el endpoint exige X-Dashboard-Token (AUD-18); sin él es público.
async function get(query) {
  const headers = {};
  if (process.env.DASHBOARD_API_TOKEN) headers['X-Dashboard-Token'] = process.env.DASHBOARD_API_TOKEN;
  const res = await fetch(`${BASE_URL}/api/eventos-dashboard${query}`, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

const CAMPOS_EVENTO = [
  'evento_id', 'registro_origen_id', 'planta_id', 'fecha', 'periodo',
  'valor_mw', 'tipo', 'jdts_snapshot', 'jefes_snapshot', 'activa', 'creado_en',
];
const CAMPOS_DISP = [
  'planta_id', 'evento', 'codigo', 'fecha_inicio_estado', 'jdts_snapshot', 'jefes_snapshot', 'actualizado_en',
];

test('contrato 1: sin planta_id ni fecha → 400 con {error}', async () => {
  const r = await get('');
  assert.equal(r.status, 400);
  assert.equal(typeof r.data.error, 'string');
});

test('contrato 1: la planta de test nunca se filtra al dashboard → 200 {eventos: []}', async () => {
  const r = await get(`?planta_id=${TEST_PLANTA_ID}&fecha=${hoyBogota()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { eventos: [] }, 'la llave es "eventos" (no "items") y va vacía para TST');
});

test('contrato 1: planta real + fecha → 200 {eventos: [...]} con los 11 campos documentados', async () => {
  const r = await get(`?planta_id=GEC3&fecha=${hoyBogota()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.eventos), 'la respuesta es {eventos: Array}');
  assert.deepEqual(Object.keys(r.data), ['eventos'], 'ninguna otra llave en la raíz');
  for (const ev of r.data.eventos) {
    assert.deepEqual(Object.keys(ev).sort(), [...CAMPOS_EVENTO].sort(), `campos del evento ${ev.evento_id}`);
    assert.ok(['AUTH', 'REDESP', 'PRUEBA'].includes(ev.tipo), `tipo documentado: ${ev.tipo}`);
    assert.equal(ev.activa, true, 'solo trae activa=1');
  }
});

test('contrato 1: tipo= filtra por tipo (REDESP)', async () => {
  const r = await get(`?planta_id=GEC3&fecha=${hoyBogota()}&tipo=REDESP`);
  assert.equal(r.status, 200);
  for (const ev of r.data.eventos) assert.equal(ev.tipo, 'REDESP');
});

test('contrato 2: tipo=DISP exige planta_id (400) y devuelve a lo sumo 1 fila con los 7 campos', async () => {
  const sin = await get('?tipo=DISP');
  assert.equal(sin.status, 400);
  const r = await get('?tipo=DISP&planta_id=GEC3');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.eventos));
  assert.ok(r.data.eventos.length <= 1, 'una fila por planta con el estado vigente');
  for (const d of r.data.eventos) {
    assert.deepEqual(Object.keys(d).sort(), [...CAMPOS_DISP].sort());
  }
});
