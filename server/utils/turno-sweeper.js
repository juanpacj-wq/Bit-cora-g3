import sql from 'mssql';
import { ventanaTurno, ventanaActual, fechaBogotaStr, getTurnoColombia } from './turno.js';
import { registrarEventoCierre } from './ciet.js';
import { abrirTurnoSiFalta, acumularPresenciaSesiones, transicionarTurnosVencidos, resolverTurnoAbierto } from './turno-entidad.js';
import { broadcastTurnoTransicion } from './ws-turno-transicion.js';

const INTERVAL_MS = 60_000;

// D-045: unidades con cabecera de turno = las dos plantas térmicas físicas de Gecelca. MAND (cierra
// por día) y DISP (estado continuo) NO tienen cabecera de turno; el resto de bitácoras opera sobre
// estas mismas dos unidades. Hardcodeado como en el resto del subrepo (p.ej. el chequeo MAND de db.js).
const PLANTAS_TURNO = ['GEC3', 'GEC32'];

let timer = null;

// D-045 E3: asegura que exista la fila de turno_unidad del turno VIGENTE por unidad (apertura
// automática, autor SISTEMA). Idempotente (UPSERT por UNIQUE natural en abrirTurnoSiFalta): si la
// unidad ya tiene un ABIERTO —p.ej. el turno anterior extendido— la fila del turno vigente nace
// PROGRAMADO (sucesor sin solape); si no hay ninguno abierto, nace ABIERTO. Forward-only: NO
// backfillea turnos pasados (el histórico se purga en E10). Error boundary por planta: un fallo en
// una unidad no impide la otra ni tumba el timer. La transición PROGRAMADO→ABIERTO la dispara el
// cierre del anterior (E6/E7); acá sólo se garantiza que la fila (ABIERTO o PROGRAMADO) exista.
export async function abrirTurnosVigentes(pool, { log = false } = {}) {
  const ahora = new Date();
  const turno = getTurnoColombia();
  const { inicio } = ventanaActual(ahora);
  const fechaOperativa = fechaBogotaStr(inicio);
  for (const planta_id of PLANTAS_TURNO) {
    try {
      // Detectar apertura de un turno ABIERTO nuevo para avisar por WS: tras un cierre anticipado la
      // unidad quedó sin ABIERTO y el front en solo-lectura; cuando la ventana siguiente lo abre, sin
      // este aviso el front seguiría bloqueado hasta un F5 (la apertura por ventana no dispara transición).
      const antes = await resolverTurnoAbierto(pool, planta_id);
      const row = await abrirTurnoSiFalta(pool, planta_id, turno, fechaOperativa, ahora);
      if (row.estado === 'ABIERTO' && (!antes || antes.turno_unidad_id !== row.turno_unidad_id)) {
        broadcastTurnoTransicion(planta_id, { estado: 'ABIERTO', bloqueo: false });
      }
      if (log) {
        console.log(`[turno-sweeper] turno vigente asegurado: ${planta_id} T${turno} ${fechaOperativa} → ${row.estado} (#${row.turno_unidad_id})`);
      }
    } catch (err) {
      console.error(`[turno-sweeper] error abriendo turno vigente ${planta_id} T${turno} ${fechaOperativa}:`, err.message);
    }
  }
}

// D-045 E7: transiciona los turnos ABIERTO vencidos de las unidades con cabecera (flujo 6-a-6) y avisa
// por WS a la planta. `transicionarTurnosVencidos` decide cierre (AUTO_SIN_PERSONAL / AUTO_SIN_RESPUESTA)
// o bloqueo (personal aún en gracia) y devuelve el resumen; acá lo transmitimos. Solo GEC3/GEC32
// (PLANTAS_TURNO) — TST queda fuera para no interferir con los tests de dominio. Error boundary propio.
export async function transicionarYAvisar(pool) {
  let transiciones = [];
  try {
    transiciones = await transicionarTurnosVencidos(pool, { plantas: PLANTAS_TURNO });
  } catch (err) {
    console.error('[turno-sweeper] error en transiciones de turno:', err.message);
    return;
  }
  for (const t of transiciones) {
    if (t.accion === 'cerrado') {
      console.log(`[turno-sweeper] turno #${t.turno_unidad_id} ${t.planta_id} auto-cerrado (${t.motivo}); sucesor #${t.sucesor_id ?? '—'}`);
      broadcastTurnoTransicion(t.planta_id, { estado: 'CERRADO', bloqueo: false, motivo: t.motivo });
    } else if (t.accion === 'bloqueo') {
      broadcastTurnoTransicion(t.planta_id, { estado: 'ABIERTO', bloqueo: true });
    }
  }
}

