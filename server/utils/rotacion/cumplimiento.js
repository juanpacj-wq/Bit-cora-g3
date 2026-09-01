// D-065 · Cumplimiento plan-vs-real de la rotación de turnos (superficie C, backend).
//
// La app ya sabe QUIÉN ESTUVO en cada turno (`turno_participante` / `conformacion_turno`, D-045) y,
// desde D-065, QUIÉN DEBÍA ESTAR (`titularesDeTurno`, C4). Este módulo cruza las dos cosas:
//
//   - `evaluarEstado`           → función PURA: dados los titulares, quiénes entraron y quién tiene el
//                                  control, dice el estado del slot (PENDIENTE / PARCIAL / COMPLETO /
//                                  CUBIERTO_POR_RELEVO). Sin BD, para que los escalones se prueben solos.
//   - `derivarPrincipalDelLog`  → función PURA: la pila LIFO derivada del log append-only
//                                  `rotacion_control` (mismo algoritmo que `_CONTEXTO-BASE.md §5.2`).
//   - `derivarCumplimiento`     → lee de la BD (participantes + log) y arma UNA fila por rol con
//                                  patrón activo. Lo usan el congelado y la consulta en vivo.
//   - `congelarCumplimiento`    → contrato C7: se invoca DENTRO de la transacción de `cerrarTurno`,
//                                  justo después de congelar la conformación. Idempotente por la PK
//                                  natural de `rotacion_cumplimiento` (NOT EXISTS).
//   - `consultarCumplimiento`   → contrato C6: filas de un rango para una planta. Los turnos cerrados
//                                  salen congelados de la tabla; el turno ABIERTO se deriva en vivo.
//
// REGLA CENTRAL (CA-15): el estado se resuelve POR `usuario_id`, nunca por conteo de cargo. Si entran
// tres personas del rol y ninguna es titular, el estado sigue PENDIENTE. Es lo contrario de lo que
// haría un scheduler comercial y es deliberado: lo que se mide es si vino QUIEN debía venir.
//
// `filas = 0` en el congelado NO es error: es el estado normal de un sistema recién desplegado (ningún
// rol tiene patrón activo para esa fecha) o de un rol cuyo grupo de guardia no tiene a nadie
// asignado. Un `throw` ahí volvería incerrable todo turno de la planta antes de la primera carga
// anual. Precedente literal: D-063, `copias = 0` nunca es error.
//
// Filtros heredados al contar participantes y relevos: `es_sintetico = 1` queda fuera salvo que el
// llamador pase `incluirSinteticos` (D-044, escape hatch EXCLUSIVO de unit tests, mismo que
// `cerrarTurno`) y `es_observador = 1` queda fuera SIEMPRE, sin escape hatch (D-059): un observador
// que entra no satisface un slot ni cuenta como relevo.

import sql from 'mssql';
import { titularesDeTurno } from './titulares.js';

export const ESTADOS = Object.freeze(['PENDIENTE', 'PARCIAL', 'COMPLETO', 'CUBIERTO_POR_RELEVO']);

// Rango máximo de la consulta C6, en días calendario inclusivos. Más → 400 rango_excesivo.
export const RANGO_MAX_DIAS = 93;

const GRUPO_MIN = 1;
const GRUPO_MAX = 4;
const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Normaliza la `fecha_operativa` a 'YYYY-MM-DD'. Acepta el string canónico o el `Date` con que mssql
 * devuelve una columna DATE (medianoche UTC): en ese caso se leen las partes UTC directas, NUNCA el
 * shift −5h de `fechaBogotaStr` — un DATE no tiene hora, su valor ya ES la fecha operativa y aplicarle
 * el offset la correría un día atrás (mismo criterio que `fechaRefBogotaMediodia` en turno-entidad.js).
 * Cualquier otra cosa → Error('fecha_invalida'), el mismo slug que usa el motor (C1).
 */
export function fechaOperativaIso(valor) {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) throw new Error('fecha_invalida');
    return `${valor.getUTCFullYear()}-${pad2(valor.getUTCMonth() + 1)}-${pad2(valor.getUTCDate())}`;
  }
  const texto = String(valor ?? '');
  if (!RE_FECHA_ISO.test(texto)) throw new Error('fecha_invalida');
  return texto;
}

/**
 * Pila LIFO derivada del log `rotacion_control` de UN (turno, planta, cargo). `eventos` viene ya en
 * orden de `rotacion_control_id`. TOMAR apila; ABANDONAR desapila solo si el tope es ese usuario;
 * DESCARTAR no entra en la pila. Devuelve el tope `{ usuario_id, nombre }` o `null` si la pila está
 * vacía — que significa "el principal es el titular del patrón" (fondo conceptual, no está en el log).
 */
