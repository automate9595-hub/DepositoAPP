import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { b64u, fromB64u, derToRaw, verifyAssertion } from '../supabase/functions/deposito-passkey/verify.js';

const subtle = webcrypto.subtle;
const enc = (s) => new TextEncoder().encode(s);
const sha = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const rawToDer = (raw) => { const enc1 = (v) => { let i = 0; while (i < 31 && v[i] === 0) i++; let x = v.slice(i); if (x[0] & 0x80) x = cat(Uint8Array.of(0), x); return cat(Uint8Array.of(0x02, x.length), x); }; const body = cat(enc1(raw.slice(0, 32)), enc1(raw.slice(32))); return cat(Uint8Array.of(0x30, body.length), body); };

async function makeEs256({ flags = 0x05, rpId = 'ejemplo.github.io', origin = 'https://ejemplo.github.io', type = 'webauthn.get', badChallenge = false, tamper = false } = {}) {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
  const challenge = webcrypto.getRandomValues(new Uint8Array(32));
  const clientDataJSON = enc(JSON.stringify({ type, challenge: badChallenge ? b64u(new Uint8Array(32)) : b64u(challenge), origin }));
  const authData = cat(await sha(enc(rpId)), Uint8Array.of(flags), new Uint8Array(4));
  const signed = cat(authData, await sha(clientDataJSON));
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signed));
  const signature = rawToDer(raw);
  if (tamper) signature[signature.length - 1] ^= 1;
  return { spki, alg: -7, authData, clientDataJSON, signature, challenge, rpId: 'ejemplo.github.io', origin: 'https://ejemplo.github.io' };
}

test('base64url ida y vuelta', () => {
  const b = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);
  assert.deepEqual([...fromB64u(b64u(b))], [...b]);
  assert.ok(!/[+/=]/.test(b64u(b)));
});

test('derToRaw produce 64 bytes y recupera r y s', () => {
  const raw = webcrypto.getRandomValues(new Uint8Array(64)); raw[0] = 0; raw[32] = 0xff;
  assert.deepEqual([...derToRaw(rawToDer(raw))], [...raw]);
});

test('acepta una autenticación ES256 válida con verificación de usuario', async () => {
  assert.equal(await verifyAssertion(await makeEs256(), subtle), true);
});

test('acepta RS256', async () => {
  const kp = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
  const challenge = webcrypto.getRandomValues(new Uint8Array(32));
  const clientDataJSON = enc(JSON.stringify({ type: 'webauthn.get', challenge: b64u(challenge), origin: 'https://x.io' }));
  const authData = cat(await sha(enc('x.io')), Uint8Array.of(0x05), new Uint8Array(4));
  const signature = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, cat(authData, await sha(clientDataJSON))));
  assert.equal(await verifyAssertion({ spki, alg: -257, authData, clientDataJSON, signature, challenge, rpId: 'x.io', origin: 'https://x.io' }, subtle), true);
});

test('rechaza: sin verificación de usuario, sin presencia, otro sitio, otro origen, desafío ajeno, firma alterada, tipo erróneo', async () => {
  await assert.rejects(verifyAssertion(await makeEs256({ flags: 0x01 }), subtle), /no verificó/);
  await assert.rejects(verifyAssertion(await makeEs256({ flags: 0x04 }), subtle), /presencia/);
  const other = await makeEs256({ rpId: 'otro.sitio' }); other.rpId = 'ejemplo.github.io';
  await assert.rejects(verifyAssertion(other, subtle), /sitio/);
  const o = await makeEs256(); o.origin = 'https://malo.com';
  await assert.rejects(verifyAssertion(o, subtle), /origen/);
  await assert.rejects(verifyAssertion(await makeEs256({ badChallenge: true }), subtle), /desafío/);
  await assert.rejects(verifyAssertion(await makeEs256({ tamper: true }), subtle), /firma/i);
  await assert.rejects(verifyAssertion(await makeEs256({ type: 'webauthn.create' }), subtle), /inesperada/);
});

test('rechaza una clave pública distinta a la registrada', async () => {
  const a = await makeEs256(); const b = await makeEs256();
  a.spki = b.spki;
  await assert.rejects(verifyAssertion(a, subtle), /firma/i);
});
