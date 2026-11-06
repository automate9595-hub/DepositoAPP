// Carrito del proveedor: lógica pura y persistente (localStorage inyectable para pruebas).
// IMPORTANTE: los precios/totales de aquí son solo orientativos. El servidor recalcula todo.
import { clamp, toInt } from './format.js';

export const MAX_QTY = 999999;

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(b) : b.forEach((_, i) => (b[i] = Math.random() * 256)));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const emptyCart = () => ({ items: {}, notes: '', customerId: '', requestId: newRequestId(), v: 1 });

export function loadCart(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return emptyCart();
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object' || typeof c.items !== 'object' || !c.requestId) return emptyCart();
    for (const [id, it] of Object.entries(c.items)) {
      if (!it || toInt(it.qty) <= 0) delete c.items[id];
    }
    return { items: c.items, notes: String(c.notes ?? ''), customerId: String(c.customerId ?? ''), requestId: c.requestId, v: 1 };
  } catch { return emptyCart(); }
}

export function saveCart(storage, key, cart) {
  try { storage.setItem(key, JSON.stringify(cart)); return true; } catch { return false; }
}

// product: { id, code, name, price, photo_url, available }
export function setQty(cart, product, qty) {
  const q = clamp(toInt(qty), 0, MAX_QTY);
  if (q === 0) { delete cart.items[product.id]; return cart; }
  cart.items[product.id] = {
    id: product.id, code: product.code, name: product.name, price: Number(product.price), photo_url: product.photo_url ?? null,
    available: toInt(product.available), qty: q,
  };
  return cart;
}
export const getQty = (cart, id) => cart.items[id]?.qty ?? 0;
export const removeItem = (cart, id) => { delete cart.items[id]; return cart; };
export const itemList = (cart) => Object.values(cart.items);
export const cartCount = (cart) => itemList(cart).reduce((n, i) => n + i.qty, 0);
export const cartLines = (cart) => itemList(cart).length;
export const cartTotal = (cart) => Math.round(itemList(cart).reduce((t, i) => t + i.price * i.qty, 0) * 100) / 100;
export const toPayload = (cart) => itemList(cart).map((i) => ({ product_id: i.id, qty: i.qty }));
// Tras un envío confirmado por la base de datos se vacía y se genera NUEVO identificador
export const resetCart = () => emptyCart();
