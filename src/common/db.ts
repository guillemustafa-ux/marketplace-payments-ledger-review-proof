import type pg from 'pg';

export { dayOf } from './math.js';

export type Pool = pg.Pool;

/** Wipe every table between test cases (tests share one database). */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('truncate table charges, ledger_lines, ledger_transactions restart identity cascade');
  // v2-only tables: absent from the v1 schema, so a missing relation is fine.
  for (const table of ['webhook_events', 'reversals', 'pending_reversals', 'capture_intents', 'payout_intents']) {
    try {
      await pool.query(`truncate table ${table} restart identity`);
    } catch (error) {
      if (!String(error).includes('does not exist')) throw error;
    }
  }
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
