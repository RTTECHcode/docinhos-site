// Testes das ações novas do painel (F2): segurança da conta, pausa, horários, frete, sinônimos, pedidos e histórico.
// Chama o handler real api/admin.js (req/res falsos) contra o banco de DESENVOLVIMENTO.
// Uso: node -r ./scripts/dev-env.js scripts/test-admin-painel.js
// Só cria linhas "ZZ-TESTE ..." / usuários "zz-teste-pn-*" e apaga no final; horários, estado da loja e configurações
// são salvos antes e restaurados depois. Senhas e códigos são aleatórios e nunca impressos.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const admin = require('../api/admin');
const menu = require('../api/menu');
const sql = require('../api/_lib/db');
const auth = require('../api/_lib/auth');
const loyalty = require('../api/_lib/loyalty');

const Q = (text, params) => sql.query(text, params || []);
const rnd = () => crypto.randomBytes(6).toString('hex');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; const m = /test-admin-painel\.js:(\d+)/.exec(String(e && e.stack)); console.log('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').slice(0, 4).join(' | ') + (m ? ' (linha ' + m[1] + ')' : '')); process.exitCode = 1; }
}

const HOST = 'painel.test.local';
async function call(o) {
  const method = o.method || 'GET';
  const headers = { host: HOST, 'x-forwarded-for': o.ip || '198.51.100.50', 'user-agent': 'test-admin-painel' };
  if (method === 'POST') { headers.origin = 'https://' + HOST; headers['content-type'] = 'application/json'; }
  if (o.cookie) headers.cookie = o.cookie;
  const req = { method, url: '/api/admin?' + new URLSearchParams({ a: o.action || '', ...(o.query || {}) }), headers, body: o.body, socket: { remoteAddress: '127.0.0.1' } };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(c) { this.body = c === undefined ? '' : c; } };
  await admin(req, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* sem corpo */ }
  return { status: res.statusCode, json, headers: res.headers };
}
const get = (cookie, action, query, extra) => call({ action, cookie, query, ...(extra || {}) });
const post = (cookie, action, body, extra) => call({ method: 'POST', action, cookie, body: body === undefined ? {} : body, ...(extra || {}) });
async function menuCall() {
  const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await menu({ method: 'GET', headers: {} }, res);
  return res;
}

const S = { ips: { n: 0 }, users: [], pw: {} };
const nextIp = () => `203.0.113.${100 + (++S.ips.n)}`;
async function mkUser(role, { security = true } = {}) {
  const username = 'zz-teste-pn-' + rnd();
  const password = 'Sx-' + rnd();
  const ah = security ? await auth.hashAnswer('resposta combinada') : null;
  const id = (await Q(`insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at)
                       values ($1,$2,$3,false,$4,$5,$6) returning id`,
    [username, await auth.hashPassword(password), role, security ? 'prof_favorito' : null, ah, security ? new Date() : null]))[0].id;
  S.users.push(username);
  return { id, username, password };
}
async function login(u, ip) {
  const r = await post(null, 'login', { username: u.username, password: u.password }, { ip: ip || nextIp() });
  const sc = r.headers['set-cookie'];
  return { r, cookie: sc ? String(sc).split(';')[0] : null };
}

const POINT_KEYS = ['points_enabled', 'points_per_real', 'points_block_points', 'points_block_value_cents'];
const SETTINGS = ['default_pause_label', 'shipping_bands', 'store_origin_lat', 'store_origin_lon', 'store_origin_address', 'store_paused', 'store_paused_message', ...POINT_KEYS];
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '00:00', closes: '23:59' })); // D8: sem horário = fechada; os testes de pedido precisam da loja aberta
let snap;
async function snapshot() {
  return {
    hours: await Q('select weekday, opens, closes from store_hours'),
    state: (await Q('select * from store_state where id = 1'))[0] || null,
    settings: await Q('select key, value from settings where key = any($1::text[])', [SETTINGS]),
    syn: (await Q('select id from ingredient_synonyms')).map(r => r.id)
  };
}
async function restore(s) {
  await Q('delete from store_hours');
  for (const h of s.hours) await Q('insert into store_hours (weekday, opens, closes) values ($1,$2,$3)', [h.weekday, h.opens, h.closes]);
  await Q('delete from store_state where id = 1');
  if (s.state) await Q('insert into store_state (id, closed_until, closed_indefinitely, closed_message, updated_by) values (1,$1,$2,$3,$4)', [s.state.closed_until, s.state.closed_indefinitely, s.state.closed_message, s.state.updated_by]);
  await Q('delete from settings where key = any($1::text[])', [SETTINGS]);
  for (const r of s.settings) await Q('insert into settings (key, value) values ($1,$2)', [r.key, r.value]);
  await Q('delete from ingredient_synonyms where id <> all($1::int[])', [s.syn]);
}
async function cleanup() {
  await Q(`delete from ingredient_pause_batches where term_norm like 'zz%' or created_by like 'zz-teste-pn-%'`);
  await Q(`delete from orders where customer_name like 'ZZ-TESTE%'`);
  await Q(`delete from customers where name like 'ZZ-TESTE%'`);
  await Q(`delete from products where name like 'ZZ-TESTE%'`);
  await Q(`delete from complements where name like 'ZZ-TESTE%'`);
  await Q(`delete from categories where name like 'ZZ-TESTE%'`);
  await Q(`delete from admin_audit where username like 'zz-teste-pn-%'`);
  await Q(`delete from admin_users where username like 'zz-teste-pn-%'`); // sessões, códigos e tentativas: cascata / abaixo
  await Q(`delete from admin_recovery_attempts where username like 'zz-teste-pn-%' or ip like '203.0.113.%' or ip like '192.0.2.%'`);
  await Q(`delete from login_attempts where username like 'zz-teste-pn-%' or ip like '203.0.113.%'`);
}

