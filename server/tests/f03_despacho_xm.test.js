// D-064 L03 — El tipo de evento del asiento automático (F36.A1) y su COLAPSO en el libro F03.
//
// Las dos mitades de este lote comparten archivo porque son una sola historia: el asiento que el
// sistema escribe cuando llega el despacho de XM son CUATRO filas —dos bitácoras de Sala × dos
// unidades (§5.2)— que comparten `detalle`, `fecha_evento` y `campos_extra.clave_asiento`. El
// tipo de evento las hace posibles (existe en SALAJDT y SALAING, y `seleccionable = 0` impide que
// alguien teclee a mano una que finja venir del sistema) y el colapso las imprime como el único
// renglón que son.
//
// Lo que se prueba de verdad acá es el NO-REGRESIÓN: `eventosSala` deduplicaba solo por
// `registro_id` y ahora deduplica por clave de agrupación cuando la hay. Si ese cambio se hubiera
// hecho de más, dos eventos tecleados el mismo día se colapsarían en uno y el libro perdería
// operación real, en silencio. Por eso los casos "normales" pesan tanto como el caso nuevo.
//
// Aislamiento (D-030/D-055): la suite corre contra la BD PRODUCTIVA. Todo lo que se siembra va a
// las plantas-fixture `TST` y `TSR` —nunca a GEC3/GEC32— y cada `DELETE` lleva su acotador de
// fixture léxicamente junto al statement. El mes es marzo de 2026: histórico, determinista y
// distinto del que usa `f03_datos.test.js` (febrero), así que ninguna de las dos suites puede
// pisar los fixtures de la otra aunque cambie el orden de la corrida.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';

import { initDB, getDB } from '../db.js';
import { armarMes } from '../utils/f03-datos.js';
import { asientoLiteralSala } from '../utils/asientos/index.js';
import {
  asientoDespachoXM,
  camposExtraDespacho,
  claveDeAgrupacion,
  esAsientoDeSistema,
  BITACORAS_ASIENTO_SISTEMA,
  TIPO_EVENTO_DESPACHO_XM,
} from '../utils/asientos/sistema.js';
import {
  TEST_PLANTA,
  TEST_PLANTA_REFLEJO,
  setupSesionReflejo,
  deactivateSyntheticSessions,
} from './helpers.js';

const MES = '2026-03';
const DIA = '2026-03-10';
// El despacho que ANUNCIA es el del día siguiente: la fecha del texto no es la del renglón (§5.2).
const FECHA_DESPACHO = '2026-03-11';

// Las dos plantas-fixture hacen de las dos unidades. `armarMes` recibe `plantas` inyectable
// justamente para esto (`PLANTAS_F03`): producción pasa GEC3/GEC32 y el test jamás.
const UNIDADES = [TEST_PLANTA, TEST_PLANTA_REFLEJO];
const soloFixture = { plantas: UNIDADES };

let db;
let usuario_id;
let tipos;   // filas de lov_bit.tipo_evento de SALAJDT/SALAING + el código de su bitácora

before(async () => {
  await initDB();
  db = await getDB();
  // Siembra la planta-fixture 'TSR' (la otra, 'TST', es residente de `db.js`) y deja un usuario
  // sintético para `creado_por`, que tiene FK a `lov_bit.usuario`.
  usuario_id = (await setupSesionReflejo()).usuario_id;
  tipos = await cargarTiposDeSala();
  await limpiarFixtures();
});

