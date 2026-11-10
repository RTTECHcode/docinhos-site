// Testes do painel /admin: unitários (sem banco) + integração chamando o handler api/admin.js com req/res falsos.
// A integração usa o banco REAL: só cria linhas "ZZ-TESTE ..." / usuários "zz-teste-*" e apaga tudo no final,
// conferindo por snapshot que nada real mudou. As senhas dos usuários de teste são aleatórias (nunca impressas).
// Uso: set -a && . ./.env && set +a && node scripts/test-admin.js
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const admin = require('../api/admin');
const I = admin._internal;

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(name); const m = /test-admin\.js:(\d+)/.exec(String(e && e.stack)); console.log('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n')[0] + (m ? ' (linha ' + m[1] + ')' : '')); }
}
const rnd = () => crypto.randomBytes(9).toString('hex');
const throwsHttp = fn => assert.throws(fn, I.HttpError);

// ---------- req/res falsos ----------
const HOST = 'admin.test.local';
const ORIGIN = 'https://' + HOST;
function fakeReq(o) {
  const qs = new URLSearchParams({ a: o.action || '', ...(o.query || {}) }).toString();
  const method = o.method || 'GET';
  const headers = { host: o.host || HOST, 'x-forwarded-for': o.ip || '198.51.100.1', 'user-agent': 'test-admin' };
  if (method === 'POST') {
    if (o.origin !== null) headers.origin = o.origin || ORIGIN;
    headers['content-type'] = o.contentType || 'application/json';
  }
  if (o.cookie) headers.cookie = o.cookie;
  if (o.headers) Object.assign(headers, o.headers);
  return { method, url: '/api/admin?' + qs, headers, body: o.body, socket: { remoteAddress: '127.0.0.1' } };
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.end = chunk => { res.body = chunk === undefined ? '' : chunk; };
  return res;
}
async function call(o) {
  const res = fakeRes();
  await admin(fakeReq(o), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* corpo não-JSON */ }
  return { status: res.statusCode, json, headers: res.headers };
}
const get = (cookie, action, query, extra) => call({ action, cookie, query, ...(extra || {}) });
const post = (cookie, action, body, extra) => call({ method: 'POST', action, cookie, body: body === undefined ? {} : body, ...(extra || {}) });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------- unitários ----------
async function unit() {
  console.log('\nUnitários');
  await t('hash/verify scrypt (salt aleatório, senha errada falha)', async () => {
    const h = await I.hashPassword('senha-de-teste-1');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await I.verifyPassword('senha-de-teste-1', h), true);
    assert.equal(await I.verifyPassword('senha-de-teste-2', h), false);
    assert.notEqual(h, await I.hashPassword('senha-de-teste-1'));
  });
  await t('verify rejeita hash malformado ou com parâmetros absurdos', async () => {
    for (const bad of [undefined, '', 'abc', 'scrypt$3$8$1$AAAA$AAAA', 'scrypt$32768$8$1$AAAA', 'bcrypt$32768$8$1$AAAA$AAAA', 'scrypt$32768$8$1$AAAA$'])
      assert.equal(await I.verifyPassword('x', bad), false);
  });
  await t('bloqueio: 5 falhas em 15 min travam; menos de 5 ou espalhadas não', () => {
    const now = 1e12, m = 60000;
    const lock = f => I.evaluateLock({ failsMs: f, ipFails: 0, nowMs: now });
    assert.equal(lock([now - m, now - 2 * m, now - 3 * m, now - 4 * m, now - 5 * m]).locked, true);
    assert.equal(lock([now - m, now - 2 * m, now - 3 * m, now - 4 * m]).locked, false);
    assert.equal(lock([now - m, now - 5 * m, now - 10 * m, now - 16 * m, now - 20 * m]).locked, false);
    assert.equal(lock([now - 16 * m, now - 17 * m, now - 18 * m, now - 19 * m, now - 20 * m]).locked, false);
  });
  await t('bloqueio: 10 falhas em 24 h e limite de 20 falhas por IP', () => {
    const now = 1e12, h = 3600000;
    const ten = Array.from({ length: 10 }, (_, i) => now - (i + 1) * h);
    const r = I.evaluateLock({ failsMs: ten, ipFails: 0, nowMs: now });
    assert.equal(r.locked, true); assert.equal(r.reason, '24h'); assert.equal(r.until, now - 10 * h + 24 * h);
    const old = Array.from({ length: 10 }, (_, i) => now - (15 + i) * h);
    assert.equal(I.evaluateLock({ failsMs: old, ipFails: 0, nowMs: now }).locked, false);
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 20, nowMs: now }).locked, true);
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 19, nowMs: now }).locked, false);
  });
  await t('A1-04: ataque espalhado (30 falhas do usuário em 1 h) barra só IP desconhecido; IP conhecido segue livre', () => {
    const now = 1e12;
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 0, userFails: 30, knownIp: false, nowMs: now }).locked, true);
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 0, userFails: 30, knownIp: false, nowMs: now }).reason, 'spread');
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 0, userFails: 29, knownIp: false, nowMs: now }).locked, false);
    assert.equal(I.evaluateLock({ failsMs: [], ipFails: 0, userFails: 500, knownIp: true, nowMs: now }).locked, false);
  });
  await t('validadores: centavos, ids e inteiros', () => {
    assert.equal(I.vCents(0, 'x'), 0); assert.equal(I.vCents(1000000, 'x'), 1000000); assert.equal(I.vCents(null, 'x', true), null);
    for (const v of [-1, 1.5, '12', 1000001, NaN, null, undefined]) throwsHttp(() => I.vCents(v, 'x'));
    assert.equal(I.vId(1), 1); assert.equal(I.vId(2147483647), 2147483647);
    for (const v of [0, -1, '1', 1.2, 2147483648, null, {}]) throwsHttp(() => I.vId(v));
    assert.equal(I.vInt(5, 0, 10, 'x'), 5); throwsHttp(() => I.vInt(11, 0, 10, 'x')); throwsHttp(() => I.vInt('5', 0, 10, 'x'));
    assert.equal(I.vBool(true, 'x'), true); throwsHttp(() => I.vBool('true', 'x'));
    assert.equal(I.vEnum('size', ['size', 'additional'], 'x'), 'size'); throwsHttp(() => I.vEnum('drop', ['size', 'additional'], 'x'));
  });
  await t('validadores: textos, usuário, senha e chave', () => {
    assert.equal(I.vStr('  oi  ', 1, 10, 'x'), 'oi');
    throwsHttp(() => I.vStr('a' + String.fromCharCode(7) + 'b', 1, 10, 'x'));
    throwsHttp(() => I.vStr('a\nb', 1, 10, 'x')); assert.equal(I.vStr('a\nb', 1, 10, 'x', { multiline: true }), 'a\nb');
    throwsHttp(() => I.vStr('', 1, 10, 'x')); throwsHttp(() => I.vStr('x'.repeat(11), 1, 10, 'x')); throwsHttp(() => I.vStr(12, 1, 10, 'x'));
    assert.equal(I.vUsername(' Gigi '), 'gigi');
    for (const v of ['a b', 'ab', 'x'.repeat(33), '../x', null]) throwsHttp(() => I.vUsername(v));
    throwsHttp(() => I.vPassword('1234567')); assert.equal(I.vPassword('12345678'), '12345678'); throwsHttp(() => I.vPassword('x'.repeat(129))); throwsHttp(() => I.vPassword(12345678));
    assert.equal(I.vKey('Zz_Teste-1'), 'zz_teste-1'); throwsHttp(() => I.vKey('a b')); throwsHttp(() => I.vKey(''));
  });
  await t('imagem: assinatura (jpeg/png/webp/avif) e rejeições', () => {
    assert.equal(I.detectImage(Buffer.from(PNG_B64, 'base64')), 'image/png');
    assert.equal(I.detectImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])), 'image/jpeg');
    assert.equal(I.detectImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
    assert.equal(I.detectImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)])), 'image/avif');
    assert.equal(I.detectImage(Buffer.from('<svg xmlns="x"><script>alert(1)</script></svg>')), null);
    assert.equal(I.detectImage(Buffer.from('abc')), null);
    assert.equal(I.decodeImage(PNG_B64).mime, 'image/png');
    for (const v of ['', 'nao e base64!!!', Buffer.from('hello world hello world').toString('base64'), 'A'.repeat(2800001), 12345, null]) throwsHttp(() => I.decodeImage(v));
  });
  await t('CSRF: sameOrigin e Content-Type JSON', () => {
    const so = h => I.sameOrigin({ headers: h });
    assert.equal(so({ origin: 'https://a.com', host: 'a.com' }), true);
    assert.equal(so({ origin: 'https://a.com', host: 'a.com', 'sec-fetch-site': 'same-origin' }), true);
    for (const h of [{ origin: 'https://evil.com', host: 'a.com' }, { host: 'a.com' }, { origin: 'null', host: 'a.com' }, { origin: 'https://a.com.evil.com', host: 'a.com' },
      { origin: 'https://a.com:8443', host: 'a.com' }, { origin: 'https://a.com', host: 'a.com', 'sec-fetch-site': 'cross-site' }, { origin: 'https://a.com' }]) assert.equal(so(h), false);
    const js = ct => I.isJsonType({ headers: ct === undefined ? {} : { 'content-type': ct } });
    assert.equal(js('application/json'), true); assert.equal(js('application/json; charset=utf-8'), true);
    for (const ct of ['text/plain', 'application/jsonx', 'multipart/form-data', undefined]) assert.equal(js(ct), false);
  });
}