// F4: finaliza automáticamente las sesion_bitacora cuya ventana de turno ya terminó.
// Login Entra (cambio de conducta vs. F2): además EXPULSA la sesión de app (sesion_activa.activa=0)
// a fin de turno. La cookie de login Entra NO se toca — el usuario sigue autenticado; al volver en
// el turno siguiente, abrir la página reactiva sesion_activa vía select-context. Son dos sesiones
// separadas (cookie Entra = identidad; sesion_activa = participación en el turno). Ver ADR e
// invariante en CLAUDE.md (la convención "TTL ninguno / activa=1 hasta logout" quedó superada).
// Hace la finalización y la emisión de CIET en una transacción por sesion_bitacora — si
// algo falla en una, las demás siguen procesándose en su propia transacción.
export async function sweepTurnosVencidos(pool) {
  const ahora = new Date();
  // Listamos candidatos primero (sin lock) — la transacción individual hace su propia
  // verificación y aplica el UPDATE solo si sigue NULL. Idempotente.
  const r = await pool.request().query(`
    SELECT sb.sesion_bitacora_id, sb.sesion_id, sb.bitacora_id, sb.abierta_en,
           sa.usuario_id, sa.planta_id, sa.turno, c.nombre AS cargo_nombre,
           u.nombre_completo
    FROM bitacora.sesion_bitacora sb
    INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
    INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
    INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
    WHERE sa.activa = 1 AND sb.finalizada_en IS NULL
  `);

  let finalizadas = 0;
  // Agrupamos por (sesion_id) para emitir UN solo CIET por sesión-usuario aunque tenga
  // varias bitácoras abiertas. campos_extra.bitacora_origen queda null en ese caso (es una
  // finalización global por agotamiento de turno).
  const porSesion = new Map();
  for (const row of r.recordset) {
    const { fin } = ventanaTurno(row.turno, row.abierta_en);
    if (ahora < fin) continue; // ventana aún no termina
    if (!porSesion.has(row.sesion_id)) porSesion.set(row.sesion_id, { row, ids: [] });
    porSesion.get(row.sesion_id).ids.push(row.sesion_bitacora_id);
  }

  for (const { row, ids } of porSesion.values()) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // UPDATE solo las que siguen NULL (idempotente entre runs concurrentes).
      // AUD-41 (BIT-AUDSEG-2026-001): lista parametrizada (@id0,@id1,...) en vez de CSV concatenado.
      // `ids` siempre trae >=1 (se pobló al agrupar por sesión), pero guardamos el caso vacío igual.
      const reqUpd = new sql.Request(transaction);
      const placeholdersUpd = ids.map((id, i) => {
        reqUpd.input('id' + i, sql.Int, id);
        return '@id' + i;
      }).join(',');
      if (placeholdersUpd.length === 0) { await transaction.commit(); continue; }
      const upd = await reqUpd.query(`
        UPDATE bitacora.sesion_bitacora
        SET finalizada_en = SYSUTCDATETIME()
        WHERE sesion_bitacora_id IN (${placeholdersUpd}) AND finalizada_en IS NULL
      `);
      const n = upd.rowsAffected[0] || 0;
      if (n > 0) {
        await registrarEventoCierre(transaction, {
          tipo: 'finalizacion',
          sesion: {
            usuario_id: row.usuario_id,
            planta_id: row.planta_id,
            turno: row.turno,
            cargo_nombre: row.cargo_nombre,
          },
          forzado: true,
          motivo: 'sweeper',
        });
        finalizadas += n;
      }
      await transaction.commit();
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      console.error(`[turno-sweeper] error finalizando sesion ${row.sesion_id}:`, err.message);
    }
  }

  // D-045 E6: RETIRADO el disparo automático de conformación por el sweeper (cierra el hallazgo H2 de
  // la auditoría 2026-07-04). Antes acá se derivaba (planta, turno, fecha_operativa) de las sesiones
  // finalizadas y se corría buildConformacionSnapshot; convivía con el cierre real y podía snapshotear
  // un turno todavía sin sellar. La conformación es ahora un producto ATÓMICO de `cerrarTurno` (sella
  // la cabecera + congela desde turno_participante en una sola transacción). El sweeper conserva SOLO
  // la finalización de sesion_bitacora y la expulsión de sesion_activa; el auto-cierre de la cabecera
  // vencida lo agrega E7.

  // Expulsión de sesión de app a fin de turno (login Entra). Se hace DESPUÉS de la conformación
  // (que filtra por la ventana de inicio_sesion y usa cerrada_en, no por activa). Recorre TODAS
  // las sesiones activas — no solo las que tenían sesion_bitacora abierta — y cierra aquellas
  // cuya ventana de turno (según su inicio_sesion) ya terminó. Las reactivadas en el turno
  // vigente tienen inicio_sesion fresco → su ventana no venció → no se expulsan.
  try {
    const activas = await pool.request().query(
      `SELECT sesion_id, turno, inicio_sesion FROM bitacora.sesion_activa WHERE activa = 1`
    );
    const expirados = [];
    for (const s of activas.recordset) {
      const { fin } = ventanaTurno(s.turno, s.inicio_sesion);
      if (ahora >= fin) expirados.push(s.sesion_id);
    }
    if (expirados.length > 0) {
      // D-045 E4 (presencia): cerrar el lapso de presencia de las sesiones que se van a expulsar ANTES
      // de ponerlas activa=0 (la acumulación necesita inicio_sesion + turno_id con la sesión aún activa).
      // Error boundary propio: un fallo acá no debe impedir la expulsión del turno.
      try {
        await acumularPresenciaSesiones(pool, expirados);
      } catch (err) {
        console.error('[turno-sweeper] error acumulando presencia al expulsar:', err.message);
      }
      // AUD-41: lista parametrizada (@id0,@id1,...) en vez de CSV concatenado.
      const reqExp = pool.request();
      const placeholdersExp = expirados.map((id, i) => {
        reqExp.input('id' + i, sql.Int, id);
        return '@id' + i;
      }).join(',');
      await reqExp.query(`
        UPDATE bitacora.sesion_activa
           SET activa = 0, cerrada_en = SYSUTCDATETIME()
         WHERE activa = 1 AND sesion_id IN (${placeholdersExp})
      `);
      console.log(`[turno-sweeper] ${expirados.length} sesion_activa expulsadas a fin de turno`);
    }
  } catch (err) {
    console.error('[turno-sweeper] error expulsando sesiones a fin de turno:', err.message);
  }

  return finalizadas;
}

