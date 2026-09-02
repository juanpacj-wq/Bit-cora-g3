// D-065 · L11 — Correcciones de la O1 (GATE-O1 §7, CR-1…CR-15).
//
// Este archivo no fija un CA nuevo: protege CA-3/CA-4/CA-5/CA-6 contra los hallazgos que el
// /code-review de la O1 confirmó sobre territorios ya cerrados. Cada caso se escribió ANTES del
// arreglo y se vio rojo con el código de la O1 (la salida literal está en cierres/L11.md).
//
// Escrituras en BD, todas acotadas y todas reversibles:
//   · `lov_bit.usuario`: solo filas con `azure_oid` en el namespace `00000000-d065-4011-…` (el
//     "4011" marca L11; ningún oid real de Entra empieza por ceros). Se borran por ese patrón en
//     `before()` y `after()`, igual que hace L03 con su fixture.
//   · `bitacora.turno_unidad` / `rotacion_*`: SOLO dentro de transacciones que se DESCARTAN
//     (rollback), sobre las plantas-fixture 'TST'/'TSR' y con fecha 2001-01-01. Ninguna fila
//     sobrevive al test; el check de residuos lo confirma.
//   · `bitacora.migracion_aplicada`: el caso CR-15 borra el flag `F37.A1` y `initDB()` lo repone
//     en la misma corrida — es el escenario "alguien borró el flag a mano" que el propio db.js
//     declara soportado.
// Ninguna escritura alcanza una fila de una persona real ni una planta real (D-055).
//
// `db.js` se importa DINÁMICAMENTE (no `import` estático) para que este archivo controle cuándo
// se evalúa: `initDB()` corre varias veces acá (idempotencia de F37.A3, CR-15) y el orden importa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { limpiarCacheToken, obtenerToken, graphGet } from '../utils/graph/cliente.js';
import * as directorio from '../utils/graph/directorio.js';

const { leerDirectorioEntra, sincronizarDirectorio } = directorio;
// Se lee del namespace (no como import con nombre) para que, si el símbolo no existe, falle el
// caso CR-3 y no el archivo entero: así el rojo previo señala al hallazgo, no al import.
const TRAMO_SYNC = directorio.TRAMO_SYNC;

const { initDB, getDB } = await import('../db.js');

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const NS_L11 = '00000000-d065-4011-8000-';                   // namespace de oids de este archivo
const OID_JEFE     = `${NS_L11}0000000000a1`;                 // CR-1: fixture con es_jefe_planta=1
const OID_TID      = `${NS_L11}0000000000a2`;                 // CR-1: fixture con azure_tid
const OID_ANCLA    = `${NS_L11}0000000000a3`;                 // dueño de FKs (creado_por, usuario_id)
const oidTramo = (i) => `${NS_L11}${String(100 + i).padStart(12, '0')}`; // CR-3: 45 personas

const UPN_JEFE = 'test_rot_jefe_l11@fixture.local';
const TID_FIXTURE = '11111111-2222-3333-4444-555555555555';
const TENANT_FIXTURE = '11111111-2222-3333-4444-555555555555';
const CLIENT_FIXTURE = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const SP_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const GRUPO_A = 'cccccccc-1111-2222-3333-444444444444';
const GRUPO_B = 'dddddddd-1111-2222-3333-444444444444';
const GRUPO_C = 'eeeeeeee-1111-2222-3333-444444444444';
const ROLE_ID_JDT = 'aaaa1111-0000-0000-0000-000000000001';
const ROLE_ID_SDM = 'aaaa1111-0000-0000-0000-000000000002';

const PLANTA_FIXTURE = 'TST';
const PLANTA_FIXTURE_2 = 'TSR';
const FECHA_FIXTURE = '2001-01-01'; // ningún test operativo usa el 2001: no choca con UQ_turno_unidad_natural

let pool;
let envOriginal;
let usuarioAncla; // usuario_id del fixture ancla (para creado_por / usuario_id)
let cargoId;      // un cargo_id cualquiera del catálogo, solo como referencia de FK

const usuarioGraph = (id, displayName, upn) => ({ id, displayName, userPrincipalName: upn, accountEnabled: true });

