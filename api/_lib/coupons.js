'use strict';
/*
 * Cupons (v4 N6). Tudo validado e calculado no servidor.
 *  - Código: maiúsculas, A-Z, 0-9 e hífen, 3 a 20 caracteres.
 *  - Desconto só nos produtos (nunca no frete). Percentual arredonda para baixo em centavos. Os produtos precisam ficar com pelo
 *    menos R$ 1,00 depois do desconto (o desconto é limitado a isso). orders.discount_cents = desconto total (cupom + pontos antigos).
 *  - Pedido mínimo conta sobre o subtotal dos itens pagos (antes do desconto; prêmio do Clube vale R$ 0).
 *  - Limites: total (max_uses) e por cliente (max_uses_per_customer, por telefone normalizado, vale para visitante). Contam usos
 *    reservados e confirmados. A contagem e a reserva acontecem na MESMA transação do pedido, sob a trava de cupom
 *    (pg_advisory_xact_lock(2, coupon_id)), em api/order.js.
 *  - Ciclo: reserved (pedido criado) -> committed (pagamento aprovado) -> released (rejeitado, cancelado, expirado, estornado,
 *    24 h sem pagar ou pedido cancelado no painel).
 *  - Acumula com prêmio do Clube só se stacks_with_club (padrão: não).
 *  - Disparo por WhatsApp: público (só conta com consentimento ativo), lista guardada em coupon_campaigns/targets.
 */
const { phoneKeySql } = require('./text');
const { siteUrl } = require('./site');
const MIN_PRODUCTS_AFTER_DISCOUNT = 100; // R$ 1,00

class CouponError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }
const bad = (message, code) => { throw new CouponError(400, message, code); };

const MSG_INVALID = 'Cupom inválido ou indisponível.';
const moneyBR = cents => 'R$ ' + (cents / 100).toFixed(2).replace('.', ',');
const iso = v => (v ? new Date(v).toISOString() : null);
const isInt = v => Number.isInteger(v);

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z0-9-]{3,20}$/.test(c) ? c : null;
}

// Desconto de um cupom sobre o subtotal dos itens pagos (função pura).
function discountFor(coupon, paidSubtotalCents) {
  const raw = coupon.kind === 'percent' ? Math.floor((paidSubtotalCents * coupon.value) / 100) : coupon.value;
  return Math.max(0, Math.min(raw, paidSubtotalCents - MIN_PRODUCTS_AFTER_DISCOUNT));
}

// Trecho SQL (usa $a = id do cupom e $b = telefone normalizado): o cupom ainda está ativo, na vigência e com saldo de usos.
// Usado na instrução do pedido, depois da trava de cupom, para decidir de forma atômica.
const eligibleSql = (couponParam, phoneParam) => `exists (
  select 1 from coupons cp where cp.id = ${couponParam}::int and cp.active
     and (cp.starts_at is null or cp.starts_at <= now()) and (cp.expires_at is null or cp.expires_at > now())
     and (cp.max_uses is null or (select count(*) from coupon_redemptions r where r.coupon_id = cp.id and r.status in ('reserved', 'committed')) < cp.max_uses)
     and (cp.max_uses_per_customer is null or (select count(*) from coupon_redemptions r where r.coupon_id = cp.id and r.phone_key = ${phoneParam}::text
                                                  and r.status in ('reserved', 'committed')) < cp.max_uses_per_customer))`;

// Reserva o uso (instrução da transação do pedido): grava a partir do pedido recém-criado (pelo hash do token de rastreio).
const reserveStatement = (sql, { couponId, trackingHash, phoneKey, discountCents }) => sql.query(
  `insert into coupon_redemptions (coupon_id, order_id, customer_id, phone_key, status, discount_cents)
   select $1::int, o.id, o.customer_id, $3::text, 'reserved', $4::int from orders o where o.tracking_token_hash = $2::text
   on conflict (order_id) do nothing returning id`, [couponId, trackingHash, phoneKey, discountCents]);

// Devolve usos reservados há mais de 24 h cujo pedido não foi pago (preguiçoso, junto com a leitura do saldo).
async function releaseStale(sql) {
  await sql.query(
    `update coupon_redemptions r set status = 'released', updated_at = now()
       from orders o
      where o.id = r.order_id and r.status = 'reserved' and r.created_at < now() - interval '24 hours' and o.payment_status <> 'approved'`);
}

/**
 * Estado do pagamento -> uso do cupom. Idempotente. order = { id, payment_status, fulfillment_status }.
 * Retorna 'coupon_commit', 'coupon_release' ou null (nada mudou).
 */
