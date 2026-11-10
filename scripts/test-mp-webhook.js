// Teste simples do parser/validação do webhook: node scripts/test-mp-webhook.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const { parseSignature, verifySignature, parseNotification } = require('../api/mp-webhook')._internal;

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
  } finally {
    console.warn = origWarn; console.error = origErr;
    if (savedSecret === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET; else process.env.MERCADOPAGO_WEBHOOK_SECRET = savedSecret;
    if (savedEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnv;
  }
  console.log('mp-webhook: handler ok');
})().catch(e => { console.error(e); process.exit(1); });

console.log('mp-webhook: todos os testes passaram');