/** Respuesta HTTP real (con stream), para que el cliente ejercite el mismo camino que con fetch. */
const responder = (cuerpo, { status = 200, headers = {} } = {}) => new Response(
  typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

/** Transporte de fixture: SP con dos roles, tres grupos, y `sobrescribir(url)` para forzar fallos. */
function armarFetch({ sobrescribir = () => null } = {}) {
  const rutas = {
    servicePrincipals: { value: [{ id: SP_ID, displayName: 'APP FIXTURE', appRoles: [
      { id: ROLE_ID_JDT, value: 'JEFE_DE_TURNO' }, { id: ROLE_ID_SDM, value: 'OPERADOR_PLANTA_SDM' },
    ] }] },
    appRoleAssignedTo: { value: [
      { principalType: 'Group', principalId: GRUPO_A, principalDisplayName: 'GRUPO A', appRoleId: ROLE_ID_JDT },
      { principalType: 'Group', principalId: GRUPO_B, principalDisplayName: 'GRUPO B', appRoleId: ROLE_ID_SDM },
      { principalType: 'Group', principalId: GRUPO_C, principalDisplayName: 'GRUPO C', appRoleId: ROLE_ID_SDM },
    ] },
    [`groups/${GRUPO_A}`]: { value: [usuarioGraph(`${NS_L11}0000000000b1`, 'Persona A1', 'test_rot_a1@fixture.local')] },
    [`groups/${GRUPO_B}`]: { value: [usuarioGraph(`${NS_L11}0000000000b2`, 'Persona B1', 'test_rot_b1@fixture.local')] },
    [`groups/${GRUPO_C}`]: { value: [usuarioGraph(`${NS_L11}0000000000b3`, 'Persona C1', 'test_rot_c1@fixture.local')] },
  };
  return async (url, opciones) => {
    const forzada = sobrescribir(url, opciones);
    if (forzada) return forzada;
    if (url.includes('/oauth2/v2.0/token')) return responder({ access_token: 'token-de-fixture', expires_in: 3600 });
    if (url.includes('/servicePrincipals?')) return responder(rutas.servicePrincipals);
    if (url.includes('/appRoleAssignedTo')) return responder(rutas.appRoleAssignedTo);
    for (const clave of Object.keys(rutas)) {
      if (clave.startsWith('groups/') && url.includes(`/${clave}`)) return responder(rutas[clave]);
    }
    throw new Error(`fixture sin ruta para ${url}`);
  };
}

function ponerCredencialesFixture() {
  process.env.M365_TENANT_ID = TENANT_FIXTURE;
  process.env.M365_CLIENT_ID = CLIENT_FIXTURE;
  process.env.M365_CLIENT_SECRET = 'secret-de-fixture';
  limpiarCacheToken();
}

/** Restaura una env var a su valor original; `undefined` se restaura BORRANDO (CR-11). */
function restaurarEnv(nombre, valor) {
  if (valor === undefined) delete process.env[nombre];
  else process.env[nombre] = valor;
}

async function limpiarFixture() {
  // Acotado al namespace de L11 (`…-d065-4011-…`): no existe un oid real con esa forma.
  await pool.request()
    .input('patron', sql.VarChar(64), `${NS_L11}%`)
    .query('DELETE FROM lov_bit.usuario WHERE azure_oid LIKE @patron');
}

async function sembrarUsuario({ oid, username, upn = null, tid = null, es_jefe = 0 }) {
  const r = await pool.request()
    .input('oid', sql.VarChar(64), oid)
    .input('username', sql.VarChar(50), username)
    .input('upn', sql.VarChar(200), upn)
    .input('tid', sql.VarChar(64), tid)
    .input('es_jefe', sql.Bit, es_jefe)
    .query(`
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, azure_oid, azure_upn, azure_tid,
         es_jefe_planta, es_jdt_default, activo, es_sintetico)
      OUTPUT INSERTED.usuario_id
      VALUES ('Fixture L11', @username, NULL, NULL, @oid, @upn, @tid, @es_jefe, 0, 1, 1);
    `);
  return r.recordset[0].usuario_id;
}

async function leerUsuario(oid) {
  const r = await pool.request().input('oid', sql.VarChar(64), oid)
    .query('SELECT azure_upn, azure_tid, CAST(es_jefe_planta AS INT) AS es_jefe_planta FROM lov_bit.usuario WHERE azure_oid = @oid');
  return r.recordset[0];
}

/**
 * Corre `fn(tx)` en una transacción que SIEMPRE se descarta. Es la forma de probar una constraint
 * sobre tablas con FK a `turno_unidad` sin dejar ni una fila: la cabecera de turno se crea
 * adentro, sobre la planta-fixture, y se va con el rollback.
 */
async function enTransaccionDescartada(fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    return await fn(tx);
  } finally {
    try { await tx.rollback(); } catch { /* ya abortada por el motor: nada que deshacer */ }
  }
}

