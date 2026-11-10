const crypto = require('node:crypto');
const { hasControlChars } = require('./_lib/validate');
const shipping = require('./_lib/shipping');
const storeHours = require('./_lib/store-hours');
const ordersLib = require('./_lib/orders');
const loyalty = require('./_lib/loyalty');
const customerLib = require('./_lib/customer');

const SITE_URL = 'https://docinhos-site.vercel.app';
const MP_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';
const MP_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';

// Endereço da loja gravado nos pedidos de retirada ("pickup").
// TODO: no futuro virá do painel admin (configuração da loja), não mais desta constante.
const STORE_ADDRESS = 'Manoel Hare Peralta, 101';

const DELIVERY_METHODS = ['delivery', 'pickup'];
const DEFAULT_PAUSE_LABEL = 'volto logo <3';
const MAX_ITEMS = 30;
const MAX_ITEM_QTY = 20;
const MAX_ORDERS_PER_PHONE = 5; // por janela de 10 minutos
const MAX_INT4 = 2147483647;

// Decisões de pagamento:
// - Cartão (Checkout Pro, redirecionamento): só crédito e débito, sem Pix.
//   Parcelamento até 3x (ticket médio baixo; mais parcelas só encarece para a loja).
//   A preferência (link de pagamento) vale por 2 horas a partir da criação.
// - Pix: gerado direto no site via POST /v1/payments (sem preference), válido por 30 min
//   (mínimo aceito pela API do Mercado Pago).
// - A API exige payer.email no Pix e não coletamos e-mail do cliente. Usamos um e-mail sintético
//   por pedido (pedido-<codigo>@docinhos-site.vercel.app): tem formato válido, não pertence a ninguém
//   e não é usado para contato (o aviso ao cliente é feito pelo WhatsApp).
const MAX_INSTALLMENTS = 3;
const PREFERENCE_TTL_MS = 2 * 60 * 60 * 1000;
const PIX_TTL_MS = 30 * 60 * 1000;
const PAYMENT_CHOICES = ['pix', 'card'];

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
 *   complements: Map<productId, Map<complementId, { id, name, price_cents, kind, max_quantity, group_id }>>,
 *   groups?: Map<productId, Map<groupId, { id, label, min_choices, max_choices }>>   // opcional
 * }
 * Produtos com grupos: a soma das qty dos adicionais de cada grupo deve ficar entre min_choices e max_choices.
 * Adicionais sem grupo seguem só a regra de max_quantity.
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
    if (product.paused) {
      const label = product.pause_label || catalog.defaultPauseLabel || DEFAULT_PAUSE_LABEL;
      fail(`Item ${n}: "${product.name}" está pausado no momento (${label}). Remova o item do carrinho para continuar.`);
    }
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
    const groupTotals = new Map(); // groupId -> soma das qty escolhidas
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
      if (comp.group_id != null) groupTotals.set(comp.group_id, (groupTotals.get(comp.group_id) || 0) + e.qty);
      return e.qty > 1 ? `${comp.name} x${e.qty}` : comp.name;
    });

    // Limites por grupo de escolha (derivados do banco, nunca do cliente).
    const groups = (catalog.groups && catalog.groups.get(product.id)) || new Map();
    for (const g of groups.values()) {
      const total = groupTotals.get(g.id) || 0;
      if (total > g.max_choices) fail(`Item ${n}: escolha até ${g.max_choices} em "${g.label}".`);
      if (total < g.min_choices) fail(`Item ${n}: escolha pelo menos ${g.min_choices} em "${g.label}".`);
    }

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
function validateCustomer(b, storeAddress = STORE_ADDRESS) {
  const name = typeof b.customer_name === 'string' ? b.customer_name.trim() : '';
  if (name.length < 2 || name.length > 80) fail('Informe seu nome (2 a 80 caracteres).');
  if (hasControlChars(name, false)) fail('O nome contém caracteres inválidos.');

  const phone = typeof b.customer_phone === 'string' || typeof b.customer_phone === 'number'
    ? String(b.customer_phone).replace(/\D/g, '') : '';
  if (phone.length < 10 || phone.length > 13) fail('Informe um telefone válido com DDD.');

  const method = b.delivery_method;
  if (!DELIVERY_METHODS.includes(method)) fail('Escolha entrega ou retirada.');

  let address, cep = null;
  if (method === 'delivery') {
    cep = shipping.normalizeCep(b.cep);
    if (!cep) fail('Informe o CEP de entrega com 8 números.');
    address = typeof b.address === 'string' ? b.address.trim() : '';
    if (address.length < 5 || address.length > 200) fail('Informe o endereço de entrega (5 a 200 caracteres).');
    if (hasControlChars(address, false)) fail('O endereço contém caracteres inválidos.');
  } else {
    address = storeAddress; // retirada: ignora qualquer endereço enviado
  }

  let notes = null;
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') fail('Observações inválidas.');
    notes = b.notes.trim() || null;
    if (notes && notes.length > 300) fail('As observações podem ter no máximo 300 caracteres.');
    if (notes && hasControlChars(notes, true)) fail('As observações contêm caracteres inválidos.');
  }
  return { name, phone, method, address, notes, cep, number: b.address_number };
}

