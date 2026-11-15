// Testes v4 (A2, F2) do lado do cliente contra o banco de DESENVOLVIMENTO:
//  N1 status único (rastreio e conta), N3 Clube por prêmios (inclui 10 pedidos em paralelo com saldo para 1),
//  N6 cupons (coupon_check, limite por cliente e max_uses em paralelo, liberação), A-02 atomicidade (sem reserva órfã),
//  U-01 Pix guardado e apagado, S-06 moeda obrigatória, fim do use_points.
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-pedido.js
//  - Produtos, prêmio, cupons, clientes e pedidos "ZZ-v4-a2" criados aqui e apagados no final.
//  - Mercado Pago simulado (fetch falso). Token falso só em memória. Nenhuma chamada externa. Web Push desligado.
//  - Não altera configurações da loja (horário, frete, regras de pontos).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
delete process.env.MERCADOPAGO_ACCESS_TOKEN;
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const sql = require('../api/_lib/db');
const orderHandler = require('../api/order');
const statusHandler = require('../api/order-status');
const customerHandler = require('../api/customer');
const menuHandler = require('../api/menu');
const customerLib = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');
const payments = require('../api/_lib/payments');

const P = 'ZZ-v4-a2';
const CAT = `${P} Categoria`, P_DOCE = `${P} Doce`, P_BRINDE = `${P} Brinde`;
const Q = (t, p = []) => sql.query(t, p);
const HOST = 'loja.test.local';
let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}.${crypto.randomBytes(2).toString('hex')}`; // TEST-NET-2: apagado no final
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
const order = (body, cookie) => runJson(orderHandler, { method: 'POST', body, headers: site(cookie) });
const track = token => runJson(statusHandler, { method: 'GET', query: { t: token }, headers: { 'x-real-ip': ip() } });
const cust = (method, a, { body, cookie, fixedIp } = {}) =>
  runJson(customerHandler, { method, url: `/api/customer?a=${a}`, body, headers: site(cookie, fixedIp) });

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

// ---------- Mercado Pago simulado ----------
const mpPayments = new Map(); // id -> { status, amount, code }
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://api.mercadopago.com/v1/payments' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    const id = 880000000 + Math.floor(Math.random() * 9e7);
    mpPayments.set(String(id), { status: 'pending', amount: b.transaction_amount, code: b.external_reference });
    return new Response(JSON.stringify({ id, status: 'pending', date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString(),
      point_of_interaction: { transaction_data: { qr_code: '00020126ZZV4A2PIX', qr_code_base64: 'iVBORw0KGgoZZV4A2' } } }), { status: 201 });
  }
  const m = u.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
  if (m && mpPayments.has(m[1])) {
    const p = mpPayments.get(m[1]);
    return new Response(JSON.stringify({ id: Number(m[1]), status: p.status, external_reference: p.code, transaction_amount: p.amount, currency_id: 'BRL', payment_method_id: 'pix' }), { status: 200 });
  }
  if (u.startsWith('https://api.mercadopago.com/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
  return realFetch(url, opts); // o driver do banco (Neon) também usa fetch
};
const pay = (o, status, extra = {}) => payments.syncPayment(sql, {
  id: 'zz' + crypto.randomBytes(4).toString('hex'), status, external_reference: o.code, transaction_amount: o.total_cents / 100,
  currency_id: 'BRL', payment_method_id: 'pix', ...extra
}, { source: 'teste' });

// ---------- dados ----------
async function cleanup() {
  await Q(`delete from coupons where code like 'ZZV4A2-%'`); // cascata: coupon_redemptions
  const ids = (await Q(`select id from orders where customer_name like $1`, [P + '%'])).map(r => r.id);
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like $1) or order_id = any($2::int[])`, [P + '%', ids]);
  await Q(`delete from orders where id = any($1::int[])`, [ids]);
  await Q(`delete from rate_hits where ip like '198.51.100.%' or ip = any($1::text[])`, [ids.map(i => 'order:' + i)]);
  await Q(`delete from customers where name like $1`, [P + '%']);
  await Q(`delete from club_rewards where product_id in (select id from products where name like $1)`, [P + '%']);
  await Q(`delete from products where name like $1`, [P + '%']);
  await Q(`delete from categories where name = $1`, [CAT]);
}
async function account(label, points) {
  const { customer, token } = await customerLib.createAccount(sql, { name: `${P} ${label}`, phone: phone(), password: 'Zz-' + crypto.randomBytes(9).toString('base64url'),
    security_question: 'prof_favorito', security_answer: 'zz resposta v4' }, { ip: ip(), ua: 'test-v4-pedido' });
  if (points) await loyalty.adjust(sql, { customerId: customer.id, points, note: 'zz-v4-a2 saldo de teste' });
  return { ...customer, cookie: `${customerLib.COOKIE_NAME}=${token}` };
}
const balance = async id => (await loyalty.getBalance(sql, id)).balance;
const ledgerKinds = async orderId => (await Q('select kind, points from loyalty_ledger where order_id = $1 order by id', [orderId])).map(r => `${r.kind}:${r.points}`);
async function coupon(code, fields) {
  const f = { kind: 'percent', value: 10, min_order_cents: 0, max_uses: null, max_uses_per_customer: null, active: true, stacks_with_club: false, ...fields };
  const [c] = await Q(`insert into coupons (code, kind, value, min_order_cents, max_uses, max_uses_per_customer, active, stacks_with_club, created_by, note)
    values ($1, $2, $3, $4, $5, $6, $7, $8, 'zz-v4-a2', 'teste') returning id`, [code, f.kind, f.value, f.min_order_cents, f.max_uses, f.max_uses_per_customer, f.active, f.stacks_with_club]);
  return c.id;
}

