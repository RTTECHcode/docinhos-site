// Teste do handler real de /api/order contra o banco (req/res falsos).
// Uso: set -a && . ./.env && set +a && node scripts/test-order-handler.js [--mp]
// Sem --mp o token do Mercado Pago é removido do ambiente (nenhuma chamada externa).
// Todos os pedidos de teste (nome "__TESTE__") são apagados no final.
const assert = require('node:assert/strict');
const WITH_MP = process.argv.includes('--mp');
if (!WITH_MP) delete process.env.MERCADOPAGO_ACCESS_TOKEN;

const sql = require('../api/db');
const handler = require('../api/order');
const { STORE_ADDRESS } = handler._internal;

const NAME = '__TESTE__';
const PHONES = ['11900000001', '11900000002', '11900000003', '11900000004', '11900000005', '11900000006'];

function call(body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d, headers }); return this; }
    };
    Promise.resolve(handler({ method, body }, res)).catch(reject);
  });
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

async function cleanup() {
  const del = await sql.query('delete from orders where customer_name = $1 returning id', [NAME]);
  return del.length;
}

(async () => {
  await cleanup();
  const [copao] = await sql`select id from products where name = 'Copão da Felicidade'`;
  const [gel] = await sql`select id, price_cents from products where name = 'Geladinho Gourmet de Limão'`;
  const sizes = await sql.query(
    `select c.id, c.name, c.price_cents from product_complements pc join complements c on c.id = pc.complement_id
      where pc.product_id = $1 and c.kind = 'size' order by c.price_cents`, [copao.id]);
  const [nutella] = await sql.query(
    `select c.id, c.price_cents, pc.max_quantity from product_complements pc join complements c on c.id = pc.complement_id
      where pc.product_id = $1 and c.name = 'Topping - Nutella'`, [copao.id]);
  const [base] = await sql`select price_cents from products where id = ${copao.id}`;
  const big = sizes[sizes.length - 1];

  const valid = (over = {}) => ({
    customer_name: NAME, customer_phone: '(11) 90000-0001', delivery_method: 'delivery',
    address: 'Rua dos Testes, 123', notes: 'sem pressa',
    items: [{ product_id: copao.id, size_id: big.id, extras: [{ id: nutella.id, qty: 2 }], qty: 2 }],
    ...over
  });

  await test('GET retorna 405', async () => {
    const r = await call({}, 'GET');
    assert.equal(r.status, 405);
  });

  await test('pedido válido: 201, total calculado no servidor, gravado no banco', async () => {
    const r = await call(valid());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const unit = base.price_cents + big.price_cents + nutella.price_cents * 2;
    assert.equal(r.body.total_cents, unit * 2);
    assert.equal(r.body.delivery_method, 'delivery');
    assert.equal(r.body.address, 'Rua dos Testes, 123');
    assert.equal(r.body.items[0].unit_total_cents, unit);
    assert.deepEqual(r.body.items[0].extras, ['Topping - Nutella x2']);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.ok(/^DG[0-9A-F]{10}$/.test(r.body.code));
    if (!WITH_MP) assert.equal(r.body.payment, null);
    const [row] = await sql`select subtotal_cents, total_cents, customer_phone, items from orders where code = ${r.body.code}`;
    assert.equal(row.total_cents, unit * 2);
    assert.equal(row.subtotal_cents, unit * 2);
    assert.equal(row.customer_phone, '11900000001');
    assert.equal(row.items[0].name, 'Copão da Felicidade');
  });

  await test('preço adulterado no body é ignorado', async () => {
    const body = valid({ customer_phone: PHONES[1], items: [{ product_id: gel.id, qty: 3, unit_total_cents: 1, price_cents: 1, total_cents: 1 }], total_cents: 1, subtotal_cents: 1 });
    const r = await call(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total_cents, gel.price_cents * 3);
    assert.equal(r.body.items[0].unit_total_cents, gel.price_cents);
  });

  await test('delivery sem endereço -> 400', async () => {
    const r = await call(valid({ customer_phone: PHONES[2], address: '' }));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /endereço/i);
    const r2 = await call(valid({ customer_phone: PHONES[2], address: undefined }));
    assert.equal(r2.status, 400);
  });

  await test('pickup grava o endereço da loja (ignora o enviado)', async () => {
    const r = await call(valid({ customer_phone: PHONES[3], delivery_method: 'pickup', address: 'Av. Falsa, 999' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.address, STORE_ADDRESS);
    const [row] = await sql`select address, delivery_method from orders where code = ${r.body.code}`;
    assert.equal(row.address, STORE_ADDRESS);
    assert.equal(row.delivery_method, 'pickup');
  });

  await test('erros de validação -> 400 em português, sem vazar detalhes', async () => {
    const cases = [
      valid({ customer_phone: PHONES[4], items: [] }),
      valid({ customer_phone: PHONES[4], items: [{ product_id: 99999, qty: 1 }] }),
      valid({ customer_phone: PHONES[4], items: [{ product_id: copao.id, qty: 1 }] }), // falta size_id
      valid({ customer_phone: PHONES[4], items: [{ product_id: gel.id, qty: 21 }] }),
      valid({ customer_phone: '123' }),
      valid({ customer_phone: PHONES[4], delivery_method: 'x' })
    ];
    for (const c of cases) {
      const r = await call(c);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok(typeof r.body.error === 'string' && !/sql|stack|at /.test(r.body.error));
    }
    assert.equal((await call(null)).status, 400);
    assert.equal((await call('{ruim')).status, 400);
  });

  await test('rate limit: 5 pedidos por telefone em 10 min, o 6º retorna 429', async () => {
    const body = valid({ customer_phone: PHONES[5], items: [{ product_id: gel.id, qty: 1 }] });
    for (let i = 0; i < 5; i++) {
      const r = await call(body);
      assert.equal(r.status, 201, `pedido ${i + 1}: ${JSON.stringify(r.body)}`);
    }
    const r = await call(body);
    assert.equal(r.status, 429);
    // mesmo número com formatação diferente continua contando como o mesmo telefone
    const r2 = await call({ ...body, customer_phone: '+55 (11) 90000-0006'.replace('+55 ', '') });
    assert.equal(r2.status, 429);
    const [{ n }] = await sql`select count(*)::int n from orders where customer_phone = ${PHONES[5]}`;
    assert.equal(n, 5);
  });

  if (WITH_MP) {
    await test('Mercado Pago aceita o corpo da preference (payment.url/id presentes)', async () => {
      const r = await call(valid({ customer_phone: '11900000007' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.payment && /^https:\/\//.test(r.body.payment.url) && r.body.payment.id, 'payment veio null: ver log de erro acima');
    });
  }

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    const n = await cleanup().catch(() => -1);
    console.log(`pedidos de teste apagados: ${n}`);
  });
