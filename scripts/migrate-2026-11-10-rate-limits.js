// Migração: cria a tabela rate_hits (contagem por minuto de consultas por IP) para os limites de GET /api/order-status
// (acompanhamento do pedido) e GET /api/store?a=quote (cotação de frete). Antes esses limites ficavam em memória, por
// instância da função; no banco valem para todas as instâncias da Vercel.
// Idempotente e só aditiva: nenhuma linha ou coluna é apagada. As linhas com mais de 1 dia são apagadas pelas próprias
// funções de vez em quando (são só escopo + IP + minuto + total, sem dado pessoal além do IP).
// Rodar ANTES do deploy do código que usa a tabela (senão o acompanhamento e a cotação de frete falham com 500).
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-rate-limits.js
// Uso (produção, só com ordem do Renan): set -a && . ./.env && set +a && node scripts/migrate-2026-11-10-rate-limits.js
const sql = require('../api/_lib/db');

(async () => {
  await sql.query(`create table if not exists rate_hits (
     scope text not null,
     ip text not null,
     minute timestamptz not null,
     n integer not null default 1,
     primary key (scope, ip, minute)
   )`);
  await sql.query('create index if not exists rate_hits_minute_idx on rate_hits (minute)');
  console.log('Tabela rate_hits pronta');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
