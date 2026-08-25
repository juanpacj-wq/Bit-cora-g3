// D-058 (REQ-06) — Consulta unificada de las cuatro fuentes y armado del mes para el libro F03.
//
// Es el trabajo real de REQ-06 §5.2: **no existe ninguna otra consulta que combine estas fuentes**.
// La vista `v_historico_busqueda` que alimenta el apartado de Históricos no sirve —MAND y DISP
// quedan fuera del cierre de turno que la alimenta, porque tienen ciclo de vida propio—, así que
// acá se une a mano lo que el papel ya mezclaba: Operación 24h, Disponibilidad y las dos bitácoras
// de Sala, de las DOS unidades, en una sola línea de tiempo por día.
//
// Este módulo **solo lee** (RN-06.f) y devuelve DATOS, no `.xlsx`: el escritor es `f03-libro.js`
// (E7), que es puro y recibe exactamente el shape que se arma acá. La partición es deliberada —
// toda la lógica delicada (horas canónicas, doble tabla, bloques que cruzan medianoche) vive de
// este lado, donde se puede probar sin abrir un ZIP.
//
// Los cuatro cruces que hacen esto más difícil de lo que parece:
//
//   1. **Cada fuente tiene su hora canónica distinta** — y en MAND no es `fecha_evento` (ver
//      `horaCanonicaDeLote`).
//   2. **Cada fuente vive en dos tablas según la antigüedad**: `registro_activo` (día en curso) y
//      `registro_historico` (días ya cerrados). Un mes que incluye hoy consulta las dos y no puede
//      duplicar ni perder el día de la transición (RN-06.d).
//   3. **El T2 cruza medianoche** y el sistema lo fecha por su día de INICIO (D-045). El libro lo
//      parte por medianoche: cada evento cae en el día de calendario en que ocurrió y aparece
//      exactamente una vez en todo el libro (criterio 6b).
//   4. **De Sala hay que excluir los asientos reflejados** (E4/E5) o el mismo evento de MAND sale
//      TRES veces en la misma hoja: el original + su copia en SALAJDT + la de SALAING (respuesta 2).

import sql from 'mssql';

import { asientoLote, asientoDisponibilidad, asientoLiteralSala } from './asientos/index.js';
import { fechaBogotaIso } from './turno.js';

// Las unidades que cubre el libro (RQ-06.3 / decisión E: un solo archivo con las dos unidades
// mezcladas). NO es una allowlist de permisos —lo que D-055 prohibió fue una allowlist en un
// endpoint de ESCRITURA, porque volvía imposible escribir sobre una planta-fixture—: acá es el
// ALCANCE del documento, y es inyectable justamente para que los tests puedan armar el mes sobre su
// fixture sin tocar unidad real.
//
// Dicho de otra forma: esto es lo que hace cumplir RN-06.g (`TST` nunca se exporta) y, de paso,
// deja fuera a `TSR` —la fixture del reflejo, que producción no conoce y no debe conocer (E4)—
// sin que ninguna de las dos tenga que nombrarse acá. Un filtro por `planta.activa = 1` habría
// hecho lo mismo hoy, pero ata la salida de un reporte HISTÓRICO a un flag mutable: apagar una
// unidad borraría retroactivamente sus meses ya emitidos.
export const PLANTAS_F03 = ['GEC3', 'GEC32'];

// Los tres bloques de cada hoja (§7 del insumo, RQ-06.10). Las horas son de CALENDARIO Bogotá, no
// `turno_id`: el primero es la cola del T2 que arrancó AYER y el tercero la cabeza del T2 de hoy.
// Los literales van con los espacios EXACTOS del formato controlado — el primero sin espacios
// alrededor del guion y los otros dos con ellos. Se calcaron; no los "normalices".
export const BLOQUES = [
  { turno_literal: '00:00-06:00', desde: 0, hasta: 6 },
  { turno_literal: '06:00 - 18:00', desde: 6, hasta: 18 },
  { turno_literal: '18:00 - 00:00', desde: 18, hasta: 24 },
];

