const sql = require('./db');

const SITE_URL = 'https://docinhos-site.vercel.app';
const MP_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';

function normalizeItems(items) {
  return items.map(i => ({
    raw: i,
    qty: Math.max(1, Math.floor(Number(i.qty)) || 1),
    unitCents: Math.max(0, Math.round(Number(i.unit_total_cents)) || 0)
  }));
}

// Um item do Mercado Pago por produto do pedido (preço em reais).
function buildPreferenceItems(normalized) {
  return normalized
    .filter(i => i.unitCents > 0)
    .map((i, idx) => {
      const extras = Array.isArray(i.raw.extras) ? i.raw.extras.filter(Boolean) : [];
      const title = [String(i.raw.name || 'Produto'), i.raw.size ? `- ${i.raw.size}` : '', extras.length ? `(+ ${extras.join(', ')})` : '']
        .filter(Boolean).join(' ').slice(0, 256);
      return { id: String(idx + 1), title, quantity: i.qty, currency_id: 'BRL', unit_price: Number((i.unitCents / 100).toFixed(2)) };
    });
}

async function createPreference(token, order, prefItems) {
  const mpRes = await fetch(MP_PREFERENCES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Idempotency-Key': `pref-${order.code}`
    },
    body: JSON.stringify({
      items: prefItems,
      external_reference: order.code,
      back_urls: {
        success: `${SITE_URL}/?pagamento=ok`,
        failure: `${SITE_URL}/?pagamento=erro`,
        pending: `${SITE_URL}/?pagamento=pendente`
      },
      auto_return: 'approved',
      notification_url: `${SITE_URL}/api/mp-webhook`,
      statement_descriptor: 'DOCINHOS GIGI'
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!mpRes.ok) throw new Error(`Mercado Pago respondeu ${mpRes.status}`);
  return mpRes.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const b = req.body || {};
    if (!b.customer_name || !b.customer_phone || !Array.isArray(b.items) || !b.items.length)
      return res.status(400).json({ error: 'Dados incompletos' });

    const normalized = normalizeItems(b.items);
    const subtotal = normalized.reduce((s, i) => s + i.unitCents * i.qty, 0);
    if (subtotal <= 0) return res.status(400).json({ error: 'Carrinho vazio' });

    const code = 'DG' + Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 36).toString(36).toUpperCase();
    const [order] = await sql.query(
      `insert into orders (code, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, total_cents, notes, payment_status)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
       returning id, code, total_cents`,
      [code, b.customer_name, b.customer_phone, b.delivery_method || 'delivery', b.address || null, JSON.stringify(b.items), subtotal, subtotal, b.notes || null]
    );

    // Se a preference falhar, o pedido continua válido (payment: null).
    let payment = null;
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (mpToken) {
      try {
        const pref = await createPreference(mpToken, order, buildPreferenceItems(normalized));
        if (pref && pref.init_point && pref.id) {
          payment = { url: pref.init_point, id: String(pref.id) };
          await sql`update orders set payment_method = 'mercadopago', payment_id = ${String(pref.id)} where id = ${order.id}`;
        }
      } catch (err) {
        console.error('Falha ao criar preference do Mercado Pago:', err.message);
      }
    }

    res.status(201).json({ ...order, payment });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível criar o pedido' });
  }
};
