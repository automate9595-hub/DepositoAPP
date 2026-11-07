// Verificación de una autenticación WebAuthn (huella / rostro). Código puro, sin dependencias:
// lo usa la Edge Function deposito-passkey y se prueba con node --test (tests/bio.test.mjs).
// Debe mantenerse igual a la sección «Utilidades puras» de src/js/bio.js.

// ---------- Utilidades puras (se prueban con node --test) ----------
export const b64u = (buf) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const fromB64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

// Firma ECDSA en formato DER (la que entrega el autenticador) → r||s de 64 bytes (la que pide WebCrypto)
export function derToRaw(der) {
  const d = der instanceof Uint8Array ? der : new Uint8Array(der);
  if (d[0] !== 0x30) throw new Error('Firma con formato inválido');
  let i = 2; if (d[1] & 0x80) i = 2 + (d[1] & 0x7f);
  const read = () => {
    if (d[i] !== 0x02) throw new Error('Firma con formato inválido');
    const len = d[i + 1]; let v = d.slice(i + 2, i + 2 + len); i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = read(); const s = read();
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}

const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
const eq = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);

// Comprueba una respuesta de autenticación de WebAuthn. Devuelve true o lanza un Error con el motivo.
export async function verifyAssertion({ spki, alg, authData, clientDataJSON, signature, challenge, rpId, origin }, subtle = globalThis.crypto.subtle) {
  const cd = JSON.parse(new TextDecoder().decode(clientDataJSON));
  if (cd.type !== 'webauthn.get') throw new Error('Respuesta inesperada del dispositivo');
  if (cd.challenge !== b64u(challenge)) throw new Error('El desafío no coincide');
  if (origin && cd.origin !== origin) throw new Error('El origen no coincide');
  const ad = authData instanceof Uint8Array ? authData : new Uint8Array(authData);
  if (ad.length < 37) throw new Error('Datos de autenticación incompletos');
  const rpHash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  if (!eq(ad.slice(0, 32), rpHash)) throw new Error('El sitio no coincide');
  if (!(ad[32] & 0x01)) throw new Error('No hubo presencia del usuario');
  if (!(ad[32] & 0x04)) throw new Error('El dispositivo no verificó la huella o el rostro');
  const cdHash = new Uint8Array(await subtle.digest('SHA-256', clientDataJSON));
  const signed = cat(ad, cdHash);
  let valid;
  if (alg === -7) {
    const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signed);
  } else if (alg === -257) {
    const key = await subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  } else throw new Error('Algoritmo de firma no admitido');
  if (!valid) throw new Error('La firma no es válida');
  return true;
}

