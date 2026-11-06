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

console.log('mp-webhook: todos os testes passaram');
