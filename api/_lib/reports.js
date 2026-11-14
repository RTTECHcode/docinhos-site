'use strict';
/*
 * Relatórios do painel (v4 N5). Só perfil admin (a permissão é conferida em api/admin.js). Tudo agregado no servidor.
 *  - Venda = pedido com payment_status 'approved' e não cancelado (pedido pago e cancelado depois tem o dinheiro estornado à mão).
 *  - Datas: dia de São Paulo (AAAA-MM-DD). Período máximo: 366 dias (A1: limite de 12 meses). Padrão: últimos 30 dias.
 *  - Clientes: uma linha por telefone normalizado (conta ou visitante), juntando pedidos e contas pelo phone_key.
 *  - CSV: BOM UTF-8, separador ';', todas as células entre aspas (aspas duplicadas) e prefixo ' em células que começam com
 *    = + - @ tab ou CR (contra fórmula maliciosa no Excel). Telefone completo no CSV só com pii=1.
 *  - Nada de dado pessoal em log. A auditoria (admin.js) grava filtros e quantidade de linhas, nunca o termo buscado.
 */
const { phoneKeySql } = require('./text');

class ReportError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }
const bad = (message, code) => { throw new ReportError(400, message, code); };

const TZ = 'America/Sao_Paulo';
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const PAGE_SIZE = 50;
const CSV_MAX_ROWS = 10000;
const PAID = `payment_status = 'approved' and fulfillment_status <> 'cancelled'`;

// ---------- Datas ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function todaySP(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

// from/to opcionais (AAAA-MM-DD). Retorna { from, to } válidos (to inclusive).
function parseRange(fromRaw, toRaw, now = new Date()) {
  const check = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) {
      bad(`${label}: use o formato AAAA-MM-DD.`, 'invalid_date');
    }
    return v;
  };
  let from = check(fromRaw, 'Data inicial'), to = check(toRaw, 'Data final');
  if (!to) to = from ? addDays(from, DEFAULT_RANGE_DAYS - 1) : todaySP(now);
  if (!from) from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (to < from) bad('A data final precisa ser igual ou depois da inicial.', 'invalid_range');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) bad(`Escolha um período de até ${MAX_RANGE_DAYS} dias.`, 'range_too_long');
  return { from, to };
}
// Trecho SQL do período ($1 = from, $2 = to, dias de São Paulo, to inclusive).
const RANGE_SQL = `created_at >= ($1::date)::timestamp at time zone '${TZ}' and created_at < (($2::date + 1))::timestamp at time zone '${TZ}'`;

