import http from 'http';
import sql from 'mssql';
import { initDB, getDB, TEST_PLANTA_ID } from './db.js';
// F16: USUARIO_SISTEMA_ID es un export `let` que se inicializa al final de initDB(). El
// binding live de ESM permite usarlo después; al momento de los handlers del request ya
// está cargado.
import * as dbBindings from './db.js';
import { CORS_HEADERS, parseBody, sendJSON } from './utils/http.js';
import { responderError, mensajeUsuario } from './utils/errores.js';
import { resolveCargo } from './utils/entra-roles.js';
import { getTurnoColombia, periodoFromFechaBogota, turnoFromPeriodo, ventanaTurno, fechaBogotaStr } from './utils/turno.js';
import { loadSession } from './middleware/auth.js';
import { hasPermisoBitacora, puedeCerrarTurno, plantaMatch, canEditarRegistro, puedeVerConformacion, puedeTriggerConformacion } from './middleware/permissions.js';
import { buildConformacionSnapshot, persistConformacionSnapshot } from './utils/conformacion-snapshot.js';
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

// D-026: cache lazy del bitacora_id de DISP. Lo necesitamos para devolver shape compat
// (registro.bitacora_id) cuando el handler tomó la fila de disponibilidad_estado y no del
// peek por body.bitacora_id.
let _dispBitacoraId = null;
async function getDispBitacoraId(db) {
  if (_dispBitacoraId != null) return _dispBitacoraId;
  const r = await db.request().query(`SELECT bitacora_id FROM lov_bit.bitacora WHERE codigo='DISP'`);
  _dispBitacoraId = r.recordset[0]?.bitacora_id ?? null;
  return _dispBitacoraId;
}

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