/** Crea una cabecera de turno CERRADA en la planta-fixture dentro de `tx` y devuelve su id. */
async function crearTurnoFixture(tx, planta = PLANTA_FIXTURE) {
  const r = await new sql.Request(tx)
    .input('planta', sql.VarChar(10), planta)
    .input('fecha', sql.Date, FECHA_FIXTURE)
    .input('creado_por', sql.Int, usuarioAncla)
    .query(`
      INSERT INTO bitacora.turno_unidad
        (fecha_operativa, planta_id, turno, estado, inicio_nominal, fin_nominal, creado_por)
      OUTPUT INSERTED.turno_unidad_id
      VALUES (@fecha, @planta, 1, 'CERRADO', '2001-01-01T11:00:00', '2001-01-01T23:00:00', @creado_por);
    `);
  return r.recordset[0].turno_unidad_id;
}

/** Ejecuta un INSERT que puede violar una constraint y devuelve `{ ok, error }` sin lanzar. */
async function intentar(promesa) {
  try {
    await promesa;
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

before(async () => {
  assert.notEqual(process.env.SKIP_INITDB, '1', 'este test exige el initDB real: aplica y verifica F37.A3');
  envOriginal = {
    tenant: process.env.M365_TENANT_ID,
    client: process.env.M365_CLIENT_ID,
    secret: process.env.M365_CLIENT_SECRET,
  };
  await initDB();
  pool = await getDB();
  await limpiarFixture();
  usuarioAncla = await sembrarUsuario({ oid: OID_ANCLA, username: 'test_rot_l11_ancla' });
  const c = await pool.request().query('SELECT MIN(cargo_id) AS cargo_id FROM lov_bit.cargo');
  cargoId = c.recordset[0].cargo_id;
  assert.ok(cargoId, 'el catálogo de cargos no puede estar vacío');
});

after(async () => {
  await limpiarFixture();
  restaurarEnv('M365_TENANT_ID', envOriginal.tenant);
  restaurarEnv('M365_CLIENT_ID', envOriginal.client);
  restaurarEnv('M365_CLIENT_SECRET', envOriginal.secret);
  limpiarCacheToken();
});

// ═══════════════════════════════ CR-1 · el MERGE no pisa azure_upn/azure_tid con NULL ═══════════

test('CR-1 · una persona que Graph devuelve SIN UPN conserva su azure_upn en la BD', async () => {
  await sembrarUsuario({ oid: OID_JEFE, username: 'test_rot_jefe_l11', upn: UPN_JEFE, es_jefe: 1 });

  // Graph la devuelve sin userPrincipalName (soft-deleted, B2B, $select recortado): upn vacío.
  const r = await sincronizarDirectorio(pool, {
    por_usuario: usuarioAncla,
    directorio: { personas: [{ azure_oid: OID_JEFE, nombre: 'Jefe Fixture', upn: '', activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: 'Ingeniero Jefe de Turno' }], grupos: [] },
  });
  assert.equal(r.actualizados, 1, 'la fila existía: es una actualización');

  const fila = await leerUsuario(OID_JEFE);
  assert.equal(fila.azure_upn, UPN_JEFE, 'un UPN ausente en Graph NO borra el UPN que la BD ya tenía');
});

test('CR-1 · la cadena completa: tras el predicado de enforceSingletonFlag sigue siendo Jefe de Planta', async () => {
  // Por qué NO se llama a initDB()/enforceSingletonFlag acá: en el .env de dev
  // `M365_JEFE_PLANTA_UPNS` está vacío y el titular es la fila legacy `emunoz` (azure_upn NULL).
  // Correr la rama por UPN con cualquier lista la degradaría (`azure_upn IS NULL` → 0) y la rama
  // legacy nunca la repone: sería escribir sobre una persona real (D-055). Se reproduce entonces
  // el UPDATE de degradación TAL CUAL está en db.js (enforceSingletonFlag, rama con UPNs), acotado
  // al oid de fixture y dentro de una transacción que se descarta. El caso de abajo verifica que
  // ese predicado siga siendo el de db.js, para que esta réplica no derive en silencio.
  const fila = await leerUsuario(OID_JEFE);
  assert.equal(fila.es_jefe_planta, 1, 'precondición: el fixture entró como Jefe de Planta');

  const degradado = await enTransaccionDescartada(async (tx) => {
    await new sql.Request(tx)
      .input('u0', sql.VarChar(200), UPN_JEFE)
      .input('oid', sql.VarChar(64), OID_JEFE)
      .query(`
        UPDATE lov_bit.usuario SET es_jefe_planta = 0
         WHERE es_jefe_planta = 1 AND (azure_upn IS NULL OR LOWER(azure_upn) NOT IN (@u0))
           AND azure_oid = @oid;
      `);
    const r = await new sql.Request(tx).input('oid', sql.VarChar(64), OID_JEFE)
      .query('SELECT CAST(es_jefe_planta AS INT) AS f FROM lov_bit.usuario WHERE azure_oid = @oid');
    return r.recordset[0].f === 0;
  });
  assert.equal(
    degradado, false,
    'con azure_upn = NULL tras la sincronización, el siguiente arranque degradaría al Jefe de Planta',
  );
});

test('CR-1 · el predicado replicado arriba es el que de verdad corre en db.js (guard contra deriva)', () => {
  const fuente = readFileSync(fileURLToPath(new URL('../db.js', import.meta.url)), 'utf8');
  const inicio = fuente.indexOf('async function enforceSingletonFlag');
  assert.ok(inicio > 0, 'db.js debe seguir definiendo enforceSingletonFlag');
  const cuerpo = fuente.slice(inicio, inicio + 2500).replace(/\s+/g, ' ');
  assert.ok(
    cuerpo.includes('WHERE ${columna} = 1 AND (azure_upn IS NULL OR LOWER(azure_upn) NOT IN ('),
    'el predicado de degradación cambió en db.js: actualiza la réplica del caso anterior',
  );
});

test('CR-1 · azure_tid tampoco se pisa cuando M365_TENANT_ID no está configurado', async () => {
  await sembrarUsuario({ oid: OID_TID, username: 'test_rot_tid_l11', upn: 'test_rot_tid_l11@fixture.local', tid: TID_FIXTURE });
  const tenantOriginal = process.env.M365_TENANT_ID;
  delete process.env.M365_TENANT_ID;
  try {
    await sincronizarDirectorio(pool, {
      directorio: { personas: [{ azure_oid: OID_TID, nombre: 'Persona Tid', upn: 'test_rot_tid_l11@fixture.local', activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: null }], grupos: [] },
    });
  } finally {
    restaurarEnv('M365_TENANT_ID', tenantOriginal);
  }
  const fila = await leerUsuario(OID_TID);
  assert.equal(fila.azure_tid, TID_FIXTURE, 'sin tenant configurado, el tid previo se conserva');
});

// ═══════════════════════════════ CR-2 · tolerancia por asignación ═══════════════════════════════

test('CR-2 · un 404 en UNA asignación (usuario borrado hace < 30 días) no tumba el directorio', async () => {
  ponerCredencialesFixture();
  const fetchImpl = armarFetch({
    sobrescribir: (url) => (url.includes(`/groups/${GRUPO_B}/`) ? responder({ error: { code: 'Request_ResourceNotFound' } }, { status: 404 }) : null),
  });
  const dir = await leerDirectorioEntra({ fetchImpl });
  assert.equal(dir.personas.length, 2, 'las personas de los otros dos grupos sí salen');
  assert.equal(dir.grupos.length, 2, 'el grupo que falló se omite, no se inventa con 0 miembros');
  assert.ok(!dir.grupos.some((g) => g.nombre === 'GRUPO B'));
});

test('CR-2 · si falla la MAYORÍA de las asignaciones sigue siendo entra_no_disponible', async () => {
  ponerCredencialesFixture();
  const fetchImpl = armarFetch({
    sobrescribir: (url) => ((url.includes(`/groups/${GRUPO_A}/`) || url.includes(`/groups/${GRUPO_B}/`))
      ? responder({}, { status: 404 }) : null),
  });
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl }),
    (e) => e.codigo === 'entra_no_disponible' && /2 de 3/.test(e.message),
    'dos de tres asignaciones caídas no es un directorio: es Graph fallando',
  );
});