// ---------- Vendas ----------
async function sales(sql, { from: fromRaw, to: toRaw } = {}) {
  const { from, to } = parseRange(fromRaw, toRaw);
  const p = [from, to];
  const [[tot], [all], byPayment, byDelivery, top, byWeekday, byHour, byDay] = await Promise.all([
    sql.query(
      `select count(*)::int as paid_orders,
              coalesce(sum(subtotal_cents + delivery_fee_cents), 0)::bigint as gross_cents,
              coalesce(sum(delivery_fee_cents), 0)::bigint as delivery_fee_cents,
              coalesce(sum(discount_cents), 0)::bigint as discount_cents,
              coalesce(sum(coupon_discount_cents), 0)::bigint as coupon_discount_cents,
              coalesce(sum(club_points), 0)::bigint as club_points_spent,
              coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL}`, p),
    sql.query(
      `select count(*)::int as total_orders, count(*) filter (where payment_status <> 'approved')::int as unpaid_orders
         from orders where ${RANGE_SQL}`, p),
    sql.query(
      `select case when payment_method = 'pix' then 'pix' else 'card' end as k, count(*)::int as orders, coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL} group by 1 order by 1`, p),
    sql.query(
      `select case when delivery_method = 'pickup' then 'pickup' else 'delivery' end as k, count(*)::int as orders, coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL} group by 1 order by 1`, p),
    sql.query(
      `select coalesce(i->>'name', '?') as name,
              sum(case when (i->>'qty') ~ '^[0-9]{1,4}$' then (i->>'qty')::int else 0 end) filter (where coalesce(i->>'reward', 'false') <> 'true')::int as qty,
              sum(case when (i->>'qty') ~ '^[0-9]{1,4}$' and (i->>'unit_total_cents') ~ '^[0-9]{1,9}$'
                       then (i->>'qty')::int * (i->>'unit_total_cents')::bigint else 0 end)::bigint as revenue_cents,
              coalesce(sum(case when (i->>'qty') ~ '^[0-9]{1,4}$' then (i->>'qty')::int else 0 end) filter (where i->>'reward' = 'true'), 0)::int as reward_qty
         from orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as i
        where ${PAID.replace(/payment_status/g, 'o.payment_status').replace(/fulfillment_status/g, 'o.fulfillment_status')} and ${RANGE_SQL.replace(/created_at/g, 'o.created_at')}
        group by 1 order by qty desc nulls last, revenue_cents desc limit 10`, p),
    sql.query(
      `select extract(dow from created_at at time zone '${TZ}')::int as k, count(*)::int as orders, coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL} group by 1 order by 1`, p),
    sql.query(
      `select extract(hour from created_at at time zone '${TZ}')::int as k, count(*)::int as orders, coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL} group by 1 order by 1`, p),
    sql.query(
      `select to_char(created_at at time zone '${TZ}', 'YYYY-MM-DD') as day, count(*)::int as paid_orders,
              coalesce(sum(subtotal_cents + delivery_fee_cents), 0)::bigint as gross_cents, coalesce(sum(delivery_fee_cents), 0)::bigint as delivery_fee_cents,
              coalesce(sum(discount_cents), 0)::bigint as discount_cents, coalesce(sum(total_cents), 0)::bigint as net_cents
         from orders where ${PAID} and ${RANGE_SQL} group by 1 order by 1`, p)
  ]);
  const n = v => Number(v);
  const split = (rows, keys) => Object.fromEntries(keys.map(k => {
    const r = rows.find(x => x.k === k);
    return [k, { orders: r ? r.orders : 0, net_cents: r ? n(r.net_cents) : 0 }];
  }));
  const fill = (rows, size) => Array.from({ length: size }, (_, k) => {
    const r = rows.find(x => x.k === k);
    return { k, orders: r ? r.orders : 0, net_cents: r ? n(r.net_cents) : 0 };
  });
  const net = n(tot.net_cents);
  return {
    from, to, timezone: TZ,
    paid_orders: tot.paid_orders,
    gross_cents: n(tot.gross_cents), delivery_fee_cents: n(tot.delivery_fee_cents), discount_cents: n(tot.discount_cents),
    coupon_discount_cents: n(tot.coupon_discount_cents), club_points_spent: n(tot.club_points_spent), net_cents: net,
    avg_ticket_cents: tot.paid_orders ? Math.round(net / tot.paid_orders) : 0,
    total_orders: all.total_orders, unpaid_orders: all.unpaid_orders,
    unpaid_rate: all.total_orders ? Math.round((all.unpaid_orders / all.total_orders) * 10000) / 10000 : 0,
    by_payment: split(byPayment, ['pix', 'card']),
    by_delivery: split(byDelivery, ['delivery', 'pickup']),
    top_products: top.map(r => ({ name: r.name, qty: r.qty || 0, revenue_cents: n(r.revenue_cents), reward_qty: r.reward_qty || 0 })),
    by_weekday: fill(byWeekday, 7).map(({ k, ...r }) => ({ weekday: k, ...r })),
    by_hour: fill(byHour, 24).map(({ k, ...r }) => ({ hour: k, ...r })),
    by_day: byDay.map(r => ({ day: r.day, paid_orders: r.paid_orders, gross_cents: n(r.gross_cents), delivery_fee_cents: n(r.delivery_fee_cents),
      discount_cents: n(r.discount_cents), net_cents: n(r.net_cents) }))
  };
}

// ---------- Clientes ----------
const SORTS = { name: 'lower(name)', paid_orders: 'paid_orders', spent: 'spent_cents', last_order: 'last_order_at', points: 'points_balance' };

function parseCustomerQuery({ s, sort, dir, page } = {}) {
  const search = typeof s === 'string' ? s.trim().slice(0, 60) : '';
  const sortKey = Object.prototype.hasOwnProperty.call(SORTS, sort) ? sort : 'spent';
  const direction = dir === 'asc' ? 'asc' : 'desc';
  const pg = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), 100000);
  return { search, sort: sortKey, dir: direction, page: pg };
}

function customersSql(limitSql) {
  const pkOrders = phoneKeySql('o.customer_phone'), pkCust = phoneKeySql('c.phone');
  return `with agg as (
      select ${pkOrders} as pk,
             (array_agg(o.customer_name order by o.created_at desc))[1] as last_name,
             count(*) filter (where o.payment_status = 'approved' and o.fulfillment_status <> 'cancelled')::int as paid_orders,
             coalesce(sum(o.total_cents) filter (where o.payment_status = 'approved' and o.fulfillment_status <> 'cancelled'), 0)::bigint as spent_cents,
             max(o.created_at) as last_order_at,
             max(o.created_at) filter (where o.payment_status = 'approved' and o.fulfillment_status <> 'cancelled') as last_paid_at
        from orders o group by 1),
    cust as (
      select c.id, c.name, c.phone, ${pkCust} as pk,
             (c.active and c.whatsapp_consent and (c.whatsapp_opt_out_at is null or c.whatsapp_opt_out_at < c.whatsapp_consent_at)) as wa
        from customers c),
    base as (
      select coalesce(c.pk, a.pk) as pk, coalesce(c.name, a.last_name) as name, coalesce(c.phone, a.pk) as phone, c.id as customer_id,
             coalesce(a.paid_orders, 0) as paid_orders, coalesce(a.spent_cents, 0) as spent_cents, a.last_order_at, a.last_paid_at,
             coalesce(c.wa, false) as whatsapp_consent,
             coalesce((select sum(l.points) from loyalty_ledger l where l.customer_id = c.id), 0)::int as points_balance
        from agg a full outer join cust c on c.pk = a.pk
       where coalesce(c.pk, a.pk) <> '')
    select b.*, count(*) over ()::int as total_rows,
           (select case when g.delivered_at is not null then 'delivered' when g.cancelled_at is not null then 'cancelled' else 'pending' end
              from review_gifts g where g.phone_key = b.pk order by g.granted_at desc, g.id desc limit 1) as gift_status,
           (select g.id from review_gifts g where g.phone_key = b.pk and g.delivered_at is null and g.cancelled_at is null limit 1) as gift_pending_id
      from base b
     where ($1::text = '' or strpos(lower(b.name), lower($1::text)) > 0 or ($2::text <> '' and strpos(b.pk, $2::text) > 0))
     order by %ORDER%, b.pk
     ${limitSql}`;
}

