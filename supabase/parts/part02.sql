create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  number text not null,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  items jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  paid_amount numeric not null default 0,
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'partial', 'paid')),
  invoice_date timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  title text not null,
  amount numeric not null default 0,
  category text,
  notes text,
  expense_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid,
  product_name text,
  type text not null check (type in ('in', 'out')),
  qty integer not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.products        add column if not exists notes text;
alter table public.products        add column if not exists category text;
alter table public.products        add column if not exists updated_at timestamptz not null default now();
alter table public.products        add column if not exists deleted_at timestamptz;
alter table public.customers       add column if not exists updated_at timestamptz not null default now();
alter table public.customers       add column if not exists deleted_at timestamptz;
alter table public.suppliers       add column if not exists updated_at timestamptz not null default now();
alter table public.suppliers       add column if not exists deleted_at timestamptz;
alter table public.invoices        add column if not exists updated_at timestamptz not null default now();
alter table public.invoices        add column if not exists deleted_at timestamptz;
alter table public.expenses        add column if not exists notes text;
alter table public.expenses        add column if not exists updated_at timestamptz not null default now();
alter table public.expenses        add column if not exists deleted_at timestamptz;
alter table public.stock_movements add column if not exists updated_at timestamptz not null default now();
alter table public.stock_movements add column if not exists deleted_at timestamptz;
alter table public.invoices drop constraint if exists invoices_customer_id_fkey;
create index if not exists idx_products_shop  on public.products(shop_id);
create index if not exists idx_customers_shop on public.customers(shop_id);
create index if not exists idx_suppliers_shop on public.suppliers(shop_id);
create index if not exists idx_invoices_shop  on public.invoices(shop_id, invoice_date desc);
create index if not exists idx_expenses_shop  on public.expenses(shop_id);
create index if not exists idx_stock_shop     on public.stock_movements(shop_id, created_at desc);
create index if not exists idx_profiles_shop  on public.profiles(shop_id);
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  email text,
  shop_name text,
  plan_id text,
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
