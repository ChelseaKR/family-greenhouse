/**
 * Cognito CustomMessage trigger.
 *
 * Cognito's `verification_message_template` covers sign-up confirmation and
 * nothing else, so forgot-password shipped AWS's stock body ("Your verification
 * code is NNNNNN") from the SAME From: address as the carefully written signup
 * email. That identity break lands on the one message a locked-out user has to
 * trust, which is exactly the message a phishing lookalike would target.
 *
 * This trigger is the only mechanism Cognito offers for that path. It renders
 * ForgotPassword and AdminCreateUser in the voice of the sign-up template
 * (infrastructure/modules/auth/main.tf) and returns every other trigger source
 * UNTOUCHED, so the declarative templates stay authoritative where they exist.
 *
 * Contract notes:
 *   - The handler must return the whole event object, with `response` filled in.
 *   - `request.codeParameter` is the literal placeholder Cognito substitutes
 *     (`{####}`); `request.usernameParameter` is `{username}`. They must appear
 *     verbatim in the body — building the string from the real code is not
 *     possible here, and hardcoding "{####}" would break if Cognito ever
 *     changed the token.
 *   - Bodies are plain text with real newlines, matching the sign-up template
 *     already in production.
 */

const SITE_URL = process.env.SITE_URL ?? 'https://familygreenhouse.net';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? '';

const SIGN_OFF = SUPPORT_EMAIL
  ? `— The Family Greenhouse team\n${SITE_URL}\nQuestions? Just reply, or write to ${SUPPORT_EMAIL}.`
  : `— The Family Greenhouse team\n${SITE_URL}`;

/** Voice check: greet, say what happened, give the code, say what to do if it
 *  wasn't them. Same shape and sign-off as the sign-up template. */
export function forgotPasswordMessage(codeParameter) {
  return [
    'Hi there,',
    '',
    'Someone asked to reset the password on your Family Greenhouse account.',
    'If that was you, here is the code:',
    '',
    `Your password reset code is: ${codeParameter}`,
    '',
    'Pop that into the reset screen to choose a new password.',
    'The code expires in 1 hour.',
    '',
    "Didn't ask for this? You can safely ignore this email — your password",
    "hasn't changed, and nobody can reset it without this code.",
    '',
    SIGN_OFF,
  ].join('\n');
}

export function adminInviteMessage(usernameParameter, codeParameter) {
  return [
    'Hi there,',
    '',
    'Someone has set up a Family Greenhouse account for you — the family',
    'plant-care app that helps you grow together.',
    '',
    `Your username is: ${usernameParameter}`,
    `Your temporary password is: ${codeParameter}`,
    '',
    `Sign in at ${SITE_URL} and you'll be asked to choose your own password.`,
    'The temporary one stops working once you do.',
    '',
    'Not expecting this? You can safely ignore this email — the account stays',
    'locked until someone signs in with the password above.',
    '',
    SIGN_OFF,
  ].join('\n');
}

/**
 * The switch value the confirm-reminder pass sends as ClientMetadata
 * (backend/src/services/confirmReminders.ts, `REMINDER_CLIENT_METADATA`).
 *
 * ResendConfirmationCode is a public API, so clientMetadata is caller-supplied.
 * It is therefore used ONLY as a switch and nothing from it reaches the body.
 * Anyone who sets it gets this copy instead of the welcome copy, for an address
 * they could already trigger a resend for, which changes nothing they can do.
 */
export const REMINDER_PURPOSE = 'confirm-reminder';

/**
 * The ONE automatic reminder for an account that signed up and never
 * confirmed. Sent 24 hours to 7 days after sign-up, when the first code has
 * expired, so it carries a fresh one. Same voice, sign-off and language as the
 * sign-up template (English only, as that template is).
 *
 * No tracking of any kind: the one link is the plain confirmation page, with no
 * query string, no redirect and no image.
 */
export function confirmReminderMessage(codeParameter) {
  return [
    'Hi there,',
    '',
    'You started signing up for Family Greenhouse but have not confirmed your',
    'email address yet. The code in our first email has expired, so here is a',
    'new one:',
    '',
    `Your verification code is: ${codeParameter}`,
    '',
    `To finish, open ${SITE_URL}/confirm-email and enter the email address`,
    'you signed up with, then this code. It expires in 24 hours.',
    '',
    "This is the only reminder we'll send. Didn't sign up? You can safely",
    'ignore this email — the account is never activated without the code.',
    '',
    SIGN_OFF,
  ].join('\n');
}

export const handler = async (event) => {
  const { triggerSource, request, response } = event;

  if (
    triggerSource === 'CustomMessage_ResendCode' &&
    request.clientMetadata?.purpose === REMINDER_PURPOSE
  ) {
    response.emailSubject = 'Finish setting up Family Greenhouse — here is a new code';
    response.emailMessage = confirmReminderMessage(request.codeParameter);
    return event;
  }

  if (triggerSource === 'CustomMessage_ForgotPassword') {
    response.emailSubject = 'Reset your Family Greenhouse password';
    response.emailMessage = forgotPasswordMessage(request.codeParameter);
    return event;
  }

  if (triggerSource === 'CustomMessage_AdminCreateUser') {
    response.emailSubject = 'You have been invited to Family Greenhouse';
    response.emailMessage = adminInviteMessage(request.usernameParameter, request.codeParameter);
    return event;
  }

  // Every other source (SignUp, ResendCode, VerifyUserAttribute, ...) keeps the
  // pool's declarative template. Returning the event unmodified is how Cognito
  // is told "no override" — writing an empty string would send an empty email.
  return event;
};