// Carrega do banco só produtos ativos (de categorias ativas) e seus complementos ativos.
async function loadCatalog(sql, productIds) {
  const products = await sql.query(
    `select p.id, p.name, p.price_cents, p.paused, p.pause_label
       from products p join categories c on c.id = p.category_id
      where p.active and c.active and p.id = any($1::int[])`,
    [productIds]
  );
  const links = await sql.query(
    `select pc.product_id, c.id, c.name, c.price_cents, c.kind, pc.max_quantity, pc.group_id
       from product_complements pc join complements c on c.id = pc.complement_id
      where c.active and not pc.paused and pc.product_id = any($1::int[])`,
    [productIds]
  );
  const groups = await sql.query(
    `select id, product_id, label, min_choices, max_choices
       from product_groups where product_id = any($1::int[])`,
    [productIds]
  );
  const catalog = { products: new Map(), complements: new Map(), groups: new Map() };
  for (const p of products) catalog.products.set(p.id, p);
  for (const l of links) {
    if (!catalog.complements.has(l.product_id)) catalog.complements.set(l.product_id, new Map());
    catalog.complements.get(l.product_id).set(l.id, l);
  }
  for (const g of groups) {
    if (!catalog.groups.has(g.product_id)) catalog.groups.set(g.product_id, new Map());
    catalog.groups.get(g.product_id).set(g.id, g);
  }
  return catalog;
}

