// Migração v4 (A2): Clube de pontos por itens (N3), cupons (N6), mimo da avaliação (N8) e índice dos relatórios (N5/A-09).
//  - club_rewards: prêmios do Clube (produto + tamanho opcional + custo em pontos);
//  - orders.club_points, orders.coupon_id, orders.coupon_code, orders.coupon_discount_cents;
//  - loyalty_ledger.kind passa a aceitar reward_reserve, reward_release e reward_commit (CHECK ampliado);
//  - coupons, coupon_redemptions, coupon_campaigns, coupon_campaign_targets;
//  - review_gifts (no máximo 1 mimo pendente por telefone: índice único parcial);
//  - índice parcial orders(created_at) where payment_status = 'approved' para os relatórios (A-09);
//  - orders.pix_qr_code, orders.pix_qr_base64, orders.pix_expires_at: Pix guardado para reabrir o pagamento (U-01);
//  - webhook_events: avisos do Mercado Pago aceitos e recusados (401), para o /api/health e o painel (O-01).
//  - admin_push_subscriptions e orders.push_notified_at: Web Push de pedido pago no painel (U-06).
//  - orders.payment_attempt_at (novo pagamento do mesmo pedido) e orders.address_district / address_city (bairro e cidade
//    do CEP, para o rastreio resumido), F3.
// Nota: uma versão anterior (não publicada) deste script criava orders_created_status_idx (created_at, payment_status).
// Ele pode existir no banco dev; não atrapalha e não é recriado aqui (nada de DROP).
// Idempotente e só aditiva: nenhuma tabela ou coluna é apagada ou renomeada; nenhuma linha muda.
// A tabela ingredient_synonyms continua no banco, sem uso (N4).
// Rodar ANTES do deploy do código v4.
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migracoes/migrate-2026-11-12-v4-schema.js
// Produção: só com ordem do Renan, com o mesmo script apontando para o banco de produção.
const sql = require('../../api/_lib/db');

const KINDS = ['earn', 'redeem_reserve', 'redeem_release', 'redeem_commit', 'reversal', 'adjust', 'reward_reserve', 'reward_release', 'reward_commit'];

