// D-065 L04 — CA-7, CA-8, CA-9 y D3 del GATE-O1: endpoints de configuración anual de la rotación.
//
// Corre contra un backend efímero (TEST_BASE_URL, puerto 3114) con AUTH_TEST_BYPASS=1. Todo lo que
// siembra es sintético y se identifica sin ambigüedad:
//   · tres cuentas `test_rot_l04_{jdt,gerente,admin}` con es_sintetico = 1 y azure_oid de fixture
//     (00000000-d065-4004-…), cada una con su sesión de app sobre la planta-fixture 'TST' (D-055):
//     un Ingeniero Jefe de Turno (flag en 0), un Gerente de Producción (flag en 1 Y solo_lectura en 1,
//     el caso que demuestra que el gate no mira solo_lectura) y un Administrador (flag en 1);
//   · ocho personas `test_rot_l04_p1..p8` con azure_oid de fixture, una por grupo y por malla;
//   · una persona SIN azure_oid, para el rechazo `usuario_invalido`.
// Los patrones y asignaciones que crea llevan `creado_por` = una cuenta de fixture, y por ahí se
// limpian (before() y after()): nunca por cargo ni por fecha, que alcanzarían filas ajenas.
//
// La sincronización con Entra se prueba SOLO en su camino de degradación (503). El camino feliz
// pegaría contra Graph de verdad y escribiría ~80 personas reales en lov_bit.usuario (H9 del
// GATE-O1), un residuo que ninguna limpieza puede acotar. Ese caso exige que el backend Y este
// proceso corran sin M365_CLIENT_SECRET; si la variable está puesta, el test FALLA a propósito con
// el comando exacto en vez de saltarse en silencio (mismo criterio que sis_scrape_endpoint, CA-53).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { initDB, getDB } from '../db.js';
import { TEST_PLANTA, call, cleanupTestRegistros, deactivateSyntheticSessions } from './helpers.js';
import { loadSession } from '../middleware/auth.js';
import { establecerContextoSesion } from '../utils/sesion-contexto.js';
import { entraConfigurado } from '../utils/graph/cliente.js';
import { getTurnoColombia } from '../utils/turno.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';
const ORACULO = JSON.parse(readFileSync(new URL('./fixtures/rotacion-oraculo-2026.json', import.meta.url), 'utf8'));

const CARGO_POR_MALLA = { OPS: 'Operador de Planta - Sala de Mando', ING: 'Ingeniero de Operación' };

// CR2-5 (GATE-O2 → L12): la ventana del patrón-fixture TERMINA EN EL PASADO. El oráculo cubre
// 2026-02-01 → 2027-01-31, o sea que el patrón que esta suite cargaba estaba ACTIVO HOY sobre dos
// cargos REALES (Operador de Planta - Sala de Mando e Ingeniero de Operación). Mientras tanto el
// turno-sweeper del backend efímero cierra GEC3/GEC32 (deuda D4 del GATE-O1: no mira
// AUTH_TEST_BYPASS) y cada cierre congela cumplimiento; `titularesDeTurno` NO filtra por planta
// (R3), así que esas ocho personas de fixture podían quedar congeladas como titulares en el
// histórico de una planta real — y el `after()` las borra después, dejando la fila apuntando a
// usuarios que ya no existen (es lo que caza el check de `residuos.js`).
// Recortar el periodo NO debilita CA-7: el oráculo se sigue reproduciendo día por día, solo que
// sobre los cinco meses que caben dentro de la ventana. La muestra de abajo se ajusta para que
// sigan siendo ≥ 16 fechas. `rotacion_correcciones_o2.test.js` verifica que esta fecha siga siendo
// pasada.
const PERIODO = { inicio: '2026-02-01', fin: '2026-06-30' };
// Un periodo LIBRE (sin patrón) para los casos que solo ejercitan validación: también en el pasado,
// para que un rechazo que algún día dejara de rechazar no siembre un patrón vigente.
const PERIODO_LIBRE = { inicio: '2025-02-01', fin: '2025-12-31' };
const FECHAS = Object.keys(ORACULO.dias.OPS).sort().filter((f) => f <= PERIODO.fin);
const FECHA_ABIERTA = '9999-12-31';

const OID = (n) => `00000000-d065-4004-8000-${String(n).padStart(12, '0')}`;
const CUENTAS = {
  jdt:     { username: 'test_rot_l04_jdt',     nombre: 'Test Rot L04 JdT',     cargo: 'Ingeniero Jefe de Turno',   oid: OID(1) },
  gerente: { username: 'test_rot_l04_gerente', nombre: 'Test Rot L04 Gerente', cargo: 'Gerente de Producción',     oid: OID(2) },
  admin:   { username: 'test_rot_l04_admin',   nombre: 'Test Rot L04 Admin',   cargo: 'Administrador y Debugging', oid: OID(3) },
};
const SIN_OID = { username: 'test_rot_l04_sinoid', nombre: 'Test Rot L04 Sin Oid' };

let db;
const ses = {};      // sesion_id por cuenta
const uid = {};      // usuario_id por cuenta
const cargoId = {};  // cargo_id por clave: ops, ing, jdt, gerente, admin
const personas = []; // { usuario_id, nombre, malla, grupo }
let usuarioSinOid;
let patronOpsId;

