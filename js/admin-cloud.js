/* Hisably Admin ↔ Supabase */
(function () {
  'use strict';
  const cfg = window.HISABLY_SUPABASE || {};
  let client = null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function ready() {
    return !!(cfg.enabled && cfg.url && cfg.anonKey && window.supabase);
  }

  function sb() {
    if (!ready()) return null;
    if (!client) client = window.supabase.createClient(cfg.url, cfg.anonKey);
    return client;
  }
  function need() {
    const c = sb();
    if (!c) throw new Error('Cloud not configured');
    return c;
  }

  async function signIn(email, password) {
    const c = need();
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Verify platform_admin
    const { data: prof, error: pe } = await c.from('profiles').select('role').eq('id', data.user.id).single();
    if (pe || !prof || prof.role !== 'platform_admin') {
      await c.auth.signOut();
      throw new Error('Not a platform admin account');
    }
    return data;
  }

  /** True when a valid Supabase session exists AND it belongs to a platform admin. */
  async function hasAdminSession() {
    const c = sb();
    if (!c) return false;
    const { data } = await c.auth.getSession();
    if (!data.session) return false;
    const { data: prof } = await c.from('profiles').select('role').eq('id', data.session.user.id).single();
    return !!(prof && prof.role === 'platform_admin');
  }

  async function signOut() {
    const c = sb();
    if (c) { try { await c.auth.signOut(); } catch (e) {} }
  }

  // ---------- Shops ----------
  async function fetchShops() {
    const c = need();
    const [shops, notes] = await Promise.all([
      c.from('shops').select('*').order('created_at', { ascending: false }),
      c.from('shop_notes').select('shop_id,notes')
    ]);
    if (shops.error) throw shops.error;
    if (notes.error) throw notes.error;
    const noteMap = {};
    (notes.data || []).forEach(n => { noteMap[n.shop_id] = n.notes; });
    return (shops.data || []).map(s => ({
      id: s.id,
      shopName: s.name,
      ownerName: s.owner_name,
      ownerPhone: s.owner_phone,
      ownerEmail: s.owner_email,
      city: s.city,
      planId: s.plan_id,
      status: s.status,
      notes: noteMap[s.id] || '',
      trialEndsAt: s.trial_ends_at,
      paidUntil: s.paid_until,
      createdAt: s.created_at
    }));
  }

  async function upsertShop(shop) {
    const c = need();
    const row = {
      name: shop.shopName,
      owner_name: shop.ownerName || null,
      owner_phone: shop.ownerPhone || null,
      owner_email: shop.ownerEmail || null,
      city: shop.city || null,
      plan_id: shop.planId || 'free',
      status: shop.status || 'trial',
      paid_until: shop.paidUntil || null,
      updated_at: new Date().toISOString()
    };
    if (shop.trialEndsAt) row.trial_ends_at = shop.trialEndsAt;
    let id = shop.id;
    if (id && UUID_RE.test(String(id))) {
      const { error } = await c.from('shops').update(row).eq('id', id);
      if (error) throw error;
    } else {
      row.trial_ends_at = row.trial_ends_at || new Date(Date.now() + 14 * 864e5).toISOString();
      const { data, error } = await c.from('shops').insert(row).select('id').single();
      if (error) throw error;
      id = data.id;
    }
    const { error: ne } = await c.from('shop_notes').upsert({
      shop_id: id, notes: shop.notes || null, updated_at: new Date().toISOString()
    });
    if (ne) throw ne;
    return id;
  }

  async function deleteShop(id) {
    const c = need();
    const { error } = await c.from('shops').delete().eq('id', id);
    if (error) throw error;
  }

  // ---------- Plans ----------
  async function fetchPlans() {
    const c = need();
    const { data, error } = await c.from('plans').select('*').order('price');
    if (error) throw error;
    return (data || []).map(p => ({
      id: p.id,
      name: p.name,
      price: Number(p.price) || 0,
      currency: p.currency || 'PKR',
      interval: p.interval || 'month',
      features: p.features || '',
      active: !!p.active
    }));
  }

  async function upsertPlan(plan) {
    const c = need();
    const { error } = await c.from('plans').upsert({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      currency: plan.currency || 'PKR',
      interval: plan.interval || 'month',
      features: plan.features || '',
      active: plan.active !== false
    });
    if (error) throw error;
  }

  async function deletePlan(id) {
    const c = need();
    const { error } = await c.from('plans').delete().eq('id', id);
    if (error) throw error;
  }

  // ---------- Payment requests ----------
  async function fetchPayments() {
    const c = need();
    const { data, error } = await c
      .from('payment_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id,
      shopId: r.shop_id,
      email: r.email,
      shopName: r.shop_name,
      plan: r.plan_id,
      note: r.note,
      status: r.status,
      createdAt: r.created_at
    }));
  }

  async function resolvePayment(id, status) {
    const c = need();
    const { error } = await c
      .from('payment_requests')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  // ---------- Platform settings (what sellers see: payment numbers, freemium switch) ----------
  async function fetchSettings() {
    const c = need();
    const { data, error } = await c.from('platform_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      freemiumEnabled: data.freemium_enabled !== false,
      jazzcash: data.jazzcash || '',
      easypaisa: data.easypaisa || '',
      bankName: data.bank_name || '',
      bankAccount: data.bank_account || '',
      bankTitle: data.bank_title || '',
      basicPrice: Number(data.basic_price) || 499,
      proPrice: Number(data.pro_price) || 999,
      currency: data.currency || 'PKR',
      paymentNote: data.payment_note || ''
    };
  }

  async function saveSettings(s) {
    const c = need();
    const { error } = await c.from('platform_settings').upsert({
      id: 1,
      freemium_enabled: s.freemiumEnabled !== false,
      jazzcash: s.jazzcash || null,
      easypaisa: s.easypaisa || null,
      bank_name: s.bankName || null,
      bank_account: s.bankAccount || null,
      bank_title: s.bankTitle || null,
      basic_price: s.basicPrice,
      pro_price: s.proPrice,
      currency: s.currency || 'PKR',
      payment_note: s.paymentNote || null,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
  }

  window.HisablyAdminCloud = {
    ready,
    signIn,
    hasAdminSession,
    signOut,
    fetchShops,
    upsertShop,
    deleteShop,
    fetchPlans,
    upsertPlan,
    deletePlan,
    fetchPayments,
    resolvePayment,
    fetchSettings,
    saveSettings
  };
})();
