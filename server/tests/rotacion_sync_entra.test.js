// D-065 L03 — CA-5 y CA-6: cliente de Microsoft Graph y sincronización del directorio de Entra.
//
// El test NO toca la red: el transporte se inyecta (`fetchImpl`) y responde con una captura
// anonimizada del tenant — 3 personas inventadas, 2 grupos (uno de ellos VACÍO, como
// COORDINADOR_CARBON_MAQUINARIA y ADMINISTRADOR_DEBUGGING hoy) y una asignación con un appRoleId
// que no está entre los appRoles del SP, que es el "Default Access" de Entra. La llamada real se
// verifica a mano una vez y se reporta en el cierre.
//
// Los usuarios que siembra van con `es_sintetico = 1` y los oids son GUIDs de fixture
// (`00000000-d065-...`), imposibles de confundir con uno real. La limpieza borra exactamente esos
// oids: `lov_bit.usuario` no es una tabla protegida por el guard de D-055, pero el criterio es el
// mismo — nada acá puede alcanzar una fila de una persona real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { getDB } from '../db.js';
import { deactivateSyntheticSessions } from './helpers.js';
import { limpiarCacheToken } from '../utils/graph/cliente.js';
import { leerDirectorioEntra, sincronizarDirectorio } from '../utils/graph/directorio.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const OID_SEMBRADO = '00000000-d065-4000-8000-000000000001'; // ya existe en la BD antes del sync
const OID_NUEVO    = '00000000-d065-4000-8000-000000000002'; // lo crea el sync
const OID_GEMELO_A = '00000000-d065-4000-8000-000000000003'; // nombre casi idéntico al B
const OID_GEMELO_B = '00000000-d065-4000-8000-000000000004';
const OID_DEFAULT  = '00000000-d065-4000-8000-000000000005'; // Default Access

const OIDS_FIXTURE = [OID_SEMBRADO, OID_NUEVO, OID_GEMELO_A, OID_GEMELO_B, OID_DEFAULT];

const USERNAME_SEMBRADO = 'test_rot_sembrado';

const TENANT_FIXTURE = '11111111-2222-3333-4444-555555555555';
const CLIENT_FIXTURE = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const SP_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const GRUPO_JDT = 'cccccccc-1111-2222-3333-444444444444';
const GRUPO_VACIO = 'dddddddd-1111-2222-3333-444444444444';

const ROLE_ID_JDT = 'aaaa1111-0000-0000-0000-000000000001';
const ROLE_ID_SDM = 'aaaa1111-0000-0000-0000-000000000002';
const ROLE_ID_COORD = 'aaaa1111-0000-0000-0000-000000000003';
// Este appRoleId NO está en `appRoles` del SP: así se ve el Default Access de Entra.
const ROLE_ID_HUERFANO = '00000000-0000-0000-0000-000000000000';

const usuarioGraph = (id, displayName, upn, accountEnabled = true) => ({
  id, displayName, userPrincipalName: upn, accountEnabled,
});

