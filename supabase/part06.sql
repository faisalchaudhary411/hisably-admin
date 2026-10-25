alter table public.products add column if not exists shopify_product_id text;
alter table public.products add column if not exists shopify_variant_id text;
alter table public.products add column if not exists shopify_inventory_item_id text;
alter table public.products add column if not exists shopify_synced_price numeric;
alter table public.products add column if not exists shopify_synced_stock integer;
create unique index if not exists uq_products_shopify_variant on public.products(shop_id, shopify_variant_id) where shopify_variant_id is not null;
create index if not exists idx_products_shopify_item on public.products(shop_id, shopify_inventory_item_id);
alter table public.customers add column if not exists shopify_customer_id text;
create unique index if not exists uq_customers_shopify on public.customers(shop_id, shopify_customer_id) where shopify_customer_id is not null;
alter table public.invoices add column if not exists shopify_order_id text;
create unique index if not exists uq_invoices_shopify on public.invoices(shop_id, shopify_order_id) where shopify_order_id is not null;
create table if not exists public.shopify_connections (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  domain text not null,
  access_token text,
  client_id text,
  client_secret text,
  api_secret text,
  token_cache text,
  token_expires_at timestamptz,
  location_id text,
  location_name text,
  last_pull_at timestamptz,
  last_orders_at timestamptz,
  last_push_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_shopify_domain on public.shopify_connections(domain);
alter table public.shopify_connections enable row level security;
revoke all on public.shopify_connections from anon, authenticated;
