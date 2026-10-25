create or replace function public.enforce_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  plan text; lim int; cnt int; already boolean; enabled boolean;
begin
  if public.is_platform_admin() then return new; end if;
  plan := public.shop_effective_plan(new.shop_id);
  if plan is null then return new; end if;
  execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
    into already using new.id;
  if already then return new; end if;
  if plan = 'blocked' then
    raise exception 'LIMIT: account inactive' using errcode = 'P0001';
  end if;
  select coalesce(freemium_enabled, true) into enabled from public.platform_settings where id = 1;
  if plan not in ('free','basic') or enabled is false then return new; end if;
  if plan = 'basic' then
    lim := case tg_table_name
      when 'products' then 300 when 'invoices' then 1500 when 'customers' then 200
      when 'expenses' then 1000 when 'suppliers' then 50 else null end;
  else
    lim := case tg_table_name
      when 'products' then 25 when 'invoices' then 40 when 'customers' then 20
      when 'expenses' then 30 when 'suppliers' then 10 else null end;
  end if;
  if lim is null then return new; end if;
  execute format('select count(*) from public.%I where shop_id = $1 and deleted_at is null', tg_table_name)
    into cnt using new.shop_id;
  if cnt >= lim then
    raise exception 'LIMIT: % plan allows % % - upgrade your plan', plan, lim, tg_table_name
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
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
do $$
declare t text; pol record;
begin
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
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or public.is_platform_admin());
create policy "profiles_update_own" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_admin_all" on public.profiles for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "shops_select" on public.shops for select
  using (id = public.my_shop_id() or public.is_platform_admin());
