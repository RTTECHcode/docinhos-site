'use strict';
/*
 * Avaliação no Google e mimo (v4 N8).
 *  - Ajuste google_review_url em settings: chave ausente = link padrão; chave vazia = bloco de avaliação desligado; só https://.
 *  - post_payment (GET /api/order-status): só com pagamento aprovado e pedido não cancelado. A tela nunca decide sozinha.
 *  - review_gifts: no máximo 1 mimo pendente por telefone (índice único parcial). O admin concede (por pedido ou por telefone);
 *    pedidos criados DEPOIS da concessão aparecem com o selo `gift` no painel; ao concluir um desses pedidos o mimo vira entregue.
 *  - Nada do mimo aparece em resposta pública nem na conta do cliente.
 */
const { phoneKey, phoneKeySql } = require('./text');

const DEFAULT_REVIEW_URL = 'https://g.page/r/Cd8fNm7f9KsUEAI/review';
const INSTAGRAM_URL = 'https://www.instagram.com/docinhosdagigioz/';
const GIFT_LABEL = '1 brigadeirinho';
const SETTING_KEY = 'google_review_url';

class GiftError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }

// Link de avaliação em vigor: null = desligado.
async function getReviewUrl(sql) {
  const [row] = await sql.query('select value from settings where key = $1', [SETTING_KEY]);
  if (!row) return DEFAULT_REVIEW_URL;
  const v = String(row.value || '').trim();
  return v === '' ? null : v;
}

// Valida o texto digitado no painel. '' desliga. Retorna o valor limpo.
function validateReviewUrl(input) {
  if (input === undefined || input === null) throw new GiftError(400, 'Informe o link de avaliação (ou deixe vazio para desligar).', 'invalid_review_url');
  if (typeof input !== 'string') throw new GiftError(400, 'Link de avaliação inválido.', 'invalid_review_url');
  const v = input.trim();
  if (v === '') return '';
  let url;
  try { url = new URL(v); } catch { throw new GiftError(400, 'Link de avaliação inválido. Use um endereço que comece com https://', 'invalid_review_url'); }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || v.length > 300 || /[\u0000-\u001f\u007f\s]/.test(v)) {
    throw new GiftError(400, 'Link de avaliação inválido. Use um endereço que comece com https://', 'invalid_review_url');
  }
  return v;
}

