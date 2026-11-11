// Testes de api/_lib/payments.js (syncPayment e checkOrderPayment), da conferência de reserva em /api/order-status
// e da ação "Conferir pagamento" do painel (a=payment_check), contra o banco de DESENVOLVIMENTO.
// O Mercado Pago é sempre simulado (globalThis.fetch trocado); nenhuma chamada real sai daqui.
// Uso: node -r ./scripts/dev-env.js scripts/test-payments.js   (cria e apaga dados "ZZ-a1pay" e usuários "zz-teste-a1p-*")
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');
const payments = require('../api/_lib/payments');
const ordersLib = require('../api/_lib/orders');
const customerLib = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');
const auth = require('../api/_lib/auth');
const statusHandler = require('../api/order-status');
const admin = require('../api/admin');

const NAME = 'ZZ-a1pay';
const TEST_IP = '198.51.100.77';
const Q = (t, p = []) => sql.query(t, p);
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); process.exitCode = 1; }
}

// ---------- Mercado Pago simulado ----------
// pays: lista de pagamentos "no Mercado Pago". GET /v1/payments/:id e /v1/payments/search?external_reference=...
const mp = { pays: [], calls: [] };
const realFetch = globalThis.fetch;
function mockMp() {
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith('https://api.mercadopago.com/')) return realFetch(url, init); // o driver do banco usa fetch
    mp.calls.push(u);
    const parsed = new URL(u);
    if (parsed.pathname === '/v1/payments/search') {
      const ref = parsed.searchParams.get('external_reference');
      return new Response(JSON.stringify({ results: mp.pays.filter(p => p.external_reference === ref) }), { status: 200 });
    }
    const m = /^\/v1\/payments\/(\d+)$/.exec(parsed.pathname);
    const p = m && mp.pays.find(x => String(x.id) === m[1]);
    return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{}', { status: 404 });
  };
}
function unmockMp() { globalThis.fetch = realFetch; delete process.env.MERCADOPAGO_ACCESS_TOKEN; }
let paySeq = 0;
const payOf = (order, status, over = {}) => ({
  id: 970000000 + Math.floor(Math.random() * 9e6) + (++paySeq), status, external_reference: order.code,
  transaction_amount: order.total_cents / 100, currency_id: 'BRL', payment_method_id: 'pix', date_created: new Date().toISOString(), ...over
});

// ---------- Dados ----------
async function mkOrder(tag, { customerId = null, subtotal = 1500, method = 'pix', paymentId = null, ageMinutes = 1, status = 'pending', fulfillment = 'new' } = {}) {
  const code = 'ZZ' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const tr = ordersLib.newTrackingToken();
  const [o] = await Q(`insert into orders (code, public_code, tracking_token_hash, customer_id, customer_name, customer_phone, delivery_method, items,
      subtotal_cents, delivery_fee_cents, discount_cents, points_redeemed, total_cents, payment_method, payment_id, payment_status, fulfillment_status, created_at)
    values ($1, null, $2, $3, $4, '11900007766', 'pickup', '[]'::jsonb, $5, 0, 0, 0, $5, $6, $7, $8, $9, now() - make_interval(mins => $10::int))
    returning id, code, total_cents`,
    [code, tr.hash, customerId, NAME + ' ' + tag, subtotal, method, paymentId, status, fulfillment, ageMinutes]);
  return { ...o, token: tr.token };
}
const row = async id => (await Q('select payment_status, payment_id, payment_method from orders where id = $1', [id]))[0];
const ledger = async id => (await Q('select kind, points from loyalty_ledger where order_id = $1 order by id', [id])).map(r => r.kind + ':' + r.points);

