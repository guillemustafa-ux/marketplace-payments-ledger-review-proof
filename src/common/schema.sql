-- v2 schema: the fixed ledger. Every table/constraint below is the "correct" version.

-- F1: webhook event ids are stored under a unique constraint, in the same transaction
-- as the ledger entries they cause.
create table if not exists webhook_events (
  event_id text primary key,
  event_type text not null,
  created_at timestamptz not null default now()
);

-- Charge metadata, recorded when a capture is applied, so a later refund or dispute can
-- reverse the right accounts.
create table if not exists charges (
  charge_id text primary key,
  amount_cents bigint not null,
  creator_id text not null,
  referrer_id text not null
);

-- Double-entry ledger. I2: each (provider object id, entry type) produces at most one
-- ledger transaction, enforced by the unique constraint below.
create table if not exists ledger_transactions (
  id bigserial primary key,
  provider_object_id text not null,
  entry_type text not null,
  day text not null,
  created_at timestamptz not null default now(),
  unique (provider_object_id, entry_type)
);

-- The double-entry legs. Every transaction's lines sum to zero (I1).
create table if not exists ledger_lines (
  id bigserial primary key,
  transaction_id bigint not null references ledger_transactions(id) on delete cascade,
  account text not null,
  amount_cents bigint not null
);

-- Every applied refund or dispute, so the next one on the same charge is split against the
-- running total already reversed (F5) and a charge reversed in full leaves every party at zero (I3).
create table if not exists reversals (
  provider_object_id text not null,
  kind text not null,
  charge_id text not null,
  amount_cents bigint not null,
  primary key (provider_object_id, kind)
);

-- F3: refunds and disputes that arrive before their capture are parked here and applied
-- once the capture exists.
create table if not exists pending_reversals (
  id bigserial primary key,
  provider_object_id text not null,
  kind text not null,
  charge_id text not null,
  amount_cents bigint not null,
  day text not null,
  unique (provider_object_id, kind)
);

-- F7: one idempotency key per order, stored before the first send and reused on every retry.
create table if not exists capture_intents (
  order_id text primary key,
  idempotency_key text not null
);

-- F9: the payout intent is persisted with its client_reference before the first send, and
-- read on every request for that reference.
create table if not exists payout_intents (
  client_reference text primary key,
  status text not null,
  payout_id text
);

create index if not exists ledger_lines_account_idx on ledger_lines(account);
create index if not exists ledger_transactions_day_idx on ledger_transactions(day);
create index if not exists reversals_charge_idx on reversals(charge_id);
