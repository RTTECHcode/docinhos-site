// Testes v4 (A2) da rodada F3 (pedidos do A4) contra o banco de DESENVOLVIMENTO:
//  1. POST /api/order?a=retry_payment (novo Pix ou link do cartão do mesmo pedido);
//  2. tracking_url em GET /api/customer?a=orders (link ?o=<id> que só abre com a sessão do dono);
//  3. itens e endereço resumido (bairro e cidade; retirada = loja) em GET /api/order-status.
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-f3.js
//  - Produtos, categoria, pedidos, cupons e contas "ZZ-v4-a2" criados aqui e apagados no final.
//  - Mercado Pago simulado (fetch trocado; o driver do banco segue no fetch real). Token falso no processo, nenhuma chamada externa.
//  - O ajuste scheduling_slot_capacity é copiado no começo e restaurado no final. O horário da loja NÃO é alterado.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.MERCADOPAGO_ACCESS_TOKEN = 'zz-token-falso-de-teste';
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const sql = require('../api/_lib/db');
const orderHandler = require('../api/order');
const statusHandler = require('../api/order-status');
const customerHandler = require('../api/customer');
const ordersLib = require('../api/_lib/orders');
const payments = require('../api/_lib/payments');
const customerLib = require('../api/_lib/customer');
const hours = require('../api/_lib/store-hours');
const sched = require('../api/_lib/scheduling');