test('CR-2 · un 429 con Retry-After corto se reintenta UNA vez y la lectura sale bien', async () => {
  ponerCredencialesFixture();
  let veces = 0;
  const fetchImpl = armarFetch({
    sobrescribir: (url) => {
      if (!url.includes(`/groups/${GRUPO_A}/`)) return null;
      veces++;
      return veces === 1 ? responder({}, { status: 429, headers: { 'retry-after': '0' } }) : null;
    },
  });
  const dir = await leerDirectorioEntra({ fetchImpl });
  assert.equal(veces, 2, 'la petición estrangulada se repitió exactamente una vez');
  assert.equal(dir.personas.length, 3, 'y el directorio quedó completo');
});

test('CR-2 · un 429 con Retry-After por encima del tope NO se espera: se omite esa asignación', async () => {
  ponerCredencialesFixture();
  let veces = 0;
  const fetchImpl = armarFetch({
    sobrescribir: (url) => {
      if (!url.includes(`/groups/${GRUPO_A}/`)) return null;
      veces++;
      return responder({}, { status: 429, headers: { 'retry-after': '600' } });
    },
  });
  const dir = await leerDirectorioEntra({ fetchImpl });
  assert.equal(veces, 1, 'no se reintenta con una espera de 10 minutos');
  assert.equal(dir.personas.length, 2, 'la asignación estrangulada se omitió y el resto salió');
});

