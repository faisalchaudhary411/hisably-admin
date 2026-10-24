# Hisably Admin – Your SaaS side

This is **your** console as the platform owner. The seller app (Hisably) is what shops use daily.

## Login
- Open `index.html` (or host on a private URL)
- Default password: **hisably2026**
- Change it immediately under **Settings**

## What you can do
- **Dashboard** – total shops, active, trials, MRR
- **Shops** – add / edit / pause / expire each seller business
- **Plans** – Free / Basic / Pro (or your own prices in PKR, INR, BDT)
- **Subscriptions** – see who is paid, trial, expired
- **Settings** – support contacts, currency, password, export/import

## Two apps

| App | Who uses it | Purpose |
|-----|-------------|---------|
| **Hisably** (seller) | Shop owners | Inventory, invoices, customers, QR pay |
| **Hisably Admin** (you) | You only | Manage shops, plans, revenue |

## Current mode: Local
Admin data is stored in **this browser** only. Good for:
- Learning the workflow
- Tracking shops you onboard manually
- Setting plan prices

## Next step: Real multi-shop cloud
When you are ready to sell online accounts:
1. Free **Supabase** project (auth + Postgres)
2. Sellers register / login in Hisably app
3. Admin reads the same database
4. Optional: JazzCash / Stripe for collecting subscription fees

Ask for the Supabase wiring guide when you want to go live.

## Hosting tip
Host Admin on a **private** link or password-protect the folder.
Do not put the default password on a public page without changing it.
