// Testes da função pura de preço (sem banco): node scripts/test-order-pricing.js
const assert = require('node:assert/strict');
const { priceItems, validateCustomer, buildPreferenceBody, STORE_ADDRESS, ValidationError } = require('../api/order')._internal;

const comp = (id, name, price_cents, kind, max_quantity = 1) => ({ id, name, price_cents, kind, max_quantity });
const catalog = {
  products: new Map([
    [1, { id: 1, name: 'Copão', price_cents: 1800 }],
    [2, { id: 2, name: 'Geladinho', price_cents: 600 }],
    [3, { id: 3, name: 'Só por tamanho', price_cents: null }],
    [4, { id: 4, name: 'Sem preço', price_cents: null }]
  ]),
  complements: new Map([
    [1, new Map([
      [10, comp(10, 'Copo 250ml', 0, 'size')],
      [11, comp(11, 'Copo 500ml', 1700, 'size')],
      [20, comp(20, 'Nutella', 299, 'additional', 3)],
      [21, comp(21, 'Granola', 100, 'additional', 1)]
    ])],
    [3, new Map([[12, comp(12, 'Grande', 2500, 'size')]])]
  ])
};

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}
const rejects = (items, re) => assert.throws(() => priceItems(items, catalog), e => e instanceof ValidationError && re.test(e.message));

test('preço = produto + tamanho + adicionais*qty', () => {
  const r = priceItems([{ product_id: 1, size_id: 11, extras: [{ id: 20, qty: 2 }, { id: 21, qty: 1 }], qty: 2 }], catalog);
  assert.equal(r.items[0].unit_total_cents, 1800 + 1700 + 299 * 2 + 100);
  assert.equal(r.subtotal_cents, r.items[0].unit_total_cents * 2);
  assert.deepEqual(r.items[0].extras, ['Nutella x2', 'Granola']);
  assert.equal(r.items[0].size, 'Copo 500ml');
});

test('preço adulterado vindo do cliente é ignorado', () => {
  const r = priceItems([{ product_id: 2, qty: 1, unit_total_cents: 1, price_cents: 1, price: 0.01, total_cents: 1 }], catalog);
  assert.equal(r.items[0].unit_total_cents, 600);
  assert.equal(r.subtotal_cents, 600);
});

test('produto sem tamanhos: size_id é rejeitado', () => rejects([{ product_id: 2, size_id: 10, qty: 1 }], /não possui tamanhos/));
test('produto com tamanhos exige size_id', () => rejects([{ product_id: 1, qty: 1 }], /escolha o tamanho/i));
test('size_id de outro produto é rejeitado', () => rejects([{ product_id: 1, size_id: 12, qty: 1 }], /tamanho inválido/));
test('size_id apontando para adicional é rejeitado', () => rejects([{ product_id: 1, size_id: 20, qty: 1 }], /tamanho inválido/));
test('extra acima do máximo', () => rejects([{ product_id: 1, size_id: 10, extras: [{ id: 21, qty: 2 }], qty: 1 }], /permite de 1 a 1/));
test('extra com qty 0 ou fracionada', () => {
  rejects([{ product_id: 1, size_id: 10, extras: [{ id: 20, qty: 0 }], qty: 1 }], /permite/);
  rejects([{ product_id: 1, size_id: 10, extras: [{ id: 20, qty: 1.5 }], qty: 1 }], /permite/);
});
test('extra que é tamanho / de outro produto / repetido', () => {
  rejects([{ product_id: 1, size_id: 10, extras: [{ id: 11, qty: 1 }], qty: 1 }], /adicional inválido/);
  rejects([{ product_id: 2, extras: [{ id: 20, qty: 1 }], qty: 1 }], /adicional inválido/);
  rejects([{ product_id: 1, size_id: 10, extras: [{ id: 20, qty: 1 }, { id: 20, qty: 1 }], qty: 1 }], /repetido/);
});
test('quantidade absurda / inválida', () => {
  for (const qty of [0, -1, 21, 1e9, 1.5, '2', null, undefined, NaN, Infinity])
    rejects([{ product_id: 2, qty }], /quantidade/);
});
test('mais de 30 itens', () => rejects(Array.from({ length: 31 }, () => ({ product_id: 2, qty: 1 })), /no máximo 30/));
test('carrinho vazio / não-array', () => {
  rejects([], /vazio/);
  assert.throws(() => priceItems(null, catalog), ValidationError);
});
test('produto inexistente/inativo e id inválido', () => {
  rejects([{ product_id: 999, qty: 1 }], /indisponível/);
  rejects([{ product_id: '2', qty: 1 }], /produto inválido/);
  rejects([{ product_id: -1, qty: 1 }], /produto inválido/);
});
test('produto com preço nulo: ok só com tamanho; senão erro', () => {
  const r = priceItems([{ product_id: 3, size_id: 12, qty: 1 }], catalog);
  assert.equal(r.items[0].unit_total_cents, 2500);
  rejects([{ product_id: 4, qty: 1 }], /sem preço/);
});

test('validateCustomer: regras de nome, telefone, entrega e observações', () => {
  const ok = { customer_name: '  Ana  ', customer_phone: '(11) 91234-5678', delivery_method: 'delivery', address: 'Rua A, 10', notes: '' };
  const c = validateCustomer(ok);
  assert.equal(c.name, 'Ana');
  assert.equal(c.phone, '11912345678');
  assert.equal(c.notes, null);
  const bad = patch => assert.throws(() => validateCustomer({ ...ok, ...patch }), ValidationError);
  bad({ customer_name: 'A' });
  bad({ customer_name: 'x'.repeat(81) });
  bad({ customer_phone: '123456789' });
  bad({ customer_phone: '1'.repeat(14) });
  bad({ delivery_method: 'drone' });
  bad({ address: '' });
  bad({ address: 'abcd' });
  bad({ address: 'x'.repeat(201) });
  bad({ notes: 'x'.repeat(301) });
  const p = validateCustomer({ ...ok, delivery_method: 'pickup', address: 'qualquer coisa' });
  assert.equal(p.address, STORE_ADDRESS);
});

test('preference: Pix + crédito + débito, 3x, expira em 2h', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const body = buildPreferenceBody({ code: 'DGX' }, [], now);
  const excluded = body.payment_methods.excluded_payment_types.map(t => t.id).sort();
  // account_money não pode ser excluído (a API do MP devolve 400).
  assert.deepEqual(excluded, ['atm', 'prepaid_card', 'ticket']);
  assert.ok(!excluded.includes('account_money'));
  assert.ok(!excluded.includes('bank_transfer'), 'bank_transfer (Pix) não pode ser excluído');
  assert.equal(body.payment_methods.installments, 3);
  assert.equal(body.expires, true);
  assert.equal(body.expiration_date_from, '2026-01-01T10:00:00.000+00:00');
  assert.equal(body.expiration_date_to, '2026-01-01T12:00:00.000+00:00');
  assert.equal(body.external_reference, 'DGX');
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
