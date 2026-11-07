// Acceso con huella o rostro (WebAuthn / "passkey" del dispositivo).
//
// Cómo funciona: el sistema del teléfono o de la computadora (Face ID, huella, Windows Hello) verifica a la persona;
// la aplicación NUNCA recibe la cara ni la huella, solo una firma criptográfica. Al activarlo se guarda la clave
// PÚBLICA de este dispositivo y, al desbloquear, se comprueba la firma, el desafío, el origen y que el sistema haya
// verificado a la persona (bandera UV). Protege el uso de la sesión abierta en este dispositivo; no reemplaza a la
// contraseña de Supabase (si se cierra la sesión, se vuelve a entrar con contraseña).

const KEY = 'deposito-bio';
const RP_NAME = 'DepositoAPP';

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

// ---------- Registro local (solo claves públicas) ----------
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* sin espacio */ } };
export const bioEnabled = (uid) => !!load()[uid];
// Cuenta(s) con huella activada en este dispositivo: [{ uid, email }]
export const bioAccounts = () => Object.entries(load()).map(([uid, r]) => ({ uid, email: r.email || '' }));

// Cuánto tiempo fuera de la aplicación antes de volver a pedir huella o rostro (minutos)
export const LOCK_CHOICES = [5, 10, 15, 30, 60];
export function bioLockMinutes() { const n = Number(localStorage.getItem('deposito-bio-min')); return LOCK_CHOICES.includes(n) ? n : 10; }
export function setBioLockMinutes(n) { try { localStorage.setItem('deposito-bio-min', String(n)); } catch { /* sin espacio */ } }
// Última vez que la persona estuvo usando la app (para no pedir la huella si volvió enseguida)
export function touchActive() { try { localStorage.setItem('deposito-bio-active', String(Date.now())); } catch { /* sin espacio */ } }
export function recentlyActive() { const t = Number(localStorage.getItem('deposito-bio-active') || 0); return t > 0 && Date.now() - t < bioLockMinutes() * 60 * 1000; }
// «Cerrar sesión» con huella activada solo bloquea: la marca sobrevive al cierre de la app
export const softLockGet = () => localStorage.getItem('deposito-bio-soft') === '1';
export function softLockSet(on) { try { if (on) localStorage.setItem('deposito-bio-soft', '1'); else localStorage.removeItem('deposito-bio-soft'); } catch { /* sin espacio */ } }
export function bioDisable(uid) { const o = load(); delete o[uid]; save(o); }

export async function bioSupported() {
  try { return !!(window.isSecureContext && window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch { return false; }
}
const rand = (n = 32) => crypto.getRandomValues(new Uint8Array(n));

const uuidBytes = (uuid) => Uint8Array.from(String(uuid).replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)));
export const bioServerRegistered = (uid) => !!load()[uid]?.server;
export const bioCredId = (uid) => load()[uid]?.id || null;

// register: función que guarda la clave pública en la base (RPC register_passkey); la entrega la pantalla de la cuenta
export async function bioEnable(user, { register, label } = {}) {
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: RP_NAME, id: location.hostname },
    user: { id: uuidBytes(user.id), name: user.email || user.id, displayName: user.full_name || user.email || 'Usuario' },
    challenge: rand(),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
    timeout: 60000, attestation: 'none',
  } });
  const r = cred?.response; const spki = r?.getPublicKey?.();
  if (!spki) throw new Error('Este dispositivo no permite guardar la clave de acceso. Actualice el navegador.');
  const rec = { email: user.email || '', id: b64u(cred.rawId), spki: b64u(spki), alg: r.getPublicKeyAlgorithm?.() ?? -7, at: new Date().toISOString(), server: false };
  const o = load(); o[user.id] = rec; save(o);
  try {
    await bioVerify(user.id);                                    // prueba inmediata en este dispositivo
    if (register) { await register({ id: rec.id, public_key: rec.spki, alg: rec.alg, label }); o[user.id].server = true; save(o); }   // queda registrada en la base
  } catch (e) { bioDisable(user.id); throw e; }
}

