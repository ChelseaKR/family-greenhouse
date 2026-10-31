import { describe, expect, it } from 'vitest';
import { AGE_ASSURANCE_POLICY, type AgeAssurancePolicy } from '@/config/ageAssurance';
import {
  accountGate,
  accountMinimumAge,
  checkoutGate,
  isKnownAdult,
  isKnownMinor,
  parseAgeSignal,
  type AgeSignal,
} from '@/lib/ageSignal';

/**
 * The app-store age signal (lib/ageSignal.ts): every bracket, every way the
 * signal can be missing, and the rule that a missing signal is never an
 * adult (absence is not a value). The last block is a negative control: it
 * proves these assertions fail against a parser that renders absence as an
 * adult, and that the sabotage really changed the answer.
 */

const RECOMMENDED: AgeAssurancePolicy = {
  requestPolicy: 'onlyWhenRequired',
  accounts: 'blockUnder13',
  paidPlans: 'termsOnly',
};
const STRICT: AgeAssurancePolicy = {
  requestPolicy: 'always',
  accounts: 'blockUnder18',
  paidPlans: 'blockMinorCheckout',
};

const known = (bracket: string, declaration = 'selfDeclared') => ({
  status: 'known',
  bracket,
  declaration,
  requirements: [],
});

/** Everything the plugin, a missing plugin or a broken bridge can hand over. */
const ABSENT_INPUTS: unknown[] = [
  undefined,
  null,
  '',
  'adult',
  42,
  {},
  { status: 'unavailable', reason: 'platformUnsupported' },
  { status: 'unavailable', reason: 'notInScope' },
  { status: 'unavailable', reason: 'declinedSharing' },
  { status: 'unavailable', reason: 'requestFailed' },
  { status: 'unavailable', reason: 'unrecognizedRange' },
  { status: 'unavailable', reason: 'something new' },
  { status: 'unavailable' },
  { status: 'known' },
  { status: 'known', bracket: 'over21' },
  { status: 'known', bracket: null },
  { status: 'mystery', bracket: 'adult' },
];

/** The absence rule, as a reusable check (the negative control runs it too). */
function assertAbsenceIsNeverAnAdult(parse: (raw: unknown) => AgeSignal): void {
  for (const raw of ABSENT_INPUTS) {
    const signal = parse(raw);
    expect(signal.status, JSON.stringify(raw)).toBe('unavailable');
    expect(isKnownAdult(signal), JSON.stringify(raw)).toBe(false);
    expect(isKnownMinor(signal), JSON.stringify(raw)).toBe(false);
  }
}

describe('the recommended policy is what ships', () => {
  it('matches the report recommendations D1, A1 and B1', () => {
    expect(AGE_ASSURANCE_POLICY).toEqual(RECOMMENDED);
    expect(accountMinimumAge(AGE_ASSURANCE_POLICY)).toBe(13);
  });
});

describe('each bracket', () => {
  it('under 13: a known minor, blocked from accounts', () => {
    const signal = parseAgeSignal(known('under13', 'guardianDeclared'));
    expect(signal).toEqual({
      status: 'known',
      bracket: 'under13',
      declaration: 'guardianDeclared',
      minor: true,
    });
    expect(isKnownMinor(signal)).toBe(true);
    expect(isKnownAdult(signal)).toBe(false);
    expect(accountGate(signal, RECOMMENDED)).toBe('blocked');
    expect(accountGate(signal, STRICT)).toBe('blocked');
  });

  it('13 to 15: a known minor, allowed under A1, blocked under A2', () => {
    const signal = parseAgeSignal(known('age13to15'));
    expect(isKnownMinor(signal)).toBe(true);
    expect(accountGate(signal, RECOMMENDED)).toBe('allowed');
    expect(accountGate(signal, STRICT)).toBe('blocked');
  });

  it('16 to 17: a known minor, allowed under A1, blocked under A2', () => {
    const signal = parseAgeSignal(known('age16to17', 'confirmed'));
    expect(isKnownMinor(signal)).toBe(true);
    expect(isKnownAdult(signal)).toBe(false);
    expect(accountGate(signal, RECOMMENDED)).toBe('allowed');
    expect(accountGate(signal, STRICT)).toBe('blocked');
  });

  it('18 and over: the only known adult', () => {
    const signal = parseAgeSignal(known('adult', 'confirmed'));
    expect(isKnownAdult(signal)).toBe(true);
    expect(isKnownMinor(signal)).toBe(false);
    expect(accountGate(signal, RECOMMENDED)).toBe('allowed');
    expect(accountGate(signal, STRICT)).toBe('allowed');
    expect(checkoutGate(signal, STRICT)).toBe('allowed');
  });

  it('an unknown declaration keeps the bracket but says so', () => {
    expect(parseAgeSignal(known('adult', 'telepathy'))).toMatchObject({
      bracket: 'adult',
      declaration: 'unspecified',
    });
  });
});

describe('signal unavailable', () => {
  it('older iOS, a declined share, no plugin and garbage are never an adult or a minor', () => {
    assertAbsenceIsNeverAnAdult(parseAgeSignal);
  });

  it('keeps the reason Apple gave', () => {
    expect(parseAgeSignal({ status: 'unavailable', reason: 'platformUnsupported' })).toEqual({
      status: 'unavailable',
      reason: 'platformUnsupported',
    });
    expect(parseAgeSignal({ status: 'unavailable', reason: 'declinedSharing' })).toEqual({
      status: 'unavailable',
      reason: 'declinedSharing',
    });
    expect(parseAgeSignal(undefined)).toEqual({ status: 'unavailable', reason: 'malformed' });
  });

  it('blocks nothing and unlocks nothing', () => {
    for (const raw of ABSENT_INPUTS) {
      const signal = parseAgeSignal(raw);
      expect(accountGate(signal, RECOMMENDED)).toBe('allowed');
      expect(accountGate(signal, STRICT)).toBe('allowed');
      expect(checkoutGate(signal, STRICT)).toBe('allowed');
    }
  });
});

describe('paid plans (decision B)', () => {
  it('termsOnly never refuses checkout, even for a known minor', () => {
    expect(checkoutGate(parseAgeSignal(known('age13to15')), RECOMMENDED)).toBe('allowed');
  });

  it('blockMinorCheckout refuses only a known minor', () => {
    expect(checkoutGate(parseAgeSignal(known('age16to17')), STRICT)).toBe('blocked');
    expect(checkoutGate(parseAgeSignal(known('adult')), STRICT)).toBe('allowed');
  });
});

describe('negative control', () => {
  // A parser with the bug this file exists to prevent: no signal reads as 18+.
  const sabotaged = (raw: unknown): AgeSignal => {
    const signal = parseAgeSignal(raw);
    return signal.status === 'unavailable'
      ? { status: 'known', bracket: 'adult', declaration: 'unspecified', minor: false }
      : signal;
  };

  it('the sabotage really changes the answer', () => {
    expect(isKnownAdult(parseAgeSignal(undefined))).toBe(false);
    expect(isKnownAdult(sabotaged(undefined))).toBe(true);
  });

  it('the absence assertions fail against it', () => {
    expect(() => assertAbsenceIsNeverAnAdult(sabotaged)).toThrow();
  });
});
