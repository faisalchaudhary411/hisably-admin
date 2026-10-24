-- ============================================================
-- Hisably – Supabase schema  (v2, secure + idempotent)
-- Safe to run on a fresh project AND to re-run on an existing one
-- (it upgrades tables, replaces functions/policies, keeps your data).
-- ============================================================

-- ---------- Shops ----------
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

-- Admin-private notes live in their own table (sellers can read their shop row,
-- so private notes must NOT be a column on it).
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

-- ---------- Profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  role text not null default 'seller'
    check (role in ('seller', 'platform_admin')),
  shop_id uuid references public.shops(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- Plans ----------
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
  ('pro', 'Pro', 999, 'PKR', 'Everything in Basic + priority support', true)
on conflict (id) do nothing;

-- ---------- Seller data (shop scoped) ----------
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

-- Upgrade older installs (adds columns that v1 did not have)
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
-- invoices.customer_id used to be a hard FK; soft-deleted customers make that pointless
alter table public.invoices drop constraint if exists invoices_customer_id_fkey;

create index if not exists idx_products_shop  on public.products(shop_id);
create index if not exists idx_customers_shop on public.customers(shop_id);
create index if not exists idx_suppliers_shop on public.suppliers(shop_id);
create index if not exists idx_invoices_shop  on public.invoices(shop_id, invoice_date desc);
create index if not exists idx_expenses_shop  on public.expenses(shop_id);
create index if not exists idx_stock_shop     on public.stock_movements(shop_id, created_at desc);
create index if not exists idx_profiles_shop  on public.profiles(shop_id);

-- ---------- Payment requests ----------
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
alter table public.payment_requests add column if not exists resolved_at timestamptz;
-- one open request per shop (stops spam)
create unique index if not exists uq_payment_pending_per_shop
  on public.payment_requests(shop_id) where status = 'pending';

-- ---------- Platform settings (singleton) ----------
create table if not exists public.platform_settings (
  id int primary key default 1 check (id = 1),
  freemium_enabled boolean default true,
  jazzcash text,
  easypaisa text,
  bank_name text,
  bank_account text,
  bank_title text,
  basic_price numeric default 499,
  pro_price numeric default 999,
  currency text default 'PKR',
  payment_note text,
  updated_at timestamptz default now()
);
insert into public.platform_settings (id) values (1) on conflict do nothing;

-- ============================================================
-- Functions
-- ============================================================

-- Helpers (security definer so RLS policies can call them without recursion)
create or replace function public.my_shop_id()
returns uuid language sql stable security definer set search_path = public as $$
  select shop_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'platform_admin');
$$;

-- Signup: ALWAYS creates a 'seller'. The role is never read from client metadata.
-- Creates the shop (14-day trial) + profile in one step, so it also works when
-- "Confirm email" is ON (no session exists yet at that moment).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_n text := left(nullif(trim(meta->>'full_name'), ''), 120);
  shop_n text := left(nullif(trim(meta->>'shop_name'), ''), 120);
  phone_n text := left(nullif(trim(meta->>'phone'), ''), 40);
  sid uuid;
