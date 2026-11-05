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
    const categories = [];
    for (const row of rows) {
      let category = categories.find(item => item.id === row.category_id);
      if (!category) { category = { id: row.category_id, name: row.category_name, products: [] }; categories.push(category); }
      category.products.push({ id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, imagePath: row.image_path });
    }
    res.status(200).json({ categories });
  } catch (error) { res.status(500).json({ error: 'Não foi possível carregar o cardápio' }); }
};