async function onPaymentStatus(sql, order) {
  const st = order.payment_status;
  if (st === 'approved') {
    if (order.fulfillment_status === 'cancelled') return null; // pedido cancelado: o uso fica devolvido
    const rows = await sql.query(`update coupon_redemptions set status = 'committed', updated_at = now() where order_id = $1 and status <> 'committed' returning id`, [order.id]);
    return rows.length ? 'coupon_commit' : null;
  }
  if (['rejected', 'cancelled', 'expired', 'refunded', 'charged_back'].includes(st)) {
    const rows = await sql.query(`update coupon_redemptions set status = 'released', updated_at = now() where order_id = $1 and status <> 'released' returning id`, [order.id]);
    return rows.length ? 'coupon_release' : null;
  }
  return null;
}

// Pedido cancelado no painel: devolve o uso do cupom (mesmo se já estava confirmado). Idempotente.
async function releaseForOrder(sql, orderId) {
  const rows = await sql.query(`update coupon_redemptions set status = 'released', updated_at = now() where order_id = $1 and status <> 'released' returning id`, [orderId]);
  return rows.length > 0;
}

/**
 * Valida um código para um carrinho. Lança CouponError (mensagem em português) se não vale.
 * input: { code, paidSubtotalCents, phoneKey (pode ser null no coupon_check de visitante sem telefone), hasRewards, now }
 * Retorna { coupon, discount_cents }.
 */
async function evaluate(sql, { code, paidSubtotalCents, phoneKey = null, hasRewards = false, now = new Date() }) {
  const norm = normalizeCode(code);
  if (!norm) throw new CouponError(400, MSG_INVALID, 'invalid_coupon');
  await releaseStale(sql);
  const [c] = await sql.query('select * from coupons where code = $1', [norm]);
  const t = now.getTime();
  if (!c || !c.active || (c.starts_at && new Date(c.starts_at).getTime() > t) || (c.expires_at && new Date(c.expires_at).getTime() <= t)) {
    throw new CouponError(400, MSG_INVALID, 'invalid_coupon');
  }
  if (c.min_order_cents > 0 && paidSubtotalCents < c.min_order_cents) {
    throw new CouponError(400, `Este cupom vale para pedidos a partir de ${moneyBR(c.min_order_cents)} em produtos.`, 'coupon_min_order');
  }
  if (hasRewards && !c.stacks_with_club) {
    throw new CouponError(400, 'Este cupom não pode ser usado junto com prêmios do Clube. Retire o prêmio ou o cupom.', 'coupon_not_stackable');
  }
  if (c.max_uses !== null) {
    const [{ n }] = await sql.query(`select count(*)::int n from coupon_redemptions where coupon_id = $1 and status in ('reserved', 'committed')`, [c.id]);
    if (n >= c.max_uses) throw new CouponError(409, 'Este cupom já atingiu o limite de usos.', 'coupon_exhausted');
  }
  if (c.max_uses_per_customer !== null && phoneKey) {
    const [{ n }] = await sql.query(
      `select count(*)::int n from coupon_redemptions where coupon_id = $1 and phone_key = $2 and status in ('reserved', 'committed')`, [c.id, phoneKey]);
    if (n >= c.max_uses_per_customer) throw new CouponError(409, 'Você já usou este cupom o máximo de vezes permitido.', 'coupon_customer_limit');
  }
  const discount = discountFor(c, paidSubtotalCents);
  if (discount <= 0) throw new CouponError(400, 'Este cupom não gera desconto neste pedido.', 'coupon_no_discount');
  return { coupon: c, discount_cents: discount };
}

// ---------- Admin ----------
const adminView = row => ({
  id: row.id, code: row.code, kind: row.kind, value: row.value, min_order_cents: row.min_order_cents,
  starts_at: iso(row.starts_at), expires_at: iso(row.expires_at), max_uses: row.max_uses, max_uses_per_customer: row.max_uses_per_customer,
  active: row.active, stacks_with_club: row.stacks_with_club, note: row.note || null, created_by: row.created_by || null, created_at: iso(row.created_at),
  uses_reserved: row.uses_reserved === undefined ? undefined : Number(row.uses_reserved),
  uses_committed: row.uses_committed === undefined ? undefined : Number(row.uses_committed),
  discount_committed_cents: row.discount_committed_cents === undefined ? undefined : Number(row.discount_committed_cents),
  state: !row.active ? 'off' : (row.starts_at && new Date(row.starts_at) > new Date() ? 'scheduled' : (row.expires_at && new Date(row.expires_at) <= new Date() ? 'expired' : 'on'))
});

