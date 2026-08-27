// Router de Combustibles → Consumos (E7, AUD-34/35; D-027/D-034). Montado bajo /api/combustibles
// tras requireEntra. catálogo (read) + consumos GET (pivot planta×fecha) + consumos POST (batch)
// + revertir al valor del SIS + scrape manual del SIS y su estado (D-061).
// COMB_BITACORA_ID se resuelve vía dbBindings (live binding, asignado al final de initDB).

import express from 'express';
import sql from 'mssql';
import * as dbBindings from '../db.js';
import { getDB } from '../db.js';
import { sendJSON } from '../utils/http.js';
import { hasPermisoBitacora } from '../middleware/permissions.js';
import { fechaBogotaStr } from '../utils/turno.js';
import { estadoSisLock } from '../utils/sis/sis-lock.js';
import { estadoScrapeJob, iniciarScrapeJob } from '../utils/sis/sis-job.js';
import { asyncH, loadAppSession } from './_middleware.js';

const router = express.Router();
router.use(loadAppSession);

// D-061 (L02): plantas válidas en TODOS los endpoints del router. TEST_PLANTA_ID entra para que las
// suites de COMB/SIS operen fuera de GEC3/GEC32 (higiene D-055: la suite corre contra la BD
// productiva). Helper ÚNICO: antes el literal ['GEC3','GEC32'] estaba repetido en tres endpoints y
// esa duplicación fue la raíz del pendiente D-055 en COMB. Sale del live binding de db.js, nunca
// del literal 'TST'.
function plantaCombValida(planta_id) {
  return ['GEC3', 'GEC32', dbBindings.TEST_PLANTA_ID].includes(planta_id);
}

// Respuesta única para planta inválida — el front ramifica por `codigo`, nunca por texto (D-032).
const ERR_PLANTA = {
  error: 'planta_id inválido',
  codigo: 'planta_invalida',
  mensaje: 'La planta indicada no maneja consumos de combustible.',
};

// Plantas con lecturas del SIS. Predicado MÁS ESTRICTO que `plantaCombValida`: GEC3 es una planta
// válida de COMB (se le registran consumos a mano) pero NO tiene SIS, así que pedirle un scrape es
// un 400 `planta_sin_sis`, no un 404 mudo ni un job que no traería nada. La planta-fixture entra
// porque el seed C12 le dio el catálogo espejo ALIM_1..8 justo para poder ejercer el scrape en las
// suites sin tocar una planta real (D-055).
function plantaConSis(planta_id) {
  return planta_id === 'GEC32' || planta_id === dbBindings.TEST_PLANTA_ID;
}

// Tope del rango de un scrape manual: 31 días (inclusive). Un día cuesta ~5 min contra el SIS real,
// así que un mes ya son ~2,5 h de job; más que eso es trabajo de backfill (CLI, D-060), no de un
// botón. Rangos históricos grandes van por server/scripts/backfill-carbon-gec32.js.
const MAX_DIAS_RANGO = 31;
const MS_DIA = 86400000;

