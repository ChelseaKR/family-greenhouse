/**
 * Split-the-bill arithmetic (brief §4.12). Pure, in integer cents, so no
 * cent is ever lost to floating point: the shares always sum to the total
 * exactly, and no two shares differ by more than one cent.
 *
 * This is display arithmetic only. The app never collects from members —
 * one subscription covers the household and how it is split is theirs.
 */

export interface BillSplit {
  totalCents: number;
  members: number;
  /** One share per member, in cents, largest first. Sums to `totalCents`. */
  shares: number[];
  /** True when every share is identical. */
  evenly: boolean;
  /** The larger share (what "each" rounds up to). */
  highCents: number;
  /** How many members pay `highCents`. */
  highCount: number;
  /** The smaller share, equal to `highCents` when `evenly`. */
  lowCents: number;
  /** How many members pay `lowCents` (0 when `evenly`). */
  lowCount: number;
}

/**
 * Split `totalCents` across `members` people. Returns `null` — never a
 * fabricated split — when the inputs cannot describe a real bill: fewer than
 * two members (a household of one has nothing to split, and the surface hides
 * itself), a negative or non-integer cent amount, or a non-finite count.
 */
export function splitCents(totalCents: number, members: number): BillSplit | null {
  if (!Number.isInteger(totalCents) || totalCents < 0) return null;
  if (!Number.isInteger(members) || members < 2) return null;
  const base = Math.floor(totalCents / members);
  const remainder = totalCents - base * members;
  const shares = Array.from({ length: members }, (_, i) => (i < remainder ? base + 1 : base));
  const evenly = remainder === 0;
  return {
    totalCents,
    members,
    shares,
    evenly,
    highCents: evenly ? base : base + 1,
    highCount: evenly ? members : remainder,
    lowCents: base,
    lowCount: evenly ? 0 : members - remainder,
  };
}

/**
 * Dollar-amount convenience over `splitCents`. The catalog publishes prices
 * in dollars (4.99); they are converted to cents with rounding so a binary
 * float like 4.99 * 100 = 498.99999… still means 499 cents.
 */
export function splitDollars(amount: number, members: number): BillSplit | null {
  if (!Number.isFinite(amount)) return null;
  return splitCents(Math.round(amount * 100), members);
}

/** Cents → dollars for formatting, exact for any integer cent value. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}
