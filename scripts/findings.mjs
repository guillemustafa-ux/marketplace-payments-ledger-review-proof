import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const F_NAMES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'];

export const SEVERITY = {
  F1: 'Medium',
  F2: 'Critical',
  F3: 'High',
  F4: 'High',
  F5: 'Medium',
  F6: 'High',
  F7: 'Critical',
  F8: 'Medium',
  F9: 'Critical',
};

export const SEVERITY_SCALE = {
  Critical: 'money created or destroyed with no trace',
  High: 'a wrong balance that only a manual audit would find',
  Medium: 'a smaller or partial error, or a missing second line of defence',
};

export const FINDINGS = {
  F1: {
    title: 'A redelivered webhook event is processed a second time (on v1 it doubles the credit only because F2 is also open)',
    fix: 'Store each event id under a unique constraint in the same transaction as its ledger entries, so a redelivered event is a no-op. With F2 fixed this is a second line of defence with no money effect of its own.',
  },
  F2: {
    title: 'Two events for one occurrence credit the creator twice',
    fix: 'Key every ledger transaction by (provider object id, entry type), so two events that describe the same occurrence produce one transaction.',
  },
  F3: {
    title: 'A refund or dispute that arrives before its capture is dropped, and the creator keeps the earnings',
    fix: 'Park an early refund or dispute and apply it once the capture exists.',
  },
  F4: {
    title: 'A second partial refund is dropped as a duplicate',
    fix: 'Key refunds by the refund id, not by (charge id, type).',
  },
  F5: {
    title: 'Partial refunds round each line, drift by cents and do not add back to zero',
    fix: 'Split each refund against the running total already reversed on the charge, so its parts sum exactly to it and a charge refunded in full, in one part or several, leaves every party at zero.',
  },
  F6: {
    title: 'Reconciliation compares counts, so an amount drift stays green',
    fix: 'Compare the amount per creator and per day between the ledger and the provider.',
  },
  F7: {
    title: 'A lost capture response is retried with a fresh idempotency key',
    fix: 'Store one idempotency key per order before the first send, and reuse it on every retry and on a repeated request for the same order.',
  },
  F8: {
    title: 'A dispute reverses the creator earnings but leaves the referral reward and the platform share in place',
    fix: 'Reverse a dispute like a refund: creator earnings, referral reward and platform share together, in one ledger transaction.',
  },
  F9: {
    title: 'An unknown payout outcome is retried blindly and pays twice',
    fix: 'Persist the payout intent with its client_reference before sending and read it on every request; after an unknown outcome look the payout up by client_reference and send only when the provider has none.',
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
