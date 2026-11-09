import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { balanceOf, ledgerCaptureAmounts } from '../common/db.js';
import { captureSplit, dayOf, reversalSplit } from '../common/math.js';
import type {
  CaptureInput,
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

/** A refund or a dispute: money that goes back out of a captured charge. */
interface Reversal {
  kind: 'refund' | 'dispute';
  id: string;
  chargeId: string;
  amount: number;
}

interface PayoutInput {
  creator_id: string;
  amount: number;
  client_reference: string;
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
        const refund = event.data.object as Refund;
        // FIX F4: key the refund by the refund id, not the charge id.
        await reverse(client, { kind: 'refund', id: refund.id, chargeId: refund.charge, amount: refund.amount }, day);
      } else if (event.type === 'charge.dispute.created') {
        const dispute = event.data.object as Dispute;
        await reverse(client, { kind: 'dispute', id: dispute.id, chargeId: dispute.charge, amount: dispute.amount }, day);
      }
      // `charge.refunded` carries the charge, not the refund. Money moves from `refund.created`
      // only, so one refund is never reversed twice from two event types.
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function capture(input: CaptureInput): Promise<{ ok: boolean }> {
    // FIX F7: one idempotency key per order, stored before the first send and reused on every retry.
    await pool.query('insert into capture_intents (order_id, idempotency_key) values ($1, $2) on conflict (order_id) do nothing', [
      input.order_id,
      randomUUID(),
    ]);
    const intent = await pool.query('select idempotency_key from capture_intents where order_id = $1', [input.order_id]);
    const charge = await sendCaptureWithRetry(input, String(intent.rows[0].idempotency_key));
    await recordCaptureFromApi(charge);
    return { ok: true };
  }

  async function payout(input: PayoutInput): Promise<PayoutOutcome> {
    // FIX F9: persist the payout intent before the first send and read it on every request.
    const inserted = await pool.query(
      'insert into payout_intents (client_reference, status) values ($1, $2) on conflict (client_reference) do nothing',
      [input.client_reference, 'pending'],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      const intent = await pool.query('select status, payout_id from payout_intents where client_reference = $1', [
        input.client_reference,
      ]);
      const row = intent.rows[0] as { status: string; payout_id: string | null };
      if (row.status === 'paid' && row.payout_id) return { status: 'paid', payout_id: row.payout_id };
      // Pending or unknown: an earlier send may have reached the provider, so ask it first.
      const found = await lookupPayout(input.client_reference);
      if (found) {
        await markPayoutPaid(input, found.id, found.created ?? 1730000000);
        return { status: 'paid', payout_id: found.id };
      }
      // The provider has no payout for this reference: sending it now cannot pay twice.
    }
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

  async function sendCaptureWithRetry(input: CaptureInput, key: string): Promise<Charge> {
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

  async function sendPayout(input: PayoutInput): Promise<PayoutOutcome> {
    try {
      const response = await fetch(`${providerUrl}/v1/payouts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: input.amount, client_reference: input.client_reference, destination: input.creator_id }),
      });
      if (response.ok) {
        const paid = (await response.json()) as { id: string; created?: number };
        await markPayoutPaid(input, paid.id, paid.created ?? 1730000000);
        return { status: 'paid', payout_id: paid.id };
      }
      await markPayoutUnknown(input.client_reference);
      return { status: 'unknown' };
    } catch {
      // Unknown outcome: look the payout up by client_reference. If the provider has none,
      // return unknown and do not resend here; the next request resolves it by lookup.
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

  async function markPayoutPaid(input: PayoutInput, payoutId: string, created: number): Promise<void> {
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
      await client.query('update payout_intents set status = $1, payout_id = $2 where client_reference = $3', [
        'paid',
        payoutId,
        input.client_reference,
      ]);
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
    await applyPendingReversals(client, charge.id);
  }

  async function reverse(client: PoolClient, reversal: Reversal, day: string): Promise<void> {
    const charge = await lookupCharge(client, reversal.chargeId);
    if (!charge) {
      // FIX F3: park a refund or dispute that arrives before its capture and apply it once the capture exists.
      await client.query(
        `insert into pending_reversals (provider_object_id, kind, charge_id, amount_cents, day)
         values ($1, $2, $3, $4, $5)
         on conflict (provider_object_id, kind) do nothing`,
        [reversal.id, reversal.kind, reversal.chargeId, reversal.amount, day],
      );
      return;
    }
    await applyReversal(client, reversal, charge, day);
  }

  async function applyPendingReversals(client: PoolClient, chargeId: string): Promise<void> {
    const charge = await lookupCharge(client, chargeId);
    if (!charge) return;
    const pending = await client.query(
      'select provider_object_id, kind, amount_cents, day from pending_reversals where charge_id = $1 order by id',
      [chargeId],
    );
    for (const row of pending.rows) {
      const reversal: Reversal = { kind: row.kind, id: row.provider_object_id, chargeId, amount: Number(row.amount_cents) };
      await applyReversal(client, reversal, charge, String(row.day));
    }
    await client.query('delete from pending_reversals where charge_id = $1', [chargeId]);
  }

  async function applyReversal(client: PoolClient, reversal: Reversal, charge: ChargeRecord, day: string): Promise<void> {
    const chargeAmount = Number(charge.amount_cents);
    const done = await client.query('select coalesce(sum(amount_cents), 0)::bigint as cents from reversals where charge_id = $1', [
      reversal.chargeId,
    ]);
    const alreadyReversed = Number(done.rows[0].cents);
    // A dispute takes back whatever is left of the charge; a refund never exceeds it.
    const amount = Math.min(reversal.amount, chargeAmount - alreadyReversed);
    if (amount <= 0) return;
    const txId = await insertTransaction(client, reversal.id, reversal.kind, day);
    if (txId == null) return;
    // FIX F5: split against the running total already reversed, so the parts sum exactly and a full reversal in parts ends at zero.
    const split = reversalSplit(chargeAmount, alreadyReversed, amount);
    // FIX F8: a dispute reverses the creator earnings, the referral reward and the platform share, like a refund.
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount },
    ]);
    await client.query('insert into reversals (provider_object_id, kind, charge_id, amount_cents) values ($1, $2, $3, $4)', [
      reversal.id,
      reversal.kind,
      reversal.chargeId,
      amount,
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
