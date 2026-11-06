const crypto = require('node:crypto');

const SITE_URL = 'https://docinhos-site.vercel.app';
const MP_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';

// Endereço da loja gravado nos pedidos de retirada ("pickup").
// TODO: no futuro virá do painel admin (configuração da loja), não mais desta constante.
const STORE_ADDRESS = 'Manoel Hare Peralta, 101';

const DELIVERY_METHODS = ['delivery', 'pickup'];
const DELIVERY_FEE_CENTS = 0; // taxa de entrega fixa por enquanto
const MAX_ITEMS = 30;
const MAX_ITEM_QTY = 20;
const MAX_ORDERS_PER_PHONE = 5; // por janela de 10 minutos
const MAX_INT4 = 2147483647;

// Decisões de pagamento (Checkout Pro):
// - Parcelamento: até 3x (ticket médio baixo; mais parcelas só encarece para a loja).
// - Expiração: a preferência (link de pagamento) vale por 2 horas a partir da criação.
const MAX_INSTALLMENTS = 3;
const PREFERENCE_TTL_MS = 2 * 60 * 60 * 1000;

class ValidationError extends Error {}
const fail = message => { throw new ValidationError(message); };
const isId = v => Number.isInteger(v) && v >= 1 && v <= MAX_INT4;

// Formato ISO 8601 com milissegundos e offset, como pede a API do Mercado Pago.
function mpDate(date) {
  return date.toISOString().replace('Z', '+00:00');
}

/**
 * Função pura: valida os itens do cliente e calcula os preços a partir do catálogo do servidor.
 * Qualquer preço enviado pelo cliente é ignorado.
 *
 * catalog = {
 *   products: Map<productId, { id, name, price_cents }>,           // só ativos
 *   complements: Map<productId, Map<complementId, { id, name, price_cents, kind, max_quantity }>>
 * }
 * Retorna { items: [normalizados], subtotal_cents }. Lança ValidationError (mensagem em português).
 */
