/**
 * The data and configuration behind the optional "Buy this plant" link
 * (ADR 0038), checked as files: the committed config, the hand-checked product
 * pages, and the rule that turns them into a link.
 */
import { describe, expect, it } from 'vitest';

import affiliateLinks from '@/config/affiliateLinks.json';
import plantShopLinks from '@/features/plantShop/plantShopLinks.json';
import { CARE_GUIDE_SLUGS } from '@/features/care/careGuideSlugs';
import { PLANT_SAFETY_PAGES } from '@/features/petsafe/plantSafetyPages';
import {
  MERCHANTS,
  affiliateHref,
  isTrackingLink,
  offersShopLink,
  resolvePlantShopLink,
  type PlantShopEntry,
} from '@/features/plantShop/plantShop';

const TRACKING = 'https://thesill.pxf.io/c/1234567/123456/12345';
const OTHER = 'https://bloomscape.pxf.io/c/1234567/654321/54321';
const ENTRIES = plantShopLinks.links as Record<string, PlantShopEntry[]>;

/** The merchant's own storefront host, per merchant. */
const HOST = { theSill: 'www.thesill.com', bloomscape: 'bloomscape.com' } as const;

describe('the committed affiliate config', () => {
  it('names only known merchants, each empty or an Impact tracking link base', () => {
    for (const [key, value] of Object.entries(affiliateLinks)) {
      if (key === '$comment') continue;
      expect(MERCHANTS).toContain(key);
      expect(value === '' || isTrackingLink(value), `${key}: ${String(value)}`).toBe(true);
    }
  });

  it('carries no per-reader value: no query string or fragment in a tracking link', () => {
    for (const merchant of MERCHANTS) {
      const value = (affiliateLinks as Record<string, string>)[merchant] ?? '';
      expect(value).not.toMatch(/[?#&]/);
    }
  });
});

describe('the checked product pages (plantShopLinks.json)', () => {
  const published = new Set([...CARE_GUIDE_SLUGS, ...PLANT_SAFETY_PAGES.map((p) => p.slug)]);

  it.each(Object.entries(ENTRIES))('%s', (slug, entries) => {
    expect(published.has(slug), `${slug} is not a published plant page`).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    const merchants = entries.map((e) => e.merchant);
    expect(new Set(merchants).size).toBe(merchants.length);
    for (const entry of entries) {
      expect(MERCHANTS).toContain(entry.merchant);
      const url = new URL(entry.url);
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe(HOST[entry.merchant]);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(entry.botanicalNameOnPage.trim()).not.toBe('');
      expect(entry.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('resolvePlantShopLink', () => {
  it('answers null for every plant with the config as committed when it is empty', () => {
    const configured = MERCHANTS.some((m) =>
      isTrackingLink((affiliateLinks as Record<string, string>)[m])
    );
    if (configured) return; // a program is live; the cases below cover the rule
    for (const slug of published()) expect(resolvePlantShopLink(slug)).toBeNull();
  });

  it('answers null with no config, whatever the data lists', () => {
    for (const slug of Object.keys(ENTRIES)) expect(resolvePlantShopLink(slug, {})).toBeNull();
  });

  it('builds the deep link: the tracking link, then ?u= the encoded product page', () => {
    const link = resolvePlantShopLink('pothos', { theSill: TRACKING })!;
    expect(link.merchant).toBe('theSill');
    expect(link.productUrl).toBe('https://www.thesill.com/products/golden-pothos');
    expect(link.href).toBe(
      `${TRACKING}?u=${encodeURIComponent('https://www.thesill.com/products/golden-pothos')}`
    );
    expect(affiliateHref(TRACKING, 'https://a.example/b?c=d')).toBe(
      `${TRACKING}?u=https%3A%2F%2Fa.example%2Fb%3Fc%3Dd`
    );
  });

  it('prefers the first merchant in MERCHANTS whose program is configured', () => {
    expect(
      resolvePlantShopLink('monstera', { theSill: TRACKING, bloomscape: OTHER })!.merchant
    ).toBe('theSill');
    expect(resolvePlantShopLink('monstera', { bloomscape: OTHER })!.merchant).toBe('bloomscape');
  });

  it('falls through to a merchant that lists the plant', () => {
    // Jade plant is checked at Bloomscape only.
    expect(resolvePlantShopLink('jade-plant', { theSill: TRACKING })).toBeNull();
    expect(
      resolvePlantShopLink('jade-plant', { theSill: TRACKING, bloomscape: OTHER })!.merchant
    ).toBe('bloomscape');
  });

  it('gives no link for a plant with no checked page, or a malformed tracking link', () => {
    expect(
      resolvePlantShopLink('nerve-plant', { theSill: TRACKING, bloomscape: OTHER })
    ).toBeNull();
    expect(resolvePlantShopLink('__proto__', { theSill: TRACKING })).toBeNull();
    for (const bad of [
      'http://thesill.pxf.io/c/1/2/3',
      'https://thesill.pxf.io/c/1/2/3?subId=reader',
      'https://thesill.pxf.io/c/1/2',
      ' https://thesill.pxf.io/c/1/2/3',
      'javascript:alert(1)',
    ]) {
      expect(resolvePlantShopLink('pothos', { theSill: bad }), bad).toBeNull();
    }
  });
});

describe('offersShopLink (pet-safe pages)', () => {
  it('is true only when every verdict is non-toxic', () => {
    expect(offersShopLink([{ state: 'non-toxic' }, { state: 'non-toxic' }])).toBe(true);
    expect(offersShopLink([{ state: 'non-toxic' }, { state: 'toxic' }])).toBe(false);
    expect(offersShopLink([{ state: 'non-toxic' }, { state: 'not-assessed' }])).toBe(false);
    expect(offersShopLink([])).toBe(false);
  });
});

function published(): string[] {
  return [...new Set([...CARE_GUIDE_SLUGS, ...PLANT_SAFETY_PAGES.map((p) => p.slug)])];
}