(async () => {
  await cleanup();
  const rules = await loyalty.getRules(sql);
  if (!rules.enabled) { console.error('Programa de pontos desligado no dev: o teste precisa dele ligado (não altero configurações).'); process.exit(1); }
  const [cat] = await Q(`insert into categories (name, sort_order, active) values ($1, 9999, true) returning id`, [CAT]);
  const [doce] = await Q(`insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, 1000, true, 9999) returning id`, [cat.id, P_DOCE]);
  const [brinde] = await Q(`insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, 500, true, 9999) returning id`, [cat.id, P_BRINDE]);
  const [reward] = await Q(`insert into club_rewards (product_id, points_cost, max_per_order, active, sort_order) values ($1, 60, 2, true, 9999) returning id`, [brinde.id]);
  const items = [{ product_id: doce.id, qty: 1 }];
  const body = (extra = {}) => ({ customer_name: `${P} Pedido`, customer_phone: phone(), delivery_method: 'pickup', items, ...extra });
  const R = (qty = 1) => [{ reward_id: reward.id, qty }];

  try {
    console.log('N3: fim do desconto por pontos e vitrine do Clube');
    await t('use_points no pedido: 400 points_discount_ended (nada gravado)', async () => {
      const r = await order(body({ use_points: 100 }));
      assert.equal(r.status, 400); assert.equal(r.body.code, 'points_discount_ended');
    });
    await t('points_preview ignora use_points (mesmos pontos com e sem)', async () => {
      const a = await cust('POST', 'points_preview', { body: { items } });
      const b = await cust('POST', 'points_preview', { body: { items, use_points: 100 } });
      assert.equal(a.status, 200); assert.deepEqual(a.body, b.body);
    });
    await t('/api/menu traz club.enabled e o prêmio ligado (nome, custo, available)', async () => {
      const r = await runJson(menuHandler, { method: 'GET', headers: {} });
      assert.equal(r.status, 200); assert.equal(typeof r.body.club, 'object');
      const it = r.body.club.rewards.find(x => x.id === reward.id);
      assert.ok(it, 'prêmio aparece');
      assert.equal(it.name, P_BRINDE); assert.equal(it.points_cost, 60); assert.equal(it.available, true);
    });

    const A = await account('Cliente A', 60);
    await t('conta: GET club exige login e mostra saldo e quanto falta', async () => {
      assert.equal((await cust('GET', 'club')).status, 401);
      const r = await cust('GET', 'club', { cookie: A.cookie });
      assert.equal(r.status, 200); assert.equal(r.body.club.balance, 60);
      const it = r.body.club.rewards.find(x => x.id === reward.id);
      assert.equal(it.missing_points, 0); assert.equal(it.can_redeem, true);
    });
    await t('prêmio sem login: 401 login_required; só prêmio sem item pago: 400 reward_min_subtotal', async () => {
      const r = await order(body({ rewards: R() }));
      assert.equal(r.status, 401); assert.equal(r.body.code, 'login_required');
      const r2 = await order(body({ items: [], rewards: R() }), A.cookie);
      assert.equal(r2.status, 400); assert.equal(r2.body.code, 'reward_min_subtotal');
    });
    await t('prêmio inexistente, repetido, qty acima do máximo: 400 (nada gravado)', async () => {
      assert.equal((await order(body({ rewards: [{ reward_id: 2147480000, qty: 1 }] }), A.cookie)).body.code, 'reward_unavailable');
      assert.equal((await order(body({ rewards: [...R(), ...R()] }), A.cookie)).body.code, 'invalid_rewards');
      assert.equal((await order(body({ rewards: R(3) }), A.cookie)).body.code, 'reward_max_per_order');
      const r = await order(body({ rewards: [{ reward_id: reward.id, qty: 1, price: 0, points_cost: 1 }] }), A.cookie);
      assert.equal(r.status, 201, 'campos extras do navegador são ignorados');
    });
    // O pedido acima (campos extras) usou os 60 pontos: devolve para o teste de concorrência começar com saldo exato de 60.
    const extra = (await Q(`select id from orders where customer_id = $1 and club_points > 0`, [A.id]))[0];
    await t('o pedido com campos extras usou o custo do servidor (60), não o do navegador', async () => {
      assert.ok(extra);
      assert.equal((await Q('select club_points from orders where id = $1', [extra.id]))[0].club_points, 60);
      assert.equal(await balance(A.id), 0);
      await pay({ code: (await Q('select code from orders where id = $1', [extra.id]))[0].code, total_cents: 1000 }, 'rejected');
      assert.equal(await balance(A.id), 60, 'recusado devolve');
      assert.deepEqual(await ledgerKinds(extra.id), ['reward_reserve:-60', 'reward_release:60']);
    });

    console.log('N3 + A-02: concorrência (10 pedidos em paralelo, saldo para 1)');
    let winner = null;
    await t('10 pedidos simultâneos com prêmio de 60 e saldo 60: exatamente 1 entra, 9 recebem 409 insufficient_points', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => order(body({ rewards: R() }), A.cookie)));
      const ok = rs.filter(r => r.status === 201), no = rs.filter(r => r.status !== 201);
      assert.equal(ok.length, 1, 'statuses: ' + rs.map(r => r.status).join(','));
      assert.ok(no.every(r => r.status === 409 && r.body.code === 'insufficient_points'), no.map(r => r.body.code).join(','));
      winner = ok[0].body;
      assert.equal(winner.club_points, 60); assert.equal(winner.total_cents, 1000);
      assert.ok(winner.items.some(i => i.reward === true && i.unit_total_cents === 0 && i.reward_id === reward.id));
    });
    await t('A-02: saldo nunca negativo, 1 reserva só, nenhuma reserva órfã', async () => {
      assert.equal(await balance(A.id), 0);
      const [{ n }] = await Q(`select count(*)::int n from loyalty_ledger where customer_id = $1 and kind = 'reward_reserve' and order_id <> $2`, [A.id, extra.id]);
      assert.equal(n, 1);
      const [{ orphan }] = await Q(`select count(*)::int orphan from loyalty_ledger l where l.customer_id = $1 and l.kind = 'reward_reserve'
        and not exists (select 1 from orders o where o.id = l.order_id)`, [A.id]);
      assert.equal(orphan, 0);
      assert.equal((await Q(`select count(*)::int n from orders where customer_id = $1 and club_points > 0`, [A.id]))[0].n, 2);
    });

    console.log('N1: status único; N3: ciclo do prêmio');
    await t('rastreio: awaiting_payment antes, received depois do pagamento; ledger reward_commit + earn', async () => {
      let r = await track(winner.tracking_token);
      assert.equal(r.status, 200); assert.equal(r.body.status_key, 'awaiting_payment'); assert.equal(r.body.status_label, 'Aguardando pagamento');
      assert.equal(r.body.pix, null); assert.equal(r.body.post_payment, null);
      assert.equal((await pay(winner, 'approved')).outcome, 'updated');
      r = await track(winner.tracking_token);
      assert.equal(r.body.status_key, 'received'); assert.equal(r.body.status_label, 'Pedido recebido');
      assert.ok(r.body.post_payment && typeof r.body.post_payment.review_url === 'string', 'N8: post_payment só com pagamento aprovado');
      const earned = loyalty.earnPoints(1000, 0, rules);
      assert.deepEqual(await ledgerKinds(winner.id), ['reward_reserve:-60', 'reward_commit:0', `earn:${earned}`]);
      assert.equal(await balance(A.id), earned, 'prêmio vale R$ 0: ganha só pelos itens pagos');
    });
    await t('conta: lista de pedidos com status_label, club_points e "(prêmio do Clube)"', async () => {
      const r = await cust('GET', 'orders', { cookie: A.cookie });
      assert.equal(r.status, 200);
      const o = r.body.orders.find(x => x.public_code === winner.public_code);
      assert.ok(o); assert.equal(o.status_key, 'received'); assert.equal(o.status_label, 'Pedido recebido');
      assert.equal(o.club_points, 60);
      assert.ok(o.items_summary.some(s => s.includes('(prêmio do Clube)')));
    });
    await t('A-10 (lib): estorno do pedido pago devolve o prêmio e tira o ganho, uma vez só', async () => {
      const before = await balance(A.id);
      const earned = loyalty.earnPoints(1000, 0, rules);
      assert.equal(await loyalty.reverseOrder(sql, winner.id), true);
      assert.equal(await loyalty.reverseOrder(sql, winner.id), false);
      assert.equal(await balance(A.id), before - earned + 60);
    });

    console.log('S-06 e U-01: moeda e Pix guardado');
    await t('S-06: pagamento sem moeda ou em USD é recusado (pedido continua pendente)', async () => {
      const r = await order(body());
      assert.equal(r.status, 201);
      assert.equal((await pay(r.body, 'approved', { currency_id: undefined })).outcome, 'currency_mismatch');
      assert.equal((await pay(r.body, 'approved', { currency_id: 'USD' })).outcome, 'currency_mismatch');
      assert.equal((await Q('select payment_status from orders where id = $1', [r.body.id]))[0].payment_status, 'pending');
    });
    await t('U-01: Pix guardado volta no rastreio enquanto pendente; aprovado apaga código e QR', async () => {
      process.env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-zz-v4-a2-falso';
      try {
        const r = await order(body({ payment_choice: 'pix' }));
        assert.equal(r.status, 201); assert.equal(r.body.payment.type, 'pix');
        let s = await track(r.body.tracking_token);
        assert.ok(s.body.pix, 'pix volta'); assert.equal(s.body.pix.qr_code, '00020126ZZV4A2PIX');
        assert.ok(new Date(s.body.pix.expires_at) > new Date());
        const [row] = await Q('select payment_id, pix_qr_code from orders where id = $1', [r.body.id]);
        assert.equal(row.pix_qr_code, '00020126ZZV4A2PIX');
        mpPayments.get(row.payment_id).status = 'approved';
        await Q(`delete from rate_hits where scope = 'payment_check' and ip = $1`, ['order:' + r.body.id]);
        s = await track(r.body.tracking_token); // conferência de reserva lê o pagamento aprovado
        assert.equal(s.body.status_key, 'received'); assert.equal(s.body.pix, null);
        const [after] = await Q('select pix_qr_code, pix_qr_base64, pix_expires_at from orders where id = $1', [r.body.id]);
        assert.deepEqual([after.pix_qr_code, after.pix_qr_base64, after.pix_expires_at], [null, null, null]);
      } finally { delete process.env.MERCADOPAGO_ACCESS_TOKEN; }
    });
    await t('U-01: Pix vencido não volta', async () => {
      const r = await order(body());
      await Q(`update orders set payment_method = 'pix', pix_qr_code = 'zz', pix_qr_base64 = 'zz', pix_expires_at = now() - interval '1 minute' where id = $1`, [r.body.id]);
      assert.equal((await track(r.body.tracking_token)).body.pix, null);
    });

    console.log('N6: cupons');
    await coupon('ZZV4A2-P10', { max_uses_per_customer: 1 });
    await coupon('ZZV4A2-MAX3', { kind: 'fixed', value: 200, max_uses: 3 });
    await coupon('ZZV4A2-MIN', { min_order_cents: 5000 });
    await coupon('ZZV4A2-OFF', { active: false });
    await coupon('ZZV4A2-BIG', { kind: 'fixed', value: 5000 });
    await coupon('ZZV4A2-STK', { stacks_with_club: true });
    await t('coupon_check: válido calcula no servidor; inválido, desligado, mínimo e preço do navegador', async () => {
      let r = await cust('POST', 'coupon_check', { body: { code: ' zzv4a2-p10 ', items: [{ product_id: doce.id, qty: 1, price_cents: 1 }] } });
      assert.equal(r.status, 200); assert.equal(r.body.subtotal_cents, 1000); assert.equal(r.body.discount_cents, 100); assert.equal(r.body.coupon.code, 'ZZV4A2-P10');
      for (const [code, exp] of [['ZZV4A2-NAOEXISTE', 'invalid_coupon'], ['ZZV4A2-OFF', 'invalid_coupon'], ['x', 'invalid_coupon'], ['ZZV4A2-MIN', 'coupon_min_order']]) {
        r = await cust('POST', 'coupon_check', { body: { code, items } });
        assert.equal(r.body.code, exp, code);
      }
      r = await cust('POST', 'coupon_check', { body: { code: 'ZZV4A2-BIG', items } });
      assert.equal(r.body.discount_cents, 900, 'desconto limitado: produtos ficam com R$ 1,00');
      r = await cust('POST', 'coupon_check', { body: { code: 'ZZV4A2-P10', items, rewards: R() } });
      assert.equal(r.body.code, 'coupon_not_stackable');
    });
    await t('coupon_check: 21a tentativa do mesmo IP em 10 min = 429', async () => {
      const fixed = ip();
      for (let i = 0; i < 20; i++) assert.notEqual((await cust('POST', 'coupon_check', { body: {}, fixedIp: fixed })).status, 429, 'tentativa ' + (i + 1));
      const r = await cust('POST', 'coupon_check', { body: { code: 'ZZV4A2-P10', items }, fixedIp: fixed });
      assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    });
    await t('pedido com cupom (visitante): desconto do servidor, uso reservado; mesmo telefone de novo = 409', async () => {
      const ph = phone();
      const r = await order(body({ customer_phone: ph, coupon_code: 'zzv4a2-p10' }));
      assert.equal(r.status, 201); assert.equal(r.body.coupon_code, 'ZZV4A2-P10'); assert.equal(r.body.coupon_discount_cents, 100);
      assert.equal(r.body.discount_cents, 100); assert.equal(r.body.total_cents, 900);
      const [red] = await Q('select status, discount_cents from coupon_redemptions where order_id = $1', [r.body.id]);
      assert.deepEqual([red.status, red.discount_cents], ['reserved', 100]);
      const r2 = await order(body({ customer_phone: `(${ph.slice(0, 2)}) ${ph.slice(2)}`, coupon_code: 'ZZV4A2-P10' }));
      assert.equal(r2.status, 409); assert.equal(r2.body.code, 'coupon_customer_limit');
      const chk = await cust('POST', 'coupon_check', { body: { code: 'ZZV4A2-P10', items, phone: ph } });
      assert.equal(chk.status, 200, 'F5-S-08: visitante não consulta uso por telefone (phone ignorado)'); assert.equal(chk.body.discount_cents, 100);
      await pay(r.body, 'rejected');
      assert.equal((await Q('select status from coupon_redemptions where order_id = $1', [r.body.id]))[0].status, 'released');
      assert.equal((await order(body({ customer_phone: ph, coupon_code: 'ZZV4A2-P10' }))).status, 201, 'liberado: pode usar de novo');
    });
    await t('limite por cliente em paralelo: 4 pedidos do mesmo telefone ao mesmo tempo, só 1 usa o cupom', async () => {
      const ph = phone();
      const rs = await Promise.all(Array.from({ length: 4 }, () => order(body({ customer_phone: ph, coupon_code: 'ZZV4A2-P10' }))));
      assert.equal(rs.filter(r => r.status === 201).length, 1, rs.map(r => r.status).join(','));
      assert.ok(rs.filter(r => r.status !== 201).every(r => r.body.code === 'coupon_customer_limit'));
    });
    await t('max_uses em paralelo: 10 pedidos (telefones diferentes) e max_uses 3: exatamente 3 entram, 7 = 409 coupon_exhausted', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => order(body({ coupon_code: 'ZZV4A2-MAX3' }))));
      const ok = rs.filter(r => r.status === 201);
      assert.equal(ok.length, 3, rs.map(r => r.status).join(','));
      assert.ok(rs.filter(r => r.status !== 201).every(r => r.status === 409 && r.body.code === 'coupon_exhausted'));
      const [{ n }] = await Q(`select count(*)::int n from coupon_redemptions r join coupons c on c.id = r.coupon_id where c.code = 'ZZV4A2-MAX3' and r.status = 'reserved'`);
      assert.equal(n, 3);
      const [{ orphan }] = await Q(`select count(*)::int orphan from orders o join coupons c on c.id = o.coupon_id where c.code = 'ZZV4A2-MAX3'
        and not exists (select 1 from coupon_redemptions r where r.order_id = o.id)`);
      assert.equal(orphan, 0, 'A-02: pedido com cupom sempre tem a reserva');
      await pay(ok[0].body, 'approved');
      assert.equal((await Q('select status from coupon_redemptions where order_id = $1', [ok[0].body.id]))[0].status, 'committed');
      assert.equal((await order(body({ coupon_code: 'ZZV4A2-MAX3' }))).body.code, 'coupon_exhausted');
      await pay(ok[1].body, 'expired');
      assert.equal((await order(body({ coupon_code: 'ZZV4A2-MAX3' }))).status, 201, 'expirado libera 1 uso');
    });
    await t('cupom + prêmio: sem stacks_with_club = 400; com stacks_with_club passa e gera pontos sobre o valor com desconto', async () => {
      const C = await account('Cliente C', 60);
      const r = await order(body({ rewards: R(), coupon_code: 'ZZV4A2-P10' }), C.cookie);
      assert.equal(r.status, 400); assert.equal(r.body.code, 'coupon_not_stackable');
      assert.equal(await balance(C.id), 60, 'recusado não reserva pontos');
      const r2 = await order(body({ rewards: R(), coupon_code: 'ZZV4A2-STK' }), C.cookie);
      assert.equal(r2.status, 201); assert.equal(r2.body.total_cents, 900); assert.equal(r2.body.club_points, 60);
      await pay(r2.body, 'approved');
      assert.deepEqual(await ledgerKinds(r2.body.id), ['reward_reserve:-60', 'reward_commit:0', `earn:${loyalty.earnPoints(1000, 100, rules)}`]);
    });
  } finally {
    global.fetch = realFetch;
    await cleanup();
    const left = await Q(`select (select count(*) from orders where customer_name like $1)::int o, (select count(*) from customers where name like $1)::int c,
      (select count(*) from coupons where code like 'ZZV4A2-%')::int k, (select count(*) from products where name like $1)::int p`, [P + '%']);
    console.log('limpeza:', JSON.stringify(left[0]));
  }
  console.log(`${passed} passaram, ${failed} falharam`);
})().catch(async e => { console.error('ERRO:', e.message); process.exitCode = 1; try { global.fetch = realFetch; await cleanup(); } catch { /* */ } });
