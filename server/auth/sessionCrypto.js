/**
 * AUD-13 — Cifrado en reposo del blob de sesión ([auth].[AppSessions]).
 *
 * El store guardaba el JSON de la sesión EN CLARO, incluida la caché de tokens MSAL (access/refresh
 * tokens reutilizables) y la identidad. Un dump de la BD / backup robado / o el propio canal SQL sin
 * TLS (AUD-07) exponían esos tokens. Ahora el contenido sensible se cifra con AES-256-GCM antes de
 * escribirse y se descifra al leerse.
 *
 * Diseño:
 *  - Solo se cifra para el store MSSQL (el de memoria es dev y no persiste a disco).
 *  - El subclass envuelve set/get: escribe `{ cookie, __enc }` — `cookie` (metadatos no secretos:
 *    expiración/flags) queda visible porque el store calcula el vencimiento de ahí; identidad +
 *    tokens viven cifrados en `__enc`. En `get`, descifra `__enc`; si la fila es LEGACY (en claro,
 *    pre-cifrado) la devuelve tal cual → migración sin downtime (se re-cifra en el próximo `set`).
 *  - Clave: `SESSION_ENC_KEY` (hex de 64 = 32 bytes) si está; si no, se DERIVA de `SESSION_SECRET`
 *    (sha256) para no exigir config nueva. Rotar la clave invalida sesiones (descifrado falla →
 *    se tratan como inexistentes → re-login), comportamiento aceptable.
 */
import crypto from 'crypto';

const MAGIC = 'enc1:';
let _key = null;

function key() {
  if (_key) return _key;
  const explicit = process.env.SESSION_ENC_KEY;
  if (explicit && /^[0-9a-fA-F]{64}$/.test(explicit)) {
    _key = Buffer.from(explicit, 'hex');
  } else {
    const secret = process.env.SESSION_SECRET || '';
    _key = crypto.createHash('sha256').update('appsession-enc:' + secret).digest(); // 32 bytes
  }
  return _key;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(MAGIC);
}

export function encryptSession(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MAGIC + Buffer.concat([iv, tag, ct]).toString('base64'); // [iv(12)][tag(16)][ciphertext]
}

export function decryptSession(value) {
  if (!isEncrypted(value)) throw new Error('blob de sesión no cifrado');
  const raw = Buffer.from(value.slice(MAGIC.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag); // GCM: un blob manipulado o cifrado con otra clave falla en .final()
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Devuelve una subclase del store MSSQL que cifra el blob de sesión en reposo. Se le pasa la clase
 * base (connect-mssql-v2) para no acoplar este módulo a esa dependencia.
 */
export function makeEncryptedStoreClass(Base) {
  return class EncryptedMSSQLStore extends Base {
    set(sid, session, cb) {
      let wrapped;
      try {
        wrapped = { cookie: session.cookie, __enc: encryptSession(JSON.stringify(session)) };
      } catch (e) {
        return cb ? cb(e) : undefined;
      }
      return super.set(sid, wrapped, cb);
    }

    get(sid, cb) {
      return super.get(sid, (err, obj) => {
        if (err) return cb(err);
        if (!obj) return cb(null, null);
        if (isEncrypted(obj.__enc)) {
          try { return cb(null, JSON.parse(decryptSession(obj.__enc))); }
          catch { return cb(null, null); } // blob corrupto / clave rotada → sesión inválida
        }
        return cb(null, obj); // LEGACY en claro: se re-cifra al próximo set
      });
    }

    all(cb) {
      return super.all((err, sessions) => {
        if (err || !sessions) return cb(err, sessions);
        const dec = (s) => {
          if (s && isEncrypted(s.__enc)) { try { return JSON.parse(decryptSession(s.__enc)); } catch { return null; } }
          return s;
        };
        if (Array.isArray(sessions)) return cb(null, sessions.map(dec));
        const out = {};
        for (const k of Object.keys(sessions)) out[k] = dec(sessions[k]);
        return cb(null, out);
      });
    }
  };
}
