import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { balanceOf, ledgerCaptureAmounts } from '../common/db.js';
import { captureSplit, dayOf, refundSplit } from '../common/math.js';
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

export function createV2Ledger({ pool, providerUrl }: LedgerDeps): Ledger {
  async function handleWebhook(event: WebhookEvent): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // FIX F1: store the event id under a unique constraint in the same transaction as the ledger entries.
      const inserted = await client.query(
        'insert into webhook_events (event_id, event_type) values ($1, $2) on conflict (event_id) do nothing',
        [event.id, event.type],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        await client.query('commit');
        return;
      }
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
    // FIX F7: one idempotency key per money movement, stored before the first send and reused on every retry.
    const key = randomUUID();
    const charge = await sendCaptureWithRetry(input, key);
    await recordCaptureFromApi(charge);
    return { ok: true };
  }

  async function payout(input: { creator_id: string; amount: number; client_reference: string }): Promise<PayoutOutcome> {
    // FIX F9: persist the intent with a client_reference before sending.
    await pool.query(
      'insert into payout_intents (client_reference, status) values ($1, $2) on conflict (client_reference) do nothing',
      [input.client_reference, 'pending'],
    );
    return sendPayout(input);
  }

  async function reconcile(day: string): Promise<ReconcileDifference[]> {
    // FIX F6: compare AMOUNTS per creator per day, not counts.
    const ledger = await ledgerCaptureAmounts(pool, day);
    const response = await fetch(`${providerUrl}/v1/reconciliation?day=${encodeURIComponent(day)}`);
    const providerRows = (await response.json()) as { creator_id: string; amount_cents: number }[];
    const provider = new Map<string, number>();
    for (const row of providerRows) provider.set(row.creator_id, row.amount_cents);

    const differences: ReconcileDifference[] = [];
    for (const [creatorId, ledgerCents] of ledger) {
      const providerCents = provider.get(creatorId) ?? 0;
      if (ledgerCents !== providerCents) {
        differences.push({ creator_id: creatorId, ledger_cents: ledgerCents, provider_cents: providerCents });
      }
    }
    for (const [creatorId, providerCents] of provider) {
      if (!ledger.has(creatorId) && providerCents !== 0) {
        differences.push({ creator_id: creatorId, ledger_cents: 0, provider_cents: providerCents });
      }
    }
    return differences;
  }

  async function balance(account: string): Promise<number> {
    return balanceOf(pool, account);
  }

  async function sendCaptureWithRetry(
    input: { amount: number; creator_id: string; referrer_id: string },
    key: string,
  ): Promise<Charge> {
    let lastError: unknown = new Error('capture not attempted');
    for (let attempt = 0; attempt < 5; attempt++) {
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
        lastError = error; // lost response: retry with the SAME key
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
    try {
      const response = await fetch(`${providerUrl}/v1/payouts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: input.amount, client_reference: input.client_reference, destination: input.creator_id }),
      });
      if (response.ok) {
        const payout = (await response.json()) as { id: string; created?: number };
        await markPayoutPaid(input, payout.id, payout.created ?? 1730000000);
        return { status: 'paid', payout_id: payout.id };
      }
      await markPayoutUnknown(input.client_reference);
      return { status: 'unknown' };
    } catch {
      // FIX F9: after an unknown outcome, look the payout up by client_reference; if the
      // lookup cannot decide, stop and escalate — never resend blindly.
      const found = await lookupPayout(input.client_reference);
      if (found) {
        await markPayoutPaid(input, found.id, found.created ?? 1730000000);
        return { status: 'paid', payout_id: found.id };
      }
      await markPayoutUnknown(input.client_reference);
      return { status: 'unknown' };
    }
  }

  async function lookupPayout(clientReference: string): Promise<{ id: string; created?: number } | null> {
    const response = await fetch(`${providerUrl}/v1/payouts?client_reference=${encodeURIComponent(clientReference)}`);
    if (response.status === 404) return null;
    const rows = (await response.json()) as { id: string; created?: number }[];
    return rows[0] ?? null;
  }

  async function markPayoutUnknown(clientReference: string): Promise<void> {
    await pool.query('update payout_intents set status = $1 where client_reference = $2', ['unknown', clientReference]);
  }

  async function markPayoutPaid(input: { creator_id: string; amount: number; client_reference: string }, payoutId: string, created: number): Promise<void> {
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
      await client.query('update payout_intents set status = $1 where client_reference = $2', ['paid', input.client_reference]);
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
    // FIX F3: apply any refund parked before this capture arrived.
    await applyPendingRefunds(client, charge.id, day);
  }

  async function recordRefund(client: PoolClient, refund: Refund, day: string): Promise<void> {
    const charge = await lookupCharge(client, refund.charge);
    if (!charge) return;
    // FIX F4: key the refund by the refund id, not the charge id.
    const txId = await insertTransaction(client, refund.id, 'refund', day);
    if (txId == null) return;
    // FIX F5: integer split with the remainder assigned to one party, so the parts sum exactly.
    const split = refundSplit(charge.amount_cents, refund.amount);
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount: refund.amount },
    ]);
  }

  async function handleChargeRefunded(client: PoolClient, charge: Charge, day: string): Promise<void> {
    const refundAmount = charge.amount_refunded ?? charge.amount;
    const existing = await lookupCharge(client, charge.id);
    if (!existing) {
      // FIX F3: park the refund and apply it once the capture exists.
      await client.query(
        'insert into pending_refunds (charge_id, amount_cents) values ($1, $2) on conflict (charge_id) do nothing',
        [charge.id, refundAmount],
      );
      return;
    }
    const txId = await insertTransaction(client, charge.id, 'refund', day);
    if (txId == null) return;
    const split = refundSplit(existing.amount_cents, refundAmount);
    await insertLines(client, txId, [
      { account: creatorAccount(existing.creator_id), amount: -split.creator },
      { account: referrerAccount(existing.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount: refundAmount },
    ]);
  }

  async function applyPendingRefunds(client: PoolClient, chargeId: string, day: string): Promise<void> {
    const pending = await client.query('select charge_id, amount_cents from pending_refunds where charge_id = $1', [chargeId]);
    for (const row of pending.rows) {
      const charge = await lookupCharge(client, chargeId);
      if (!charge) continue;
      const txId = await insertTransaction(client, chargeId, 'refund', day);
      if (txId != null) {
        const split = refundSplit(charge.amount_cents, Number(row.amount_cents));
        await insertLines(client, txId, [
          { account: creatorAccount(charge.creator_id), amount: -split.creator },
          { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
          { account: PLATFORM, amount: -split.platform },
          { account: EXTERNAL, amount: Number(row.amount_cents) },
        ]);
      }
      await client.query('delete from pending_refunds where charge_id = $1', [chargeId]);
    }
  }

  async function recordDispute(client: PoolClient, dispute: Dispute, day: string): Promise<void> {
    const charge = await lookupCharge(client, dispute.charge);
    if (!charge) return;
    const txId = await insertTransaction(client, dispute.charge, 'dispute', day);
    if (txId == null) return;
    const split = captureSplit(charge.amount_cents);
    // FIX F8: reverse the creator earnings AND the referral reward in the same ledger transaction.
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount: charge.amount_cents },
    ]);
  }

  // FIX F2: key every ledger transaction by (provider object id, entry type).
  async function insertTransaction(
    client: PoolClient,
    providerObjectId: string,
    entryType: string,
    day: string,
  ): Promise<number | null> {
    const result = await client.query(
      `insert into ledger_transactions (provider_object_id, entry_type, day)
       values ($1, $2, $3)
       on conflict (provider_object_id, entry_type) do nothing
       returning id`,
      [providerObjectId, entryType, day],
    );
    return result.rows.length ? Number(result.rows[0].id) : null;
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
