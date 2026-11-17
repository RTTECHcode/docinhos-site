// Testes v4 (A2, F2) do painel contra o banco de DESENVOLVIMENTO:
//  papéis (admin x staff), N6 cupons e disparo, N3 prêmios, N8 mimo e ajustes do pós-pagamento, N5 relatórios e CSV (S-04),
//  S-01 senha curta em produção e teto diário, O-01 saúde e eventos do webhook, U-06 Web Push (chaves geradas em memória),
//  N4 busca sem sinônimos.
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-admin.js
//  - Usuários do painel "zz-v4-a2-*" inseridos direto no banco (senha aleatória) e apagados no final, com tentativas e auditoria.
//  - Clientes, pedidos, cupons, produtos "ZZ-v4-a2" e eventos/inscrições de teste apagados no final. Ajustes do pós-pagamento restaurados.
//  - Nenhuma chamada externa: o envio do push é capturado por um fetch falso. Nenhuma chave é gravada em arquivo.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');
const adminHandler = require('../api/admin');
const healthHandler = require('../api/health');
const auth = require('../api/_lib/auth');
const gifts = require('../api/_lib/gifts');
const monitor = require('../api/_lib/monitor');
const push = require('../api/_lib/push');
const { generate } = require('./gerar-vapid');
const { textMatches, expandTerms } = adminHandler._internal;

const P = 'ZZ-v4-a2';
const U = 'zz-v4-a2-';
const Q = (t, p = []) => sql.query(t, p);
const HOST = 'painel.test.local';
const ENV_PUB = 'VAPID_PUBLIC_KEY', ENV_PRIV = 'VAPID_' + 'PRIVATE_KEY', ENV_SUBJ = 'VAPID_SUBJECT';
const ORIGINAL_APP_ENV = process.env.APP_ENV;
delete process.env[ENV_PUB]; delete process.env[ENV_PRIV]; delete process.env[ENV_SUBJ];
process.env.APP_ENV = 'development'; // F6 M3: fora de produção, salvo no teste da senha curta
let ipN = 0;
const nextIp = () => `203.0.113.${(++ipN % 250) + 1}`; // TEST-NET-3
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const phone = () => '119' + rnd(8);
const pass = () => 'Zz-' + crypto.randomBytes(12).toString('base64url');

