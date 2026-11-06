// Migração do painel /admin (idempotente e só aditiva: nada é apagado nem alterado de forma destrutiva).
// Uso: set -a && . ./.env && set +a && node scripts/migrate-admin.js
const sql = require('../api/db');

const STATEMENTS = [
  `create table if not exists admin_users (
     id serial primary key,
     username text not null unique,
     password_hash text not null,
     role text not null default 'staff' check (role in ('admin','staff')),
     weak_password boolean not null default false,
     active boolean not null default true,
     created_at timestamptz not null default now(),
     last_login_at timestamptz
   )`,
  `alter table admin_users add column if not exists active boolean not null default true`,
  `create table if not exists admin_sessions (
     token_hash text primary key,
     user_id integer not null references admin_users(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     ip text,
     ua text
   )`,
  `create index if not exists admin_sessions_user_idx on admin_sessions(user_id)`,
  `create index if not exists admin_sessions_exp_idx on admin_sessions(expires_at)`,
  `create table if not exists login_attempts (
     id bigserial primary key,
     username text not null,
     ip text,
     ok boolean not null default false,
     at timestamptz not null default now()
   )`,
  `create index if not exists login_attempts_user_idx on login_attempts(username, at)`,
  `create index if not exists login_attempts_ip_idx on login_attempts(ip, at)`,
  `create table if not exists admin_audit (
     id bigserial primary key,
     username text,
     action text not null,
     detail text,
     at timestamptz not null default now()
   )`,
  `create index if not exists admin_audit_at_idx on admin_audit(at desc)`,
  `create table if not exists images (
     id serial primary key,
     mime text not null,
     data bytea not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists settings (
     key text primary key,
     value text not null
   )`,
  `alter table product_complements add column if not exists paused boolean not null default false`,
  `alter table orders add column if not exists fulfillment_status text not null default 'new'`
];

(async () => {
  for (const statement of STATEMENTS) await sql.query(statement);
  console.log(`Migração do admin aplicada (${STATEMENTS.length} instruções)`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
