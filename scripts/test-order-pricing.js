// Testes da função pura de preço (sem banco): node scripts/test-order-pricing.js
const assert = require('node:assert/strict');
const { priceItems, validateCustomer, buildPreferenceItems, buildPreferenceBody, buildPixBody, pixPayerEmail, PAYMENT_CHOICES, STORE_ADDRESS, ValidationError } = require('../api/order')._internal;

const comp = (id, name, price_cents, kind, max_quantity = 1, group_id = null) => ({ id, name, price_cents, kind, max_quantity, group_id });
const catalog = {
  products: new Map([
    [1, { id: 1, name: 'Copão', price_cents: 1800 }],
    [2, { id: 2, name: 'Geladinho', price_cents: 600 }],
    [3, { id: 3, name: 'Só por tamanho', price_cents: null }],
    [4, { id: 4, name: 'Sem preço', price_cents: null }],
    [5, { id: 5, name: 'Com grupos', price_cents: 1000 }]
  ]),
  complements: new Map([
    [1, new Map([
      [10, comp(10, 'Copo 250ml', 0, 'size')],
      [11, comp(11, 'Copo 500ml', 1700, 'size')],
      [20, comp(20, 'Nutella', 299, 'additional', 3)],
      [21, comp(21, 'Granola', 100, 'additional', 1)]
    ])],
    [3, new Map([[12, comp(12, 'Grande', 2500, 'size')]])],
    [5, new Map([
      [40, comp(40, 'Brig A', 0, 'additional', 1, 1)],
      [41, comp(41, 'Brig B', 100, 'additional', 1, 1)],
      [42, comp(42, 'Brig C', 200, 'additional', 1, 1)],
      [50, comp(50, 'Fruta A', 0, 'additional', 1, 2)],
      [51, comp(51, 'Fruta B', 0, 'additional', 1, 2)],
      [60, comp(60, 'Solto', 50, 'additional', 3, null)]
    ])]
  ]),
  groups: new Map([[5, new Map([
    [1, { id: 1, label: 'Escolha o brigadeiro', min_choices: 0, max_choices: 2 }],
    [2, { id: 2, label: 'Escolha sua fruta', min_choices: 1, max_choices: 1 }]
  ])]])
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

test('grupos: dentro do limite soma preço dos extras', () => {
  const r = priceItems([{ product_id: 5, extras: [{ id: 41, qty: 1 }, { id: 42, qty: 1 }, { id: 50, qty: 1 }], qty: 1 }], catalog);
  assert.equal(r.items[0].unit_total_cents, 1000 + 100 + 200);
});
test('grupos: exceder o máximo do grupo (soma das qty)', () => rejects(
  [{ product_id: 5, extras: [{ id: 40, qty: 1 }, { id: 41, qty: 1 }, { id: 42, qty: 1 }, { id: 50, qty: 1 }], qty: 1 }],
  /^Item 1: escolha até 2 em "Escolha o brigadeiro".$/));
test('grupos: abaixo do mínimo (inclusive sem nenhum extra)', () => {
  rejects([{ product_id: 5, extras: [{ id: 40, qty: 1 }], qty: 1 }], /^Item 1: escolha pelo menos 1 em "Escolha sua fruta".$/);
  rejects([{ product_id: 5, qty: 1 }], /pelo menos 1 em "Escolha sua fruta"/);
  rejects([{ product_id: 5, extras: [], qty: 1 }], /pelo menos 1/);
});
test('grupos: exceder o máximo do grupo mínimo-1 (fruta)', () => rejects(
  [{ product_id: 5, extras: [{ id: 50, qty: 1 }, { id: 51, qty: 1 }], qty: 1 }], /escolha até 1 em "Escolha sua fruta"/));
test('grupos: max_quantity do extra continua valendo dentro do grupo', () => rejects(
  [{ product_id: 5, extras: [{ id: 50, qty: 2 }], qty: 1 }], /permite de 1 a 1/));
test('sem grupo: item solto usa só max_quantity e não conta para grupos', () => {
  const r = priceItems([{ product_id: 5, extras: [{ id: 50, qty: 1 }, { id: 60, qty: 3 }], qty: 1 }], catalog);
  assert.equal(r.items[0].unit_total_cents, 1000 + 150);
  rejects([{ product_id: 5, extras: [{ id: 50, qty: 1 }, { id: 60, qty: 4 }], qty: 1 }], /"Solto" permite de 1 a 3/);
});
test('produto sem grupos (catálogo sem groups) segue a regra antiga', () => {
  const r = priceItems([{ product_id: 1, size_id: 10, extras: [{ id: 20, qty: 3 }], qty: 1 }], { products: catalog.products, complements: catalog.complements });
  assert.equal(r.items[0].unit_total_cents, 1800 + 299 * 3);
});

test('validateCustomer: regras de nome, telefone, entrega e observações', () => {
  const ok = { customer_name: '  Ana  ', customer_phone: '(11) 91234-5678', delivery_method: 'delivery', cep: '06000-001', address: 'Rua A, 10', notes: '' };
  const c = validateCustomer(ok);
  assert.equal(c.name, 'Ana');
  assert.equal(c.cep, '06000001');
  assert.equal(c.phone, '11912345678');
  assert.equal(c.notes, null);
  const bad = patch => assert.throws(() => validateCustomer({ ...ok, ...patch }), ValidationError);
  bad({ customer_name: 'A' });
  bad({ customer_name: 'x'.repeat(81) });
  bad({ customer_phone: '123456789' });
  bad({ customer_phone: '1'.repeat(14) });
  bad({ delivery_method: 'drone' });
  bad({ cep: undefined }); // entrega exige CEP (frete por distância)
  bad({ cep: '123' });
  bad({ address: '' });
  bad({ address: 'abcd' });
  bad({ address: 'x'.repeat(201) });
  bad({ notes: 'x'.repeat(301) });
  const p = validateCustomer({ ...ok, delivery_method: 'pickup', address: 'qualquer coisa' });
  assert.equal(p.address, STORE_ADDRESS);
});

test('pix: corpo do pagamento direto (valor do servidor, 30 min, e-mail sintético)', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const body = buildPixBody({ code: 'DG0123456789', total_cents: 4599 }, '  Maria  da Silva ', now);
  assert.equal(body.payment_method_id, 'pix');
  assert.equal(body.transaction_amount, 45.99);
  assert.equal(body.external_reference, 'DG0123456789');
  assert.equal(body.description, 'Pedido DG0123456789 - Docinhos da Gigi');
  assert.equal(body.notification_url, 'https://docinhos-site.vercel.app/api/mp-webhook');
  assert.equal(body.date_of_expiration, '2026-01-01T10:30:00.000+00:00');
  assert.equal(body.payer.email, 'pedido-dg0123456789@docinhos-site.vercel.app');
  assert.equal(body.payer.first_name, 'Maria');
  assert.equal(pixPayerEmail('DGABCDEF0123'), 'pedido-dgabcdef0123@docinhos-site.vercel.app');
  assert.equal(buildPixBody({ code: 'DGX', total_cents: 600 }, '', now).payer.first_name, 'Cliente');
  assert.deepEqual(PAYMENT_CHOICES, ['pix', 'card']);
});

