// Confirmação de pagamento do Mercado Pago, compartilhada por três caminhos:
//  1. webhook (api/mp-webhook.js), quando o Mercado Pago avisa;
//  2. conferência de reserva no acompanhamento (api/order-status.js), quando o aviso não chega;
//  3. botão "Conferir pagamento" do painel (api/admin.js, a=payment_check).
// O dado vale só se vier da API do Mercado Pago com o nosso token. Regras iguais nos três caminhos:
// moeda BRL, valor pago em centavos igual ao total_cents do pedido, gravação idempotente (recusado não
// sobrescreve aprovado), pontos só em pagamento aprovado e pedido cancelado não credita (loyalty.onPaymentStatus).

const MP_API = 'https://api.mercadopago.com';
const DEFAULT_TIMEOUT_MS = 8000;

class PaymentLookupError extends Error {
  constructor(message, status) { super(message); this.name = 'PaymentLookupError'; this.status = status; }
}

// GET na API do Mercado Pago. 404 vira null; outros erros lançam PaymentLookupError.
// Usa o fetch global no momento da chamada (os testes trocam globalThis.fetch).
async function mpGet(token, path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(MP_API + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new PaymentLookupError(`Mercado Pago respondeu ${res.status}`, res.status);
  return res.json();
}

// Pagamento pelo id numérico (data.id do webhook ou payment_id do Pix).
async function fetchPayment(token, id, opts) {
  if (!/^\d+$/.test(String(id))) return null;
  return mpGet(token, '/v1/payments/' + String(id), opts);
}

// Pagamentos de um pedido pelo external_reference (code legado). Usado no cartão: o pedido guarda o id da
// preferência até o primeiro aviso, e o cliente pode ter tentado mais de um cartão.
async function searchPaymentsByReference(token, code, opts) {
  const qs = new URLSearchParams({ external_reference: String(code), sort: 'date_created', criteria: 'desc', limit: '20' });
  const data = await mpGet(token, '/v1/payments/search?' + qs.toString(), opts);
  return data && Array.isArray(data.results) ? data.results : [];
}

// Entre várias tentativas, vale a aprovada; senão, a mais recente.
function pickPayment(results) {
  const list = (results || []).filter(p => p && p.id && p.status);
  if (!list.length) return null;
  const approved = list.find(p => p.status === 'approved');
  if (approved) return approved;
  return list.slice().sort((a, b) => String(b.date_created || '').localeCompare(String(a.date_created || '')))[0];
}

// Pix (payment_method_id 'pix') vira 'pix'; qualquer outro pagamento vem do Checkout Pro com cartão.
function paymentMethodOf(pay) {
  return pay && pay.payment_method_id === 'pix' ? 'pix' : 'mercadopago_card';
}

// Grava no máximo um aviso por pedido + pagamento (o Mercado Pago reenvia a mesma notificação várias vezes).
const CANCELLED_PAID_ACTION = 'pagamento_apos_cancelamento';
async function noteCancelledPaid(sql, orderId, paymentId) {
  await sql.query(
    `insert into admin_audit (username, action, detail)
     select 'mercadopago', $2::text,
            'Pedido ' || public_code || ' estava cancelado e recebeu pagamento aprovado (pagamento ' || $3::text || '). '
            || 'Pontos não creditados. Estorne o valor manualmente no Mercado Pago.'
       from orders
      where id = $1 and fulfillment_status = 'cancelled' and payment_status = 'approved'
        and not exists (select 1 from admin_audit where action = $2::text and detail like 'Pedido ' || orders.public_code || ' %(pagamento ' || $3::text || ')%')`,
    [orderId, CANCELLED_PAID_ACTION, paymentId]);
}

/**
 * Aplica um pagamento lido da API do Mercado Pago ao pedido do external_reference.
 * @returns {Promise<{outcome: 'invalid'|'no_order'|'currency_mismatch'|'amount_mismatch'|'updated'|'unchanged',
 *   order_id?: number, payment_status?: string, payment_id?: string}>}
 */
async function syncPayment(sql, pay, { source = 'webhook' } = {}) {
  const code = pay && pay.external_reference;
  if (!code || !pay.status || !pay.id) return { outcome: 'invalid' };
  const [order] = await sql.query('select id, total_cents from orders where code = $1', [String(code)]);
  if (!order) return { outcome: 'no_order' };

  // Só confirma se moeda e valor pago batem com o total gravado no servidor.
  if (pay.currency_id && pay.currency_id !== 'BRL') {
    console.error(`[${source}] Moeda do pagamento diferente de BRL`, code, pay.id);
    return { outcome: 'currency_mismatch', order_id: order.id };
  }
  if (Math.round(Number(pay.transaction_amount) * 100) !== order.total_cents) {
    console.error(`[${source}] Valor do pagamento diferente do pedido`, code, pay.id);
    return { outcome: 'amount_mismatch', order_id: order.id };
  }

  // Idempotente: só grava se algo mudou; um pagamento recusado não sobrescreve um já aprovado.
  const changed = await sql.query(
    `update orders set payment_status = $2, payment_id = $3, payment_method = $4
     where code = $1
       and (payment_status is distinct from $2 or payment_id is distinct from $3)
       and not (payment_status = 'approved' and payment_id is distinct from $3 and $2 <> 'approved')
     returning id`,
    [String(code), String(pay.status), String(pay.id), paymentMethodOf(pay)]
  );
  // Pontos (O11): idempotente; aprovado credita e confirma o resgate, rejeitado/cancelado devolve a reserva,
  // estornado reverte. Roda sempre para consertar execução interrompida. Pedido já cancelado e pagamento aprovado
  // depois: não credita e avisa o admin na auditoria para estornar à mão (nada é estornado no Mercado Pago).
  await noteCancelledPaid(sql, order.id, String(pay.id));
  await require('./loyalty').onPaymentStatus(sql, order.id);
  const [now] = await sql.query('select payment_status from orders where id = $1', [order.id]);
  return { outcome: changed.length ? 'updated' : 'unchanged', order_id: order.id, payment_status: now.payment_status, payment_id: String(pay.id) };
}

/**
 * Consulta o Mercado Pago pelo pedido e aplica o resultado (conferência de reserva e botão do painel).
 * Pix com id numérico: GET /v1/payments/{id}. Cartão (ou Pix sem id): busca por external_reference.
 * @param order linha com id, code, payment_id, payment_method
 * @returns {Promise<{outcome: string, payment_status?: string, mp_status?: string, payment_id?: string}>}
 *   outcome 'no_token' (sem MERCADOPAGO_ACCESS_TOKEN) ou 'not_found' (nenhum pagamento no Mercado Pago), além dos de syncPayment.
 */
async function checkOrderPayment(sql, order, { source = 'check', timeoutMs } = {}) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return { outcome: 'no_token' };
  let pay = null;
  if (order.payment_method === 'pix' && /^\d+$/.test(String(order.payment_id || ''))) {
    pay = await fetchPayment(token, order.payment_id, { timeoutMs });
  }
  if (!pay) pay = pickPayment(await searchPaymentsByReference(token, order.code, { timeoutMs }));
  if (!pay) return { outcome: 'not_found' };
  const r = await syncPayment(sql, pay, { source });
  return { ...r, mp_status: String(pay.status) };
}

module.exports = {
  PaymentLookupError, MP_API, mpGet, fetchPayment, searchPaymentsByReference, pickPayment, paymentMethodOf,
  CANCELLED_PAID_ACTION, noteCancelledPaid, syncPayment, checkOrderPayment
};
