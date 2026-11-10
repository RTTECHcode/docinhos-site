// Teste da rodada A2 contra o banco de DESENVOLVIMENTO: limites do POST /api/order antes do frete e webhook de
// pedido cancelado que recebe pagamento aprovado depois.
// Uso: node -r ./scripts/dev-env.js scripts/test-order-limits.js
// Não mexe em configurações da loja (horário, frete, origem): o estado "aberta" e a rede do frete são simulados
// só neste processo. Dados de teste: pedidos "ZZ-A2 limites", clientes "ZZ-A2 ...", IPs "a2teste-...". Tudo é
// apagado no começo e no fim.
const assert = require('node:assert/strict');
const sql = require('../api/_lib/db');
const storeHours = require('../api/_lib/store-hours');
const shipping = require('../api/_lib/shipping');
const loyalty = require('../api/_lib/loyalty');
const customerLib = require('../api/_lib/customer');
const handler = require('../api/order');
const webhook = require('../api/mp-webhook');

const NAME = 'ZZ-A2 limites';
const HOST = 'loja.a2.local';
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const newIp = () => 'a2teste-' + rnd(8);
const phone = () => '119' + rnd(8);
const { MAX_ATTEMPTS_PER_IP, MAX_ORDERS_PER_PHONE, MAX_ORDERS_PER_IP } = handler._internal;

function run(fn, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; }
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}
const call = (body, ip, extra = {}) => run(handler, {
  method: 'POST', body, headers: { host: HOST, origin: 'https://' + HOST, 'content-type': 'application/json', 'x-real-ip': ip, ...extra }
});
const delivery = (over = {}) => ({
  customer_name: NAME, customer_phone: phone(), delivery_method: 'delivery', cep: '06000000', address: 'Rua ZZ A2, 10', address_number: '10',
  items: [{ product_id: 1, qty: 1 }], ...over
});

// Rede do frete: conta as chamadas (nenhuma deve acontecer quando o pedido é barrado antes do frete).
let netCalls = 0;
const countingFetch = async () => { netCalls++; throw new Error('rede desligada no teste'); };

// Pedido gravado direto no banco (para encher os limites sem passar pelo handler).
const insertOrder = (over = {}) => {
  const o = { code: 'ZZA2' + rnd(10), public_code: 'ZZ-' + rnd(6), customer_id: null, customer_phone: phone(), client_ip: null,
    subtotal_cents: 3000, total_cents: 3000, points_redeemed: 0, discount_cents: 0, fulfillment_status: 'new', payment_status: 'pending', ...over };
  return sql.query(
    `insert into orders (code, public_code, customer_id, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, total_cents,
                         points_redeemed, discount_cents, fulfillment_status, payment_status, client_ip)
     values ($1, $2, $3, $4, $5, 'pickup', 'Loja', '[]'::jsonb, $6, $7, $8, $9, $10, $11, $12) returning *`,
    [o.code, o.public_code, o.customer_id, NAME, o.customer_phone, o.subtotal_cents, o.total_cents, o.points_redeemed, o.discount_cents,
      o.fulfillment_status, o.payment_status, o.client_ip]).then(r => r[0]);
};

async function payWebhook(order, status, paymentId) {
  const real = globalThis.fetch;
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
  const savedSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  delete process.env.MERCADOPAGO_WEBHOOK_SECRET; // assinatura tem teste próprio (test-mp-webhook)
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.mercadopago.com/')) return real(url, init); // o driver do banco usa fetch
    return { ok: true, status: 200, json: async () => ({ id: Number(paymentId), status, external_reference: order.code, transaction_amount: order.total_cents / 100, currency_id: 'BRL', payment_method_id: 'pix' }) };
  };
  try { return await run(webhook, { method: 'POST', query: {}, body: { type: 'payment', data: { id: paymentId } }, headers: {} }); }
  finally {
    globalThis.fetch = real; delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (savedSecret !== undefined) process.env.MERCADOPAGO_WEBHOOK_SECRET = savedSecret;
  }
}

