import { loadCart, saveCart } from './cart.js';

export const state = { user: null, profile: null, cart: null, unread: 0 };

// Bus de eventos mínimo entre módulos
const handlers = {};
export const bus = {
  on(evt, fn) { (handlers[evt] ||= new Set()).add(fn); return () => handlers[evt].delete(fn); },
  emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

let cartKey = null;
export function initCart(uid) { cartKey = `deposito-cart-${uid}`; state.cart = loadCart(localStorage, cartKey); }
export function persistCart() {
  if (!cartKey) return true;
  const okSave = saveCart(localStorage, cartKey, state.cart);
  bus.emit('cart');
  return okSave;
}
export function replaceCart(c) { state.cart = c; persistCart(); }

const PROFILE_KEY = 'deposito-profile-cache';
export const cacheProfile = (p) => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* sin espacio */ } };
export const cachedProfile = (uid) => { try { const p = JSON.parse(localStorage.getItem(PROFILE_KEY)); return p?.id === uid ? p : null; } catch { return null; } };
export const clearProfileCache = () => { try { localStorage.removeItem(PROFILE_KEY); } catch { /* nada */ } };

export const role = () => state.profile?.role ?? null;
export const isAdmin = () => ['admin_principal', 'admin_secundario'].includes(role());
export function can(perm) {
  const p = state.profile;
  if (!p) return false;
  if (p.role === 'admin_principal') return true;
  return p.role === 'admin_secundario' && p.permissions?.[perm] === true;
}