const cuerpoPatron = (malla, { inicio = PERIODO.inicio, fin = PERIODO.fin, comoTexto = false } = {}) => {
  const p = ORACULO.patrones[malla];
  const [grupo_t1, grupo_t2] = ORACULO.dias[malla][inicio] ?? [p.vector_t1[0], p.vector_t2[0]];
  return {
    cargo_id: cargoId[malla.toLowerCase()],
    fecha_inicio: inicio,
    fecha_fin: fin,
    vector_t1: comoTexto ? p.vector_t1.join(',') : p.vector_t1,
    vector_t2: comoTexto ? p.vector_t2.join(',') : p.vector_t2,
    grupo_t1,
    grupo_t2,
  };
};

const asignacion = (p, extra = {}) => ({
  usuario_id: p.usuario_id, cargo_id: cargoId[p.malla.toLowerCase()], grupo: p.grupo, vigente_desde: PERIODO.inicio, ...extra,
});

const persona = (malla, grupo) => personas.find((p) => p.malla === malla && p.grupo === grupo);
const idsOrdenados = (lista) => lista.map((x) => x.usuario_id).sort((a, b) => a - b);

async function filasDe(usuario_id) {
  const r = await db.request().input('u', sql.Int, usuario_id).query(`
    SELECT rotacion_asignacion_id, usuario_id, cargo_id, grupo,
           CONVERT(VARCHAR(10), vigente_desde, 23) AS vigente_desde,
           CONVERT(VARCHAR(10), vigente_hasta, 23) AS vigente_hasta
    FROM bitacora.rotacion_asignacion WHERE usuario_id = @u ORDER BY vigente_desde
  `);
  return r.recordset;
}

async function titulares(query, sesion_id = ses.jdt) {
  const r = await call('GET', `/api/rotacion/titulares?${query}`, { sesion_id });
  assert.equal(r.status, 200, `${query} → ${JSON.stringify(r.data)}`);
  return r.data;
}

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
async function limpiarFixture() {
  await db.request().query(`
    DECLARE @u TABLE (usuario_id INT PRIMARY KEY);
    INSERT INTO @u
      SELECT usuario_id FROM lov_bit.usuario
       WHERE username LIKE 'test\\_rot\\_l04\\_%' ESCAPE '\\' OR azure_oid LIKE '00000000-d065-4004-%';
    DELETE FROM bitacora.rotacion_asignacion
      WHERE usuario_id IN (SELECT usuario_id FROM @u) OR creado_por IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.rotacion_patron    WHERE creado_por IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.turno_participante WHERE usuario_id IN (SELECT usuario_id FROM @u);
    DELETE FROM bitacora.sesion_activa      WHERE usuario_id IN (SELECT usuario_id FROM @u);
    DELETE FROM lov_bit.usuario             WHERE usuario_id IN (SELECT usuario_id FROM @u);
  `);
}

async function crearUsuario({ username, nombre, oid = null }) {
  // es_sintetico = 1 explícito (no heredado del barrido de initDB) para que el guard de sesiones
  // colgadas lo alcance aunque la corrida aborte a mitad (mismo criterio que setupSesionReflejo).
  const r = await db.request()
    .input('nombre', sql.VarChar(200), nombre)
    .input('username', sql.VarChar(50), username)
    .input('oid', sql.VarChar(64), oid)
    .query(`
      INSERT INTO lov_bit.usuario
        (nombre_completo, username, email, password_hash, azure_oid, azure_tid,
         es_jefe_planta, es_jdt_default, activo, es_sintetico)
      OUTPUT INSERTED.usuario_id
      VALUES (@nombre, @username, NULL, NULL, @oid, NULL, 0, 0, 1, 1)
    `);
  return r.recordset[0].usuario_id;
}

async function crearSesion(usuario_id, cargo_id) {
  const r = await db.request()
    .input('usuario_id', sql.Int, usuario_id)
    .input('planta_id', sql.VarChar(10), TEST_PLANTA)
    .input('cargo_id', sql.Int, cargo_id)
    .input('turno', sql.TinyInt, getTurnoColombia())
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);
  return r.recordset[0].sesion_id;
}

before(async () => {
  await initDB();
  db = await getDB();
  await limpiarFixture();

  await db.request().input('planta', sql.VarChar(10), TEST_PLANTA).query(`
    MERGE lov_bit.planta AS t USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
    WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
  `);

  const cargos = await db.request().query(`
    SELECT cargo_id, nombre, CAST(puede_configurar_rotacion AS BIT) AS flag, CAST(solo_lectura AS BIT) AS solo_lectura
    FROM lov_bit.cargo
  `);
  const porNombre = Object.fromEntries(cargos.recordset.map((c) => [c.nombre, c]));
  cargoId.ops = porNombre[CARGO_POR_MALLA.OPS].cargo_id;
  cargoId.ing = porNombre[CARGO_POR_MALLA.ING].cargo_id;
  for (const [clave, cuenta] of Object.entries(CUENTAS)) cargoId[clave] = porNombre[cuenta.cargo].cargo_id;
  // Premisas del seed (F37.A2, CA-4): si cambian, lo que sigue no prueba lo que dice probar.
  assert.equal(porNombre[CUENTAS.jdt.cargo].flag, false);
  assert.equal(porNombre[CUENTAS.gerente.cargo].flag, true);
  assert.equal(porNombre[CUENTAS.gerente.cargo].solo_lectura, true);
  assert.equal(porNombre[CUENTAS.admin.cargo].flag, true);

  for (const [clave, cuenta] of Object.entries(CUENTAS)) {
    uid[clave] = await crearUsuario(cuenta);
    ses[clave] = await crearSesion(uid[clave], cargoId[clave]);
  }
  let n = 0;
  for (const malla of ['OPS', 'ING']) {
    for (const grupo of [1, 2, 3, 4]) {
      n += 1;
      const nombre = `Test Rot L04 Persona ${n}`;
      const usuario_id = await crearUsuario({ username: `test_rot_l04_p${n}`, nombre, oid: OID(10 + n) });
      personas.push({ usuario_id, nombre, malla, grupo });
    }
  }
  usuarioSinOid = await crearUsuario(SIN_OID);
});

