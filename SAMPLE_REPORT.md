# Payments ledger review (SAMPLE, redacted) - v1

> Sample report on a synthetic, offline marketplace payments backend. Creator names are
> synthetic, there is no real money and no real provider, and every number below was measured
> by running the failing spec, not typed by hand.

<!-- review-stats target=v1 findingsOpen=9 retestsClosed=9 critical=4 high=3 medium=2 -->

**Verdict (v1): 9 findings open (4 Critical, 3 High, 2 Medium).** Retest against v2: 9 of 9 closed.

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
| 1 | A redelivered webhook event credits the creator twice | Critical | `src/v1/ledger.ts:41` | `payments ledger review F1 a redelivered event credits the creator once` | creator balance (cents): 1600 (expected 800) | Store each event id under a unique constraint in the same transaction as its ledger entries, so a redelivered event is a no-op. | Closed |
| 2 | Two events for one occurrence credit the creator twice | Critical | `src/v1/ledger.ts:234` | `payments ledger review F2 two events for one occurrence credit the creator once` | creator balance (cents): 1600 (expected 800) | Key every ledger transaction by (provider object id, entry type), so two events that describe the same occurrence produce one transaction. | Closed |
| 3 | An out-of-order refund is dropped and the creator keeps the full earnings | High | `src/v1/ledger.ts:206` | `payments ledger review F3 an out-of-order refund is applied once the capture exists` | creator balance (cents): 800 (expected 0) | Park a refund that arrives before its capture and apply it once the capture exists. | Closed |
| 4 | A second partial refund is dropped as a duplicate | High | `src/v1/ledger.ts:184` | `payments ledger review F4 a second partial refund is applied` | creator balance (cents): 560 (expected 320) | Key refunds by the refund id, not by (charge id, type). | Closed |
| 5 | A partial refund rounds each line and drifts by cents | Medium | `src/v1/ledger.ts:193` | `payments ledger review F5 a partial refund splits without rounding drift` | platform balance (cents): 178 (expected 177) | Split with integer math and assign the remainder to one party, so the parts sum exactly to the refund. | Closed |
| 6 | Reconciliation compares counts, so an amount drift stays green | High | `src/v1/ledger.ts:73` | `payments ledger review F6 reconciliation flags an amount drift per creator` | reconciliation differences reported: 0 (expected 1) | Compare the amount per creator and per day between the ledger and the provider. | Closed |
| 7 | A lost capture response is retried with a fresh idempotency key | Critical | `src/v1/ledger.ts:91` | `payments ledger review F7 a lost capture response is retried with one idempotency key` | captures created: 2 (expected 1); total captured (cents): 2000 (expected 1000) | Generate one idempotency key per money movement, store it before the first send, and reuse it on every retry. | Closed |
| 8 | A dispute reverses the creator earnings but leaves the referral reward paid | Medium | `src/v1/ledger.ts:227` | `payments ledger review F8 a dispute reverses the referral reward` | referral balance (cents): 20 (expected 0) | Reverse the creator earnings and the referral reward in the same ledger transaction. | Closed |
| 9 | An unknown payout outcome is retried blindly and pays twice | Critical | `src/v1/ledger.ts:124` | `payments ledger review F9 an unknown payout outcome is looked up, not retried blindly` | payouts created: 2 (expected 1) | Persist the payout intent with a client_reference before sending; after an unknown outcome look it up by client_reference, and stop and escalate if the lookup cannot decide. | Closed |

## Method

- Each finding is reproduced by one spec that states the correct behaviour with exact numbers,
  so it fails on v1 and passes on v2.
- Locations are computed from the `// DEFECT F<n>` markers in `src/v1`, never typed.
- Severity is assigned from the scale above; observed numbers come from the failing spec's run.
