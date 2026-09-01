// D-065 · L05 — Toma de control del rol (superficie B, backend).
//
// Dominio de la PILA LIFO de control de un rol dentro de un turno. La pila NO se materializa nunca:
// se DERIVA, cada vez, del log append-only `bitacora.rotacion_control` (C2) ordenado por
// `rotacion_control_id` dentro de (turno_id, planta_id, cargo_id). Una fila jamás se borra ni se
// actualiza: la acción contraria se apila encima, y por eso el mismo log es la auditoría de quién
// tomó qué rol y cuándo. Materializarla (una columna `es_principal`, un UPDATE al tenedor) es
// exactamente el defecto nº 4 del legacy que este diseño evita.
//
// El FONDO conceptual de la pila es el titular que designó el patrón (C4, `titularesDeTurno` de L04)
// y NO está en el log: por eso no puede abandonar (`titular_no_abandona`, CA-12) y la pila nunca
// queda vacía. Encima del fondo van las tomas vivas: TOMAR apila, ABANDONAR desapila solo si el
// tope es quien abandona.
//
// Serialización REAL, no optimismo (requerimiento §7, CA-11). Lo que hay que serializar es el
// CÁLCULO del principal, no la escritura: el log admite los dos eventos de dos TOMAR concurrentes
// (los dos son legítimos y ambos deben quedar), pero la decisión "¿ya soy principal?" / "¿soy el
// tope?" tiene que leer un log que nadie más esté cambiando. Un UNIQUE no sirve para eso. Se usa
// `sp_getapplock` por (turno_id, cargo_id) DENTRO de la transacción, con @LockOwner='Transaction':
// el lock se suelta solo en el commit o el rollback, nunca a mano. Un retorno < 0 es timeout →
// `control_ocupado`.
//
// Convención TZ: `turno_unidad.fecha_operativa` es un DATE que mssql entrega como Date a medianoche
// UTC; se lee por sus partes UTC (nunca con el shift −5h, que la correría un día atrás) y viaja al
// motor como 'YYYY-MM-DD', que es lo único que el motor acepta (L01).

import sql from 'mssql';
import { titularesDeTurno } from './titulares.js';
import { resolverTurnoAbierto } from '../turno-entidad.js';

export const ACCIONES = Object.freeze(['TOMAR', 'ABANDONAR', 'DESCARTAR']);

// Lo que espera una transacción a que la anterior sobre el mismo (turno, cargo) comprometa. Cada
// transacción dura milisegundos; agotar esto significa un problema real, no contención normal.
export const LOCK_TIMEOUT_MS = 5000;

// Los seis códigos del motor del patrón (C1 + D1 del GATE-O1) más `cargo_invalido`, que
// `titularesDeTurno` (L04) agrega en C4. Si se propagan —un vector corrupto en `rotacion_patron`,
// una fecha que no es 'YYYY-MM-DD'— el router los mapea a 400 con su slug; jamás llegan crudos a la
// respuesta (D-032).
export const CODIGOS_MOTOR = new Set([
  'vector_invalido', 'desfase_imposible', 'desfase_ambiguo', 'turno_invalido',
  'fecha_invalida', 'patron_invalido', 'cargo_invalido',
]);

// Texto de usuario de cada 409 de dominio. El front ramifica por `codigo`, nunca por texto (D-032).
// `turno_cerrado` no está acá: lo responde `respTurnoCerrado` de `_middleware.js`, con el mismo slug
// que usan los demás write-gates del repo.
export const MENSAJES_CONTROL = Object.freeze({
  ya_es_principal: 'Ya tienes el control de este rol en el turno en curso.',
  no_es_principal: 'No tienes el control de este rol en este momento: solo quien lo tiene puede abandonarlo.',
  titular_no_abandona: 'Eres el titular del turno para este rol y el titular no abandona el control: es el fondo de la pila.',
  control_ocupado: 'Otra persona está tomando o abandonando este rol justo ahora. Intenta de nuevo en unos segundos.',
  rotacion_no_aplica: 'La toma de control no aplica para tu cargo en este turno.',
});

// Error de dominio con `codigo` estable. El router lo traduce a 409; cualquier otro error sigue su
// camino a `expressErrorHandler` (saneado, sin internals).
export class ErrorControl extends Error {
  constructor(codigo) {
    super(codigo);
    this.name = 'ErrorControl';
    this.codigo = codigo;
  }
}

// ---------------------------------------------------------------------------------------------
// Lógica pura (sin BD) — testeable con arreglos fijos.
// ---------------------------------------------------------------------------------------------

