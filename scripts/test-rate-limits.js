// Teste dos limites por IP guardados no banco (tabela rate_hits): GET /api/order-status e GET /api/store?a=quote.
// Roda contra o banco de DESENVOLVIMENTO. Não consulta frete de verdade (a cotação usa CEP inválido, barrado antes
// da rede) e não mexe em configurações da loja. Dados de teste: linhas de rate_hits com IP "rlteste-...", apagadas no
// começo e no fim.
// Uso: node -r ./scripts/dev-env.js scripts/test-rate-limits.js
const assert = require('node:assert/strict');
const path = require('node:path');
const sql = require('../api/_lib/db');
const shipping = require('../api/_lib/shipping');
const { hitExceeded } = require('../api/_lib/rate-limit');

const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const newIp = () => 'rlteste-' + rnd(8);

// Carrega o módulo do zero: simula outra instância da função na Vercel (memória separada).
function freshInstance(rel) {
  const file = require.resolve(path.join('..', rel));
  delete require.cache[file];
  return require(file);
}
function run(fn, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; }
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}
const track = (h, ip, extra = {}) => run(h, { method: 'GET', query: { t: 'curto' }, headers: { 'x-real-ip': ip, ...extra } });
const quote = (h, ip, extra = {}) => run(h, { method: 'GET', query: { a: 'quote', cep: '123', address: 'Rua X, 1' }, headers: { 'x-real-ip': ip, ...extra } });
// Grava um total já existente num minuto passado (minutesAgo minutos antes do minuto atual).
const seed = (scope, ip, n, minutesAgo) => sql.query(
  `insert into rate_hits (scope, ip, minute, n) values ($1, $2, date_trunc('minute', now()) - make_interval(mins => $4::int), $3)`,
  [scope, ip, n, minutesAgo]);
const cleanup = () => sql.query(`delete from rate_hits where ip like 'rlteste-%'`);

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

(async () => {
  await cleanup();
  console.log('Acompanhamento do pedido (/api/order-status)');
  const { MAX_PER_IP } = require('../api/order-status')._internal;

  await t('limite vale entre instâncias: 300 consultas somando duas instâncias passam, a 301ª dá 429 rate_limited', async () => {
    assert.equal(MAX_PER_IP, 300);
    const ip = newIp();
    await seed('order_status', ip, MAX_PER_IP - 2, 3);
    const a = freshInstance('api/order-status'), b = freshInstance('api/order-status');
    assert.notEqual(a, b, 'módulos distintos');
    assert.equal((await track(a, ip)).status, 404, '299ª');
    assert.equal((await track(b, ip)).status, 404, '300ª (outra instância)');
    const r = await track(a, ip);
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(r.body.error, 'Muitas consultas em pouco tempo. Aguarde alguns minutos.');
    assert.equal((await track(b, ip)).status, 429, 'segue barrado na outra instância');
  });
  await t('IP vem de x-real-ip: x-forwarded-for forjado não escapa; outro IP segue livre', async () => {
    const ip = newIp();
    await seed('order_status', ip, MAX_PER_IP, 1);
    const h = require('../api/order-status');
    assert.equal((await track(h, ip, { 'x-forwarded-for': newIp() })).status, 429);
    assert.equal((await track(h, newIp())).status, 404);
  });
  await t('janela de 10 min: minuto de 10 min atrás conta; de 11 min atrás não', async () => {
    const h = require('../api/order-status');
    const old = newIp();
    await seed('order_status', old, MAX_PER_IP, 11);
    assert.equal((await track(h, old)).status, 404, 'fora da janela');
    const edge = newIp();
    await seed('order_status', edge, MAX_PER_IP, 10);
    assert.equal((await track(h, edge)).status, 429, 'ainda dentro da janela');
  });
  await t('chamadas no mesmo minuto viram UMA linha (a tabela não cresce por chamada)', async () => {
    const ip = newIp(), h = require('../api/order-status');
    for (let i = 0; i < 5; i++) await track(h, ip);
    const rows = await sql.query(`select n from rate_hits where scope = 'order_status' and ip = $1`, [ip]);
    // Pode virar o minuto no meio: 1 ou 2 linhas, somando 5.
    assert.ok(rows.length <= 2, 'linhas: ' + rows.length);
    assert.equal(rows.reduce((s, r) => s + r.n, 0), 5);
  });

  console.log('\nCotação de frete (/api/store?a=quote)');
  const store = require('../api/store');
  const { QUOTE_MAX_PER_IP } = store._internal;

  await t('30 cotações passam (aqui 400 por CEP inválido), a 31ª dá 429 rate_limited, também em outra instância', async () => {
    assert.equal(QUOTE_MAX_PER_IP, 30);
    const ip = newIp();
    await seed('shipping_quote', ip, QUOTE_MAX_PER_IP - 1, 2);
    const r30 = await quote(store, ip);
    assert.equal(r30.status, 400); assert.equal(r30.body.code, 'invalid_cep');
    const r = await quote(freshInstance('api/store'), ip);
    assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(r.body.error, 'Muitas consultas de frete. Aguarde alguns minutos.');
    assert.equal((await quote(store, newIp())).status, 400, 'outro IP segue livre');
  });
  await t('limite da cotação é separado do acompanhamento do pedido (escopos distintos)', async () => {
    const ip = newIp();
    await seed('order_status', ip, MAX_PER_IP + 50, 1);
    assert.equal((await quote(store, ip)).status, 400);
  });
  await t('teto global de endereços novos: 429 shipping_busy', async () => {
    const real = shipping.tooManyNewLookups;
    shipping.tooManyNewLookups = async () => true;
    try {
      const r = await quote(store, newIp());
      assert.equal(r.status, 429); assert.equal(r.body.code, 'shipping_busy');
      assert.equal(r.body.error, 'Muitas consultas de frete agora. Tente de novo em instantes.');
    } finally { shipping.tooManyNewLookups = real; }
  });

  console.log('\nLimpeza e validação');
  await t('linhas com mais de 1 dia são apagadas de vez em quando na própria chamada', async () => {
    const ip = newIp();
    await seed('shipping_quote', ip, 3, 25 * 60);
    await seed('shipping_quote', ip, 4, 23 * 60);
    const realRandom = Math.random;
    Math.random = () => 0; // força a limpeza nesta chamada
    try { await hitExceeded(sql, 'shipping_quote', newIp(), { windowMinutes: 10, max: 30 }); } finally { Math.random = realRandom; }
    const rows = await sql.query('select n from rate_hits where ip = $1', [ip]);
    assert.deepEqual(rows.map(r => r.n), [4], 'só a de 23 h fica');
  });
  await t('escopo desconhecido é recusado (erro de programação, não grava nada)', async () => {
    await assert.rejects(hitExceeded(sql, 'outro', newIp(), { windowMinutes: 10, max: 1 }), /Escopo de limite desconhecido/);
  });

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error('limpeza:', e.message); } });
