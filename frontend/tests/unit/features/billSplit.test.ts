import { describe, expect, it } from 'vitest';
import { centsToDollars, splitCents, splitDollars } from '@/features/pricing/billSplit';

describe('splitCents — cents are never lost', () => {
  it('splits an uneven total so the shares sum to the total exactly', () => {
    const split = splitCents(499, 4);
    expect(split).not.toBeNull();
    expect(split!.shares).toEqual([125, 125, 125, 124]);
    expect(split!.shares.reduce((a, b) => a + b, 0)).toBe(499);
    expect(split!.evenly).toBe(false);
    expect(split!.highCents).toBe(125);
    expect(split!.highCount).toBe(3);
    expect(split!.lowCents).toBe(124);
    expect(split!.lowCount).toBe(1);
  });

  it('reports an even split as such, with no low share', () => {
    const split = splitCents(1000, 4)!;
    expect(split.shares).toEqual([250, 250, 250, 250]);
    expect(split.evenly).toBe(true);
    expect(split.highCents).toBe(250);
    expect(split.highCount).toBe(4);
    expect(split.lowCount).toBe(0);
  });

  it('keeps every share within one cent of every other, for many totals and sizes', () => {
    for (let total = 0; total <= 2500; total += 37) {
      for (let members = 2; members <= 50; members += 1) {
        const split = splitCents(total, members)!;
        const sum = split.shares.reduce((a, b) => a + b, 0);
        expect(sum, `${total}c / ${members}`).toBe(total);
        expect(Math.max(...split.shares) - Math.min(...split.shares)).toBeLessThanOrEqual(1);
        expect(split.highCount + split.lowCount).toBe(members);
        expect(split.highCents * split.highCount + split.lowCents * split.lowCount).toBe(total);
      }
    }
  });

  it('refuses to invent a split for a household of one, or for nonsense input', () => {
    expect(splitCents(499, 1)).toBeNull();
    expect(splitCents(499, 0)).toBeNull();
    expect(splitCents(499, 2.5)).toBeNull();
    expect(splitCents(-1, 2)).toBeNull();
    expect(splitCents(4.99, 2)).toBeNull(); // dollars where cents were expected
    expect(splitCents(Number.NaN, 2)).toBeNull();
  });
});

describe('splitDollars', () => {
  it('converts a catalog dollar price to cents without a float error', () => {
    // 4.99 * 100 is 498.99999999999994 in binary floating point.
    const split = splitDollars(4.99, 3)!;
    expect(split.totalCents).toBe(499);
    expect(split.shares).toEqual([167, 166, 166]);
  });

  it('handles annual and lifetime amounts the same way', () => {
    expect(splitDollars(39.99, 3)!.shares).toEqual([1333, 1333, 1333]);
    expect(splitDollars(149, 4)!.shares).toEqual([3725, 3725, 3725, 3725]);
  });

  it('returns null for a non-finite amount', () => {
    expect(splitDollars(Number.POSITIVE_INFINITY, 2)).toBeNull();
    expect(splitDollars(Number.NaN, 2)).toBeNull();
  });
});

describe('centsToDollars', () => {
  it('is exact for formatting', () => {
    expect(centsToDollars(125)).toBe(1.25);
    expect(centsToDollars(499)).toBe(4.99);
  });
});
