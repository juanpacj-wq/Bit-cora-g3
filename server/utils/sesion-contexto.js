import sql from 'mssql';
import { TEST_PLANTA_ID } from '../db.js';
import { getTurnoColombia, ventanaActual, fechaBogotaStr } from './turno.js';
import {
  resolverTurnoAbierto,
  abrirTurnoSiFalta,
  marcarParticipante,
  acumularPresenciaSesiones,
} from './turno-entidad.js';

// D-054 — Dominio del CONTEXTO OPERATIVO de una sesión de app (en qué unidad estás operando).
//
// Existe porque hay DOS caminos para fijar ese contexto y ambos deben comportarse idénticamente:
//   - POST /api/auth/select-context : al entrar (aún no hay sesión de app; solo identidad Entra).
//   - POST /api/auth/cambiar-unidad : en caliente (ya hay sesión de app; gateado por permiso).
// Antes de D-054 solo existía el primero y su transacción vivía inline en el router. Duplicarla
// para el segundo habría dejado el CASE de ventana de D-040 y el barrido de sesión única de D-035
// en dos copias que driftean en silencio (el bug clásico de este repo: una copia se corrige y la
// otra no). Acá viven UNA sola vez; los routers solo validan y delegan.

/**
 * ¿La planta acepta un contexto de operación? Fuente ÚNICA de esa regla, compartida por
 * select-context (entrar) y cambiar-unidad (cambiar en caliente): ninguna puede quedarse corta
 * respecto de la otra.
 *
 * TEST_PLANTA_ID queda EXCLUIDA a nivel de query (mismo criterio que GET /api/catalogos/plantas):
 * la planta de test es residente en `lov_bit.planta` con `activa=1` — D-030 la necesita así para la
 * FK de sesion_activa y para la validación del POST DISP — de modo que filtrar solo por `activa=1`
 * la dejaba pasar. El selector del login nunca la ofrece, pero eso es una barrera de UI: acá se
 * cierra en el server, que es donde cuenta.
 */
export async function validarPlantaOperable(db, planta_id) {
  const r = await db.request()
    .input('planta_id', sql.VarChar(10), planta_id)
    .input('test_planta', sql.VarChar(10), TEST_PLANTA_ID)
    .query(`
      SELECT COUNT(*) AS ok FROM lov_bit.planta
      WHERE planta_id = @planta_id AND activa = 1 AND planta_id <> @test_planta
    `);
  return !!r.recordset[0].ok;
}

/** Resuelve cargo_id desde el nombre canónico del cargo (el que devuelve resolveCargo del token). */
export async function resolverCargoId(db, cargo_nombre) {
  const r = await db.request()
    .input('cargo_nombre', sql.VarChar(100), cargo_nombre)
    .query(`SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @cargo_nombre`);
  return r.recordset[0]?.cargo_id ?? null;
}

/**
 * Fija el contexto operativo del usuario en `planta_id`: acumula la presencia del lapso anterior,
 * desactiva cualquier OTRA sesión de app suya (D-035 sesión única), reactiva o crea la fila de la
 * unidad destino y marca su participación en el turno vigente.
 *
 * Orden NO negociable: la presencia se acumula ANTES de tocar `activa`/`inicio_sesion`, porque
 * `acumularPresenciaSesiones` lee `[inicio_sesion, ahora)` y `turno_id` de las filas AÚN activas
 * (turno-entidad.js) — y el paso siguiente pisa ambos.
 *
 * Los bloques de turno/presencia/participación son best-effort a propósito: un fallo ahí degrada la
 * telemetría de presencia, pero NUNCA debe impedir que la persona entre a operar.
 *
 * @returns {Promise<object>} la fila de sesión (mismo shape que SELECT_SESION de middleware/auth.js)
 */
