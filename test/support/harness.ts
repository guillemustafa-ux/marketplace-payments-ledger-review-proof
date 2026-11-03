import pg from 'pg';
import { startApp, type RunningApp } from '../../src/common/app.js';
import { truncateAll } from '../../src/common/db.js';
import { startFakeProvider, type FakeProvider } from '../../src/common/fake-provider.js';
import { dayOf } from '../../src/common/math.js';
import type { WebhookEvent } from '../../src/common/types.js';
import { signPayload } from '../../src/common/webhook.js';
import { createV2Ledger } from '../../src/v2/ledger.js';

export const WEBHOOK_SECRET = 'whsec_test_secret';
/** Fixed Unix-seconds clock so reconciliation days are deterministic. */
export const CREATED = 1730000000;
export const DAY = dayOf(CREATED);

export interface Harness {
  appUrl: string;
  provider: FakeProvider;
  pool: pg.Pool;
  truncate(): Promise<void>;
  deliver(event: WebhookEvent): Promise<Response>;
  /** Sign with an arbitrary secret (the tampered-payload control uses the wrong one). */
  deliverWithSecret(event: WebhookEvent, secret: string): Promise<Response>;
  close(): Promise<void>;
}

export async function startHarness(databaseUrl: string): Promise<Harness> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const provider = await startFakeProvider();
  const ledger = createV2Ledger({ pool, providerUrl: provider.url });
  const app: RunningApp = await startApp({ ledger, webhookSecret: WEBHOOK_SECRET });

  return {
    appUrl: app.url,
    provider,
    pool,
    truncate: () => truncateAll(pool),
    deliver: (event) => postWebhook(app.url, event, WEBHOOK_SECRET),
    deliverWithSecret: (event, secret) => postWebhook(app.url, event, secret),
    close: async () => {
      await app.close();
      await provider.close();
      await pool.end();
    },
  };
}

async function postWebhook(appUrl: string, event: WebhookEvent, secret: string): Promise<Response> {
  const body = JSON.stringify(event);
  const t = event.created;
  return fetch(`${appUrl}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(body, secret, t) },
    body,
  });
}
