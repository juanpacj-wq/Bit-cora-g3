// D-063 L04 — GUARDRAIL estático: el marcador del ASIENTO REFLEJADO es UNO y es `origen_bitacora`.
//
// Contexto: D-058 marcó las copias de Operación 24h por su PUNTERO (`campos_extra.origen_lote_id`),
// y el predicado "es una copia" vivía en CINCO puntos distintos (helper, espejo SQL del GET /activos,
// exclusión del libro F03, chip de la grilla, Históricos). Cuando D-063 sumó las copias de
// Disponibilidad —que llevan otro puntero, `origen_disponibilidad_id`— cada uno de esos puntos
// atado al puntero de MAND dejaba la copia DISP editable, publicable en el libro y sin chip. El
// marcador pasa a ser universal (`origen_bitacora`, contrato C3) y ESTE guard fija que los cinco
// puntos lo consumen y que ninguno vuelve a decidir por `origen_lote_id`.
//
// No toca la BD: escanea CÓDIGO FUENTE (backend + front) y FALLA nombrando al ofensor. Quedan FUERA
// `utils/reflejo-sala.js` y `routes/mand.js`: ahí `origen_lote_id` es el puntero legítimo con el que
// el origen encuentra sus copias (DML acotado por `= @lote`), no un marcador booleano.
//
// Reglas:
//   A. Ninguno de los cinco archivos usa `origen_lote_id` como MARCADOR: ni `'$.origen_lote_id') IS
//      [NOT] NULL` en SQL, ni `!!….origen_lote_id`, ni `if (….origen_lote_id)`, ni ternario
//      `….origen_lote_id ? …`, ni `Boolean(….origen_lote_id)`, ni `CLAVE_ORIGEN_REFLEJO = 'origen_lote_id'`.
//   B. `permissions.js` exporta `CLAVE_ORIGEN_REFLEJO = 'origen_bitacora'`.
//   C. `registros.js` (espejo SQL de `puede_editar`) y `f03-datos.js` (exclusión del libro) filtran
//      con `JSON_VALUE(…, '$.origen_bitacora') IS NULL`.
//   D. Los dos archivos de `src/` consumen `origen_bitacora` (el marcador, no solo
//      `origen_bitacora_nombre`, que es el rótulo).
//
// En la ola O1 el front lo migra L03 en paralelo: si D o A(front) salen rojos antes de que L03
// cierre, es "rojo esperado hasta GATE-O1", no un motivo para editar `src/` desde otro lote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));   // server/tests
const SERVER = join(DIR, '..');                          // server
const RAIZ = join(SERVER, '..');                         // Bit-cora-g3

const BACKEND = {
  'server/middleware/permissions.js': join(SERVER, 'middleware', 'permissions.js'),
  'server/routes/registros.js': join(SERVER, 'routes', 'registros.js'),
  'server/utils/f03-datos.js': join(SERVER, 'utils', 'f03-datos.js'),
};
const FRONT = {
  'src/BitacorasGecelca3.jsx': join(RAIZ, 'src', 'BitacorasGecelca3.jsx'),
  'src/components/historicos/HistoricoTable.jsx': join(RAIZ, 'src', 'components', 'historicos', 'HistoricoTable.jsx'),
};
const TODOS = { ...BACKEND, ...FRONT };

// Elimina comentarios (bloque, línea JS `//`, línea SQL `--`) para no falsear con texto explicativo:
// este mismo repo documenta el marcador viejo en comentarios.
//
// D-055: parte con `/\r?\n/`, NUNCA con `.split('\n')`. El repo es CRLF y el `.` de una regex JS no
// matchea `\r`, así que con `\n` a secas el `//.*$` nunca hacía match y el strip quedaba INERTE (así
// estuvo el guard de D-041). Hay meta-test abajo que lo fija.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

function codigoDe(ruta) {
  return stripComments(readFileSync(ruta, 'utf8'));
}

