// D-041 — GUARDRAIL estático anti-destrucción de datos productivos.
//
// Contexto: la suite corre contra la BD PRODUCTIVA (D-030). Un test de cleanup hacía
// `DELETE FROM bitacora.disponibilidad_dashboard WHERE planta_id='GEC3'`. `disponibilidad_dashboard`
// es una VISTA actualizable de una sola tabla → el DELETE cascada a `disponibilidad_estado` y borraba
// el estado VIGENTE real de GEC3 en cada corrida ("Sin estado registrado" en el dashboard).
//
// Este test NO toca la BD: escanea el CÓDIGO FUENTE de los tests/helpers y FALLA si reaparece un
// patrón capaz de destruir datos reales. Es el candado de "blindaje frente a auditoría" a nivel CI,
// complementario al trigger INSTEAD OF que hace las vistas de solo-lectura en la BD (backstop runtime).
//
// Reglas:
//   A. Prohibido escribir (DELETE/UPDATE/INSERT/MERGE) a través de las VISTAS dashboard/reporting.
//      Son proyecciones de solo lectura; se escribe SIEMPRE en la tabla base.
//   B. Prohibido un DELETE/UPDATE sobre la tabla base `disponibilidad_estado` con un literal de
//      planta REAL ('GEC3'/'GEC32') embebido en el SQL. La limpieza DISP debe ir por TEST_PLANTA
//      (helper `cleanDispTestPlanta` o `@`-param ligado a TEST_PLANTA_ID).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// Vistas de reporte de solo lectura (nunca destino de DML).
const VISTAS_RO = ['disponibilidad_dashboard', 'autorizacion_dashboard', 'v_disponibilidad_estado'];

// Elimina comentarios (bloque, línea JS `//`, línea SQL `--`) para no falsear con texto explicativo
// —este mismo repo documenta el bug citando los nombres prohibidos—.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

// Archivos a auditar: todos los *.js del directorio tests/ salvo este guard.
function archivosAuditar() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && f !== SELF)
    .map((f) => ({ nombre: f, ruta: join(DIR, f) }));
}

const DML_VISTA = new RegExp(
  `(?:DELETE\\s+FROM|INSERT\\s+INTO|MERGE\\s+(?:INTO\\s+)?|UPDATE)\\s+(?:bitacora\\.)?(?:${VISTAS_RO.join('|')})\\b`,
  'i',
);

// DELETE/UPDATE sobre la tabla base con literal de planta real en el mismo statement (ventana corta).
const DML_ESTADO_LITERAL = /(?:DELETE\s+FROM|UPDATE)\s+(?:bitacora\.)?disponibilidad_estado\b[\s\S]{0,300}?'(?:GEC3|GEC32)'/i;

test('Regla A: ningún test/helper escribe (DELETE/UPDATE/INSERT/MERGE) a través de una vista dashboard', () => {
  const ofensores = [];
  for (const { nombre, ruta } of archivosAuditar()) {
    const limpio = stripComments(readFileSync(ruta, 'utf8'));
    if (DML_VISTA.test(limpio)) {
      ofensores.push(`${nombre}: escribe a través de una vista de solo lectura (${VISTAS_RO.join('/')}). Usa la tabla base (disponibilidad_estado / evento_dashboard).`);
    }
  }
  assert.equal(ofensores.length, 0,
    `Escritura por vista dashboard detectada (footgun D-041):\n  - ${ofensores.join('\n  - ')}`);
});

test('Regla B: ningún DELETE/UPDATE sobre disponibilidad_estado usa un literal de planta REAL (GEC3/GEC32)', () => {
  const ofensores = [];
  for (const { nombre, ruta } of archivosAuditar()) {
    const limpio = stripComments(readFileSync(ruta, 'utf8'));
    if (DML_ESTADO_LITERAL.test(limpio)) {
      ofensores.push(`${nombre}: DELETE/UPDATE de disponibilidad_estado con planta real embebida. Limpia DISP por TEST_PLANTA (cleanDispTestPlanta).`);
    }
  }
  assert.equal(ofensores.length, 0,
    `Borrado de DISP sobre planta real detectado (D-041):\n  - ${ofensores.join('\n  - ')}`);
});

test('meta: el guard efectivamente encuentra archivos que auditar', () => {
  // Defensa contra un guard "vacío" que pasa por no escanear nada (path roto, glob vacío).
  assert.ok(archivosAuditar().length >= 5, 'debe auditar varios archivos de tests');
});
