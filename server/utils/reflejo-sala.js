// D-058 (REQ-02) — Reflejo de los eventos de Operación 24h hacia las bitácoras de Sala de Mando.
//
// La bitácora del turno quedaba incompleta: lo que se autorizó, probó o redespachó se capturaba en
// otra pestaña y no dejaba rastro donde el ingeniero narra su turno. Acá vive la ÚNICA copia de esa
// mecánica (REQ-02 §5.2): la invocan la captura y la corrección de MAND, y mañana la de DISP. Si
// cada endpoint armara su propio INSERT, las copias divergirían del origen en silencio — que es
// justo lo que REQ-02 viene a eliminar.
//
// Invariantes que este módulo garantiza:
//   - El asiento sale del motor (`utils/asientos/`), nunca de un template local: el mismo texto
//     alimenta el listado del día, esta copia y el libro F03 (REQ-06).
//   - Se escribe en `SALAJDT` **y** `SALAING`, las dos siempre, sin importar cuál de los dos cargos
//     originó el evento (RQ-02.2). `SALAOP` nunca (RQ-02.3).
//   - El vínculo con el origen es `campos_extra.origen_lote_id` — por LOTE, no por registro: la
//     copia también migra al histórico en el cierre de turno de Sala, así que no hay FK posible
//     (mismo argumento que `evento_dashboard.registro_origen_id`, D-055 (c)).
//   - Todo ocurre dentro de la transacción del ORIGEN: o se aplica en los tres lados o en ninguno
//     (RQ-02.9). Este módulo nunca abre ni cierra transacciones, y nunca se traga un error.

import sql from 'mssql';
import { TEST_PLANTA_ID } from '../db.js';
import { asientoLote } from './asientos/index.js';
import { resolverTurnoAbierto } from './turno-entidad.js';
import { periodoFromFechaBogota, turnoFromPeriodo } from './turno.js';

// Las dos bitácoras destino, por `codigo` (identidad estable, D-052): un rename de la etiqueta
// visible no puede romper el reflejo. `SALAOP` queda fuera por RQ-02.3.
export const BITACORAS_REFLEJO = ['SALAJDT', 'SALAING'];

// Nombre del tipo espejo que le corresponde a cada tipo de MAND. Son los nombres LITERALES del
// catálogo de origen —'Autorización' con tilde, 'Pruebas' en plural—, sembrados en SALAJDT/SALAING
// con `seleccionable = 0` por F34.A1 (E3). El `tipo_evento_id` se resuelve por `(bitacora_id,
// nombre)` en cada llamada y JAMÁS se cachea: un id literal es exactamente el drift invisible que
// persigue `guard_tipo_evento_coherente.test.js` (D-053).
export const TIPO_ESPEJO_MAND = {
  AUTH: 'Autorización',
  PRUEBA: 'Pruebas',
  REDESP: 'Redespacho',
};

// RN-02.e — la planta-fixture no refleja. Vive acá, una sola vez, y no replicada en cada enganche:
// tres call sites (captura, corrección, borrado) y el de DISP cuando llegue; un guard copiado es un
// guard que alguien olvida. La suite corre contra la BD productiva (D-030), así que sin esto cada
// `npm test` sembraría asientos de prueba en las bitácoras de Sala.
export function plantaRefleja(planta_id) {
  return planta_id !== TEST_PLANTA_ID;
}

// ── Por qué `rowsAffected = 0` NO es un error, en la corrección y en el borrado ─────────────────
//
// Las copias viven en bitácoras de Sala, que SÍ cierran por turno (D-045): a las 18:01 el cierre ya
// las archivó a `registro_historico` y no queda ninguna viva que actualizar o borrar. Y hay un
// segundo caso igual de legítimo: los lotes ANTERIORES a D-058 nunca tuvieron copias — el reflejo no
// es retroactivo (RQ-02.13), así que corregir uno de ellos tampoco debe fabricarlas. Los dos son el
// caso ESPERADO, no una anomalía — y son exactamente la clase de "cero filas" que alguien va a
// querer "arreglar" con un `throw`, con un 409 o con un INSERT. NO LO ARREGLES:
//
//   - El histórico NO se reescribe (RF-032): lo que se asentó en el turno pasado quedó asentado.
//   - La corrección del origen PROCEDE IGUAL. Rechazarla volvería incorregible un lote a las 18:01
//     por el estado de su reflejo — invierte la jerarquía (el origen manda sobre la copia) y
//     contradice el criterio 12 de REQ-04, ya implementado y probado en D-057: MAND está EXENTA de
//     los gates de turno, y un 409 por "turno cerrado" reintroduciría por la puerta de atrás lo que
//     se excluyó por diseño.
//
// Por eso las dos funciones devuelven `{ copias }` en vez de lanzar: el número es informativo (sirve
// para tests y para depurar), nunca una condición de error.

