// Testes v4 (A2) de N10 (encomenda com data marcada) e N11 (selo "Mais pedido" e prazo de entrega) contra o banco de DESENVOLVIMENTO.
// Uso: node -r ./scripts/dev-env.js scripts/test-v4-agenda.js
//  - Produtos, categoria e pedidos "ZZ-v4-a2" criados aqui e apagados no final. Usuários do painel "zz-v4-a2-ag-*" inseridos
//    direto no banco (senha aleatória) e apagados no final, com tentativas e auditoria.
//  - Ajustes scheduling_*, best_seller_enabled e delivery_eta_* e o fechamento manual (store_state) são copiados no começo e
//    restaurados no final. O horário semanal (store_hours) NÃO é alterado: as regras de horário são testadas com a função pura.
//  - Sem Mercado Pago (token removido do processo): os pedidos ficam "pending". Nenhuma chamada externa.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
delete process.env.MERCADOPAGO_ACCESS_TOKEN;
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const sql = require('../api/_lib/db');
const orderHandler = require('../api/order');
const statusHandler = require('../api/order-status');
const storeHandler = require('../api/store');
const menuHandler = require('../api/menu');
const adminHandler = require('../api/admin');
const auth = require('../api/_lib/auth');
const hours = require('../api/_lib/store-hours');
const sched = require('../api/_lib/scheduling');
const showcase = require('../api/_lib/showcase');

const P = 'ZZ-v4-a2';
const U = 'zz-v4-a2-ag-';
const CAT = `${P} Agenda Categoria`;
const Q = (t, p = []) => sql.query(t, p);
const HOST = 'loja.test.local';
let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}.ag${crypto.randomBytes(2).toString('hex')}`; // TEST-NET-2: apagado no final
const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const phone = () => '119' + rnd(8);
const pass = () => 'Zz-' + crypto.randomBytes(12).toString('base64url');
const pad = n => String(n).padStart(2, '0');

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
const site = () => ({ host: HOST, origin: 'https://' + HOST, 'content-type': 'application/json', 'x-real-ip': ip() });
const order = body => runJson(orderHandler, { method: 'POST', body, headers: site() });
const track = token => runJson(statusHandler, { method: 'GET', query: { t: token }, headers: { 'x-real-ip': ip() } });
const slots = (date, mode = 'pickup', fixedIp) => runJson(storeHandler, { method: 'GET', query: { a: 'slots', date, mode }, headers: { 'x-real-ip': fixedIp || ip() } });
const menu = () => runJson(menuHandler, { method: 'GET', headers: {} });

async function acall(action, { method = 'GET', body, cookie, query = '' } = {}) {
  const headers = { host: HOST, 'x-real-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}`, 'user-agent': 'test-v4-agenda' };
  if (method === 'POST') { headers.origin = 'https://' + HOST; headers['content-type'] = 'application/json'; }
  if (cookie) headers.cookie = cookie;
  const req = { method, url: `/api/admin?a=${action}${query}`, headers, body: body === undefined ? {} : body, socket: { remoteAddress: '127.0.0.1' } };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(c) { this.body = c === undefined ? '' : c; } };
  await adminHandler(req, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* vazio */ }
  return { status: res.statusCode, json, headers: res.headers };
}
const cookieOf = r => (r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0] : null);
async function adminUser(suffix, role, password) {
  const name = U + suffix;
  await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at)
    values ($1, $2, $3, false, 'prof_favorito', $4, now())`, [name, await auth.hashPassword(password), role, await auth.hashAnswer('zz resposta v4')]);
  return name;
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', String(e.message).split('\n')[0].slice(0, 300)); process.exitCode = 1; }
}

// Dia de calendário em São Paulo, deslocado em `offset` dias: 'AAAA-MM-DD'.
function spDate(offset = 0) {
  const p = hours.zoneParts(new Date());
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// O mesmo instante escrito na hora de São Paulo com -03:00 (o servidor aceita qualquer ISO com fuso).
function spIso(isoUtc) {
  const p = hours.zoneParts(new Date(isoUtc));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00-03:00`;
}

