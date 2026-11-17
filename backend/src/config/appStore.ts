import { paymentsAreAvailable } from './commercialStatus.js';

/**
 * Apple In-App Purchase switches and constants (ADR 0041).
 *
 * OFF by default. The three /billing/app-store/* routes answer 404 until
 * `APP_STORE_BILLING_ENABLED` is exactly "1" AND payments are available at
 * all (`paymentsAreAvailable`: the repository commercial hold is off and
 * `PAYMENTS_ENABLED` is "1"). Values such as "true" or " 1" stay off, the
 * same rule as `PAYMENTS_ENABLED`.
 *
 * What the switch does NOT gate: reading an App Store subscription already
 * recorded on a household row. Entitlement always honors one, so turning the
 * switch off never takes away a plan somebody paid Apple for, and the web
 * checkout keeps refusing a second subscription on top of it.
 */
export function appStoreBillingEnabled(): boolean {
  return process.env.APP_STORE_BILLING_ENABLED === '1' && paymentsAreAvailable();
}

/** The iPhone app's bundle id (capacitor.config.ts `appId`). */
export const APP_STORE_BUNDLE_ID = 'net.familygreenhouse.app';

/**
 * The app's Apple ID in App Store Connect. Production notifications carry it
 * as `appAppleId`, and one that names a different app is refused.
 */
export const APP_STORE_APP_APPLE_ID = 6812185914;

/**
 * Which App Store environments' transactions grant entitlement (ADR 0045).
 *
 * Production only, unless the deployment opts in. A Sandbox purchase is a
 * test purchase nobody paid for, so it grants a plan only where that is
 * intended. `APP_STORE_ENVIRONMENTS` (comma separated) is the opt-in: staging
 * sets "Production,Sandbox", and production sets it only for the days App
 * Review needs it, because App Review buys with Sandbox accounts against the
 * production server.
 *
 * Unset means Production. A value that names neither environment accepts
 * nothing, so a typo closes the door instead of opening it. `Xcode` and
 * `LocalTesting` are never accepted: those are signed by a certificate on
 * the developer's Mac, not by Apple, and cannot pass `verifyAppleJws`.
 */
export function appStoreEnvironments(): ReadonlySet<string> {
  const raw = process.env.APP_STORE_ENVIRONMENTS;
  const listed = (raw ?? 'Production')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s === 'Production' || s === 'Sandbox');
  return new Set(listed);
}