export function derivarPrincipalDelLog(eventos = []) {
  const pila = [];
  for (const ev of eventos) {
    if (!ev) continue;
    if (ev.accion === 'TOMAR') {
      pila.push({ usuario_id: ev.usuario_id, nombre: ev.nombre ?? null });
    } else if (ev.accion === 'ABANDONAR') {
      const tope = pila[pila.length - 1];
      if (tope && tope.usuario_id === ev.usuario_id) pila.pop();
    }
  }
  return pila.length ? pila[pila.length - 1] : null;
}

/**
 * Estado de UN slot (turno, planta, cargo). PURA.
 *   titulares     → [{ usuario_id, nombre }] que designó el patrón para ese turno.
 *   participantes → usuario_ids (o objetos con usuario_id) que tienen fila en turno_participante;
 *                   cualquier iterable (arreglo o Set).
 *   principal     → tope de la pila de control ({ usuario_id, nombre }) o null (= el titular).
 * Escalones (CA-16): ningún titular entró → PENDIENTE; alguno pero no todos → PARCIAL; todos →
 * COMPLETO (decisión R9). Un principal que NO es titular → CUBIERTO_POR_RELEVO, que gana sobre los
 * otros tres. Un titular que tomó el control explícitamente no es relevo: se evalúa por escalones.
 * Devuelve { estado, titulares: [{ usuario_id, nombre, entro }], relevo: { usuario_id, nombre } | null }.
 */
export function evaluarEstado({ titulares = [], participantes = [], principal = null } = {}) {
  const entraron = new Set(
    Array.from(participantes ?? [], (p) => (p && typeof p === 'object' ? p.usuario_id : p)),
  );
  const filas = titulares.map((t) => ({
    usuario_id: t.usuario_id,
    nombre: t.nombre ?? null,
    entro: entraron.has(t.usuario_id),
  }));
  const idsTitulares = new Set(filas.map((f) => f.usuario_id));

  const relevo = principal && !idsTitulares.has(principal.usuario_id)
    ? { usuario_id: principal.usuario_id, nombre: principal.nombre ?? null }
    : null;

  let estado;
  if (relevo) {
    estado = 'CUBIERTO_POR_RELEVO';
  } else {
    const entraronTitulares = filas.filter((f) => f.entro).length;
    if (entraronTitulares === 0) estado = 'PENDIENTE';
    else if (entraronTitulares === filas.length) estado = 'COMPLETO';
    else estado = 'PARCIAL';
  }
  return { estado, titulares: filas, relevo };
}

// ── Lecturas de BD (aceptan un pool o una Transaction: ambos exponen `.request()`) ──────────────

// usuario_ids con fila en turno_participante para el turno, con los dos filtros heredados.
async function leerParticipantes(exec, { turno_id, incluirSinteticos }) {
  const r = await exec.request()
    .input('id', sql.Int, turno_id)
    .input('incluir_sinteticos', sql.Bit, incluirSinteticos ? 1 : 0)
    .query(`
      SELECT tp.usuario_id
      FROM bitacora.turno_participante tp
      INNER JOIN lov_bit.usuario u  ON u.usuario_id  = tp.usuario_id
      INNER JOIN lov_bit.cargo   cg ON cg.cargo_id   = tp.cargo_id
      WHERE tp.turno_id = @id
        AND (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
        AND cg.es_observador = 0
    `);
  return new Set(r.recordset.map((row) => row.usuario_id));
}

// Eventos TOMAR/ABANDONAR del turno en la planta, agrupados por cargo y en orden del log.
async function leerEventosControl(exec, { turno_id, planta_id, incluirSinteticos }) {
  const r = await exec.request()
    .input('id', sql.Int, turno_id)
    .input('planta', sql.VarChar(10), planta_id)
    .input('incluir_sinteticos', sql.Bit, incluirSinteticos ? 1 : 0)
    .query(`
      SELECT rc.cargo_id, rc.usuario_id, rc.accion, u.nombre_completo AS nombre
      FROM bitacora.rotacion_control rc
      INNER JOIN lov_bit.usuario u ON u.usuario_id = rc.usuario_id
      WHERE rc.turno_id = @id AND rc.planta_id = @planta
        AND rc.accion IN ('TOMAR', 'ABANDONAR')
        AND (@incluir_sinteticos = 1 OR u.es_sintetico = 0)
      ORDER BY rc.rotacion_control_id ASC
    `);
  const porCargo = new Map();
  for (const ev of r.recordset) {
    if (!porCargo.has(ev.cargo_id)) porCargo.set(ev.cargo_id, []);
    porCargo.get(ev.cargo_id).push(ev);
  }
  return porCargo;
}

