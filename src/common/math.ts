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
 * Correct refund split: floor each proportional share, then assign the remainder to the
 * platform so the three parts always sum exactly to the refund amount.
 */
export function refundSplit(amountCents: number, refundAmountCents: number): RefundSplit {
  const split = captureSplit(amountCents);
  const creator = Math.floor((split.creator * refundAmountCents) / amountCents);
  const referrer = Math.floor((split.referrer * refundAmountCents) / amountCents);
  const platform = Math.floor((split.platform * refundAmountCents) / amountCents);
  const remainder = refundAmountCents - creator - referrer - platform;
  return { creator, referrer, platform: platform + remainder };
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
