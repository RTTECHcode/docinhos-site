const crypto = require('node:crypto');
const { hasControlChars } = require('./_lib/validate');
const shipping = require('./_lib/shipping');
const storeHours = require('./_lib/store-hours');
const ordersLib = require('./_lib/orders');
const loyalty = require('./_lib/loyalty');
const customerLib = require('./_lib/customer');
const auth = require('./_lib/auth');
const club = require('./_lib/club');
const coupons = require('./_lib/coupons');
const scheduling = require('./_lib/scheduling'); // v4 N10: encomenda com data marcada
const { phoneKey } = require('./_lib/text');
const { hitExceeded } = require('./_lib/rate-limit');
const payments = require('./_lib/payments');

// A-05 (v4): endereço do site num ponto só (variável SITE_URL, padrão https://docinhos-site.vercel.app).
const SITE_URL = require('./_lib/site').siteUrl();
const MP_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';
const MP_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';
// ?source_news=webhooks: o Mercado Pago manda só o formato Webhooks (assinado, com data.id), sem o IPN antigo
// (?topic=&id=, sem assinatura), que o webhook recusava e o Mercado Pago ficava reenviando.
const NOTIFICATION_URL = `${SITE_URL}/api/mp-webhook?source_news=webhooks`;
// Volta do Checkout Pro: com o token de rastreio, aprovado e pendente vão para a página do pedido (que mostra o
// pagamento mudar sozinho); a falha volta para a loja, onde há o botão de tentar pagar de novo.
// F3: retry_payment pela conta (sem token) volta para /pedido.html?o=<id>, que abre com a sessão do cliente.
function backUrls(trackingToken, orderId = null) {
  const ref = trackingToken ? `t=${encodeURIComponent(trackingToken)}` : `o=${Number(orderId)}`;
  const track = st => `${SITE_URL}/pedido.html?${ref}&pagamento=${st}`;
  return trackingToken || Number.isInteger(orderId)
    ? { success: track('ok'), failure: `${SITE_URL}/?pagamento=erro`, pending: track('pendente') }
    : { success: `${SITE_URL}/?pagamento=ok`, failure: `${SITE_URL}/?pagamento=erro`, pending: `${SITE_URL}/?pagamento=pendente` };
}

// Endereço da loja gravado nos pedidos de retirada ("pickup").
// TODO: no futuro virá do painel admin (configuração da loja), não mais desta constante.
const STORE_ADDRESS = 'Manoel Hare Peralta, 101';

