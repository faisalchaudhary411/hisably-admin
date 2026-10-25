alter table public.payment_requests add column if not exists resolved_at timestamptz;
create unique index if not exists uq_payment_pending_per_shop
  on public.payment_requests(shop_id) where status = 'pending';
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
  lifetime_price numeric default 14999,
  currency text default 'PKR',
  payment_note text,
  updated_at timestamptz default now()
);
alter table public.platform_settings add column if not exists lifetime_price numeric default 14999;
insert into public.platform_settings (id) values (1) on conflict do nothing;
create or replace function public.my_shop_id()
returns uuid language sql stable security definer set search_path = public as $$
  select shop_id from public.profiles where id = auth.uid();
$$;
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'platform_admin');
$$;
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_n text := left(nullif(trim(meta->>'full_name'), ''), 120);
  shop_n text := left(nullif(trim(meta->>'shop_name'), ''), 120);
  phone_n text := left(nullif(trim(meta->>'phone'), ''), 40);
  sid uuid;
begin
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
create or replace function public.save_shop_settings(s jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_shop_id() is null then raise exception 'No shop'; end if;
  update public.shops set settings = coalesce(s, '{}'::jsonb), updated_at = now()
  where id = public.my_shop_id();
end;
$$;
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
