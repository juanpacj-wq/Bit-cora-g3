// D-046 — GUARDRAIL estático del script de simulación del umbral de cierre.
//
// El script sql/snippets/simular-umbral-turno-D046.sql adelanta `fin_nominal` de un turno real para
// disparar el flujo de transición/auto-cierre en una prueba manual. Debe ser un acto humano deliberado
// (SSMS, ventana coordinada), NUNCA correr solo en initDB()/CI — si el sweeper o el arranque lo invocaran
// estarían venciendo turnos de producción sin querer.
//
// Este test NO toca la BD: escanea el CÓDIGO FUENTE y FALLA si (A) el script deja de mover fin_nominal,
// (B) el script se vuelve destructivo (DELETE/DROP/TRUNCATE) o toca DISP/catálogos, o (C) algún .js del
// server lo referencia (auto-ejecutable). En la línea de guard_purga_no_auto_ejecutable.test.js (D-045).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));   // server/tests
const SERVER_DIR = dirname(DIR);                       // server
const REPO_DIR = dirname(SERVER_DIR);                  // raíz del subrepo
const SCRIPT = join(REPO_DIR, 'sql', 'snippets', 'simular-umbral-turno-D046.sql');
const SCRIPT_BASE = 'simular-umbral-turno-D046';

// Quita comentarios (bloque, línea JS `//`, línea SQL `--`) para no falsear con texto explicativo.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

// Todos los *.js bajo server/ EXCEPTO node_modules y tests/ (donde vive este mismo guard, que nombra el
// script como string para localizarlo — no es una invocación).
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

test('el script de simulación existe y realmente mueve fin_nominal de turno_unidad', () => {
  assert.ok(existsSync(SCRIPT), 'sql/snippets/simular-umbral-turno-D046.sql debe existir');
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  assert.match(limpio, /UPDATE\s+bitacora\.turno_unidad\b/i, 'debe hacer UPDATE de bitacora.turno_unidad');
  assert.match(limpio, /SET\s+fin_nominal\s*=/i, 'debe setear fin_nominal (el disparador del flujo)');
});

test('el script es NO destructivo: no borra nada ni toca DISP/catálogos', () => {
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  assert.doesNotMatch(limpio, /\bDELETE\s+FROM\b/i, 'la simulación NO debe borrar filas');
  assert.doesNotMatch(limpio, /\b(DROP|TRUNCATE)\b/i, 'la simulación NO debe DROP/TRUNCATE');
  assert.doesNotMatch(limpio, /(?:DELETE\s+FROM|TRUNCATE\s+TABLE|UPDATE)\s+(?:bitacora\.)?disponibilidad_estado\b/i,
    'la simulación NO debe tocar disponibilidad_estado (DISP)');
  assert.doesNotMatch(limpio, /(?:DELETE\s+FROM|TRUNCATE\s+TABLE|UPDATE)\s+lov_bit\./i,
    'la simulación NO debe tocar catálogos lov_bit.*');
});

test('el script NO es auto-ejecutable: ningún .js de server/ (fuera de tests/) lo referencia', () => {
  const ofensores = [];
  for (const f of serverJsFiles()) {
    if (stripComments(readFileSync(f, 'utf8')).includes(SCRIPT_BASE)) ofensores.push(basename(f));
  }
  assert.equal(ofensores.length, 0,
    `El script de simulación NO debe referenciarse desde el código del server (se corre a mano): ${ofensores.join(', ')}`);
});

test('meta: el guard encuentra el script y varios .js de server', () => {
  assert.ok(readFileSync(SCRIPT, 'utf8').length > 200, 'el script existe y no está vacío');
  assert.ok(serverJsFiles().length >= 10, 'debe escanear varios .js de server');
});
