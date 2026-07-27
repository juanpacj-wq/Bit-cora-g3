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
// con `seleccionable = 0` por F33.A1 (E3). El `tipo_evento_id` se resuelve por `(bitacora_id,
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

// Resuelve, en una sola ida a la BD, el par (bitacora_id, tipo_evento_id) de cada destino para el
// tipo espejo pedido. Falla FUERTE si falta alguno: sin los 8 tipos de F33.A1 el INSERT metería un
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
      `reflejo-sala: falta el tipo espejo "${nombreTipo}" en ${faltantes.join(', ')} (seed F33.A1)`,
    );
  }
  return BITACORAS_REFLEJO.map((codigo) => porCodigo.get(codigo));
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

  const nombreTipo = TIPO_ESPEJO_MAND[tipo];
  if (!nombreTipo) throw new TypeError(`reflejo-sala: tipo de evento sin espejo (${tipo})`);
  if (!lote_id) throw new TypeError('reflejo-sala: lote_id es obligatorio (es el vínculo con el origen)');
  if (!creado_por) throw new TypeError('reflejo-sala: creado_por es obligatorio (RN-02.c)');

  // `fecha_evento` = la HORA DE LA LLAMADA, no el instante de la escritura. Es un dato narrativo: el
  // asiento tiene que leerse donde el operador lo espera, y coincidir con la fila del listado del día
  // y con el renglón del F03. Un lote registrado 17:05 por una llamada de las 16:38 se asienta a las
  // 16:38. La captura de MAND la exige y la valida contra el reloj del servidor, así que faltar acá
  // es un bug del llamador — y una copia sin hora sería impublicable en el F03 (REQ-06).
  const horaLlamada = hora_llamada instanceof Date ? hora_llamada : new Date(hora_llamada);
  if (!hora_llamada || Number.isNaN(horaLlamada.getTime())) {
    throw new TypeError('reflejo-sala: hora_llamada inválida o ausente');
  }

  // El asiento lo arma el MOTOR (E1). Que el `detalle` de la copia SEA esa salida es lo que hace
  // imposible que el listado del día y la bitácora de Sala digan cosas distintas del mismo evento.
  const asiento = asientoLote({ tipo, planta_id, periodos, funcionariocnd, detalle });
  // `registro_activo.detalle` es NOT NULL y un renglón en blanco en la bitácora del turno es peor
  // que un error: el lote sin celdas ya lo rechaza el endpoint con `lote_sin_celdas` (D-057), así que
  // llegar acá vacío es un bug. Nunca una copia muda.
  if (!asiento) throw new Error(`reflejo-sala: el motor devolvió un asiento vacío (lote ${lote_id})`);

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

  // `turno` (la columna vieja, 1|2) sí se deriva de la hora del asiento: describe cuándo pasó, no
  // dónde se archiva. Misma cadena que usa MAND para sus celdas, para que no puedan divergir.
  const turno = turnoFromPeriodo(periodoFromFechaBogota(horaLlamada));

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
