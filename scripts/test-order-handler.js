// Teste do handler real de /api/order, /api/order-status e do webhook contra o banco de DESENVOLVIMENTO.
// Uso: node -r ./scripts/dev-env.js scripts/test-order-handler.js
//
// - Produtos de teste "ZZ-TESTE ..." criados aqui e apagados no final (não depende do cardápio real).
// - Rede de frete (ViaCEP, Nominatim, OSRM) e API do Mercado Pago simuladas: nenhuma chamada externa.
// - Horário da loja, fechamento manual e configurações de frete são salvos antes e restaurados no final.
// - Pedidos "__TESTE__", clientes "ZZ-TESTE" e caches de teste são apagados no final.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
delete process.env.MERCADOPAGO_ACCESS_TOKEN;
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;

const sql = require('../api/_lib/db');
const handler = require('../api/order');
const statusHandler = require('../api/order-status');
const webhook = require('../api/mp-webhook');
const shipping = require('../api/_lib/shipping');
const storeHours = require('../api/_lib/store-hours');
const customerLib = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');
const ordersLib = require('../api/_lib/orders');
const { STORE_ADDRESS } = handler._internal;

const NAME = '__TESTE__';
const CAT = 'ZZ-TESTE categoria';
const P_OK = 'ZZ-TESTE Doce';
const P_BIG = 'ZZ-TESTE Caixa';
const SETTING_KEYS = ['store_paused', 'store_paused_message', 'store_origin_lat', 'store_origin_lon', 'shipping_bands', 'default_pause_label'];
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const phoneSeq = () => '119' + rnd(8); // telefone de pedido, único por teste (limite de 5 por 10 min)
const accountPhone = () => '119' + rnd(8);

function run(fn, req) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d, headers }); return this; }
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}
const call = (body, cookie, method = 'POST') => run(handler, { method, body, headers: cookie ? { cookie } : {} });
const track = (query, method = 'GET') => run(statusHandler, { method, query });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

// ---------- rede simulada (frete) ----------
const BASE_LAT = -23.5, BASE_LON = -46.8;
const net = { calls: [], osrmDown: false };
// CEP -> tag no nome da rua; a tag diz ao Nominatim/OSRM simulados qual distância devolver.
const CEPS = { '06000001': 'km2', '06000002': 'km5', '06000003': 'km8', '06000004': 'km12', '06000005': 'reta', '06000006': 'semgeo', '06000007': 'km3', '06000008': 'km6', '06000009': 'km10' };
function fakeFetch(url, init = {}) {
  const u = String(url);
  net.calls.push({ url: u, init });
  const json = data => ({ ok: true, status: 200, json: async () => data });
  if (u.startsWith('https://viacep.com.br/ws/')) {
    const cep = u.split('/')[4];
    if (cep === '06999999') return json({ erro: true });
    if (!CEPS[cep]) return { ok: false, status: 500, json: async () => ({}) };
    return json({ logradouro: `Rua ZZ Teste ${CEPS[cep]}`, bairro: 'Centro', localidade: 'Osasco', uf: 'SP' });
  }
  if (u.startsWith('https://nominatim.openstreetmap.org/search')) {
    const q = decodeURIComponent(u.split('&q=')[1] || '');
    if (/Manoel Hare Peralta/i.test(q)) return json([{ lat: String(BASE_LAT), lon: String(BASE_LON), display_name: 'origem teste' }]);
    if (/semgeo/.test(q)) return json([]);
    if (/reta/.test(q)) return json([{ lat: String(BASE_LAT + 0.02698), lon: String(BASE_LON), display_name: 'destino em linha reta' }]);
    const m = /km(\d+)/.exec(q);
    if (m) return json([{ lat: String(BASE_LAT), lon: String((BASE_LON + Number(m[1]) * 0.001).toFixed(5)), display_name: 'destino ' + m[0] }]);
    return json([]);
  }
  if (u.startsWith('https://router.project-osrm.org/')) {
    if (net.osrmDown) return { ok: false, status: 503, json: async () => ({}) };
    const dest = u.split('/driving/')[1].split('?')[0].split(';')[1].split(',');
    const lon = Number(dest[0]), lat = Number(dest[1]);
    if (lat !== BASE_LAT) return { ok: false, status: 500, json: async () => ({}) }; // destino "reta": OSRM sem rota
    return json({ code: 'Ok', routes: [{ distance: Math.round((lon - BASE_LON) / 0.001) * 1000 }] });
  }
  throw new Error('rede inesperada: ' + u);
}

