'use strict';
/*
 * Regras de pedido compartilhadas (O1, O6, O7): código público DG-####, token de rastreio,
 * máquina de status de preparo, conclusão automática preguiçosa e visão pública sem dados pessoais.
 */
const crypto = require('node:crypto');
const { sha256 } = require('./auth');

class OrderError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }

// ---------- O1: códigos ----------
// DG-#### tem só 9000 combinações: NÃO é chave de rastreio nem de busca pública (é adivinhável).
// A unicidade é checada apenas entre pedidos dos últimos 90 dias (índice não único em orders.public_code).
const PUBLIC_CODE_RE = /^DG-\d{4}$/;
const PUBLIC_CODE_WINDOW = '90 days';
const newPublicCode = () => `DG-${crypto.randomInt(1000, 10000)}`;

// Rastreio: token aleatório de 128 bits (base64url, 22 caracteres). No banco fica só o SHA-256.
const TRACKING_RE = /^[A-Za-z0-9_-]{22}$/;
function newTrackingToken() {
  const token = crypto.randomBytes(16).toString('base64url');
  return { token, hash: sha256(token) };
}
const hashTrackingToken = token => sha256(String(token));

// ---------- O6: status de preparo ----------
const FLOW = ['new', 'accepted', 'preparing', 'ready', 'awaiting_delivery', 'completed'];
const STATUSES = [...FLOW, 'cancelled'];
const LABELS = {
  new: 'novo', accepted: 'aceito', preparing: 'em preparo', ready: 'pronto',
  awaiting_delivery: 'aguardando entrega', completed: 'concluído', cancelled: 'cancelado'
};
const PICKUP_LABELS = { awaiting_delivery: 'aguardando retirada' };
const TS_COLUMN = {
  accepted: 'accepted_at', preparing: 'preparing_at', ready: 'ready_at',
  awaiting_delivery: 'awaiting_delivery_at', completed: 'completed_at', cancelled: 'cancelled_at'
};
const AUTO_COMPLETE_AFTER = '1 hour'; // conclusão automática 1 h depois de "pronto"

// Valor antigo 'delivered' (painel anterior) equivale a 'completed'. Nunca mais é gravado; não alteramos dados antigos.
const normalizeStatus = s => (s === 'delivered' ? 'completed' : s);
const statusLabel = (status, method) => {
  const s = normalizeStatus(status);
  return (method === 'pickup' && PICKUP_LABELS[s]) || LABELS[s] || s;
};

// Regras: só avança (pode pular etapas), nunca volta; cancelar vale até antes de concluir; concluído e cancelado são finais.
function checkTransition(fromRaw, to) {
  const from = normalizeStatus(fromRaw);
  if (!STATUSES.includes(to)) return { ok: false, message: 'Status inválido.' };
  if (from === to) return { ok: true, same: true };
  if (from === 'completed' || from === 'cancelled') return { ok: false, message: `O pedido já está ${LABELS[from]} e não pode mais mudar.` };
  if (to === 'cancelled') return { ok: true };
  if (FLOW.indexOf(to) < FLOW.indexOf(from)) return { ok: false, message: `Não é possível voltar o pedido de "${LABELS[from]}" para "${LABELS[to]}".` };
  return { ok: true };
}

// Conclusão automática, calculada na leitura (sem cron): pronto/aguardando entrega há mais de 1 h viram concluído.
// completed_at fica igual ao instante em que a regra venceu (ready_at + 1 h), não ao da consulta.
async function sweepOrders(sql) {
  await sql.query(
    `update orders
        set fulfillment_status = 'completed', completed_at = coalesce(ready_at, created_at) + interval '${AUTO_COMPLETE_AFTER}'
      where fulfillment_status in ('ready', 'awaiting_delivery')
        and coalesce(ready_at, created_at) < now() - interval '${AUTO_COMPLETE_AFTER}'`);
}

// Muda o status com validação no servidor. Retorna a linha atualizada.
async function changeStatus(sql, { id, to, reason }) {
  const [cur] = await sql.query('select id, code, public_code, delivery_method, fulfillment_status from orders where id = $1', [id]);
  if (!cur) throw new OrderError(404, 'Pedido não encontrado.');
  const check = checkTransition(cur.fulfillment_status, to);
  if (!check.ok) throw new OrderError(409, check.message, 'invalid_transition');
  if (check.same) return { ...cur, fulfillment_status: normalizeStatus(cur.fulfillment_status), changed: false };
  const col = TS_COLUMN[to]; // vem de um mapa fixo, nunca do cliente
  const cancel = to === 'cancelled';
  const rows = await sql.query(
    `update orders set fulfillment_status = $2, ${col} = now(), cancel_reason = case when $4::boolean then $5::text else cancel_reason end
      where id = $1 and fulfillment_status = $3
      returning id, code, public_code, delivery_method, fulfillment_status`,
    [id, to, cur.fulfillment_status, cancel, cancel && reason ? String(reason).slice(0, 200) : null]);
  if (!rows[0]) throw new OrderError(409, 'O pedido foi alterado por outra pessoa. Atualize a lista.', 'conflict');
  return { ...rows[0], changed: true, from: normalizeStatus(cur.fulfillment_status) };
}

// ---------- Visões ----------
const iso = v => (v ? new Date(v).toISOString() : null);

// Visão pública (rastreio): nunca telefone nem endereço.
function trackingView(row) {
  const status = normalizeStatus(row.fulfillment_status);
  return {
    public_code: row.public_code || null,
    payment_status: row.payment_status,
    fulfillment_status: status,
    fulfillment_label: statusLabel(status, row.delivery_method),
    delivery_method: row.delivery_method,
    total_cents: row.total_cents,
    created_at: iso(row.created_at),
    accepted_at: iso(row.accepted_at),
    preparing_at: iso(row.preparing_at),
    ready_at: iso(row.ready_at),
    awaiting_delivery_at: iso(row.awaiting_delivery_at),
    completed_at: iso(row.completed_at),
    cancelled_at: iso(row.cancelled_at)
  };
}
const TRACKING_COLUMNS = `public_code, payment_status, fulfillment_status, delivery_method, total_cents, created_at,
  accepted_at, preparing_at, ready_at, awaiting_delivery_at, completed_at, cancelled_at`;

// Colunas completas para o painel admin (inclui dados pessoais: só atrás de login).
const ADMIN_COLUMNS = `id, code, public_code, customer_name, customer_phone, delivery_method, address, items, subtotal_cents,
  delivery_fee_cents, discount_cents, points_redeemed, total_cents, distance_km, payment_method, payment_status, fulfillment_status,
  notes, created_at, accepted_at, preparing_at, ready_at, awaiting_delivery_at, completed_at, cancelled_at, cancel_reason, customer_id`;
function adminView(row) {
  return {
    ...row,
    distance_km: row.distance_km === null || row.distance_km === undefined ? null : Number(row.distance_km),
    fulfillment_status: normalizeStatus(row.fulfillment_status),
    fulfillment_label: statusLabel(row.fulfillment_status, row.delivery_method)
  };
}

module.exports = {
  OrderError, PUBLIC_CODE_RE, PUBLIC_CODE_WINDOW, newPublicCode, TRACKING_RE, newTrackingToken, hashTrackingToken,
  FLOW, STATUSES, LABELS, TS_COLUMN, normalizeStatus, statusLabel, checkTransition, sweepOrders, changeStatus,
  trackingView, TRACKING_COLUMNS, ADMIN_COLUMNS, adminView
};
