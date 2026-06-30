import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'secret-para-tests-de-cifrado-de-sesion';
const { encryptSession, decryptSession, isEncrypted, makeEncryptedStoreClass } = await import('../auth/sessionCrypto.js');

// AUD-13 — cifrado en reposo del blob de sesión.

test('encrypt → decrypt: round-trip recupera el texto', () => {
  const plain = JSON.stringify({ user: { oid: 'OID-XYZ' }, msalCache: 'token-secreto' });
  const enc = encryptSession(plain);
  assert.ok(isEncrypted(enc), 'debe llevar el prefijo enc1:');
  assert.ok(!enc.includes('OID-XYZ'), 'no debe quedar el oid en claro');
  assert.ok(!enc.includes('token-secreto'), 'no debe quedar el token en claro');
  assert.equal(decryptSession(enc), plain);
});

test('decryptSession: blob manipulado → lanza (GCM detecta el tampering)', () => {
  const enc = encryptSession('hola');
  const tampered = enc.slice(0, -4) + (enc.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptSession(tampered));
});

test('decryptSession: valor sin prefijo (legacy en claro) → lanza "no cifrado"', () => {
  assert.throws(() => decryptSession('{"user":{}}'), /no cifrado/);
  assert.equal(isEncrypted('{"user":{}}'), false);
});

// Subclase del store: simula la base (connect-mssql-v2) con un Map en memoria.
class MockBase {
  constructor() { this.rows = new Map(); }
  set(sid, obj, cb) { this.rows.set(sid, JSON.parse(JSON.stringify(obj))); if (cb) cb(); }
  get(sid, cb) { cb(null, this.rows.get(sid) || null); }
  all(cb) { cb(null, Object.fromEntries(this.rows)); }
}

test('store cifrado: set guarda __enc (sin identidad en claro) y get descifra', async () => {
  const Enc = makeEncryptedStoreClass(MockBase);
  const store = new Enc();
  await new Promise((r) => store.set('s1', { cookie: { path: '/' }, user: { oid: 'SECRET-OID' }, msalCache: 'TOK' }, r));
  const rowStr = JSON.stringify(store.rows.get('s1'));
  assert.ok(!rowStr.includes('SECRET-OID'), 'la fila no debe tener el oid en claro');
  assert.ok(!rowStr.includes('TOK'), 'la fila no debe tener el token en claro');
  assert.ok(isEncrypted(store.rows.get('s1').__enc), 'la fila debe llevar __enc cifrado');
  const got = await new Promise((r) => store.get('s1', (e, o) => r(o)));
  assert.equal(got.user.oid, 'SECRET-OID');
  assert.equal(got.msalCache, 'TOK');
});

test('store cifrado: fila LEGACY en claro se lee tal cual (migración suave)', async () => {
  const Enc = makeEncryptedStoreClass(MockBase);
  const store = new Enc();
  store.rows.set('legacy', { cookie: {}, user: { oid: 'LEG-OID' } }); // sin __enc (pre-cifrado)
  const got = await new Promise((r) => store.get('legacy', (e, o) => r(o)));
  assert.equal(got.user.oid, 'LEG-OID');
});