// ---------- parser de comandos (sem banco, sem IA) ----------
async function parserTests() {
  console.log('\nParser de comandos em português');
  const P = (id, name, active = true) => ({ id, name, active, category_id: 1 });
  const mk = (over = {}) => ({
    products: [P(1, 'Monte seu copo'), P(2, 'Geladinho Gourmet de Morango'), P(3, 'Geladinho Gourmet de Limão'),
      P(4, 'Geladinho Gourmet de Chocolate com Nutella'), P(5, 'Brigadeiros - Brigadeiro tradicional e Ninho'), P(6, 'Brigadeiros - Bicho de Pé, Ninho e Chocolate', false),
      P(7, 'Açaí 300ml - Monte Seu Copo')],
    complements: [P(10, 'Recheio de Kitkat'), P(11, 'Nutella'), P(12, 'Topping - Nutella'), P(13, 'Brigadeiro de Oreo', false),
      P(14, 'Brigadeiro de Chocolate'), P(15, 'Recheio de Bis', false), P(16, 'Paçoca'), P(17, 'Granola')],
    categories: [{ id: 1, name: 'Geladinhos Gourmet', active: true }, { id: 2, name: 'Açaí', active: true }, { id: 3, name: 'Brownies', active: false }],
    links: [{ product_id: 1, complement_id: 10, paused: false }, { product_id: 7, complement_id: 10, paused: false }, { product_id: 1, complement_id: 16, paused: true }],
    storePaused: false, ...over
  });
  const cat = mk();
  const run = text => I.parseCommand(text, cat);
  const names = r => (r.targets || r.candidates || []).map(x => x.name);

  await t('"pausar nutella" -> complemento Nutella (nome exato vence "Topping - Nutella")', () => {
    const r = run('pausar nutella');
    assert.equal(r.ok, true); assert.equal(r.targets.length, 1);
    assert.deepEqual([r.targets[0].type, r.targets[0].name, r.targets[0].from, r.targets[0].to], ['complement', 'Nutella', true, false]);
  });
  await t('"acabou o kitkat no monte seu copo" -> vínculo (só no produto)', () => {
    const r = run('acabou o kitkat no monte seu copo');
    assert.equal(r.ok, true); assert.equal(r.targets.length, 1);
    assert.equal(r.targets[0].type, 'link'); assert.equal(r.targets[0].productId, 1); assert.equal(r.targets[0].id, 10); assert.equal(r.targets[0].to, false);
  });
  await t('"pausar todos os geladinhos" -> todos os produtos geladinho (3), não a categoria', () => {
    const r = run('pausar todos os geladinhos');
    assert.equal(r.ok, true); assert.equal(r.targets.length, 3);
    assert.ok(r.targets.every(x => x.type === 'product' && /Geladinho/.test(x.name) && x.to === false));
  });
  await t('"reativar brigadeiro de oreo" -> reativa o complemento pausado', () => {
    const r = run('reativar brigadeiro de oreo');
    assert.equal(r.ok, true); assert.equal(r.targets.length, 1);
    assert.deepEqual([r.targets[0].name, r.targets[0].from, r.targets[0].to], ['Brigadeiro de Oreo', false, true]);
  });
  await t('"fechar a loja" pausa; "abrir a loja" reabre; já aberta => nada a mudar', () => {
    const a = run('fechar a loja');
    assert.deepEqual([a.ok, a.targets[0].type, a.targets[0].from, a.targets[0].to], [true, 'store', true, false]);
    const b = I.parseCommand('abrir a loja', mk({ storePaused: true }));
    assert.deepEqual([b.ok, b.targets[0].type, b.targets[0].to], [true, 'store', true]);
    const c = run('abrir a loja');
    assert.equal(c.ok, true); assert.equal(c.targets.length, 0);
  });
  await t('sinônimos de pausa: tirar / esgotou / desativar / fora', () => {
    for (const phrase of ['tirar o kitkat', 'esgotou kitkat', 'desativar kitkat', 'kitkat fora', 'ocultar kitkat']) {
      const r = run(phrase);
      assert.equal(r.ok, true, phrase); assert.equal(r.targets[0].name, 'Recheio de Kitkat', phrase); assert.equal(r.targets[0].to, false, phrase);
    }
  });
  await t('sinônimos de reativar: voltou / tem / liberar / ativar', () => {
    for (const phrase of ['voltou o bis', 'tem bis', 'liberar bis', 'ativar recheio de bis']) {
      const r = run(phrase);
      assert.equal(r.ok, true, phrase); assert.equal(r.targets[0].name, 'Recheio de Bis', phrase); assert.equal(r.targets[0].to, true, phrase);
    }
  });
  await t('acentos, caixa, pontuação e plural: "ACABOU O PAÇOCA!!!" e "pausar açai"', () => {
    assert.equal(run('ACABOU A PAÇOCA!!!').targets[0].name, 'Paçoca');
    assert.equal(run('acabou a pacoca').targets[0].name, 'Paçoca');
    const r = run('pausar açai');
    assert.equal(r.ok, true); assert.ok(names(r).some(n => /Açaí/.test(n)));
  });
  await t('"pausar a categoria geladinhos" -> categoria', () => {
    const r = run('pausar a categoria geladinhos');
    assert.equal(r.ok, true); assert.equal(r.targets.length, 1); assert.equal(r.targets[0].type, 'category'); assert.equal(r.targets[0].name, 'Geladinhos Gourmet');
  });
  await t('"desativar todos os complementos" / "pausar tudo" (só prévia)', () => {
    const r = run('desativar todos os complementos');
    assert.equal(r.ok, true); assert.ok(r.targets.every(x => x.type === 'complement' && x.to === false)); assert.equal(r.targets.length, 6); assert.equal(r.skipped, 2);
    const all = run('pausar tudo');
    assert.equal(all.ok, true); assert.ok(all.targets.every(x => x.type === 'product'));
  });
  await t('"pausar todos os brigadeiros" -> só produtos (prefere produto a complemento)', () => {
    const r = run('pausar todos os brigadeiros');
    assert.equal(r.ok, true); assert.ok(r.targets.length >= 1); assert.ok(r.targets.every(x => x.type === 'product'));
  });
  await t('erro de digitação leve e nome separado: "pausar nutela", "pausar kit kat"', () => {
    const r = run('pausar nutela');
    assert.ok(names(r).includes('Nutella'));
    const k = run('pausar kit kat');
    assert.equal(k.ok, true); assert.equal(k.targets[0].name, 'Recheio de Kitkat');
    assert.equal(run('pasuar granola').targets[0].name, 'Granola');
  });
  await t('ambiguidade: "pausar chocolate" lista candidatos, sem alvos aplicáveis', () => {
    const r = run('pausar chocolate');
    assert.equal(r.ok, false); assert.equal(r.kind, 'ambiguous'); assert.ok(r.candidates.length >= 2);
    assert.ok(r.candidates.every(c => typeof c.id === 'number' && typeof c.type === 'string' && c.to === false));
  });
  await t('complemento não vinculado ao produto => notfound explicando', () => {
    const r = run('pausar granola no monte seu copo');
    assert.equal(r.ok, false); assert.equal(r.kind, 'notfound'); assert.match(r.message, /vinculado/);
  });
  await t('não entendeu => exemplos; sem verbo; só verbo; nome inexistente', () => {
    for (const phrase of ['bla bla', '', '   ', 'acabou', 'bom dia']) {
      const r = run(phrase);
      assert.equal(r.ok, false, phrase); assert.equal(r.kind, 'unknown', phrase); assert.ok(r.examples.length >= 3, phrase);
    }
    const nf = run('pausar xyzabc');
    assert.equal(nf.ok, false); assert.equal(nf.kind, 'notfound'); assert.ok(nf.examples.length >= 3);
  });
  await t('entrada hostil/grande é tratada como texto (sem exceção)', () => {
    for (const phrase of ["pausar '; drop table products; --", 'pausar ' + 'a'.repeat(5000), 'pausar <script>alert(1)</script>', 'pausar ' + String.fromCharCode(0, 1)]) {
      const r = run(phrase);
      assert.equal(typeof r.ok, 'boolean');
    }
  });
}