const RESPUESTAS = {
  servicePrincipals: {
    value: [{
      id: SP_ID,
      displayName: 'APP DE FIXTURE',
      appRoles: [
        { id: ROLE_ID_JDT, value: 'JEFE_DE_TURNO' },
        { id: ROLE_ID_SDM, value: 'OPERADOR_PLANTA_SDM' },
        { id: ROLE_ID_COORD, value: 'COORDINADOR_CARBON_MAQUINARIA' },
      ],
    }],
  },
  appRoleAssignedTo: {
    value: [
      { principalType: 'Group', principalId: GRUPO_JDT, principalDisplayName: 'GRUPO JDT FIXTURE', appRoleId: ROLE_ID_JDT },
      { principalType: 'Group', principalId: GRUPO_VACIO, principalDisplayName: 'GRUPO VACIO FIXTURE', appRoleId: ROLE_ID_COORD },
      { principalType: 'User', principalId: OID_DEFAULT, principalDisplayName: 'Persona Sin Rol', appRoleId: ROLE_ID_HUERFANO },
      // No es una persona: se ignora sin ruido.
      { principalType: 'ServicePrincipal', principalId: '99999999-0000-0000-0000-000000000000', appRoleId: ROLE_ID_SDM },
    ],
  },
  [`groups/${GRUPO_JDT}`]: {
    value: [
      usuarioGraph(OID_SEMBRADO, 'Persona Sembrada', 'test_rot_sembrado@fixture.local'),
      usuarioGraph(OID_NUEVO, 'Persona Nueva', 'test_rot_nueva@fixture.local'),
      // CA-5, caso negativo: dos nombres casi iguales (el typo del Excel) con oids distintos.
      usuarioGraph(OID_GEMELO_A, 'Bayron Jimenez', 'test_rot_gemelo_a@fixture.local'),
      usuarioGraph(OID_GEMELO_B, 'Byron Jimenez', 'test_rot_gemelo_b@fixture.local'),
    ],
  },
  // Grupo vacío: es un hecho operativo, no un error.
  [`groups/${GRUPO_VACIO}`]: { value: [] },
  [`users/${OID_DEFAULT}`]: usuarioGraph(OID_DEFAULT, 'Persona Sin Rol', 'test_rot_sinrol@fixture.local'),
};

/** Transporte falso: rutea por URL y devuelve la captura. No hay red en ningún caso. */
function fetchFixture(url, opciones) {
  const responder = (cuerpo) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => cuerpo,
  });

  if (url.includes('/oauth2/v2.0/token')) {
    assert.equal(opciones.method, 'POST');
    return Promise.resolve(responder({ access_token: 'token-de-fixture', expires_in: 3600 }));
  }
  if (url.includes('/servicePrincipals?')) return Promise.resolve(responder(RESPUESTAS.servicePrincipals));
  if (url.includes('/appRoleAssignedTo')) return Promise.resolve(responder(RESPUESTAS.appRoleAssignedTo));

  for (const clave of Object.keys(RESPUESTAS)) {
    if (clave.startsWith('groups/') || clave.startsWith('users/')) {
      if (url.includes(`/${clave}`)) return Promise.resolve(responder(RESPUESTAS[clave]));
    }
  }
  return Promise.reject(new Error(`fixture sin ruta para ${url}`));
}

// ── Entorno ────────────────────────────────────────────────────────────────────────────────────
let envOriginal;
let pool;

function ponerCredencialesFixture() {
  process.env.M365_TENANT_ID = TENANT_FIXTURE;
  process.env.M365_CLIENT_ID = CLIENT_FIXTURE;
  process.env.M365_CLIENT_SECRET = 'secret-de-fixture';
  limpiarCacheToken();
}

async function limpiarFixture() {
  const req = pool.request();
  const marcadores = OIDS_FIXTURE.map((oid, i) => { req.input(`o${i}`, sql.VarChar(64), oid); return `@o${i}`; });
  // Acotado a los oids del fixture (GUIDs `...-d065-...`, inventados): no puede alcanzar una fila real.
  await req.query(`DELETE FROM lov_bit.usuario WHERE azure_oid IN (${marcadores.join(',')})`);
}

before(async () => {
  envOriginal = {
    tenant: process.env.M365_TENANT_ID,
    client: process.env.M365_CLIENT_ID,
    secret: process.env.M365_CLIENT_SECRET,
  };
  pool = await getDB();
  await limpiarFixture();
});

after(async () => {
  await limpiarFixture();
  // Este archivo no crea sesiones, pero la red de seguridad es barata y la exige la convención 28.
  await deactivateSyntheticSessions();
  process.env.M365_TENANT_ID = envOriginal.tenant;
  process.env.M365_CLIENT_ID = envOriginal.client;
  process.env.M365_CLIENT_SECRET = envOriginal.secret;
  limpiarCacheToken();
});

