import { createIsolatedClient } from '../supa.js';
import { state } from '../state.js';
import { read, rpc, friendly, toAppError } from '../api.js';
import { esc, money, roleLabel, PERMS, dateTime, statusLabel, one, debounce, cleanSearch } from '../format.js';
import { $, busy, ok, fail, emptyBox, errorBox, spinner, modal, icon } from '../ui.js';

const PAGE = 30;

// ---------------- Usuarios ----------------
export async function usersView(el) {
  let rows = []; let sup = {}; let q = '';
  el.innerHTML = `<div class="stack"><div class="row"><input id="q" type="search" class="grow" placeholder="Buscar nombre o correo" aria-label="Buscar"><button class="btn primary" id="new">${icon('plus')} Nuevo</button></div><div id="l" class="list"></div></div>`;
  const list = $('#l', el);
  async function load() {
    list.innerHTML = spinner();
    try {
      const [p, s] = await Promise.all([
        read((c) => c.from('profiles').select('id,email,role,full_name,phone,active,permissions,created_at').order('created_at', { ascending: false }).limit(500)),
        read((c) => c.from('suppliers').select('profile_id,company_name')),
      ]);
      rows = p.data || []; sup = Object.fromEntries((s.data || []).map((x) => [x.profile_id, x.company_name])); draw();
    } catch (e) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', load); }
  }
  function draw() {
    const t = cleanSearch(q).toLowerCase();
    const f = rows.filter((r) => !t || `${r.full_name} ${r.email}`.toLowerCase().includes(t));
    list.innerHTML = f.length ? f.map((r) => `<div class="card click" data-id="${r.id}"><div class="row between"><b class="ellipsis">${esc(r.full_name || r.email)}</b>
      ${!r.role ? '<span class="status s-warn">Sin rol</span>' : r.active ? '<span class="status s-ok">Activo</span>' : '<span class="status s-idle">Inactivo</span>'}</div>
      <div class="muted small ellipsis">${esc(r.email)} · ${esc(roleLabel(r.role))}${sup[r.id] ? ' · ' + esc(sup[r.id]) : ''}</div></div>`).join('') : emptyBox('Sin usuarios.');
  }
  $('#q', el).addEventListener('input', debounce((e) => { q = e.target.value; draw(); }, 250));
  $('#new', el).addEventListener('click', async () => { if (await newUserForm()) load(); });
  list.addEventListener('click', async (e) => { const c = e.target.closest('[data-id]'); if (!c) return; const r = rows.find((x) => x.id === c.dataset.id); if (r && await editUserForm(r, sup[r.id])) load(); });
  await load();
  return { refresh: () => load() };
}

const permBoxes = (perms = {}) => Object.entries(PERMS).map(([k, l]) => `<label class="check"><input type="checkbox" data-perm="${k}" ${perms[k] ? 'checked' : ''}> ${l}</label>`).join('');
const readPerms = (ov) => Object.fromEntries([...ov.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked]));
const roleOptions = (sel) => [['proveedor', 'Proveedor'], ['deposito', 'Personal del depósito'], ['admin_secundario', 'Segundo administrador']]
  .filter(([v]) => v !== 'admin_secundario' || state.profile.role === 'admin_principal')
  .map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');

function newUserForm() {
  return modal(`<h2>Nuevo usuario</h2><form id="f" class="stack" novalidate>
    <label class="field"><span>Nombre completo</span><input name="name" required maxlength="120"></label>
    <label class="field"><span>Correo electrónico (será su usuario)</span><input name="email" type="email" inputmode="email" autocapitalize="none" required></label>
    <label class="field"><span>Contraseña inicial (mínimo 8 caracteres)</span><input name="pw" type="text" autocomplete="off" minlength="8" required></label>
    <label class="field"><span>Teléfono</span><input name="phone" inputmode="tel"></label>
    <label class="field"><span>Rol</span><select name="role">${roleOptions('proveedor')}</select></label>
    <label class="field" id="co"><span>Empresa del proveedor</span><input name="company" maxlength="120"></label>
    <div id="pm" class="hidden"><span class="muted small">Permisos del segundo administrador</span>${permBoxes({ orders: true, inventory: true, products: true, stats: true })}</div>
    <p class="notice bad hidden" id="err" role="alert"></p>
    <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Crear usuario</button></div></form>`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      const sync = () => { $('#co', ov).classList.toggle('hidden', f.role.value !== 'proveedor'); $('#pm', ov).classList.toggle('hidden', f.role.value !== 'admin_secundario'); };
      f.role.addEventListener('change', sync); sync();
      const bad = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        if (!f.name.value.trim()) return bad('Ingrese el nombre.');
        if (!/^\S+@\S+\.\S+$/.test(f.email.value.trim())) return bad('Ingrese un correo válido.');
        if (f.pw.value.length < 8) return bad('La contraseña debe tener al menos 8 caracteres.');
        await busy($('button:not([type=button])', f), async () => {
          try {
            // Cliente aislado: no cierra la sesión del administrador
            const iso = createIsolatedClient();
            const { data, error } = await iso.auth.signUp({ email: f.email.value.trim(), password: f.pw.value, options: { data: { full_name: f.name.value.trim() } } });
            if (error) throw error;
            if (!data.user || (data.user.identities && data.user.identities.length === 0)) throw toAppError('already registered');
            if (!data.session && data.user && !data.user.confirmed_at && !data.user.email_confirmed_at) {
              throw new Error('CONFIRMACION: El usuario se creó pero Supabase exige confirmar el correo. Desactive "Confirm email" en Authentication > Providers > Email y vuelva a intentarlo con otro correo, o confirme el usuario manualmente.');
            }
            await rpc('admin_set_user', { p_user: data.user.id, p_role: f.role.value, p_full_name: f.name.value.trim(), p_phone: f.phone.value.trim() || null, p_active: true,
              p_permissions: f.role.value === 'admin_secundario' ? readPerms(ov) : null, p_company: f.company.value.trim() || null });
            ok('Usuario creado y activado'); close(true);
          } catch (x) { bad(friendly(x)); }
        });
      });
    },
  }).then((v) => v === true);
}