// Um item do Mercado Pago por item do pedido (preço em reais, calculado no servidor).
// A taxa de entrega (se > 0) entra como item extra: o total pago precisa ser igual ao total_cents do pedido,
// senão o webhook (que confere o valor) nunca aprova.
// Com desconto de pontos o Mercado Pago não aceita valor negativo: os produtos viram uma linha só, já com o desconto
// (subtotal - desconto), para o total pago continuar igual ao total_cents do pedido.
function buildPreferenceItems(items, deliveryFeeCents = 0, discountCents = 0, orderLabel = 'Pedido') {
  const list = discountCents > 0
    ? [{ id: '1', title: `${orderLabel} - Docinhos da Gigi (com desconto de pontos)`.slice(0, 256), quantity: 1, currency_id: 'BRL',
        unit_price: Number(((items.reduce((s, i) => s + i.unit_total_cents * i.qty, 0) - discountCents) / 100).toFixed(2)) }]
    : items
    .filter(i => i.unit_total_cents > 0)
    .map((i, idx) => {
      const title = [i.name, i.size ? `- ${i.size}` : '', i.extras.length ? `(+ ${i.extras.join(', ')})` : '']
        .filter(Boolean).join(' ').slice(0, 256);
      return { id: String(idx + 1), title, quantity: i.qty, currency_id: 'BRL', unit_price: Number((i.unit_total_cents / 100).toFixed(2)) };
    });
  if (deliveryFeeCents > 0) {
    list.push({ id: 'frete', title: 'Taxa de entrega', quantity: 1, currency_id: 'BRL', unit_price: Number((deliveryFeeCents / 100).toFixed(2)) });
  }
  return list;
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
    // Só cartão de crédito e débito: o Pix é gerado dentro do site, então "bank_transfer" (Pix) é excluído.
    // "account_money" (saldo Mercado Pago) NÃO pode ser excluído: a API responde 400
    // "account_money cannot be excluded" (confirmado em teste), então fica disponível no checkout.
    payment_methods: {
      excluded_payment_types: [
        { id: 'ticket' },        // boleto
        { id: 'atm' },
        { id: 'prepaid_card' },
        { id: 'bank_transfer' }   // Pix
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

function pixPayerEmail(code) {
  return `pedido-${String(code).toLowerCase()}@docinhos-site.vercel.app`;
}

function buildPixBody(order, customerName, now = new Date()) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0].slice(0, 60) || 'Cliente';
  return {
    transaction_amount: Number((order.total_cents / 100).toFixed(2)),
    payment_method_id: 'pix',
    description: `Pedido ${order.public_code || order.code} - Docinhos da Gigi`,
    external_reference: order.code,
    notification_url: `${SITE_URL}/api/mp-webhook`,
    date_of_expiration: mpDate(new Date(now.getTime() + PIX_TTL_MS)),
    payer: { email: pixPayerEmail(order.code), first_name: firstName }
  };
}

async function createPixPayment(token, order, customerName) {
  const body = buildPixBody(order, customerName);
  const mpRes = await fetch(MP_PAYMENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Idempotency-Key': `pix-${order.code}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (!mpRes.ok) {
    let detail = '';
    try { const j = await mpRes.json(); detail = j && j.message ? `: ${String(j.message).slice(0, 120)}` : ''; } catch { /* sem corpo */ }
    throw new Error(`Mercado Pago respondeu ${mpRes.status}${detail}`);
  }
  const pay = await mpRes.json();
  const td = pay && pay.point_of_interaction && pay.point_of_interaction.transaction_data;
  if (!pay || !pay.id || !td || !td.qr_code || !td.qr_code_base64) throw new Error('Resposta do Pix sem QR code');
  return {
    id: String(pay.id),
    status: String(pay.status || 'pending'),
    qr_code: td.qr_code,
    qr_code_base64: td.qr_code_base64,
    expires_at: pay.date_of_expiration || body.date_of_expiration
  };
}

// Código legado (external_reference do Mercado Pago, chave única do banco). O cliente vê public_code (DG-####).
function newCode() {
  return 'DG' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

const MAX_CODE_TRIES = 10;
const send = (res, status, payload) => res.status(status).json(payload);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const sql = require('./_lib/db'); // carregado aqui para testar a função pura sem DATABASE_URL
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Dados inválidos.');

    // Loja fechada (horário, fechamento manual ou pausa antiga): recusa já, informando quando abre.
    const state = await storeHours.getStoreState(sql);
    if (!state.open) {
      return send(res, 503, {
        error: state.message || 'Estamos fechados no momento.',
        code: 'store_closed',
        store: { open: false, reason: state.reason, reopens_at: state.reopens_at, next_open_at: state.next_open_at, message: state.message }
      });
    }

    const settingRows = await sql.query(`select key, value from settings where key in ('store_address', 'default_pause_label')`);
    const st = {};
    for (const r of settingRows) st[r.key] = r.value;

    const customer = validateCustomer(b, st.store_address || STORE_ADDRESS);
    const choice = PAYMENT_CHOICES.includes(b.payment_choice) ? b.payment_choice : 'card';
    if (!Array.isArray(b.items) || b.items.length === 0) fail('O carrinho está vazio.');
    if (b.items.length > MAX_ITEMS) fail(`O pedido pode ter no máximo ${MAX_ITEMS} itens.`);
    const ids = [...new Set(b.items.map(i => (i && isId(i.product_id) ? i.product_id : null)).filter(Boolean))];

    const catalog = await loadCatalog(sql, ids);
    catalog.defaultPauseLabel = st.default_pause_label || DEFAULT_PAUSE_LABEL;
    const priced = priceItems(b.items, catalog);

    // Frete: retirada R$ 0; entrega por faixa de km, recalculado aqui (o cliente nunca informa valor).
    let deliveryFee = 0, distanceKm = null;
    if (customer.method === 'delivery') {
      const quote = await shipping.quoteDelivery(sql, { cep: customer.cep, address: customer.address, number: customer.number });
      deliveryFee = quote.fee_cents;
      distanceKm = quote.km;
    }

    // Pontos (só com cliente logado): saldo, bloqueio de 48 h e desconto conferidos no servidor.
    let discount = 0, pointsRedeemed = 0;
    if (b.use_points !== undefined && b.use_points !== null && b.use_points !== 0 && (!Number.isInteger(b.use_points) || b.use_points < 0)) fail('Quantidade de pontos inválida.');
    const session = await customerLib.getSession(sql, req);
    if (b.use_points) {
      if (!session) return send(res, 401, { error: 'Entre na sua conta para usar seus pontos.', code: 'login_required' });
      const bal = await loyalty.getBalance(sql, session.customer.id);
      const red = loyalty.validateRedemption({
        points: b.use_points, subtotalCents: priced.subtotal_cents, balance: bal.balance, lockedUntil: session.customer.points_locked_until
      });
      discount = red.discount_cents;
      pointsRedeemed = red.points;
    }
    const total = priced.subtotal_cents - discount + deliveryFee;
    if (total < loyalty.MIN_CHARGE_CENTS) {
      fail('O valor a pagar precisa ser de pelo menos R$ 1,00. Use menos pontos neste pedido.');
    }

    // Limite de abuso: o insert só acontece se o telefone tiver < 5 pedidos nos últimos 10 min e se o DG-#### não
    // existir entre os pedidos dos últimos 90 dias (checagem e inserção na mesma instrução, para reduzir corridas).
    const tracking = ordersLib.newTrackingToken();
    let order = null;
    for (let attempt = 0; attempt < MAX_CODE_TRIES && !order; attempt++) {
      const publicCode = ordersLib.newPublicCode();
      const rows = await sql.query(
        `insert into orders (code, public_code, tracking_token_hash, customer_id, customer_name, customer_phone, delivery_method, address, items,
                             subtotal_cents, delivery_fee_cents, discount_cents, points_redeemed, total_cents, distance_km, notes, payment_status)
         select $1::text, $2::text, $3::text, $4::int, $5::text, $6::text, $7::text, $8::text, $9::jsonb,
                $10::int, $11::int, $12::int, $13::int, $14::int, $15::numeric, $16::text, 'pending'
          where (select count(*) from orders
                  where regexp_replace(customer_phone, '\\D', '', 'g') = $6::text
                    and created_at > now() - interval '10 minutes') < $17::int
            and not exists (select 1 from orders where public_code = $2::text and created_at > now() - interval '${ordersLib.PUBLIC_CODE_WINDOW}')
         returning id, code, public_code, total_cents`,
        [newCode(), publicCode, tracking.hash, session ? session.customer.id : null, customer.name, customer.phone, customer.method, customer.address,
          JSON.stringify(priced.items), priced.subtotal_cents, deliveryFee, discount, pointsRedeemed, total, distanceKm, customer.notes, MAX_ORDERS_PER_PHONE]
      );
      if (rows.length) { order = rows[0]; break; }
      const [{ n }] = await sql.query(
        `select count(*)::int n from orders where regexp_replace(customer_phone, '\\D', '', 'g') = $1 and created_at > now() - interval '10 minutes'`, [customer.phone]);
      if (n >= MAX_ORDERS_PER_PHONE) return res.status(429).json({ error: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.' });
      // senão foi colisão do DG-####: sorteia outro
    }
    if (!order) throw new Error('não foi possível gerar um código de pedido único');

    // Reserva dos pontos (atômica com a conferência do saldo). Se outra compra gastou antes, desfaz este pedido.
    if (pointsRedeemed > 0) {
      const reserved = await loyalty.reserve(sql, { customerId: session.customer.id, orderId: order.id, points: pointsRedeemed });
      if (!reserved) {
        await sql.query('delete from orders where id = $1', [order.id]);
        return send(res, 409, { error: 'Saldo de pontos insuficiente. Atualize a página e tente de novo.', code: 'insufficient_points' });
      }
    }

    // Se a criação do pagamento falhar, o pedido continua válido (payment: null).
    let payment = null;
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (mpToken && choice === 'pix') {
      try {
        const pix = await createPixPayment(mpToken, order, customer.name);
        payment = { type: 'pix', id: pix.id, qr_code: pix.qr_code, qr_code_base64: pix.qr_code_base64, expires_at: pix.expires_at };
        await sql`update orders set payment_method = 'pix', payment_id = ${pix.id}, payment_status = ${pix.status} where id = ${order.id}`;
      } catch (err) {
        payment = null;
        console.error('Falha ao criar Pix no Mercado Pago:', err.message);
      }
    } else if (mpToken) {
      try {
        const pref = await createPreference(mpToken, order, buildPreferenceItems(priced.items, deliveryFee, discount, order.public_code));
        if (pref && pref.init_point && pref.id) {
          payment = { type: 'card', url: pref.init_point, id: String(pref.id) };
          await sql`update orders set payment_method = 'mercadopago_card', payment_id = ${String(pref.id)} where id = ${order.id}`;
        }
      } catch (err) {
        console.error('Falha ao criar preference do Mercado Pago:', err.message);
      }
    }

    return res.status(201).json({
      id: order.id,
      code: order.code,
      public_code: order.public_code,
      tracking_token: tracking.token, // só aparece aqui; o banco guarda apenas o SHA-256
      subtotal_cents: priced.subtotal_cents,
      delivery_fee_cents: deliveryFee,
      discount_cents: discount,
      points_redeemed: pointsRedeemed,
      total_cents: order.total_cents,
      distance_km: distanceKm,
      delivery_method: customer.method,
      address: customer.address,
      items: priced.items,
      payment
    });
  } catch (error) {
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof shipping.ShippingError) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.max_km ? { max_km: error.max_km } : {}) });
    if (error instanceof loyalty.LoyaltyError) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error('Erro ao criar pedido:', error.message);
    return res.status(500).json({ error: 'Não foi possível criar o pedido' });
  }
};

module.exports._internal = { priceItems, validateCustomer, buildPreferenceItems, buildPreferenceBody, buildPixBody, pixPayerEmail, createPixPayment, PAYMENT_CHOICES, STORE_ADDRESS, DEFAULT_PAUSE_LABEL, ValidationError };
