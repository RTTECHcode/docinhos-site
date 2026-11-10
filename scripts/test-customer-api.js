// Teste do handler real de /api/customer (conta do cliente, A10) contra o banco de DESENVOLVIMENTO.
// Uso: node -r ./scripts/dev-env.js scripts/test-customer-api.js
// Telefones de teste 1190000xxxx, clientes "ZZ-a10 ...", pedidos "ZZ-a10 pedido". Tudo é apagado no começo e no fim.
const assert = require('node:assert/strict');
const sql = require('../api/_lib/db');
const handler = require('../api/customer');
const customerLib = require('../api/_lib/customer');

const Q = (text, params = []) => sql.query(text, params);
const HOST = 'loja.teste';
const ORIGIN = `https://${HOST}`;
let ipN = 0;
const nextIp = () => `198.19.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
let phoneN = 0;
const newPhone = () => `1190000${String(Math.floor(Math.random() * 90) + 10)}${String(++phoneN).padStart(2, '0')}`.slice(0, 11);
const PASS = 'SenhaBoa-123', ANS = 'Dona Maria';

function run(req) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(text) { let body = null; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: this.statusCode, body, headers }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
function req(method, action, { body, cookie, ip, origin = ORIGIN, type = 'application/json', extra = {}, query = '' } = {}) {
  const headers = { host: HOST, 'x-forwarded-for': ip || nextIp(), 'user-agent': 'teste-a10', ...extra };
  if (method === 'POST') { if (origin) headers.origin = origin; if (type) headers['content-type'] = type; headers['sec-fetch-site'] = headers['sec-fetch-site'] || 'same-origin'; }
  if (cookie) headers.cookie = cookie;
  return { method, url: `/api/customer?a=${action}${query}`, headers, body };
}
const get = (action, o) => run(req('GET', action, o));
const post = (action, body, o = {}) => run(req('POST', action, { ...o, body }));
const cookieOf = r => { const sc = r.headers['set-cookie']; return sc ? sc.split(';')[0] : null; };
const reg = (over = {}, o = {}) => post('register', { name: 'ZZ-a10 Cliente', phone: newPhone(), password: PASS, security_question: 'prof_favorito', security_answer: ANS, consent_version: customerLib.CONSENT_VERSION, ...over }, o);
// Falhas antigas inseridas direto no banco, espaçadas de 2 h (nunca 5 em 30 min): testa a regra de 10 erros em 24 h (do par telefone+IP).
const OLD_IP = '198.19.249.1';
const oldFails = (scope, phoneE164, n, ip = OLD_IP) => Q(
  `insert into customer_login_attempts (scope, phone, ip, ok, at)
   select $1, $2, $4, false, now() - interval '1 minute' - (g * interval '2 hours') from generate_series(0, $3::int - 1) g`, [scope, phoneE164, n, ip]);
// Ataque espalhado: n erros recentes (5 min atrás) no telefone, cada um de um IP diferente.
const spreadFails = (scope, phoneE164, n) => Q(
  `insert into customer_login_attempts (scope, phone, ip, ok, at)
   select $1, $2, '198.19.248.' || g, false, now() - interval '5 minutes' from generate_series(1, $3::int) g`, [scope, phoneE164, n]);

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').slice(0, 4).join(' | ')); process.exitCode = 1; }
}

async function cleanup() {
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like 'ZZ-a10%')`);
  await Q(`delete from orders where customer_name like 'ZZ-a10%'`);
  await Q(`delete from customers where name like 'ZZ-a10%'`); // sessões e eventos de consentimento saem em cascata
  await Q(`delete from customer_login_attempts where ip like '198.19.%' or phone like '+551190000%' or phone like '#senha:+551190000%'`);
}

