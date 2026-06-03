/**
 * Single source of truth for the "beta" flag. Defaults to true so a fresh
 * build is safe — payment surfaces stay hidden until the operator
 * deliberately flips `VITE_BETA_MODE=false`.
 *
 * Behavior gates:
 *   - When true: pricing cards show "Free during beta", checkout CTAs are
 *     swapped for "Sign up free", BillingSettings hides upgrade buttons
 *     and shows a beta banner.
 *   - When false: regular pricing + Stripe checkout buttons.
 *
 * This is a *display* flag. The backend's plan caps (Seedling: 10 plants,
 * Garden: 500, Greenhouse: 5000) still apply — beta accounts get whatever
 * plan their Cognito-stored subscription says. Defaulting to Seedling at
 * sign-up means beta users get the free-tier caps, which is intended.
 */

const RAW = (import.meta.env.VITE_BETA_MODE ?? 'true').toString().toLowerCase();

export const IS_BETA = RAW !== 'false' && RAW !== '0' && RAW !== 'no';

/** Display string surfaced wherever payment used to live. */
export const BETA_NOTICE = 'Free during beta — pricing shown for reference only, no charges yet.';

/** Short badge text for headers/nav. */
export const BETA_BADGE = 'Beta';
