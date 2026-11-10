// QA (A8, F5): pontos pelo webhook do Mercado Pago, com assinatura real (segredo do .env.dev, nunca impresso).
// Pedido aprovado credita pontos (1 por R$ 1,00 do subtotal depois do desconto); recusado, valor errado ou assinatura inválida não creditam.
// A consulta ao Mercado Pago (GET /v1/payments/:id) é simulada; o resto (handler, banco, loyalty) é o código real.
// Uso: node -r ./scripts/dev-env.js scripts/test-qa-points.js   (banco dev; cria e apaga dados ZZ-a8)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');
const handler = require('../api/mp-webhook');
const customer = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');

const NAME = 'ZZ-a8 Pontos';
const POINT_KEYS = Object.values(loyalty.RULE_KEYS);
const Q = (t, p = []) => sql.query(t, p);
const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
let seq = 0;

async function notify(order, mpStatus, { amountCents, badSig } = {}) {
  const dataId = String(900000000 + Math.floor(Math.random() * 9e7) + ++seq);
  const requestId = 'req-qa-' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const v1 = crypto.createHmac('sha256', badSig ? 'segredo-errado' : secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.mercadopago.com/v1/payments/')) {
      return new Response(JSON.stringify({ id: Number(dataId), status: mpStatus, external_reference: order.code,
        transaction_amount: (amountCents ?? order.total_cents) / 100, currency_id: 'BRL', payment_method_id: 'pix' }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  const res = { code: null, setHeader() {}, status(c) { res.code = c; return res; }, json() { return res; } };
  try {
    await handler({ method: 'POST', query: { 'data.id': dataId, type: 'payment' }, headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      body: { type: 'payment', data: { id: dataId } } }, res);
  } finally { global.fetch = realFetch; }
  return res.code;
}

async function mkOrder(customerId, tag, { subtotal, discount = 0, points = 0 }) {
  const code = 'ZZA8' + tag + crypto.randomBytes(3).toString('hex').toUpperCase();
  const [o] = await Q(`insert into orders (code, customer_id, customer_name, customer_phone, delivery_method, items, subtotal_cents, delivery_fee_cents,
      discount_cents, points_redeemed, total_cents, payment_status, fulfillment_status)
    values ($1, $2, $3, '11900008899', 'pickup', '[]'::jsonb, $4, 0, $5, $6, $7, 'pending', 'new') returning id, code, total_cents`,
    [code, customerId, NAME + ' ' + tag, subtotal, discount, points, subtotal - discount]);
  if (points) await Q(`insert into loyalty_ledger (customer_id, order_id, kind, points, note) values ($1, $2, 'redeem_reserve', $3, 'qa')`, [customerId, o.id, -points]);
  return o;
}
const ledger = async orderId => (await Q('select kind, points from loyalty_ledger where order_id = $1 order by id', [orderId])).map(r => r.kind + ':' + r.points);
const payStatus = async id => (await Q('select payment_status from orders where id = $1', [id]))[0].payment_status;

async function cleanup() {
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like 'ZZ-a8%')`);
  await Q(`delete from orders where customer_name like 'ZZ-a8 Pontos%'`);
  await Q(`delete from customers where name like 'ZZ-a8 Pontos%'`);
}

(async () => {
  if (!secret) { console.log('test-qa-points: MERCADOPAGO_WEBHOOK_SECRET ausente no .env.dev; teste de assinatura não roda.'); process.exit(1); }
  await cleanup();
  const phone = '119' + String(10000000 + Math.floor(Math.random() * 89999999));
  const { customer: c } = await customer.createAccount(sql, { name: NAME, phone, password: 'Qa-' + crypto.randomBytes(9).toString('base64url'),
    security_question: 'prof_favorito', security_answer: 'zz resposta qa' }, { ip: '10.88.8.90', ua: 'test-qa-points' });
  try {
    await loyalty.adjust(sql, { customerId: c.id, points: 300, note: 'qa saldo inicial' });

    // A: aprovado credita 25 pontos (R$ 25,50 -> 25); notificação repetida não credita de novo.
    const a = await mkOrder(c.id, 'A', { subtotal: 2550 });
    assert.equal(await notify(a, 'approved'), 200);
    assert.equal(await payStatus(a.id), 'approved');
    assert.deepEqual(await ledger(a.id), ['earn:25'], 'aprovado credita 25');
    assert.equal(await notify(a, 'approved'), 200);
    assert.deepEqual(await ledger(a.id), ['earn:25'], 'repetição não duplica');

    // B: recusado não credita.
    const b = await mkOrder(c.id, 'B', { subtotal: 3000 });
    assert.equal(await notify(b, 'rejected'), 200);
    assert.equal(await payStatus(b.id), 'rejected');
    assert.deepEqual(await ledger(b.id), [], 'recusado não credita');

    // B2: pendente não credita.
    const p = await mkOrder(c.id, 'P', { subtotal: 4000 });
    assert.equal(await notify(p, 'pending'), 200);
    assert.deepEqual(await ledger(p.id), [], 'pendente não credita');

    // C: com resgate de 100 pontos (R$ 10): aprovado confirma o resgate e credita só sobre o que foi pago (R$ 10 -> 10).
    const cc = await mkOrder(c.id, 'C', { subtotal: 2000, discount: 1000, points: 100 });
    assert.equal(await notify(cc, 'approved'), 200);
    assert.deepEqual(await ledger(cc.id), ['redeem_reserve:-100', 'redeem_commit:0', 'earn:10'], 'resgate confirmado + ganho sobre o pago');

    // D: com resgate, recusado: devolve os pontos reservados e não credita.
    const d = await mkOrder(c.id, 'D', { subtotal: 2000, discount: 1000, points: 100 });
    assert.equal(await notify(d, 'rejected'), 200);
    assert.deepEqual(await ledger(d.id), ['redeem_reserve:-100', 'redeem_release:100'], 'recusado devolve a reserva');

    // E: aprovado com valor diferente do pedido: ignorado.
    const e = await mkOrder(c.id, 'E', { subtotal: 5000 });
    assert.equal(await notify(e, 'approved', { amountCents: 100 }), 200);
    assert.equal(await payStatus(e.id), 'pending', 'valor errado não aprova');
    assert.deepEqual(await ledger(e.id), [], 'valor errado não credita');

    // F: assinatura inválida: 401 e nada muda.
    const f = await mkOrder(c.id, 'F', { subtotal: 5000 });
    assert.equal(await notify(f, 'approved', { badSig: true }), 401);
    assert.equal(await payStatus(f.id), 'pending');
    assert.deepEqual(await ledger(f.id), [], 'assinatura inválida não credita');

    // Saldo final: 300 + 25 - 100 + 10 = 235.
    const pts = await customer.getPoints(sql, c.id, { limit: 50 });
    assert.equal(pts.balance, 235, 'saldo final ' + pts.balance);

    // Regra editável (Ajustes do painel). O banco dev é compartilhado: a regra fica alterada só durante estes casos.
    const pointsSnap = await Q('select key, value from settings where key = any($1::text[])', [POINT_KEYS]);
    try {
      await loyalty.saveRules(sql, { enabled: true, points_per_real: 2, block_points: 50, block_value_cents: 500 });
      // G: pedido já creditado não muda com a regra nova (notificação repetida).
      assert.equal(await notify(a, 'approved'), 200);
      assert.deepEqual(await ledger(a.id), ['earn:25'], 'já creditado não muda');
      // H: aprovado depois da mudança credita pela regra em vigor: R$ 25,50 x 2 = 51.
      const g = await mkOrder(c.id, 'G', { subtotal: 2550 });
      assert.equal(await notify(g, 'approved'), 200);
      assert.deepEqual(await ledger(g.id), ['earn:51'], 'regra nova: 2 pontos por R$ 1');
      // I: resgate pela regra nova (50 pontos = R$ 5) e confirmado; ganho sobre o pago (R$ 15 x 2 = 30).
      const i = await mkOrder(c.id, 'I', { subtotal: 2000, discount: 500, points: 50 });
      assert.equal(await notify(i, 'approved'), 200);
      assert.deepEqual(await ledger(i.id), ['redeem_reserve:-50', 'redeem_commit:0', 'earn:30']);
      // J: programa desligado: aprovado confirma o resgate já reservado, mas não credita pontos novos.
      await loyalty.saveRules(sql, { enabled: false, points_per_real: 2, block_points: 50, block_value_cents: 500 });
      const j = await mkOrder(c.id, 'J', { subtotal: 2000, discount: 500, points: 50 });
      assert.equal(await notify(j, 'approved'), 200);
      assert.deepEqual(await ledger(j.id), ['redeem_reserve:-50', 'redeem_commit:0'], 'desligado não credita');
      const bal = await customer.getPoints(sql, c.id, { limit: 5 });
      assert.equal(bal.balance, 235 + 51 - 50 + 30 - 50, 'saldo depois da regra nova');
      assert.deepEqual([bal.points_enabled, bal.points_per_real, bal.block_points, bal.block_value_cents], [false, 2, 50, 500]);
    } finally {
      await Q('delete from settings where key = any($1::text[])', [POINT_KEYS]);
      for (const r of pointsSnap) await Q('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
    }
    console.log('test-qa-points: todos os testes passaram (aprovado credita, recusado/pendente/valor errado/assinatura inválida não creditam; regra editável e programa desligado).');
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch(async e => { console.error('FALHA', e.message); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