// Días de [from, to] inclusive, con aritmética UTC pura (nunca hora local: convención de TZ).
function diasDeRango(from, to) {
  const aUTC = (f) => { const [y, m, d] = f.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((aUTC(to) - aUTC(from)) / MS_DIA) + 1;
}

// Columnas que alimentan el shape de celda del GET. Se comparte con revertir (C5) para que la celda
// que este devuelve sea LITERALMENTE la misma forma que la del pivot: si divergieran, el front
// pintaría el badge de override con datos de otra forma justo después de revertir.
// `sis_owned` se calcula en SQL: la celda es del SIS si la creó SISTEMA y ningún humano la tocó
// después (ownership de D-029, intacta). Requiere el parámetro @sis en el request.
const SELECT_CELDA = `
        c.consumo_id, c.periodo, c.combustible_id, c.cantidad, c.detalle,
        c.creado_por, c.creado_en, c.modificado_por, c.modificado_en,
        c.valor_sis, c.sis_actualizado_en,
        CAST(CASE WHEN c.creado_por = @sis
                   AND (c.modificado_por IS NULL OR c.modificado_por = @sis)
                  THEN 1 ELSE 0 END AS BIT) AS sis_owned,
        uc.nombre_completo AS creado_por_nombre,
        um.nombre_completo AS modificado_por_nombre
      FROM bitacora.consumo_combustible c
      LEFT JOIN lov_bit.usuario uc ON uc.usuario_id = c.creado_por
      LEFT JOIN lov_bit.usuario um ON um.usuario_id = c.modificado_por`;

// Fila → celda del contrato C4. `es_override` se deriva acá y no en SQL porque compara dos DECIMAL
// que el driver puede entregar como string: pasar ambos lados por Number una sola vez evita el
// falso positivo '12.500' !== '12.5'.
function mapCelda(row) {
  const cantidad = Number(row.cantidad);
  const valor_sis = row.valor_sis === null || row.valor_sis === undefined ? null : Number(row.valor_sis);
  const sis_owned = !!row.sis_owned;
  return {
    consumo_id: row.consumo_id,
    cantidad,
    detalle: row.detalle,
    creado_por: { usuario_id: row.creado_por, nombre_completo: row.creado_por_nombre },
    creado_en: row.creado_en,
    modificado_por: row.modificado_por
      ? { usuario_id: row.modificado_por, nombre_completo: row.modificado_por_nombre }
      : null,
    modificado_en: row.modificado_en,
    valor_sis,
    sis_actualizado_en: row.sis_actualizado_en,
    sis_owned,
    es_override: !sis_owned && valor_sis !== null && cantidad !== valor_sis,
  };
}

// GET /api/combustibles/catalogo?planta_id=GEC3|GEC32|TST
router.get('/catalogo', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }
  const planta_id = req.query.planta_id;
  if (!plantaCombValida(planta_id)) {
    return sendJSON(res, 400, ERR_PLANTA);
  }
  const db = await getDB();
  const r = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden, cantidad_max
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);
  return sendJSON(res, 200, { planta_id, combustibles: r.recordset });
}));

// GET /api/combustibles/consumos?planta_id=&fecha=YYYY-MM-DD
// Devuelve catálogo (siempre) + pivot de celdas keyed por periodo→combustible_id + el estado del
// scrape del SIS de ese día (D-061 C4).
router.get('/consumos', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }
  const planta_id = req.query.planta_id;
  const fechaStr = req.query.fecha;
  if (!plantaCombValida(planta_id)) {
    return sendJSON(res, 400, ERR_PLANTA);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '')) {
    return sendJSON(res, 400, { error: 'fecha requerida (YYYY-MM-DD)', codigo: 'fecha_invalida' });
  }

  const db = await getDB();
  // Live binding de db.js: initDB lo resuelve SIEMPRE, también con SKIP_INITDB=1 (GATE-O1 D2).
  const sistemaId = dbBindings.USUARIO_SISTEMA_ID;

  const catRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`
      SELECT combustible_id, codigo, nombre, unidad, tipo, orden, cantidad_max
      FROM lov_bit.combustible
      WHERE planta_id = @p AND activo = 1
      ORDER BY orden, codigo
    `);

  const conRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('f', sql.Date, fechaStr)
    .input('sis', sql.Int, sistemaId)
    .query(`
      SELECT ${SELECT_CELDA}
      WHERE c.planta_id = @p AND c.fecha = @f
      ORDER BY c.periodo, c.combustible_id
    `);

  // Pivot: { "<periodo>": { "<combustible_id>": { ... } } }
  const celdas = {};
  for (const row of conRes.recordset) {
    const p = String(row.periodo);
    if (!celdas[p]) celdas[p] = {};
    celdas[p][String(row.combustible_id)] = mapCelda(row);
  }

  // Estado del scrape del SIS de (planta, fecha). `null` cuando no hay lectura registrada — el
  // front lo distingue de "hay lectura pero incompleta" (D-060: completo ⇔ 24/24 sin errores).
  const logRes = await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('f', sql.Date, fechaStr)
    .query(`
      SELECT scrape_tipo, periodos_ok, periodos_error, ultimo_periodo, completo, scraped_en
      FROM bitacora.sis_scrape_log
      WHERE planta_id = @p AND fecha = @f
    `);
  const logRow = logRes.recordset[0];
  const sisEstado = logRow
    ? {
      scrape_tipo: logRow.scrape_tipo,
      periodos_ok: Number(logRow.periodos_ok),
      periodos_error: Number(logRow.periodos_error),
      ultimo_periodo: logRow.ultimo_periodo === null ? null : Number(logRow.ultimo_periodo),
      completo: !!logRow.completo,
      scraped_en: logRow.scraped_en,
    }
    : null;

  return sendJSON(res, 200, {
    planta_id,
    fecha: fechaStr,
    catalogo: catRes.recordset,
    celdas,
    sis: sisEstado,
  });
}));

