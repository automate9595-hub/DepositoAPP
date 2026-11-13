import { read, rpc, friendly } from '../api.js';
import { modal } from '../ui.js';
import { esc, money } from '../format.js';
import { mountPaySplit, SPLIT_METHODS } from '../pay-split.js';


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
    ${hasAccount ? `<label class="field"><span>¿Cómo se cobra?</span><select id="delivery-kind"><option value="paid">Cobrar ahora</option><option value="credit">Dejar a cuenta corriente</option></select></label>` : `<p class="notice">Este cliente no tiene cuenta corriente. Registrá el cobro completo para confirmar la entrega.</p>`}
    <div id="delivery-payment" class="stack">
      <p class="muted small">Si el cliente paga con varios medios (por ejemplo mitad efectivo y mitad Mercado Pago), agregá otro medio.</p>
      <div id="delivery-split"></div>
      ${hasAccount ? '<p class="muted small">Si recibe un pago parcial, la diferencia quedará pendiente en la cuenta corriente.</p>' : ''}
    </div>
    <p id="delivery-error" class="notice bad hidden" role="alert"></p>
    <div class="row"><button class="btn grow" data-close>Cancelar</button><button class="btn primary grow" id="delivery-ok">Confirmar entrega</button></div>`, {
      onMount: (ov, close) => {
        const kind = ov.querySelector('#delivery-kind');
        const payment = ov.querySelector('#delivery-payment');
        const error = ov.querySelector('#delivery-error');
        const split = mountPaySplit(ov.querySelector('#delivery-split'), { methods: SPLIT_METHODS, total, max: 3, onChange: () => error.classList.add('hidden') });
        kind?.addEventListener('change', () => { payment.hidden = kind.value === 'credit'; error.classList.add('hidden'); });
        ov.querySelector('#delivery-ok').addEventListener('click', () => {
          const credit = kind?.value === 'credit';
          if (!credit) {
            const problem = split.problem({ exact: !hasAccount });
            if (problem) { error.textContent = problem; error.classList.remove('hidden'); return; }
          }
          close({ parts: credit ? [] : split.parts() });
        });
      },
    });
  if (!result) return false;
  await rpc('confirm_delivery_with_payments', { p_order_id: order.id, p_parts: result.parts });
  return true;
}