async function saveReviewUrl(sql, input) {
  const v = validateReviewUrl(input);
  await sql.query(`insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [SETTING_KEY, v]);
  return v === '' ? null : v;
}

// Bloco pós-pagamento do /api/order-status. row precisa de payment_status e fulfillment_status.
async function postPayment(sql, row) {
  if (!row || row.payment_status !== 'approved' || row.fulfillment_status === 'cancelled') return null;
  return { review_url: await getReviewUrl(sql), instagram_url: INSTAGRAM_URL };
}

const ownerOf = (customerId) => customerId || null;

// Concede um mimo. Por pedido (orderId) ou por telefone (phone, só quem chama decide a permissão). Um pendente por telefone.
async function grant(sql, { orderId = null, phone = null, by }) {
  let key, customerId = null, grantedOrderId = null, afterOrderId = null;
  if (orderId !== null && orderId !== undefined) {
    if (!Number.isInteger(orderId) || orderId < 1) throw new GiftError(400, 'Pedido inválido.', 'invalid_order');
    const [o] = await sql.query('select id, customer_phone, customer_id, fulfillment_status from orders where id = $1', [orderId]);
    if (!o) throw new GiftError(404, 'Pedido não encontrado.', 'not_found');
    if (o.fulfillment_status === 'cancelled') throw new GiftError(409, 'Pedido cancelado não pode receber mimo.', 'order_cancelled');
    key = phoneKey(o.customer_phone);
    customerId = ownerOf(o.customer_id);
    grantedOrderId = o.id;
    afterOrderId = o.id;
  } else {
    if (typeof phone !== 'string' && typeof phone !== 'number') throw new GiftError(400, 'Informe o pedido ou o telefone.', 'invalid_phone');
    key = phoneKey(phone);
    const [last] = await sql.query(`select id, customer_id from orders where ${phoneKeySql('customer_phone')} = $1 order by id desc limit 1`, [key]);
    if (last) { afterOrderId = last.id; customerId = ownerOf(last.customer_id); }
    if (!customerId) {
      const [c] = await sql.query(`select id from customers where ${phoneKeySql('phone')} = $1 limit 1`, [key]);
      if (c) customerId = c.id;
    }
  }
  if (!/^\d{10,11}$/.test(key)) throw new GiftError(400, 'Telefone inválido.', 'invalid_phone');
  const rows = await sql.query(
    `insert into review_gifts (phone_key, customer_id, granted_order_id, after_order_id, label, granted_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (phone_key) where delivered_at is null and cancelled_at is null do nothing
     returning id, label, granted_at`,
    [key, customerId, grantedOrderId, afterOrderId, GIFT_LABEL, String(by || 'admin').slice(0, 60)]);
  if (!rows.length) throw new GiftError(409, 'Este cliente já tem um mimo pendente.', 'gift_pending');
  return { id: rows[0].id, label: rows[0].label, granted_at: new Date(rows[0].granted_at).toISOString(), phone_key: key };
}

// Cancela um mimo pendente (guarda o histórico). 404 se não existe ou já foi entregue/cancelado.
async function cancel(sql, id, by) {
  if (!Number.isInteger(id) || id < 1) throw new GiftError(400, 'Mimo inválido.', 'invalid_id');
  const rows = await sql.query(
    `update review_gifts set cancelled_at = now(), cancelled_by = $2
      where id = $1 and delivered_at is null and cancelled_at is null returning id`, [id, String(by || 'admin').slice(0, 60)]);
  if (!rows.length) throw new GiftError(404, 'Mimo pendente não encontrado.', 'not_found');
  return { id: rows[0].id };
}

// Pedidos concluídos (manual ou automático): o mimo pendente do telefone, concedido ANTES da criação do pedido, vira entregue.
// Idempotente (só atualiza o que ainda está pendente). O pedido da própria avaliação não entrega o mimo.
async function deliverForOrders(sql, orderIds) {
  const ids = (orderIds || []).filter(Number.isInteger);
  if (!ids.length) return 0;
  const rows = await sql.query(
    `update review_gifts g set delivered_order_id = o.id, delivered_at = now()
       from orders o
      where o.id = any($1::int[]) and g.delivered_at is null and g.cancelled_at is null
        and g.phone_key = ${phoneKeySql('o.customer_phone')}
        and o.created_at > g.granted_at and g.granted_order_id is distinct from o.id
      returning g.id`, [ids]);
  return rows.length;
}

// Põe `gift: { id, label }` nos pedidos do painel (mimo pendente do telefone, concedido antes do pedido ser criado, não o pedido avaliado).
async function attachGifts(sql, rows) {
  const keys = [...new Set(rows.map(r => phoneKey(r.customer_phone)).filter(Boolean))];
  const byKey = new Map();
  if (keys.length) {
    const gifts = await sql.query(
      `select id, phone_key, label, granted_at, granted_order_id from review_gifts
        where delivered_at is null and cancelled_at is null and phone_key = any($1::text[])`, [keys]);
    for (const g of gifts) byKey.set(g.phone_key, g);
  }
  return rows.map(r => {
    const g = byKey.get(phoneKey(r.customer_phone));
    const ok = g && g.granted_order_id !== r.id && new Date(r.created_at).getTime() > new Date(g.granted_at).getTime();
    return { ...r, gift: ok ? { id: g.id, label: g.label } : null };
  });
}

module.exports = {
  DEFAULT_REVIEW_URL, INSTAGRAM_URL, GIFT_LABEL, SETTING_KEY, GiftError,
  getReviewUrl, validateReviewUrl, saveReviewUrl, postPayment, grant, cancel, deliverForOrders, attachGifts
};
