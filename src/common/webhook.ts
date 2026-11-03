import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-shaped webhook signature: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Verification is a control present in BOTH versions, never a defect.
 */
export function signPayload(rawBody: string, secret: string, t: number): string {
  const signature = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${signature}`;
}

export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const values = new Map<string, string>();
  for (const element of header.split(',')) {
    const eq = element.indexOf('=');
    if (eq < 0) continue;
    values.set(element.slice(0, eq).trim(), element.slice(eq + 1).trim());
  }
  const t = values.get('t');
  const v1 = values.get('v1');
  if (!t || !v1) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'), 'hex');
  const received = Buffer.from(v1, 'hex');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
