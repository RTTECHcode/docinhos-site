// Teste v4 A-01: scripts/schema.sql sobe em banco VAZIO e é idempotente (roda duas vezes).
// Banco vazio = um schema temporário zz_v4_a2_<aleatório> criado só para o teste e apagado no fim (nada do public muda).
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-schema.js
const fs = require('node:fs');
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FALHA') + ' - ' + msg); if (!cond) fails++; };

(async () => {
  const schema = 'zz_v4_a2_' + crypto.randomBytes(4).toString('hex');
  const statements = fs.readFileSync(__dirname + '/schema.sql', 'utf8').split(';').map(s => s.trim()).filter(Boolean);
  await sql.query(`create schema ${schema}`);
  try {
    const run = () => sql.transaction([sql.query(`set local search_path to ${schema}`), ...statements.map(s => sql.query(s))]);
    let err = null;
    try { await run(); } catch (e) { err = e; }
    ok(!err, 'schema.sql sobe em banco vazio' + (err ? ': ' + err.message : ''));
    let err2 = null;
    try { await run(); } catch (e) { err2 = e; }
    ok(!err2, 'schema.sql roda de novo sem erro (idempotente)' + (err2 ? ': ' + err2.message : ''));
    const tables = (await sql.query(`select table_name from information_schema.tables where table_schema = $1`, [schema])).map(r => r.table_name);
    for (const t of ['customers', 'orders', 'loyalty_ledger', 'club_rewards', 'coupons', 'coupon_redemptions', 'coupon_campaigns',
      'coupon_campaign_targets', 'review_gifts', 'webhook_events', 'admin_audit']) ok(tables.includes(t), 'tabela ' + t);
    const cols = (await sql.query(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = $1`, [schema])).map(r => r.c);
    for (const c of ['customers.address_cep', 'orders.pix_qr_code', 'orders.pix_qr_base64', 'orders.pix_expires_at', 'orders.club_points',
      'orders.coupon_id', 'orders.coupon_code', 'orders.coupon_discount_cents']) ok(cols.includes(c), 'coluna ' + c);
    const [idx] = await sql.query(`select indexdef from pg_indexes where schemaname = $1 and indexname = 'orders_paid_created_idx'`, [schema]);
    ok(idx && /where \(payment_status = 'approved'::text\)/i.test(idx.indexdef), 'índice parcial orders_paid_created_idx (A-09)');
  } finally {
    await sql.query(`drop schema ${schema} cascade`); // só o schema temporário criado acima
  }
  console.log(fails ? `\n${fails} falha(s)` : '\nTudo certo');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error('Erro:', e.message); process.exitCode = 1; });