async function acall(action, { method = 'GET', body, cookie, ip, query = '' } = {}) {
  const headers = { host: HOST, 'x-real-ip': ip || nextIp(), 'user-agent': 'test-v4-admin' };
  if (method === 'POST') { headers.origin = 'https://' + HOST; headers['content-type'] = 'application/json'; }
  if (cookie) headers.cookie = cookie;
  const req = { method, url: `/api/admin?a=${action}${query}`, headers, body: body === undefined ? {} : body, socket: { remoteAddress: '127.0.0.1' } };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(c) { this.body = c === undefined ? '' : c; } };
  await adminHandler(req, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* CSV ou vazio */ }
  return { status: res.statusCode, json, text: String(res.body), headers: res.headers };
}
const login = (username, password, ip) => acall('login', { method: 'POST', body: { username, password }, ip });
const cookieOf = r => (r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0] : null);
async function adminUser(suffix, role, password) {
  const name = U + suffix;
  await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at)
    values ($1, $2, $3, false, 'prof_favorito', $4, now())`, [name, await auth.hashPassword(password), role, await auth.hashAnswer('zz resposta v4')]);
  return name;
}
const lastAudit = async (username, action) => (await Q('select detail from admin_audit where username = $1 and action = $2 order by id desc limit 1', [username, action]))[0];

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', String(e.message).split('\n')[0].slice(0, 300)); process.exitCode = 1; }
}

const REVIEW_KEYS = [gifts.SETTING_KEY, gifts.INSTAGRAM_KEY];
let reviewSnap = null;
const EV_MARK = 'zz-v4-a2 teste';
async function cleanup() {
  await Q(`delete from coupons where code like 'ZZV4A2-%'`); // cascata: usos, campanhas e alvos
  const ids = (await Q(`select id from orders where customer_name like $1 or customer_name like $2`, [P + '%', '=' + P + '%'])).map(r => r.id);
  await Q(`delete from review_gifts where granted_by like $1 or granted_order_id = any($2::int[]) or delivered_order_id = any($2::int[])`, [U + '%', ids]);
  await Q(`delete from loyalty_ledger where order_id = any($1::int[])`, [ids]);
  await Q(`delete from orders where id = any($1::int[])`, [ids]);
  await Q(`delete from customers where name like $1 or name like $2`, [P + '%', '=' + P + '%']);
  await Q(`delete from club_rewards where product_id in (select id from products where name like $1)`, [P + '%']);
  await Q(`delete from products where name like $1`, [P + '%']);
  await Q(`delete from categories where name like $1`, [P + '%']);
  await Q(`delete from admin_push_subscriptions where username like $1`, [U + '%']);
  await Q(`delete from webhook_events where detail = $1`, [EV_MARK]);
  await Q(`delete from login_attempts where username like $1`, [U + '%']);
  await Q(`delete from admin_audit where username like $1`, [U + '%']);
  await Q(`delete from admin_users where username like $1`, [U + '%']);
}
async function restoreReview() {
  if (!reviewSnap) return;
  await Q('delete from settings where key = any($1::text[])', [REVIEW_KEYS]);
  for (const r of reviewSnap) await Q('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
}
async function mkOrder(ph, { total = 1500, pay = 'approved', name = `${P} Pedido` } = {}) {
  const code = 'ZZV4A2' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const [o] = await Q(`insert into orders (code, customer_name, customer_phone, delivery_method, items, subtotal_cents, delivery_fee_cents, discount_cents,
      points_redeemed, total_cents, payment_status, fulfillment_status)
    values ($1, $2, $3, 'pickup', '[{"name":"ZZ-v4-a2 Doce","qty":1,"unit_total_cents":1500}]'::jsonb, $4, 0, 0, 0, $4, $5, 'new')
    returning id, code, total_cents, created_at`, [code, name, ph, total, pay]);
  return o;
}

(async () => {
  await cleanup();
  reviewSnap = await Q('select key, value from settings where key = any($1::text[])', [REVIEW_KEYS]);
  const admPass = pass(), stfPass = pass();
  const ADM = await adminUser('adm', 'admin', admPass);
  const STF = await adminUser('stf', 'staff', stfPass);
  const AC = cookieOf(await login(ADM, admPass));
  const SC = cookieOf(await login(STF, stfPass));
  const realFetch = global.fetch;

  try {
    console.log('Papéis e sessão');
    await t('logins de teste funcionam', async () => { assert.ok(AC); assert.ok(SC); });
    await t('sem sessão: 401 nas ações novas', async () => {
      for (const a of ['coupons', 'club_rewards', 'review_settings', 'report_sales', 'report_customers_csv', 'health_detail', 'push_config']) assert.equal((await acall(a)).status, 401, a);
      for (const a of ['coupon_save', 'gift_grant', 'push_subscribe', 'push_test']) assert.equal((await acall(a, { method: 'POST', body: {} })).status, 401, a);
    });
    await t('staff: 403 em cupons, relatórios, CSV, prêmios (salvar), mimos pendentes, ajustes do pós-pagamento e mimo por telefone', async () => {
      for (const a of ['coupons', 'report_sales', 'report_customers', 'report_customers_csv', 'report_sales_csv', 'review_gifts']) assert.equal((await acall(a, { cookie: SC })).status, 403, a);
      for (const a of ['coupon_save', 'coupon_toggle', 'coupon_audience', 'coupon_campaign_create', 'club_reward_save', 'club_reward_toggle', 'review_settings_save'])
        assert.equal((await acall(a, { method: 'POST', cookie: SC, body: {} })).status, 403, a);
      assert.equal((await acall('gift_grant', { method: 'POST', cookie: SC, body: { phone: phone() } })).status, 403);
      for (const a of ['club_rewards', 'review_settings', 'push_config']) assert.equal((await acall(a, { cookie: SC })).status, 200, a);
      assert.equal((await acall('health_detail', { cookie: SC })).status, 403, 'F5-S-06: health_detail só admin');
    });

    console.log('N4: busca sem sinônimos');
    await t('textMatches: começo de palavra, sem acento, plural; meio de palavra não casa; expandTerms só o termo', async () => {
      assert.ok(textMatches('Biscoito Oreo', ['ore']));
      assert.ok(textMatches('Biscoito Oreo', ['ÓREOS']));
      assert.ok(textMatches('Copo com morango', ['Morangos']));
      assert.equal(textMatches('Biscoito Oreo', ['iscoito']), null);
      assert.deepEqual(expandTerms('  Óreo '), ['oreo']);
    });

    console.log('N6: cupons (admin)');
    let couponId;
    await t('coupon_save cria (código em maiúsculas), valida, recusa duplicado e troca de código; toggle; auditoria', async () => {
      const r = await acall('coupon_save', { method: 'POST', cookie: AC, body: { code: 'zzv4a2-adm', kind: 'percent', value: 15, max_uses_per_customer: 1, expires_at: '2099-12-31' } });
      assert.equal(r.status, 200); assert.equal(r.json.coupon.code, 'ZZV4A2-ADM'); couponId = r.json.coupon.id;
      assert.equal(r.json.coupon.state, 'on');
      for (const bad of [{ code: 'ZZV4A2-X1', kind: 'grátis', value: 1 }, { code: 'ZZV4A2-X2', kind: 'percent', value: 101 }, { code: 'x', kind: 'fixed', value: 100 },
        { code: 'ZZV4A2-X3', kind: 'fixed', value: 100, starts_at: '2030-01-02', expires_at: '2030-01-01' }])
        assert.equal((await acall('coupon_save', { method: 'POST', cookie: AC, body: bad })).status, 400, JSON.stringify(bad));
      assert.equal((await acall('coupon_save', { method: 'POST', cookie: AC, body: { code: 'ZZV4A2-ADM', kind: 'fixed', value: 100 } })).status, 409);
      assert.equal((await acall('coupon_save', { method: 'POST', cookie: AC, body: { id: couponId, code: 'ZZV4A2-OUTRO', kind: 'percent', value: 15 } })).json.code, 'code_locked');
      assert.equal((await acall('coupon_toggle', { method: 'POST', cookie: AC, body: { id: couponId } })).json.coupon.active, false);
      assert.equal((await acall('coupon_toggle', { method: 'POST', cookie: AC, body: { id: couponId, active: true } })).json.coupon.active, true);
      assert.ok((await acall('coupons', { cookie: AC })).json.coupons.some(c => c.id === couponId));
      assert.ok((await lastAudit(ADM, 'cupom_salvo')).detail.includes('ZZV4A2-ADM'));
    });

    // Cliente com consentimento e gasto enorme: o público "gastou acima de" só pega ele (nenhum cliente real).
    const P1 = phone();
    await Q(`insert into customers (name, phone, password_hash, security_question, security_answer_hash, whatsapp_consent, whatsapp_consent_at)
      values ($1, $2, 'zz', 'prof_favorito', 'zz', true, now())`, ['=' + P + ' Formula', P1]);
    const big = await mkOrder(P1, { total: 90000000 });
    await t('público, campanha, mensagem com link do site e marcação de enviado', async () => {
      const aud = await acall('coupon_audience', { method: 'POST', cookie: AC, body: { coupon_id: couponId, audience: { type: 'spent_over', cents: 89000000 } } });
      assert.equal(aud.status, 200); assert.equal(aud.json.count, 1);
      assert.equal((await acall('coupon_audience', { method: 'POST', cookie: AC, body: { coupon_id: couponId, audience: { type: 'nope' } } })).status, 400);
      const k = await acall('coupon_campaign_create', { method: 'POST', cookie: AC, body: { coupon_id: couponId, audience: { type: 'spent_over', cents: 89000000 } } });
      assert.equal(k.status, 200); assert.equal(k.json.count, 1);
      const g = await acall('coupon_campaign', { cookie: AC, query: `&id=${k.json.campaign_id}` });
      assert.equal(g.json.targets.length, 1);
      const msg = g.json.targets[0].message;
      assert.ok(msg.includes('ZZV4A2-ADM') && msg.includes('15% de desconto') && /https:\/\/[^\s]+\/\?cupom=ZZV4A2-ADM/.test(msg));
      const s = await acall('coupon_target_sent', { method: 'POST', cookie: AC, body: { campaign_id: k.json.campaign_id, customer_id: g.json.targets[0].customer_id } });
      assert.ok(s.json.sent_at);
      assert.equal((await acall('coupon_campaign', { cookie: AC, query: `&coupon_id=${couponId}` })).json.campaigns[0].sent, 1);
    });

    console.log('N3: prêmios (admin)');
    const [cat] = await Q(`insert into categories (name, sort_order, active) values ($1, 9999, true) returning id`, [`${P} Categoria Admin`]);
    const [prod] = await Q(`insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, 700, true, 9999) returning id`, [cat.id, `${P} Premio`]);
    await t('club_reward_save cria desligado, valida custo, toggle; auditoria com o nome do produto', async () => {
      const r = await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: prod.id, points_cost: 70, active: false } });
      assert.equal(r.status, 200); assert.equal(r.json.reward.state, 'off'); assert.equal(r.json.reward.product_name, `${P} Premio`);
      assert.ok((await lastAudit(ADM, 'clube_premio_salvo')).detail.includes(`${P} Premio`), 'auditoria sem "undefined"');
      assert.equal((await acall('club_reward_save', { method: 'POST', cookie: AC, body: { product_id: prod.id, points_cost: 0 } })).json.code, 'invalid_cost');
      const tg = await acall('club_reward_toggle', { method: 'POST', cookie: AC, body: { id: r.json.reward.id } });
      assert.equal(tg.json.reward.active, true);
      assert.ok((await lastAudit(ADM, 'clube_premio_ligado')).detail.includes(`${P} Premio`));
      assert.ok((await acall('club_rewards', { cookie: SC })).json.rewards.some(x => x.id === r.json.reward.id));
    });

    console.log('N8: mimo e ajustes do pós-pagamento');
    await t('mimo pelo pedido (staff), um pendente por telefone, aparece no pedido seguinte e é entregue ao concluir', async () => {
      const ph = phone();
      const o1 = await mkOrder(ph);
      const g = await acall('gift_grant', { method: 'POST', cookie: SC, body: { order_id: o1.id } });
      assert.equal(g.status, 200); assert.ok(g.json.gift.id);
      assert.equal((await acall('gift_grant', { method: 'POST', cookie: SC, body: { order_id: o1.id } })).json.code, 'gift_pending');
      const o2 = await mkOrder(ph);
      const withGift = await gifts.attachGifts(sql, [{ id: o1.id, customer_phone: ph, created_at: o1.created_at }, { id: o2.id, customer_phone: ph, created_at: o2.created_at }]);
      assert.equal(withGift[0].gift, null, 'o pedido avaliado não recebe o mimo');
      assert.equal(withGift[1].gift.id, g.json.gift.id);
      assert.equal((await acall('order_status', { method: 'POST', cookie: SC, body: { id: o2.id, status: 'completed' } })).status, 200);
      const [row] = await Q('select delivered_order_id from review_gifts where id = $1', [g.json.gift.id]);
      assert.equal(row.delivered_order_id, o2.id);
      assert.equal((await acall('gift_cancel', { method: 'POST', cookie: SC, body: { id: g.json.gift.id } })).status, 404, 'entregue não cancela');
    });
    await t('mimo por telefone (admin), lista de pendentes e cancelamento; telefone mascarado na auditoria', async () => {
      const ph = phone();
      const g = await acall('gift_grant', { method: 'POST', cookie: AC, body: { phone: ph } });
      assert.equal(g.status, 200);
      assert.ok((await acall('review_gifts', { cookie: AC })).json.gifts.some(x => x.id === g.json.gift.id));
      const det = (await lastAudit(ADM, 'mimo_concedido')).detail;
      assert.ok(!det.includes(ph) && det.includes(ph.slice(-4)), 'auditoria só com os 4 últimos dígitos');
      assert.equal((await acall('gift_cancel', { method: 'POST', cookie: AC, body: { id: g.json.gift.id } })).status, 200);
      assert.equal((await acall('gift_grant', { method: 'POST', cookie: AC, body: { phone: '123' } })).json.code, 'invalid_phone');
    });
    await t('review_settings_save: só https, Instagram opcional, reset volta ao padrão', async () => {
      for (const bad of [{ google_review_url: 'http://g.page/x' }, { google_review_url: 'javascript:alert(1)' }, { instagram_url: 'https://user:pw@insta.com/x' }, {}])
        assert.equal((await acall('review_settings_save', { method: 'POST', cookie: AC, body: bad })).status, 400, JSON.stringify(bad));
      let r = await acall('review_settings_save', { method: 'POST', cookie: AC, body: { google_review_url: 'https://g.page/r/zz-v4-a2/review', instagram_url: 'https://www.instagram.com/zzv4a2' } });
      assert.equal(r.status, 200); assert.equal(r.json.review.review_url_is_default, false); assert.equal(r.json.review.instagram_url, 'https://www.instagram.com/zzv4a2');
      r = await acall('review_settings_save', { method: 'POST', cookie: AC, body: { reset_review_url: true, instagram_url: '' } });
      assert.equal(r.json.review.review_url_is_default, true); assert.equal(r.json.review.instagram_url, null);
      assert.equal((await acall('review_settings', { cookie: SC })).json.review.google_review_url, gifts.DEFAULT_REVIEW_URL);
    });
    await restoreReview();

    console.log('N5 + S-04: relatórios e CSV');
    await t('report_sales: datas validadas; o pedido pago de teste entra no total do dia', async () => {
      assert.equal((await acall('report_sales', { cookie: AC, query: '&from=2026-13-01' })).json.code, 'invalid_date');
      assert.equal((await acall('report_sales', { cookie: AC, query: '&from=2026-01-10&to=2026-01-01' })).json.code, 'invalid_range');
      assert.equal((await acall('report_sales', { cookie: AC, query: '&from=2020-01-01&to=2026-01-01' })).json.code, 'range_too_long');
      const before = (await acall('report_sales', { cookie: AC })).json.report;
      const extraOrder = await mkOrder(phone(), { total: 4321 });
      const after = (await acall('report_sales', { cookie: AC })).json.report;
      assert.equal(after.paid_orders - before.paid_orders, 1);
      assert.equal(after.net_cents - before.net_cents, extraOrder.total_cents);
      assert.ok(Array.isArray(after.by_hour) && after.by_hour.length === 24 && after.by_weekday.length === 7);
      assert.ok((await lastAudit(ADM, 'relatorio_consulta')).detail.startsWith('vendas:'));
    });
    await t('report_customers: busca acha o cliente de teste; auditoria sem o termo buscado', async () => {
      const r = await acall('report_customers', { cookie: AC, query: `&s=${encodeURIComponent(P)}&sort=spent&dir=desc` });
      assert.equal(r.status, 200);
      const row = r.json.report.customers.find(c => c.phone_key === P1);
      assert.ok(row); assert.equal(row.paid_orders, 1); assert.equal(row.spent_cents, big.total_cents); assert.equal(row.whatsapp_consent, true);
      const det = (await lastAudit(ADM, 'relatorio_consulta')).detail;
      assert.ok(det.includes('busca sim') && !det.toLowerCase().includes('zz-v4-a2'));
    });
    await t('CSV de clientes: BOM, ponto e vírgula, fórmula neutralizada, telefone mascarado (completo só com pii=1); auditoria', async () => {
      const r = await acall('report_customers_csv', { cookie: AC, query: `&s=${encodeURIComponent(P)}` });
      assert.equal(r.status, 200);
      assert.ok(String(r.headers['content-type']).startsWith('text/csv'));
      assert.ok(/attachment; filename="clientes-\d{4}-\d{2}-\d{2}\.csv"/.test(r.headers['content-disposition']));
      assert.equal(r.text.charCodeAt(0), 0xfeff);
      assert.ok(r.text.includes('"Nome";"Telefone"'));
      assert.ok(r.text.includes(`"'=${P} Formula"`), 'célula começando com = ganha apóstrofo');
      assert.ok(!r.text.includes(P1), 'sem pii: telefone completo não sai');
      assert.ok(r.text.includes('*******' + P1.slice(-4)));
      const full = await acall('report_customers_csv', { cookie: AC, query: `&s=${encodeURIComponent(P)}&pii=1` });
      assert.ok(full.text.includes(P1));
      const det = (await lastAudit(ADM, 'relatorio_csv')).detail;
      assert.ok(det.includes('telefone completo') && !det.toLowerCase().includes('zz-v4-a2'));
    });
    await t('CSV de vendas: cabeçalho e nome do arquivo com o período', async () => {
      const r = await acall('report_sales_csv', { cookie: AC, query: '&from=2026-11-01&to=2026-11-14' });
      assert.equal(r.status, 200);
      assert.ok(r.headers['content-disposition'].includes('vendas-2026-11-01-a-2026-11-14.csv'));
      assert.ok(r.text.includes('"Dia";"Pedidos pagos";"Bruto (R$)"'));
    });

    console.log('S-01: login');
    await t('produção: senha certa mas curta = 401 igual à senha errada (F5-S-07), sem sessão, conta falha; fora de produção entra', async () => {
      const shortPass = 'Ab1-' + rnd(3); // 7 caracteres
      const SH = await adminUser('curta', 'staff', shortPass);
      process.env.APP_ENV = 'production';
      let r;
      try { r = await login(SH, shortPass); } finally { process.env.APP_ENV = 'development'; }
      const wrong = await login(SH, shortPass + 'x');
      assert.equal(r.status, 401); assert.equal(cookieOf(r), null);
      assert.deepEqual(r.json, wrong.json, 'mesma resposta da senha errada');
      assert.equal((await Q(`select count(*)::int n from login_attempts where username = $1 and not ok`, [SH]))[0].n, 2);
      assert.ok(await lastAudit(SH, 'login_senha_curta_bloqueado'));
      assert.equal((await login(SH, shortPass)).status, 200);
    });
    await t('teto diário: 50 falhas em 24 h (IPs variados) travam até a senha certa de IP conhecido; 1 aviso na auditoria', async () => {
      const dp = pass();
      const DU = await adminUser('dia', 'staff', dp);
      const known = nextIp();
      await Q(`insert into login_attempts (username, ip, ok, at) values ($1, $2, true, now() - interval '5 hours')`, [DU, known]);
      await Q(`insert into login_attempts (username, ip, ok, at) select $1, '203.0.113.' || (g % 200 + 1)::text || '.zz', false, now() - interval '2 hours' - (g || ' minutes')::interval
        from generate_series(1, 50) g`, [DU]);
      const r = await login(DU, dp, known);
      assert.equal(r.status, 429); assert.equal(cookieOf(r), null);
      await login(DU, dp, known);
      assert.equal((await Q(`select count(*)::int n from admin_audit where username = $1 and action = 'login_teto_diario'`, [DU]))[0].n, 1);
    });

    console.log('O-01: saúde');
    await t('/api/health: só sim/não (sem valores); 3 recusas do webhook depois do último aceito derrubam (F5-S-01); health_detail com resumo', async () => {
      const r1 = await new Promise(res => healthHandler({ method: 'GET' }, { setHeader() {}, status(c) { return { json: d => res({ status: c, body: d }) }; } }));
      assert.ok([200, 503].includes(r1.status));
      assert.deepEqual(Object.keys(r1.body.checks).sort(), ['database', 'mercadopago_token', 'mercadopago_webhook_secret', 'webhook_no_401_24h']);
      assert.ok(Object.values(r1.body.checks).every(v => typeof v === 'boolean'));
      assert.equal(r1.body.checks.database, true);
      // F5-S-01: um aceito agora zera o alerta; 1 ou 2 recusas depois dele não derrubam; a 3ª derruba.
      await monitor.recordWebhookEvent(sql, 'accepted', EV_MARK);
      await monitor.recordWebhookEvent(sql, 'unauthorized', EV_MARK);
      await monitor.recordWebhookEvent(sql, 'unauthorized', EV_MARK);
      const r15 = await new Promise(res => healthHandler({ method: 'GET' }, { setHeader() {}, status(c) { return { json: d => res({ status: c, body: d }) }; } }));
      assert.equal(r15.body.checks.webhook_no_401_24h, true, '2 recusas depois do aceito não acendem');
      await monitor.recordWebhookEvent(sql, 'unauthorized', EV_MARK);
      const r2 = await new Promise(res => healthHandler({ method: 'GET' }, { setHeader() {}, status(c) { return { json: d => res({ status: c, body: d }) }; } }));
      assert.equal(r2.status, 503); assert.equal(r2.body.checks.webhook_no_401_24h, false);
      const d = await acall('health_detail', { cookie: AC });
      assert.equal(d.status, 200); assert.ok(d.json.health.unauthorized_24h >= 1); assert.ok(d.json.health.last_unauthorized_at);
      await Q(`delete from webhook_events where detail = $1`, [EV_MARK]);
    });

    console.log('U-06: Web Push');
    const others = (await Q(`select count(*)::int n from admin_push_subscriptions where username not like $1`, [U + '%']))[0].n;
    await t('sem chaves VAPID: desligado sem erro (config, inscrever = 409, aviso de pago ignorado)', async () => {
      const c = await acall('push_config', { cookie: SC });
      assert.equal(c.json.push.enabled, false); assert.equal(c.json.push.public_key, null);
      const sub = await acall('push_subscribe', { method: 'POST', cookie: SC, body: { subscription: {} } });
      assert.equal(sub.status, 409); assert.equal(sub.json.code, 'push_disabled');
      assert.deepEqual(await push.notifyPaid(sql, 1), { skipped: 'disabled' });
    });
    // Chaves geradas agora, só na memória deste processo.
    const keys = generate();
    process.env[ENV_PUB] = keys.publicKey; process.env[ENV_PRIV] = keys.privateKey; process.env[ENV_SUBJ] = 'mailto:zz-v4-a2@example.com';
    const client = crypto.createECDH('prime256v1'); client.generateKeys();
    const clientAuth = crypto.randomBytes(16);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/zz-v4-a2-' + crypto.randomBytes(6).toString('hex');
    const subscription = { endpoint, keys: { p256dh: client.getPublicKey().toString('base64url'), auth: clientAuth.toString('base64url') } };
    const sent = [];
    let replyStatus = 201;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith('https://fcm.googleapis.com/')) { sent.push({ url: String(url), opts }); return new Response('', { status: replyStatus }); }
      return realFetch(url, opts);
    };
    function decrypt(body) {
      const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const shared = client.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), client.getPublicKey(), asPublic]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, clientAuth, info, 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2, 'delimitador do último registro');
      return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
    }
    function verifyVapid(header) {
      const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
      assert.ok(m, 'cabeçalho vapid');
      assert.equal(m[2], keys.publicKey);
      const [h, b, s] = m[1].split('.');
      const pub = Buffer.from(keys.publicKey, 'base64url');
      const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
      assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'assinatura ES256');
      const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
      assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.sub, 'mailto:zz-v4-a2@example.com');
    }
    await t('inscrição: valida endpoint e chaves; aceita a válida; config mostra a chave pública e 1 aparelho', async () => {
      for (const [bad, code] of [[{ ...subscription, endpoint: 'http://fcm.googleapis.com/x' }, 'invalid_subscription'],
        [{ ...subscription, endpoint: 'https://evil.example.com/x' }, 'unsupported_push_service'],
        [{ ...subscription, endpoint: 'https://fcm.googleapis.com.evil.com/x' }, 'unsupported_push_service'],
        [{ endpoint, keys: { p256dh: 'abc', auth: subscription.keys.auth } }, 'invalid_subscription']]) {
        assert.equal((await acall('push_subscribe', { method: 'POST', cookie: SC, body: { subscription: bad } })).json.code, code, bad.endpoint);
      }
      const r = await acall('push_subscribe', { method: 'POST', cookie: SC, body: { subscription } });
      assert.equal(r.status, 200); assert.equal(r.json.devices, 1);
      const c = await acall('push_config', { cookie: SC });
      assert.equal(c.json.push.enabled, true); assert.equal(c.json.push.public_key, keys.publicKey); assert.equal(c.json.push.devices, 1);
    });
    await t('pedido pago: aviso cifrado (RFC 8291) com VAPID válido, só código e valor, uma vez por pedido', async () => {
      if (others > 0) { console.log('      (pulado: há inscrições reais no banco dev; não envio para elas)'); return; }
      const o = await mkOrder(phone(), { total: 4590 });
      sent.length = 0;
      const r1 = await push.notifyPaid(sql, o.id);
      assert.equal(r1.sent, 1);
      assert.equal(sent.length, 1); assert.equal(sent[0].url, endpoint);
      verifyVapid(sent[0].opts.headers.Authorization);
      assert.equal(sent[0].opts.headers['Content-Encoding'], 'aes128gcm');
      const msg = decrypt(Buffer.from(sent[0].opts.body));
      assert.deepEqual(Object.keys(msg).sort(), ['body', 'tag', 'title', 'url']);
      assert.ok(msg.title.startsWith('Pedido ') && msg.title.endsWith(' pago')); assert.equal(msg.body, 'R$ 45,90');
      assert.ok(!JSON.stringify(msg).includes(P), 'sem nome do cliente');
      assert.deepEqual(await push.notifyPaid(sql, o.id), { skipped: 'already_or_not_eligible' });
      assert.equal(sent.length, 1);
      const pending = await mkOrder(phone(), { pay: 'pending' });
      assert.deepEqual(await push.notifyPaid(sql, pending.id), { skipped: 'already_or_not_eligible' }, 'pendente não avisa');
    });
    await t('push_test: 410 do serviço apaga a inscrição; sem aparelho = 409; desinscrever remove', async () => {
      replyStatus = 410;
      const r = await acall('push_test', { method: 'POST', cookie: SC });
      assert.equal(r.status, 200); assert.equal(r.json.removed, 1);
      assert.equal((await acall('push_test', { method: 'POST', cookie: SC })).json.code, 'no_subscription');
      replyStatus = 201;
      await acall('push_subscribe', { method: 'POST', cookie: SC, body: { subscription } });
      assert.equal((await acall('push_test', { method: 'POST', cookie: SC })).json.sent, 1);
      const u = await acall('push_unsubscribe', { method: 'POST', cookie: SC, body: { endpoint } });
      assert.equal(u.json.removed, 1); assert.equal(u.json.devices, 0);
    });
    // F5-S-04: usuário desativado perde as inscrições e não recebe aviso de pedido pago.
    await t('F5-S-04: user_toggle (desativar) apaga as inscrições push do usuário; notifyPaid ignora usuário inativo', async () => {
      const name = await adminUser('push', 'staff', pass());
      const [{ id }] = await Q('select id from admin_users where username = $1', [name]);
      const ep = 'https://fcm.googleapis.com/fcm/send/zz-v4-a2-f5-' + crypto.randomBytes(6).toString('hex');
      await Q(`insert into admin_push_subscriptions (username, endpoint, p256dh, auth) values ($1, $2, $3, $4)`,
        [name, ep, subscription.keys.p256dh, subscription.keys.auth]);
      if (others === 0) {
        await Q('update admin_users set active = false where id = $1', [id]);
        const o = await mkOrder(phone(), { total: 1234 });
        sent.length = 0;
        await push.notifyPaid(sql, o.id);
        assert.ok(!sent.some(x => x.url === ep), 'inativo não recebe');
        await Q('update admin_users set active = true where id = $1', [id]);
      }
      const r = await acall('user_toggle', { method: 'POST', cookie: AC, body: { id, active: false } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await Q('select count(*)::int n from admin_push_subscriptions where username = $1', [name]))[0].n, 0);
      assert.match((await lastAudit(ADM, 'usuario_desativado')).detail, /1 aparelho/);
    });
  } finally {
    global.fetch = realFetch;
    delete process.env[ENV_PUB]; delete process.env[ENV_PRIV]; delete process.env[ENV_SUBJ];
    if (ORIGINAL_APP_ENV !== undefined) process.env.APP_ENV = ORIGINAL_APP_ENV; else delete process.env.APP_ENV;
    await restoreReview();
    await cleanup();
    const [left] = await Q(`select (select count(*) from admin_users where username like $1)::int u, (select count(*) from orders where customer_name like $2 or customer_name like $3)::int o,
      (select count(*) from customers where name like $2 or name like $3)::int c, (select count(*) from admin_push_subscriptions where username like $1)::int s,
      (select count(*) from webhook_events where detail = $4)::int w`, [U + '%', P + '%', '=' + P + '%', EV_MARK]);
    console.log('limpeza:', JSON.stringify(left));
  }
  console.log(`${passed} passaram, ${failed} falharam`);
})().catch(async e => { console.error('ERRO:', String(e.message).slice(0, 200)); process.exitCode = 1; try { await restoreReview(); await cleanup(); } catch { /* */ } });