// ── CA-5 · leerDirectorioEntra ─────────────────────────────────────────────────────────────────
test('leerDirectorioEntra: arma personas y grupos, tolera el grupo vacío y el Default Access', async () => {
  ponerCredencialesFixture();
  const dir = await leerDirectorioEntra({ fetchImpl: fetchFixture });

  assert.equal(dir.grupos.length, 2, 'los dos grupos asignados, el vacío incluido');
  const vacio = dir.grupos.find((g) => g.nombre === 'GRUPO VACIO FIXTURE');
  assert.equal(vacio.miembros, 0, 'un grupo sin miembros se reporta en 0, no se omite ni rompe');
  assert.equal(vacio.role, 'COORDINADOR_CARBON_MAQUINARIA');

  assert.equal(dir.personas.length, 5, '4 del grupo JDT + 1 asignación directa');

  const sembrada = dir.personas.find((p) => p.azure_oid === OID_SEMBRADO);
  assert.equal(sembrada.role, 'JEFE_DE_TURNO');
  assert.equal(sembrada.cargo_nombre, 'Ingeniero Jefe de Turno', 'el cargo sale de ROLE_TO_CARGO');
  assert.equal(sembrada.upn, 'test_rot_sembrado@fixture.local');
  assert.equal(sembrada.activo, true);

  // El appRoleId huérfano = Default Access: aparece asignada pero no puede entrar (D-031).
  const sinRol = dir.personas.find((p) => p.azure_oid === OID_DEFAULT);
  assert.equal(sinRol.cargo_nombre, null, 'sin cargo mapeado → null, no un cargo inventado');
  assert.equal(typeof sinRol.role, 'string', 'role sigue siendo string aunque no mapee');

  // El ServicePrincipal asignado no es una persona.
  assert.equal(dir.personas.some((p) => p.upn === ''), false, 'no entró un principal sin UPN');
});

test('leerDirectorioEntra: sin credencial no llega a la red', async () => {
  delete process.env.M365_CLIENT_SECRET;
  limpiarCacheToken();
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl: () => assert.fail('no debió llamar a la red') }),
    (e) => e.codigo === 'entra_no_disponible',
  );
});

// ── CA-5 · sincronizarDirectorio ───────────────────────────────────────────────────────────────
test('sincronizarDirectorio: aprovisiona por azure_oid — la persona que ya existe no duplica', async () => {
  ponerCredencialesFixture();
  await limpiarFixture();

  // Se siembra UNA persona con azure_oid conocido, como si ya hubiera entrado por el login.
  await pool.request()
    .input('oid', sql.VarChar(64), OID_SEMBRADO)
    .input('username', sql.VarChar(50), USERNAME_SEMBRADO)
    .query(`
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, azure_oid, azure_upn,
         es_jefe_planta, es_jdt_default, activo, es_sintetico)
      VALUES ('Nombre Viejo', @username, NULL, NULL, @oid, 'viejo@fixture.local', 0, 0, 1, 1);
    `);

  // Directorio recortado al caso del CA: la sembrada + una nueva.
  const directorio = {
    personas: [
      { azure_oid: OID_SEMBRADO, nombre: 'Persona Sembrada', upn: 'test_rot_sembrado@fixture.local', activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: 'Ingeniero Jefe de Turno' },
      { azure_oid: OID_NUEVO, nombre: 'Persona Nueva', upn: 'test_rot_nueva@fixture.local', activo: true, role: 'OPERADOR_PLANTA_SDM', cargo_nombre: 'Operador de Planta - Sala de Mando' },
    ],
    grupos: [],
  };

  const r = await sincronizarDirectorio(pool, { por_usuario: 1, directorio });

  assert.equal(r.creados, 1, 'solo la persona nueva se crea');
  assert.equal(r.actualizados, 1, 'la sembrada se actualiza, no se re-crea');
  assert.equal(r.total, 2);
  assert.deepEqual(r.por_rol, { JEFE_DE_TURNO: 1, OPERADOR_PLANTA_SDM: 1 });

  const cuenta = await pool.request()
    .input('oid', sql.VarChar(64), OID_SEMBRADO)
    .query('SELECT COUNT(*) AS n FROM lov_bit.usuario WHERE azure_oid = @oid');
  assert.equal(cuenta.recordset[0].n, 1, 'el azure_oid sembrado sigue en UNA sola fila');

  // El MERGE actualizó los datos de identidad de la fila que ya existía, sin cambiar de fila.
  const fila = await pool.request()
    .input('oid', sql.VarChar(64), OID_SEMBRADO)
    .query('SELECT nombre_completo, username, azure_upn FROM lov_bit.usuario WHERE azure_oid = @oid');
  assert.equal(fila.recordset[0].nombre_completo, 'Persona Sembrada');
  assert.equal(fila.recordset[0].azure_upn, 'test_rot_sembrado@fixture.local');
  assert.equal(fila.recordset[0].username, USERNAME_SEMBRADO, 'el username existente no se pisa');

  // La nueva entra con su azure_oid, que es lo que hace que su primer login calce con esta fila.
  const nueva = await pool.request()
    .input('oid', sql.VarChar(64), OID_NUEVO)
    .query('SELECT username, azure_oid, activo FROM lov_bit.usuario WHERE azure_oid = @oid');
  assert.equal(nueva.recordset.length, 1);
  assert.equal(nueva.recordset[0].username, 'test_rot_nueva@fixture.local');
  assert.equal(nueva.recordset[0].activo, true);

  // Idempotencia: repetir la sincronización no crea nada.
  const r2 = await sincronizarDirectorio(pool, { por_usuario: 1, directorio });
  assert.equal(r2.creados, 0, 'la segunda corrida no crea filas');
  assert.equal(r2.actualizados, 2);
});

