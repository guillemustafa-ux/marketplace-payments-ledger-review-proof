import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Charge, Dispute, Refund, WebhookEvent } from '../src/common/types.js';
import { CREATED, DAY, startHarness, type Harness } from './support/harness.js';

const CREATOR = 'creator_a';
const REFERRER = 'creator_r';
const creatorAccount = `creator:${CREATOR}`;
const referrerAccount = `referrer:${REFERRER}`;
const platformAccount = 'platform';

function charge(id: string, amount: number, creator = CREATOR, referrer = REFERRER): Charge {
  return { id, object: 'charge', amount, currency: 'usd', metadata: { creator_id: creator, referrer_id: referrer } };
}

function refund(id: string, amount: number, chargeId: string): Refund {
  return { id, object: 'refund', amount, charge: chargeId, currency: 'usd' };
}

function dispute(id: string, chargeId: string, amount: number): Dispute {
  return { id, object: 'dispute', charge: chargeId, amount, currency: 'usd' };
}

function chargeEvent(id: string, object: Charge, created = CREATED): WebhookEvent {
  return { id, type: 'charge.succeeded', created, data: { object } };
}

function refundEvent(id: string, object: Refund, created = CREATED): WebhookEvent {
  return { id, type: 'refund.created', created, data: { object } };
}

function chargeRefundedEvent(id: string, object: Charge, created = CREATED): WebhookEvent {
  return { id, type: 'charge.refunded', created, data: { object } };
}

function disputeEvent(id: string, object: Dispute, created = CREATED): WebhookEvent {
  return { id, type: 'charge.dispute.created', created, data: { object } };
}