const P = 'ZZ-v4-a2';
const CAT = `${P} F3 Categoria`;
const Q = (t, p = []) => sql.query(t, p);
const HOST = 'loja.test.local';
let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}.f3${crypto.randomBytes(2).toString('hex')}`; // TEST-NET-2: apagado no final
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const phone = () => '119' + rnd(8);

function runJson(fn, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      end(text) { let b = null; try { b = JSON.parse(text); } catch { b = text; } resolve({ status: this.statusCode, body: b }); }
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}
const site = (cookie, fixedIp) => ({ host: HOST, origin: 'https://' + HOST, 'content-type': 'application/json', 'x-real-ip': fixedIp || ip(), ...(cookie ? { cookie } : {}) });
const order = (body, cookie) => runJson(orderHandler, { method: 'POST', url: '/api/order', body, headers: site(cookie) });
const retry = (body, { cookie, fixedIp, headers } = {}) =>
  runJson(orderHandler, { method: 'POST', url: '/api/order?a=retry_payment', query: { a: 'retry_payment' }, body, headers: headers || site(cookie, fixedIp) });
const track = (query, cookie) => runJson(statusHandler, { method: 'GET', query, headers: { 'x-real-ip': ip(), ...(cookie ? { cookie } : {}) } });
const cust = (method, a, { body, cookie } = {}) => runJson(customerHandler, { method, url: `/api/customer?a=${a}`, body, headers: site(cookie) });

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', String(e.message).split('\n')[0].slice(0, 300)); process.exitCode = 1; }
}

// ---------- Mercado Pago simulado ----------
const mp = { payments: new Map(), prefs: [], pixKeys: [], prefKeys: [] }; // payments: id -> { status, amount, code, created }
const realFetch = global.fetch;
let seq = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://api.mercadopago.com/v1/payments' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    mp.pixKeys.push(opts.headers['X-Idempotency-Key']);
    const id = 870000000 + (++seq);
    mp.payments.set(String(id), { status: 'pending', amount: b.transaction_amount, code: b.external_reference, created: new Date().toISOString() });
    return new Response(JSON.stringify({ id, status: 'pending', date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString(),
      point_of_interaction: { transaction_data: { qr_code: '00020126ZZF3PIX' + id, qr_code_base64: 'iVBORw0KGgoZZF3' + id } } }), { status: 201 });
  }
  if (u === 'https://api.mercadopago.com/checkout/preferences' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    mp.prefKeys.push(opts.headers['X-Idempotency-Key']);
    mp.prefs.push(b);
    const id = 'zz-pref-' + (++seq);
    return new Response(JSON.stringify({ id, init_point: 'https://mp.test.local/checkout/' + id }), { status: 201 });
  }
  const m = u.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
  if (m && mp.payments.has(m[1])) {
    const p = mp.payments.get(m[1]);
    return new Response(JSON.stringify({ id: Number(m[1]), status: p.status, external_reference: p.code, transaction_amount: p.amount,
      currency_id: 'BRL', payment_method_id: 'pix', date_created: p.created }), { status: 200 });
  }
  if (u.startsWith('https://api.mercadopago.com/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
  return realFetch(url, opts); // o driver do banco (Neon) também usa fetch
};

// ---------- dados e restauração ----------
const CAP_KEY = sched.KEYS.slot_capacity;
let capSnap = null;
async function cleanup() {
  await Q(`delete from coupons where code like 'ZZV4A2-F3%'`); // cascata: coupon_redemptions
  const ids = (await Q(`select id from orders where customer_name like $1`, [P + '%'])).map(r => r.id);
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like $1) or order_id = any($2::int[])`, [P + '%', ids]);
  await Q(`delete from orders where id = any($1::int[])`, [ids]);
  await Q(`delete from rate_hits where ip like '198.51.100.%' or ip = any($1::text[])`, [ids.map(i => 'order:' + i)]);
  await Q(`delete from order_attempts where ip like '198.51.100.%'`);
  await Q(`delete from customers where name like $1`, [P + '%']);
  await Q(`delete from products where name like $1`, [P + '%']);
  await Q(`delete from categories where name = $1`, [CAT]);
}
async function restore() {
  if (!capSnap) return;
  await Q('delete from settings where key = $1', [CAP_KEY]);
  for (const r of capSnap) await Q('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
}
// Pedido gravado direto no banco, com token de rastreio. Retorna { id, code, token }.
async function mkOrder(fields = {}) {
  const f = { pay: 'pending', status: 'new', created: '0 minutes', scheduled: null, method: 'pix', payId: null, ...fields };
  const code = 'ZZF3' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const tr = ordersLib.newTrackingToken();
  const items = [{ product_id: null, name: `${P} Doce`, size: 'Médio', extras: [], qty: 2, unit_total_cents: 500 }];
  const [o] = await Q(`insert into orders (code, public_code, tracking_token_hash, customer_name, customer_phone, delivery_method, address, items, subtotal_cents,
      delivery_fee_cents, discount_cents, points_redeemed, total_cents, payment_status, payment_method, payment_id, fulfillment_status, created_at, scheduled_for)
    values ($1, 'DG-0000', $2, $3, $4, 'pickup', 'Loja', $5::jsonb, 1000, 0, 0, 0, 1000, $6, $7, $8, $9, now() - $10::interval, $11) returning id`,
    [code, tr.hash, `${P} F3 ${f.label || 'direto'}`, phone(), JSON.stringify(items), f.pay, f.method, f.payId, f.status, f.created, f.scheduled]);
  return { id: o.id, code, token: tr.token };
}
const row = async id => (await Q('select payment_status, payment_method, payment_id, pix_qr_code, pix_expires_at, payment_attempt_at from orders where id = $1', [id]))[0];

(async () => {
  await cleanup();
  capSnap = await Q('select key, value from settings where key = $1', [CAP_KEY]);
  const st0 = await hours.getStoreState(sql);
  if (!st0.open) { console.error('A loja do dev está fechada agora: o teste precisa dela aberta (não altero o horário).'); process.exit(1); }
  const [cat] = await Q(`insert into categories (name, sort_order, active) values ($1, 9999, true) returning id`, [CAT]);
  const [doce] = await Q(`insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, 1000, true, 9999) returning id`, [cat.id, `${P} F3 Doce`]);
  const body = (extra = {}) => ({ customer_name: `${P} F3 Pedido`, customer_phone: phone(), delivery_method: 'pickup', items: [{ product_id: doce.id, qty: 2 }], ...extra });

  try {
    console.log('1. retry_payment');
    const r0 = await order(body({ payment_choice: 'pix' }));
    assert.equal(r0.status, 201, JSON.stringify(r0.body));
    const tok = r0.body.tracking_token;
    const firstPix = r0.body.payment.id;

    await t('Pix de novo: novo pagamento, nova chave de idempotência, Pix gravado (U-01) e visto no order-status', async () => {
      const r = await retry({ t: tok });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.payment.type, 'pix'); assert.equal(r.body.payment_choice, 'pix');
      assert.notEqual(r.body.payment.id, firstPix);
      assert.equal(r.body.total_cents, 2000);
      assert.equal(mp.pixKeys[0], `pix-${r0.body.code}`, 'pedido novo continua com a chave antiga');
      assert.match(mp.pixKeys[1], new RegExp(`^pix-${r0.body.code}-[0-9a-f]{8}$`));
      const o = await row(r0.body.id);
      assert.equal(o.payment_id, r.body.payment.id); assert.equal(o.payment_method, 'pix'); assert.equal(o.payment_status, 'pending');
      assert.equal(o.pix_qr_code, r.body.payment.qr_code); assert.ok(o.payment_attempt_at);
      const s = await track({ t: tok });
      assert.equal(s.body.pix.qr_code, r.body.payment.qr_code);
    });
    await t('aviso atrasado do Pix antigo (cancelado) é ignorado; o novo segue pendente', async () => {
      const old = mp.payments.get(String(firstPix));
      const r = await payments.syncPayment(sql, { id: Number(firstPix), status: 'cancelled', external_reference: r0.body.code, transaction_amount: 20,
        currency_id: 'BRL', payment_method_id: 'pix', date_created: new Date(Date.now() - 10 * 60000).toISOString() }, { source: 'teste' });
      assert.equal(r.outcome, 'stale'); assert.ok(old);
      const o = await row(r0.body.id);
      assert.equal(o.payment_status, 'pending'); assert.ok(o.pix_qr_code, 'Pix novo continua guardado');
    });
    await t('isSuperseded: aprovado vale sempre; sem data ou sem retry não ignora', async () => {
      const at = new Date();
      const old = new Date(at.getTime() - 60000).toISOString();
      assert.equal(payments.isSuperseded({ status: 'cancelled', date_created: old }, { payment_attempt_at: at }), true);
      assert.equal(payments.isSuperseded({ status: 'approved', date_created: old }, { payment_attempt_at: at }), false);
      assert.equal(payments.isSuperseded({ status: 'cancelled' }, { payment_attempt_at: at }), false);
      assert.equal(payments.isSuperseded({ status: 'cancelled', date_created: old }, { payment_attempt_at: null }), false);
      assert.equal(payments.isSuperseded({ status: 'rejected', date_created: new Date(at.getTime() - 1000).toISOString() }, { payment_attempt_at: at }), false, 'folga de 2 s');
    });
    await t('troca para cartão: link novo, itens somam o total, volta para o pedido, Pix apagado', async () => {
      const r = await retry({ t: tok, payment_choice: 'card' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.payment.type, 'card'); assert.match(r.body.payment.url, /^https:\/\/mp\.test\.local\//);
      const pref = mp.prefs[mp.prefs.length - 1];
      assert.equal(pref.items.reduce((s, i) => s + Math.round(i.unit_price * 100) * i.quantity, 0), 2000);
      assert.ok(pref.back_urls.success.includes('t=' + encodeURIComponent(tok)));
      assert.match(mp.prefKeys[mp.prefKeys.length - 1], new RegExp(`^pref-${r0.body.code}-[0-9a-f]{8}$`));
      const o = await row(r0.body.id);
      assert.equal(o.payment_method, 'mercadopago_card'); assert.equal(o.payment_id, r.body.payment.id);
      assert.equal(o.pix_qr_code, null); assert.equal(o.pix_expires_at, null);
      assert.equal((await track({ t: tok })).body.pix, null);
    });
    await t('limite por pedido: a 4ª tentativa em 10 min = 429 (de IPs diferentes)', async () => {
      const r = await retry({ t: tok, payment_choice: 'pix' });
      assert.equal(r.status, 200, 'terceira passa');
      const r4 = await retry({ t: tok, payment_choice: 'pix' });
      assert.equal(r4.status, 429); assert.equal(r4.body.code, 'rate_limited');
    });
    await t('limite por IP: 11ª chamada em 10 min = 429 (até token inválido conta)', async () => {
      const fixed = ip();
      const rs = [];
      for (let i = 0; i < 11; i++) rs.push(await retry({ t: 'x'.repeat(22) }, { fixedIp: fixed }));
      assert.ok(rs.slice(0, 10).every(r => r.status === 404));
      assert.equal(rs[10].status, 429);
    });
    await t('entrada: token inválido 404; payment_choice inválido 400; sem origem 403; ação desconhecida 404; GET 405', async () => {
      assert.equal((await retry({ t: 'curto' })).status, 404);
      assert.equal((await retry({})).status, 404);
      const o = await mkOrder({ label: 'entrada' });
      const r = await retry({ t: o.token, payment_choice: 'boleto' });
      assert.equal(r.status, 400);
      const h = site(); delete h.origin;
      assert.equal((await retry({ t: o.token }, { headers: h })).status, 403);
      const u = await runJson(orderHandler, { method: 'POST', url: '/api/order?a=outra', query: { a: 'outra' }, body: {}, headers: site() });
      assert.equal(u.status, 404); assert.equal(u.body.code, 'unknown_action');
      assert.equal((await runJson(orderHandler, { method: 'GET', url: '/api/order?a=retry_payment', query: { a: 'retry_payment' }, headers: site() })).status, 405);
    });
    await t('recusas: pago, cancelado, mais de 24 h, cartão em análise, horário já passado', async () => {
      const cases = [
        [{ pay: 'approved' }, 'already_paid'], [{ pay: 'refunded' }, 'already_paid'], [{ status: 'cancelled' }, 'order_cancelled'],
        [{ created: '25 hours' }, 'retry_expired'], [{ pay: 'in_process', method: 'mercadopago_card' }, 'payment_in_process'],
        [{ scheduled: new Date(Date.now() - 3600000).toISOString() }, 'schedule_passed']
      ];
      for (const [f, code] of cases) {
        const o = await mkOrder({ label: code, ...f });
        const r = await retry({ t: o.token });
        assert.equal(r.status, 409, code + ' ' + JSON.stringify(r.body)); assert.equal(r.body.code, code);
      }
    });
    await t('pagamento recusado sem reserva: pode pagar de novo (Pix)', async () => {
      const o = await mkOrder({ label: 'recusado', pay: 'rejected', method: 'mercadopago_card' });
      const r = await retry({ t: o.token, payment_choice: 'pix' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await row(o.id)).payment_status, 'pending');
    });
    await t('pago entre a última consulta e o retry: confere no Mercado Pago e responde 409 already_paid', async () => {
      const r1 = await order(body({ payment_choice: 'pix' }));
      mp.payments.get(String(r1.body.payment.id)).status = 'approved';
      const n = mp.pixKeys.length;
      const r = await retry({ t: r1.body.tracking_token });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'already_paid');
      assert.equal(mp.pixKeys.length, n, 'nenhum Pix novo');
      assert.equal((await row(r1.body.id)).payment_status, 'approved');
    });
    await t('cupom: reserva continua a mesma no retry; devolvida = 409 reservation_released', async () => {
      await Q(`insert into coupons (code, kind, value, min_order_cents, active, created_by, note) values ('ZZV4A2-F3C', 'percent', 10, 0, true, 'zz-v4-a2', 'teste')`);
      const r1 = await order(body({ payment_choice: 'pix', coupon_code: 'ZZV4A2-F3C' }));
      assert.equal(r1.status, 201, JSON.stringify(r1.body));
      const r = await retry({ t: r1.body.tracking_token, payment_choice: 'card' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const pref = mp.prefs[mp.prefs.length - 1];
      assert.equal(pref.items.reduce((s, i) => s + Math.round(i.unit_price * 100) * i.quantity, 0), r1.body.total_cents, 'com desconto');
      const red = await Q('select status, discount_cents from coupon_redemptions where order_id = $1', [r1.body.id]);
      assert.equal(red.length, 1); assert.equal(red[0].status, 'reserved'); assert.equal(red[0].discount_cents, r1.body.coupon_discount_cents);
      await Q(`update coupon_redemptions set status = 'released' where order_id = $1`, [r1.body.id]);
      const r2 = await retry({ t: r1.body.tracking_token });
      assert.equal(r2.status, 409); assert.equal(r2.body.code, 'reservation_released');
    });
    await t('Clube: prêmio devolvido (reward_release sem commit) = reservation_released (retryBlock)', async () => {
      const fake = rows => ({ query: async () => rows });
      const base = { payment_status: 'pending', fulfillment_status: 'new', fresh: true, club_points: 60, points_redeemed: 0, coupon_id: null, scheduled_for: null, id: 1 };
      const { retryBlock } = orderHandler._internal;
      assert.equal((await retryBlock(fake([{ kind: 'reward_reserve' }, { kind: 'reward_release' }]), base))[2], 'reservation_released');
      assert.equal(await retryBlock(fake([{ kind: 'reward_reserve' }]), base), null, 'reserva em aberto: pode');
    });
    await t('vaga agendada: pedido que já não segura a vaga e janela lotada = 409 slot_full; com vaga passa', async () => {
      await Q('delete from settings where key = $1', [CAP_KEY]);
      await Q('insert into settings (key, value) values ($1, $2)', [CAP_KEY, '1']);
      const when = new Date(Math.ceil((Date.now() + 2 * 86400000) / 1800000) * 1800000).toISOString();
      const o = await mkOrder({ label: 'vaga', created: '70 minutes', scheduled: when });
      const other = await mkOrder({ label: 'vaga-outro', pay: 'approved', scheduled: when });
      const r = await retry({ t: o.token });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'slot_full');
      await Q(`update orders set fulfillment_status = 'cancelled' where id = $1`, [other.id]);
      assert.equal((await retry({ t: o.token })).status, 200);
    });

    console.log('2. tracking_url na conta');
    async function account(label) {
      const { customer, token } = await customerLib.createAccount(sql, { name: `${P} F3 ${label}`, phone: phone(), password: 'Zz-' + crypto.randomBytes(9).toString('base64url'),
        security_question: 'prof_favorito', security_answer: 'zz resposta v4' }, { ip: ip(), ua: 'test-v4-f3' });
      return { ...customer, cookie: `${customerLib.COOKIE_NAME}=${token}` };
    }
    const A = await account('Cliente A'), B = await account('Cliente B');
    const ra = await order(body({ payment_choice: 'pix' }), A.cookie);
    assert.equal(ra.status, 201, JSON.stringify(ra.body));
    await t('Meus pedidos: tracking_url /pedido.html?o=<id> em cada pedido do próprio cliente', async () => {
      const r = await cust('GET', 'orders', { cookie: A.cookie });
      assert.equal(r.status, 200);
      assert.equal(r.body.orders.length, 1);
      assert.equal(r.body.orders[0].tracking_url, `/pedido.html?o=${ra.body.id}`);
      assert.equal((await cust('GET', 'orders', { cookie: B.cookie })).body.orders.length, 0, 'B não vê o pedido de A');
      assert.equal((await cust('GET', 'orders', {})).status, 401);
    });
    await t('order-status ?o=: dono vê (mesmo formato do ?t=); outro cliente 404; sem sessão 401; formato inválido 404', async () => {
      const r = await track({ o: String(ra.body.id) }, A.cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const byToken = await track({ t: ra.body.tracking_token });
      assert.equal(r.body.public_code, byToken.body.public_code); assert.deepEqual(Object.keys(r.body).sort(), Object.keys(byToken.body).sort());
      assert.equal((await track({ o: String(ra.body.id) }, B.cookie)).status, 404);
      const anon = await track({ o: String(ra.body.id) });
      assert.equal(anon.status, 401); assert.equal(anon.body.code, 'login_required');
      assert.equal((await track({ o: '0' }, A.cookie)).status, 404);
      assert.equal((await track({ o: '12abc' }, A.cookie)).status, 404);
    });
    await t('retry_payment com o=<id>: dono gera novo pagamento (cartão volta para ?o=); outro cliente 404; sem sessão 401', async () => {
      const r = await retry({ o: ra.body.id, payment_choice: 'card' }, { cookie: A.cookie });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const pref = mp.prefs[mp.prefs.length - 1];
      assert.ok(pref.back_urls.success.endsWith(`/pedido.html?o=${ra.body.id}&pagamento=ok`), pref.back_urls.success);
      assert.equal((await retry({ o: ra.body.id }, { cookie: B.cookie })).status, 404);
      const anon = await retry({ o: ra.body.id });
      assert.equal(anon.status, 401); assert.equal(anon.body.code, 'login_required');
      assert.equal((await retry({ o: 'abc' }, { cookie: A.cookie })).status, 404);
    });

    console.log('3. itens e endereço resumido no order-status');
    await t('retirada: itens (nome, tamanho, quantidade) e endereço da loja; nada de preço, telefone ou id', async () => {
      const r = await track({ t: ra.body.tracking_token });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, [{ name: `${P} F3 Doce`, size: null, qty: 2, reward: false }]);
      const [st] = await Q(`select value from settings where key = 'store_address'`);
      assert.equal(r.body.address_summary, (st && st.value) || ordersLib.STORE_ADDRESS);
      const txt = JSON.stringify(r.body);
      assert.ok(!txt.includes('unit_total_cents') && !txt.includes('product_id') && !txt.includes('customer_phone'));
    });
    await t('entrega: só bairro e cidade gravados no pedido; rua, número e complemento nunca aparecem', async () => {
      const o = await mkOrder({ label: 'entrega' });
      await Q(`update orders set delivery_method = 'delivery', address = 'Rua ZZ Secreta, 999 - apto 77 - Centro, Cidade ZZ',
        address_district = 'Centro ZZ', address_city = 'Cidade ZZ' where id = $1`, [o.id]);
      const r = await track({ t: o.token });
      assert.equal(r.body.address_summary, 'Centro ZZ, Cidade ZZ');
      assert.deepEqual(r.body.items, [{ name: `${P} Doce`, size: 'Médio', qty: 2, reward: false }]);
      const txt = JSON.stringify(r.body);
      assert.ok(!txt.includes('Secreta') && !txt.includes('999') && !txt.includes('apto'));
      await Q(`update orders set address_district = null, address_city = null where id = $1`, [o.id]);
      assert.equal((await track({ t: o.token })).body.address_summary, null, 'pedido antigo sem bairro/cidade: null (o texto livre não é recortado)');
    });
    await t('publicItems e addressSummary (puros): prêmio marcado, quantidade inválida vira 1, só cidade', async () => {
      assert.deepEqual(ordersLib.publicItems([{ name: 'Brinde', qty: 1, reward: true, reward_id: 3, points_cost: 60, unit_total_cents: 0 }, null, { qty: 'x' }]),
        [{ name: 'Brinde', size: null, qty: 1, reward: true }, { name: 'Item', size: null, qty: 1, reward: false }]);
      assert.equal(ordersLib.addressSummary({ delivery_method: 'delivery', address_district: '', address_city: 'Cidade' }), 'Cidade');
      assert.equal(ordersLib.addressSummary({ delivery_method: 'pickup', address: 'qualquer' }, 'Loja X'), 'Loja X');
    });
    await t('pedido de entrega novo grava bairro e cidade do CEP (quoteDelivery devolve district e city)', async () => {
      const shipping = require('../api/_lib/shipping');
      const real = shipping.quoteDelivery;
      shipping.quoteDelivery = async () => ({ km: 2, fee_cents: 500, district: 'Bairro ZZ', city: 'Cidade ZZ' });
      try {
        const r = await order(body({ delivery_method: 'delivery', cep: '01001000', address: 'Rua ZZ Teste, 10' }));
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const [o] = await Q('select address_district, address_city from orders where id = $1', [r.body.id]);
        assert.deepEqual(o, { address_district: 'Bairro ZZ', address_city: 'Cidade ZZ' });
        assert.equal((await track({ t: r.body.tracking_token })).body.address_summary, 'Bairro ZZ, Cidade ZZ');
      } finally { shipping.quoteDelivery = real; }
    });
  } finally {
    global.fetch = realFetch;
    await restore();
    await cleanup();
    const left = await Q(`select (select count(*) from orders where customer_name like $1)::int o, (select count(*) from customers where name like $1)::int c,
      (select count(*) from coupons where code like 'ZZV4A2-F3%')::int k, (select count(*) from products where name like $1)::int p`, [P + '%']);
    console.log('limpeza:', JSON.stringify(left[0]));
  }
  console.log(`${passed} passaram, ${failed} falharam`);
})().catch(async e => { console.error('ERRO:', e.message); process.exitCode = 1; try { global.fetch = realFetch; await restore(); await cleanup(); } catch { /* */ } });
