# Payments ledger review (SAMPLE) - v1

> Sample report on a synthetic, offline marketplace payments backend. Creator names are
> synthetic, there is no real money and no real provider, and every number below was measured
> by running the failing spec, not typed by hand.

<!-- review-stats target=v1 findingsOpen=9 retestsClosed=9 critical=3 high=3 medium=3 -->

**Verdict (v1): 9 findings open (3 Critical, 3 High, 3 Medium).** Retest against v2: 9 of 9 closed.

- Severity scale:
  **Critical** = money created or destroyed with no trace (F2, F7, F9);
  **High** = a wrong balance that only a manual audit would find (F3, F4, F6);
  **Medium** = a smaller or partial error, or a missing second line of defence (F1, F5, F8).
- Verdict: FAIL while any Critical or High finding is open; PASS when all are closed.
- Status = behaviour on v1; Retest = the same spec re-run against v2 (the fixed version).

## Summary (for a non-technical reader)

Fans pay creators for private chats. Every payment is split three ways: a 20% platform fee,
the creator's share, and a small referral reward paid out of the fee. This backend keeps a
double-entry ledger of that money.

The v1 version makes 9 money mistakes. Three of them create or destroy money with no trace:
two notifications for the same payment pay the creator twice (F2), a retried card charge
charges the fan more than once (F7), and a retried payout sends the creator's money more than
once (F9). Three
more leave a balance wrong in a way only a careful audit would catch: a refund or dispute that
arrives before its payment is lost (F3), a second partial refund is ignored (F4), and the daily
check that is meant to catch amount differences only counts rows instead of dollars (F6). The
last three are smaller: a repeated notification is processed again, which on v1 doubles the
credit only because F2 is also open (F1); partial refunds are off by cents and do not add back
to zero (F5); and a disputed payment returns the creator's money but not the referral reward or
the platform share (F8).

The v2 version fixes all 9: the same automated specs that expose each mistake on v1 pass on
v2, and the table below records the observed numbers for each one. What the specs do not cover
is listed under Limits in the README.

## Findings

| # | Finding | Severity | Location | Failing spec | How it fails (observed) | Suggested fix | Retest (v2) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A redelivered webhook event is processed a second time (on v1 it doubles the credit only because F2 is also open) | Medium | `src/v1/ledger.ts:42` | `payments ledger review F1 a redelivered event is recorded once and credits the creator once` | creator balance (cents): 1600 (expected 800) | Store each event id under a unique constraint in the same transaction as its ledger entries, so a redelivered event is a no-op. With F2 fixed this is a second line of defence with no money effect of its own. | Closed |
| 2 | Two events for one occurrence credit the creator twice | Critical | `src/v1/ledger.ts:221` | `payments ledger review F2 two events for one occurrence credit the creator once` | creator balance (cents): 1600 (expected 800) | Key every ledger transaction by (provider object id, entry type), so two events that describe the same occurrence produce one transaction. | Closed |
| 3 | A refund or dispute that arrives before its capture is dropped, and the creator keeps the earnings | High | `src/v1/ledger.ts:182` | `payments ledger review F3 a refund or dispute that arrives before its capture is applied once the capture exists` | creator balance after an early refund (cents): 800 (expected 0) | Park an early refund or dispute and apply it once the capture exists. | Closed |
| 4 | A second partial refund is dropped as a duplicate | High | `src/v1/ledger.ts:189` | `payments ledger review F4 a second partial refund is applied` | creator balance (cents): 560 (expected 320) | Key refunds by the refund id, not by (charge id, type). | Closed |
| 5 | Partial refunds round each line, drift by cents and do not add back to zero | Medium | `src/v1/ledger.ts:198` | `payments ledger review F5 partial refunds split without rounding drift and a full refund in parts ends at zero` | platform balance (cents): 178 (expected 177) | Split each refund against the running total already reversed on the charge, so its parts sum exactly to it and a charge refunded in full, in one part or several, leaves every party at zero. | Closed |
| 6 | Reconciliation compares counts, so an amount drift stays green | High | `src/v1/ledger.ts:73` | `payments ledger review F6 reconciliation flags an amount drift per creator` | reconciliation differences reported: 0 (expected 1) | Compare the amount per creator and per day between the ledger and the provider. | Closed |
| 7 | A lost capture response is retried with a fresh idempotency key | Critical | `src/v1/ledger.ts:91` | `payments ledger review F7 a lost capture response and an order repeated after a restart capture once` | captures created: 3 (expected 1); total captured (cents): 3000 (expected 1000) | Store one idempotency key per order before the first send, and reuse it on every retry and on a repeated request for the same order. | Closed |
| 8 | A dispute reverses the creator earnings but leaves the referral reward and the platform share in place | Medium | `src/v1/ledger.ts:214` | `payments ledger review F8 a dispute reverses the creator earnings, the referral reward and the platform share` | referral balance (cents): 20 (expected 0); platform balance (cents): 180 (expected 0) | Reverse a dispute like a refund: creator earnings, referral reward and platform share together, in one ledger transaction. | Closed |
| 9 | An unknown payout outcome is retried blindly and pays twice | Critical | `src/v1/ledger.ts:124` | `payments ledger review F9 an unknown payout outcome is looked up and a repeated payout request pays once` | payouts created for 3 payout requests: 6 (expected 3) | Persist the payout intent with its client_reference before sending and read it on every request; after an unknown outcome look the payout up by client_reference and send only when the provider has none. | Closed |

## Method

- Each finding is reproduced by one spec that states the correct behaviour with exact numbers,
  so it fails on v1 and passes on v2.
- Locations are computed from the `// DEFECT F<n>` markers in `src/v1`, never typed.
- Severity is assigned from the scale above; observed numbers come from the failing spec's run.