// ---------- dados e estado de teste ----------
let snap, prodOk, prodBig;
async function snapshot() {
  return {
    hours: await sql.query('select weekday, opens, closes from store_hours'),
    state: (await sql.query('select * from store_state where id = 1'))[0] || null,
    settings: await sql.query('select key, value from settings where key = any($1::text[])', [SETTING_KEYS])
  };
}
async function restore(s) {
  await sql.query('delete from store_hours');
  for (const h of s.hours) await sql.query('insert into store_hours (weekday, opens, closes) values ($1, $2, $3)', [h.weekday, h.opens, h.closes]);
  await sql.query('delete from store_state where id = 1');
  if (s.state) {
    await sql.query(`insert into store_state (id, closed_until, closed_indefinitely, closed_message, updated_by) values (1, $1, $2, $3, $4)`,
      [s.state.closed_until, s.state.closed_indefinitely, s.state.closed_message, s.state.updated_by]);
  }
  await sql.query('delete from settings where key = any($1::text[])', [SETTING_KEYS]);
  for (const r of s.settings) await sql.query('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
}
async function cleanup() {
  const orders = await sql.query('delete from orders where customer_name = $1 returning id', [NAME]);
  await sql.query(`delete from customers where name like 'ZZ-TESTE%'`);
  await sql.query(`delete from customer_login_attempts where ip like '203.0.113.%' or ip like '198.51.100.%'`);
  await sql.query(`delete from products where name like 'ZZ-TESTE%'`);
  await sql.query(`delete from categories where name like 'ZZ-TESTE%'`);
  await sql.query(`delete from geocode_cache where addr_key like '%zz teste%'`);
  await sql.query(`delete from route_cache where origin = $1`, [`${BASE_LAT.toFixed(5)},${BASE_LON.toFixed(5)}`]);
  return orders.length;
}

const fresh = () => ({
  customer_name: NAME, customer_phone: phoneSeq(), delivery_method: 'pickup', notes: 'teste',
  items: [{ product_id: prodOk.id, qty: 1 }]
});
const delivery = (cep, over = {}) => ({ ...fresh(), delivery_method: 'delivery', cep, address: 'Rua ZZ Teste, 123', address_number: '123', ...over });
const orderRow = async id => (await sql.query('select * from orders where id = $1', [id]))[0];

// Webhook do Mercado Pago com a API simulada.
async function payWebhook(order, status, { amountCents, paymentId } = {}) {
  const real = globalThis.fetch;
  const id = paymentId || String(900000000 + Math.floor(Math.random() * 99999999));
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.mercadopago.com/')
    ? { ok: true, status: 200, json: async () => ({ id: Number(id), status, external_reference: order.code, transaction_amount: (amountCents ?? order.total_cents) / 100, currency_id: 'BRL', payment_method_id: 'visa' }) }
    : real(url, init));
  try { return await run(webhook, { method: 'POST', query: {}, body: { type: 'payment', data: { id } }, headers: {} }); }
  finally { globalThis.fetch = real; delete process.env.MERCADOPAGO_ACCESS_TOKEN; }
}

async function mkCustomer(tag) {
  const phone = accountPhone();
  const { customer, token } = await customerLib.createAccount(sql, {
    name: 'ZZ-TESTE ' + tag, phone, password: 'senha-de-teste-1', security_question: 'prof_favorito', security_answer: 'Dona Maria'
  }, { ip: '203.0.113.' + Math.floor(Math.random() * 200) });
  return { id: customer.id, phone, cookie: `${customerLib.COOKIE_NAME}=${token}` };
}
const balanceOf = async id => (await loyalty.getBalance(sql, id)).balance;