// Los dos cargos que el encabezado de cada bloque nombra (§7.1). Son nombres de `lov_bit.cargo`,
// que es la identidad estable de un cargo en este sistema (la matriz de permisos también matchea
// por nombre, D-054). Acá no gobiernan ningún permiso: solo dicen qué renglón del papel llena cada
// persona.
const CARGO_JEFE = 'Ingeniero Jefe de Turno';
const CARGO_INGENIERO = 'Ingeniero de Operación';

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Arma la estructura de datos del mes: un elemento por día, cada uno con sus tres bloques ya
 * renderizados y ordenados. Es exactamente lo que `construirLibroF03` (E7) consume.
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} opciones
 * @param {string} opciones.mes  `YYYY-MM`.
 * @param {string[]} [opciones.plantas]  Ver `PLANTAS_F03`. Inyectable SOLO para los tests.
 * @param {boolean} [opciones.incluirSinteticos]  Escape hatch de D-044, EXCLUSIVO de los tests:
 *   deja que los usuarios fixture (`es_sintetico = 1`) puedan nombrarse en el encabezado. Producción
 *   NUNCA lo pasa, y el guardrail estático de `conformacion_turno.test.js` falla si algún archivo de
 *   producción lo setea en `true`.
 * @returns {Promise<Array<{fecha: string, bloques: Array<{turno_literal: string, jefe: string,
 *   ingenieros: string, filas: Array<{hora: string, asiento: string}>}>}>>}
 *   Todos los días del mes, siempre: un día sin eventos trae sus tres bloques con `filas: []` y eso
 *   NO es un error (RQ-06.8 / RN-06.h). Un mes entero vacío tampoco.
 */
export async function armarMes(pool, { mes, plantas = PLANTAS_F03, incluirSinteticos = false } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) {
    throw new TypeError(`armarMes: mes inválido "${mes}" (se espera YYYY-MM)`);
  }
  const dias = diasDelMes(mes);
  const vacio = () => dias.map((fecha) => ({ fecha, bloques: bloquesVacios() }));
  if (!Array.isArray(plantas) || plantas.length === 0) return vacio();

  // La ventana de la consulta se abre UN DÍA a cada lado del mes y el recorte fino lo hace después
  // el día canónico, calculado en Node. Motivo: el filtro SQL va por `fecha_evento` (que es lo que
  // está indexado y es lo que ata cada celda a su día de grilla) mientras que la fila se ubica por
  // su hora CANÓNICA, y las dos pueden separarse en el borde — el caso extremo es un lote guardado
  // en el milisegundo en que cruza la medianoche. Un día de holgura cuesta nada y elimina la clase
  // entera de "el evento del 1° a las 00:0x no salió".
  const desde = sumarDias(dias[0], -1);
  const hasta = sumarDias(dias[dias.length - 1], 1);

  const bitacoras = await resolverBitacoras(pool);
  const [mand, disp, sala, personal] = await Promise.all([
    eventosMand(pool, { plantas, desde, hasta, mand_id: bitacoras.MAND }),
    eventosDisponibilidad(pool, { plantas, desde, hasta }),
    eventosSala(pool, { plantas, desde, hasta, sala_ids: [bitacoras.SALAJDT, bitacoras.SALAING] }),
    personalPorTurno(pool, { plantas, desde, hasta, incluirSinteticos }),
  ]);

  const porDia = new Map(dias.map((fecha) => [fecha, bloquesVacios()]));
  for (const ev of [...mand, ...disp, ...sala]) {
    const bloques = porDia.get(ev.fecha);
    if (!bloques) continue; // cayó en la holgura de ±1 día: no es de este mes
    const i = indiceDeBloque(ev.horaNum);
    if (i < 0) continue; // hora inutilizable: no se inventa un bloque
    bloques[i].filas.push(ev);
  }

  return dias.map((fecha) => {
    const bloques = porDia.get(fecha);
    return {
      fecha,
      bloques: bloques.map((bloque, i) => {
        // Orden ASCENDENTE por hora dentro del bloque (§7.2-4). El listado del día en pantalla va
        // DESCENDENTE por `hora_llamada` (RN-04.a) — **son órdenes distintos a propósito**: ahí
        // interesa lo último registrado, acá el papel se lee como una narración del turno. No los
        // "unifiques". El desempate por `clave` mantiene estable el orden de dos eventos del mismo
        // minuto (pasa: dos autorizaciones a la misma hora, o MAND y DISP simultáneos).
        const filas = bloque.filas
          .sort((a, b) => a.ms - b.ms || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0))
          .map(({ hora, asiento }) => ({ hora, asiento }));
        const nombres = personal.get(claveTurnoDeBloque(fecha, i));
        return {
          turno_literal: bloque.turno_literal,
          jefe: unirNombres(nombres?.jefes),
          ingenieros: unirNombres(nombres?.ingenieros),
          filas,
        };
      }),
    };
  });
}