// Los `bitacora_id` de los dos destinos, por `codigo`. Corregir y borrar no necesitan el tipo de
// evento —el TIPO de un lote es INMUTABLE (D-057, decisión 11)—, así que acá alcanza con acotar el
// DML a las dos bitácoras de Sala. Ese `IN` no es decorativo: sin él, el UPDATE/DELETE por
// `origen_lote_id` alcanzaría cualquier fila que mañana use la misma clave (el reflejo de DISP, sin
// ir más lejos), y el borrado de un lote de MAND se llevaría por delante asientos ajenos.
async function resolverBitacorasDestino(tx) {
  const r = await new sql.Request(tx).query(`
    SELECT codigo, bitacora_id
    FROM lov_bit.bitacora
    WHERE codigo IN ('SALAJDT', 'SALAING')
  `);
  const porCodigo = new Map(r.recordset.map((row) => [row.codigo, row.bitacora_id]));
  const faltantes = BITACORAS_REFLEJO.filter((c) => !porCodigo.has(c));
  if (faltantes.length > 0) {
    throw new Error(`reflejo-sala: falta la bitácora destino ${faltantes.join(', ')} en lov_bit.bitacora`);
  }
  return BITACORAS_REFLEJO.map((codigo) => porCodigo.get(codigo));
}

// Resuelve, en una sola ida a la BD, el par (bitacora_id, tipo_evento_id) de cada destino para el
// tipo espejo pedido. Falla FUERTE si falta alguno: sin los 8 tipos de F34.A1 el INSERT metería un
// `tipo_evento_id` de otra bitácora (no hay FK ni CHECK que lo impida) y el drift solo se notaría
// meses después, con el dato ya en el histórico inmutable.
async function resolverDestinos(tx, { nombreTipo }) {
  const r = await new sql.Request(tx)
    .input('nombre', sql.VarChar(100), nombreTipo)
    .query(`
      SELECT b.codigo, b.bitacora_id, te.tipo_evento_id
      FROM lov_bit.bitacora b
      INNER JOIN lov_bit.tipo_evento te
              ON te.bitacora_id = b.bitacora_id AND te.nombre = @nombre
      WHERE b.codigo IN ('SALAJDT', 'SALAING')
      ORDER BY b.codigo
    `);
  const porCodigo = new Map(r.recordset.map((row) => [row.codigo, row]));
  const faltantes = BITACORAS_REFLEJO.filter((c) => !porCodigo.has(c));
  if (faltantes.length > 0) {
    throw new Error(
      `reflejo-sala: falta el tipo espejo "${nombreTipo}" en ${faltantes.join(', ')} (seed F34.A1)`,
    );
  }
  return BITACORAS_REFLEJO.map((codigo) => porCodigo.get(codigo));
}

