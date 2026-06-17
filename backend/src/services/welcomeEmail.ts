/**
 * One-time welcome email, sent when a brand-new user finishes setup by
 * creating their very first household.
 *
 * Like the digest/recap emails this is plain text (emailNotifier ships no HTML
 * yet) and goes straight through `emailNotifier.sendEmail` — it's a single
 * transactional onboarding touch, not a real-time ping, so it skips the
 * `notifier.sendToUser` channel fan-out and the DND window.
 *
 * Fire-once + best-effort are the caller's responsibility: the handler only
 * calls this on the genuine first-household path (the user had no household
 * before), and wraps it in try/catch so a flaky SES region can never break
 * onboarding. See handlers/households/handler.ts.
 */
import { logger } from '../utils/logger.js';
import * as emailNotifier from './emailNotifier.js';

/** Compose the plain-text welcome email. Pure + exported so it's unit-testable
 *  and the copy can be asserted without reaching SES. `appUrl` is the
 *  FRONTEND_URL base (no trailing slash); links hang off it. */
export function composeWelcomeEmail(
  userName: string,
  appUrl: string
): { subject: string; text: string } {
  const base = appUrl.replace(/\/+$/, '');
  // A genuine first name when we have one, otherwise a warm generic greeting.
  const greeting = userName.trim() ? `Hi ${userName.trim()},` : 'Hi there,';
  const subject = 'Welcome to Family Greenhouse 🌱';
  const text = [
    greeting,
    '',
    "You're all set up — welcome to Family Greenhouse. We're glad you're here.",
    '',
    'The best first step is to add your first plant. It takes less than a',
    'minute: give it a name, or start from a species suggestion and we’ll fill',
    'in the care details for you.',
    '',
    `Add your first plant: ${base}/plants/new`,
    '',
    'A couple of small tips to get started:',
    '  - Most houseplants would rather be a little too dry than too wet — when',
    '    in doubt, wait a day and check the soil with your finger.',
    '  - Bright, indirect light suits the widest range of plants. A spot near a',
    '    window that never gets harsh midday sun is a safe bet.',
    '',
    `Not sure where to begin? Our care guides cover the popular plants: ${base}/care`,
    '',
    'Happy growing,',
    'The Family Greenhouse team',
  ].join('\n');
  return { subject, text };
}

/**
 * Send the welcome email to a newly-onboarded user. Best-effort: any failure
 * is logged and swallowed so it can never break the household-creation flow.
 * Returns true if a send was attempted without throwing (a dry-run when SES is
 * unconfigured still counts), false if it failed.
 */
export async function sendWelcomeEmail(
  userId: string,
  email: string,
  userName: string,
  appUrl: string
): Promise<boolean> {
  try {
    const { subject, text } = composeWelcomeEmail(userName, appUrl);
    await emailNotifier.sendEmail({ to: email, subject, text });
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId, msg: 'welcome_email_failed' },
      'welcome_email_failed'
    );
    return false;
  }
}
