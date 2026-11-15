// Testes sem banco da migração para a Netlify (F6): ambiente (M3), endereço do site (M4), adaptador das Functions (M1),
// netlify.toml (M2) e servidor local (M5). Não precisa de netlify-cli: o evento da Function é simulado.
// node scripts/test-netlify.js
'use strict';
const assert = require('node:assert');
delete process.env.DATABASE_URL; // sem banco: as Functions reais testadas aqui não podem chegar a ele

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FALHA', name, '\n       ', e && e.message); }
}

(async () => {
  console.log('M3: ambiente (APP_ENV, fail-closed)');
  const env = require('../api/_lib/env');
  await t('produção a menos que APP_ENV seja development/preview ou NODE_ENV=test', () => {
    assert.equal(env.isProduction({}), true, 'sem variável');
    assert.equal(env.isProduction({ APP_ENV: '' }), true);
    assert.equal(env.isProduction({ APP_ENV: 'production' }), true);
    assert.equal(env.isProduction({ APP_ENV: 'prod' }), true, 'erro de digitação = produção');
    assert.equal(env.isProduction({ APP_ENV: 'staging' }), true);
    assert.equal(env.isProduction({ VERCEL_ENV: 'preview' }), true, 'VERCEL_ENV não conta mais');
    assert.equal(env.isProduction({ APP_ENV: 'development' }), false);
    assert.equal(env.isProduction({ APP_ENV: ' Preview ' }), false);
    assert.equal(env.isProduction({ NODE_ENV: 'test' }), false);
    assert.equal(env.appEnv({ APP_ENV: 'preview', NODE_ENV: 'test' }), 'preview');
  });
  await t('nenhum VERCEL_ENV sobrou em api/', () => {
    const fs = require('node:fs'), path = require('node:path');
    const dir = path.join(__dirname, '..', 'api');
    const files = [...fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)),
      ...fs.readdirSync(path.join(dir, '_lib')).filter(f => f.endsWith('.js') && f !== 'env.js').map(f => path.join(dir, '_lib', f))];
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('VERCEL_ENV'), f);
  });

  console.log('M4: endereço do site');
  await t('SITE_URL padrão = domínio próprio; variável válida vence; inválida cai no padrão', () => {
    const site = require('../api/_lib/site');
    assert.equal(site.DEFAULT_SITE_URL, 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({}), 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({ SITE_URL: 'https://docinhos-site.vercel.app/' }), 'https://docinhos-site.vercel.app');
    assert.equal(site.siteUrl({ SITE_URL: 'http://evil.example.com' }), 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({ SITE_URL: 'http://localhost:3402' }), 'http://localhost:3402');
  });
  await t('e-mail sintético do Pix e USER_AGENT no domínio da loja', () => {
    assert.equal(require('../api/order')._internal.pixPayerEmail('DG0123'), 'pedido-dg0123@docinhosdagigioz.com.br');
    assert.equal(require('../api/_lib/shipping').USER_AGENT, 'DocinhosDaGigi/1.0 (+https://docinhosdagigioz.com.br)');
  });

  console.log('M2: netlify.toml');
  const fs = require('node:fs'), path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const toml = require('../netlify/lib/toml-headers');
  const rules = toml.loadRules([path.join(ROOT, 'netlify.toml')]);
  await t('cabeçalhos do netlify.toml iguais aos do vercel.json, rota por rota', () => {
    assert.ok(rules && rules.length >= 4, 'netlify.toml sem [[headers]]');
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const vercelFor = p => {
      const out = {};
      for (const r of vercel.headers) if (new RegExp('^' + r.source.replace(/\(\.\*\)/g, '.*') + '$').test(p)) for (const h of r.headers) out[h.key] = h.value;
      return out;
    };
    for (const p of ['/', '/index.html', '/pedido', '/admin/', '/api/order', '/api/mp-webhook', '/api/order-status', '/api/menu', '/api/admin'])
      assert.deepStrictEqual(toml.headersFor(rules, p), vercelFor(p), p);
    assert.equal(toml.headersFor(rules, '/api/order')['Cache-Control'], 'no-store');
    assert.equal(toml.headersFor(rules, '/api/orders')['Cache-Control'], undefined, 'for literal, sem prefixo');
  });
  await t('build, Functions e reescrita /api/:name (status 200); uma Function por arquivo de api/', () => {
    const text = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    assert.match(text, /publish = "public"/);
    assert.match(text, /functions = "netlify\/functions"/);
    assert.match(text, /node_bundler = "esbuild"/);
    assert.match(text, /included_files = \["api\/\*\*", "netlify\.toml"\]/);
    assert.match(text, /from = "\/api\/:name"\s+to = "\/\.netlify\/functions\/:name"\s+status = 200/);
    const apis = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js')).sort();
    const fns = fs.readdirSync(path.join(ROOT, 'netlify', 'functions')).filter(f => f.endsWith('.js')).sort();
    assert.deepStrictEqual(fns, apis);
    assert.ok(apis.length <= 12, 'limite de 12 funções');
    for (const f of fns) assert.equal(typeof require(path.join(ROOT, 'netlify', 'functions', f)).handler, 'function', f);
  });

  console.log('M1: adaptador (evento da Function simulado, sem netlify-cli)');
  const { createHandler } = require('../netlify/lib/adapter');
  const ev = (o = {}) => Object.assign({ httpMethod: 'GET', path: '/api/x', headers: {}, multiValueHeaders: {},
    queryStringParameters: {}, multiValueQueryStringParameters: {}, rawQuery: '', body: null, isBase64Encoded: false }, o);
  const echo = name => createHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ method: req.method, url: req.url, query: req.query, body: req.body,
      raw: req.rawBody.toString('base64'), ip: require('../api/_lib/auth').clientIp(req), cookie: req.headers.cookie || null });
  }, name, { rules });

  await t('JSON: req.body parseado, rawBody byte a byte, query com chave repetida, url com a query', async () => {
    const body = '{"a":1,  "b":"çã"}';
    const r = await echo('order')(ev({ httpMethod: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      rawQuery: 'a=order_status&id=1&id=2', queryStringParameters: { a: 'order_status', id: '2' },
      multiValueQueryStringParameters: { a: ['order_status'], id: ['1', '2'] } }));
    assert.equal(r.statusCode, 201);
    const j = JSON.parse(r.body);
    assert.equal(j.method, 'POST');
    assert.deepStrictEqual(j.body, { a: 1, b: 'çã' });
    assert.equal(Buffer.from(j.raw, 'base64').toString('utf8'), body, 'corpo cru preservado (HMAC)');
    assert.deepStrictEqual(j.query, { a: 'order_status', id: ['1', '2'] });
    assert.equal(j.url, '/api/order?a=order_status&id=1&id=2');
    assert.equal(r.isBase64Encoded, false);
  });
  await t('corpo em base64 (isBase64Encoded) e formulário', async () => {
    const r = await echo('customer')(ev({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('x=1&y=%C3%A7').toString('base64'), isBase64Encoded: true }));
    const j = JSON.parse(r.body);
    assert.deepStrictEqual(j.body, { x: '1', y: 'ç' });
    assert.equal(Buffer.from(j.raw, 'base64').toString('utf8'), 'x=1&y=%C3%A7');
    const r2 = await echo('customer')(ev({ multiValueQueryStringParameters: { a: ['me'], k: ['1', '2'] }, rawQuery: undefined }));
    assert.deepStrictEqual(JSON.parse(r2.body).query, { a: 'me', k: ['1', '2'] }, 'sem rawQuery, usa multiValue');
  });
  await t('IP: x-real-ip do cliente descartado; vale x-nf-client-connection-ip', async () => {
    let j = JSON.parse((await echo('order')(ev({ headers: { 'X-Real-IP': '6.6.6.6', 'x-nf-client-connection-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6, 203.0.113.7' } }))).body);
    assert.equal(j.ip, '203.0.113.7');
    j = JSON.parse((await echo('order')(ev({ headers: { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '198.51.100.9' } }))).body);
    assert.equal(j.ip, '198.51.100.9', 'sem o cabeçalho da borda, nunca o x-real-ip do cliente');
    j = JSON.parse((await echo('order')(ev({ multiValueHeaders: { Cookie: ['a=1', 'b=2'] }, headers: { cookie: 'a=1' } }))).body);
    assert.equal(j.cookie, 'a=1; b=2');
  });
  await t('cabeçalhos: segurança do netlify.toml + os do handler (handler vence); Set-Cookie múltiplo', async () => {
    const h = createHandler(async (req, res) => {
      res.setHeader('Set-Cookie', ['s=1; HttpOnly', 'c=2; HttpOnly']);
      res.setHeader('cache-control', 'private, max-age=60');
      res.status(200).send('ok');
    }, 'order', { rules });
    const r = await h(ev());
    assert.equal(r.headers['Content-Security-Policy'], toml.headersFor(rules, '/')['Content-Security-Policy']);
    assert.equal(r.headers['X-Frame-Options'], 'DENY');
    assert.equal(r.headers['Strict-Transport-Security'], 'max-age=63072000; includeSubDomains; preload');
    assert.equal(r.headers['cache-control'], 'private, max-age=60');
    assert.equal(r.headers['Cache-Control'], undefined, 'sem duplicar com outra caixa');
    assert.deepStrictEqual(r.multiValueHeaders['Set-Cookie'], ['s=1; HttpOnly', 'c=2; HttpOnly']);
    assert.equal(r.body, 'ok');
    const r2 = await createHandler(async (req, res) => res.json({}), 'order', { rules })(ev());
    assert.equal(r2.headers['Cache-Control'], 'no-store', 'Cache-Control da rota no netlify.toml');
  });
  await t('corpo binário (imagem) sai em base64; texto e JSON não; redirect; statusCode + end', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    let r = await createHandler(async (req, res) => { res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.end(png); }, 'img', { rules })(ev());
    assert.equal(r.isBase64Encoded, true);
    assert.ok(Buffer.from(r.body, 'base64').equals(png));
    r = await createHandler(async (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.write('a;b\n'); res.end('1;2\n'); }, 'admin', { rules })(ev());
    assert.equal(r.isBase64Encoded, false); assert.equal(r.body, 'a;b\n1;2\n');
    r = await createHandler(async (req, res) => res.redirect(303, '/pedido.html?ok=1'), 'order', { rules })(ev());
    assert.equal(r.statusCode, 303); assert.equal(r.headers.Location, '/pedido.html?ok=1');
  });
  await t('erro no handler ou handler sem resposta: 500 "Erro interno", sem detalhe', async () => {
    const quiet = console.error; console.error = () => {};
    try {
      let r = await createHandler(async () => { throw new Error('segredo-interno'); }, 'order', { rules })(ev());
      assert.equal(r.statusCode, 500); assert.equal(r.body, 'Erro interno'); assert.ok(!JSON.stringify(r).includes('segredo-interno'));
      assert.equal(r.headers['X-Frame-Options'], 'DENY');
      r = await createHandler(async () => {}, 'order', { rules })(ev());
      assert.equal(r.statusCode, 500);
    } finally { console.error = quiet; }
    assert.throws(() => createHandler(() => {}, '../x'));
  });
  await t('Functions reais sem banco: /api/mp-webhook 401 com assinatura inválida; 200 com assinatura válida (HMAC pela query)', async () => {
    const crypto = require('node:crypto');
    const saved = { s: process.env.MERCADOPAGO_WEBHOOK_SECRET, a: process.env.APP_ENV };
    process.env.MERCADOPAGO_WEBHOOK_SECRET = 'zz-segredo-de-teste'; process.env.APP_ENV = 'production';
    const quiet = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
    try {
      const fn = require('../netlify/functions/mp-webhook').handler;
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: 'merchant_order', data: { id: '123' } });
      const base = { httpMethod: 'POST', rawQuery: 'data.id=123&type=merchant_order', body };
      let r = await fn(ev({ ...base, headers: { 'content-type': 'application/json', 'x-request-id': 'zz-req', 'x-signature': `ts=${ts},v1=00` } }));
      assert.equal(r.statusCode, 401);
      assert.equal(r.headers['Cache-Control'], 'no-store');
      assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
      const v1 = crypto.createHmac('sha256', 'zz-segredo-de-teste').update(`id:123;request-id:zz-req;ts:${ts};`).digest('hex');
      r = await fn(ev({ ...base, headers: { 'content-type': 'application/json', 'x-request-id': 'zz-req', 'x-signature': `ts=${ts},v1=${v1}` } }));
      assert.equal(r.statusCode, 200, r.body);
      r = await fn(ev({ httpMethod: 'GET' }));
      assert.equal(r.statusCode, 405);
    } finally {
      [console.error, console.warn] = quiet;
      if (saved.s === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET; else process.env.MERCADOPAGO_WEBHOOK_SECRET = saved.s;
      if (saved.a === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved.a;
    }
  });
  await t('Functions reais sem banco: /api/img id inválido 404; /api/health HEAD-only 405 para POST', async () => {
    let r = await require('../netlify/functions/img').handler(ev({ rawQuery: 'id=abc' }));
    assert.equal(r.statusCode, 404); assert.equal(r.body, 'Não encontrada');
    r = await require('../netlify/functions/health').handler(ev({ httpMethod: 'POST' }));
    assert.equal(r.statusCode, 405); assert.equal(r.headers['X-Robots-Tag'], 'noindex');
  });

  console.log('M5: servidor local');
  await t('dev-server aplica os cabeçalhos do netlify.toml', () => {
    const { applyHeaders } = require('./dev-server');
    const got = {};
    applyHeaders({ setHeader: (k, v) => { got[k] = v; } }, '/api/order-status');
    assert.deepStrictEqual(got, toml.headersFor(rules, '/api/order-status'));
    assert.equal(got['Cache-Control'], 'no-store');
    assert.ok(got['Content-Security-Policy'].startsWith("default-src 'self'"));
  });

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  if (fail) process.exitCode = 1;
})();
