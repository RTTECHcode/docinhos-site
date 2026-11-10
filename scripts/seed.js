const sql = require('../api/_lib/db');
const { products, complements, productComplements, productGroups, renames } = require('./catalog');
const fs = require('fs');
(async () => {
  const schema = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await sql.query(statement);

  // Renomeia em place (preserva ids) antes do upsert, senão ON CONFLICT (name) criaria duplicata.
  for (const [oldName, newName] of renames) {
    await sql`update products set name = ${newName}
      where name = ${oldName} and not exists (select 1 from products where name = ${newName})`;
  }

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

  for (const [productName, key, label, minChoices, maxChoices, sortOrder] of productGroups) {
    await sql`insert into product_groups (product_id, key, label, min_choices, max_choices, sort_order)
      select p.id, ${key}, ${label}, ${minChoices}, ${maxChoices}, ${sortOrder} from products p where p.name = ${productName}
      on conflict (product_id, key) do update set label = excluded.label, min_choices = excluded.min_choices, max_choices = excluded.max_choices, sort_order = excluded.sort_order`;
  }

  for (const [productName, complementName, maxQty, groupKey] of productComplements) {
    await sql`insert into product_complements (product_id, complement_id, max_quantity, group_id)
      select p.id, c.id, ${maxQty}, (select g.id from product_groups g where g.product_id = p.id and g.key = ${groupKey}::text)
      from products p, complements c
      where p.name = ${productName} and c.name = ${complementName}
      on conflict (product_id, complement_id) do update set max_quantity = excluded.max_quantity, group_id = excluded.group_id`;
  }
  console.log(`Seed: ${products.length} produtos, ${complements.length} complementos, ${productComplements.length} vínculos, ${productGroups.length} grupos`);
})().catch(error => { console.error(error); process.exitCode = 1; });
