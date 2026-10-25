create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_name text,
  owner_phone text,
  owner_email text,
  city text,
  plan_id text not null default 'free',
  status text not null default 'trial'
    check (status in ('trial', 'active', 'paused', 'expired')),
  settings jsonb default '{}'::jsonb,
  trial_ends_at timestamptz,
  paid_until timestamptz,                -- NEW: paid plans expire (monthly)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shops add column if not exists paid_until timestamptz;
create table if not exists public.shop_notes (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  notes text,
  updated_at timestamptz not null default now()
);
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='shops' and column_name='notes') then
    insert into public.shop_notes (shop_id, notes)
      select id, notes from public.shops where notes is not null and notes <> ''
      on conflict (shop_id) do nothing;
    alter table public.shops drop column notes;
  end if;
end $$;
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  role text not null default 'seller'
    check (role in ('seller', 'platform_admin')),
  shop_id uuid references public.shops(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.plans (
  id text primary key,
  name text not null,
  price numeric not null default 0,
  currency text not null default 'PKR',
  interval text not null default 'month',
  features text,
  active boolean not null default true
);
insert into public.plans (id, name, price, currency, features, active) values
  ('free', 'Free', 0, 'PKR', 'Limited products, invoices and customers', true),
  ('basic', 'Basic', 499, 'PKR', 'Unlimited + payment QR on invoices', true),
  ('pro', 'Pro', 999, 'PKR', 'Unlimited + bulk tools + priority support', true),
  ('lifetime', 'Lifetime', 14999, 'PKR', 'Pro features forever, one-time payment', true)
on conflict (id) do nothing;
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  price numeric not null default 0,
  cost numeric default 0,
  stock integer not null default 0,
  barcode text,
  unit text default 'pcs',
  low_stock integer default 5,
  category text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  phone text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