after(async () => {
  await limpiarFixture();
  // establecerContextoSesion (caso D3) puede abrir la cabecera turno_unidad de 'TST'; el barrido
  // estándar la borra cuando queda sin dependientes.
  await cleanupTestRegistros();
  await deactivateSyntheticSessions();
});

// ── D3 · el flag llega a la sesión por los dos SELECT espejo ───────────────────────────────────
test('D3 · puede_configurar_rotacion viaja en la sesión por SELECT_SESION y por su espejo de sesion-contexto', async () => {
  // bypassHabilitado() lee process.env en cada llamada; NODE_ENV no es production en el harness.
  process.env.AUTH_TEST_BYPASS = '1';
  const gerente = await loadSession({ headers: { 'x-sesion-id': String(ses.gerente) } });
  assert.equal(gerente.puede_configurar_rotacion, true);
  assert.equal(gerente.solo_lectura, true, 'el Gerente conserva solo_lectura = 1 (CA-4)');
  const jdt = await loadSession({ headers: { 'x-sesion-id': String(ses.jdt) } });
  assert.equal(jdt.puede_configurar_rotacion, false, 'false, nunca undefined');

  // El espejo: es lo que select-context / cambiar-unidad devuelven al front (D-054).
  const filaGerente = await establecerContextoSesion(db, {
    usuario_id: uid.gerente, planta_id: TEST_PLANTA, cargo_id: cargoId.gerente, cargo_nombre: CUENTAS.gerente.cargo,
  });
  assert.equal(filaGerente.puede_configurar_rotacion, true);
  assert.equal(filaGerente.sesion_id, ses.gerente, 'reactiva la misma sesión (misma unidad y cargo)');
  const filaJdt = await establecerContextoSesion(db, {
    usuario_id: uid.jdt, planta_id: TEST_PLANTA, cargo_id: cargoId.jdt, cargo_nombre: CUENTAS.jdt.cargo,
  });
  assert.equal(filaJdt.puede_configurar_rotacion, false);
  assert.equal(filaJdt.sesion_id, ses.jdt);

  // Los dos espejos proyectan el MISMO conjunto de flags de cargo.
  const flags = (s) => Object.keys(s).filter((k) => /^(puede_|es_observador|solo_lectura)/.test(k)).sort();
  assert.deepEqual(flags(filaGerente), flags(gerente));
  assert.ok(flags(gerente).includes('puede_configurar_rotacion'));
});

// ── CA-8 · gate data-driven ────────────────────────────────────────────────────────────────────
test('CA-8 · gate: un Ingeniero Jefe de Turno recibe 403 rotacion_no_autorizado en los tres POST', async () => {
  const casos = [
    ['/api/rotacion/patrones', cuerpoPatron('OPS')],
    ['/api/rotacion/asignaciones', { asignaciones: [asignacion(persona('OPS', 1))] }],
    ['/api/rotacion/sincronizar-entra', {}],
  ];
  for (const [path, body] of casos) {
    const r = await call('POST', path, { sesion_id: ses.jdt, body });
    assert.equal(r.status, 403, `${path} → ${JSON.stringify(r.data)}`);
    assert.equal(r.data.codigo, 'rotacion_no_autorizado');
    assert.equal(r.data.error, 'rotacion_no_autorizado');
    assert.equal(typeof r.data.mensaje, 'string');
  }
  const n = await db.request().input('u', sql.Int, uid.jdt).query(`
    SELECT (SELECT COUNT(*) FROM bitacora.rotacion_patron     WHERE creado_por = @u)
         + (SELECT COUNT(*) FROM bitacora.rotacion_asignacion WHERE creado_por = @u) AS n
  `);
  assert.equal(n.recordset[0].n, 0, 'el 403 no escribió nada');
  // Los GET no llevan gate: cualquier sesión consulta.
  const g = await call('GET', '/api/rotacion/patrones', { sesion_id: ses.jdt });
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.data.patrones));
});

