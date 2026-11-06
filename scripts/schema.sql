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
  price_cents integer not null default 0,
  kind text not null default 'additional',
  active boolean not null default true
);
create table if not exists product_complements (
  product_id integer not null references products(id) on delete cascade,
  complement_id integer not null references complements(id) on delete cascade,
  max_quantity integer not null default 1,
  primary key (product_id, complement_id)
);
create table if not exists orders (
  id serial primary key,
  code text not null unique,
  customer_name text not null,
  customer_phone text not null,
  delivery_method text not null default 'delivery',
  address text,
  items jsonb not null,
  subtotal_cents integer not null,
  delivery_fee_cents integer not null default 0,
  total_cents integer not null,
  payment_method text,
  payment_id text,
  payment_status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now()
);