// ---------- integração (banco real, somente dados ZZ-TESTE) ----------
const S = { imageIds: new Set(), ips: { lock: '198.51.100.20', a: '198.51.100.21', b: '198.51.100.22', c: '198.51.100.23', d: '198.51.100.24', e: '198.51.100.25',
  f: '198.51.100.26', g: '198.51.100.27', h: '198.51.100.28' } };
let sql, Q;
const TABLES = ['products', 'complements', 'categories', 'product_complements', 'product_groups', 'orders', 'settings'];

async function snapshot() {
  const out = {};
  for (const tb of TABLES) out[tb] = (await Q(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from ${tb} x`))[0];
  out.images = (await Q('select count(*)::int n from images'))[0].n;
  out.realUsers = (await Q(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from admin_users x where username in ('admin','gigi')`))[0].h;
  return out;
}
async function mkUser(username, role, password, weak) {
  const ah = await require('../api/_lib/auth').hashAnswer('resposta teste');
  return (await Q('insert into admin_users (username, password_hash, role, weak_password, security_question, security_answer_hash, security_set_at) values ($1,$2,$3,$4,$5,$6, now()) returning id',
    [username, await I.hashPassword(password), role, !!weak, 'prof_favorito', ah]))[0].id;
}
async function loginAs(username, password, ip) {
  const r = await post(null, 'login', { username, password }, { ip });
  const sc = r.headers['set-cookie'];
  return { r, cookie: sc ? sc.split(';')[0] : null, setCookie: sc };
}
function trackImage(path) { const m = /id=(\d+)/.exec(String(path || '')); if (m) S.imageIds.add(Number(m[1])); }

async function setup() {
  sql = require('../api/_lib/db'); Q = (text, params) => sql.query(text, params || []);
  S.before = await snapshot();
  S.settingsBefore = await Q('select key, value from settings');
  S.names = { adm: 'zz-teste-adm', staff: 'zz-teste-staff', lock: 'zz-teste-lock', ghost: 'zz-teste-ghost', fresh: 'zz-teste-novo', weak: 'zz-teste-fraco', pwlock: 'zz-teste-pwlock' };
  S.pw = { adm: rnd() + 'Aa1', staff: rnd() + 'Bb2', lock: rnd() + 'Cc3', weak: rnd() + 'Gg7', pwlock: rnd() + 'Hh8' };
  S.admId = await mkUser(S.names.adm, 'admin', S.pw.adm, false);
  S.staffId = await mkUser(S.names.staff, 'staff', S.pw.staff, false);
  await mkUser(S.names.lock, 'staff', S.pw.lock, false);
  S.weakId = await mkUser(S.names.weak, 'staff', S.pw.weak, true);
  await mkUser(S.names.pwlock, 'staff', S.pw.pwlock, false);
  const a = await loginAs(S.names.adm, S.pw.adm, S.ips.a);
  const s = await loginAs(S.names.staff, S.pw.staff, S.ips.b);
  S.adm = a.cookie; S.staff = s.cookie;
  assert.ok(S.adm && S.staff, 'login dos usuários de teste falhou');
}

