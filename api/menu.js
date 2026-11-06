const sql = require('./db');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const rows = await sql`
      select c.id category_id, c.name category_name, c.sort_order category_order,
             p.id, p.name, p.description, p.price_cents, p.image_path, p.sort_order
      from categories c join products p on p.category_id = c.id
      where c.active and p.active order by c.sort_order, p.sort_order, p.name
    `;
    const links = await sql`
      select pc.product_id, c.id, c.name, c.price_cents, c.kind, pc.max_quantity
      from product_complements pc
      join complements c on c.id = pc.complement_id and c.active
      order by c.kind, c.name
    `;
    const byProduct = {};
    for (const l of links) {
      (byProduct[l.product_id] ||= []).push({ id: l.id, name: l.name, priceCents: l.price_cents, kind: l.kind, maxQuantity: l.max_quantity });
    }
    const categories = [];
    for (const row of rows) {
      let category = categories.find(item => item.id === row.category_id);
      if (!category) { category = { id: row.category_id, name: row.category_name, products: [] }; categories.push(category); }
      category.products.push({ id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, imagePath: row.image_path, complements: byProduct[row.id] || [] });
    }
    res.status(200).json({ categories });
  } catch (error) { res.status(500).json({ error: 'Não foi possível carregar o cardápio' }); }
};