(async () => {
  await cleanup();
  const SQL_FILE = require('node:fs').readFileSync(require.resolve('../api/customer.js'), 'utf8');

  console.log('\nHTTP básico');
  await t('métodos: PUT/DELETE = 405; GET em ação POST = 405; POST em ação GET = 405; ação desconhecida = 404; tudo com no-store', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) { const r = await run({ method: m, url: '/api/customer?a=me', headers: { host: HOST } }); assert.equal(r.status, 405); assert.equal(r.headers['cache-control'], 'no-store'); }
    assert.equal((await get('login')).status, 405);
    assert.equal((await post('me', {})).status, 405);
    assert.equal((await post('orders', {})).status, 405);
    const r404 = await get('nada'); assert.equal(r404.status, 404); assert.equal(r404.headers['cache-control'], 'no-store');
    assert.equal((await get('constructor')).status, 404, 'sem herdar propriedades de Object');
  });
  await t('questions: lista fixa + texto e versão do consentimento (a caixa nunca vem marcada: só o texto)', async () => {
    const r = await get('questions');
    assert.equal(r.status, 200);
    assert.ok(r.body.questions.length >= 5 && r.body.questions.every(q => q.id && q.text));
    assert.equal(r.body.consent.text, customerLib.CONSENT_TEXT);
    assert.equal(r.body.consent.version, customerLib.CONSENT_VERSION);
  });
  await t('me sem sessão: { logged_in: false } exato', async () => {
    const r = await get('me');
    assert.equal(r.status, 200); assert.deepEqual(r.body, { logged_in: false });
  });

  console.log('\nCSRF');
  await t('POST com Origin errada = 403, sem Origin = 403, Sec-Fetch-Site cross-site = 403, sem JSON = 415', async () => {
    const phone = newPhone();
    const ok = { name: 'ZZ-a10 Csrf', phone, password: PASS, security_question: 'prof_favorito', security_answer: ANS };
    assert.equal((await post('register', ok, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('register', ok, { origin: null })).status, 403);
    assert.equal((await post('register', ok, { extra: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await post('login', { phone, password: PASS }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('logout', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('register', ok, { type: 'text/plain' })).status, 415);
    assert.equal((await post('register', ok, { type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await Q('select count(*)::int n from customers where phone = $1', ['+55' + phone]))[0].n, 0, 'nada foi criado');
    assert.equal((await post('register', 'texto', {})).status, 400);
  });

  console.log('\nCadastro');
  let A, aCookie;
  await t('cadastro sem consentimento: 201, cookie HttpOnly/Secure/Lax/Path=/ __Host-, whatsapp falso, nenhum evento, sem hash na resposta', async () => {
    const phone = newPhone();
    const r = await reg({ phone, name: 'ZZ-a10 Ana', email: 'zz-a10-ana@example.com', birth_day: 5, birth_month: 11 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sc = r.headers['set-cookie'];
    assert.match(sc, /^__Host-dg_cliente=[\w-]{30,};/);
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(sc.includes(part), part);
    assert.ok(!/Domain=/i.test(sc));
    assert.equal(r.body.whatsapp_consent, false);
    assert.ok(!JSON.stringify(r.body).includes('scrypt') && !JSON.stringify(r.body).includes(cookieOf(r).split('=')[1]), 'token só no cookie');
    const [c] = await Q('select id, whatsapp_consent, whatsapp_consent_at, birth_day, birth_month from customers where phone = $1', ['+55' + phone]);
    assert.equal(c.whatsapp_consent, false); assert.equal(c.whatsapp_consent_at, null); assert.equal(c.birth_day, 5);
    assert.equal((await Q('select count(*)::int n from customer_consent_events where customer_id = $1', [c.id]))[0].n, 0);
    A = { phone, id: c.id }; aCookie = cookieOf(r);
  });
  await t('cadastro com consentimento true: grava texto, versão, IP e evento opt_in (origem cadastro)', async () => {
    const phone = newPhone(), ip = nextIp();
    const r = await reg({ phone, whatsapp_consent: true }, { ip });
    assert.equal(r.status, 201); assert.equal(r.body.whatsapp_consent, true);
    const [c] = await Q('select id, whatsapp_consent, whatsapp_consent_text, whatsapp_consent_version, whatsapp_consent_ip from customers where phone = $1', ['+55' + phone]);
    assert.equal(c.whatsapp_consent, true); assert.equal(c.whatsapp_consent_text, customerLib.CONSENT_TEXT);
    assert.equal(c.whatsapp_consent_version, customerLib.CONSENT_VERSION); assert.equal(c.whatsapp_consent_ip, ip);
    const ev = await Q('select action, source, text_version from customer_consent_events where customer_id = $1', [c.id]);
    assert.equal(ev.length, 1); assert.equal(ev[0].action, 'opt_in'); assert.equal(ev[0].source, 'cadastro'); assert.equal(ev[0].text_version, customerLib.CONSENT_VERSION);
  });
  await t('consentimento "true" como TEXTO ou número não vale (só boolean true): cria sem consentimento', async () => {
    for (const v of ['true', 1, 'on', 'sim']) {
      const phone = newPhone();
      const r = await reg({ phone, whatsapp_consent: v });
      assert.equal(r.status, 201); assert.equal(r.body.whatsapp_consent, false);
      assert.equal((await Q('select whatsapp_consent from customers where phone = $1', ['+55' + phone]))[0].whatsapp_consent, false);
    }
  });
  await t('validações: telefone, nome, senha curta, resposta curta, pergunta fora da lista, aniversário inválido, e-mail inválido (400 em português)', async () => {
    for (const over of [{ phone: '123' }, { name: 'a' }, { password: '1234567' }, { security_answer: 'ab' }, { security_question: 'qual_seu_nome' }, { birth_day: 31, birth_month: 2 }, { birth_day: 3 }, { email: 'nao-e-email' }]) {
      const r = await reg(over); assert.equal(r.status, 400, JSON.stringify(over) + ' -> ' + JSON.stringify(r.body)); assert.ok(r.body.error && !/\bat\s+\w+.*\(/i.test(r.body.error));
    }
  });
  await t('telefone duplicado = 409 sem criar outra conta', async () => {
    const r = await reg({ phone: A.phone });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'duplicate');
    assert.equal((await Q('select count(*)::int n from customers where phone = $1', ['+55' + A.phone]))[0].n, 1);
  });
  await t('[item 1] duplicado (telefone ou e-mail) = 409 SEM calcular scrypt', async () => {
    const authLib = require('../api/_lib/auth');
    const orig = authLib.hashPassword; let calls = 0;
    authLib.hashPassword = async (...a) => { calls++; return orig(...a); };
    let r1, r2;
    try {
      r1 = await reg({ phone: A.phone });
      r2 = await reg({ email: 'ZZ-A10-ANA@example.com' });
    } finally { authLib.hashPassword = orig; }
    assert.equal(r1.status, 409); assert.equal(r1.body.code, 'duplicate');
    assert.equal(r2.status, 409); assert.equal(r2.body.code, 'duplicate');
    assert.equal(calls, 0, 'nenhum hash calculado');
  });
  await t('[item 1] limite de cadastro por IP: 15 TENTATIVAS/h (400 e 409 contam); a 16ª = 429; barrada não grava; outro IP livre', async () => {
    const ip = '198.19.250.250';
    for (let i = 0; i < 10; i++) assert.equal((await reg({ phone: '123' }, { ip })).status, 400);
    for (let i = 0; i < 4; i++) assert.equal((await reg({ phone: A.phone }, { ip })).status, 409);
    assert.equal((await reg({}, { ip })).status, 201, 'a 15ª tentativa ainda passa');
    const r = await reg({}, { ip });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'locked');
    assert.equal((await reg({ phone: A.phone }, { ip })).status, 429, 'duplicado também barrado');
    assert.equal((await Q(`select count(*)::int n from customer_login_attempts where scope = 'register' and ip = $1`, [ip]))[0].n, 15);
    assert.equal((await Q(`select count(*)::int n from customer_login_attempts where phone like '#%' and ip = $1`, [ip]))[0].n, 0, 'sem chave falsa nova');
    assert.equal((await reg({}, { ip: nextIp() })).status, 201, 'outro IP segue livre');
  });
  await t('[item 1] tentativas de cadastro não contam como erro de login do IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < 6; i++) await reg({ phone: '123' }, { ip });
    assert.equal((await post('login', { phone: A.phone, password: PASS }, { ip })).status, 200);
  });

  console.log('\nSessão: me / logout');
  await t('me com sessão: formato EXATO do contrato com a loja', async () => {
    const r = await get('me', { cookie: aCookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { logged_in: true, customer: { name: 'ZZ-a10 Ana', points: { balance: 0, locked_until: null } } });
  });
  await t('login errado (senha e telefone inexistente): 401 com a mesma mensagem genérica, sem cookie', async () => {
    const r1 = await post('login', { phone: A.phone, password: 'errada-123' });
    const r2 = await post('login', { phone: newPhone(), password: 'errada-123' });
    assert.equal(r1.status, 401); assert.equal(r2.status, 401);
    assert.equal(r1.body.error, r2.body.error); assert.deepEqual(r1.body, r2.body);
    assert.ok(!r1.headers['set-cookie']);
  });
  await t('login certo (com máscara no telefone): 200 + cookie novo; me mostra o nome', async () => {
    const masked = `(${A.phone.slice(0, 2)}) ${A.phone.slice(2, 7)}-${A.phone.slice(7)}`;
    const r = await post('login', { phone: masked, password: PASS });
    assert.equal(r.status, 200); assert.equal(r.body.customer.name, 'ZZ-a10 Ana');
    assert.match(r.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000/);
    const me = await get('me', { cookie: cookieOf(r) });
    assert.equal(me.body.logged_in, true);
  });
  await t('logout: limpa o cookie (Max-Age=0) e a sessão deixa de valer no servidor', async () => {
    const l = await post('login', { phone: A.phone, password: PASS });
    const ck = cookieOf(l);
    const out = await post('logout', {}, { cookie: ck });
    assert.equal(out.status, 200); assert.match(out.headers['set-cookie'], /^__Host-dg_cliente=;.*Max-Age=0/);
    assert.deepEqual((await get('me', { cookie: ck })).body, { logged_in: false });
  });
  await t('ações de conta sem sessão: 401 login_required (profile, orders, points, consent, password)', async () => {
    for (const a of ['profile', 'orders', 'points']) { const r = await get(a); assert.equal(r.status, 401); assert.equal(r.body.code, 'login_required'); }
    assert.equal((await post('consent', { whatsapp_consent: true })).status, 401);
    assert.equal((await post('password', { current_password: PASS, new_password: 'NovaSenha-123' })).status, 401);
    assert.equal((await get('orders', { cookie: '__Host-dg_cliente=token-falso' })).status, 401);
  });

  console.log('\nBloqueio de login');
  await t('[A2] 5 erros de senha = bloqueio 429 (30 min) do PAR telefone+IP; senha certa também barrada nesse IP; outro IP e outra conta livres', async () => {
    const phone = newPhone(); const ip = nextIp();
    assert.equal((await reg({ phone, name: 'ZZ-a10 Lock' })).status, 201);
    let last;
    for (let i = 0; i < 5; i++) last = await post('login', { phone, password: 'errada-123' }, { ip });
    assert.equal(last.status, 429); assert.match(last.body.error, /30 minutos/); assert.equal(last.body.code, 'locked');
    assert.equal((await post('login', { phone, password: PASS }, { ip })).status, 429, 'certa mas bloqueada (mesmo IP)');
    assert.equal((await post('login', { phone, password: PASS }, { ip: nextIp() })).status, 200, 'par diferente: o dono entra de outro IP');
    assert.equal((await post('login', { phone, password: PASS }, { ip })).status, 429, 'o acerto em outro IP não solta o par travado');
    assert.equal((await post('login', { phone: A.phone, password: PASS })).status, 200, 'outra conta livre');
  });
  await t('[A2] ataque espalhado: 10 erros no telefone em 1 h (IPs variados) barram IPs que nunca entraram; IP onde o cliente já entrou segue livre', async () => {
    const phone = newPhone(), home = nextIp();
    assert.equal((await reg({ phone, name: 'ZZ-a10 Spread' })).status, 201);
    assert.equal((await post('login', { phone, password: PASS }, { ip: home })).status, 200, 'login certo: IP conhecido');
    await spreadFails('login', '+55' + phone, customerLib.SPREAD_MAX_FAILS);
    const fresh = await post('login', { phone, password: PASS }, { ip: nextIp() });
    assert.equal(fresh.status, 429, 'IP novo barrado mesmo com a senha certa'); assert.equal(fresh.body.error, customerLib.MSG_LOCKED_LONG);
    assert.equal((await post('login', { phone, password: PASS }, { ip: home })).status, 200, 'IP conhecido entra');
    // recuperação: mesma regra, com a contagem própria do scope recover
    const pr = newPhone();
    assert.equal((await reg({ phone: pr, name: 'ZZ-a10 SpreadRec' })).status, 201);
    await spreadFails('recover', '+55' + pr, customerLib.SPREAD_MAX_FAILS);
    assert.equal((await post('recover', { phone: pr, answer: ANS, new_password: 'NovaSenha-123' }, { ip: nextIp() })).status, 429, 'recuperação: IP novo barrado');
    const p9 = newPhone();
    assert.equal((await reg({ phone: p9, name: 'ZZ-a10 Spread9' })).status, 201);
    await spreadFails('login', '+55' + p9, customerLib.SPREAD_MAX_FAILS - 1);
    assert.equal((await post('login', { phone: p9, password: PASS }, { ip: nextIp() })).status, 200, '9 erros espalhados: IP novo ainda entra');
    // telefone inexistente: mesma resposta (não revela existência)
    const ghost = newPhone(); await spreadFails('login', '+55' + ghost, customerLib.SPREAD_MAX_FAILS);
    assert.deepEqual((await post('login', { phone: ghost, password: 'errada-123' }, { ip: nextIp() })).body, fresh.body);
  });
  await t('bloqueio por IP: 5 erros em telefones diferentes = 429 para o IP', async () => {
    const ip = nextIp(); let last;
    for (let i = 0; i < 5; i++) last = await post('login', { phone: newPhone(), password: 'errada-123' }, { ip });
    assert.equal(last.status, 429);
    assert.equal((await post('login', { phone: A.phone, password: PASS }, { ip })).status, 429);
  });
  await t('[item 2/A2] login: 10 erros em 24 h no par telefone+IP = bloqueio de 24 h (mensagem genérica); 9 erros não bloqueiam; outro IP livre', async () => {
    const p9 = newPhone();
    assert.equal((await reg({ phone: p9, name: 'ZZ-a10 Long9' })).status, 201);
    await oldFails('login', '+55' + p9, 9);
    assert.equal((await post('login', { phone: p9, password: PASS }, { ip: OLD_IP })).status, 200, '9 erros em 24 h: entra');
    const p10 = newPhone();
    assert.equal((await reg({ phone: p10, name: 'ZZ-a10 Long10' })).status, 201);
    await oldFails('login', '+55' + p10, 9);
    const tenth = await post('login', { phone: p10, password: 'errada-123' }, { ip: OLD_IP });
    assert.equal(tenth.status, 429); assert.equal(tenth.body.code, 'locked');
    assert.equal(tenth.body.error, customerLib.MSG_LOCKED_LONG); assert.ok(!/30 minutos|24|hora/.test(tenth.body.error), 'genérica');
    assert.equal((await post('login', { phone: p10, password: PASS }, { ip: OLD_IP })).status, 429, 'senha certa bloqueada no par');
    assert.equal((await post('login', { phone: p10, password: PASS }, { ip: nextIp() })).status, 200, 'outro IP: par diferente, entra');
    // telefone inexistente bloqueia do mesmo jeito (não revela existência)
    const ghost = newPhone(); await oldFails('login', '+55' + ghost, 9);
    const g = await post('login', { phone: ghost, password: 'errada-123' }, { ip: OLD_IP });
    assert.deepEqual(g.body, tenth.body);
  });

  console.log('\nRecuperação');
  await t('recover_question: conta real mostra a pergunta cadastrada; conta inexistente recebe pergunta da lista, estável e do mesmo formato', async () => {
    const real = await post('recover_question', { phone: A.phone });
    assert.equal(real.status, 200); assert.equal(real.body.question_id, 'prof_favorito');
    const ghost = newPhone();
    const g1 = await post('recover_question', { phone: ghost }), g2 = await post('recover_question', { phone: ghost });
    assert.equal(g1.status, 200); assert.deepEqual(g1.body, g2.body, 'estável');
    assert.deepEqual(Object.keys(g1.body).sort(), Object.keys(real.body).sort());
    assert.ok(customerLib.SECURITY_QUESTIONS.some(q => q.id === g1.body.question_id));
    assert.equal((await post('recover_question', { phone: '123' })).status, 400);
  });
  let R;
  await t('recuperação errada (conta real e conta inexistente): 400 com a MESMA mensagem; nenhuma sessão derrubada; sem trava de pontos', async () => {
    R = { phone: newPhone() }; R.cookie = cookieOf(await reg({ phone: R.phone, name: 'ZZ-a10 Rec' }));
    const a = await post('recover', { phone: R.phone, answer: 'resposta errada', new_password: 'NovaSenha-123' });
    const b = await post('recover', { phone: newPhone(), answer: 'resposta errada', new_password: 'NovaSenha-123' });
    assert.equal(a.status, 400); assert.deepEqual(a.body, b.body); assert.equal(a.body.code, 'bad_recovery');
    assert.equal((await get('me', { cookie: R.cookie })).body.logged_in, true);
    assert.equal((await Q('select points_locked_until from customers where phone = $1', ['+55' + R.phone]))[0].points_locked_until, null);
  });
  await t('recuperação certa (resposta com acento/maiúscula normalizada): ok, derruba sessões, troca senha, trava pontos 48 h', async () => {
    const r = await post('recover', { phone: R.phone, answer: '  DÔNA   maria ', new_password: 'NovaSenha-456' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true);
    const hours = (new Date(r.body.points_locked_until).getTime() - Date.now()) / 3600000;
    assert.ok(hours > 47.9 && hours <= 48.01, 'horas: ' + hours);
    const [c] = await Q('select points_locked_until from customers where phone = $1', ['+55' + R.phone]);
    assert.ok(new Date(c.points_locked_until).getTime() > Date.now() + 47 * 3600000);
    assert.equal((await get('me', { cookie: R.cookie })).body.logged_in, false, 'sessão antiga derrubada');
    assert.equal((await post('login', { phone: R.phone, password: PASS })).status, 401, 'senha antiga não vale');
    const l = await post('login', { phone: R.phone, password: 'NovaSenha-456' });
    assert.equal(l.status, 200);
    const me = await get('me', { cookie: cookieOf(l) });
    assert.ok(me.body.customer.points.locked_until, 'me mostra o bloqueio');
    const p = await get('points', { cookie: cookieOf(l) });
    assert.ok(p.body.locked_until);
  });
  await t('[A2] recuperação: 5 erros = bloqueio 429 do par telefone+IP, mesmo com a resposta certa depois; outro IP livre', async () => {
    const phone = newPhone(), ip = nextIp();
    assert.equal((await reg({ phone, name: 'ZZ-a10 RecLock' })).status, 201);
    let last;
    for (let i = 0; i < 5; i++) last = await post('recover', { phone, answer: 'errada ' + i, new_password: 'NovaSenha-123' }, { ip });
    assert.equal(last.status, 429); assert.match(last.body.error, /30 minutos/);
    assert.equal((await post('recover', { phone, answer: ANS, new_password: 'NovaSenha-123' }, { ip })).status, 429);
    assert.equal((await Q('select points_locked_until from customers where phone = $1', ['+55' + phone]))[0].points_locked_until, null);
    assert.equal((await post('recover', { phone, answer: ANS, new_password: 'NovaSenha-123' }, { ip: nextIp() })).status, 200, 'par diferente: outro IP recupera');
    // telefone inexistente também bloqueia do mesmo jeito (não revela existência)
    const ghost = newPhone(), ip2 = nextIp(); let g;
    for (let i = 0; i < 5; i++) g = await post('recover', { phone: ghost, answer: 'errada ' + i, new_password: 'NovaSenha-123' }, { ip: ip2 });
    assert.equal(g.status, 429);
  });
  await t('[item 2/A2] recuperação: 10 erros em 24 h no par telefone+IP = bloqueio de 24 h, mesmo com a resposta certa', async () => {
    const phone = newPhone(), ip = nextIp();
    assert.equal((await reg({ phone, name: 'ZZ-a10 RecLong' })).status, 201);
    await oldFails('recover', '+55' + phone, 9, ip);
    const tenth = await post('recover', { phone, answer: 'errada', new_password: 'NovaSenha-123' }, { ip });
    assert.equal(tenth.status, 429); assert.equal(tenth.body.error, customerLib.MSG_LOCKED_LONG);
    assert.equal((await post('recover', { phone, answer: ANS, new_password: 'NovaSenha-123' }, { ip })).status, 429);
    assert.equal((await Q('select points_locked_until from customers where phone = $1', ['+55' + phone]))[0].points_locked_until, null);
    assert.equal((await post('login', { phone, password: PASS }, { ip })).status, 200, 'login tem contagem própria');
  });
  await t('recuperação: senha nova curta = 400 sem gastar tentativa de resposta', async () => {
    const r = await post('recover', { phone: A.phone, answer: ANS, new_password: '123' });
    assert.equal(r.status, 400);
  });

  console.log('\nDados: consentimento e senha');
  let B, bCookie;
  await t('consent: ligar/desligar grava eventos opt_in/opt_out (origem conta); repetir não grava; valor não booleano = 400', async () => {
    B = { phone: newPhone() }; const r = await reg({ phone: B.phone, name: 'ZZ-a10 Bia' }); bCookie = cookieOf(r);
    B.id = (await Q('select id from customers where phone = $1', ['+55' + B.phone]))[0].id;
    const V = customerLib.CONSENT_VERSION;
    const on = await post('consent', { whatsapp_consent: true, consent_version: V }, { cookie: bCookie });
    assert.equal(on.status, 200); assert.equal(on.body.customer.whatsapp_consent, true);
    assert.equal((await post('consent', { whatsapp_consent: true, consent_version: V }, { cookie: bCookie })).status, 200);
    const off = await post('consent', { whatsapp_consent: false }, { cookie: bCookie });
    assert.equal(off.body.customer.whatsapp_consent, false); assert.ok(off.body.customer.whatsapp_opt_out_at);
    const ev = await Q('select action, source from customer_consent_events where customer_id = $1 order by id', [B.id]);
    assert.deepEqual(ev.map(e => e.action), ['opt_in', 'opt_out']); assert.ok(ev.every(e => e.source === 'conta'));
    for (const v of ['true', 1, null, undefined]) assert.equal((await post('consent', { whatsapp_consent: v }, { cookie: bCookie })).status, 400);
    assert.equal((await post('consent', { whatsapp_consent: true, consent_version: V }, { cookie: bCookie, origin: 'https://evil.example' })).status, 403);
  });
  await t('[item 5] consent_version: aceite com versão velha/ausente = 409 consent_outdated (cadastro e conta), sem gravar nada; desmarcar nunca é barrado', async () => {
    for (const v of ['v0-velha', undefined, 123]) {
      const phone = newPhone();
      const r = await reg({ phone, whatsapp_consent: true, consent_version: v });
      assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'consent_outdated');
      assert.equal((await Q('select count(*)::int n from customers where phone = $1', ['+55' + phone]))[0].n, 0);
    }
    assert.equal((await reg({ whatsapp_consent: false, consent_version: 'v0-velha' })).status, 201, 'sem aceite a versão não importa');
    const before = (await Q('select count(*)::int n from customer_consent_events where customer_id = $1', [B.id]))[0].n;
    const old = await post('consent', { whatsapp_consent: true, consent_version: 'v0-velha' }, { cookie: bCookie });
    assert.equal(old.status, 409); assert.equal(old.body.code, 'consent_outdated');
    assert.equal((await post('consent', { whatsapp_consent: true }, { cookie: bCookie })).status, 409, 'sem versão');
    assert.equal((await Q('select whatsapp_consent from customers where id = $1', [B.id]))[0].whatsapp_consent, false);
    assert.equal((await Q('select count(*)::int n from customer_consent_events where customer_id = $1', [B.id]))[0].n, before);
    assert.equal((await post('consent', { whatsapp_consent: true, consent_version: customerLib.CONSENT_VERSION }, { cookie: bCookie })).status, 200);
    const offOld = await post('consent', { whatsapp_consent: false, consent_version: 'v0-velha' }, { cookie: bCookie });
    assert.equal(offOld.status, 200); assert.equal(offOld.body.customer.whatsapp_consent, false);
  });
  await t('profile: dados próprios, sem hash, sem id interno', async () => {
    const r = await get('profile', { cookie: bCookie });
    assert.equal(r.status, 200); assert.equal(r.body.customer.name, 'ZZ-a10 Bia'); assert.equal(r.body.customer.phone, '+55' + B.phone);
    const txt = JSON.stringify(r.body); assert.ok(!/scrypt|password|answer_hash|"id"/.test(txt));
  });
  await t('password: senha atual errada = 400; certa troca, mantém esta sessão e derruba as outras', async () => {
    const other = cookieOf(await post('login', { phone: B.phone, password: PASS }));
    const bad = await post('password', { current_password: 'errada-123', new_password: 'Outra-Senha-1' }, { cookie: bCookie });
    assert.equal(bad.status, 400); assert.equal(bad.body.code, 'bad_password');
    assert.equal((await post('password', { current_password: PASS, new_password: 'curta' }, { cookie: bCookie })).status, 400);
    const ok = await post('password', { current_password: PASS, new_password: 'Outra-Senha-1' }, { cookie: bCookie });
    assert.equal(ok.status, 200);
    assert.equal((await get('me', { cookie: bCookie })).body.logged_in, true);
    assert.equal((await get('me', { cookie: other })).body.logged_in, false);
    assert.equal((await post('login', { phone: B.phone, password: PASS })).status, 401);
    assert.equal((await post('login', { phone: B.phone, password: 'Outra-Senha-1' })).status, 200);
  });
  await t('password: 5 senhas atuais erradas = 429', async () => {
    const phone = newPhone(); const ck = cookieOf(await reg({ phone, name: 'ZZ-a10 Pw' })); let last;
    for (let i = 0; i < 5; i++) last = await post('password', { current_password: 'errada-' + i + 'xx', new_password: 'Outra-Senha-1' }, { cookie: ck });
    assert.equal(last.status, 400);
    const blocked = await post('password', { current_password: PASS, new_password: 'Outra-Senha-1' }, { cookie: ck });
    assert.equal(blocked.status, 429);
  });
  await t('[item 3] password: contagem separada do login (troca bloqueada não trava o login; login bloqueado não trava a troca)', async () => {
    const p1 = newPhone(); const ck1 = cookieOf(await reg({ phone: p1, name: 'ZZ-a10 Sep1' }));
    for (let i = 0; i < 5; i++) await post('password', { current_password: 'errada-' + i + 'xx', new_password: 'Outra-Senha-1' }, { cookie: ck1 });
    assert.equal((await post('password', { current_password: PASS, new_password: 'Outra-Senha-1' }, { cookie: ck1 })).status, 429);
    assert.equal((await post('login', { phone: p1, password: PASS })).status, 200, 'login livre');
    assert.equal((await Q(`select count(*)::int n from customer_login_attempts where scope = 'login' and phone = $1 and ok = false`, ['+55' + p1]))[0].n, 0, 'nada no login');
    assert.equal((await Q(`select count(*)::int n from customer_login_attempts where scope = 'password' and phone = $1 and ok = false`, ['+55' + p1]))[0].n, 5, 'falhas no scope password');
    const p2 = newPhone(); const ck2 = cookieOf(await reg({ phone: p2, name: 'ZZ-a10 Sep2' }));
    const ip2 = nextIp();
    for (let i = 0; i < 5; i++) await post('login', { phone: p2, password: 'errada-123' }, { ip: ip2 });
    assert.equal((await post('login', { phone: p2, password: PASS }, { ip: ip2 })).status, 429, 'login bloqueado (par telefone+IP)');
    assert.equal((await post('password', { current_password: PASS, new_password: 'Outra-Senha-2' }, { cookie: ck2 })).status, 200, 'troca livre');
  });
  await t('[F5 scopes] linhas antigas (#cadastro e #senha:) continuam contando: bloqueios em curso não se perdem', async () => {
    const ip = nextIp();
    await Q(`insert into customer_login_attempts (scope, phone, ip, ok) select 'login', '#cadastro', $1, true from generate_series(1, 15)`, [ip]);
    const r = await reg({}, { ip });
    assert.equal(r.status, 429, 'cadastro barrado pelas linhas antigas');
    const p = newPhone(); const ck = cookieOf(await reg({ phone: p, name: 'ZZ-a10 Legado' }));
    await Q(`insert into customer_login_attempts (scope, phone, ip, ok) select 'login', $1, '198.19.249.2', false from generate_series(1, 5)`, ['#senha:+55' + p]);
    assert.equal((await post('password', { current_password: PASS, new_password: 'Outra-Senha-3' }, { cookie: ck })).status, 429, 'troca barrada pelas linhas antigas');
    assert.equal((await post('login', { phone: p, password: PASS })).status, 200, 'login segue livre');
  });

  console.log('\nPedidos e pontos (isolamento entre clientes)');
  let C, cCookie, D, dCookie;
  await t('orders e points: cada cliente vê só os seus (sem vazar pedido, código ou pontos do outro)', async () => {
    C = { phone: newPhone() }; cCookie = cookieOf(await reg({ phone: C.phone, name: 'ZZ-a10 Cida' }));
    D = { phone: newPhone() }; dCookie = cookieOf(await reg({ phone: D.phone, name: 'ZZ-a10 Davi' }));
    C.id = (await Q('select id from customers where phone = $1', ['+55' + C.phone]))[0].id;
    D.id = (await Q('select id from customers where phone = $1', ['+55' + D.phone]))[0].id;
    const items = JSON.stringify([{ product_id: 1, name: 'Brigadeiro ZZ', size: 'Grande', extras: [], qty: 2, unit_total_cents: 1000 }]);
    const mk = (code, pub, cust, status, pay) => Q(
      `insert into orders (code, public_code, customer_id, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, delivery_fee_cents, total_cents, payment_status, fulfillment_status)
       values ($1, $2, $3, 'ZZ-a10 pedido', '11900009999', 'delivery', 'Rua Secreta 123', $4::jsonb, 2000, 500, 2500, $5, $6) returning id`, [code, pub, cust, items, pay, status]);
    const [oC] = await mk('ZZA10C0000001', 'DG-9101', C.id, 'preparing', 'approved');
    await mk('ZZA10D0000001', 'DG-9102', D.id, 'new', 'pending');
    await Q(`insert into loyalty_ledger (customer_id, order_id, kind, points, note) values ($1, $2, 'earn', 20, 'pontos do pedido pago')`, [C.id, oC.id]);
    await Q(`insert into loyalty_ledger (customer_id, order_id, kind, points, note) values ($1, null, 'adjust', 5, 'bônus teste')`, [C.id]);

    const oc = await get('orders', { cookie: cCookie });
    assert.equal(oc.status, 200); assert.equal(oc.body.orders.length, 1);
    const o = oc.body.orders[0];
    assert.equal(o.public_code, 'DG-9101'); assert.equal(o.total_cents, 2500); assert.equal(o.fulfillment_label, 'em preparo'); assert.equal(o.payment_label, 'pago');
    assert.deepEqual(o.items_summary, ['2x Brigadeiro ZZ (Grande)']); assert.equal(o.tracking_url, null);
    const txt = JSON.stringify(oc.body); assert.ok(!txt.includes('DG-9102') && !txt.includes('Rua Secreta') && !txt.includes('11900009999') && !txt.includes('customer_phone'));
    const od = await get('orders', { cookie: dCookie });
    assert.deepEqual(od.body.orders.map(x => x.public_code), ['DG-9102']); assert.equal(od.body.orders[0].payment_label, 'aguardando pagamento');
    assert.ok(!JSON.stringify(od.body).includes('DG-9101'));

    const pc = await get('points', { cookie: cCookie });
    assert.equal(pc.status, 200); assert.equal(pc.body.balance, 25); assert.equal(pc.body.points_per_real, 1); assert.equal(pc.body.block_points, 100); assert.equal(pc.body.block_value_cents, 1000);
    assert.equal(pc.body.locked_until, null);
    const descs = pc.body.history.map(h => h.description);
    assert.ok(descs.includes('Pontos do pedido DG-9101 (pagamento aprovado)'), descs.join(' | '));
    assert.ok(descs.includes('Ajuste da loja: bônus teste'));
    assert.ok(pc.body.history.every(h => /[a-zç]/i.test(h.description) && !/earn|adjust|redeem/.test(h.description.replace('Ajuste da loja', ''))));
    const pd = await get('points', { cookie: dCookie });
    assert.equal(pd.body.balance, 0); assert.deepEqual(pd.body.history, []);
    assert.ok(!JSON.stringify(pd.body).includes('DG-9101'));
    assert.deepEqual((await get('me', { cookie: cCookie })).body.customer.points, { balance: 25, locked_until: null });
  });
  await t('orders: parâmetros limit/offset hostis não quebram nem vazam (limit negativo, texto, enorme)', async () => {
    for (const q of ['&limit=-5', '&limit=abc', '&limit=99999&offset=-1', '&offset=1e9', "&limit=1;drop table orders"]) {
      const r = await get('orders', { cookie: cCookie, query: q }); assert.equal(r.status, 200, q);
      assert.ok(r.body.orders.every(x => x.public_code === 'DG-9101'));
    }
  });
  await t('token de sessão de outro cliente não serve para ler dados alheios (cookie adulterado/truncado = 401)', async () => {
    const tok = cCookie.split('=')[1];
    assert.equal((await get('orders', { cookie: `__Host-dg_cliente=${tok.slice(0, -1)}x` })).status, 401);
    assert.equal((await get('orders', { cookie: `__Host-dg_cliente=${'a'.repeat(300)}` })).status, 401);
    assert.equal((await get('orders', { cookie: `dg_cliente=${tok}` })).status, 401, 'sem o prefixo __Host- não vale');
  });

  console.log('\nHigiene de erros e código');
  await t('[item 4] erro interno não vaza stack nem SQL (resposta 500 genérica); o log leva só o código', async () => {
    const orig = console.error, origQuery = sql.query;
    const logs = [];
    console.error = (...a) => logs.push(a.map(String).join(' '));
    let r, r2;
    try {
      sql.query = async () => { const e = new Error('select * from customers falhou em /srv/api/_lib/customer.js:99 +5511900001234'); e.code = 'XX000'; throw e; }; // simula falha do banco
      r = await run(req('GET', 'me', { cookie: '__Host-dg_cliente=abc' }));
      sql.query = async () => { throw new Error('falha com dado pessoal +5511900001234'); }; // sem código
      r2 = await run(req('GET', 'me', { cookie: '__Host-dg_cliente=abc' }));
    } finally { console.error = orig; sql.query = origQuery; }
    assert.equal(r.status, 500); assert.equal(r2.status, 500);
    assert.deepEqual(r.body, { error: 'Não foi possível concluir a operação.' });
    assert.deepEqual(logs, ['Erro na conta do cliente: XX000', 'Erro na conta do cliente: sem_codigo']);
  });
  await t('código: sem innerHTML/stack/segredos no handler; só SQL parametrizado', async () => {
    assert.ok(!/innerHTML|err\.stack|error\.stack|process\.env/.test(SQL_FILE));
  });

  await cleanup();
  const left = (await Q(`select (select count(*)::int from customers where name like 'ZZ-a10%') c, (select count(*)::int from orders where customer_name like 'ZZ-a10%') o`))[0];
  console.log(`\n${passed} testes ok. Sobras ZZ-a10: clientes=${left.c}, pedidos=${left.o}.`);
  if (left.c || left.o) process.exitCode = 1;
  if (process.exitCode) console.error('HÁ FALHAS');
  process.exit(process.exitCode || 0);
})().catch(async e => { console.error('ERRO', e && e.message); try { await cleanup(); } catch {} process.exit(1); });