export function startTurnoSweeper(pool) {
  if (timer) return;
  // D-045 E3: catchup de apertura al ARRANQUE (forward-only). Asegura la fila del turno vigente por
  // unidad sin esperar el primer tick de 60s. Fire-and-forget: su propio error boundary interno (por
  // planta) evita que un fallo de apertura tumbe el bootstrap; el .catch cubre un fallo global.
  abrirTurnosVigentes(pool, { log: true }).catch((err) =>
    console.error('[turno-sweeper] apertura de arranque falló:', err.message)
  );
  const tick = async () => {
    try {
      // D-045 E3: en cada tick asegura la fila del turno vigente (crea el ABIERTO al entrar la ventana,
      // o el sucesor PROGRAMADO si el anterior sigue extendido). Idempotente → silencioso salvo error.
      await abrirTurnosVigentes(pool);
      // D-045 E7: cerrar/bloquear turnos vencidos ANTES de expulsar sesiones (el cierre atómico usa la
      // presencia de las sesiones aún activas; la expulsión de sweepTurnosVencidos viene después).
      await transicionarYAvisar(pool);
      const n = await sweepTurnosVencidos(pool);
      if (n > 0) console.log(`[turno-sweeper] ${n} sesion_bitacora finalizadas por agotamiento de turno`);
    } catch (err) {
      console.error('[turno-sweeper]', err);
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, INTERVAL_MS);
}

export function stopTurnoSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
