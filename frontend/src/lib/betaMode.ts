/**
 * Legacy beta badge flag. It is presentation-only and cannot enable pricing,
 * registration, Checkout, or billing controls. Those remain governed by the
 * repository commercial status plus server and infrastructure backstops.
 */

const RAW = (import.meta.env.VITE_BETA_MODE ?? 'true').toString().toLowerCase();

export const IS_BETA = RAW !== 'false' && RAW !== '0' && RAW !== 'no';

/** Short badge text for headers/nav. */
export const BETA_BADGE = 'Beta';