test('preference (cartão): soma dos itens (com e sem taxa de entrega) == total do pedido', () => {
  const r = priceItems([{ product_id: 1, qty: 2, size_id: 11, extras: [{ id: 20, qty: 2 }, { id: 21, qty: 1 }] }], catalog);
  for (const fee of [0, 500, 799]) {
    const total = r.subtotal_cents + fee;
    const items = buildPreferenceItems(r.items, fee);
    const sum = items.reduce((s, i) => s + Math.round(i.unit_price * i.quantity * 100), 0);
    assert.equal(sum, total, `taxa ${fee}`);
    assert.equal(items.some(i => i.id === 'frete'), fee > 0);
  }
  const frete = buildPreferenceItems(r.items, 799).find(i => i.id === 'frete');
  assert.deepEqual(frete, { id: 'frete', title: 'Taxa de entrega', quantity: 1, currency_id: 'BRL', unit_price: 7.99 });
  assert.equal(buildPreferenceItems(r.items).length, r.items.length);
});

test('retirada não exige CEP e devolve o número informado na entrega', () => {
  const base = { customer_name: 'Maria', customer_phone: '11999998888' };
  assert.equal(validateCustomer({ ...base, delivery_method: 'pickup' }).cep, null);
  assert.equal(validateCustomer({ ...base, delivery_method: 'delivery', cep: '06000001', address: 'Rua das Flores', address_number: '45' }).number, '45');
});

test('produto pausado é recusado com o rótulo do produto, o padrão da loja ou "volto logo <3"', () => {
  const mk = product => ({ ...catalog, products: new Map([[2, { id: 2, name: 'Geladinho', price_cents: 600, ...product }]]), complements: new Map() });
  const err = c => { try { priceItems([{ product_id: 2, qty: 1 }], c); } catch (e) { return e; } return null; };
  let e = err(mk({ paused: true, pause_label: 'volta amanhã' }));
  assert.ok(e instanceof ValidationError); assert.match(e.message, /Geladinho/); assert.match(e.message, /volta amanhã/);
  e = err({ ...mk({ paused: true }), defaultPauseLabel: 'já já' });
  assert.match(e.message, /já já/);
  e = err(mk({ paused: true }));
  assert.match(e.message, /volto logo <3/);
  assert.equal(err(mk({ paused: false })), null);
});

