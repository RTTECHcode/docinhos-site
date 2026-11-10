// Preenche o código curto DG-#### (public_code) dos pedidos antigos, feitos antes da migração painel-v2.
// Só acrescenta: preenche public_code onde está vazio. O código antigo (coluna code) continua igual,
// porque é a referência do pedido no Mercado Pago. Idempotente: rodar de novo não muda nada.
// Evita repetir um DG-#### já usado nos últimos 90 dias, a mesma regra de api/order.js.
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/migrate-2026-11-10-public-code-backfill.js
// Uso (produção, só com ordem do Renan): node --env-file=.env scripts/migrate-2026-11-10-public-code-backfill.js
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');

(async () => {
  const pending = await sql.query(`select id, created_at from orders where public_code is null order by created_at, id`);
  if (!pending.length) { console.log('Nenhum pedido sem código curto. Nada a fazer.'); return; }

  // Códigos já usados, com a data, para respeitar a janela de 90 dias.
  const used = await sql.query(`select public_code, created_at from orders where public_code is not null`);
  const taken = used.map(r => ({ code: r.public_code, at: new Date(r.created_at).getTime() }));
  const DAY = 86400000;

  let done = 0;
  for (const o of pending) {
    const at = new Date(o.created_at).getTime();
    const near = new Set(taken.filter(t => Math.abs(t.at - at) < 90 * DAY).map(t => t.code));
    let code = null;
    for (let i = 0; i < 200 && !code; i++) {
      const c = `DG-${crypto.randomInt(1000, 10000)}`;
      if (!near.has(c)) code = c;
    }
    if (!code) code = `DG-${crypto.randomInt(1000, 10000)}`; // janela cheia (improvável): aceita repetir com pedido distante
    const r = await sql.query(`update orders set public_code = $1 where id = $2 and public_code is null returning id`, [code, o.id]);
    if (r.length) { taken.push({ code, at }); done++; }
  }
  console.log(`Códigos curtos preenchidos: ${done} de ${pending.length} pedidos antigos.`);
})().then(() => process.exit(0)).catch(e => { console.error('Falhou:', e.message); process.exit(1); });
