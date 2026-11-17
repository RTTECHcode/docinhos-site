// QA v4 (A6, F5): lacunas de cobertura de N3 e N8 contra o banco de DESENVOLVIMENTO.
//  - N3: bloqueio de 48 h vale para a troca por prêmio (423 points_locked; club mostra locked_until e can_redeem false).
//  - N3: cancelar no painel pedido NÃO pago com prêmio devolve os pontos (reward_release).
//  - N3: club_reward_save recusa produto com escolha obrigatória (required_group) e produto com tamanhos sem tamanho (size_required).
//  - N8: pedido pago e depois cancelado não devolve mais post_payment no rastreio.
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-qa-gaps.js
//  - Tudo com prefixo ZZ-v4-a6 / zz-v4-a6-, apagado no final. Mercado Pago simulado. Não altera ajustes da loja.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
delete process.env.MERCADOPAGO_ACCESS_TOKEN;
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VERCEL_ENV;

const sql = require('../api/_lib/db');
const orderHandler = require('../api/order');
const statusHandler = require('../api/order-status');
const customerHandler = require('../api/customer');
const adminHandler = require('../api/admin');
const auth = require('../api/_lib/auth');
const customerLib = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');
const payments = require('../api/_lib/payments');

const P = 'ZZ-v4-a6';
const U = 'zz-v4-a6-';
const CAT = `${P} Categoria`;
const Q = (t, p = []) => sql.query(t, p);
const HOST = 'loja.test.local';
let ipSeq = 0;
const ip = () => `198.18.0.${(++ipSeq % 250) + 1}`; // faixa de teste (RFC 2544): rate_hits apagados no final
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const phone = () => '11900' + rnd(6);

function runJson(fn, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {}, body: '',
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d, headers: this.headers }); return this; },
      end(text) { let b = null; try { b = JSON.parse(text); } catch { b = text; } resolve({ status: this.statusCode, body: b, headers: this.headers }); }
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}
const site = cookie => ({ host: HOST, origin: 'https://' + HOST, 'content-type': 'application/json', 'x-real-ip': ip(), ...(cookie ? { cookie } : {}) });
const order = (body, cookie) => runJson(orderHandler, { method: 'POST', body, headers: site(cookie) });
const track = token => runJson(statusHandler, { method: 'GET', query: { t: token }, headers: { 'x-real-ip': ip() } });
const cust = (method, a, cookie) => runJson(customerHandler, { method, url: `/api/customer?a=${a}`, body: {}, headers: site(cookie) });
const acall = (action, { method = 'GET', body = {}, cookie } = {}) => {
  const headers = { host: HOST, 'x-real-ip': ip(), 'user-agent': 'test-v4-qa-gaps' };
  if (method === 'POST') { headers.origin = 'https://' + HOST; headers['content-type'] = 'application/json'; }
  if (cookie) headers.cookie = cookie;
  return runJson(adminHandler, { method, url: `/api/admin?a=${action}`, headers, body, socket: { remoteAddress: '127.0.0.1' } });
};

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', String(e.message).split('\n')[0].slice(0, 300)); process.exitCode = 1; }
}