test('CR-2 · el fallo GLOBAL sigue siendo global: sin service principal no hay directorio', async () => {
  ponerCredencialesFixture();
  const fetchImpl = armarFetch({
    sobrescribir: (url) => (url.includes('/servicePrincipals?') ? responder({}, { status: 500 }) : null),
  });
  await assert.rejects(() => leerDirectorioEntra({ fetchImpl }), (e) => e.codigo === 'entra_no_disponible');
});

// ═══════════════════════════════ CR-3 · commit por tramos ═══════════════════════════════════════

test('CR-3 · la sincronización de 45 personas commitea por tramos, no en UNA transacción', async () => {
  const personas = Array.from({ length: 45 }, (_, i) => ({
    azure_oid: oidTramo(i), nombre: `Persona Tramo ${i}`, upn: `test_rot_tramo_${i}@fixture.local`,
    activo: true, role: 'OPERADOR_PLANTA_SDM', cargo_nombre: 'Operador de Planta - Sala de Mando',
  }));
  const beginOriginal = sql.Transaction.prototype.begin;
  const commitOriginal = sql.Transaction.prototype.commit;
  let begins = 0;
  let commits = 0;
  sql.Transaction.prototype.begin = function (...a) { begins++; return beginOriginal.apply(this, a); };
  sql.Transaction.prototype.commit = function (...a) { commits++; return commitOriginal.apply(this, a); };
  try {
    const r = await sincronizarDirectorio(pool, { directorio: { personas, grupos: [] } });
    assert.equal(r.creados, 45);
  } finally {
    sql.Transaction.prototype.begin = beginOriginal;
    sql.Transaction.prototype.commit = commitOriginal;
  }
  const esperados = Math.ceil(45 / TRAMO_SYNC);
  assert.ok(esperados >= 2, `TRAMO_SYNC=${TRAMO_SYNC} debe partir 45 personas en al menos dos tramos`);
  assert.equal(begins, esperados, `una transacción por tramo de ${TRAMO_SYNC}: los range locks del HOLDLOCK no se acumulan sobre las 45`);
  assert.equal(commits, esperados);

  const n = await pool.request().input('patron', sql.VarChar(64), `${NS_L11}%`)
    .query('SELECT COUNT(*) AS n FROM lov_bit.usuario WHERE azure_oid LIKE @patron AND username LIKE \'test[_]rot[_]tramo%\'');
  assert.equal(n.recordset[0].n, 45, 'las 45 quedaron escritas');
});

