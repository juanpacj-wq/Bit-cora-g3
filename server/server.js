import http from 'http';
import sql from 'mssql';
import { initDB, getDB } from './db.js';
// F16: USUARIO_SISTEMA_ID es un export `let` que se inicializa al final de initDB(). El
// binding live de ESM permite usarlo después; al momento de los handlers del request ya
// está cargado.
import * as dbBindings from './db.js';
import { parseBody, sendJSON } from './utils/http.js';
import { aplicarRateLimit, getDispBitacoraId } from './routes/_shared.js';
import { responderError } from './utils/errores.js';
import { resolveCargo } from './utils/entra-roles.js';
import { getTurnoColombia, periodoFromFechaBogota, turnoFromPeriodo, fechaBogotaStr } from './utils/turno.js';
import { loadSession } from './middleware/auth.js';
import { hasPermisoBitacora, puedeCerrarTurno, plantaMatch, canEditarRegistro } from './middleware/permissions.js';
import { validateCamposExtra, computeCamposAuto } from './utils/campos.js';
import {
  findEventoDashboard, upsertEventoDashboard, hasNotificarDashboard,
  // D-026: DISP storage migró a `bitacora.disponibilidad_estado`. Los helpers viejos
  // (find/upsert/deleteDisponibilidadDashboard) fueron reemplazados por los siguientes.
  findVigente, findUltimoCerrado, insertNuevoEstado, cerrarVigente, actualizarVigente,
  eliminarPorId, restaurarComoVigente, getEstadoCompleto, getMetricas,
} from './utils/notificador.js';
import {
  snapshotJDTs, snapshotJefes, snapshotIngenieros, snapshotGerentesProduccion,
} from './utils/snapshots.js';
import { registrarEventoCierre, registrarDeshacerDisponibilidad } from './utils/ciet.js';
import { attachWSS, broadcastUsuariosActivos } from './utils/ws-usuarios-activos.js';
import { attachWSConteoBitacoras, broadcastConteoBitacoras } from './utils/ws-conteo-bitacoras.js';
// F9: turno-sweeper reemplazó al viejo sesion-sweeper (eliminado). Finaliza sesion_bitacora
// cuando la ventana del turno termina, sin tocar sesion_activa.activa.
import { startTurnoSweeper, stopTurnoSweeper } from './utils/turno-sweeper.js';
// F16: sweeper diario MAND + helper de cierre manual.
import { startMandSweeper, stopMandSweeper, cerrarDiaMand } from './utils/mand-sweeper.js';
import { startSisSweeper, stopSisSweeper } from './utils/sis/sis-sweeper.js';
// Login Entra ID: wrapper Express (sesión cookie + rutas /auth) que envuelve este if-chain.
import { buildAuthApp, setBroadcastUsuariosActivos } from './auth/app.js';

const PORT = parseInt(process.env.SERVER_PORT || '3002', 10);

// F12 / D-024: catálogo cerrado de estados DISP. Coincide con la regla en
// lov_bit.bitacora.definicion_campos (db.js DISP_JSON) — duplicada acá porque la rama
// DISP no pasa por validateCamposExtra.
//
// Indisponible y Mantenimiento comparten codigo=-1 a propósito: el código numérico es la
// métrica agregable de "horas de indisponibilidad" (reporte XM); el string `evento` es el
// discriminador semántico (salida forzada vs. consignación / mantenimiento planeado).
const DISP_EVENTOS_VALIDOS = ['En Servicio', 'En Reserva', 'Indisponible', 'Mantenimiento'];
const DISP_CODIGO_POR_EVENTO = { 'En Servicio': 1, 'En Reserva': 0, Indisponible: -1, Mantenimiento: -1 };

