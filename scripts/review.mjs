import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { F_NAMES, FINDINGS, SEVERITY, findingId, locateMarkers, root } from './findings.mjs';
import { runVitest } from './run-vitest.mjs';

function readObserved(file) {
  if (!existsSync(file)) return {};
  const byFinding = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    (byFinding[entry.finding] ??= []).push(entry);
  }
  return byFinding;
}

function evidenceText(entries) {
  return (entries ?? [])
    .map((e) => `${e.what}: ${e.observed} (expected ${e.expected})`)
    .join('; ');
}

// 1. Run v1 and capture the observed numbers and the failed specs.
const observedDir = mkdtempSync(join(tmpdir(), 'payments-ledger-observed-'));
const observedFile = join(observedDir, 'observed.jsonl');
process.env.OBSERVED_FILE = observedFile;
const v1 = runVitest({ target: 'v1' });
delete process.env.OBSERVED_FILE;

if (v1.failed === undefined) {
  console.error('review: the v1 run produced no report (infrastructure failure).');
  process.exit(1);
}
const v1FindingIds = v1.failed.map(findingId);
const v1NonFinding = v1.failed.filter((name) => !findingId(name));
const distinctIds = new Set(v1FindingIds.filter(Boolean));
const exactlyNine =
  v1.failed.length === 9 && v1NonFinding.length === 0 && distinctIds.size === 9 && F_NAMES.every((f) => distinctIds.has(f));
if (!exactlyNine) {
  console.error(`review FAILED: expected exactly F1..F9 to fail on v1, got ${v1.failed.length} failure(s):`);
  for (const name of v1.failed) console.error(`  - ${name}`);
  process.exit(1);
}

const observed = readObserved(observedFile);
rmSync(observedDir, { recursive: true, force: true });

// 2. Run v2: everything must pass.
const v2 = runVitest({ target: 'v2' });
if (v2.failed === undefined) {
  console.error('review: the v2 run produced no report (infrastructure failure).');
  process.exit(1);
}
if (v2.failed.length > 0) {
  console.error(`review FAILED: ${v2.failed.length} spec(s) failed on v2:`);
  for (const name of v2.failed) console.error(`  - ${name}`);
  process.exit(1);
}

// 3. Locate the defects (computed from the // DEFECT F<n> markers, never typed).
const { locations } = locateMarkers('v1', 'DEFECT');
if (Object.keys(locations).length !== 9) {
  console.error(`review FAILED: expected 9 // DEFECT markers in src/v1, found ${Object.keys(locations).length}.`);
  process.exit(1);
}

// 4. Write the report.
const counts = { Critical: 0, High: 0, Medium: 0 };
for (const f of F_NAMES) counts[SEVERITY[f]] += 1;

const rows = F_NAMES.map((f, index) => {
  const meta = FINDINGS[f];
  const evidence = evidenceText(observed[f]);
  const location = locations[f];
  const spec = v1.failed.find((name) => findingId(name) === f) ?? '';
  return `| ${index + 1} | ${meta.title} | ${SEVERITY[f]} | \`${location}\` | \`${spec}\` | ${evidence} | ${meta.fix} | Closed |`;
}).join('\n');

const report = `# Payments ledger review (SAMPLE, redacted) - v1

> Sample report on a synthetic, offline marketplace payments backend. Creator names are
> synthetic, there is no real money and no real provider, and every number below was measured
> by running the failing spec, not typed by hand.

<!-- review-stats target=v1 findingsOpen=9 retestsClosed=9 critical=${counts.Critical} high=${counts.High} medium=${counts.Medium} -->

**Verdict (v1): 9 findings open (${counts.Critical} Critical, ${counts.High} High, ${counts.Medium} Medium).** Retest against v2: 9 of 9 closed.

- Severity scale: **Critical** = money created or destroyed with no trace (F1, F2, F7, F9);
  **High** = a wrong balance that only a manual audit would find (F3, F4, F6);
  **Medium** = a smaller or partial error (F5, F8).
- Verdict: FAIL while any Critical or High finding is open; PASS when all are closed.
- Status = behaviour on v1; Retest = the same spec re-run against v2 (the fixed version).

## Summary (for a non-technical reader)

Fans pay creators for private chats. Every payment is split three ways: a 20% platform fee,
the creator's share, and a small referral reward paid out of the fee. This backend keeps a
double-entry ledger of that money.

The v1 version makes nine money mistakes. Four of them create or destroy money with no trace:
a repeated or duplicated notification pays a creator twice (F1, F2), a retried card charge
charges the fan twice (F7), and a retried payout sends the creator's money twice (F9). Three
more leave a balance wrong in a way only a careful audit would catch: a refund that arrives
before its payment is lost (F3), a second partial refund is ignored (F4), and the daily check
that is meant to catch amount differences only counts rows instead of dollars (F6). The last
two are smaller: a partial refund is off by a cent because of rounding (F5), and a disputed
payment returns the creator's money but not the referral reward (F8).

The v2 version fixes all nine. The same automated specs that expose each mistake on v1 pass on
v2, and the report below records the observed numbers for each one.

## Findings

| # | Finding | Severity | Location | Failing spec | How it fails (observed) | Suggested fix | Retest (v2) |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Method

- Each finding is reproduced by one spec that states the correct behaviour with exact numbers,
  so it fails on v1 and passes on v2.
- Locations are computed from the \`// DEFECT F<n>\` markers in \`src/v1\`, never typed.
- Severity is assigned from the scale above; observed numbers come from the failing spec's run.
`;

writeFileSync(join(root, 'SAMPLE_REPORT.md'), report, 'utf8');
console.log('review OK: v1 has exactly the 9 planted findings open; v2 is all green.');
console.log('wrote SAMPLE_REPORT.md');