export async function establecerContextoSesion(db, { usuario_id, planta_id, cargo_id, cargo_nombre }) {
  const turno = getTurnoColombia();
  // D-040 (persistencia por ventana de turno): la ventana [inicio, fin) del turno actual acota si
  // una finalización previa sigue vigente. Se pasa a la reactivación para PRESERVARla dentro del
  // mismo turno (re-login / volver a la unidad) y limpiarla solo si es de un turno pasado.
  const { inicio: ventanaInicio, fin: ventanaFin } = ventanaActual();

  // D-059: un cargo observador (solo consulta) NO deja huella de turno: su login no abre cabeceras,
  // su sesión queda con turno_id=NULL y nunca se marca como participante — por construcción no
  // existe en turno_participante ni en la conformación. El flag se consulta ACÁ (chokepoint único
  // de contexto) y no en los callers, para que select-context y cambiar-unidad no puedan divergir.
  // Sin try/catch a propósito: si esta consulta falla, falla el login completo (nunca degradar a
  // "tratarlo como operador" en silencio).
  const rc = await db.request()
    .input('cargo_id', sql.Int, cargo_id)
    .query(`SELECT CAST(es_observador AS BIT) AS es_observador FROM lov_bit.cargo WHERE cargo_id = @cargo_id`);
  const cargoObservador = rc.recordset[0]?.es_observador === true;

  // D-045 E4 (participación viva): resolver la cabecera del turno ABIERTO de la unidad para vincularla
  // a la sesión y marcar participación. Si aún no existe (borde de ventana, antes del tick del sweeper)
  // se crea acá (idempotente). Nunca reabre un turno CERRADO: abrirTurnoSiFalta devuelve la fila
  // existente tal cual, así que resolverTurnoAbierto sigue dando null → se entra sin turno_id.
  // D-059: para un observador NO se resuelve ni se abre nada — turnoId queda NULL.
  let turnoId = null;
  if (!cargoObservador) try {
    let turnoAbierto = await resolverTurnoAbierto(db, planta_id);
    if (!turnoAbierto) {
      await abrirTurnoSiFalta(db, planta_id, turno, fechaBogotaStr(ventanaInicio));
      turnoAbierto = await resolverTurnoAbierto(db, planta_id);
    }
    turnoId = turnoAbierto?.turno_unidad_id ?? null;
  } catch (err) {
    console.error('[sesion-contexto] no se pudo resolver turno_unidad (participación no marcada):', err.message);
  }

  // D-045 E4 (presencia): antes de reactivar/desactivar, cerrar el lapso de presencia de TODAS las
  // sesiones activas del usuario (la que se refresca acá y las que "sesión única" va a desactivar) —
  // se suma [inicio_sesion, ahora) a su turno_participante. Best-effort.
  try {
    const activas = await db.request()
      .input('usuario_id', sql.Int, usuario_id)
      .query(`SELECT sesion_id FROM bitacora.sesion_activa WHERE usuario_id = @usuario_id AND activa = 1 AND turno_id IS NOT NULL`);
    await acumularPresenciaSesiones(db, activas.recordset.map((r) => r.sesion_id));
  } catch (err) {
    console.error('[sesion-contexto] no se pudo acumular presencia previa:', err.message);
  }

  // Dedupe por (usuario_id, planta_id, cargo_id). Sesión de app POR TURNO: al reactivar REFRESCAMOS
  // inicio_sesion y turno. UPDLOCK+HOLDLOCK serializa pestañas.
  const transaction = new sql.Transaction(db);
  await transaction.begin();
  let result;
  try {
    result = await new sql.Request(transaction)
      .input('usuario_id', sql.Int, usuario_id)
      .input('planta_id', sql.VarChar(10), planta_id)
      .input('cargo_id', sql.Int, cargo_id)
      .input('turno', sql.TinyInt, turno)
      .input('turno_id', sql.Int, turnoId)
      .input('ventana_inicio', sql.DateTime2, ventanaInicio)
      .input('ventana_fin', sql.DateTime2, ventanaFin)
      .query(`
        -- D-035 (sesión única por persona): al entrar a una unidad, desactivar cualquier OTRA
        -- sesión de app activa de este usuario (otra planta/cargo).
        UPDATE bitacora.sesion_activa
           SET activa = 0, cerrada_en = SYSUTCDATETIME()
         WHERE usuario_id = @usuario_id
           AND activa = 1
           AND NOT (planta_id = @planta_id AND cargo_id = @cargo_id);

        DECLARE @sesion_id INT;
        SELECT TOP 1 @sesion_id = sesion_id
        FROM bitacora.sesion_activa WITH (UPDLOCK, HOLDLOCK)
        WHERE usuario_id = @usuario_id
          AND planta_id  = @planta_id
          AND cargo_id   = @cargo_id
        ORDER BY inicio_sesion DESC;

        IF @sesion_id IS NOT NULL
        BEGIN
          UPDATE bitacora.sesion_activa
             SET activa               = 1,
                 cerrada_en           = NULL,
                 inicio_sesion        = SYSUTCDATETIME(),
                 turno                = @turno,
                 turno_id             = @turno_id,   -- D-045 E4: vínculo a la cabecera del turno
                 ultima_actividad     = SYSUTCDATETIME(),
                 -- D-040 (persistencia por ventana): reactivar NO reabre el turno si la finalización
                 -- sigue dentro de la ventana del turno actual (re-login / volver a la unidad en el
                 -- MISMO turno la PRESERVA). Solo se limpia si es de un turno pasado (o ya era NULL),
                 -- así "empieza el siguiente turno" la expira sola. Reemplaza el reset incondicional
                 -- que reabría el turno en cada reactivación (causa del bug).
                 turno_finalizado_en  = CASE
                   WHEN turno_finalizado_en >= @ventana_inicio AND turno_finalizado_en < @ventana_fin
                   THEN turno_finalizado_en
                   ELSE NULL
                 END
           WHERE sesion_id = @sesion_id;
        END
        ELSE
        BEGIN
          INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno, turno_id)
          VALUES (@usuario_id, @planta_id, @cargo_id, @turno, @turno_id);
          SET @sesion_id = SCOPE_IDENTITY();
        END

        -- ESPEJO de SELECT_SESION (middleware/auth.js): mismo shape de sesión — cambiar juntos (D-059).
        SELECT s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
               s.inicio_sesion, s.ultima_actividad, s.turno_finalizado_en,
               u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
               c.nombre AS cargo_nombre, c.solo_lectura,
               CAST(c.puede_cerrar_turno   AS BIT) AS puede_cerrar_turno,
               CAST(c.puede_cambiar_unidad AS BIT) AS puede_cambiar_unidad,
               CAST(c.es_observador        AS BIT) AS es_observador
        FROM bitacora.sesion_activa s
        INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
        INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id
        WHERE s.sesion_id = @sesion_id;
      `);
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    throw err;
  }

  // D-045 E4 (participación viva): tras crear/reactivar la sesión, marcar al usuario como participante
  // del turno vigente (UPSERT idempotente, no pisa primer_ingreso). Best-effort: no debe tumbar el login.
  // D-059: para un observador turnoId quedó NULL arriba → el guard de marcarParticipante lo vuelve
  // no-op (nunca entra a turno_participante).
  try {
    await marcarParticipante(db, {
      turno_id: turnoId,
      usuario_id,
      cargo_id,
      cargo_nombre,
    });
  } catch (err) {
    console.error('[sesion-contexto] no se pudo marcar participación:', err.message);
  }

  return result.recordset[0];
}
