import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ledger, WebhookEvent } from './types.js';
import { verifySignature } from './webhook.js';

export interface AppConfig {
  ledger: Ledger;
  webhookSecret: string;
}

export interface RunningApp {
  url: string;
  close(): Promise<void>;
}

/** Plain node:http shell shared by both versions; every business rule lives in the Ledger. */
export async function startApp({ ledger, webhookSecret }: AppConfig): Promise<RunningApp> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/webhooks') return await handleWebhook(req, res);
      if (req.method === 'POST' && url.pathname === '/capture') return await handleCapture(req, res);
      if (req.method === 'POST' && url.pathname === '/payout') return await handlePayout(req, res);
      if (req.method === 'GET' && url.pathname === '/reconcile') return await handleReconcile(url, res);
      if (req.method === 'GET' && url.pathname === '/balance') return await handleBalance(url, res);
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    const signature = req.headers['stripe-signature'];
    if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, webhookSecret)) {
      send(res, 401, { error: 'invalid_signature' });
      return;
    }
    const event = JSON.parse(rawBody) as WebhookEvent;
    await ledger.handleWebhook(event);
    send(res, 200, { ok: true });
  }

  async function handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { amount: number; creator_id: string; referrer_id: string };
    const result = await ledger.capture(body);
    send(res, 200, result);
  }

  async function handlePayout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { creator_id: string; amount: number; client_reference: string };
    const result = await ledger.payout(body);
    send(res, 200, result);
  }

  async function handleReconcile(url: URL, res: ServerResponse): Promise<void> {
    const day = url.searchParams.get('day') ?? '';
    const differences = await ledger.reconcile(day);
    send(res, 200, { differences });
  }

  async function handleBalance(url: URL, res: ServerResponse): Promise<void> {
    const account = url.searchParams.get('account') ?? '';
    const balance = await ledger.balance(account);
    send(res, 200, { account, balance_cents: balance });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
