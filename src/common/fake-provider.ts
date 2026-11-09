import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureSplit, dayOf } from './math.js';

export interface ProviderCapture {
  id: string;
  idempotency_key: string;
  amount: number;
  creator_id: string;
  referrer_id: string;
  created: number;
}

export interface ProviderPayout {
  id: string;
  client_reference: string;
  amount: number;
  destination: string;
  created: number;
}

export type CaptureFault = 'drop-response';
/**
 * drop-response: the payout is made, then the connection drops (the client sees an error).
 * error-after-commit: the payout is made, then the provider answers 500.
 * error-before-commit: the provider answers 500 and makes no payout.
 */
export type PayoutFault = 'drop-response' | 'error-after-commit' | 'error-before-commit';

export interface FakeProvider {
  url: string;
  close(): Promise<void>;
  failNextCapture(fault: CaptureFault): void;
  failNextPayout(fault: PayoutFault): void;
  seedCapture(input: { id: string; amount: number; creator_id: string; referrer_id: string; created: number }): void;
  captureCount(): number;
  totalCapturedCents(): number;
  payoutCount(): number;
  payoutsByReference(clientReference: string): ProviderPayout[];
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const captures: ProviderCapture[] = [];
  const capturesByKey = new Map<string, ProviderCapture>();
  const payouts: ProviderPayout[] = [];
  const captureFaults: CaptureFault[] = [];
  const payoutFaults: PayoutFault[] = [];
  let seq = 0;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/v1/captures') return handleCapture(req, res);
    if (method === 'POST' && url.pathname === '/v1/payouts') return handlePayout(req, res);
    if (method === 'GET' && url.pathname === '/v1/payouts') return handlePayoutLookup(url, res);
    if (method === 'GET' && url.pathname === '/v1/reconciliation') return handleReconciliation(url, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  async function handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = String(req.headers['idempotency-key'] ?? '');
    const body = (await readJson(req)) as { amount: number; creator_id: string; referrer_id: string };
    if (!key) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing idempotency key' }));
      return;
    }
    // Same idempotency key returns the same stored response (a lost response is retried safely).
    const existing = capturesByKey.get(key);
    if (existing) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(captureJson(existing)));
      return;
    }
    const capture: ProviderCapture = {
      id: `ch_${++seq}`,
      idempotency_key: key,
      amount: body.amount,
      creator_id: body.creator_id,
      referrer_id: body.referrer_id,
      created: 1730000000 + seq,
    };
    captures.push(capture);
    capturesByKey.set(key, capture);

    const fault = captureFaults.shift();
    if (fault === 'drop-response') {
      // Committed, then the response is dropped: the client sees a lost response.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(captureJson(capture)));
  }

  async function handlePayout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { amount: number; client_reference: string; destination: string };
    const fault = payoutFaults.shift();
    if (fault === 'error-before-commit') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'provider_error' }));
      return;
    }
    const payout: ProviderPayout = {
      id: `po_${++seq}`,
      client_reference: body.client_reference,
      amount: body.amount,
      destination: body.destination,
      created: 1730000000 + seq,
    };
    payouts.push(payout);
    if (fault === 'drop-response') {
      // Committed, then the response is dropped: an unknown outcome for the client.
      req.socket.destroy();
      return;
    }
    if (fault === 'error-after-commit') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'provider_error' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payoutJson(payout)));
  }

  function handlePayoutLookup(url: URL, res: ServerResponse): void {
    const reference = url.searchParams.get('client_reference') ?? '';
    const matches = payouts.filter((p) => p.client_reference === reference);
    if (matches.length === 0) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(matches.map(payoutJson)));
  }

  function handleReconciliation(url: URL, res: ServerResponse): void {
    const day = url.searchParams.get('day') ?? '';
    const byCreator = new Map<string, number>();
    for (const capture of captures) {
      if (dayOf(capture.created) !== day) continue;
      const split = captureSplit(capture.amount);
      byCreator.set(capture.creator_id, (byCreator.get(capture.creator_id) ?? 0) + split.creator);
    }
    const rows = [...byCreator.entries()].map(([creator_id, amount_cents]) => ({ creator_id, amount_cents }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    failNextCapture: (fault) => captureFaults.push(fault),
    failNextPayout: (fault) => payoutFaults.push(fault),
    seedCapture: (input) => {
      captures.push({
        id: input.id,
        idempotency_key: `seed:${input.id}`,
        amount: input.amount,
        creator_id: input.creator_id,
        referrer_id: input.referrer_id,
        created: input.created,
      });
    },
    captureCount: () => captures.length,
    totalCapturedCents: () => captures.reduce((sum, c) => sum + c.amount, 0),
    payoutCount: () => payouts.length,
    payoutsByReference: (ref) => payouts.filter((p) => p.client_reference === ref),
  };
}

function captureJson(capture: ProviderCapture): Record<string, unknown> {
  return {
    id: capture.id,
    object: 'charge',
    amount: capture.amount,
    currency: 'usd',
    metadata: { creator_id: capture.creator_id, referrer_id: capture.referrer_id },
    created: capture.created,
  };
}

function payoutJson(payout: ProviderPayout): Record<string, unknown> {
  return {
    id: payout.id,
    object: 'payout',
    amount: payout.amount,
    currency: 'usd',
    client_reference: payout.client_reference,
    destination: payout.destination,
    created: payout.created,
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return readBody(req).then((body) => (body ? JSON.parse(body) : {}));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