const publicCodes = [];
async function cleanup() {
  await sql.query(`delete from admin_audit where action = 'pagamento_apos_cancelamento' and detail like 'Pedido ZZ-%'`);
  await sql.query('delete from orders where customer_name = $1', [NAME]);
  await sql.query(`delete from customers where name like 'ZZ-A2 %'`);
  await sql.query(`delete from order_attempts where ip like 'a2teste-%'`);
  await sql.query(`delete from customer_login_attempts where ip like 'a2teste-%'`);
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

(async () => {
  await cleanup();
  const realState = storeHours.getStoreState;
  storeHours.getStoreState = async () => ({ open: true }); // loja aberta só neste processo (sem mexer em store_hours)
  shipping.setFetch(countingFetch);

  console.log('Item 1: limites do pedido antes do frete');
  await t('pedidos recusados (400) contam por IP: passou de 20 tentativas em 10 min = 429 rate_limited; outro IP segue', async () => {
    const ip = newIp();
    for (let i = 0; i < MAX_ATTEMPTS_PER_IP; i++) {
      const r = await call({ customer_name: '' }, ip); assert.equal(r.status, 400, 'tentativa ' + (i + 1));
    }
    const r = await call(delivery(), ip);
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(netCalls, 0, 'sem consulta de frete');
    const [{ n }] = await sql.query('select count(*)::int n from order_attempts where ip = $1', [ip]);
    assert.equal(n, MAX_ATTEMPTS_PER_IP + 1, 'a recusa 429 também entra na conta');
    assert.equal((await call({ customer_name: '' }, newIp())).status, 400, 'outro IP livre');
  });
  await t('403 (outro site) e 415 (sem JSON) não gastam a cota do IP', async () => {
    const ip = newIp();
    for (let i = 0; i < MAX_ATTEMPTS_PER_IP + 5; i++) {
      assert.equal((await call({}, ip, { origin: 'https://outro.site' })).status, 403);
      assert.equal((await call('x', ip, { 'content-type': 'text/plain' })).status, 415);
    }
    assert.equal((await call({ customer_name: '' }, ip)).status, 400);
  });
  await t('limite por telefone (5 pedidos em 10 min) é checado ANTES do frete', async () => {
    const p = phone();
    for (let i = 0; i < MAX_ORDERS_PER_PHONE; i++) await insertOrder({ customer_phone: p });
    netCalls = 0;
    const r = await call(delivery({ customer_phone: p }), newIp());
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(netCalls, 0, 'frete não consultado');
  });
  await t('limite por IP (10 pedidos criados em 10 min) é checado ANTES do frete, mesmo trocando o telefone', async () => {
    const ip = newIp();
    for (let i = 0; i < MAX_ORDERS_PER_IP; i++) await insertOrder({ client_ip: ip });
    netCalls = 0;
    const r = await call(delivery(), ip);
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(netCalls, 0, 'frete não consultado');
  });
  await t('teto global de consultas novas de endereço (como no /api/store): 429 shipping_busy sem consultar; retirada não é afetada', async () => {
    const real = shipping.tooManyNewLookups;
    shipping.tooManyNewLookups = async () => true;
    try {
      netCalls = 0;
      const r = await call(delivery(), newIp());
      assert.equal(r.status, 429); assert.equal(r.body.code, 'shipping_busy'); assert.match(r.body.error, /consultas de frete/);
      assert.equal(netCalls, 0);
      const pick = await call({ customer_name: NAME, customer_phone: phone(), delivery_method: 'pickup', items: [] }, newIp());
      assert.equal(pick.status, 400, 'retirada segue para a validação normal'); assert.match(pick.body.error, /carrinho/);
    } finally { shipping.tooManyNewLookups = real; }
  });
  await t('tooManyNewLookups: 39 consultas no último minuto libera, 40 barra', async () => {
    const fake = n => ({ query: async () => [{ n }] });
    assert.equal(shipping.MAX_NEW_LOOKUPS_PER_MINUTE, 40);
    assert.equal(await shipping.tooManyNewLookups(fake(39)), false);
    assert.equal(await shipping.tooManyNewLookups(fake(40)), true);
  });

  console.log('\nItem 4: pedido cancelado que recebe pagamento aprovado');
  const mkCustomer = async tag => (await customerLib.createAccount(sql, {
    name: 'ZZ-A2 ' + tag, phone: phone(), password: 'senha-de-teste-1', security_question: 'prof_favorito', security_answer: 'Dona Maria'
  }, { ip: newIp() })).customer;
  const auditRows = code => sql.query(`select username, detail from admin_audit where action = 'pagamento_apos_cancelamento' and detail like $1`, [`Pedido ${code} %`]);
  const kinds = async orderId => (await sql.query('select kind from loyalty_ledger where order_id = $1 order by id', [orderId])).map(r => r.kind);

  await t('cancelado + aprovado: grava o pagamento, NÃO credita pontos e deixa UM aviso na auditoria (webhook repetido não duplica)', async () => {
    const c = await mkCustomer('Cancelado');
    const o = await insertOrder({ customer_id: c.id, fulfillment_status: 'cancelled' });
    publicCodes.push(o.public_code);
    const pid = '71' + rnd(8);
    assert.equal((await payWebhook(o, 'approved', pid)).status, 200);
    const [row] = await sql.query('select payment_status from orders where id = $1', [o.id]);
    assert.equal(row.payment_status, 'approved', 'status real do pagamento fica registrado');
    assert.equal((await loyalty.getBalance(sql, c.id)).balance, 0, 'sem pontos');
    assert.deepEqual(await kinds(o.id), []);
    for (let i = 0; i < 3; i++) await payWebhook(o, 'approved', pid);
    const rows = await auditRows(o.public_code);
    assert.equal(rows.length, 1, 'um aviso só');
    assert.match(rows[0].detail, new RegExp(`Pedido ${o.public_code} .*cancelado.*${pid}.*Estorne o valor manualmente no Mercado Pago`));
    assert.equal(rows[0].username, 'mercadopago');
    assert.ok(!webhook._internal.CANCELLED_PAID_ACTION.includes('falhou'), 'não é evento só de admin (A1-08): staff também vê');
  });
  await t('cancelado com pontos reservados (já devolvidos no cancelamento): aprovado depois não cobra os pontos de novo', async () => {
    const c = await mkCustomer('Resgate');
    await loyalty.adjust(sql, { customerId: c.id, points: 200, note: 'saldo de teste' });
    const o = await insertOrder({ customer_id: c.id, points_redeemed: 100, discount_cents: 500, total_cents: 2500 });
    publicCodes.push(o.public_code);
    assert.equal(await loyalty.reserve(sql, { customerId: c.id, orderId: o.id, points: 100 }), true);
    await sql.query(`update orders set fulfillment_status = 'cancelled' where id = $1`, [o.id]);
    await loyalty.releaseReserve(sql, o.id, 'pedido cancelado');
    assert.equal((await loyalty.getBalance(sql, c.id)).balance, 200);
    await payWebhook(o, 'approved', '72' + rnd(8));
    assert.equal((await loyalty.getBalance(sql, c.id)).balance, 200, 'saldo intacto');
    assert.deepEqual(await kinds(o.id), ['redeem_reserve', 'redeem_release'], 'sem adjust, commit ou earn');
    assert.equal((await auditRows(o.public_code)).length, 1);
  });
  await t('controle: pedido NÃO cancelado e aprovado credita os pontos normalmente, sem aviso', async () => {
    const c = await mkCustomer('Normal');
    const o = await insertOrder({ customer_id: c.id });
    publicCodes.push(o.public_code);
    await payWebhook(o, 'approved', '73' + rnd(8));
    assert.equal((await loyalty.getBalance(sql, c.id)).balance, 30);
    assert.equal((await auditRows(o.public_code)).length, 0);
  });
  await t('cancelado sem cliente (pedido de visitante): aviso também é gravado', async () => {
    const o = await insertOrder({ fulfillment_status: 'cancelled' });
    publicCodes.push(o.public_code);
    await payWebhook(o, 'approved', '74' + rnd(8));
    assert.equal((await auditRows(o.public_code)).length, 1);
  });
  await t('cancelado com pagamento recusado: sem aviso', async () => {
    const o = await insertOrder({ fulfillment_status: 'cancelled' });
    publicCodes.push(o.public_code);
    await payWebhook(o, 'rejected', '75' + rnd(8));
    assert.equal((await auditRows(o.public_code)).length, 0);
  });

  storeHours.getStoreState = realState;
  shipping.setFetch(null);
  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error('limpeza:', e.message); } });