begin
  -- Accounts created by hand in the dashboard (no metadata) get a profile only.
  if full_n is not null or shop_n is not null then
    insert into public.shops (name, owner_name, owner_phone, owner_email, plan_id, status, trial_ends_at)
    values (coalesce(shop_n, full_n || '''s Shop'), full_n, phone_n, new.email, 'free', 'trial', now() + interval '14 days')
    returning id into sid;
  end if;
  insert into public.profiles (id, full_name, phone, role, shop_id)
  values (new.id, coalesce(full_n, ''), phone_n, 'seller', sid);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Sellers may edit their own name/phone, but never role or shop.
-- (auth.uid() is null in the SQL editor, so the one-time admin promotion still works.)
create or replace function public.protect_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin()
     and (new.role is distinct from old.role
          or new.shop_id is distinct from old.shop_id
          or new.id is distinct from old.id) then
    raise exception 'Not allowed to change role or shop';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_profile on public.profiles;
create trigger trg_protect_profile before update on public.profiles
  for each row execute procedure public.protect_profile();

-- Sellers save their shop settings (logo, invoice prefix, ...) ONLY through this
-- function, so they can never touch plan_id / status / trial / paid_until.
create or replace function public.save_shop_settings(s jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_shop_id() is null then raise exception 'No shop'; end if;
  update public.shops set settings = coalesce(s, '{}'::jsonb), updated_at = now()
  where id = public.my_shop_id();
end;
$$;

-- Effective plan of a shop, enforced server-side (client cache cannot be trusted)
create or replace function public.shop_effective_plan(sid uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when s.status in ('paused', 'expired') then 'blocked'
    when s.status = 'trial' then
      case when s.trial_ends_at is null or s.trial_ends_at < now() then 'free' else 'trial' end
    when s.status = 'active' then
      case when s.paid_until is not null and s.paid_until < now() then 'free'
           else s.plan_id end
    else 'free'
  end
  from public.shops s where s.id = sid;
$$;

-- Free-plan limits (same numbers as seller-app/js/freemium.js)
create or replace function public.enforce_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  plan text; lim int; cnt int; already boolean; enabled boolean;
begin
  if public.is_platform_admin() then return new; end if;
  plan := public.shop_effective_plan(new.shop_id);
  if plan is null then return new; end if;

  -- upsert of an existing row also fires BEFORE INSERT: let those through
  execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
    into already using new.id;
  if already then return new; end if;

  if plan = 'blocked' then
    raise exception 'LIMIT: account inactive' using errcode = 'P0001';
  end if;
  select coalesce(freemium_enabled, true) into enabled from public.platform_settings where id = 1;
  if plan <> 'free' or enabled is false then return new; end if;

  lim := case tg_table_name
    when 'products' then 25 when 'invoices' then 40 when 'customers' then 20
    when 'expenses' then 30 when 'suppliers' then 10 else null end;
  if lim is null then return new; end if;

  execute format('select count(*) from public.%I where shop_id = $1 and deleted_at is null', tg_table_name)
    into cnt using new.shop_id;
  if cnt >= lim then
    raise exception 'LIMIT: free plan allows % % - upgrade for unlimited', lim, tg_table_name
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- updated_at is client-supplied (needed for offline merge) but can never be in the future
create or replace function public.clamp_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := least(coalesce(new.updated_at, now()), now());
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['products','customers','suppliers','invoices','expenses','stock_movements'] loop
    execute format('drop trigger if exists trg_clamp_updated on public.%I', t);
    execute format('create trigger trg_clamp_updated before insert or update on public.%I
                    for each row execute procedure public.clamp_updated_at()', t);
  end loop;
  foreach t in array array['products','customers','suppliers','invoices','expenses'] loop
    execute format('drop trigger if exists trg_plan_limit on public.%I', t);
    execute format('create trigger trg_plan_limit before insert on public.%I
                    for each row execute procedure public.enforce_plan_limit()', t);
  end loop;
end $$;

-- ============================================================
-- Row Level Security
-- ============================================================
do $$
declare t text; pol record;
begin
  -- wipe every old policy so re-running always converges to the set below
  for pol in select policyname, tablename from pg_policies
             where schemaname = 'public'
               and tablename in ('shops','shop_notes','profiles','plans','products','customers',
                                 'suppliers','invoices','expenses','stock_movements',
                                 'payment_requests','platform_settings') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;

  foreach t in array array['shops','shop_notes','profiles','plans','products','customers',
                           'suppliers','invoices','expenses','stock_movements',
                           'payment_requests','platform_settings'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- shop-scoped seller tables
  foreach t in array array['products','customers','suppliers','invoices','expenses','stock_movements'] loop
    execute format('create policy "shop_select" on public.%I for select
                    using (shop_id = public.my_shop_id() or public.is_platform_admin())', t);
    execute format('create policy "shop_insert" on public.%I for insert
                    with check (shop_id = public.my_shop_id() or public.is_platform_admin())', t);
    execute format('create policy "shop_update" on public.%I for update
                    using (shop_id = public.my_shop_id() or public.is_platform_admin())
                    with check (shop_id = public.my_shop_id() or public.is_platform_admin())', t);
    execute format('create policy "shop_delete" on public.%I for delete
                    using (shop_id = public.my_shop_id() or public.is_platform_admin())', t);
  end loop;
end $$;

-- Profiles
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or public.is_platform_admin());
create policy "profiles_update_own" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_admin_all" on public.profiles for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Shops: sellers can READ their own shop only. All writes = admin
-- (sellers use save_shop_settings(); signup creates the shop in the trigger).
create policy "shops_select" on public.shops for select
  using (id = public.my_shop_id() or public.is_platform_admin());
create policy "shops_admin_write" on public.shops for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "shop_notes_admin" on public.shop_notes for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Plans / platform settings: any signed-in user reads, admin writes
create policy "plans_read" on public.plans for select to authenticated using (true);
create policy "plans_admin" on public.plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "settings_read" on public.platform_settings for select to authenticated using (true);
create policy "settings_admin" on public.platform_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Payment requests: seller may only file a pending request for THEIR shop & email
create policy "payreq_admin" on public.payment_requests for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "payreq_insert_own" on public.payment_requests for insert
  with check (
    status = 'pending'
    and shop_id = public.my_shop_id()
    and lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
  );
create policy "payreq_select_own" on public.payment_requests for select
  using (shop_id = public.my_shop_id());

-- Server clock, so changing the phone's date cannot extend a trial
create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now(); $$;

grant execute on function public.server_now() to authenticated;
grant execute on function public.save_shop_settings(jsonb) to authenticated;