/**
 * Filas de cumplimiento de UN turno, una por rol con patrón activo y titulares (o relevo). NO escribe.
 * `exec` es un pool o la Transaction de `cerrarTurno`. Devuelve
 *   [{ fecha_operativa, planta_id, turno, cargo_id, cargo_nombre, grupo, estado, titulares, relevo, turno_id }]
 * Un rol sin patrón activo no aparece (C4); un rol con patrón pero sin nadie asignado al grupo de
 * guardia y sin relevo tampoco: no hay slot que medir (0 de 0 no es un estado).
 */
export async function derivarCumplimiento(exec, {
  turno_id, fecha_operativa, planta_id, turno, incluirSinteticos = false,
}) {
  const fechaIso = fechaOperativaIso(fecha_operativa);
  const roles = await titularesDeTurno(exec, { fechaOperativa: fechaIso, turno });
  if (!Array.isArray(roles) || roles.length === 0) return [];

  // Secuencial a propósito: sobre una Transaction de mssql no puede haber dos requests en vuelo.
  const participantes = await leerParticipantes(exec, { turno_id, incluirSinteticos });
  const eventosPorCargo = await leerEventosControl(exec, { turno_id, planta_id, incluirSinteticos });

  const filas = [];
  for (const rol of roles) {
    // Hecho 7 del GATE-O1: `rotacion_cumplimiento.grupo` acepta 0, 5 o 200 mientras L11 no agregue el
    // CHECK. El motor (C1) solo produce 1..4, así que un grupo fuera de rango es un bug aguas arriba y
    // no se congela en silencio en un registro append-only.
    if (!Number.isInteger(rol.grupo) || rol.grupo < GRUPO_MIN || rol.grupo > GRUPO_MAX) {
      throw new Error('grupo_invalido');
    }
    const principal = derivarPrincipalDelLog(eventosPorCargo.get(rol.cargo_id) ?? []);
    const ev = evaluarEstado({ titulares: rol.personas ?? [], participantes, principal });
    if (ev.titulares.length === 0 && !ev.relevo) continue;
    filas.push({
      fecha_operativa: fechaIso,
      planta_id,
      turno,
      cargo_id: rol.cargo_id,
      cargo_nombre: rol.cargo_nombre,
      grupo: rol.grupo,
      estado: ev.estado,
      titulares: ev.titulares,
      relevo: ev.relevo,
      turno_id,
    });
  }
  return filas;
}

/**
 * Contrato C7. Se invoca DENTRO de la transacción de `cerrarTurno`, después de congelar la
 * conformación. Idempotente por la PK de `rotacion_cumplimiento` (NOT EXISTS). `filas = 0` NO es
 * error: significa que ningún rol tenía patrón activo para esa fecha (o que ya estaba congelado).
 * Cualquier fallo se propaga: un turno sellado sin su cumplimiento es peor que un cierre que hay que
 * reintentar, así que el llamador NO lo envuelve y la transacción entera cae.
 * `cargo_nombre` y `titulares_json` van congelados: la etiqueta de un cargo puede cambiar (D-052) y
 * el histórico no se reescribe.
 */
export async function congelarCumplimiento(tx, {
  turno_id, fecha_operativa, planta_id, turno, incluirSinteticos = false,
}) {
  const derivadas = await derivarCumplimiento(tx, {
    turno_id, fecha_operativa, planta_id, turno, incluirSinteticos,
  });

  let insertadas = 0;
  for (const f of derivadas) {
    const r = await tx.request()
      .input('fecha_op', sql.Date, f.fecha_operativa)
      .input('planta', sql.VarChar(10), f.planta_id)
      .input('turno', sql.TinyInt, f.turno)
      .input('cargo_id', sql.Int, f.cargo_id)
      .input('cargo_nombre', sql.VarChar(100), f.cargo_nombre)
      .input('grupo', sql.TinyInt, f.grupo)
      .input('estado', sql.VarChar(20), f.estado)
      .input('titulares_json', sql.NVarChar(sql.MAX), JSON.stringify(f.titulares))
      .input('relevo_usuario_id', sql.Int, f.relevo ? f.relevo.usuario_id : null)
      .input('turno_id', sql.Int, f.turno_id)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM bitacora.rotacion_cumplimiento
          WHERE fecha_operativa = @fecha_op AND planta_id = @planta
            AND turno = @turno AND cargo_id = @cargo_id
        )
        INSERT INTO bitacora.rotacion_cumplimiento
          (fecha_operativa, planta_id, turno, cargo_id, cargo_nombre, grupo, estado,
           titulares_json, relevo_usuario_id, turno_id)
        VALUES
          (@fecha_op, @planta, @turno, @cargo_id, @cargo_nombre, @grupo, @estado,
           @titulares_json, @relevo_usuario_id, @turno_id);
      `);
    insertadas += r.rowsAffected?.[0] || 0;
  }

  console.log(
    `[rotacion-cumplimiento] turno #${turno_id} (${planta_id} ${fechaOperativaIso(fecha_operativa)} T${turno}) ` +
    `→ roles con slot: ${derivadas.length}, filas congeladas: ${insertadas}`,
  );
  return { filas: insertadas };
}