test('sincronizarDirectorio: dos nombres casi iguales con azure_oid distintos → DOS filas', async () => {
  ponerCredencialesFixture();
  await limpiarFixture();

  // El caso real: `Bayron`/`Byron` es uno de los typos del Excel. Un MERGE por nombre_completo los
  // fusionaría en una sola persona y la rotación asignaría el turno de uno al otro.
  const directorio = {
    personas: [
      { azure_oid: OID_GEMELO_A, nombre: 'Bayron Jimenez', upn: 'test_rot_gemelo_a@fixture.local', activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: 'Ingeniero Jefe de Turno' },
      { azure_oid: OID_GEMELO_B, nombre: 'Byron Jimenez', upn: 'test_rot_gemelo_b@fixture.local', activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: 'Ingeniero Jefe de Turno' },
    ],
    grupos: [],
  };

  const r = await sincronizarDirectorio(pool, { por_usuario: 1, directorio });
  assert.equal(r.creados, 2, 'dos personas distintas son dos altas');

  const req = pool.request()
    .input('a', sql.VarChar(64), OID_GEMELO_A)
    .input('b', sql.VarChar(64), OID_GEMELO_B);
  const filas = await req.query(
    'SELECT azure_oid, nombre_completo FROM lov_bit.usuario WHERE azure_oid IN (@a, @b)',
  );
  assert.equal(filas.recordset.length, 2, 'el match es por azure_oid, nunca por nombre');
  assert.equal(new Set(filas.recordset.map((f) => f.azure_oid)).size, 2);
});

test('sincronizarDirectorio: un UPN ya tomado por una fila legacy no rompe la transacción', async () => {
  ponerCredencialesFixture();
  await limpiarFixture();

  // Fila legacy SIN azure_oid que ya ocupa el username que el UPN produciría (el patrón de los 13
  // duplicados de prod, llevado al extremo). El alta debe caer al azure_oid como username en vez
  // de reventar la UNIQUE y tumbar la sincronización entera.
  const upnChocado = 'test_rot_choque@fixture.local';
  await pool.request()
    .input('username', sql.VarChar(50), upnChocado)
    .query(`
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo, es_sintetico)
      VALUES ('Legacy Sin Oid', @username, NULL, NULL, 0, 0, 1, 1);
    `);

  try {
    const r = await sincronizarDirectorio(pool, {
      por_usuario: 1,
      directorio: {
        personas: [
          { azure_oid: OID_NUEVO, nombre: 'Persona Con UPN Chocado', upn: upnChocado, activo: true, role: 'JEFE_DE_TURNO', cargo_nombre: 'Ingeniero Jefe de Turno' },
        ],
        grupos: [],
      },
    });
    assert.equal(r.creados, 1);

    const fila = await pool.request()
      .input('oid', sql.VarChar(64), OID_NUEVO)
      .query('SELECT username, azure_upn FROM lov_bit.usuario WHERE azure_oid = @oid');
    assert.equal(fila.recordset[0].username, OID_NUEVO, 'cayó al azure_oid como username');
    assert.equal(fila.recordset[0].azure_upn, upnChocado, 'el UPN sí queda registrado');

    // Y la fila legacy sigue intacta: este flujo no fusiona ni borra duplicados preexistentes.
    const legacy = await pool.request()
      .input('username', sql.VarChar(50), upnChocado)
      .query('SELECT azure_oid FROM lov_bit.usuario WHERE username = @username');
    assert.equal(legacy.recordset.length, 1);
    assert.equal(legacy.recordset[0].azure_oid, null);
  } finally {
    await pool.request()
      .input('username', sql.VarChar(50), upnChocado)
      .query('DELETE FROM lov_bit.usuario WHERE username = @username AND es_sintetico = 1');
  }
});

