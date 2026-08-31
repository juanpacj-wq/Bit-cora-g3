// D-064 — El escritor del asiento. Es el ÚNICO módulo del flujo que crea filas, y las crea en las
// bitácoras de Sala de plantas REALES, así que todo acá está escrito a la defensiva.
//
// ── Las cuatro filas son UNA sola cosa ──────────────────────────────────────────────────────────
// El asiento son 4 filas —`SALAJDT` y `SALAING`, por cada una de las dos unidades— que comparten
// `detalle`, `fecha_evento` y `campos_extra.clave_asiento`, y por eso el libro F03 las colapsa a un
// renglón (contrato C5). Se escriben en UNA transacción: o están las cuatro o no está ninguna. Si
// quedaran tres, el libro imprimiría el renglón igual (colapsa por clave) y nadie notaría que a una
// bitácora le falta el asiento hasta que alguien la lea a mano meses después.
//
// La coherencia de las cuatro NO la sostiene ningún constraint: el colapso del libro se queda con
// el `detalle` y la hora de la fila de MENOR `registro_id` y descarta las otras tres sin avisar. Por
// eso el texto, la hora y el `campos_extra` se calculan UNA vez, arriba del bucle, y se heredan —
// nunca se recalculan por fila. Es el mismo cuidado del gotcha (b) de D-058, y lo fija el guard de
// coherencia de `tests/despacho_xm.test.js` (equivalente al `verificarCoherenciaDeLotes()` que
// D-056 (c) tiene para los lotes de MAND).
//
// ── La idempotencia mira LAS DOS tablas ─────────────────────────────────────────────────────────
// `clave_asiento` se busca en `registro_activo` Y en `registro_historico`. Un asiento de hace tres
// días YA fue archivado por el cierre de turno: buscarlo solo en el activo lo escribiría de nuevo,
// que es exactamente el caso que ejercita el relleno del mes.
//
// ── Lo que este asiento NO hace ─────────────────────────────────────────────────────────────────
// No llena ninguna celda de la grilla de Operación 24h (RQ-05.11) y no escribe en
// `evento_dashboard` ni en `disponibilidad_dashboard` (RQ-05.12): el dato vino del dashboard y
// reenviárselo sería un ciclo. Tampoco se edita ni se borra desde la interfaz, y eso NO hay que
// programarlo — el autor es SISTEMA, que nunca tiene sesión, y `canEditarRegistro` (D-049) ya exige
// autoría. `permissions.js` no se toca.

import sql from 'mssql';
import { USUARIO_SISTEMA_ID } from '../../db.js';
import {
  asientoDespachoXM,
  claveAsientoDespacho,
  camposExtraDespacho,
  BITACORAS_ASIENTO_SISTEMA,
  TIPO_EVENTO_DESPACHO_XM,
} from '../asientos/sistema.js';
import { resolverTurnoAbierto } from '../turno-entidad.js';
import { periodoFromFechaBogota, turnoFromPeriodo } from '../turno.js';

// Las unidades que se asientan. Congelada: es un array exportado y un `.push()` de cualquier
// consumidor lo contaminaría para todo el proceso (la lección de R7 sobre las constantes de L02).
//
// Las Guajiras (`TGJ1`/`TGJ2`) NO están y no es un olvido: el despacho que anuncia este asiento es
// el de G3.0 y G3.2, y Bitácora solo opera las dos plantas térmicas de Gecelca. Un hecho de la
// tabla del dashboard no trae planta —anuncia un DÍA—, así que la lista de destinos la decide este
// módulo y nadie más.
export const PLANTAS_DESPACHO = Object.freeze(['GEC3', 'GEC32']);

/**
 * Escribe el asiento del despacho del día `fecha_despacho` en las bitácoras de Sala.
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} opciones
 * @param {string}  opciones.fecha_despacho  'YYYY-MM-DD' — el día que anuncia (el siguiente).
 * @param {Date}    opciones.detectado_en    instante de detección, ya en UTC (lo convierte el lector).
 * @param {boolean} [opciones.hora_estimada=false]  `true` solo para el relleno del mes (RQ-05.14).
 * @param {string[]} [opciones.plantas=PLANTAS_DESPACHO]  inyectable SOLO para tests.
 * @returns {Promise<{creado: boolean, filas: number, motivo?: 'ya_existe'}>}
 * @throws {TypeError} si la fecha no es 'YYYY-MM-DD' válida (lo lanza el módulo de L02) o si
 *   `detectado_en` no es una fecha real. El llamador decide qué hacer: saltarse ese día y loguearlo.
 *
 * `plantas` es inyectable y no es un adorno: la suite corre contra la BD PRODUCTIVA (D-030), así
 * que sin este parámetro no habría forma de probar el escritor sin sembrar asientos en GEC3/GEC32.
 * Es la contramedida ESTRUCTURAL de D-061 — el guard estático solo ve el DML literal del test, y una
 * escritura que entra por el `default` de una función de producción le es invisible.
 */