/** Record the number a failing spec actually observed, so the review can report it. */
function record(finding: string, what: string, observed: number, expected: number): void {
  const file = process.env.OBSERVED_FILE;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ finding, what, observed, expected })}\n`, 'utf8');
}

describe('payments ledger review', () => {
  let h: Harness;

  beforeEach(async () => {
    const databaseUrl = inject('databaseUrl');
    h = await startHarness(databaseUrl);
    await h.truncate();
  });

  afterEach(async () => {
    await h.close();
  });

  /** Deliver a signed webhook and require that the app accepted it (HTTP 200). */
  async function send(event: WebhookEvent): Promise<void> {
    const response = await h.deliver(event);
    expect(response.status, `webhook ${event.id} (${event.type})`).toBe(200);
  }

  async function balance(account: string): Promise<number> {
    const response = await fetch(`${h.appUrl}/balance?account=${encodeURIComponent(account)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { balance_cents: number };
    return body.balance_cents;
  }

  async function reconcile(): Promise<{ creator_id: string; ledger_cents: number; provider_cents: number }[]> {
    const response = await fetch(`${h.appUrl}/reconcile?day=${encodeURIComponent(DAY)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { differences: { creator_id: string; ledger_cents: number; provider_cents: number }[] };
    return body.differences;
  }

  async function transactions(entryType: string): Promise<number> {
    const result = await h.pool.query('select count(*)::int as n from ledger_transactions where entry_type = $1', [entryType]);
    return Number(result.rows[0].n);
  }

  async function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${h.appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  it('CONTROL happy path totals', async () => {
    await send(chargeEvent('evt_capture', charge('ch_1', 1000)));
    expect(await balance(creatorAccount)).toBe(800);
    expect(await balance(referrerAccount)).toBe(20);
    expect(await balance(platformAccount)).toBe(180);
  });

  it('CONTROL tampered payload is rejected', async () => {
    const response = await h.deliverWithSecret(chargeEvent('evt_tampered', charge('ch_1', 1000)), 'whsec_wrong_secret');
    expect(response.status).toBe(401);
    expect(await balance(creatorAccount)).toBe(0);
    expect(await balance(referrerAccount)).toBe(0);
    expect(await balance(platformAccount)).toBe(0);
  });

  it('CONTROL clean ledger reconciles clean', async () => {
    const c = charge('ch_1', 1000);
    h.provider.seedCapture({ id: c.id, amount: c.amount, creator_id: c.metadata.creator_id, referrer_id: c.metadata.referrer_id, created: CREATED });
    await send(chargeEvent('evt_capture', c));
    expect(await reconcile()).toEqual([]);
  });

  it('CONTROL a refund announced by refund.created and charge.refunded is reversed once', async () => {
    await send(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await send(refundEvent('evt_refund', refund('re_1', 1000, 'ch_1')));
    await send(chargeRefundedEvent('evt_charge_refunded', charge('ch_1', 1000)));
    expect(await balance(creatorAccount)).toBe(0);
    expect(await balance(referrerAccount)).toBe(0);
    expect(await balance(platformAccount)).toBe(0);
    expect(await balance('external')).toBe(0);
    expect(await transactions('refund')).toBe(1);
  });

  it('F1 a redelivered event is recorded once and credits the creator once', async () => {
    const event = chargeEvent('evt_1', charge('ch_1', 1000));
    await send(event);
    await send(event);
    const got = await balance(creatorAccount);
    record('F1', 'creator balance (cents)', got, 800);
    expect(got).toBe(800);
    // F1's fix records the event id under a unique constraint, so a redelivered event is
    // skipped before it reaches the ledger. With F2's key in place the balance above stays
    // right even without F1's fix; this row is what F1's fix adds.
    const events = await h.pool.query('select count(*)::int as n from webhook_events where event_id = $1', ['evt_1']);
    expect(Number(events.rows[0].n)).toBe(1);
  });

  it('F2 two events for one occurrence credit the creator once', async () => {
    const c = charge('ch_1', 1000);
    await send(chargeEvent('evt_1', c));
    await send(chargeEvent('evt_2', c));
    const got = await balance(creatorAccount);
    record('F2', 'creator balance (cents)', got, 800);
    expect(got).toBe(800);
  });

  it('F3 a refund or dispute that arrives before its capture is applied once the capture exists', async () => {
    // ch_1: a full refund arrives before the capture.
    await send(refundEvent('evt_refund', refund('re_1', 1000, 'ch_1')));
    await send(chargeEvent('evt_capture_1', charge('ch_1', 1000)));
    // ch_2 (another creator and referrer): a dispute arrives before the capture.
    await send(disputeEvent('evt_dispute', dispute('di_1', 'ch_2', 1000)));
    await send(chargeEvent('evt_capture_2', charge('ch_2', 1000, 'creator_b', 'creator_s')));
    const got = await balance(creatorAccount);
    record('F3', 'creator balance after an early refund (cents)', got, 0);
    expect(got).toBe(0);
    expect(await balance(referrerAccount)).toBe(0);
    expect(await balance('creator:creator_b')).toBe(0);
    expect(await transactions('capture')).toBe(2);
    expect(await transactions('refund')).toBe(1);
    expect(await transactions('dispute')).toBe(1);
  });

  it('F4 a second partial refund is applied', async () => {
    await send(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await send(refundEvent('evt_r1', refund('re_1', 300, 'ch_1')));
    await send(refundEvent('evt_r2', refund('re_2', 300, 'ch_1')));
    const got = await balance(creatorAccount);
    record('F4', 'creator balance (cents)', got, 320);
    expect(got).toBe(320);
    expect(await balance(referrerAccount)).toBe(8);
    expect(await balance(platformAccount)).toBe(72);
  });

  it('F5 partial refunds split without rounding drift and a full refund in parts ends at zero', async () => {
    await send(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await send(refundEvent('evt_r', refund('re_1', 13, 'ch_1')));
    const got = await balance(platformAccount);
    record('F5', 'platform balance (cents)', got, 177);
    expect(await balance(creatorAccount)).toBe(790);
    expect(await balance(referrerAccount)).toBe(20);
    expect(got).toBe(177);
    // ch_2 (another creator and referrer) is refunded in full in three parts: every party
    // derived from it must end at zero (invariant I3).
    await send(chargeEvent('evt_capture_2', charge('ch_2', 1000, 'creator_c', 'creator_t')));
    await send(refundEvent('evt_p1', refund('re_p1', 333, 'ch_2')));
    await send(refundEvent('evt_p2', refund('re_p2', 333, 'ch_2')));
    await send(refundEvent('evt_p3', refund('re_p3', 334, 'ch_2')));
    expect(await balance('creator:creator_c')).toBe(0);
    expect(await balance('referrer:creator_t')).toBe(0);
    expect(await balance(platformAccount)).toBe(177);
  });

  it('F6 reconciliation flags an amount drift per creator', async () => {
    const c = charge('ch_1', 1000);
    h.provider.seedCapture({ id: c.id, amount: c.amount, creator_id: c.metadata.creator_id, referrer_id: c.metadata.referrer_id, created: CREATED });
    await send(chargeEvent('evt_capture', c));
    await h.pool.query('update ledger_lines set amount_cents = 700 where account = $1', [creatorAccount]);
    const diffs = await reconcile();
    record('F6', 'reconciliation differences reported', diffs.length, 1);
    expect(diffs).toEqual([{ creator_id: CREATOR, ledger_cents: 700, provider_cents: 800 }]);
  });

  it('F7 a lost capture response and a repeated order capture once', async () => {
    const order = { order_id: 'ord_1', amount: 1000, creator_id: CREATOR, referrer_id: REFERRER };
    h.provider.failNextCapture('drop-response');
    const first = await postJson('/capture', order);
    expect(first.status).toBe(200);
    const second = await postJson('/capture', order);
    expect(second.status).toBe(200);
    const count = h.provider.captureCount();
    const total = h.provider.totalCapturedCents();
    record('F7', 'captures created', count, 1);
    record('F7', 'total captured (cents)', total, 1000);
    expect(count).toBe(1);
    expect(total).toBe(1000);
    expect(await balance(creatorAccount)).toBe(800);
  });

  it('F8 a dispute reverses the creator earnings, the referral reward and the platform share', async () => {
    await send(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await send(disputeEvent('evt_disp', dispute('di_1', 'ch_1', 1000)));
    const got = await balance(referrerAccount);
    record('F8', 'referral balance (cents)', got, 0);
    record('F8', 'platform balance (cents)', await balance(platformAccount), 0);
    expect(await balance(creatorAccount)).toBe(0);
    expect(got).toBe(0);
    expect(await balance(platformAccount)).toBe(0);
  });

  it('F9 an unknown payout outcome is looked up and a repeated payout request pays once', async () => {
    const request = { creator_id: CREATOR, amount: 800, client_reference: 'po_1' };
    h.provider.failNextPayout('drop-response');
    const first = await postJson('/payout', request);
    expect(first.status).toBe(200);
    expect(first.json.status).toBe('paid');
    const second = await postJson('/payout', request);
    expect(second.status).toBe(200);
    expect(second.json.status).toBe('paid');
    const count = h.provider.payoutCount();
    record('F9', 'payouts created', count, 1);
    expect(count).toBe(1);
    expect(h.provider.payoutsByReference('po_1').length).toBe(1);
    expect(await balance(creatorAccount)).toBe(-800);
  });
});
