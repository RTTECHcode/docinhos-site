// Migração de dados v4 (A2, N3): prêmios iniciais do Clube, SÓ no banco de desenvolvimento, todos DESLIGADOS.
// Serve para o painel e a loja terem o que mostrar no teste. A Gigi escolhe os prêmios de verdade e liga no painel.
//  - Só roda carregado por scripts/dev-env.js (GIGI_ENV_LOADED=1). Sem isso, recusa (nunca roda em produção por engano).
//  - Só insere se club_rewards estiver vazia (idempotente: rodar de novo não duplica).
//  - Escolhe os 3 produtos ativos mais baratos, com preço próprio e sem grupo de escolha obrigatória.
//  - Custo em pontos = preço x 10 x pontos por real (ex.: R$ 5,00 com 1 ponto por real = 50 pontos, 10% de volta).
// Uso: node -r ./scripts/dev-env.js scripts/migrate-2026-11-12-v4-club-seed.js
if (process.env.GIGI_ENV_LOADED !== '1') {
  console.error('Recusado: este script só roda no banco de desenvolvimento (node -r ./scripts/dev-env.js ...).');
  process.exit(1);
}
const sql = require('../api/_lib/db');
const { getRules } = require('../api/_lib/loyalty');

(async () => {
  const [{ n }] = await sql.query('select count(*)::int n from club_rewards');
  if (n > 0) { console.log(`club_rewards já tem ${n} prêmio(s): nada a fazer.`); return; }
  const rules = await getRules(sql);
  const ppr = Math.max(1, Number(rules.points_per_real) || 1);
  const products = await sql.query(
    `select p.id, p.price_cents from products p join categories c on c.id = p.category_id
      where p.active and c.active and not p.paused and p.price_cents is not null and p.price_cents > 0
        and not exists (select 1 from product_groups g where g.product_id = p.id and g.min_choices > 0)
      order by p.price_cents, p.id limit 3`);
  let order = 0;
  for (const p of products) {
    const cost = Math.min(100000, Math.max(1, Math.ceil((p.price_cents * ppr) / 10)));
    await sql.query(
      `insert into club_rewards (product_id, points_cost, max_per_order, active, sort_order)
       select $1, $2, 1, false, $3 where not exists (select 1 from club_rewards where product_id = $1 and size_complement_id is null)`,
      [p.id, cost, order++]);
    console.log(`Prêmio criado (desligado): produto #${p.id}, ${cost} pontos`);
  }
  if (!products.length) console.log('Nenhum produto elegível: nenhum prêmio criado.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
