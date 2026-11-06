import { read, rpc, friendly } from '../api.js';
import { modal } from '../ui.js';
import { esc, money } from '../format.js';

// Pregunta el destino del cobro antes de confirmar la entrega. La operación SQL
// ejecuta entrega + cargo + pago en una sola transacción.
export async function deliverOrder(order) {
  let hasAccount = false;
  if (order.customer_id) {
    const { data, error } = await read((s) => s.from('customers').select('id,is_public').eq('id', order.customer_id).maybeSingle());
    if (error) throw error;
    hasAccount = !!data && !data.is_public;
  }
  const total = Number(order.total_delivered ?? order.total_approved ?? order.total_requested ?? 0);
  const result = await modal(`<h2>Confirmar entrega y cobro</h2>
    <p class="muted">Pedido ${esc(order.order_number || '')} · total entregado <b>${money(total)}</b></p>
    ${hasAccount ? `<label class="field"><span>¿Cómo se cobra?</span><select id="delivery-kind"><option value="paid">Cobrar ahora</option><option value="credit">Dejar a cuenta corriente</option></select></label>` : `<p class="notice">Este cliente no tiene cuenta corriente. Registrá el cobro para confirmar la entrega.</p>`}
    <div id="delivery-payment" class="stack">
      <label class="field"><span>Monto recibido</span><input id="delivery-amount" inputmode="decimal" value="${total.toFixed(2)}"></label>
      <label class="field"><span>¿Cómo pagó?</span><select id="delivery-method"><option>Efectivo</option><option>Transferencia</option><option>Cheque</option><option>Tarjeta</option><option>Otro</option></select></label>
      ${hasAccount ? '<p class="muted small">Si recibe un pago parcial, la diferencia quedará pendiente en la cuenta corriente.</p>' : ''}
    </div>
    <p id="delivery-error" class="notice bad hidden" role="alert"></p>
    <div class="row"><button class="btn grow" data-close>Cancelar</button><button class="btn primary grow" id="delivery-ok">Confirmar entrega</button></div>`, {
      onMount: (ov, close) => {
        const kind = ov.querySelector('#delivery-kind');
        const payment = ov.querySelector('#delivery-payment');
        const amount = ov.querySelector('#delivery-amount');
        const method = ov.querySelector('#delivery-method');
        const error = ov.querySelector('#delivery-error');
        kind?.addEventListener('change', () => { payment.hidden = kind.value === 'credit'; });
        ov.querySelector('#delivery-ok').addEventListener('click', () => {
          const credit = kind?.value === 'credit';
          const paid = credit ? 0 : Number(String(amount.value).replace(',', '.'));
          if (!credit && (!(paid > 0) || paid > total + 0.001)) {
            error.textContent = `Ingresá un monto mayor a cero y no superior a ${money(total)}.`;
            error.classList.remove('hidden'); return;
          }
          if (!hasAccount && paid + 0.001 < total) {
            error.textContent = 'Este cliente no tiene cuenta corriente: debe registrarse el total entregado.';
            error.classList.remove('hidden'); return;
          }
          close({ amount: paid, method: credit ? null : method.value });
        });
      },
    });
  if (!result) return false;
  await rpc('confirm_delivery_with_payment', { p_order_id: order.id, p_payment_amount: result.amount, p_payment_method: result.method });
  return true;
}