// ── CA-6 · degradación ─────────────────────────────────────────────────────────────────────────
test('degradación (a): sin M365_CLIENT_SECRET → entra_no_disponible', async () => {
  ponerCredencialesFixture();
  delete process.env.M365_CLIENT_SECRET;
  limpiarCacheToken();

  await assert.rejects(
    () => sincronizarDirectorio(pool, { por_usuario: 1 }),
    (e) => {
      assert.equal(e.codigo, 'entra_no_disponible');
      assert.match(e.message, /M365_CLIENT_SECRET/, 'nombra la variable que falta');
      return true;
    },
  );
});

test('degradación (b): el transporte lanza → entra_no_disponible, sin filtrar la URL', async () => {
  ponerCredencialesFixture();
  const explota = () => {
    const e = new TypeError('fetch failed');
    e.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
    throw e;
  };
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl: explota }),
    (e) => {
      assert.equal(e.codigo, 'entra_no_disponible');
      // La causa (que es lo que ops necesita) sí; el mensaje crudo del fetch no.
      assert.match(e.message, /SELF_SIGNED_CERT_IN_CHAIN/);
      assert.doesNotMatch(e.message, /login\.microsoftonline|graph\.microsoft/);
      return true;
    },
  );
});

test('degradación (b bis): Graph responde 500 → entra_no_disponible', async () => {
  ponerCredencialesFixture();
  const quinientos = (url) => {
    if (url.includes('/oauth2/v2.0/token')) return fetchFixture(url, { method: 'POST' });
    return Promise.resolve({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ error: { message: 'boom' } }),
    });
  };
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl: quinientos }),
    (e) => e.codigo === 'entra_no_disponible' && /HTTP 500/.test(e.message),
  );
});

test('degradación (b ter): el token responde 401 → entra_no_disponible', async () => {
  ponerCredencialesFixture();
  const noAutorizado = () => Promise.resolve({
    ok: false, status: 401, headers: new Headers(), json: async () => ({}),
  });
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl: noAutorizado }),
    (e) => e.codigo === 'entra_no_disponible' && /token: HTTP 401/.test(e.message),
  );
});

test('degradación (c): tras el fallo de Graph el server sigue vivo — GET /health responde 200', async () => {
  ponerCredencialesFixture();
  await assert.rejects(
    () => leerDirectorioEntra({ fetchImpl: () => Promise.reject(new Error('red caída')) }),
    (e) => e.codigo === 'entra_no_disponible',
  );

  const res = await fetch(`${BASE_URL}/health`);
  assert.equal(res.status, 200, 'un fallo de Graph no tumba el backend');
});

test('el token se cachea: dos lecturas seguidas piden UN solo token', async () => {
  ponerCredencialesFixture();
  let tokens = 0;
  const contando = (url, opciones) => {
    if (url.includes('/oauth2/v2.0/token')) tokens++;
    return fetchFixture(url, opciones);
  };
  await leerDirectorioEntra({ fetchImpl: contando });
  await leerDirectorioEntra({ fetchImpl: contando });
  assert.equal(tokens, 1, 'el segundo directorio reusa el token cacheado');
});
