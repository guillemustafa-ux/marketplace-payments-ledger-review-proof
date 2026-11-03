import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { balanceOf } from '../common/db.js';
import { captureSplit, dayOf, refundSplitRoundedPerLine } from '../common/math.js';
import type {
  Charge,
  Dispute,
  Ledger,
  PayoutOutcome,
  ReconcileDifference,
  Refund,
  WebhookEvent,
} from '../common/types.js';

const PLATFORM = 'platform';
const EXTERNAL = 'external';
const creatorAccount = (id: string) => `creator:${id}`;
const referrerAccount = (id: string) => `referrer:${id}`;

interface LedgerLine {
  account: string;
  amount: number;
}

interface ChargeRecord {
  amount_cents: number;
  creator_id: string;
  referrer_id: string;
}

export interface LedgerDeps {
  pool: Pool;
  providerUrl: string;
}

export function createV1Ledger({ pool, providerUrl }: LedgerDeps): Ledger {
  async function handleWebhook(event: WebhookEvent): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // DEFECT F1: the event id is not stored under a unique constraint, so a redelivered
      // event is processed a second time.
      const day = dayOf(event.created);
      if (event.type === 'charge.succeeded') {
        await recordCapture(client, event.data.object as Charge, day);
      } else if (event.type === 'refund.created') {
        await recordRefund(client, event.data.object as Refund, day);
      } else if (event.type === 'charge.refunded') {
        await handleChargeRefunded(client, event.data.object as Charge, day);
      } else if (event.type === 'charge.dispute.created') {
        await recordDispute(client, event.data.object as Dispute, day);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function capture(input: { amount: number; creator_id: string; referrer_id: string }): Promise<{ ok: boolean }> {
    const charge = await sendCaptureWithRetry(input);
    await recordCaptureFromApi(charge);
    return { ok: true };
  }

  async function payout(input: { creator_id: string; amount: number; client_reference: string }): Promise<PayoutOutcome> {
    return sendPayout(input);
  }

  async function reconcile(day: string): Promise<ReconcileDifference[]> {
    // DEFECT F6: compare only the number of captures, so an amount drift per creator stays green.
    const ledgerCount = await pool.query(
      "select count(*)::int as n from ledger_transactions where day = $1 and entry_type = 'capture'",
      [day],
    );
    const response = await fetch(`${providerUrl}/v1/reconciliation?day=${encodeURIComponent(day)}`);
    const providerRows = (await response.json()) as { creator_id: string; amount_cents: number }[];
    if (Number(ledgerCount.rows[0].n) === providerRows.length) return [];
    return [{ creator_id: '<count mismatch>', ledger_cents: Number(ledgerCount.rows[0].n), provider_cents: providerRows.length }];
  }

  async function balance(account: string): Promise<number> {
    return balanceOf(pool, account);
  }

  async function sendCaptureWithRetry(input: { amount: number; creator_id: string; referrer_id: string }): Promise<Charge> {
    let lastError: unknown = new Error('capture not attempted');
    for (let attempt = 0; attempt < 5; attempt++) {
      // DEFECT F7: a fresh idempotency key per attempt; a retry after a lost response captures twice.
      const key = randomUUID();
      try {
        const response = await fetch(`${providerUrl}/v1/captures`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ amount: input.amount, creator_id: input.creator_id, referrer_id: input.referrer_id }),
        });
        if (response.ok) return (await response.json()) as Charge;
        lastError = new Error(`capture failed: HTTP ${response.status}`);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function recordCaptureFromApi(charge: Charge): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await recordCapture(client, charge, dayOf(charge.created ?? 1730000000));
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function sendPayout(input: { creator_id: string; amount: number; client_reference: string }): Promise<PayoutOutcome> {
    // DEFECT F9: after an unknown outcome the payout is resent blindly, paying twice.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`${providerUrl}/v1/payouts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount: input.amount, client_reference: input.client_reference, destination: input.creator_id }),
        });
        if (response.ok) {
          const payout = (await response.json()) as { id: string; created?: number };
          await recordPayout(input, payout.id, payout.created ?? 1730000000);
          return { status: 'paid', payout_id: payout.id };
        }
        return { status: 'unknown' };
      } catch {
        // lost response: resend blindly
      }
    }
    return { status: 'unknown' };
  }

  async function recordPayout(input: { creator_id: string; amount: number }, payoutId: string, created: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const txId = await insertTransaction(client, payoutId, 'payout', dayOf(created));
      if (txId != null) {
        await insertLines(client, txId, [
          { account: creatorAccount(input.creator_id), amount: -input.amount },
          { account: EXTERNAL, amount: input.amount },
        ]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordCapture(client: PoolClient, charge: Charge, day: string): Promise<void> {
    const txId = await insertTransaction(client, charge.id, 'capture', day);
    if (txId == null) return;
    const split = captureSplit(charge.amount);
    await insertLines(client, txId, [
      { account: creatorAccount(charge.metadata.creator_id), amount: split.creator },
      { account: referrerAccount(charge.metadata.referrer_id), amount: split.referrer },
      { account: PLATFORM, amount: split.platform },
      { account: EXTERNAL, amount: -charge.amount },
    ]);
    await client.query(
      'insert into charges (charge_id, amount_cents, creator_id, referrer_id) values ($1, $2, $3, $4) on conflict (charge_id) do nothing',
      [charge.id, charge.amount, charge.metadata.creator_id, charge.metadata.referrer_id],
    );
  }

  async function recordRefund(client: PoolClient, refund: Refund, day: string): Promise<void> {
    const charge = await lookupCharge(client, refund.charge);
    if (!charge) return;
    // DEFECT F4: refunds are deduplicated by (charge id, type), so a second partial refund
    // on the same charge is dropped.
    const existing = await client.query(
      "select 1 from ledger_transactions where provider_object_id = $1 and entry_type = 'refund'",
      [refund.charge],
    );
    if ((existing.rowCount ?? 0) > 0) return;
    const txId = await insertTransaction(client, refund.charge, 'refund', day);
    if (txId == null) return;
    // DEFECT F5: each line is rounded half-up independently, so the parts can be off by a cent.
    const split = refundSplitRoundedPerLine(charge.amount_cents, refund.amount);
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount: refund.amount },
    ]);
  }

  async function handleChargeRefunded(client: PoolClient, charge: Charge, day: string): Promise<void> {
    const existing = await lookupCharge(client, charge.id);
    if (!existing) {
      // DEFECT F3: an out-of-order refund is dropped and the creator keeps the full earnings.
      return;
    }
    const refundAmount = charge.amount_refunded ?? charge.amount;
    const txId = await insertTransaction(client, charge.id, 'refund', day);
    if (txId == null) return;
    const split = refundSplitRoundedPerLine(existing.amount_cents, refundAmount);
    await insertLines(client, txId, [
      { account: creatorAccount(existing.creator_id), amount: -split.creator },
      { account: referrerAccount(existing.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount: refundAmount },
    ]);
  }

  async function recordDispute(client: PoolClient, dispute: Dispute, day: string): Promise<void> {
    const charge = await lookupCharge(client, dispute.charge);
    if (!charge) return;
    const txId = await insertTransaction(client, dispute.charge, 'dispute', day);
    if (txId == null) return;
    const split = captureSplit(charge.amount_cents);
    // DEFECT F8: reverse the creator earnings but leave the referral reward paid.
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: EXTERNAL, amount: split.creator },
    ]);
  }

  // DEFECT F2: transactions are not keyed by (provider object id, entry type), so two
  // events for one occurrence create two transactions.
  async function insertTransaction(
    client: PoolClient,
    providerObjectId: string,
    entryType: string,
    day: string,
  ): Promise<number | null> {
    const result = await client.query(
      'insert into ledger_transactions (provider_object_id, entry_type, day) values ($1, $2, $3) returning id',
      [providerObjectId, entryType, day],
    );
    return Number(result.rows[0].id);
  }

  async function insertLines(client: PoolClient, transactionId: number, lines: LedgerLine[]): Promise<void> {
    for (const line of lines) {
      await client.query('insert into ledger_lines (transaction_id, account, amount_cents) values ($1, $2, $3)', [
        transactionId,
        line.account,
        line.amount,
      ]);
    }
  }

  async function lookupCharge(client: PoolClient, chargeId: string): Promise<ChargeRecord | null> {
    const result = await client.query('select amount_cents, creator_id, referrer_id from charges where charge_id = $1', [chargeId]);
    return result.rows.length ? (result.rows[0] as ChargeRecord) : null;
  }

  return { handleWebhook, capture, payout, reconcile, balance };
}