// POST /api/combustibles/consumos — batch atómico (patrón MAND).
// Body: { planta_id, fecha, celdas: [{ periodo, combustible_id, cantidad, detalle? }] }
// cantidad=null o 0 ⇒ override a 0 si la celda tiene lectura del SIS, DELETE si no (D-061 C6);
// existente ⇒ UPDATE; nueva ⇒ INSERT.
// modificado_por solo se setea si cantidad cambió (paridad D-019 con MAND).
router.post('/consumos', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear Consumos' });
  }

  const { planta_id, fecha, celdas } = req.body || {};
  if (!plantaCombValida(planta_id)) {
    return sendJSON(res, 400, ERR_PLANTA);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    return sendJSON(res, 400, { error: 'fecha inválida (YYYY-MM-DD)', codigo: 'fecha_invalida' });
  }
  if (!Array.isArray(celdas)) {
    return sendJSON(res, 400, { error: 'celdas debe ser un array' });
  }

  // Ventana: hoy o pasado en TZ Bogotá (D-027 decisión). Comparación lexicográfica
  // funciona porque ambos están en YYYY-MM-DD padded.
  const hoyBogota = fechaBogotaStr(new Date());
  if (fecha > hoyBogota) {
    // GATE-O2 (H-L04-2): el front ramifica por `codigo` (D-032) y este 400 salía sin él, así que
    // caía al mensaje genérico. `error` se conserva tal cual por paridad con `registros.js`.
    return sendJSON(res, 400, { error: 'fecha_futura', codigo: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
  }

  const db = await getDB();

  // Pre-load catálogo activo de la planta — el frontend podría mandar IDs de la otra
  // planta por bug; rechazamos con motivo específico. cantidad_max (D-034) gobierna el
  // tope físico por combustible: ALIMENTADOR=25, CALIZA=40, ACPM=25000 (NULL = sin tope).
  const catRows = (await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .query(`SELECT combustible_id, cantidad_max FROM lov_bit.combustible WHERE planta_id=@p AND activo=1`)
  ).recordset;
  const catMax = new Map(catRows.map(r => [r.combustible_id, r.cantidad_max === null ? null : Number(r.cantidad_max)]));

  const errores = [];
  for (const c of celdas) {
    if (!Number.isInteger(c.periodo) || c.periodo < 1 || c.periodo > 24) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'periodo_fuera_rango' });
      continue;
    }
    if (!catMax.has(c.combustible_id)) {
      errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'combustible_no_pertenece_planta' });
      continue;
    }
    if (c.cantidad !== null && c.cantidad !== 0 && c.cantidad !== undefined) {
      if (typeof c.cantidad !== 'number' || !Number.isFinite(c.cantidad) || c.cantidad < 0) {
        errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'cantidad_invalida' });
        continue;
      }
      // Tope físico (D-034): cantidad_max NULL = sin límite; boundary inclusivo (=max OK).
      const max = catMax.get(c.combustible_id);
      if (max !== null && c.cantidad > max) {
        errores.push({ periodo: c.periodo, combustible_id: c.combustible_id, motivo: 'cantidad_excede_max' });
        continue;
      }
    }
  }
  if (errores.length > 0) {
    return sendJSON(res, 400, { errores });
  }

  // Batch atómico. Patrón MAND: por celda, lookup existente → INSERT / UPDATE / DELETE.
  const tx = new sql.Transaction(db);
  await tx.begin();
  let creados = 0, actualizados = 0, eliminados = 0;
  try {
    for (const c of celdas) {
      const existente = (await new sql.Request(tx)
        .input('p', sql.VarChar(10), planta_id)
        .input('f', sql.Date, fecha)
        .input('per', sql.TinyInt, c.periodo)
        .input('cid', sql.Int, c.combustible_id)
        .query(`
          SELECT consumo_id, cantidad, detalle, valor_sis
          FROM bitacora.consumo_combustible
          WHERE planta_id=@p AND fecha=@f AND periodo=@per AND combustible_id=@cid
        `)).recordset[0];

      const esVacio = c.cantidad === null || c.cantidad === 0 || c.cantidad === undefined;

      if (esVacio) {
        if (!existente) continue;

        // D-061 (C6): vaciar una celda que TIENE lectura del SIS no la borra — la deja en 0 como
        // OVERRIDE humano. Borrarla la dejaría sin dueño humano y el próximo scrape la repondría
        // con el valor del SIS: el operador vería revivir lo que acaba de vaciar. Con la fila viva
        // en 0 y `modificado_por` humano, la ownership (D-029) protege el override y `valor_sis`
        // se conserva como sombra para poder revertir.
        if (existente.valor_sis !== null && existente.valor_sis !== undefined) {
          // D-061 (CA-36): vaciar NO es editar el comentario. El diff del front manda `{ cantidad:
          // null }` SIN la clave `detalle` cuando el operador solo borra el número, y tomar eso
          // como "detalle = null" le borraba en silencio la nota que explicaba la celda. Con la
          // clave ausente se conserva el `detalle` que ya estaba; con la clave presente (aunque
          // venga en null) manda el body, que es la forma de borrar el comentario a propósito.
          const traeDetalle = Object.prototype.hasOwnProperty.call(c, 'detalle');
          const detalleVaciado = traeDetalle ? (c.detalle ?? null) : (existente.detalle ?? null);

          if (Number(existente.cantidad) !== 0) {
            await new sql.Request(tx)
              .input('id', sql.Int, existente.consumo_id)
              .input('det', sql.NVarChar(sql.MAX), detalleVaciado)
              .input('u', sql.Int, sesion.usuario_id)
              .query(`
                UPDATE bitacora.consumo_combustible
                SET cantidad=0, detalle=@det,
                    modificado_por=@u, modificado_en=SYSUTCDATETIME()
                WHERE consumo_id=@id
              `);
            actualizados++;
          } else if ((existente.detalle ?? null) !== detalleVaciado) {
            // Ya estaba en 0 y solo cambió el comentario: mismo trato que la rama con valor
            // (paridad D-019). Ignorarlo devolvería un 200 que dice "guardado" y perdería el
            // comentario en silencio (lección D-055: nunca un 200 mentiroso).
            await new sql.Request(tx)
              .input('id', sql.Int, existente.consumo_id)
              .input('det', sql.NVarChar(sql.MAX), detalleVaciado)
              .query(`UPDATE bitacora.consumo_combustible SET detalle=@det WHERE consumo_id=@id`);
            actualizados++;
          }
          continue;
        }

        // Sin lectura del SIS: comportamiento histórico (D-027) — la celda se borra.
        await new sql.Request(tx)
          .input('id', sql.Int, existente.consumo_id)
          .query(`DELETE FROM bitacora.consumo_combustible WHERE consumo_id=@id`);
        eliminados++;
        continue;
      }

      if (!existente) {
        await new sql.Request(tx)
          .input('p', sql.VarChar(10), planta_id)
          .input('f', sql.Date, fecha)
          .input('per', sql.TinyInt, c.periodo)
          .input('cid', sql.Int, c.combustible_id)
          .input('cant', sql.Decimal(12, 3), c.cantidad)
          .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
          .input('u', sql.Int, sesion.usuario_id)
          .query(`
            INSERT INTO bitacora.consumo_combustible
              (planta_id, fecha, periodo, combustible_id, cantidad, detalle, creado_por)
            VALUES (@p, @f, @per, @cid, @cant, @det, @u)
          `);
        creados++;
      } else {
        // D-061 (CA-47): MISMA regla que la rama de vaciado 40 líneas más arriba — clave `detalle`
        // ausente ⇒ se conserva el comentario que ya estaba; clave presente (aunque venga null) ⇒
        // manda el body. Antes esta rama hacía `c.detalle ?? null` y la MISMA ausencia significaba
        // "conservar" al vaciar y "borrar" al cambiar la cantidad: la API se contradecía consigo
        // misma y perdía el comentario en silencio (H25).
        const traeDetalle = Object.prototype.hasOwnProperty.call(c, 'detalle');
        const detalleFinal = traeDetalle ? (c.detalle ?? null) : (existente.detalle ?? null);

        // UPDATE — modificado_por solo si cantidad cambió (paridad D-019 con MAND).
        const cantidadCambio = Number(existente.cantidad) !== c.cantidad;
        if (cantidadCambio) {
          await new sql.Request(tx)
            .input('id', sql.Int, existente.consumo_id)
            .input('cant', sql.Decimal(12, 3), c.cantidad)
            .input('det', sql.NVarChar(sql.MAX), detalleFinal)
            .input('u', sql.Int, sesion.usuario_id)
            .query(`
              UPDATE bitacora.consumo_combustible
              SET cantidad=@cant, detalle=@det,
                  modificado_por=@u, modificado_en=SYSUTCDATETIME()
              WHERE consumo_id=@id
            `);
          actualizados++;
        } else if ((existente.detalle ?? null) !== detalleFinal) {
          // Solo detalle cambió: actualizar sin tocar modificado_por (igual que MAND).
          await new sql.Request(tx)
            .input('id', sql.Int, existente.consumo_id)
            .input('det', sql.NVarChar(sql.MAX), detalleFinal)
            .query(`UPDATE bitacora.consumo_combustible SET detalle=@det WHERE consumo_id=@id`);
          actualizados++;
        }
      }
    }
    await tx.commit();
    return sendJSON(res, 200, { resumen: { creados, actualizados, eliminados } });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}));