after(async () => {
  await limpiarFixtures();
  await deactivateSyntheticSessions();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

async function cargarTiposDeSala() {
  const r = await db.request().query(`
    SELECT b.codigo, te.tipo_evento_id, te.nombre, te.orden, te.seleccionable
    FROM lov_bit.tipo_evento te
    INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
    WHERE b.codigo IN ('SALAJDT', 'SALAING')
  `);
  return r.recordset;
}

const tipoDe = (codigo, nombre) => tipos.find((t) => t.codigo === codigo && t.nombre === nombre);

// Instante UTC de una hora de pared Bogotá. Offset puro -5h (D-020): nada de `new Date(str)` con
// la TZ de la máquina.
function instante(fecha, hora) {
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
}

async function insertarRegistro({ tipo_evento_id, planta, fecha_evento, detalle, campos_extra = null }) {
  const r = await db.request()
    .input('te', sql.Int, tipo_evento_id)
    .input('planta', sql.VarChar(10), planta)
    .input('fecha_evento', sql.DateTime2, fecha_evento)
    .input('turno', sql.TinyInt, 1)
    .input('detalle', sql.NVarChar(sql.MAX), detalle)
    .input('campos_extra', sql.NVarChar(sql.MAX), campos_extra)
    .input('usuario', sql.Int, usuario_id)
    .query(`
      INSERT INTO bitacora.registro_activo
        (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
         estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
      OUTPUT INSERTED.registro_id
      SELECT te.bitacora_id, @planta, @fecha_evento, @turno, @detalle, @campos_extra, @te,
             'borrador', '[]', '[]', '[]', @usuario
      FROM lov_bit.tipo_evento te WHERE te.tipo_evento_id = @te
    `);
  return r.recordset[0].registro_id;
}

// Las CUATRO filas del asiento, tal como las va a escribir L04: mismo texto, mismo instante, mismo
// `campos_extra`, una por cada (bitácora de Sala × unidad). El texto y el `campos_extra` salen del
// motor (C2), no de un literal copiado acá: si el motor cambiara la frase, este test la sigue.
async function seedAsientoDespacho({
  fecha_despacho = FECHA_DESPACHO, hora = '15:07', hora_estimada = false, unidades = UNIDADES,
  campos_extra = null, detalle = null,
} = {}) {
  const extra = campos_extra ?? JSON.stringify(camposExtraDespacho({ fecha_despacho, hora_estimada }));
  const texto = detalle ?? asientoDespachoXM(fecha_despacho);
  const ids = [];
  for (const codigo of BITACORAS_ASIENTO_SISTEMA) {
    for (const planta of unidades) {
      ids.push(await insertarRegistro({
        tipo_evento_id: tipoDe(codigo, TIPO_EVENTO_DESPACHO_XM).tipo_evento_id,
        planta,
        fecha_evento: instante(DIA, hora),
        detalle: texto,
        campos_extra: extra,
      }));
    }
  }
  return ids;
}

// Un renglón tecleado por una persona: sin marcador, con 'Evento General' (el tipo que el operador
// sí puede elegir).
async function seedSalaTecleado({ bitacora = 'SALAJDT', planta = TEST_PLANTA, hora, detalle }) {
  return insertarRegistro({
    tipo_evento_id: tipoDe(bitacora, 'Evento General').tipo_evento_id,
    planta,
    fecha_evento: instante(DIA, hora),
    detalle,
  });
}

// La ventana de limpieza se DERIVA del mes y se abre un día a cada lado (GATE-O1, R9). Dos razones:
//   - `${MES}-31` solo era una fecha válida porque marzo tiene 31 días; con un mes de 30, o con
//     febrero, el `sql.Date` recibía un día inexistente y la limpieza podía no borrar nada, dejando
//     fixtures vivos que arrastran a los tests siguientes.
//   - `armarMes` consulta de `mes-01 menos 1 día` a `último día más 1` (la holgura que le permite
//     ubicar por hora canónica un evento del borde), así que un residuo en esos dos días entra al
//     lazo de `eventosSala` aunque después `porDia` lo descarte. Limpiar solo el mes exacto dejaba
//     una fuente de intermitencia difícil de reproducir.
const [MES_ANIO, MES_NUM] = MES.split('-').map(Number);
const ULTIMO_DIA = new Date(Date.UTC(MES_ANIO, MES_NUM, 0)).getUTCDate();          // día 0 del mes
const DESDE_LIMPIEZA = new Date(Date.UTC(MES_ANIO, MES_NUM - 1, 1 - 1))            // siguiente = el
  .toISOString().slice(0, 10);                                                     // último de este
const HASTA_LIMPIEZA = new Date(Date.UTC(MES_ANIO, MES_NUM - 1, ULTIMO_DIA + 1))
  .toISOString().slice(0, 10);

// El DML de limpieza va acotado por planta-FIXTURE, con el acotador léxicamente junto al statement
// (D-055): `@fixture` y `@fixture2` están ligados a TEST_PLANTA y TEST_PLANTA_REFLEJO. La ventana
// de fechas es acotación ADICIONAL, no la acotación: acotar por fecha NO acota (D-061).
async function limpiarFixtures() {
  await db.request()
    .input('fixture', sql.VarChar(10), TEST_PLANTA)
    .input('fixture2', sql.VarChar(10), TEST_PLANTA_REFLEJO)
    .input('desde', sql.Date, DESDE_LIMPIEZA)
    .input('hasta', sql.Date, HASTA_LIMPIEZA)
    .query(`
      DELETE FROM bitacora.registro_activo
        WHERE planta_id IN (@fixture, @fixture2)
          AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) BETWEEN @desde AND @hasta;
      DELETE FROM bitacora.registro_historico
        WHERE planta_id IN (@fixture, @fixture2)
          AND CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) BETWEEN @desde AND @hasta;
    `);
}

// ── Lecturas de conveniencia ─────────────────────────────────────────────────────────────────

const dia = (dias, fecha) => dias.find((d) => d.fecha === fecha);
const filasDe = (dias, fecha, i) => dia(dias, fecha).bloques[i].filas;
const todasLasFilas = (dias) => dias.flatMap((d) => d.bloques.flatMap((b) => b.filas));

// ── C6 · el tipo de evento (F36.A1) ──────────────────────────────────────────────────────────

describe('D-064 L03 — F36.A1, el tipo del asiento automático', () => {
  test('F36.A1 siembra el tipo en las dos bitácoras, oculto y con orden 5', () => {
    for (const codigo of BITACORAS_ASIENTO_SISTEMA) {
      const t = tipoDe(codigo, TIPO_EVENTO_DESPACHO_XM);
      assert.ok(t, `${codigo} no tiene el tipo "${TIPO_EVENTO_DESPACHO_XM}": L04 lo resuelve por ` +
        '(bitacora_id, nombre) y sin él no puede escribir el asiento');
      assert.equal(t.orden, 5, `${codigo}/"${TIPO_EVENTO_DESPACHO_XM}" debe ir con orden 5 ` +
        '(los cuatro espejo de F34.A1 ocupan 1..4)');
      assert.equal(t.seleccionable, false,
        `${codigo}/"${TIPO_EVENTO_DESPACHO_XM}" quedó seleccionable: aparecería en el selector de ` +
        'tipo de la grilla y cualquiera podría teclear a mano un asiento que finge venir del sistema');
    }
  });

  test('el nombre del tipo es el del contrato C2, sin divergencia entre el seed y el motor', () => {
    // El motor nombra el tipo (`TIPO_EVENTO_DESPACHO_XM`) y el seed lo crea: son dos literales en
    // dos archivos y nada los ata, igual que el espejo de nombres de bitácora de D-052. Si alguien
    // renombra uno, L04 resuelve `undefined` y el asiento deja de escribirse EN SILENCIO.
    assert.equal(TIPO_EVENTO_DESPACHO_XM, 'Despacho económico');
  });

  test('un segundo arranque no duplica el tipo ni le sube el flag (seed idempotente)', async () => {
    const antes = await cargarTiposDeSala();
    await initDB();
    const despues = await cargarTiposDeSala();
    assert.equal(despues.length, antes.length,
      'un segundo arranque duplicó filas de tipo_evento en las bitácoras de Sala');
    const clave = (t) => `${t.codigo}|${t.nombre}|${t.orden}|${t.seleccionable}`;
    assert.deepEqual(despues.map(clave).sort(), antes.map(clave).sort(),
      'un segundo arranque cambió el orden o el flag de algún tipo de Sala');
    for (const codigo of BITACORAS_ASIENTO_SISTEMA) {
      const t = despues.find((x) => x.codigo === codigo && x.nombre === TIPO_EVENTO_DESPACHO_XM);
      assert.equal(t.seleccionable, false,
        `${codigo} perdió el seleccionable = 0 tras el segundo arranque: el UPDATE complementario ` +
        'no está cubriendo el tipo nuevo (va en las DOS listas del seed, no solo en el INSERT)');
    }
  });

  test('el UPDATE complementario devuelve el flag a 0 si alguien lo sube fuera del arranque', async () => {
    // Es la razón de ser de la segunda lista: el `NOT EXISTS` del INSERT ya no vuelve a tocar la
    // fila una vez creada, así que sin el UPDATE un seteo accidental quedaría vivo para siempre.
    //
    // El `try/finally` NO es ceremonia (GATE-O1, R8): esto es DML sobre el catálogo REAL de la BD,
    // no sobre una fixture, y la suite corre contra la BD productiva (D-030). Entre el `UPDATE` y su
    // reversión el tipo queda tecleable a mano, así que la ventana tiene que cerrarse pase lo que
    // pase — si `initDB()` lanza por un timeout, si el assert falla, o si alguien corta la corrida,
    // el flag NO puede quedar en 1 esperando el próximo arranque del backend.
    const t = tipoDe('SALAJDT', TIPO_EVENTO_DESPACHO_XM);
    const volverACero = () => db.request()
      .input('id', sql.Int, t.tipo_evento_id)
      .query(`UPDATE lov_bit.tipo_evento SET seleccionable = 0 WHERE tipo_evento_id = @id`);
    let r;
    try {
      await db.request()
        .input('id', sql.Int, t.tipo_evento_id)
        .query(`UPDATE lov_bit.tipo_evento SET seleccionable = 1 WHERE tipo_evento_id = @id`);
      await initDB();
      r = await db.request()
        .input('id', sql.Int, t.tipo_evento_id)
        .query(`SELECT seleccionable FROM lov_bit.tipo_evento WHERE tipo_evento_id = @id`);
    } finally {
      await volverACero().catch(() => {});   // el finally no puede tapar el error real del test
    }
    assert.equal(r.recordset[0].seleccionable, false,
      'el arranque no revirtió el seleccionable = 1: el tipo quedaría tecleable a mano');
  });
});

// ── CA-3 · el colapso en el libro ────────────────────────────────────────────────────────────

describe('D-064 L03 — CA-3, el colapso de las 4 filas en un renglón', () => {
  test('colapsa las 4 filas en un renglón, con el texto literal y en el bloque de su hora', async () => {
    await limpiarFixtures();
    const ids = await seedAsientoDespacho({ hora: '15:07' });
    assert.equal(ids.length, 4, 'precondición: el asiento son 4 filas (2 bitácoras × 2 unidades)');

    const dias = await armarMes(db, { mes: MES, ...soloFixture });
    const filas = filasDe(dias, DIA, 1); // bloque 06:00 - 18:00
    assert.equal(filas.length, 1,
      `las 4 filas del asiento deben salir como UN renglón; salieron ${filas.length}`);
    assert.equal(filas[0].hora, '15:07');
    // Texto LITERAL: sin prefijo de unidad. El asiento nombra a las dos (`G3.0 y G3.2`) y
    // prefijarlo con una sola sería mentir — de ahí el marcador.
    assert.equal(filas[0].asiento, asientoDespachoXM(FECHA_DESPACHO));
    assert.equal(filas[0].asiento,
      'Se recibe del XM despacho económico de G3.0 y G3.2 para el 11-03-2026');
    assert.ok(!filas[0].asiento.includes('—'),
      `el asiento salió con prefijo de unidad: "${filas[0].asiento}"`);

    const apariciones = todasLasFilas(dias).filter((f) => f.asiento === filas[0].asiento);
    assert.equal(apariciones.length, 1, 'aparece EXACTAMENTE una vez en todo el mes');
  });

  test('dos jornadas distintas son dos renglones: la clave agrupa por FECHA, no por marcador', async () => {
    await limpiarFixtures();
    await seedAsientoDespacho({ fecha_despacho: '2026-03-11', hora: '15:07' });
    await seedAsientoDespacho({ fecha_despacho: '2026-03-12', hora: '16:20' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2,
      'dos despachos distintos del mismo día se colapsaron en uno: la clave no está discriminando ' +
      'por fecha y se perdería un hecho real');
    assert.deepEqual(filas.map((f) => f.hora), ['15:07', '16:20'], 'orden ascendente por hora');
    assert.equal(filas[0].asiento, asientoDespachoXM('2026-03-11'));
    assert.equal(filas[1].asiento, asientoDespachoXM('2026-03-12'));
  });

  test('los registros normales no se colapsan', async () => {
    await limpiarFixtures();
    // El caso que el cambio podría haber roto: dos renglones tecleados el mismo día, sin marcador.
    await seedSalaTecleado({ hora: '08:05', detalle: 'GEC3 sincronizada al sistema' });
    await seedSalaTecleado({ hora: '12:40', detalle: 'GEC3 se realiza prueba de bomba de emergencia' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2,
      'dos registros tecleados el mismo día deben seguir siendo DOS renglones: el dedupe por ' +
      'registro_id no puede haberse perdido');
    assert.deepEqual(filas.map((f) => f.hora), ['08:05', '12:40']);
  });

  test('dos registros tecleados con el MISMO texto y la MISMA hora siguen siendo dos renglones', async () => {
    await limpiarFixtures();
    // Sin marcador no hay clave de agrupación, así que ni el texto ni la hora idénticos pueden
    // colapsarlos: el JdT y el IngOp anotando lo mismo son dos asientos del papel, no uno.
    await seedSalaTecleado({ bitacora: 'SALAJDT', hora: '09:00', detalle: 'GEC3 relevo de turno' });
    await seedSalaTecleado({ bitacora: 'SALAING', hora: '09:00', detalle: 'GEC3 relevo de turno' });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2, 'el colapso solo lo decide la clave de agrupación, nunca el texto');
  });

  test('el prefijo de unidad sigue vivo para lo tecleado', async () => {
    await limpiarFixtures();
    await seedSalaTecleado({
      planta: TEST_PLANTA, hora: '10:15', detalle: 'Se realiza ronda de inspección',
    });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 1);
    assert.equal(filas[0].asiento, `${TEST_PLANTA} — Se realiza ronda de inspección`,
      'el renglón tecleado perdió el prefijo de unidad: la rama del asiento de sistema se comió ' +
      'también lo que escribió una persona');
    // La misma rama, con la unidad REAL del formato (CA-3): se verifica sobre el motor puro, que
    // no toca la BD — sembrar en GEC3 sería escribir en planta real (D-055).
    assert.equal(
      asientoLiteralSala({ planta_id: 'GEC3', texto: 'Se realiza ronda de inspección' }),
      'GEC3 — Se realiza ronda de inspección',
    );
  });

  test('el asiento de sistema ENTRA al libro: el filtro de reflejados no lo alcanza', async () => {
    await limpiarFixtures();
    // RQ-05.9: el marcador es `origen_sistema`, no `origen_bitacora`. Si alguien "unificara" los
    // dos marcadores, el asiento desaparecería del F03 sin que nada más se rompiera.
    await seedAsientoDespacho({ hora: '15:07' });
    await insertarRegistro({
      tipo_evento_id: tipoDe('SALAJDT', 'Evento General').tipo_evento_id,
      planta: TEST_PLANTA,
      fecha_evento: instante(DIA, '15:30'),
      detalle: 'Copia reflejada de un lote de Operación 24h',
      campos_extra: JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: 'no-importa' }),
    });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.deepEqual(filas.map((f) => f.asiento), [asientoDespachoXM(FECHA_DESPACHO)],
      'el libro debe traer el asiento de sistema y NO la copia reflejada');
  });

  test('el predicado degrada ante un campos_extra corrupto (y SQL lanza antes: ver hallazgo H1)', () => {
    // Este caso NO se puede montar contra la BD, y eso mismo es el hallazgo H1 del cierre: una
    // fila de Sala con `campos_extra` malformado hace que `JSON_VALUE(…, '$.origen_bitacora')`
    // —el filtro de reflejados, anterior a D-064 y que este lote tiene congelado— lance el error
    // 13609 y se caiga el libro del MES ENTERO. Se midió: `registro_activo.campos_extra` no tiene
    // CHECK `ISJSON` (los únicos CHECK de la tabla son `turno` y `estado`), así que la fila se
    // puede escribir.
    //
    // Lo que SÍ depende de este lote es que la mitad en Node no agregue una segunda forma de
    // caerse: el predicado se consulta por FILA dentro del lazo y en el histórico —append-only—
    // una fila corrupta no se puede arreglar. Degrada a "no es de sistema" y el renglón saldría
    // por el camino tecleado.
    assert.equal(esAsientoDeSistema('{ esto no es json'), false);
    assert.equal(claveDeAgrupacion('{ esto no es json'), null);
  });

  test('un asiento de sistema SIN clave de agrupación no se colapsa, pero tampoco se prefija', async () => {
    await limpiarFixtures();
    // Fila degradada (`clave_asiento` ausente): duplicar es peor que agrupar mal dos filas ajenas,
    // así que cae al desempate por `registro_id`. Lo que NO puede perder es el texto literal.
    await seedAsientoDespacho({
      hora: '15:07',
      unidades: [TEST_PLANTA],
      campos_extra: JSON.stringify({ origen_sistema: 'DESPACHO_XM', fecha_despacho: FECHA_DESPACHO }),
    });

    const filas = filasDe(await armarMes(db, { mes: MES, ...soloFixture }), DIA, 1);
    assert.equal(filas.length, 2, 'sin clave no hay agrupación posible: salen las dos filas');
    for (const fila of filas) {
      assert.equal(fila.asiento, asientoDespachoXM(FECHA_DESPACHO),
        'el marcador por sí solo ya basta para pasar el texto literal, sin prefijo de unidad');
    }
  });
});