const customerRow = r => ({
  phone_key: r.pk, name: r.name, phone: r.phone, customer_id: r.customer_id, has_account: r.customer_id !== null,
  paid_orders: r.paid_orders, spent_cents: Number(r.spent_cents),
  last_order_at: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
  last_paid_at: r.last_paid_at ? new Date(r.last_paid_at).toISOString() : null,
  points_balance: r.points_balance, whatsapp_consent: !!r.whatsapp_consent,
  gift_status: r.gift_status || null, gift_pending_id: r.gift_pending_id || null
});

async function customers(sql, rawQuery = {}) {
  const q = parseCustomerQuery(rawQuery);
  const digits = q.search.replace(/\D/g, '');
  const order = `${SORTS[q.sort]} ${q.dir} nulls last`;
  const text = customersSql(`limit ${PAGE_SIZE} offset ${(q.page - 1) * PAGE_SIZE}`).replace('%ORDER%', order);
  const rows = await sql.query(text, [q.search, digits.length >= 3 ? digits : '']);
  const total = rows.length ? rows[0].total_rows : 0;
  return { ...q, page_size: PAGE_SIZE, total, total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), customers: rows.map(customerRow) };
}

// ---------- CSV ----------
const FORMULA_START = /^[=+\-@\t\r]/;
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_START.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const csvLine = cells => cells.map(csvCell).join(';');
const csvDoc = (header, rows) => '\uFEFF' + [csvLine(header), ...rows.map(csvLine)].join('\r\n') + '\r\n';
const reais = cents => (Number(cents) / 100).toFixed(2).replace('.', ',');
const dtBR = iso => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');
const maskPhone = pk => (pk ? '*'.repeat(Math.max(0, String(pk).length - 4)) + String(pk).slice(-4) : '');
const GIFT_TEXT = { pending: 'pendente', delivered: 'entregue', cancelled: 'cancelado' };

async function customersCsv(sql, rawQuery = {}, { pii = false } = {}) {
  const q = parseCustomerQuery(rawQuery);
  const digits = q.search.replace(/\D/g, '');
  const text = customersSql(`limit ${CSV_MAX_ROWS}`).replace('%ORDER%', `${SORTS[q.sort]} ${q.dir} nulls last`);
  const rows = (await sql.query(text, [q.search, digits.length >= 3 ? digits : ''])).map(customerRow);
  const header = ['Nome', 'Telefone', 'Conta', 'Pedidos pagos', 'Total gasto (R$)', 'Último pedido', 'Saldo de pontos', 'WhatsApp autorizado', 'Mimo'];
  const body = rows.map(r => [r.name, pii ? r.phone_key : maskPhone(r.phone_key), r.has_account ? 'sim' : 'não', r.paid_orders, reais(r.spent_cents),
    dtBR(r.last_order_at), r.points_balance, r.whatsapp_consent ? 'sim' : 'não', GIFT_TEXT[r.gift_status] || '']);
  return { csv: csvDoc(header, body), rows: rows.length, capped: rows.length >= CSV_MAX_ROWS, filters: { sort: q.sort, dir: q.dir, search: q.search !== '' } };
}

async function salesCsv(sql, range = {}) {
  const r = await sales(sql, range);
  const header = ['Dia', 'Pedidos pagos', 'Bruto (R$)', 'Frete (R$)', 'Descontos (R$)', 'Líquido (R$)'];
  const body = r.by_day.map(d => [d.day, d.paid_orders, reais(d.gross_cents), reais(d.delivery_fee_cents), reais(d.discount_cents), reais(d.net_cents)]);
  body.push(['TOTAL', r.paid_orders, reais(r.gross_cents), reais(r.delivery_fee_cents), reais(r.discount_cents), reais(r.net_cents)]);
  return { csv: csvDoc(header, body), rows: r.by_day.length, from: r.from, to: r.to };
}

module.exports = {
  ReportError, TZ, MAX_RANGE_DAYS, DEFAULT_RANGE_DAYS, PAGE_SIZE, CSV_MAX_ROWS,
  todaySP, parseRange, parseCustomerQuery, sales, customers, csvCell, csvDoc, customersCsv, salesCsv, maskPhone
};
