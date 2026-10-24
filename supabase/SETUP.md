# Hisably + Supabase setup (free tier)

## 1. Create project
1. Go to [https://supabase.com](https://supabase.com) → Start your project (free)
2. Create a new project (set a strong DB password, save it)
3. Wait until the project is ready

## 2. Run the database schema
1. In Supabase: **SQL Editor** → New query
2. Paste the full contents of `schema.sql`
3. Click **Run**
4. Upgrading an older install? Just run the same file again – it is safe to re-run and keeps your data
   (it also fixes security holes in the first version of the schema).
4. Confirm tables appear under **Table Editor**: shops, profiles, plans, products, …

## 3. Create your platform admin user
1. **Authentication** → Users → Add user  
   - Email: your email  
   - Password: choose one  
2. Open **SQL Editor** and run (replace the email):

```sql
update public.profiles
set role = 'platform_admin'
where id = (
  select id from auth.users where email = 'YOU@EXAMPLE.COM'
);
```

## 4. Copy API keys
**Project Settings → API**:
- Project URL → `url`
- `anon` `public` key → `anonKey`

## 5. Configure both apps
Copy `config.example.js` to:

- `admin/js/supabase-config.js`
- `seller-app/js/supabase-config.js`

Edit each file:

```js
window.HISABLY_SUPABASE = {
  url: 'https://xxxx.supabase.co',
  anonKey: 'eyJhbGciOi...',
  enabled: true
};
```

## 6. Load scripts
Already wired in both `index.html` files (supabase-js, `supabase-config.js`, `cloud.js` / `admin-cloud.js`).

## 7. How it works after wiring

| Action | Result |
|--------|--------|
| Seller registers | A database trigger creates the auth user + shop (14-day trial) + profile. Works with email confirmation on or off |
| Seller uses app | Fast local UI; changes sync automatically (record by record, newest edit wins, offline safe) |
| Seller opens app on another phone | Sign in → data merges in automatically |
| Seller taps **I paid** | A payment request appears in Admin → Payments on your phone |
| You approve it | Shop becomes Active on that plan for 30 days (then falls back to Free unless renewed) |
| Free-plan limits | Enforced by the database too, so editing the phone's storage cannot bypass them |

## 8. In the app
Sign-in is required. **More → Sync now** forces a sync; otherwise it happens automatically.

## 9. Security notes
- Never put the **service_role** key in the frontend
- Only `anon` key + RLS policies (already in schema.sql)
- With Supabase on, the admin panel only accepts your real admin email + password (the local default password is disabled)
- Sellers can never change their own role, shop or plan – this is enforced in the database (see `schema.sql`)

## 10. Email confirmation
Either setting works. With **Confirm email ON** the seller is told to check their inbox, then signs in.
Turn it off (**Authentication → Providers → Email**) only if you want instant signup.

---

If anything fails, check browser console and Supabase **Logs**.
Common issues: `enabled: false`, wrong URL/key, schema not run, profile role not set to `platform_admin`.