// Núcleo compartido por la CAPTURA y la CORRECCIÓN: valida lo que una copia no puede tener mal y
// devuelve el texto y la hora ya normalizados. Vive una sola vez a propósito — si crear y corregir
// armaran el asiento por su cuenta, un lote corregido podría quedar redactado distinto del mismo
// lote recién capturado, que es la divergencia que REQ-02 elimina.
function normalizarLote({ lote_id, tipo, planta_id, periodos, funcionariocnd, detalle, hora_llamada }) {
  const nombreTipo = TIPO_ESPEJO_MAND[tipo];
  if (!nombreTipo) throw new TypeError(`reflejo-sala: tipo de evento sin espejo (${tipo})`);
  if (!lote_id) throw new TypeError('reflejo-sala: lote_id es obligatorio (es el vínculo con el origen)');

  // `fecha_evento` = la HORA DE LA LLAMADA, no el instante de la escritura. Es un dato narrativo: el
  // asiento tiene que leerse donde el operador lo espera, y coincidir con la fila del listado del día
  // y con el renglón del F03. Un lote registrado 17:05 por una llamada de las 16:38 se asienta a las
  // 16:38, y si la corrección MUEVE esa hora, la copia se mueve con ella. La captura y la corrección
  // de MAND la exigen y la validan contra el reloj del servidor, así que faltar acá es un bug del
  // llamador — y una copia sin hora sería impublicable en el F03 (REQ-06).
  const horaLlamada = hora_llamada instanceof Date ? hora_llamada : new Date(hora_llamada);
  if (!hora_llamada || Number.isNaN(horaLlamada.getTime())) {
    throw new TypeError('reflejo-sala: hora_llamada inválida o ausente');
  }

  // El asiento lo arma el MOTOR (E1). Que el `detalle` de la copia SEA esa salida es lo que hace
  // imposible que el listado del día y la bitácora de Sala digan cosas distintas del mismo evento.
  const asiento = asientoLote({ tipo, planta_id, periodos, funcionariocnd, detalle });
  // Un renglón en blanco en la bitácora del turno es peor que un error —el `detalle` de la copia es
  // TODO su contenido—, y el lote sin celdas ya lo rechazan los endpoints con `lote_sin_celdas`
  // (D-057), así que llegar acá vacío es un bug del llamador. Nunca una copia muda.
  if (!asiento) throw new Error(`reflejo-sala: el motor devolvió un asiento vacío (lote ${lote_id})`);

  // `turno` (la columna vieja, 1|2) se deriva de la hora del asiento: describe cuándo pasó, no dónde
  // se archiva. Misma cadena que usa MAND para sus celdas, para que no puedan divergir.
  const turno = turnoFromPeriodo(periodoFromFechaBogota(horaLlamada));

  return { nombreTipo, horaLlamada, asiento, turno };
}

/**
 * Crea las DOS copias de un lote de Operación 24h en las bitácoras de Sala.
 *
 * @param {sql.Transaction} tx  La transacción del ORIGEN. No se abre ni se cierra acá.
 * @param {object} lote
 * @param {string} lote.planta_id
 * @param {string} lote.lote_id        GUID del lote (D-056), el vínculo origen ↔ copias.
 * @param {'AUTH'|'PRUEBA'|'REDESP'} lote.tipo
 * @param {Array<{periodo:number, valor_mw:number}>} lote.periodos  Celdas CON valor del lote.
 * @param {string|null} lote.funcionariocnd
 * @param {string|null} lote.detalle
 * @param {string|Date} lote.hora_llamada  Instante UTC de la llamada del CND.
 * @param {number} lote.creado_por      Autor del ORIGEN (RN-02.c), nunca SISTEMA.
 * @param {{ingenieros_snapshot:string, jdts_snapshot:string, jefes_snapshot:string}} lote.snapshots
 *        Los que la transacción del origen YA calculó. No se recalculan: son el mismo instante.
 * @returns {Promise<{copias:number, omitido?:string, asiento?:string}>}
 */