const DELIVERY_METHODS = ['delivery', 'pickup'];
const MAX_ITEMS = 30;
const MAX_ITEM_QTY = 20;
const MAX_ORDERS_PER_PHONE = 5; // por janela de 10 minutos
const MAX_ORDERS_PER_IP = 10;   // por janela de 10 minutos (A1-05: trocar o telefone não burla o limite)
const MAX_ATTEMPTS_PER_IP = 20; // tentativas (aceitas OU recusadas: 400, 409, 422, 429, 503...) por IP em 10 minutos
const MSG_TOO_MANY = 'Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.';
const MSG_SHIPPING_BUSY = 'Muitas consultas de frete agora. Tente de novo em instantes.';
const MAX_INT4 = 2147483647;
const MSG_REWARD_MIN = 'Para trocar pontos por um prêmio, o pedido precisa ter pelo menos R$ 1,00 em outros produtos.';

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
    // D6 (v3): a etiqueta da pausa é fixa (sem texto próprio por produto); a mensagem não usa mais pause_label.
    if (product.paused) fail(`Item ${n}: "${product.name}" está pausado no momento. Remova o item do carrinho para continuar.`);
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
    `select p.id, p.name, p.price_cents, p.paused
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
// Com desconto (cupom ou pontos antigos) o Mercado Pago não aceita valor negativo: os produtos viram uma linha só, já com
// o desconto (subtotal - desconto), para o total pago continuar igual ao total_cents do pedido.
// Prêmio do Clube (v4 N3) vale R$ 0 e não vai para o Mercado Pago (a API recusa item com preço 0).
function buildPreferenceItems(items, deliveryFeeCents = 0, discountCents = 0, orderLabel = 'Pedido') {
  // Com desconto: um item só com o subtotal já descontado (o MP não aceita item de valor negativo ou zero).
  const discounted = items.reduce((s, i) => s + i.unit_total_cents * i.qty, 0) - discountCents;
  const list = discountCents > 0
    ? (discounted > 0
      ? [{ id: '1', title: `${orderLabel} - Docinhos da Gigi (com desconto)`.slice(0, 256), quantity: 1, currency_id: 'BRL', unit_price: Number((discounted / 100).toFixed(2)) }]
      : [])
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
    back_urls: backUrls(order.tracking_token, order.track_order_id),
    auto_return: 'approved',
    notification_url: NOTIFICATION_URL,
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

async function createPreference(token, order, prefItems, idempotencyKey = `pref-${order.code}`) {
  const mpRes = await fetch(MP_PREFERENCES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Idempotency-Key': idempotencyKey
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
    notification_url: NOTIFICATION_URL,
    date_of_expiration: mpDate(new Date(now.getTime() + PIX_TTL_MS)),
    payer: { email: pixPayerEmail(order.code), first_name: firstName }
  };
}

async function createPixPayment(token, order, customerName, idempotencyKey = `pix-${order.code}`) {
  const body = buildPixBody(order, customerName);
  const mpRes = await fetch(MP_PAYMENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Idempotency-Key': idempotencyKey
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

// Registra esta tentativa e diz se o IP passou do limite (a tentativa atual entra na conta). Tabela order_attempts
// (scripts/migrate-2026-11-10-order-attempts.js). De vez em quando apaga linhas com mais de 1 dia.
async function attemptsExceeded(sql, ip) {
  const [{ n }] = await sql.query(
    `with ins as (insert into order_attempts (ip) values ($1) returning 1)
     select (select count(*) from order_attempts where ip = $1 and at > now() - interval '10 minutes')::int + (select count(*) from ins)::int as n`,
    [ip]);
  if (Math.random() < 0.02) await sql.query(`delete from order_attempts where at < now() - interval '1 day'`);
  return n > MAX_ATTEMPTS_PER_IP;
}
// Pedidos criados nos últimos 10 min por este telefone e por este IP.
async function recentOrders(sql, phone, ip) {
  const [r] = await sql.query(
    `select count(*) filter (where regexp_replace(customer_phone, '\\D', '', 'g') = $1)::int n, count(*) filter (where client_ip = $2)::int by_ip
       from orders where created_at > now() - interval '10 minutes'`, [phone, ip]);
  return r;
}
const overOrderLimit = r => r.n >= MAX_ORDERS_PER_PHONE || r.by_ip >= MAX_ORDERS_PER_IP;

// ---------- F3: novo pagamento do mesmo pedido (POST /api/order?a=retry_payment) ----------
// Gera de novo o Pix ou o link do cartão de um pedido já criado, sem refazer o pedido. Valores, itens e reservas (prêmio do
// Clube, cupom e vaga agendada) continuam os mesmos: nada é recalculado nem reservado de novo. Vale só para pedido com
// pagamento não aprovado, não cancelado e criado há menos de 24 h. Se a reserva já foi devolvida (pagamento recusado ou
// vencido), recusa (409 reservation_released): o cliente faz um pedido novo.
const RETRY_WINDOW_MIN = 10;
const RETRY_MAX_PER_IP = 10;    // por IP em 10 min
const RETRY_MAX_PER_ORDER = 3;  // por pedido em 10 min
const RETRY_CHECK_TIMEOUT_MS = 4000;
const PAID_STATUSES = ['approved', 'refunded', 'charged_back'];
const PROCESSING_STATUSES = ['in_process', 'authorized']; // cartão em análise: outro pagamento poderia cobrar duas vezes
const MSG_RETRY_TOO_MANY = 'Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos.';
const RETRY_COLUMNS = `id, code, public_code, customer_id, customer_name, payment_status, payment_method, payment_id, fulfillment_status,
  created_at, items, delivery_fee_cents, discount_cents, total_cents, club_points, points_redeemed, coupon_id, scheduled_for,
  (created_at > now() - interval '24 hours') as fresh`;

// Motivo para não gerar novo pagamento, ou null. o = linha com RETRY_COLUMNS.
async function retryBlock(sql, o, now = new Date()) {
  if (PAID_STATUSES.includes(o.payment_status)) return [409, 'Este pedido já está pago.', 'already_paid'];
  if (o.fulfillment_status === 'cancelled') return [409, 'Este pedido foi cancelado. Faça um novo pedido.', 'order_cancelled'];
  if (!o.fresh) return [409, 'Passou o prazo de 24 horas para pagar este pedido. Faça um novo pedido.', 'retry_expired'];
  if (PROCESSING_STATUSES.includes(o.payment_status)) {
    return [409, 'O Mercado Pago ainda está analisando o pagamento deste pedido. Aguarde alguns minutos.', 'payment_in_process'];
  }
  if (o.scheduled_for && new Date(o.scheduled_for).getTime() <= now.getTime()) {
    return [409, 'O horário marcado para este pedido já passou. Faça um novo pedido.', 'schedule_passed'];
  }
  const released = [409, 'O prêmio do Clube ou o cupom deste pedido já foi devolvido. Faça um novo pedido.', 'reservation_released'];
  if (o.club_points > 0 || o.points_redeemed > 0) {
    const rows = await sql.query('select kind from loyalty_ledger where order_id = $1', [o.id]);
    const has = k => rows.some(r => r.kind === k);
    if ((has('reward_release') && !has('reward_commit')) || (has('redeem_release') && !has('redeem_commit'))) return released;
  }
  if (o.coupon_id) {
    const [r] = await sql.query('select status from coupon_redemptions where order_id = $1', [o.id]);
    if (!r || r.status === 'released') return released;
  }
  // Vaga agendada: pedido pendente só segura a vaga por 60 min (N10). Se já não segura, confere se ainda há vaga.
  if (o.scheduled_for) {
    const cfg = await scheduling.getConfig(sql);
    if (cfg.slot_capacity > 0) {
      const [{ occ }] = await sql.query(`select (${scheduling.OCCUPIES_SQL}) as occ from orders where id = $1`, [o.id]);
      if (!occ && (await scheduling.slotTaken(sql, new Date(o.scheduled_for))) >= cfg.slot_capacity) {
        return [409, 'A janela marcada para este pedido lotou. Faça um novo pedido com outro horário.', 'slot_full'];
      }
    }
  }
  return null;
}

// Itens pagos do pedido gravado (prêmio do Clube vale R$ 0 e fica de fora), no formato de buildPreferenceItems.
function paidItemsOf(o) {
  const list = Array.isArray(o.items) ? o.items : [];
  return list.filter(i => i && !i.reward).map(i => ({
    name: String(i.name || 'Item'), size: i.size || null, extras: Array.isArray(i.extras) ? i.extras.map(String) : [],
    qty: Number(i.qty) || 0, unit_total_cents: Number(i.unit_total_cents) || 0
  }));
}

async function retryPayment(req, res, sql) {
  const ip = auth.clientIp(req);
  if (await hitExceeded(sql, 'retry_payment', ip, { windowMinutes: RETRY_WINDOW_MIN, max: RETRY_MAX_PER_IP })) {
    return send(res, 429, { error: MSG_RETRY_TOO_MANY, code: 'rate_limited' });
  }
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};
  const notFound = () => send(res, 404, { error: 'Pedido não encontrado.', code: 'order_not_found' });
  // Pedido pelo token de rastreio (t) ou, na conta, pelo número interno (o) com a sessão do dono (F3, tracking_url).
  const token = typeof b.t === 'string' ? b.t : '';
  let o;
  if (token) {
    if (!ordersLib.TRACKING_RE.test(token)) return notFound();
    [o] = await sql.query(`select ${RETRY_COLUMNS} from orders where tracking_token_hash = $1`, [ordersLib.hashTrackingToken(token)]);
  } else if (b.o !== undefined) {
    if (!isId(b.o)) return notFound();
    const session = await customerLib.getSession(sql, req);
    if (!session) return send(res, 401, { error: 'Entre na sua conta para pagar este pedido.', code: 'login_required' });
    [o] = await sql.query(`select ${RETRY_COLUMNS} from orders where id = $1 and customer_id = $2`, [b.o, session.customer.id]);
  }
  if (!o) return notFound();
  if (await hitExceeded(sql, 'retry_payment_order', 'order:' + o.id, { windowMinutes: RETRY_WINDOW_MIN, max: RETRY_MAX_PER_ORDER })) {
    return send(res, 429, { error: MSG_RETRY_TOO_MANY, code: 'rate_limited' });
  }
  if (b.payment_choice !== undefined && !PAYMENT_CHOICES.includes(b.payment_choice)) fail('Escolha Pix ou cartão.');
  const choice = b.payment_choice || (o.payment_method === 'pix' ? 'pix' : 'card');
  const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!mpToken) return send(res, 503, { error: 'O pagamento on-line está indisponível agora. Fale com a loja pelo WhatsApp.', code: 'payment_unavailable' });

  // O cliente pode ter acabado de pagar: confere no Mercado Pago antes (mesmas regras do webhook). Falha só vai para o log.
  if (o.payment_method && !PAID_STATUSES.includes(o.payment_status) && o.fulfillment_status !== 'cancelled') {
    try { await payments.checkOrderPayment(sql, o, { source: 'retry_payment', timeoutMs: RETRY_CHECK_TIMEOUT_MS }); } catch (err) {
      console.error('retry_payment: conferência falhou:', err.message);
    }
    [o] = await sql.query(`select ${RETRY_COLUMNS} from orders where id = $1`, [o.id]);
  }
  const block = await retryBlock(sql, o);
  if (block) return send(res, block[0], { error: block[1], code: block[2] });

  // Chave de idempotência nova a cada tentativa (a do pedido devolveria o pagamento antigo). A hora é marcada ANTES de
  // chamar o Mercado Pago: aviso não aprovado de pagamento criado antes dela é ignorado (payments.syncPayment).
  const startedAt = new Date();
  const suffix = crypto.randomBytes(4).toString('hex');
  const stillOpen = n => `payment_status <> all($${n}::text[]) and fulfillment_status <> 'cancelled'`;
  let payment;
  try {
    if (choice === 'pix') {
      const pix = await createPixPayment(mpToken, o, o.customer_name, `pix-${o.code}-${suffix}`);
      const exp = new Date(pix.expires_at);
      const rows = await sql.query(
        `update orders set payment_method = 'pix', payment_id = $2, payment_status = $3, pix_qr_code = $4, pix_qr_base64 = $5, pix_expires_at = $6,
                payment_attempt_at = $7
          where id = $1 and ${stillOpen(8)} returning id`,
        [o.id, pix.id, pix.status, String(pix.qr_code).slice(0, 4000), String(pix.qr_code_base64).slice(0, 200000),
          Number.isNaN(exp.getTime()) ? new Date(Date.now() + PIX_TTL_MS) : exp, startedAt, PAID_STATUSES]);
      if (!rows.length) return send(res, 409, { error: 'Este pedido já está pago ou foi cancelado.', code: 'already_paid' });
      payment = { type: 'pix', id: pix.id, qr_code: pix.qr_code, qr_code_base64: pix.qr_code_base64, expires_at: pix.expires_at };
    } else {
      const prefItems = buildPreferenceItems(paidItemsOf(o), o.delivery_fee_cents, o.discount_cents, o.public_code);
      const sum = prefItems.reduce((s, i) => s + Math.round(i.unit_price * 100) * i.quantity, 0);
      if (sum !== o.total_cents) throw new Error('itens do pedido não somam o total');
      const pref = await createPreference(mpToken, { ...o, tracking_token: token || null, track_order_id: o.id }, prefItems, `pref-${o.code}-${suffix}`);
      if (!pref || !pref.init_point || !pref.id) throw new Error('preferência sem link');
      const rows = await sql.query(
        `update orders set payment_method = 'mercadopago_card', payment_id = $2, payment_status = 'pending',
                pix_qr_code = null, pix_qr_base64 = null, pix_expires_at = null, payment_attempt_at = $3
          where id = $1 and ${stillOpen(4)} returning id`,
        [o.id, String(pref.id), startedAt, PAID_STATUSES]);
      if (!rows.length) return send(res, 409, { error: 'Este pedido já está pago ou foi cancelado.', code: 'already_paid' });
      payment = { type: 'card', url: pref.init_point, id: String(pref.id) };
    }
  } catch (err) {
    console.error('retry_payment: falha ao gerar pagamento:', String(err.message || '').replace(/\S+@\S+/g, '<email>').slice(0, 160));
    return send(res, 502, { error: 'Não foi possível gerar o pagamento agora. Tente de novo em instantes.', code: 'payment_unavailable' });
  }
  return send(res, 200, { public_code: o.public_code, total_cents: o.total_cents, payment_choice: choice, payment });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  // A1-05: só o próprio site cria pedido. Origin igual ao Host (e Sec-Fetch-Site same-origin quando vier) e corpo JSON
  // (text/plain dispensaria o preflight de CORS e deixaria outro site postar pedidos).
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'Origem não permitida.', code: 'forbidden_origin' });
  if (!auth.isJsonType(req)) return res.status(415).json({ error: 'Envie os dados como JSON.', code: 'unsupported_type' });
  // F3: ?a=retry_payment gera novo pagamento de um pedido existente. Sem ?a: cria pedido (como antes).
  const action = (req.query && typeof req.query.a === 'string') ? req.query.a : new URL(req.url || '/', 'http://x').searchParams.get('a');
  if (action && action !== 'retry_payment') return res.status(404).json({ error: 'Ação desconhecida.', code: 'unknown_action' });
  try {
    if (action === 'retry_payment') return await retryPayment(req, res, require('./_lib/db'));
    const sql = require('./_lib/db'); // carregado aqui para testar a função pura sem DATABASE_URL
    // Limite por IP antes de qualquer trabalho caro (frete, catálogo). Toda tentativa conta, até as recusadas.
    // 403/415 acima não contam: um site de terceiros não consegue gastar a cota do IP de quem o visita.
    const ip = auth.clientIp(req);
    if (await attemptsExceeded(sql, ip)) return send(res, 429, { error: MSG_TOO_MANY, code: 'rate_limited' });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Dados inválidos.');

    // Loja fechada (horário, fechamento manual ou pausa antiga): recusa já, informando quando abre.
    // v4 N10: com data marcada (scheduled_for) a loja fechada agora não impede; a janela é validada logo abaixo.
    const wantsSchedule = b.scheduled_for !== undefined && b.scheduled_for !== null && b.scheduled_for !== '';
    const state = await storeHours.getStoreState(sql);
    if (!state.open && !wantsSchedule) {
      return send(res, 503, {
        error: state.message || 'Estamos fechados no momento.',
        code: 'store_closed',
        store: { open: false, reason: state.reason, reopens_at: state.reopens_at, next_open_at: state.next_open_at, message: state.message }
      });
    }

    // v4 N10: janela de 30 min, horário do dia, antecedência, máximo de dias e vaga. null = o quanto antes.
    const schedule = await scheduling.validateRequested(sql, b.scheduled_for);

    const settingRows = await sql.query(`select key, value from settings where key in ('store_address')`);
    const st = {};
    for (const r of settingRows) st[r.key] = r.value;

    const customer = validateCustomer(b, st.store_address || STORE_ADDRESS);
    // Limite de pedidos por telefone e por IP também ANTES do frete (o insert confere de novo, de forma atômica).
    if (overOrderLimit(await recentOrders(sql, customer.phone, ip))) return send(res, 429, { error: MSG_TOO_MANY, code: 'rate_limited' });
    // Mesmo teto global de consultas novas de endereço do /api/store (protege ViaCEP/Nominatim/OSRM), antes do catálogo e do frete.
    if (customer.method === 'delivery' && await shipping.tooManyNewLookups(sql)) return send(res, 429, { error: MSG_SHIPPING_BUSY, code: 'shipping_busy' });
    const choice = PAYMENT_CHOICES.includes(b.payment_choice) ? b.payment_choice : 'card';
    // v4 N3: o desconto em reais por pontos acabou (o saldo continua e vale para os prêmios do Clube).
    if (b.use_points !== undefined && b.use_points !== null && b.use_points !== 0 && b.use_points !== false) {
      return send(res, 400, { error: 'O desconto com pontos foi substituído pelo Clube: troque seus pontos por um prêmio.', code: 'points_discount_ended' });
    }
    const hasRewardsInput = Array.isArray(b.rewards) && b.rewards.length > 0;
    if ((!Array.isArray(b.items) || b.items.length === 0) && hasRewardsInput) {
      return send(res, 400, { error: MSG_REWARD_MIN, code: 'reward_min_subtotal' });
    }
    if (!Array.isArray(b.items) || b.items.length === 0) fail('O carrinho está vazio.');
    if (b.items.length > MAX_ITEMS) fail(`O pedido pode ter no máximo ${MAX_ITEMS} itens.`);
    const ids = [...new Set(b.items.map(i => (i && isId(i.product_id) ? i.product_id : null)).filter(Boolean))];

    const catalog = await loadCatalog(sql, ids);
    const priced = priceItems(b.items, catalog);

    // Frete: retirada R$ 0; entrega por faixa de km, recalculado aqui (o cliente nunca informa valor).
    let deliveryFee = 0, distanceKm = null;
    if (customer.method === 'delivery') {
      const quote = await shipping.quoteDelivery(sql, { cep: customer.cep, address: customer.address, number: customer.number });
      deliveryFee = quote.fee_cents;
      distanceKm = quote.km;
    }

    const session = await customerLib.getSession(sql, req);

    // Clube (v4 N3): prêmios trocados por pontos. Exige login, programa ligado, sem bloqueio de 48 h, saldo e R$ 1,00 em itens pagos.
    const rewards = await club.resolveRewards(sql, b.rewards);
    const clubPoints = rewards.points_total;
    if (clubPoints > 0) {
      if (!session) return send(res, 401, { error: 'Entre na sua conta para trocar pontos por prêmios.', code: 'login_required' });
      if (priced.subtotal_cents < loyalty.MIN_CHARGE_CENTS) return send(res, 400, { error: MSG_REWARD_MIN, code: 'reward_min_subtotal' });
      const bal = await loyalty.getBalance(sql, session.customer.id); // também devolve reservas vencidas
      if (!bal.points_enabled) return send(res, 409, { error: 'O Clube está pausado no momento. Faça o pedido sem prêmios; seu saldo continua guardado.', code: 'points_disabled' });
      if (bal.locked_until) {
        return send(res, 423, { error: 'A troca de pontos está bloqueada por 48 h por segurança (recuperação de conta recente). Você pode fazer o pedido sem prêmios.', code: 'points_locked', locked_until: bal.locked_until });
      }
      if (bal.balance < clubPoints) {
        return send(res, 409, { error: `Saldo de pontos insuficiente: você tem ${Math.max(0, bal.balance)} pontos e os prêmios custam ${clubPoints}.`, code: 'insufficient_points' });
      }
    }

    // Cupom (v4 N6): validado no servidor sobre o subtotal dos itens pagos. Limite por cliente = por telefone normalizado.
    const pk = phoneKey(customer.phone);
    let coupon = null, couponDiscount = 0;
    if (b.coupon_code !== undefined && b.coupon_code !== null && b.coupon_code !== '') {
      const ev = await coupons.evaluate(sql, { code: b.coupon_code, paidSubtotalCents: priced.subtotal_cents, phoneKey: pk, hasRewards: clubPoints > 0 });
      coupon = ev.coupon;
      couponDiscount = ev.discount_cents;
    }
    const discount = couponDiscount;
    const total = priced.subtotal_cents - discount + deliveryFee;
    if (total < loyalty.MIN_CHARGE_CENTS) fail('O valor a pagar precisa ser de pelo menos R$ 1,00.');
    const allItems = [...priced.items, ...rewards.items];

    // A-02 + A-07 (v4): pedido e reservas (prêmio do Clube e cupom) numa transação só. O pedido nunca fica gravado sem a reserva.
    //  1. trava de pontos do cliente (classe 1), do cupom (classe 2) e da janela agendada (classe 3, v4 N10), sempre nessa ordem (sem deadlock);
    //  2. insert do pedido condicionado: limite por telefone e IP, DG-#### livre, saldo >= pontos dos prêmios, cupom com uso livre
    //     e vaga na janela agendada;
    //  3. reserva dos pontos (reward_reserve) e do cupom, lidas do pedido recém-criado (nada é gravado se o pedido não entrou).
    // Cada instrução da transação enxerga o que foi gravado antes de a trava ser obtida: dois pedidos simultâneos nunca gastam
    // o mesmo ponto nem passam do limite de usos do cupom.
    const tracking = ordersLib.newTrackingToken();
    const customerId = session ? session.customer.id : null;
    let order = null;
    for (let attempt = 0; attempt < MAX_CODE_TRIES && !order; attempt++) {
      const publicCode = ordersLib.newPublicCode();
      const queries = [];
      if (clubPoints > 0) queries.push(sql.query('select pg_advisory_xact_lock($1::int, $2::int)', [loyalty.LOCK_POINTS, customerId]));
      if (coupon) queries.push(sql.query('select pg_advisory_xact_lock($1::int, $2::int)', [loyalty.LOCK_COUPON, coupon.id]));
      if (schedule && schedule.capacity > 0) queries.push(sql.query('select pg_advisory_xact_lock($1::int, $2::int)', [scheduling.LOCK_SLOT, schedule.key]));
      queries.push(sql.query(
        `insert into orders (code, public_code, tracking_token_hash, customer_id, customer_name, customer_phone, delivery_method, address, items,
                             subtotal_cents, delivery_fee_cents, discount_cents, points_redeemed, total_cents, distance_km, notes, payment_status, client_ip,
                             club_points, coupon_id, coupon_code, coupon_discount_cents, scheduled_for)
         select $1::text, $2::text, $3::text, $4::int, $5::text, $6::text, $7::text, $8::text, $9::jsonb,
                $10::int, $11::int, $12::int, 0, $13::int, $14::numeric, $15::text, 'pending', $17::text,
                $19::int, $20::int, $21::text, $12::int, $23::timestamptz
          where (select count(*) from orders
                  where regexp_replace(customer_phone, '\\D', '', 'g') = $6::text
                    and created_at > now() - interval '10 minutes') < $16::int
            and (select count(*) from orders where client_ip = $17::text and created_at > now() - interval '10 minutes') < $18::int
            and not exists (select 1 from orders where public_code = $2::text and created_at > now() - interval '${ordersLib.PUBLIC_CODE_WINDOW}')
            and ($19::int = 0 or (select coalesce(sum(points), 0) from loyalty_ledger where customer_id = $4::int) >= $19::int)
            and ($20::int is null or ${coupons.eligibleSql('$20', '$22')})
            and ($23::timestamptz is null or $24::int = 0
                 or (select count(*) from orders where scheduled_for = $23::timestamptz and ${scheduling.OCCUPIES_SQL}) < $24::int)
         returning id, code, public_code, total_cents`,
        [newCode(), publicCode, tracking.hash, customerId, customer.name, customer.phone, customer.method, customer.address,
          JSON.stringify(allItems), priced.subtotal_cents, deliveryFee, discount, total, distanceKm, customer.notes, MAX_ORDERS_PER_PHONE,
          ip, MAX_ORDERS_PER_IP, clubPoints, coupon ? coupon.id : null, coupon ? coupon.code : null, pk,
          schedule ? schedule.iso : null, schedule ? schedule.capacity : 0]
      ));
      if (clubPoints > 0) {
        queries.push(sql.query(
          `insert into loyalty_ledger (customer_id, order_id, kind, points, note)
           select o.customer_id, o.id, 'reward_reserve', -o.club_points, 'reserva de prêmio do Clube'
             from orders o where o.tracking_token_hash = $1::text and o.club_points > 0
           on conflict (order_id, kind) where order_id is not null do nothing`, [tracking.hash]));
      }
      if (coupon) queries.push(coupons.reserveStatement(sql, { couponId: coupon.id, trackingHash: tracking.hash, phoneKey: pk, discountCents: couponDiscount }));
      const results = await sql.transaction(queries);
      const rows = results[(clubPoints > 0 ? 1 : 0) + (coupon ? 1 : 0) + (schedule && schedule.capacity > 0 ? 1 : 0)];
      if (rows.length) { order = rows[0]; break; }
      // Não entrou: descobre o motivo (limite, saldo, cupom) ou foi colisão do DG-#### (sorteia outro).
      if (overOrderLimit(await recentOrders(sql, customer.phone, ip))) return send(res, 429, { error: MSG_TOO_MANY, code: 'rate_limited' });
      if (clubPoints > 0) {
        const [{ n }] = await sql.query('select coalesce(sum(points), 0)::int n from loyalty_ledger where customer_id = $1', [customerId]);
        if (n < clubPoints) return send(res, 409, { error: 'Saldo de pontos insuficiente. Atualize a página e tente de novo.', code: 'insufficient_points' });
      }
      // v4 N10: a janela lotou entre a conferência e o insert (outro pedido levou a última vaga).
      if (schedule && schedule.capacity > 0 && (await scheduling.slotTaken(sql, schedule.start)) >= schedule.capacity) throw scheduling.slotFull();
      // Cupom esgotado ou limite do cliente atingido no meio do caminho: evaluate lança o erro certo (409).
      if (coupon) await coupons.evaluate(sql, { code: coupon.code, paidSubtotalCents: priced.subtotal_cents, phoneKey: pk, hasRewards: clubPoints > 0 });
    }
    if (!order) throw new Error('não foi possível gerar um código de pedido único');

    // Se a criação do pagamento falhar, o pedido continua válido (payment: null).
    let payment = null;
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (mpToken && choice === 'pix') {
      try {
        const pix = await createPixPayment(mpToken, order, customer.name);
        payment = { type: 'pix', id: pix.id, qr_code: pix.qr_code, qr_code_base64: pix.qr_code_base64, expires_at: pix.expires_at };
        // U-01 (v4): guarda o Pix para a página do pedido reabrir o pagamento (apagado quando o pagamento sai de pendente).
        const exp = new Date(pix.expires_at);
        await sql.query(
          `update orders set payment_method = 'pix', payment_id = $2, payment_status = $3, pix_qr_code = $4, pix_qr_base64 = $5, pix_expires_at = $6
            where id = $1`,
          [order.id, pix.id, pix.status, String(pix.qr_code).slice(0, 4000), String(pix.qr_code_base64).slice(0, 200000),
            Number.isNaN(exp.getTime()) ? new Date(Date.now() + PIX_TTL_MS) : exp]);
      } catch (err) {
        payment = null;
        console.error('Falha ao criar Pix no Mercado Pago:', err.message);
      }
    } else if (mpToken) {
      try {
        const pref = await createPreference(mpToken, { ...order, tracking_token: tracking.token }, buildPreferenceItems(priced.items, deliveryFee, discount, order.public_code));
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
      points_redeemed: 0,
      club_points: clubPoints,
      coupon_code: coupon ? coupon.code : null,
      coupon_discount_cents: couponDiscount,
      total_cents: order.total_cents,
      distance_km: distanceKm,
      delivery_method: customer.method,
      address: customer.address,
      items: allItems,
      scheduled_for: schedule ? schedule.iso : null, // v4 N10: null = o quanto antes
      scheduled_label: schedule ? scheduling.scheduledLabel(schedule.start) : null,
      payment
    });
  } catch (error) {
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof shipping.ShippingError) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.max_km ? { max_km: error.max_km } : {}) });
    if (error instanceof loyalty.LoyaltyError || error instanceof club.ClubError || error instanceof coupons.CouponError || error instanceof scheduling.ScheduleError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    // QA v3 B1: a mensagem de erro inesperado pode trazer valores (telefone, e-mail). Loga o código e a mensagem
    // com e-mails e sequências de 4+ dígitos mascarados, o suficiente para diagnosticar sem dados pessoais.
    const code = error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : 'sem_codigo';
    const safeMsg = String((error && error.message) || '').replace(/\S+@\S+/g, '<email>').replace(/\d{4,}/g, '<n>').slice(0, 200);
    console.error('Erro ao criar pedido:', code, safeMsg);
    return res.status(500).json({ error: 'Não foi possível criar o pedido' });
  }
};

module.exports._internal = { RETRY_MAX_PER_IP, RETRY_MAX_PER_ORDER, retryBlock, paidItemsOf, MAX_ORDERS_PER_PHONE, MAX_ORDERS_PER_IP, MAX_ATTEMPTS_PER_IP, priceItems, validateCustomer, buildPreferenceItems, buildPreferenceBody, buildPixBody, backUrls, NOTIFICATION_URL, pixPayerEmail, createPixPayment, PAYMENT_CHOICES, STORE_ADDRESS, ValidationError, loadCatalog, isId, MAX_ITEMS };
