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
  // D-061 (L06 · CA-27): las dos tablas de la ingesta de carbón del SIS. Entran ahora porque el
  // backfill histórico de GEC32 las está poblando con años de operación real (D-060/D-061) sobre
  // la MISMA BD contra la que corre la suite (D-030): un `DELETE ... WHERE planta_id='GEC32' AND
  // fecha=@f` de un test —el patrón exacto que tenían `consumos_combustible`, `sis_concurrencia` y
  // `sis_scraper_ownership`— borraría 192 celdas de carbón real por cada corrida, y el log del día
  // con ellas. A diferencia de `registro_historico` no hay auditoría que lo delate: la grilla
  // simplemente aparece vacía ese día.
  'consumo_combustible',
  'sis_scrape_log',
];

// Marcadores que prueban que el statement está acotado a datos de test. Basta uno.
//  - TEST_PLANTA / TEST_PLANTA_ID / 'TST' → planta-fixture (D-030)
//  - TEST_PLANTA_REFLEJO / 'TSR'          → segunda planta-fixture, la que SÍ refleja (D-058 E4).
//                                           Vive solo en tests/helpers.js y se siembra con activa=0;
//                                           acota igual de fuerte que 'TST' porque tampoco es real.
//  - TEST_TAG / @tag                      → tag único por corrida
//  - es_sintetico                         → fixtures de usuario (D-044)
//  - test_%                               → usernames sintéticos
const ACOTADORES = [
  /\bTEST_PLANTA(_ID)?\b/,
  /\bTEST_PLANTA_REFLEJO\b/,
  /'TST'/,
  /'TSR'/,
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

// D-061 (L06 · CA-27): el mismo verificador bidireccional para las dos tablas del SIS. Va aparte y
// con el patrón LITERAL que tenían los tests de carbón (planta real + fecha fija), porque "acotar
// por fecha" es exactamente la falsa sensación de seguridad que el guard tiene que desmentir: la
// fecha fija 2026-04-17 dejó de ser tierra de nadie el día que el backfill empezó a llenarla.
test('meta: el detector cubre consumo_combustible y sis_scrape_log, y una fecha fija NO acota', () => {
  const porFecha = `
    const PLANTA = 'GEC32';
    const FECHA = '2026-04-17';
    await db.request()
      .input('p', sql.VarChar(10), PLANTA)
      .input('f', sql.Date, FECHA)
      .query(\`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@p AND fecha=@f\`);
    await db.request()
      .input('p', sql.VarChar(10), PLANTA)
      .input('f', sql.Date, FECHA)
      .query(\`DELETE FROM bitacora.sis_scrape_log WHERE planta_id=@p AND fecha=@f\`);
  `;
  const ofensores = ofensoresEn(porFecha);
  assert.equal(ofensores.length, 2, `los dos DELETE deben marcarse: ${JSON.stringify(ofensores)}`);
  assert.deepEqual(
    ofensores.map((o) => o.tabla).sort(),
    ['consumo_combustible', 'sis_scrape_log'],
  );

  // Un UPDATE del log también cuenta (el helper `setLog` de sis_scraper_ownership lo hace).
  const updateSinAcotar = `
    await db.request()
      .input('p', sql.VarChar(10), 'GEC32')
      .query(\`UPDATE bitacora.sis_scrape_log SET completo=0 WHERE planta_id=@p\`);
  `;
  assert.equal(ofensoresEn(updateSinAcotar).length, 1, 'un UPDATE del log sin acotador debe marcarse');

  const acotadoAFixture = `
    await db.request()
      .input('tp', sql.VarChar(10), TEST_PLANTA)
      .input('f', sql.Date, FECHA)
      .query(\`DELETE FROM bitacora.consumo_combustible WHERE planta_id=@tp AND fecha=@f\`);
  `;
  assert.equal(ofensoresEn(acotadoAFixture).length, 0, 'acotado a la planta-fixture no debe marcarse');
});
