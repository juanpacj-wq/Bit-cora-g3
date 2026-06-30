/**
 * Store de sesión PLUGGABLE para la cookie de login Entra.
 *
 *   SESSION_STORE=memory  -> MemoryStore (SOLO desarrollo)
 *   SESSION_STORE=mssql   -> tabla [auth].[AppSessions] en el MISMO SQL Server de bitácoras
 *
 * El MemoryStore por defecto de express-session NO sirve en producción: se borra al reiniciar
 * y no se comparte entre instancias. En prod usar mssql para que la sesión sobreviva reinicios.
 *
 * Reutiliza las MISMAS variables de conexión que db.js (DB_HOST/DB_NAME/DB_USER/DB_PASSWORD/
 * DB_PORT), incluida la sintaxis de instancia nombrada "host\\instancia". El esquema/tabla de
 * sesión viven aislados del esquema de negocio (no ensucian lov_bit/bitacora).
 *
 * Devuelve { store, kind }. Si store es undefined, express-session usa MemoryStore.
 */
const MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 30 * 24 * 60 * 60 * 1000);

function buildSqlConfig() {
  const rawHost = process.env.DB_HOST || '';
  let server = rawHost;
  let instanceName;
  if (rawHost.includes('\\')) [server, instanceName] = rawHost.split('\\');
  // AUD-07: mismo patrón env-driven que db.js. Default NO-rompedor (encrypt=false +
  // trustServerCertificate=true = comportamiento actual). En prod, endurecer con un certificado
  // válido en SQL Server + DB_ENCRYPT=true DB_TRUST_SERVER_CERT=false.
  const encrypt = process.env.DB_ENCRYPT === 'true';
  const trustServerCertificate = process.env.DB_TRUST_SERVER_CERT !== 'false';
  if (process.env.NODE_ENV === 'production' && !encrypt) {
    console.warn(
      '  ⚠  PRODUCCIÓN con tráfico SQL en CLARO (DB_ENCRYPT≠true): el blob de sesión con tokens MSAL ' +
      'viaja sin cifrar. Instala un certificado en SQL Server y configura DB_ENCRYPT=true DB_TRUST_SERVER_CERT=false.'
    );
  }
  return {
    server,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: instanceName ? undefined : Number(process.env.DB_PORT || 1433),
    options: {
      encrypt,
      trustServerCertificate,
      ...(instanceName ? { instanceName } : {}),
    },
  };
}

export async function buildSessionStore() {
  const kind = (process.env.SESSION_STORE || 'memory').toLowerCase();

  if (kind === 'mssql') {
    const { default: MSSQLStore } = await import('connect-mssql-v2');
    const { default: sql } = await import('mssql');
    const sqlConfig = buildSqlConfig();

    // Esquema + tabla saneados (solo los controla el operador vía env): defensa ante inyección en DDL.
    const schema = (process.env.SQL_SESSION_SCHEMA || 'auth').replace(/[^A-Za-z0-9_]/g, '');
    const table = (process.env.SQL_SESSION_TABLE || 'AppSessions').replace(/[^A-Za-z0-9_]/g, '');
    const qualified = `[${schema}].[${table}]`;

    // AUTO-PROVISIÓN: connect-mssql-v2 no crea schema ni tabla. Los creamos si faltan.
    const pool = new sql.ConnectionPool(sqlConfig);
    await pool.connect();
    await pool.request().batch(
      `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${schema}') EXEC('CREATE SCHEMA [${schema}]');`
    );
    await pool.request().batch(
      `IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id ` +
      `WHERE s.name = '${schema}' AND t.name = '${table}') ` +
      `CREATE TABLE ${qualified}([sid] nvarchar(255) NOT NULL PRIMARY KEY, ` +
      `[session] nvarchar(max) NOT NULL, [expires] datetime NOT NULL);`
    );
    // AUD-32 (BIT-AUDSEG-2026-001): índice sobre [expires] — `autoRemove` barre las sesiones
    // vencidas filtrando por esta columna; sin índice es un scan completo de la tabla. Idempotente.
    await pool.request().batch(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes ` +
      `WHERE name = 'IX_${table}_expires' AND object_id = OBJECT_ID('${qualified}')) ` +
      `CREATE INDEX [IX_${table}_expires] ON ${qualified}([expires]);`
    );
    await pool.close();

    // AUD-13: cifrado en reposo del blob de sesión (tokens MSAL + identidad). Subclase del store
    // que cifra en set / descifra en get; filas legacy en claro siguen leyéndose (migración suave).
    const { makeEncryptedStoreClass } = await import('./sessionCrypto.js');
    const EncryptedMSSQLStore = makeEncryptedStoreClass(MSSQLStore);
    const store = new EncryptedMSSQLStore(sqlConfig, {
      table: qualified,
      ttl: MAX_AGE_MS,
      autoRemove: true,
      autoRemoveInterval: 1000 * 60 * 60, // cada 1h
    });
    store.on('error', (e) => console.error('[session-store mssql]', e.message));
    return { store, kind };
  }

  // memory (DEV). AUD-21: devolvemos una instancia EXPLÍCITA de MemoryStore (no undefined) para
  // poder COMPARTIRLA con el resolver de sesión del WebSocket (auth/wsSession.js). Si dejáramos que
  // express-session creara su MemoryStore interno, el handshake WS no tendría cómo leer la sesión.
  const { default: session } = await import('express-session');
  return { store: new session.MemoryStore(), kind: 'memory' };
}
