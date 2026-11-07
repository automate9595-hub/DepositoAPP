// Supabase Edge Function: ingreso con huella o rostro (passkey) SIN correo ni contraseña.
// Despliegue:  supabase functions deploy deposito-passkey --no-verify-jwt
//   (o, en el panel de Supabase: Edge Functions › deposito-passkey › desactivar «Verify JWT»)
// Usa los secretos SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY, que Supabase ya inyecta en las funciones.
// Opcional: secreto ALLOWED_ORIGINS = "https://tu-usuario.github.io" (varios separados por coma).
//
// Cómo valida: 1) entrega un desafío de un solo uso (3 minutos); 2) recibe la firma del dispositivo;
// 3) comprueba firma, desafío, sitio, origen y que el sistema verificó huella/rostro; 4) comprueba que la cuenta
// esté activa; 5) devuelve un token de un solo uso con el que la app abre la sesión.
import { verifyAssertion, b64u, fromB64u } from './verify.js';

const url = Deno.env.get('SUPABASE_URL')!;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
const H = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

const corsFor = (origin: string | null) => ({
  'access-control-allow-origin': origin && (!allowed.length || allowed.includes(origin)) ? origin : 'null',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin',
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
