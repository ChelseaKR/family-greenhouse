/**
 * Refer-a-friend (ADR 0029) — the pure model: code generation/round-trip,
 * and the anti-self-referral email heuristic. No DynamoDB, no Stripe.
 */
import { describe, it, expect } from 'vitest';
import {
  REFERRAL_BONUS_MONTHS,
  REFERRAL_BONUS_PLAN_ID,
  detectSelfReferral,
  formatReferralCode,
  generateReferralCode,
  normalizeEmailForMatch,
  normalizeReferralCode,
} from '../../../src/models/referrals.js';

describe('referral code generation', () => {
  it('generates a well-formed RF-prefixed code that survives normalize round-trip', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^RF[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(normalizeReferralCode(code)).toBe(code);
    }
  });

  it('generates codes that are not trivially predictable (no two identical in 200 draws)', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateReferralCode()));
    expect(codes.size).toBe(200);
  });

  it('formats with a readable separator and reduces to the same canonical code', () => {
    const code = generateReferralCode();
    const formatted = formatReferralCode(code);
    expect(formatted.startsWith('RF-')).toBe(true);
    expect(normalizeReferralCode(formatted)).toBe(code);
  });

  it('normalizes case, spacing, dashes and Crockford confusables', () => {
    const code = generateReferralCode();
    const messy = formatReferralCode(code)
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'o') // 0 -> O is a confusable a person might type
      .replace(/1/g, 'i');
    expect(normalizeReferralCode(messy)).toBe(code);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(normalizeReferralCode('not-a-code')).toBeNull();
    expect(normalizeReferralCode('')).toBeNull();
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode(12345)).toBeNull();
    // A gift code (different prefix/length family) must not be accepted here.
    expect(normalizeReferralCode('FG0000000000000000')).toBeNull();
  });
});

describe('the bonus itself', () => {
  it('is one month of Garden — generous enough to share, not Greenhouse (ADR 0012 AI-cost ceiling)', () => {
    expect(REFERRAL_BONUS_PLAN_ID).toBe('garden');
    expect(REFERRAL_BONUS_MONTHS).toBe(1);
  });
});

describe('normalizeEmailForMatch', () => {
  it('lowercases and strips a +tag suffix from the local part', () => {
    expect(normalizeEmailForMatch('Chelsea+ref1@Gmail.com')).toEqual({
      local: 'chelsea',
      domain: 'gmail.com',
      full: 'chelsea@gmail.com',
    });
  });

  it('leaves an address with no +tag unchanged apart from case', () => {
    expect(normalizeEmailForMatch('Alice@Example.com')).toEqual({
      local: 'alice',
      domain: 'example.com',
      full: 'alice@example.com',
    });
  });
});

describe('detectSelfReferral (the anti-abuse guard)', () => {
  it('blocks the exact same normalized address on both sides', () => {
    expect(detectSelfReferral('alice@gmail.com', 'alice@gmail.com')).toBe('same_email');
  });

  it('blocks a +tag alias of the SAME inbox — the loophole this guard exists for', () => {
    expect(detectSelfReferral('alice@gmail.com', 'alice+referral@gmail.com')).toBe('same_email');
    expect(detectSelfReferral('alice+one@gmail.com', 'alice+two@gmail.com')).toBe('same_email');
  });

  it('blocks two different-looking addresses that share a PRIVATE/custom domain', () => {
    // Two accounts at the same small workplace/personal domain, signing up
    // minutes apart via one of their own referral links, is the strongest
    // cheap signal this module has for "one household, not two".
    expect(detectSelfReferral('chelsea@chelseakr.com', 'newuser@chelseakr.com')).toBe(
      'shared_custom_domain'
    );
  });

  it('is case-insensitive on both the local part and the domain', () => {
    expect(detectSelfReferral('Alice@Example.com', 'ALICE@EXAMPLE.COM')).toBe('same_email');
  });

  // --- Negative control: a genuine two-person referral must NOT be blocked. ---
  it('does NOT block two different people who happen to share a free/shared provider', () => {
    expect(detectSelfReferral('alice@gmail.com', 'bob@gmail.com')).toBeNull();
    expect(detectSelfReferral('alice@icloud.com', 'bob@icloud.com')).toBeNull();
    expect(detectSelfReferral('alice@yahoo.com', 'bob.smith@yahoo.com')).toBeNull();
  });

  it('does NOT block two different people on two different custom domains', () => {
    expect(detectSelfReferral('alice@company-a.com', 'bob@company-b.com')).toBeNull();
  });

  it('does NOT block a legitimate +tag used by someone with a DIFFERENT base address', () => {
    expect(detectSelfReferral('alice@gmail.com', 'bob+fromalice@gmail.com')).toBeNull();
  });
});
