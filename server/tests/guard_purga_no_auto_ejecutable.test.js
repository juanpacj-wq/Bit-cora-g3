// D-045 E10 — GUARDRAIL estático del script de purga de arranque limpio.
//
// El script sql/snippets/purga-arranque-limpio-D045.sql es DESTRUCTIVO e IRREVERSIBLE (borra
// registros/histórico/conformación/evento_dashboard/turno_unidad). Debe ser un acto humano
// deliberado (SSMS, con backup + coordinación cross-repo), NUNCA correr solo en initDB()/CI.
//
// Este test NO toca la BD: escanea el CÓDIGO FUENTE y FALLA si (A) el script deja de ser destructivo,
// (B) el script toca DISP o catálogos, o (C) algún .js del server lo referencia (auto-ejecutable). En
// la línea del guardrail D-041 (guard_no_prod_disp_destruction.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));   // server/tests
const SERVER_DIR = dirname(DIR);                       // server
const REPO_DIR = dirname(SERVER_DIR);                  // raíz del subrepo
const SCRIPT = join(REPO_DIR, 'sql', 'snippets', 'purga-arranque-limpio-D045.sql');
const SCRIPT_BASE = 'purga-arranque-limpio-D045';

// Quita comentarios (bloque, línea JS `//`, línea SQL `--`) para no falsear con texto explicativo.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

// Todos los *.js bajo server/ EXCEPTO node_modules y tests/ (donde vive este mismo guard, que nombra
// el script como string para localizarlo — no es una invocación).
function serverJsFiles(dir = SERVER_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...serverJsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('el script de purga existe y es realmente destructivo (no un stub)', () => {
  assert.ok(existsSync(SCRIPT), 'sql/snippets/purga-arranque-limpio-D045.sql debe existir');
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  for (const tabla of ['evento_dashboard', 'registro_historico', 'registro_activo', 'conformacion_turno', 'turno_unidad']) {
    assert.match(limpio, new RegExp(`DELETE\\s+FROM\\s+bitacora\\.${tabla}\\b`, 'i'), `debe borrar bitacora.${tabla}`);
  }
});

test('el script NO toca disponibilidad_estado ni lov_bit (DISP + catálogos intactos)', () => {
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  assert.doesNotMatch(limpio, /(?:DELETE\s+FROM|TRUNCATE\s+TABLE|UPDATE)\s+(?:bitacora\.)?disponibilidad_estado\b/i,
    'la purga NO debe borrar/alterar disponibilidad_estado (DISP se preserva)');
  assert.doesNotMatch(limpio, /(?:DELETE\s+FROM|TRUNCATE\s+TABLE|UPDATE)\s+lov_bit\./i,
    'la purga NO debe tocar catálogos lov_bit.*');
});

test('el script NO es auto-ejecutable: ningún .js de server/ (fuera de tests/) lo referencia', () => {
  const ofensores = [];
  for (const f of serverJsFiles()) {
    if (stripComments(readFileSync(f, 'utf8')).includes(SCRIPT_BASE)) ofensores.push(basename(f));
  }
  assert.equal(ofensores.length, 0,
    `El script de purga NO debe referenciarse desde el código del server (se corre a mano): ${ofensores.join(', ')}`);
});

test('meta: el guard encuentra el script y varios .js de server', () => {
  assert.ok(readFileSync(SCRIPT, 'utf8').length > 200, 'el script existe y no está vacío');
  assert.ok(serverJsFiles().length >= 10, 'debe escanear varios .js de server');
});