// POST /api/combustibles/consumos/revertir — D-061 (C5). Deshace un override humano devolviendo la
// celda al valor que trajo el SIS. Gate `puede_crear`: revertir ESCRIBE, y va por la misma matriz
// data-driven que el batch (nunca una allowlist de cargos, D-054/D-059).
// Body: { planta_id, fecha, periodo, combustible_id }
// Tabla de decisión, toda dentro de una transacción:
//   ya SIS-owned y cantidad = valor_sis > 0  → 'sin_cambios' (no toca nada)
//   valor_sis > 0                            → UPDATE al valor del SIS → 'restaurado'
//   valor_sis = 0                            → DELETE → 'eliminado' (el estado canónico del SIS
//                                              para un cero es "sin fila", igual que el scraper)
router.post('/consumos/revertir', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear Consumos' });
  }

  const { planta_id, fecha, periodo, combustible_id } = req.body || {};
  if (!plantaCombValida(planta_id)) {
    return sendJSON(res, 400, ERR_PLANTA);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    return sendJSON(res, 400, {
      error: 'fecha inválida (YYYY-MM-DD)',
      codigo: 'fecha_invalida',
      mensaje: 'La fecha no es válida.',
    });
  }
  if (!Number.isInteger(periodo) || periodo < 1 || periodo > 24) {
    return sendJSON(res, 400, {
      error: 'periodo fuera de rango',
      codigo: 'periodo_fuera_rango',
      mensaje: 'El periodo debe estar entre 1 y 24.',
    });
  }

  const db = await getDB();
  const sistemaId = dbBindings.USUARIO_SISTEMA_ID;

  const pertenece = (await db.request()
    .input('p', sql.VarChar(10), planta_id)
    .input('cid', sql.Int, Number.isInteger(combustible_id) ? combustible_id : null)
    .query(`
      SELECT 1 AS x FROM lov_bit.combustible
      WHERE combustible_id = @cid AND planta_id = @p AND activo = 1
    `)).recordset[0];
  if (!pertenece) {
    return sendJSON(res, 400, {
      error: 'combustible no pertenece a la planta',
      codigo: 'combustible_no_pertenece_planta',
      mensaje: 'El combustible no pertenece a esta planta.',
    });
  }

  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    const fila = (await new sql.Request(tx)
      .input('p', sql.VarChar(10), planta_id)
      .input('f', sql.Date, fecha)
      .input('per', sql.TinyInt, periodo)
      .input('cid', sql.Int, combustible_id)
      .input('sis', sql.Int, sistemaId)
      .query(`
        SELECT ${SELECT_CELDA}
        WHERE c.planta_id=@p AND c.fecha=@f AND c.periodo=@per AND c.combustible_id=@cid
      `)).recordset[0];

    if (!fila) {
      await tx.commit();
      return sendJSON(res, 404, {
        error: 'la celda no existe',
        codigo: 'celda_no_existe',
        mensaje: 'Esa celda ya no existe.',
      });
    }

    const celdaActual = mapCelda(fila);
    if (celdaActual.valor_sis === null) {
      await tx.commit();
      return sendJSON(res, 400, {
        error: 'la celda no tiene valor del SIS',
        codigo: 'sin_valor_sis',
        mensaje: 'Esta celda no tiene lectura del SIS para restaurar.',
      });
    }

    // Nada que hacer: la celda ya es del SIS y coincide con su lectura. Igual devuelve el shape
    // completo (mismo que 'restaurado') para que el front no ramifique el refresco.
    if (celdaActual.sis_owned && celdaActual.valor_sis > 0 && celdaActual.cantidad === celdaActual.valor_sis) {
      await tx.commit();
      return sendJSON(res, 200, { accion: 'sin_cambios', celda: celdaActual });
    }

    if (celdaActual.valor_sis > 0) {
      // Devolver la propiedad al SISTEMA es parte de restaurar: si `modificado_por` se quedara con
      // el humano, la celda seguiría contando como override (ownership D-029) y el próximo scrape
      // la respetaría en vez de actualizarla.
      await new sql.Request(tx)
        .input('id', sql.Int, fila.consumo_id)
        .input('sis', sql.Int, sistemaId)
        .query(`
          UPDATE bitacora.consumo_combustible
          SET cantidad = valor_sis,
              creado_por = @sis,
              modificado_por = NULL,
              modificado_en = NULL,
              sis_actualizado_en = SYSUTCDATETIME()
          WHERE consumo_id = @id
        `);

      const releida = (await new sql.Request(tx)
        .input('id', sql.Int, fila.consumo_id)
        .input('sis', sql.Int, sistemaId)
        .query(`SELECT ${SELECT_CELDA} WHERE c.consumo_id = @id`)).recordset[0];

      await tx.commit();
      return sendJSON(res, 200, { accion: 'restaurado', celda: mapCelda(releida) });
    }

    // valor_sis = 0: el SIS no reporta consumo en ese periodo y su representación canónica es la
    // ausencia de fila (el scraper elimina las celdas que caen a cero). Dejarla viva en 0 y
    // SIS-owned sería un estado que el scraper nunca produce.
    await new sql.Request(tx)
      .input('id', sql.Int, fila.consumo_id)
      .query(`DELETE FROM bitacora.consumo_combustible WHERE consumo_id = @id`);
    await tx.commit();
    return sendJSON(res, 200, { accion: 'eliminado', celda: null });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}));