async function adminList(sql) {
  await releaseStale(sql);
  const rows = await sql.query(
    `select c.*,
            (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'reserved') as uses_reserved,
            (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'committed') as uses_committed,
            (select coalesce(sum(r.discount_cents), 0) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'committed') as discount_committed_cents
       from coupons c order by c.active desc, c.created_at desc, c.id desc`);
  return rows.map(adminView);
}

function parseWhen(v, label, end) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') bad(`${label}: data inválida.`, 'invalid_date');
  const t = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T${end ? '23:59:59' : '00:00:00'}-03:00`) : new Date(t);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) bad(`${label}: data inválida.`, 'invalid_date');
  return d;
}
const optInt = (v, min, max, label) => {
  if (v === undefined || v === null || v === '') return null;
  if (!isInt(v) || v < min || v > max) bad(`${label}: informe um número inteiro de ${min} a ${max} (ou deixe vazio).`, 'invalid_field');
  return v;
};

// Cria (sem id) ou edita (com id). O código não muda depois de criado. Sem apagar: desative.
async function save(sql, body, by) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Dados inválidos.');
  const id = body.id === undefined || body.id === null ? null : body.id;
  if (id !== null && (!isInt(id) || id < 1)) bad('Cupom inválido.');
  if (body.kind !== 'percent' && body.kind !== 'fixed') bad('Escolha o tipo do desconto: porcentagem ou valor fixo.', 'invalid_kind');
  const maxValue = body.kind === 'percent' ? 100 : 1000000;
  if (!isInt(body.value) || body.value < 1 || body.value > maxValue) {
    bad(body.kind === 'percent' ? 'Desconto: informe uma porcentagem inteira de 1 a 100.' : 'Desconto: informe o valor em centavos (inteiro, de 1 a 1.000.000).', 'invalid_value');
  }
  const minOrder = body.min_order_cents === undefined || body.min_order_cents === null || body.min_order_cents === '' ? 0 : body.min_order_cents;
  if (!isInt(minOrder) || minOrder < 0 || minOrder > 10000000) bad('Pedido mínimo inválido.', 'invalid_field');
  const starts = parseWhen(body.starts_at, 'Início', false), expires = parseWhen(body.expires_at, 'Validade', true);
  if (starts && expires && expires <= starts) bad('A validade precisa ser depois do início.', 'invalid_window');
  const maxUses = optInt(body.max_uses, 1, 10000000, 'Limite total de usos');
  const perCustomer = optInt(body.max_uses_per_customer, 1, 100000, 'Limite por cliente');
  const active = body.active === undefined ? true : body.active;
  const stacks = body.stacks_with_club === undefined ? false : body.stacks_with_club;
  if (typeof active !== 'boolean' || typeof stacks !== 'boolean') bad('Dados inválidos.');
  let note = null;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    if (typeof body.note !== 'string' || body.note.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(body.note)) bad('Anotação inválida (até 200 caracteres).', 'invalid_field');
    note = body.note.trim() || null;
  }
  let row;
  if (id === null) {
    const code = normalizeCode(body.code);
    if (!code) bad('Código inválido: use de 3 a 20 letras, números ou hífen.', 'invalid_code');
    try {
      [row] = await sql.query(
        `insert into coupons (code, kind, value, min_order_cents, starts_at, expires_at, max_uses, max_uses_per_customer, active, stacks_with_club, note, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [code, body.kind, body.value, minOrder, starts, expires, maxUses, perCustomer, active, stacks, note, String(by || 'admin').slice(0, 60)]);
    } catch (e) {
      if (e && e.code === '23505') throw new CouponError(409, 'Já existe um cupom com esse código.', 'code_taken');
      throw e;
    }
  } else {
    if (body.code !== undefined && body.code !== null && normalizeCode(body.code) !== (await sql.query('select code from coupons where id = $1', [id]).then(r => (r[0] ? r[0].code : null)))) {
      bad('O código do cupom não pode ser alterado. Crie outro cupom.', 'code_locked');
    }
    [row] = await sql.query(
      `update coupons set kind = $2, value = $3, min_order_cents = $4, starts_at = $5, expires_at = $6, max_uses = $7, max_uses_per_customer = $8,
              active = $9, stacks_with_club = $10, note = $11, updated_at = now() where id = $1 returning id`,
      [id, body.kind, body.value, minOrder, starts, expires, maxUses, perCustomer, active, stacks, note]);
    if (!row) throw new CouponError(404, 'Cupom não encontrado.', 'not_found');
  }
  return getOne(sql, row.id);
}

