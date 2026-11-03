// Domain types shared by both versions. Amounts are integer cents, USD only.

export interface Charge {
  id: string;
  object: 'charge';
  amount: number;
  currency: string;
  created?: number;
  /** Present on `charge.refunded`: the total already refunded on this charge, in cents. */
  amount_refunded?: number;
  metadata: {
    creator_id: string;
    referrer_id: string;
  };
}

export interface Refund {
  id: string;
  object: 'refund';
  amount: number;
  charge: string;
  currency: string;
}

export interface Dispute {
  id: string;
  object: 'dispute';
  charge: string;
  amount: number;
  currency: string;
}

export interface Payout {
  id: string;
  object: 'payout';
  amount: number;
  currency: string;
  client_reference?: string;
  destination?: string;
}

export type ProviderObject = Charge | Refund | Dispute | Payout;

/** A Stripe-shaped event: `{ id, type, created, data: { object } }`. */
export interface WebhookEvent {
  id: string;
  type: string;
  /** Unix seconds. Used as the reconciliation day and the event id (never for ordering). */
  created: number;
  data: { object: ProviderObject };
}

export type EntryType = 'capture' | 'refund' | 'dispute' | 'payout';

export interface CaptureSplit {
  creator: number;
  referrer: number;
  platform: number;
  fee: number;
}

export interface RefundSplit {
  creator: number;
  referrer: number;
  platform: number;
}

export interface ReconcileDifference {
  creator_id: string;
  ledger_cents: number;
  provider_cents: number;
}

export interface PayoutOutcome {
  status: 'paid' | 'unknown';
  payout_id?: string;
}

/** The `Ledger` interface both versions implement; the HTTP shell delegates to it. */
export interface Ledger {
  handleWebhook(event: WebhookEvent): Promise<void>;
  capture(input: { amount: number; creator_id: string; referrer_id: string }): Promise<{ ok: boolean }>;
  payout(input: { creator_id: string; amount: number; client_reference: string }): Promise<PayoutOutcome>;
  reconcile(day: string): Promise<ReconcileDifference[]>;
  balance(account: string): Promise<number>;
}