export async function crearAsientoDespacho(pool, {
  fecha_despacho,
  detectado_en,
  hora_estimada = false,
  plantas = PLANTAS_DESPACHO,
} = {}) {
  // El texto, la clave y el `campos_extra` los produce el módulo PURO de L02. No se replican acá:
  // dos productores del mismo string es la receta de buscar con una clave y escribir otra.
  // Los tres validan la fecha y LANZAN si no existe (`2026-02-30` rueda al 2 de marzo en JS, sin
  // avisar): un asiento mal fechado se queda en un libro mensual firmado que nadie contrasta.
  const detalle = asientoDespachoXM(fecha_despacho);
  const clave = claveAsientoDespacho(fecha_despacho);
  const campos_extra = JSON.stringify(camposExtraDespacho({ fecha_despacho, hora_estimada }));

  const fecha_evento = detectado_en instanceof Date ? detectado_en : new Date(detectado_en);
  if (!detectado_en || Number.isNaN(fecha_evento.getTime())) {
    throw new TypeError(
      `crearAsientoDespacho: detectado_en inválido o ausente (llegó ${JSON.stringify(detectado_en)})`,
    );
  }

  const unidades = Array.isArray(plantas) ? plantas.filter(Boolean) : [];
  if (unidades.length === 0) {
    throw new TypeError('crearAsientoDespacho: `plantas` no puede quedar vacía');
  }

  // Precedente `mand-sweeper.js:32-34`: si el autor del sistema no está resuelto, se LANZA. Escribir
  // con un autor inventado dejaría filas atribuidas a una persona en el histórico append-only.
  if (!USUARIO_SISTEMA_ID) {
    throw new Error('crearAsientoDespacho: USUARIO_SISTEMA_ID no inicializado (initDB no corrió)');
  }

  // La columna `turno` (1|2) SÍ es la del evento: describe cuándo pasó. Se calcula UNA vez, desde la
  // hora de detección, y la heredan las cuatro filas — igual que `fecha_evento`. El `turno_id`, en
  // cambio, es otra cosa por completo; ver abajo.
  const turno = turnoFromPeriodo(periodoFromFechaBogota(fecha_evento));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (await existeAsiento(transaction, clave)) {
      await transaction.commit();
      return { creado: false, filas: 0, motivo: 'ya_existe' };
    }

    const destinos = await resolverDestinos(transaction);

    let filas = 0;
    for (const planta_id of unidades) {
      // `turno_id` NO es narrativo: es el PUNTERO DE ARCHIVADO (D-045, D-058 gotcha (c)). Sale del
      // turno ABIERTO de ESA unidad al momento de escribir, o `NULL` si no hay ninguno. Apuntarlo al
      // turno que le tocaría a la hora del evento —que para un relleno de hace tres semanas ya está
      // CERRADO— dejaría la fila viva en `registro_activo` para siempre: ningún cierre la archivaría
      // y aparecería en la bitácora de Sala meses después. Con `NULL` la levanta el rescate de
      // huérfanos del primer cierre que venga (D-063, decisión D6).
      const turnoAbierto = await resolverTurnoAbierto(transaction, planta_id);
      const turno_id = turnoAbierto?.turno_unidad_id ?? null;

      for (const destino of destinos) {
        await new sql.Request(transaction)
          .input('bitacora_id', sql.Int, destino.bitacora_id)
          .input('planta', sql.VarChar(10), planta_id)
          .input('fecha_evento', sql.DateTime2, fecha_evento)
          .input('turno', sql.TinyInt, turno)
          .input('turno_id', sql.Int, turno_id)
          .input('detalle', sql.NVarChar(sql.MAX), detalle)
          .input('campos_extra', sql.NVarChar(sql.MAX), campos_extra)
          .input('te', sql.Int, destino.tipo_evento_id)
          .input('creado_por', sql.Int, USUARIO_SISTEMA_ID)
          .query(`
            INSERT INTO bitacora.registro_activo
              (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id)
            VALUES (@bitacora_id, @planta, @fecha_evento, @turno, @detalle, @campos_extra, @te,
                    'borrador', '[]', '[]', '[]', @creado_por, @turno_id)
          `);
        filas += 1;
      }
    }

    await transaction.commit();
    return { creado: true, filas };
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }
}