// Fila de la tabla → shape C6 (congelado: true).
function filaCongeladaAContrato(row) {
  let titulares = [];
  try {
    const parsed = JSON.parse(row.titulares_json);
    if (Array.isArray(parsed)) titulares = parsed;
  } catch {
    // Un JSON corrupto en un registro congelado no tumba la consulta: se reporta sin titulares.
  }
  return {
    fecha_operativa: fechaOperativaIso(row.fecha_operativa),
    turno: row.turno,
    planta_id: row.planta_id,
    cargo_id: row.cargo_id,
    cargo_nombre: row.cargo_nombre,
    grupo: row.grupo,
    estado: row.estado,
    titulares,
    relevo: row.relevo_usuario_id != null
      ? { usuario_id: row.relevo_usuario_id, nombre: row.relevo_nombre ?? null }
      : null,
    congelado: true,
  };
}

function ordenarFilas(filas) {
  return filas.sort((a, b) =>
    a.fecha_operativa.localeCompare(b.fecha_operativa)
    || a.turno - b.turno
    || String(a.cargo_nombre).localeCompare(String(b.cargo_nombre))
    || a.cargo_id - b.cargo_id,
  );
}

/**
 * Contrato C6. `desde`/`hasta` son 'YYYY-MM-DD' (día Bogotá) ya validados por el router; `planta_id`
 * es una planta existente. `turnoAbierto` es la fila ABIERTO de la planta (o null): si su
 * `fecha_operativa` cae en el rango se deriva EN VIVO (congelado: false) y reemplaza a cualquier
 * fila congelada con su misma clave (un turno reabierto vuelve a estar en curso). Camino de
 * PRODUCCIÓN: nunca incluye sintéticos. Devuelve { filas, resumen }.
 */
export async function consultarCumplimiento(pool, { desde, hasta, planta_id, turnoAbierto = null }) {
  const r = await pool.request()
    .input('planta', sql.VarChar(10), planta_id)
    .input('desde', sql.Date, desde)
    .input('hasta', sql.Date, hasta)
    .query(`
      SELECT rc.fecha_operativa, rc.planta_id, rc.turno, rc.cargo_id, rc.cargo_nombre, rc.grupo,
             rc.estado, rc.titulares_json, rc.relevo_usuario_id, u.nombre_completo AS relevo_nombre
      FROM bitacora.rotacion_cumplimiento rc
      LEFT JOIN lov_bit.usuario u ON u.usuario_id = rc.relevo_usuario_id
      WHERE rc.planta_id = @planta
        AND rc.fecha_operativa >= @desde AND rc.fecha_operativa <= @hasta
    `);
  let filas = r.recordset.map(filaCongeladaAContrato);

  if (turnoAbierto && turnoAbierto.estado === 'ABIERTO') {
    const fechaAbierto = fechaOperativaIso(turnoAbierto.fecha_operativa);
    if (fechaAbierto >= desde && fechaAbierto <= hasta) {
      filas = filas.filter((f) => !(f.fecha_operativa === fechaAbierto && f.turno === turnoAbierto.turno));
      const vivas = await derivarCumplimiento(pool, {
        turno_id: turnoAbierto.turno_unidad_id,
        fecha_operativa: fechaAbierto,
        planta_id,
        turno: turnoAbierto.turno,
      });
      for (const v of vivas) {
        filas.push({
          fecha_operativa: v.fecha_operativa,
          turno: v.turno,
          planta_id: v.planta_id,
          cargo_id: v.cargo_id,
          cargo_nombre: v.cargo_nombre,
          grupo: v.grupo,
          estado: v.estado,
          titulares: v.titulares,
          relevo: v.relevo,
          congelado: false,
        });
      }
    }
  }

  ordenarFilas(filas);
  const resumen = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const f of filas) resumen[f.estado] = (resumen[f.estado] ?? 0) + 1;
  return { filas, resumen };
}
