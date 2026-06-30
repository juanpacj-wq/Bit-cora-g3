// Saneamiento central de errores hacia el cliente.
//
// Motivación: el if-chain (server.js) y el wrapper de auth (auth/app.js) devolvían `err.message`
// crudo en las respuestas 5xx. Un fallo de conexión a la BD desde una red sin acceso producía
// `{ error: "Failed to connect to 192.168.17.20\\mssqlg3 in 15000ms" }`, que el frontend mostraba
// tal cual: (a) filtra el host/instancia/puerto de la BD (brecha de seguridad), y (b) es
// incomprensible para un operador.
//
// Este módulo clasifica el error técnico en una etiqueta apta para usuario final + un `codigo`
// estable (machine-readable, para que el frontend pueda ramificar) y NUNCA expone el mensaje
// crudo. El detalle técnico se sigue logueando server-side (responderError lo hace).
//
// Convención de shape de la respuesta de error:
//   { error: <texto amigable>, codigo: <slug estable>, mensaje: <mismo texto amigable> }
// `error`  → lo consume useApi (lo usa como Error.message en flujos genéricos).
// `mensaje`→ lo consume el modal DISP (CambiarEstadoModal.buildPopup, rama por defecto).
// `codigo` → slug estable por si el frontend quiere un popup específico (no expone internals).

import { CORS_HEADERS } from './http.js';

// Catálogo de etiquetas de usuario final. La clave es el `codigo` estable.
export const ETIQUETAS = {
  db_no_disponible: 'No se pudo conectar con la base de datos. Verifica tu conexión a la red corporativa e intenta de nuevo; si el problema continúa, contacta a soporte.',
  db_timeout: 'La base de datos tardó demasiado en responder. Intenta de nuevo en unos segundos.',
  db_error: 'Ocurrió un problema al procesar la información en la base de datos. Intenta de nuevo; si persiste, contacta a soporte.',
  cuerpo_invalido: 'La información enviada no tiene un formato válido. Recarga la página e intenta de nuevo.',
  cuerpo_demasiado_grande: 'La información enviada es demasiado grande. Reduce el tamaño e intenta de nuevo.',
  config_sistema: 'Hay un problema de configuración del sistema. Contacta a soporte.',
  error_interno: 'Ocurrió un error inesperado. Intenta de nuevo; si el problema continúa, contacta a soporte.',
};

// Códigos/nombres de tedious + mssql que representan "no se pudo establecer la conexión".
const CODIGOS_CONEXION = new Set([
  'ESOCKET', 'ETIMEOUT', 'ELOGIN', 'EINSTLOOKUP', 'ENOTFOUND',
  'ENOTOPEN', 'ECONNCLOSED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
]);

// Clasifica un error técnico en { status, codigo }. No arma el texto (eso lo hace mensajeUsuario)
// para poder reusar la clasificación desde el frontend-fallback conceptual y los tests.
export function clasificarError(err) {
  const name = err?.name || '';
  const code = err?.code || '';
  const msg = String(err?.message || '');

  // 1) Fallo de conexión a la BD (lo del screenshot). mssql lo envuelve como ConnectionError;
  //    tedious expone un `code`. "Failed to connect to <host> in Nms" matchea por mensaje.
  if (
    name === 'ConnectionError' ||
    (CODIGOS_CONEXION.has(code) && name !== 'RequestError') ||
    /failed to connect|connection .*(closed|lost)|getaddrinfo|socket hang up/i.test(msg)
  ) {
    return { status: 503, codigo: 'db_no_disponible' };
  }

  // 2) Timeout de un request a la BD (la conexión existe pero la query no respondió a tiempo).
  if (name === 'RequestError' && code === 'ETIMEOUT') {
    return { status: 503, codigo: 'db_timeout' };
  }

  // 3) Otro error de SQL (violación de constraint, conversión de tipos, deadlock, etc.).
  if (name === 'RequestError' || name === 'TransactionError' || err?.number != null) {
    return { status: 500, codigo: 'db_error' };
  }

  // 4) Cuerpo de la petición excede el tope de tamaño (AUD-15: parseBody aborta con este code).
  if (code === 'cuerpo_demasiado_grande') {
    return { status: 413, codigo: 'cuerpo_demasiado_grande' };
  }

  // 5) Cuerpo de la petición no es JSON válido (parseBody rechaza con SyntaxError).
  if (name === 'SyntaxError' || err instanceof SyntaxError) {
    return { status: 400, codigo: 'cuerpo_invalido' };
  }

  // 6) Desconocido: nunca exponemos el mensaje crudo.
  return { status: 500, codigo: 'error_interno' };
}

// Texto apto para usuario final correspondiente a un error técnico.
export function mensajeUsuario(err) {
  const { codigo } = clasificarError(err);
  return ETIQUETAS[codigo] || ETIQUETAS.error_interno;
}

// Responde un error saneado por el if-chain nativo (http). Loguea el detalle técnico server-side.
// `ctx` es una etiqueta corta del endpoint para el log (ej. '[POST /api/registros]').
export function responderError(res, err, ctx = '') {
  const { status, codigo } = clasificarError(err);
  const mensaje = ETIQUETAS[codigo] || ETIQUETAS.error_interno;
  console.error(`[ERROR]${ctx ? ' ' + ctx : ''} codigo=${codigo} status=${status} →`, err);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify({ error: mensaje, codigo, mensaje }));
  return undefined;
}

// Error-handling middleware para la capa Express (auth/app.js). express-session (store mssql) y los
// handlers de /auth pueden propagar errores vía next(err) — p.ej. la BD caída al cargar la sesión.
// Sin esto, el error subía al handler POR DEFECTO de Express, que renderiza el stack en HTML y FILTRA
// internals (el host/instancia de la BD: "Failed to connect to 192.168...\\mssqlg3"). Reusa el mismo
// saneamiento del if-chain (D-032). Debe registrarse de ÚLTIMO (firma de 4 args = error-handler).
export function expressErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  responderError(res, err, `[auth-layer] ${req?.method || ''} ${req?.originalUrl || req?.url || ''}`);
}
