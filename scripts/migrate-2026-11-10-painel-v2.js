// Migração do Painel v2 (F2: O1-O13). Idempotente e só aditiva: nada é apagado, renomeado nem reescrito.
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-painel-v2.js
// Uso (produção, só com ordem do Renan): set -a && . ./.env && set +a && node scripts/migrate-2026-11-10-painel-v2.js
const sql = require('../api/_lib/db');

const DEFAULT_BANDS = JSON.stringify([
  { max_km: 3, fee_cents: 600 },
  { max_km: 6, fee_cents: 900 },
  { max_km: 10, fee_cents: 1400 }
]);

const STATEMENTS = [
  // ---- O9: pergunta de segurança e códigos de recuperação do admin ----
  `alter table admin_users add column if not exists security_question text`,
  `alter table admin_users add column if not exists security_answer_hash text`,
  `alter table admin_users add column if not exists security_set_at timestamptz`,
  `create table if not exists admin_recovery_codes (
     id serial primary key,
     user_id integer not null references admin_users(id) on delete cascade,
     code_hash text not null,
     used_at timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists admin_recovery_codes_user_idx on admin_recovery_codes(user_id)`,
  `create table if not exists admin_recovery_attempts (
     id bigserial primary key,
     username text not null,
     ip text,
     ok boolean not null default false,
     at timestamptz not null default now()
   )`,
  `create index if not exists admin_recovery_attempts_user_idx on admin_recovery_attempts(username, at)`,
  `create index if not exists admin_recovery_attempts_ip_idx on admin_recovery_attempts(ip, at)`,

  // ---- O10: clientes ----
  `create table if not exists customers (
     id serial primary key,
     name text not null,
     phone text not null unique,
     email text,
     password_hash text not null,
     security_question text not null,
     security_answer_hash text not null,
     whatsapp_consent boolean not null default false,
     whatsapp_consent_at timestamptz,
     whatsapp_consent_text text,
     whatsapp_consent_version text,
     whatsapp_consent_ip text,
     whatsapp_opt_out_at timestamptz,
     whatsapp_confirmed_at timestamptz,
     birth_day smallint check (birth_day between 1 and 31),
     birth_month smallint check (birth_month between 1 and 12),
     points_locked_until timestamptz,
     active boolean not null default true,
     created_at timestamptz not null default now(),
     last_login_at timestamptz
   )`,
  `create unique index if not exists customers_email_uq on customers (lower(email)) where email is not null`,
  `create table if not exists customer_sessions (
     token_hash text primary key,
     customer_id integer not null references customers(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     ip text,
     ua text
   )`,
  `create index if not exists customer_sessions_customer_idx on customer_sessions(customer_id)`,
  `create index if not exists customer_sessions_exp_idx on customer_sessions(expires_at)`,
  `create table if not exists customer_login_attempts (
     id bigserial primary key,
     scope text not null check (scope in ('login','recover')),
     phone text not null,
     ip text,
     ok boolean not null default false,
     at timestamptz not null default now()
   )`,
  `create index if not exists customer_login_attempts_phone_idx on customer_login_attempts(scope, phone, at)`,
  `create index if not exists customer_login_attempts_ip_idx on customer_login_attempts(scope, ip, at)`,
  `create table if not exists customer_consent_events (
     id bigserial primary key,
     customer_id integer not null references customers(id) on delete cascade,
     channel text not null default 'whatsapp' check (channel in ('whatsapp')),
     action text not null check (action in ('opt_in','opt_out','confirm')),
     text_version text,
     source text,
     ip text,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists customer_consent_events_customer_idx on customer_consent_events(customer_id, created_at)`,

  // ---- O1, O5, O6, O10, O11: novas colunas de pedidos ----
  `alter table orders add column if not exists public_code text`,
  `alter table orders add column if not exists tracking_token_hash text`,
  `alter table orders add column if not exists distance_km numeric(7,2)`,
  `alter table orders add column if not exists discount_cents integer not null default 0`,
  `alter table orders add column if not exists points_redeemed integer not null default 0`,
  `alter table orders add column if not exists customer_id integer references customers(id) on delete set null`,
  `alter table orders add column if not exists accepted_at timestamptz`,
  `alter table orders add column if not exists preparing_at timestamptz`,
  `alter table orders add column if not exists ready_at timestamptz`,
  `alter table orders add column if not exists awaiting_delivery_at timestamptz`,
  `alter table orders add column if not exists completed_at timestamptz`,
  `alter table orders add column if not exists cancelled_at timestamptz`,
  `alter table orders add column if not exists cancel_reason text`,
  `create index if not exists orders_public_code_idx on orders(public_code, created_at)`,
  `create unique index if not exists orders_tracking_token_uq on orders(tracking_token_hash) where tracking_token_hash is not null`,
  `create index if not exists orders_created_idx on orders(created_at desc)`,
  `create index if not exists orders_customer_idx on orders(customer_id, created_at desc)`,

  // ---- O11: pontos ----
  `create table if not exists loyalty_ledger (
     id bigserial primary key,
     customer_id integer not null references customers(id) on delete cascade,
     order_id integer references orders(id) on delete set null,
     kind text not null check (kind in ('earn','redeem_reserve','redeem_release','redeem_commit','reversal','adjust')),
     points integer not null,
     note text,
     created_at timestamptz not null default now()
   )`,
  `create unique index if not exists loyalty_ledger_order_kind_uq on loyalty_ledger(order_id, kind) where order_id is not null`,
  `create index if not exists loyalty_ledger_customer_idx on loyalty_ledger(customer_id, created_at)`,

  // ---- O2: pausa de produto ----
  `alter table products add column if not exists paused boolean not null default false`,
  `alter table products add column if not exists pause_label text`,

  // ---- O3 e O4: horários e estado da loja ----
  `create table if not exists store_hours (
     id serial primary key,
     weekday smallint not null check (weekday between 0 and 6),
     opens time not null,
     closes time not null,
     check (closes > opens)
   )`,
  `create index if not exists store_hours_weekday_idx on store_hours(weekday, opens)`,
  `create table if not exists store_state (
     id smallint primary key check (id = 1),
     closed_until timestamptz,
     closed_indefinitely boolean not null default false,
     closed_message text,
     updated_by text,
     updated_at timestamptz not null default now()
   )`,

  // ---- O5: cache de geocodificação e de rotas ----
  `create table if not exists geocode_cache (
     addr_key text primary key,
     lat double precision not null,
     lon double precision not null,
     display text,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists route_cache (
     origin text not null,
     dest text not null,
     km numeric(7,2) not null,
     created_at timestamptz not null default now(),
     primary key (origin, dest)
   )`,

  // ---- O8: sinônimos de ingredientes ----
  `create table if not exists ingredient_synonyms (
     id serial primary key,
     canonical text not null,
     synonym text not null,
     canonical_norm text not null,
     synonym_norm text not null,
     unique (canonical_norm, synonym_norm)
   )`,
  `insert into ingredient_synonyms (canonical, synonym, canonical_norm, synonym_norm) values
     ('oreo', 'biscoito oreo', 'oreo', 'biscoito oreo'),
     ('morango', 'morangos', 'morango', 'morangos')
   on conflict (canonical_norm, synonym_norm) do nothing`,

  // ---- O8: lotes de pausa por ingrediente (para reativar por termo e desfazer) ----
  `create table if not exists ingredient_pause_batches (
     id serial primary key,
     term text not null,
     term_norm text not null,
     pause_label text,
     created_by text,
     created_at timestamptz not null default now(),
     released_at timestamptz,
     released_by text
   )`,
  `create index if not exists ingredient_pause_batches_open_idx on ingredient_pause_batches (term_norm) where released_at is null`,
  `create table if not exists ingredient_pause_items (
     id serial primary key,
     batch_id integer not null references ingredient_pause_batches(id) on delete cascade,
     product_id integer not null references products(id) on delete cascade,
     complement_id integer references complements(id) on delete cascade,
     changed boolean not null default true,
     prev_pause_label text
   )`,
  `create index if not exists ingredient_pause_items_batch_idx on ingredient_pause_items (batch_id)`,
  `create index if not exists ingredient_pause_items_product_idx on ingredient_pause_items (product_id, complement_id)`,

  // ---- Configurações padrão (não sobrescreve o que o Renan já definiu) ----
  `insert into settings (key, value) values ('default_pause_label', 'volto logo <3') on conflict (key) do nothing`,
  `insert into settings (key, value) values ('shipping_bands', '${DEFAULT_BANDS}') on conflict (key) do nothing`,
  `insert into settings (key, value) values ('store_origin_address', 'Rua Manoel Hare Peralta, 101, Ayrosa, Osasco, SP') on conflict (key) do nothing`
];

(async () => {
  for (const statement of STATEMENTS) await sql.query(statement);
  console.log(`Migração painel-v2 aplicada (${STATEMENTS.length} instruções)`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