// La idempotencia de RQ-05.13/15: la MISMA clave no se escribe dos veces, ni aunque su asiento ya
// haya sido archivado. Va DENTRO de la transacción para que dos llamadas simultáneas —el barrido y
// el relleno corriendo a mano— no puedan colarse las dos entre la consulta y el INSERT.
//
// `ISJSON(...) = 1` antes del `JSON_VALUE`: en modo lax `JSON_VALUE` LANZA sobre un `campos_extra`
// malformado (`RequestError 13609`) y no hay CHECK que lo impida, así que una sola fila corrupta en
// cualquier parte de la tabla dejaría al sweeper sin poder escribir ningún asiento nunca más.
//
// El filtro por bitácora no es cosmético: acota la búsqueda a las dos de Sala (índices
// `IX_ra_bitacora` / `IX_rh_bit`) en vez de recorrer el histórico entero cada cinco minutos.
async function existeAsiento(tx, clave) {
  const codigos = listaDeCodigos();
  const r = await new sql.Request(tx)
    .input('clave', sql.NVarChar(200), clave)
    .query(`
      SELECT TOP 1 1 AS x
      FROM bitacora.registro_activo ra
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
      WHERE b.codigo IN (${codigos})
        AND ra.campos_extra IS NOT NULL AND ISJSON(ra.campos_extra) = 1
        AND JSON_VALUE(ra.campos_extra, '$.clave_asiento') = @clave
      UNION ALL
      SELECT TOP 1 1 AS x
      FROM bitacora.registro_historico rh
      INNER JOIN lov_bit.bitacora b ON b.bitacora_id = rh.bitacora_id
      WHERE b.codigo IN (${codigos})
        AND rh.campos_extra IS NOT NULL AND ISJSON(rh.campos_extra) = 1
        AND JSON_VALUE(rh.campos_extra, '$.clave_asiento') = @clave
    `);
  return r.recordset.length > 0;
}

// Resuelve, en UNA sola ida a la BD, el par `(bitacora_id, tipo_evento_id)` de cada bitácora de Sala
// para el tipo `'Despacho económico'` (contrato C6, sembrado por F36.A1). Copiado en forma de
// `reflejo-sala.js:105-130` y por la misma razón: si el tipo se resolviera aparte, el INSERT podría
// llevar el `tipo_evento_id` de OTRA bitácora — no hay FK ni CHECK que lo impida y el drift es
// invisible hasta que alguien abre el editor, con el dato ya en el histórico (D-053).
//
// NUNCA por id fijo: los ids son distintos en cada base (en `PortalG3_dev` se recrearon durante la
// verificación de L03). Falla FUERTE si falta alguno — sin el seed no hay dónde escribir.
async function resolverDestinos(tx) {
  const r = await new sql.Request(tx)
    .input('nombre', sql.VarChar(100), TIPO_EVENTO_DESPACHO_XM)
    .query(`
      SELECT b.codigo, b.bitacora_id, te.tipo_evento_id
      FROM lov_bit.bitacora b
      INNER JOIN lov_bit.tipo_evento te
              ON te.bitacora_id = b.bitacora_id AND te.nombre = @nombre
      WHERE b.codigo IN (${listaDeCodigos()})
      ORDER BY b.codigo
    `);
  const porCodigo = new Map(r.recordset.map((row) => [row.codigo, row]));
  const faltantes = BITACORAS_ASIENTO_SISTEMA.filter((c) => !porCodigo.has(c));
  if (faltantes.length > 0) {
    throw new Error(
      `crearAsientoDespacho: falta el tipo "${TIPO_EVENTO_DESPACHO_XM}" en ${faltantes.join(', ')} (seed F36.A1)`,
    );
  }
  return BITACORAS_ASIENTO_SISTEMA.map((codigo) => porCodigo.get(codigo));
}

// Los códigos de Sala, entrecomillados para un `IN (...)`. Se interpolan y no se bindean porque son
// una constante congelada del módulo de L02 (`BITACORAS_ASIENTO_SISTEMA`), no un dato de entrada: no
// hay cadena de usuario que llegue hasta acá.
function listaDeCodigos() {
  return BITACORAS_ASIENTO_SISTEMA.map((c) => `'${c}'`).join(', ');
}
