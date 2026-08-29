import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import { initDB, getDB, TEST_PLANTA_ID, seedCatalogoCombTest } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { getTurnoColombia } from '../utils/turno.js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3002';
export const PLANTA_ID = 'GEC3';

// D-030: planta sintética reservada para tests (definida en db.js, excluida de las vistas DISP).
// Los tests que tocan disponibilidad operan sobre esta planta — nunca sobre GEC3/GEC32 reales.
export const TEST_PLANTA = TEST_PLANTA_ID;

// D-058 E4 — SEGUNDA planta-fixture: la única que SÍ refleja a las bitácoras de Sala.
//
// `TEST_PLANTA` no puede cubrir el camino feliz del reflejo (REQ-02) porque RN-02.e la excluye a
// propósito: si reflejara, cada `npm test` sembraría asientos de prueba en SALAJDT/SALAING sobre la
// BD productiva (D-030). Y usar GEC3/GEC32 está prohibido — sería escribir en planta REAL (D-055).
//
// Dos diferencias deliberadas con 'TST':
//   1. **No vive en `db.js`.** Producción no debe conocerla: para el código de producto es una
//      planta cualquiera, que es justamente lo que la vuelve útil acá. Si mañana alguien la agregara
//      al guard de RN-02.e, esta suite dejaría de probar lo que dice probar.
//   2. **Se siembra con `activa = 0`**, y eso es lo que la mantiene invisible fuera de los tests:
//      `GET /api/catalogos/plantas` y `validarPlantaOperable` (select-context / cambiar-unidad)
//      filtran por `activa = 1`, así que ningún operador puede verla en el selector ni entrar a
//      ella. La sesión de test se inserta directo en `sesion_activa`, que no valida la planta más
//      allá de la FK.
export const TEST_PLANTA_REFLEJO = 'TSR';

// Usuario propio de la fixture del reflejo (prefijo `test_` → `es_sintetico`, D-044). Es un usuario
// APARTE de los de `setupSessions` a propósito: `ensureSesion` desactiva las otras sesiones del mismo
// usuario (sesión única, D-035), así que reusar `test_jdt` mataría la sesión sobre 'TST' y el resto
// de la suite de MAND empezaría a recibir 401 (la lección de D-055 sobre partir los tests de MAND en
// dos archivos, acá en versión "dos plantas").
const TEST_USER_REFLEJO = { nombre: 'Test JdT Reflejo', username: 'test_reflejo_jdt' };

/**
 * Siembra la planta-fixture del reflejo, su usuario sintético y una sesión de app sobre ella.
 * Idempotente. Devuelve `{ sesion_id, usuario_id, planta_id }`.
 *
 * El cargo por defecto es `Ingeniero Jefe de Turno`: tiene `puede_crear` en MAND por la matriz
 * data-driven, que es el gate real del endpoint (nunca se hardcodea el cargo, D-027/D-048).
 */
export async function setupSesionReflejo({ cargo = 'Ingeniero Jefe de Turno' } = {}) {
  const db = await getDB();
  const password_hash = await hashPassword(randomBytes(24).toString('hex'));

  await db.request()
    .input('planta', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      MERGE lov_bit.planta AS t
      USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
      -- activa = 0 en los dos lados: si alguien la activó a mano, cada corrida la vuelve a apagar.
      WHEN MATCHED THEN UPDATE SET activa = 0
      WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa)
        VALUES (@planta, 'Test Synthetic Reflejo', 0);
    `);

  // `es_sintetico = 1` explícito, no heredado del barrido de arranque de `db.js` (que solo corre en
  // initDB): un usuario creado a mitad de corrida quedaría en 0 hasta el próximo restart y
  // `deactivateSyntheticSessions()` no lo alcanzaría → sesión colgada y `zzz_session_leak_guard` rojo.
  await db.request()
    .input('nombre', sql.VarChar(200), TEST_USER_REFLEJO.nombre)
    .input('username', sql.VarChar(50), TEST_USER_REFLEJO.username)
    .input('pwd', sql.VarChar(200), password_hash)
    .query(`
      MERGE lov_bit.usuario AS t
      USING (SELECT @username AS username) AS s ON t.username = s.username
      WHEN MATCHED THEN UPDATE SET activo = 1, nombre_completo = @nombre, es_sintetico = 1
      WHEN NOT MATCHED THEN INSERT
        (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo, es_sintetico)
        VALUES (@nombre, @username, NULL, @pwd, 0, 0, 1, 1);
    `);

  const { recordset: [usuario] } = await db.request()
    .input('username', sql.VarChar(50), TEST_USER_REFLEJO.username)
    .query(`SELECT usuario_id FROM lov_bit.usuario WHERE username = @username`);
  const { recordset: [cargoRow] } = await db.request()
    .input('cargo', sql.VarChar(100), cargo)
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @cargo`);

  await db.request()
    .input('usuario_id', sql.Int, usuario.usuario_id)
    .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
  const ins = await db.request()
    .input('usuario_id', sql.Int, usuario.usuario_id)
    .input('planta_id', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('cargo_id', sql.Int, cargoRow.cargo_id)
    .input('turno', sql.TinyInt, getTurnoColombia())
    .query(`
      INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
      OUTPUT INSERTED.sesion_id
      VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
    `);

  return {
    sesion_id: ins.recordset[0].sesion_id,
    usuario_id: usuario.usuario_id,
    planta_id: TEST_PLANTA_REFLEJO,
  };
}