// ── Fuente 1: Operación 24h (MAND) ───────────────────────────────────────────────────────────

// Un lote es UN renglón, no uno por periodo (RQ-04.8): el lote es una sola llamada del CND y el
// motor ya compacta sus periodos. Y varios lotes conviven en el mismo (tipo, periodo, día, planta)
// desde D-056 — el libro los muestra TODOS (RN-06.a / criterio 7); aplanarlos a un valor por
// periodo vaciaría de sentido a REQ-03.
async function eventosMand(pool, { plantas, desde, hasta, mand_id }) {
  if (!mand_id) return [];
  const rq = pool.request()
    .input('mand', sql.Int, mand_id)
    .input('desde', sql.Date, desde)
    .input('hasta', sql.Date, hasta);
  const enPlantas = bindPlantas(rq, plantas);
  const columnas = `
    r.registro_id, r.planta_id, r.fecha_evento, r.detalle,
    te.notificar_dashboard_tipo AS tipo,
    JSON_VALUE(r.campos_extra, '$.lote_id')                    AS lote_id,
    TRY_CAST(JSON_VALUE(r.campos_extra, '$.periodo') AS INT)   AS periodo,
    TRY_CAST(JSON_VALUE(r.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
    JSON_VALUE(r.campos_extra, '$.funcionariocnd')             AS funcionariocnd,
    JSON_VALUE(r.campos_extra, '$.hora_llamada')               AS hora_llamada`;
  const filtro = `
    WHERE r.bitacora_id = @mand
      AND r.planta_id IN (${enPlantas})
      AND CAST(DATEADD(HOUR, -5, r.fecha_evento) AS DATE) BETWEEN @desde AND @hasta`;

  const r = await rq.query(`
    SELECT ${columnas}
    FROM bitacora.registro_activo r
    INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    ${filtro}
    UNION ALL
    SELECT ${columnas}
    FROM bitacora.registro_historico r
    INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
    ${filtro}
    ORDER BY registro_id
  `);

  const lotes = agruparPorLote(r.recordset);
  const eventos = [];
  for (const lote of lotes) {
    const instante = horaCanonicaDeLote(lote);
    if (!instante) continue; // sin hora ni periodo utilizable no hay dónde ponerlo (no debería pasar)
    // El motor LANZA ante un tipo desconocido, y donde el texto se PERSISTE eso está bien (el
    // reflejo, E4). Acá se degrada y se loguea, igual que el listado del día (E2): este libro es
    // mensual y `notificar_dashboard_tipo` es NULLABLE, así que un tipo MAND nuevo tumbaría la
    // descarga del mes ENTERO. Se pierde un renglón, no el libro.
    const asiento = renderizar('MAND', lote.lote_id, () => asientoLote({
      tipo: lote.tipo,
      planta_id: lote.planta_id,
      periodos: lote.periodos,
      funcionariocnd: lote.funcionariocnd,
      detalle: lote.detalle,
    }));
    if (asiento) eventos.push(evento(instante, asiento, `1|${lote.lote_id}`));
  }
  return eventos;
}

