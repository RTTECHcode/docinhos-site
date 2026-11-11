// Teste do backend da rodada v3 (A2): endereço da conta (D1), pré-preenchimento (D2), CEP (D3), prévia de pontos (D4),
// complementos pausados (D5), pausa sem etiqueta (D6), categoria "Para família" (D7) e horários (D8, pelo painel).
// Uso: node -r ./scripts/dev-env.js scripts/test-v3-backend.js
// Banco de DESENVOLVIMENTO. Dados de teste: clientes "ZZ-v3 ...", catálogo "ZZ-v3 ...", CEPs 0699xxxx, IPs "198.18.x.x".
// Tudo é apagado no começo e no fim; horários, regras de pontos e estado da loja são restaurados. Sem rede: ViaCEP simulado.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sql = require('../api/_lib/db');
const customerHandler = require('../api/customer');
const storeHandler = require('../api/store');
const menuHandler = require('../api/menu');
const adminHandler = require('../api/admin');
const customerLib = require('../api/_lib/customer');
const shipping = require('../api/_lib/shipping');
const loyalty = require('../api/_lib/loyalty');
const storeHours = require('../api/_lib/store-hours');
const orderApi = require('../api/order')._internal;
const adminAuth = require('../api/_lib/auth');

const Q = (text, params = []) => sql.query(text, params);
const HOST = 'loja.teste';
const ORIGIN = `https://${HOST}`;
let ipN = 0;
const nextIp = () => `198.18.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
let phoneN = 0;
const newPhone = () => `1190007${String(Math.floor(Math.random() * 90) + 10)}${String(++phoneN).padStart(2, '0')}`.slice(0, 11);
const PASS = 'SenhaBoa-123', ANS = 'Dona Maria';
const POINT_KEYS = ['points_enabled', 'points_per_real', 'points_block_points', 'points_block_value_cents'];
const SNAP_KEYS = [...POINT_KEYS, 'store_origin_lat', 'store_origin_lon', 'shipping_bands']; // origem/faixas: a cotação de teste mexe nelas

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').slice(0, 4).join(' | ')); process.exitCode = 1; }
}

// ---------- chamadas aos handlers ----------
function runRes(handler, req, { jsonRes = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d, headers }); return this; },
      end(text) { let body = null; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: this.statusCode, body, headers }); }
    };
    void jsonRes;
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
function creq(method, action, { body, cookie, ip } = {}) {
  const headers = { host: HOST, 'x-forwarded-for': ip || nextIp(), 'x-real-ip': ip || nextIp(), 'user-agent': 'teste-v3' };
  if (method === 'POST') { headers.origin = ORIGIN; headers['content-type'] = 'application/json'; headers['sec-fetch-site'] = 'same-origin'; }
  if (cookie) headers.cookie = cookie;
  return { method, url: `/api/customer?a=${action}`, headers, body };
}
const cget = (action, o) => runRes(customerHandler, creq('GET', action, o));
const cpost = (action, body, o = {}) => runRes(customerHandler, creq('POST', action, { ...o, body }));
const cookieOf = r => { const sc = r.headers['set-cookie']; return sc ? String(sc).split(';')[0] : null; };
const register = (over = {}) => cpost('register', { name: 'ZZ-v3 Cliente', phone: newPhone(), password: PASS, security_question: 'prof_favorito', security_answer: ANS, consent_version: customerLib.CONSENT_VERSION, ...over });
const storeGet = (query, ip) => runRes(storeHandler, { method: 'GET', query, headers: { host: HOST, 'x-real-ip': ip || nextIp() } });
const menuCall = () => runRes(menuHandler, { method: 'GET', headers: {} });

const ADDR = { cep: '06000-001', street: 'Rua ZZ-v3 das Flores', number: '123', complement: 'apto 4', district: 'Centro', city: 'Osasco' };

// ---------- ViaCEP simulado ----------
const net = { calls: 0, urls: [] };
function fakeFetch(url) {
  const u = String(url); net.calls++; net.urls.push(u);
  if (u.startsWith('https://viacep.com.br/ws/')) {
    const cep = u.split('/')[4];
    if (cep === '06999999') return { ok: true, status: 200, json: async () => ({ erro: true }) };
    if (cep === '06999998') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ logradouro: 'Rua ZZ-v3 Teste', bairro: 'Centro', localidade: 'Osasco', uf: 'SP' }) };
  }
  if (u.startsWith('https://nominatim.openstreetmap.org/')) return { ok: true, status: 200, json: async () => [{ lat: '-23.51', lon: '-46.81', display_name: 'ZZ-v3 destino' }] };
  if (u.startsWith('https://router.project-osrm.org/')) return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 2500 }] }) };
  return { ok: false, status: 500, json: async () => ({}) };
}
const viacepCalls = () => net.urls.filter(u => u.startsWith('https://viacep.com.br/')).length;

// ---------- estado a restaurar ----------
let snap;
async function snapshot() {
  const keys = [...SNAP_KEYS];
  return {
    hours: await Q('select weekday, opens, closes from store_hours'),
    state: await Q('select * from store_state where id = 1'),
    settings: await Q('select key, value from settings where key = any($1::text[])', [keys])
  };
}
async function restore(s) {
  await Q('delete from store_hours');
  for (const h of s.hours) await Q('insert into store_hours (weekday, opens, closes) values ($1,$2,$3)', [h.weekday, h.opens, h.closes]);
  await Q('delete from store_state where id = 1');
  if (s.state[0]) await Q('insert into store_state (id, closed_until, closed_indefinitely, closed_message, updated_by, updated_at) values (1, $1, $2, $3, $4, coalesce($5, now()))', [s.state[0].closed_until, s.state[0].closed_indefinitely, s.state[0].closed_message, s.state[0].updated_by, s.state[0].updated_at]);
  await Q('delete from settings where key = any($1::text[])', [SNAP_KEYS]);
  for (const r of s.settings) await Q('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
}
async function cleanup() {
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like 'ZZ-v3%')`);
  await Q(`delete from customers where name like 'ZZ-v3%'`);
  await Q(`delete from customer_login_attempts where ip like '198.18.%' or phone like '+551190007%' or phone like '#senha:+551190007%'`);
  await Q(`delete from product_complements where product_id in (select id from products where name like 'ZZ-v3%')`);
  await Q(`delete from product_groups where product_id in (select id from products where name like 'ZZ-v3%')`);
  await Q(`delete from products where name like 'ZZ-v3%'`);
  await Q(`delete from complements where name like 'ZZ-v3%'`);
  await Q(`delete from categories where name like 'ZZ-v3%'`);
  await Q(`delete from cep_cache where cep like '0699%' or cep like '06000%'`);
  await Q(`delete from login_attempts where username like 'zz-v3-%'`);
  await Q(`delete from admin_audit where username like 'zz-v3-%'`);
  await Q(`delete from admin_users where username like 'zz-v3-%'`);
  await Q(`delete from rate_hits where ip like '198.18.%' or ip like 'v3teste-%' or (scope = 'cep_lookup_global' and ip = 'global')`);
  await Q(`delete from geocode_cache where addr_key like '%zz%v3%'`);
  await Q(`delete from route_cache where origin = '-23.50000,-46.80000'`);
}

