const sql = require('../api/db');
const products = require('./catalog');
const fs = require('fs');
(async () => {
  const schema = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await sql.query(statement);
  const categories = [...new Set(products.map(item => item[2]))];
  for (let i = 0; i < categories.length; i++) await sql`insert into categories (name, sort_order) values (${categories[i]}, ${i}) on conflict (name) do update set sort_order = excluded.sort_order`;
  for (let i = 0; i < products.length; i++) {
    const [name, image, category, priceCents, description] = products[i];
    const [{ id: categoryId }] = await sql`select id from categories where name = ${category}`;
    await sql`insert into products (category_id, name, description, price_cents, image_path, sort_order) values (${categoryId}, ${name}, ${description}, ${priceCents}, ${'/images/products/' + image}, ${i})
      on conflict (name) do update set description = excluded.description, price_cents = excluded.price_cents, image_path = excluded.image_path, sort_order = excluded.sort_order, active = true`;
  }
  console.log(`Seed concluído: ${products.length} produtos em ${categories.length} categorias`);
})().catch(error => { console.error(error); process.exitCode = 1; });