test('CA-8 · gate: el Gerente de Producción (solo_lectura = 1) crea el patrón OPS y sus asignaciones → 200', async () => {
  const r = await call('POST', '/api/rotacion/patrones', { sesion_id: ses.gerente, body: cuerpoPatron('OPS') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { patron } = r.data;
  assert.equal(patron.cargo_id, cargoId.ops);
  assert.equal(patron.cargo_nombre, CARGO_POR_MALLA.OPS);
  assert.equal(patron.desfase, ORACULO.patrones.OPS.desfase, 'el desfase se DERIVA y coincide con el medido en el Excel');
  assert.deepEqual(patron.vector_t1, ORACULO.patrones.OPS.vector_t1);
  assert.deepEqual(patron.vector_t2, ORACULO.patrones.OPS.vector_t2);
  assert.deepEqual([patron.grupo_t1, patron.grupo_t2], ORACULO.dias.OPS[PERIODO.inicio]);
  assert.equal(patron.fecha_inicio, PERIODO.inicio);
  assert.equal(patron.fecha_fin, PERIODO.fin);
  assert.equal(patron.activo, true);
  assert.equal(patron.creado_por, uid.gerente);
  patronOpsId = patron.rotacion_patron_id;

  const a = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente,
    body: { asignaciones: personas.filter((p) => p.malla === 'OPS').map((p) => asignacion(p)) },
  });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data, { creadas: 4, cerradas: 0, actualizadas: 0, sin_cambio: 0, total: 4 });
});

test('POST /patrones · el Administrador crea el patrón ING (vectores como texto); desfase y ancla del cliente se ignoran', async () => {
  const r = await call('POST', '/api/rotacion/patrones', {
    sesion_id: ses.admin,
    body: { ...cuerpoPatron('ING', { comoTexto: true }), desfase: 7, ancla: '2020-01-01' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.patron.desfase, ORACULO.patrones.ING.desfase, 'derivado (2), no el 7 que mandó el cliente');
  const fila = await db.request().input('id', sql.Int, r.data.patron.rotacion_patron_id)
    .query('SELECT desfase, vector_t1, vector_t2 FROM bitacora.rotacion_patron WHERE rotacion_patron_id = @id');
  assert.equal(fila.recordset[0].desfase, ORACULO.patrones.ING.desfase);
  assert.equal(fila.recordset[0].vector_t1, ORACULO.patrones.ING.vector_t1.join(','));
  assert.equal(fila.recordset[0].vector_t2, ORACULO.patrones.ING.vector_t2.join(','));

  const a = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.admin,
    body: { asignaciones: personas.filter((p) => p.malla === 'ING').map((p) => asignacion(p)) },
  });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.creadas, 4);
});