// POST /api/combustibles/sis/scrape — D-061 (C7). Dispara el scrape manual del SIS y responde
// **202 sin esperarlo**: un día son 24 periodos a ~13 s cada uno (~5 min), y nginx corta a los
// 60 s. El trabajo vive en sis-job.js bajo el mutex de proceso; el avance se consulta en
// GET /sis/estado. Gate `puede_crear`: dispara una escritura masiva de celdas.
// Body: { planta_id?, fecha } o { planta_id?, from, to }.
router.post('/sis/scrape', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para lanzar el scrape del SIS' });
  }

  const { planta_id = 'GEC32', fecha, from, to } = req.body || {};
  if (!plantaConSis(planta_id)) {
    return sendJSON(res, 400, {
      error: 'la planta no tiene SIS',
      codigo: 'planta_sin_sis',
      mensaje: 'Esta planta no tiene lecturas del SIS.',
    });
  }

  // Las dos formas del body colapsan en una: un día suelto es el rango degenerado from=to=fecha.
  // De acá para abajo hay UN solo camino, así que las validaciones no pueden divergir entre ambas.
  const unDia = fecha !== undefined && fecha !== null;
  const desde = unDia ? fecha : from;
  const hasta = unDia ? fecha : to;

  const FORMATO = /^\d{4}-\d{2}-\d{2}$/;
  if (!FORMATO.test(desde || '') || !FORMATO.test(hasta || '')) {
    return sendJSON(res, 400, {
      error: 'fecha inválida (YYYY-MM-DD)',
      codigo: 'fecha_invalida',
      mensaje: 'Indica la fecha o el rango en formato AAAA-MM-DD.',
    });
  }

  // Ventana: hoy o pasado en TZ Bogotá. Comparación lexicográfica: ambos en YYYY-MM-DD con padding.
  const hoyBogota = fechaBogotaStr(new Date());
  if (desde > hoyBogota || hasta > hoyBogota) {
    return sendJSON(res, 400, {
      error: 'fecha futura',
      codigo: 'fecha_futura',
      mensaje: 'No se puede pedirle al SIS una fecha futura.',
    });
  }
  if (desde > hasta) {
    return sendJSON(res, 400, {
      error: 'rango inválido',
      codigo: 'rango_invalido',
      mensaje: 'La fecha inicial no puede ser posterior a la final.',
    });
  }
  if (diasDeRango(desde, hasta) > MAX_DIAS_RANGO) {
    return sendJSON(res, 400, {
      error: 'rango demasiado grande',
      codigo: 'rango_excede_max',
      mensaje: `El rango no puede superar ${MAX_DIAS_RANGO} días. Para un histórico largo se usa el backfill.`,
    });
  }

  const db = await getDB();
  try {
    const job = iniciarScrapeJob({
      pool: db,
      planta_id,
      from: desde,
      to: hasta,
      usuario: { usuario_id: sesion.usuario_id, nombre_completo: sesion.nombre_completo },
    });
    return sendJSON(res, 202, { job });
  } catch (err) {
    // 409 y no 500: no es una falla, es que el SIS ya está ocupado (otro job manual o el tick del
    // sweeper). El cuerpo lleva `job` y `lock` para que quien lo reciba sepa CUÁL de los dos es y
    // desde cuándo, en vez de un "reintenta" a ciegas.
    if (err?.codigo === 'scrape_en_curso') {
      return sendJSON(res, 409, {
        error: 'ya hay un scrape en curso',
        codigo: 'scrape_en_curso',
        mensaje: 'Ya hay un scrape del SIS en curso. Espera a que termine e intenta de nuevo.',
        job: estadoScrapeJob(),
        lock: estadoSisLock(),
      });
    }
    throw err;
  }
}));