async function statusCall(query) {
  const res = { code: null, body: null, setHeader() {}, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  await statusHandler({ method: 'GET', query, headers: { 'x-forwarded-for': TEST_IP } }, res);
  return res;
}

const HOST = 'painel.test.local';
async function adminCall(o) {
  const method = o.method || 'GET';
  const headers = { host: HOST, 'x-forwarded-for': o.ip || '203.0.113.231', 'user-agent': 'test-payments' };
  if (method === 'POST') { headers.origin = 'https://' + HOST; headers['content-type'] = 'application/json'; }
  if (o.cookie) headers.cookie = o.cookie;
  const req = { method, url: '/api/admin?' + new URLSearchParams({ a: o.action || '' }), headers, body: o.body, socket: { remoteAddress: '127.0.0.1' } };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(c) { this.body = c === undefined ? '' : c; } };
  await admin(req, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* sem corpo */ }
  return { status: res.statusCode, json, headers: res.headers };
}
async function adminLogin(role) {
  const username = 'zz-teste-a1p-' + crypto.randomBytes(5).toString('hex');
  const password = 'Sx-' + crypto.randomBytes(9).toString('hex');
  await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at)
           values ($1, $2, $3, false, 'prof_favorito', $4, now())`, [username, await auth.hashPassword(password), role, await auth.hashAnswer('resposta combinada')]);
  const r = await adminCall({ method: 'POST', action: 'login', body: { username, password }, ip: '203.0.113.' + (200 + Math.floor(Math.random() * 50)) });
  const sc = r.headers['set-cookie'];
  return { username, cookie: sc ? String(sc).split(';')[0] : null };
}

async function cleanup() {
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like 'ZZ-a1pay%')`);
  await Q(`delete from loyalty_ledger where order_id in (select id from orders where customer_name like 'ZZ-a1pay%')`);
  await Q(`delete from admin_audit where username like 'zz-teste-a1p-%' or (username = 'mercadopago' and detail like 'Pedido ZZ-a1pay%')`);
  await Q(`delete from orders where customer_name like 'ZZ-a1pay%'`);
  await Q(`delete from customers where name like 'ZZ-a1pay%'`);
  await Q(`delete from admin_users where username like 'zz-teste-a1p-%'`);
  await Q(`delete from login_attempts where username like 'zz-teste-a1p-%'`);
  await Q(`delete from rate_hits where (scope = 'payment_check' and (ip like 'order:%' or ip like 'admin-order:%') and minute > now() - interval '1 hour')
                                  or (scope = 'order_status' and ip = $1)`, [TEST_IP]);
}