// ---------- dados e restauração ----------
const SETTING_KEYS = [...Object.values(sched.KEYS), ...Object.values(showcase.KEYS)];
let settingsSnap = null, stateSnap; // stateSnap: undefined = ainda não lido, null = linha não existia
async function cleanup() {
  const ids = (await Q(`select id from orders where customer_name like $1`, [P + '%'])).map(r => r.id);
  await Q(`delete from loyalty_ledger where order_id = any($1::int[])`, [ids]);
  await Q(`delete from orders where id = any($1::int[])`, [ids]);
  await Q(`delete from rate_hits where ip like '198.51.100.%'`);
  await Q(`delete from order_attempts where ip like '198.51.100.%'`);
  await Q(`delete from products where name like $1`, [P + '%']);
  await Q(`delete from categories where name = $1`, [CAT]);
  await Q(`delete from login_attempts where username like $1`, [U + '%']);
  await Q(`delete from admin_audit where username like $1`, [U + '%']);
  await Q(`delete from admin_users where username like $1`, [U + '%']);
}
async function restore() {
  if (settingsSnap) {
    await Q('delete from settings where key = any($1::text[])', [SETTING_KEYS]);
    for (const r of settingsSnap) await Q('insert into settings (key, value) values ($1, $2)', [r.key, r.value]);
  }
  if (stateSnap === null) await Q('delete from store_state where id = 1'); // não existia: volta a não existir
  else if (stateSnap) {
    await Q(`update store_state set closed_until = $1, closed_indefinitely = $2, closed_message = $3, updated_by = $4, updated_at = $5 where id = 1`,
      [stateSnap.closed_until, stateSnap.closed_indefinitely, stateSnap.closed_message, stateSnap.updated_by, stateSnap.updated_at]);
  }
}
async function mkOrder(fields) {
  const f = { pay: 'approved', status: 'new', items: [], created: '0 minutes', scheduled: null, ready: null, ...fields };
  const code = 'ZZV4A2' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const [o] = await Q(`insert into orders (code, customer_name, customer_phone, delivery_method, items, subtotal_cents, delivery_fee_cents, discount_cents,
      points_redeemed, total_cents, payment_status, fulfillment_status, created_at, scheduled_for, ready_at)
    values ($1, $2, $3, 'pickup', $4::jsonb, 1000, 0, 0, 0, 1000, $5, $6, now() - $7::interval, $8, $9) returning id`,
    [code, `${P} Agenda ${f.label || 'direto'}`, phone(), JSON.stringify(f.items), f.pay, f.status, f.created, f.scheduled, f.ready]);
  return o.id;
}

