// Migração v3 (A2): endereço do cliente na conta (D1) e cache de CEP (D3).
//  - customers: colunas address_cep, address_street, address_number, address_complement, address_district, address_city (1 endereço por conta);
//  - cep_cache: cache de CEP -> rua/bairro/cidade/UF (consulta ViaCEP de GET /api/store?a=cep).
// Idempotente e só aditiva: nenhuma linha, coluna ou tabela é apagada ou alterada.
// Rodar ANTES do deploy do código v3 (o cadastro com endereço, a conta e a consulta de CEP usam as colunas e a tabela novas).
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-v3-schema.js
// Uso (produção, só com ordem do Renan): node --env-file=.env scripts/migrate-2026-11-10-v3-schema.js
const sql = require('../api/_lib/db');

(async () => {
  for (const col of ['address_cep', 'address_street', 'address_number', 'address_complement', 'address_district', 'address_city']) {
    await sql.query(`alter table customers add column if not exists ${col} text`);
  }
  console.log('Colunas de endereço em customers prontas');
  await sql.query(`create table if not exists cep_cache (
     cep text primary key,
     logradouro text not null default '',
     bairro text not null default '',
     localidade text not null default '',
     uf text not null default '',
     created_at timestamptz not null default now()
   )`);
  console.log('Tabela cep_cache pronta');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