// ═══════════════════════════════ CR-13 · la cache del token depende del secreto ══════════════════

test('CR-13 · rotar M365_CLIENT_SECRET invalida el token cacheado', async () => {
  ponerCredencialesFixture();
  let tokens = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) { tokens++; return responder({ access_token: `t${tokens}`, expires_in: 3600 }); }
    throw new Error('solo token');
  };
  assert.equal(await obtenerToken({ fetchImpl }), 't1');
  assert.equal(await obtenerToken({ fetchImpl }), 't1', 'mismo secreto: se sirve de la cache');
  process.env.M365_CLIENT_SECRET = 'secret-rotado';
  assert.equal(await obtenerToken({ fetchImpl }), 't2', 'secreto nuevo: se pide un token nuevo');
  assert.equal(tokens, 2);
});

// ═══════════════════════════════ CR-10 · el tope de bytes existe de verdad ═══════════════════════

test('CR-10 · una respuesta chunked (sin content-length) que supera el tope se rechaza', async () => {
  ponerCredencialesFixture();
  // 9 MB de JSON válido: sin el contador sobre el stream, el cliente lo parsea sin chistar.
  const relleno = 'x'.repeat(9 * 1024 * 1024);
  const fetchImpl = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) return responder({ access_token: 'tok', expires_in: 3600 });
    return responder(`{"value":[],"relleno":"${relleno}"}`);
  };
  await assert.rejects(
    () => graphGet('/users/x', { fetchImpl }),
    (e) => e.codigo === 'entra_no_disponible' && /demasiado grande/.test(e.message),
  );
});

test('CR-10 · una respuesta normal sin content-length se lee completa', async () => {
  ponerCredencialesFixture();
  const fetchImpl = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) return responder({ access_token: 'tok', expires_in: 3600 });
    return responder({ id: 'abc', displayName: 'ok' });
  };
  const r = await graphGet('/users/x', { fetchImpl });
  assert.equal(r.displayName, 'ok');
});

// ═══════════════════════════════ F37.A3 · constraints que faltaron en F37.A1 ═════════════════════

test('F37.A3 · está aplicada, UNA sola vez, y sus cinco constraints existen sobre su tabla', async () => {
  const flag = await pool.request().query(`SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A3'`);
  assert.equal(flag.recordset[0].n, 1, 'F37.A3 debe aparecer exactamente una vez');

  const r = await pool.request().query(`
    SELECT o.name AS nombre, o.type AS tipo, OBJECT_NAME(o.parent_object_id) AS tabla
    FROM sys.objects o
    WHERE o.name IN ('CK_rotacion_cumpl_grupo', 'UQ_turno_unidad_id_planta', 'UQ_turno_unidad_id_natural',
                     'FK_rotacion_control_turno_planta', 'FK_rotacion_cumpl_turno_natural')
  `);
  const por = new Map(r.recordset.map((x) => [x.nombre, x]));
  const esperado = {
    CK_rotacion_cumpl_grupo:          ['C', 'rotacion_cumplimiento'],
    UQ_turno_unidad_id_planta:        ['UQ', 'turno_unidad'],
    UQ_turno_unidad_id_natural:       ['UQ', 'turno_unidad'],
    FK_rotacion_control_turno_planta: ['F', 'rotacion_control'],
    FK_rotacion_cumpl_turno_natural:  ['F', 'rotacion_cumplimiento'],
  };
  for (const [nombre, [tipo, tabla]] of Object.entries(esperado)) {
    const c = por.get(nombre);
    assert.ok(c, `falta la constraint ${nombre} (F37.A3)`);
    assert.equal(String(c.tipo).trim(), tipo, `${nombre}: tipo`);
    assert.equal(c.tabla, tabla, `${nombre}: tabla`);
  }
});

test('F37.A3 · es idempotente: un segundo initDB() no falla ni duplica el flag', async () => {
  await initDB();
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A3'`);
  assert.equal(r.recordset[0].n, 1);
});

// ═══════════════════════════════ CR-9 · CHECK de rotacion_cumplimiento.grupo ═════════════════════

