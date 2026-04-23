import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Parámetros scrypt: N=2^15, r=8, p=1. Usa ~32 MB por hash y ~30 ms en HW moderno.
// Dentro de los defaults de Node (maxmem=32 MB), se deja holgura explícita para evitar el error
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS. OWASP acepta N>=2^14; 2^15 es estándar conservador.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAX_MEM = 256 * N * R;  // ~64 MB — holgura frente al mínimo 128*N*r

// Formato almacenado: `scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>`
// Incluye los parámetros para permitir futura rotación sin romper hashes viejos.
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password debe ser string no vacío');
  }
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  try {
    const derived = await scryptAsync(plain, salt, expected.length, { N: n, r, p, maxmem: 256 * n * r });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Prefijo almacenado para distinguir hashes ya migrados de contraseñas en texto plano.
export const HASH_PREFIX = 'scrypt$';
