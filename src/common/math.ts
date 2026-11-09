import type { CaptureSplit, RefundSplit } from './types.js';

// Fee, referral and refund split math. Amounts are integer cents, USD only.
//
// The fee is 20% of the charge (rounded half up to the cent), the creator keeps the
// remainder, and a referral reward of 10% of the fee (rounded down) goes to the
// referrer, paid out of the fee.

export function platformFee(amountCents: number): number {
  // 20% of an integer amount is amount / 5, whose fractional part is one of
  // {0, .2, .4, .6, .8}. Math.round is therefore tie-free and matches half-up.
  return Math.round(amountCents / 5);
}

export function creatorNet(amountCents: number): number {
  return amountCents - platformFee(amountCents);
}

export function referralReward(feeCents: number): number {
  return Math.floor(feeCents / 10);
}

export function platformNet(feeCents: number, referralCents: number): number {
  return feeCents - referralCents;
}

export function captureSplit(amountCents: number): CaptureSplit {
  const fee = platformFee(amountCents);
  const creator = creatorNet(amountCents);
  const referrer = referralReward(fee);
  return { creator, referrer, platform: platformNet(fee, referrer), fee };
}

/**
 * The shares due when `reversedCents` of a charge have been reversed in total: creator and
 * referrer are floored, and the platform takes the remainder, so the three always sum to
 * `reversedCents`. When the whole charge is reversed they equal the capture split exactly.
 */
function sharesReversed(amountCents: number, reversedCents: number): RefundSplit {
  const split = captureSplit(amountCents);
  const creator = Math.floor((split.creator * reversedCents) / amountCents);
  const referrer = Math.floor((split.referrer * reversedCents) / amountCents);
  return { creator, referrer, platform: reversedCents - creator - referrer };
}

/**
 * Correct reversal split, against the running total already reversed on the charge: the
 * parts of each reversal sum exactly to it, and a charge reversed in full (in one part or
 * several) leaves every party at zero.
 */
export function reversalSplit(amountCents: number, alreadyReversedCents: number, reversalCents: number): RefundSplit {
  const before = sharesReversed(amountCents, alreadyReversedCents);
  const after = sharesReversed(amountCents, alreadyReversedCents + reversalCents);
  return {
    creator: after.creator - before.creator,
    referrer: after.referrer - before.referrer,
    platform: after.platform - before.platform,
  };
}

/**
 * Defective refund split used by v1: each line is rounded half-up independently, so the
 * three parts can add up to one cent more or less than the refund.
 */
export function refundSplitRoundedPerLine(amountCents: number, refundAmountCents: number): RefundSplit {
  const split = captureSplit(amountCents);
  const creator = Math.round((split.creator * refundAmountCents) / amountCents);
  const referrer = Math.round((split.referrer * refundAmountCents) / amountCents);
  const platform = Math.round((split.platform * refundAmountCents) / amountCents);
  return { creator, referrer, platform };
}

/** Day key ('YYYY-MM-DD' UTC) from a Unix-seconds timestamp. */
export function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
