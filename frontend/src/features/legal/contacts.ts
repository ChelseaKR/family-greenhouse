/**
 * Contact addresses the legal and support pages point readers at. They are
 * constants rather than catalog strings so every locale interpolates the same
 * address (`{{supportEmail}}`) instead of carrying a per-locale copy that
 * could drift from the inbox that actually answers.
 */
export const SUPPORT_EMAIL = 'support@familygreenhouse.net';
export const HELLO_EMAIL = 'hello@familygreenhouse.net';

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
export const HELLO_MAILTO = `mailto:${HELLO_EMAIL}`;

/** Pre-filled subject so a request from someone who cannot sign in is easy to triage. */
export const ACCOUNT_DELETION_MAILTO = `${SUPPORT_MAILTO}?subject=Account%20deletion%20request`;
