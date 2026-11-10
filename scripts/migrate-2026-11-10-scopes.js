// Migração: amplia o CHECK de customer_login_attempts.scope para aceitar 'register' (cadastro) e 'password' (troca de senha).
// Antes só valiam 'login' e 'recover', e o código guardava chaves falsas na coluna phone ('#cadastro', '#senha:+55...').
// Também cria a coluna orders.client_ip (limite de pedidos por IP, A1-05).
// Idempotente e só aditiva: o CHECK novo aceita tudo o que o antigo aceitava; nenhuma linha ou coluna é apagada.
// Rodar ANTES do deploy do código que usa os scopes novos e a coluna nova (senão o cadastro e o pedido falham).
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-scopes.js
// Uso (produção, só com ordem do Renan): set -a && . ./.env && set +a && node scripts/migrate-2026-11-10-scopes.js
const sql = require('../api/_lib/db');

const SCOPES = ['login', 'recover', 'register', 'password'];
const CONSTRAINT = 'customer_login_attempts_scope_check';

(async () => {
  // CHECKs atuais da tabela que mencionam a coluna scope (o nome padrão do Postgres é customer_login_attempts_scope_check).
  const checks = await sql.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'customer_login_attempts'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%scope%'`);
  const done = checks.length === 1 && checks[0].conname === CONSTRAINT && SCOPES.every(s => checks[0].def.includes(`'${s}'`));
  if (done) {
    console.log('CHECK de scope já aceita: ' + SCOPES.join(', '));
  } else {
    // Troca na mesma transação: a tabela nunca fica sem CHECK.
    await sql.transaction([
      ...checks.map(c => sql.query(`alter table customer_login_attempts drop constraint if exists "${c.conname.replace(/"/g, '')}"`)),
      sql.query(`alter table customer_login_attempts add constraint ${CONSTRAINT} check (scope in (${SCOPES.map(s => `'${s}'`).join(', ')}))`)
    ]);
    console.log('CHECK de scope ampliado: ' + SCOPES.join(', '));
  }
  await sql.query('alter table orders add column if not exists client_ip text');
  await sql.query('create index if not exists orders_client_ip_idx on orders (client_ip, created_at) where client_ip is not null');
  console.log('Coluna orders.client_ip pronta');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
