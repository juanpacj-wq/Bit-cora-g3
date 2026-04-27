import http from 'http';
import sql from 'mssql';
import { initDB, getDB } from './db.js';
import { verifyPassword } from './utils/password.js';
import { CORS_HEADERS, parseBody, sendJSON } from './utils/http.js';
import { getTurnoColombia, periodoFromFechaBogota, turnoFromPeriodo, ventanaTurno } from './utils/turno.js';
import { loadSession } from './middleware/auth.js';
import { hasPermisoBitacora, puedeCerrarTurno, plantaMatch, canEditarRegistro } from './middleware/permissions.js';
import { validateCamposExtra, computeCamposAuto } from './utils/campos.js';
import { findEventoDashboard, upsertEventoDashboard, hasNotificarDashboard } from './utils/notificador.js';
import { snapshotJDTs, snapshotJefes, snapshotIngenieros } from './utils/snapshots.js';
import { registrarEventoCierre } from './utils/ciet.js';
import { attachWSS, broadcastUsuariosActivos } from './utils/ws-usuarios-activos.js';
import { attachWSConteoBitacoras, broadcastConteoBitacoras } from './utils/ws-conteo-bitacoras.js';
// F9: turno-sweeper reemplazó al viejo sesion-sweeper (eliminado). Finaliza sesion_bitacora
// cuando la ventana del turno termina, sin tocar sesion_activa.activa.
import { startTurnoSweeper, stopTurnoSweeper } from './utils/turno-sweeper.js';

const PORT = parseInt(process.env.SERVER_PORT || '3002', 10);

