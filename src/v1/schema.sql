-- v1 schema: the defective ledger. Compare with src/common/schema.sql:
--   - no webhook_events table (F1: redelivered events are processed again)
--   - no unique(provider_object_id, entry_type) on ledger_transactions (F2: two events
--     for one occurrence create two transactions)
--   - no pending_refunds table (F3: an out-of-order refund is dropped)
--   - no payout_intents table (F9: an unknown payout outcome is retried blindly)

create table if not exists charges (
  charge_id text primary key,
  amount_cents bigint not null,
  creator_id text not null,
  referrer_id text not null
);

create table if not exists ledger_transactions (
  id bigserial primary key,
  provider_object_id text not null,
  entry_type text not null,
  day text not null,
  created_at timestamptz not null default now()
);

create table if not exists ledger_lines (
  id bigserial primary key,
  transaction_id bigint not null references ledger_transactions(id) on delete cascade,
  account text not null,
  amount_cents bigint not null
);

create index if not exists ledger_lines_account_idx on ledger_lines(account);
create index if not exists ledger_transactions_day_idx on ledger_transactions(day);
