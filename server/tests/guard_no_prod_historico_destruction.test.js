// D-055 — GUARDRAIL estático anti-destrucción de datos operativos productivos.
//
// Contexto: la suite corre contra la BD PRODUCTIVA (D-030). `guard_no_prod_disp_destruction`
// (D-041) blindó DISP, pero solo DISP: nada cubría `registro_historico` — la tabla que RF-032
// declara append-only e inmutable. Resultado: `sala_de_mando_batch` hacía
// `DELETE FROM bitacora.registro_historico WHERE bitacora_id=@mand AND planta_id=@p` con
// @p = PLANTA_ID = 'GEC3' (planta REAL), y `fechas_bogota` (T4/C5) lo mismo para CALDERA. Cada
// `npm test` destruía histórico inmutable real, sin fecha ni tag que lo acotara.
//
// Este test NO toca la BD: escanea el CÓDIGO FUENTE de tests/helpers y FALLA si un DELETE/UPDATE
// sobre una tabla operativa no está acotado a un FIXTURE. Es el complemento estático del blindaje
// (el otro es la migración del propio test a la planta 'TST').
//
// Regla única: todo DELETE/UPDATE/TRUNCATE sobre una TABLA_PROTEGIDA debe llevar, dentro de la
// ventana del statement, al menos un ACOTADOR de fixture. La ventana mira hacia ATRÁS además de
// hacia adelante porque en `mssql` el binding vive en los `.input(...)` que preceden al `.query(...)`:
//
//     db.request()
//       .input('p', sql.VarChar(10), TEST_PLANTA)   // ← el acotador vive acá
//       .query(`DELETE FROM bitacora.registro_historico WHERE planta_id = @p`);
//
// Por eso un alias local (`const PLANTA_ID = TEST_PLANTA`) NO satisface el guard a propósito: el
// acotador debe ser LÉXICAMENTE visible junto al DML, para que revisar el diff baste para saber
// que el borrado no puede tocar una planta real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// Tablas cuyo borrado indiscriminado destruye operación real. `registro_historico` encabeza la
// lista: es el libro inmutable (RF-032) y nada, ni un test, debería borrarlo sin acotar.
const TABLAS_PROTEGIDAS = [
  'registro_historico',
  'registro_activo',
  'evento_dashboard',
  'mand_cierre_log',
];

// Marcadores que prueban que el statement está acotado a datos de test. Basta uno.
//  - TEST_PLANTA / TEST_PLANTA_ID / 'TST' → planta-fixture (D-030)
//  - TEST_TAG / @tag                      → tag único por corrida
//  - es_sintetico                         → fixtures de usuario (D-044)
//  - test_%                               → usernames sintéticos
const ACOTADORES = [
  /\bTEST_PLANTA(_ID)?\b/,
  /'TST'/,
  /\bTEST_TAG\b/,
  /@tag\b/,
  /\bes_sintetico\b/,
  /'test_%'/,
  // Statement acotado a UNA fila por su PK (`WHERE evento_id = @id`): no puede vaciar una tabla,
  // y en un test esa fila es la que el propio test insertó.
  /\b(registro_id|evento_id|disponibilidad_id|turno_unidad_id)\s*=\s*@/,
];

// Alias locales de la planta-fixture (`const P = TEST_PLANTA_ID`) son acotadores válidos: el
// binding es verificable estáticamente en el mismo archivo. Lo que NO califica es un alias a una
// planta real (`const PLANTA_ID = 'GEC3'`) — que es justamente el patrón que produjo D-055.
function aliasesDeFixture(src) {
  const out = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*TEST_PLANTA(?:_ID)?\s*[;,\n]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(new RegExp(`\\b${m[1]}\\b`));
  return out;
}

// `\r?\n` (no `\n`) a propósito: el repo es CRLF y el `.` de una regex JS no matchea `\r`, así que
// partir por `\n` deja un `\r` que impide a `//.*$` alcanzar el `$` → strip inerte. Ver D-055.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

function archivosAuditar() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && f !== SELF)
    .map((f) => ({ nombre: f, ruta: join(DIR, f) }));
}

// Ventana asimétrica: 700 chars hacia atrás (alcanza la cadena de `.input(...)` que liga los
// parámetros) y 400 hacia adelante (el cuerpo del propio statement).
const ATRAS = 700;
const ADELANTE = 400;

function ofensoresEn(src) {
  const limpio = stripComments(src);
  const acotadores = [...ACOTADORES, ...aliasesDeFixture(limpio)];
  const out = [];
  for (const tabla of TABLAS_PROTEGIDAS) {
    const re = new RegExp(`(?:DELETE\\s+FROM|UPDATE|TRUNCATE\\s+TABLE)\\s+(?:bitacora\\.)?${tabla}\\b`, 'gi');
    let m;
    while ((m = re.exec(limpio)) !== null) {
      const desde = Math.max(0, m.index - ATRAS);
      const ventana = limpio.slice(desde, m.index + ADELANTE);
      if (!acotadores.some((a) => a.test(ventana))) {
        const linea = limpio.slice(0, m.index).split('\n').length;
        out.push({ tabla, linea, sentencia: m[0].replace(/\s+/g, ' ') });
      }
    }
  }
  return out;
}

test('Regla D-055: ningún DELETE/UPDATE sobre tablas operativas corre sin acotador de fixture', () => {
  const ofensores = [];
  for (const { nombre, ruta } of archivosAuditar()) {
    for (const o of ofensoresEn(readFileSync(ruta, 'utf8'))) {
      ofensores.push(`${nombre}:${o.linea} → "${o.sentencia}" sobre ${o.tabla} sin acotador de fixture`);
    }
  }
  assert.equal(
    ofensores.length,
    0,
    'DML sin acotar sobre tabla operativa (la suite corre contra PROD, D-030).\n' +
      'Acota por TEST_PLANTA / TEST_TAG / es_sintetico, léxicamente junto al statement:\n  - ' +
      ofensores.join('\n  - '),
  );
});

// Meta-tests: un guard que no detecta nada es peor que no tener guard — pasa dando falsa
// confianza. Estos dos fijan que el escáner ve archivos y que su detector realmente dispara.
test('meta: el guard encuentra archivos que auditar', () => {
  assert.ok(archivosAuditar().length >= 5, 'debe auditar varios archivos de tests');
});

test('meta: el detector dispara ante el patrón real que motivó D-055, y calla ante su versión acotada', () => {
  const vulnerable = `
    const PLANTA_ID = 'GEC3';
    await db.request()
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .input('p', sql.VarChar(10), PLANTA_ID)
      .query(\`DELETE FROM bitacora.registro_historico WHERE bitacora_id = @mand AND planta_id = @p;\`);
  `;
  assert.equal(ofensoresEn(vulnerable).length, 1, 'debe detectar el DELETE de histórico sin acotar');

  const acotado = `
    await db.request()
      .input('mand', sql.Int, MAND_BITACORA_ID)
      .input('p', sql.VarChar(10), TEST_PLANTA)
      .query(\`DELETE FROM bitacora.registro_historico WHERE bitacora_id = @mand AND planta_id = @p;\`);
  `;
  assert.equal(ofensoresEn(acotado).length, 0, 'no debe marcar el DELETE acotado a la planta-fixture');
});