export async function crearReflejoLote(tx, {
  planta_id,
  lote_id,
  tipo,
  periodos,
  funcionariocnd = null,
  detalle = null,
  hora_llamada,
  creado_por,
  snapshots,
} = {}) {
  if (!plantaRefleja(planta_id)) return { copias: 0, omitido: 'planta_de_test' };
  if (!creado_por) throw new TypeError('reflejo-sala: creado_por es obligatorio (RN-02.c)');

  const { nombreTipo, horaLlamada, asiento, turno } = normalizarLote({
    lote_id, tipo, planta_id, periodos, funcionariocnd, detalle, hora_llamada,
  });

  // `turno_id` NO es narrativo: es el PUNTERO DE ARCHIVADO (D-045). Sale del turno ABIERTO de la
  // unidad —no de la hora del asiento— porque si apuntara a un turno ya CERRADO nadie archivaría la
  // copia jamás y quedaría viva en `registro_activo` para siempre, apareciendo en la bitácora de
  // Sala meses después; el rescate de huérfanos de D-045 tampoco la alcanzaría, porque solo levanta
  // los de `turno_id IS NULL` en-ventana. Por eso NULL cuando no hay turno abierto (la ventana de
  // transición de D-046): ahí sí lo levanta el rescate.
  //
  // Esto NO contradice a D-055 (b), que resuelve el `turno_id` de una celda MAND por su PERIODO:
  // allá la celda pertenece a UN periodo; acá el asiento es del LOTE ENTERO, cuyos periodos pueden
  // caer en dos turnos, así que no hay turno semántico único y manda el criterio de archivado.
  const turnoAbierto = await resolverTurnoAbierto(tx, planta_id);
  const turno_id = turnoAbierto?.turno_unidad_id ?? null;

  const campos_extra = JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: lote_id });
  const destinos = await resolverDestinos(tx, { nombreTipo });

  for (const destino of destinos) {
    await new sql.Request(tx)
      .input('bitacora_id', sql.Int, destino.bitacora_id)
      .input('planta', sql.VarChar(10), planta_id)
      .input('fecha_evento', sql.DateTime2, horaLlamada)
      .input('turno', sql.TinyInt, turno)
      .input('turno_id', sql.Int, turno_id)
      .input('detalle', sql.NVarChar(sql.MAX), asiento)
      .input('campos_extra', sql.NVarChar(sql.MAX), campos_extra)
      .input('te', sql.Int, destino.tipo_evento_id)
      .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), snapshots?.ingenieros_snapshot ?? '[]')
      .input('jdts_snapshot', sql.NVarChar(sql.MAX), snapshots?.jdts_snapshot ?? '[]')
      .input('jefes_snapshot', sql.NVarChar(sql.MAX), snapshots?.jefes_snapshot ?? '[]')
      // RN-02.c: el autor de la copia es el AUTOR DEL ORIGEN, nunca el usuario SISTEMA. El histórico
      // de Sala tiene que ser coherente con quién registró el evento.
      .input('creado_por', sql.Int, creado_por)
      .query(`
        INSERT INTO bitacora.registro_activo
          (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
           estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id)
        VALUES (@bitacora_id, @planta, @fecha_evento, @turno, @detalle, @campos_extra, @te,
                'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por,
                @turno_id)
      `);
  }

  return { copias: destinos.length, asiento };
}

/**
 * Reescribe las copias vivas de un lote corregido (D-057 → `PUT /api/sala-de-mando/lotes/:lote_id`).
 *
 * Decisión H: corregir el lote REGENERA el texto; no se agrega un renglón de corrección. La bitácora
 * de Sala muestra el estado ACTUAL del evento —que es lo que REQ-02 pide— y el rastro de la
 * corrección vive en `modificado_por`/`modificado_en`, no en un asiento duplicado que obligaría al
 * lector a reconstruir cuál de los dos vale.
 *
 * Recibe el estado POSTERIOR al diff, nunca el body crudo: el texto tiene que describir lo que quedó
 * en la BD. El `tipo` llega solo para poder renderizar la plantilla — es INMUTABLE (D-057, decisión
 * 11), así que `tipo_evento_id` no se toca ni acá ni en el origen.
 *
 * `turno_id` tampoco se re-resuelve: es el puntero de archivado que se fijó al crear la copia
 * (D-045). Reapuntarlo al turno abierto de HOY movería una copia de turno por el solo hecho de
 * corregir el origen, y no arreglaría nada — si su turno ya hubiera cerrado, la copia no estaría
 * viva acá.
 *
 * @param {sql.Transaction} tx  La transacción del ORIGEN. No se abre ni se cierra acá.
 * @param {object} lote  Mismos campos que `crearReflejoLote`, con `modificado_por` en vez de
 *                       `creado_por`: la autoría original NO se pisa (RN-02.c sigue rigiendo).
 * @returns {Promise<{copias:number, omitido?:string, asiento?:string}>} `copias = 0` NO es error.
 */
