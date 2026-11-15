// QA v4 (A6): N1, tabela completa de displayStatus (puro, sem banco).
// Uso: node scripts/test-v4-qa-status.js
'use strict';
const assert = require('node:assert/strict');
const { displayStatus } = require('../api/_lib/orders');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}
const ds = (fulfillment_status, payment_status, delivery_method = 'delivery') => displayStatus({ fulfillment_status, payment_status, delivery_method });

test('N1: preparo "new" depende do pagamento', () => {
  const cases = [
    [null, 'awaiting_payment', 'Aguardando pagamento'],
    ['pending', 'awaiting_payment', 'Aguardando pagamento'],
    ['in_process', 'awaiting_payment', 'Aguardando pagamento'],
    ['authorized', 'awaiting_payment', 'Aguardando pagamento'],
    ['rejected', 'payment_failed', 'Pagamento não concluído'],
    ['cancelled', 'payment_failed', 'Pagamento não concluído'],
    ['expired', 'payment_failed', 'Pagamento não concluído'],
    ['refunded', 'refunded', 'Pagamento estornado'],
    ['charged_back', 'refunded', 'Pagamento estornado'],
    ['approved', 'received', 'Pedido recebido']
  ];
  for (const [pay, key, label] of cases) assert.deepEqual(ds('new', pay), { key, label }, `pagamento ${pay}`);
});

test('N1: demais etapas seguem o preparo (com pagamento aprovado)', () => {
  const cases = [
    ['accepted', 'accepted', 'Pedido aceito'], ['preparing', 'preparing', 'Em preparo'], ['ready', 'ready', 'Pronto'],
    ['awaiting_delivery', 'awaiting_delivery', 'Saiu para entrega'], ['completed', 'completed', 'Concluído'],
    ['delivered', 'completed', 'Concluído']
  ];
  for (const [f, key, label] of cases) assert.deepEqual(ds(f, 'approved'), { key, label }, `preparo ${f}`);
});

test('N1: retirada em "aguardando entrega" = "Pronto para retirada"', () => {
  assert.deepEqual(ds('awaiting_delivery', 'approved', 'pickup'), { key: 'awaiting_delivery', label: 'Pronto para retirada' });
  assert.equal(ds('ready', 'approved', 'pickup').label, 'Pronto');
});

test('N1: cancelado vence tudo (qualquer pagamento)', () => {
  for (const pay of [null, 'pending', 'approved', 'refunded', 'rejected']) {
    assert.deepEqual(ds('cancelled', pay), { key: 'cancelled', label: 'Cancelado' }, `pagamento ${pay}`);
  }
});

console.log(`\n${passed} ok`);