const STEPS = [
  ['club_rewards', `create table if not exists club_rewards (
     id serial primary key,
     product_id integer not null references products(id) on delete cascade,
     size_complement_id integer references complements(id) on delete cascade,
     points_cost integer not null check (points_cost > 0),
     max_per_order integer not null default 1 check (max_per_order >= 1),
     active boolean not null default true,
     starts_at timestamptz,
     ends_at timestamptz,
     sort_order integer not null default 0,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`],
  ['club_rewards_idx', `create index if not exists club_rewards_active_idx on club_rewards (active, sort_order)`],
  ['coupons', `create table if not exists coupons (
     id serial primary key,
     code text not null unique check (code ~ '^[A-Z0-9-]{3,20}$'),
     kind text not null check (kind in ('percent', 'fixed')),
     value integer not null check (value > 0),
     min_order_cents integer not null default 0 check (min_order_cents >= 0),
     starts_at timestamptz,
     expires_at timestamptz,
     max_uses integer check (max_uses is null or max_uses > 0),
     max_uses_per_customer integer check (max_uses_per_customer is null or max_uses_per_customer > 0),
     active boolean not null default true,
     stacks_with_club boolean not null default false,
     note text,
     created_by text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`],
  ['orders.club_points', `alter table orders add column if not exists club_points integer not null default 0`],
  ['orders.coupon_id', `alter table orders add column if not exists coupon_id integer references coupons(id) on delete set null`],
  ['orders.coupon_code', `alter table orders add column if not exists coupon_code text`],
  ['orders.coupon_discount_cents', `alter table orders add column if not exists coupon_discount_cents integer not null default 0`],
  ['coupon_redemptions', `create table if not exists coupon_redemptions (
     id bigserial primary key,
     coupon_id integer not null references coupons(id) on delete cascade,
     order_id integer not null unique references orders(id) on delete cascade,
     customer_id integer references customers(id) on delete set null,
     phone_key text not null,
     status text not null check (status in ('reserved', 'committed', 'released')),
     discount_cents integer not null default 0,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`],
  ['coupon_redemptions_idx', `create index if not exists coupon_redemptions_coupon_idx on coupon_redemptions (coupon_id, status, phone_key)`],
  ['coupon_campaigns', `create table if not exists coupon_campaigns (
     id serial primary key,
     coupon_id integer not null references coupons(id) on delete cascade,
     audience jsonb not null,
     created_by text,
     created_at timestamptz not null default now()
   )`],
  ['coupon_campaign_targets', `create table if not exists coupon_campaign_targets (
     campaign_id integer not null references coupon_campaigns(id) on delete cascade,
     customer_id integer not null references customers(id) on delete cascade,
     sent_at timestamptz,
     sent_by text,
     primary key (campaign_id, customer_id)
   )`],
  ['review_gifts', `create table if not exists review_gifts (
     id serial primary key,
     phone_key text not null,
     customer_id integer references customers(id) on delete set null,
     granted_order_id integer references orders(id) on delete set null,
     after_order_id integer,
     label text not null default '1 brigadeirinho',
     granted_by text not null,
     granted_at timestamptz not null default now(),
     delivered_order_id integer references orders(id) on delete set null,
     delivered_at timestamptz,
     cancelled_at timestamptz,
     cancelled_by text
   )`],
  ['review_gifts_pending_uq', `create unique index if not exists review_gifts_pending_uq on review_gifts (phone_key) where delivered_at is null and cancelled_at is null`],
  ['orders_paid_created_idx', `create index if not exists orders_paid_created_idx on orders (created_at) where payment_status = 'approved'`],
  ['orders.pix_qr_code', `alter table orders add column if not exists pix_qr_code text`],
  ['orders.pix_qr_base64', `alter table orders add column if not exists pix_qr_base64 text`],
  ['orders.pix_expires_at', `alter table orders add column if not exists pix_expires_at timestamptz`],
  ['webhook_events', `create table if not exists webhook_events (
     id bigserial primary key,
     at timestamptz not null default now(),
     outcome text not null check (outcome in ('accepted', 'unauthorized')),
     detail text
   )`],
  ['webhook_events_idx', `create index if not exists webhook_events_outcome_at_idx on webhook_events (outcome, at desc)`],
  ['admin_push_subscriptions', `create table if not exists admin_push_subscriptions (
     id bigserial primary key,
     username text not null,
     endpoint text not null unique,
     p256dh text not null,
     auth text not null,
     user_agent text,
     created_at timestamptz not null default now(),
     last_ok_at timestamptz,
     fail_count integer not null default 0,
     last_error text
   )`],
  ['admin_push_subscriptions_idx', `create index if not exists admin_push_subscriptions_user_idx on admin_push_subscriptions (username)`],
  ['orders.push_notified_at', `alter table orders add column if not exists push_notified_at timestamptz`],
  // N10: encomenda com data marcada (null = o quanto antes) e índice parcial para contar vagas por janela.
  ['orders.scheduled_for', `alter table orders add column if not exists scheduled_for timestamptz`],
  ['orders_scheduled_for_idx', `create index if not exists orders_scheduled_for_idx on orders (scheduled_for) where scheduled_for is not null`],
  // F3 (A2): novo pagamento do mesmo pedido (retry_payment) e bairro/cidade do CEP para o rastreio resumido.
  ['orders.payment_attempt_at', `alter table orders add column if not exists payment_attempt_at timestamptz`],
  ['orders.address_district', `alter table orders add column if not exists address_district text`],
  ['orders.address_city', `alter table orders add column if not exists address_city text`]
];

(async () => {
  for (const [name, text] of STEPS) {
    await sql.query(text);
    console.log('Pronto:', name);
  }
  // CHECK do ledger ampliado (os valores antigos continuam aceitos). Em uma transação: nunca fica sem a regra.
  await sql.transaction([
    sql.query('alter table loyalty_ledger drop constraint if exists loyalty_ledger_kind_check'),
    sql.query(`alter table loyalty_ledger add constraint loyalty_ledger_kind_check check (kind in (${KINDS.map(k => `'${k}'`).join(', ')}))`)
  ]);
  console.log('Pronto: loyalty_ledger.kind ampliado');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