async function authTests() {
  console.log('\nIntegração: autenticação e segurança');
  await t('login ok: cookie HttpOnly/Secure/SameSite=Strict/Path=/, sem hash na resposta, só SHA-256 no banco', async () => {
    const l = await loginAs(S.names.adm, S.pw.adm, S.ips.a);
    assert.equal(l.r.status, 200);
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(l.setCookie.includes(part), part);
    assert.ok(!l.setCookie.includes('Domain'));
    assert.ok(!/password_hash|scrypt$/i.test(JSON.stringify(l.r.json)));
    const token = l.cookie.split('=')[1];
    const rows = await Q('select token_hash from admin_sessions where user_id = $1', [S.admId]);
    assert.ok(rows.some(r => r.token_hash === crypto.createHash('sha256').update(token).digest('hex')));
    assert.ok(!rows.some(r => r.token_hash === token));
  });
  await t('cabeçalhos: no-store, noindex e nosniff em respostas de sucesso e de erro', async () => {
    for (const r of [await get(S.adm, 'me'), await get(null, 'me'), await post(S.adm, 'me', {}, { origin: 'https://evil.example' })]) {
      assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-robots-tag'], 'noindex'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  });
  await t('login errado e usuário inexistente dão resposta idêntica (401, mesma mensagem)', async () => {
    const a = await loginAs(S.names.adm, 'senha-errada-xyz', S.ips.c);
    const b = await loginAs(S.names.ghost, 'senha-errada-xyz', S.ips.c);
    assert.equal(a.r.status, 401); assert.equal(b.r.status, 401);
    assert.deepEqual(a.r.json, b.r.json); assert.equal(a.cookie, null);
    assert.equal((await post(null, 'login', {}, { ip: S.ips.c })).status, 400);
    assert.equal((await post(null, 'login', { username: 5, password: {} }, { ip: S.ips.c })).status, 400);
  });
  await t('bloqueio: 5 falhas => 429 "Muitas tentativas"; senha certa também é barrada; unlock-admin.js libera', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = await loginAs(S.names.lock, 'errada-' + i + '-xxxx', S.ips.lock);
    assert.equal(last.r.status, 429); assert.equal(last.r.json.error, 'Muitas tentativas. Tente mais tarde.');
    const right = await loginAs(S.names.lock, S.pw.lock, S.ips.lock);
    assert.equal(right.r.status, 429); assert.equal(right.cookie, null);
    const other = await loginAs(S.names.lock, S.pw.lock, S.ips.d); // A1-04: IP diferente não herda o bloqueio do par usuário+IP
    assert.equal(other.r.status, 200);
    assert.equal((await loginAs(S.names.lock, S.pw.lock, S.ips.lock)).r.status, 429, 'o IP que errou continua barrado');
    execFileSync(process.execPath, [path.join(__dirname, 'unlock-admin.js'), S.names.lock], { env: process.env, stdio: 'pipe' });
    const after = await loginAs(S.names.lock, S.pw.lock, S.ips.lock);
    assert.equal(after.r.status, 200);
  });
  await t('A1-04: 30 falhas espalhadas em vários IPs barram IP novo, mas o dono entra pelo IP conhecido', async () => {
    assert.equal((await loginAs(S.names.lock, S.pw.lock, S.ips.d)).r.status, 200); // IP d vira conhecido
    for (let i = 0; i < 30; i++) await Q('insert into login_attempts (username, ip, ok) values ($1, $2, false)', [S.names.lock, '203.0.113.' + (100 + i)]);
    assert.equal((await loginAs(S.names.lock, S.pw.lock, S.ips.f)).r.status, 429, 'IP desconhecido');
    assert.equal((await loginAs(S.names.lock, S.pw.lock, S.ips.d)).r.status, 200, 'IP conhecido');
    await Q('delete from login_attempts where username = $1', [S.names.lock]);
  });
  await t('IP do cliente: x-real-ip (Vercel) vale mais que x-forwarded-for forjado', async () => {
    for (let i = 0; i < 5; i++) await loginAs(S.names.lock, 'errada-xri-' + i, S.ips.g);
    const forged = await post(null, 'login', { username: S.names.lock, password: S.pw.lock }, { ip: S.ips.h, headers: { 'x-real-ip': S.ips.g } });
    assert.equal(forged.status, 429, 'trocar o x-forwarded-for não escapa do bloqueio');
    await Q('delete from login_attempts where username = $1', [S.names.lock]);
  });
  await t('bloqueio por IP: 20 falhas em 15 min barram outros usuários desse IP', async () => {
    const ip = S.ips.e;
    for (let i = 0; i < 20; i++) await Q('insert into login_attempts (username, ip, ok) values ($1, $2, false)', ['zz-teste-ip' + i, ip]);
    const r = await loginAs(S.names.staff, S.pw.staff, ip);
    assert.equal(r.r.status, 429); assert.equal(r.r.json.error, 'Muitas tentativas. Tente mais tarde.');
  });
  await t('sem sessão => 401 em leituras e mutações (cookie ausente, lixo ou de outro valor)', async () => {
    for (const a of ['me', 'catalog', 'orders', 'audit', 'users']) assert.equal((await get(null, a)).status, 401, a);
    for (const a of ['product_save', 'command', 'command_apply', 'store_save', 'order_status', 'password_change', 'product_image']) assert.equal((await post(null, a, {})).status, 401, a);
    assert.equal((await get(I.SESSION_COOKIE + '=lixo', 'me')).status, 401);
    assert.equal((await get(I.SESSION_COOKIE + '=' + 'a'.repeat(500), 'me')).status, 401);
  });
  await t('CSRF: Origin errado/ausente => 403; Content-Type fora de JSON => 415; corpo inválido => 400', async () => {
    assert.equal((await post(S.adm, 'store_save', { store_paused: false }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(S.adm, 'store_save', { store_paused: false }, { origin: null })).status, 403);
    assert.equal((await post(S.adm, 'store_save', { store_paused: false }, { origin: 'https://' + HOST + '.evil.example' })).status, 403);
    assert.equal((await post(S.adm, 'store_save', { store_paused: false }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await post(S.adm, 'store_save', {}, { contentType: 'text/plain' })).status, 415);
    assert.equal((await post(S.adm, 'store_save', 'isso não é objeto')).status, 400);
    assert.equal((await post(S.adm, 'store_save', [1, 2])).status, 400);
    assert.equal((await post(null, 'login', { username: 'x', password: 'y' }, { origin: 'https://evil.example' })).status, 403);
  });
  await t('método errado => 405; ação inexistente => 404; perfil staff não acessa rotas de admin (403)', async () => {
    assert.equal((await call({ method: 'DELETE', action: 'me', cookie: S.adm })).status, 405);
    assert.equal((await call({ method: 'PUT', action: 'me', cookie: S.adm })).status, 405);
    assert.equal((await get(S.adm, 'product_save')).status, 405);
    assert.equal((await post(S.adm, 'catalog', {})).status, 405);
    assert.equal((await get(S.adm, 'login')).status, 405);
    assert.equal((await get(S.adm, 'nao_existe')).status, 404);
    assert.equal((await get(S.adm, '__proto__')).status, 404);
    assert.equal((await get(S.adm, 'constructor')).status, 404);
    assert.equal((await get(S.staff, 'users')).status, 403);
    assert.equal((await post(S.staff, 'user_create', { username: 'zz-teste-x', password: 'abcdefgh1' })).status, 403);
    assert.equal((await post(S.staff, 'user_reset', { id: S.admId, new_password: 'abcdefgh1' })).status, 403);
    assert.equal((await get(S.adm, 'users')).status, 200);
  });
  await t('A1-06: senha fraca só libera me, troca de senha, sair e segurança; o resto 403 password_change_required', async () => {
    const l = await loginAs(S.names.weak, S.pw.weak, S.ips.b);
    assert.equal(l.r.status, 200); assert.equal(l.r.json.user.weakPassword, true);
    for (const a of ['catalog', 'orders', 'audit', 'store_state']) {
      const r = await get(l.cookie, a); assert.equal(r.status, 403, a); assert.equal(r.json.code, 'password_change_required', a);
    }
    const c = await post(l.cookie, 'command', { text: 'pausar zz teste' });
    assert.equal(c.status, 403); assert.equal(c.json.code, 'password_change_required');
    for (const a of ['me', 'security_questions', 'security_status']) assert.equal((await get(l.cookie, a)).status, 200, a);
    const newPw = rnd() + 'Ii9';
    const ok = await post(l.cookie, 'password_change', { current_password: S.pw.weak, new_password: newPw });
    assert.equal(ok.status, 200); assert.equal(ok.json.user.weakPassword, false);
    assert.equal((await get(l.cookie, 'catalog')).status, 200);
    S.pw.weak = newPw;
  });
  await t('A1-07: senha atual errada na troca conta no bloqueio (5 erros => 429, mesmo com a certa); outro IP não trava', async () => {
    const l = await loginAs(S.names.pwlock, S.pw.pwlock, S.ips.c);
    let last;
    for (let i = 0; i < 5; i++) last = await post(l.cookie, 'password_change', { current_password: 'errada-' + i + '-xx', new_password: rnd() + 'Jj1' }, { ip: S.ips.c });
    assert.equal(last.status, 429);
    assert.equal((await post(l.cookie, 'password_change', { current_password: S.pw.pwlock, new_password: rnd() + 'Jj1' }, { ip: S.ips.c })).status, 429);
    assert.equal((await post(l.cookie, 'recovery_codes_new', { current_password: S.pw.pwlock }, { ip: S.ips.c })).status, 429);
    assert.equal((await loginAs(S.names.pwlock, S.pw.pwlock, S.ips.c)).r.status, 429, 'login desse IP também barrado');
    assert.equal((await loginAs(S.names.pwlock, S.pw.pwlock, S.ips.d)).r.status, 200, 'outro IP segue livre');
    assert.equal((await Q(`select count(*)::int n from admin_audit where username = $1 and action = 'troca_senha_falhou'`, [S.names.pwlock]))[0].n >= 5, true);
  });
  await t('sessão expirada no banco => 401; weakPassword refletido em /me', async () => {
    await Q('update admin_users set weak_password = true where id = $1', [S.weakId]);
    const l = await loginAs(S.names.weak, S.pw.weak, S.ips.b);
    assert.equal((await get(l.cookie, 'me')).json.user.weakPassword, true);
    await Q('update admin_users set weak_password = false where id = $1', [S.weakId]);
    await Q(`update admin_sessions set expires_at = now() - interval '1 minute' where token_hash = $1`, [crypto.createHash('sha256').update(l.cookie.split('=')[1]).digest('hex')]);
    assert.equal((await get(l.cookie, 'me')).status, 401);
  });
}

async function menuCall() {
  const res = { code: 200, body: null, headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await require('../api/menu')({ method: 'GET', headers: {} }, res);
  return res;
}
async function imgCall(id) {
  const res = fakeRes();
  await require('../api/img')({ method: 'GET', url: '/api/img?id=' + id, headers: {} }, res);
  return res;
}

async function catalogTests() {
  console.log('\nIntegração: cardápio, complementos, grupos, fotos');
  const ctx = S.ctx = {};
  await t('categoria: criar, renomear, pausar', async () => {
    const c = await post(S.adm, 'category_save', { name: 'ZZ-TESTE Categoria', sort_order: 999 });
    assert.equal(c.status, 200); ctx.cat = c.json.category.id;
    const e = await post(S.adm, 'category_save', { id: ctx.cat, name: 'ZZ-TESTE Categoria 2' });
    assert.equal(e.json.category.name, 'ZZ-TESTE Categoria 2'); assert.equal(e.json.category.sort_order, 999);
    assert.equal((await post(S.adm, 'category_save', { id: ctx.cat, active: false })).json.category.active, false);
    assert.equal((await post(S.adm, 'category_save', { id: ctx.cat, active: true })).json.category.active, true);
    assert.equal((await post(S.adm, 'category_save', { id: 2147483000, name: 'x' })).status, 404);
    assert.equal((await post(S.adm, 'category_save', { sort_order: 1 })).status, 400);
  });
  await t('produto: criar, editar, pausar com um toque, preço nulo, SQL em texto é só texto', async () => {
    const p = await post(S.adm, 'product_save', { name: 'ZZ-TESTE Fatia Alfa', description: "linha 1\nlinha 2 '; drop table products; --", price_cents: 1250, category_id: ctx.cat, sort_order: 5 });
    assert.equal(p.status, 200, JSON.stringify(p.json)); ctx.prod = p.json.product.id;
    assert.equal(p.json.product.price_cents, 1250); assert.match(p.json.product.description, /drop table/);
    assert.ok((await Q('select count(*)::int n from products'))[0].n > 30);
    const e = await post(S.adm, 'product_save', { id: ctx.prod, name: 'ZZ-TESTE Fatia Alfa 2', price_cents: null });
    assert.equal(e.json.product.price_cents, null); assert.equal(e.json.product.name, 'ZZ-TESTE Fatia Alfa 2');
    assert.equal((await post(S.adm, 'product_save', { id: ctx.prod, name: 'ZZ-TESTE Fatia Alfa' })).status, 200);
    const off = await post(S.adm, 'product_toggle', { id: ctx.prod, active: false });
    assert.equal(off.json.product.active, false);
    assert.equal((await post(S.adm, 'product_toggle', { id: ctx.prod, active: true })).json.product.active, true);
    assert.equal((await post(S.adm, 'product_toggle', { id: ctx.prod, active: 'sim' })).status, 400);
    assert.equal((await post(S.adm, 'product_toggle', { id: 2147483000, active: true })).status, 404);
  });
  await t('produto: validações (preço negativo/decimal/gigante, nome vazio/longo, categoria inexistente, duplicado)', async () => {
    const base = { name: 'ZZ-TESTE Invalido', category_id: ctx.cat };
    for (const bad of [{ price_cents: -1 }, { price_cents: 12.5 }, { price_cents: '12' }, { price_cents: 10000001 }, { name: '' }, { name: 'x'.repeat(121) },
      { category_id: 0 }, { category_id: 'a' }, { description: 'x'.repeat(501) }, { sort_order: -3 }, { active: 'true' }]) {
      const r = await post(S.adm, 'product_save', { ...base, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(typeof r.json.error, 'string');
    }
    assert.equal((await post(S.adm, 'product_save', { ...base, category_id: 2147483000 })).status, 400);
    assert.equal((await post(S.adm, 'product_save', { ...base, name: 'ZZ-TESTE Fatia Alfa' })).status, 400);
    assert.equal((await Q(`select count(*)::int n from products where name = 'ZZ-TESTE Invalido'`))[0].n, 0);
  });
  await t('complemento: criar (tamanho e adicional), editar, pausar, validar', async () => {
    const a = await post(S.adm, 'complement_save', { name: 'ZZ-TESTE Calda Beta', price_cents: 250, kind: 'additional' });
    assert.equal(a.status, 200); ctx.comp = a.json.complement.id;
    const s = await post(S.adm, 'complement_save', { name: 'ZZ-TESTE Copo Gama', price_cents: 0, kind: 'size' });
    ctx.size = s.json.complement.id;
    assert.equal((await post(S.adm, 'complement_save', { id: ctx.comp, price_cents: 300 })).json.complement.price_cents, 300);
    assert.equal((await post(S.adm, 'complement_toggle', { id: ctx.comp, active: false })).json.complement.active, false);
    assert.equal((await post(S.adm, 'complement_toggle', { id: ctx.comp, active: true })).json.complement.active, true);
    assert.equal((await post(S.adm, 'complement_save', { name: 'ZZ-TESTE X', price_cents: 1, kind: 'drop' })).status, 400);
    assert.equal((await post(S.adm, 'complement_save', { name: 'ZZ-TESTE X', price_cents: -5, kind: 'size' })).status, 400);
    assert.equal((await post(S.adm, 'complement_save', { name: 'ZZ-TESTE Calda Beta', price_cents: 1, kind: 'size' })).status, 400);
  });
  await t('grupo: criar, editar, regras min<=max, chave duplicada, excluir', async () => {
    const g = await post(S.adm, 'group_save', { product_id: ctx.prod, key: 'Calda', label: 'ZZ-TESTE Escolha a calda', min_choices: 0, max_choices: 2 });
    assert.equal(g.status, 200, JSON.stringify(g.json)); ctx.group = g.json.group.id; assert.equal(g.json.group.key, 'calda');
    assert.equal((await post(S.adm, 'group_save', { id: ctx.group, label: 'ZZ-TESTE Calda 2', max_choices: 3 })).json.group.max_choices, 3);
    assert.equal((await post(S.adm, 'group_save', { id: ctx.group, min_choices: 9 })).status, 400);
    assert.equal((await post(S.adm, 'group_save', { product_id: ctx.prod, key: 'calda', label: 'dup', max_choices: 1 })).status, 400);
    assert.equal((await post(S.adm, 'group_save', { product_id: ctx.prod, key: 'k2', label: 'x', min_choices: 3, max_choices: 1 })).status, 400);
    assert.equal((await post(S.adm, 'group_save', { product_id: 2147483000, key: 'k3', label: 'x', max_choices: 1 })).status, 404);
    const tmp = await post(S.adm, 'group_save', { product_id: ctx.prod, key: 'tmp', label: 'ZZ-TESTE tmp', max_choices: 1 });
    assert.equal((await post(S.adm, 'group_delete', { id: tmp.json.group.id })).status, 200);
    assert.equal((await post(S.adm, 'group_delete', { id: tmp.json.group.id })).status, 404);
  });
  await t('vínculo: vincular com max_quantity e grupo, pausar só no produto, /api/menu esconde o pausado, desvincular', async () => {
    const l = await post(S.adm, 'link_save', { product_id: ctx.prod, complement_id: ctx.comp, max_quantity: 2, group_id: ctx.group });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    await post(S.adm, 'link_save', { product_id: ctx.prod, complement_id: ctx.size, max_quantity: 1, group_id: ctx.group });
    const row = (await Q('select * from product_complements where product_id=$1 and complement_id=$2', [ctx.prod, ctx.comp]))[0];
    assert.deepEqual([row.max_quantity, row.group_id, row.paused], [2, ctx.group, false]);
    assert.equal((await Q('select group_id from product_complements where product_id=$1 and complement_id=$2', [ctx.prod, ctx.size]))[0].group_id, null);
    const find = m => m.body.categories.flatMap(c => c.products).find(p => p.id === ctx.prod);
    let m = await menuCall();
    assert.equal(m.code, 200); assert.ok(find(m).complements.some(c => c.id === ctx.comp));
    assert.deepEqual(Object.keys(m.body.settings).sort(), ['defaultPauseLabel', 'deliveryFeeCents', 'storeAddress', 'storePaused', 'storePausedMessage']);
    assert.equal((await post(S.adm, 'link_toggle', { product_id: ctx.prod, complement_id: ctx.comp, paused: true })).status, 200);
    m = await menuCall(); assert.ok(!find(m).complements.some(c => c.id === ctx.comp));
    assert.equal((await post(S.adm, 'link_toggle', { product_id: ctx.prod, complement_id: ctx.comp, paused: false })).status, 200);
    assert.equal((await post(S.adm, 'link_save', { product_id: ctx.prod, complement_id: ctx.comp, max_quantity: 0 })).status, 400);
    assert.equal((await post(S.adm, 'link_save', { product_id: ctx.prod, complement_id: ctx.comp, max_quantity: 51 })).status, 400);
    assert.equal((await post(S.adm, 'link_save', { product_id: ctx.prod, complement_id: ctx.comp, group_id: 2147483000 })).status, 404);
    assert.equal((await post(S.adm, 'link_toggle', { product_id: ctx.prod, complement_id: 2147483000, paused: true })).status, 404);
    assert.equal((await post(S.adm, 'link_delete', { product_id: ctx.prod, complement_id: ctx.size })).status, 200);
    assert.equal((await post(S.adm, 'link_delete', { product_id: ctx.prod, complement_id: ctx.size })).status, 404);
  });
  await t('foto: PNG minúsculo grava em images, image_path vira /api/img?id=N e api/img serve com cache imutável', async () => {
    const r = await post(S.adm, 'product_image', { product_id: ctx.prod, data: PNG_B64 });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(r.json.image_path, /^\/api\/img\?id=\d+$/); trackImage(r.json.image_path);
    assert.equal((await Q('select image_path from products where id=$1', [ctx.prod]))[0].image_path, r.json.image_path);
    const id = Number(/id=(\d+)/.exec(r.json.image_path)[1]);
    const img = await imgCall(id);
    assert.equal(img.statusCode, 200); assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.ok(Buffer.isBuffer(img.body) && img.body.equals(Buffer.from(PNG_B64, 'base64')));
    // trocar a foto apaga a antiga
    const r2 = await post(S.adm, 'product_image', { product_id: ctx.prod, data: PNG_B64 }); trackImage(r2.json.image_path);
    assert.equal((await Q('select count(*)::int n from images where id=$1', [id]))[0].n, 0);
    assert.equal((await imgCall(id)).statusCode, 404);
  });
  await t('foto: rejeita SVG/texto, base64 inválido, grande demais, produto inexistente; api/img valida o id', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    for (const data of [svg, 'isto nao e base64', '', 'A'.repeat(2900000), 123, undefined]) assert.equal((await post(S.adm, 'product_image', { product_id: ctx.prod, data })).status, 400);
    assert.equal((await post(S.adm, 'product_image', { product_id: 2147483000, data: PNG_B64 })).status, 404);
    assert.equal((await post(S.adm, 'product_image', { product_id: 'x', data: PNG_B64 })).status, 400);
    for (const id of ['abc', '0', '-1', '1.5', '99999999999', '', '1;drop']) assert.equal((await imgCall(id)).statusCode, 404, id);
    assert.equal((await imgCall(2147483000)).statusCode, 404);
    const res = fakeRes(); await require('../api/img')({ method: 'POST', url: '/api/img?id=1', headers: {} }, res); assert.equal(res.statusCode, 405);
  });
  await t('foto: remover limpa image_path e apaga a linha de images', async () => {
    const id = Number(/id=(\d+)/.exec((await Q('select image_path from products where id=$1', [S.ctx.prod]))[0].image_path)[1]);
    assert.equal((await post(S.adm, 'product_image_remove', { product_id: S.ctx.prod })).status, 200);
    assert.equal((await Q('select image_path from products where id=$1', [S.ctx.prod]))[0].image_path, null);
    assert.equal((await Q('select count(*)::int n from images where id=$1', [id]))[0].n, 0);
  });
  await t('catálogo (leitura): inclui itens de teste, usos, grupos e vínculos', async () => {
    const c = await get(S.adm, 'catalog');
    assert.equal(c.status, 200);
    assert.ok(c.json.products.some(p => p.id === S.ctx.prod)); assert.ok(c.json.complements.some(x => x.id === S.ctx.comp && x.uses === 1));
    assert.ok(c.json.groups.some(g => g.id === S.ctx.group)); assert.ok(c.json.links.some(l => l.complement_id === S.ctx.comp && l.paused === false));
    assert.deepEqual(Object.keys(c.json.settings).sort(), ['defaultPauseLabel', 'deliveryFeeCents', 'storeAddress', 'storePaused', 'storePausedMessage']);
  });
}

async function orderTests() {
  console.log('\nIntegração: pedidos');
  const code = 'ZZTESTE' + rnd().slice(0, 8).toUpperCase();
  const row = (await Q(`insert into orders (code, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, delivery_fee_cents, total_cents, payment_method, payment_status, notes)
    values ($1,'ZZ-TESTE Cliente','11999990000','delivery','Rua Teste 1',$2::jsonb,1000,0,1000,'pix','approved','sem gelo') returning id`,
  [code, JSON.stringify([{ product_id: 1, name: 'ZZ-TESTE item', size: null, extras: ['A', 'B x2'], qty: 1, unit_total_cents: 1000 }])]))[0];
  await t('lista: padrão new, busca por código/nome, filtros e limite de 100', async () => {
    const l = await get(S.adm, 'orders', { s: code.toLowerCase() });
    assert.equal(l.status, 200); assert.equal(l.json.orders.length, 1); assert.equal(l.json.orders[0].fulfillment_status, 'new');
    assert.equal((await get(S.adm, 'orders', { s: 'zz-teste cliente' })).json.orders.length, 1);
    assert.equal((await get(S.adm, 'orders', { s: code, f: 'paid' })).json.orders.length, 1);
    assert.equal((await get(S.adm, 'orders', { s: code, f: 'ready' })).json.orders.length, 0);
    assert.ok((await get(S.adm, 'orders')).json.orders.length <= 200);
    assert.equal((await get(S.adm, 'orders', { s: "'; drop table orders; --" })).status, 200);
  });
  await t('status: new -> preparing -> ready -> delivered -> cancelled; inválidos => 400/404', async () => {
    for (const s of ['accepted', 'preparing', 'ready', 'awaiting_delivery']) {
      const r = await post(S.adm, 'order_status', { id: row.id, status: s });
      assert.equal(r.status, 200); assert.equal(r.json.order.fulfillment_status, s);
      assert.equal((await Q('select fulfillment_status from orders where id=$1', [row.id]))[0].fulfillment_status, s);
    }
    assert.equal((await post(S.adm, 'order_status', { id: row.id, status: 'preparing' })).status, 409); // não volta
    assert.equal((await post(S.adm, 'order_status', { id: row.id, status: 'cancelled', reason: 'teste' })).status, 200);
    assert.equal((await post(S.adm, 'order_status', { id: row.id, status: 'new' })).status, 409);
    assert.equal((await get(S.adm, 'orders', { f: 'cancelled', s: code })).json.orders.length, 1);
    for (const bad of ['pronto', '', null, 5]) assert.equal((await post(S.adm, 'order_status', { id: row.id, status: bad })).status, 400);
    assert.equal((await post(S.adm, 'order_status', { id: 'x', status: 'new' })).status, 400);
    assert.equal((await post(S.adm, 'order_status', { id: 2147483000, status: 'new' })).status, 404);
    assert.equal((await Q('select count(*)::int n from orders where id=$1 and payment_status=$2', [row.id, 'approved']))[0].n, 1); // pagamento intocado
  });
}

async function commandTests() {
  console.log('\nIntegração: caixa de comandos, loja, conta');
  const ctx = S.ctx;
  const state = async () => ({
    comp: (await Q('select active from complements where id=$1', [ctx.comp]))[0].active,
    prod: (await Q('select active from products where id=$1', [ctx.prod]))[0].active,
    link: (await Q('select paused from product_complements where product_id=$1 and complement_id=$2', [ctx.prod, ctx.comp]))[0].paused
  });
  await t('comando: prévia NÃO altera o banco; confirmação aplica (complemento global)', async () => {
    const p = await post(S.staff, 'command', { text: 'pausar zz teste calda beta' });
    assert.equal(p.status, 200); assert.equal(p.json.ok, true); assert.equal(p.json.targets.length, 1);
    assert.deepEqual([p.json.targets[0].type, p.json.targets[0].id, p.json.targets[0].from, p.json.targets[0].to], ['complement', ctx.comp, true, false]);
    assert.equal((await state()).comp, true);
    const a = await post(S.staff, 'command_apply', { targets: p.json.targets });
    assert.equal(a.status, 200); assert.equal(a.json.changed, 1); assert.equal((await state()).comp, false);
    const back = await post(S.staff, 'command', { text: 'reativar zz teste calda beta' });
    assert.equal(back.json.targets[0].to, true); assert.equal(back.json.targets[0].from, false);
    await post(S.staff, 'command_apply', { targets: back.json.targets });
    assert.equal((await state()).comp, true);
  });
  await t('comando: complemento só em um produto (vínculo) e produto, com prévia antes/depois', async () => {
    const p = await post(S.adm, 'command', { text: 'acabou zz teste calda beta no zz teste fatia alfa' });
    assert.equal(p.json.ok, true, JSON.stringify(p.json)); assert.equal(p.json.targets.length, 1);
    assert.deepEqual([p.json.targets[0].type, p.json.targets[0].from, p.json.targets[0].to], ['link', true, false]);
    assert.equal((await state()).link, false);
    await post(S.adm, 'command_apply', { targets: p.json.targets });
    assert.deepEqual([(await state()).link, (await state()).comp], [true, true]);
    const pr = await post(S.adm, 'command', { text: 'tirar zz teste fatia alfa' });
    await post(S.adm, 'command_apply', { targets: pr.json.targets });
    assert.equal((await state()).prod, false);
    const again = await post(S.adm, 'command', { text: 'pausar zz teste fatia alfa' });
    assert.equal(again.json.ok, true); assert.equal(again.json.targets.length, 0); assert.equal(again.json.skipped, 1);
    const on = await post(S.adm, 'command', { text: 'voltou zz teste fatia alfa' });
    await post(S.adm, 'command_apply', { targets: on.json.targets });
    assert.equal((await state()).prod, true);
    await post(S.adm, 'command_apply', { targets: (await post(S.adm, 'command', { text: 'liberar zz teste calda beta no zz teste fatia alfa' })).json.targets });
  });
  await t('comando: ambiguidade lista candidatos; desconhecido devolve exemplos; entrada inválida => 400', async () => {
    const amb = await post(S.adm, 'command', { text: 'pausar zz teste' });
    assert.equal(amb.json.ok, false); assert.equal(amb.json.kind, 'ambiguous'); assert.ok(amb.json.candidates.length >= 2);
    const unk = await post(S.adm, 'command', { text: 'qualquer coisa sem sentido' });
    assert.equal(unk.json.ok, false); assert.ok(unk.json.examples.length >= 3);
    assert.equal((await post(S.adm, 'command', { text: '' })).status, 400);
    assert.equal((await post(S.adm, 'command', { text: 'x'.repeat(201) })).status, 400);
    assert.equal((await post(S.adm, 'command', { text: 42 })).status, 400);
  });
  await t('aplicação em lote valida tudo: alvos adulterados => 400 e nada muda', async () => {
    const before = await state();
    for (const targets of [[], 'x', [{ type: 'drop', id: 1, to: false }], [{ type: 'product', id: 'x', to: false }], [{ type: 'product', id: ctx.prod, to: 'nao' }],
      [{ type: 'link', id: ctx.comp, to: false }], [{ type: 'product', id: ctx.prod, to: false }, null], Array.from({ length: 301 }, () => ({ type: 'product', id: ctx.prod, to: true }))]) {
      assert.equal((await post(S.adm, 'command_apply', { targets })).status, 400, JSON.stringify(targets).slice(0, 60));
    }
    assert.deepEqual(await state(), before);
  });
  await t('loja pelo comando: "fechar a loja" só com confirmação; /api/menu reflete; "abrir a loja" volta', async () => {
    const p = await post(S.adm, 'command', { text: 'fechar a loja' });
    assert.equal(p.json.targets[0].type, 'store');
    assert.equal((await menuCall()).body.settings.storePaused, false);
    await post(S.adm, 'command_apply', { targets: p.json.targets });
    assert.equal((await menuCall()).body.settings.storePaused, true);
    const o = await post(S.adm, 'command', { text: 'abrir a loja' });
    assert.equal(o.json.targets[0].from, false);
    await post(S.adm, 'command_apply', { targets: o.json.targets });
    assert.equal((await menuCall()).body.settings.storePaused, false);
  });
  await t('loja: store_paused liga/desliga, endereço, taxa, mensagem e validações', async () => {
    const on = await post(S.adm, 'store_save', { store_paused: true, store_paused_message: 'ZZ-TESTE voltamos já' });
    assert.equal(on.status, 200); assert.equal(on.json.settings.storePaused, true); assert.equal(on.json.settings.storePausedMessage, 'ZZ-TESTE voltamos já');
    let m = (await menuCall()).body.settings; assert.equal(m.storePaused, true); assert.equal(m.storePausedMessage, 'ZZ-TESTE voltamos já');
    const off = await post(S.adm, 'store_save', { store_paused: false, store_address: 'ZZ-TESTE Rua das Flores, 7', delivery_fee_cents: 650 });
    assert.deepEqual([off.json.settings.storePaused, off.json.settings.storeAddress, off.json.settings.deliveryFeeCents], [false, 'ZZ-TESTE Rua das Flores, 7', 650]);
    m = (await menuCall()).body.settings; assert.deepEqual([m.storeAddress, m.deliveryFeeCents, m.storePaused], ['ZZ-TESTE Rua das Flores, 7', 650, false]);
    for (const bad of [{ delivery_fee_cents: -1 }, { delivery_fee_cents: 1.5 }, { delivery_fee_cents: 10000001 }, { store_paused: 'sim' }, { store_address: 'ab' }, {}, { store_address: 'x'.repeat(201) }])
      assert.equal((await post(S.adm, 'store_save', bad)).status, 400, JSON.stringify(bad));
  });
  await t('favoritos: fixar/desafixar complemento em settings.pinned_complements', async () => {
    const a = await post(S.adm, 'pin_toggle', { complement_id: ctx.comp, pinned: true });
    assert.equal(a.status, 200); assert.equal(a.json.pinned[0], ctx.comp);
    assert.ok((await get(S.adm, 'catalog')).json.pinned.includes(ctx.comp));
    assert.ok(!(await post(S.adm, 'pin_toggle', { complement_id: ctx.comp, pinned: false })).json.pinned.includes(ctx.comp));
    assert.equal((await post(S.adm, 'pin_toggle', { complement_id: 2147483000, pinned: true })).status, 404);
  });
  await t('troca de senha: exige senha atual, mínimo 8, limpa weak_password e encerra as outras sessões', async () => {
    const other = (await loginAs(S.names.staff, S.pw.staff, S.ips.b)).cookie;
    assert.equal((await get(other, 'me')).status, 200);
    assert.equal((await post(S.staff, 'password_change', { current_password: 'errada-errada', new_password: 'NovaSenhaTeste9' })).status, 400);
    assert.equal((await post(S.staff, 'password_change', { current_password: S.pw.staff, new_password: '1234567' })).status, 400);
    assert.equal((await post(S.staff, 'password_change', { current_password: S.pw.staff, new_password: S.pw.staff })).status, 400);
    const newPw = rnd() + 'Dd4';
    await Q('update admin_users set weak_password = true where id = $1', [S.staffId]); // a troca limpa a marca de senha fraca
    const ok = await post(S.staff, 'password_change', { current_password: S.pw.staff, new_password: newPw });
    assert.equal(ok.status, 200); assert.equal(ok.json.user.weakPassword, false);
    assert.equal((await Q('select weak_password from admin_users where id=$1', [S.staffId]))[0].weak_password, false);
    assert.equal((await get(other, 'me')).status, 401); assert.equal((await get(S.staff, 'me')).status, 200);
    assert.equal((await loginAs(S.names.staff, S.pw.staff, S.ips.b)).r.status, 401);
    S.pw.staff = newPw;
    assert.equal((await loginAs(S.names.staff, newPw, S.ips.b)).r.status, 200);
  });
  await t('usuários (admin): criar, duplicado, senha curta, reset invalida sessões, desativar bloqueia login, não desativa a si mesmo', async () => {
    const pw = rnd() + 'Ee5';
    const c = await post(S.adm, 'user_create', { username: S.names.fresh, password: pw, role: 'staff' });
    assert.equal(c.status, 200); const id = c.json.target.id;
    assert.equal((await post(S.adm, 'user_create', { username: S.names.fresh, password: pw })).status, 400);
    assert.equal((await post(S.adm, 'user_create', { username: 'zz-teste-curto', password: '123' })).status, 400);
    assert.equal((await post(S.adm, 'user_create', { username: 'Nome Inválido!', password: pw })).status, 400);
    assert.equal((await post(S.adm, 'user_create', { username: 'zz-teste-role', password: pw, role: 'root' })).status, 400);
    const sess = (await loginAs(S.names.fresh, pw, S.ips.b)).cookie;
    assert.equal((await get(sess, 'me')).status, 200);
    const pw2 = rnd() + 'Ff6';
    { const rr = await post(S.adm, "user_reset", { id, new_password: pw2 }); assert.equal(rr.status, 200, JSON.stringify(rr.json)); }
    assert.equal((await get(sess, 'me')).status, 401);
    assert.equal((await loginAs(S.names.fresh, pw, S.ips.b)).r.status, 401);
    const s2 = await loginAs(S.names.fresh, pw2, S.ips.b); assert.equal(s2.r.status, 200);
    assert.equal((await post(S.adm, 'user_reset', { id, new_password: 'curta' })).status, 400);
    assert.equal((await post(S.adm, 'user_toggle', { id, active: false })).status, 200);
    assert.equal((await get(s2.cookie, 'me')).status, 401);
    assert.equal((await loginAs(S.names.fresh, pw2, S.ips.b)).r.status, 401);
    assert.equal((await post(S.adm, 'user_toggle', { id: S.admId, active: false })).status, 400);
    assert.equal((await post(S.adm, 'user_toggle', { id: 2147483000, active: false })).status, 404);
    const list = await get(S.adm, 'users');
    assert.ok(list.json.users.every(u => !('password_hash' in u)));
  });
  await t('auditoria: últimas 50 linhas, sem segredos; logout encerra a sessão e limpa o cookie', async () => {
    const a = await get(S.adm, 'audit');
    assert.equal(a.status, 200); assert.ok(a.json.rows.length > 0 && a.json.rows.length <= 50);
    const blob = JSON.stringify(a.json.rows);
    assert.ok(!blob.includes(S.pw.adm) && !blob.includes(S.pw.staff) && !/scrypt\$/.test(blob));
    assert.ok(a.json.rows.some(r => r.action === 'login_falhou')); assert.ok(a.json.rows.some(r => r.action === 'produto_editado'));
    const st = await get(S.staff, 'audit'); // A1-08: staff não vê falhas de login/recuperação (IP e usuário digitado)
    assert.equal(st.status, 200); assert.ok(st.json.rows.length > 0);
    assert.ok(!st.json.rows.some(r => r.action === 'login_falhou' || r.action === 'recuperacao_falhou'));
    const l = await loginAs(S.names.adm, S.pw.adm, S.ips.a);
    const out = await post(l.cookie, 'logout', {});
    assert.equal(out.status, 200); assert.ok(String(out.headers['set-cookie']).includes('Max-Age=0'));
    assert.equal((await get(l.cookie, 'me')).status, 401);
  });
  await t('exclusão: produto some (grupo e vínculos em cascata) e pedidos não são afetados; complemento e categoria também', async () => {
    const ordersBefore = (await Q('select count(*)::int n from orders'))[0].n;
    assert.equal((await post(S.adm, 'product_delete', { id: ctx.prod })).status, 200);
    assert.equal((await post(S.adm, 'product_delete', { id: ctx.prod })).status, 404);
    assert.equal((await Q('select count(*)::int n from product_groups where id=$1', [ctx.group]))[0].n, 0);
    assert.equal((await Q('select count(*)::int n from product_complements where product_id=$1', [ctx.prod]))[0].n, 0);
    assert.equal((await post(S.adm, 'complement_delete', { id: ctx.comp })).status, 200);
    assert.equal((await post(S.adm, 'complement_delete', { id: ctx.size })).status, 200);
    assert.equal((await post(S.adm, 'category_save', { id: ctx.cat, active: false })).status, 200);
    assert.equal((await Q('select count(*)::int n from orders'))[0].n, ordersBefore);
  });
}

async function cleanup() {
  console.log('\nLimpeza e conferência');
  await Q(`delete from orders where code like 'ZZTESTE%'`);
  await Q(`delete from products where name like 'ZZ-TESTE%'`);
  await Q(`delete from complements where name like 'ZZ-TESTE%'`);
  await Q(`delete from categories where name like 'ZZ-TESTE%'`);
  if (S.imageIds.size) await Q('delete from images where id = any($1::int[])', [[...S.imageIds]]);
  await Q(`delete from admin_users where username like 'zz-teste-%'`);
  await Q(`delete from login_attempts where username like 'zz-teste-%' or ip = any($1::text[])`, [Object.values(S.ips)]);
  await Q(`delete from admin_audit where username like 'zz-teste-%'`);
  await Q(`delete from settings where key not in (select unnest($1::text[]))`, [S.settingsBefore.map(r => r.key)]);
  for (const r of S.settingsBefore) await Q('insert into settings (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [r.key, r.value]);
  await t('nada real mudou: tabelas e contagens idênticas ao snapshot inicial', async () => {
    const after = await snapshot();
    assert.deepEqual(after, S.before);
    assert.equal((await Q('select count(*)::int n from products where active'))[0].n, S.before.products.n === 33 ? 33 : (await Q('select count(*)::int n from products where active'))[0].n);
  });
  await t('usuários reais admin e gigi continuam existindo (sem imprimir hashes)', async () => {
    const r = await Q(`select username, role, active from admin_users where username in ('admin','gigi') order by username`);
    assert.deepEqual(r.map(x => x.username), ['admin', 'gigi']); assert.ok(r.every(x => x.active));
    assert.equal((await Q(`select count(*)::int n from admin_users where username like 'zz-teste-%'`))[0].n, 0);
  });
}

(async () => {
  await unit();
  await parserTests();
  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL ausente: integração PULADA (rode com: set -a && . ./.env && set +a && node scripts/test-admin.js)');
  } else {
    let setupOk = false;
    try {
      await setup(); setupOk = true;
      await authTests();
      await catalogTests();
      await orderTests();
      await commandTests();
    } catch (e) { failed++; failures.push('integração (exceção)'); console.log('  FAIL integração interrompida: ' + String(e && e.message).split('\n')[0]); }
    finally { if (setupOk) { try { await cleanup(); } catch (e) { failed++; failures.push('limpeza'); console.log('  FAIL limpeza: ' + String(e && e.message).split('\n')[0]); } } }
  }
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed) { console.log('Falhas: ' + failures.join(' | ')); process.exitCode = 1; }
})();

