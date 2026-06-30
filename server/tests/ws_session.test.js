import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'cookie-signature';
import { sidFromCookie, userFromCookie } from '../auth/wsSession.js';

// AUD-21 — verificación pura del resolver de sesión del handshake WS (sin red/BD real).
const SECRET = 'secreto-de-prueba-32-bytes-abcdef';
const NAME = 'bitacora.sid';

function reqConCookie(value) {
  return { headers: { cookie: `${NAME}=${encodeURIComponent(value)}` } };
}
const ctx = (overrides = {}) => ({ secret: SECRET, cookieName: NAME, ...overrides });

test('sidFromCookie: cookie firmada válida → devuelve el sid', () => {
  const sid = 'abc123';
  const signed = 's:' + sign(sid, SECRET);
  assert.equal(sidFromCookie(reqConCookie(signed), ctx()), sid);
});

test('sidFromCookie: firma manipulada → null', () => {
  const signed = 's:' + sign('abc123', SECRET);
  const tampered = signed.slice(0, -3) + 'xyz'; // corrompe la firma
  assert.equal(sidFromCookie(reqConCookie(tampered), ctx()), null);
});

test('sidFromCookie: firmada con OTRO secreto → null', () => {
  const signed = 's:' + sign('abc123', 'otro-secreto-distinto-aaaaaaaaaa');
  assert.equal(sidFromCookie(reqConCookie(signed), ctx()), null);
});

test('sidFromCookie: sin header de cookie → null', () => {
  assert.equal(sidFromCookie({ headers: {} }, ctx()), null);
});

test('sidFromCookie: nombre de cookie distinto → null', () => {
  const signed = 's:' + sign('abc123', SECRET);
  assert.equal(sidFromCookie({ headers: { cookie: `otra=${encodeURIComponent(signed)}` } }, ctx()), null);
});

test('sidFromCookie: valor sin prefijo "s:" (no firmado) → null', () => {
  assert.equal(sidFromCookie(reqConCookie('abc123'), ctx()), null);
});

test('sidFromCookie: sin contexto (auth no arrancó) → null (fail-closed)', () => {
  const signed = 's:' + sign('abc123', SECRET);
  assert.equal(sidFromCookie(reqConCookie(signed), null), null);
});

test('userFromCookie: store devuelve la sesión con user.oid → user', async () => {
  const sid = 'sess-1';
  const fakeStore = { get: (id, cb) => cb(null, id === sid ? { user: { oid: 'OID-1', usuario_id: 7 } } : null) };
  const u = await userFromCookie(reqConCookie('s:' + sign(sid, SECRET)), ctx({ store: fakeStore }));
  assert.equal(u.oid, 'OID-1');
});

test('userFromCookie: sesión sin user.oid → null', async () => {
  const fakeStore = { get: (id, cb) => cb(null, { cookie: {} }) };
  const u = await userFromCookie(reqConCookie('s:' + sign('sess-2', SECRET)), ctx({ store: fakeStore }));
  assert.equal(u, null);
});

test('userFromCookie: cookie manipulada → null SIN tocar el store', async () => {
  let llamado = false;
  const fakeStore = { get: (id, cb) => { llamado = true; cb(null, { user: { oid: 'X' } }); } };
  const signed = 's:' + sign('sess-3', SECRET);
  const u = await userFromCookie(reqConCookie(signed.slice(0, -2) + 'zz'), ctx({ store: fakeStore }));
  assert.equal(u, null);
  assert.equal(llamado, false);
});