function editUserForm(r, company) {
  const principal = r.role === 'admin_principal';
  return modal(`<h2>${esc(r.full_name || r.email)}</h2><p class="muted small">${esc(r.email)}</p>
    ${principal ? '<p class="notice">El administrador principal no se puede modificar desde la aplicación.</p><button class="btn block" data-close>Cerrar</button>' : `
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Nombre completo</span><input name="name" value="${esc(r.full_name)}" required maxlength="120"></label>
      <label class="field"><span>Teléfono</span><input name="phone" value="${esc(r.phone || '')}" inputmode="tel"></label>
      <label class="field"><span>Rol</span><select name="role">${r.role ? '' : '<option value="">Elegir rol…</option>'}${roleOptions(r.role)}</select></label>
      <label class="field" id="co"><span>Empresa del proveedor</span><input name="company" value="${esc(company || '')}" maxlength="120"></label>
      <div id="pm" class="hidden"><span class="muted small">Permisos del segundo administrador</span>${permBoxes(r.permissions)}</div>
      <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Cuenta activa</label>
      <p class="muted small">Si olvidó la contraseña, el usuario puede cambiarla en Cuenta; para restablecerla use Supabase > Authentication > Users.</p>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Guardar</button></div></form>`}`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); if (!f) return; const err = $('#err', ov);
      const sync = () => { $('#co', ov).classList.toggle('hidden', f.role.value !== 'proveedor'); $('#pm', ov).classList.toggle('hidden', f.role.value !== 'admin_secundario'); };
      f.role.addEventListener('change', sync); sync();
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        if (!f.role.value) { err.textContent = 'Elija un rol.'; err.classList.remove('hidden'); return; }
        await busy($('button:not([type=button])', f), async () => {
          try {
            await rpc('admin_set_user', { p_user: r.id, p_role: f.role.value, p_full_name: f.name.value, p_phone: f.phone.value || null, p_active: f.active.checked,
              p_permissions: f.role.value === 'admin_secundario' ? readPerms(ov) : null, p_company: f.company.value.trim() || null });
            ok('Usuario actualizado'); close(true);
          } catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
        });
      });
    },
  }).then((v) => v === true);
}

// ---------------- Auditoría ----------------
export async function auditView(el) {
  let page = 0; let rows = [];
  el.innerHTML = `<div class="stack"><div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  async function load(reset) {
    if (reset) { page = 0; rows = []; list.innerHTML = spinner(); }
    try {
      const { data } = await read((s) => s.from('audit_logs').select('id,action,entity,entity_id,details,created_at,profiles(full_name,email)').order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1));
      rows = rows.concat(data || []); more.classList.toggle('hidden', (data || []).length < PAGE);
      list.innerHTML = rows.length ? rows.map((a) => { const u = one(a.profiles); return `<div class="card"><div class="row between"><b>${esc(a.action)}</b><span class="muted small">${dateTime(a.created_at)}</span></div>
        <div class="small">${esc(u?.full_name || u?.email || 'Sistema')} · ${esc(a.entity)}</div>
        ${a.details ? `<details class="small muted"><summary>Detalle</summary><pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0">${esc(JSON.stringify(a.details, null, 1).slice(0, 1500))}</pre></details>` : ''}</div>`; }).join('') : emptyBox('Sin registros.');
    } catch (e) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); }
  }
  more.addEventListener('click', () => { page += 1; load(false); });
  await load(true);
  return {};
}
