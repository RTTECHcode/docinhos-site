'use strict';
/*
 * Pontos de fidelidade (O11). Tudo calculado no servidor; o saldo é SEMPRE a soma de loyalty_ledger.
 *
 * Regras:
 *  - Ganho: 1 ponto por R$ 1,00 do subtotal pago, sem frete, depois do desconto, arredondado para baixo.
 *  - Resgate: blocos de 100 pontos; 100 pontos = R$ 10,00 de desconto; desconto nunca passa do subtotal.
 *  - Crédito só quando o pagamento é aprovado (webhook do Mercado Pago, valor conferido).
 *
 * Linhas do ledger (unique (order_id, kind), então nenhuma operação por pedido se repete):
 *  earn            + pontos ganhos (pagamento aprovado)
 *  redeem_reserve  - pontos reservados ao criar o pedido com desconto
 *  redeem_release  + devolve a reserva (pagamento rejeitado/cancelado/expirado, reserva vencida > 24 h ou pedido cancelado)
 *  redeem_commit     0 (marcador): a reserva virou gasto definitivo (pagamento aprovado)
 *  reversal        +/- estorno de pagamento (refunded/charged_back): tira o ganho e devolve o gasto, em uma linha só
 *  adjust          +/- ajuste manual ou correção (ex.: aprovação que chegou depois de a reserva ser liberada)
 */
const BLOCK_POINTS = 100;
const BLOCK_CENTS = 1000;           // 100 pontos = R$ 10,00
const RESERVE_TTL = '24 hours';     // reserva de pagamento não concluído é devolvida depois disso
const MIN_CHARGE_CENTS = 100;       // o Mercado Pago não processa pedido de valor zero: mínimo R$ 1,00 a pagar
const KINDS = ['earn', 'redeem_reserve', 'redeem_release', 'redeem_commit', 'reversal', 'adjust'];

class LoyaltyError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }

// ---------- Funções puras ----------
const earnPoints = (subtotalCents, discountCents = 0) => Math.max(0, Math.floor((subtotalCents - discountCents) / 100));
const discountForPoints = points => (points / BLOCK_POINTS) * BLOCK_CENTS;
const maxRedeemablePoints = (subtotalCents, balance) =>
  Math.max(0, Math.floor(Math.min(balance, Math.floor(subtotalCents / BLOCK_CENTS) * BLOCK_POINTS) / BLOCK_POINTS) * BLOCK_POINTS);

const fmtDateTimeBR = date => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
}).format(date).replace(',', ' às');

/**
 * Valida e calcula um resgate. points = o que o cliente pediu (inteiro, múltiplo de 100).
 * Lança LoyaltyError (mensagens em português). Retorna { points, discount_cents }.
 */
function validateRedemption({ points, subtotalCents, balance, lockedUntil, now = new Date() }) {
  if (points === undefined || points === null || points === 0) return { points: 0, discount_cents: 0 };
  if (!Number.isInteger(points) || points < 0) throw new LoyaltyError(400, 'Quantidade de pontos inválida.', 'invalid_points');
  if (points % BLOCK_POINTS !== 0) throw new LoyaltyError(400, `Os pontos são usados em blocos de ${BLOCK_POINTS} (${BLOCK_POINTS} pontos = R$ 10,00).`, 'invalid_block');
  if (lockedUntil && new Date(lockedUntil).getTime() > now.getTime()) {
    throw new LoyaltyError(423, `O uso de pontos está bloqueado até ${fmtDateTimeBR(new Date(lockedUntil))} por segurança (recuperação de conta recente). Você pode fazer o pedido sem usar pontos.`, 'points_locked');
  }
  if (points > balance) throw new LoyaltyError(409, `Saldo de pontos insuficiente: você tem ${Math.max(0, balance)} pontos.`, 'insufficient_points');
  const discount = discountForPoints(points);
  if (discount > subtotalCents) {
    const max = maxRedeemablePoints(subtotalCents, balance);
    throw new LoyaltyError(400, max > 0
      ? `O desconto não pode passar do valor dos produtos. Neste pedido você pode usar até ${max} pontos.`
      : 'O valor dos produtos é menor que o desconto de 100 pontos (R$ 10,00).', 'discount_too_big');
  }
  return { points, discount_cents: discount };
}