test('POST /patrones · validaciones: códigos del motor y de entrada → 400; duplicado y solapado → 409', async () => {
  const ops = ORACULO.patrones.OPS;
  const libre = PERIODO_LIBRE; // periodo sin patrón (y pasado): solo debe fallar la validación
  const casos = [
    ['desfase_ambiguo',   { ...cuerpoPatron('OPS', libre), vector_t2: ops.vector_t1, grupo_t1: 1, grupo_t2: 1 }],
    ['desfase_imposible', { ...cuerpoPatron('OPS', libre), grupo_t1: 1, grupo_t2: 3 }],
    ['grupo_invalido',    { ...cuerpoPatron('OPS', libre), grupo_t1: '3' }],
    ['grupo_invalido',    { ...cuerpoPatron('OPS', libre), grupo_t2: 9 }],
    ['fecha_invalida',    { ...cuerpoPatron('OPS', libre), fecha_inicio: '2025-02-30' }],
    ['fecha_invalida',    { ...cuerpoPatron('OPS', libre), fecha_fin: '2025-12-31T00:00' }],
    ['rango_invalido',    { ...cuerpoPatron('OPS', libre), fecha_inicio: '2025-12-31', fecha_fin: '2025-02-01' }],
    ['vector_invalido',   { ...cuerpoPatron('OPS', libre), vector_t1: '1,2,3' }],
    ['vector_invalido',   { ...cuerpoPatron('OPS', libre), vector_t2: [0, 1, 1, 1, 1, 1, 1, 1] }],
    ['cargo_invalido',    { ...cuerpoPatron('OPS', libre), cargo_id: 'x' }],
    ['cargo_invalido',    { ...cuerpoPatron('OPS', libre), cargo_id: 999999 }],
  ];
  for (const [codigo, body] of casos) {
    const r = await call('POST', '/api/rotacion/patrones', { sesion_id: ses.gerente, body });
    assert.equal(r.status, 400, `${codigo}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.codigo, codigo);
    assert.equal(typeof r.data.mensaje, 'string');
  }

  // Mismo cargo, misma fecha de inicio → 409 patron_duplicado (UQ_rotacion_patron_natural, sin 500).
  const dup = await call('POST', '/api/rotacion/patrones', {
    sesion_id: ses.gerente, body: cuerpoPatron('OPS', { inicio: PERIODO.inicio, fin: '2026-05-31' }),
  });
  assert.equal(dup.status, 409, JSON.stringify(dup.data));
  assert.equal(dup.data.codigo, 'patron_duplicado');
  assert.equal(dup.data.patron_id, patronOpsId);

  // Mismo cargo, periodo que pisa al activo → 409 patron_solapado.
  const sol = await call('POST', '/api/rotacion/patrones', {
    sesion_id: ses.gerente, body: cuerpoPatron('OPS', { inicio: '2026-05-01', fin: '2026-06-15' }),
  });
  assert.equal(sol.status, 409, JSON.stringify(sol.data));
  assert.equal(sol.data.codigo, 'patron_solapado');
  assert.equal(sol.data.patron_id, patronOpsId);

  const n = await db.request().input('u', sql.Int, uid.gerente)
    .query('SELECT COUNT(*) AS n FROM bitacora.rotacion_patron WHERE creado_por = @u');
  assert.equal(n.recordset[0].n, 1, 'ningún rechazo insertó');
});

test('GET /patrones · lista con vectores como arreglos y filtra por cargo_id', async () => {
  const todos = await call('GET', '/api/rotacion/patrones', { sesion_id: ses.jdt });
  assert.equal(todos.status, 200);
  const mios = todos.data.patrones.filter((p) => [uid.gerente, uid.admin].includes(p.creado_por));
  assert.equal(mios.length, 2);
  for (const p of mios) {
    assert.ok(Array.isArray(p.vector_t1) && p.vector_t1.length === 8);
    assert.ok(Array.isArray(p.vector_t2) && p.vector_t2.length === 8);
    assert.match(p.fecha_inicio, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof p.creado_por_nombre, 'string');
  }
  const ops = await call('GET', `/api/rotacion/patrones?cargo_id=${cargoId.ops}`, { sesion_id: ses.jdt });
  assert.equal(ops.status, 200);
  assert.ok(ops.data.patrones.every((p) => p.cargo_id === cargoId.ops));
  assert.ok(ops.data.patrones.some((p) => p.rotacion_patron_id === patronOpsId));
  const malo = await call('GET', '/api/rotacion/patrones?cargo_id=abc', { sesion_id: ses.jdt });
  assert.equal(malo.status, 400);
  assert.equal(malo.data.codigo, 'cargo_invalido');
});

// ── CA-7 · titulares contra el oráculo ─────────────────────────────────────────────────────────
test('CA-7 · GET /titulares reproduce el oráculo del Excel (20 fechas × 2 turnos, mallas OPS e ING) sin consultar el Excel', async () => {
  // Los 8 primeros días (un ciclo completo) más una fecha cada 12 días hasta el fin del periodo.
  const muestra = [...FECHAS.slice(0, 8), ...FECHAS.filter((_, i) => i >= 8 && i % 12 === 0)];
  assert.ok(muestra.length >= 16, `muestra de ${muestra.length} fechas`);
  let pares = 0;
  for (const fecha of muestra) {
    for (const turno of [1, 2]) {
      const data = await titulares(`fecha=${fecha}&turno=${turno}&planta_id=GEC3`);
      assert.equal(data.fecha, fecha);
      assert.equal(data.turno, turno);
      for (const malla of ['OPS', 'ING']) {
        const entrada = data.titulares.find((t) => t.cargo_id === cargoId[malla.toLowerCase()]);
        assert.ok(entrada, `${malla} ${fecha} T${turno}: el rol con patrón activo aparece`);
        const esperado = ORACULO.dias[malla][fecha][turno - 1];
        assert.equal(entrada.grupo, esperado, `${malla} ${fecha} T${turno}: grupo`);
        assert.equal(entrada.cargo_nombre, CARGO_POR_MALLA[malla]);
        const titular = persona(malla, esperado);
        assert.deepEqual(entrada.personas, [{ usuario_id: titular.usuario_id, nombre: titular.nombre }], `${malla} ${fecha} T${turno}: titular`);
      }
      pares += 1;
    }
  }
  assert.equal(pares, muestra.length * 2);

  // Fuera del periodo no hay patrón activo: los dos roles desaparecen del arreglo (C4).
  for (const fuera of ['2026-01-31', '2026-07-01']) {
    const data = await titulares(`fecha=${fuera}&turno=1`);
    assert.equal(data.titulares.filter((t) => [cargoId.ops, cargoId.ing].includes(t.cargo_id)).length, 0, fuera);
  }
});

test('GET /titulares · planta_id no altera el resultado (R3); cargo_id filtra; turno y fecha inválidos → 400', async () => {
  const fecha = FECHAS[10];
  const gec3 = await titulares(`fecha=${fecha}&turno=2&planta_id=GEC3`);
  const gec32 = await titulares(`fecha=${fecha}&turno=2&planta_id=GEC32`);
  const sinPlanta = await titulares(`fecha=${fecha}&turno=2`);
  assert.deepEqual(gec32.titulares, gec3.titulares);
  assert.deepEqual(sinPlanta.titulares, gec3.titulares);
  assert.equal(gec3.planta_id, 'GEC3');
  assert.equal(gec32.planta_id, 'GEC32');
  assert.equal(sinPlanta.planta_id, TEST_PLANTA, 'sin planta_id devuelve la de la sesión');

  const solo = await titulares(`fecha=${fecha}&turno=2&cargo_id=${cargoId.ops}`);
  assert.equal(solo.titulares.length, 1);
  assert.equal(solo.titulares[0].cargo_id, cargoId.ops);

  // Sin fecha ni turno: el turno en curso.
  const actual = await call('GET', '/api/rotacion/titulares', { sesion_id: ses.jdt });
  assert.equal(actual.status, 200);
  assert.match(actual.data.fecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok([1, 2].includes(actual.data.turno));

  for (const [query, codigo] of [
    [`fecha=${fecha}&turno=3`, 'turno_invalido'],
    [`fecha=${fecha}&turno=x`, 'turno_invalido'],
    ['fecha=2026-02-30&turno=1', 'fecha_invalida'],
    ['fecha=hoy&turno=1', 'fecha_invalida'],
    [`fecha=${fecha}&turno=1&cargo_id=0`, 'cargo_invalido'],
  ]) {
    const r = await call('GET', `/api/rotacion/titulares?${query}`, { sesion_id: ses.jdt });
    assert.equal(r.status, 400, query);
    assert.equal(r.data.codigo, codigo, query);
  }
});

// ── GET /asignaciones ──────────────────────────────────────────────────────────────────────────
test('GET /asignaciones · vigentes por fecha, filtro por cargo y nómina `personas`', async () => {
  const mios = new Set(personas.map((p) => p.usuario_id));
  const r = await call('GET', '/api/rotacion/asignaciones?fecha=2026-06-01', { sesion_id: ses.jdt });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fecha, '2026-06-01');
  const vigentes = r.data.asignaciones.filter((a) => mios.has(a.usuario_id));
  assert.equal(vigentes.length, 8);
  for (const a of vigentes) {
    assert.equal(a.vigente_desde, PERIODO.inicio);
    assert.equal(a.vigente_hasta, FECHA_ABIERTA, 'sin vigente_hasta → vigencia abierta');
    assert.equal(typeof a.cargo_nombre, 'string');
    assert.equal(typeof a.nombre, 'string');
  }

  const ops = await call('GET', `/api/rotacion/asignaciones?fecha=2026-06-01&cargo_id=${cargoId.ops}`, { sesion_id: ses.jdt });
  assert.equal(ops.status, 200);
  assert.equal(ops.data.asignaciones.filter((a) => mios.has(a.usuario_id)).length, 4);
  assert.ok(ops.data.asignaciones.every((a) => a.cargo_id === cargoId.ops));

  const antes = await call('GET', '/api/rotacion/asignaciones?fecha=2026-01-31', { sesion_id: ses.jdt });
  assert.equal(antes.data.asignaciones.filter((a) => mios.has(a.usuario_id)).length, 0, 'antes del periodo nadie está vigente');

  // Nómina: solo filas con azure_oid; trae el último cargo con el que entró y la asignación vigente.
  const nomina = r.data.personas;
  assert.ok(!nomina.some((p) => p.usuario_id === usuarioSinOid), 'sin azure_oid no se puede asignar');
  for (const p of personas) {
    const fila = nomina.find((n) => n.usuario_id === p.usuario_id);
    assert.ok(fila, `${p.nombre} está en la nómina`);
    assert.equal(fila.grupo, p.grupo);
    assert.equal(fila.asignacion_cargo_id, cargoId[p.malla.toLowerCase()]);
    assert.equal(fila.ultimo_cargo_id, null, 'nunca ha iniciado sesión');
  }
  const jdt = nomina.find((n) => n.usuario_id === uid.jdt);
  assert.equal(jdt.ultimo_cargo_nombre, CUENTAS.jdt.cargo);
  assert.equal(jdt.grupo, null);
});

// ── CA-9 · relevo ──────────────────────────────────────────────────────────────────────────────
test('CA-9 · relevo: cierra la vigencia anterior e inserta una nueva; el titular de una fecha pasada no cambia', async () => {
  const p1 = persona('OPS', 1);
  const fechaG1 = FECHAS.find((f) => ORACULO.dias.OPS[f][0] === 1); // primer día con el grupo 1 en T1
  assert.ok(fechaG1 < '2026-03-01', fechaG1);

  const antes = await titulares(`fecha=${fechaG1}&turno=1&cargo_id=${cargoId.ops}`);
  assert.deepEqual(idsOrdenados(antes.titulares[0].personas), [p1.usuario_id]);
  const filasAntes = await filasDe(p1.usuario_id);
  assert.equal(filasAntes.length, 1);

  const r = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente,
    body: { asignaciones: [asignacion(p1, { grupo: 2, vigente_desde: '2026-03-01' })] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { creadas: 1, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });

  const despues = await titulares(`fecha=${fechaG1}&turno=1&cargo_id=${cargoId.ops}`);
  assert.deepEqual(despues.titulares, antes.titulares, 'el titular de la fecha pasada es el mismo');

  const filas = await filasDe(p1.usuario_id);
  assert.equal(filas.length, filasAntes.length + 1, 'COUNT(*) sube en 1');
  assert.equal(filas[0].rotacion_asignacion_id, filasAntes[0].rotacion_asignacion_id, 'la fila anterior sigue siendo la misma');
  assert.equal(filas[0].grupo, 1, 'su grupo no se reescribió');
  assert.equal(filas[0].usuario_id, p1.usuario_id);
  assert.equal(filas[0].vigente_desde, PERIODO.inicio);
  assert.equal(filas[0].vigente_hasta, '2026-02-28', 'solo se movió el fin de la vigencia');
  assert.deepEqual([filas[1].grupo, filas[1].vigente_desde, filas[1].vigente_hasta], [2, '2026-03-01', FECHA_ABIERTA]);

  // Desde el relevo: p1 acompaña al grupo 2 y ya no cubre al grupo 1.
  const fechaG2 = FECHAS.find((f) => f >= '2026-03-01' && ORACULO.dias.OPS[f][0] === 2);
  const fechaG1b = FECHAS.find((f) => f >= '2026-03-01' && ORACULO.dias.OPS[f][0] === 1);
  const conG2 = await titulares(`fecha=${fechaG2}&turno=1&cargo_id=${cargoId.ops}`);
  assert.deepEqual(idsOrdenados(conG2.titulares[0].personas), idsOrdenados([p1, persona('OPS', 2)]));
  const conG1 = await titulares(`fecha=${fechaG1b}&turno=1&cargo_id=${cargoId.ops}`);
  assert.deepEqual(conG1.titulares[0].personas, [], 'el grupo 1 quedó sin titular: el rol sigue apareciendo, con personas vacías');
});

test('POST /asignaciones · recarga idéntica = sin_cambio; corrección el mismo día = actualizadas; grupo null = cerradas', async () => {
  const p2 = persona('OPS', 2);
  const p3 = persona('OPS', 3);
  const p4 = persona('OPS', 4);
  const p8 = persona('ING', 4);

  // Recargar el lote anual con la misma nómina no infla la tabla.
  const igual = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente,
    body: { asignaciones: [asignacion(p2), asignacion(p3, { vigente_desde: '2026-05-01' })] },
  });
  assert.equal(igual.status, 200, JSON.stringify(igual.data));
  assert.deepEqual(igual.data, { creadas: 0, cerradas: 0, actualizadas: 0, sin_cambio: 2, total: 2 });
  assert.equal((await filasDe(p2.usuario_id)).length, 1);
  assert.equal((await filasDe(p3.usuario_id)).length, 1);

  // Error de digitación del día de carga: misma fecha de inicio → se corrige en sitio, sin fila nueva.
  const corr = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente, body: { asignaciones: [asignacion(p4, { grupo: 3 })] },
  });
  assert.equal(corr.status, 200, JSON.stringify(corr.data));
  assert.deepEqual(corr.data, { creadas: 0, cerradas: 0, actualizadas: 1, sin_cambio: 0, total: 1 });
  const filasP4 = await filasDe(p4.usuario_id);
  assert.equal(filasP4.length, 1);
  assert.equal(filasP4[0].grupo, 3);

  // Salida de la rotación: cierra la vigencia y no inserta.
  const salida = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente, body: { asignaciones: [asignacion(p8, { grupo: null, vigente_desde: '2026-04-01' })] },
  });
  assert.equal(salida.status, 200, JSON.stringify(salida.data));
  assert.deepEqual(salida.data, { creadas: 0, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });
  const filasP8 = await filasDe(p8.usuario_id);
  assert.equal(filasP8.length, 1);
  assert.equal(filasP8[0].vigente_hasta, '2026-03-31');
  const fechaIng4Antes = FECHAS.find((f) => f < '2026-04-01' && ORACULO.dias.ING[f][0] === 4);
  const fechaIng4Despues = FECHAS.find((f) => f >= '2026-04-01' && ORACULO.dias.ING[f][0] === 4);
  assert.deepEqual(idsOrdenados((await titulares(`fecha=${fechaIng4Antes}&turno=1&cargo_id=${cargoId.ing}`)).titulares[0].personas), [p8.usuario_id]);
  assert.deepEqual((await titulares(`fecha=${fechaIng4Despues}&turno=1&cargo_id=${cargoId.ing}`)).titulares[0].personas, []);
  // Salir otra vez no cierra nada.
  const nada = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente, body: { asignaciones: [asignacion(p8, { grupo: null, vigente_desde: '2026-05-01' })] },
  });
  assert.deepEqual(nada.data, { creadas: 0, cerradas: 0, actualizadas: 0, sin_cambio: 1, total: 1 });
});

test('POST /asignaciones · lote atómico: un elemento inválido deshace el lote entero, con su índice', async () => {
  const p5 = persona('ING', 1);
  const filasAntes = await filasDe(p5.usuario_id);

  const r = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.gerente,
    body: {
      asignaciones: [
        asignacion(p5, { grupo: 2, vigente_desde: '2026-06-01' }), // relevo válido…
        { usuario_id: usuarioSinOid, cargo_id: cargoId.ing, grupo: 1, vigente_desde: '2026-06-01' }, // …seguido de uno inválido
      ],
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.codigo, 'usuario_invalido');
  assert.equal(r.data.indice, 1);
  assert.deepEqual(await filasDe(p5.usuario_id), filasAntes, 'el relevo válido del índice 0 se deshizo');

  for (const [codigo, body, indice] of [
    ['lote_vacio', { asignaciones: [] }, undefined],
    ['lote_vacio', {}, undefined],
    ['lote_excesivo', { asignaciones: Array.from({ length: 501 }, () => asignacion(p5)) }, undefined],
    ['grupo_invalido', { asignaciones: [asignacion(p5, { grupo: '2' })] }, 0],
    ['grupo_invalido', { asignaciones: [asignacion(p5, { grupo: 5 })] }, 0],
    ['fecha_invalida', { asignaciones: [asignacion(p5, { vigente_desde: '2026-13-01' })] }, 0],
    ['vigencia_invalida', { asignaciones: [asignacion(p5, { vigente_desde: '2026-06-02', vigente_hasta: '2026-06-01' })] }, 0],
    ['usuario_invalido', { asignaciones: [asignacion(p5), { ...asignacion(p5), usuario_id: 'x' }] }, 1],
    ['cargo_invalido', { asignaciones: [asignacion(p5, { cargo_id: 999999, vigente_desde: '2026-06-01' })] }, 0],
  ]) {
    const x = await call('POST', '/api/rotacion/asignaciones', { sesion_id: ses.gerente, body });
    assert.equal(x.status, 400, `${codigo}: ${JSON.stringify(x.data)}`);
    assert.equal(x.data.codigo, codigo);
    if (indice !== undefined) assert.equal(x.data.indice, indice, codigo);
  }
  assert.deepEqual(await filasDe(p5.usuario_id), filasAntes, 'ningún rechazo escribió');
});

test('POST /asignaciones · una asignación que empieza después → 409 asignacion_conflicto, sin tocar nada', async () => {
  const p6 = persona('ING', 2);
  const relevo = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.admin, body: { asignaciones: [asignacion(p6, { grupo: 3, vigente_desde: '2026-06-15' })] },
  });
  assert.equal(relevo.status, 200, JSON.stringify(relevo.data));
  assert.equal(relevo.data.creadas, 1);
  const filasAntes = await filasDe(p6.usuario_id);
  assert.equal(filasAntes.length, 2);
  const futura = filasAntes.find((f) => f.vigente_desde === '2026-06-15');

  const r = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.admin, body: { asignaciones: [asignacion(p6, { grupo: 4, vigente_desde: '2026-06-01' })] },
  });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.codigo, 'asignacion_conflicto');
  assert.equal(r.data.asignacion_id, futura.rotacion_asignacion_id);
  assert.equal(r.data.indice, 0);
  assert.deepEqual(await filasDe(p6.usuario_id), filasAntes);

  // Salir de la rotación el MISMO día en que empieza una asignación sí es posible desde L12 (CR2-3):
  // esa fila nunca llegó a tener efecto, así que se elimina en vez de responder un 409 que describía
  // otro caso ("ya tiene una asignación que empieza después") y obligaba a poner la salida al día
  // siguiente, dejando a la persona de titular fantasma por un día. La verificación bidireccional
  // completa vive en rotacion_correcciones_o2.test.js; acá se fija que el 409 de "empieza después"
  // NO se dispara por este camino.
  const salida = await call('POST', '/api/rotacion/asignaciones', {
    sesion_id: ses.admin, body: { asignaciones: [asignacion(p6, { grupo: null, vigente_desde: '2026-06-15' })] },
  });
  assert.equal(salida.status, 200, JSON.stringify(salida.data));
  assert.deepEqual(salida.data, { creadas: 0, cerradas: 1, actualizadas: 0, sin_cambio: 0, total: 1 });
  const filasDespues = await filasDe(p6.usuario_id);
  assert.equal(filasDespues.length, 1, 'la fila que empezaba ese mismo día se eliminó');
  assert.equal(filasDespues[0].rotacion_asignacion_id, filasAntes[0].rotacion_asignacion_id);
  assert.equal(filasDespues[0].vigente_hasta, '2026-06-14', 'la anterior conserva su cierre del relevo');
});

// ── CA-6 (mitad HTTP, asignada al GATE-O2) · degradación de Graph por el endpoint ─────────────
test('CA-6 (mitad HTTP) · POST /sincronizar-entra sin credencial de Graph → 503 entra_no_disponible saneado', async () => {
  assert.equal(
    entraConfigurado(), false,
    'Este caso solo puede correr con el backend Y este proceso SIN M365_CLIENT_SECRET: con la credencial puesta, '
    + 'el POST sincronizaría el tenant REAL contra la BD (≈80 personas, sin limpieza posible). Relanza así:\n'
    + '  M365_CLIENT_SECRET= SERVER_PORT=3114 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js\n'
    + '  M365_CLIENT_SECRET= TEST_BASE_URL=http://localhost:3114 node --env-file=../.env --test tests/rotacion_endpoints.test.js',
  );
  const usuariosAntes = (await db.request().query('SELECT COUNT(*) AS n FROM lov_bit.usuario')).recordset[0].n;

  const r = await call('POST', '/api/rotacion/sincronizar-entra', { sesion_id: ses.gerente, body: {} });
  assert.equal(r.status, 503, JSON.stringify(r.data));
  assert.equal(r.data.codigo, 'entra_no_disponible');
  assert.equal(typeof r.data.mensaje, 'string');
  assert.doesNotMatch(JSON.stringify(r.data), /M365_|secret|graph\.microsoft|microsoftonline/i, 'saneado (D-032): ni la variable ni el host');

  const usuariosDespues = (await db.request().query('SELECT COUNT(*) AS n FROM lov_bit.usuario')).recordset[0].n;
  assert.equal(usuariosDespues, usuariosAntes, 'nada se escribió');
  const health = await fetch(`${BASE_URL}/health`);
  assert.equal(health.status, 200, 'el server sigue vivo');
});