(async () => {
  await cleanup();
  settingsSnap = await Q('select key, value from settings where key = any($1::text[])', [SETTING_KEYS]);
  [stateSnap = null] = await Q('select closed_until, closed_indefinitely, closed_message, updated_by, updated_at from store_state where id = 1');
  const st0 = await hours.getStoreState(sql);
  if (!st0.open) { console.error('A loja do dev está fechada agora: o teste precisa dela aberta (não altero o horário).'); process.exit(1); }
  const [cat] = await Q(`insert into categories (name, sort_order, active) values ($1, 9999, true) returning id`, [CAT]);
  const prod = {};
  for (const k of ['Doce', 'Top', 'Pouco', 'Premio', 'Cancelado', 'Antigo', 'Pendente']) {
    [prod[k]] = await Q(`insert into products (category_id, name, price_cents, active, sort_order) values ($1, $2, 1000, true, 9999) returning id`, [cat.id, `${P} ${k}`]);
  }
  const body = extra => ({ customer_name: `${P} Agenda`, customer_phone: phone(), delivery_method: 'pickup', items: [{ product_id: prod.Doce.id, qty: 1 }], ...extra });
  const admPass = pass(), stfPass = pass();
  const ADM = await adminUser('adm', 'admin', admPass);
  const STF = await adminUser('stf', 'staff', stfPass);
  const AC = cookieOf(await acall('login', { method: 'POST', body: { username: ADM, password: admPass } }));
  const SC = cookieOf(await acall('login', { method: 'POST', body: { username: STF, password: stfPass } }));
  const save = (b, cookie = AC) => acall('order_settings_save', { method: 'POST', body: b, cookie });

  try {
    console.log('Funções puras');
    await t('janelas: alinhadas a 30 min e inteiras dentro da faixa (09:15-10:40 = 09:30 e 10:00)', async () => {
      assert.deepEqual(sched.windowsForWeekday([{ weekday: 1, opens: '09:15', closes: '10:40' }], 1), [570, 600]);
      assert.deepEqual(sched.windowsForWeekday([{ weekday: 1, opens: '00:00', closes: '23:59' }], 1).length, 47);
      assert.deepEqual(sched.windowsForWeekday([{ weekday: 1, opens: '09:00', closes: '18:00' }], 2), []);
    });
    await t('blockReason: desalinhada, fora do horário, antecedência, máximo de dias, fechamento manual', async () => {
      const now = new Date('2026-11-16T12:00:00Z'); // segunda 09:00 em São Paulo
      const rows = []; for (let d = 0; d < 7; d++) rows.push({ weekday: d, opens: '09:00', closes: '18:00' });
      const ctx = { cfg: { enabled: true, min_lead_min: 120, max_days: 7, slot_capacity: 0 }, hoursRows: rows, manual: null, legacyPaused: false };
      const at = s => new Date(s);
      assert.equal(sched.blockReason(ctx, at('2026-11-16T17:00:00Z'), now), null); // 14:00
      assert.equal(sched.blockReason(ctx, at('2026-11-16T17:10:00Z'), now), 'invalid'); // 14:10
      assert.equal(sched.blockReason(ctx, at('2026-11-16T17:00:30Z'), now), 'invalid'); // segundos
      assert.equal(sched.blockReason(ctx, at('2026-11-16T21:00:00Z'), now), 'invalid'); // 18:00 (fecha às 18)
      assert.equal(sched.blockReason(ctx, at('2026-11-16T20:30:00Z'), now), null); // 17:30-18:00 cabe
      assert.equal(sched.blockReason(ctx, at('2026-11-16T11:30:00Z'), now), 'invalid'); // 08:30
      assert.equal(sched.blockReason(ctx, at('2026-11-16T13:30:00Z'), now), 'too_soon'); // 10:30 (< 2 h)
      assert.equal(sched.blockReason(ctx, at('2026-11-16T14:00:00Z'), now), null); // 11:00 (= 2 h)
      assert.equal(sched.blockReason(ctx, at('2026-11-23T20:30:00Z'), now), null); // +7 dias
      assert.equal(sched.blockReason(ctx, at('2026-11-24T12:00:00Z'), now), 'too_far'); // +8 dias
      assert.equal(sched.blockReason({ ...ctx, legacyPaused: true }, at('2026-11-17T12:00:00Z'), now), 'closed');
      assert.equal(sched.blockReason({ ...ctx, manual: { closed_indefinitely: true } }, at('2026-11-17T12:00:00Z'), now), 'closed');
      const timed = { ...ctx, manual: { closed_until: at('2026-11-17T15:00:00Z'), closed_indefinitely: false } };
      assert.equal(sched.blockReason(timed, at('2026-11-17T14:30:00Z'), now), 'closed');
      assert.equal(sched.blockReason(timed, at('2026-11-17T15:00:00Z'), now), null);
    });
    await t('etiqueta: "Agendado: sex 21/11, 15:00-15:30" (hora de São Paulo); sem data = null', async () => {
      assert.equal(sched.scheduledLabel('2025-11-21T18:00:00Z'), 'Agendado: sex 21/11, 15:00-15:30');
      assert.equal(sched.scheduledLabel(null), null);
    });

    console.log('N10/N11: ajustes no painel');
    await t('order_settings: staff lê; salvar é só admin (403); sem sessão 401', async () => {
      const r = await acall('order_settings', { cookie: SC });
      assert.equal(r.status, 200);
      for (const k of ['scheduling_enabled', 'scheduling_min_lead_min', 'scheduling_max_days', 'scheduling_slot_capacity', 'best_seller_enabled', 'delivery_eta_min', 'delivery_eta_max']) assert.ok(k in r.json.settings, k);
      assert.equal((await save({ delivery_eta_min: 10 }, SC)).status, 403);
      assert.equal((await acall('order_settings')).status, 401);
    });
    await t('order_settings_save: validações; nada é gravado se um campo estiver errado; auditoria', async () => {
      const before = (await acall('order_settings', { cookie: AC })).json.settings;
      for (const bad of [{}, { scheduling_min_lead_min: 5000 }, { scheduling_max_days: 0 }, { scheduling_slot_capacity: -1 }, { scheduling_enabled: 'sim' },
        { delivery_eta_min: 1.5 }, { delivery_eta_min: 60, delivery_eta_max: 40 }, { best_seller_enabled: 1 }, { delivery_eta_max: 601 }]) {
        assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await save({ delivery_eta_min: 15, scheduling_max_days: 99 })).status, 400);
      assert.deepEqual((await acall('order_settings', { cookie: AC })).json.settings, before, 'nada mudou');
      const r = await save({ scheduling_enabled: true, scheduling_min_lead_min: 60, scheduling_max_days: 3, scheduling_slot_capacity: 0, delivery_eta_min: 20, delivery_eta_max: 45, best_seller_enabled: true });
      assert.equal(r.status, 200);
      assert.equal(r.json.settings.scheduling_min_lead_min, 60); assert.equal(r.json.settings.delivery_eta_max, 45);
      const [a] = await Q(`select detail from admin_audit where username = $1 and action = 'ajustes_pedido_salvos' order by id desc limit 1`, [ADM]);
      assert.match(a.detail, /scheduling_min_lead_min=60/); assert.match(a.detail, /delivery_eta_max=45/);
    });
    await t('/api/menu: scheduling { enabled, min_lead_min, max_days, slot_minutes } e prazo 20 a 45', async () => {
      const r = await menu();
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.scheduling, { enabled: true, min_lead_min: 60, max_days: 3, slot_minutes: 30 });
      assert.equal(r.body.delivery_eta_min, 20); assert.equal(r.body.delivery_eta_max, 45);
    });

    console.log('N10: janelas disponíveis (/api/store?a=slots)');
    await t('slots: data e modo inválidos dão 400', async () => {
      for (const d of ['', '2026-02-30', '20261120', '2026-13-01', 'amanha']) {
        const r = await slots(d); assert.equal(r.status, 400, d); assert.equal(r.body.code, 'invalid_date');
      }
      const r = await slots(spDate(1), 'motoboy'); assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_mode');
    });
    let day1 = null;
    await t('slots: amanhã tem 47 janelas de 30 min (horário 00:00-23:59 do dev); hoje respeita a antecedência; além do máximo vem vazio', async () => {
      const r = await slots(spDate(1));
      assert.equal(r.status, 200); assert.equal(r.body.enabled, true); assert.equal(r.body.slot_minutes, 30);
      assert.equal(r.body.slots.length, 47);
      assert.ok(r.body.slots.every(s => new Date(s.end) - new Date(s.start) === 30 * 60000 && /^\d\d:\d\d-\d\d:\d\d$/.test(s.label)));
      day1 = r.body.slots.filter(s => s.available);
      assert.ok(day1.length >= 40, 'quase todas livres');
      const today = (await slots(spDate(0))).body.slots;
      const lim = Date.now() + 60 * 60000;
      assert.ok(today.every(s => (new Date(s.start).getTime() < lim ? s.reason === 'too_soon' : s.available)), 'antecedência de 60 min');
      assert.deepEqual((await slots(spDate(4))).body.slots, []);
      assert.deepEqual((await slots(spDate(-1))).body.slots, []);
      assert.equal((await slots(spDate(3), 'delivery')).body.slots.length, 47);
    });
    await t('slots: limite por IP (429 rate_limited)', async () => {
      const fixed = ip();
      await Q(`insert into rate_hits (scope, ip, minute, n) values ('schedule_slots', $1, date_trunc('minute', now()), $2)`, [fixed, storeHandler._internal.SLOTS_MAX_PER_IP]);
      const r = await slots(spDate(1), 'pickup', fixed);
      assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    });

    console.log('N10: pedido agendado');
    let okOrder = null;
    await t('pedido com scheduled_for válido: 201, devolve scheduled_for e etiqueta; rastreio e painel mostram', async () => {
      const slot = day1[10];
      const r = await order(body({ scheduled_for: spIso(slot.start) }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.scheduled_for, slot.start);
      assert.match(r.body.scheduled_label, /^Agendado: (dom|seg|ter|qua|qui|sex|sáb) \d\d\/\d\d, \d\d:\d\d-\d\d:\d\d$/);
      okOrder = r.body;
      const tr = await track(r.body.tracking_token);
      assert.equal(tr.body.scheduled_for, slot.start); assert.equal(tr.body.scheduled_label, r.body.scheduled_label);
      const list = await acall('orders', { cookie: SC, query: '&s=' + encodeURIComponent('zz-v4-a2 agenda') });
      const row = list.json.orders.find(o => o.id === r.body.id);
      assert.equal(row.scheduled_for, slot.start); assert.equal(row.scheduled_label, r.body.scheduled_label);
    });
    await t('pedido sem scheduled_for continua "o quanto antes" (scheduled_for null)', async () => {
      const r = await order(body({ scheduled_for: '' }));
      assert.equal(r.status, 201); assert.equal(r.body.scheduled_for, null); assert.equal(r.body.scheduled_label, null);
    });
    await t('recusas: formato, desalinhado, perto demais, longe demais (nenhum pedido gravado)', async () => {
      const n0 = (await Q(`select count(*)::int n from orders where customer_name like $1`, [P + '%']))[0].n;
      const s = new Date(day1[12].start);
      const cases = [
        ['amanhã 15h', 'invalid_schedule'], [12345, 'invalid_schedule'], ['2026-11-99T10:00:00Z', 'invalid_schedule'],
        [new Date(s.getTime() + 10 * 60000).toISOString(), 'invalid_schedule'],
        [new Date(s.getTime() + 1000).toISOString(), 'invalid_schedule'],
        [(await slots(spDate(0))).body.slots.find(x => x.reason === 'too_soon')?.start || new Date(Math.ceil(Date.now() / 1800000) * 1800000).toISOString(), 'schedule_too_soon'],
        [new Date(s.getTime() + 4 * 86400000).toISOString(), 'schedule_too_far']
      ];
      for (const [v, code] of cases) {
        const r = await order(body({ scheduled_for: v }));
        assert.equal(r.status, 400, String(v)); assert.equal(r.body.code, code, String(v));
      }
      assert.equal((await Q(`select count(*)::int n from orders where customer_name like $1`, [P + '%']))[0].n, n0);
    });
    await t('agendamento desligado: 409 scheduling_disabled; slots vazio; menu enabled false', async () => {
      assert.equal((await save({ scheduling_enabled: false })).status, 200);
      const r = await order(body({ scheduled_for: day1[13].start }));
      assert.equal(r.status, 409); assert.equal(r.body.code, 'scheduling_disabled');
      const sl = await slots(spDate(1)); assert.equal(sl.body.enabled, false); assert.deepEqual(sl.body.slots, []);
      assert.equal((await menu()).body.scheduling.enabled, false);
      assert.equal((await save({ scheduling_enabled: true })).status, 200);
    });
    await t('loja fechada agora: "o quanto antes" 503; agendar antes da reabertura 400 schedule_closed; depois 201', async () => {
      await hours.closeStore(sql, { minutes: 24 * 60, message: 'zz-v4-a2 fechada', user: 'zz-v4-a2' });
      const r1 = await order(body());
      assert.equal(r1.status, 503); assert.equal(r1.body.code, 'store_closed');
      const r2 = await order(body({ scheduled_for: day1[0].start })); // amanhã cedo, antes de reabrir (+24 h)
      assert.equal(r2.status, 400); assert.equal(r2.body.code, 'schedule_closed');
      const late = (await slots(spDate(2))).body.slots.filter(s => s.available).pop();
      const blocked = (await slots(spDate(1))).body.slots.filter(s => s.reason === 'closed').length;
      assert.ok(blocked > 0, 'slots mostram closed');
      const r3 = await order(body({ scheduled_for: late.start }));
      assert.equal(r3.status, 201, JSON.stringify(r3.body)); assert.equal(r3.body.scheduled_for, late.start);
      await Q(`update store_state set closed_until = null, closed_indefinitely = false, closed_message = null where id = 1`);
      assert.equal((await hours.getStoreState(sql)).open, true);
    });

    console.log('N10: vaga por janela (trava contra corrida)');
    await t('capacidade 1: 6 pedidos em paralelo na mesma janela, só 1 entra; os outros 409 slot_full', async () => {
      assert.equal((await save({ scheduling_slot_capacity: 1 })).status, 200);
      const slot = day1[20];
      const rs = await Promise.all(Array.from({ length: 6 }, () => order(body({ scheduled_for: slot.start }))));
      const ok = rs.filter(r => r.status === 201), full = rs.filter(r => r.status === 409 && r.body.code === 'slot_full');
      assert.equal(ok.length, 1, rs.map(r => r.status + ':' + (r.body.code || '')).join(','));
      assert.equal(full.length, 5);
      assert.equal((await Q(`select count(*)::int n from orders where scheduled_for = $1 and customer_name like $2`, [slot.start, P + '%']))[0].n, 1);
      const s2 = (await slots(spDate(1))).body.slots.find(s => s.start === slot.start);
      assert.equal(s2.available, false); assert.equal(s2.reason, 'full');
    });
    await t('vaga volta: pagamento recusado, pedido cancelado ou pendente há mais de 60 min não ocupam; pago ocupa', async () => {
      const slot = day1[20];
      const [o] = await Q(`select id from orders where scheduled_for = $1 and customer_name like $2`, [slot.start, P + '%']);
      const free = async () => (await slots(spDate(1))).body.slots.find(s => s.start === slot.start).available;
      await Q(`update orders set payment_status = 'rejected' where id = $1`, [o.id]); assert.equal(await free(), true, 'recusado');
      await Q(`update orders set payment_status = 'pending', created_at = now() - interval '61 minutes' where id = $1`, [o.id]); assert.equal(await free(), true, 'pendente antigo');
      await Q(`update orders set payment_status = 'approved' where id = $1`, [o.id]); assert.equal(await free(), false, 'pago ocupa');
      await Q(`update orders set fulfillment_status = 'cancelled' where id = $1`, [o.id]); assert.equal(await free(), true, 'cancelado');
      const r = await order(body({ scheduled_for: slot.start }));
      assert.equal(r.status, 201, 'a vaga livre aceita um novo pedido');
      assert.equal((await order(body({ scheduled_for: slot.start }))).body.code, 'slot_full');
      assert.equal((await save({ scheduling_slot_capacity: 0 })).status, 200);
      assert.equal((await order(body({ scheduled_for: slot.start }))).status, 201, 'sem limite (0) aceita');
    });

    console.log('N10: painel (filtro, janela de 24 h e conclusão automática)');
    await t('f=scheduled: só agendados, ordenados pela data marcada; agendado antigo para amanhã fica na lista e fora do histórico', async () => {
      const oldSched = await mkOrder({ label: 'antigo agendado', created: '48 hours', scheduled: day1[30].start, pay: 'approved' });
      const oldAsap = await mkOrder({ label: 'antigo asap', created: '48 hours', pay: 'approved' });
      const s = '&s=' + encodeURIComponent('zz-v4-a2 agenda');
      const list = (await acall('orders', { cookie: SC, query: s })).json.orders;
      assert.ok(list.some(o => o.id === oldSched), 'agendado antigo na lista');
      assert.ok(!list.some(o => o.id === oldAsap), 'antigo sem data fora da lista');
      const only = (await acall('orders', { cookie: SC, query: '&f=scheduled' + s })).json.orders;
      assert.ok(only.length >= 3 && only.every(o => o.scheduled_for));
      const times = only.map(o => new Date(o.scheduled_for).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => a - b), 'ordem pela data marcada');
      const hist = (await acall('order_history', { cookie: SC, query: s })).json.orders;
      assert.ok(hist.some(o => o.id === oldAsap) && !hist.some(o => o.id === oldSched));
      const histSched = (await acall('order_history', { cookie: SC, query: '&f=scheduled' + s })).json.orders;
      assert.ok(!histSched.some(o => o.id === oldAsap));
    });
    await t('conclusão automática respeita a data marcada', async () => {
      const early = await mkOrder({ label: 'pronto cedo', status: 'ready', ready: new Date(Date.now() - 2 * 3600000).toISOString(), scheduled: new Date(Date.now() + 3600000).toISOString(), created: '3 hours' });
      const past = await mkOrder({ label: 'agendado passou', status: 'ready', ready: new Date(Date.now() - 3 * 3600000).toISOString(), scheduled: new Date(Date.now() - 2 * 3600000).toISOString(), created: '4 hours' });
      const asap = await mkOrder({ label: 'pronto asap', status: 'ready', ready: new Date(Date.now() - 2 * 3600000).toISOString(), created: '3 hours' });
      await acall('orders', { cookie: SC });
      const rows = await Q(`select id, fulfillment_status, completed_at, scheduled_for from orders where id = any($1::int[])`, [[early, past, asap]]);
      const by = Object.fromEntries(rows.map(r => [r.id, r]));
      assert.equal(by[early].fulfillment_status, 'ready', 'pronto cedo para daqui 1 h continua pronto');
      assert.equal(by[past].fulfillment_status, 'completed');
      assert.equal(new Date(by[past].completed_at).getTime(), new Date(by[past].scheduled_for).getTime() + 3600000, 'concluído = data marcada + 1 h');
      assert.equal(by[asap].fulfillment_status, 'completed');
    });

    console.log('N11: selo "Mais pedido"');
    await t('best_seller: top por unidades em pedidos pagos de 30 dias (mín. 5); prêmio, cancelado, antigo e pendente não contam', async () => {
      const it = (p, qty, extra = {}) => [{ product_id: p.id, name: 'zz', qty, unit_total_cents: 1000, ...extra }];
      await mkOrder({ label: 'top', items: it(prod.Top, 9999) });
      await mkOrder({ label: 'pouco', items: it(prod.Pouco, 4) });
      await mkOrder({ label: 'premio', items: it(prod.Premio, 9999, { reward: true, unit_total_cents: 0 }) });
      await mkOrder({ label: 'cancelado', items: it(prod.Cancelado, 9999), status: 'cancelled' });
      await mkOrder({ label: 'antigo', items: it(prod.Antigo, 9999), created: '31 days' });
      await mkOrder({ label: 'pendente', items: it(prod.Pendente, 9999), pay: 'pending' });
      await mkOrder({ label: 'lixo', items: [{ product_id: 'x', qty: 'muitos' }, { qty: 3 }] }); // item estranho não derruba a consulta
      const r = await menu();
      const flat = r.body.categories.flatMap(c => c.products);
      const flag = p => flat.find(x => x.id === p.id).best_seller;
      assert.equal(flag(prod.Top), true);
      for (const k of ['Pouco', 'Premio', 'Cancelado', 'Antigo', 'Pendente', 'Doce']) assert.equal(flag(prod[k]), false, k);
      assert.ok(flat.filter(x => x.best_seller).length <= 3, 'no máximo 3');
      assert.ok(flat.every(x => typeof x.best_seller === 'boolean'));
    });
    await t('best_seller_enabled desligado: nenhum produto com selo', async () => {
      assert.equal((await save({ best_seller_enabled: false })).status, 200);
      assert.ok((await menu()).body.categories.flatMap(c => c.products).every(x => x.best_seller === false));
    });
  } finally {
    await restore();
    await cleanup();
    const [left] = await Q(`select (select count(*) from orders where customer_name like $1)::int o, (select count(*) from products where name like $1)::int p,
      (select count(*) from admin_users where username like $2)::int u, (select count(*) from rate_hits where ip like '198.51.100.%')::int r`, [P + '%', U + '%']);
    const now = await Q('select key, value from settings where key = any($1::text[]) order by key', [SETTING_KEYS]);
    const same = JSON.stringify(now) === JSON.stringify([...settingsSnap].sort((a, b) => a.key.localeCompare(b.key)));
    const st = await hours.getStoreState(sql);
    console.log(`limpeza: pedidos ${left.o}, produtos ${left.p}, usuários ${left.u}, rate_hits ${left.r}; ajustes restaurados: ${same}; loja aberta: ${st.open}`);
    console.log(`${passed} passaram, ${failed} falharam`);
  }
})().catch(async e => { console.error('ERRO:', String(e.message).slice(0, 200)); process.exitCode = 1; try { await restore(); await cleanup(); } catch { /* */ } });
