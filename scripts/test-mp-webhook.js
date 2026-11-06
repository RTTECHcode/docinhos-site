// Teste simples do parser/validação do webhook: node scripts/test-mp-webhook.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const { parseSignature, verifySignature, parseNotification } = require('../api/mp-webhook')._internal;

const secret = 'segredo-de-teste';
const ts = '1700000000';
const requestId = 'req-123';
const dataId = '123456789';
const v1 = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
const header = `ts=${ts},v1=${v1}`;

assert.deepStrictEqual(parseSignature(header), { ts, v1 });
assert.deepStrictEqual(parseSignature(''), {});

assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId, dataId }), true);
assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId, dataId: '999' }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: header, requestId: 'outro', dataId }), false);
assert.strictEqual(verifySignature({ secret: 'errado', signatureHeader: header, requestId, dataId }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: `ts=${ts},v1=abc`, requestId, dataId }), false);
assert.strictEqual(verifySignature({ secret, signatureHeader: '', requestId, dataId }), false);

assert.deepStrictEqual(parseNotification({}, { type: 'payment', data: { id: '123456789' } }), { type: 'payment', dataId: '123456789' });
assert.deepStrictEqual(parseNotification({ 'data.id': '55', type: 'payment' }, {}), { type: 'payment', dataId: '55' });
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

console.log('mp-webhook: todos os testes passaram');