function priceItems(rawItems, catalog) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) fail('O carrinho está vazio.');
  if (rawItems.length > MAX_ITEMS) fail(`O pedido pode ter no máximo ${MAX_ITEMS} itens.`);

  const items = rawItems.map((raw, idx) => {
    const n = idx + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Item ${n} inválido.`);
    if (!isId(raw.product_id)) fail(`Item ${n}: produto inválido.`);
    if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_ITEM_QTY)
      fail(`Item ${n}: a quantidade deve ser de 1 a ${MAX_ITEM_QTY}.`);

    const product = catalog.products.get(raw.product_id);
    if (!product) fail(`Item ${n}: produto indisponível.`);
    const links = catalog.complements.get(product.id) || new Map();
    const sizes = [...links.values()].filter(c => c.kind === 'size');

    // Tamanho
    let size = null;
    const hasSizeId = raw.size_id !== undefined && raw.size_id !== null;
    if (sizes.length) {
      if (!hasSizeId) fail(`Item ${n}: escolha o tamanho.`);
      if (!isId(raw.size_id)) fail(`Item ${n}: tamanho inválido.`);
      size = links.get(raw.size_id);
      if (!size || size.kind !== 'size') fail(`Item ${n}: tamanho inválido para este produto.`);
    } else if (hasSizeId) {
      fail(`Item ${n}: este produto não possui tamanhos.`);
    }

    // Adicionais
    const rawExtras = raw.extras === undefined || raw.extras === null ? [] : raw.extras;
    if (!Array.isArray(rawExtras) || rawExtras.length > MAX_ITEMS) fail(`Item ${n}: adicionais inválidos.`);
    const seen = new Set();
    let extrasCents = 0;
    const extras = rawExtras.map(e => {
      if (!e || typeof e !== 'object' || !isId(e.id)) fail(`Item ${n}: adicional inválido.`);
      if (seen.has(e.id)) fail(`Item ${n}: adicional repetido.`);
      seen.add(e.id);
      const comp = links.get(e.id);
      if (!comp || comp.kind !== 'additional') fail(`Item ${n}: adicional inválido para este produto.`);
      if (!Number.isInteger(e.qty) || e.qty < 1 || e.qty > comp.max_quantity)
        fail(`Item ${n}: "${comp.name}" permite de 1 a ${comp.max_quantity}.`);
      extrasCents += comp.price_cents * e.qty;
      return e.qty > 1 ? `${comp.name} x${e.qty}` : comp.name;
    });

    // Preço base do produto pode ser nulo (preço só pelo tamanho).
    if (product.price_cents === null || product.price_cents === undefined) {
      if (!size) fail(`Item ${n}: produto sem preço definido.`);
    }
    const unit = (product.price_cents || 0) + (size ? size.price_cents : 0) + extrasCents;

    return {
      product_id: product.id,
      name: product.name,
      size: size ? size.name : null,
      extras,
      qty: raw.qty,
      unit_total_cents: unit
    };
  });

  const subtotal = items.reduce((s, i) => s + i.unit_total_cents * i.qty, 0);
  if (subtotal <= 0) fail('O carrinho está vazio.');
  return { items, subtotal_cents: subtotal };
}

// Valida os dados do cliente/entrega. Retorna valores limpos.
function validateCustomer(b) {
  const name = typeof b.customer_name === 'string' ? b.customer_name.trim() : '';
  if (name.length < 2 || name.length > 80) fail('Informe seu nome (2 a 80 caracteres).');

  const phone = typeof b.customer_phone === 'string' || typeof b.customer_phone === 'number'
    ? String(b.customer_phone).replace(/\D/g, '') : '';
  if (phone.length < 10 || phone.length > 13) fail('Informe um telefone válido com DDD.');

  const method = b.delivery_method;
  if (!DELIVERY_METHODS.includes(method)) fail('Escolha entrega ou retirada.');

  let address;
  if (method === 'delivery') {
    address = typeof b.address === 'string' ? b.address.trim() : '';
    if (address.length < 5 || address.length > 200) fail('Informe o endereço de entrega (5 a 200 caracteres).');
  } else {
    address = STORE_ADDRESS; // retirada: ignora qualquer endereço enviado
  }

  let notes = null;
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') fail('Observações inválidas.');
    notes = b.notes.trim() || null;
    if (notes && notes.length > 300) fail('As observações podem ter no máximo 300 caracteres.');
  }
  return { name, phone, method, address, notes };
}

// Carrega do banco só produtos ativos (de categorias ativas) e seus complementos ativos.
async function loadCatalog(sql, productIds) {
  const products = await sql.query(
    `select p.id, p.name, p.price_cents
       from products p join categories c on c.id = p.category_id
      where p.active and c.active and p.id = any($1::int[])`,
    [productIds]
  );
  const links = await sql.query(
    `select pc.product_id, c.id, c.name, c.price_cents, c.kind, pc.max_quantity
       from product_complements pc join complements c on c.id = pc.complement_id
      where c.active and pc.product_id = any($1::int[])`,
    [productIds]
  );
  const catalog = { products: new Map(), complements: new Map() };
  for (const p of products) catalog.products.set(p.id, p);
  for (const l of links) {
    if (!catalog.complements.has(l.product_id)) catalog.complements.set(l.product_id, new Map());
    catalog.complements.get(l.product_id).set(l.id, l);
  }
  return catalog;
}

// Um item do Mercado Pago por item do pedido (preço em reais, calculado no servidor).
function buildPreferenceItems(items) {
  return items
    .filter(i => i.unit_total_cents > 0)
    .map((i, idx) => {
      const title = [i.name, i.size ? `- ${i.size}` : '', i.extras.length ? `(+ ${i.extras.join(', ')})` : '']
        .filter(Boolean).join(' ').slice(0, 256);
      return { id: String(idx + 1), title, quantity: i.qty, currency_id: 'BRL', unit_price: Number((i.unit_total_cents / 100).toFixed(2)) };
    });
}

function buildPreferenceBody(order, prefItems, now = new Date()) {
  return {
    items: prefItems,
    external_reference: order.code,
    back_urls: {
      success: `${SITE_URL}/?pagamento=ok`,
      failure: `${SITE_URL}/?pagamento=erro`,
      pending: `${SITE_URL}/?pagamento=pendente`
    },
    auto_return: 'approved',
    notification_url: `${SITE_URL}/api/mp-webhook`,
    statement_descriptor: 'DOCINHOS GIGI',
    // Pix, cartão de crédito e cartão de débito. NÃO excluir "bank_transfer" (é o Pix).
    // "account_money" (saldo Mercado Pago) NÃO pode ser excluído: a API responde 400
    // "account_money cannot be excluded" (confirmado em teste), então fica disponível.
    payment_methods: {
      excluded_payment_types: [
        { id: 'ticket' },        // boleto
        { id: 'atm' },
        { id: 'prepaid_card' }
      ],
      installments: MAX_INSTALLMENTS
    },
    // Validade da preferência (link de pagamento): 2 horas.
    expires: true,
    expiration_date_from: mpDate(now),
    expiration_date_to: mpDate(new Date(now.getTime() + PREFERENCE_TTL_MS))
  };
}

async function createPreference(token, order, prefItems) {
  const mpRes = await fetch(MP_PREFERENCES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Idempotency-Key': `pref-${order.code}`
    },
    body: JSON.stringify(buildPreferenceBody(order, prefItems)),
    signal: AbortSignal.timeout(8000)
  });
  if (!mpRes.ok) throw new Error(`Mercado Pago respondeu ${mpRes.status}`);
  return mpRes.json();
}

function newCode() {
  return 'DG' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const sql = require('./db'); // carregado aqui para testar a função pura sem DATABASE_URL
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Dados inválidos.');

    const customer = validateCustomer(b);
    if (!Array.isArray(b.items) || b.items.length === 0) fail('O carrinho está vazio.');
    if (b.items.length > MAX_ITEMS) fail(`O pedido pode ter no máximo ${MAX_ITEMS} itens.`);
    const ids = [...new Set(b.items.map(i => (i && isId(i.product_id) ? i.product_id : null)).filter(Boolean))];

    const catalog = await loadCatalog(sql, ids);
    const priced = priceItems(b.items, catalog);
    const total = priced.subtotal_cents + DELIVERY_FEE_CENTS;

    // Limite de abuso: o insert só acontece se o telefone tiver < 5 pedidos nos últimos 10 min
    // (checagem e inserção na mesma instrução, para reduzir corridas).
    const rows = await sql.query(
      `insert into orders (code, customer_name, customer_phone, delivery_method, address, items,
                           subtotal_cents, delivery_fee_cents, total_cents, notes, payment_status)
       select $1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::int, $8::int, $9::int, $10::text, 'pending'
        where (select count(*) from orders
                where regexp_replace(customer_phone, '\\D', '', 'g') = $3::text
                  and created_at > now() - interval '10 minutes') < $11::int
       returning id, code, total_cents`,
      [newCode(), customer.name, customer.phone, customer.method, customer.address, JSON.stringify(priced.items),
        priced.subtotal_cents, DELIVERY_FEE_CENTS, total, customer.notes, MAX_ORDERS_PER_PHONE]
    );
    if (!rows.length) return res.status(429).json({ error: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.' });
    const order = rows[0];

    // Se a preference falhar, o pedido continua válido (payment: null).
    let payment = null;
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (mpToken) {
      try {
        const pref = await createPreference(mpToken, order, buildPreferenceItems(priced.items));
        if (pref && pref.init_point && pref.id) {
          payment = { url: pref.init_point, id: String(pref.id) };
          await sql`update orders set payment_method = 'mercadopago', payment_id = ${String(pref.id)} where id = ${order.id}`;
        }
      } catch (err) {
        console.error('Falha ao criar preference do Mercado Pago:', err.message);
      }
    }

    return res.status(201).json({
      id: order.id,
      code: order.code,
      total_cents: order.total_cents,
      delivery_method: customer.method,
      address: customer.address,
      items: priced.items,
      payment
    });
  } catch (error) {
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    console.error('Erro ao criar pedido:', error.message);
    return res.status(500).json({ error: 'Não foi possível criar o pedido' });
  }
};

module.exports._internal = { priceItems, validateCustomer, buildPreferenceItems, buildPreferenceBody, STORE_ADDRESS, ValidationError };
