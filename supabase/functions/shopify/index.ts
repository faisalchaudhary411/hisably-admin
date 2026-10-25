// Hisably <-> Shopify two-way sync (Supabase Edge Function, name: "shopify").
// Paste this whole file into Supabase -> Edge Functions -> shopify, then Deploy.
// IMPORTANT: turn OFF "Verify JWT" for this function (Shopify webhooks cannot send a Supabase JWT;
// the function verifies users and Shopify signatures itself).
//
// What it does
//   - Seller app  -> action calls (connect / sync / status / disconnect)  [Authorization: Bearer <user jwt>]
//   - Shopify     -> webhooks (products, inventory, orders, customers)    [X-Shopify-Hmac-Sha256]
//   Prices + stock + products + customers flow from Shopify into Hisably, Shopify orders become
//   invoices, and price / stock changes made in Hisably are pushed back to Shopify.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const API_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-07';
const CALLBACK = () => `${SUPABASE_URL}/functions/v1/shopify`;
const TOPICS = [
  'products/create', 'products/update', 'products/delete', 'inventory_levels/update',
  'orders/create', 'orders/updated', 'customers/create', 'customers/update'
];
const PUSH_BATCH = 40;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => (v == null ? '' : String(v));
const digits = (v) => str(v).replace(/\D/g, '');

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ database (PostgREST, service role)
async function db(method, path, body, prefer) {
  const headers = {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function dbAll(path) {            // pages through >1000 rows
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + 999}`, 'Range-Unit': 'items'
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`db GET ${path.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
    const rows = text ? JSON.parse(text) : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const q = (v) => encodeURIComponent(str(v));

async function planAllowsShopify(shopId) {
  const plan = await db('POST', 'rpc/shop_effective_plan', { sid: shopId });
  let enabled = true;
  try {
    const ps = await db('GET', 'platform_settings?id=eq.1&select=freemium_enabled');
    if (ps && ps[0] && ps[0].freemium_enabled === false) enabled = false;
  } catch (_e) { /* default: freemium on */ }
  if (plan === 'blocked') return false;
  return !enabled || ['trial', 'pro', 'lifetime'].includes(plan);
}

async function getConn(shopId) {
  const r = await db('GET', `shopify_connections?shop_id=eq.${q(shopId)}&select=*`);
  return (r && r[0]) || null;
}
async function getConnByDomain(domain) {
  const r = await db('GET', `shopify_connections?domain=eq.${q(domain)}&select=*`);
  return (r && r[0]) || null;
}
async function patchConn(conn, patch) {
  Object.assign(conn, patch);
  await db('PATCH', `shopify_connections?shop_id=eq.${q(conn.shop_id)}`, { ...patch, updated_at: nowIso() });
}

// ------------------------------------------------------------------ Shopify API
function normalizeDomain(input) {
  let d = str(input).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
  if (d.startsWith('admin.shopify.com')) throw new HttpError(400, 'Use your store address like mystore.myshopify.com');
  if (d && !d.includes('.')) d += '.myshopify.com';
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) {
    throw new HttpError(400, 'Store address must look like mystore.myshopify.com');
  }
  return d;
}

async function getToken(conn) {
  if (conn.access_token) return conn.access_token;
  if (conn.token_cache && conn.token_expires_at && new Date(conn.token_expires_at).getTime() > Date.now() + 120000) {
    return conn.token_cache;
  }
  if (!conn.client_id || !conn.client_secret) throw new HttpError(400, 'No Shopify credentials saved');
  const res = await fetch(`https://${conn.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: conn.client_id, client_secret: conn.client_secret, grant_type: 'client_credentials' })
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(400, `Shopify rejected the Client ID / Secret (${res.status}). Check them and that the app is installed on this store.`);
  const j = JSON.parse(text);
  if (!j.access_token) throw new HttpError(400, 'Shopify did not return an access token');
  const exp = new Date(Date.now() + (num(j.expires_in) || 86000) * 1000).toISOString();
  await patchConn(conn, { token_cache: j.access_token, token_expires_at: exp });
  return j.access_token;
}

// returns { json, next }  (next = Link rel="next" path or null)
async function shopify(conn, method, path, body) {
  const token = await getToken(conn);
  const url = path.startsWith('http') ? path : `https://${conn.domain}/admin/api/${API_VERSION}/${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep((num(res.headers.get('Retry-After')) || 1.5) * 1000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const code = res.status;
      let hint = '';
      if (code === 401) hint = ' (token invalid or expired)';
      if (code === 403) hint = ' (missing API permission - add the scopes listed in the setup guide)';
      if (code === 404) hint = ' (not found)';
      throw new HttpError(code === 401 || code === 403 ? 400 : 502, `Shopify ${method} ${path.split('?')[0]} failed: ${code}${hint} ${text.slice(0, 160)}`);
    }
    let next = null;
    const link = res.headers.get('Link') || res.headers.get('link');
    if (link) {
      const m = link.split(',').map((s) => s.trim()).find((s) => /rel="?next"?/.test(s));
      if (m) { const u = m.match(/<([^>]+)>/); if (u) next = u[1]; }
    }
    return { json: text ? JSON.parse(text) : {}, next };
  }
  throw new HttpError(502, 'Shopify is rate limiting or unavailable, try again in a minute');
}
async function shopifyAll(conn, path, key, maxPages = 40) {
  const out = [];
  let url = path;
  for (let i = 0; i < maxPages && url; i++) {
    const { json, next } = await shopify(conn, 'GET', url);
    out.push(...(json[key] || []));
    url = next;
  }
  return out;
}

// ------------------------------------------------------------------ products
function variantName(p, v) {
  const multi = (p.variants || []).length > 1 && v.title && v.title !== 'Default Title';
  return (multi ? `${p.title} - ${v.title}` : p.title) || 'Shopify product';
}
async function inventoryFor(conn, itemIds) {
  const map = {};
  if (!conn.location_id) return map;
  for (let i = 0; i < itemIds.length; i += 50) {
    const ids = itemIds.slice(i, i + 50);
    const { json } = await shopify(conn, 'GET',
      `inventory_levels.json?inventory_item_ids=${ids.join(',')}&location_ids=${conn.location_id}&limit=250`);
    (json.inventory_levels || []).forEach((l) => { if (l.available != null) map[str(l.inventory_item_id)] = num(l.available); });
  }
  return map;
}

async function loadProductIndex(shopId) {
  const rows = await dbAll(`products?shop_id=eq.${q(shopId)}&deleted_at=is.null&select=id,name,price,stock,barcode,category,shopify_variant_id,shopify_product_id,shopify_inventory_item_id,shopify_synced_price,shopify_synced_stock`);
  const idx = { byVariant: {}, byBarcode: {}, byName: {}, byItem: {} };
  rows.forEach((r) => {
    if (r.shopify_variant_id) idx.byVariant[r.shopify_variant_id] = r;
    if (r.shopify_inventory_item_id) idx.byItem[r.shopify_inventory_item_id] = r;
    if (!r.shopify_variant_id) {
      if (r.barcode) idx.byBarcode[str(r.barcode).toLowerCase()] = r;
      idx.byName[str(r.name).trim().toLowerCase()] = r;
    }
  });
  return idx;
}

async function logMovement(shopId, row, delta) {
  if (!delta) return;
  await db('POST', 'stock_movements', {
    shop_id: shopId, product_id: row.id, product_name: row.name,
    type: delta > 0 ? 'in' : 'out', qty: Math.abs(delta), note: 'Shopify sync'
  });
}

// Apply one Shopify variant to Hisably. Returns 'added' | 'updated' | 'same'
async function applyVariant(conn, p, v, level, idx, pending) {
  const shopId = conn.shop_id;
  const name = variantName(p, v);
  const barcode = str(v.barcode || v.sku).trim();
  const price = num(v.price);
  const tracked = v.inventory_management === 'shopify' && level != null;
  const vid = str(v.id), pid = str(p.id), iid = str(v.inventory_item_id);
  const category = str(p.product_type).trim() || null;

  let row = idx.byVariant[vid];
  if (!row) {                               // try to link an existing Hisably product instead of duplicating
    const cand = (barcode && idx.byBarcode[barcode.toLowerCase()]) || idx.byName[name.trim().toLowerCase()];
    if (cand && !cand.shopify_variant_id) row = cand;
    if (row) { delete idx.byBarcode[str(row.barcode).toLowerCase()]; delete idx.byName[str(row.name).trim().toLowerCase()]; }
    if (row) {
      // first link: Shopify is the source of truth for price and stock
      const delta = tracked ? level - num(row.stock) : 0;
      const patch = {
        shopify_product_id: pid, shopify_variant_id: vid, shopify_inventory_item_id: tracked ? iid : null,
        shopify_synced_price: price, shopify_synced_stock: tracked ? level : null,
        price, updated_at: nowIso()
      };
      if (tracked) patch.stock = level;
      if (!row.category && category) patch.category = category;
      await db('PATCH', `products?id=eq.${q(row.id)}`, patch);
      Object.assign(row, patch);
      idx.byVariant[vid] = row;
      if (tracked) idx.byItem[iid] = row;
      await logMovement(shopId, row, delta);
      return 'updated';
    }
  }
  if (!row) {                               // brand-new product
    pending.push({
      shop_id: shopId, name, price, cost: 0, stock: tracked ? level : 9999, barcode: barcode || null,
      unit: 'pcs', low_stock: 5, category, notes: 'Imported from Shopify',
      shopify_product_id: pid, shopify_variant_id: vid, shopify_inventory_item_id: tracked ? iid : null,
      shopify_synced_price: price, shopify_synced_stock: tracked ? level : null
    });
    return 'added';
  }

  // existing linked product: merge
  const patch = {};
  let visible = false;
  if (row.name !== name) { patch.name = name; visible = true; }
  if ((row.barcode || '') !== barcode && barcode) { patch.barcode = barcode; visible = true; }
  if (category && (row.category || '') !== category) { patch.category = category; visible = true; }
  // price: Shopify wins unless the seller changed it in Hisably and it is not pushed yet
  const syncedP = row.shopify_synced_price;
  if (syncedP == null || num(row.price) === num(syncedP)) {
    if (num(row.price) !== price) { patch.price = price; visible = true; }
  }
  if (syncedP == null || num(syncedP) !== price) patch.shopify_synced_price = price;
  let delta = 0;
  if (tracked) {
    const syncedS = row.shopify_synced_stock;
    if (syncedS == null) {
      delta = level - num(row.stock);
      if (delta) { patch.stock = level; visible = true; }
    } else {
      delta = level - num(syncedS);                         // what changed in Shopify since last sync
      if (delta) { patch.stock = Math.max(0, num(row.stock) + delta); visible = true; }
    }
    if (row.shopify_synced_stock == null || num(row.shopify_synced_stock) !== level) patch.shopify_synced_stock = level;
    if (row.shopify_inventory_item_id !== iid) patch.shopify_inventory_item_id = iid;
  }
  if (!Object.keys(patch).length) return 'same';
  if (visible) patch.updated_at = nowIso();                 // so the seller app picks the change up
  await db('PATCH', `products?id=eq.${q(row.id)}`, patch);
  Object.assign(row, patch);
  if (delta) await logMovement(shopId, row, patch.stock != null ? delta : 0);
  return visible ? 'updated' : 'same';
}

async function flushNew(pending, stats) {
  for (let i = 0; i < pending.length; i += 100) {
    await db('POST', 'products', pending.slice(i, i + 100), 'return=minimal');
  }
  stats.added += pending.length;
  pending.length = 0;
}

async function pullProducts(conn, full) {
  const stats = { added: 0, updated: 0 };
  const idx = await loadProductIndex(conn.shop_id);
  let path = 'products.json?limit=250&fields=id,title,product_type,variants';
  if (!full && conn.last_pull_at) {
    path += `&updated_at_min=${encodeURIComponent(new Date(new Date(conn.last_pull_at).getTime() - 120000).toISOString())}`;
  }
  let url = path;
  const pending = [];
  for (let page = 0; url && page < 60; page++) {
    const { json, next } = await shopify(conn, 'GET', url);
    const products = json.products || [];
    const trackedIds = [];
    products.forEach((p) => (p.variants || []).forEach((v) => { if (v.inventory_management === 'shopify') trackedIds.push(str(v.inventory_item_id)); }));
    const inv = await inventoryFor(conn, trackedIds);
    for (const p of products) {
      for (const v of p.variants || []) {
        const r = await applyVariant(conn, p, v, inv[str(v.inventory_item_id)], idx, pending);
        if (r === 'added') { /* counted on flush */ } else if (r === 'updated') stats.updated++;
      }
    }
    await flushNew(pending, stats);
    url = next;
  }
  return stats;
}

async function handleProductWebhook(conn, p) {
  const idx = { byVariant: {}, byBarcode: {}, byName: {}, byItem: {} };
  const vids = (p.variants || []).map((v) => str(v.id));
  if (vids.length) {
    const rows = await db('GET', `products?shop_id=eq.${q(conn.shop_id)}&shopify_variant_id=in.(${vids.join(',')})&select=*`);
    rows.forEach((r) => { idx.byVariant[r.shopify_variant_id] = r; });
  }
  for (const v of p.variants || []) {                      // link-by-barcode candidates for brand-new variants
    if (!idx.byVariant[str(v.id)]) {
      const bc = str(v.barcode || v.sku).trim();
      if (bc) {
        const r = await db('GET', `products?shop_id=eq.${q(conn.shop_id)}&deleted_at=is.null&shopify_variant_id=is.null&barcode=eq.${q(bc)}&select=*&limit=1`);
        if (r && r[0]) idx.byBarcode[bc.toLowerCase()] = r[0];
      }
    }
  }
  const tracked = (p.variants || []).filter((v) => v.inventory_management === 'shopify').map((v) => str(v.inventory_item_id));
  const inv = await inventoryFor(conn, tracked);
  const pending = [];
  for (const v of p.variants || []) await applyVariant(conn, p, v, inv[str(v.inventory_item_id)], idx, pending);
  await flushNew(pending, { added: 0 });
}

async function handleInventoryWebhook(conn, lvl) {
  if (str(lvl.location_id) !== str(conn.location_id) || lvl.available == null) return;
  const rows = await db('GET', `products?shop_id=eq.${q(conn.shop_id)}&shopify_inventory_item_id=eq.${q(lvl.inventory_item_id)}&select=*&limit=1`);
  const row = rows && rows[0];
  if (!row) return;
  const level = num(lvl.available);
  const synced = row.shopify_synced_stock == null ? num(row.stock) : num(row.shopify_synced_stock);
  const delta = level - synced;
  if (!delta && row.shopify_synced_stock != null) return;   // echo of our own push
  const patch = { shopify_synced_stock: level, stock: Math.max(0, num(row.stock) + delta), updated_at: nowIso() };
  await db('PATCH', `products?id=eq.${q(row.id)}`, patch);
  await logMovement(conn.shop_id, row, delta);
}

async function pushProducts(conn) {
  const rows = await dbAll(`products?shop_id=eq.${q(conn.shop_id)}&deleted_at=is.null&shopify_variant_id=not.is.null&select=id,name,price,stock,shopify_variant_id,shopify_inventory_item_id,shopify_synced_price,shopify_synced_stock`);
  const changes = rows.filter((r) =>
    (r.shopify_synced_price != null && num(r.price) !== num(r.shopify_synced_price)) ||
    (r.shopify_inventory_item_id && r.shopify_synced_stock != null && num(r.stock) !== num(r.shopify_synced_stock)));
  const todo = changes.slice(0, PUSH_BATCH);
  const out = { pushed: 0, remaining: changes.length - todo.length, errors: [] };
  for (const r of todo) {
    const priceChanged = r.shopify_synced_price != null && num(r.price) !== num(r.shopify_synced_price);
    const stockChanged = r.shopify_inventory_item_id && r.shopify_synced_stock != null && num(r.stock) !== num(r.shopify_synced_stock);
    const old = { shopify_synced_price: r.shopify_synced_price, shopify_synced_stock: r.shopify_synced_stock };
    const next = {};
    if (priceChanged) next.shopify_synced_price = num(r.price);
    if (stockChanged) next.shopify_synced_stock = Math.round(num(r.stock));
    // write the new baseline FIRST so the webhook echo of this very change is recognised as an echo
    await db('PATCH', `products?id=eq.${q(r.id)}`, next);
    try {
      if (priceChanged) {
        await shopify(conn, 'PUT', `variants/${r.shopify_variant_id}.json`, { variant: { id: Number(r.shopify_variant_id), price: num(r.price).toFixed(2) } });
      }
      if (stockChanged) {
        await shopify(conn, 'POST', 'inventory_levels/adjust.json', {
          location_id: Number(conn.location_id), inventory_item_id: Number(r.shopify_inventory_item_id),
          available_adjustment: Math.round(num(r.stock)) - num(old.shopify_synced_stock)
        });
      }
      out.pushed++;
    } catch (e) {
      const back = {};
      if (priceChanged) back.shopify_synced_price = old.shopify_synced_price;
      if (stockChanged) back.shopify_synced_stock = old.shopify_synced_stock;
      await db('PATCH', `products?id=eq.${q(r.id)}`, back);
      out.errors.push(`${r.name}: ${e.message}`.slice(0, 160));
      if (e.status === 400) break;                          // auth / permission problem: stop early
    }
    await sleep(250);
  }
  return out;
}

// ------------------------------------------------------------------ customers
function customerFields(c) {
  const a = c.default_address || {};
  const name = `${str(c.first_name)} ${str(c.last_name)}`.trim() || str(a.name).trim() || str(c.email) || 'Shopify customer';
  const phone = str(c.phone || a.phone).trim();
  const address = [a.address1, a.address2, a.city, a.province, a.country].filter(Boolean).join(', ');
  return { name, phone: phone || null, address: address || null };
}
async function upsertCustomer(conn, c, idx) {
  const sid = str(c.id);
  const f = customerFields(c);
  let row = idx ? idx.byId[sid] : (await db('GET', `customers?shop_id=eq.${q(conn.shop_id)}&shopify_customer_id=eq.${q(sid)}&select=*&limit=1`))[0];
  if (!row && f.phone) {
    row = idx ? idx.byPhone[digits(f.phone)] : (await db('GET', `customers?shop_id=eq.${q(conn.shop_id)}&deleted_at=is.null&phone=eq.${q(f.phone)}&shopify_customer_id=is.null&select=*&limit=1`))[0];
    if (row && row.shopify_customer_id) row = null;
  }
  if (row) {
    const patch = {};
    if (row.name !== f.name) patch.name = f.name;
    if (f.phone && row.phone !== f.phone) patch.phone = f.phone;
    if (f.address && row.address !== f.address) patch.address = f.address;
    if (row.shopify_customer_id !== sid) patch.shopify_customer_id = sid;
    if (row.deleted_at) patch.deleted_at = null;
    if (Object.keys(patch).length) {
      patch.updated_at = nowIso();
      await db('PATCH', `customers?id=eq.${q(row.id)}`, patch);
      Object.assign(row, patch);
      return { id: row.id, changed: true };
    }
    return { id: row.id, changed: false };
  }
  const made = await db('POST', 'customers', {
    shop_id: conn.shop_id, name: f.name, phone: f.phone, address: f.address,
    notes: `Shopify customer${c.email ? ' · ' + c.email : ''}`, shopify_customer_id: sid
  }, 'return=representation');
  if (idx) { idx.byId[sid] = made[0]; if (f.phone) idx.byPhone[digits(f.phone)] = made[0]; }
  return { id: made[0].id, changed: true, added: true };
}
async function loadCustomerIndex(shopId) {
  const rows = await dbAll(`customers?shop_id=eq.${q(shopId)}&select=id,name,phone,address,deleted_at,shopify_customer_id`);
  const idx = { byId: {}, byPhone: {} };
  rows.forEach((r) => {
    if (r.shopify_customer_id) idx.byId[r.shopify_customer_id] = r;
    else if (r.phone && !r.deleted_at) idx.byPhone[digits(r.phone)] = r;
  });
  return idx;
}
async function pullCustomers(conn, full) {
  const stats = { added: 0, updated: 0 };
  let path = 'customers.json?limit=250';
  if (!full && conn.last_pull_at) path += `&updated_at_min=${encodeURIComponent(new Date(new Date(conn.last_pull_at).getTime() - 120000).toISOString())}`;
  const list = await shopifyAll(conn, path, 'customers', 40);
  const idx = await loadCustomerIndex(conn.shop_id);
  for (const c of list) {
    const r = await upsertCustomer(conn, c, idx);
    if (r.added) stats.added++; else if (r.changed) stats.updated++;
  }
  return stats;
}

// ------------------------------------------------------------------ orders -> invoices
function buildOrderItems(o, localByVariant) {
  const items = (o.line_items || []).map((li) => {
    const local = localByVariant[str(li.variant_id)];
    const title = li.variant_title && li.variant_title !== 'Default Title' && !str(li.title).includes(li.variant_title)
      ? `${li.title} - ${li.variant_title}` : str(li.title);
    return { productId: local ? local.id : null, name: title || str(li.name), price: num(li.price), cost: local ? num(local.cost) : 0, qty: Math.max(1, Math.round(num(li.quantity))) };
  });
  const discount = num(o.current_total_discounts ?? o.total_discounts);
  if (discount > 0) items.push({ productId: null, name: 'Discount', price: -discount, cost: 0, qty: 1 });
  const ship = (o.shipping_lines || []).reduce((s, l) => s + num(l.price), 0);
  if (ship > 0) items.push({ productId: null, name: 'Shipping', price: ship, cost: 0, qty: 1 });
  if (o.taxes_included === false && num(o.current_total_tax ?? o.total_tax) > 0) {
    items.push({ productId: null, name: 'Tax', price: num(o.current_total_tax ?? o.total_tax), cost: 0, qty: 1 });
  }
  return items;
}
async function upsertOrder(conn, o, custIdx) {
  const oid = str(o.id);
  const existing = (await db('GET', `invoices?shop_id=eq.${q(conn.shop_id)}&shopify_order_id=eq.${q(oid)}&select=id,deleted_at&limit=1`))[0];
  if (o.cancelled_at) {
    if (existing && !existing.deleted_at) {
      await db('PATCH', `invoices?id=eq.${q(existing.id)}`, { deleted_at: nowIso(), updated_at: nowIso() });
      return 'cancelled';
    }
    return 'skipped';
  }
  let customerId = null, customerName = '', customerPhone = '';
  if (o.customer && o.customer.id) {
    const r = await upsertCustomer(conn, o.customer, custIdx);
    customerId = r.id;
    const f = customerFields(o.customer);
    customerName = f.name; customerPhone = f.phone || '';
  } else {
    const a = o.shipping_address || o.billing_address || {};
    customerName = str(a.name).trim() || str(o.email) || 'Online customer';
    customerPhone = str(a.phone || o.phone);
  }
  const vids = [...new Set((o.line_items || []).map((l) => str(l.variant_id)).filter((x) => x && x !== 'null'))];
  const localByVariant = {};
  if (vids.length) {
    const rows = await db('GET', `products?shop_id=eq.${q(conn.shop_id)}&shopify_variant_id=in.(${vids.join(',')})&select=id,cost,shopify_variant_id`);
    rows.forEach((r) => { localByVariant[r.shopify_variant_id] = r; });
  }
  const items = buildOrderItems(o, localByVariant);
  const total = Math.max(0, num(o.current_total_price ?? o.total_price));
  const fs = str(o.financial_status);
  let paid = 0;
  if (fs === 'paid' || fs === 'partially_refunded' || fs === 'refunded') paid = total;
  else if (fs === 'partially_paid') paid = Math.max(0, total - num(o.total_outstanding));
  paid = Math.min(paid, total);
  const status = total === 0 || paid >= total ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  const number = `SHP-${str(o.order_number || str(o.name).replace('#', '') || oid)}`;
  const row = {
    number, customer_id: customerId, customer_name: customerName || null, customer_phone: customerPhone || null,
    items, total, paid_amount: paid, payment_status: status,
    invoice_date: o.created_at || nowIso(), updated_at: nowIso(), deleted_at: null
  };
  if (existing) { await db('PATCH', `invoices?id=eq.${q(existing.id)}`, row); return 'updated'; }
  await db('POST', 'invoices', { ...row, shop_id: conn.shop_id, shopify_order_id: oid });
  return 'added';
}
async function pullOrders(conn) {
  const stats = { added: 0, updated: 0 };
  if (!conn.last_orders_at) return stats;                 // orders are imported from the moment of connection
  const path = `orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(new Date(new Date(conn.last_orders_at).getTime() - 120000).toISOString())}`;
  const list = await shopifyAll(conn, path, 'orders', 20);
  const custIdx = await loadCustomerIndex(conn.shop_id);
  for (const o of list) {
    const r = await upsertOrder(conn, o, custIdx);
    if (r === 'added') stats.added++; else if (r === 'updated' || r === 'cancelled') stats.updated++;
  }
  return stats;
}

// ------------------------------------------------------------------ connect / webhooks
async function registerWebhooks(conn) {
  const { json } = await shopify(conn, 'GET', 'webhooks.json?limit=250');
  const have = new Set((json.webhooks || []).filter((w) => w.address === CALLBACK()).map((w) => w.topic));
  let made = 0;
  const errors = [];
  for (const topic of TOPICS) {
    if (have.has(topic)) continue;
    try {
      await shopify(conn, 'POST', 'webhooks.json', { webhook: { topic, address: CALLBACK(), format: 'json' } });
      made++;
    } catch (e) { errors.push(`${topic}: ${e.message}`.slice(0, 140)); }
    await sleep(200);
  }
  return { made, errors };
}
async function removeWebhooks(conn) {
  try {
    const { json } = await shopify(conn, 'GET', 'webhooks.json?limit=250');
    for (const w of json.webhooks || []) {
      if (w.address === CALLBACK()) { await shopify(conn, 'DELETE', `webhooks/${w.id}.json`); await sleep(200); }
    }
  } catch (_e) { /* store may already be uninstalled */ }
}
async function listLocations(conn) {
  const { json } = await shopify(conn, 'GET', 'locations.json');
  return (json.locations || []).filter((l) => l.active !== false).map((l) => ({ id: str(l.id), name: str(l.name) }));
}

async function statusOf(shopId) {
  const c = await getConn(shopId);
  if (!c) return { connected: false };
  let locations = [];
  try { locations = await listLocations(c); } catch (_e) { /* offline Shopify: still show the rest */ }
  return {
    connected: true, domain: c.domain, location_id: c.location_id, location_name: c.location_name, locations,
    last_pull_at: c.last_pull_at, last_push_at: c.last_push_at, last_error: c.last_error,
    auth: c.access_token ? 'token' : 'client'
  };
}

async function doConnect(shopId, b) {
  const domain = normalizeDomain(b.domain);
  const token = str(b.accessToken).trim();
  const clientId = str(b.clientId).trim(), clientSecret = str(b.clientSecret).trim();
  const apiSecret = str(b.apiSecret).trim() || clientSecret;
  if (!token && !(clientId && clientSecret)) throw new HttpError(400, 'Enter the Admin API access token, or the Client ID and Client secret');
  if (!apiSecret) throw new HttpError(400, 'Enter the API secret key (used to verify Shopify webhooks)');
  const other = await getConnByDomain(domain);
  if (other && other.shop_id !== shopId) throw new HttpError(409, 'This Shopify store is already connected to another Hisably account');
  const conn = {
    shop_id: shopId, domain, access_token: token || null, client_id: clientId || null, client_secret: clientSecret || null,
    api_secret: apiSecret, token_cache: null, token_expires_at: null, location_id: null, location_name: null,
    last_pull_at: null, last_orders_at: null, last_push_at: null, last_error: null
  };
  const info = await shopify(conn, 'GET', 'shop.json');          // proves the credentials work
  const locs = await listLocations(conn);
  const loc = locs.find((l) => l.id === str(b.locationId)) || locs[0] || null;
  conn.location_id = loc ? loc.id : null;
  conn.location_name = loc ? loc.name : null;
  await db('POST', 'shopify_connections?on_conflict=shop_id', { ...conn, updated_at: nowIso() }, 'resolution=merge-duplicates,return=minimal');
  const hooks = await registerWebhooks(conn);
  const res = await runSync(conn, true);
  return { ok: true, shopName: info.json.shop && info.json.shop.name, webhooks: hooks, ...res };
}

async function runSync(conn, full) {
  const started = nowIso();
  const out = { products: null, customers: null, orders: null, push: null };
  try {
    out.products = await pullProducts(conn, full);
    out.customers = await pullCustomers(conn, full);
    out.orders = await pullOrders(conn);
    out.push = await pushProducts(conn);
    await patchConn(conn, {
      last_pull_at: started, last_orders_at: started,
      last_push_at: nowIso(), last_error: out.push.errors.length ? out.push.errors[0] : null
    });
  } catch (e) {
    await patchConn(conn, { last_error: String(e.message || e).slice(0, 300) });
    throw e;
  }
  const changed = (out.products.added + out.products.updated + out.customers.added + out.customers.updated +
    out.orders.added + out.orders.updated) > 0 || out.push.pushed > 0;
  return { changed, ...out };
}

// ------------------------------------------------------------------ auth
async function userShop(req) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'Sign in first');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: auth } });
  if (!r.ok) throw new HttpError(401, 'Session expired, sign in again');
  const user = await r.json();
  const p = await db('GET', `profiles?id=eq.${q(user.id)}&select=shop_id,role`);
  const shopId = p && p[0] && p[0].shop_id;
  if (!shopId) throw new HttpError(403, 'Your account has no shop');
  return shopId;
}