(async () => {
  await cleanup();
  snap = await snapshot();
  shipping.setFetch(fakeFetch);
  // loja aberta o dia todo (D8: sem horário = fechada) e programa de pontos com a regra padrão
  await Q('delete from store_hours');
  await storeHours.saveHours(sql, [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '00:00', closes: '23:59' })));
  await Q('delete from store_state where id = 1');
  await loyalty.saveRules(sql, loyalty.DEFAULT_RULES);

  // catálogo de teste
  const [cat] = await Q(`insert into categories (name, sort_order, active) values ('ZZ-v3 categoria', 997, true) returning id`);
  const mkProd = async (name, cents) => (await Q('insert into products (category_id, name, description, price_cents, active) values ($1, $2, $3, $4, true) returning id', [cat.id, name, '', cents]))[0];
  const prod = await mkProd('ZZ-v3 Brigadeiro', 1000);
  const mkComp = async (name, cents, kind = 'additional') => (await Q('insert into complements (name, price_cents, kind, active) values ($1, $2, $3, true) returning id', [name, cents, kind]))[0];
  const compOk = await mkComp('ZZ-v3 Granola', 200), compPaused = await mkComp('ZZ-v3 Morango', 300);
  await Q('insert into product_complements (product_id, complement_id, max_quantity, paused) values ($1, $2, 2, false), ($1, $3, 2, true)', [prod.id, compOk.id, compPaused.id]);
  const prodPaused = (await Q(`insert into products (category_id, name, description, price_cents, active, paused, pause_label) values ($1, 'ZZ-v3 Pausado', '', 500, true, true, 'etiqueta antiga') returning id`, [cat.id]))[0];

  // ===== D1 / D2: endereço e pré-preenchimento =====
  console.log('\nD1: endereço da conta');
  let cookie, ownerPhone;
  await t('cadastro sem endereço continua valendo; address sem sessão = 401; GET/POST no método errado = 405', async () => {
    ownerPhone = newPhone();
    const r = await register({ phone: ownerPhone });
    assert.equal(r.status, 201, JSON.stringify(r.body)); cookie = cookieOf(r); assert.ok(cookie);
    assert.deepEqual((await cget('address', { cookie })).body, { address: null });
    for (const a of ['address']) assert.equal((await cget(a)).status, 401);
    for (const a of ['address_save', 'address_clear']) assert.equal((await cpost(a, ADDR)).status, 401, a);
    assert.equal((await cpost('address', {}, { cookie })).status, 405);
    assert.equal((await cget('address_save', { cookie })).status, 405);
    assert.equal((await cget('address', { cookie })).headers['cache-control'], 'no-store');
  });
  await t('cadastro com endereço: cliente e endereço no MESMO insert (nenhum update posterior); endereço inválido não cria conta nem deixa linha', async () => {
    const log = [];
    const spy = { query: (text, params) => { log.push(String(text)); return sql.query(text, params); } };
    const phone = newPhone();
    const out = await customerLib.createAccount(spy, { name: 'ZZ-v3 Atomico', phone, password: PASS, security_question: 'prof_favorito', security_answer: ANS, address: ADDR }, { ip: nextIp() });
    assert.ok(out.token);
    const inserts = log.filter(s => /insert into customers\b/i.test(s));
    assert.equal(inserts.length, 1); assert.match(inserts[0], /address_cep/);
    assert.ok(!log.some(s => /update customers set address_/i.test(s)), 'sem segundo comando para o endereço');
    const row = (await Q('select address_cep, address_street, address_number, address_city from customers where phone = $1', ['+55' + phone]))[0];
    assert.deepEqual(row, { address_cep: '06000001', address_street: 'Rua ZZ-v3 das Flores', address_number: '123', address_city: 'Osasco' });
    const phone2 = newPhone();
    const err = await customerLib.createAccount(spy, { name: 'ZZ-v3 Atomico2', phone: phone2, password: PASS, security_question: 'prof_favorito', security_answer: ANS, address: { ...ADDR, street: 'x' } }, { ip: nextIp() }).catch(e => e);
    assert.equal(err.status, 400); assert.equal(err.code, 'invalid_address');
    assert.equal((await Q('select count(*)::int n from customers where phone = $1', ['+55' + phone2]))[0].n, 0);
  });
  await t('address_save: grava (CEP vira 8 dígitos, espaços limpos), lê de volta, troca e limpa; aceita { address: {...} } e campos soltos', async () => {
    const r = await cpost('address_save', { address: { ...ADDR, street: '  Rua ZZ-v3   das Flores ' } }, { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.address, { cep: '06000001', street: 'Rua ZZ-v3 das Flores', number: '123', complement: 'apto 4', district: 'Centro', city: 'Osasco' });
    assert.deepEqual((await cget('address', { cookie })).body.address, r.body.address);
    const r2 = await cpost('address_save', { cep: '06000002', street: 'Avenida ZZ-v3', number: '9S/N' }, { cookie });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(r2.body.address, { cep: '06000002', street: 'Avenida ZZ-v3', number: '9S/N', complement: '', district: '', city: '' });
    const c = await cpost('address_clear', {}, { cookie });
    assert.deepEqual([c.status, c.body.address], [200, null]);
    assert.equal((await cget('address', { cookie })).body.address, null);
    const row = (await Q(`select address_cep, address_street from customers where phone = $1`, ['+55' + ownerPhone]))[0];
    assert.deepEqual([row.address_cep, row.address_street], [null, null]);
  });
  await t('validação no servidor: CEP de 8 dígitos, rua 3-120, número 1-10, complemento até 60, bairro/cidade até 80, sem controle; nada é gravado no erro', async () => {
    const bad = [
      ['cep curto', { ...ADDR, cep: '0600' }, 'invalid_cep'], ['cep com letras', { ...ADDR, cep: 'abcdefgh' }, 'invalid_cep'], ['sem cep', { ...ADDR, cep: '' }, 'invalid_cep'],
      ['rua curta', { ...ADDR, street: 'ab' }, 'invalid_address'], ['rua longa', { ...ADDR, street: 'x'.repeat(121) }, 'invalid_address'], ['sem rua', { ...ADDR, street: '' }, 'invalid_address'],
      ['sem número', { ...ADDR, number: '' }, 'invalid_address'], ['número longo', { ...ADDR, number: '1'.repeat(11) }, 'invalid_address'],
      ['complemento longo', { ...ADDR, complement: 'x'.repeat(61) }, 'invalid_address'], ['bairro longo', { ...ADDR, district: 'x'.repeat(81) }, 'invalid_address'],
      ['cidade longa', { ...ADDR, city: 'x'.repeat(81) }, 'invalid_address'], ['rua não texto', { ...ADDR, street: 12345 }, 'invalid_address'],
      ['controle na rua', { ...ADDR, street: 'Rua\u0000Boa' }, 'invalid_address'], ['tudo vazio', { cep: '', street: '', number: '' }, 'invalid_address']
    ];
    for (const [nome, body, code] of bad) {
      const r = await cpost('address_save', body, { cookie });
      assert.equal(r.status, 400, `${nome}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, code, nome);
    }
    // limites exatos passam
    const ok = await cpost('address_save', { cep: '06000003', street: 'x'.repeat(120), number: '1'.repeat(10), complement: 'y'.repeat(60), district: 'z'.repeat(80), city: 'w'.repeat(80) }, { cookie });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await cpost('address_clear', {}, { cookie });
    assert.equal((await cget('address', { cookie })).body.address, null, 'erro não grava nada');
  });
  await t('cadastro com endereço opcional: grava junto; endereço inválido recusa o cadastro (400) sem criar a conta', async () => {
    const phone = newPhone();
    const r = await register({ phone, address: ADDR });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c2 = cookieOf(r);
    assert.equal((await cget('address', { cookie: c2 })).body.address.cep, '06000001');
    const phone2 = newPhone();
    const bad = await register({ phone: phone2, address: { ...ADDR, cep: '12' } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body)); assert.equal(bad.body.code, 'invalid_cep');
    assert.equal((await Q('select count(*)::int n from customers where phone = $1', ['+55' + phone2]))[0].n, 0, 'conta não foi criada');
    const blank = await register({ phone: newPhone(), address: { cep: '', street: '', number: '' } });
    assert.equal(blank.status, 201, 'endereço todo em branco = sem endereço'); assert.equal((await cget('address', { cookie: cookieOf(blank) })).body.address, null);
  });
  await t('só o dono vê e altera: cada sessão enxerga apenas o próprio endereço', async () => {
    await cpost('address_save', ADDR, { cookie });
    const other = await register({ address: { ...ADDR, street: 'Rua ZZ-v3 do Outro', number: '77' } });
    const cOther = cookieOf(other);
    assert.equal((await cget('address', { cookie: cOther })).body.address.street, 'Rua ZZ-v3 do Outro');
    assert.equal((await cget('address', { cookie })).body.address.street, 'Rua ZZ-v3 das Flores');
    // o corpo não escolhe a conta: customer_id/id no corpo são ignorados
    await cpost('address_save', { ...ADDR, street: 'Rua ZZ-v3 Alterada', customer_id: 1, id: 1 }, { cookie: cOther });
    assert.equal((await cget('address', { cookie })).body.address.street, 'Rua ZZ-v3 das Flores');
  });

  console.log('\nD2: pré-preenchimento do checkout');
  await t('prefill: visitante recebe só logged_in:false; logado recebe nome, telefone e endereço da própria conta; no-store', async () => {
    const v = await cget('prefill');
    assert.deepEqual(v.body, { logged_in: false }); assert.equal(v.headers['cache-control'], 'no-store');
    const r = await cget('prefill', { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.logged_in, true); assert.equal(r.body.name, 'ZZ-v3 Cliente');
    assert.equal(r.body.phone_national, ownerPhone); assert.ok(String(r.body.phone).endsWith(ownerPhone));
    assert.equal(r.body.address.cep, '06000001'); assert.equal(r.body.address.street, 'Rua ZZ-v3 das Flores');
    assert.equal(r.headers['cache-control'], 'no-store');
    for (const k of Object.keys(r.body)) assert.ok(['logged_in', 'name', 'phone', 'phone_national', 'address'].includes(k), `campo inesperado ${k}`);
    assert.equal((await cpost('prefill', {}, { cookie })).status, 405);
  });
  await t('prefill de conta sem endereço devolve address:null', async () => {
    const r = await cget('prefill', { cookie: cookieOf(await register()) });
    assert.equal(r.body.logged_in, true); assert.equal(r.body.address, null);
  });

  // ===== D3: CEP =====
  console.log('\nD3: CEP para endereço');
  await t('lookupCep: ViaCEP simulado, devolve { cep, street, district, city, uf }; 2ª consulta vem do cache sem rede', async () => {
    net.calls = 0;
    const a = await shipping.lookupCep(sql, '06000-010');
    assert.deepEqual(a, { cep: '06000010', street: 'Rua ZZ-v3 Teste', district: 'Centro', city: 'Osasco', uf: 'SP' });
    assert.equal(net.calls, 1);
    const b = await shipping.lookupCep(sql, '06000010');
    assert.deepEqual(b, a); assert.equal(net.calls, 1, 'cache em banco: sem nova chamada');
    assert.equal((await Q(`select count(*)::int n from cep_cache where cep = '06000010'`))[0].n, 1);
    // cache vencido (> 90 dias) consulta de novo
    await Q(`update cep_cache set created_at = now() - interval '91 days' where cep = '06000010'`);
    await shipping.lookupCep(sql, '06000010'); assert.equal(net.calls, 2);
  });
  await t('GET /api/store?a=cep: 200 com no-store; CEP inexistente = 404 cep_not_found; inválido = 400 invalid_cep; ViaCEP fora = 503', async () => {
    const ok = await storeGet({ a: 'cep', cep: '06000011' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.city, 'Osasco'); assert.equal(ok.headers['cache-control'], 'no-store');
    const nf = await storeGet({ a: 'cep', cep: '06999999' });
    assert.equal(nf.status, 404); assert.equal(nf.body.code, 'cep_not_found');
    assert.equal((await Q(`select count(*)::int n from cep_cache where cep = '06999999'`))[0].n, 1, 'CEP inexistente fica em cache (marcador, 1 dia)');
    for (const cep of ['123', 'abcdefgh', '', undefined]) { const r = await storeGet({ a: 'cep', cep }); assert.equal(r.status, 400, String(cep)); assert.equal(r.body.code, 'invalid_cep'); }
    const down = await storeGet({ a: 'cep', cep: '06999998' });
    assert.equal(down.status, 503); assert.equal(down.body.code, 'cep_unavailable');
  });
  await t('limite por IP no escopo cep_lookup: 30 consultas em 10 min, a 31ª = 429 rate_limited; outro IP não é afetado; não gasta o limite da cotação', async () => {
    assert.equal(storeHandler._internal.CEP_MAX_PER_IP, 30);
    const ip = 'v3teste-cep-1';
    for (let i = 0; i < 30; i++) assert.equal((await storeGet({ a: 'cep', cep: '06000011' }, ip)).status, 200, `consulta ${i + 1}`);
    const r = await storeGet({ a: 'cep', cep: '06000011' }, ip);
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal((await storeGet({ a: 'cep', cep: '06000011' }, 'v3teste-cep-2')).status, 200);
    assert.equal((await Q(`select count(*)::int n from rate_hits where scope = 'shipping_quote' and ip = $1`, [ip]))[0].n, 0);
    assert.ok((await Q(`select count(*)::int n from rate_hits where scope = 'cep_lookup' and ip = $1`, [ip]))[0].n >= 1);
  });

  await t('CEP inexistente: 1ª consulta vai ao ViaCEP, a 2ª (404) sai do cache sem rede; passou de 1 dia consulta de novo; CEP encontrado não é afetado', async () => {
    await Q(`delete from cep_cache where cep in ('06999999', '06000012')`);
    net.urls = [];
    for (let i = 0; i < 3; i++) { const r = await shipping.lookupCep(sql, '06999999').catch(e => e); assert.equal(r.status, 404); assert.equal(r.code, 'cep_not_found'); }
    assert.equal(viacepCalls(), 1, 'só a 1ª consulta vai ao ViaCEP');
    const row = (await Q(`select localidade, uf from cep_cache where cep = '06999999'`))[0];
    assert.deepEqual([row.localidade, row.uf], ['', '']);
    await Q(`update cep_cache set created_at = now() - interval '23 hours' where cep = '06999999'`);
    await shipping.lookupCep(sql, '06999999').catch(() => {}); assert.equal(viacepCalls(), 1, 'com 23 h ainda vale');
    await Q(`update cep_cache set created_at = now() - interval '25 hours' where cep = '06999999'`);
    await shipping.lookupCep(sql, '06999999').catch(() => {}); assert.equal(viacepCalls(), 2, 'com 25 h expirou');
    assert.equal(shipping.CEP_NOT_FOUND_DAYS, 1);
    // CEP encontrado com 2 dias continua valendo (90 dias)
    await shipping.lookupCep(sql, '06000012'); await Q(`update cep_cache set created_at = now() - interval '2 days' where cep = '06000012'`);
    const n = viacepCalls(); await shipping.lookupCep(sql, '06000012'); assert.equal(viacepCalls(), n);
    // falha do ViaCEP (503) não é guardada
    await Q(`delete from cep_cache where cep = '06999998'`);
    await shipping.lookupCep(sql, '06999998').catch(() => {});
    assert.equal((await Q(`select count(*)::int n from cep_cache where cep = '06999998'`))[0].n, 0);
  });
  await t('teto global do ViaCEP (cep_lookup_global, 60/min): só conta chamada externa; cache hit passa; estourou = 503 cep_unavailable; outro IP também barrado', async () => {
    assert.equal(shipping.CEP_GLOBAL_MAX_PER_MINUTE, 60);
    await Q(`delete from rate_hits where scope = 'cep_lookup_global' and ip = 'global'`);
    await shipping.lookupCep(sql, '06000030'); // entra no cache
    const countHits = async () => Number((await Q(`select coalesce(sum(n), 0)::int n from rate_hits where scope = 'cep_lookup_global' and ip = 'global'`))[0].n);
    const base = await countHits();
    assert.equal(base, 1, 'a chamada externa contou 1');
    for (let i = 0; i < 3; i++) await shipping.lookupCep(sql, '06000030');
    assert.equal(await countHits(), base, 'cache hit não conta no teto');
    // leva o teto a 59 e confere: a 60ª passa, a 61ª chamada externa é barrada e NÃO chama o ViaCEP
    await Q(`insert into rate_hits (scope, ip, minute, n) values ('cep_lookup_global', 'global', date_trunc('minute', now()), 58)
             on conflict (scope, ip, minute) do update set n = rate_hits.n + 58`);
    net.urls = [];
    await shipping.lookupCep(sql, '06000031'); // 60ª: ainda passa
    assert.equal(viacepCalls(), 1);
    const r = await storeGet({ a: 'cep', cep: '06000032' }, 'v3teste-cepg-1'); // 61ª: barrada
    assert.equal(r.status, 503); assert.equal(r.body.code, 'cep_unavailable');
    assert.equal(viacepCalls(), 1, 'barrada antes do fetch externo');
    assert.ok(!/limite|teto|global/i.test(r.body.error), 'mensagem genérica');
    assert.equal((await storeGet({ a: 'cep', cep: '06000032' }, 'v3teste-cepg-2')).status, 503, 'vale para todos os IPs');
    assert.equal((await storeGet({ a: 'cep', cep: '06000030' }, 'v3teste-cepg-3')).status, 200, 'CEP em cache continua respondendo');
    assert.equal((await storeGet({ a: 'cep', cep: '06000031' }, 'v3teste-cepg-4')).status, 200);
    assert.equal((await Q(`select count(*)::int n from cep_cache where cep = '06000032'`))[0].n, 0);
    await Q(`delete from rate_hits where scope = 'cep_lookup_global' and ip = 'global'`);
    assert.equal((await storeGet({ a: 'cep', cep: '06000032' }, 'v3teste-cepg-5')).status, 200, 'passada a janela, volta a consultar');
  });
  await t('quoteDelivery usa o cep_cache: 2ª cotação do mesmo CEP não chama o ViaCEP e dá o mesmo resultado; CEP inexistente (422) também fica em cache; teto global não barra a cotação', async () => {
    await shipping.setOrigin(sql, -23.5, -46.8);
    await Q(`delete from settings where key = 'shipping_bands'`);
    await Q(`delete from cep_cache where cep in ('06000040', '06999999')`);
    await Q(`delete from rate_hits where scope = 'cep_lookup_global' and ip = 'global'`);
    net.urls = [];
    const q1 = await shipping.quoteDelivery(sql, { cep: '06000-040', address: 'Rua ZZ-v3 Teste, 100' });
    assert.equal(viacepCalls(), 1);
    assert.equal((await Q(`select count(*)::int n from cep_cache where cep = '06000040'`))[0].n, 1, 'cotação grava no cep_cache');
    const q2 = await shipping.quoteDelivery(sql, { cep: '06000040', address: 'Rua ZZ-v3 Teste, 100' });
    assert.equal(viacepCalls(), 1, 'cache: sem nova chamada ao ViaCEP');
    assert.deepEqual(q2, q1);
    assert.equal(q1.km, 2.5); assert.equal(q1.fee_cents, 600); // OSRM simulado: 2,5 km = 1ª faixa padrão
    // CEP inexistente: 422 cep_not_found na 1ª e na 2ª (esta sem rede)
    net.urls = [];
    for (let i = 0; i < 2; i++) { const e = await shipping.quoteDelivery(sql, { cep: '06999999', address: 'Rua ZZ-v3 Teste, 1' }).catch(x => x); assert.equal(e.status, 422); assert.equal(e.code, 'cep_not_found'); }
    assert.equal(viacepCalls(), 1);
    // teto global estourado: a cotação (que alimenta o pedido) não é barrada, só a consulta de CEP
    await Q(`insert into rate_hits (scope, ip, minute, n) values ('cep_lookup_global', 'global', date_trunc('minute', now()), 500)
             on conflict (scope, ip, minute) do update set n = 500`);
    const q3 = await shipping.quoteDelivery(sql, { cep: '06000041', address: 'Rua ZZ-v3 Teste, 100' });
    assert.equal(q3.fee_cents, 600);
    await Q(`delete from rate_hits where scope = 'cep_lookup_global' and ip = 'global'`);
  });

  // ===== D4: prévia de pontos =====
  console.log('\nD4: prévia de pontos');
  await t('points_preview: visitante e logado recebem { points, enabled, rules, subtotal_cents }; preço vem do servidor (preço do cliente é ignorado)', async () => {
    const body = { items: [{ product_id: prod.id, qty: 2, price_cents: 1 }] }; // R$ 20,00 -> 20 pontos (1 por real)
    const v = await cpost('points_preview', body);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.deepEqual([v.body.points, v.body.enabled, v.body.subtotal_cents], [20, true, 2000]);
    assert.deepEqual(v.body.rules, loyalty.DEFAULT_RULES);
    const l = await cpost('points_preview', body, { cookie });
    assert.deepEqual(l.body, v.body, 'logado e visitante recebem o mesmo cálculo');
    assert.equal(v.headers['cache-control'], 'no-store');
    // mesmo número que o pedido usaria: earnPoints do subtotal da precificação do pedido
    const priced = orderApi.priceItems(body.items, await orderApi.loadCatalog(sql, [prod.id]));
    assert.equal(v.body.points, loyalty.earnPoints(priced.subtotal_cents, 0, await loyalty.getRules(sql)));
  });
  await t('points_preview: adicionais entram no subtotal; regra com 2 pontos por real; use_points abate o desconto (bloco de 100 pontos = R$ 10 por padrão)', async () => {
    const p = await cpost('points_preview', { items: [{ product_id: prod.id, qty: 1, extras: [{ id: compOk.id, qty: 2 }] }] });
    assert.deepEqual([p.body.subtotal_cents, p.body.points], [1400, 14]);
    await loyalty.saveRules(sql, { ...loyalty.DEFAULT_RULES, points_per_real: 2 });
    assert.equal((await cpost('points_preview', { items: [{ product_id: prod.id, qty: 3 }] })).body.points, 60);
    await loyalty.saveRules(sql, loyalty.DEFAULT_RULES);
    const rules = await loyalty.getRules(sql);
    const big = { items: [{ product_id: prod.id, qty: 20 }], use_points: rules.block_points }; // R$ 200,00
    const withUse = await cpost('points_preview', big), without = await cpost('points_preview', { items: big.items });
    assert.ok(withUse.body.points < without.body.points, 'resgatar pontos reduz o que se ganha');
    assert.equal(withUse.body.points, loyalty.earnPoints(20000, loyalty.discountForPoints(rules.block_points, rules), rules));
    assert.equal((await cpost('points_preview', { items: big.items, use_points: 'x' })).body.points, without.body.points, 'use_points inválido é ignorado');
  });
  await t('points_preview: programa desligado = 0 pontos, enabled:false; carrinho inválido/vazio/pausado = 400 invalid_items', async () => {
    await loyalty.saveRules(sql, { ...loyalty.DEFAULT_RULES, enabled: false });
    const off = await cpost('points_preview', { items: [{ product_id: prod.id, qty: 1 }] });
    assert.equal(off.status, 200); assert.deepEqual([off.body.points, off.body.enabled], [0, false]);
    await loyalty.saveRules(sql, loyalty.DEFAULT_RULES);
    for (const items of [[], undefined, 'x', [{ product_id: 999999999, qty: 1 }], [{ product_id: prod.id, qty: 0 }], [{ product_id: prodPaused.id, qty: 1 }], [null], new Array(60).fill({ product_id: prod.id, qty: 1 })]) {
      const r = await cpost('points_preview', { items }); assert.equal(r.status, 400, JSON.stringify(items)?.slice(0, 60)); assert.equal(r.body.code, 'invalid_items');
    }
    assert.equal((await cget('points_preview')).status, 405);
  });
  await t('points_preview: vazio = "O carrinho está vazio."; mais de 30 itens = mensagem própria "itens demais" (não "vazio"); 30 itens passa', async () => {
    assert.equal(orderApi.MAX_ITEMS, 30);
    const empty = await cpost('points_preview', { items: [] });
    assert.equal(empty.status, 400); assert.equal(empty.body.error, 'O carrinho está vazio.'); assert.equal(empty.body.code, 'invalid_items');
    const many = await cpost('points_preview', { items: new Array(31).fill({ product_id: prod.id, qty: 1 }) });
    assert.equal(many.status, 400); assert.equal(many.body.code, 'invalid_items');
    assert.match(many.body.error, /itens demais/); assert.ok(!/vazio/.test(many.body.error)); assert.match(many.body.error, /30/);
    const max = await cpost('points_preview', { items: new Array(30).fill({ product_id: prod.id, qty: 1 }) });
    assert.equal(max.status, 200, JSON.stringify(max.body)); assert.equal(max.body.subtotal_cents, 30000);
  });
  await t('points_preview: limite por IP (escopo points_preview, 120 em 10 min) = 429 rate_limited; outro IP não é afetado; não usa o escopo da cotação', async () => {
    assert.equal(customerHandler._internal.PREVIEW_MAX_PER_IP, 120);
    const ip = 'v3teste-pp-1', body = { items: [{ product_id: prod.id, qty: 1 }] };
    await Q(`insert into rate_hits (scope, ip, minute, n) values ('points_preview', $1, date_trunc('minute', now()), 118)`, [ip]);
    assert.equal((await cpost('points_preview', body, { ip })).status, 200); // 119
    assert.equal((await cpost('points_preview', body, { ip })).status, 200); // 120
    const r = await cpost('points_preview', body, { ip }); // 121
    assert.equal(r.status, 429, JSON.stringify(r.body)); assert.equal(r.body.code, 'rate_limited');
    assert.equal((await cpost('points_preview', body, { ip: 'v3teste-pp-2' })).status, 200);
    assert.equal((await Q(`select count(*)::int n from rate_hits where scope = 'shipping_quote' and ip = $1`, [ip]))[0].n, 0);
  });

  // ===== D5: complementos pausados =====
  console.log('\nD5: complemento pausado no cardápio');
  await t('cardápio devolve o complemento pausado com unavailable:true (o disponível não tem a marca)', async () => {
    const m = await menuCall();
    const p = m.body.categories.flatMap(c => c.products).find(x => x.id === prod.id);
    const paused = p.complements.find(c => c.id === compPaused.id), ok = p.complements.find(c => c.id === compOk.id);
    assert.ok(paused, 'complemento pausado aparece'); assert.equal(paused.unavailable, true);
    assert.ok(ok); assert.ok(!('unavailable' in ok));
  });
  await t('o pedido continua recusando o complemento pausado (precificação do servidor); o disponível passa', async () => {
    const cat2 = await orderApi.loadCatalog(sql, [prod.id]);
    assert.throws(() => orderApi.priceItems([{ product_id: prod.id, qty: 1, extras: [{ id: compPaused.id, qty: 1 }] }], cat2), e => e instanceof orderApi.ValidationError && /adicional inv/.test(e.message));
    assert.equal(orderApi.priceItems([{ product_id: prod.id, qty: 1, extras: [{ id: compOk.id, qty: 1 }] }], cat2).subtotal_cents, 1200);
    const r = await cpost('points_preview', { items: [{ product_id: prod.id, qty: 1, extras: [{ id: compPaused.id, qty: 1 }] }] });
    assert.equal(r.status, 400);
  });

  // ===== D6: pausa sem etiqueta =====
  console.log('\nD6: etiqueta de pausa fixa');
  await t('cardápio: produto pausado = { unavailable, paused } sem label; settings sem defaultPauseLabel (mesmo com pause_label legado no banco)', async () => {
    const m = await menuCall();
    const p = m.body.categories.flatMap(c => c.products).find(x => x.id === prodPaused.id);
    assert.equal(p.unavailable, true); assert.equal(p.paused, true); assert.ok(!('label' in p));
    assert.ok(!('defaultPauseLabel' in m.body.settings) && !('default_pause_label' in m.body.settings));
    assert.ok(!JSON.stringify(m.body).includes('etiqueta antiga'));
    assert.throws(() => orderApi.priceItems([{ product_id: prodPaused.id, qty: 1 }], { products: new Map() }), () => true); // sem catálogo = recusa
  });
  await t('o código não lê nem grava pause_label/default_pause_label (as ações do painel têm teste próprio em test-admin-painel)', async () => {
    const fs = require('node:fs');
    for (const f of ['../api/admin.js', '../api/menu.js', '../api/order.js']) {
      const src = fs.readFileSync(require.resolve(f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      assert.ok(!/pause_label/.test(src.replace(/\/\/.*$/gm, '')), `${f} ainda cita pause_label`);
    }
  });

  // ===== D7: categoria =====
  console.log('\nD7: categoria "Para família"');
  await t('migração idempotente: roda 2 vezes sem erro; não sobra "Sobremesas tamanho família"; catalog.js e seed.js usam o novo nome', async () => {
    const run = () => execFileSync(process.execPath, ['-r', './scripts/dev-env.js', 'scripts/migrate-2026-11-10-v3-categoria-familia.js'], { encoding: 'utf8', cwd: require('node:path').join(__dirname, '..') });
    run(); const out = run();
    assert.match(out, /Nada a fazer/);
    assert.equal((await Q(`select count(*)::int n from categories where name = 'Sobremesas tamanho família'`))[0].n, 0);
    const fs = require('node:fs');
    for (const f of ['catalog.js', 'seed.js']) { const s = fs.readFileSync(require('node:path').join(__dirname, f), 'utf8'); assert.ok(s.includes('Para família')); assert.ok(!s.includes("'Sobremesas tamanho família'") || /update categories/.test(s), f); }
  });

  // ===== D8: horários pelo painel =====
  console.log('\nD8: horários (painel)');
  const adminUser = 'zz-v3-' + Math.floor(Math.random() * 1e9);
  const adminPass = 'Sx-' + Math.floor(Math.random() * 1e12);
  const [adm] = await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at) values ($1, $2, 'admin', false, 'prof_favorito', $3, now()) returning id`, [adminUser, await adminAuth.hashPassword(adminPass), await adminAuth.hashAnswer('resposta combinada')]);
  const acall = async (action, { method = 'GET', body, cookie, ip } = {}) => {
    const headers = { host: HOST, 'x-forwarded-for': ip || nextIp(), 'user-agent': 'teste-v3' };
    if (method === 'POST') { headers.origin = ORIGIN; headers['content-type'] = 'application/json'; }
    if (cookie) headers.cookie = cookie;
    const req = { method, url: '/api/admin?a=' + action, headers, body: body === undefined ? {} : body, socket: { remoteAddress: '127.0.0.1' } };
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(c) { this.body = c === undefined ? '' : c; } };
    await adminHandler(req, res);
    let json = null; try { json = JSON.parse(res.body); } catch { /* sem corpo */ }
    return { status: res.statusCode, json, headers: res.headers };
  };
  const lg = await acall('login', { method: 'POST', body: { username: adminUser, password: adminPass } });
  const AC = lg.headers['set-cookie'] ? String(lg.headers['set-cookie']).split(';')[0] : null;
  await t('hours_warning no painel: lista vazia salva como "no_hours" e a loja fecha; horário cadastrado limpa o aviso; fechamento manual vence a agenda', async () => {
    assert.ok(AC, 'login do admin de teste: ' + lg.status);
    const e = await acall('store_hours_save', { method: 'POST', cookie: AC, body: { hours: [] } });
    assert.equal(e.status, 200, JSON.stringify(e.json)); assert.equal(e.json.hours_warning, 'no_hours');
    assert.equal((await acall('store_hours', { cookie: AC })).json.hours_warning, 'no_hours');
    const st = await acall('store_state', { cookie: AC });
    assert.equal(st.json.hours_warning, 'no_hours'); assert.equal(st.json.state.open, false);
    assert.equal((await menuCall()).body.store.open, false);
    const ok = await acall('store_hours_save', { method: 'POST', cookie: AC, body: { hours: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '00:00', closes: '23:59' })) } });
    assert.equal(ok.json.hours_warning, null);
    assert.equal((await acall('store_state', { cookie: AC })).json.hours_warning, null);
    assert.equal((await menuCall()).body.store.open, true);
    const close = await acall('store_close', { method: 'POST', cookie: AC, body: { indefinite: true } });
    assert.equal(close.status, 200); assert.equal(close.json.state.open, false); assert.equal(close.json.state.reason, 'manual');
    assert.equal((await menuCall()).body.store.open, false, 'fechado à mão vence o horário aberto');
    await acall('store_reopen', { method: 'POST', cookie: AC, body: {} });
  });
  await Q('delete from admin_users where id = $1', [adm.id]); // sessões e tentativas saem em cascata ou ficam inertes

  await restore(snap);
  await cleanup();
  console.log(`\n${passed} testes passaram${process.exitCode ? ' (HÁ FALHAS)' : ''}`);
})().catch(async e => {
  console.error('ERRO', e && e.stack || e);
  try { if (snap) await restore(snap); await cleanup(); } catch {}
  process.exit(1);
});