// Agrupa las celdas por `campos_extra.lote_id`, deduplicando por `registro_id`.
//
// El dedupe cubre RN-06.d: `registro_historico` PRESERVA el `registro_id` original (no es IDENTITY),
// así que si una fila llegara a estar en las dos tablas a la vez —el instante del cierre diario, un
// archivado a medias— la unión la traería dos veces y el renglón saldría duplicado en la hoja. Es
// el riesgo que REQ-06 §5.4 marca como "hay que escribir la consulta con cuidado".
//
// La metadata del lote (hora, funcionario, descripción) se toma de su PRIMERA celda, asumiendo
// coherencia — igual que `GET /lotes`. Está replicada por celda y ningún constraint la sostiene: lo
// que la sostiene es el guard de coherencia de `sala_de_mando_batch.test.js` (D-056 (c)).
function agruparPorLote(filas) {
  const vistos = new Set();
  const porLote = new Map();
  for (const fila of filas) {
    if (vistos.has(fila.registro_id)) continue;
    vistos.add(fila.registro_id);
    if (!fila.lote_id) continue; // sin lote no hay agrupación posible; no debería quedar ninguno
    let lote = porLote.get(fila.lote_id);
    if (!lote) {
      lote = {
        lote_id: fila.lote_id,
        planta_id: fila.planta_id,
        tipo: fila.tipo,
        fecha_evento: fila.fecha_evento,
        hora_llamada: fila.hora_llamada ?? null,
        funcionariocnd: fila.funcionariocnd ?? null,
        detalle: fila.detalle ?? null,
        periodos: [],
      };
      porLote.set(fila.lote_id, lote);
    }
    lote.periodos.push({ periodo: fila.periodo, valor_mw: fila.valor_mw });
  }
  for (const lote of porLote.values()) lote.periodos.sort((a, b) => a.periodo - b.periodo);
  return [...porLote.values()];
}

