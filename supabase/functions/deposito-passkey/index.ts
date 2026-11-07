// Supabase Edge Function: ingreso con huella o rostro (passkey) SIN correo ni contraseña.
// ARCHIVO ÚNICO: pegar todo este contenido en la función (no hace falta verify.js).
// Despliegue:  supabase functions deploy deposito-passkey --no-verify-jwt
//   (o, en el panel de Supabase: Edge Functions › deposito-passkey › desactivar «Verify JWT»)
// Usa los secretos SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY, que Supabase ya inyecta en las funciones.
// Opcional: secreto ALLOWED_ORIGINS = "https://tu-usuario.github.io" (varios separados por coma).
//
// Cómo valida: 1) entrega un desafío de un solo uso (3 minutos); 2) recibe la firma del dispositivo;
// 3) comprueba firma, desafío, sitio, origen y que el sistema verificó huella/rostro; 4) comprueba que la cuenta
// esté activa; 5) devuelve un token de un solo uso con el que la app abre la sesión.
// @ts-nocheck
// (Archivo único: incluye el verificador de firmas; no necesita ningún otro archivo.)

// ---------- Utilidades puras (se prueban con node --test) ----------
const b64u = (buf) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

// Firma ECDSA en formato DER (la que entrega el autenticador) → r||s de 64 bytes (la que pide WebCrypto)
function derToRaw(der) {
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
async function verifyAssertion({ spki, alg, authData, clientDataJSON, signature, challenge, rpId, origin }, subtle = globalThis.crypto.subtle) {
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


// ---------- Función ----------

const url = Deno.env.get('SUPABASE_URL')!;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
const H = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

const corsFor = (origin: string | null) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer',
  'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400', vary: 'origin',
});
const rest = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`rest ${r.status}`);
  return t ? JSON.parse(t) : null;
};

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsFor(origin);
  const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method === 'GET') return out({ ok: true, service: 'deposito-passkey' });   // para comprobar en el navegador que está publicada
  if (req.method !== 'POST') return out({ error: 'Método no permitido' }, 405);
  if (!url || !key) return out({ error: 'Faltan los secretos del servidor' }, 500);
  if (!origin || (allowed.length && !allowed.includes(origin))) return out({ error: 'Origen no permitido' }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return out({ error: 'Solicitud inválida' }, 400); }

  try {
    if (body.action === 'challenge') {
      await rest('passkey_challenges?expires_at=lt.' + encodeURIComponent(new Date().toISOString()), { method: 'DELETE' }).catch(() => {});
      const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
      const rows = await rest('passkey_challenges', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ challenge }) });
      return out({ id: rows[0].id, challenge });
    }

    if (body.action === 'login') {
      const fail = () => out({ error: 'No se pudo verificar la identidad' }, 401);
      const { id, credential_id, authenticator_data, client_data_json, signature } = body;
      if (!id || !credential_id || !authenticator_data || !client_data_json || !signature) return fail();

      // El desafío se consume (un solo uso) y debe estar vigente
      const ch = await rest(`passkey_challenges?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { prefer: 'return=representation' } });
      if (!ch?.length || new Date(ch[0].expires_at).getTime() < Date.now()) return fail();

      const pk = (await rest(`passkeys?id=eq.${encodeURIComponent(credential_id)}&select=user_id,public_key,alg`))?.[0];
      if (!pk) return fail();

      await verifyAssertion({
        spki: fromB64u(pk.public_key), alg: pk.alg, authData: fromB64u(authenticator_data), clientDataJSON: fromB64u(client_data_json),
        signature: fromB64u(signature), challenge: fromB64u(ch[0].challenge), rpId: new URL(origin).hostname, origin,
      });

      const prof = (await rest(`profiles?id=eq.${pk.user_id}&select=active,role`))?.[0];
      if (!prof?.active || !prof?.role) return out({ error: 'La cuenta está inactiva o pendiente de aprobación' }, 403);
      const u = await (await fetch(`${url}/auth/v1/admin/users/${pk.user_id}`, { headers: H })).json();
      if (!u?.email) return fail();

      const gl = await fetch(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'magiclink', email: u.email }) });
      const g = await gl.json();
      const token_hash = g?.hashed_token || g?.properties?.hashed_token;
      if (!gl.ok || !token_hash) return out({ error: 'No se pudo abrir la sesión' }, 500);

      await rest(`passkeys?id=eq.${encodeURIComponent(credential_id)}`, { method: 'PATCH', body: JSON.stringify({ last_used_at: new Date().toISOString() }) }).catch(() => {});
      return out({ token_hash });
    }
    return out({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    // Cualquier fallo de verificación se informa igual: no se revela qué paso falló
    console.error('passkey', (e as Error).message);
    return out({ error: 'No se pudo verificar la identidad' }, 401);
  }
});