// El cuerpo del router nativo (if-chain). Antes era el callback de http.createServer; ahora es
// una función a la que el wrapper Express (auth/app.js) delega todo lo que no sea ruta de auth.
// express-session ya pobló req.session antes de llegar acá, así que loadSession() puede leer la
// cookie Entra. parseBody() sigue leyendo el stream crudo porque express.json() NO es global.
async function legacyHandler(req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

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

    // GET /api/catalogos/plantas
    if (pathname === '/api/catalogos/plantas' && method === 'GET') {
      const db = await getDB();
      const result = await db.request().query(`
        SELECT planta_id, nombre, activa
        FROM lov_bit.planta
        WHERE activa = 1
        ORDER BY planta_id
      `);
      return sendJSON(res, 200, { plantas: result.recordset });
    }

    // GET /api/catalogos/cargos
    if (pathname === '/api/catalogos/cargos' && method === 'GET') {
      const db = await getDB();
      const result = await db.request().query(`
        SELECT cargo_id, nombre, solo_lectura, CAST(puede_cerrar_turno AS BIT) AS puede_cerrar_turno
        FROM lov_bit.cargo
        ORDER BY cargo_id
      `);
      return sendJSON(res, 200, { cargos: result.recordset });
    }

    // GET /api/catalogos/bitacoras
    // F10: oculta=0 esconde bitácoras de auditoría interna (CIET) del frontend.
    if (pathname === '/api/catalogos/bitacoras' && method === 'GET') {
      const db = await getDB();
      const result = await db.request().query(`
        SELECT bitacora_id, nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa
        FROM lov_bit.bitacora
        WHERE activa = 1 AND oculta = 0
        ORDER BY orden
      `);
      return sendJSON(res, 200, { bitacoras: result.recordset });
    }

    // GET /api/catalogos/bitacoras/:id/tipos-evento
    const tiposMatch = pathname.match(/^\/api\/catalogos\/bitacoras\/(\d+)\/tipos-evento$/);
    if (tiposMatch && method === 'GET') {
      const bitacora_id = parseInt(tiposMatch[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('bitacora_id', sql.Int, bitacora_id)
        .query(`
          SELECT tipo_evento_id, bitacora_id, nombre, es_default, orden
          FROM lov_bit.tipo_evento
          WHERE bitacora_id = @bitacora_id
          ORDER BY orden
        `);
      return sendJSON(res, 200, { tipos_evento: result.recordset });
    }

    // GET /api/catalogos/permisos/:cargo_id
    const permisosMatch = pathname.match(/^\/api\/catalogos\/permisos\/(\d+)$/);
    if (permisosMatch && method === 'GET') {
      const cargo_id = parseInt(permisosMatch[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('cargo_id', sql.Int, cargo_id)
        .query(`
          SELECT b.bitacora_id, b.nombre, b.codigo, b.icono, b.formulario_especial, b.orden,
                 ISNULL(p.puede_ver, 0) AS puede_ver,
                 ISNULL(p.puede_crear, 0) AS puede_crear
          FROM lov_bit.bitacora b
          LEFT JOIN lov_bit.cargo_bitacora_permiso p
            ON p.bitacora_id = b.bitacora_id AND p.cargo_id = @cargo_id
          WHERE b.activa = 1 AND b.oculta = 0
          ORDER BY b.orden
        `);
      return sendJSON(res, 200, { permisos: result.recordset });
    }

    // GET /api/catalogos/jdt-actual?planta_id=GEC3
    if (pathname === '/api/catalogos/jdt-actual' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) {
        return sendJSON(res, 400, { error: 'planta_id es requerido' });
      }
      const db = await getDB();
      const activo = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT TOP 1 u.usuario_id, u.nombre_completo, u.email, u.es_jefe_planta, u.es_jdt_default,
                 s.inicio_sesion, s.ultima_actividad
          FROM bitacora.sesion_activa s
          INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
          INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
          WHERE s.planta_id = @planta_id AND s.activa = 1 AND c.nombre = 'Jefe de Turno'
          ORDER BY s.inicio_sesion DESC
        `);
      if (activo.recordset.length > 0) {
        return sendJSON(res, 200, { jdt: activo.recordset[0], origen: 'sesion_activa' });
      }
      const fallback = await db.request().query(`
        SELECT TOP 1 usuario_id, nombre_completo, email, es_jefe_planta, es_jdt_default
        FROM lov_bit.usuario
        WHERE es_jdt_default = 1 AND activo = 1
      `);
      if (fallback.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'No hay JdT disponible' });
      }
      return sendJSON(res, 200, { jdt: fallback.recordset[0], origen: 'default' });
    }

    // GET /api/catalogos/jefe
    if (pathname === '/api/catalogos/jefe' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const db = await getDB();
      const result = await db.request().query(`
        SELECT TOP 1 usuario_id, nombre_completo, email, es_jefe_planta, es_jdt_default
        FROM lov_bit.usuario
        WHERE es_jefe_planta = 1 AND activo = 1
      `);
      if (result.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'No hay jefe de planta' });
      }
      return sendJSON(res, 200, { jefe: result.recordset[0] });
    }

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

    // F16: GET /api/sala-de-mando/dias-pendientes ELIMINADO. La grilla solo muestra HOY y
    // el cierre es automático vía sweeper diario (mand-sweeper.js). El frontend ya no usa
    // paginación entre días — F17 limpia los callsites en useSalaDeMando.js.

    // F6: GET /api/sala-de-mando?planta_id=&fecha=
    // Devuelve la grilla 3×24 (AUTH | PRUEBA | REDESP) que renderea el frontend de Sala de
    // Mando. Para cada tipo: arreglo de 24 posiciones (índice = periodo-1), mapa periodo→
    // registro_id, y los campos de fila (detalle, funcionariocnd) tomados del registro más
    // reciente (preguntas.md punto 3 dice que detalle/funcionario aplican por fila).
    if (pathname === '/api/sala-de-mando' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      const fecha = url.searchParams.get('fecha');
      if (!planta_id || !fecha) return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
      }
      const db = await getDB();
      const r = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .query(`
          SELECT ra.registro_id, ra.detalle, ra.creado_en, ra.fecha_evento,
                 te.notificar_dashboard_tipo AS tipo,
                 te.nombre AS tipo_evento_nombre,
                 TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT) AS periodo,
                 TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw,
                 JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd
          FROM bitacora.registro_activo ra
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
          INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = ra.tipo_evento_id
          WHERE b.codigo = 'MAND'
            AND ra.planta_id = @planta_id
            AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @fecha
            AND ra.estado = 'borrador'
          ORDER BY ra.creado_en DESC
        `);

      const buildEmpty = () => ({
        valores: Array(24).fill(null),
        detalle: null,
        funcionariocnd: null,
        registros: {},
      });
      const out = { AUTH: buildEmpty(), PRUEBA: buildEmpty(), REDESP: buildEmpty() };
      for (const row of r.recordset) {
        const fila = out[row.tipo];
        if (!fila) continue;
        if (row.periodo && row.periodo >= 1 && row.periodo <= 24) {
          // El primer recordset (más reciente) gana para una celda dada — registros viejos
          // del mismo periodo NO se sobreescriben (no debería pasar por el UNIQUE de
          // evento_dashboard, pero defensivo).
          if (fila.valores[row.periodo - 1] == null) {
            fila.valores[row.periodo - 1] = row.valor_mw;
            fila.registros[row.periodo] = row.registro_id;
          }
        }
        // Detalle y funcionario por fila: primer (más reciente) que tenga valor no vacío.
        if (fila.detalle == null && row.detalle) fila.detalle = row.detalle;
        if (fila.funcionariocnd == null && row.funcionariocnd) fila.funcionariocnd = row.funcionariocnd;
      }
      return sendJSON(res, 200, out);
    }

    // F16.B1: POST /api/sala-de-mando/guardar — batch save atómico para la grilla MAND.
    // Body: { planta_id, fecha, filas: [{ tipo, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }] }
    // Reglas (preguntas_mand.md + preguntas_mand2.md):
    //   - tipo ∈ {'AUTH','PRUEBA','REDESP'}; valor_mw=null → DELETE de la celda.
    //   - planta_id ∈ {GEC3, GEC32}; fecha = hoy en TZ Bogotá (sino 400 fecha_no_es_hoy).
    //   - REDESP: rechaza periodo < periodo_actual = floor(hora_bogota_now)+1 con motivo
    //     'periodo_bloqueado'. AUTH/PRUEBA editables siempre dentro del día.
    //   - AUTH con al menos una celda con valor != null exige funcionariocnd no vacío.
    //   - PRUEBA/REDESP fuerzan funcionariocnd = null en persistencia (silencioso).
    //   - modificado_por se actualiza SOLO en celdas cuyo valor_mw cambió (regla 2b).
    //   - Toda la batch corre en una transacción; cualquier error → rollback completo.
    if (pathname === '/api/sala-de-mando/guardar' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });

      const body = await parseBody(req);
      const { planta_id, fecha, filas } = body || {};

      if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id inválido (debe ser GEC3 o GEC32)' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede guardar en otra planta' });
      }
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD' });
      }
      if (!Array.isArray(filas)) {
        return sendJSON(res, 400, { error: 'filas debe ser un array' });
      }

      // Validación: fecha = hoy en TZ Bogotá. Calculamos hoy con offset -5h.
      const nowMs = Date.now();
      const nowBogota = new Date(nowMs - 5 * 3600 * 1000);
      const hoyStr = `${nowBogota.getUTCFullYear()}-${String(nowBogota.getUTCMonth() + 1).padStart(2, '0')}-${String(nowBogota.getUTCDate()).padStart(2, '0')}`;
      if (fecha !== hoyStr) {
        return sendJSON(res, 400, {
          errores: [{ motivo: 'fecha_no_es_hoy', mensaje: `fecha debe ser hoy (${hoyStr} en zona Bogotá)` }],
        });
      }

      // Periodo actual = floor(hora_bogota_now) + 1 → P1=00:00..00:59, P15=14:00..14:59.
      // Se usa para validar el lock REDESP.
      const periodoActual = nowBogota.getUTCHours() + 1;

      const db = await getDB();

      // Lookup MAND + tipos de evento (Autorización/Pruebas/Redespacho) → mapeo
      // notificar_dashboard_tipo (AUTH/PRUEBA/REDESP).
      const meta = await db.request().query(`
        SELECT b.bitacora_id AS mand_id,
               te.tipo_evento_id, te.nombre AS tipo_nombre, te.notificar_dashboard_tipo AS tipo_dashboard
        FROM lov_bit.bitacora b
        INNER JOIN lov_bit.tipo_evento te ON te.bitacora_id = b.bitacora_id
        WHERE b.codigo = 'MAND'
      `);
      if (meta.recordset.length === 0) {
        console.error('[ERROR] config: bitácora MAND no encontrada en lov_bit.bitacora');
        return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
      }
      const MAND_ID = meta.recordset[0].mand_id;
      const tipoMap = {};
      for (const row of meta.recordset) {
        if (row.tipo_dashboard) tipoMap[row.tipo_dashboard] = {
          tipo_evento_id: row.tipo_evento_id,
          tipo_nombre: row.tipo_nombre,
        };
      }
      if (!tipoMap.AUTH || !tipoMap.PRUEBA || !tipoMap.REDESP) {
        console.error('[ERROR] config: mapeo de tipos MAND incompleto en lov_bit.tipo_evento');
        return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
      }

      // Permiso: puede_crear en MAND. plantaMatch ya validado arriba.
      if (!(await hasPermisoBitacora(sesion, MAND_ID, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para crear/editar en MAND' });
      }

      // Validaciones de negocio (acumulan errores, NO escriben si hay alguno).
      const errores = [];
      const filasNorm = [];
      for (const fila of filas) {
        const { tipo, detalle, funcionariocnd, periodos } = fila || {};
        if (!['AUTH', 'PRUEBA', 'REDESP'].includes(tipo)) {
          errores.push({ tipo: tipo ?? null, motivo: 'tipo_invalido' });
          continue;
        }
        if (!Array.isArray(periodos)) {
          errores.push({ tipo, motivo: 'periodos_invalido' });
          continue;
        }
        // Sanitizar periodos: cada item debe tener {periodo:int 1..24, valor_mw: number|null}.
        const periodosNorm = [];
        for (const item of periodos) {
          const p = parseInt(item?.periodo, 10);
          if (!Number.isInteger(p) || p < 1 || p > 24) {
            errores.push({ tipo, periodo: item?.periodo ?? null, motivo: 'periodo_fuera_rango' });
            continue;
          }
          const v = (item.valor_mw === null || item.valor_mw === undefined || item.valor_mw === '')
            ? null
            : Number(item.valor_mw);
          if (v !== null && !Number.isFinite(v)) {
            errores.push({ tipo, periodo: p, motivo: 'valor_mw_invalido' });
            continue;
          }
          // Validación REDESP: rechaza periodo bloqueado solo si valor_mw != null
          // (vaciar una celda bloqueada — improbable — no debería fallar por la regla del lock).
          if (tipo === 'REDESP' && v !== null && p < periodoActual) {
            errores.push({ tipo, periodo: p, motivo: 'periodo_bloqueado' });
            continue;
          }
          periodosNorm.push({ periodo: p, valor_mw: v });
        }

        // funcionariocnd: AUTH lo requiere si hay al menos un valor != null.
        // PRUEBA/REDESP: forzamos a null (silencioso).
        let funcEff = funcionariocnd;
        if (tipo === 'AUTH') {
          const hayValor = periodosNorm.some((x) => x.valor_mw !== null);
          if (hayValor && (!funcEff || String(funcEff).trim() === '')) {
            errores.push({ tipo, motivo: 'funcionariocnd_requerido' });
          }
          if (funcEff != null && String(funcEff).trim() === '') funcEff = null;
        } else {
          funcEff = null;
        }

        filasNorm.push({
          tipo, detalle: detalle ?? null, funcionariocnd: funcEff, periodos: periodosNorm,
        });
      }

      if (errores.length > 0) {
        return sendJSON(res, 400, { errores });
      }

      // Procesamiento atómico.
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

        let creados = 0, actualizados = 0, eliminados = 0;

        for (const fila of filasNorm) {
          const teInfo = tipoMap[fila.tipo];
          const tipoEventoId = teInfo.tipo_evento_id;
          const dashboardTipo = fila.tipo;

          for (const { periodo, valor_mw } of fila.periodos) {
            // Lookup: registro existente para (MAND, planta, fecha Bogotá, periodo, tipo_evento).
            const existRes = await new sql.Request(transaction)
              .input('mand', sql.Int, MAND_ID)
              .input('planta', sql.VarChar(10), planta_id)
              .input('fecha', sql.Date, fecha)
              .input('periodo', sql.Int, periodo)
              .input('te', sql.Int, tipoEventoId)
              .query(`
                SELECT TOP 1 ra.registro_id, ra.detalle,
                       TRY_CAST(JSON_VALUE(ra.campos_extra, '$.valor_mw') AS FLOAT) AS valor_mw_old,
                       JSON_VALUE(ra.campos_extra, '$.funcionariocnd') AS funcionariocnd_old
                FROM bitacora.registro_activo ra
                WHERE ra.bitacora_id = @mand
                  AND ra.planta_id = @planta
                  AND CAST(DATEADD(HOUR, -5, ra.fecha_evento) AS DATE) = @fecha
                  AND ra.tipo_evento_id = @te
                  AND TRY_CAST(JSON_VALUE(ra.campos_extra, '$.periodo') AS INT) = @periodo
                  AND ra.estado = 'borrador'
                ORDER BY ra.creado_en DESC
              `);
            const existing = existRes.recordset[0];
            const turno = turnoFromPeriodo(periodo);

            if (existing && valor_mw === null) {
              // Caso B: existe + valor null → DELETE + soft-delete evento_dashboard.
              await new sql.Request(transaction)
                .input('rid', sql.Int, existing.registro_id)
                .query(`
                  UPDATE bitacora.evento_dashboard SET activa = 0
                  WHERE registro_origen_id = @rid;
                  DELETE FROM bitacora.registro_activo WHERE registro_id = @rid;
                `);
              eliminados++;
              continue;
            }

            if (existing && valor_mw !== null) {
              // Caso A: existe + valor != null. UPDATE de valor/detalle/funcionariocnd.
              // modificado_por SOLO si valor_mw cambió (regla 2b preguntas_mand2.md).
              const valorCambio = (existing.valor_mw_old !== valor_mw);
              const detalleCambio = (existing.detalle ?? null) !== (fila.detalle ?? null);
              const funcCambio = (existing.funcionariocnd_old ?? null) !== (fila.funcionariocnd ?? null);
              if (!valorCambio && !detalleCambio && !funcCambio) continue; // no-op

              const camposExtra = JSON.stringify({
                periodo,
                valor_mw,
                ...(fila.funcionariocnd != null ? { funcionariocnd: fila.funcionariocnd } : { funcionariocnd: null }),
              });
              if (valorCambio) {
                await new sql.Request(transaction)
                  .input('rid', sql.Int, existing.registro_id)
                  .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
                  .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
                  .input('mod_por', sql.Int, sesion.usuario_id)
                  .query(`
                    UPDATE bitacora.registro_activo
                    SET detalle = @detalle,
                        campos_extra = @campos_extra,
                        modificado_por = @mod_por,
                        modificado_en = SYSUTCDATETIME()
                    WHERE registro_id = @rid
                  `);
              } else {
                // Solo cambió detalle/funcionariocnd — actualizamos sin tocar modificado_por.
                await new sql.Request(transaction)
                  .input('rid', sql.Int, existing.registro_id)
                  .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
                  .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
                  .query(`
                    UPDATE bitacora.registro_activo
                    SET detalle = @detalle,
                        campos_extra = @campos_extra
                    WHERE registro_id = @rid
                  `);
              }

              // UPSERT evento_dashboard. Reusa fila si existía (preserva evento_id).
              await upsertEventoDashboard(transaction, {
                planta_id,
                fecha,
                periodo,
                valor: valor_mw,
                jdts_snapshot,
                jefes_snapshot,
                registro_origen_id: existing.registro_id,
                tipo: dashboardTipo,
              });
              actualizados++;
              continue;
            }

            if (!existing && valor_mw === null) {
              // Caso D: no existe + valor null → no-op.
              continue;
            }

            // Caso C: no existe + valor != null → INSERT registro_activo + UPSERT evento_dashboard.
            const camposExtra = JSON.stringify({
              periodo,
              valor_mw,
              ...(fila.funcionariocnd != null ? { funcionariocnd: fila.funcionariocnd } : { funcionariocnd: null }),
            });
            const ins = await new sql.Request(transaction)
              .input('mand', sql.Int, MAND_ID)
              .input('planta', sql.VarChar(10), planta_id)
              .input('turno', sql.TinyInt, turno)
              .input('detalle', sql.NVarChar(sql.MAX), fila.detalle ?? null)
              .input('campos_extra', sql.NVarChar(sql.MAX), camposExtra)
              .input('te', sql.Int, tipoEventoId)
              .input('ingenieros_snapshot', sql.NVarChar(sql.MAX), ingenieros_snapshot)
              .input('jdts_snapshot', sql.NVarChar(sql.MAX), jdts_snapshot)
              .input('jefes_snapshot', sql.NVarChar(sql.MAX), jefes_snapshot)
              .input('creado_por', sql.Int, sesion.usuario_id)
              .query(`
                INSERT INTO bitacora.registro_activo
                  (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                   estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por)
                OUTPUT INSERTED.registro_id
                VALUES (@mand, @planta, SYSUTCDATETIME(), @turno, @detalle, @campos_extra, @te,
                        'borrador', @ingenieros_snapshot, @jdts_snapshot, @jefes_snapshot, @creado_por)
              `);
            const newId = ins.recordset[0].registro_id;
            await upsertEventoDashboard(transaction, {
              planta_id,
              fecha,
              periodo,
              valor: valor_mw,
              jdts_snapshot,
              jefes_snapshot,
              registro_origen_id: newId,
              tipo: dashboardTipo,
            });
            creados++;
          }
        }

        await transaction.commit();
        broadcastConteoBitacoras(planta_id).catch(() => {});
        return sendJSON(res, 200, { resumen: { creados, actualizados, eliminados } });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // F16.B4: POST /api/sala-de-mando/cierre-diario — endpoint manual que dispara el cierre
    // del día para una planta (mismo helper que el sweeper diario). Útil para tests, recovery
    // operativo y reproducción manual.
    if (pathname === '/api/sala-de-mando/cierre-diario' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) {
        return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar el día MAND' });
      }
      const body = await parseBody(req);
      const { fecha, planta_id } = body || {};
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD' });
      }
      if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id inválido (debe ser GEC3 o GEC32)' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede cerrar el día de otra planta' });
      }
      const pool = await getDB();
      try {
        const result = await cerrarDiaMand(pool, {
          fecha,
          planta_id,
          usuarioCierre: dbBindings.USUARIO_SISTEMA_ID,
        });
        broadcastConteoBitacoras(planta_id).catch(() => {});
        return sendJSON(res, 200, result);
      } catch (err) {
        return responderError(res, err, 'POST /api/sala-de-mando/cierre-diario');
      }
    }

    // GET /api/cierre/preview?planta_id=&bitacora_id=
    if (pathname === '/api/cierre/preview' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      const bitacora_id = url.searchParams.get('bitacora_id');
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
      }
      const db = await getDB();
      const reqQ = db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('bitacora_id', sql.Int, bitacora_id ? parseInt(bitacora_id, 10) : null);
      const result = await reqQ.query(`
        SELECT r.bitacora_id, b.nombre AS bitacora_nombre,
               SUM(CASE WHEN LEN(LTRIM(RTRIM(ISNULL(r.detalle, '')))) = 0 THEN 1 ELSE 0 END) AS incompletos,
               COUNT(*) AS total
        FROM bitacora.registro_activo r
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
        WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
          AND b.oculta = 0
          AND b.codigo NOT IN ('DISP','MAND')
          AND (@bitacora_id IS NULL OR r.bitacora_id = @bitacora_id)
        GROUP BY r.bitacora_id, b.nombre
      `);
      return sendJSON(res, 200, { preview: result.recordset });
    }

    // F4: GET /api/cierre/preview-masivo?planta_id=
    // Devuelve lo que el JdT/IngOp necesita para mostrar el modal antes de cerrar masivo:
    //   - bitácoras con borradores (excluye bitácoras ocultas — CIET — desde F10)
    //   - ingenieros con sesion_bitacora abierta (finalizada_en IS NULL) y la lista de
    //     bitácoras donde están participando.
    if (pathname === '/api/cierre/preview-masivo' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) {
        return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
      }
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede consultar otra planta' });
      }
      const db = await getDB();

      const bitsRes = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT r.bitacora_id, b.nombre, COUNT(*) AS registros_borrador
          FROM bitacora.registro_activo r
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
          WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
            AND b.oculta = 0
            AND b.codigo NOT IN ('DISP','MAND')
          GROUP BY r.bitacora_id, b.nombre
          ORDER BY b.nombre
        `);

      const usersRes = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT sa.usuario_id, u.nombre_completo,
                 STRING_AGG(CAST(sb.bitacora_id AS VARCHAR(20)), ',') AS bitacoras_csv
          FROM bitacora.sesion_bitacora sb
          INNER JOIN bitacora.sesion_activa sa ON sa.sesion_id = sb.sesion_id
          INNER JOIN lov_bit.usuario u ON u.usuario_id = sa.usuario_id
          WHERE sa.planta_id = @planta_id
            AND sa.activa = 1
            AND sb.finalizada_en IS NULL
          GROUP BY sa.usuario_id, u.nombre_completo
          ORDER BY u.nombre_completo
        `);

      const ingenieros_no_finalizados = usersRes.recordset.map((row) => ({
        usuario_id: row.usuario_id,
        nombre_completo: row.nombre_completo,
        bitacoras_abiertas: row.bitacoras_csv
          ? row.bitacoras_csv.split(',').map((s) => parseInt(s, 10))
          : [],
      }));

      return sendJSON(res, 200, {
        bitacoras_pendientes: bitsRes.recordset,
        ingenieros_no_finalizados,
      });
    }

    // POST /api/cierre/bitacora
    if (pathname === '/api/cierre/bitacora' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
      const { bitacora_id, planta_id } = await parseBody(req);
      if (!bitacora_id || !planta_id) {
        return sendJSON(res, 400, { error: 'bitacora_id y planta_id son requeridos' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede cerrar bitácoras de otra planta' });
      }
      const cerrado_por = sesion.usuario_id;
      const pool = await getDB();
      // F13.3: DISP no se cierra por turno (envía al histórico al llegar un nuevo registro).
      // F16: MAND tampoco — el cierre es automático vía sweeper diario. Devolvemos 400 con
      // mensaje específico para que el frontend pueda gatear el botón sin ambigüedad.
      const codigoRes = await pool.request()
        .input('bitacora_id', sql.Int, bitacora_id)
        .query(`SELECT codigo FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id`);
      const codigo = codigoRes.recordset[0]?.codigo;
      if (codigo === 'MAND') {
        return sendJSON(res, 400, {
          error: 'mand_cierre_individual_no_permitido',
          mensaje: 'MAND no acepta cierre individual — el cierre es automático al finalizar el día.',
        });
      }
      if (codigo === 'DISP') {
        return sendJSON(res, 422, {
          error: 'bitacora_no_cerrable',
          mensaje: 'La bitácora DISP no se cierra por turno',
        });
      }
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        // F4: cierre cronológico. Identificamos el turno del registro más antiguo y solo
        // movemos los registros que caen en su ventana. Los registros del turno siguiente
        // permanecen como borrador hasta que el JdT/IngOp los cierre con un nuevo click.
        // UPDLOCK + HOLDLOCK previene que dos JdTs cierren el mismo turno simultáneamente.
        const oldest = await new sql.Request(transaction)
          .input('bitacora_id', sql.Int, bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .query(`
            SELECT TOP 1 fecha_evento, turno
            FROM bitacora.registro_activo WITH (UPDLOCK, HOLDLOCK)
            WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
            ORDER BY fecha_evento ASC, registro_id ASC
          `);

        let registros_cerrados = 0;
        if (oldest.recordset.length > 0) {
          const { fecha_evento, turno } = oldest.recordset[0];
          const { inicio, fin } = ventanaTurno(turno, fecha_evento);

          const insResult = await new sql.Request(transaction)
            .input('bitacora_id', sql.Int, bitacora_id)
            .input('planta_id', sql.VarChar(10), planta_id)
            .input('cerrado_por', sql.Int, cerrado_por)
            .input('inicio', sql.DateTime2, inicio)
            .input('fin', sql.DateTime2, fin)
            .query(`
              INSERT INTO bitacora.registro_historico
                (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                 estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
                 modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
              SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                     'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
                     modificado_por, modificado_en, @cerrado_por, SYSUTCDATETIME(), CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)
              FROM bitacora.registro_activo
              WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
                AND fecha_evento >= @inicio AND fecha_evento < @fin;
            `);
          registros_cerrados = insResult.rowsAffected[0] || 0;

          await new sql.Request(transaction)
            .input('bitacora_id', sql.Int, bitacora_id)
            .input('planta_id', sql.VarChar(10), planta_id)
            .input('inicio', sql.DateTime2, inicio)
            .input('fin', sql.DateTime2, fin)
            .query(`
              DELETE FROM bitacora.registro_activo
              WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
                AND fecha_evento >= @inicio AND fecha_evento < @fin;
            `);
        }

        // F3: registrar evento CIET 'cierre' (de F3) — auditoría de la operación incluso si
        // el cierre fue vacío (no había borradores). El JdT/IngOp ejecutó el cierre deliberadamente.
        await registrarEventoCierre(transaction, {
          tipo: 'cierre',
          sesion,
          bitacora_origen_id: bitacora_id,
          forzado: false,
        });

        await transaction.commit();
        broadcastConteoBitacoras(planta_id).catch(() => {});
        return sendJSON(res, 200, { registros_cerrados });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }

    // POST /api/cierre/masivo
    if (pathname === '/api/cierre/masivo' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden cerrar bitácoras' });
      const { planta_id } = await parseBody(req);
      if (!planta_id) {
        return sendJSON(res, 400, { error: 'planta_id es requerido' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede cerrar bitácoras de otra planta' });
      }
      const cerrado_por = sesion.usuario_id;
      const pool = await getDB();
      // F4/F10: excluimos bitácoras ocultas (CIET) del listado para evitar recursión (cada
      // cierre genera un CIET nuevo; absorberlo en el masivo siguiente emite otro CIET).
      // CIET se cierra explícitamente vía /api/cierre/bitacora si un DBA lo necesita.
      const listRes = await pool.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT DISTINCT r.bitacora_id, b.nombre
          FROM bitacora.registro_activo r
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
          WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
            AND b.oculta = 0
            AND b.codigo NOT IN ('DISP','MAND')
        `);

      const resumen = [];
      for (const row of listRes.recordset) {
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
          // F4: cierre cronológico por bitácora. Mismo patrón que /api/cierre/bitacora.
          const oldest = await new sql.Request(transaction)
            .input('bitacora_id', sql.Int, row.bitacora_id)
            .input('planta_id', sql.VarChar(10), planta_id)
            .query(`
              SELECT TOP 1 fecha_evento, turno
              FROM bitacora.registro_activo WITH (UPDLOCK, HOLDLOCK)
              WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
              ORDER BY fecha_evento ASC, registro_id ASC
            `);

          let registros_cerrados = 0;
          if (oldest.recordset.length > 0) {
            const { fecha_evento, turno } = oldest.recordset[0];
            const { inicio, fin } = ventanaTurno(turno, fecha_evento);

            const insResult = await new sql.Request(transaction)
              .input('bitacora_id', sql.Int, row.bitacora_id)
              .input('planta_id', sql.VarChar(10), planta_id)
              .input('cerrado_por', sql.Int, cerrado_por)
              .input('inicio', sql.DateTime2, inicio)
              .input('fin', sql.DateTime2, fin)
              .query(`
                INSERT INTO bitacora.registro_historico
                  (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                   estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
                   modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
                SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                       'cerrado', ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, creado_en,
                       modificado_por, modificado_en, @cerrado_por, SYSUTCDATETIME(), CAST(DATEADD(HOUR, -5, SYSUTCDATETIME()) AS DATE)
                FROM bitacora.registro_activo
                WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
                  AND fecha_evento >= @inicio AND fecha_evento < @fin;
              `);
            registros_cerrados = insResult.rowsAffected[0] || 0;

            await new sql.Request(transaction)
              .input('bitacora_id', sql.Int, row.bitacora_id)
              .input('planta_id', sql.VarChar(10), planta_id)
              .input('inicio', sql.DateTime2, inicio)
              .input('fin', sql.DateTime2, fin)
              .query(`
                DELETE FROM bitacora.registro_activo
                WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador'
                  AND fecha_evento >= @inicio AND fecha_evento < @fin;
              `);
          }

          await registrarEventoCierre(transaction, {
            tipo: 'cierre',
            sesion,
            bitacora_origen_id: row.bitacora_id,
            forzado: false,
          });
          await transaction.commit();
          resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, registros_cerrados });
        } catch (err) {
          await transaction.rollback();
          // Va dentro de un 200 (resultado por bitácora); saneamos igual para no filtrar internals.
          console.error(`[ERROR] cierre masivo bitacora=${row.bitacora_id} →`, err);
          resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, error: mensajeUsuario(err) });
        }
      }
      broadcastConteoBitacoras(planta_id).catch(() => {});
      return sendJSON(res, 200, { resumen });
    }

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

    // F12 / D-026: GET /api/disponibilidad?planta_id=&historial_limit=20&historial_offset=0
    // Vista del mini-dashboard. Permiso: puede_ver=1 en DISP (todos los cargos post-F12.A6).
    // Storage migrado a `bitacora.disponibilidad_estado` (D-026); la lógica se mudó al helper
    // `getEstadoCompleto` en notificador.js.
    if (pathname === '/api/disponibilidad' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });
      const historial_limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('historial_limit') || '20', 10)));
      const historial_offset = Math.max(0, parseInt(url.searchParams.get('historial_offset') || '0', 10));

      const db = await getDB();
      const dispBitacoraId = await getDispBitacoraId(db);
      if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
      if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_ver'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para ver Disponibilidad' });
      }

      const out = await getEstadoCompleto(db, { planta_id, historial_limit, historial_offset });
      return sendJSON(res, 200, out);
    }

    // D-024 / D-026: GET /api/disponibilidad/metricas?planta_id=&desde=&hasta=
    //
    // Devuelve, para una ventana [desde, hasta] (UTC ISO; default = primer registro DISP
    // de la planta a SYSUTCDATETIME()), la duración acumulada en ms por evento + dos
    // acumulados pre-computados para el dashboard:
    //   - disponible       = En Servicio + En Reserva
    //   - no_disponible    = Indisponible + Mantenimiento
    //
    // D-026: la query se mudó al helper `getMetricas` en notificador.js, que ahora suma
    // DATEDIFF_BIG directo sobre `bitacora.disponibilidad_estado` (la vista intermedia
    // `v_disp_intervalos` fue dropeada en F26.A1). Shape de respuesta inalterado.
    if (pathname === '/api/disponibilidad/metricas' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });

      const db = await getDB();
      const plantaCheck = await db.request()
        .input('p', sql.VarChar(10), planta_id)
        .query(`SELECT 1 AS ok FROM lov_bit.planta WHERE planta_id=@p AND activa=1`);
      if (!plantaCheck.recordset[0]) {
        return sendJSON(res, 400, { error: 'planta_id no es operativa' });
      }

      const dispBitacoraId = await getDispBitacoraId(db);
      if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
      if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_ver'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para ver Disponibilidad' });
      }

      const desdeRaw = url.searchParams.get('desde');
      const hastaRaw = url.searchParams.get('hasta');
      const desde = desdeRaw ? new Date(desdeRaw) : null;
      const hasta = hastaRaw ? new Date(hastaRaw) : null;
      if (desdeRaw && Number.isNaN(desde.getTime())) {
        return sendJSON(res, 400, { error: 'desde inválido (ISO 8601 requerido)' });
      }
      if (hastaRaw && Number.isNaN(hasta.getTime())) {
        return sendJSON(res, 400, { error: 'hasta inválido (ISO 8601 requerido)' });
      }
      if (desde && hasta && desde.getTime() > hasta.getTime()) {
        return sendJSON(res, 400, { error: 'desde debe ser <= hasta' });
      }

      const out = await getMetricas(db, { planta_id, desde, hasta });
      return sendJSON(res, 200, out);
    }

    // F12 / D-026: POST /api/disponibilidad/deshacer { planta_id }
    // Revierte el último cambio: borra el vigente y restaura el N-1 (último cerrado) como
    // vigente — o vacía la planta si no hay N-1. Emite CIET 'Deshacer disponibilidad' con audit.
    // D-026: storage ahora es `bitacora.disponibilidad_estado`. El vigente se borra con DELETE;
    // el N-1 se reabre con UPDATE fecha_fin_estado=NULL (`restaurarComoVigente`) — sin mover
    // filas entre tablas. La vista `disponibilidad_dashboard` queda sincronizada automáticamente.
    if (pathname === '/api/disponibilidad/deshacer' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const { planta_id } = await parseBody(req);
      if (!planta_id) return sendJSON(res, 400, { error: 'planta_id es requerido' });

      const db = await getDB();
      const dispBitacoraId = await getDispBitacoraId(db);
      if (!dispBitacoraId) return sendJSON(res, 500, { error: 'Hay un problema de configuración del sistema. Contacta a soporte.', codigo: 'config_sistema' });
      if (!(await hasPermisoBitacora(sesion, dispBitacoraId, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para deshacer en Disponibilidad' });
      }

      const transaction = new sql.Transaction(db);
      await transaction.begin();
      try {
        const vigente = await findVigente(transaction, { planta_id });
        if (!vigente) {
          await transaction.rollback();
          return sendJSON(res, 422, { error: 'sin_vigente', mensaje: `${planta_id} no tiene estado vigente` });
        }
        const nMenos1 = await findUltimoCerrado(transaction, { planta_id });

        // DELETE el vigente (es el que se está deshaciendo).
        await eliminarPorId(transaction, { disponibilidad_id: vigente.disponibilidad_id });

        let restaurado = null;
        if (nMenos1) {
          // Reabrir el N-1: fecha_fin_estado=NULL → pasa a vigente. No movemos filas entre
          // tablas; el row es el mismo, solo cambia su estado en la máquina (cerrado → vigente).
          await restaurarComoVigente(transaction, { disponibilidad_id: nMenos1.disponibilidad_id });
          restaurado = {
            registro_id: nMenos1.disponibilidad_id,
            evento: nMenos1.estado,
            codigo: nMenos1.codigo,
            fecha_inicio_estado: nMenos1.fecha_inicio_estado,
            fecha_fin_estado: null,
            detalle: nMenos1.detalle,
          };
        }

        const ciet = await registrarDeshacerDisponibilidad(transaction, {
          sesion,
          planta_id,
          evento_revertido: vigente.estado,
          fecha_revertida: vigente.fecha_inicio_estado,
        });

        await transaction.commit();
        broadcastConteoBitacoras(planta_id).catch(() => {});
        return sendJSON(res, 200, {
          revertido: { registro_id_eliminado: vigente.disponibilidad_id, evento: vigente.estado },
          restaurado,
          ciet_registro_id: ciet.registro_id,
        });
      } catch (err) {
        try { await transaction.rollback(); } catch {}
        throw err;
      }
    }

    // GET /api/historicos/resumen?planta_id=&fecha=
    // F10: oculta=0 esconde bitácoras de auditoría interna (CIET) del histórico visible.
    if (pathname === '/api/historicos/resumen' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const planta_id = url.searchParams.get('planta_id');
      const fecha = url.searchParams.get('fecha');
      if (!planta_id || !fecha) {
        return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .query(`
          SELECT b.bitacora_id, b.nombre AS bitacora_nombre, b.codigo AS bitacora_codigo,
                 COUNT(h.registro_id) AS total_registros,
                 MAX(h.cerrado_en) AS fecha_cierre
          FROM lov_bit.bitacora b
          LEFT JOIN bitacora.registro_historico h
            ON h.bitacora_id = b.bitacora_id
           AND h.planta_id = @planta_id
           AND h.fecha_cierre_operativo = @fecha
          WHERE b.activa = 1 AND b.oculta = 0
          GROUP BY b.bitacora_id, b.nombre, b.codigo, b.orden
          HAVING COUNT(h.registro_id) > 0
          ORDER BY b.orden
        `);
      return sendJSON(res, 200, { resumen: result.recordset });
    }

    // GET /api/historicos/:id
    // F10: rechaza el registro si su bitácora es oculta — coherente con "no aparece en histórico".
    const histIdMatch = pathname.match(/^\/api\/historicos\/(\d+)$/);
    if (histIdMatch && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const registro_id = parseInt(histIdMatch[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`SELECT * FROM bitacora.v_historico_busqueda WHERE registro_id = @registro_id AND bitacora_oculta = 0`);
      if (result.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'Histórico no encontrado' });
      }
      return sendJSON(res, 200, { registro: result.recordset[0] });
    }

    // GET /api/historicos?filtros&page&limit
    if (pathname === '/api/historicos' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const params = url.searchParams;
      const page = Math.max(1, parseInt(params.get('page') || '1', 10));
      const limit = Math.min(500, Math.max(1, parseInt(params.get('limit') || '50', 10)));
      const offset = (page - 1) * limit;

      const db = await getDB();
      // F10: filtro base oculta=0 — registros de bitácoras de auditoría interna (CIET) NO
      // aparecen en históricos visibles aunque alguien envíe filtros que los matcheen.
      const where = ['bitacora_oculta = 0'];
      const reqData = db.request();
      const reqCount = db.request();
      const addInput = (name, type, value) => { reqData.input(name, type, value); reqCount.input(name, type, value); };

      if (params.get('planta_id')) { addInput('planta_id', sql.VarChar(10), params.get('planta_id')); where.push('planta_id = @planta_id'); }
      if (params.get('bitacora_id')) { addInput('bitacora_id', sql.Int, parseInt(params.get('bitacora_id'), 10)); where.push('bitacora_id = @bitacora_id'); }
      if (params.get('creado_por_id')) { addInput('creado_por_id', sql.Int, parseInt(params.get('creado_por_id'), 10)); where.push('creado_por_id = @creado_por_id'); }
      if (params.get('turno')) { addInput('turno', sql.TinyInt, parseInt(params.get('turno'), 10)); where.push('turno = @turno'); }
      if (params.get('tipo_evento_id')) { addInput('tipo_evento_id', sql.Int, parseInt(params.get('tipo_evento_id'), 10)); where.push('tipo_evento_id = @tipo_evento_id'); }
      if (params.get('fecha_desde')) { addInput('fecha_desde', sql.Date, new Date(params.get('fecha_desde'))); where.push('fecha_cierre_operativo >= @fecha_desde'); }
      if (params.get('fecha_hasta')) { addInput('fecha_hasta', sql.Date, new Date(params.get('fecha_hasta'))); where.push('fecha_cierre_operativo <= @fecha_hasta'); }
      if (params.get('busqueda')) { addInput('busqueda', sql.NVarChar(200), params.get('busqueda')); where.push("detalle LIKE '%' + @busqueda + '%'"); }

      const whereSql = where.join(' AND ');
      reqData.input('offset', sql.Int, offset).input('limit', sql.Int, limit);

      const dataResult = await reqData.query(`
        SELECT *
        FROM bitacora.v_historico_busqueda
        WHERE ${whereSql}
        ORDER BY fecha_cierre_operativo DESC, fecha_evento DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);
      const countResult = await reqCount.query(`
        SELECT COUNT(*) AS total FROM bitacora.v_historico_busqueda WHERE ${whereSql}
      `);

      return sendJSON(res, 200, {
        data: dataResult.recordset,
        total: countResult.recordset[0].total,
        page,
        limit,
      });
    }

    // GET /api/autorizaciones?planta_id=&fecha=
    // F5: alias filtrado por tipo='AUTH'. Mantiene shape original (autorizacion_id, valor_autorizado_mw)
    // vía la vista compat `bitacora.autorizacion_dashboard`.
    // F9: marcado deprecated. El dashboard ya consume /api/eventos-dashboard. Próximo release lo borra.
    if (pathname === '/api/autorizaciones' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      console.warn('[deprecated] GET /api/autorizaciones — usar /api/eventos-dashboard?tipo=AUTH');
      const planta_id = url.searchParams.get('planta_id');
      const fecha = url.searchParams.get('fecha');
      if (!planta_id || !fecha) {
        return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .query(`
          SELECT a.autorizacion_id, a.registro_origen_id, a.planta_id, a.fecha, a.periodo,
                 a.valor_autorizado_mw, a.jdts_snapshot, a.jefes_snapshot, a.activa, a.creado_en
          FROM bitacora.autorizacion_dashboard a
          WHERE a.planta_id = @planta_id AND a.fecha = @fecha AND a.activa = 1
          ORDER BY a.periodo
        `);
      return sendJSON(res, 200, { autorizaciones: result.recordset });
    }

    // GET /api/autorizaciones/:planta_id/:fecha/:periodo
    // F9: deprecated — usar /api/eventos-dashboard.
    const authLookup = pathname.match(/^\/api\/autorizaciones\/([^/]+)\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/(\d+)$/);
    if (authLookup && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      console.warn('[deprecated] GET /api/autorizaciones/:p/:f/:per — usar /api/eventos-dashboard');
      const [, planta_id, fecha, periodoStr] = authLookup;
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .input('periodo', sql.TinyInt, parseInt(periodoStr, 10))
        .query(`
          SELECT a.*
          FROM bitacora.autorizacion_dashboard a
          WHERE a.planta_id = @planta_id AND a.fecha = @fecha
            AND a.periodo = @periodo AND a.activa = 1
        `);
      if (result.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'Autorización no encontrada' });
      }
      return sendJSON(res, 200, { autorizacion: result.recordset[0] });
    }

    // DELETE /api/autorizaciones/:id
    // F9: deprecated — usar DELETE /api/eventos-dashboard/:id que cubre cualquier tipo.
    const authDel = pathname.match(/^\/api\/autorizaciones\/(\d+)$/);
    if (authDel && method === 'DELETE') {
      console.warn('[deprecated] DELETE /api/autorizaciones/:id — usar /api/eventos-dashboard/:id');
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden anular autorizaciones' });
      const autorizacion_id = parseInt(authDel[1], 10);
      const db = await getDB();
      // F5: el id viejo (autorizacion_id) coincide con evento_id porque sp_rename solo cambió
      // el nombre de la columna, no los valores. Filtramos tipo='AUTH' para preservar la
      // semántica del alias (no permitimos borrar REDESP/PRUEBA por aquí).
      const result = await db.request()
        .input('evento_id', sql.Int, autorizacion_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .query(`
          UPDATE bitacora.evento_dashboard
          SET activa = 0
          WHERE evento_id = @evento_id AND planta_id = @planta_id AND tipo = 'AUTH'
        `);
      if (!result.rowsAffected[0]) {
        return sendJSON(res, 404, { error: 'Autorización no encontrada' });
      }
      return sendJSON(res, 200, { ok: true });
    }

    // F5: GET /api/eventos-dashboard?planta_id=&fecha=&tipo=
    // Endpoint nuevo para F8 (dashboard externo). `tipo` opcional — sin él retorna todos los
    // tipos (AUTH+REDESP+PRUEBA) activos para esa (planta, fecha).
    // F12: tipo='DISP' lee de bitacora.disponibilidad_dashboard (semántica distinta — sin
    // periodo, sin fecha; 1 fila por planta con el estado vigente). Cimiento para F15.
    //
    // F15 TODO: el consumer en dashboard-gen-gec3 debe hacer polling cada 60s y catch
    // silencioso. Vite proxy + Nginx (`/api/eventos-dashboard → 3002`) ya cubren el routing
    // desde F8 — F15 solo necesita agregar el hook + componente <BadgeDisponibilidad>.
    if (pathname === '/api/eventos-dashboard' && method === 'GET') {
      const planta_id = url.searchParams.get('planta_id');
      const fecha = url.searchParams.get('fecha');
      const tipo = url.searchParams.get('tipo');

      // D-030: la planta de test reservada nunca debe filtrarse al dashboard productivo. Este
      // endpoint es el único borde del contrato cross-repo (el dashboard no toca esta BD directo),
      // así que la tratamos como inexistente acá — independientemente del tipo. Las vistas DISP no
      // la filtran a propósito (los tests dependen de ellas); el corte vive en este borde.
      if (planta_id === TEST_PLANTA_ID) {
        return sendJSON(res, 200, { eventos: [] });
      }

      if (tipo === 'DISP') {
        if (!planta_id) {
          return sendJSON(res, 400, { error: 'planta_id es requerido para tipo=DISP' });
        }
        const db = await getDB();
        const r = await db.request()
          .input('p', sql.VarChar(10), planta_id)
          .query(`
            SELECT planta_id, evento, codigo, fecha_inicio_estado,
                   jdts_snapshot, jefes_snapshot, actualizado_en
            FROM bitacora.disponibilidad_dashboard
            WHERE planta_id = @p
          `);
        const row = r.recordset[0] || null;
        return sendJSON(res, 200, { eventos: row ? [row] : [] });
      }

      if (!planta_id || !fecha) {
        return sendJSON(res, 400, { error: 'planta_id y fecha son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .input('tipo', sql.VarChar(10), tipo || null)
        .query(`
          SELECT e.evento_id, e.registro_origen_id, e.planta_id, e.fecha, e.periodo,
                 e.valor_mw, e.tipo, e.jdts_snapshot, e.jefes_snapshot, e.activa, e.creado_en
          FROM bitacora.evento_dashboard e
          WHERE e.planta_id = @planta_id AND e.fecha = @fecha AND e.activa = 1
            AND (@tipo IS NULL OR e.tipo = @tipo)
          ORDER BY e.periodo, e.tipo
        `);
      return sendJSON(res, 200, { eventos: result.recordset });
    }

    // F5: DELETE /api/eventos-dashboard/:id — opera sobre cualquier tipo. F7 lo usa para
    // cancelar (vaciar) celdas en MAND.
    const eventoDel = pathname.match(/^\/api\/eventos-dashboard\/(\d+)$/);
    if (eventoDel && method === 'DELETE') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeCerrarTurno(sesion)) {
        return sendJSON(res, 403, { error: 'Solo el Jefe de Turno o el Ingeniero de Operación pueden anular eventos' });
      }
      const evento_id = parseInt(eventoDel[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('evento_id', sql.Int, evento_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .query(`
          UPDATE bitacora.evento_dashboard
          SET activa = 0
          WHERE evento_id = @evento_id AND planta_id = @planta_id
        `);
      if (!result.rowsAffected[0]) {
        return sendJSON(res, 404, { error: 'Evento no encontrado' });
      }
      return sendJSON(res, 200, { ok: true });
    }

    // conformacion-turno-2026-05 (Q4=e): consulta de la conformación de turno (sin UI en W1).
    // Auth requerida; cualquier cargo con sesión activa puede ver (puedeVerConformacion=true).
    if (pathname === '/api/conformacion-turno' && method === 'GET') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeVerConformacion(sesion)) return sendJSON(res, 403, { error: 'No autorizado' });

      const fecha = url.searchParams.get('fecha');
      const turno = parseInt(url.searchParams.get('turno'), 10);
      const planta_id = url.searchParams.get('planta_id');

      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return sendJSON(res, 400, { error: 'fecha es requerida en formato YYYY-MM-DD (Bogotá)' });
      }
      if (![1, 2].includes(turno)) {
        return sendJSON(res, 400, { error: 'turno debe ser 1 o 2' });
      }
      if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id debe ser GEC3 o GEC32' });
      }

      const db = await getDB();
      const r = await db.request()
        .input('fecha', sql.Date, fecha)
        .input('turno', sql.TinyInt, turno)
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT
            fecha_operativa, planta_id, turno,
            usuario_id, usuario_nombre,
            cargo_id, cargo_nombre,
            inicio_sesion, fin_sesion,
            inicio_sesion_bogota, fin_sesion_bogota,
            duracion_min, fin_inferido,
            snapshot_en, snapshot_en_bogota
          FROM bitacora.conformacion_turno
          WHERE fecha_operativa = @fecha
            AND turno = @turno
            AND planta_id = @planta_id
          ORDER BY inicio_sesion ASC
        `);

      return sendJSON(res, 200, {
        fecha_operativa: fecha,
        planta_id,
        turno,
        filas: r.recordset,
        total: r.recordset.length,
      });
    }

    // conformacion-turno-2026-05 (Q4 extra): trigger manual del snapshot (QA + recovery).
    // Permisos restrictivos vía puedeTriggerConformacion. Por defecto rechaza turnos cuya
    // ventana no cerró — bypass con ?force=true (snapshot puede ser incompleto).
    // Idempotencia natural vía PK de conformacion_turno.
    if (pathname === '/api/conformacion-turno/trigger' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!puedeTriggerConformacion(sesion)) {
        return sendJSON(res, 403, { error: 'Solo Ingeniero Jefe de Turno, Ingeniero de Operación o Jefe de Planta pueden disparar el snapshot manual' });
      }

      const body = await parseBody(req);
      const { fecha_operativa, planta_id, turno } = body || {};

      if (!fecha_operativa || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_operativa)) {
        return sendJSON(res, 400, { error: 'fecha_operativa requerida en formato YYYY-MM-DD (Bogotá)' });
      }
      if (![1, 2].includes(turno)) {
        return sendJSON(res, 400, { error: 'turno debe ser 1 o 2' });
      }
      if (!planta_id || !['GEC3', 'GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id debe ser GEC3 o GEC32' });
      }

      const forceQuery = url.searchParams.get('force') === 'true';
      // Mediodía Bogotá para evitar el shift -5h de colombiaParts con string 'YYYY-MM-DD'
      // (mismo patrón que conformacion-snapshot.js::fechaRefBogotaMediodia).
      const fechaRef = new Date(`${fecha_operativa}T12:00:00.000-05:00`);
      const { fin: ventanaFin } = ventanaTurno(turno, fechaRef);
      if (!forceQuery && new Date() < ventanaFin) {
        return sendJSON(res, 400, {
          error: 'La ventana del turno aún no cerró. Use ?force=true si quieres disparar sobre un turno en curso (snapshot puede ser incompleto).',
          ventana_fin: ventanaFin.toISOString(),
        });
      }

      try {
        const db = await getDB();
        const filas = await buildConformacionSnapshot(db, { fecha_operativa, planta_id, turno });
        const { insertadas, skipped } = await persistConformacionSnapshot(db, filas);
        return sendJSON(res, 200, {
          fecha_operativa, planta_id, turno,
          insertadas, skipped,
          filas_resultado: filas.length,
          force: forceQuery,
          disparado_por: { usuario_id: sesion.usuario_id, nombre: sesion.nombre_completo },
        });
      } catch (err) {
        return responderError(res, err, 'POST /api/conformacion-turno/trigger');
      }
    }

    // ========================================================================
    // D-027: Combustibles → Consumos (F26.B1)
    // 3 endpoints: catálogo (read), consumos GET (pivot por planta×fecha), consumos POST (batch).
    // COMB_BITACORA_ID se resuelve vía dbBindings (live binding, asignado al final de initDB).
    // ========================================================================

    // GET /api/combustibles/catalogo?planta_id=GEC3|GEC32
    if (method === 'GET' && pathname === '/api/combustibles/catalogo') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
      }
      const planta_id = url.searchParams.get('planta_id');
      if (!['GEC3','GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
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
    }

    // GET /api/combustibles/consumos?planta_id=&fecha=YYYY-MM-DD
    // Devuelve catálogo (siempre) + pivot de celdas keyed por periodo→combustible_id.
    if (method === 'GET' && pathname === '/api/combustibles/consumos') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_ver'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para ver Combustibles' });
      }
      const planta_id = url.searchParams.get('planta_id');
      const fechaStr  = url.searchParams.get('fecha');
      if (!['GEC3','GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id requerido (GEC3 | GEC32)' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '')) {
        return sendJSON(res, 400, { error: 'fecha requerida (YYYY-MM-DD)' });
      }

      const db = await getDB();

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
        .query(`
          SELECT
            c.consumo_id, c.periodo, c.combustible_id, c.cantidad, c.detalle,
            c.creado_por, c.creado_en, c.modificado_por, c.modificado_en,
            uc.nombre_completo AS creado_por_nombre,
            um.nombre_completo AS modificado_por_nombre
          FROM bitacora.consumo_combustible c
          LEFT JOIN lov_bit.usuario uc ON uc.usuario_id = c.creado_por
          LEFT JOIN lov_bit.usuario um ON um.usuario_id = c.modificado_por
          WHERE c.planta_id = @p AND c.fecha = @f
          ORDER BY c.periodo, c.combustible_id
        `);

      // Pivot: { "<periodo>": { "<combustible_id>": { ... } } }
      const celdas = {};
      for (const row of conRes.recordset) {
        const p = String(row.periodo);
        if (!celdas[p]) celdas[p] = {};
        celdas[p][String(row.combustible_id)] = {
          consumo_id: row.consumo_id,
          cantidad: Number(row.cantidad),
          detalle: row.detalle,
          creado_por: { usuario_id: row.creado_por, nombre_completo: row.creado_por_nombre },
          creado_en: row.creado_en,
          modificado_por: row.modificado_por
            ? { usuario_id: row.modificado_por, nombre_completo: row.modificado_por_nombre }
            : null,
          modificado_en: row.modificado_en,
        };
      }

      return sendJSON(res, 200, {
        planta_id,
        fecha: fechaStr,
        catalogo: catRes.recordset,
        celdas,
      });
    }

    // POST /api/combustibles/consumos — batch atómico (patrón MAND).
    // Body: { planta_id, fecha, celdas: [{ periodo, combustible_id, cantidad, detalle? }] }
    // cantidad=null o 0 ⇒ DELETE de la celda si existía; existente ⇒ UPDATE; nueva ⇒ INSERT.
    // modificado_por solo se setea si cantidad cambió (paridad D-019 con MAND).
    if (method === 'POST' && pathname === '/api/combustibles/consumos') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!(await hasPermisoBitacora(sesion, dbBindings.COMB_BITACORA_ID, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para crear Consumos' });
      }

      const body = await parseBody(req);
      const { planta_id, fecha, celdas } = body || {};
      if (!['GEC3','GEC32'].includes(planta_id)) {
        return sendJSON(res, 400, { error: 'planta_id inválido' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
        return sendJSON(res, 400, { error: 'fecha inválida (YYYY-MM-DD)' });
      }
      if (!Array.isArray(celdas)) {
        return sendJSON(res, 400, { error: 'celdas debe ser un array' });
      }

      // Ventana: hoy o pasado en TZ Bogotá (D-027 decisión). Comparación lexicográfica
      // funciona porque ambos están en YYYY-MM-DD padded.
      const hoyBogota = fechaBogotaStr(new Date());
      if (fecha > hoyBogota) {
        return sendJSON(res, 400, { error: 'fecha_futura', mensaje: 'La fecha no puede ser futura' });
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
              SELECT consumo_id, cantidad, detalle
              FROM bitacora.consumo_combustible
              WHERE planta_id=@p AND fecha=@f AND periodo=@per AND combustible_id=@cid
            `)).recordset[0];

          const esVacio = c.cantidad === null || c.cantidad === 0 || c.cantidad === undefined;

          if (esVacio) {
            if (existente) {
              await new sql.Request(tx)
                .input('id', sql.Int, existente.consumo_id)
                .query(`DELETE FROM bitacora.consumo_combustible WHERE consumo_id=@id`);
              eliminados++;
            }
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
            // UPDATE — modificado_por solo si cantidad cambió (paridad D-019 con MAND).
            const cantidadCambio = Number(existente.cantidad) !== c.cantidad;
            if (cantidadCambio) {
              await new sql.Request(tx)
                .input('id', sql.Int, existente.consumo_id)
                .input('cant', sql.Decimal(12, 3), c.cantidad)
                .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
                .input('u', sql.Int, sesion.usuario_id)
                .query(`
                  UPDATE bitacora.consumo_combustible
                  SET cantidad=@cant, detalle=@det,
                      modificado_por=@u, modificado_en=SYSUTCDATETIME()
                  WHERE consumo_id=@id
                `);
              actualizados++;
            } else if ((existente.detalle ?? null) !== (c.detalle ?? null)) {
              // Solo detalle cambió: actualizar sin tocar modificado_por (igual que MAND).
              await new sql.Request(tx)
                .input('id', sql.Int, existente.consumo_id)
                .input('det', sql.NVarChar(sql.MAX), c.detalle ?? null)
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
    }

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