/**
 * DATE de mssql (Date a medianoche UTC) o string → 'YYYY-MM-DD'. Lee las partes UTC directas: un
 * DATE no tiene hora, su valor YA ES la fecha operativa; aplicarle el offset Bogotá la correría un
 * día atrás (mismo gotcha que documenta `fechaRefBogotaMediodia` en turno-entidad.js).
 */
export function fechaOperativaIso(valor) {
  if (valor instanceof Date) {
    const y = valor.getUTCFullYear();
    const m = String(valor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(valor.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(valor ?? '').slice(0, 10);
}

/**
 * Deriva las TOMAS vivas (la parte de la pila que sí está en el log) a partir de los eventos en
 * orden de `rotacion_control_id`. TOMAR apila; ABANDONAR desapila solo si el tope es ese usuario
 * (un ABANDONAR de quien no es tope es un evento inerte, no corrompe la pila); DESCARTAR no toca la
 * pila. Devuelve el arreglo de abajo hacia arriba: el último elemento es el tope.
 *
 * @param {Array<{ usuario_id: number, nombre?: string|null, accion: string }>} eventos
 * @returns {Array<{ usuario_id: number, nombre: string|null }>}
 */
export function derivarTomas(eventos = []) {
  const tomas = [];
  for (const e of eventos) {
    if (e.accion === 'TOMAR') {
      tomas.push({ usuario_id: e.usuario_id, nombre: e.nombre ?? null });
    } else if (e.accion === 'ABANDONAR' && tomas.length && tomas[tomas.length - 1].usuario_id === e.usuario_id) {
      tomas.pop();
    }
  }
  return tomas;
}

const COLLATOR = new Intl.Collator('es', { sensitivity: 'base' });

/**
 * Ordena el FONDO (los titulares del patrón) para que el primero por nombre quede de ÚLTIMO, o sea
 * en el TOPE del fondo. Así se cumplen las dos cosas a la vez: `principal` es siempre el tope de la
 * pila (invariante que L08 puede asumir) y, mientras nadie haya tomado el control, el principal por
 * defecto es el titular alfabéticamente primero. Con un solo titular —el caso de las mallas
 * reales— el orden es irrelevante. Desempate por `usuario_id` para que sea determinista.
 */
export function ordenarFondo(titulares = []) {
  return [...titulares].sort((a, b) => {
    const porNombre = COLLATOR.compare(String(b.nombre ?? ''), String(a.nombre ?? ''));
    return porNombre !== 0 ? porNombre : (b.usuario_id - a.usuario_id);
  });
}

/**
 * Arma el estado del contrato C5 sin tocar la BD.
 *
 * - `pila` = fondo (titulares, `es_titular: true`) + tomas vivas del log, de abajo hacia arriba.
 * - `principal` = tope de la pila, o `null` si el rol no tiene titulares y nadie tomó el control.
 * - `ya_respondi` = el usuario ya ejecutó CUALQUIERA de los tres verbos en este turno (CA-13).
 * - Con `aplica: false` todo lo demás sale neutro: el popup no se ofrece.
 */
export function armarEstado({
  aplica, turno_id = null, cargo_id = null, cargo_nombre = null,
  titulares = [], eventos = [], usuario_id,
}) {
  const base = { aplica: Boolean(aplica), turno_id, cargo_id, cargo_nombre };
  if (!aplica) {
    return { ...base, principal: null, soy_principal: false, soy_titular: false, ya_respondi: false, pila: [] };
  }
  const esTitular = (id) => titulares.some((t) => t.usuario_id === id);
  const fondo = ordenarFondo(titulares).map((t) => ({ usuario_id: t.usuario_id, nombre: t.nombre ?? null, es_titular: true }));
  const tomas = derivarTomas(eventos).map((t) => ({ ...t, es_titular: esTitular(t.usuario_id) }));
  const pila = [...fondo, ...tomas];
  const tope = pila.length ? pila[pila.length - 1] : null;
  const principal = tope ? { usuario_id: tope.usuario_id, nombre: tope.nombre } : null;
  return {
    ...base,
    principal,
    soy_principal: principal != null && principal.usuario_id === usuario_id,
    soy_titular: esTitular(usuario_id),
    ya_respondi: eventos.some((e) => e.usuario_id === usuario_id),
    pila,
  };
}

// ---------------------------------------------------------------------------------------------
// Acceso a datos.
// ---------------------------------------------------------------------------------------------

async function flagsCargo(request, cargo_id) {
  const r = await request
    .input('cargo_id', sql.Int, cargo_id)
    .query(`
      SELECT nombre,
             CAST(es_observador             AS BIT) AS es_observador,
             CAST(puede_configurar_rotacion AS BIT) AS puede_configurar_rotacion
      FROM lov_bit.cargo
      WHERE cargo_id = @cargo_id
    `);
  return r.recordset[0] ?? null;
}

async function leerEventos(request, { turno_id, planta_id, cargo_id }) {
  const r = await request
    .input('turno_id', sql.Int, turno_id)
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('cargo_id', sql.Int, cargo_id)
    .query(`
      SELECT rc.rotacion_control_id, rc.usuario_id, u.nombre_completo AS nombre, rc.accion
      FROM bitacora.rotacion_control rc
      INNER JOIN lov_bit.usuario u ON u.usuario_id = rc.usuario_id
      WHERE rc.turno_id = @turno_id AND rc.planta_id = @planta_id AND rc.cargo_id = @cargo_id
      ORDER BY rc.rotacion_control_id
    `);
  return r.recordset;
}

/**
 * ¿Aplica la toma de control al cargo de la sesión en este turno, y quiénes son sus titulares?
 * Es CONFIGURACIÓN (flags del cargo + patrón y asignaciones), no estado del turno: se resuelve fuera
 * de la transacción de los verbos.
 *
 * `aplica = false` cuando (decisión R12):
 *   - el cargo lleva `es_observador = 1` (USUARIO DE CONSULTA, D-059), o
 *   - lleva `puede_configurar_rotacion = 1` (Administrador y Debugging, Gerente de Producción):
 *     quien configura la malla no compite por un puesto en ella, o
 *   - el cargo no tiene patrón activo para la fecha operativa del turno (`titularesDeTurno` no lo
 *     devuelve): un rol sin patrón simplemente no rota.
 * Los dos primeros se resuelven por FLAG, nunca por nombre de cargo (convención 12): son los mismos
 * flags que el MERGE de cargos fija en cada arranque. El Ingeniero Químico y el Coordinador de
 * carbón y maquinaria no son un caso especial: aplican si tienen patrón.
 */
async function contextoRol(pool, sesion, turno) {
  const flags = await flagsCargo(pool.request(), sesion.cargo_id);
  const cargo_nombre = flags?.nombre ?? sesion.cargo_nombre ?? null;
  if (!flags || flags.es_observador || flags.puede_configurar_rotacion) {
    return { aplica: false, cargo_nombre, titulares: [] };
  }
  const roles = await titularesDeTurno(pool, {
    fechaOperativa: fechaOperativaIso(turno.fecha_operativa),
    turno: turno.turno,
    cargo_id: sesion.cargo_id,
  });
  const rol = (roles ?? []).find((r) => r.cargo_id === sesion.cargo_id);
  if (!rol) return { aplica: false, cargo_nombre, titulares: [] };
  return { aplica: true, cargo_nombre: rol.cargo_nombre ?? cargo_nombre, titulares: rol.personas ?? [] };
}

/**
 * `GET /estado`: el shape C5 para la sesión. Sin turno ABIERTO en la unidad el popup no se ofrece
 * (`aplica: false`, `turno_id: null`): un GET informativo no responde 409; los verbos sí (CA-14).
 */
export async function estadoControl(pool, sesion) {
  const turno = await resolverTurnoAbierto(pool, sesion.planta_id);
  const base = {
    turno_id: turno?.turno_unidad_id ?? null,
    cargo_id: sesion.cargo_id,
    cargo_nombre: sesion.cargo_nombre ?? null,
    usuario_id: sesion.usuario_id,
  };
  if (!turno) return armarEstado({ aplica: false, ...base });

  const ctx = await contextoRol(pool, sesion, turno);
  if (!ctx.aplica) return armarEstado({ aplica: false, ...base, cargo_nombre: ctx.cargo_nombre });

  const eventos = await leerEventos(pool.request(), {
    turno_id: turno.turno_unidad_id, planta_id: sesion.planta_id, cargo_id: sesion.cargo_id,
  });
  return armarEstado({ aplica: true, ...base, cargo_nombre: ctx.cargo_nombre, titulares: ctx.titulares, eventos });
}

async function tomarLock(request, { turno_id, cargo_id }) {
  const r = await request
    .input('recurso', sql.NVarChar(255), `rotacion-control-${turno_id}-${cargo_id}`)
    .input('timeout', sql.Int, LOCK_TIMEOUT_MS)
    .query(`
      DECLARE @rc INT;
      EXEC @rc = sp_getapplock
        @Resource = @recurso, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @timeout;
      SELECT @rc AS rc;
    `);
  return r.recordset[0].rc;
}

/**
 * Ejecuta uno de los tres verbos para la sesión y devuelve el estado C5 resultante.
 *
 * Lanza `ErrorControl` con `codigo`:
 *   turno_cerrado        — la unidad no tiene turno ABIERTO (los tres verbos, CA-14)
 *   rotacion_no_aplica   — el cargo no rota o está excluido (R12)
 *   control_ocupado      — timeout del applock (otra transacción del mismo (turno, cargo) no soltó)
 *   ya_es_principal      — TOMAR de quien ya es el tope
 *   no_es_principal      — ABANDONAR de quien no es el tope
 *   titular_no_abandona  — ABANDONAR del fondo (sin tomas vivas), CA-12
 * Cualquier otro error (BD, motor) se propaga tal cual para que lo sanee quien corresponde.
 */
export async function ejecutarAccion(pool, sesion, accion) {
  if (!ACCIONES.includes(accion)) throw new Error(`ejecutarAccion: acción inválida '${accion}'`);

  const turno = await resolverTurnoAbierto(pool, sesion.planta_id);
  if (!turno) throw new ErrorControl('turno_cerrado');

  const ctx = await contextoRol(pool, sesion, turno);
  if (!ctx.aplica) throw new ErrorControl('rotacion_no_aplica');

  const clave = { turno_id: turno.turno_unidad_id, planta_id: sesion.planta_id, cargo_id: sesion.cargo_id };
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // 1) Serializar el cálculo del principal por (turno, cargo). Con @LockOwner='Transaction' el lock
    //    vive hasta el commit/rollback de abajo; no se libera a mano.
    const rc = await tomarLock(new sql.Request(tx), clave);
    if (rc < 0) throw new ErrorControl('control_ocupado');

    // 2) El turno pudo cerrarse entre la resolución de arriba y el lock (`cerrarTurno` corre en su
    //    propia transacción): se re-verifica ya serializados, para no apilar sobre un turno CERRADO
    //    ni alterar lo que L06 congela al cerrar.
    const abierto = await new sql.Request(tx)
      .input('turno_id', sql.Int, clave.turno_id)
      .query(`SELECT 1 AS x FROM bitacora.turno_unidad WHERE turno_unidad_id = @turno_id AND estado = 'ABIERTO'`);
    if (!abierto.recordset[0]) throw new ErrorControl('turno_cerrado');

    // 3) Leer el log y derivar el estado previo.
    const eventos = await leerEventos(new sql.Request(tx), clave);
    const previo = armarEstado({
      aplica: true, ...clave, cargo_nombre: ctx.cargo_nombre,
      titulares: ctx.titulares, eventos, usuario_id: sesion.usuario_id,
    });

    // 4) Reglas del verbo.
    let insertar = true;
    if (accion === 'TOMAR') {
      if (previo.soy_principal) throw new ErrorControl('ya_es_principal');
    } else if (accion === 'ABANDONAR') {
      const tomas = derivarTomas(eventos);
      if (tomas.length === 0) {
        // Sin tomas vivas el principal es el fondo, y el fondo no se abandona.
        throw new ErrorControl(previo.soy_titular ? 'titular_no_abandona' : 'no_es_principal');
      }
      if (tomas[tomas.length - 1].usuario_id !== sesion.usuario_id) throw new ErrorControl('no_es_principal');
    } else {
      // DESCARTAR es el "No" del popup: no entra en la pila, solo deja `ya_respondi = true`. Un
      // segundo DESCARTAR del mismo usuario no agrega otra fila (idempotente).
      insertar = !eventos.some((e) => e.usuario_id === sesion.usuario_id && e.accion === 'DESCARTAR');
    }

    // 5) Apilar el evento (append-only: nunca UPDATE ni DELETE sobre este log).
    if (insertar) {
      await new sql.Request(tx)
        .input('turno_id', sql.Int, clave.turno_id)
        .input('planta_id', sql.VarChar(10), clave.planta_id)
        .input('cargo_id', sql.Int, clave.cargo_id)
        .input('usuario_id', sql.Int, sesion.usuario_id)
        .input('accion', sql.VarChar(12), accion)
        .query(`
          INSERT INTO bitacora.rotacion_control (turno_id, planta_id, cargo_id, usuario_id, accion)
          VALUES (@turno_id, @planta_id, @cargo_id, @usuario_id, @accion)
        `);
      eventos.push({ usuario_id: sesion.usuario_id, nombre: sesion.nombre_completo ?? null, accion });
    }

    await tx.commit();
    return armarEstado({
      aplica: true, ...clave, cargo_nombre: ctx.cargo_nombre,
      titulares: ctx.titulares, eventos, usuario_id: sesion.usuario_id,
    });
  } catch (e) {
    try { await tx.rollback(); } catch { /* rollback best-effort */ }
    throw e;
  }
}