async function hmacOk(secret, raw, header) {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let bin = '';
  sig.forEach((b) => { bin += String.fromCharCode(b); });
  const mine = btoa(bin);
  if (mine.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

async function webhook(req) {
  const raw = await req.text();
  const domain = (req.headers.get('x-shopify-shop-domain') || '').toLowerCase();
  const topic = req.headers.get('x-shopify-topic') || '';
  const conn = domain ? await getConnByDomain(domain) : null;
  if (!conn || !(await hmacOk(conn.api_secret, raw, req.headers.get('x-shopify-hmac-sha256')))) {
    return new Response('unauthorized', { status: 401 });
  }
  try {
    if (!(await planAllowsShopify(conn.shop_id))) return new Response('ok', { status: 200 });
    const data = raw ? JSON.parse(raw) : {};
    if (topic === 'products/create' || topic === 'products/update') await handleProductWebhook(conn, data);
    else if (topic === 'products/delete') {
      await db('PATCH', `products?shop_id=eq.${q(conn.shop_id)}&shopify_product_id=eq.${q(data.id)}`, { deleted_at: nowIso(), updated_at: nowIso() });
    } else if (topic === 'inventory_levels/update') await handleInventoryWebhook(conn, data);
    else if (topic === 'orders/create' || topic === 'orders/updated') await upsertOrder(conn, data, null);
    else if (topic === 'customers/create' || topic === 'customers/update') await upsertCustomer(conn, data, null);
  } catch (e) {
    await patchConn(conn, { last_error: `webhook ${topic}: ${String(e.message || e)}`.slice(0, 300) }).catch(() => {});
  }
  return new Response('ok', { status: 200 });
}

// ------------------------------------------------------------------ entry
async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (req.headers.get('x-shopify-hmac-sha256')) return webhook(req);
  try {
    const shopId = await userShop(req);
    const b = await req.json().catch(() => ({}));
    const action = b.action;
    if (action === 'status') {
      return reply({ ...(await statusOf(shopId)), allowed: await planAllowsShopify(shopId) });
    }
    if (!(await planAllowsShopify(shopId))) throw new HttpError(402, 'The Shopify connection is a Pro feature. Upgrade to Pro or Lifetime.');
    if (action === 'connect') return reply(await doConnect(shopId, b));
    const conn = await getConn(shopId);
    if (!conn) throw new HttpError(400, 'Shopify is not connected');
    if (action === 'sync') return reply(await runSync(conn, !!b.full));
    if (action === 'set_location') {
      const locs = await listLocations(conn);
      const loc = locs.find((l) => l.id === str(b.locationId));
      if (!loc) throw new HttpError(400, 'Unknown location');
      await patchConn(conn, { location_id: loc.id, location_name: loc.name });
      await db('PATCH', `products?shop_id=eq.${q(shopId)}&shopify_variant_id=not.is.null`, { shopify_synced_stock: null });
      return reply({ ok: true, ...(await runSync(conn, true)) });
    }
    if (action === 'disconnect') {
      await removeWebhooks(conn);
      await db('DELETE', `shopify_connections?shop_id=eq.${q(shopId)}`);
      return reply({ ok: true });
    }
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return reply({ error: String(e.message || e).slice(0, 400) }, status);
  }
}

if (typeof Deno !== 'undefined' && Deno.serve && !globalThis.__HISABLY_TEST__) Deno.serve(handle);
globalThis.__shopifyHandle = handle;