// La hora de un lote de MAND es `campos_extra.hora_llamada` — **NUNCA `fecha_evento`** (D-056).
// `fecha_evento` es `SYSUTCDATETIME()` al guardar, o sea cuándo se DIGITÓ: un lote registrado a las
// 17:05 por una llamada de las 16:38 va en la fila de las **16:38**, que es para lo que D-056 creó
// el campo. Confundirlas mueve el renglón de bloque cuando la digitación cruza un umbral de turno.
//
// Y la clave puede estar **AUSENTE**, no nula: las 7 filas que migró `F32.A1` son anteriores al
// campo. Ahí la hora se DERIVA del primer periodo del lote (P17 → 16:00, respuesta 5), sobre el día
// Bogotá de su `fecha_evento` — que en esos registros sí es el día de la grilla. Es dato real del
// registro; no se inventa una hora ni se manda la fila al final del bloque.
function horaCanonicaDeLote(lote) {
  if (lote.hora_llamada) {
    const d = new Date(lote.hora_llamada);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const primero = lote.periodos.find((p) => Number.isInteger(p.periodo) && p.periodo >= 1);
  if (!primero || !lote.fecha_evento) return null;
  const [y, m, d] = partesBogota(lote.fecha_evento).fecha.split('-').map(Number);
  // Periodo N = la hora Bogotá N-1; el +5 la lleva a UTC (offset puro, Colombia sin DST — D-020).
  return new Date(Date.UTC(y, m - 1, d, primero.periodo - 1 + 5));
}

// ── Fuente 2: Disponibilidad (DISP) ──────────────────────────────────────────────────────────

// El estado se asienta UNA vez, en su instante de inicio — con eso queda resuelta la pregunta
// abierta §8.2 de REQ-06 (un estado que cruza la medianoche aparece en la hoja del día en que
// EMPEZÓ, igual que el T2 se fecha por su día de inicio; RN-06.c). `fecha_fin_estado` no genera
// renglón: el fin de un estado es el comienzo del siguiente, y asentarlo dos veces sería narrar el
// mismo hecho dos veces.
//
// Fuente: la tabla base `disponibilidad_estado`, NUNCA la vista `disponibilidad_dashboard` (D-041).
async function eventosDisponibilidad(pool, { plantas, desde, hasta }) {
  const rq = pool.request()
    .input('desde', sql.Date, desde)
    .input('hasta', sql.Date, hasta);
  const enPlantas = bindPlantas(rq, plantas);
  const r = await rq.query(`
    SELECT disponibilidad_id, planta_id, estado, detalle, fecha_inicio_estado
    FROM bitacora.disponibilidad_estado
    WHERE planta_id IN (${enPlantas})
      AND CAST(DATEADD(HOUR, -5, fecha_inicio_estado) AS DATE) BETWEEN @desde AND @hasta
    ORDER BY disponibilidad_id
  `);

  const eventos = [];
  for (const fila of r.recordset) {
    const asiento = renderizar('DISP', fila.disponibilidad_id, () => asientoDisponibilidad({
      planta_id: fila.planta_id,
      evento: fila.estado,
      detalle: fila.detalle,
    }));
    if (asiento) eventos.push(evento(fila.fecha_inicio_estado, asiento, `2|${fila.disponibilidad_id}`));
  }
  return eventos;
}

// ── Fuentes 3 y 4: las bitácoras de Sala (SALAJDT + SALAING) ─────────────────────────────────

// Texto LITERAL del ingeniero, con el prefijo de unidad condicional que agrega el motor (E1). Son
// los eventos que el sistema no puede generar —la rutina del turno, el relevo— y su valor está en
// que los escribió quien estuvo ahí.
//
// `SALAOP` NO entra: las cuatro fuentes del libro son MAND, DISP, SALAJDT y SALAING (§7.2).
//
// **El filtro de los reflejados es la línea que evita el triplicado** (respuesta 2): desde E4 cada
// lote de MAND se copia a las DOS bitácoras de Sala, así que sin `origen_lote_id IS NULL` el mismo
// evento saldría tres veces en la misma hoja. El libro lee siempre los ORIGINALES.
async function eventosSala(pool, { plantas, desde, hasta, sala_ids }) {
  const ids = sala_ids.filter((id) => id != null);
  if (ids.length === 0) return [];
  const rq = pool.request()
    .input('desde', sql.Date, desde)
    .input('hasta', sql.Date, hasta);
  const enPlantas = bindPlantas(rq, plantas);
  const enBitacoras = ids.map((id, i) => {
    rq.input(`sala${i}`, sql.Int, id);
    return `@sala${i}`;
  }).join(', ');

  const columnas = 'r.registro_id, r.planta_id, r.fecha_evento, r.detalle';
  const filtro = `
    WHERE r.bitacora_id IN (${enBitacoras})
      AND r.planta_id IN (${enPlantas})
      AND CAST(DATEADD(HOUR, -5, r.fecha_evento) AS DATE) BETWEEN @desde AND @hasta
      AND JSON_VALUE(r.campos_extra, '$.origen_lote_id') IS NULL`;

  const r = await rq.query(`
    SELECT ${columnas} FROM bitacora.registro_activo r ${filtro}
    UNION ALL
    SELECT ${columnas} FROM bitacora.registro_historico r ${filtro}
    ORDER BY registro_id
  `);

  const vistos = new Set();
  const eventos = [];
  for (const fila of r.recordset) {
    if (vistos.has(fila.registro_id)) continue; // mismo dedupe que MAND (RN-06.d)
    vistos.add(fila.registro_id);
    const asiento = asientoLiteralSala({ planta_id: fila.planta_id, texto: fila.detalle });
    // Un registro sin texto no produce renglón: una fila con hora y descripción vacía es ruido en
    // el papel. El motor no lo normaliza ni le inventa contenido.
    if (asiento) eventos.push(evento(fila.fecha_evento, asiento, `3|${fila.registro_id}`));
  }
  return eventos;
}

// ── Encabezado de cada bloque: JEFE DE TURNO / INGENIERO DE TURNO ─────────────────────────────

// Devuelve `Map<'YYYY-MM-DD|turno', {jefes:Set, ingenieros:Set}>` con la UNIÓN DEDUPLICADA de las
// dos unidades, sin etiquetar — como el papel (respuesta 4). Dos unidades con el mismo JdT dan UN
// nombre.
//
// Dos fuentes que se complementan y por eso van en `UNION`:
//   - `conformacion_turno` es el snapshot inmutable, pero se escribe **al CERRAR** el turno (D-045):
//     el turno en curso todavía no tiene fila.
//   - `turno_participante` es la presencia VIVA por unidad, y existe desde que alguien entra.
// Sin nada de lo dos, la celda queda EN BLANCO. No se infiere de `sesion_activa` ni se inventa un
// nombre: el papel también se deja en blanco cuando nadie lo llenó.
//
// Se excluyen los usuarios sintéticos (D-044, `es_sintetico = 1`): la suite corre contra la BD
// productiva (D-030) y un fixture jamás debe aparecer nombrado en un formato controlado. El escape
// hatch `incluirSinteticos` es el MISMO de `buildConformacionSnapshot`, con el mismo nombre a
// propósito: así lo cubre el guardrail estático que ya existe (D-044).
async function personalPorTurno(pool, { plantas, desde, hasta, incluirSinteticos }) {
  const rq = pool.request()
    // El bloque 00:00-06:00 del día F pertenece al turno con `fecha_operativa = F-1`, así que la
    // ventana de turnos arranca un día antes que la de eventos (que ya viene con su propia holgura).
    .input('desde', sql.Date, sumarDias(desde, -1))
    .input('hasta', sql.Date, hasta)
    .input('cargo_jefe', sql.VarChar(100), CARGO_JEFE)
    .input('cargo_ing', sql.VarChar(100), CARGO_INGENIERO)
    .input('incluir_sinteticos', sql.Bit, incluirSinteticos ? 1 : 0);
  const enPlantas = bindPlantas(rq, plantas);

  const r = await rq.query(`
    SELECT CONVERT(char(10), ct.fecha_operativa, 23) AS fecha_operativa, ct.turno,
           ct.cargo_nombre, ct.usuario_nombre
    FROM bitacora.conformacion_turno ct
    INNER JOIN lov_bit.usuario u ON u.usuario_id = ct.usuario_id
    WHERE ct.planta_id IN (${enPlantas})
      AND ct.fecha_operativa BETWEEN @desde AND @hasta
      AND ct.cargo_nombre IN (@cargo_jefe, @cargo_ing)
      AND (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
    UNION
    SELECT CONVERT(char(10), tu.fecha_operativa, 23) AS fecha_operativa, tu.turno,
           tp.cargo_nombre, tp.usuario_nombre
    FROM bitacora.turno_participante tp
    INNER JOIN bitacora.turno_unidad tu ON tu.turno_unidad_id = tp.turno_id
    INNER JOIN lov_bit.usuario u ON u.usuario_id = tp.usuario_id
    WHERE tu.planta_id IN (${enPlantas})
      AND tu.fecha_operativa BETWEEN @desde AND @hasta
      AND tp.cargo_nombre IN (@cargo_jefe, @cargo_ing)
      AND (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
  `);

  const porTurno = new Map();
  for (const fila of r.recordset) {
    const clave = `${fila.fecha_operativa}|${fila.turno}`;
    let nombres = porTurno.get(clave);
    if (!nombres) porTurno.set(clave, (nombres = { jefes: new Set(), ingenieros: new Set() }));
    const nombre = String(fila.usuario_nombre ?? '').trim();
    if (!nombre) continue;
    (fila.cargo_nombre === CARGO_JEFE ? nombres.jefes : nombres.ingenieros).add(nombre);
  }
  return porTurno;
}

// `(fecha_operativa, turno)` del turno que cubre el bloque `i` del día `fecha`. El primer bloque es
// la COLA del T2 que arrancó el día anterior — el sistema fecha el T2 por su día de inicio (D-045),
// así que ahí va `F-1`, no `F`. Es el mismo desfase que `fechaOperativaDePeriodo` resuelve para los
// periodos 1..6 de la grilla de MAND (D-055 (b)).
function claveTurnoDeBloque(fecha, i) {
  if (i === 0) return `${sumarDias(fecha, -1)}|2`;
  return `${fecha}|${i === 1 ? 1 : 2}`;
}

// Los nombres se unen con ` - `, como el papel (`Jose Saavedra - Luis Zapata`). Guion CORTO acá: el
// largo (`—`) está reservado para el prefijo de unidad de los renglones de Sala (decisión I), y
// mezclarlos haría ambiguo dónde termina un nombre. Orden alfabético para que dos corridas del
// mismo mes den el mismo archivo.
function unirNombres(conjunto) {
  if (!conjunto || conjunto.size === 0) return '';
  return [...conjunto].sort((a, b) => a.localeCompare(b, 'es')).join(' - ');
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────

async function resolverBitacoras(pool) {
  const r = await pool.request().query(`
    SELECT codigo, bitacora_id FROM lov_bit.bitacora
    WHERE codigo IN ('MAND', 'SALAJDT', 'SALAING')
  `);
  const porCodigo = Object.fromEntries(r.recordset.map((b) => [b.codigo, b.bitacora_id]));
  // Si faltara alguna, el libro sale sin esa fuente en vez de sin libro: es un reporte de solo
  // lectura y una bitácora ausente es un problema de configuración que ya grita en otro lado.
  for (const codigo of ['MAND', 'SALAJDT', 'SALAING']) {
    if (!porCodigo[codigo]) console.error(`[f03] falta la bitácora ${codigo} en lov_bit.bitacora`);
  }
  return porCodigo;
}

// `IN (@pl0, @pl1, …)` parametrizado: la lista nunca se interpola como literal.
function bindPlantas(rq, plantas) {
  return plantas.map((planta, i) => {
    rq.input(`pl${i}`, sql.VarChar(10), planta);
    return `@pl${i}`;
  }).join(', ');
}

// Un evento listo para ubicar y ordenar. `ms` es el instante real (el orden no puede depender del
// texto `HH:MM`, que empata a cada minuto) y `clave` desempata de forma estable.
function evento(instante, asiento, clave) {
  const d = instante instanceof Date ? instante : new Date(instante);
  const { fecha, hora, horaNum } = partesBogota(d);
  return { fecha, hora, horaNum, ms: d.getTime(), asiento, clave };
}

function indiceDeBloque(horaNum) {
  // Bordes cerrados por abajo y abiertos por arriba: 05:59 → primero, 06:00 → segundo, 18:00 →
  // tercero. Son las mismas fronteras que definen T1/T2 en el dominio.
  return BLOQUES.findIndex((b) => horaNum >= b.desde && horaNum < b.hasta);
}

const bloquesVacios = () => BLOQUES.map((b) => ({ turno_literal: b.turno_literal, filas: [] }));

// Fecha y hora de pared en Bogotá de un instante UTC. Se apoya en `fechaBogotaIso` (D-020) en vez
// de re-implementar el shift: una segunda implementación de la TZ es una segunda oportunidad de
// equivocarse. `fechaBogotaIso` devuelve `YYYY-MM-DDTHH:MM:SS-05:00`.
function partesBogota(instante) {
  const iso = fechaBogotaIso(instante);
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16), horaNum: Number(iso.slice(11, 13)) };
}

// Todos los días del mes, `YYYY-MM-DD`, ascendente. `Date.UTC(y, m, 0)` es el día 0 del mes
// siguiente, o sea el último del pedido: resuelve febrero y los bisiestos sin tabla.
function diasDelMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const cantidad = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: cantidad }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
}

// Aritmética de días sobre la CADENA, en UTC: `new Date('2026-07-01')` más `getDate()` local
// metería la zona horaria de la máquina en un cálculo que ya está resuelto en Bogotá (D-020).
function sumarDias(fecha, n) {
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// El motor lanza ante un tipo/estado que no conoce (E1) y acá eso se degrada a "sin renglón" + log.
// Es la misma decisión de E2 y por la misma razón: este libro es MENSUAL, así que un solo dato raro
// no puede tumbar la descarga entera. Donde el texto se PERSISTE (el reflejo, E4) sigue lanzando.
function renderizar(fuente, id, fn) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[f03] asiento no renderizable (${fuente} ${id}):`, e?.message ?? e);
    return null;
  }
}
