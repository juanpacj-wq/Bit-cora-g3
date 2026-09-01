// D-065 (contrato C4) · Resolución CON BD del titular de un turno: el patrón activo de cada rol
// (`rotacion_patron`) cruzado con las asignaciones persona→grupo vigentes en esa fecha
// (`rotacion_asignacion`). La aritmética del ciclo la pone el motor puro (`patron.js`); acá solo se
// leen las dos tablas y se filtra a quien tenía la guardia.
//
// Una sola query, pensada para `IX_rotacion_asig_resolucion (cargo_id, vigente_desde,
// vigente_hasta) INCLUDE (usuario_id, grupo)`: el LEFT JOIN de asignaciones se resuelve por cargo
// y por vigencia sin ir a la tabla base. Un rol SIN patrón activo en la fecha no aparece en el
// resultado (C4). Un rol CON patrón pero sin nadie asignado al grupo de guardia sí aparece, con
// `personas: []` — es exactamente lo que L06 necesita para marcarlo PENDIENTE.
//
// El resultado NO depende de la planta (decisión R3): el titular es el mismo en GEC3 y GEC32.
//
// FECHAS: `fechaOperativa` viaja como 'YYYY-MM-DD' en día Bogotá (C1) y se compara en SQL contra
// las columnas DATE por CAST del string. Ni un `Date` de JS ni un offset en ninguna parte; lo que
// sale de la BD sale ya formateado con CONVERT(..., 23) por la misma razón.

import sql from 'mssql';
import { diasEntre, grupoDeTurno, parsearVector } from './patron.js';

/**
 * Titulares de un turno para TODOS los roles con patrón activo, o para uno solo si se pasa
 * `cargo_id`.
 *
 * Lanza los mismos códigos del motor (`turno_invalido`, `fecha_invalida`, `vector_invalido`,
 * `patron_invalido`) y `cargo_invalido` si `cargo_id` viene y no es un entero positivo. El router
 * los traduce a 400; acá son Errors con el slug como mensaje, igual que en C1.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ fechaOperativa: string, turno: 1|2, cargo_id?: number|null }} args
 * @returns {Promise<Array<{ cargo_id: number, cargo_nombre: string, grupo: 1|2|3|4,
 *                           personas: Array<{ usuario_id: number, nombre: string }> }>>}
 */
export async function titularesDeTurno(pool, { fechaOperativa, turno, cargo_id = null } = {}) {
  if (turno !== 1 && turno !== 2) throw new Error('turno_invalido');
  // `diasEntre` valida formato Y existencia del día ('2026-02-30' → fecha_invalida) antes de que
  // el string llegue al CAST de SQL, que fallaría con un RequestError sin código de dominio.
  diasEntre(fechaOperativa, fechaOperativa);

  let cargoFiltro = null;
  if (cargo_id != null) {
    cargoFiltro = Number(cargo_id);
    if (!Number.isInteger(cargoFiltro) || cargoFiltro <= 0) throw new Error('cargo_invalido');
  }

  const r = await pool.request()
    .input('fecha', sql.VarChar(10), fechaOperativa)
    .input('cargo_id', sql.Int, cargoFiltro)
    .query(`
      SELECT p.rotacion_patron_id, p.cargo_id, c.nombre AS cargo_nombre,
             CONVERT(VARCHAR(10), p.fecha_inicio, 23) AS fecha_inicio,
             p.vector_t1, p.vector_t2, p.desfase,
             a.usuario_id, a.grupo, u.nombre_completo AS nombre
      FROM bitacora.rotacion_patron p
      INNER JOIN lov_bit.cargo c ON c.cargo_id = p.cargo_id
      LEFT JOIN bitacora.rotacion_asignacion a
             ON a.cargo_id = p.cargo_id
            AND a.vigente_desde <= CAST(@fecha AS DATE)
            AND a.vigente_hasta >= CAST(@fecha AS DATE)
      LEFT JOIN lov_bit.usuario u ON u.usuario_id = a.usuario_id
      WHERE p.activo = 1
        AND p.fecha_inicio <= CAST(@fecha AS DATE)
        AND p.fecha_fin    >= CAST(@fecha AS DATE)
        AND (@cargo_id IS NULL OR p.cargo_id = @cargo_id)
      ORDER BY c.nombre, p.fecha_inicio DESC, u.nombre_completo, a.usuario_id
    `);

  // Agrupa por cargo. Si un cargo tuviera DOS patrones activos que cubren la fecha (hueco CR-6 del
  // GATE-O1: la BD todavía no lo impide; el POST de este lote sí lo rechaza con 409), manda el de
  // `fecha_inicio` más reciente —el ORDER BY lo trae primero— y las filas del otro se descartan,
  // para que la respuesta sea una sola y determinista en vez de dos.
  const porCargo = new Map();
  for (const fila of r.recordset) {
    let entrada = porCargo.get(fila.cargo_id);
    if (!entrada) {
      entrada = {
        cargo_id: fila.cargo_id,
        cargo_nombre: fila.cargo_nombre,
        patron: {
          rotacion_patron_id: fila.rotacion_patron_id,
          fecha_inicio: fila.fecha_inicio,
          vector_t1: parsearVector(fila.vector_t1),
          vector_t2: parsearVector(fila.vector_t2),
          desfase: fila.desfase,
        },
        asignaciones: [],
      };
      porCargo.set(fila.cargo_id, entrada);
    }
    if (fila.rotacion_patron_id !== entrada.patron.rotacion_patron_id) continue;
    if (fila.usuario_id != null) entrada.asignaciones.push(fila);
  }

  const resultado = [];
  for (const entrada of porCargo.values()) {
    const grupo = grupoDeTurno(entrada.patron, fechaOperativa, turno);
    const vistos = new Set();
    const personas = [];
    for (const a of entrada.asignaciones) {
      if (a.grupo !== grupo || vistos.has(a.usuario_id)) continue;
      vistos.add(a.usuario_id);
      personas.push({ usuario_id: a.usuario_id, nombre: a.nombre });
    }
    resultado.push({
      cargo_id: entrada.cargo_id,
      cargo_nombre: entrada.cargo_nombre,
      grupo,
      personas,
    });
  }
  return resultado;
}
