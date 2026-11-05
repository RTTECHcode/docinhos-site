create table if not exists categories (
  id serial primary key,
  name text not null unique,
  sort_order integer not null default 0,
  active boolean not null default true
);
create table if not exists products (
  id serial primary key,
  category_id integer not null references categories(id),
  name text not null,
  description text not null default '',
  price_cents integer,
  image_path text,
  active boolean not null default true,
  sort_order integer not null default 0,
  constraint products_name_unique unique (name)
);
create table if not exists complements (
  id serial primary key,
  name text not null unique,
  price_cents integer,
  active boolean not null default true
);
create table if not exists product_complements (
  product_id integer not null references products(id) on delete cascade,
  complement_id integer not null references complements(id) on delete cascade,
  primary key (product_id, complement_id)
);
