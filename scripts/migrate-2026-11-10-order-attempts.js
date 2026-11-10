// Migração: cria a tabela order_attempts (uma linha por tentativa de pedido em POST /api/order, aceita ou recusada).
// Serve para o limite por IP contar também os pedidos recusados (400, 409, 422, 429, 503...), antes da consulta de frete.
// Idempotente e só aditiva: nenhuma linha ou coluna é apagada. As linhas com mais de 1 dia são apagadas pelo próprio
// /api/order de vez em quando (são só IP + horário, sem dado pessoal além do IP).
// Rodar ANTES do deploy do código que usa a tabela (senão o pedido falha com 500).
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-order-attempts.js
// Uso (produção, só com ordem do Renan): set -a && . ./.env && set +a && node scripts/migrate-2026-11-10-order-attempts.js
const sql = require('../api/_lib/db');

(async () => {
  await sql.query(`create table if not exists order_attempts (
     id bigserial primary key,
     ip text not null,
     at timestamptz not null default now()
   )`);
  await sql.query('create index if not exists order_attempts_ip_idx on order_attempts (ip, at)');
  console.log('Tabela order_attempts pronta');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
