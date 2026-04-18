import http from 'http';
import sql from 'mssql';
import { initDB, getDB } from './db.js';
import { CORS_HEADERS, parseBody, sendJSON } from './utils/http.js';
import { getTurnoColombia } from './utils/turno.js';
import { loadSession } from './middleware/auth.js';
import { hasPermisoBitacora, isJdT, plantaMatch, canEditarRegistro } from './middleware/permissions.js';
import { validateCamposExtra, computeCamposAuto } from './utils/campos.js';
import { findAutorizacion, upsertAutorizacion, hasNotificarDashboard } from './utils/notificador.js';

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

    // POST /api/auth/login
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { email, password } = await parseBody(req);
      if (!email || !password) {
        return sendJSON(res, 400, { error: 'email y password son requeridos' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('email', sql.NVarChar(200), email)
        .input('password', sql.NVarChar(200), password)
        .query(`
          SELECT usuario_id, nombre_completo, email, es_jefe_planta, es_jdt_default, activo
          FROM lov_bit.usuario
          WHERE email = @email AND password_hash = @password AND activo = 1
        `);
      if (result.recordset.length === 0) {
        return sendJSON(res, 401, { error: 'Credenciales inválidas' });
      }
      return sendJSON(res, 200, { usuario: result.recordset[0] });
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
      const insert = await db.request()
        .input('usuario_id', sql.Int, usuario_id)
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('cargo_id', sql.Int, cargo_id)
        .input('turno', sql.TinyInt, turno)
        .query(`
          INSERT INTO bitacora.sesion_activa (usuario_id, planta_id, cargo_id, turno)
          OUTPUT INSERTED.*
          VALUES (@usuario_id, @planta_id, @cargo_id, @turno)
        `);
      return sendJSON(res, 200, { sesion: insert.recordset[0] });
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
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/auth/heartbeat
    if (pathname === '/api/auth/heartbeat' && method === 'POST') {
      const { sesion_id } = await parseBody(req);
      if (!sesion_id) {
        return sendJSON(res, 400, { error: 'sesion_id es requerido' });
      }
      const db = await getDB();
      await db.request()
        .input('sesion_id', sql.Int, sesion_id)
        .query(`
          UPDATE bitacora.sesion_activa
          SET ultima_actividad = GETDATE()
          WHERE sesion_id = @sesion_id AND activa = 1
        `);
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/auth/sesiones-activas?planta_id=GEC3
    if (pathname === '/api/auth/sesiones-activas' && method === 'GET') {
      const planta_id = url.searchParams.get('planta_id');
      if (!planta_id) {
        return sendJSON(res, 400, { error: 'planta_id es requerido' });
      }
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT
            s.sesion_id, s.usuario_id, s.planta_id, s.cargo_id, s.turno,
            s.inicio_sesion, s.ultima_actividad, s.activa,
            u.nombre_completo, u.email, u.es_jefe_planta, u.es_jdt_default,
            c.nombre AS cargo_nombre, c.solo_lectura
          FROM bitacora.sesion_activa s
          INNER JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id
          INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
          WHERE s.planta_id = @planta_id AND s.activa = 1
          ORDER BY s.inicio_sesion DESC
        `);
      return sendJSON(res, 200, { sesiones: result.recordset });
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
        SELECT cargo_id, nombre, solo_lectura
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
               ing.nombre_completo AS ingeniero_nombre,
               jdt.nombre_completo AS jdt_nombre,
               jf.nombre_completo AS jefe_nombre
        FROM bitacora.registro_activo r
        INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
        INNER JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
        INNER JOIN lov_bit.usuario ing ON ing.usuario_id = r.ingeniero_id
        LEFT JOIN lov_bit.usuario jdt ON jdt.usuario_id = r.jdt_turno_id
        INNER JOIN lov_bit.usuario jf ON jf.usuario_id = r.jefe_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.fecha_evento ASC
      `);
      return sendJSON(res, 200, { registros: result.recordset });
    }

    // POST /api/registros
    if (pathname === '/api/registros' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      const body = await parseBody(req);
      const { bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id } = body;
      if (!bitacora_id || !planta_id || !fecha_evento || !turno || !tipo_evento_id || !detalle) {
        return sendJSON(res, 400, { error: 'Campos requeridos faltantes (detalle, fecha_evento, turno, bitacora_id, planta_id, tipo_evento_id)' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede crear registros en otra planta' });
      }
      if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
        return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
      }
      if (new Date(fecha_evento).getTime() - Date.now() > 5 * 60 * 1000) {
        return sendJSON(res, 400, { error: 'fecha_evento no puede estar más de 5 min en el futuro' });
      }
      const ingeniero_id = sesion.usuario_id;
      const db = await getDB();

      const teCheck = await db.request()
        .input('te', sql.Int, tipo_evento_id)
        .input('b', sql.Int, bitacora_id)
        .query(`SELECT 1 AS ok FROM lov_bit.tipo_evento WHERE tipo_evento_id = @te AND bitacora_id = @b`);
      if (teCheck.recordset.length === 0) {
        return sendJSON(res, 400, { error: 'tipo_evento_id no pertenece a la bitácora' });
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
      const camposStrValidated = camposFinal ? JSON.stringify(camposFinal) : null;

      // Resolver JdT
      const jdtSesion = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT TOP 1 s.usuario_id
          FROM bitacora.sesion_activa s
          INNER JOIN lov_bit.cargo c ON c.cargo_id = s.cargo_id
          WHERE s.planta_id = @planta_id AND s.activa = 1 AND c.nombre = 'Jefe de Turno'
          ORDER BY s.inicio_sesion DESC
        `);
      let jdt_turno_id = jdtSesion.recordset[0]?.usuario_id || null;
      if (!jdt_turno_id) {
        const fallback = await db.request().query(`
          SELECT TOP 1 usuario_id FROM lov_bit.usuario WHERE es_jdt_default = 1 AND activo = 1
        `);
        jdt_turno_id = fallback.recordset[0]?.usuario_id || null;
      }

      // Resolver jefe
      const jefeRes = await db.request().query(`
        SELECT TOP 1 usuario_id FROM lov_bit.usuario WHERE es_jefe_planta = 1 AND activo = 1
      `);
      const jefe_id = jefeRes.recordset[0]?.usuario_id;
      if (!jefe_id) return sendJSON(res, 500, { error: 'No hay jefe de planta configurado' });

      const camposStr = camposStrValidated;
      const notificar = hasNotificarDashboard(bit.definicion_campos);
      const fechaEventoDate = new Date(fecha_evento);

      const transaction = new sql.Transaction(db);
      await transaction.begin();
      try {
        if (notificar && camposFinal) {
          const periodo = camposFinal.periodo;
          const valor = camposFinal.valor_autorizado_mw;
          if (periodo && valor != null) {
            const existente = await findAutorizacion(transaction, {
              planta_id, fecha: fechaEventoDate, periodo,
            });
            if (existente && existente.activa) {
              await transaction.rollback();
              return sendJSON(res, 409, {
                error: 'Ya existe autorización vigente para este periodo',
                autorizacion_id: existente.autorizacion_id,
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
          .input('ingeniero_id', sql.Int, ingeniero_id)
          .input('jdt_turno_id', sql.Int, jdt_turno_id)
          .input('jefe_id', sql.Int, jefe_id)
          .query(`
            INSERT INTO bitacora.registro_activo
              (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingeniero_id, jdt_turno_id, jefe_id, creado_por)
            OUTPUT INSERTED.*
            VALUES (@bitacora_id, @planta_id, @fecha_evento, @turno, @detalle, @campos_extra, @tipo_evento_id,
                    'borrador', @ingeniero_id, @jdt_turno_id, @jefe_id, @ingeniero_id)
          `);
        const registro = ins.recordset[0];

        if (notificar && camposFinal) {
          const periodo = camposFinal.periodo;
          const valor = camposFinal.valor_autorizado_mw;
          if (periodo && valor != null) {
            await upsertAutorizacion(transaction, {
              planta_id,
              fecha: fechaEventoDate,
              periodo,
              valor,
              jdt_id: jdt_turno_id,
              jefe_id,
              registro_origen_id: registro.registro_id,
            });
          }
        }

        await transaction.commit();
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
        .query(`SELECT registro_id, estado, bitacora_id, planta_id, ingeniero_id FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
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

      let camposStr = null;
      if (campos_extra !== undefined && campos_extra !== null) {
        const bitRes = await db.request()
          .input('bitacora_id', sql.Int, reg.bitacora_id)
          .query(`SELECT definicion_campos FROM lov_bit.bitacora WHERE bitacora_id = @bitacora_id`);
        const validation = validateCamposExtra(bitRes.recordset[0]?.definicion_campos, campos_extra);
        if (!validation.ok) {
          return sendJSON(res, 400, { error: 'campos_extra inválido', detalles: validation.errors });
        }
        const camposFinal = validation.definicion ? computeCamposAuto(validation.definicion, validation.data) : validation.data;
        camposStr = camposFinal ? JSON.stringify(camposFinal) : null;
      }

      const upd = await db.request()
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
      return sendJSON(res, 200, { registro: upd.recordset[0] });
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

    // POST /api/cierre/bitacora
    if (pathname === '/api/cierre/bitacora' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!isJdT(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno puede cerrar bitácoras' });
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
        const insReq = new sql.Request(transaction);
        const insResult = await insReq
          .input('bitacora_id', sql.Int, bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .input('cerrado_por', sql.Int, cerrado_por)
          .query(`
            INSERT INTO bitacora.registro_historico
              (registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
               estado, ingeniero_id, jdt_turno_id, jefe_id, creado_por, creado_en,
               modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
            SELECT registro_id, bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                   'cerrado', ingeniero_id, jdt_turno_id, jefe_id, creado_por, creado_en,
                   modificado_por, modificado_en, @cerrado_por, GETDATE(), CAST(GETDATE() AS DATE)
            FROM bitacora.registro_activo
            WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador';
          `);

        const delReq = new sql.Request(transaction);
        await delReq
          .input('bitacora_id', sql.Int, bitacora_id)
          .input('planta_id', sql.VarChar(10), planta_id)
          .query(`
            DELETE FROM bitacora.registro_activo
            WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador';
          `);

        await transaction.commit();
        return sendJSON(res, 200, { registros_cerrados: insResult.rowsAffected[0] || 0 });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }

    // POST /api/cierre/masivo
    if (pathname === '/api/cierre/masivo' && method === 'POST') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!isJdT(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno puede cerrar bitácoras' });
      const { planta_id } = await parseBody(req);
      if (!planta_id) {
        return sendJSON(res, 400, { error: 'planta_id es requerido' });
      }
      if (!plantaMatch(sesion, planta_id)) {
        return sendJSON(res, 403, { error: 'No puede cerrar bitácoras de otra planta' });
      }
      const cerrado_por = sesion.usuario_id;
      const pool = await getDB();
      const listRes = await pool.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .query(`
          SELECT DISTINCT r.bitacora_id, b.nombre
          FROM bitacora.registro_activo r
          INNER JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
          WHERE r.planta_id = @planta_id AND r.estado = 'borrador'
        `);

      const resumen = [];
      for (const row of listRes.recordset) {
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
          const insReq = new sql.Request(transaction);
          const insResult = await insReq
            .input('bitacora_id', sql.Int, row.bitacora_id)
            .input('planta_id', sql.VarChar(10), planta_id)
            .input('cerrado_por', sql.Int, cerrado_por)
            .query(`
              INSERT INTO bitacora.registro_historico
                (bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                 estado, ingeniero_id, jdt_turno_id, jefe_id, creado_por, creado_en,
                 modificado_por, modificado_en, cerrado_por, cerrado_en, fecha_cierre_operativo)
              SELECT bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id,
                     'cerrado', ingeniero_id, jdt_turno_id, jefe_id, creado_por, creado_en,
                     modificado_por, modificado_en, @cerrado_por, GETDATE(), CAST(GETDATE() AS DATE)
              FROM bitacora.registro_activo
              WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador';
            `);
          const delReq = new sql.Request(transaction);
          await delReq
            .input('bitacora_id', sql.Int, row.bitacora_id)
            .input('planta_id', sql.VarChar(10), planta_id)
            .query(`
              DELETE FROM bitacora.registro_activo
              WHERE bitacora_id = @bitacora_id AND planta_id = @planta_id AND estado = 'borrador';
            `);
          await transaction.commit();
          resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, registros_cerrados: insResult.rowsAffected[0] || 0 });
        } catch (err) {
          await transaction.rollback();
          resumen.push({ bitacora_id: row.bitacora_id, nombre: row.nombre, error: err.message });
        }
      }
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
        .query(`SELECT registro_id, estado, bitacora_id, planta_id, ingeniero_id FROM bitacora.registro_activo WHERE registro_id = @registro_id`);
      if (check.recordset.length === 0) return sendJSON(res, 404, { error: 'Registro no encontrado' });
      const reg = check.recordset[0];
      if (reg.estado !== 'borrador') {
        return sendJSON(res, 409, { error: 'Solo se pueden eliminar registros en borrador' });
      }
      if (!(await canEditarRegistro(sesion, reg))) {
        return sendJSON(res, 403, { error: 'Sin permiso para eliminar este registro' });
      }

      await db.request()
        .input('registro_id', sql.Int, registro_id)
        .query(`
          UPDATE bitacora.autorizacion_dashboard SET activa = 0 WHERE registro_origen_id = @registro_id;
          DELETE FROM bitacora.registro_activo WHERE registro_id = @registro_id AND estado = 'borrador';
        `);
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
      if (params.get('ingeniero_id')) { addInput('ingeniero_id', sql.Int, parseInt(params.get('ingeniero_id'), 10)); where.push('ingeniero_id = @ingeniero_id'); }
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
    if (pathname === '/api/autorizaciones' && method === 'GET') {
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
                 a.valor_autorizado_mw, a.jdt_id, a.jefe_id, a.activa, a.creado_en,
                 jdt.nombre_completo AS jdt_nombre,
                 jf.nombre_completo AS jefe_nombre
          FROM bitacora.autorizacion_dashboard a
          INNER JOIN lov_bit.usuario jdt ON jdt.usuario_id = a.jdt_id
          INNER JOIN lov_bit.usuario jf ON jf.usuario_id = a.jefe_id
          WHERE a.planta_id = @planta_id AND a.fecha = @fecha AND a.activa = 1
          ORDER BY a.periodo
        `);
      return sendJSON(res, 200, { autorizaciones: result.recordset });
    }

    // GET /api/autorizaciones/:planta_id/:fecha/:periodo
    const authLookup = pathname.match(/^\/api\/autorizaciones\/([^/]+)\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/(\d+)$/);
    if (authLookup && method === 'GET') {
      const [, planta_id, fecha, periodoStr] = authLookup;
      const db = await getDB();
      const result = await db.request()
        .input('planta_id', sql.VarChar(10), planta_id)
        .input('fecha', sql.Date, new Date(fecha))
        .input('periodo', sql.TinyInt, parseInt(periodoStr, 10))
        .query(`
          SELECT a.*, jdt.nombre_completo AS jdt_nombre, jf.nombre_completo AS jefe_nombre
          FROM bitacora.autorizacion_dashboard a
          INNER JOIN lov_bit.usuario jdt ON jdt.usuario_id = a.jdt_id
          INNER JOIN lov_bit.usuario jf ON jf.usuario_id = a.jefe_id
          WHERE a.planta_id = @planta_id AND a.fecha = @fecha
            AND a.periodo = @periodo AND a.activa = 1
        `);
      if (result.recordset.length === 0) {
        return sendJSON(res, 404, { error: 'Autorización no encontrada' });
      }
      return sendJSON(res, 200, { autorizacion: result.recordset[0] });
    }

    // DELETE /api/autorizaciones/:id
    const authDel = pathname.match(/^\/api\/autorizaciones\/(\d+)$/);
    if (authDel && method === 'DELETE') {
      const sesion = await loadSession(req);
      if (!sesion) return sendJSON(res, 401, { error: 'Sesión no válida' });
      if (!isJdT(sesion)) return sendJSON(res, 403, { error: 'Solo el Jefe de Turno puede anular autorizaciones' });
      const autorizacion_id = parseInt(authDel[1], 10);
      const db = await getDB();
      const result = await db.request()
        .input('autorizacion_id', sql.Int, autorizacion_id)
        .input('planta_id', sql.VarChar(10), sesion.planta_id)
        .query(`
          UPDATE bitacora.autorizacion_dashboard
          SET activa = 0
          WHERE autorizacion_id = @autorizacion_id AND planta_id = @planta_id
        `);
      if (!result.rowsAffected[0]) {
        return sendJSON(res, 404, { error: 'Autorización no encontrada' });
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
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[SERVER] Escuchando en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Error de conexión:', err);
    process.exit(1);
  });
