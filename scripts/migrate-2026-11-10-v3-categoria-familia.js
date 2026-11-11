// Migração v3 (A2, D7): renomeia a categoria "Sobremesas tamanho família" para "Para família".
// Idempotente e não destrutiva: só renomeia (os ids e os produtos da categoria continuam os mesmos). Só age se a categoria antiga
// existir e a nova ainda não existir; rodar de novo não faz nada. Não apaga nem move nada.
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-v3-categoria-familia.js
// Uso (produção, só com ordem do Renan): node --env-file=.env scripts/migrate-2026-11-10-v3-categoria-familia.js
const sql = require('../api/_lib/db');

(async () => {
  const rows = await sql.query(
    `update categories set name = 'Para família'
      where name = 'Sobremesas tamanho família' and not exists (select 1 from categories where name = 'Para família')
      returning id`);
  console.log(rows.length ? `Categoria renomeada para "Para família" (id ${rows[0].id})` : 'Nada a fazer (categoria já renomeada ou inexistente)');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