(async () => {
  await cleanup();
  snap = await snapshot();
  await Q('delete from store_hours');
  for (const h of ALL_DAY) await Q('insert into store_hours (weekday, opens, closes) values ($1,$2,$3)', [h.weekday, h.opens, h.closes]);
  const adm = await mkUser('admin'), staff = await mkUser('staff');
  const A = (await login(adm)).cookie, ST = (await login(staff)).cookie;
  assert.ok(A && ST);

  console.log('\nO9: pergunta de segurança e recuperação');
  const nosec = await mkUser('admin', { security: false });
  let N, codes;
  await t('sem pergunta cadastrada: login sinaliza needsSecurity e o servidor bloqueia as outras ações', async () => {
    const l = await login(nosec); N = l.cookie;
    assert.equal(l.r.status, 200); assert.equal(l.r.json.user.needsSecurity, true);
    assert.equal((await get(N, 'me')).json.user.needsSecurity, true);
    for (const a of ['catalog', 'orders', 'audit', 'users', 'store_state', 'shipping_get']) {
      const r = await get(N, a); assert.equal(r.status, 403, a); assert.equal(r.json.code, 'security_setup_required');
    }
    assert.equal((await post(N, 'product_pause', { id: 1, paused: true })).status, 403);
    assert.equal((await get(N, 'security_questions')).status, 200);
    assert.ok((await get(N, 'security_questions')).json.questions.length >= 6);
    assert.equal((await get(null, 'security_questions')).status, 401);
  });
  await t('cadastro: pergunta fora da lista, resposta curta ou sem corpo -> 400; ok devolve 10 códigos uma vez só', async () => {
    assert.equal((await post(N, 'security_setup', { question_id: 'nome_da_mae', answer: 'abcdef' })).status, 400);
    assert.equal((await post(N, 'security_setup', { question_id: 'prof_favorito', answer: 'ab' })).status, 400);
    assert.equal((await post(N, 'security_setup', {})).status, 400);
    assert.equal((await get(N, 'catalog')).status, 403);
    const r = await post(N, 'security_setup', { question_id: 'melhor_amigo', answer: '  Joãozinho  da Silva ' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    codes = r.json.codes;
    assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
    assert.equal(r.json.user.needsSecurity, false);
    const rows = await Q('select code_hash, used_at from admin_recovery_codes where user_id = $1', [nosec.id]);
    assert.equal(rows.length, 10);
    assert.ok(rows.every(x => x.code_hash.startsWith('scrypt$') && x.used_at === null));
    const blob = JSON.stringify(rows) + JSON.stringify(await Q('select security_answer_hash from admin_users where id = $1', [nosec.id]));
    assert.ok(!codes.some(c => blob.includes(c.replace(/-/g, ''))) && !/jo[aã]ozinho/i.test(blob), 'só hash no banco');
    assert.equal((await get(N, 'catalog')).status, 200);
    assert.equal((await get(N, 'security_status')).json.security.codes_left, 10);
    const st = (await get(N, 'security_status')).json.security;
    assert.deepEqual(Object.keys(st).sort(), ['codes_left', 'question', 'question_id', 'set', 'set_at']);
    assert.ok(!JSON.stringify(await get(N, 'security_status')).includes('hash'));
  });
  await t('trocar a pergunta exige a senha atual; códigos novos substituem os antigos', async () => {
    assert.equal((await post(N, 'security_setup', { question_id: 'primeiro_livro', answer: 'dom casmurro' })).status, 400);
    assert.equal((await post(N, 'security_setup', { question_id: 'primeiro_livro', answer: 'dom casmurro', current_password: 'errada' })).status, 400);
    const r = await post(N, 'security_setup', { question_id: 'melhor_amigo', answer: 'Joãozinho da Silva', current_password: nosec.password });
    assert.equal(r.status, 200); assert.equal(r.json.codes.length, 10);
    assert.ok(r.json.codes.every(c => !codes.includes(c)));
    codes = r.json.codes;
    assert.equal((await post(N, 'recovery_codes_new', {})).status, 400);
    const n2 = await post(N, 'recovery_codes_new', { current_password: nosec.password });
    assert.equal(n2.status, 200); codes = n2.json.codes;
    assert.equal((await Q('select count(*)::int n from admin_recovery_codes where user_id = $1', [nosec.id]))[0].n, 10);
  });
  await t('recover_question: resposta de formato igual para usuário real e inexistente; pergunta falsa estável; GET -> 405', async () => {
    const real = await post(null, 'recover_question', { username: nosec.username });
    const fake1 = await post(null, 'recover_question', { username: 'zz-teste-pn-naoexiste' }), fake2 = await post(null, 'recover_question', { username: 'zz-teste-pn-naoexiste' });
    assert.equal(real.status, 200); assert.equal(fake1.status, 200);
    assert.deepEqual(Object.keys(real.json).sort(), Object.keys(fake1.json).sort());
    assert.equal(real.json.question_id, 'melhor_amigo');
    assert.deepEqual(fake1.json, fake2.json);
    assert.ok(auth.QUESTION_IDS.includes(fake1.json.question_id));
    assert.equal((await post(null, 'recover_question', {})).status, 400);
    assert.equal((await get(null, 'recover_question')).status, 405);
  });
  await t('recuperação: resposta errada ou código errado -> mesma mensagem genérica (usuário real e inexistente)', async () => {
    const ip = '192.0.2.10';
    const mk = (user, answer, code, from) => post(null, 'recover', { username: user, answer, code, new_password: 'NovaSenha-123' }, { ip: from });
    // IPs diferentes: cada tentativa é a primeira do seu IP (a 3ª falha do mesmo IP já bloqueia, testado abaixo)
    const wrongAnswer = await mk(nosec.username, 'resposta errada', codes[0], '192.0.2.11');
    const wrongCode = await mk(nosec.username, 'joaozinho da silva', 'AAAA-BBBB-CCCC', '192.0.2.12');
    const noUser = await mk('zz-teste-pn-naoexiste', 'qualquer coisa', codes[0], '192.0.2.13');
    for (const r of [wrongAnswer, wrongCode, noUser]) assert.equal(r.status, 400);
    assert.equal(wrongAnswer.json.error, wrongCode.json.error);
    assert.equal(wrongAnswer.json.error, noUser.json.error);
    assert.ok(!/usu[aá]rio|existe|c[oó]digo|resposta/i.test(wrongAnswer.json.error.replace('recuperar', '')), 'a mensagem não revela qual dado falhou: ' + wrongAnswer.json.error);
    assert.equal((await post(null, 'recover', { username: nosec.username, answer: 'a', code: 'b', new_password: 'curta' }, { ip })).status, 400);
    assert.equal((await Q('select password_hash from admin_users where id = $1', [nosec.id])).length, 1);
    assert.equal(await auth.verifyPassword(nosec.password, (await Q('select password_hash from admin_users where id = $1', [nosec.id]))[0].password_hash), true, 'senha intacta');
  });
  await t('3 erros bloqueiam por 1 h (usuário e IP): nem os dados certos passam; outro IP também é barrado para o mesmo usuário', async () => {
    const u = await mkUser('admin'); const codesU = (await post((await login(u)).cookie, 'recovery_codes_new', { current_password: u.password })).json.codes;
    const ip = '192.0.2.20';
    const bad = () => post(null, 'recover', { username: u.username, answer: 'errada', code: 'AAAA-BBBB-CCCC', new_password: 'NovaSenha-123' }, { ip });
    assert.equal((await bad()).status, 400); assert.equal((await bad()).status, 400);
    assert.equal((await bad()).status, 429, '3ª falha já bloqueia');
    const good = await post(null, 'recover', { username: u.username, answer: 'resposta combinada', code: codesU[0], new_password: 'NovaSenha-123' }, { ip });
    assert.equal(good.status, 429);
    const otherIp = await post(null, 'recover', { username: u.username, answer: 'resposta combinada', code: codesU[0], new_password: 'NovaSenha-123' }, { ip: '192.0.2.21' });
    assert.equal(otherIp.status, 429, 'bloqueio do usuário vale para qualquer IP');
    const sameIpOtherUser = await post(null, 'recover', { username: nosec.username, answer: 'joaozinho da silva', code: codes[0], new_password: 'NovaSenha-123' }, { ip });
    assert.equal(sameIpOtherUser.status, 429, 'bloqueio do IP vale para outros usuários');
    assert.equal(await auth.verifyPassword('NovaSenha-123', (await Q('select password_hash from admin_users where id = $1', [u.id]))[0].password_hash), false);
    // expira: tentativas com mais de 1 h não contam
    await Q(`update admin_recovery_attempts set at = now() - interval '61 minutes' where username = $1 or ip = $2`, [u.username, ip]);
    const after = await post(null, 'recover', { username: u.username, answer: 'resposta combinada', code: codesU[0], new_password: 'NovaSenha-123' }, { ip });
    assert.equal(after.status, 200, JSON.stringify(after.json));
  });
  await t('recuperação certa: troca a senha, derruba as sessões, código vale uma vez, audita', async () => {
    const before = N;
    assert.equal((await get(before, 'me')).status, 200);
    const ip = '192.0.2.30';
    const r = await post(null, 'recover', { username: nosec.username, answer: '  JOAOZINHO   da  silva ', code: codes[2].toLowerCase(), new_password: 'SenhaNova-456' }, { ip });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await get(before, 'me')).status, 401, 'sessão antiga derrubada');
    nosec.password = 'SenhaNova-456';
    const l = await login(nosec); assert.equal(l.r.status, 200); N = l.cookie;
    assert.equal((await login({ ...nosec, password: 'Sx-antiga' })).r.status, 401);
    const reuse = await post(null, 'recover', { username: nosec.username, answer: 'joaozinho da silva', code: codes[2], new_password: 'Outra-789012' }, { ip: '192.0.2.31' });
    assert.equal(reuse.status, 400, 'código usado não vale de novo');
    assert.equal((await Q('select count(*)::int n from admin_recovery_codes where user_id = $1 and used_at is not null', [nosec.id]))[0].n, 1);
    assert.equal((await get(N, 'security_status')).json.security.codes_left, 9);
    const aud = await Q(`select action, detail from admin_audit where username = $1 and action = 'senha_recuperada'`, [nosec.username]);
    assert.equal(aud.length, 1);
    assert.ok(!JSON.stringify(aud).includes('SenhaNova') && !JSON.stringify(aud).includes(codes[2]));
  });

  console.log('\nO2: pausa de produtos');
  const [cat] = await Q(`insert into categories (name, sort_order, active) values ('ZZ-TESTE cat pn', 998, true) returning id`);
  const prod = (await Q(`insert into products (category_id, name, description, price_cents, active) values ($1, 'ZZ-TESTE Brigadeiro de Ninho', 'com biscoito Oreo e morangos', 800, true) returning id`, [cat.id]))[0];
  await t('product_pause (D6): pausa sem etiqueta (pause_label no corpo é ignorado sem erro); cardápio diz só paused/unavailable; retoma', async () => {
    const r = await post(A, 'product_pause', { id: prod.id, paused: true, pause_label: 'volta amanhã' });
    assert.equal(r.status, 200); assert.equal(r.json.product.paused, true); assert.ok(!('pause_label' in r.json.product));
    assert.equal((await Q('select pause_label from products where id = $1', [prod.id]))[0].pause_label, null, 'a coluna obsoleta não é gravada');
    let m = await menuCall();
    const find = () => m.body.categories.flatMap(c => c.products).find(p => p.id === prod.id);
    assert.equal(find().unavailable, true); assert.equal(find().paused, true); assert.ok(!('label' in find()), 'sem etiqueta no cardápio');
    assert.ok(!('defaultPauseLabel' in m.body.settings));
    await post(A, 'product_pause', { id: prod.id, paused: true, pause_label: null }); // também ignorado
    const cat2 = await get(A, 'catalog'); const row = cat2.json.products.find(p => p.id === prod.id);
    assert.equal(row.paused, true); assert.ok(!('pause_label' in row)); assert.equal(row.active, true);
    assert.equal((await post(A, 'product_pause', { id: prod.id, paused: false })).json.product.paused, false);
    m = await menuCall(); assert.ok(!('unavailable' in find()) || find().unavailable !== true);
  });
  await t('etiqueta padrão obsoleta (D6): a ação não grava nada nem erra; ids inexistentes -> 404; staff também pausa', async () => {
    const before = await Q(`select value from settings where key = 'default_pause_label'`);
    for (const label of ['já já', '', 'x'.repeat(61), null, 5]) { const r = await post(A, 'pause_default_label', { label }); assert.equal(r.status, 200, String(label)); assert.equal(r.json.obsolete, true); }
    assert.deepEqual(await Q(`select value from settings where key = 'default_pause_label'`), before, 'nada gravado');
    await post(A, 'product_pause', { id: prod.id, paused: true });
    const m = await menuCall();
    assert.ok(!('defaultPauseLabel' in m.body.settings));
    assert.ok(!('label' in m.body.categories.flatMap(c => c.products).find(p => p.id === prod.id)));
    assert.equal((await post(A, 'product_pause', { id: 2147483000, paused: true })).status, 404);
    assert.equal((await post(A, 'product_pause', { id: prod.id, paused: 'sim' })).status, 400);
    assert.equal((await post(A, 'product_pause', { id: prod.id, paused: false, pause_label: 'x'.repeat(61) })).status, 200, 'pause_label é ignorado, sem validar');
    assert.equal((await post(ST, 'product_pause', { id: prod.id, paused: false })).status, 200);
  });

  console.log('\nO3/O4: horários e estado da loja');
  await t('horários: salvar várias faixas, ler, limpar; formato inválido e sobreposição -> 400', async () => {
    const hours = [{ weekday: 1, opens: '09:00', closes: '12:00' }, { weekday: 1, opens: '14:00', closes: '18:00' }, { weekday: 6, opens: '10:00', closes: '15:00' }];
    const r = await post(A, 'store_hours_save', { hours });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.hours, hours);
    const g = await get(A, 'store_hours'); assert.deepEqual(g.json.hours, hours); assert.equal(g.json.timezone, 'America/Sao_Paulo');
    for (const bad of [[{ weekday: 9, opens: '09:00', closes: '10:00' }], [{ weekday: 1, opens: '18:00', closes: '09:00' }], [{ weekday: 1, opens: '09:00', closes: '12:00' }, { weekday: 1, opens: '11:00', closes: '13:00' }], 'x', [{ weekday: 1, opens: 'abc', closes: '10:00' }]])
      assert.equal((await post(A, 'store_hours_save', { hours: bad })).status, 400, JSON.stringify(bad));
    assert.deepEqual((await get(A, 'store_hours')).json.hours, hours, 'erro não altera os horários salvos');
    assert.equal(g.json.hours_warning, null, 'com horários não há aviso');
    const e = await post(A, 'store_hours_save', { hours: [] });
    assert.equal(e.status, 200); assert.equal(e.json.hours_warning, 'no_hours');
    assert.deepEqual((await get(A, 'store_hours')).json.hours, []);
    assert.equal((await get(A, 'store_hours')).json.hours_warning, 'no_hours');
    // D8: sem horário nenhum = FECHADA (antes ficava aberta o tempo todo)
    const st = await get(A, 'store_state');
    assert.equal(st.json.hours_warning, 'no_hours'); assert.equal(st.json.state.open, false); assert.equal(st.json.state.reason, 'schedule');
    assert.equal((await menuCall()).body.store.open, false);
    await post(A, 'store_hours_save', { hours: ALL_DAY }); // os testes seguintes precisam da loja aberta
    assert.equal((await get(A, 'store_state')).json.hours_warning, null);
  });
  await t('fechar por 30 min / 1 h / minutos livres / até reabrir; mensagem; reabrir; valores inválidos', async () => {
    for (const minutes of [30, 60, 45]) {
      const r = await post(A, 'store_close', { minutes, message: 'voltamos já' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.state.open, false); assert.equal(r.json.state.reason, 'manual');
      const diff = (new Date(r.json.state.reopens_at) - Date.now()) / 60000;
      assert.ok(Math.abs(diff - minutes) < 1, `${minutes} min -> ${diff}`);
      const pub = (await menuCall()).body.store;
      assert.deepEqual([pub.open, pub.reason], [false, 'manual']); assert.ok(pub.reopens_at); assert.match(pub.message, /voltamos já/);
    }
    const ind = await post(A, 'store_close', { indefinite: true });
    assert.equal(ind.status, 200); assert.equal(ind.json.state.reopens_at, null);
    assert.equal((await get(A, 'store_state')).json.manual.closed_indefinitely, true);
    for (const bad of [{ minutes: 0 }, { minutes: -5 }, { minutes: 1.5 }, { minutes: 'x' }, { minutes: 999999 }, {}, { minutes: 30, message: 'x'.repeat(201) }])
      assert.equal((await post(A, 'store_close', bad)).status, 400, JSON.stringify(bad));
    const re = await post(A, 'store_reopen', {});
    assert.equal(re.status, 200); assert.equal(re.json.state.open, true);
    assert.equal((await menuCall()).body.store.open, true);
  });
  await t('fechamento vencido volta a abrir sozinho (sem ninguém reabrir)', async () => {
    await post(A, 'store_close', { minutes: 30 });
    await Q(`update store_state set closed_until = now() - interval '1 second' where id = 1`);
    assert.equal((await menuCall()).body.store.open, true);
    assert.equal((await get(A, 'store_state')).json.state.open, true);
  });
  await t('agenda fechada: menu informa reason schedule e next_open_at', async () => {
    await post(A, 'store_hours_save', { hours: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens: '03:00', closes: '03:01' })) });
    const s = (await menuCall()).body.store;
    if (s.open === false) { assert.equal(s.reason, 'schedule'); assert.ok(s.next_open_at); }
    await post(A, 'store_hours_save', { hours: ALL_DAY });
  });

  console.log('\nO5: frete por faixas');
  await t('shipping_get: faixas padrão, limite, origem e retirada R$ 0', async () => {
    await Q(`delete from settings where key in ('shipping_bands', 'store_origin_lat', 'store_origin_lon', 'store_origin_address')`); // o snapshot do início restaura o que havia
    const r = await get(A, 'shipping_get');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.shipping.bands, [{ max_km: 3, fee_cents: 600 }, { max_km: 6, fee_cents: 900 }, { max_km: 10, fee_cents: 1400 }]);
    assert.equal(r.json.shipping.max_km, 10); assert.equal(r.json.shipping.pickup_fee_cents, 0);
    assert.match(r.json.shipping.origin_address, /Manoel Hare Peralta, 101/);
  });
  await t('shipping_save: só admin; faixas válidas valem no cardápio; inválidas -> 400', async () => {
    assert.equal((await post(ST, 'shipping_save', { bands: [{ max_km: 5, fee_cents: 500 }] })).status, 403);
    const ok = await post(A, 'shipping_save', { bands: [{ max_km: 2, fee_cents: 500 }, { max_km: 8, fee_cents: 1000 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await menuCall()).body.shipping.maxKm, 8);
    assert.deepEqual((await menuCall()).body.shipping.bands, [{ max_km: 2, fee_cents: 500 }, { max_km: 8, fee_cents: 1000 }]);
    for (const bad of [[], [{ max_km: 5, fee_cents: 500 }, { max_km: 3, fee_cents: 800 }], [{ max_km: 5, fee_cents: 500 }, { max_km: 5, fee_cents: 800 }], [{ max_km: 0, fee_cents: 500 }], [{ max_km: 5, fee_cents: -1 }], [{ max_km: 5, fee_cents: 1.5 }], [{ max_km: 'x', fee_cents: 500 }], 'x', [{ max_km: 5 }]])
      assert.equal((await post(A, 'shipping_save', { bands: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await post(A, 'shipping_save', {})).status, 400);
    assert.equal((await get(A, 'shipping_get')).json.shipping.max_km, 8, 'erro não altera as faixas');
    await Q(`delete from settings where key = 'shipping_bands'`);
  });

  // Regra de pontos: outros testes usam o mesmo banco dev; cada caso devolve as chaves points_* ao valor do início logo em seguida.
  const restorePoints = async () => {
    await Q('delete from settings where key = any($1::text[])', [POINT_KEYS]);
    for (const r of snap.settings.filter(x => POINT_KEYS.includes(x.key))) await Q('insert into settings (key, value) values ($1,$2)', [r.key, r.value]);
  };
  const DEF = { enabled: true, points_per_real: 1, block_points: 100, block_value_cents: 1000 };
  await t('points_get: sem chaves = regra padrão (1 pt/R$ 1; 100 pts = R$ 10, ligado); staff lê; sem sessão 401; cardápio mostra a regra', async () => {
    try {
      await Q('delete from settings where key = any($1::text[])', [POINT_KEYS]);
      const r = await get(ST, 'points_get');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.points.rules, DEF);
      assert.deepEqual(r.json.points.defaults, DEF);
      assert.deepEqual(r.json.points.limits.block_value_cents, [100, 10000]);
      assert.deepEqual((await menuCall()).body.points, { enabled: true, pointsPerReal: 1, blockPoints: 100, blockValueCents: 1000 });
      assert.equal((await get(null, 'points_get')).status, 401);
      // valor estragado no banco: volta a regra padrão inteira
      await Q(`insert into settings (key, value) values ('points_block_points', 'abc'), ('points_per_real', '3')`);
      assert.deepEqual(await loyalty.getRules(sql), DEF);
    } finally { await restorePoints(); }
  });
  await t('points_save: só admin (staff 403, sem sessão 401); válida vale no painel, cardápio e saldo; audita antes -> depois', async () => {
    try {
      const nova = { enabled: true, points_per_real: 2, block_points: 50, block_value_cents: 500 };
      assert.equal((await post(ST, 'points_save', nova)).status, 403);
      assert.equal((await post(null, 'points_save', nova)).status, 401);
      const ok = await post(A, 'points_save', nova);
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.deepEqual(ok.json.points.rules, nova);
      assert.deepEqual((await get(A, 'points_get')).json.points.rules, nova);
      assert.deepEqual((await menuCall()).body.points, { enabled: true, pointsPerReal: 2, blockPoints: 50, blockValueCents: 500 });
      const keys = Object.fromEntries((await Q('select key, value from settings where key = any($1::text[])', [POINT_KEYS])).map(r => [r.key, r.value]));
      assert.deepEqual(keys, { points_enabled: '1', points_per_real: '2', points_block_points: '50', points_block_value_cents: '500' });
      const au = (await Q(`select action, detail from admin_audit where username = $1 and action = 'pontos_regra_alterada' order by id desc limit 1`, [adm.username]))[0];
      assert.ok(au, 'auditoria gravada');
      assert.match(au.detail, /-> ligado, 2 pt\/R\$ 1, 50 pts = 500 centavos$/);
      // desligar
      const off = await post(A, 'points_save', { ...nova, enabled: false });
      assert.equal(off.status, 200);
      assert.equal((await menuCall()).body.points.enabled, false);
      assert.equal((await loyalty.getRules(sql)).enabled, false);
    } finally { await restorePoints(); }
  });
  await t('points_save: inválidas -> 400 com mensagem e a regra não muda (negativo, zero, fração, texto, acima do limite, retorno > 50%)', async () => {
    try {
      const base = { enabled: true, points_per_real: 1, block_points: 100, block_value_cents: 1000 };
      assert.equal((await post(A, 'points_save', { ...base, block_points: 200 })).status, 200);
      const bads = [{}, { ...base, enabled: 'sim' }, { ...base, points_per_real: -1 }, { ...base, points_per_real: 0 }, { ...base, points_per_real: 1.5 },
        { ...base, points_per_real: 11 }, { ...base, block_points: '100' }, { ...base, block_points: 5 }, { ...base, block_points: 20000 },
        { ...base, block_value_cents: -500 }, { ...base, block_value_cents: 50 }, { ...base, block_value_cents: 10001 },
        { ...base, points_per_real: 10, block_points: 100, block_value_cents: 1000 }];
      for (const b of bads) {
        const r = await post(A, 'points_save', b);
        assert.equal(r.status, 400, JSON.stringify(b));
        assert.equal(r.json.code, 'invalid_rules');
        assert.ok(r.json.error && r.json.error.length > 10, 'mensagem em português');
      }
      assert.deepEqual((await get(A, 'points_get')).json.points.rules, { ...base, block_points: 200 }, 'erro não altera a regra');
      assert.equal((await get(A, 'points_save')).status, 405);
      assert.equal((await post(A, 'points_get', {})).status, 405);
    } finally { await restorePoints(); }
  });
  await t('regra nova não muda pontos já creditados; pedido aprovado depois usa a regra em vigor; desligado não credita', async () => {
    const cust = (await Q(`insert into customers (name, phone, password_hash, security_question, security_answer_hash) values ('ZZ-TESTE cliente pts', $1, 'x', 'prof_favorito', 'x') returning id`, ['+5511' + '9' + rnd().replace(/\D/g, '').padEnd(8, '2').slice(0, 8)]))[0];
    const mk = async (sub) => (await Q(`insert into orders (code, customer_id, customer_name, customer_phone, delivery_method, items, subtotal_cents, delivery_fee_cents, total_cents, payment_status, fulfillment_status)
      values ($1, $2, 'ZZ-TESTE pts', '11900000000', 'pickup', '[]'::jsonb, $3, 0, $3, 'approved', 'new') returning id`, ['ZZTPTS' + rnd().toUpperCase(), cust.id, sub]))[0];
    try {
      const o1 = await mk(3000);
      await loyalty.onPaymentStatus(sql, o1.id);
      assert.equal((await loyalty.getBalance(sql, cust.id)).balance, 30);
      assert.equal((await post(A, 'points_save', { enabled: true, points_per_real: 2, block_points: 50, block_value_cents: 500 })).status, 200);
      await loyalty.onPaymentStatus(sql, o1.id); // notificação repetida
      const o2 = await mk(3000);
      await loyalty.onPaymentStatus(sql, o2.id);
      const bal = await loyalty.getBalance(sql, cust.id);
      assert.equal(bal.balance, 30 + 60, 'o1 continua 30; o2 ganha 60 pela regra nova');
      assert.deepEqual([bal.points_per_real, bal.block_points, bal.block_value_cents, bal.points_enabled], [2, 50, 500, true]);
      assert.equal((await post(A, 'points_save', { enabled: false, points_per_real: 2, block_points: 50, block_value_cents: 500 })).status, 200);
      const o3 = await mk(3000);
      await loyalty.onPaymentStatus(sql, o3.id);
      assert.equal((await loyalty.getBalance(sql, cust.id)).balance, 90, 'desligado não credita');
    } finally {
      await restorePoints();
      await Q('delete from loyalty_ledger where customer_id = $1', [cust.id]);
      await Q('delete from orders where customer_id = $1', [cust.id]); // não pode sobrar para os testes de lista de pedidos
      await Q('delete from customers where id = $1', [cust.id]);
    }
  });

  console.log('\nO8: sinônimos e pausa em lote com prévia');
  const comp = (await Q(`insert into complements (name, price_cents, kind, active) values ('ZZ-TESTE Biscoito Oreo', 300, 'additional', true) returning id`))[0];
  await Q('insert into product_complements (product_id, complement_id, max_quantity) values ($1, $2, 1)', [prod.id, comp.id]);
  let synId;
  await t('sinônimos: sementes existem; salvar, editar, duplicado e inválidos; excluir', async () => {
    const list = (await get(A, 'synonyms')).json.synonyms;
    assert.ok(list.some(s => /oreo/i.test(s.canonical) || /oreo/i.test(s.synonym)));
    assert.ok(list.some(s => /morango/i.test(s.canonical + s.synonym)));
    const r = await post(A, 'synonym_save', { canonical: 'ZZ-TESTE leite ninho', synonym: 'ZZ-TESTE leite em pó' });
    assert.equal(r.status, 200); synId = r.json.synonym.id;
    assert.equal((await post(A, 'synonym_save', { id: synId, canonical: 'ZZ-TESTE leite ninho', synonym: 'ZZ-TESTE ninho' })).json.synonym.synonym, 'ZZ-TESTE ninho');
    assert.equal((await post(A, 'synonym_save', { canonical: 'ZZ-TESTE leite ninho', synonym: 'ZZ-TESTE ninho' })).status >= 400, true, 'par duplicado');
    for (const bad of [{ canonical: 'a', synonym: 'bb' }, { canonical: 'oreo', synonym: 'OREO' }, { canonical: 'ÓREO', synonym: 'oreo' }, { canonical: 'abc' }, {}, { canonical: 'x'.repeat(61), synonym: 'abc' }])
      assert.equal((await post(A, 'synonym_save', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post(A, 'synonym_delete', { id: synId })).status, 200);
    assert.equal((await post(A, 'synonym_delete', { id: synId })).status, 404);
  });
  await t('prévia: acha por sinônimo, sem acento, no nome, descrição e complemento; NÃO altera nada', async () => {
    const before = JSON.stringify([await Q('select id, paused from products order by id'), await Q('select product_id, complement_id, paused from product_complements order by 1,2')]);
    for (const term of ['oreo', 'ÓREO', 'biscoito oreo', 'Biscoito Óreo']) {
      const r = await post(A, 'pause_preview', { term });
      assert.equal(r.status, 200, term);
      assert.ok(r.json.products.some(p => p.id === prod.id && p.matched_in === 'descrição'), `${term}: produto pela descrição`);
      const c = r.json.complements.find(x => x.id === comp.id);
      assert.ok(c && c.links.some(l => l.product_id === prod.id && l.paused === false), `${term}: complemento e vínculo`);
      assert.ok(r.json.terms.includes('oreo') && r.json.terms.includes('biscoito oreo'), 'sinônimo expandido');
    }
    const m = await post(A, 'pause_preview', { term: 'morango' });
    assert.ok(m.json.products.some(p => p.id === prod.id), 'plural "morangos" casa com "morango"');
    assert.equal((await post(A, 'pause_preview', { term: 'ninho' })).json.products.some(p => p.id === prod.id), true, 'nome');
    assert.equal((await post(A, 'pause_preview', { term: 'xyzinexistente' })).json.summary.products, 0);
    assert.equal((await post(A, 'pause_preview', { term: 'a' })).status, 400);
    assert.equal(JSON.stringify([await Q('select id, paused from products order by id'), await Q('select product_id, complement_id, paused from product_complements order by 1,2')]), before, 'prévia não muda nada');
  });
  await t('aplicar: exige confirm:true, term e só pausa (retomar é por resume_*); pausa produto e vínculo escolhidos; só o que foi listado muda', async () => {
    const body = { term: 'ZZ-TESTE oreo', product_ids: [prod.id], links: [{ product_id: prod.id, complement_id: comp.id }] };
    await post(A, 'product_pause', { id: prod.id, paused: false });
    assert.equal((await post(A, 'pause_apply', body)).status, 400);
    assert.equal((await post(A, 'pause_apply', { ...body, confirm: 'true' })).status, 400);
    assert.equal((await post(A, 'pause_apply', { ...body, confirm: true, term: undefined })).status, 400, 'term obrigatório');
    assert.equal((await post(A, 'pause_apply', { ...body, confirm: true, paused: false })).status, 400, 'retomar não é por aqui');
    assert.equal((await Q('select paused from products where id = $1', [prod.id]))[0].paused, false);
    const r = await post(A, 'pause_apply', { ...body, confirm: true, pause_label: 'sem Oreo hoje' }); // pause_label ignorado (D6)
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual([r.json.products_changed, r.json.links_changed], [1, 1]);
    assert.ok(r.json.batch_id);
    const p = (await Q('select paused, pause_label from products where id = $1', [prod.id]))[0];
    assert.deepEqual([p.paused, p.pause_label], [true, null]);
    assert.equal((await Q('select paused from product_complements where product_id = $1 and complement_id = $2', [prod.id, comp.id]))[0].paused, true);
    const m = await menuCall();
    const pc = m.body.categories.flatMap(c => c.products).find(x => x.id === prod.id).complements.find(c => c.id === comp.id);
    assert.ok(pc && pc.unavailable === true, 'D5: complemento pausado continua no cardápio, marcado como indisponível');
    assert.equal((await post(A, 'pause_apply', { term: 'oreo', product_ids: [], links: [], confirm: true })).status, 400);
    assert.equal((await post(A, 'pause_apply', { term: 'oreo', product_ids: ['x'], confirm: true })).status, 400);
    const undo = await post(A, 'pause_undo', { batch_id: r.json.batch_id });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.equal((await Q('select paused from products where id = $1', [prod.id]))[0].paused, false);
    assert.equal((await Q('select paused from product_complements where product_id = $1 and complement_id = $2', [prod.id, comp.id]))[0].paused, false);
  });

  // Lotes por ingrediente: desfazer e reativar por termo (inclui os complementos do "monte seu copo", que são vínculos com grupo)
  const lot = {};
  lot.builder = (await Q(`insert into products (category_id, name, description, price_cents, active) values ($1, 'ZZ-TESTE Monte seu copo', 'Monte do seu jeito com zzmorango e zzoreo', 1800, true) returning id`, [cat.id]))[0];
  lot.group = (await Q(`insert into product_groups (product_id, key, label, min_choices, max_choices, sort_order) values ($1, 'zzfrutas', 'Frutas', 1, 2, 1) returning id`, [lot.builder.id]))[0];
  const mkComp = async name => (await Q(`insert into complements (name, price_cents, kind, active) values ($1, 0, 'additional', true) returning id`, [name]))[0];
  lot.mor = await mkComp('ZZ-TESTE zzmorango'); lot.ore = await mkComp('ZZ-TESTE zzoreo'); lot.gra = await mkComp('ZZ-TESTE zzgranola');
  for (const c of [lot.mor, lot.ore, lot.gra]) await Q('insert into product_complements (product_id, complement_id, max_quantity, group_id) values ($1, $2, 1, $3)', [lot.builder.id, c.id, lot.group.id]);
  await Q('insert into product_complements (product_id, complement_id, max_quantity) values ($1, $2, 1)', [prod.id, lot.mor.id]);
  lot.torta = (await Q(`insert into products (category_id, name, description, price_cents, active) values ($1, 'ZZ-TESTE Torta zzmorango zzoreo', '', 900, true) returning id`, [cat.id]))[0];
  lot.manual = (await Q(`insert into products (category_id, name, description, price_cents, active, paused, pause_label) values ($1, 'ZZ-TESTE Mousse zzmorango', '', 700, true, true, 'legado') returning id`, [cat.id]))[0];
  const link = (pid, cid) => ({ product_id: pid, complement_id: cid });
  const isPaused = async (pid, cid) => (await Q(cid ? 'select paused from product_complements where product_id = $1 and complement_id = $2' : 'select paused from products where id = $1', cid ? [pid, cid] : [pid]))[0].paused;
  let bMor, bOre;
  await t('lote: pausa por "zzmorango" grava o lote só com o que MUDOU (já pausado manualmente fica de fora); vale nos complementos do "monte seu copo"', async () => {
    const pv = await post(A, 'pause_preview', { term: 'zzmorango' });
    assert.ok(pv.json.products.some(x => x.id === lot.builder.id && x.builder === true), 'produto "monte seu..." marcado como builder');
    const c = pv.json.complements.find(x => x.id === lot.mor.id);
    assert.ok(c.links.some(l => l.product_id === lot.builder.id && l.group_label === 'Frutas'), 'vínculo informa o grupo');
    const r = await post(A, 'pause_apply', { term: 'zzmorango', confirm: true, pause_label: 'sem morango',
      product_ids: [lot.torta.id, lot.manual.id], links: [link(lot.builder.id, lot.mor.id), link(prod.id, lot.mor.id)] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.products_changed, r.json.links_changed, r.json.already_paused, r.json.shared_with_other_batches], [1, 2, 1, 0]);
    assert.equal(r.json.warnings, undefined, 'ainda sobram opções no grupo obrigatório');
    bMor = r.json.batch_id;
    const items = await Q('select product_id, complement_id, changed from ingredient_pause_items where batch_id = $1 order by id', [bMor]);
    assert.equal(items.length, 3); assert.ok(items.every(i => i.changed));
    assert.ok(!items.some(i => i.product_id === lot.manual.id), 'o que já estava pausado antes não entra no lote');
    assert.equal(await isPaused(lot.builder.id, lot.mor.id), true);
    const copo = (await menuCall()).body.categories.flatMap(x => x.products).find(x => x.id === lot.builder.id);
    assert.equal(copo.complements.find(c => c.id === lot.mor.id).unavailable, true, 'D5: opção pausada fica no "monte seu copo", marcada como indisponível');
    assert.ok(!copo.complements.find(c => c.id === lot.gra.id).unavailable, 'a outra opção segue disponível');
    assert.equal((await post(A, 'pause_apply', { term: 'zzmorango', confirm: true, product_ids: [lot.torta.id] })).json.batch_id, null, 'nada mudou: não cria lote vazio');
  });
  await t('lote: item já pausado por OUTRO lote aberto entra como compartilhado; aviso quando um grupo obrigatório fica sem opções', async () => {
    const r = await post(A, 'pause_apply', { term: 'zzoreo', confirm: true, product_ids: [lot.torta.id], links: [link(lot.builder.id, lot.ore.id)] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.products_changed, r.json.links_changed, r.json.shared_with_other_batches], [0, 1, 1]);
    bOre = r.json.batch_id; assert.ok(bOre && bOre !== bMor);
    assert.deepEqual((await Q('select changed from ingredient_pause_items where batch_id = $1 and product_id = $2 and complement_id is null', [bOre, lot.torta.id])).map(x => x.changed), [false]);
    const g = await post(A, 'pause_apply', { term: 'zzgranola', confirm: true, links: [link(lot.builder.id, lot.gra.id)] });
    assert.equal(g.status, 200);
    assert.equal(g.json.warnings.length, 1);
    assert.match(g.json.warnings[0].message, /Frutas.*obrigat/);
    assert.equal((await post(A, 'pause_undo', { batch_id: g.json.batch_id })).status, 200);
    assert.equal(await isPaused(lot.builder.id, lot.gra.id), false);
  });
  await t('reativar por termo: prévia não altera; mostra o que volta e o que fica pausado por outro lote; manual nunca volta', async () => {
    const snapshotItems = async () => JSON.stringify(await Q('select i.id, b.released_at from ingredient_pause_items i join ingredient_pause_batches b on b.id = i.batch_id order by i.id'));
    const before = await snapshotItems();
    const r = await post(A, 'resume_preview', { term: 'zzmorango' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.batches.map(b => b.id), [bMor]);
    assert.equal(r.json.will_resume.length, 2);
    assert.ok(r.json.will_resume.every(x => x.type === 'link'));
    const held = r.json.keep_paused.find(x => x.product_id === lot.torta.id);
    assert.deepEqual(held.held_by, ['zzoreo'], 'avisa que outro termo ainda segura o item');
    assert.ok(![...r.json.will_resume, ...r.json.keep_paused, ...r.json.already_active].some(x => x.product_id === lot.manual.id), 'pausa manual fora do lote não é tocada');
    assert.deepEqual([r.json.summary.resume, r.json.summary.keep_paused], [2, 1]);
    assert.equal(await snapshotItems(), before, 'prévia não muda nada');
    assert.equal((await post(A, 'resume_preview', { term: 'zzinexistente' })).json.batches.length, 0);
    assert.equal((await post(A, 'resume_preview', { term: 'a' })).status, 400);
    const cmd = await post(A, 'command', { text: 'voltou zzmorango' });
    assert.equal(cmd.json.kind, 'ingredient_resume', 'a caixa de comandos reaproveita o verbo de reativar');
    assert.deepEqual(cmd.json.apply, { a: 'resume_apply', body: { term: 'zzmorango', confirm: true } });
    assert.equal((await post(A, 'command', { text: 'reativar zzmorango' })).json.kind, 'ingredient_resume');
    assert.notEqual((await post(A, 'command', { text: 'voltou zzinexistente' })).json.kind, 'ingredient_resume');
  });
  await t('reativar por termo: confirmação obrigatória; volta só o que o lote pausou; o item de outro lote segue pausado', async () => {
    assert.equal((await post(A, 'resume_apply', { term: 'zzmorango' })).status, 400);
    assert.equal((await post(A, 'resume_apply', { term: 'zzinexistente', confirm: true })).status, 404);
    const r = await post(A, 'resume_apply', { term: 'zzmorango', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.products_resumed, r.json.links_resumed, r.json.batches_released], [0, 2, [bMor]]);
    assert.equal(await isPaused(lot.builder.id, lot.mor.id), false);
    assert.equal(await isPaused(prod.id, lot.mor.id), false);
    assert.equal(await isPaused(lot.torta.id), true, 'a torta ainda é segurada pelo lote do zzoreo');
    assert.equal(await isPaused(lot.manual.id), true, 'pausa manual continua');
    assert.equal(await isPaused(lot.builder.id, lot.ore.id), true);
    assert.ok((await Q('select released_at from ingredient_pause_batches where id = $1', [bMor]))[0].released_at);
    assert.equal((await post(A, 'resume_apply', { term: 'zzmorango', confirm: true })).status, 404, 'lote já liberado: nada a fazer');
    assert.deepEqual((await get(A, 'pause_batches')).json.batches.map(b => b.id).filter(id => id === bMor || id === bOre), [bOre], 'só o lote aberto aparece');
  });
  await t('reativar por sinônimo: "zzbiscoitinho" libera o lote do "zzoreo"; a torta volta (D6: sem restauração de etiqueta)', async () => {
    assert.equal((await post(A, 'synonym_save', { canonical: 'zzoreo', synonym: 'zzbiscoitinho' })).status, 200);
    const pv = await post(A, 'resume_preview', { term: 'zzbiscoitinho' });
    assert.deepEqual(pv.json.batches.map(b => b.id), [bOre]);
    assert.equal(pv.json.summary.keep_paused, 0);
    const r = await post(A, 'resume_apply', { term: 'zzbiscoitinho', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.products_resumed, r.json.links_resumed], [1, 1]);
    assert.equal(await isPaused(lot.torta.id), false);
    assert.equal((await Q('select pause_label from products where id = $1', [lot.torta.id]))[0].pause_label, null, 'nenhuma etiqueta é gravada');
    assert.equal(await isPaused(lot.builder.id, lot.ore.id), false);
    assert.equal(await isPaused(lot.manual.id), true);
    assert.equal((await Q('select pause_label from products where id = $1', [lot.manual.id]))[0].pause_label, 'legado', 'a coluna obsoleta fica intacta');
  });
  await t('desfazer lote: por batch_id logo após pausar; 2ª vez 409; inexistente 404; id inválido 400; respeita item segurado por outro lote', async () => {
    const a = await post(A, 'pause_apply', { term: 'zzmorango', confirm: true, product_ids: [lot.torta.id], links: [link(lot.builder.id, lot.mor.id)] });
    const b = await post(A, 'pause_apply', { term: 'zzoreo', confirm: true, product_ids: [lot.torta.id] });
    assert.deepEqual([a.json.products_changed, a.json.links_changed, b.json.products_changed, b.json.shared_with_other_batches], [1, 1, 0, 1]);
    const ub = await post(A, 'pause_undo', { batch_id: b.json.batch_id });
    assert.equal(ub.status, 200, JSON.stringify(ub.json));
    assert.deepEqual(ub.json.keep_paused.map(x => x.product_id), [lot.torta.id]);
    assert.deepEqual(ub.json.keep_paused[0].held_by, ['zzmorango']);
    assert.equal(await isPaused(lot.torta.id), true, 'o lote do morango ainda segura a torta');
    const ua = await post(A, 'pause_undo', { batch_id: a.json.batch_id });
    assert.equal(ua.status, 200);
    assert.deepEqual([ua.json.products_resumed, ua.json.links_resumed], [1, 1]);
    assert.equal(await isPaused(lot.torta.id), false); assert.equal(await isPaused(lot.builder.id, lot.mor.id), false);
    assert.equal((await post(A, 'pause_undo', { batch_id: a.json.batch_id })).status, 409);
    assert.equal((await post(A, 'pause_undo', { batch_id: 2147483000 })).status, 404);
    for (const v of [undefined, 'x', -1, 0, 1.5]) assert.equal((await post(A, 'pause_undo', { batch_id: v })).status, 400, String(v));
    assert.equal((await get(A, 'pause_undo')).status, 405);
    assert.equal(await isPaused(lot.manual.id), true, 'pausa manual intacta no fim');
  });
  await t('lote: item retomado à mão antes do desfazer não muda; vínculo removido não quebra; só login acessa', async () => {
    const a = await post(A, 'pause_apply', { term: 'zzmorango', confirm: true, links: [link(lot.builder.id, lot.mor.id), link(prod.id, lot.mor.id)] });
    assert.equal(a.json.links_changed, 2);
    await Q('update product_complements set paused = false where product_id = $1 and complement_id = $2', [prod.id, lot.mor.id]); // alguém reativou à mão
    await Q('delete from product_complements where product_id = $1 and complement_id = $2', [lot.builder.id, lot.mor.id]); // e outro vínculo foi removido
    const u = await post(A, 'pause_undo', { batch_id: a.json.batch_id });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.links_resumed, 0);
    assert.equal(u.json.summary.already_active, 1);
    assert.equal(await isPaused(prod.id, lot.mor.id), false);
    for (const [method, act] of [['POST', 'pause_apply'], ['POST', 'pause_undo'], ['POST', 'resume_preview'], ['POST', 'resume_apply'], ['GET', 'pause_batches']])
      assert.equal((method === 'POST' ? await post(null, act, {}) : await get(null, act)).status, 401, act);
    assert.equal((await get(ST, 'pause_batches')).status, 200, 'staff também usa');
  });

  console.log('\nO6/O7: pedidos, status e histórico');
  const mkOrder = async (label, { ageHours = 0, status = 'new', pay = 'approved', customerId = null } = {}) => (await Q(
    `insert into orders (code, public_code, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, delivery_fee_cents, total_cents,
                         payment_method, payment_status, fulfillment_status, customer_id, created_at)
     values ($1, $2, $3, '11900001111', 'pickup', 'Loja', '[]'::jsonb, 1000, 0, 1000, 'pix', $4, $5, $6, now() - ($7 || ' hours')::interval) returning id, code, public_code`,
    ['ZZP' + rnd().toUpperCase(), 'DG-' + String(Math.floor(Math.random() * 9000) + 1000), 'ZZ-TESTE ' + label, pay, status, customerId, String(ageHours)]))[0];
  const recent = await mkOrder('recente'), recentDone = await mkOrder('recente concluido', { status: 'completed' }), recentCancel = await mkOrder('recente cancelado', { status: 'cancelled' });
  const old1 = await mkOrder('antigo um', { ageHours: 30, status: 'completed' }), old2 = await mkOrder('antigo dois', { ageHours: 50, status: 'delivered' }), old3 = await mkOrder('antigo tres', { ageHours: 100, status: 'cancelled' });
  const ids = r => r.json.orders.map(o => o.id);
  await t('lista: só pedidos com menos de 24 h, de todos os status (concluído e cancelado inclusos)', async () => {
    const l = await get(A, 'orders', { s: 'zz-teste' });
    assert.equal(l.status, 200);
    assert.deepEqual(ids(l).sort(), [recent.id, recentDone.id, recentCancel.id].sort());
    assert.ok(l.json.orders.every(o => 'public_code' in o && 'fulfillment_label' in o));
    assert.equal(l.json.orders.find(o => o.id === recentDone.id).fulfillment_label, 'concluído');
    assert.deepEqual(ids(await get(A, 'orders', { s: 'zz-teste', f: 'completed' })), [recentDone.id]);
    assert.deepEqual(ids(await get(A, 'orders', { s: recent.public_code })).includes(recent.id), true, 'busca pelo DG-####');
  });
  await t('histórico: só > 24 h, filtros de data/status/busca e paginação com total', async () => {
    const h = await get(A, 'order_history', { s: 'zz-teste' });
    assert.equal(h.status, 200);
    assert.deepEqual(ids(h), [old1.id, old2.id, old3.id], 'mais recentes primeiro, sem os de menos de 24 h');
    assert.deepEqual([h.json.page, h.json.page_size, h.json.total, h.json.total_pages], [1, 20, 3, 1]);
    assert.deepEqual(ids(await get(A, 'order_history', { s: 'zz-teste', f: 'completed' })).sort(), [old1.id, old2.id].sort(), 'concluído inclui o valor antigo delivered');
    assert.deepEqual(ids(await get(A, 'order_history', { s: 'zz-teste', f: 'cancelled' })), [old3.id]);
    const p1 = await get(A, 'order_history', { s: 'zz-teste', page_size: '2', page: '1' }), p2 = await get(A, 'order_history', { s: 'zz-teste', page_size: '2', page: '2' }), p9 = await get(A, 'order_history', { s: 'zz-teste', page_size: '2', page: '9' });
    assert.deepEqual([ids(p1).length, ids(p2).length, ids(p9).length], [2, 1, 0]);
    assert.deepEqual([p1.json.total, p1.json.total_pages, p9.json.total, p9.json.total_pages], [3, 2, 3, 2]);
    assert.deepEqual(ids(p1).concat(ids(p2)), [old1.id, old2.id, old3.id], 'sem repetir nem pular');
    const day = d => new Date(Date.now() - d * 3600e3).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const byDate = await get(A, 'order_history', { s: 'zz-teste', from: day(50), to: day(50) });
    const sameDay = [[old1, 30], [old2, 50], [old3, 100]].filter(([, h]) => day(h) === day(50)).map(([o]) => o.id).sort();
    assert.ok(sameDay.includes(old2.id));
    assert.deepEqual(ids(byDate).sort(), sameDay, 'faixa de datas no horário de São Paulo (dia de 50 h atrás)');
    assert.deepEqual(ids(await get(A, 'order_history', { s: 'zz-teste', from: day(0) })), [], 'a partir de hoje: nada com mais de 24 h');
    for (const bad of [{ from: '2026-13-01' }, { from: 'ontem' }, { to: '10/11/2026' }]) assert.equal((await get(A, 'order_history', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await get(A, 'order_history', { page_size: '5000', s: 'zz-teste' })).json.page_size, 100, 'limite do tamanho da página');
    assert.equal((await get(A, 'order_history', { page: '-3', page_size: 'x', s: 'zz-teste' })).status, 200);
    assert.equal((await get(null, 'order_history')).status, 401);
  });
  await t('status: só avança (aceito -> em preparo -> pronto -> aguardando entrega -> concluído); voltar -> 409; cancelar vale até concluir', async () => {
    const o = await mkOrder('fluxo');
    for (const s of ['accepted', 'preparing', 'ready', 'awaiting_delivery', 'completed']) {
      const r = await post(A, 'order_status', { id: o.id, status: s });
      assert.equal(r.status, 200, s + JSON.stringify(r.json)); assert.equal(r.json.order.fulfillment_status, s);
    }
    const row = (await Q('select accepted_at, preparing_at, ready_at, awaiting_delivery_at, completed_at from orders where id = $1', [o.id]))[0];
    assert.ok(Object.values(row).every(v => v), 'carimbo de hora por etapa: ' + JSON.stringify(row));
    assert.equal((await post(A, 'order_status', { id: o.id, status: 'preparing' })).status, 409);
    assert.equal((await post(A, 'order_status', { id: o.id, status: 'cancelled' })).status, 409, 'concluído não cancela');
    assert.equal((await post(A, 'order_status', { id: o.id, status: 'completed' })).status, 200, 'repetir o mesmo status não muda nada');
    const p = await mkOrder('pula etapa');
    assert.equal((await post(A, 'order_status', { id: p.id, status: 'ready' })).status, 200, 'pode pular etapas para a frente');
    assert.equal((await post(A, 'order_status', { id: p.id, status: 'new' })).status, 409);
    assert.equal((await post(A, 'order_status', { id: p.id, status: 'delivered' })).json.order.fulfillment_status, 'completed', 'delivered antigo vira completed');
    const c = await mkOrder('cancela');
    const cr = await post(A, 'order_status', { id: c.id, status: 'cancelled', reason: 'cliente desistiu' });
    assert.equal(cr.status, 200);
    const crow = (await Q('select cancelled_at, cancel_reason from orders where id = $1', [c.id]))[0];
    assert.ok(crow.cancelled_at); assert.equal(crow.cancel_reason, 'cliente desistiu');
    assert.equal((await post(A, 'order_status', { id: c.id, status: 'accepted' })).status, 409);
    assert.equal((await post(A, 'order_status', { id: o.id, status: 'pronto' })).status, 400);
    assert.equal((await post(A, 'order_status', { id: 2147483000, status: 'accepted' })).status, 404);
    assert.equal((await Q(`select count(*)::int n from admin_audit where username = $1 and action = 'pedido_status'`, [adm.username]))[0].n >= 6, true);
  });
  await t('pronto há mais de 1 h aparece como concluído na lista do painel (sem cron)', async () => {
    const o = await mkOrder('auto', { status: 'ready' });
    await Q(`update orders set ready_at = now() - interval '2 hours' where id = $1`, [o.id]);
    const l = await get(A, 'orders', { s: 'zz-teste auto' });
    assert.equal(l.json.orders[0].fulfillment_status, 'completed');
  });
  await t('cancelar pedido pago com pontos reservados devolve os pontos; pedido já aprovado não devolve', async () => {
    const cust = (await Q(`insert into customers (name, phone, password_hash, security_question, security_answer_hash) values ('ZZ-TESTE cliente pn', $1, 'x', 'prof_favorito', 'x') returning id`, ['+5511' + '9' + rnd().replace(/\D/g, '').padEnd(8, '1').slice(0, 8)]))[0];
    await loyalty.adjust(sql, { customerId: cust.id, points: 300, note: 'teste' });
    const o = await mkOrder('com pontos', { pay: 'pending', customerId: cust.id });
    await Q('update orders set points_redeemed = 200, discount_cents = 2000 where id = $1', [o.id]);
    assert.equal(await loyalty.reserve(sql, { customerId: cust.id, orderId: o.id, points: 200 }), true);
    assert.equal((await loyalty.getBalance(sql, cust.id)).balance, 100);
    assert.equal((await post(A, 'order_status', { id: o.id, status: 'cancelled', reason: 'teste' })).status, 200);
    assert.equal((await loyalty.getBalance(sql, cust.id)).balance, 300, 'reserva devolvida');
    const o2 = await mkOrder('aprovado', { pay: 'pending', customerId: cust.id });
    await Q('update orders set points_redeemed = 100, discount_cents = 1000 where id = $1', [o2.id]);
    await loyalty.reserve(sql, { customerId: cust.id, orderId: o2.id, points: 100 });
    await Q(`update orders set payment_status = 'approved' where id = $1`, [o2.id]);
    await loyalty.onPaymentStatus(sql, o2.id);
    const bal = (await loyalty.getBalance(sql, cust.id)).balance;
    await post(A, 'order_status', { id: o2.id, status: 'cancelled' });
    assert.equal((await loyalty.getBalance(sql, cust.id)).balance, bal, 'pedido pago: cancelar não devolve os pontos já gastos');
  });
  await t('endpoints novos exigem sessão; GET/POST trocados -> 405; admin-only continua restrito', async () => {
    for (const a of ['order_history', 'store_hours', 'store_state', 'shipping_get', 'synonyms', 'security_status']) assert.equal((await get(null, a)).status, 401, a);
    for (const a of ['product_pause', 'pause_default_label', 'store_hours_save', 'store_close', 'store_reopen', 'shipping_save', 'synonym_save', 'synonym_delete', 'pause_preview', 'pause_apply', 'security_setup', 'recovery_codes_new', 'order_status'])
      assert.equal((await post(null, a, {})).status, 401, a);
    assert.equal((await post(A, 'store_hours', {})).status, 405);
    assert.equal((await get(A, 'product_pause')).status, 405);
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (snap) await restore(snap).catch(e => console.error('falha ao restaurar:', e.message));
    await cleanup().catch(e => console.error('falha na limpeza:', e.message));
    process.exit();
  });
