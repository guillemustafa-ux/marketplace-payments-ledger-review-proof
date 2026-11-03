import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const F_NAMES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'];

export const SEVERITY = {
  F1: 'Critical',
  F2: 'Critical',
  F3: 'High',
  F4: 'High',
  F5: 'Medium',
  F6: 'High',
  F7: 'Critical',
  F8: 'Medium',
  F9: 'Critical',
};

export const FINDINGS = {
  F1: {
    title: 'A redelivered webhook event credits the creator twice',
    fix: 'Store each event id under a unique constraint in the same transaction as its ledger entries, so a redelivered event is a no-op.',
  },
  F2: {
    title: 'Two events for one occurrence credit the creator twice',
    fix: 'Key every ledger transaction by (provider object id, entry type), so two events that describe the same occurrence produce one transaction.',
  },
  F3: {
    title: 'An out-of-order refund is dropped and the creator keeps the full earnings',
    fix: 'Park a refund that arrives before its capture and apply it once the capture exists.',
  },
  F4: {
    title: 'A second partial refund is dropped as a duplicate',
    fix: 'Key refunds by the refund id, not by (charge id, type).',
  },
  F5: {
    title: 'A partial refund rounds each line and drifts by cents',
    fix: 'Split with integer math and assign the remainder to one party, so the parts sum exactly to the refund.',
  },
  F6: {
    title: 'Reconciliation compares counts, so an amount drift stays green',
    fix: 'Compare the amount per creator and per day between the ledger and the provider.',
  },
  F7: {
    title: 'A lost capture response is retried with a fresh idempotency key',
    fix: 'Generate one idempotency key per money movement, store it before the first send, and reuse it on every retry.',
  },
  F8: {
    title: 'A dispute reverses the creator earnings but leaves the referral reward paid',
    fix: 'Reverse the creator earnings and the referral reward in the same ledger transaction.',
  },
  F9: {
    title: 'An unknown payout outcome is retried blindly and pays twice',
    fix: 'Persist the payout intent with a client_reference before sending; after an unknown outcome look it up by client_reference, and stop and escalate if the lookup cannot decide.',
  },
};

/** The finding id (F1..F9) named in a test title, or null (controls have none). */
export function findingId(name) {
  const match = /\bF([1-9])\b/.exec(name);
  return match ? `F${match[1]}` : null;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Locations of `// <kind> F<n>` markers under src/<version>, as "file:line" (computed, never
 * typed). `kind` is DEFECT for src/v1 and FIX for src/v2.
 */
export function locateMarkers(version, kind) {
  const locations = {};
  const counts = {};
  const pattern = new RegExp(`//\\s*${kind}\\s+(F[1-9])`);
  for (const file of walk(join(root, 'src', version))) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const match = pattern.exec(line);
        if (!match) return;
        locations[match[1]] = `${relative(root, file).replace(/\\/g, '/')}:${index + 1}`;
        counts[match[1]] = (counts[match[1]] ?? 0) + 1;
      });
  }
  return { locations, counts };
}

/** Spec titles declared in test/spec.test.ts: `it('...')`. */
export function specTitles() {
  const source = readFileSync(join(root, 'test', 'spec.test.ts'), 'utf8');
  return [...source.matchAll(/^\s*it\('([^']+)'/gm)].map((m) => m[1]);
}
