// D-053 — GUARDRAIL estático del reporte pre-flight del split de Sala de Mando.
//
// sql/snippets/reporte-split-sala-D053.sql predice, contra los datos REALES de prod, qué haría la
// migración F30.A1 antes de desplegarla — sobre todo cuántos registros quedarían SIN atribuir. Es un
// acto humano deliberado (SSMS, antes del deploy) y debe ser de SOLO LECTURA: si alguien le metiera
// DML, un "reporte" estaría reescribiendo el histórico de producción sin que nadie lo esperara.
//
// Este test NO toca la BD: escanea el CÓDIGO FUENTE y falla si (A) el reporte deja de calcular lo que
// promete, (B) deja de ser solo-lectura, o (C) algún .js del server lo referencia (auto-ejecutable).
// En la línea de guard_purga_no_auto_ejecutable (D-045) y guard_simular_umbral_no_auto_ejecutable (D-046).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));   // server/tests
const SERVER_DIR = dirname(DIR);                       // server
const REPO_DIR = dirname(SERVER_DIR);                  // raíz del subrepo
const SCRIPT = join(REPO_DIR, 'sql', 'snippets', 'reporte-split-sala-D053.sql');
const SCRIPT_BASE = 'reporte-split-sala-D053';

// Quita comentarios (bloque, línea JS `//`, línea SQL `--`) para no falsear con texto explicativo:
// la cabecera del snippet NOMBRA las tablas y los verbos que este guard prohíbe, y db.js referencia
// el snippet en un comentario (documentación legítima, no una invocación).
//
// OJO: normalizar CRLF→LF ANTES de partir es obligatorio, no cosmético. El repo se checkoutea con
// CRLF (core.autocrlf), y en regex `.` NO matchea `\r`: sobre una línea "// texto\r", el patrón
// /\/\/.*$/ no puede llegar al `$` y el comentario SOBREVIVE al strip → falso positivo. Es un bug
// latente en los guards hermanos (D-045/D-046), que no lo notan porque db.js nunca nombra sus scripts.
function stripComments(src) {
  return src
    .replace(/\r\n?/g, '\n')
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

test('el reporte existe y calcula lo que promete (escalera de atribución + no atribuibles)', () => {
  assert.ok(existsSync(SCRIPT), 'sql/snippets/reporte-split-sala-D053.sql debe existir');
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  // Los 3 escalones de la escalera, en el mismo orden que F30.A1 en db.js.
  assert.match(limpio, /bitacora\.turno_participante\b/i, 'debe consultar el escalón 1 (turno_participante)');
  assert.match(limpio, /bitacora\.conformacion_turno\b/i, 'debe consultar el escalón 2 (conformacion_turno)');
  assert.match(limpio, /HAVING\s+COUNT\(DISTINCT\s+sa\.cargo_id\)\s*=\s*1/i,
    'debe consultar el escalón 3 (sesion_activa con cargo único del autor)');
  // El número que decide el deploy.
  assert.match(limpio, /sin_atribuir/i, 'debe reportar el conteo de registros sin atribuir');
  // Las dos tablas que la migración toca.
  assert.match(limpio, /bitacora\.registro_activo\b/i, 'debe cubrir registro_activo');
  assert.match(limpio, /bitacora\.registro_historico\b/i, 'debe cubrir registro_historico');
});

test('el reporte es de SOLO LECTURA: ni un solo verbo de escritura', () => {
  const limpio = stripComments(readFileSync(SCRIPT, 'utf8'));
  // `SELECT ... INTO` también queda prohibido: materializaría una tabla en prod desde un "reporte".
  for (const verbo of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w/i,
    /\bDELETE\s+FROM\b/i,
    /\bMERGE\b/i,
    /\b(DROP|TRUNCATE|ALTER)\b/i,
    /\bSELECT\b[\s\S]*?\bINTO\s+(?!.*#)/i,
  ]) {
    assert.doesNotMatch(limpio, verbo, `el reporte debe ser solo-lectura; encontrado: ${verbo}`);
  }
});

test('el reporte NO es auto-ejecutable: ningún .js de server/ (fuera de tests/) lo referencia', () => {
  const ofensores = [];
  for (const f of serverJsFiles()) {
    if (stripComments(readFileSync(f, 'utf8')).includes(SCRIPT_BASE)) ofensores.push(basename(f));
  }
  assert.equal(ofensores.length, 0,
    `El reporte pre-flight NO debe referenciarse desde el código del server (se corre a mano en SSMS): ${ofensores.join(', ')}`);
});

test('meta: el guard encuentra el script y varios .js de server', () => {
  assert.ok(readFileSync(SCRIPT, 'utf8').length > 200, 'el script existe y no está vacío');
  assert.ok(serverJsFiles().length >= 10, 'debe escanear varios .js de server');
});