// GET /api/combustibles/sis/estado — D-061 (C8). Avance del scrape manual + foto del mutex + si la
// ingesta automática está encendida.
// Gate `puede_ver`: es información de lectura (quién está hablando con el SIS y cómo va).
// `job` es null si este proceso nunca corrió ninguno — incluido el caso "corrió y se reinició":
// el estado vive en memoria y la verdad persistente es bitacora.sis_scrape_log.
// `sweeper.habilitado` (D-061 / L10, H33): `SIS_SWEEPER_ENABLED=0` apaga el tick horario, y sin
// esto un sweeper APAGADO se veía desde afuera idéntico a uno ROTO — el chip diría "SIS · sin
// lectura" día tras día y este endpoint respondería lo mismo que un sweeper sano en reposo. Se lee
// del entorno con la MISMA expresión que server.js (solo el string exacto '0' apaga; la ausencia de
// la variable deja la ingesta encendida) y a propósito sin importar nada de allá: es un flag de
// test, no de producción, y el router no debe poder encenderlo ni apagarlo.
router.get('/sis/estado', asyncH(async (req, res) => {
  const sesion = req.sesion;
  if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
  }
  return sendJSON(res, 200, {
    job: estadoScrapeJob(),
    lock: estadoSisLock(),
    sweeper: { habilitado: process.env.SIS_SWEEPER_ENABLED !== '0' },
  });
}));

export default router;