async function getOne(sql, id) {
  const list = await adminList(sql);
  return list.find(c => c.id === id) || null;
}

async function toggle(sql, body) {
  if (!body || !isInt(body.id) || body.id < 1) bad('Cupom inválido.');
  if (body.active !== undefined && typeof body.active !== 'boolean') bad('Informe ligado ou desligado.');
  const rows = await sql.query(`update coupons set active = coalesce($2::boolean, not active), updated_at = now() where id = $1 returning id`, [body.id, body.active === undefined ? null : body.active]);
  if (!rows.length) throw new CouponError(404, 'Cupom não encontrado.', 'not_found');
  return getOne(sql, rows[0].id);
}

// ---------- Público do disparo ----------
const AUDIENCE_TYPES = ['all', 'bought_within', 'inactive_for', 'spent_over'];
function validateAudience(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !AUDIENCE_TYPES.includes(a.type)) bad('Escolha o público do cupom.', 'invalid_audience');
  if (a.type === 'all') return { type: 'all' };
  if (a.type === 'spent_over') {
    if (!isInt(a.cents) || a.cents < 1 || a.cents > 100000000) bad('Valor mínimo gasto inválido.', 'invalid_audience');
    return { type: 'spent_over', cents: a.cents };
  }
  if (!isInt(a.days) || a.days < 1 || a.days > 3650) bad('Número de dias inválido (1 a 3650).', 'invalid_audience');
  return { type: a.type, days: a.days };
}

const MAX_TARGETS = 5000;
// Clientes com conta, consentimento ativo de WhatsApp (e sem opt-out posterior) que batem com o público.
// Compras = pedidos pagos (approved) e não cancelados, ligados à conta pelo cliente OU pelo telefone normalizado.
function audienceSql() {
  return `with paid as (
      select ${phoneKeySql('o.customer_phone')} as pk, max(o.created_at) as last_at, coalesce(sum(o.total_cents), 0) as spent
        from orders o where o.payment_status = 'approved' and o.fulfillment_status <> 'cancelled' group by 1),
    base as (
      select c.id, c.name, c.phone, p.last_at, coalesce(p.spent, 0) as spent
        from customers c left join paid p on p.pk = ${phoneKeySql('c.phone')}
       where c.active and c.whatsapp_consent
         and (c.whatsapp_opt_out_at is null or c.whatsapp_opt_out_at < c.whatsapp_consent_at))
    select id, name, phone from base
     where ($1::text = 'all')
        or ($1::text = 'bought_within' and last_at is not null and last_at > now() - make_interval(days => $2::int))
        or ($1::text = 'inactive_for' and (last_at is null or last_at <= now() - make_interval(days => $2::int)))
        or ($1::text = 'spent_over' and spent >= $3::bigint)
     order by name, id limit ${MAX_TARGETS}`;
}
const audienceParams = a => [a.type, a.days || 0, a.cents || 0];

async function audiencePreview(sql, body) {
  if (!body || !isInt(body.coupon_id) || body.coupon_id < 1) bad('Cupom inválido.');
  const audience = validateAudience(body.audience);
  const [c] = await sql.query('select id from coupons where id = $1', [body.coupon_id]);
  if (!c) throw new CouponError(404, 'Cupom não encontrado.', 'not_found');
  const rows = await sql.query(audienceSql(), audienceParams(audience));
  return { audience, count: rows.length, capped: rows.length >= MAX_TARGETS, preview: rows.slice(0, 10).map(r => ({ customer_id: r.id, name: r.name })) };
}

async function campaignCreate(sql, body, by) {
  if (!body || !isInt(body.coupon_id) || body.coupon_id < 1) bad('Cupom inválido.');
  const audience = validateAudience(body.audience);
  const [c] = await sql.query('select id from coupons where id = $1', [body.coupon_id]);
  if (!c) throw new CouponError(404, 'Cupom não encontrado.', 'not_found');
  const rows = await sql.query(audienceSql(), audienceParams(audience));
  if (!rows.length) throw new CouponError(409, 'Nenhum cliente com consentimento de WhatsApp neste público.', 'empty_audience');
  const [camp] = await sql.query('insert into coupon_campaigns (coupon_id, audience, created_by) values ($1, $2::jsonb, $3) returning id, created_at',
    [body.coupon_id, JSON.stringify(audience), String(by || 'admin').slice(0, 60)]);
  await sql.query(
    `insert into coupon_campaign_targets (campaign_id, customer_id) select $1::int, x from unnest($2::int[]) as x on conflict do nothing`,
    [camp.id, rows.map(r => r.id)]);
  return { campaign_id: camp.id, count: rows.length, audience, created_at: iso(camp.created_at) };
}