export async function actualizarReflejoLote(tx, {
  planta_id,
  lote_id,
  tipo,
  periodos,
  funcionariocnd = null,
  detalle = null,
  hora_llamada,
  modificado_por,
} = {}) {
  if (!plantaRefleja(planta_id)) return { copias: 0, omitido: 'planta_de_test' };
  if (!modificado_por) throw new TypeError('reflejo-sala: modificado_por es obligatorio (quién corrigió)');

  const { horaLlamada, asiento, turno } = normalizarLote({
    lote_id, tipo, planta_id, periodos, funcionariocnd, detalle, hora_llamada,
  });

  const [salajdt, salaing] = await resolverBitacorasDestino(tx);

  // La búsqueda es por `origen_lote_id`, NUNCA por `registro_id`: la copia también migra al
  // histórico en el cierre de turno de Sala, así que no hay FK posible ni id estable que guardar en
  // el origen (mismo argumento que `evento_dashboard.registro_origen_id`, D-055 (c)).
  //
  // El sello de auditoría va por CASE contra el valor ANTERIOR (SQL Server evalúa todas las
  // expresiones del SET contra la fila original): una corrección que no mueve el asiento ni la hora
  // no marca la copia como modificada. Es la misma paridad que aplica el origen en `mand.js`, donde
  // solo se sellan las celdas AFECTADAS (D-057, decisión 2).
  const r = await new sql.Request(tx)
    .input('lote', sql.NVarChar(64), lote_id)
    .input('planta', sql.VarChar(10), planta_id)
    .input('salajdt', sql.Int, salajdt)
    .input('salaing', sql.Int, salaing)
    .input('detalle', sql.NVarChar(sql.MAX), asiento)
    .input('fecha_evento', sql.DateTime2, horaLlamada)
    .input('turno', sql.TinyInt, turno)
    .input('modificado_por', sql.Int, modificado_por)
    .query(`
      UPDATE bitacora.registro_activo
      SET modificado_por = CASE WHEN detalle <> @detalle OR fecha_evento <> @fecha_evento
                                THEN @modificado_por ELSE modificado_por END,
          modificado_en  = CASE WHEN detalle <> @detalle OR fecha_evento <> @fecha_evento
                                THEN SYSUTCDATETIME() ELSE modificado_en END,
          detalle        = @detalle,
          fecha_evento   = @fecha_evento,
          turno          = @turno
      WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote
        AND planta_id = @planta
        AND bitacora_id IN (@salajdt, @salaing)
    `);

  // `rowsAffected = 0` es el caso ESPERADO cuando el cierre de turno de Sala ya archivó las copias.
  // No se lanza ni se responde 409: ver el bloque de arriba, y no lo "arregles".
  return { copias: r.rowsAffected[0] ?? 0, asiento };
}

/**
 * Borra las copias vivas de un lote eliminado (D-057 → `DELETE /api/sala-de-mando/lotes/:lote_id`).
 *
 * Borrado REAL, no anulación, por la misma razón que en el origen (RN-04.c): el asiento describía un
 * evento que se registró por error, y un renglón tachado en la bitácora del turno no informa —
 * confunde. Lo que ya pasó al histórico se queda ahí (RF-032).
 *
 * @param {sql.Transaction} tx  La transacción del ORIGEN. No se abre ni se cierra acá.
 * @returns {Promise<{copias:number, omitido?:string}>} `copias = 0` NO es error.
 */
export async function borrarReflejoLote(tx, { planta_id, lote_id } = {}) {
  if (!plantaRefleja(planta_id)) return { copias: 0, omitido: 'planta_de_test' };
  if (!lote_id) throw new TypeError('reflejo-sala: lote_id es obligatorio (es el vínculo con el origen)');

  const [salajdt, salaing] = await resolverBitacorasDestino(tx);

  // Mismo criterio de búsqueda que el UPDATE: por `origen_lote_id`, acotado a la planta del origen y
  // a las dos bitácoras de Sala. El `IN` importa: sin él, el DELETE alcanzaría cualquier fila que
  // mañana reuse la clave (el reflejo de DISP tiene su propio ADR pendiente).
  const r = await new sql.Request(tx)
    .input('lote', sql.NVarChar(64), lote_id)
    .input('planta', sql.VarChar(10), planta_id)
    .input('salajdt', sql.Int, salajdt)
    .input('salaing', sql.Int, salaing)
    .query(`
      DELETE FROM bitacora.registro_activo
      WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote
        AND planta_id = @planta
        AND bitacora_id IN (@salajdt, @salaing)
    `);

  // `rowsAffected = 0` es el caso ESPERADO cuando el cierre de turno de Sala ya archivó las copias.
  // No se lanza: ver el bloque de arriba.
  return { copias: r.rowsAffected[0] ?? 0 };
}
