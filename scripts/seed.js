const sql = require('../api/db');
const { products, complements, productComplements } = require('./catalog');
const fs = require('fs');
(async () => {
  const schema = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await sql.query(statement);

  const categoryOrder = ['Copos da felicidade', 'Doces no pote', 'Geladinhos Gourmet', 'Açaí', 'Sobremesas tamanho família'];
  for (let i = 0; i < categoryOrder.length; i++) {
    await sql`insert into categories (name, sort_order) values (${categoryOrder[i]}, ${i}) on conflict (name) do update set sort_order = excluded.sort_order, active = true`;
  }
  await sql.query('update categories set active = false where name <> all($1::text[])', [categoryOrder]);

  for (const c of complements) {
    await sql`insert into complements (name, price_cents, kind) values (${c.name}, ${c.price_cents}, ${c.kind}) on conflict (name) do update set price_cents = excluded.price_cents, kind = excluded.kind, active = true`;
  }

  for (let i = 0; i < products.length; i++) {
    const [name, image, category, priceCents, description] = products[i];
    const [{ id: categoryId }] = await sql`select id from categories where name = ${category}`;
    await sql`insert into products (category_id, name, description, price_cents, image_path, sort_order) values (${categoryId}, ${name}, ${description}, ${priceCents}, ${'/images/products/' + image}, ${i})
      on conflict (name) do update set category_id = excluded.category_id, description = excluded.description, price_cents = excluded.price_cents, image_path = excluded.image_path, sort_order = excluded.sort_order, active = true`;
  }
  await sql.query('update products set active = false where name <> all($1::text[])', [products.map(p => p[0])]);

  for (const [productName, complementName, maxQty] of productComplements) {
    await sql`insert into product_complements (product_id, complement_id, max_quantity)
      select p.id, c.id, ${maxQty} from products p, complements c
      where p.name = ${productName} and c.name = ${complementName}
      on conflict (product_id, complement_id) do update set max_quantity = excluded.max_quantity`;
  }
  console.log(`Seed: ${products.length} produtos, ${complements.length} complementos, ${productComplements.length} vínculos`);
})().catch(error => { console.error(error); process.exitCode = 1; });