async function insertarCumplimiento(tx, { turnoId, grupo, planta = PLANTA_FIXTURE, fecha = FECHA_FIXTURE, turno = 1 }) {
  return new sql.Request(tx)
    .input('fecha', sql.Date, fecha)
    .input('planta', sql.VarChar(10), planta)
    .input('turno', sql.TinyInt, turno)
    .input('cargo', sql.Int, cargoId)
    .input('grupo', sql.TinyInt, grupo)
    .input('turno_id', sql.Int, turnoId)
    .query(`
      INSERT INTO bitacora.rotacion_cumplimiento
        (fecha_operativa, planta_id, turno, cargo_id, cargo_nombre, grupo, estado, titulares_json, turno_id)
      VALUES (@fecha, @planta, @turno, @cargo, 'Cargo Fixture', @grupo, 'PENDIENTE', N'[]', @turno_id);
    `);
}

test('CR-9 · rotacion_cumplimiento.grupo acepta NULL y 1..4, rechaza 0 y 5', async () => {
  const resultados = {};
  for (const grupo of [null, 1, 4, 0, 5]) {
    resultados[String(grupo)] = await enTransaccionDescartada(async (tx) => {
      const turnoId = await crearTurnoFixture(tx);
      return intentar(insertarCumplimiento(tx, { turnoId, grupo }));
    });
  }
  assert.equal(resultados.null.ok, true, 'NULL sigue siendo legítimo: "el rol no tenía patrón" (L06)');
  assert.equal(resultados['1'].ok, true, 'grupo 1');
  assert.equal(resultados['4'].ok, true, 'grupo 4');
  for (const malo of ['0', '5']) {
    assert.equal(resultados[malo].ok, false, `grupo ${malo} debe rechazarse`);
    assert.equal(resultados[malo].error.number, 547, `grupo ${malo}: error 547 (constraint)`);
    assert.match(resultados[malo].error.message, /CK_rotacion_cumpl_grupo/, `grupo ${malo}: lo rechaza el CHECK con nombre`);
  }
});

// ═══════════════════════════════ CR-7 · planta_id atado al turno_id ══════════════════════════════

test('CR-7 · rotacion_control: un turno de TST con planta_id de TSR se rechaza (FK compuesta)', async () => {
  const r = await enTransaccionDescartada(async (tx) => {
    const turnoId = await crearTurnoFixture(tx, PLANTA_FIXTURE);
    const insertar = (planta) => new sql.Request(tx)
      .input('turno_id', sql.Int, turnoId).input('planta', sql.VarChar(10), planta)
      .input('cargo', sql.Int, cargoId).input('usuario', sql.Int, usuarioAncla)
      .query(`INSERT INTO bitacora.rotacion_control (turno_id, planta_id, cargo_id, usuario_id, accion)
              VALUES (@turno_id, @planta, @cargo, @usuario, 'TOMAR');`);
    return { bien: await intentar(insertar(PLANTA_FIXTURE)), drift: await intentar(insertar(PLANTA_FIXTURE_2)) };
  });
  assert.equal(r.bien.ok, true, 'el par consistente (turno de TST, planta TST) entra');
  assert.equal(r.drift.ok, false, 'el drift D-053(iii) —turno de una planta con planta_id de otra— ya no entra en silencio');
  assert.equal(r.drift.error.number, 547);
  assert.match(r.drift.error.message, /FK_rotacion_control_turno_planta/);
});

test('CR-7 · rotacion_cumplimiento: (turno_id, fecha, planta, turno) tienen que ser los del turno', async () => {
  const r = await enTransaccionDescartada(async (tx) => {
    const turnoId = await crearTurnoFixture(tx, PLANTA_FIXTURE);
    return {
      bien:   await intentar(insertarCumplimiento(tx, { turnoId, grupo: 2 })),
      planta: await intentar(insertarCumplimiento(tx, { turnoId, grupo: 2, planta: PLANTA_FIXTURE_2 })),
      turno:  await intentar(insertarCumplimiento(tx, { turnoId, grupo: 2, turno: 2 })),
      fecha:  await intentar(insertarCumplimiento(tx, { turnoId, grupo: 2, fecha: '2001-01-02' })),
    };
  });
  assert.equal(r.bien.ok, true);
  for (const [caso, res] of Object.entries(r)) {
    if (caso === 'bien') continue;
    assert.equal(res.ok, false, `drift en ${caso} debe rechazarse`);
    assert.equal(res.error.number, 547, `${caso}: error 547`);
    assert.match(res.error.message, /FK_rotacion_cumpl_turno_natural/, `${caso}: lo ata la FK compuesta`);
  }
});