const server = http.createServer(async (req, res) => {
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

    // POST /api/auth/login  (autentica por username + bcrypt)
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { username, password } = await parseBody(req);
      if (!username || !password) {
        return sendJSON(res, 400, { error: 'username y password son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('username', sql.VarChar(50), username)
        .query(`
          SELECT usuario_id, nombre_completo, username, email, password_hash,
                 es_jefe_planta, es_jdt_default, activo
          FROM lov_bit.usuario
          WHERE username = @username AND activo = 1
        `);
      const u = result.recordset[0];
      if (!u || !(await verifyPassword(password, u.password_hash))) {
        return sendJSON(res, 401, { error: 'Credenciales inválidas' });
      }
      const { password_hash: _omit, ...usuario } = u;
      return sendJSON(res, 200, { usuario });
    }

    // POST /api/auth/select-context
    if (pathname === '/api/auth/select-context' && method === 'POST') {
      const { usuario_id, planta_id, cargo_id } = await parseBody(req);
      if (!usuario_id || !planta_id || !cargo_id) {
        return sendJSON(res, 400, { error: 'usuario_id, planta_id y cargo_id son requeridos' });
      }
      const db = await getDB();

      const valid = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('cargo_id', sql.Int, cargo_id)
        .query(`
          SELECT
            (SELECT COUNT(*) FROM lov_bit.planta WHERE planta_id = @planta_id AND activa = 1) AS planta_ok,
            (SELECT COUNT(*) FROM lov_bit.cargo WHERE cargo_id = @cargo_id) AS cargo_ok
        `);
      if (!valid.recordset[0].planta_ok || !valid.recordset[0].cargo_ok) {
        return sendJSON(res, 400, { error: 'planta_id o cargo_id inválido' });
      }

      const turno = getTurnoColombia();
      // INSERT y recuperamos la sesión ENRIQUECIDA con el nombre del cargo y el flag
      // puede_cerrar_turno — el frontend los necesita para pintar dropdowns y habilitar
      // el botón de "Cerrar Turno". OUTPUT INSERTED.* solo daría las columnas crudas.
      const result = await db.request()
        .input('usuario_id', sql.Int, usuario_id)
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('cargo_id', sql.Int, cargo_id)
        .input('turno', sql.TinyInt, turno)
        .query(`
          DECLARE @out TABLE (sesion_id INT);
          INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
          OUTPUT INSERTED.sesion_id INTO @out
          VALUES (@usuario_id, @planta_id, @cargo_id, @turno);

          SELECT s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno, s.activa,
                 s.inicio_sesion, s.ultima_actividad,
                 u.nombre_completo, u.username, u.es_jefe_planta, u.es_jdt_default,
                 c.nombre AS cargo_nombre, c.solo_lectura,
                 CAST(c.puede_cerrar_turno AS BIT) AS puede_cerrar_turno
          FROM @out o
          INNER JOIN bitacora.sesion_activa s ON s.sesion_id = o.sesion_id
          INNER JOIN lov_bit.usuario u        ON u.usuario_id = s.usuario_id
          INNER JOIN lov_bit.cargo c          ON c.cargo_id   = s.cargo_id;
        `);
      broadcastUsuariosActivos().catch(() => {});
      return sendJSON(res, 200, { sesion: result.recordset[0] });
    }

    // POST /api/auth/logout
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const { sesion_id } = await parseBody(req);
      if (!sesion_id) {
        return sendJSON(res, 400, { error: 'sesion_id es requerido' });
      }
      const db = await getDB();
      await db.request()
        .input('sesion_id', sql.Int, sesion_id)
        .query(`UPDATE bitacora.sesion_activa SET activa = 0 WHERE sesion_id = @sesion_id`);
      broadcastUsuariosActivos().catch(() => {});
      return sendJSON(res, 200, { ok: true });
    }

    // F9: /api/auth/resume y /api/auth/heartbeat eliminados. La sesión queda activa hasta
    // logout o sweeper de turno (F4). Si una sesión queda inválida, el primer request
    // autenticado retorna 401 y el cliente hace logout via setUnauthorizedHandler.

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
          WHEN MATCHED THEN UPDATE SET finalizada_en = NULL, abierta_en = GETDATE()
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

            UPDATE sb SET finalizada_en = GETDATE()
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
    //   - UPDATE sus sesion_bitacora con finalizada_en = GETDATE().
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
              UPDATE sb SET finalizada_en = GETDATE()
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
    if (pathname === '/api/catalogos/bitacoras' && method === 'GET') {
      const db = await getDB();
      const result = await db.request().query(`
        SELECT bitacora_id, nombre, codigo, icono, formulario_especial, definicion_campos, orden, activa
        FROM lov_bit.bitacora
        WHERE activa = 1
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
          WHERE b.activa = 1
          ORDER BY b.orden
        `);
      return sendJSON(res, 200, { permisos: result.recordset });
    }

    // GET /api/catalogos/jdt-actual?planta_id=GEC3
    if (pathname === '/api/catalogos/jdt-actual' && method === 'GET') {
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
      const planta_id = url.searchParams.get('planta_id');
      const bitacora_id = url.searchParams.get('bitacora_id');
      const estado = url.searchParams.get('estado');
      const db = await getDB();
      const reqQ = db.request();
      let where = ['1=1'];
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
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT bitacora_id, COUNT(*) AS total
          FROM bitacora.registro_activo
          WHERE planta_id = @planta_id AND estado = 'borrador'
          GROUP BY bitacora_id
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
      // F3: detalle ya no es requerido. F6: turno tampoco — para MAND lo derivamos de periodo.
      if (!bitacora_id || !planta_id || !fecha_evento || !tipo_evento_id) {
        return sendJSON(res, 400, { error: 'Campos requeridos faltantes (fecha_evento, bitacora_id, planta_id, tipo_evento_id)' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede crear registros en otra planta' });
      }
      if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
      }
      const creado_por = sesion.usuario_id;
      const db = await getDB();

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
          return sendJSON(res, 500, { error: 'No hay jefe de planta activo' });
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
      const check = await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`SELECT registro_id, estado, bitacora_id, planta_id, creado_por, fecha_evento FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
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
            AND CAST(ra.fecha_evento AS DATE) = @fecha
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
          AND (@bitacora_id IS NULL OR r.bitacora_id = @bitacora_id)
        GROUP BY r.bitacora_id, b.nombre
      `);
      return sendJSON(res, 200, { preview: result.recordset });
    }

    // F4: GET /api/cierre/preview-masivo?planta_id=
    // Devuelve lo que el JdT/IngOp necesita para mostrar el modal antes de cerrar masivo:
    //   - bitácoras con borradores (excluye CIET, igual que el masivo)
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
            AND b.codigo <> 'CIET'
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
            ORDER BY fecha_evento ASC
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
                     modificado_por, modificado_en, @cerrado_por, GETDATE(), CAST(GETDATE() AS DATE)
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
      // F4: excluimos CIET del listado para evitar recursión (cada cierre genera un CIET
      // nuevo; absorberlo en el masivo siguiente emite otro CIET, etc.). CIET se cierra
      // explícitamente vía /api/cierre/bitacora si alguien lo necesita.
      const listRes = await pool.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT DISTINCT r.bitacora_id, b.nombre
          FROM bitacora.registro_activo r
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
          WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
            AND b.codigo <> 'CIET'
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
              ORDER BY fecha_evento ASC
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
                       modificado_por, modificado_en, @cerrado_por, GETDATE(), CAST(GETDATE() AS DATE)
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
          resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, error: err.message });
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

    // GET /api/historicos/resumen?planta_id=&fecha=
    if (pathname === '/api/historicos/resumen' && method === 'GET') {
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
          WHERE b.activa = 1
          GROUP BY b.bitacora_id, b.nombre, b.codigo, b.orden
          HAVING COUNT(h.registro_id) > 0
          ORDER BY b.orden
        `);
      return sendJSON(res, 200, { resumen: result.recordset });
    }

    // GET /api/historicos/:id
    const histIdMatch = pathname.match(/^\/api\/historicos\/(\d+)$/);
    if (histIdMatch && method === 'GET') {
      const registro_id = parseInt(histIdMatch[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`SELECT * FROM bitacora.v_historico_busqueda WHERE registro_id = @registro_id`);
      if (result.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'Histórico no encontrado' });
      }
      return sendJSON(res, 200, { registro: result.recordset[0] });
    }

    // GET /api/historicos?filtros&page&limit
    if (pathname === '/api/historicos' && method === 'GET') {
      const params = url.searchParams;
      const page = Math.max(1, parseInt(params.get('page') || '1', 10));
      const limit = Math.min(500, Math.max(1, parseInt(params.get('limit') || '50', 10)));
      const offset = (page - 1) * limit;

      const db = await getDB();
      const where = ['1=1'];
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
    if (pathname === '/api/eventos-dashboard' && method === 'GET') {
      const planta_id = url.searchParams.get('planta_id');
      const fecha = url.searchParams.get('fecha');
      const tipo = url.searchParams.get('tipo');
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

    sendJSON(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('[ERROR]', err);
    sendJSON(res, 500, { error: err.message });
  }
});

initDB()
  .then(async () => {
    attachWSS(server);
    attachWSConteoBitacoras(server);
    const db = await getDB();
    startTurnoSweeper(db);
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
    process.exit(0);
  });
}