// Ingreso sin correo ni contraseña: el servidor valida la firma y devuelve un token de un solo uso (token_hash)
export async function passkeyLogin({ baseUrl, anonKey }) {
  const call = async (body) => {
    const res = await fetch(`${baseUrl}/functions/v1/deposito-passkey`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status });
    return data;
  };
  const ch = await call({ action: 'challenge' });
  const a = await navigator.credentials.get({ publicKey: { challenge: fromB64u(ch.challenge), rpId: location.hostname, timeout: 60000, userVerification: 'required' } });
  const r = a.response;
  const out = await call({ action: 'login', id: ch.id, credential_id: b64u(a.rawId), authenticator_data: b64u(r.authenticatorData), client_data_json: b64u(r.clientDataJSON), signature: b64u(r.signature) });
  return out.token_hash;
}

export async function bioVerify(uid) {
  const rec = load()[uid]; if (!rec) throw new Error('No hay acceso biométrico configurado');
  const challenge = rand();
  const a = await navigator.credentials.get({ publicKey: {
    challenge, rpId: location.hostname, timeout: 60000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: fromB64u(rec.id), transports: ['internal'] }],
  } });
  const r = a.response;
  await verifyAssertion({ spki: fromB64u(rec.spki), alg: rec.alg, authData: r.authenticatorData, clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature), challenge, rpId: location.hostname, origin: location.origin });
  return true;
}

// ---------- Pantalla de bloqueo ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let lockP = null;

// Devuelve una promesa: true = desbloqueado; false = la persona eligió usar la contraseña.
export function bioLock({ uid, label, icon, logoSvg, onPassword, maxFails = 5 }) {
  if (lockP) return lockP;
  lockP = new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'lockscreen'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Aplicación bloqueada');
    ov.innerHTML = `<div class="aurora"></div><div class="lockbox">
      <div class="brand"><div class="logo">${logoSvg || ''}</div><div><b>Depósito</b><div class="muted small">Aplicación bloqueada</div></div></div>
      <div class="card stack lockcard"><p class="muted small ellipsis">${esc(label)}</p>
        <button type="button" class="lockbtn" id="lk" aria-label="Desbloquear con huella o rostro">${icon('fingerprint')}</button>
        <b>Toque para desbloquear</b><p class="muted small">Con su huella o su rostro, usando el sensor del dispositivo.</p>
        <p class="notice bad hidden" id="lke" role="alert"></p>
        <button type="button" class="btn ghost block" id="lkp">${icon('lock')} Usar mi contraseña</button></div></div>`;
    document.body.append(ov);
    const btn = ov.querySelector('#lk'); const err = ov.querySelector('#lke'); let working = false; let fails = 0;
    const done = (v) => { ov.remove(); lockP = null; resolve(v); };
    const attempt = async () => {
      if (working) return; working = true; err.classList.add('hidden'); btn.classList.add('busy');
      try { await bioVerify(uid); done(true); return; }
      catch (e) {
        if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') fails++;   // cancelar no cuenta; una firma inválida sí
        else if (e?.name === 'NotAllowedError') fails += 0.5;
        if (fails >= maxFails) { done(false); onPassword?.(); return; }
        err.textContent = e?.name === 'NotAllowedError' ? 'No se pudo verificar. Vuelva a intentar o use su contraseña.' : 'No se pudo verificar la identidad. Vuelva a intentar.';
        err.classList.remove('hidden');
      } finally { working = false; btn.classList.remove('busy'); }
    };
    btn.addEventListener('click', attempt);
    ov.querySelector('#lkp').addEventListener('click', () => { done(false); onPassword?.(); });
    setTimeout(attempt, 250);        // intenta solo; en iPhone hace falta tocar el botón
  });
  return lockP;
}