test('preference com desconto de pontos: soma == total e nunca item de valor zero/negativo', () => {
  const r = priceItems([{ product_id: 1, qty: 2, size_id: 11 }], catalog); // 2 x 3500 = 7000
  for (const [fee, discount] of [[0, 1000], [600, 2000], [900, 7000], [0, 3000]]) {
    const items = buildPreferenceItems(r.items, fee, discount, 'DG-1234');
    const sum = items.reduce((s, i) => s + Math.round(i.unit_price * i.quantity * 100), 0);
    assert.equal(sum, r.subtotal_cents - discount + fee, `taxa ${fee} desconto ${discount}`);
    assert.ok(items.every(i => i.unit_price > 0));
  }
  assert.match(buildPreferenceItems(r.items, 0, 1000, 'DG-1234')[0].title, /DG-1234/);
});

test('pix: descrição usa o DG-#### quando existe', () => {
  assert.match(buildPixBody({ code: 'DG0123456789', public_code: 'DG-4821', total_cents: 1000 }, 'Ana').description, /^Pedido DG-4821 /);
});

test('pix: transaction_amount inclui a taxa (total do pedido)', () => {
  const body = buildPixBody({ code: 'DGX', total_cents: 4599 + 799 }, 'Ana');
  assert.equal(body.transaction_amount, 53.98);
});

test('cliente: caracteres de controle rejeitados em nome, endereço e observações', () => {
  const base = { customer_name: 'Maria', customer_phone: '11999998888', delivery_method: 'delivery', cep: '06000001', address: 'Rua das Flores, 10', notes: 'sem cebola' };
  assert.equal(validateCustomer(base).name, 'Maria');
  assert.equal(validateCustomer({ ...base, notes: 'linha 1\nlinha 2' }).notes, 'linha 1\nlinha 2'); // quebra de linha ok nas observações
  const bads = [['customer_name', 'Ma\x00ria'], ['customer_name', 'Ma\nria'], ['address', 'Rua\x07 das Flores, 10'], ['address', 'Rua\r\nA, 10'], ['notes', 'oi\x1b[31m'], ['notes', 'oi\x7f']];
  for (const [field, val] of bads) {
    assert.throws(() => validateCustomer({ ...base, [field]: val }), e => e instanceof ValidationError && /inválidos/.test(e.message), field);
  }
});

test('preference (cartão): sem Pix, boleto, atm e pré-pago; 3x; expira em 2h', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const body = buildPreferenceBody({ code: 'DGX' }, [], now);
  const excluded = body.payment_methods.excluded_payment_types.map(t => t.id).sort();
  // bank_transfer = Pix (fica no site). account_money não pode ser excluído (a API do MP devolve 400).
  assert.deepEqual(excluded, ['atm', 'bank_transfer', 'prepaid_card', 'ticket']);
  assert.ok(!excluded.includes('account_money'));
  assert.ok(!excluded.includes('credit_card') && !excluded.includes('debit_card'), 'cartões não podem ser excluídos');
  assert.equal(body.payment_methods.installments, 3);
  assert.equal(body.expires, true);
  assert.equal(body.expiration_date_from, '2026-01-01T10:00:00.000+00:00');
  assert.equal(body.expiration_date_to, '2026-01-01T12:00:00.000+00:00');
  assert.equal(body.external_reference, 'DGX');
});

// ---------- Regra de pontos editável (api/_lib/loyalty.js, funções puras) ----------
const loyalty = require('../api/_lib/loyalty');
const loyaltyThrows = (fn, status, code) => {
  try { fn(); } catch (e) { assert.ok(e instanceof loyalty.LoyaltyError, 'tipo do erro'); assert.deepEqual([e.status, e.code], [status, code]); return e; }
  assert.fail('devia falhar');
};

test('pontos: padrão = regra antiga (1 ponto por R$ 1; 100 pontos = R$ 10)', () => {
  assert.deepEqual({ ...loyalty.DEFAULT_RULES }, { enabled: true, points_per_real: 1, block_points: 100, block_value_cents: 1000 });
  assert.equal(loyalty.earnPoints(2599, 0), 25);
  assert.equal(loyalty.earnPoints(2000, 1000), 10);
  assert.equal(loyalty.discountForPoints(300), 3000);
  assert.equal(loyalty.maxRedeemablePoints(2599, 900), 200);
  assert.deepEqual(loyalty.validateRedemption({ points: 100, subtotalCents: 2000, balance: 250 }), { points: 100, discount_cents: 1000 });
});

