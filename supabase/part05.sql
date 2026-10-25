create policy "shops_admin_write" on public.shops for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "shop_notes_admin" on public.shop_notes for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "plans_read" on public.plans for select to authenticated using (true);
create policy "plans_admin" on public.plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "settings_read" on public.platform_settings for select to authenticated using (true);
create policy "settings_admin" on public.platform_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
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
create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now(); $$;
grant execute on function public.server_now() to authenticated;
grant execute on function public.save_shop_settings(jsonb) to authenticated;
