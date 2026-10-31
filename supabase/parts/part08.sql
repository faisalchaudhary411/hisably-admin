-- Part 8: purchases (stock bought from suppliers, supplier payables). Safe to re-run.
create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  number text not null,
  supplier_id uuid,
  supplier_name text,
  supplier_phone text,
  items jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  paid_amount numeric not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  purchase_date timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_purchases_shop on public.purchases(shop_id, purchase_date desc);
drop trigger if exists trg_clamp_updated on public.purchases;
create trigger trg_clamp_updated before insert or update on public.purchases
  for each row execute procedure public.clamp_updated_at();
alter table public.purchases enable row level security;
drop policy if exists "shop_select" on public.purchases;
drop policy if exists "shop_insert" on public.purchases;
drop policy if exists "shop_update" on public.purchases;
drop policy if exists "shop_delete" on public.purchases;
create policy "shop_select" on public.purchases for select
  using (shop_id = public.my_shop_id() or public.is_platform_admin());
create policy "shop_insert" on public.purchases for insert
  with check (shop_id = public.my_shop_id() or public.is_platform_admin());
create policy "shop_update" on public.purchases for update
  using (shop_id = public.my_shop_id() or public.is_platform_admin())
  with check (shop_id = public.my_shop_id() or public.is_platform_admin());
create policy "shop_delete" on public.purchases for delete
  using (shop_id = public.my_shop_id() or public.is_platform_admin());
