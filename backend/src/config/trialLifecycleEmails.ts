/**
 * The switch for the two no-card-trial lifecycle emails (ADR 0039): "your
 * trial ends in N days" and "you are back on Seedling, nothing was deleted".
 *
 * OFF unless the environment variable is exactly the string `true`. Anything
 * else, including unset, `1`, `TRUE` and a padded value, is off: a switch that
 * sends mail to real households should not be turned on by a typo or by a
 * truthy-looking value somebody did not mean. Same fail-closed reading
 * `isPaymentActivityAllowed` applies to `PAYMENTS_ENABLED`.
 *
 * Read per call rather than once at import, so a test (or a Lambda whose
 * environment is changed) sees the current value.
 */
export function trialLifecycleEmailsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRIAL_LIFECYCLE_EMAILS_ENABLED === 'true';
}
