-- Part 7: invoice extras (discount, tax, charges, document type). Safe to re-run.
alter table public.invoices add column if not exists doc_type text not null default 'sale';
alter table public.invoices add column if not exists meta jsonb not null default '{}'::jsonb;
