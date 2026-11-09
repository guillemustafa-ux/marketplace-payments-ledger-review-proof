import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-shaped webhook signature: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Verification is a control present in BOTH versions, never a defect.
 */
export function signPayload(rawBody: string, secret: string, t: number): string {
  const signature = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${signature}`;
}

/**
 * Accepts the payload when ANY of the received `v1=` signatures matches, each compared in
 * constant time (docs/sources.md: "compare the expected signature to each of the received
 * signatures").
 */
export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  let t: string | undefined;
  const signatures: string[] = [];
  for (const element of header.split(',')) {
    const eq = element.indexOf('=');
    if (eq < 0) continue;
    const key = element.slice(0, eq).trim();
    const value = element.slice(eq + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!t || signatures.length === 0) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'), 'hex');
  let matched = false;
  for (const signature of signatures) {
    const received = Buffer.from(signature, 'hex');
    if (received.length === expected.length && timingSafeEqual(expected, received)) matched = true;
  }
  return matched;
}
