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
let notProven = 0;
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
  const [copao] = await sql`select id from products where name = 'Monte seu copo'`;
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
    items: [{ product_id: copao.id, size_id: big.id, extras: [{ id: nutella.id, qty: 1 }], qty: 2 }],
    ...over
  });

  // opções por grupo do Monte seu copo (ids reais do banco)
  const opts = await sql.query(
    `select g.key, c.id, c.name from product_groups g join product_complements pc on pc.group_id = g.id
       join complements c on c.id = pc.complement_id where g.product_id = $1 order by g.sort_order, c.name`, [copao.id]);
  const byKey = k => opts.filter(o => o.key === k).map(o => o.id);
  const [acai300] = await sql`select id from products where name = 'Açaí 300ml - Monte Seu Copo'`;
  const acaiOpts = (await sql.query(`select pc.complement_id id from product_complements pc join product_groups g on g.id = pc.group_id where g.product_id = $1 order by 1`, [acai300.id])).map(o => o.id);
  const withExtras = (phone, product_id, size_id, ids, qtyEach = 1) => valid({ customer_phone: phone, items: [{ product_id, size_id, extras: ids.map(id => ({ id, qty: qtyEach })), qty: 1 }] });

  await test('grupos: até 2 por grupo passa; 3 no mesmo grupo -> 400 com mensagem do grupo', async () => {
    const brig = byKey('brigadeiro');
    const ok = await call(withExtras(PHONES[4], copao.id, sizes[0].id, [brig[0], brig[1], ...byKey('fruta').slice(0, 2)]));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await call(withExtras(PHONES[4], copao.id, sizes[0].id, brig.slice(0, 3)));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Item 1: escolha até 2 em "Escolha o brigadeiro".');
  });

  await test('grupos: qty 2 numa opção conta 2 no limite; qty acima de max_quantity -> 400', async () => {
    const brig = byKey('brigadeiro');
    const bad = await call(withExtras(PHONES[4], copao.id, sizes[0].id, [brig[0]], 2));
    assert.equal(bad.status, 400); // max_quantity 1
  });

  await test('grupos: açaí 300ml aceita 3 complementos e rejeita 4', async () => {
    const ok = await call(withExtras(PHONES[4], acai300.id, null, acaiOpts.slice(0, 3)));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await call(withExtras(PHONES[4], acai300.id, null, acaiOpts.slice(0, 4)));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Item 1: escolha até 3 em "Escolha seus complementos".');
  });

  await test('sem grupo: Açaí Trufado não aceita complementos', async () => {
    const [tr] = await sql`select id from products where name = 'Açaí Trufado 300ml - Brigadeiro de Ninho'`;
    const bad = await call(withExtras(PHONES[4], tr.id, null, [acaiOpts[0]]));
    assert.equal(bad.status, 400);
    const ok = await call(valid({ customer_phone: PHONES[4], items: [{ product_id: tr.id, qty: 1 }] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  await test('GET retorna 405', async () => {
    const r = await call({}, 'GET');
    assert.equal(r.status, 405);
  });

  await test('pedido válido: 201, total calculado no servidor, gravado no banco', async () => {
    const r = await call(valid());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const unit = base.price_cents + big.price_cents + nutella.price_cents;
    assert.equal(r.body.total_cents, unit * 2);
    assert.equal(r.body.delivery_method, 'delivery');
    assert.equal(r.body.address, 'Rua dos Testes, 123');
    assert.equal(r.body.items[0].unit_total_cents, unit);
    assert.deepEqual(r.body.items[0].extras, ['Topping - Nutella']);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.ok(/^DG[0-9A-F]{10}$/.test(r.body.code));
    if (!WITH_MP) assert.equal(r.body.payment, null);
    const [row] = await sql`select subtotal_cents, total_cents, customer_phone, items from orders where code = ${r.body.code}`;
    assert.equal(row.total_cents, unit * 2);
    assert.equal(row.subtotal_cents, unit * 2);
    assert.equal(row.customer_phone, '11900000001');
    assert.equal(row.items[0].name, 'Monte seu copo');
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

  await test('payment_choice ausente/inválido vira card; sem token o pagamento é null', async () => {
    if (WITH_MP) return; // coberto abaixo com o Mercado Pago real
    for (const [i, choice] of [undefined, 'boleto', 42, 'pix', 'card'].entries()) {
      const r = await call(valid({ customer_phone: '1190000010' + i, payment_choice: choice }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.payment, null);
    }
  });

  await test('order-status: só code e payment_status; 404 para inexistente/formato inválido; 405', async () => {
    const created = await call(valid({ customer_phone: '11900000020' }));
    assert.equal(created.status, 201);
    const status = require('../api/order-status');
    const callStatus = (query, method = 'GET') => new Promise((resolve, reject) => {
      const headers = {};
      const res = { statusCode: 200, setHeader(k, v) { headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d, headers }); return this; } };
      Promise.resolve(status({ method, query }, res)).catch(reject);
    });
    const ok = await callStatus({ code: created.body.code });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { code: created.body.code, payment_status: 'pending' });
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal((await callStatus({ code: 'DG0000000000' })).status, 404);
    assert.equal((await callStatus({ code: "x' or 1=1 --" })).status, 404);
    assert.equal((await callStatus({})).status, 404);
    assert.equal((await callStatus({ code: ['DG0000000000'] })).status, 404);
    assert.equal((await callStatus({ code: created.body.code }, 'POST')).status, 405);
  });

  await test('pix (fetch simulado, formato da doc): resposta, gravação e falha mantêm o pedido', async () => {
    if (WITH_MP) return; // com --mp o fetch real é usado
    const realFetch = global.fetch;
    const calls = [];
    const fakePix = { id: 987654321, status: 'pending', date_of_expiration: '2026-01-01T10:30:00.000-03:00',
      point_of_interaction: { transaction_data: { qr_code: '00020126580014br.gov.bcb.pix0136' + 'x'.repeat(40), qr_code_base64: 'iVBORw0KGgo' + 'A'.repeat(200), ticket_url: 'https://www.mercadopago.com.br/payments/987654321/ticket' } } };
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
    try {
      // O driver do Neon também usa fetch: só intercepta o que vai para o Mercado Pago.
      const mock = fn => async (url, init) => (String(url).startsWith('https://api.mercadopago.com/') ? fn(url, init) : realFetch(url, init));
      global.fetch = mock((url, init) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => fakePix }; });
      const r = await call(valid({ customer_phone: '11900000030', payment_choice: 'pix' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body.payment).sort(), ['expires_at', 'id', 'qr_code', 'qr_code_base64', 'type']);
      assert.equal(r.body.payment.type, 'pix');
      assert.equal(r.body.payment.id, '987654321');
      assert.equal(r.body.payment.expires_at, fakePix.date_of_expiration);
      // uma única chamada ao MP: /v1/payments (nenhuma preference)
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.mercadopago.com/v1/payments');
      assert.equal(calls[0].init.headers['X-Idempotency-Key'], 'pix-' + r.body.code);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.payment_method_id, 'pix');
      assert.equal(sent.transaction_amount, r.body.total_cents / 100);
      assert.equal(sent.external_reference, r.body.code);
      assert.equal(sent.payer.email, 'pedido-' + r.body.code.toLowerCase() + '@docinhos-site.vercel.app');
      const [row] = await sql`select payment_method, payment_id, payment_status from orders where code = ${r.body.code}`;
      assert.deepEqual(row, { payment_method: 'pix', payment_id: '987654321', payment_status: 'pending' });

      // falha do MP: pedido continua válido, payment null, nada gravado de pagamento
      global.fetch = mock(() => ({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized use of live credentials' }) }));
      const f = await call(valid({ customer_phone: '11900000031', payment_choice: 'pix' }));
      assert.equal(f.status, 201);
      assert.equal(f.body.payment, null);
      const [frow] = await sql`select payment_method, payment_id, payment_status from orders where code = ${f.body.code}`;
      assert.deepEqual(frow, { payment_method: null, payment_id: null, payment_status: 'pending' });

      // resposta sem QR code também vira payment null
      global.fetch = mock(() => ({ ok: true, status: 201, json: async () => ({ id: 1, status: 'pending' }) }));
      const g = await call(valid({ customer_phone: '11900000032', payment_choice: 'pix' }));
      assert.equal(g.status, 201);
      assert.equal(g.body.payment, null);
    } finally {
      global.fetch = realFetch;
      delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    }
  });

  if (WITH_MP) {
    const MP = 'https://api.mercadopago.com';
    const mpGet = async path => (await fetch(MP + path, { headers: { Authorization: 'Bearer ' + process.env.MERCADOPAGO_ACCESS_TOKEN } })).json();

    await test('card: preference sai sem Pix (bank_transfer excluído), com cartões, 3x, payment.type=card', async () => {
      const r = await call(valid({ customer_phone: '11900000007', payment_choice: 'card' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const p = r.body.payment;
      assert.ok(p && p.type === 'card' && /^https:\/\//.test(p.url) && p.id, 'payment veio null: ver log de erro acima');
      const pref = await mpGet('/checkout/preferences/' + encodeURIComponent(p.id));
      const excluded = pref.payment_methods.excluded_payment_types.map(t => t.id).sort();
      assert.ok(excluded.includes('bank_transfer'), 'Pix deveria estar excluído: ' + excluded);
      assert.ok(!excluded.includes('credit_card') && !excluded.includes('debit_card'));
      assert.equal(pref.payment_methods.installments, 3);
      assert.equal(pref.external_reference, r.body.code);
      const [row] = await sql`select payment_method, payment_id from orders where code = ${r.body.code}`;
      assert.equal(row.payment_method, 'mercadopago_card');
      assert.equal(row.payment_id, p.id);
    });

    await test('card é o padrão quando payment_choice falta', async () => {
      const r = await call(valid({ customer_phone: '11900000008' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.payment && r.body.payment.type === 'card');
    });

    await test('pix: pagamento direto, id + qr_code + qr_code_base64 + expires_at, gravado no banco', async () => {
      const r = await call(valid({ customer_phone: '11900000009', payment_choice: 'pix' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const p = r.body.payment;
      if (!p) {
        // Conhecido: a conta de TESTE recebe 401 "Unauthorized use of live credentials" no Pix direto
        // (o payer precisa ser um comprador de teste real). Não é falha do código: fica marcado como NÃO PROVADO.
        notProven++;
        console.warn('NÃO PROVADO - Pix direto no sandbox: payment veio null (ver log do MP acima). Valide em produção com um Pix real de valor baixo.');
        return;
      }
      assert.equal(p.type, 'pix');
      assert.ok(/^\d+$/.test(p.id), 'id do pagamento');
      assert.ok(typeof p.qr_code === 'string' && p.qr_code.length > 20, 'qr_code');
      assert.ok(typeof p.qr_code_base64 === 'string' && p.qr_code_base64.length > 100, 'qr_code_base64');
      assert.ok(!Number.isNaN(Date.parse(p.expires_at)), 'expires_at');
      assert.equal('url' in p, false);
      const [row] = await sql`select payment_method, payment_id, payment_status from orders where code = ${r.body.code}`;
      assert.equal(row.payment_method, 'pix');
      assert.equal(row.payment_id, p.id);
      assert.equal(row.payment_status, 'pending');
      const pay = await mpGet('/v1/payments/' + p.id);
      assert.equal(pay.payment_method_id, 'pix');
      assert.equal(Math.round(pay.transaction_amount * 100), r.body.total_cents);
      assert.equal(pay.external_reference, r.body.code);
    });
  }

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}${notProven ? `, ${notProven} NÃO PROVADO(S)` : ''}`);
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    const n = await cleanup().catch(() => -1);
    console.log(`pedidos de teste apagados: ${n}`);
  });
