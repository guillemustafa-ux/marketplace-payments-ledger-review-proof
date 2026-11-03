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

  it('CONTROL happy path totals', async () => {
    await h.deliver(chargeEvent('evt_capture', charge('ch_1', 1000)));
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
    await h.deliver(chargeEvent('evt_capture', c));
    expect(await reconcile()).toEqual([]);
  });

  it('F1 a redelivered event credits the creator once', async () => {
    const event = chargeEvent('evt_1', charge('ch_1', 1000));
    await h.deliver(event);
    await h.deliver(event);
    expect(await balance(creatorAccount)).toBe(800);
  });

  it('F2 two events for one occurrence credit the creator once', async () => {
    const c = charge('ch_1', 1000);
    await h.deliver(chargeEvent('evt_1', c));
    await h.deliver(chargeEvent('evt_2', c));
    expect(await balance(creatorAccount)).toBe(800);
  });

  it('F3 an out-of-order refund is applied once the capture exists', async () => {
    const refunded = { ...charge('ch_1', 1000), amount_refunded: 1000 };
    await h.deliver(chargeRefundedEvent('evt_refund', refunded));
    await h.deliver(chargeEvent('evt_capture', charge('ch_1', 1000)));
    expect(await balance(creatorAccount)).toBe(0);
  });

  it('F4 a second partial refund is applied', async () => {
    await h.deliver(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await h.deliver(refundEvent('evt_r1', refund('re_1', 300, 'ch_1')));
    await h.deliver(refundEvent('evt_r2', refund('re_2', 300, 'ch_1')));
    expect(await balance(creatorAccount)).toBe(320);
    expect(await balance(referrerAccount)).toBe(8);
    expect(await balance(platformAccount)).toBe(72);
  });

  it('F5 a partial refund splits without rounding drift', async () => {
    await h.deliver(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await h.deliver(refundEvent('evt_r', refund('re_1', 13, 'ch_1')));
    expect(await balance(creatorAccount)).toBe(790);
    expect(await balance(referrerAccount)).toBe(20);
    expect(await balance(platformAccount)).toBe(177);
  });

  it('F6 reconciliation flags an amount drift per creator', async () => {
    const c = charge('ch_1', 1000);
    h.provider.seedCapture({ id: c.id, amount: c.amount, creator_id: c.metadata.creator_id, referrer_id: c.metadata.referrer_id, created: CREATED });
    await h.deliver(chargeEvent('evt_capture', c));
    await h.pool.query('update ledger_lines set amount_cents = 700 where account = $1', [creatorAccount]);
    expect(await reconcile()).toEqual([{ creator_id: CREATOR, ledger_cents: 700, provider_cents: 800 }]);
  });

  it('F7 a lost capture response is retried with one idempotency key', async () => {
    h.provider.failNextCapture('drop-response');
    const response = await fetch(`${h.appUrl}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1000, creator_id: CREATOR, referrer_id: REFERRER }),
    });
    expect(response.status).toBe(200);
    expect(h.provider.captureCount()).toBe(1);
    expect(h.provider.totalCapturedCents()).toBe(1000);
  });

  it('F8 a dispute reverses the referral reward', async () => {
    await h.deliver(chargeEvent('evt_capture', charge('ch_1', 1000)));
    await h.deliver(disputeEvent('evt_disp', dispute('di_1', 'ch_1', 1000)));
    expect(await balance(creatorAccount)).toBe(0);
    expect(await balance(referrerAccount)).toBe(0);
    expect(await balance(platformAccount)).toBe(0);
  });

  it('F9 an unknown payout outcome is looked up, not retried blindly', async () => {
    h.provider.failNextPayout('drop-response');
    const response = await fetch(`${h.appUrl}/payout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creator_id: CREATOR, amount: 800, client_reference: 'po_1' }),
    });
    expect(response.status).toBe(200);
    expect(h.provider.payoutCount()).toBe(1);
    expect(h.provider.payoutsByReference('po_1').length).toBe(1);
  });
});