// ═══════════════════════════════ CR-6 · el hueco de solapamiento (documentado, no cerrado) ═══════
//
// Decisión de L11 (cierre §CR-6): el no-solapamiento de rangos NO se expresa con una constraint
// declarativa en SQL Server, un índice único filtrado por `activo = 1` rompería la carga anual
// (el patrón 2027 se carga en enero mientras el 2026 sigue vigente hasta el 31), y este repo no
// tiene triggers y no va a estrenar uno en un lote de corrección. La validación es de L04, en el
// endpoint. Estos dos casos documentan que la BD HOY lo acepta: si algún día una constraint lo
// rechaza, se ponen rojos y hay que revisarlos junto con la validación de L04.

test('CR-6 · (documenta el hueco) dos rotacion_patron activos del mismo cargo pueden solaparse', async () => {
  const r = await enTransaccionDescartada(async (tx) => {
    const insertar = (inicio, fin) => new sql.Request(tx)
      .input('cargo', sql.Int, cargoId).input('ini', sql.Date, inicio).input('fin', sql.Date, fin)
      .input('por', sql.Int, usuarioAncla)
      .query(`INSERT INTO bitacora.rotacion_patron (cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, desfase, activo, creado_por)
              VALUES (@cargo, @ini, @fin, '1,1,3,3,4,4,2,2', '4,2,2,1,1,3,3,4', 0, 1, @por);`);
    await insertar('2001-02-01', '2002-01-31');
    return intentar(insertar('2001-06-01', '2002-05-31'));
  });
  assert.equal(r.ok, true, 'la BD no impide el solapamiento: lo tiene que rechazar el endpoint de L04 (400)');
});

test('CR-6 · (documenta el hueco) una persona puede tener dos asignaciones vigentes con grupos distintos', async () => {
  const r = await enTransaccionDescartada(async (tx) => {
    const insertar = (grupo, desde, hasta) => new sql.Request(tx)
      .input('usuario', sql.Int, usuarioAncla).input('cargo', sql.Int, cargoId).input('grupo', sql.TinyInt, grupo)
      .input('desde', sql.Date, desde).input('hasta', sql.Date, hasta).input('por', sql.Int, usuarioAncla)
      .query(`INSERT INTO bitacora.rotacion_asignacion (usuario_id, cargo_id, grupo, vigente_desde, vigente_hasta, creado_por)
              VALUES (@usuario, @cargo, @grupo, @desde, @hasta, @por);`);
    await insertar(1, '2001-02-01', '2002-01-31');
    return intentar(insertar(3, '2001-06-01', '2002-05-31'));
  });
  assert.equal(r.ok, true, 'la BD no impide dos vigencias solapadas: lo tiene que rechazar el endpoint de L04 (400)');
});

// ═══════════════════════════════ CR-15 · el log de F37.A1 dice la verdad ═════════════════════════

test('CR-15 · con el flag borrado a mano y las tablas ya creadas, initDB() NO dice "schema creado"', async () => {
  await pool.request().query(`DELETE FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A1'`);
  const lineas = [];
  const logOriginal = console.log;
  console.log = (...a) => { lineas.push(a.join(' ')); };
  try {
    await initDB();
  } finally {
    console.log = logOriginal;
  }
  const deF37 = lineas.filter((l) => l.startsWith('[F37.A1]'));
  assert.equal(deF37.length, 1, 'F37.A1 imprime exactamente una línea cuando el flag faltaba');
  assert.doesNotMatch(deF37[0], /schema de rotación creado/, 'no se creó ninguna tabla: el log no puede decir que sí');
  assert.match(deF37[0], /repuesto/, 'dice que repuso el flag y que las tablas ya existían');

  const flag = await pool.request().query(`SELECT COUNT(*) AS n FROM bitacora.migracion_aplicada WHERE codigo = 'F37.A1'`);
  assert.equal(flag.recordset[0].n, 1, 'y el flag volvió a estar, una sola vez');
});
