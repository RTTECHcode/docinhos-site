// Migração v5: ícone ilustrado das categorias.
//  - categories.icon (text, nulo = sem ícone). Os valores aceitos ficam em api/_lib/category-icons.js.
//  - Sugere um ícone pelo nome SÓ para categoria que ainda não tem ícone (ex.: "Para família" = brigadeiro,
//    "Açaí" = acai). Quem já escolheu no painel não muda. Rodar de novo não altera nada.
// Rodar ANTES do deploy do código v5 (o /api/menu passa a ler categories.icon).
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migracoes/migrate-2026-11-17-v5-category-icon.js
// Produção: só com ordem do Renan, com o mesmo script apontando para o banco de produção.
const sql = require('../../api/_lib/db');
const { suggestIcon } = require('../../api/_lib/category-icons');

(async () => {
  await sql.query('alter table categories add column if not exists icon text');
  console.log('Pronto: categories.icon');
  const rows = await sql.query('select id, name from categories where icon is null order by id');
  for (const c of rows) {
    const icon = suggestIcon(c.name);
    if (!icon) continue;
    await sql.query('update categories set icon = $2 where id = $1 and icon is null', [c.id, icon]);
    console.log(`Ícone sugerido: #${c.id} ${c.name} -> ${icon}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