// D5: sin corchetes [...]. SQL Server interpreta [ y ] como wildcards de conjunto en LIKE,
// con corchetes el patrón '%[TEST-RUN-N]%' NO matchea el literal '[TEST-RUN-N]' — el
// cleanup quedaba inerte y los asserts con LIKE TEST_TAG fallaban silenciosamente.
export const TEST_TAG = `TEST-RUN-${Date.now()}`;

// D-041: ÚNICA vía autorizada para limpiar DISP en tests. Opera SIEMPRE sobre la planta de test
// (hard-coded, sin parámetro → imposible pasar GEC3/GEC32 por error) y SIEMPRE sobre la tabla base
// disponibilidad_estado (nunca la vista disponibilidad_dashboard, que además es de solo lectura por
// trigger en la BD). Todo test que cree estados DISP debe limpiarlos con este helper.
export async function cleanDispTestPlanta() {
  const db = await getDB();
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @tp;`);
}

// D-030/D-044: ÚNICA vía para desactivar sesiones de test. Opera por `es_sintetico=1` (NO por una
// whitelist de usernames): cubre TODOS los fixtures `test_*` — incluidos los que siembran suites
// puntuales (`test_opcarbon` en consumos, `test_coord_cym` en rol_coordinador, …). La versión vieja,
// basada en los 4 TEST_USERS, dejaba esas dos sesiones ACTIVAS en GEC3 y visibles en el panel
// CONECTADOS de PRODUCCIÓN tras cada corrida (la suite corre contra prod, D-030). `es_sintetico=1`
// jamás matchea un operador real (invariante del seed, verificado en conformacion_turno.test.js).
// Contrato: todo test que cree sesiones DEBE llamarla en su `after()`; además el guard final
// `zzz_session_leak_guard.test.js` la corre como red de seguridad y falla si algo se coló.
export async function deactivateSyntheticSessions() {
  const db = await getDB();
  const r = await db.request().query(`
    UPDATE bitacora.sesion_activa SET activa = 0
    WHERE activa = 1
      AND usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE es_sintetico = 1)
  `);
  return r.rowsAffected[0];
}

// D-058 E9: hermano de `call` para endpoints que responden BYTES (el libro mensual F03). No puede
// reusar `call` porque ese hace `res.json()` y se comería el `.xlsx`. Devuelve también los headers:
// el `Content-Type` y el `Content-Disposition` son parte del contrato de una descarga.
// Un error del backend sí viene en JSON, así que el llamador lo parsea del buffer cuando `status`
// no es 200.
export async function callBinario(method, path, { sesion_id } = {}) {
  const headers = {};
  if (sesion_id != null) headers['X-Sesion-Id'] = String(sesion_id);
  const res = await fetch(`${BASE_URL}${path}`, { method, headers });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

export async function call(method, path, { body, sesion_id } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sesion_id != null) headers['X-Sesion-Id'] = String(sesion_id);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// D-030/D-044: el prefijo `test_` NO es cosmético — el seed de db.js (F-blindaje) marca
// `es_sintetico=1` a todo username LIKE 'test\_%' en cada arranque, y ese flag es el chokepoint que
// (a) excluye al usuario del builder de conformacion_turno (no contamina el histórico inmutable de
// GEC3/GEC32) y (b) permite que deactivateSyntheticSessions() lo barra sin depender de una whitelist
// de nombres. Un fixture nuevo SIEMPRE va con ese prefijo.
const TEST_USERS = [
  { key: 'jdt',     nombre: 'Test JdT',      username: 'test_jdt',     jefe: 0, jdtd: 1 },
  { key: 'ingOp',   nombre: 'Test Ing Op',   username: 'test_ingop',   jefe: 0, jdtd: 0 },
  { key: 'gerente', nombre: 'Test Gerente',  username: 'test_gerente', jefe: 1, jdtd: 0 },
  { key: 'ingQuim', nombre: 'Test Ing Quim', username: 'test_ingquim', jefe: 0, jdtd: 0 },
  // D-053: el split de Sala de Mando necesita dos cargos más como fixture de primera clase.
  // - opSala: único cargo con puede_crear en SALAOP.
  // - admin: el ÚNICO cargo con puede_crear en TODAS las bitácoras (D-039). Es lo que vuelve a hacer
  //   posible el caso "no-autor CON permiso de creación" de registros_solo_autor, que antes dependía
  //   de que SALA tuviera puede_crear compartido.
  { key: 'opSala',  nombre: 'Test Op Sala',  username: 'test_opsala',  jefe: 0, jdtd: 0 },
  { key: 'admin',   nombre: 'Test Admin',    username: 'test_admin',   jefe: 0, jdtd: 0 },
];

const USER_CARGO = {
  jdt:     'Ingeniero Jefe de Turno',
  ingOp:   'Ingeniero de Operación',
  gerente: 'Gerente de Producción',
  ingQuim: 'Ingeniero Químico',
  opSala:  'Operador de Planta - Sala de Mando',
  admin:   'Administrador y Debugging',
};

// D-061 (L06 · enmienda G3 del GATE-O1): siembra la planta-fixture 'TST' y su catálogo de
// combustibles, en ese orden y de forma idempotente.
//
// Existe porque `seedCatalogoCombTest` (db.js) se AUTO-OMITE si la fila 'TST' de `lov_bit.planta`
// todavía no está, y esa fila la siembra el harness, no `initDB`. Sobre una BD virgen eso dejaba
// el catálogo para el SEGUNDO arranque: las suites de COMB/SIS encontraban `combustibles: []` y
// reventaban con un TypeError sin pista del motivo (hallazgo H4 del code-review de la O1).
//
// La usan `setupSessions({ planta: TEST_PLANTA })` y las suites del scraper, que operan sobre la
// fixture SIN abrir sesiones de app (`sis_scraper_ownership`, `sis_concurrencia`) y por eso no
// pueden apoyarse en `setupSessions` para tener catálogo.
export async function ensurePlantaCombTest() {
  const db = await getDB();
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      MERGE lov_bit.planta AS t
      USING (SELECT @tp AS planta_id) AS s ON t.planta_id = s.planta_id
      WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@tp, 'Test Synthetic', 1);
    `);
  return seedCatalogoCombTest(db);
}

