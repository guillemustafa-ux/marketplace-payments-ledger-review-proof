import { readFileSync } from 'node:fs';
import type pg from 'pg';

export { dayOf } from './math.js';

export type Pool = pg.Pool;

/** Read and run every schema file (in order) against a fresh database. */
export async function applySchema(pool: Pool, files: string[]): Promise<void> {
  for (const file of files) await pool.query(readFileSync(file, 'utf8'));
}

/** Wipe every table between test cases (tests share one database). */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'truncate table webhook_events, payout_intents, pending_refunds, ledger_lines, ledger_transactions, charges restart identity cascade',
  );
}

/** Sum of all ledger lines for one account (positive = credit, negative = debit). */
export async function balanceOf(pool: Pool, account: string): Promise<number> {
  const result = await pool.query('select coalesce(sum(amount_cents), 0)::bigint as cents from ledger_lines where account = $1', [
    account,
  ]);
  return Number(result.rows[0].cents);
}

/** Per-creator capture amounts for one day, from the ledger (for reconciliation). */
export async function ledgerCaptureAmounts(pool: Pool, day: string): Promise<Map<string, number>> {
  const result = await pool.query(
    `select l.account, coalesce(sum(l.amount_cents), 0)::bigint as cents
       from ledger_lines l
       join ledger_transactions t on t.id = l.transaction_id
      where t.day = $1 and t.entry_type = 'capture' and l.account like 'creator:%'
      group by l.account`,
    [day],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) map.set(String(row.account).slice('creator:'.length), Number(row.cents));
  return map;
}
