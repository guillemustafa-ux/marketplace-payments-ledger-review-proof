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
});
