/* Hisably Admin – Platform owner console */
(function () {
  'use strict';

  const KEYS = {
    password: 'hisably_admin_pw',
    session: 'hisably_admin_session',
    shops: 'hisably_admin_shops',
    plans: 'hisably_admin_plans',
    settings: 'hisably_admin_settings'
  };

  const DEFAULT_PLANS = [
    { id: 'free', name: 'Free', price: 0, currency: 'PKR', interval: 'month', shops: 1, features: 'Products, invoices, local data', active: true },
    { id: 'basic', name: 'Basic', price: 499, currency: 'PKR', interval: 'month', shops: 1, features: 'Everything in Free + backup reminders', active: true },
    { id: 'pro', name: 'Pro', price: 999, currency: 'PKR', interval: 'month', shops: 3, features: 'Multi-device ready, priority support', active: true }
  ];

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  let shops = load(KEYS.shops, []);
  let plans = load(KEYS.plans, DEFAULT_PLANS);
  let adminSettings = load(KEYS.settings, {
    platformName: 'Hisably',
    supportEmail: '',
    supportPhone: '',
    currency: 'PKR',
    freemiumEnabled: true,
    jazzcash: '03XX-XXXXXXX',
    easypaisa: '03XX-XXXXXXX',
    bankName: '',
    bankAccount: '',
    bankTitle: '',
    basicPrice: 499,
    proPrice: 999,
    paymentNote: 'Send payment then tap I paid in the app with your shop name.'
  });

  // Ensure default password exists (plain for local MVP – change in Settings)
  if (!localStorage.getItem(KEYS.password)) {
    localStorage.setItem(KEYS.password, 'hisably2026');
  }

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];

  function uid() {
    return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function money(n, cur) {
    return (cur || adminSettings.currency || 'PKR') + ' ' + (Number(n) || 0).toLocaleString('en-PK');
  }
  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => (el.hidden = true), 200);
    }, 2400);
  }
  const PAY_KEY = 'hisably_payment_requests_v1';
  let paymentRequests = [];          // cloud mode: loaded from Supabase; local mode: localStorage

  function cloudOn() {
    return !!(window.HisablyAdminCloud && window.HisablyAdminCloud.ready() && sessionStorage.getItem('hisably_cloud') === '1');
  }
  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  }
  // Paid plans are monthly: activating (or approving a payment) adds 30 days on top of any time left
  function extendPaidUntil(shop, days) {
    const base = Math.max(Date.now(), shop.paidUntil ? new Date(shop.paidUntil).getTime() : 0);
    shop.paidUntil = new Date(base + (days || 30) * 864e5).toISOString();
  }
  function isPaidActive(s) {
    return s.status === 'active' && (!s.paidUntil || new Date(s.paidUntil).getTime() > Date.now());
  }
  function shopState(s) {
    if (s.status === 'active' && s.paidUntil && new Date(s.paidUntil).getTime() <= Date.now()) return 'lapsed';
    if (s.status === 'trial' && s.trialEndsAt && new Date(s.trialEndsAt).getTime() <= Date.now()) return 'trial-ended';
    return s.status;
  }
  async function cloudSaveShop(shop) {
    if (!cloudOn()) return;
    shop.id = await window.HisablyAdminCloud.upsertShop(shop);
  }

  function persist() {
    save(KEYS.shops, shops);
    save(KEYS.plans, plans);
    save(KEYS.settings, adminSettings);
  }

  // Auth
  function isLoggedIn() {
    return sessionStorage.getItem(KEYS.session) === '1';
  }
  function login(pw) {
    const stored = localStorage.getItem(KEYS.password) || 'hisably2026';
    if (pw === stored) {
      sessionStorage.setItem(KEYS.session, '1');
      return true;
    }
    return false;
  }
  function logout() {
    sessionStorage.removeItem(KEYS.session);
    sessionStorage.removeItem('hisably_cloud');
    if (window.HisablyAdminCloud && window.HisablyAdminCloud.ready()) window.HisablyAdminCloud.signOut();
    showLogin();
  }

  function showLogin() {
    $('#loginScreen').hidden = false;
    $('#adminShell').hidden = true;
  }
  function showAdmin() {
    $('#loginScreen').hidden = true;
    $('#adminShell').hidden = false;
    navigate('dashboard');
  }

  // Metrics
  function metrics() {
    const now = Date.now();
    const active = shops.filter(isPaidActive).length;
    const trial = shops.filter(s => shopState(s) === 'trial').length;
    const expired = shops.filter(s => ['expired', 'paused', 'lapsed', 'trial-ended'].includes(shopState(s))).length;
    let mrr = 0;
    shops.forEach(s => {
      if (!isPaidActive(s)) return;
      const plan = plans.find(p => p.id === s.planId);
      if (plan && plan.price > 0) mrr += plan.price;
    });
    return { total: shops.length, active, trial, expired, mrr };
  }

  // Navigation
  let currentPage = 'dashboard';
  function navigate(page) {
    currentPage = page;
    $$('.nav-link[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const titles = {
      dashboard: 'Dashboard',
      shops: 'Shops',
      plans: 'Plans',
      subscriptions: 'Subscriptions',
      payments: 'Payment requests',
      settings: 'Settings'
    };
    $('#pageTitle').textContent = titles[page] || page;
    $('#sidebar').classList.remove('open');
    render();
    if (page === 'payments') refreshPayments();
  }

  function render() {
    const content = $('#content');
    const map = {
      dashboard: viewDashboard,
      shops: viewShops,
      plans: viewPlans,
      subscriptions: viewSubscriptions,
      payments: viewPayments,
      settings: viewSettings
    };
    content.innerHTML = (map[currentPage] || viewDashboard)();
    bindPage();
  }

  function viewDashboard() {
    const m = metrics();
    return `
      <div class="note">
        <strong>Your side of Hisably.</strong> Manage every shop that uses your app, their plan, and status.
        ${cloudOn() ? 'Connected to Supabase – you are seeing every real shop.' : 'LOCAL MODE: data is stored only in this browser. Sign in with your admin email to manage real shops.'}
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-label">Total shops</div><div class="stat-value primary">${m.total}</div></div>
        <div class="stat"><div class="stat-label">Active</div><div class="stat-value success">${m.active}</div></div>
        <div class="stat"><div class="stat-label">On trial</div><div class="stat-value warning">${m.trial}</div></div>
        <div class="stat"><div class="stat-label">MRR</div><div class="stat-value">${money(m.mrr)}</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Recent shops</h3>
          <button class="btn btn-primary btn-sm" data-action="add-shop">Add shop</button>
        </div>
        ${shopsTable(shops.slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8))}
      </div>
    `;
  }

  function shopsTable(list) {
    if (!list.length) {
      return `<div class="empty">No shops yet. Add your first seller shop to start tracking subscriptions.</div>`;
    }
    return `<div class="table-wrap"><table>
      <thead><tr>
        <th>Shop</th><th>Owner</th><th>Plan</th><th>Status</th><th>Paid until</th><th>Joined</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(s => {
          const plan = plans.find(p => p.id === s.planId);
          return `<tr>
            <td><strong>${esc(s.shopName)}</strong></td>
            <td>${esc(s.ownerName || '—')}<br><span style="color:var(--muted);font-size:0.8rem">${esc(s.ownerPhone || '')}</span></td>
            <td>${esc(plan ? plan.name : s.planId)}</td>
            <td><span class="badge badge-${shopState(s) === 'active' ? 'active' : shopState(s) === 'trial' ? 'trial' : shopState(s) === 'paused' ? 'paused' : 'expired'}">${esc(shopState(s))}</span></td>
            <td>${s.paidUntil ? formatDate(s.paidUntil) : (s.status === 'trial' && s.trialEndsAt ? 'trial → ' + formatDate(s.trialEndsAt) : '—')}</td>
            <td>${formatDate(s.createdAt)}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-secondary btn-sm" data-action="edit-shop" data-id="${esc(s.id)}">Edit</button>
              ${!isPaidActive(s) ? `<button class="btn btn-primary btn-sm" data-action="activate-shop" data-id="${esc(s.id)}">Activate +30d</button>` : `<button class="btn btn-danger btn-sm" data-action="deactivate-shop" data-id="${esc(s.id)}">Pause</button>`}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
  }

  function viewShops() {
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">All shops (${shops.length})</h3>
          <button class="btn btn-primary btn-sm" data-action="add-shop">Add shop</button>
        </div>
        <div class="form-group" style="max-width:280px">
          <input type="search" class="input" id="shopSearch" placeholder="Search shops..." />
        </div>
        <div id="shopsTableWrap">${shopsTable(shops)}</div>
      </div>
    `;
  }

  function viewPlans() {
    return `
      <div class="note">Set monthly prices in PKR / INR / BDT. Active shops on paid plans count toward MRR.</div>
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Plans</h3>
          <button class="btn btn-primary btn-sm" data-action="add-plan">Add plan</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Price</th><th>Features</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${plans.map(p => `
              <tr>
                <td><strong>${esc(p.name)}</strong></td>
                <td>${p.price === 0 ? 'Free' : money(p.price, p.currency) + '/' + (p.interval || 'month')}</td>
                <td style="max-width:220px;color:var(--muted);font-size:0.85rem">${esc(p.features || '')}</td>
                <td><span class="badge ${p.active ? 'badge-active' : 'badge-paused'}">${p.active ? 'Active' : 'Off'}</span></td>
                <td><button class="btn btn-secondary btn-sm" data-action="edit-plan" data-id="${p.id}">Edit</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  }

  function viewSubscriptions() {
    const paid = shops.filter(s => {
      const p = plans.find(x => x.id === s.planId);
      return p && p.price > 0;
    });
    return `
      <div class="stats">
        <div class="stat"><div class="stat-label">Paid subscriptions</div><div class="stat-value primary">${paid.filter(isPaidActive).length}</div></div>
        <div class="stat"><div class="stat-label">Trials</div><div class="stat-value warning">${shops.filter(s => shopState(s) === 'trial').length}</div></div>
        <div class="stat"><div class="stat-label">Expired / paused</div><div class="stat-value danger">${metrics().expired}</div></div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">Subscription list</h3></div>
        ${shopsTable(shops.filter(s => s.status === 'active' || paid.includes(s)))}
      </div>
    `;
  }

  function loadLocalPayments() {
    try { return JSON.parse(localStorage.getItem(PAY_KEY) || '[]'); } catch (e) { return []; }
  }

  function viewPayments() {
    const reqs = paymentRequests;
    const pending = reqs.filter(r => (r.status || 'pending') === 'pending');
    const done = reqs.filter(r => (r.status || 'pending') !== 'pending').slice(0, 20);
    const row = (r, actions) => `
      <tr>
        <td><strong>${esc(r.shopName || '—')}</strong><br><span style="color:var(--muted);font-size:0.8rem">${esc(r.email || '')}</span></td>
        <td>${esc(r.plan)}</td>
        <td>${esc(r.note || '—')}</td>
        <td>${formatDate(r.createdAt)}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
    return `
      <div class="note">Sellers tap <strong>I paid</strong> in the app. Check the money arrived in your JazzCash/EasyPaisa/bank, then <strong>Approve</strong> – their shop becomes Active on that plan for 30 days.</div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">Pending (${pending.length})</h3>
          <button class="btn btn-secondary btn-sm" data-action="refresh-payments">Refresh</button></div>
        ${!pending.length ? '<div class="empty">No pending payment requests</div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Shop / Email</th><th>Plan</th><th>Txn note</th><th>When</th><th></th></tr></thead>
          <tbody>${pending.map(r => row(r, `
            <button class="btn btn-primary btn-sm" data-action="approve-payment" data-id="${esc(r.id)}">Approve</button>
            <button class="btn btn-danger btn-sm" data-action="reject-payment" data-id="${esc(r.id)}">Reject</button>`)).join('')}</tbody>
        </table></div>`}
      </div>
      ${done.length ? `<div class="card"><div class="card-header"><h3 class="card-title">Recently handled</h3></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Shop / Email</th><th>Plan</th><th>Txn note</th><th>When</th><th>Result</th></tr></thead>
          <tbody>${done.map(r => row(r, `<span class="badge ${r.status === 'approved' ? 'badge-active' : 'badge-expired'}">${esc(r.status)}</span>`)).join('')}</tbody>
        </table></div></div>` : ''}`;
  }

  function viewSettings() {
    return `
      <div class="card">
        <h3 class="card-title" style="margin-bottom:16px">Platform settings</h3>
        <form id="adminSettingsForm">
          <div class="form-group">
            <label>Platform name</label>
            <input class="input" name="platformName" value="${esc(adminSettings.platformName)}" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Support email</label>
              <input class="input" name="supportEmail" type="email" value="${esc(adminSettings.supportEmail || '')}" />
            </div>
            <div class="form-group">
              <label>Support phone</label>
              <input class="input" name="supportPhone" value="${esc(adminSettings.supportPhone || '')}" />
            </div>
          </div>
          <div class="form-group">
            <label>Default currency</label>
            <select class="select" name="currency">
              <option value="PKR" ${adminSettings.currency === 'PKR' ? 'selected' : ''}>PKR</option>
              <option value="INR" ${adminSettings.currency === 'INR' ? 'selected' : ''}>INR</option>
              <option value="BDT" ${adminSettings.currency === 'BDT' ? 'selected' : ''}>BDT</option>
              <option value="USD" ${adminSettings.currency === 'USD' ? 'selected' : ''}>USD</option>
            </select>
          </div>
          <div class="form-group">
            <label>Freemium limits (Free plan caps)</label>
            <select class="select" name="freemiumEnabled">
              <option value="1" ${adminSettings.freemiumEnabled !== false ? 'selected' : ''}>ON – Free users limited</option>
              <option value="0" ${adminSettings.freemiumEnabled === false ? 'selected' : ''}>OFF – Everyone full access</option>
            </select>
          </div>
          <h3 class="card-title" style="margin:16px 0 12px">Your payment details (shown to sellers)</h3>
          <div class="form-row">
            <div class="form-group"><label>JazzCash</label><input class="input" name="jazzcash" value="${esc(adminSettings.jazzcash || '')}" /></div>
            <div class="form-group"><label>EasyPaisa</label><input class="input" name="easypaisa" value="${esc(adminSettings.easypaisa || '')}" /></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Basic price</label><input class="input" name="basicPrice" type="number" value="${adminSettings.basicPrice || 499}" /></div>
            <div class="form-group"><label>Pro price</label><input class="input" name="proPrice" type="number" value="${adminSettings.proPrice || 999}" /></div>
          </div>
          <div class="form-group"><label>Bank name / account / title</label>
            <input class="input" name="bankName" placeholder="Bank" value="${esc(adminSettings.bankName || '')}" style="margin-bottom:8px" />
            <input class="input" name="bankAccount" placeholder="Account number" value="${esc(adminSettings.bankAccount || '')}" style="margin-bottom:8px" />
            <input class="input" name="bankTitle" placeholder="Account title" value="${esc(adminSettings.bankTitle || '')}" />
          </div>
          <div class="form-group"><label>Payment note</label><textarea class="textarea" name="paymentNote">${esc(adminSettings.paymentNote || '')}</textarea></div>
          <button type="submit" class="btn btn-primary">Save settings</button>
        </form>
      </div>
      ${cloudOn() ? '' : `<div class="card">
        <h3 class="card-title" style="margin-bottom:12px">Change admin password (local mode)</h3>
        <form id="passwordForm">
          <div class="form-group">
            <label>Current password</label>
            <input class="input" type="password" name="current" required />
          </div>
          <div class="form-group">
            <label>New password</label>
            <input class="input" type="password" name="next" required minlength="6" />
          </div>
          <button type="submit" class="btn btn-secondary">Update password</button>
        </form>
      </div>
      <div class="card">
        <h3 class="card-title" style="margin-bottom:12px">Export / Import admin data</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-secondary" data-action="export-admin">Export shops & plans</button>
          <button class="btn btn-secondary" data-action="import-admin">Import backup</button>
        </div>
      </div>`}
      <div class="note" style="margin-top:8px">
        ${cloudOn()
          ? '<strong>Cloud mode:</strong> shops, plans, payment requests and these payment details are stored in Supabase, so every seller device sees them. Your password is your Supabase admin password.'
          : '<strong>Local mode:</strong> nothing here reaches sellers on other phones. Set up Supabase (see supabase/SETUP.md) and sign in with your admin email.'}
      </div>
    `;
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Modals
  function openShopModal(shop) {
    const isEdit = !!shop;
    const planOpts = plans.filter(p => p.active || (shop && shop.planId === p.id))
      .map(p => `<option value="${p.id}" ${shop && shop.planId === p.id ? 'selected' : ''}>${esc(p.name)} (${p.price === 0 ? 'Free' : money(p.price)})</option>`)
      .join('');
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="shopModal">
        <div class="modal">
          <div class="modal-header">
            <h3>${isEdit ? 'Edit shop' : 'Add shop'}</h3>
            <button class="modal-close" data-action="close-modal">✕</button>
          </div>
          <form id="shopForm">
            <div class="form-group">
              <label>Shop / business name *</label>
              <input class="input" name="shopName" required value="${esc(shop?.shopName || '')}" placeholder="e.g. Ali Bakery" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Owner name</label>
                <input class="input" name="ownerName" value="${esc(shop?.ownerName || '')}" />
              </div>
              <div class="form-group">
                <label>Owner phone</label>
                <input class="input" name="ownerPhone" value="${esc(shop?.ownerPhone || '')}" placeholder="03XX..." />
              </div>
            </div>
            <div class="form-group">
              <label>Owner email</label>
              <input class="input" name="ownerEmail" type="email" value="${esc(shop?.ownerEmail || '')}" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Plan</label>
                <select class="select" name="planId">${planOpts}</select>
              </div>
              <div class="form-group">
                <label>Status</label>
                <select class="select" name="status">
                  <option value="trial" ${shop?.status === 'trial' ? 'selected' : ''}>Trial</option>
                  <option value="active" ${!shop || shop?.status === 'active' ? 'selected' : ''}>Active</option>
                  <option value="paused" ${shop?.status === 'paused' ? 'selected' : ''}>Paused</option>
                  <option value="expired" ${shop?.status === 'expired' ? 'selected' : ''}>Expired</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>City</label>
                <input class="input" name="city" value="${esc(shop?.city || '')}" />
              </div>
              <div class="form-group">
                <label>Paid until (paid plans)</label>
                <input class="input" name="paidUntil" type="date" value="${shop?.paidUntil ? esc(String(shop.paidUntil).slice(0, 10)) : ''}" />
              </div>
            </div>
            <div class="form-group">
              <label>Notes (private)</label>
              <textarea class="textarea" name="notes">${esc(shop?.notes || '')}</textarea>
            </div>
            <div style="display:flex;gap:10px;margin-top:8px">
              ${isEdit ? `<button type="button" class="btn btn-danger" data-action="delete-shop" data-id="${shop.id}">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary" style="flex:1">${isEdit ? 'Save' : 'Add shop'}</button>
            </div>
          </form>
        </div>
      </div>`;

    $('#shopForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        shopName: fd.get('shopName').trim(),
        ownerName: fd.get('ownerName').trim(),
        ownerPhone: fd.get('ownerPhone').trim(),
        ownerEmail: fd.get('ownerEmail').trim(),
        planId: fd.get('planId'),
        status: fd.get('status'),
        city: fd.get('city').trim(),
        notes: fd.get('notes').trim(),
        paidUntil: fd.get('paidUntil') ? new Date(fd.get('paidUntil') + 'T23:59:59').toISOString() : null
      };
      if (!data.shopName) return;
      // Active paid plan without an end date would never expire -> default to 30 days
      if (data.status === 'active' && data.planId !== 'free' && !data.paidUntil) {
        const tmp = {}; extendPaidUntil(tmp, 30); data.paidUntil = tmp.paidUntil;
      }
      const target = isEdit ? { ...shop, ...data } : { id: uid(), ...data, createdAt: new Date().toISOString() };
      try {
        await cloudSaveShop(target);          // cloud first: if it fails nothing changes locally
      } catch (err) {
        toast('Cloud save failed: ' + (err.message || ''));
        return;
      }
      if (isEdit) {
        const i = shops.findIndex(x => x.id === shop.id);
        if (i > -1) shops[i] = target;
        toast('Shop updated');
      } else {
        shops.unshift(target);
        toast('Shop added');
      }
      persist();
      closeModal();
      render();
    };
  }

  function openPlanModal(plan) {
    const isEdit = !!plan;
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header">
            <h3>${isEdit ? 'Edit plan' : 'Add plan'}</h3>
            <button class="modal-close" data-action="close-modal">✕</button>
          </div>
          <form id="planForm">
            <div class="form-group">
              <label>Plan name *</label>
              <input class="input" name="name" required value="${esc(plan?.name || '')}" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Price</label>
                <input class="input" name="price" type="number" min="0" value="${plan ? plan.price : 0}" />
              </div>
              <div class="form-group">
                <label>Currency</label>
                <select class="select" name="currency">
                  <option value="PKR" ${(plan?.currency || 'PKR') === 'PKR' ? 'selected' : ''}>PKR</option>
                  <option value="INR" ${plan?.currency === 'INR' ? 'selected' : ''}>INR</option>
                  <option value="BDT" ${plan?.currency === 'BDT' ? 'selected' : ''}>BDT</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>Features (short text)</label>
              <input class="input" name="features" value="${esc(plan?.features || '')}" />
            </div>
            <div class="form-group">
              <label>Active</label>
              <select class="select" name="active">
                <option value="1" ${!plan || plan.active ? 'selected' : ''}>Yes</option>
                <option value="0" ${plan && !plan.active ? 'selected' : ''}>No</option>
              </select>
            </div>
            <div style="display:flex;gap:10px">
              ${isEdit && !['free','basic','pro'].includes(plan.id) ? `<button type="button" class="btn btn-danger" data-action="delete-plan" data-id="${plan.id}">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary" style="flex:1">Save</button>
            </div>
          </form>
        </div>
      </div>`;

    $('#planForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        name: fd.get('name').trim(),
        price: parseFloat(fd.get('price')) || 0,
        currency: fd.get('currency'),
        interval: 'month',
        features: fd.get('features').trim(),
        active: fd.get('active') === '1'
      };
      const saved = isEdit ? { ...plan, ...data } : { id: uid(), ...data };
      if (cloudOn()) {
        try { await window.HisablyAdminCloud.upsertPlan(saved); }
        catch (err) { toast('Cloud save failed: ' + (err.message || '')); return; }
      }
      if (isEdit) {
        const i = plans.findIndex(x => x.id === plan.id);
        if (i > -1) plans[i] = saved;
        toast('Plan updated');
      } else {
        plans.push(saved);
        toast('Plan added');
      }
      persist();
      closeModal();
      render();
    };
  }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
  }

  function bindPage() {
    const search = $('#shopSearch');
    if (search) {
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        const filtered = shops.filter(s =>
          (s.shopName || '').toLowerCase().includes(q) ||
          (s.ownerName || '').toLowerCase().includes(q) ||
          (s.ownerPhone || '').includes(q)
        );
        $('#shopsTableWrap').innerHTML = shopsTable(filtered);
      };
    }
    const sf = $('#adminSettingsForm');
    if (sf) {
      sf.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(sf);
        adminSettings.platformName = fd.get('platformName').trim() || 'Hisably';
        adminSettings.supportEmail = fd.get('supportEmail').trim();
        adminSettings.supportPhone = fd.get('supportPhone').trim();
        adminSettings.currency = fd.get('currency');
        adminSettings.freemiumEnabled = fd.get('freemiumEnabled') === '1';
        adminSettings.jazzcash = (fd.get('jazzcash') || '').trim();
        adminSettings.easypaisa = (fd.get('easypaisa') || '').trim();
        adminSettings.bankName = (fd.get('bankName') || '').trim();
        adminSettings.bankAccount = (fd.get('bankAccount') || '').trim();
        adminSettings.bankTitle = (fd.get('bankTitle') || '').trim();
        adminSettings.basicPrice = parseFloat(fd.get('basicPrice')) || 499;
        adminSettings.proPrice = parseFloat(fd.get('proPrice')) || 999;
        adminSettings.paymentNote = (fd.get('paymentNote') || '').trim();
        // Publish payment details for seller app (same browser / shared origin)
        localStorage.setItem('hisably_platform_pay_v1', JSON.stringify({
          jazzcash: adminSettings.jazzcash,
          easypaisa: adminSettings.easypaisa,
          bankName: adminSettings.bankName,
          bankAccount: adminSettings.bankAccount,
          bankTitle: adminSettings.bankTitle,
          note: adminSettings.paymentNote,
          basicPrice: adminSettings.basicPrice,
          proPrice: adminSettings.proPrice,
          currency: adminSettings.currency,
          freemiumEnabled: adminSettings.freemiumEnabled
        }));
        if (cloudOn()) {
          try { await window.HisablyAdminCloud.saveSettings(adminSettings); }
          catch (err) { toast('Cloud save failed: ' + (err.message || '')); return; }
        }
        persist();
        toast(cloudOn() ? 'Settings saved – sellers will see them' : 'Settings saved (local mode)');
      };
    }
    const pf = $('#passwordForm');
    if (pf) {
      pf.onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(pf);
        const cur = fd.get('current');
        const next = fd.get('next');
        if (cur !== localStorage.getItem(KEYS.password)) {
          toast('Current password wrong');
          return;
        }
        if ((next || '').length < 6) {
          toast('New password too short');
          return;
        }
        localStorage.setItem(KEYS.password, next);
        toast('Password updated');
        pf.reset();
      };
    }
  }

  async function saveShopChange(oldShop, newShop, okMsg) {
    try {
      await cloudSaveShop(newShop);
    } catch (err) {
      toast('Cloud save failed: ' + (err.message || ''));
      return false;
    }
    const i = shops.findIndex(x => x.id === oldShop.id);
    if (i > -1) shops[i] = newShop;
    persist();
    if (oldShop.ownerEmail && window.HisablyFreemium && !cloudOn()) {
      try { HisablyFreemium.localSetUserPlan(oldShop.ownerEmail, { planId: newShop.planId, status: newShop.status }); } catch (e) {}
    }
    toast(okMsg);
    render();
    return true;
  }

  async function refreshPayments() {
    try {
      paymentRequests = cloudOn() ? await window.HisablyAdminCloud.fetchPayments() : loadLocalPayments();
    } catch (err) {
      toast('Could not load payments: ' + (err.message || ''));
      paymentRequests = [];
    }
    if (currentPage === 'payments') render();
  }

  async function approvePayment(rid) {
    const r = paymentRequests.find(x => x.id === rid);
    if (!r) return;
    let shop = shops.find(x => (r.shopId && x.id === r.shopId) || (x.ownerEmail || '').toLowerCase() === (r.email || '').toLowerCase());
    if (!shop && !cloudOn()) {
      // local testing mode only: create the shop record on the fly
      shop = { id: uid(), shopName: r.shopName || r.email || 'Shop', ownerEmail: r.email, planId: r.plan || 'basic', status: 'trial', createdAt: new Date().toISOString() };
      shops.unshift(shop);
    }
    if (!shop) {
      toast('No shop found for this seller. Refresh and try again.');
      return;
    }
    const upd = { ...shop, status: 'active', planId: r.plan || 'basic' };
    extendPaidUntil(upd, 30);
    const ok = await saveShopChange(shop, upd, 'Payment approved · shop active for 30 days');
    if (!ok) return;
    try {
      if (cloudOn()) await window.HisablyAdminCloud.resolvePayment(rid, 'approved');
      else localStorage.setItem(PAY_KEY, JSON.stringify(loadLocalPayments().filter(x => x.id !== rid)));
    } catch (err) {
      toast('Shop activated, but could not close the request: ' + (err.message || ''));
    }
    refreshPayments();
  }

  async function rejectPayment(rid) {
    if (!confirm('Reject this payment request?')) return;
    try {
      if (cloudOn()) await window.HisablyAdminCloud.resolvePayment(rid, 'rejected');
      else localStorage.setItem(PAY_KEY, JSON.stringify(loadLocalPayments().filter(x => x.id !== rid)));
    } catch (err) {
      toast('Failed: ' + (err.message || ''));
      return;
    }
    toast('Request rejected');
    refreshPayments();
  }

  // Global clicks
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action], [data-page], .modal-overlay');
    if (!t) return;

    if (t.classList.contains('modal-overlay') && e.target === t) {
      closeModal();
      return;
    }

    if (t.dataset.page) {
      navigate(t.dataset.page);
      return;
    }

    const action = t.dataset.action;
    const id = t.dataset.id;
    switch (action) {
      case 'activate-shop': {
        const s = shops.find(x => x.id === id);
        if (s) {
          const upd = { ...s, status: 'active' };
          if (!upd.planId || upd.planId === 'free' || upd.planId === 'trial') upd.planId = 'basic';
          extendPaidUntil(upd, 30);
          saveShopChange(s, upd, 'Shop activated for 30 days');
        }
        break;
      }
      case 'deactivate-shop': {
        const s = shops.find(x => x.id === id);
        if (s && confirm('Pause this shop? They will not be able to add new data until you activate it again.')) {
          saveShopChange(s, { ...s, status: 'paused' }, 'Shop paused');
        }
        break;
      }
      case 'approve-payment': approvePayment(id); break;
      case 'reject-payment': rejectPayment(id); break;
      case 'refresh-payments': refreshPayments(); break;
      case 'add-shop': openShopModal(); break;
      case 'edit-shop': {
        const s = shops.find(x => x.id === id);
        if (s) openShopModal(s);
        break;
      }
      case 'delete-shop':
        if (confirm('Delete this shop AND all of its products, invoices and customers? This cannot be undone.')) {
          (async () => {
            try { if (cloudOn() && isUuid(id)) await window.HisablyAdminCloud.deleteShop(id); }
            catch (err) { toast('Cloud delete failed: ' + (err.message || '')); return; }
            shops = shops.filter(x => x.id !== id);
            persist();
            closeModal();
            toast('Shop deleted');
            render();
          })();
        }
        break;
      case 'add-plan': openPlanModal(); break;
      case 'edit-plan': {
        const p = plans.find(x => x.id === id);
        if (p) openPlanModal(p);
        break;
      }
      case 'delete-plan':
        if (confirm('Delete this plan?')) {
          (async () => {
            try { if (cloudOn()) await window.HisablyAdminCloud.deletePlan(id); }
            catch (err) { toast('Cloud delete failed: ' + (err.message || '')); return; }
            plans = plans.filter(x => x.id !== id);
            persist();
            closeModal();
            toast('Plan deleted');
            render();
          })();
        }
        break;
      case 'close-modal': closeModal(); break;
      case 'export-admin': {
        const data = { shops, plans, adminSettings, exportedAt: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `hisably-admin-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        toast('Exported');
        break;
      }
      case 'import-admin': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const data = JSON.parse(reader.result);
              if (confirm('Replace admin data with this backup?')) {
                if (Array.isArray(data.shops)) shops = data.shops;
                if (Array.isArray(data.plans)) plans = data.plans;
                if (data.adminSettings) adminSettings = { ...adminSettings, ...data.adminSettings };
                persist();
                toast('Imported');
                render();
              }
            } catch {
              toast('Invalid file');
            }
          };
          reader.readAsText(file);
        };
        input.click();
        break;
      }
    }
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailEl = $('#adminEmail');
    const pw = $('#adminPassword').value;
    const cloud = window.HisablyAdminCloud;
    const cloudReady = !!(cloud && cloud.ready());
    const email = emailEl ? emailEl.value.trim() : '';

    if (cloudReady) {
      // With Supabase configured the shared local password is NOT accepted
      if (!email) { toast('Enter your admin email'); return; }
      try {
        toast('Signing in…');
        await cloud.signIn(email, pw);
        sessionStorage.setItem(KEYS.session, '1');
        sessionStorage.setItem('hisably_cloud', '1');
        await loadFromCloud();
        showAdmin();
        toast('Signed in (cloud)');
      } catch (err) {
        toast(err.message || 'Cloud login failed');
      }
      return;
    }

    if (login(pw)) {
      sessionStorage.removeItem('hisably_cloud');
      showAdmin();
    } else {
      toast('Wrong password');
    }
  });

  async function loadFromCloud() {
    const cloud = window.HisablyAdminCloud;
    if (!cloud || !cloud.ready()) return;
    try {
      const [remoteShops, remotePlans, remoteSettings] = await Promise.all([
        cloud.fetchShops(),
        cloud.fetchPlans(),
        cloud.fetchSettings()
      ]);
      shops = remoteShops || [];
      if (remotePlans && remotePlans.length) plans = remotePlans;
      if (remoteSettings) adminSettings = Object.assign({}, adminSettings, remoteSettings);
      persist();
      const pill = $('#envPill');
      if (pill) pill.textContent = 'Cloud mode';
    } catch (err) {
      console.error(err);
      toast('Could not load cloud data: ' + (err.message || ''));
    }
  }
  $('#logoutBtn').addEventListener('click', logout);
  $('#menuToggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  // Init
  (async function init() {
    const cloud = window.HisablyAdminCloud;
    const cloudReady = !!(cloud && cloud.ready());
    const hint = $('#loginHint');
    if (cloudReady && hint) hint.innerHTML = 'Sign in with your <strong>platform_admin</strong> email and password.';
    if (!cloudReady && hint) hint.innerHTML = 'Local mode (Supabase not configured). Default password: <strong>hisably2026</strong> – change it in Settings.';
    if (isLoggedIn() && cloudReady) {
      // A page reload must not skip authentication: re-verify the real Supabase session
      let ok = false;
      try { ok = sessionStorage.getItem('hisably_cloud') === '1' && await cloud.hasAdminSession(); } catch (e) {}
      if (ok) { await loadFromCloud(); showAdmin(); }
      else { sessionStorage.removeItem(KEYS.session); sessionStorage.removeItem('hisably_cloud'); showLogin(); }
      return;
    }
    if (isLoggedIn()) showAdmin();
    else showLogin();
  })();
})();