const dmy = d => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
function discountText(c) { return c.kind === 'percent' ? `${c.value}% de desconto` : `${moneyBR(c.value)} de desconto`; }

// Mensagem pronta (o link wa.me é montado na tela, não aqui).
function buildMessage(coupon, name) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'tudo bem';
  const valid = coupon.expires_at ? ` Vale até ${dmy(coupon.expires_at)}.` : '';
  return `Oi, ${first}! Aqui é a Gigi, dos Docinhos da Gigi. Separei um cupom para você: ${coupon.code} (${discountText(coupon)}).${valid} É só abrir o link e fazer o seu pedido: ${siteUrl()}/?cupom=${coupon.code}`;
}

// Campanha com a lista de clientes, mensagem pronta e situação de envio. Sem id: lista as campanhas do cupom (coupon_id).
async function campaignGet(sql, { id = null, couponId = null }) {
  if (id === null) {
    if (!isInt(couponId) || couponId < 1) bad('Informe a campanha ou o cupom.');
    const rows = await sql.query(
      `select k.id, k.audience, k.created_by, k.created_at, count(t.customer_id)::int as total, count(t.sent_at)::int as sent
         from coupon_campaigns k left join coupon_campaign_targets t on t.campaign_id = k.id
        where k.coupon_id = $1 group by k.id order by k.created_at desc, k.id desc limit 50`, [couponId]);
    return { campaigns: rows.map(r => ({ id: r.id, audience: r.audience, created_by: r.created_by, created_at: iso(r.created_at), total: r.total, sent: r.sent })) };
  }
  if (!isInt(id) || id < 1) bad('Campanha inválida.');
  const [k] = await sql.query(`select k.id, k.coupon_id, k.audience, k.created_by, k.created_at from coupon_campaigns k where k.id = $1`, [id]);
  if (!k) throw new CouponError(404, 'Campanha não encontrada.', 'not_found');
  const [coupon] = await sql.query('select * from coupons where id = $1', [k.coupon_id]);
  const targets = await sql.query(
    `select t.customer_id, c.name, c.phone, t.sent_at, t.sent_by from coupon_campaign_targets t join customers c on c.id = t.customer_id
      where t.campaign_id = $1 order by c.name, t.customer_id`, [id]);
  return {
    campaign: { id: k.id, coupon_id: k.coupon_id, coupon_code: coupon.code, audience: k.audience, created_by: k.created_by, created_at: iso(k.created_at) },
    targets: targets.map(t => ({
      customer_id: t.customer_id, name: t.name, phone: t.phone, message: buildMessage(coupon, t.name), sent_at: iso(t.sent_at), sent_by: t.sent_by || null
    }))
  };
}

async function targetSent(sql, body, by) {
  if (!body || !isInt(body.campaign_id) || !isInt(body.customer_id) || body.campaign_id < 1 || body.customer_id < 1) bad('Dados inválidos.');
  const sent = body.sent === undefined ? true : body.sent;
  if (typeof sent !== 'boolean') bad('Dados inválidos.');
  const rows = await sql.query(
    `update coupon_campaign_targets set sent_at = case when $3::boolean then coalesce(sent_at, now()) else null end,
            sent_by = case when $3::boolean then coalesce(sent_by, $4::text) else null end
      where campaign_id = $1 and customer_id = $2 returning sent_at`, [body.campaign_id, body.customer_id, sent, String(by || 'admin').slice(0, 60)]);
  if (!rows.length) throw new CouponError(404, 'Cliente não encontrado nesta campanha.', 'not_found');
  return { sent_at: iso(rows[0].sent_at) };
}

module.exports = {
  CouponError, MSG_INVALID, MIN_PRODUCTS_AFTER_DISCOUNT, normalizeCode, discountFor, eligibleSql, reserveStatement, releaseStale,
  onPaymentStatus, releaseForOrder, evaluate, adminList, save, toggle, validateAudience, audiencePreview, campaignCreate,
  campaignGet, targetSent, buildMessage
};
