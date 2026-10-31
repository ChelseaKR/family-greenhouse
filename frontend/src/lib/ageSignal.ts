import type { AgeAssurancePolicy } from '@/config/ageAssurance';

/**
 * The app-store age signal as the web layer holds it, and the decisions made
 * from it. Pure: no plugin, no storage, no network.
 *
 * The rule this file exists to keep: absence is not a value. A signal that is
 * missing, declined, failed, malformed or ambiguous is `unavailable`, and
 * `unavailable` is never an adult and never a minor. It blocks nothing,
 * because the store has already gated the download (Ask to Buy, parental
 * consent) and the FTC does not require a general-audience app to ask ages;
 * and it unlocks nothing that needs a known adult.
 */

export type AgeBracket = 'under13' | 'age13to15' | 'age16to17' | 'adult';
export type AgeDeclaration = 'selfDeclared' | 'guardianDeclared' | 'confirmed' | 'unspecified';
export type UnavailableReason =
  | 'notYetRequested'
  | 'platformUnsupported'
  | 'notInScope'
  | 'declinedSharing'
  | 'requestFailed'
  | 'unrecognizedRange'
  | 'pluginMissing'
  | 'malformed';

export type AgeSignal =
  | { status: 'known'; bracket: AgeBracket; declaration: AgeDeclaration; minor: boolean }
  | { status: 'unavailable'; reason: UnavailableReason };

const BRACKETS: readonly AgeBracket[] = ['under13', 'age13to15', 'age16to17', 'adult'];
const DECLARATIONS: readonly AgeDeclaration[] = [
  'selfDeclared',
  'guardianDeclared',
  'confirmed',
  'unspecified',
];
const REASONS: readonly UnavailableReason[] = [
  'notYetRequested',
  'platformUnsupported',
  'notInScope',
  'declinedSharing',
  'requestFailed',
  'unrecognizedRange',
  'pluginMissing',
  'malformed',
];

export const unavailable = (reason: UnavailableReason): AgeSignal => ({
  status: 'unavailable',
  reason,
});

/**
 * Parse the plugin's answer (NativeAgeRangePlugin.swift `requestAgeRange`).
 * Anything that is not exactly a known bracket is `unavailable`.
 */
export function parseAgeSignal(raw: unknown): AgeSignal {
  if (!raw || typeof raw !== 'object') return unavailable('malformed');
  const value = raw as Record<string, unknown>;
  if (value.status === 'known') {
    const bracket = value.bracket as AgeBracket;
    if (!BRACKETS.includes(bracket)) return unavailable('malformed');
    const declaration = DECLARATIONS.includes(value.declaration as AgeDeclaration)
      ? (value.declaration as AgeDeclaration)
      : 'unspecified';
    return { status: 'known', bracket, declaration, minor: bracket !== 'adult' };
  }
  if (value.status === 'unavailable') {
    const reason = value.reason as UnavailableReason;
    return unavailable(REASONS.includes(reason) ? reason : 'malformed');
  }
  return unavailable('malformed');
}

/** True only for a store-reported 18 or over. */
export function isKnownAdult(signal: AgeSignal): boolean {
  return signal.status === 'known' && signal.bracket === 'adult';
}

/** True only for a store-reported minor bracket. */
export function isKnownMinor(signal: AgeSignal): boolean {
  return signal.status === 'known' && signal.minor;
}

export type AccountGate = 'allowed' | 'blocked';

/** The minimum account age the policy names (13 or 18). */
export function accountMinimumAge(policy: AgeAssurancePolicy): number {
  return policy.accounts === 'blockUnder18' ? 18 : 13;
}

/**
 * Whether this person may sign up, sign in or accept an invitation in the
 * app (decision A). Blocks only on a store-reported bracket below the line.
 */
export function accountGate(signal: AgeSignal, policy: AgeAssurancePolicy): AccountGate {
  if (signal.status !== 'known') return 'allowed';
  if (policy.accounts === 'blockUnder18') return signal.minor ? 'blocked' : 'allowed';
  return signal.bracket === 'under13' ? 'blocked' : 'allowed';
}

/**
 * Whether the app may open a purchase for this person (decision B). With the
 * recommended `termsOnly`, the Terms carry the rule and Apple's Ask to Buy
 * puts a minor's purchase in front of a parent.
 */
export function checkoutGate(signal: AgeSignal, policy: AgeAssurancePolicy): AccountGate {
  if (policy.paidPlans === 'blockMinorCheckout' && isKnownMinor(signal)) return 'blocked';
  return 'allowed';
}
