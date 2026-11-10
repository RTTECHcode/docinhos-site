'use strict';
/*
 * Pontos de fidelidade (O11). Tudo calculado no servidor; o saldo é SEMPRE a soma de loyalty_ledger.
 *
 * Regras (editáveis na aba Ajustes do painel e guardadas na tabela settings; padrão em DEFAULT_RULES):
 *  - Ganho: N pontos por R$ 1,00 do subtotal pago (padrão 1), sem frete, depois do desconto, arredondado para baixo.
 *  - Resgate: blocos de B pontos (padrão 100) valem R$ V de desconto (padrão R$ 10,00); desconto nunca passa do subtotal.
 *  - Programa desligado: não credita pontos novos e não aceita resgate (o saldo continua guardado).
 *  - Crédito só quando o pagamento é aprovado (webhook do Mercado Pago, valor conferido), pela regra em vigor nesse momento.
 *    O que já foi creditado ou reservado não muda quando a regra muda (o ledger guarda os pontos, o pedido guarda o desconto).
 *
 * Linhas do ledger (unique (order_id, kind), então nenhuma operação por pedido se repete):
 *  earn            + pontos ganhos (pagamento aprovado)
 *  redeem_reserve  - pontos reservados ao criar o pedido com desconto
 *  redeem_release  + devolve a reserva (pagamento rejeitado/cancelado/expirado, reserva vencida > 24 h ou pedido cancelado)
 *  redeem_commit     0 (marcador): a reserva virou gasto definitivo (pagamento aprovado)
 *  reversal        +/- estorno de pagamento (refunded/charged_back): tira o ganho e devolve o gasto, em uma linha só
 *  adjust          +/- ajuste manual ou correção (ex.: aprovação que chegou depois de a reserva ser liberada)
 */
const BLOCK_POINTS = 100;           // padrão: 100 pontos = R$ 10,00
const BLOCK_CENTS = 1000;
const RESERVE_TTL = '24 hours';     // reserva de pagamento não concluído é devolvida depois disso
const MIN_CHARGE_CENTS = 100;       // o Mercado Pago não processa pedido de valor zero: mínimo R$ 1,00 a pagar
const KINDS = ['earn', 'redeem_reserve', 'redeem_release', 'redeem_commit', 'reversal', 'adjust'];

class LoyaltyError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }

// ---------- Regra do programa (settings: points_enabled, points_per_real, points_block_points, points_block_value_cents) ----------
const DEFAULT_RULES = Object.freeze({ enabled: true, points_per_real: 1, block_points: BLOCK_POINTS, block_value_cents: BLOCK_CENTS });
const RULE_KEYS = Object.freeze({
  enabled: 'points_enabled', points_per_real: 'points_per_real', block_points: 'points_block_points', block_value_cents: 'points_block_value_cents'
});
const RULE_LIMITS = Object.freeze({
  points_per_real: [1, 10],          // pontos ganhos por R$ 1,00
  block_points: [10, 10000],         // pontos por resgate
  block_value_cents: [100, 10000],   // desconto por resgate: R$ 1,00 a R$ 100,00
  max_return_pct: 50                 // o desconto devolvido nunca passa de 50% do valor gasto para juntar os pontos
});
const moneyBR = cents => 'R$ ' + (cents / 100).toFixed(2).replace('.', ',');
// Quanto do valor gasto volta em desconto (em %). Padrão: 1 ponto por R$ 1 e 100 pontos = R$ 10 -> 10%.
const returnPct = r => (r.points_per_real * r.block_value_cents) / r.block_points;

