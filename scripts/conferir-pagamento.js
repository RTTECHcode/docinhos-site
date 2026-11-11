// Confere no Mercado Pago o pagamento de pedidos pendentes e aplica a MESMA validação do webhook
// (moeda, valor, idempotência, pontos), via api/_lib/payments.checkOrderPayment. Uso LOCAL, nunca por web.
// É o equivalente ao botão "Conferir pagamento" do admin, para quando o painel ainda não tem o botão.
//
// Uso (ids numéricos dos pedidos):
//   node --env-file=.env scripts/conferir-pagamento.js 208 211      (produção, só com ordem do Renan)
//   node -r ./scripts/dev-env.js scripts/conferir-pagamento.js 12  (banco dev)
// Sem --aplicar só mostra o que encontrou no Mercado Pago (nada é gravado). Com --aplicar grava e registra em admin_audit.
const sql = require('../api/_lib/db');
const payments = require('../api/_lib/payments');

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--aplicar');
  const ids = args.filter(a => /^\d+$/.test(a)).map(Number);
  if (!ids.length) throw new Error('Informe os ids dos pedidos. Ex.: node --env-file=.env scripts/conferir-pagamento.js 208 211');
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN não definido.');

  const rows = await sql.query(
    'select id, code, public_code, payment_id, payment_method, payment_status, total_cents from orders where id = any($1) order by id', [ids]);
  for (const o of rows) {
    const label = o.public_code || o.code;
    if (!apply) {
      let pay = null;
      if (o.payment_method === 'pix' && /^\d+$/.test(String(o.payment_id || ''))) pay = await payments.fetchPayment(token, o.payment_id);
      if (!pay) pay = payments.pickPayment(await payments.searchPaymentsByReference(token, o.code));
      console.log(label, `pedido: ${o.payment_status}, total ${o.total_cents} centavos`,
        pay ? `| MP: ${pay.status}, ${pay.transaction_amount} ${pay.currency_id}` : '| MP: nenhum pagamento');
      continue;
    }
    if (o.payment_status !== 'pending') { console.log(label, `já está "${o.payment_status}", nada a fazer`); continue; }
    const r = await payments.checkOrderPayment(sql, o, { source: 'script' });
    const [now] = await sql.query('select payment_status from orders where id = $1', [o.id]);
    await sql.query(`insert into admin_audit (username, action, detail) values ($1, 'pagamento_conferido', $2)`,
      ['script-local', `${label}: ${o.payment_status} -> ${now.payment_status} (${r.outcome})`]);
    console.log(label, `${o.payment_status} -> ${now.payment_status} (${r.outcome})`);
  }
  const missing = ids.filter(id => !rows.some(r => r.id === id));
  if (missing.length) console.log('Pedidos não encontrados:', missing.join(', '));
  if (!apply) console.log('\nNada foi gravado. Para aplicar, rode de novo com --aplicar.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => process.exit());