// `origen_lote_id` como MARCADOR (decisión booleana), no como puntero.
const MARCADOR_VIEJO = [
  { que: "JSON_VALUE('$.origen_lote_id') IS [NOT] NULL", re: /'\$\.origen_lote_id'\s*\)\s*IS\s+(?:NOT\s+)?NULL/i },
  { que: '!!….origen_lote_id', re: /!!\s*[\w$.?[\]'"]*origen_lote_id\b/ },
  { que: 'if (….origen_lote_id)', re: /if\s*\([^()]*\.origen_lote_id\s*\)/ },
  { que: '….origen_lote_id ? … : …', re: /\.origen_lote_id\s*\?\s*[^.]/ },
  { que: 'Boolean(….origen_lote_id)', re: /Boolean\s*\([^()]*origen_lote_id\s*\)/ },
  { que: "CLAVE_ORIGEN_REFLEJO = 'origen_lote_id'", re: /CLAVE_ORIGEN_REFLEJO\s*=\s*['"]origen_lote_id['"]/ },
];

const ESPEJO_SQL = /'\$\.origen_bitacora'\s*\)\s*IS\s+NULL/;
const CLAVE_NUEVA = /export\s+const\s+CLAVE_ORIGEN_REFLEJO\s*=\s*'origen_bitacora'/;
// `\b` tras `origen_bitacora` NO matchea antes de `_nombre` (el `_` es carácter de palabra), así que
// este patrón exige el marcador y no se conforma con el rótulo `origen_bitacora_nombre`.
const MARCADOR_NUEVO = /\borigen_bitacora\b/;

function ofensoresMarcadorViejo(archivos) {
  const ofensores = [];
  for (const [nombre, ruta] of Object.entries(archivos)) {
    const limpio = codigoDe(ruta);
    for (const { que, re } of MARCADOR_VIEJO) {
      if (re.test(limpio)) ofensores.push(`${nombre}: usa origen_lote_id como marcador (${que}). El marcador es origen_bitacora; origen_lote_id es solo el PUNTERO de MAND.`);
    }
  }
  return ofensores;
}

test('Regla A (backend): permissions.js, registros.js y f03-datos.js no deciden por origen_lote_id', () => {
  const ofensores = ofensoresMarcadorViejo(BACKEND);
  assert.equal(ofensores.length, 0,
    `Marcador viejo detectado (D-063 C3):\n  - ${ofensores.join('\n  - ')}`);
});

test('Regla A (front): BitacorasGecelca3.jsx y HistoricoTable.jsx no deciden por origen_lote_id', () => {
  const ofensores = ofensoresMarcadorViejo(FRONT);
  assert.equal(ofensores.length, 0,
    `Marcador viejo detectado en el front (D-063 C3; lo migra L03):\n  - ${ofensores.join('\n  - ')}`);
});

test("Regla B: permissions.js exporta CLAVE_ORIGEN_REFLEJO = 'origen_bitacora'", () => {
  const limpio = codigoDe(BACKEND['server/middleware/permissions.js']);
  assert.ok(CLAVE_NUEVA.test(limpio),
    "server/middleware/permissions.js: falta `export const CLAVE_ORIGEN_REFLEJO = 'origen_bitacora'` (D-063 C3)");
});

test("Regla C: el espejo SQL de GET /activos y la exclusión F03 filtran por JSON_VALUE('$.origen_bitacora') IS NULL", () => {
  const ofensores = [];
  for (const nombre of ['server/routes/registros.js', 'server/utils/f03-datos.js']) {
    if (!ESPEJO_SQL.test(codigoDe(BACKEND[nombre]))) {
      ofensores.push(`${nombre}: falta \`JSON_VALUE(r.campos_extra, '$.origen_bitacora') IS NULL\` (D-063 C3)`);
    }
  }
  assert.equal(ofensores.length, 0, `Espejo SQL desalineado del helper:\n  - ${ofensores.join('\n  - ')}`);
});

// Un archivo "consume el marcador" si su código lo lee, O si importa (ruta relativa, un nivel) un
// módulo cuyo código lo lee: el front centraliza el predicado en UN helper compartido entre la
// grilla y los Históricos, y eso es lo correcto (un predicado copiado es el drift que este guard
// persigue). No se ata al NOMBRE del helper — solo a que el marcador se lea por esa vía.
function importsRelativos(src) {
  const out = [];
  const re = /import\s+[^;'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function resolverModulo(desde, especificador) {
  const base = join(dirname(desde), especificador);
  for (const cand of [base, `${base}.jsx`, `${base}.js`, join(base, 'index.jsx'), join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function consumeMarcador(ruta) {
  const propio = codigoDe(ruta);
  if (MARCADOR_NUEVO.test(propio)) return { ok: true, via: 'propio' };
  for (const esp of importsRelativos(propio)) {
    const mod = resolverModulo(ruta, esp);
    if (mod && MARCADOR_NUEVO.test(codigoDe(mod))) return { ok: true, via: esp };
  }
  return { ok: false };
}

test('Regla D (front): la grilla y los Históricos consumen el marcador origen_bitacora (propio o vía helper importado)', () => {
  const ofensores = [];
  for (const [nombre, ruta] of Object.entries(FRONT)) {
    if (!consumeMarcador(ruta).ok) {
      ofensores.push(`${nombre}: no lee campos_extra.origen_bitacora ni importa un módulo que lo lea (solo el rótulo origen_bitacora_nombre no basta; D-063 C3, lo migra L03)`);
    }
  }
  assert.equal(ofensores.length, 0, `Front sin marcador universal:\n  - ${ofensores.join('\n  - ')}`);
});

test('meta: los cinco archivos auditados existen (el guard no pasa por escanear nada)', () => {
  const faltan = Object.entries(TODOS).filter(([, ruta]) => !existsSync(ruta)).map(([n]) => n);
  assert.deepEqual(faltan, [], `archivos que el guard no encuentra: ${faltan.join(', ')}`);
  assert.equal(Object.keys(TODOS).length, 5);
});

// D-055: fija la corrección del strip. El `\r` ES el caso — así viven todos los archivos del repo.
test('meta: stripComments elimina comentarios en archivos CRLF (no queda inerte)', () => {
  const crlf = "const a = 1;\r\n  // const esReflejado = !!campos.origen_lote_id;\r\n  -- AND JSON_VALUE(x, '$.origen_lote_id') IS NULL\r\n";
  const limpio = stripComments(crlf);
  assert.ok(!limpio.includes('origen_lote_id'),
    `el strip debe borrar el comentario CRLF, quedó: ${JSON.stringify(limpio)}`);
  assert.ok(limpio.includes('const a = 1;'), 'el strip no debe comerse el código');
  // Y un archivo con el marcador viejo SOLO en comentarios no es ofensor: el guard mira código.
  for (const { re } of MARCADOR_VIEJO) assert.ok(!re.test(limpio));
});

test('meta: los patrones de la regla A detectan las cinco formas del marcador viejo (verificador bidireccional)', () => {
  const malos = [
    "AND JSON_VALUE(r.campos_extra, '$.origen_lote_id') IS NULL",
    'const esReflejado = !!camposExtraValores.origen_lote_id;',
    'if (campos.origen_lote_id) { x(); }',
    'const chip = campos.origen_lote_id ? <Lock /> : null;',
    'const es = Boolean(campos?.origen_lote_id);',
    "export const CLAVE_ORIGEN_REFLEJO = 'origen_lote_id';",
  ];
  for (const malo of malos) {
    assert.ok(MARCADOR_VIEJO.some(({ re }) => re.test(malo)), `debería detectar: ${malo}`);
  }
  // El PUNTERO legítimo (como lo usa reflejo-sala.js) NO dispara ningún patrón.
  const buenos = [
    "WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote",
    'const campos = { origen_bitacora: "MAND", origen_lote_id: lote_id };',
    'const esReflejado = !!campos.origen_bitacora;',
  ];
  for (const bueno of buenos) {
    assert.ok(!MARCADOR_VIEJO.some(({ re }) => re.test(bueno)), `no debería detectar: ${bueno}`);
  }
});