export async function setupSessions({ planta = PLANTA_ID } = {}) {
  await initDB();
  const db = await getDB();
  // AUD-40 (BIT-AUDSEG-2026-001): password aleatorio fuerte por corrida en vez del literal '1234'.
  // El login local ya no existe (D-031, Entra-only), así que el hash es INERTE — pero un valor
  // conocido en usuarios test_* activos sobre la BD productiva es mala higiene. Aleatorizarlo lo
  // mantiene inerte y deja de ser un valor conocido. NO se toca activo=1 (los tests lo necesitan).
  const password_hash = await hashPassword(randomBytes(24).toString('hex'));

  // D-030: si las sesiones van a una planta distinta de las productivas (típicamente TEST_PLANTA),
  // sembrarla idempotentemente. Necesaria por la FK de sesion_activa/disponibilidad_estado y por la
  // validación `planta_id=@p AND activa=1` del POST DISP y /metricas (activa=1 obligatorio).
  if (planta !== PLANTA_ID) {
    await db.request()
      .input('planta', sql.VarChar(10), planta)
      .query(`
        MERGE lov_bit.planta AS t
        USING (SELECT @planta AS planta_id) AS s ON t.planta_id = s.planta_id
        WHEN NOT MATCHED THEN INSERT (planta_id, nombre, activa) VALUES (@planta, 'Test Synthetic', 1);
      `);
  }

  // D-061 (L06 · enmienda G3): el catálogo de combustibles de 'TST' se siembra JUSTO DESPUÉS del
  // MERGE de la planta, no antes: `initDB()` (arriba) lo omite mientras la fila no exista. Sin
  // esto, una BD virgen deja sin catálogo a la primera corrida de COMB/SIS sobre la fixture.
  if (planta === TEST_PLANTA) {
    await seedCatalogoCombTest(db);
  }

  for (const u of TEST_USERS) {
    await db.request()
      .input('nombre',   sql.VarChar(200), u.nombre)
      .input('username', sql.VarChar(50),  u.username)
      .input('pwd',      sql.VarChar(200), password_hash)
      .input('jefe',     sql.Bit, u.jefe)
      .input('jdtd',     sql.Bit, u.jdtd)
      .query(`
        MERGE lov_bit.usuario AS t
        USING (SELECT @username AS username) AS s ON t.username = s.username
        WHEN MATCHED THEN UPDATE SET
          activo = 1, nombre_completo = @nombre,
          es_jefe_planta = @jefe, es_jdt_default = @jdtd
        WHEN NOT MATCHED THEN INSERT (nombre_completo, username, email, password_hash, es_jefe_planta, es_jdt_default, activo)
          VALUES (@nombre, @username, NULL, @pwd, @jefe, @jdtd, 1);
      `);
  }

  const usernames = TEST_USERS.map(u => `'${u.username}'`).join(',');
  const { recordset: usuarios } = await db.request().query(`
    SELECT usuario_id, username FROM lov_bit.usuario WHERE username IN (${usernames})
  `);
  const userByUsername = Object.fromEntries(usuarios.map(u => [u.username, u.usuario_id]));

  const { recordset: cargos } = await db.request().query(`
    SELECT cargo_id, nombre FROM lov_bit.cargo
  `);
  const cargoByName = Object.fromEntries(cargos.map(c => [c.nombre, c.cargo_id]));

  // El turno de la sesión de test debe ser el turno ACTUAL (no un 1 hardcodeado): si se corre la
  // suite en turno 2 (después de las 18:00 Bogotá), una sesión turno=1 tiene su ventana
  // [06:00,18:00] ya vencida y el turno-sweeper la EXPULSA (activa=0) a los ≤60s → los tests
  // empiezan a recibir 401 "Sesión no válida" a mitad de corrida. Con el turno actual la ventana
  // contiene "ahora" y la sesión sobrevive toda la corrida, a cualquier hora del día.
  const turnoActual = getTurnoColombia();
  async function ensureSesion(usuario_id, cargo_id) {
    await db.request()
      .input('usuario_id', sql.Int, usuario_id)
      .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE usuario_id = @usuario_id`);
    const ins = await db.request()
      .input('usuario_id', sql.Int, usuario_id)
      .input('planta_id', sql.VarChar(10), planta)
      .input('cargo_id', sql.Int, cargo_id)
      .input('turno', sql.TinyInt, turnoActual)
      .query(`
        INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
        OUTPUT INSERTED.sesion_id
        VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
      `);
    return ins.recordset[0].sesion_id;
  }

  const sesiones = {};
  const usuariosOut = {};
  for (const u of TEST_USERS) {
    const usuario_id = userByUsername[u.username];
    const cargo_id = cargoByName[USER_CARGO[u.key]];
    sesiones[u.key] = await ensureSesion(usuario_id, cargo_id);
    usuariosOut[u.key] = { usuario_id, username: u.username, nombre_completo: u.nombre };
  }

  const { recordset: bitacoras } = await db.request().query(`
    SELECT bitacora_id, codigo FROM lov_bit.bitacora
  `);
  const bitByCodigo = Object.fromEntries(bitacoras.map(b => [b.codigo, b.bitacora_id]));

  return { sesiones, usuarios: usuariosOut, bitByCodigo };
}

export async function cleanupTestRegistros() {
  const db = await getDB();
  await db.request()
    .input('tag', sql.NVarChar(200), `%${TEST_TAG}%`)
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      -- D-041 (blindaje anti-destrucción en prod): escribir SIEMPRE en la TABLA BASE, nunca a través
      -- de una vista dashboard. autorizacion_dashboard es una VIEW actualizable sobre evento_dashboard
      -- (tipo='AUTH'); un UPDATE/DELETE por la vista cascada silenciosamente a la base → footgun.
      UPDATE bitacora.evento_dashboard SET activa = 0
      WHERE tipo = 'AUTH' AND registro_origen_id IN (
        SELECT registro_id FROM bitacora.registro_activo WHERE detalle LIKE @tag
      );
      -- D-041: DISP se borra por PLANTA DE TEST (límite de aislamiento) además del tag. NUNCA por tag
      -- global: una fila DISP de GEC3/GEC32 jamás debe caer aquí aunque por error quedara tagueada
      -- (así, un POST DISP mal dirigido a una planta real no se amplifica a un borrado del vigente).
      DELETE FROM bitacora.disponibilidad_estado WHERE planta_id = @tp AND detalle LIKE @tag;
      DELETE FROM bitacora.registro_activo WHERE detalle LIKE @tag;
      DELETE FROM bitacora.registro_historico WHERE detalle LIKE @tag;
    `);
  // AUD-33 / D-055: estos dos borrados apuntaban a PLANTA_ID ('GEC3', planta REAL) sin tag, así que
  // sobre la BD productiva (D-030) destruían el cierre MAND real y eventos-dashboard reales; por eso
  // vivían gateados tras TEST_DB_DEDICATED=1 — un gate que los volvía inertes (nunca limpiaban nada
  // en la práctica) y que seguía siendo una bomba si alguien exportaba el flag contra prod.
  // D-055 los reapunta a la planta-fixture: MAND ya corre en 'TST' (el endpoint dejó de hardcodear
  // ['GEC3','GEC32']), así que la limpieza correcta es sobre TST — y entonces es segura SIEMPRE y el
  // gate deja de hacer falta. Nota: el borrado de evento_dashboard acá es de HUÉRFANOS (origen
  // inexistente), el residuo que deja el borrado de una celda de la grilla.
  await db.request()
    .input('planta', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      DELETE FROM bitacora.mand_cierre_log WHERE planta_id = @planta;
      DELETE FROM bitacora.evento_dashboard
      WHERE planta_id = @planta
        AND registro_origen_id NOT IN (SELECT registro_id FROM bitacora.registro_activo)
        AND registro_origen_id NOT IN (SELECT registro_id FROM bitacora.registro_historico);
    `);
  // D-063 (GATE-O1, hallazgo de L01 y L04): `cerrarDiaMand` sobre la planta-fixture —lo invocan DIRECTO
  // dos tests de `sala_de_mando_batch` (el sweeper real solo corre GEC3/GEC32)— emite un CIET del usuario
  // SISTEMA con `detalle = NULL` (`campos_extra.motivo = 'mand-sweeper-diario'`, literal de `ciet.js`), y
  // ninguna limpieza lo alcanzaba: la de arriba filtra por `detalle LIKE @tag` (NULL nunca matchea) y
  // `cleanMand` acota por la bitácora MAND, no CIET. Cada `npm test` dejaba 2 filas en `registro_activo`
  // de TST y `npm run test:residuos` salía en exit 2. Acotado por TEST_PLANTA_ID (D-055) y por autor
  // SISTEMA: jamás toca un CIET real de GEC3/GEC32.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE planta_id = @tp
        AND creado_por = (SELECT usuario_id FROM lov_bit.usuario WHERE username = 'SISTEMA')
        AND JSON_VALUE(campos_extra, '$.motivo') = 'mand-sweeper-diario';
    `);
  // D-063 (GATE-O2, hallazgo de L02): el CIET "Deshacer disponibilidad" también nace con
  // `detalle = NULL`, pero con autor HUMANO (el fixture que deshace), así que el DELETE de arriba no lo
  // alcanza y el de `detalle LIKE @tag` tampoco. En la suite completa lo barría de rebote
  // `registros_solo_autor`; en corridas parciales (los bloques del gate) quedaban 3–6 filas por
  // corrida. Acotado por TEST_PLANTA_ID + es_sintetico = 1 (D-044): jamás matchea un operador real.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      DELETE ra
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.usuario u ON u.usuario_id = ra.creado_por
      WHERE ra.planta_id = @tp AND u.es_sintetico = 1 AND ra.detalle IS NULL;
    `);
  // D-063 (GATE-O2, hallazgo de L07 + /code-review): las cabeceras `turno_unidad` que un test abre en una
  // planta-fixture y no desmonta (`sala_de_mando_batch` deja una PROGRAMADO por corrida) se acumulaban sin
  // que ninguna sonda las contara. Se borran SOLO las que no tienen dependientes (registros vivos o
  // archivados, participantes, sesiones): con dependientes hay una suite a medias y la sonda de
  // `residuos.js` la delata en vez de que este barrido rompa una FK. Acotado a TST/TSR por parámetro.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE tu
      FROM bitacora.turno_unidad tu
      WHERE tu.planta_id IN (@tp, @tpr)
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_activo     ra WHERE ra.turno_id = tu.turno_unidad_id)
        AND NOT EXISTS (SELECT 1 FROM bitacora.registro_historico  rh WHERE rh.turno_id = tu.turno_unidad_id)
        AND NOT EXISTS (SELECT 1 FROM bitacora.turno_participante  tp WHERE tp.turno_id = tu.turno_unidad_id)
        AND NOT EXISTS (SELECT 1 FROM bitacora.sesion_activa       sa WHERE sa.turno_id = tu.turno_unidad_id);
    `);
  // D-061 (L06 · contrato C13): COMB y el scraper del SIS también dejan residuo en la BD, y hasta
  // ahora nadie lo barría — cada suite limpiaba su propia (planta, fecha) y lo que se escapaba
  // quedaba para siempre. Acotado a las DOS plantas-fixture y a nada más: un DELETE por fecha o
  // global cascaría sobre el carbón real de GEC32 que el backfill de D-061 está poblando (D-055).
  // `consumo_combustible` primero por si algún día hay FK hacia el log.
  await db.request()
    .input('tp', sql.VarChar(10), TEST_PLANTA_ID)
    .input('tpr', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .query(`
      DELETE FROM bitacora.consumo_combustible WHERE planta_id IN (@tp, @tpr);
      DELETE FROM bitacora.sis_scrape_log      WHERE planta_id IN (@tp, @tpr);
    `);
  // D-030/D-044: desactivar TODA sesión sintética (es_sintetico=1), no solo los 4 TEST_USERS. La
  // whitelist vieja dejaba test_opcarbon/test_coord_cym ACTIVAS en GEC3 → panel CONECTADOS de prod
  // sucio tras cada corrida. Ver deactivateSyntheticSessions.
  await deactivateSyntheticSessions();
  // conformacion-turno-2026-05 + D-044: snapshots seedeados por los tests E2E/builder. Limpiar por
  // es_sintetico=1 (no por los 4 usernames de TEST_USERS): cubre TAMBIÉN a test_opcarbon y
  // test_coord_cym, que otros suites siembran y que la versión vieja dejaba filtrados para siempre
  // en conformacion_turno. La PK incluye fecha/planta/turno y los tests usan fechas históricas, así
  // que se borra por usuario. es_sintetico jamás matchea un operador real (D-044).
  await db.request().query(`
    DELETE FROM bitacora.conformacion_turno
    WHERE usuario_id IN (SELECT usuario_id FROM lov_bit.usuario WHERE es_sintetico = 1)
  `);
}

export function makeRegistroPayload({ bitacora_id, planta_id = PLANTA_ID, tipo_evento_id, extra = {} }) {
  return {
    bitacora_id,
    planta_id,
    fecha_evento: new Date().toISOString(),
    turno: 1,
    detalle: `${TEST_TAG} detalle prueba`,
    tipo_evento_id,
    ...extra,
  };
}

export async function firstTipoEvento(bitacora_id) {
  const db = await getDB();
  const r = await db.request()
    .input('bitacora_id', sql.Int, bitacora_id)
    .query(`SELECT TOP 1 tipo_evento_id FROM lov_bit.tipo_evento WHERE bitacora_id = @bitacora_id ORDER BY orden`);
  return r.recordset[0]?.tipo_evento_id;
}
