const sql = require('./_lib/db');
const { getStoreState } = require('./_lib/store-hours');
const { getBands, maxKmOf } = require('./_lib/shipping');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const rows = await sql`
      select c.id category_id, c.name category_name, c.sort_order category_order,
             p.id, p.name, p.description, p.price_cents, p.image_path, p.sort_order, p.paused, p.pause_label
      from categories c join products p on p.category_id = c.id
      where c.active and p.active order by c.sort_order, p.sort_order, p.name
    `;
    const links = await sql`
      select pc.product_id, c.id, c.name, c.price_cents, c.kind, pc.max_quantity, pc.group_id
      from product_complements pc
      join complements c on c.id = pc.complement_id and c.active
      where not pc.paused
      order by c.kind, c.name
    `;
    // Configurações da loja (painel /admin). Valores padrão se a chave ainda não existir.
    const settingRows = await sql`select key, value from settings where key in ('store_address', 'delivery_fee_cents', 'store_paused', 'store_paused_message', 'default_pause_label')`;
    const st = {};
    for (const s of settingRows) st[s.key] = s.value;
    // Estado da loja (horário + fechamento manual) e faixas de frete (públicas, o cliente só vê; o servidor recalcula).
    const [store, bands] = await Promise.all([getStoreState(sql), getBands(sql)]);
    const defaultPauseLabel = st.default_pause_label || 'volto logo <3';
    const settings = {
      storeAddress: st.store_address || 'Manoel Hare Peralta, 101',
      deliveryFeeCents: Number.parseInt(st.delivery_fee_cents, 10) || 0, // legado: o frete real vem de shipping.bands
      storePaused: !store.open, // compatível com a loja antiga: true quando fechada (horário ou manual)
      storePausedMessage: store.open ? '' : (store.message || ''),
      defaultPauseLabel
    };
    const groupRows = await sql`
      select id, product_id, key, label, min_choices, max_choices
      from product_groups order by product_id, sort_order, id
    `;
    const groupsByProduct = {};
    for (const g of groupRows) {
      (groupsByProduct[g.product_id] ||= []).push({ id: g.id, key: g.key, label: g.label, minChoices: g.min_choices, maxChoices: g.max_choices });
    }
    const byProduct = {};
    for (const l of links) {
      (byProduct[l.product_id] ||= []).push({ id: l.id, name: l.name, priceCents: l.price_cents, kind: l.kind, maxQuantity: l.max_quantity, groupId: l.kind === 'size' ? null : l.group_id });
    }
    const categories = [];
    for (const row of rows) {
      let category = categories.find(item => item.id === row.category_id);
      if (!category) { category = { id: row.category_id, name: row.category_name, products: [] }; categories.push(category); }
      const product = { id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, imagePath: row.image_path, complements: byProduct[row.id] || [], groups: groupsByProduct[row.id] || [] };
      if (row.paused) { product.unavailable = true; product.label = row.pause_label || defaultPauseLabel; } // pausado: aparece, mas não pode ser pedido
      category.products.push(product);
    }
    const shipping = { bands, maxKm: maxKmOf(bands), pickupFeeCents: 0 };
    const storeState = { open: store.open, reason: store.reason, reopens_at: store.reopens_at, next_open_at: store.next_open_at, closes_at: store.closes_at, message: store.message };
    res.status(200).json({ categories, settings, store: storeState, shipping });
  } catch (error) { res.status(500).json({ error: 'Não foi possível carregar o cardápio' }); }
};