// Mercado Pago simulado (o driver do Neon também usa fetch: o resto passa direto).
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://api.mercadopago.com/v1/payments' && opts.method === 'POST') {
    const id = 770000000 + Math.floor(Math.random() * 9e7);
    return new Response(JSON.stringify({ id, status: 'pending', date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString(),
      point_of_interaction: { transaction_data: { qr_code: '00020126ZZV4A6PIX', qr_code_base64: 'iVBORw0KGgoZZV4A6' } } }), { status: 201 });
  }
  if (u.startsWith('https://api.mercadopago.com/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
  return realFetch(url, opts);
};
const pay = (o, status) => payments.syncPayment(sql, {
  id: 'zz' + crypto.randomBytes(4).toString('hex'), status, external_reference: o.code, transaction_amount: o.total_cents / 100,
  currency_id: 'BRL', payment_method_id: 'pix'
}, { source: 'teste' });

async function cleanup() {
  const ids = (await Q('select id from orders where customer_name like $1', [P + '%'])).map(r => r.id);
  await Q('delete from loyalty_ledger where customer_id in (select id from customers where name like $1) or order_id = any($2::int[])', [P + '%', ids]);
  await Q('delete from orders where id = any($1::int[])', [ids]);
  await Q(`delete from rate_hits where ip like '198.18.0.%' or ip = any($1::text[])`, [ids.map(i => 'order:' + i)]);
  await Q('delete from customers where name like $1', [P + '%']);
  await Q('delete from club_rewards where product_id in (select id from products where name like $1)', [P + '%']);
  await Q('delete from product_complements where product_id in (select id from products where name like $1)', [P + '%']);
  await Q('delete from products where name like $1', [P + '%']); // cascata: product_groups
  await Q('delete from complements where name like $1', [P + '%']);
  await Q('delete from categories where name = $1', [CAT]);
  await Q('delete from login_attempts where username like $1', [U + '%']);
  await Q('delete from admin_audit where username like $1', [U + '%']);
  await Q('delete from admin_users where username like $1', [U + '%']); // cascata: sessões
}
async function account(label, points) {
  const { customer, token } = await customerLib.createAccount(sql, { name: `${P} ${label}`, phone: phone(), password: 'Zz-' + crypto.randomBytes(9).toString('base64url'),
    security_question: 'prof_favorito', security_answer: 'zz resposta v4 a6' }, { ip: ip(), ua: 'test-v4-qa-gaps' });
  if (points) await loyalty.adjust(sql, { customerId: customer.id, points, note: 'zz-v4-a6 saldo de teste' });
  return { ...customer, cookie: `${customerLib.COOKIE_NAME}=${token}` };
}
const balance = async id => (await loyalty.getBalance(sql, id)).balance;
const ledgerKinds = async orderId => (await Q('select kind, points from loyalty_ledger where order_id = $1 order by id', [orderId])).map(r => `${r.kind}:${r.points}`);

(async () => {
  await cleanup();
  const rules = await loyalty.getRules(sql);
  if (!rules.enabled) { console.error('Clube desligado no dev: o teste precisa dele ligado (não altero ajustes).'); process.exit(1); }
  const [cat] = await Q('insert into categories (name, sort_order, active) values ($1, 9999, true) returning id', [CAT]);
  const mkProd = async (name, price) => (await Q('insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, $3, true, 9999) returning id', [cat.id, `${P} ${name}`, price]))[0];
  const doce = await mkProd('Doce', 1000);
  const brinde = await mkProd('Brinde', 500);
  const comSabor = await mkProd('Com sabor', 900);
  await Q(`insert into product_groups (product_id, key, label, min_choices, max_choices) values ($1, 'sabor', 'Sabor', 1, 1)`, [comSabor.id]);
  const comTamanho = await mkProd('Com tamanho', 900);
  const [tam] = await Q(`insert into complements (name, price_cents, kind, active) values ($1, 0, 'size', true) returning id`, [`${P} Tamanho P`]);
  await Q('insert into product_complements (product_id, complement_id, max_quantity) values ($1, $2, 1)', [comTamanho.id, tam.id]);
  const [reward] = await Q('insert into club_rewards (product_id, points_cost, max_per_order, active, sort_order) values ($1, 60, 1, true, 9999) returning id', [brinde.id]);
  const body = extra => ({ customer_name: `${P} Pedido`, customer_phone: phone(), delivery_method: 'pickup', items: [{ product_id: doce.id, qty: 1 }], ...extra });
  const R = [{ reward_id: reward.id, qty: 1 }];

  const admPass = 'Zz-' + crypto.randomBytes(12).toString('base64url');
  const ADM = U + 'adm';
  await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at)
    values ($1, $2, 'admin', false, 'prof_favorito', $3, now())`, [ADM, await auth.hashPassword(admPass), await auth.hashAnswer('zz resposta v4 a6')]);
  const lg = await acall('login', { method: 'POST', body: { username: ADM, password: admPass } });
  const AC = lg.headers['set-cookie'] ? String(lg.headers['set-cookie']).split(';')[0] : null;

  try {
    console.log('N3: bloqueio de 48 h na troca por prêmio');
    const L = await account('Bloqueada', 100);
    await Q(`update customers set points_locked_until = now() + interval '48 hours' where id = $1`, [L.id]);
    await t('club: locked_until preenchido e can_redeem false mesmo com saldo', async () => {
      const r = await cust('GET', 'club', L.cookie);
      assert.equal(r.status, 200);
      assert.ok(r.body.club.locked_until, 'locked_until');
      const rw = r.body.club.rewards.find(x => x.id === reward.id);
      assert.ok(rw, 'prêmio na lista'); assert.equal(rw.missing_points, 0); assert.equal(rw.can_redeem, false);
    });
    await t('pedido com prêmio: 423 points_locked com locked_until; nada gravado e saldo intacto', async () => {
      const name = `${P} Pedido bloqueado ${rnd(4)}`;
      const r = await order(body({ customer_name: name, rewards: R }), L.cookie);
      assert.equal(r.status, 423); assert.equal(r.body.code, 'points_locked'); assert.ok(r.body.locked_until);
      assert.equal((await Q('select count(*)::int n from orders where customer_name = $1', [name]))[0].n, 0);
      assert.equal(await balance(L.id), 100);
    });
    await t('mesmo bloqueada, pedido sem prêmio passa (201)', async () => {
      const r = await order(body(), L.cookie);
      assert.equal(r.status, 201);
    });

    console.log('N3: cancelar no painel pedido não pago devolve o prêmio');
    const C = await account('Cancela', 100);
    await t('reserva sai do saldo; cancelar (painel) grava reward_release e o saldo volta', async () => {
      const r = await order(body({ rewards: R }), C.cookie);
      assert.equal(r.status, 201); assert.equal(r.body.club_points, 60);
      assert.equal(await balance(C.id), 40);
      assert.ok(AC, 'login do admin de teste');
      const c = await acall('order_status', { method: 'POST', cookie: AC, body: { id: r.body.id, status: 'cancelled' } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.deepEqual(await ledgerKinds(r.body.id), ['reward_reserve:-60', 'reward_release:60']);
      assert.equal(await balance(C.id), 100);
      const s = await track(r.body.tracking_token);
      assert.equal(s.body.status_key, 'cancelled'); assert.equal(s.body.pix, null);
    });

    console.log('N8: post_payment some quando o pedido pago é cancelado');
    await t('pago: post_payment presente; cancelado no painel: post_payment null e status Cancelado', async () => {
      const r = await order(body());
      assert.equal(r.status, 201);
      assert.equal((await pay(r.body, 'approved')).outcome, 'updated');
      let s = await track(r.body.tracking_token);
      assert.equal(s.body.status_key, 'received'); assert.ok(s.body.post_payment);
      const c = await acall('order_status', { method: 'POST', cookie: AC, body: { id: r.body.id, status: 'cancelled' } });
      assert.equal(c.status, 200);
      s = await track(r.body.tracking_token);
      assert.equal(s.body.status_key, 'cancelled'); assert.equal(s.body.status_label, 'Cancelado'); assert.equal(s.body.post_payment, null);
    });

    console.log('N3: cadastro de prêmio no painel');
    await t('club_reward_save: escolha obrigatória = 400 required_group; com tamanhos sem tamanho = 400 size_required; com tamanho passa', async () => {
      let r = await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: comSabor.id, points_cost: 90, active: false } });
      assert.equal(r.status, 400); assert.equal(r.body.code, 'required_group');
      r = await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: comTamanho.id, points_cost: 90, active: false } });
      assert.equal(r.status, 400); assert.equal(r.body.code, 'size_required');
      r = await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: comTamanho.id, size_complement_id: tam.id + 999999, points_cost: 90, active: false } });
      assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_size');
      r = await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: comTamanho.id, size_complement_id: tam.id, points_cost: 90, active: false } });
      assert.equal(r.status, 200); assert.equal(r.body.reward.size_name, `${P} Tamanho P`); assert.equal(r.body.reward.state, 'off');
    });
  } finally {
    global.fetch = realFetch;
    await cleanup();
    const left = (await Q(`select (select count(*) from orders where customer_name like $1)::int o, (select count(*) from customers where name like $1)::int c,
      (select count(*) from products where name like $1)::int p, (select count(*) from admin_users where username like $2)::int a`, [P + '%', U + '%']))[0];
    console.log(`\n${passed} passaram, ${failed} falharam. Sobras ZZ-v4-a6: pedidos=${left.o}, clientes=${left.c}, produtos=${left.p}, admins=${left.a}.`);
  }
})().catch(async e => { console.error('ERRO', e.message); process.exitCode = 1; try { global.fetch = realFetch; await cleanup(); } catch { /* */ } });
