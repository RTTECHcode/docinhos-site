const sql = require('./_lib/db');
const { getStoreState } = require('./_lib/store-hours');
const { getBands, maxKmOf } = require('./_lib/shipping');
const { getRules } = require('./_lib/loyalty');
// Produto sem preço e sem tamanho disponível: aparece, mas não pode ir para o carrinho (o pedido recusaria no fim).
const NO_PRICE_LABEL = 'Consulte pelo WhatsApp';
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const rows = await sql`
      select c.id category_id, c.name category_name, c.sort_order category_order,
             p.id, p.name, p.description, p.price_cents, p.image_path, p.sort_order, p.paused
      from categories c join products p on p.category_id = c.id
      where c.active and p.active order by c.sort_order, p.sort_order, p.name
    `;
    const links = await sql`
      select pc.product_id, c.id, c.name, c.price_cents, c.kind, pc.max_quantity, pc.group_id, pc.paused
      from product_complements pc
      join complements c on c.id = pc.complement_id and c.active
      order by c.kind, c.name
    `;
    // Configurações da loja (painel /admin). Valores padrão se a chave ainda não existir.
    const settingRows = await sql`select key, value from settings where key in ('store_address', 'delivery_fee_cents', 'store_paused', 'store_paused_message')`;
    const st = {};
    for (const s of settingRows) st[s.key] = s.value;
    // Estado da loja (horário + fechamento manual) e faixas de frete (públicas, o cliente só vê; o servidor recalcula).
    // Regra de pontos (Ajustes do painel): só para mostrar na loja; o pedido recalcula tudo no servidor.
    const [store, bands, rules] = await Promise.all([getStoreState(sql), getBands(sql), getRules(sql)]);
    const settings = {
      storeAddress: st.store_address || 'Manoel Hare Peralta, 101',
      deliveryFeeCents: Number.parseInt(st.delivery_fee_cents, 10) || 0, // legado: o frete real vem de shipping.bands
      storePaused: !store.open, // compatível com a loja antiga: true quando fechada (horário ou manual)
      storePausedMessage: store.open ? '' : (store.message || '')
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
      // D5 (v3): complemento pausado aparece com unavailable: true (o pedido continua recusando); antes era escondido.
      const comp = { id: l.id, name: l.name, priceCents: l.price_cents, kind: l.kind, maxQuantity: l.max_quantity, groupId: l.kind === 'size' ? null : l.group_id };
      if (l.paused) comp.unavailable = true;
      (byProduct[l.product_id] ||= []).push(comp);
    }
    const categories = [];
    for (const row of rows) {
      let category = categories.find(item => item.id === row.category_id);
      if (!category) { category = { id: row.category_id, name: row.category_name, products: [] }; categories.push(category); }
      const product = { id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, imagePath: row.image_path, complements: byProduct[row.id] || [], groups: groupsByProduct[row.id] || [] };
      // D6 (v3): pausado = só a flag (a etiqueta é fixa, definida pela loja no front). Aparece, mas não pode ser pedido.
      if (row.paused) { product.unavailable = true; product.paused = true; }
      else if (row.price_cents === null && !product.complements.some(c => c.kind === 'size' && !c.unavailable)) { product.unavailable = true; product.label = NO_PRICE_LABEL; }
      category.products.push(product);
    }
    const shipping = { bands, maxKm: maxKmOf(bands), pickupFeeCents: 0 };
    const storeState = { open: store.open, reason: store.reason, reopens_at: store.reopens_at, next_open_at: store.next_open_at, closes_at: store.closes_at, message: store.message };
    const points = { enabled: rules.enabled, pointsPerReal: rules.points_per_real, blockPoints: rules.block_points, blockValueCents: rules.block_value_cents };
    res.status(200).json({ categories, settings, store: storeState, shipping, points });
  } catch (error) { res.status(500).json({ error: 'Não foi possível carregar o cardápio' }); }
};
module.exports.NO_PRICE_LABEL = NO_PRICE_LABEL;