// ---------- Banco ----------
const ON_CONFLICT = 'on conflict (order_id, kind) where order_id is not null do nothing';

// Devolve reservas de resgate com mais de 24 h cujo pedido não foi pago. Preguiçoso: roda na leitura do saldo.
async function releaseStaleReserves(sql, customerId = null) {
  await sql.query(
    `insert into loyalty_ledger (customer_id, order_id, kind, points, note)
     select r.customer_id, r.order_id, 'redeem_release', -r.points, 'reserva vencida (24 h sem pagamento)'
       from loyalty_ledger r join orders o on o.id = r.order_id
      where r.kind = 'redeem_reserve' and r.created_at < now() - interval '${RESERVE_TTL}'
        and o.payment_status <> 'approved' and ($1::int is null or r.customer_id = $1::int)
     ${ON_CONFLICT}`, [customerId]);
}

// Saldo = soma do ledger. Reservas em aberto já estão descontadas (o cliente não pode gastar duas vezes).
async function getBalance(sql, customerId) {
  await releaseStaleReserves(sql, customerId);
  const [row] = await sql.query(
    `select coalesce(sum(points), 0)::int as balance,
            coalesce(sum(points) filter (where kind = 'earn'), 0)::int as earned_total,
            coalesce(-sum(points) filter (where kind = 'redeem_reserve'
              and not exists (select 1 from loyalty_ledger x where x.order_id = loyalty_ledger.order_id and x.kind in ('redeem_release', 'redeem_commit'))), 0)::int as reserved
       from loyalty_ledger where customer_id = $1`, [customerId]);
  const [cust] = await sql.query('select points_locked_until from customers where id = $1', [customerId]);
  const lockedUntil = cust && cust.points_locked_until ? new Date(cust.points_locked_until) : null;
  return {
    balance: row.balance, reserved: row.reserved, earned_total: row.earned_total,
    locked_until: lockedUntil && lockedUntil.getTime() > Date.now() ? lockedUntil.toISOString() : null,
    points_per_real: 1, block_points: BLOCK_POINTS, block_value_cents: BLOCK_CENTS
  };
}

async function listLedger(sql, customerId, limit = 50) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  return sql.query(
    `select l.id, l.kind, l.points, l.note, l.created_at, o.public_code
       from loyalty_ledger l left join orders o on o.id = l.order_id
      where l.customer_id = $1 order by l.created_at desc, l.id desc limit ${n}`, [customerId]);
}

// Reserva os pontos de um pedido de forma atômica: confere o saldo e grava na mesma transação (trava por cliente).
// Retorna true se reservou, false se o saldo não bastou (outra compra gastou antes).
async function reserve(sql, { customerId, orderId, points }) {
  if (!points) return true;
  const results = await sql.transaction([
    sql.query('select pg_advisory_xact_lock($1::bigint)', [customerId]),
    sql.query(
      `insert into loyalty_ledger (customer_id, order_id, kind, points, note)
       select $1::int, $2::int, 'redeem_reserve', -$3::int, 'reserva para o pedido'
        where (select coalesce(sum(points), 0) from loyalty_ledger where customer_id = $1::int) >= $3::int
       ${ON_CONFLICT} returning id`, [customerId, orderId, points])
  ]);
  return results[1].length > 0;
}

async function orderRows(sql, orderId) {
  return sql.query('select kind, points from loyalty_ledger where order_id = $1', [orderId]);
}

// Devolve a reserva de um pedido que não vai ser pago (ou cancelado). Idempotente; não mexe em pedido já aprovado.
async function releaseReserve(sql, orderId, note = 'pagamento não concluído') {
  const rows = await sql.query(
    `insert into loyalty_ledger (customer_id, order_id, kind, points, note)
     select r.customer_id, r.order_id, 'redeem_release', -r.points, $2
       from loyalty_ledger r join orders o on o.id = r.order_id
      where r.order_id = $1 and r.kind = 'redeem_reserve' and o.payment_status <> 'approved'
        and not exists (select 1 from loyalty_ledger c where c.order_id = r.order_id and c.kind = 'redeem_commit')
     ${ON_CONFLICT} returning id`, [orderId, note]);
  return rows.length > 0;
}