function parseExtra(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// D-026: getDispBitacoraId (cache lazy del bitacora_id de DISP) se movió a routes/_shared.js
// (lo comparten el router de disponibilidad y la rama DISP de registros aún en el if-chain).

// D-026: traduce una fila de `bitacora.disponibilidad_estado` al shape que el frontend ya
// consume (legacy de `registro_activo` + `campos_extra` JSON). Mantener byte-a-byte salvo
// `bitacora_id` (que no estaba en el row de activo pero el handler ya lo conocía por body).
function mapDispRowToLegacyShape(row, bitacoraId) {
  const fechaInicio = row.fecha_inicio_estado instanceof Date
    ? row.fecha_inicio_estado
    : new Date(row.fecha_inicio_estado);
  return {
    registro_id: row.disponibilidad_id,
    bitacora_id: bitacoraId,
    planta_id: row.planta_id,
    fecha_evento: row.fecha_inicio_estado,
    turno: null,
    detalle: row.detalle,
    campos_extra: JSON.stringify({
      evento: row.estado,
      codigo: row.codigo,
      fecha_inicio_estado: fechaInicio.toISOString(),
    }),
    tipo_evento_id: null,
    estado: 'borrador',
    ingenieros_snapshot: row.ingenieros_snapshot,
    jdts_snapshot: row.jdts_snapshot,
    // El frontend lee 'jefes_snapshot'; en la tabla nueva la columna es 'jefes_planta_snapshot'.
    jefes_snapshot: row.jefes_planta_snapshot,
    creado_por: row.creado_por,
    creado_en: row.creado_en,
    modificado_por: row.modificado_por,
    modificado_en: row.modificado_en,
    fecha_fin_estado: row.fecha_fin_estado,
  };
}

// AUD-34/35: el rate limiter (aplicarRateLimit + estado _rateLimitMap + clientIp) se movió a
// routes/_shared.js para compartirlo con los routers de dominio. El if-chain lo importa de allí.

// El cuerpo del router nativo (if-chain). Antes era el callback de http.createServer; ahora es
// una función a la que el wrapper Express (auth/app.js) delega todo lo que no sea ruta de auth.
// express-session ya pobló req.session antes de llegar acá, así que loadSession() puede leer la
// cookie Entra. parseBody() sigue leyendo el stream crudo porque express.json() NO es global.
async function legacyHandler(req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // AUD-34/35: el preflight OPTIONS (CORS) y el check CSRF de mutadores (AUD-16/AUD-19) ahora los
  // aplica middleware Express global (corsMiddleware/csrfMiddleware en routes/_middleware.js), antes
  // de delegar acá. Este handler ya recibe solo requests no-OPTIONS con Origin validado.

  try {
    if (method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    }

    // Login Entra ID: /api/auth/login (password local) y /api/auth/logout (por sesion_id)
    // fueron ELIMINADOS. La autenticación la maneja el wrapper Express (auth/app.js):
    //   GET  /auth/login → Microsoft (OIDC) ; GET /auth/redirect → callback + auto-provisión
    //   GET  /api/me     → identidad + sesión de app vigente
    //   POST /api/logout → cierra sesión de app + cookie + front-channel logout
    // Acá solo queda la creación de la SESIÓN DE APP (sesion_activa) tras elegir planta.

    // POST /api/auth/select-context { planta_id }
    // Deriva usuario_id de la cookie Entra (req.session.user) y cargo_id de los App Roles del
    // token por precedencia. NO recibe usuario_id ni cargo_id del cliente (no son confiables).
    if (pathname === '/api/auth/select-context' && method === 'POST') {
      // AUD-20: endpoint sensible (crea sesión de app). Límite generoso para no estorbar uso normal.
      if (!aplicarRateLimit(req, res, 'select-context', { max: 60, windowMs: 60_000 })) return;
      const sUser = req.session?.user;
      if (!sUser?.oid || !sUser?.usuario_id) {
        return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
      }
      const { planta_id } = await parseBody(req);
      if (!planta_id) {
        return sendJSON(res, 400, { error: 'planta_id es requerido' });
      }

      // Cargo automático desde los roles del token (precedencia). Sin rol conocido → 403.
      const elegido = resolveCargo(sUser.roles);
      if (!elegido) {
        // `error` debe ser texto amigable (los flujos genéricos lo muestran como Error.message);
        // el slug estable va en `codigo`. `detail`/`roles` quedan para diagnóstico (no se muestran).
        return sendJSON(res, 403, {
          error: 'Tu cuenta aún no tiene un rol de bitácoras asignado. Pide al administrador que te asigne uno para poder ingresar.',
          codigo: 'sin_cargo_asignado',
          detail: 'Tu cuenta no tiene un App Role de bitácoras asignado en Entra.',
          roles: sUser.roles || [],
        });
      }

      const db = await getDB();
      const valid = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('cargo_nombre', sql.VarChar(100), elegido.cargoNombre)
        .query(`
          SELECT
            (SELECT COUNT(*) FROM lov_bit.planta WHERE planta_id = @planta_id AND activa = 1) AS planta_ok,
            (SELECT cargo_id FROM lov_bit.cargo WHERE nombre = @cargo_nombre) AS cargo_id
        `);
      if (!valid.recordset[0].planta_ok) {
        return sendJSON(res, 400, { error: 'planta_id inválido' });
      }
      const cargo_id = valid.recordset[0].cargo_id;
      if (!cargo_id) {
        // El App Role existe en el mapa pero el cargo no está sembrado: configuración inconsistente.
        // No filtramos el nombre de tabla/cargo al cliente; el detalle va al log.
        console.error(`[ERROR] config: cargo '${elegido.cargoNombre}' no existe en lov_bit.cargo`);
        return sendJSON(res, 500, {
          error: 'Hay un problema de configuración del sistema. Contacta a soporte.',
          codigo: 'config_sistema',
        });
      }

      const turno = getTurnoColombia();
      // Dedupe por (usuario_id, planta_id, cargo_id). A diferencia del modelo viejo, la sesión de
      // app es POR TURNO: al reactivar (el usuario volvió tras ser expulsado a fin de turno)
      // REFRESCAMOS inicio_sesion y turno, para que la conformación del turno nuevo lo incluya y
      // loadSession devuelva el turno vigente (no el viejo). UPDLOCK+HOLDLOCK serializa pestañas.
      const transaction = new sql.Transaction(db);
      await transaction.begin();
      let result;
      try {
        result = await new sql.Request(transaction)
          .input('usuario_id', sql.Int, sUser.usuario_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .input('cargo_id', sql.Int, cargo_id)
          .input('turno', sql.TinyInt, turno)
          .query(`
            -- D-035 (fix: sesión única por persona): al entrar a una unidad, desactivar cualquier
            -- OTRA sesión de app activa de este usuario (otra planta/cargo). Garantiza que una
            -- misma persona NO quede con la sesión iniciada en 2 unidades al tiempo.
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
                 SET activa           = 1,
                     cerrada_en       = NULL,
                     inicio_sesion    = SYSUTCDATETIME(),
                     turno            = @turno,
                     ultima_actividad = SYSUTCDATETIME()
               WHERE sesion_id = @sesion_id;
            END
            ELSE
            BEGIN
              INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
              VALUES (@usuario_id, @planta_id, @cargo_id, @turno);
              SET @sesion_id = SCOPE_IDENTITY();
            END

            SELECT s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
                   s.inicio_sesion, s.ultima_actividad,
                   u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
                   c.nombre AS cargo_nombre, c.solo_lectura,
                   CAST(c.puede_cerrar_turno AS BIT) AS puede_cerrar_turno
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
      broadcastUsuariosActivos().catch(() => {});
      return sendJSON(res, 200, { sesion: result.recordset[0] });
    }

    // POST /api/auth/cerrar-app
    // Cierra (activa=0) TODAS las sesiones de app del usuario Entra actual SIN tocar la cookie
    // Entra ni hacer logout. Lo usa "Operar otra unidad" (D-035): mata la sesión activa para que
    // una misma persona no quede iniciada en 2 unidades. Identidad por cookie (req.session.user),
    // no por X-Sesion-Id. Idempotente (si no hay sesión activa, no hace nada).
    if (pathname === '/api/auth/cerrar-app' && method === 'POST') {
      const sUser = req.session?.user;
      if (!sUser?.usuario_id) return sendJSON(res, 401, { error: 'No autenticado con Microsoft' });
      const db = await getDB();
      await db.request()
        .input('usuario_id', sql.Int, sUser.usuario_id)
        .query(`
          UPDATE bitacora.sesion_activa
             SET activa = 0, cerrada_en = SYSUTCDATETIME()
           WHERE usuario_id = @usuario_id AND activa = 1;
        `);
      broadcastUsuariosActivos().catch(() => {});
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/auth/usuarios-activos  (todas las plantas, requiere sesion)
    // F2: sin filtro TTL — refleja sesion_activa.activa=1 hasta logout o cierre por sweeper de F4.
    if (pathname === '/api/auth/usuarios-activos' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });

      const db = await getDB();
      const result = await db.request().query(`
        SELECT
          s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno,
          s.inicio_sesion, s.ultima_actividad,
          u.nombre_completo,
          c.nombre AS cargo_nombre,
          p.nombre AS planta_nombre
        FROM bitacora.sesion_activa s
        INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
        INNER JOIN lov_bit.cargo   c ON c.cargo_id   = s.cargo_id
        INNER JOIN lov_bit.planta  p ON p.planta_id  = s.planta_id
        WHERE s.activa = 1
        ORDER BY p.planta_id, s.inicio_sesion DESC
      `);
      return sendJSON(res, 200, { usuarios: result.recordset });
    }

    // F2: POST /api/bitacora/abrir { bitacora_id }
    // Idempotente: UPSERT en sesion_bitacora con finalizada_en=NULL. Reabrir tras finalizar
    // resetea finalizada_en=NULL y refresca abierta_en (es la entrada al turno nuevo).
    if (pathname === '/api/bitacora/abrir' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const { bitacora_id } = await parseBody(req);
      if (!bitacora_id) return sendJSON(res, 400, { error: 'bitacora_id es requerido' });
      const db = await getDB();
      // AUD-24: antes el MERGE aceptaba cualquier bitacora_id del body sin validar. Verificamos
      // que la bitácora exista (activa) y que el cargo de la sesión tenga `puede_ver` sobre ella
      // antes de tocar sesion_bitacora.
      const existe = await db.request()
        .input('bitacora_id', sql.Int, bitacora_id)
        .query(`SELECT 1 AS ok FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id AND activa = 1`);
      if (!existe.recordset[0]) {
        return sendJSON(res, 404, { error: 'Bitácora no encontrada' });
      }
      if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_ver'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para abrir esta bitácora' });
      }
      const result = await db.request()
        .input('sesion_id', sql.Int, sesion.sesion_id)
        .input('bitacora_id', sql.Int, bitacora_id)
        .query(`
          MERGE bitacora.sesion_bitacora AS t
          USING (VALUES (@sesion_id, @bitacora_id)) AS s(sesion_id, bitacora_id)
            ON t.sesion_id = s.sesion_id AND t.bitacora_id = s.bitacora_id
          WHEN MATCHED THEN UPDATE SET finalizada_en = NULL, abierta_en = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (sesion_id, bitacora_id) VALUES (s.sesion_id, s.bitacora_id);

          SELECT sesion_bitacora_id, sesion_id, bitacora_id, abierta_en, finalizada_en
          FROM bitacora.sesion_bitacora
          WHERE sesion_id = @sesion_id AND bitacora_id = @bitacora_id;
        `);
      return sendJSON(res, 200, { sesion_bitacora: result.recordset[0] });
    }

    // F2: POST /api/bitacora/finalizar
    // Finaliza TODAS las sesion_bitacora del usuario logueado (no solo del login actual: si el
    // usuario tiene varios logins activos —preguntas2.md respuesta sobre logins múltiples— se
    // finalizan todas sus participaciones abiertas).
    // F3: dispara UN solo evento CIET 'finalizacion' por usuario que finaliza, dentro de la
    // misma transacción del UPDATE — atómico.
    if (pathname === '/api/bitacora/finalizar' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const pool = await getDB();
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const result = await new sql.Request(transaction)
          .input('usuario_id', sql.Int, sesion.usuario_id)
          .query(`
            DECLARE @afectadas TABLE (sesion_bitacora_id INT, sesion_id INT, bitacora_id INT);

            UPDATE sb SET finalizada_en = SYSUTCDATETIME()
            OUTPUT inserted.sesion_bitacora_id, inserted.sesion_id, inserted.bitacora_id INTO @afectadas
            FROM bitacora.sesion_bitacora sb
            INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
            WHERE sa.usuario_id = @usuario_id AND sb.finalizada_en IS NULL;

            SELECT a.sesion_bitacora_id, a.sesion_id, a.bitacora_id,
                   b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo
            FROM @afectadas a
            INNER JOIN lov_bit.bitacora b ON b.bitacora_id = a.bitacora_id;
          `);

        let evento_ciet = null;
        if (result.recordset.length > 0) {
          evento_ciet = await registrarEventoCierre(transaction, {
            tipo: 'finalizacion',
            sesion,
            forzado: false,
          });
        }

        await transaction.commit();
        return sendJSON(res, 200, { finalizadas: result.recordset, evento_ciet });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // F4: POST /api/bitacora/finalizar-forzado { usuarios: [usuario_id, ...] }
    // Solo cargos con puede_cerrar_turno=1 pueden invocarlo. Por cada usuario en la lista:
    //   - UPDATE sus sesion_bitacora con finalizada_en = SYSUTCDATETIME().
    //   - Emite CIET 'finalizacion' con forzado=true, motivo='popup-pendientes'.
    // El "sesion" que se pasa al helper es sintética: usuario_id/turno/cargo_nombre del target,
    // planta_id del JdT que invoca (asumimos misma planta).
    if (pathname === '/api/bitacora/finalizar-forzado' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) {
        return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden forzar finalización' });
      }
      const { usuarios } = await parseBody(req);
      if (!Array.isArray(usuarios) || usuarios.length === 0) {
        return sendJSON(res, 400, { error: 'usuarios debe ser un array no vacío de usuario_id' });
      }
      const ids = usuarios.map((u) => parseInt(u, 10)).filter((n) => Number.isInteger(n));
      if (ids.length === 0) return sendJSON(res, 400, { error: 'usuarios contiene IDs inválidos' });

      const pool = await getDB();
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const finalizados = [];
        for (const usuario_id of ids) {
          // Lookup de la sesión más reciente del target en esta planta para obtener turno+cargo.
          const userSesRes = await new sql.Request(transaction)
            .input('usuario_id', sql.Int, usuario_id)
            .input('planta_id', sql.VarChar(10), sesion.planta_id)
            .query(`
              SELECT TOP 1 sa.usuario_id, sa.planta_id, sa.turno, c.nombre AS cargo_nombre
              FROM bitacora.sesion_activa sa
              INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
              WHERE sa.usuario_id = @usuario_id AND sa.planta_id = @planta_id AND sa.activa = 1
              ORDER BY sa.inicio_sesion DESC
            `);
          const targetSesion = userSesRes.recordset[0];
          if (!targetSesion) continue;

          const upd = await new sql.Request(transaction)
            .input('usuario_id', sql.Int, usuario_id)
            .input('planta_id', sql.VarChar(10), sesion.planta_id)
            .query(`
              UPDATE sb SET finalizada_en = SYSUTCDATETIME()
              FROM bitacora.sesion_bitacora sb
              INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
              WHERE sa.usuario_id = @usuario_id AND sa.planta_id = @planta_id
                AND sb.finalizada_en IS NULL;
            `);

          if ((upd.rowsAffected[0] || 0) > 0) {
            const ciet = await registrarEventoCierre(transaction, {
              tipo: 'finalizacion',
              sesion: targetSesion,
              forzado: true,
              motivo: 'popup-pendientes',
            });
            finalizados.push({ usuario_id, ciet_registro_id: ciet.registro_id });
          }
        }
        await transaction.commit();
        return sendJSON(res, 200, { finalizados });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // F2: GET /api/bitacora/usuarios-en-bitacora?planta_id=&bitacora_id=
    // Lista ingenieros con sesion_bitacora.finalizada_en IS NULL para esa (planta, bitácora).
    // Lo consume F4 para el popup "ingenieros pendientes" antes de cierre masivo.
    if (pathname === '/api/bitacora/usuarios-en-bitacora' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      const bitacora_id = url.searchParams.get('bitacora_id');
      if (!planta_id || !bitacora_id) {
        return sendJSON(res, 400, { error: 'planta_id y bitacora_id son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('bitacora_id', sql.Int, parseInt(bitacora_id, 10))
        .query(`
          SELECT DISTINCT
            sb.sesion_bitacora_id, sb.sesion_id, sb.abierta_en,
            sa.usuario_id, sa.cargo_id, sa.turno,
            u.nombre_completo,
            c.nombre AS cargo_nombre
          FROM bitacora.sesion_bitacora sb
          INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
          INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
          INNER JOIN lov_bit.cargo c ON c.cargo_id = sa.cargo_id
          WHERE sb.bitacora_id = @bitacora_id
            AND sa.planta_id = @planta_id
            AND sa.activa = 1
            AND sb.finalizada_en IS NULL
          ORDER BY u.nombre_completo
        `);
      return sendJSON(res, 200, { usuarios: result.recordset });
    }

    // AUD-34/35 E2: los 7 GET de /api/catalogos migraron a routes/catalogos.js (router Express
    // montado en auth/app.js antes del catch-all). Ya no viven en el if-chain.

    // GET /api/registros/activos?planta_id=&bitacora_id=
    if (pathname === '/api/registros/activos' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      const bitacora_id = url.searchParams.get('bitacora_id');
      const estado = url.searchParams.get('estado');
      const db = await getDB();
      const reqQ = db.request();
      // F10: defensa-en-profundidad — los registros de bitácoras ocultas (CIET) no llegan
      // al frontend aunque alguien pase su bitacora_id directo.
      let where = ['b.oculta = 0'];
      if (planta_id) { reqQ.input('planta_id', sql.VarChar(10), planta_id); where.push('r.planta_id = @planta_id'); }
      if (bitacora_id) { reqQ.input('bitacora_id', sql.Int, parseInt(bitacora_id, 10)); where.push('r.bitacora_id = @bitacora_id'); }
      if (estado) { reqQ.input('estado', sql.VarChar(20), estado); where.push('r.estado = @estado'); }
      const result = await reqQ.query(`
        SELECT r.*,
               b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
               te.nombre AS tipo_evento_nombre,
               autor.nombre_completo AS creado_por_nombre,
               r.creado_por AS creado_por_id
        FROM bitacora.registro_activo r
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
        INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
        LEFT JOIN lov_bit.usuario autor ON autor.usuario_id = r.creado_por
        WHERE ${where.join(' AND ')}
        ORDER BY r.fecha_evento ASC
      `);
      return sendJSON(res, 200, { registros: result.recordset });
    }

    // GET /api/bitacora/counts?planta_id=GEC3  (snapshot inicial de registros abiertos por bitácora)
    if (pathname === '/api/bitacora/counts' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
      }
      const db = await getDB();
      // F10: excluir bitácoras ocultas (CIET) del conteo — los tabs no las muestran y el
      // contador no debe inflarse con sus borradores.
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT r.bitacora_id, COUNT(*) AS total
          FROM bitacora.registro_activo r
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
          WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
            AND b.oculta = 0
          GROUP BY r.bitacora_id
        `);
      const counts = {};
      for (const row of result.recordset) counts[row.bitacora_id] = row.total;
      return sendJSON(res, 200, { counts });
    }

    // POST /api/registros
    if (pathname === '/api/registros' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const body = await parseBody(req);
      const { bitacora_id, planta_id, fecha_evento, turno: turnoBody, detalle, campos_extra, tipo_evento_id } = body;
      if (!bitacora_id || !planta_id) {
        return sendJSON(res, 400, { error: 'Campos requeridos faltantes (bitacora_id, planta_id)' });
      }
      const db = await getDB();

      // F12: peek temprano a la bitácora — la rama DISP omite plantaMatch (multi-planta),
      // no exige tipo_evento_id ni turno del body, y tiene su propio flujo transaccional
      // de cierre del vigente + UPSERT en disponibilidad_dashboard.
      const codigoPeek = await db.request()
        .input('bid', sql.Int, bitacora_id)
        .query(`SELECT codigo FROM lov_bit.bitacora WHERE bitacora_id = @bid`);
      const bitacoraCodigo = codigoPeek.recordset[0]?.codigo;
      if (!bitacoraCodigo) {
        return sendJSON(res, 400, { error: 'bitácora no encontrada' });
      }

      if (bitacoraCodigo === 'DISP') {
        // D-026: DISP migró a `bitacora.disponibilidad_estado` (tabla ER nativa). Mismo
        // shape de request/response que antes, pero el storage es la tabla dedicada.
        if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
          return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
        }
        // AUD-11: IDOR cross-planta. D-035 fija que una persona opera UNA sola unidad, así que
        // un operador con sesión en GEC3 no puede crear disponibilidad de GEC32. La rama DISP
        // antes omitía plantaMatch (de ahí el comentario de F12 arriba); ahora lo exige.
        if (!plantaMatch(sesion, planta_id)) {
          return sendJSON(res, 403, { error: 'No autorizado para esta planta' });
        }
        const plantaCheck = await db.request()
          .input('p', sql.VarChar(10), planta_id)
          .query(`SELECT 1 AS ok FROM lov_bit.planta WHERE planta_id=@p AND activa=1`);
        if (!plantaCheck.recordset[0]) {
          return sendJSON(res, 400, { error: 'planta_id no es operativa' });
        }

        const extra = parseExtra(campos_extra);
        if (extra === null) {
          return sendJSON(res, 400, { error: 'campos_extra inválido (no es JSON)' });
        }
        const evento = extra?.evento;
        const fechaInicioRaw = extra?.fecha_inicio_estado ?? fecha_evento;
        if (!DISP_EVENTOS_VALIDOS.includes(evento)) {
          return sendJSON(res, 400, {
            error: `evento debe ser uno de: ${DISP_EVENTOS_VALIDOS.join(', ')}`,
          });
        }
        if (!fechaInicioRaw) {
          return sendJSON(res, 400, { error: 'fecha_inicio_estado es requerido' });
        }
        const fechaInicio = new Date(fechaInicioRaw);
        if (Number.isNaN(fechaInicio.getTime())) {
          return sendJSON(res, 400, { error: 'fecha_inicio_estado inválido' });
        }
        if (fechaInicio.getTime() > Date.now()) {
          return sendJSON(res, 422, { error: 'fecha_inicio_estado no puede ser futuro' });
        }
        const codigoVal = DISP_CODIGO_POR_EVENTO[evento];

        const transaction = new sql.Transaction(db);
        await transaction.begin();
        try {
          // UPDLOCK+HOLDLOCK (dentro de findVigente) serializa POSTs concurrentes a la misma
          // planta. UQ_disp_estado_vigente_por_planta es la segunda barrera defensiva.
          const vigente = await findVigente(transaction, { planta_id });
          let vigenteAnteriorMovidoId = null;

          if (vigente) {
            const vigFechaInicio = vigente.fecha_inicio_estado instanceof Date
              ? vigente.fecha_inicio_estado
              : new Date(vigente.fecha_inicio_estado);

            if (evento === vigente.estado) {
              await transaction.rollback();
              return sendJSON(res, 409, {
                error: 'mismo_estado',
                mensaje: `${planta_id} ya está en estado ${vigente.estado}`,
                vigente: {
                  registro_id: vigente.disponibilidad_id,
                  evento: vigente.estado,
                  fecha_inicio_estado: vigFechaInicio.toISOString(),
                },
              });
            }
            if (fechaInicio.getTime() <= vigFechaInicio.getTime()) {
              await transaction.rollback();
              return sendJSON(res, 409, {
                error: 'fecha_anterior_a_vigente',
                mensaje: `La fecha es anterior o igual al inicio del estado vigente`,
                vigente: {
                  registro_id: vigente.disponibilidad_id,
                  evento: vigente.estado,
                  fecha_inicio_estado: vigFechaInicio.toISOString(),
                },
              });
            }

            await cerrarVigente(transaction, {
              disponibilidad_id: vigente.disponibilidad_id,
              fecha_fin: fechaInicio,
            });
            vigenteAnteriorMovidoId = vigente.disponibilidad_id;
          }

          const reqFactory = () => new sql.Request(transaction);
          const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
          const jefes_planta_snapshot = await snapshotJefes(reqFactory);
          const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
          const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });

          const row = await insertNuevoEstado(transaction, {
            planta_id,
            estado: evento,
            codigo: codigoVal,
            fecha_inicio_estado: fechaInicio,
            detalle: detalle ?? null,
            jdts_snapshot,
            jefes_planta_snapshot,
            gerentes_produccion_snapshot,
            ingenieros_snapshot,
            creado_por: sesion.usuario_id,
          });

          await transaction.commit();
          broadcastConteoBitacoras(planta_id).catch(() => {});

          const registro = mapDispRowToLegacyShape(row, bitacora_id);
          return sendJSON(res, 201, { registro, vigente_anterior_movido_id: vigenteAnteriorMovidoId });
        } catch (err) {
          try { await transaction.rollback(); } catch {}
          throw err;
        }
      }

      // Resto: rama genérica (no-DISP)
      if (!fecha_evento || !tipo_evento_id) {
        return sendJSON(res, 400, { error: 'Campos requeridos faltantes (fecha_evento, tipo_evento_id)' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede crear registros en otra planta' });
      }
      if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
      }
      const creado_por = sesion.usuario_id;

      // F6: lookup expandido — trae código de bitácora, nombre del tipo y notificar_dashboard_tipo
      // (columna nueva en F6 que parametriza el upsert sobre evento_dashboard).
      const teCheck = await db.request()
        .input('te', sql.Int, tipo_evento_id)
        .input('b', sql.Int, bitacora_id)
        .query(`
          SELECT te.tipo_evento_id, te.nombre AS tipo_evento_nombre,
                 te.notificar_dashboard_tipo,
                 bb.codigo AS bitacora_codigo
          FROM lov_bit.tipo_evento te
          INNER JOIN lov_bit.bitacora bb ON bb.bitacora_id = te.bitacora_id
          WHERE te.tipo_evento_id = @te AND te.bitacora_id = @b
        `);
      if (teCheck.recordset.length === 0) {
        return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
      }
      const teRow = teCheck.recordset[0];
      const isMAND = teRow.bitacora_codigo === 'MAND';

      // F6: check de fecha futura. Para MAND aceptamos cualquier hora del día actual (la
      // grilla pre-carga periodos posteriores a la hora actual, e.g. P17=16:00 a las 14:00).
      // Para el resto de bitácoras se mantiene el guard de 5 minutos.
      if (!isMAND && new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
        return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
      }

      const bitRes = await db.request()
        .input('bitacora_id', sql.Int, bitacora_id)
        .query(`SELECT codigo, definicion_campos FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id`);
      const bit = bitRes.recordset[0];
      if (!bit) return sendJSON(res, 400, { error: 'bitácora no encontrada' });

      const validation = validateCamposExtra(bit.definicion_campos, campos_extra);
      if (!validation.ok) {
        return sendJSON(res, 400, { error: 'campos_extra inválido', detalles: validation.errors });
      }
      const camposFinal = validation.definicion ? computeCamposAuto(validation.definicion, validation.data) : validation.data;
      // F6: solo AUTH legacy auto-rellena periodo desde fecha. MAND trae periodo del usuario
      // (la celda elegida en la grilla).
      if (camposFinal && hasNotificarDashboard(bit.definicion_campos) && !isMAND && camposFinal.periodo == null) {
        camposFinal.periodo = periodoFromFechaBogota(fecha_evento);
      }
      const camposStr = camposFinal ? JSON.stringify(camposFinal) : null;

      // F6: turno se autoselecciona desde periodo en MAND; para no-MAND viene del body. Esta
      // autoselección NO se reactualiza al editar (preguntas3.md respuesta D) — se aplica
      // solo en POST.
      let turno = turnoBody;
      if (isMAND) {
        const periodo = camposFinal?.periodo;
        if (!periodo) return sendJSON(res, 400, { error: 'periodo es requerido para MAND' });
        turno = turnoFromPeriodo(parseInt(periodo, 10));
      }
      if (!turno) {
        return sendJSON(res, 400, { error: 'turno es requerido' });
      }

      // F6: validación funcionariocnd para MAND/Autorización (preguntas.md punto 3).
      if (isMAND && teRow.tipo_evento_nombre === 'Autorización') {
        const fcnd = camposFinal?.funcionariocnd;
        if (!fcnd || String(fcnd).trim() === '') {
          return sendJSON(res, 400, { error: 'funcionariocnd es requerido para Autorización' });
        }
      }

      // F6: el flag de notificación pasó de definicion_campos a tipo_evento.notificar_dashboard_tipo.
      // El path legacy (hasNotificarDashboard sobre AUTH) sigue activo como fallback porque
      // AUTH original tiene `activa=0` pero la helper sigue siendo invocada por consistencia.
      const dashboardTipo = teRow.notificar_dashboard_tipo
        || (hasNotificarDashboard(bit.definicion_campos) ? 'AUTH' : null);
      const notificar = dashboardTipo != null;
      const fechaEventoDate = new Date(fecha_evento);

      const transaction = new sql.Transaction(db);
      await transaction.begin();
      try {
        const reqFactory = () => new sql.Request(transaction);
        const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
        const jefes_snapshot = await snapshotJefes(reqFactory);
        const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });
        if (jefes_snapshot === '[]') {
          await transaction.rollback();
          return sendJSON(res, 409, { error: 'No hay un Jefe de Planta activo en el sistema. No se puede registrar hasta que se asigne uno.', codigo: 'sin_jefe_planta' });
        }

        if (notificar && camposFinal) {
          const periodo = camposFinal.periodo;
          // F6: MAND usa valor_mw, AUTH legacy usa valor_autorizado_mw.
          const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
          if (periodo && valor != null) {
            const existente = await findEventoDashboard(transaction, {
              planta_id, fecha: fechaEventoDate, periodo, tipo: dashboardTipo,
            });
            if (existente && existente.activa) {
              await transaction.rollback();
              return sendJSON(res, 409, {
                error: `Ya existe ${dashboardTipo} vigente para este periodo`,
                evento_id: existente.evento_id,
              });
            }
          }
        }

        const ins = await new sql.Request(transaction)
          .input('bitacora_id', sql.Int, bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .input('fecha_evento', sql.DateTime2, fechaEventoDate)
          .input('turno', sql.TinyInt, turno)
          .input('detalle', sql.NVarChar(sql.MAX), detalle)
          .input('campos_extra', sql.NVarChar(sql.MAX), camposStr)
          .input('tipo_evento_id', sql.Int, tipo_evento_id)
          .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot)
          .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
          .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
          .input('creado_por', sql.Int, creado_por)
          .query(`
            INSERT INTO bitacora.registro_activo
              (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
            OUTPUT INSERTED.*
            VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @campos_extra, @tipo_evento_id,
                    'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por)
          `);
        const registro = ins.recordset[0];

        if (notificar && camposFinal) {
          const periodo = camposFinal.periodo;
          const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
          if (periodo && valor != null) {
            await upsertEventoDashboard(transaction, {
              planta_id,
              fecha: fechaEventoDate,
              periodo,
              valor,
              jdts_snapshot,
              jefes_snapshot,
              registro_origen_id: registro.registro_id,
              tipo: dashboardTipo,
            });
          }
        }

        await transaction.commit();
        broadcastConteoBitacoras(planta_id).catch(() => {});
        return sendJSON(res, 201, { registro });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // PUT /api/registros/:id
    const putMatch = pathname.match(/^\/api\/registros\/(\d+)$/);
    if (putMatch && method === 'PUT') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const registro_id = parseInt(putMatch[1], 10);
      const body = await parseBody(req);
      const { detalle, turno, fecha_evento, campos_extra, tipo_evento_id } = body;

      const db = await getDB();

      // D-026: DISP migró a `bitacora.disponibilidad_estado`. El frontend sigue mandando
      // PUT /api/registros/:id sin distinguir, así que peek primero contra la tabla nueva.
      // Si match → rama DISP (return). Si no → fallback al lookup en registro_activo.
      const dispPeek = await db.request()
        .input('id', sql.Int, registro_id)
        .query(`
          SELECT disponibilidad_id, planta_id, estado, codigo,
                 fecha_inicio_estado, fecha_fin_estado, detalle,
                 jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
                 creado_por, creado_en, modificado_por, modificado_en
          FROM bitacora.disponibilidad_estado
          WHERE disponibilidad_id = @id
        `);

      if (dispPeek.recordset[0]) {
        const reg = dispPeek.recordset[0];
        const dispBid = await getDispBitacoraId(db);

        // Solo se puede editar el vigente (fecha_fin_estado IS NULL); los cerrados son
        // inmutables como en el resto de bitácoras (DISP era la excepción D-011 para fecha
        // del N-1, no para edición del cerrado).
        if (reg.fecha_fin_estado !== null) {
          return sendJSON(res, 422, { error: 'Solo se puede editar el registro vigente de DISP' });
        }
        if (!(await hasPermisoBitacora(sesion, dispBid, 'puede_crear'))) {
          return sendJSON(res, 403, { error: 'Sin permiso para editar registros de Disponibilidad' });
        }
        // AUD-11: IDOR cross-planta. La planta del registro vigente debe coincidir con la
        // sesión (D-035: una persona = una unidad). Sin esto, un operador de GEC3 podría
        // editar la disponibilidad de GEC32 conociendo su disponibilidad_id.
        if (!plantaMatch(sesion, reg.planta_id)) {
          return sendJSON(res, 403, { error: 'No autorizado para esta planta' });
        }
        const { planta_id: bodyPlanta } = body;
        if (bodyPlanta != null && bodyPlanta !== reg.planta_id) {
          return sendJSON(res, 422, { error: 'planta_id no editable en DISP' });
        }

        const extraIn = parseExtra(campos_extra);
        if (extraIn === null) {
          return sendJSON(res, 400, { error: 'campos_extra inválido (no es JSON)' });
        }
        const eventoActual = reg.estado;
        const fechaInicioActual = reg.fecha_inicio_estado instanceof Date
          ? reg.fecha_inicio_estado
          : new Date(reg.fecha_inicio_estado);

        // Aplicar overrides solo cuando vienen explícitos en campos_extra o fecha_evento.
        const eventoNuevo = (extraIn && 'evento' in extraIn) ? extraIn.evento : eventoActual;
        // Compat con pre-D-026: el UPDATE viejo usaba COALESCE(@detalle, detalle) → preserva
        // el detalle previo cuando el body no lo manda. `actualizarVigente` (notificador.js)
        // hace `detalle=@detalle` directo (sin COALESCE), así que la preservación se hace acá
        // en el JS: si body.detalle es null/undefined, mantenemos el de la fila vigente.
        const detalleNuevo = (detalle != null) ? detalle : reg.detalle;
        const fechaInicioNuevoRaw =
          (extraIn && 'fecha_inicio_estado' in extraIn) ? extraIn.fecha_inicio_estado
          : (fecha_evento ?? null);
        const fechaInicioNueva = fechaInicioNuevoRaw ? new Date(fechaInicioNuevoRaw) : fechaInicioActual;

        if (!DISP_EVENTOS_VALIDOS.includes(eventoNuevo)) {
          return sendJSON(res, 400, {
            error: `evento debe ser uno de: ${DISP_EVENTOS_VALIDOS.join(', ')}`,
          });
        }
        if (Number.isNaN(fechaInicioNueva.getTime())) {
          return sendJSON(res, 400, { error: 'fecha_inicio_estado inválido' });
        }
        if (fechaInicioNueva.getTime() > Date.now()) {
          return sendJSON(res, 422, { error: 'fecha_inicio_estado no puede ser futuro' });
        }
        const codigoVal = DISP_CODIGO_POR_EVENTO[eventoNuevo];

        const transaction = new sql.Transaction(db);
        await transaction.begin();
        try {
          const eventoCambia = eventoNuevo !== eventoActual;
          const fechaCambia = fechaInicioNueva.getTime() !== fechaInicioActual.getTime();

          // N-1 = último cerrado de esta planta. Sirve para validar que el nuevo evento no
          // repita el anterior y para el side-effect D-011 sobre N-1.fecha_fin_estado.
          let nMinus1 = null;
          if (eventoCambia || fechaCambia) {
            nMinus1 = await findUltimoCerrado(transaction, { planta_id: reg.planta_id });
          }

          if (eventoCambia && nMinus1 && eventoNuevo === nMinus1.estado) {
            await transaction.rollback();
            return sendJSON(res, 409, {
              error: 'mismo_estado_que_anterior',
              mensaje: `El estado anterior ya era ${nMinus1.estado}; no se permite la secuencia ${nMinus1.estado} → ${eventoNuevo}`,
              n_menos_1: { registro_id: nMinus1.disponibilidad_id, evento: nMinus1.estado },
            });
          }
          if (fechaCambia && nMinus1) {
            const nMinus1FechaInicio = nMinus1.fecha_inicio_estado instanceof Date
              ? nMinus1.fecha_inicio_estado
              : new Date(nMinus1.fecha_inicio_estado);
            if (fechaInicioNueva.getTime() < nMinus1FechaInicio.getTime()) {
              await transaction.rollback();
              return sendJSON(res, 409, {
                error: 'fecha_anterior_a_n_menos_1',
                mensaje: 'La nueva fecha es anterior al inicio del estado previo',
                n_menos_1: {
                  registro_id: nMinus1.disponibilidad_id,
                  fecha_inicio_estado: nMinus1FechaInicio.toISOString(),
                },
              });
            }
            // D-011: mantener cronología sin gap — el N-1 cierra exactamente cuando arranca el vigente.
            await cerrarVigente(transaction, {
              disponibilidad_id: nMinus1.disponibilidad_id,
              fecha_fin: fechaInicioNueva,
            });
          }

          // Snapshots vigentes del momento de edición (no preservamos los del POST original).
          const reqFactory = () => new sql.Request(transaction);
          const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: reg.planta_id });
          const jefes_planta_snapshot = await snapshotJefes(reqFactory);
          const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
          const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id: reg.planta_id });

          await actualizarVigente(transaction, {
            disponibilidad_id: reg.disponibilidad_id,
            estado: eventoNuevo,
            codigo: codigoVal,
            fecha_inicio_estado: fechaInicioNueva,
            detalle: detalleNuevo,
            jdts_snapshot,
            jefes_planta_snapshot,
            gerentes_produccion_snapshot,
            ingenieros_snapshot,
            modificado_por: sesion.usuario_id,
          });

          // Re-fetch dentro de la transacción para devolver el row actualizado con los
          // valores definitivos (modificado_en lo seteó SYSUTCDATETIME en el UPDATE).
          const after = await new sql.Request(transaction)
            .input('id', sql.Int, reg.disponibilidad_id)
            .query(`
              SELECT disponibilidad_id, planta_id, estado, codigo,
                     fecha_inicio_estado, fecha_fin_estado, detalle,
                     jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
                     creado_por, creado_en, modificado_por, modificado_en
              FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id
            `);
          const actualizado = after.recordset[0];

          await transaction.commit();
          return sendJSON(res, 200, { registro: mapDispRowToLegacyShape(actualizado, dispBid) });
        } catch (err) {
          try { await transaction.rollback(); } catch {}
          throw err;
        }
      }

      // No-DISP: lookup tradicional en registro_activo.
      const check = await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`
          SELECT ra.registro_id, ra.estado, ra.bitacora_id, ra.planta_id, ra.creado_por,
                 ra.fecha_evento, ra.fecha_fin_estado, ra.campos_extra, b.codigo AS bitacora_codigo
          FROM bitacora.registro_activo ra
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
          WHERE ra.registro_id = @registro_id
        `);
      if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
      const reg = check.recordset[0];


      if (reg.estado !== 'borrador') {
        return sendJSON(res, 409, { error: 'Solo se pueden editar registros en borrador' });
      }
      if (!(await canEditarRegistro(sesion, reg))) {
        return sendJSON(res, 403, { error: 'Sin permiso para editar este registro' });
      }
      if (fecha_evento && new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
        return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
      }
      if (tipo_evento_id) {
        const teCheck = await db.request()
          .input('te', sql.Int, tipo_evento_id)
          .input('b', sql.Int, reg.bitacora_id)
          .query(`SELECT 1 AS ok FROM lov_bit.tipo_evento WHERE tipo_evento_id = @te AND bitacora_id = @b`);
        if (teCheck.recordset.length === 0) {
          return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
        }
      }
      const modificado_por = sesion.usuario_id;

      // F6: lookup del tipo_evento (puede ser el del body o el original del registro) para
      // saber si hay que reescribir evento_dashboard.
      const teEffectiveId = tipo_evento_id != null
        ? tipo_evento_id
        : (await db.request()
            .input('rid', sql.Int, registro_id)
            .query(`SELECT tipo_evento_id FROM bitacora.registro_activo WHERE registro_id = @rid`)
          ).recordset[0]?.tipo_evento_id;
      const teInfo = await db.request()
        .input('te', sql.Int, teEffectiveId)
        .query(`
          SELECT te.nombre AS tipo_evento_nombre, te.notificar_dashboard_tipo,
                 b.codigo AS bitacora_codigo, b.definicion_campos
          FROM lov_bit.tipo_evento te
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
          WHERE te.tipo_evento_id = @te
        `);
      const teRow = teInfo.recordset[0] || {};
      const isMAND = teRow.bitacora_codigo === 'MAND';

      let camposStr = null;
      let camposFinal = null;
      if (campos_extra !== undefined && campos_extra !== null) {
        const validation = validateCamposExtra(teRow.definicion_campos, campos_extra);
        if (!validation.ok) {
          return sendJSON(res, 400, { error: 'campos_extra inválido', detalles: validation.errors });
        }
        camposFinal = validation.definicion ? computeCamposAuto(validation.definicion, validation.data) : validation.data;
        // F6: solo AUTH legacy auto-rellena periodo desde fecha en PUT.
        if (camposFinal && hasNotificarDashboard(teRow.definicion_campos) && !isMAND) {
          const fechaEfectiva = fecha_evento ? new Date(fecha_evento) : reg.fecha_evento;
          camposFinal.periodo = periodoFromFechaBogota(fechaEfectiva);
        }
        // F6: validación funcionariocnd para MAND/Autorización en edición.
        if (isMAND && teRow.tipo_evento_nombre === 'Autorización') {
          const fcnd = camposFinal?.funcionariocnd;
          if (!fcnd || String(fcnd).trim() === '') {
            return sendJSON(res, 400, { error: 'funcionariocnd es requerido para Autorización' });
          }
        }
        camposStr = camposFinal ? JSON.stringify(camposFinal) : null;
      }

      // F6: turno NO se reactualiza en PUT (preguntas3.md respuesta D). Si llega en el body,
      // se respeta; si no, queda como estaba.
      const transaction = new sql.Transaction(db);
      await transaction.begin();
      try {
        const upd = await new sql.Request(transaction)
          .input('registro_id', sql.Int, registro_id)
          .input('detalle', sql.NVarChar(sql.MAX), detalle ?? null)
          .input('turno', sql.TinyInt, turno)
          .input('fecha_evento', sql.DateTime2, fecha_evento ? new Date(fecha_evento) : null)
          .input('campos_extra', sql.NVarChar(sql.MAX), camposStr)
          .input('tipo_evento_id', sql.Int, tipo_evento_id)
          .input('modificado_por', sql.Int, modificado_por)
          .query(`
            UPDATE bitacora.registro_activo
            SET detalle = COALESCE(@detalle, detalle),
                turno = COALESCE(@turno, turno),
                fecha_evento = COALESCE(@fecha_evento, fecha_evento),
                campos_extra = COALESCE(@campos_extra, campos_extra),
                tipo_evento_id = COALESCE(@tipo_evento_id, tipo_evento_id),
                modificado_por = @modificado_por,
                modificado_en = SYSUTCDATETIME()
            OUTPUT INSERTED.*
            WHERE registro_id = @registro_id AND estado = 'borrador'
          `);

        // F6: si el registro notifica al dashboard y cambió valor/periodo, reescribir la
        // fila correspondiente en evento_dashboard (UPSERT por (planta, fecha, periodo, tipo)).
        const dashboardTipo = teRow.notificar_dashboard_tipo
          || (hasNotificarDashboard(teRow.definicion_campos) ? 'AUTH' : null);
        if (camposFinal && dashboardTipo) {
          const periodo = camposFinal.periodo;
          const valor = camposFinal.valor_mw ?? camposFinal.valor_autorizado_mw;
          if (periodo && valor != null) {
            const reqFactory = () => new sql.Request(transaction);
            const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: reg.planta_id });
            const jefes_snapshot = await snapshotJefes(reqFactory);
            await upsertEventoDashboard(transaction, {
              planta_id: reg.planta_id,
              fecha: fecha_evento ? new Date(fecha_evento) : reg.fecha_evento,
              periodo,
              valor,
              jdts_snapshot,
              jefes_snapshot,
              registro_origen_id: registro_id,
              tipo: dashboardTipo,
            });
          }
        }

        await transaction.commit();
        return sendJSON(res, 200, { registro: upd.recordset[0] });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // AUD-34/35 E9: /api/sala-de-mando/* (grilla, guardar, cierre-diario) migró a routes/mand.js.

    // AUD-34/35 E6: /api/cierre/* (preview, preview-masivo, bitacora, masivo) migró a
    // routes/cierre.js (router Express montado en auth/app.js). Ya no vive en el if-chain.

    // DELETE /api/registros/:id
    const delMatch = pathname.match(/^\/api\/registros\/(\d+)$/);
    if (delMatch && method === 'DELETE') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const registro_id = parseInt(delMatch[1], 10);
      const db = await getDB();
      const check = await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`SELECT registro_id, estado, bitacora_id, planta_id, creado_por FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
      if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
      const reg = check.recordset[0];
      if (reg.estado !== 'borrador') {
        return sendJSON(res, 409, { error: 'Solo se pueden eliminar registros en borrador' });
      }
      if (!(await canEditarRegistro(sesion, reg))) {
        return sendJSON(res, 403, { error: 'Sin permiso para eliminar este registro' });
      }

      // F5: soft-delete cubre TODOS los tipos (AUTH/REDESP/PRUEBA), no solo AUTH. F7 confía
      // en este comportamiento para que vaciar una celda de MAND cancele cualquier evento.
      await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`
          UPDATE bitacora.evento_dashboard SET activa = 0 WHERE registro_origen_id = @registro_id;
          DELETE FROM bitacora.registro_activo WHERE registro_id = @registro_id AND estado = 'borrador';
        `);
      broadcastConteoBitacoras(reg.planta_id).catch(() => {});
      return sendJSON(res, 200, { ok: true });
    }

    // AUD-34/35 E8: /api/disponibilidad/* (estado, metricas, deshacer) migró a routes/disponibilidad.js.

    // AUD-34/35 E3/E4/E5: /api/historicos/*, /api/autorizaciones/*, /api/eventos-dashboard/* y
    // /api/conformacion-turno/* migraron a sus routers en routes/ (montados en auth/app.js).

    // ========================================================================
    // AUD-34/35 E7: /api/combustibles/* (catálogo, consumos GET/POST) migró a routes/combustibles.js.

    sendJSON(res, 404, { error: 'Not Found' });
  } catch (err) {
    // Saneamiento central: clasifica el error (conexión BD caída, timeout, parse, etc.) en una
    // etiqueta apta para usuario final + codigo estable. NUNCA devuelve err.message crudo (era una
    // brecha de seguridad: filtraba host/instancia/puerto de la BD) ni texto técnico incomprensible.
    responderError(res, err, `${method} ${pathname}`);
  }
}

initDB()
  .then(async () => {
    // Inyecta el broadcaster al surface de auth (logout dispara refresh de usuarios activos).
    setBroadcastUsuariosActivos(broadcastUsuariosActivos);
    // Wrapper Express: sesión cookie + rutas /auth, delegando el if-chain (legacyHandler).
    const app = await buildAuthApp(legacyHandler);
    const server = http.createServer(app);
    attachWSS(server);
    attachWSConteoBitacoras(server);
    const db = await getDB();
    startTurnoSweeper(db);
    startMandSweeper(db);
    startSisSweeper(db);
    server.listen(PORT, () => {
      console.log(`[SERVER] Escuchando en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Error de conexión:', err);
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopTurnoSweeper();
    stopMandSweeper();
    stopSisSweeper();
    process.exit(0);
  });
}
