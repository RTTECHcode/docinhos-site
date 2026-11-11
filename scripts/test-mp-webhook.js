// Teste simples do parser/validação do webhook: node scripts/test-mp-webhook.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const { parseSignature, verifySignature, signatureProblem, parseNotification, isLegacyIpn } = require('../api/mp-webhook')._internal;

const secret = 'segredo-de-teste';
const nowMs = Date.now();
const ts = String(nowMs); // ts atual em milissegundos (formato do Mercado Pago)
const requestId = 'req-123';
const dataId = '123456789';
const sign = (s, t, r = requestId, d = dataId) => crypto.createHmac('sha256', s).update(`id:${d};request-id:${r};ts:${t};`).digest('hex');
const v1 = sign(secret, ts);
const header = `ts=${ts},v1=${v1}`;

assert.deepStrictEqual(parseSignature(header), { ts, v1 });
assert.deepStrictEqual(parseSignature(''), {});

assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId, dataId }), true);
assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId, dataId: '999' }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId: 'outro', dataId }), false);
assert.strictEqual(verifySignature({ secret: 'errado', signatureHeader: header, requestId, dataId }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: `ts=${ts},v1=abc`, requestId, dataId }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: '', requestId, dataId }), false);

// ts em segundos também é aceito; ts velho (> 300 s) ou futuro distante é recusado, mesmo com HMAC correto.
const tsSec = String(Math.floor(nowMs / 1000));
const hdr = (t, s = secret) => `ts=${t},v1=${sign(s, t)}`;
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr(tsSec), requestId, dataId }), true, 'ts em segundos');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr(String(nowMs - 299000)), requestId, dataId }), true, 'ts 299 s atrás');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr(String(nowMs - 301000)), requestId, dataId }), false, 'ts 301 s atrás');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr(String(nowMs + 301000)), requestId, dataId }), false, 'ts 301 s no futuro');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr('1700000000'), requestId, dataId }), false, 'ts velho (s)');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr('1700000000000'), requestId, dataId }), false, 'ts velho (ms)');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr('abc'), requestId, dataId }), false, 'ts não numérico');
assert.strictEqual(verifySignature({ secret, signatureHeader: hdr(ts, 'outro-segredo'), requestId, dataId }), false, 'assinatura errada com ts atual');
assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId, dataId, nowMs: nowMs + 3600e3 }), false, 'relógio injetado 1 h depois');

// W2: segredo com espaço ou quebra de linha (colado na Vercel) continua valendo.
assert.strictEqual(verifySignature({ secret: secret + '\n', signatureHeader: header, requestId, dataId }), true, 'segredo com quebra de linha no fim');
assert.strictEqual(verifySignature({ secret: '  ' + secret + ' \r\n', signatureHeader: header, requestId, dataId }), true, 'segredo com espaços');

// W2: motivo da recusa (vai para o log; nunca contém o segredo nem o v1).
assert.strictEqual(signatureProblem({ secret, signatureHeader: header, requestId, dataId }), null);
assert.strictEqual(signatureProblem({ secret, signatureHeader: '', requestId, dataId }), 'sem x-signature');
assert.strictEqual(signatureProblem({ secret, signatureHeader: 'v1=abc', requestId, dataId }), 'x-signature sem ts ou v1');
assert.strictEqual(signatureProblem({ secret, signatureHeader: header, requestId: undefined, dataId }), 'sem x-request-id');
assert.strictEqual(signatureProblem({ secret, signatureHeader: header, requestId, dataId: '' }), 'sem data.id');
assert.strictEqual(signatureProblem({ secret, signatureHeader: hdr('abc'), requestId, dataId }), 'ts inválido');
assert.match(signatureProblem({ secret, signatureHeader: hdr(String(nowMs - 400000)), requestId, dataId }), /^ts fora da janela \(\d+ s\)$/);
const wrong = signatureProblem({ secret: 'outro', signatureHeader: header, requestId, dataId });
assert.match(wrong, /^HMAC diferente/);
assert.ok(!wrong.includes(v1) && !wrong.includes('outro'), 'motivo não vaza v1 nem segredo');

// W2: formato antigo IPN (?topic=&id=, sem data.id) é reconhecido; Webhooks (data.id) não.
assert.strictEqual(isLegacyIpn({ topic: 'payment', id: '123' }, {}), true);
assert.strictEqual(isLegacyIpn({ topic: 'merchant_order', id: '9' }, { resource: 'https://api.mercadolibre.com/merchant_orders/9', topic: 'merchant_order' }), true);
assert.strictEqual(isLegacyIpn({}, { resource: '123', topic: 'payment' }), true);
assert.strictEqual(isLegacyIpn({ 'data.id': '123', type: 'payment' }, {}), false);
assert.strictEqual(isLegacyIpn({}, { type: 'payment', data: { id: '123' } }), false);
assert.strictEqual(isLegacyIpn({ 'data.id': '123', type: 'payment', source_news: 'webhooks' }, {}), false);
assert.strictEqual(isLegacyIpn({}, {}), false);

assert.deepStrictEqual(parseNotification({}, { type: 'payment', data: { id: '123456789' } }), { type: 'payment', dataId: '123456789' });
assert.deepStrictEqual(parseNotification({ 'data.id': '55', type: 'payment' }, {}), { type: 'payment', dataId: '55' });
// data.id da query tem prioridade sobre o corpo (é o que entra no manifest assinado).
assert.deepStrictEqual(parseNotification({ 'data.id': '111', type: 'payment' }, { type: 'payment', data: { id: '222' } }), { type: 'payment', dataId: '111' });
assert.deepStrictEqual(parseNotification({ topic: 'merchant_order' }, null), { type: 'merchant_order', dataId: '' });
assert.deepStrictEqual(parseNotification({}, { type: 'payment', data: { id: 777 } }), { type: 'payment', dataId: '777' });

