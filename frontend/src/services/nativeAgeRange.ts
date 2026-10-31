import { AGE_ASSURANCE_POLICY } from '@/config/ageAssurance';
import { getNativePlatform, hasNativePlugin } from '@/lib/platform';
import { isKnownMinor, parseAgeSignal, unavailable, type AgeSignal } from '@/lib/ageSignal';
import { api } from '@/services/api';

/**
 * The app-store age signal, asked for once per launch and held in memory
 * only (app-store age-assurance laws; config/ageAssurance.ts).
 *
 * Never written to storage, never sent to the server, never logged, never
 * given to analytics. The one thing it decides besides the account gate is
 * whether the app registers its signed app transaction with the server, so
 * a parent's later withdrawal of consent can reach the account
 * (backend services/appConsent.ts); an adult's or an unknown person's is
 * never sent.
 *
 * Gated on the bridge's plugin header, never on the platform alone
 * (lib/platform.ts `hasNativePlugin`). The website and an app build without
 * the plugin get `unavailable('pluginMissing')` at once.
 */

/** The name the app registers the plugin under (NativeAgeRangePlugin.swift `jsName`). */
export const NATIVE_AGE_RANGE_PLUGIN = 'NativeAgeRange';
export const NATIVE_AGE_RANGE_METHODS = ['requestAgeRange', 'appTransaction'];

export function hasNativeAgeRange(): boolean {
  return (
    getNativePlatform() === 'ios' &&
    hasNativePlugin(NATIVE_AGE_RANGE_PLUGIN, NATIVE_AGE_RANGE_METHODS)
  );
}

export interface AgeRangeDeps {
  available: () => boolean;
  request: (requestPolicy: string) => Promise<unknown>;
  signedAppTransaction: () => Promise<string | null>;
  register: (signedAppTransaction: string) => Promise<void>;
}

const defaultDeps: AgeRangeDeps = {
  available: hasNativeAgeRange,
  request: async (policy) =>
    (await import('@/services/nativeAgeRangePlugin')).requestAgeRange(policy),
  signedAppTransaction: async () =>
    (await import('@/services/nativeAgeRangePlugin')).signedAppTransaction(),
  register: async (signedAppTransaction) => {
    await api.post('/me/app-transaction', { signedAppTransaction });
  },
};

let launchSignal: Promise<AgeSignal> | null = null;
let settled: AgeSignal | null = null;
const listeners = new Set<(signal: AgeSignal) => void>();
const registeredFor = new Set<string>();

/**
 * This launch's signal. The first call asks the plugin; every later call
 * shares that answer. Never throws: a failure is `unavailable`.
 */
export function loadAgeSignal(overrides: Partial<AgeRangeDeps> = {}): Promise<AgeSignal> {
  if (launchSignal) return launchSignal;
  const deps = { ...defaultDeps, ...overrides };
  launchSignal = (async () => {
    if (!deps.available()) return unavailable('pluginMissing');
    try {
      return parseAgeSignal(await deps.request(AGE_ASSURANCE_POLICY.requestPolicy));
    } catch {
      return unavailable('requestFailed');
    }
  })().then((signal) => {
    settled = signal;
    listeners.forEach((listener) => listener(signal));
    return signal;
  });
  return launchSignal;
}

/** The settled signal, or null while the first request is still running. */
export function settledAgeSignal(): AgeSignal | null {
  if (settled) return settled;
  // The website and plugin-less builds settle synchronously.
  if (!defaultDeps.available()) return unavailable('pluginMissing');
  return null;
}

export function onAgeSignal(listener: (signal: AgeSignal) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * For a known minor who is signed in: register the app's signed app
 * transaction with the server, once per account per launch. Never throws.
 */
export async function registerAppTransactionIfMinor(
  userId: string,
  signal: AgeSignal,
  overrides: Partial<AgeRangeDeps> = {}
): Promise<'registered' | 'skipped' | 'failed'> {
  if (!isKnownMinor(signal) || registeredFor.has(userId)) return 'skipped';
  const deps = { ...defaultDeps, ...overrides };
  registeredFor.add(userId);
  try {
    const jws = await deps.signedAppTransaction();
    if (!jws) return 'skipped';
    await deps.register(jws);
    return 'registered';
  } catch {
    // Try again at the next launch.
    registeredFor.delete(userId);
    return 'failed';
  }
}

/** Test seam. */
export function resetAgeSignalForTests(): void {
  launchSignal = null;
  settled = null;
  listeners.clear();
  registeredFor.clear();
}