function validateRules(input) {
  const err = message => { throw new LoyaltyError(400, message, 'invalid_rules'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) err('Regra de pontos inválida.');
  if (typeof input.enabled !== 'boolean') err('Informe se o programa de pontos está ligado ou desligado.');
  const int = (v, [min, max], label) => {
    if (!Number.isInteger(v) || v < min || v > max) err(`${label}: informe um número inteiro de ${min} a ${max}.`);
    return v;
  };
  const out = {
    enabled: input.enabled,
    points_per_real: int(input.points_per_real, RULE_LIMITS.points_per_real, 'Pontos por R$ 1,00 gasto'),
    block_points: int(input.block_points, RULE_LIMITS.block_points, 'Pontos necessários por resgate'),
    block_value_cents: input.block_value_cents
  };
  const [vmin, vmax] = RULE_LIMITS.block_value_cents;
  if (!Number.isInteger(out.block_value_cents) || out.block_value_cents < vmin || out.block_value_cents > vmax) {
    err(`Desconto por resgate: informe um valor de ${moneyBR(vmin)} a ${moneyBR(vmax)}.`);
  }
  if (returnPct(out) > RULE_LIMITS.max_return_pct) {
    err(`Com essa regra o cliente receberia mais de ${RULE_LIMITS.max_return_pct}% do valor gasto de volta em desconto. Aumente os pontos por resgate ou diminua o desconto.`);
  }
  return out;
}

// Regra em vigor. Chave ausente = padrão; valor estragado no banco = regra padrão inteira (nunca uma regra pela metade).
async function getRules(sql) {
  const rows = await sql.query('select key, value from settings where key = any($1::text[])', [Object.values(RULE_KEYS)]);
  const st = {};
  for (const r of rows) st[r.key] = r.value;
  const num = (k, d) => (st[k] === undefined ? d : (/^\d{1,9}$/.test(String(st[k])) ? Number(st[k]) : NaN));
  try {
    return validateRules({
      enabled: st[RULE_KEYS.enabled] === undefined ? DEFAULT_RULES.enabled : st[RULE_KEYS.enabled] === '1',
      points_per_real: num(RULE_KEYS.points_per_real, DEFAULT_RULES.points_per_real),
      block_points: num(RULE_KEYS.block_points, DEFAULT_RULES.block_points),
      block_value_cents: num(RULE_KEYS.block_value_cents, DEFAULT_RULES.block_value_cents)
    });
  } catch { return { ...DEFAULT_RULES }; }
}

// Grava as 4 chaves numa instrução só (tudo ou nada). Lança LoyaltyError 400 se a regra for inválida.
async function saveRules(sql, input) {
  const r = validateRules(input);
  await sql.query(
    `insert into settings (key, value) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)
     on conflict (key) do update set value = excluded.value`,
    [RULE_KEYS.enabled, r.enabled ? '1' : '0', RULE_KEYS.points_per_real, String(r.points_per_real),
      RULE_KEYS.block_points, String(r.block_points), RULE_KEYS.block_value_cents, String(r.block_value_cents)]);
  return r;
}

// ---------- Funções puras ----------
const earnPoints = (subtotalCents, discountCents = 0, rules = DEFAULT_RULES) =>
  Math.max(0, Math.floor(((subtotalCents - discountCents) * rules.points_per_real) / 100));
const discountForPoints = (points, rules = DEFAULT_RULES) => (points / rules.block_points) * rules.block_value_cents;
const maxRedeemablePoints = (subtotalCents, balance, rules = DEFAULT_RULES) =>
  Math.max(0, Math.min(Math.floor(Math.max(0, balance) / rules.block_points), Math.floor(subtotalCents / rules.block_value_cents)) * rules.block_points);

const fmtDateTimeBR = date => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
}).format(date).replace(',', ' às');

/**
 * Valida e calcula um resgate. points = o que o cliente pediu (inteiro, múltiplo do bloco da regra).
 * rules = regra em vigor (getRules). Lança LoyaltyError (mensagens em português). Retorna { points, discount_cents }.
 */
function validateRedemption({ points, subtotalCents, balance, lockedUntil, now = new Date(), rules = DEFAULT_RULES }) {
  if (points === undefined || points === null || points === 0) return { points: 0, discount_cents: 0 };
  if (!Number.isInteger(points) || points < 0) throw new LoyaltyError(400, 'Quantidade de pontos inválida.', 'invalid_points');
  if (!rules.enabled) throw new LoyaltyError(409, 'O programa de pontos está pausado no momento. Faça o pedido sem usar pontos; seu saldo continua guardado.', 'points_disabled');
  const bp = rules.block_points, bv = moneyBR(rules.block_value_cents);
  if (points % bp !== 0) throw new LoyaltyError(400, `Os pontos são usados em blocos de ${bp} (${bp} pontos = ${bv}).`, 'invalid_block');
  if (lockedUntil && new Date(lockedUntil).getTime() > now.getTime()) {
    throw new LoyaltyError(423, `O uso de pontos está bloqueado até ${fmtDateTimeBR(new Date(lockedUntil))} por segurança (recuperação de conta recente). Você pode fazer o pedido sem usar pontos.`, 'points_locked');
  }
  if (points > balance) throw new LoyaltyError(409, `Saldo de pontos insuficiente: você tem ${Math.max(0, balance)} pontos.`, 'insufficient_points');
  const discount = discountForPoints(points, rules);
  if (discount > subtotalCents) {
    const max = maxRedeemablePoints(subtotalCents, balance, rules);
    throw new LoyaltyError(400, max > 0
      ? `O desconto não pode passar do valor dos produtos. Neste pedido você pode usar até ${max} pontos.`
      : `O valor dos produtos é menor que o desconto de ${bp} pontos (${bv}).`, 'discount_too_big');
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
  const rules = await getRules(sql);
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
    points_enabled: rules.enabled, points_per_real: rules.points_per_real, block_points: rules.block_points, block_value_cents: rules.block_value_cents,
    rules
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
    // Ganho pela regra em vigor na aprovação. Programa desligado: não credita (o resgate acima já foi confirmado).
    const rules = await getRules(sql);
    const pts = rules.enabled ? earnPoints(o.subtotal_cents, o.discount_cents, rules) : 0;
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
  DEFAULT_RULES, RULE_KEYS, RULE_LIMITS, validateRules, getRules, saveRules,
  earnPoints, discountForPoints, maxRedeemablePoints, validateRedemption,
  releaseStaleReserves, getBalance, listLedger, reserve, releaseReserve, onPaymentStatus, adjust
};