const insertRow = (sql, { customerId, orderId, kind, points, note }) =>
  sql.query(`insert into loyalty_ledger (customer_id, order_id, kind, points, note) values ($1, $2, $3, $4, $5) ${ON_CONFLICT} returning id`,
    [customerId, orderId, kind, points, note || null]);

/**
 * Aplica ao ledger o estado de pagamento atual do pedido. Idempotente: pode ser chamado a cada notificação do
 * Mercado Pago (inclusive repetidas) e conserta uma execução anterior interrompida.
 *  approved                          -> ganho + resgate definitivo
 *  rejected | cancelled | expired    -> devolve a reserva
 *  refunded | charged_back           -> estorno (tira o ganho, devolve o gasto)
 */
async function onPaymentStatus(sql, orderId) {
  const [o] = await sql.query('select id, customer_id, subtotal_cents, discount_cents, points_redeemed, payment_status, fulfillment_status from orders where id = $1', [orderId]);
  if (!o || !o.customer_id) return { applied: [] };
  const applied = [];
  const customerId = o.customer_id;
  const status = o.payment_status;
  // Pedido cancelado que recebe pagamento aprovado depois: NÃO credita pontos nem cobra de novo o resgate devolvido.
  // O dinheiro precisa ser estornado à mão no Mercado Pago (o webhook grava o aviso na auditoria).
  if (status === 'approved' && o.fulfillment_status === 'cancelled') return { applied, skipped: 'cancelled' };
  if (status === 'approved') {
    const rows = await orderRows(sql, orderId);
    const has = k => rows.some(r => r.kind === k);
    if (o.points_redeemed > 0 && has('redeem_reserve') && !has('redeem_commit')) {
      // A reserva já tinha sido devolvida (vencida ou liberada) e o pagamento aprovou depois: cobra de novo.
      if (has('redeem_release')) {
        if ((await insertRow(sql, { customerId, orderId, kind: 'adjust', points: -o.points_redeemed, note: 'pagamento aprovado depois de a reserva ser devolvida' })).length) applied.push('adjust');
      }
      if ((await insertRow(sql, { customerId, orderId, kind: 'redeem_commit', points: 0, note: 'resgate confirmado' })).length) applied.push('redeem_commit');
    }
    const pts = earnPoints(o.subtotal_cents, o.discount_cents);
    if (pts > 0 && (await insertRow(sql, { customerId, orderId, kind: 'earn', points: pts, note: 'pontos do pedido pago' })).length) applied.push('earn');
  } else if (status === 'rejected' || status === 'cancelled' || status === 'expired') {
    if (await releaseReserve(sql, orderId, `pagamento ${status}`)) applied.push('redeem_release');
  } else if (status === 'refunded' || status === 'charged_back') {
    const rows = await orderRows(sql, orderId);
    const earn = rows.find(r => r.kind === 'earn'), commit = rows.find(r => r.kind === 'redeem_commit');
    if (earn || commit) {
      const points = -(earn ? earn.points : 0) + (commit ? o.points_redeemed : 0);
      if ((await insertRow(sql, { customerId, orderId, kind: 'reversal', points, note: `estorno (${status})` })).length) applied.push('reversal');
    }
  }
  return { applied };
}

// Ajuste manual (uso futuro do admin). order_id null: a unicidade por pedido não se aplica.
async function adjust(sql, { customerId, points, note }) {
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100000) throw new LoyaltyError(400, 'Pontos inválidos.', 'invalid_points');
  await sql.query(`insert into loyalty_ledger (customer_id, order_id, kind, points, note) values ($1, null, 'adjust', $2, $3)`,
    [customerId, points, String(note || 'ajuste manual').slice(0, 200)]);
}

module.exports = {
  BLOCK_POINTS, BLOCK_CENTS, MIN_CHARGE_CENTS, KINDS, LoyaltyError,
  earnPoints, discountForPoints, maxRedeemablePoints, validateRedemption,
  releaseStaleReserves, getBalance, listLedger, reserve, releaseReserve, onPaymentStatus, adjust
};
