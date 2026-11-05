import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  composeGiftEndingEmail,
  type GiftEndingEmailContext,
} from '../../../src/services/giftEndingEmailCopy.js';

const ctx = (over: Partial<GiftEndingEmailContext> = {}): GiftEndingEmailContext => ({
  locale: 'en',
  recipientName: 'Sam',
  planId: 'garden',
  endsAt: '2027-03-20T18:00:00.000Z',
  timeZone: 'America/Los_Angeles',
  unsubscribeUrl: 'https://api.familygreenhouse.net/notifications/email/unsubscribe?t=tok',
  ...over,
});

const BANNED = [
  /last chance/i,
  /hurry/i,
  /act now/i,
  /don'?t miss/i,
  /limited time/i,
  /discount/i,
  /promo/i,
  /coupon/i,
  /% off/i,
  /\bsave\b/i,
  /!/,
];

describe('the gift-ending email', () => {
  it('names the plan and the end date in the recipient’s zone', () => {
    const e = composeGiftEndingEmail(ctx());
    expect(e.subject).toBe('Your Garden gift ends on March 20, 2027');
    expect(e.text).toContain('The Garden gift your household was given ends on March 20, 2027.');
  });

  it('says nothing is charged and nothing is deleted', () => {
    const e = composeGiftEndingEmail(ctx());
    expect(e.text).toContain('Nothing is charged, and nothing renews.');
    expect(e.text).toContain('Nothing is deleted');
  });

  it('names the catalog price once and says to start on or after the end date, never sooner', () => {
    const e = composeGiftEndingEmail(ctx({ planId: 'greenhouse' }));
    expect(e.text.split('$9.99').length - 1).toBe(1);
    expect(e.text).toContain('on or after March 20, 2027');
    expect(e.text).toContain(
      'Starting it sooner would charge you for days the gift already covers.'
    );
    expect(e.html).toContain('/settings/billing');
  });

  it('has no urgency language, and carries one-click unsubscribe', () => {
    const e = composeGiftEndingEmail(ctx());
    for (const re of BANNED) {
      expect(e.subject).not.toMatch(re);
      expect(e.text).not.toMatch(re);
    }
    expect(e.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(composeGiftEndingEmail(ctx({ unsubscribeUrl: null })).headers).toBeUndefined();
  });

  it('escapes a hostile name and greets generically without one', () => {
    expect(composeGiftEndingEmail(ctx({ recipientName: '<b>x</b>' })).html).not.toContain(
      '<b>x</b>'
    );
    expect(composeGiftEndingEmail(ctx({ recipientName: null })).text).toContain('Hi there,');
  });

  it('says the same in Spanish', () => {
    const e = composeGiftEndingEmail(ctx({ locale: 'es' }));
    expect(e.subject).toBe('Tu regalo de Garden termina el 20 de marzo de 2027');
    expect(e.text).toContain('No se cobra nada y nada se renueva.');
    expect(e.text).toContain('a partir del 20 de marzo de 2027');
    expect(e.html).toContain('lang="es"');
  });
});