test('pontos: regra customizada muda ganho, bloco e desconto (2 pts/R$; 50 pts = R$ 5)', () => {
  const r = { enabled: true, points_per_real: 2, block_points: 50, block_value_cents: 500 };
  assert.equal(loyalty.earnPoints(2599, 0, r), 51);           // R$ 25,99 x 2 = 51,98 -> 51
  assert.equal(loyalty.earnPoints(2000, 500, r), 30);
  assert.equal(loyalty.earnPoints(300, 1000, r), 0);           // nunca negativo
  assert.equal(loyalty.discountForPoints(150, r), 1500);
  assert.equal(loyalty.maxRedeemablePoints(1299, 1000, r), 100); // R$ 12,99 cabe 2 blocos de R$ 5
  assert.equal(loyalty.maxRedeemablePoints(5000, 120, r), 100);  // saldo cabe 2 blocos
  assert.deepEqual(loyalty.validateRedemption({ points: 150, subtotalCents: 2000, balance: 200, rules: r }), { points: 150, discount_cents: 1500 });
  const e = loyaltyThrows(() => loyalty.validateRedemption({ points: 75, subtotalCents: 2000, balance: 500, rules: r }), 400, 'invalid_block');
  assert.match(e.message, /blocos de 50 \(50 pontos = R\$ 5,00\)/);
});

test('pontos: desconto do resgate nunca passa do valor dos produtos', () => {
  const r = { enabled: true, points_per_real: 1, block_points: 100, block_value_cents: 5000 };
  const e = loyaltyThrows(() => loyalty.validateRedemption({ points: 100, subtotalCents: 4999, balance: 500, rules: r }), 400, 'discount_too_big');
  assert.match(e.message, /100 pontos \(R\$ 50,00\)/);
  assert.deepEqual(loyalty.validateRedemption({ points: 100, subtotalCents: 5000, balance: 500, rules: r }), { points: 100, discount_cents: 5000 });
  loyaltyThrows(() => loyalty.validateRedemption({ points: 200, subtotalCents: 1999, balance: 500 }), 400, 'discount_too_big');
});

test('pontos: programa desligado recusa resgate (409 points_disabled); sem pontos o pedido passa', () => {
  const off = { ...loyalty.DEFAULT_RULES, enabled: false };
  loyaltyThrows(() => loyalty.validateRedemption({ points: 100, subtotalCents: 5000, balance: 500, rules: off }), 409, 'points_disabled');
  assert.deepEqual(loyalty.validateRedemption({ points: 0, subtotalCents: 5000, balance: 500, rules: off }), { points: 0, discount_cents: 0 });
  loyaltyThrows(() => loyalty.validateRedemption({ points: -100, subtotalCents: 5000, balance: 500, rules: off }), 400, 'invalid_points');
});

test('pontos: validateRules aceita limites e recusa negativo, zero, fração, texto, acima do máximo e retorno > 50%', () => {
  const ok = { enabled: true, points_per_real: 1, block_points: 100, block_value_cents: 1000 };
  assert.deepEqual(loyalty.validateRules(ok), ok);
  assert.deepEqual(loyalty.validateRules({ enabled: false, points_per_real: 10, block_points: 10000, block_value_cents: 10000 }).enabled, false);
  assert.deepEqual(loyalty.validateRules({ enabled: true, points_per_real: 1, block_points: 10, block_value_cents: 500 }).block_points, 10); // 50%: no limite
  const bads = [
    null, [], 'x', { ...ok, enabled: 'sim' }, { ...ok, enabled: undefined },
    { ...ok, points_per_real: 0 }, { ...ok, points_per_real: -1 }, { ...ok, points_per_real: 1.5 }, { ...ok, points_per_real: 11 }, { ...ok, points_per_real: '1' },
    { ...ok, block_points: 9 }, { ...ok, block_points: 10001 }, { ...ok, block_points: -100 }, { ...ok, block_points: null },
    { ...ok, block_value_cents: 99 }, { ...ok, block_value_cents: 10001 }, { ...ok, block_value_cents: -1000 }, { ...ok, block_value_cents: 10.5 },
    { ...ok, block_points: 10, block_value_cents: 510 },          // 51% de volta
    { enabled: true, points_per_real: 10, block_points: 100, block_value_cents: 1000 } // 100% de volta
  ];
  for (const b of bads) loyaltyThrows(() => loyalty.validateRules(b), 400, 'invalid_rules');
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