(async () => {
  console.log('test-payments');
  const savedToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const origErr = console.error;
  await cleanup();
  const phone = '119' + String(10000000 + Math.floor(Math.random() * 89999999));
  const { customer: c } = await customerLib.createAccount(sql, { name: NAME + ' Cliente', phone, password: 'Qa-' + crypto.randomBytes(9).toString('base64url'),
    security_question: 'prof_favorito', security_answer: 'zz resposta a1' }, { ip: '10.88.8.91', ua: 'test-payments' });
  mockMp();
  try {
    await test('pickPayment: aprovado vence; senão o mais recente; lista vazia dá null', () => {
      const old = { id: 1, status: 'rejected', date_created: '2026-11-10T10:00:00Z' };
      const neu = { id: 2, status: 'pending', date_created: '2026-11-10T11:00:00Z' };
      const ok = { id: 3, status: 'approved', date_created: '2026-11-10T09:00:00Z' };
      assert.equal(payments.pickPayment([old, neu]).id, 2);
      assert.equal(payments.pickPayment([old, ok, neu]).id, 3);
      assert.equal(payments.pickPayment([]), null);
      assert.equal(payments.pickPayment([{ id: 9 }]), null, 'sem status não serve');
    });

    await test('syncPayment: aprovado grava, credita pontos e repetição não duplica', async () => {
      const o = await mkOrder('sync-ok', { customerId: c.id, subtotal: 2550 });
      const p = payOf(o, 'approved');
      const r1 = await payments.syncPayment(sql, p);
      assert.equal(r1.outcome, 'updated'); assert.equal(r1.payment_status, 'approved');
      assert.deepEqual(await row(o.id), { payment_status: 'approved', payment_id: String(p.id), payment_method: 'pix' });
      assert.deepEqual(await ledger(o.id), ['earn:25']);
      const r2 = await payments.syncPayment(sql, p);
      assert.equal(r2.outcome, 'unchanged');
      assert.deepEqual(await ledger(o.id), ['earn:25'], 'sem crédito duplicado');
      // Outro pagamento recusado depois não sobrescreve o aprovado.
      await payments.syncPayment(sql, payOf(o, 'rejected'));
      assert.equal((await row(o.id)).payment_status, 'approved');
    });

    await test('syncPayment: valor ou moeda diferentes não gravam; sem pedido ou incompleto são ignorados', async () => {
      console.error = () => {};
      const o = await mkOrder('sync-bad', { customerId: c.id, subtotal: 1000 });
      assert.equal((await payments.syncPayment(sql, payOf(o, 'approved', { transaction_amount: 9.99 }))).outcome, 'amount_mismatch');
      assert.equal((await payments.syncPayment(sql, payOf(o, 'approved', { currency_id: 'USD' }))).outcome, 'currency_mismatch');
      console.error = origErr;
      assert.equal((await row(o.id)).payment_status, 'pending');
      assert.deepEqual(await ledger(o.id), []);
      assert.equal((await payments.syncPayment(sql, payOf({ code: 'ZZNAOEXISTE1', total_cents: 1000 }, 'approved'))).outcome, 'no_order');
      assert.equal((await payments.syncPayment(sql, { id: 1, status: 'approved' })).outcome, 'invalid');
    });

    await test('syncPayment: pedido cancelado e pago depois não credita e avisa na auditoria', async () => {
      const o = await mkOrder('sync-cancel', { customerId: c.id, subtotal: 1200, fulfillment: 'cancelled' });
      const pc = 'ZZ-a1pay-C' + o.id;
      await Q('update orders set public_code = $2 where id = $1', [o.id, pc]);
      const p = payOf(o, 'approved');
      await payments.syncPayment(sql, p);
      await payments.syncPayment(sql, p); // reenvio não duplica o aviso
      assert.equal((await row(o.id)).payment_status, 'approved');
      assert.deepEqual(await ledger(o.id), [], 'cancelado não credita');
      const notes = await Q(`select detail from admin_audit where username = 'mercadopago' and action = $1 and detail like $2`, [payments.CANCELLED_PAID_ACTION, 'Pedido ' + pc + ' %']);
      assert.equal(notes.length, 1, 'um aviso na auditoria');
    });

    await test('checkOrderPayment: Pix busca pelo payment_id; cartão busca por external_reference e escolhe o aprovado', async () => {
      const pixOrder = await mkOrder('chk-pix', { subtotal: 1200 });
      const pixPay = payOf(pixOrder, 'approved');
      mp.pays.push(pixPay);
      await Q('update orders set payment_id = $2 where id = $1', [pixOrder.id, String(pixPay.id)]);
      mp.calls = [];
      const r = await payments.checkOrderPayment(sql, { id: pixOrder.id, code: pixOrder.code, payment_id: String(pixPay.id), payment_method: 'pix' });
      assert.equal(r.outcome, 'updated'); assert.equal(r.mp_status, 'approved');
      assert.ok(mp.calls.every(u => u.endsWith('/v1/payments/' + pixPay.id)), 'Pix usa GET direto');

      const card = await mkOrder('chk-card', { subtotal: 1800, method: 'mercadopago_card', paymentId: '288714078-pref-zz' });
      mp.pays.push(payOf(card, 'rejected', { payment_method_id: 'visa', date_created: '2026-11-10T23:11:00Z' }));
      const okCard = payOf(card, 'approved', { payment_method_id: 'master', date_created: '2026-11-10T23:10:00Z' });
      mp.pays.push(okCard);
      mp.calls = [];
      const r2 = await payments.checkOrderPayment(sql, { id: card.id, code: card.code, payment_id: '288714078-pref-zz', payment_method: 'mercadopago_card' });
      assert.equal(r2.outcome, 'updated');
      assert.ok(mp.calls[0].includes('/v1/payments/search?') && mp.calls[0].includes('external_reference=' + card.code));
      assert.deepEqual(await row(card.id), { payment_status: 'approved', payment_id: String(okCard.id), payment_method: 'mercadopago_card' });

      const none = await mkOrder('chk-none', { subtotal: 1000, method: 'mercadopago_card', paymentId: 'pref-x' });
      assert.equal((await payments.checkOrderPayment(sql, { id: none.id, code: none.code, payment_id: 'pref-x', payment_method: 'mercadopago_card' })).outcome, 'not_found');
    });

    await test('order-status (token): pendente consulta o Mercado Pago e já devolve approved', async () => {
      const o = await mkOrder('st-ok', { customerId: c.id, subtotal: 1200 });
      const p = payOf(o, 'approved'); mp.pays.push(p);
      await Q('update orders set payment_id = $2 where id = $1', [o.id, String(p.id)]);
      mp.calls = [];
      const res = await statusCall({ t: o.token });
      assert.equal(res.code, 200);
      assert.equal(res.body.payment_status, 'approved');
      assert.equal(mp.calls.length, 1);
      assert.deepEqual(await ledger(o.id), ['earn:12'], 'pontos creditados pela conferência');
      mp.calls = [];
      await statusCall({ t: o.token });
      assert.equal(mp.calls.length, 0, 'já aprovado: não consulta mais');
    });

    await test('order-status: limite por pedido (2 por minuto), pedido com mais de 2 h, sem pagamento ou sem token não consultam', async () => {
      const o = await mkOrder('st-limit', { subtotal: 1000 });
      const p = payOf(o, 'pending'); mp.pays.push(p);
      await Q('update orders set payment_id = $2 where id = $1', [o.id, String(p.id)]);
      // Ocupa a cota do minuto atual do pedido (evita depender de o teste cruzar a virada do minuto).
      await Q(`insert into rate_hits (scope, ip, minute, n) values ('payment_check', $1, date_trunc('minute', now()), 2)
               on conflict (scope, ip, minute) do update set n = 2`, ['order:' + o.id]);
      mp.calls = [];
      const res = await statusCall({ t: o.token });
      assert.equal(res.code, 200); assert.equal(res.body.payment_status, 'pending');
      assert.equal(mp.calls.length, 0, 'cota do minuto esgotada');

      const old = await mkOrder('st-old', { subtotal: 1000, ageMinutes: 121 });
      mp.pays.push(payOf(old, 'approved'));
      const noPay = await mkOrder('st-nopay', { subtotal: 1000, method: null });
      mp.calls = [];
      assert.equal((await statusCall({ t: old.token })).body.payment_status, 'pending');
      assert.equal((await statusCall({ t: noPay.token })).body.payment_status, 'pending');
      assert.equal(mp.calls.length, 0, 'fora da janela de 2 h ou sem pagamento gerado');

      const fresh = await mkOrder('st-notoken', { subtotal: 1000 });
      mp.pays.push(payOf(fresh, 'approved'));
      delete process.env.MERCADOPAGO_ACCESS_TOKEN;
      mp.calls = [];
      assert.equal((await statusCall({ t: fresh.token })).body.payment_status, 'pending');
      assert.equal(mp.calls.length, 0, 'sem token não consulta');
      process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
    });

    await test('order-status: falha do Mercado Pago não derruba a consulta; formato antigo ?code= também confere', async () => {
      const o = await mkOrder('st-fail', { subtotal: 1000, method: 'mercadopago_card', paymentId: 'pref-y' });
      const saved = globalThis.fetch;
      globalThis.fetch = async (url, init) => String(url).startsWith('https://api.mercadopago.com/') ? new Response('{}', { status: 500 }) : realFetch(url, init);
      console.error = () => {};
      try {
        const res = await statusCall({ t: o.token });
        assert.equal(res.code, 200); assert.equal(res.body.payment_status, 'pending');
      } finally { globalThis.fetch = saved; console.error = origErr; }

      const legacy = await mkOrder('st-code', { subtotal: 1000, method: 'mercadopago_card', paymentId: 'pref-z' });
      await Q('update orders set code = $2 where id = $1', [legacy.id, 'DG' + crypto.randomBytes(5).toString('hex').toUpperCase()]);
      const [{ code }] = await Q('select code from orders where id = $1', [legacy.id]);
      mp.pays.push(payOf({ code, total_cents: legacy.total_cents }, 'approved', { payment_method_id: 'visa' }));
      const res = await statusCall({ code });
      assert.equal(res.code, 200);
      assert.deepEqual(res.body, { code, payment_status: 'approved' });
    });

    await test('painel a=payment_check: staff confere, grava auditoria; sem login 401; sem token 503', async () => {
      const staff = await adminLogin('staff');
      assert.ok(staff.cookie, 'login do painel');
      const o = await mkOrder('adm', { subtotal: 1300, method: 'mercadopago_card', paymentId: 'pref-adm' });
      mp.pays.push(payOf(o, 'approved', { payment_method_id: 'visa' }));
      const r = await adminCall({ method: 'POST', action: 'payment_check', cookie: staff.cookie, body: { id: o.id } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.outcome, 'updated'); assert.equal(r.json.order.payment_status, 'approved'); assert.equal(r.json.mp_status, 'approved');
      const [a] = await Q(`select action, detail from admin_audit where username = $1 and action = 'pagamento_conferido'`, [staff.username]);
      assert.ok(a && /pending -> approved \(updated, pagamento \d+\)/.test(a.detail), a && a.detail);
      const again = await adminCall({ method: 'POST', action: 'payment_check', cookie: staff.cookie, body: { id: o.id } });
      assert.equal(again.json.outcome, 'unchanged');
      assert.equal((await adminCall({ method: 'POST', action: 'payment_check', body: { id: o.id } })).status, 401);
      assert.equal((await adminCall({ method: 'POST', action: 'payment_check', cookie: staff.cookie, body: { id: 999999999 } })).status, 404);
      delete process.env.MERCADOPAGO_ACCESS_TOKEN;
      assert.equal((await adminCall({ method: 'POST', action: 'payment_check', cookie: staff.cookie, body: { id: o.id } })).status, 503);
      process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
    });
  } finally {
    console.error = origErr;
    unmockMp();
    if (savedToken !== undefined) process.env.MERCADOPAGO_ACCESS_TOKEN = savedToken;
    await cleanup();
  }
  console.log(process.exitCode ? 'test-payments: FALHOU' : `test-payments: ${passed} testes passaram`);
  process.exit(process.exitCode || 0);
})().catch(e => { globalThis.fetch = realFetch; console.error(e); process.exit(1); });