(async () => {
  await cleanup();
  snap = await snapshot();
  shipping.setFetch(fakeFetch);
  // estado conhecido: sem horários (aberta), sem fechamento manual, origem fixa, faixas padrão
  await sql.query('delete from store_hours');
  await sql.query('delete from store_state where id = 1');
  await sql.query(`delete from settings where key in ('store_paused', 'shipping_bands', 'default_pause_label', 'store_origin_lat', 'store_origin_lon')`);
  await shipping.setOrigin(sql, BASE_LAT, BASE_LON);
  const [cat] = await sql.query('insert into categories (name, sort_order, active) values ($1, 999, true) returning id', [CAT]);
  prodOk = (await sql.query('insert into products (category_id, name, price_cents, active) values ($1, $2, 1000, true) returning id', [cat.id, P_OK]))[0];
  prodBig = (await sql.query('insert into products (category_id, name, price_cents, active) values ($1, $2, 3000, true) returning id', [cat.id, P_BIG]))[0];

  // ===== O1: código DG-#### e token de rastreio =====
  let created;
  await test('GET -> 405; corpo inválido -> 400', async () => {
    assert.equal((await call({}, null, 'GET')).status, 405);
    assert.equal((await call(null)).status, 400);
    assert.equal((await call('{ruim')).status, 400);
  });

  await test('O1: pedido devolve DG-####, token de 128 bits e guarda só o SHA-256', async () => {
    const r = await call({ ...fresh(), customer_phone: '(11) 98888-7777' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created = r.body;
    assert.match(created.public_code, /^DG-\d{4}$/);
    assert.match(created.code, /^DG[0-9A-F]{10}$/); // code interno continua sendo a external_reference do MP
    assert.match(created.tracking_token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(created.total_cents, 1000);
    assert.equal(created.delivery_fee_cents, 0);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    const row = await orderRow(created.id);
    assert.equal(row.public_code, created.public_code);
    assert.equal(row.tracking_token_hash, crypto.createHash('sha256').update(created.tracking_token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(created.tracking_token), 'o token puro não pode estar em nenhuma coluna');
  });

  await test('O1: rastreio por ?t= mostra o essencial e nunca telefone/endereço; ?code antigo segue funcionando', async () => {
    const r = await track({ t: created.tracking_token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.public_code, created.public_code);
    assert.equal(r.body.payment_status, 'pending');
    assert.equal(r.body.fulfillment_status, 'new');
    assert.equal(r.body.fulfillment_label, 'novo');
    assert.equal(r.body.delivery_method, 'pickup');
    assert.ok(r.body.created_at && 'accepted_at' in r.body && 'completed_at' in r.body);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('98888') && !text.includes(STORE_ADDRESS) && !/customer_phone|address/.test(text), 'vazou dado pessoal: ' + text);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    const old = await track({ code: created.code });
    assert.equal(old.status, 200);
    assert.deepEqual(old.body, { code: created.code, payment_status: 'pending' });
    assert.equal((await track({ code: created.public_code })).status, 404, 'DG-#### não é chave de consulta');
    for (const bad of [{ t: 'a'.repeat(22) }, { t: 'curto' }, { t: ["x"] }, { t: "x' or 1=1 --" }, {}]) assert.equal((await track(bad)).status, 404);
    assert.equal((await track({ t: created.tracking_token }, 'POST')).status, 405);
  });

  await test('O1: DG-#### só precisa ser único nos últimos 90 dias (colisão antiga é aceita)', async () => {
    const old = await call(fresh());
    assert.equal(old.status, 201);
    await sql.query(`update orders set created_at = now() - interval '91 days' where id = $1`, [old.body.id]);
    const w = ordersLib.PUBLIC_CODE_WINDOW;
    assert.equal(w, '90 days');
    const dup = await sql.query(`select 1 from orders where public_code = $1 and created_at > now() - interval '${w}'`, [old.body.public_code]);
    assert.equal(dup.length, 0);
    const [idx] = await sql.query(`select indexdef from pg_indexes where indexname = 'orders_public_code_idx'`);
    assert.ok(!idx || !/unique/i.test(idx.indexdef), 'índice do DG-#### não pode ser único');
  });

  // ===== O6: status e conclusão automática =====
  await test('O6: pronto há mais de 1 h vira concluído na leitura (sem cron), com completed_at = ready_at + 1 h', async () => {
    const r = await call(fresh());
    await sql.query(`update orders set fulfillment_status = 'ready', ready_at = now() - interval '90 minutes' where id = $1`, [r.body.id]);
    const t = await track({ t: r.body.tracking_token });
    assert.equal(t.body.fulfillment_status, 'completed');
    assert.equal(t.body.fulfillment_label, 'concluído');
    const row = await orderRow(r.body.id);
    assert.equal(Math.round((new Date(row.completed_at) - new Date(row.ready_at)) / 60000), 60);
    const fresh2 = await call(fresh());
    await sql.query(`update orders set fulfillment_status = 'ready', ready_at = now() - interval '10 minutes' where id = $1`, [fresh2.body.id]);
    assert.equal((await track({ t: fresh2.body.tracking_token })).body.fulfillment_status, 'ready');
  });

  await test('O6: valor antigo "delivered" lido como concluído, sem reescrever o banco', async () => {
    const r = await call(fresh());
    await sql.query(`update orders set fulfillment_status = 'delivered' where id = $1`, [r.body.id]);
    const t = await track({ t: r.body.tracking_token });
    assert.equal(t.body.fulfillment_status, 'completed');
    assert.equal((await orderRow(r.body.id)).fulfillment_status, 'delivered');
  });

  // ===== O2: pausa =====
  await test('O2: produto pausado é recusado com o rótulo do produto ou o padrão "volto logo <3"', async () => {
    await sql.query('update products set paused = true, pause_label = null where id = $1', [prodOk.id]);
    const a = await call(fresh());
    assert.equal(a.status, 400);
    assert.match(a.body.error, /volto logo <3/);
    assert.match(a.body.error, /ZZ-TESTE Doce/);
    await sql.query(`update products set pause_label = 'volta amanhã' where id = $1`, [prodOk.id]);
    const b = await call(fresh());
    assert.equal(b.status, 400);
    assert.match(b.body.error, /volta amanhã/);
    await sql.query(`insert into settings (key, value) values ('default_pause_label', 'já já') on conflict (key) do update set value = excluded.value`);
    await sql.query('update products set pause_label = null where id = $1', [prodOk.id]);
    assert.match((await call(fresh())).body.error, /já já/);
    await sql.query(`delete from settings where key = 'default_pause_label'`);
    await sql.query('update products set paused = false where id = $1', [prodOk.id]);
    assert.equal((await call(fresh())).status, 201);
  });

  await test('O2: ativo e pausado são independentes (inativo continua recusado como antes)', async () => {
    await sql.query('update products set active = false where id = $1', [prodOk.id]);
    assert.equal((await call(fresh())).status, 400);
    await sql.query('update products set active = true where id = $1', [prodOk.id]);
    assert.equal((await call(fresh())).status, 201);
  });

  // ===== O3/O4: loja fechada =====
  await test('O4: fechamento manual com mensagem recusa o pedido (503 store_closed) e some sozinho ao vencer', async () => {
    await storeHours.closeStore(sql, { minutes: 30, message: 'voltamos em 30 min', user: 'teste' });
    const r = await call(fresh());
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'store_closed');
    assert.equal(r.body.store.open, false);
    assert.equal(r.body.store.reason, 'manual');
    assert.ok(r.body.store.reopens_at);
    assert.match(r.body.error, /^voltamos em 30 min/);
    assert.match(r.body.error, /Previsão de reabertura/);
    await sql.query(`update store_state set closed_until = now() - interval '1 minute' where id = 1`);
    assert.equal((await call(fresh())).status, 201, 'fechamento vencido não pode continuar valendo');
    await storeHours.closeStore(sql, { indefinite: true, user: 'teste' });
    assert.equal((await call(fresh())).status, 503);
    await storeHours.reopenStore(sql, 'teste');
    assert.equal((await call(fresh())).status, 201);
  });

  await test('O3/O4: fora do horário recusa e informa a próxima abertura; dentro do horário aceita', async () => {
    const now = new Date();
    const dow = now.getDay();
    // Janela que não contém "agora" em nenhum fuso razoável: todos os dias de 03:00 a 03:01 de São Paulo.
    const rows = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '03:00', closes: '03:01' }));
    await storeHours.saveHours(sql, rows);
    const st = await storeHours.getStoreState(sql, new Date('2026-11-11T15:00:00Z')); // 12:00 em São Paulo
    assert.equal(st.open, false);
    assert.equal(st.reason, 'schedule');
    assert.ok(st.next_open_at);
    const spHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(now));
    const spMin = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }).format(now));
    const insideNow = spHour === 3 && spMin === 0;
    const r = await call(fresh());
    if (!insideNow) {
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'store_closed');
      assert.equal(r.body.store.reason, 'schedule');
      assert.ok(r.body.store.next_open_at);
    }
    void dow;
    // horário que cobre o dia inteiro: aceita
    await storeHours.saveHours(sql, [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '00:00', closes: '23:59' })));
    assert.equal((await call(fresh())).status, 201);
    await sql.query('delete from store_hours');
  });

  // ===== O5: frete por faixa =====
  const feeFor = async cep => { const r = await call(delivery(cep)); return r; };
  await test('O5: faixas padrão (rede simulada): 2 km = R$ 6, 5 km = R$ 9, 8 km = R$ 14; limites 3, 6 e 10 km inclusos', async () => {
    const cases = [['06000001', 2, 600], ['06000007', 3, 600], ['06000002', 5, 900], ['06000008', 6, 900], ['06000003', 8, 1400], ['06000009', 10, 1400]];
    for (const [cep, km, fee] of cases) {
      const r = await feeFor(cep);
      assert.equal(r.status, 201, `${km} km: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.delivery_fee_cents, fee, `${km} km`);
      assert.equal(r.body.distance_km, km);
      assert.equal(r.body.total_cents, 1000 + fee);
      const row = await orderRow(r.body.id);
      assert.equal(Number(row.distance_km), km);
      assert.equal(row.delivery_fee_cents, fee);
      assert.equal(row.total_cents, 1000 + fee);
    }
  });

  await test('O5: acima de 10 km -> 422 out_of_area com o limite; nenhum pedido é criado', async () => {
    const before = (await sql.query(`select count(*)::int n from orders where customer_name = $1`, [NAME]))[0].n;
    const r = await feeFor('06000004');
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'out_of_area');
    assert.equal(r.body.max_km, 10);
    assert.match(r.body.error, /fora da área de entrega \(até 10 km\)/i);
    assert.equal((await sql.query(`select count(*)::int n from orders where customer_name = $1`, [NAME]))[0].n, before);
  });

  await test('O5: cliente não manda frete (valor enviado é ignorado); CEP ausente/inválido -> 400', async () => {
    const r = await call(delivery('06000001', { delivery_fee_cents: 0, total_cents: 1, distance_km: 0 }));
    assert.equal(r.status, 201);
    assert.equal(r.body.delivery_fee_cents, 600);
    const noCep = await call({ ...delivery('06000001'), cep: undefined });
    assert.equal(noCep.status, 400);
    assert.match(noCep.body.error, /CEP/);
    assert.equal((await call(delivery('123'))).status, 400);
    assert.equal((await call(delivery('06000001', { address: '' }))).status, 400);
  });

  await test('O5: retirada custa R$ 0, não consulta a rede e grava o endereço da loja', async () => {
    net.calls.length = 0;
    const r = await call({ ...fresh(), address: 'Av. Falsa, 999', cep: '06000004' });
    assert.equal(r.status, 201);
    assert.equal(r.body.delivery_fee_cents, 0);
    assert.equal(r.body.distance_km, null);
    assert.equal(r.body.address, STORE_ADDRESS);
    assert.equal(net.calls.length, 0);
  });

  await test('O5: faixas editadas valem no pedido (R$ 7,50 até 4 km; acima disso fora da área)', async () => {
    await shipping.saveBands(sql, [{ max_km: 4, fee_cents: 750 }]);
    assert.equal((await feeFor('06000001')).body.delivery_fee_cents, 750);
    const out = await feeFor('06000002'); // 5 km
    assert.equal(out.status, 422);
    assert.equal(out.body.max_km, 4);
    await sql.query(`delete from settings where key = 'shipping_bands'`);
  });

  await test('O5: OSRM fora do ar -> linha reta x 1,3 (com log); geocodificação ou CEP falhando -> erro claro', async () => {
    const warn = console.warn; const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      const q = await shipping.quoteDelivery(sql, { cep: '06000005', address: 'Rua ZZ Teste reta, 1' });
      assert.equal(q.source, 'straight_line');
      assert.ok(Math.abs(q.km - 3.9) < 0.25, 'km=' + q.km); // ~3,0 km em linha reta x 1,3
      assert.equal(q.fee_cents, 900);
      assert.ok(warned.some(l => /linha reta/.test(l)));
      const o = await call(delivery('06000005'));
      assert.equal(o.status, 201, JSON.stringify(o.body));
      assert.equal(o.body.delivery_fee_cents, 900);
    } finally { console.warn = warn; }
    const none = await feeFor('06000006'); // Nominatim não acha
    assert.equal(none.status, 422);
    assert.equal(none.body.code, 'address_not_found');
    assert.match(none.body.error, /endereço/i);
    const nocep = await feeFor('06999999');
    assert.equal(nocep.status, 422);
    assert.equal(nocep.body.code, 'cep_not_found');
  });

  await test('O5: Nominatim com User-Agent do projeto sem e-mail e countrycodes=br; cache evita repetir consulta', async () => {
    const nom = net.calls.filter(c => c.url.startsWith('https://nominatim.openstreetmap.org/'));
    assert.ok(nom.length > 0);
    for (const c of nom) {
      assert.equal(c.init.headers['User-Agent'], 'DocinhosDaGigi/1.0 (+https://docinhos-site.vercel.app)');
      assert.ok(!/@/.test(c.init.headers['User-Agent']));
      assert.match(c.url, /countrycodes=br/);
    }
    net.calls.length = 0;
    const again = await feeFor('06000001');
    assert.equal(again.status, 201);
    assert.equal(net.calls.filter(c => /nominatim|router\.project-osrm/.test(c.url)).length, 0, 'segunda consulta deveria vir do cache');
  });

  // ===== O10/O11: pontos =====
  await test('O11: sem login não resgata pontos (401); inválidos -> 400; saldo insuficiente -> 409', async () => {
    const anon = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'login_required');
    const c = await mkCustomer('saldo');
    for (const bad of [-100, 1.5, '100', 150, 50]) {
      const r = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: bad }, c.cookie);
      assert.equal(r.status, 400, `use_points=${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
    }
    const r = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 }, c.cookie);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'insufficient_points');
    assert.equal(await balanceOf(c.id), 0);
  });

  await test('O11: 100 pontos = R$ 10 em blocos; desconto nunca passa do subtotal; mínimo cobrado R$ 1,00', async () => {
    const c = await mkCustomer('desconto');
    await loyalty.adjust(sql, { customerId: c.id, points: 1000, note: 'teste' });
    // subtotal R$ 10: 100 pontos zeraria o total (< R$ 1,00) e 200 pontos passaria do subtotal
    const tooBig = await call({ ...fresh(), use_points: 200 }, c.cookie);
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.code, 'discount_too_big');
    const zero = await call({ ...fresh(), use_points: 100 }, c.cookie);
    assert.equal(zero.status, 400);
    assert.match(zero.body.error, /R\$ 1,00/);
    // subtotal R$ 30 com 200 pontos: desconto R$ 20, total R$ 10
    const ok = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 200 }, c.cookie);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.subtotal_cents, 3000);
    assert.equal(ok.body.discount_cents, 2000);
    assert.equal(ok.body.points_redeemed, 200);
    assert.equal(ok.body.total_cents, 1000);
    const row = await orderRow(ok.body.id);
    assert.equal(row.discount_cents, 2000); assert.equal(row.points_redeemed, 200); assert.equal(row.customer_id, c.id);
    assert.equal(await balanceOf(c.id), 800, 'reserva já saiu do saldo');
    const [led] = await sql.query(`select kind, points from loyalty_ledger where order_id = $1`, [ok.body.id]);
    assert.deepEqual({ ...led }, { kind: 'redeem_reserve', points: -200 });
  });

  await test('O11: Mercado Pago recebe exatamente o total (desconto + frete) na preference e no Pix', async () => {
    const c = await mkCustomer('mp');
    await loyalty.adjust(sql, { customerId: c.id, points: 300, note: 'teste' });
    const real = globalThis.fetch; const sent = [];
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.mercadopago.com/')) {
        sent.push({ url: String(url), body: JSON.parse(init.body) });
        return String(url).endsWith('/v1/payments')
          ? { ok: true, status: 201, json: async () => ({ id: 5551, status: 'pending', point_of_interaction: { transaction_data: { qr_code: 'x'.repeat(30), qr_code_base64: 'y'.repeat(120) } } }) }
          : { ok: true, status: 201, json: async () => ({ id: 'pref-zz', init_point: 'https://mp.test/pref' }) };
      }
      return real(url, init);
    };
    try {
      const card = await call({ ...delivery('06000001'), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100, payment_choice: 'card' }, c.cookie);
      assert.equal(card.status, 201, JSON.stringify(card.body));
      assert.equal(card.body.total_cents, 3000 - 1000 + 600);
      const pref = sent.find(s => s.url.includes('/checkout/preferences')).body;
      const sum = pref.items.reduce((a, i) => a + Math.round(i.unit_price * 100) * i.quantity, 0);
      assert.equal(sum, card.body.total_cents);
      const pix = await call({ ...delivery('06000001'), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100, payment_choice: 'pix' }, c.cookie);
      assert.equal(pix.status, 201, JSON.stringify(pix.body));
      const pixBody = sent.find(s => s.url.endsWith('/v1/payments')).body;
      assert.equal(Math.round(pixBody.transaction_amount * 100), pix.body.total_cents);
      assert.equal(pixBody.external_reference, pix.body.code);
    } finally { globalThis.fetch = real; delete process.env.MERCADOPAGO_ACCESS_TOKEN; }
  });

  await test('O10/O11: após recuperar a conta, pontos ficam travados por 48 h (423) e o pedido sem pontos segue livre', async () => {
    const c = await mkCustomer('trava');
    await loyalty.adjust(sql, { customerId: c.id, points: 500, note: 'teste' });
    await customerLib.recover(sql, { phone: c.phone, answer: '  DONA   maría ', new_password: 'outra-senha-9' }, { ip: '198.51.100.7' });
    const [row] = await sql.query('select points_locked_until from customers where id = $1', [c.id]);
    const hours = (new Date(row.points_locked_until) - Date.now()) / 3600e3;
    assert.ok(hours > 47.9 && hours <= 48.01, 'trava de ' + hours + ' h');
    const re = await customerLib.login(sql, { phone: c.phone, password: 'outra-senha-9' }, { ip: '198.51.100.7' });
    const cookie = `${customerLib.COOKIE_NAME}=${re.token}`;
    const locked = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 }, cookie);
    assert.equal(locked.status, 423);
    assert.equal(locked.body.code, 'points_locked');
    assert.equal(await balanceOf(c.id), 500, 'nada foi reservado');
    assert.equal((await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }] }, cookie)).status, 201);
    await sql.query(`update customers set points_locked_until = now() - interval '1 minute' where id = $1`, [c.id]);
    const free = await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 }, cookie);
    assert.equal(free.status, 201, JSON.stringify(free.body));
  });

  await test('O11: crédito só com pagamento aprovado e valor conferido; repetir o webhook não credita de novo', async () => {
    const c = await mkCustomer('credito');
    const o = (await call({ ...delivery('06000001'), items: [{ product_id: prodBig.id, qty: 1 }] }, c.cookie)).body; // subtotal 3000 + frete 600
    assert.equal(await balanceOf(c.id), 0);
    // pendente e valor errado: sem crédito
    assert.equal((await payWebhook(o, 'in_process')).status, 200);
    assert.equal((await payWebhook(o, 'approved', { amountCents: o.total_cents - 100 })).status, 200);
    assert.equal(await balanceOf(c.id), 0);
    assert.equal((await orderRow(o.id)).payment_status, 'in_process', 'valor diferente não confirma o pagamento');
    // aprovado: 1 ponto por R$ 1,00 do subtotal (sem frete) = 30
    const pid = '700123456';
    assert.equal((await payWebhook(o, 'approved', { paymentId: pid })).status, 200);
    assert.equal(await balanceOf(c.id), 30);
    assert.equal((await orderRow(o.id)).payment_status, 'approved');
    for (let i = 0; i < 3; i++) await payWebhook(o, 'approved', { paymentId: pid });
    assert.equal(await balanceOf(c.id), 30, 'webhook repetido não credita de novo');
    const earn = await sql.query(`select count(*)::int n from loyalty_ledger where order_id = $1 and kind = 'earn'`, [o.id]);
    assert.equal(earn[0].n, 1);
    // estorno reverte
    assert.equal((await payWebhook(o, 'refunded', { paymentId: pid })).status, 200);
    assert.equal(await balanceOf(c.id), 0);
    await payWebhook(o, 'refunded', { paymentId: pid });
    assert.equal(await balanceOf(c.id), 0, 'estorno repetido não reverte de novo');
  });

  await test('O11: pontos ganhos usam subtotal depois do desconto, arredondado para baixo', async () => {
    const c = await mkCustomer('arredonda');
    await loyalty.adjust(sql, { customerId: c.id, points: 100, note: 'teste' });
    const o = (await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }, { product_id: prodOk.id, qty: 1 }], use_points: 100 }, c.cookie)).body; // 4000 - 1000
    assert.equal(o.total_cents, 3000);
    await payWebhook(o, 'approved');
    // reserva (-100) confirmada + 30 pontos ganhos
    assert.equal(await balanceOf(c.id), 30);
    assert.equal((await sql.query(`select kind from loyalty_ledger where order_id = $1 order by id`, [o.id])).map(r => r.kind).join(','), 'redeem_reserve,redeem_commit,earn');
  });

  await test('O11: pagamento rejeitado/cancelado devolve a reserva (uma vez só); aprovado depois de liberada é ajustado', async () => {
    const c = await mkCustomer('rejeitado');
    await loyalty.adjust(sql, { customerId: c.id, points: 200, note: 'teste' });
    const o = (await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 200 }, c.cookie)).body;
    assert.equal(await balanceOf(c.id), 0);
    await payWebhook(o, 'rejected');
    assert.equal(await balanceOf(c.id), 200);
    await payWebhook(o, 'rejected');
    await payWebhook(o, 'cancelled');
    assert.equal(await balanceOf(c.id), 200, 'liberar de novo não devolve em dobro');
    const o2 = (await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 200 }, c.cookie)).body;
    await payWebhook(o2, 'cancelled');
    assert.equal(await balanceOf(c.id), 200);
    // Pagamento aprovado chega depois de a reserva ter sido liberada: o resgate é confirmado e o saldo ajustado.
    await payWebhook(o2, 'approved');
    assert.equal(await balanceOf(c.id), 200 - 200 + 10, 'gastou 200, ganhou 10 (subtotal 3000 - 2000)');
  });

  await test('O11: reserva sem pagamento há mais de 24 h é liberada ao ler o saldo; cancelar libera a reserva', async () => {
    const c = await mkCustomer('vencida');
    await loyalty.adjust(sql, { customerId: c.id, points: 200, note: 'teste' });
    const o = (await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 200 }, c.cookie)).body;
    assert.equal(await balanceOf(c.id), 0);
    await sql.query(`update loyalty_ledger set created_at = now() - interval '25 hours' where order_id = $1 and kind = 'redeem_reserve'`, [o.id]);
    assert.equal(await balanceOf(c.id), 200);
    assert.equal(await balanceOf(c.id), 200, 'idempotente');
    const o2 = (await call({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 }, c.cookie)).body;
    assert.equal(await balanceOf(c.id), 100);
    assert.equal(await loyalty.releaseReserve(sql, o2.id, "pedido cancelado"), true);
    assert.equal(await balanceOf(c.id), 200);
    assert.equal(await loyalty.releaseReserve(sql, o2.id, "pedido cancelado"), false);
    assert.equal(await balanceOf(c.id), 200);
  });

  await test('O11: dois resgates ao mesmo tempo com saldo para um só: só um passa (reserva atômica)', async () => {
    const c = await mkCustomer('corrida');
    await loyalty.adjust(sql, { customerId: c.id, points: 100, note: 'teste' });
    const body = () => ({ ...fresh(), items: [{ product_id: prodBig.id, qty: 1 }], use_points: 100 });
    const rs = await Promise.all([call(body(), c.cookie), call(body(), c.cookie), call(body(), c.cookie)]);
    const ok = rs.filter(r => r.status === 201);
    assert.equal(ok.length, 1, rs.map(r => r.status).join(','));
    assert.ok(rs.filter(r => r.status !== 201).every(r => r.status === 409 && r.body.code === 'insufficient_points'));
    assert.equal(await balanceOf(c.id), 0);
    const left = await sql.query(`select count(*)::int n from orders where customer_id = $1`, [c.id]);
    assert.equal(left[0].n, 1, 'pedidos sem reserva são apagados');
  });

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    shipping.setFetch(null);
    if (snap) await restore(snap).catch(e => console.error('falha ao restaurar estado:', e.message));
    const n = await cleanup().catch(e => { console.error(e.message); return -1; });
    console.log(`pedidos de teste apagados: ${n}`);
    process.exit();
  });