// Pix vira 'pix'; pagamento do Checkout Pro (cartão) vira 'mercadopago_card'.
const { paymentMethodOf } = require('../api/mp-webhook')._internal;
assert.strictEqual(paymentMethodOf({ payment_method_id: 'pix' }), 'pix');
assert.strictEqual(paymentMethodOf({ payment_method_id: 'visa' }), 'mercadopago_card');
assert.strictEqual(paymentMethodOf({}), 'mercadopago_card');
assert.strictEqual(paymentMethodOf(null), 'mercadopago_card');

// order-status: validação do código
const { CODE_RE } = require('../api/order-status')._internal;
assert.ok(CODE_RE.test('DG0123456789') && CODE_RE.test('DGABCDEF0123'));
for (const bad of ['', 'dg0123456789', 'DG012345678', 'DG01234567890', 'DG012345678G', "DG0123456789' or 1=1"]) assert.ok(!CODE_RE.test(bad), bad);

// Handler: sem segredo em produção responde 500; fora de produção segue (sem validar assinatura).
(async () => {
  const handler = require('../api/mp-webhook');
  const mkRes = () => { const r = { code: null, headers: {}, setHeader() {}, status(c) { r.code = c; return r; }, json() { return r; } }; return r; };
  const savedSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET, savedEnv = process.env.VERCEL_ENV;
  const origWarn = console.warn, origErr = console.error;
  console.warn = console.error = () => {};
  try {
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    process.env.VERCEL_ENV = 'production';
    let res = mkRes();
    await handler({ method: 'POST', query: {}, headers: {}, body: { type: 'payment', data: { id: '1' } } }, res);
    assert.strictEqual(res.code, 500, 'produção sem segredo deve responder 500');
    process.env.VERCEL_ENV = 'preview';
    res = mkRes();
    await handler({ method: 'POST', query: {}, headers: {}, body: { type: 'merchant_order', data: { id: '1' } } }, res);
    assert.strictEqual(res.code, 200, 'fora de produção sem segredo segue');
    process.env.MERCADOPAGO_WEBHOOK_SECRET = secret;
    res = mkRes();
    await handler({ method: 'POST', query: {}, headers: { 'x-signature': 'ts=1700000000,v1=abc', 'x-request-id': requestId }, body: { type: 'payment', data: { id: dataId } } }, res);
    assert.strictEqual(res.code, 401, 'assinatura inválida deve responder 401');

    // W2: o 401 grava o motivo no log, sem o segredo nem o v1.
    const logged = [];
    console.warn = (...a) => logged.push(a.join(' '));
    const badV1 = 'f'.repeat(64);
    res = mkRes();
    await handler({ method: 'POST', query: { 'data.id': dataId, type: 'payment' },
      headers: { 'x-signature': 'ts=' + Date.now() + ',v1=' + badV1, 'x-request-id': requestId, 'user-agent': 'MercadoPago WebHook v1.0 payment' }, body: {} }, res);
    assert.strictEqual(res.code, 401);
    assert.ok(logged.some(l => l.includes('HMAC diferente') && l.includes(requestId) && l.includes('MercadoPago WebHook v1.0')), 'log com motivo');
    assert.ok(!logged.some(l => l.includes(secret) || l.includes(badV1)), 'log sem segredo nem v1');
    console.warn = () => {};

    // W2: segredo com quebra de linha na variável de ambiente; assinatura certa passa (merchant_order: 200 sem consultar).
    process.env.MERCADOPAGO_WEBHOOK_SECRET = secret + '\n';
    const tsNow = String(Date.now());
    res = mkRes();
    await handler({ method: 'POST', query: { 'data.id': dataId, type: 'merchant_order' },
      headers: { 'x-signature': 'ts=' + tsNow + ',v1=' + sign(secret, tsNow), 'x-request-id': requestId }, body: {} }, res);
    assert.strictEqual(res.code, 200, 'segredo com quebra de linha no fim é aparado');
    process.env.MERCADOPAGO_WEBHOOK_SECRET = secret;

    // W2: IPN (Feed v2.0) recebe 200 sem processar e sem consultar o Mercado Pago, mesmo sem assinatura e em produção.
    process.env.VERCEL_ENV = 'production';
    const realFetch = globalThis.fetch; let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error('não deveria consultar'); };
    try {
      for (const q of [{ topic: 'payment', id: '123' }, { topic: 'merchant_order', id: '456' }]) {
        res = mkRes();
        await handler({ method: 'POST', query: q, headers: { 'user-agent': 'MercadoPago Feed v2.0 payment' }, body: { resource: q.id, topic: q.topic } }, res);
        assert.strictEqual(res.code, 200, 'IPN ' + q.topic);
      }
    } finally { globalThis.fetch = realFetch; }
    assert.strictEqual(fetched, 0);
  } finally {
    console.warn = origWarn; console.error = origErr;
    if (savedSecret === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET; else process.env.MERCADOPAGO_WEBHOOK_SECRET = savedSecret;
    if (savedEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnv;
  }
  console.log('mp-webhook: handler ok');
})().catch(e => { console.error(e); process.exit(1); });

console.log('mp-webhook: todos os testes passaram');
