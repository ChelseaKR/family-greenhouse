/**
 * Passkeys (#671, second half): the wire contract the auth Lambda
 * (handlers/auth/passkeys.ts) and the local mock (local-server-passkeys.ts)
 * share.
 *
 * Cognito's native WebAuthn does the cryptography. It issues the creation and
 * request options, verifies the attestation on registration and the signature
 * on every sign-in, and stores the public keys. This app moves JSON between
 * the browser's `navigator.credentials` and Cognito and never sees a private
 * key — there is not one to see.
 *
 * Inert until the owner turns it on: `passkeys_enabled` in Terraform sets the
 * pool's `web_authn_configuration`, adds `WEB_AUTHN` to its sign-in policy,
 * allows `ALLOW_USER_AUTH` on the app client, and sets PASSKEYS_ENABLED=1 on
 * the auth Lambda. Until then every passkey route answers 404
 * PASSKEYS_DISABLED and the client shows no passkey control at all.
 */
import { z } from 'zod';

/**
 * A WebAuthn credential serialized to JSON (the WebAuthn Level 3
 * `toJSON()` shape: base64url strings, nested `response`). Cognito validates
 * it; here it is only bounded, so an abusive body is refused before it is
 * forwarded. Real ones are 1-3 KB.
 */
const credentialJsonSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
  })
  .passthrough()
  .refine((value) => JSON.stringify(value).length <= 16_384, 'Credential too large');

/** POST /auth/login/passkey/start — which account is signing in. */
export const passkeySignInStartSchema = z.object({
  email: z.string().email(),
});

/** POST /auth/login/passkey/finish — the browser's assertion. */
export const passkeySignInFinishSchema = z.object({
  username: z.string().min(1).max(256),
  session: z.string().min(1).max(4096),
  credential: credentialJsonSchema,
});

/**
 * POST /auth/passkeys/register/start — adding a sign-in method re-proves the
 * person first, as authenticator setup does: the password, plus a current
 * code when the account has an authenticator app on.
 */
export const passkeyRegisterStartSchema = z.object({
  password: z.string().min(1).max(256),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

/** POST /auth/passkeys/register/finish — the browser's attestation. */
export const passkeyRegisterFinishSchema = z.object({
  credential: credentialJsonSchema,
});

export type PasskeySignInStartInput = z.infer<typeof passkeySignInStartSchema>;
export type PasskeySignInFinishInput = z.infer<typeof passkeySignInFinishSchema>;
export type PasskeyRegisterStartInput = z.infer<typeof passkeyRegisterStartSchema>;
export type PasskeyRegisterFinishInput = z.infer<typeof passkeyRegisterFinishSchema>;

export const PASSKEY_ERROR_CODES = [
  /** The deployment has passkeys off (the default). */
  'PASSKEYS_DISABLED',
  /** No passkey is registered for that account (or no such account). */
  'NO_PASSKEY',
  /** Cognito refused the passkey ceremony (origin, RP ID, signature...). */
  'PASSKEY_REJECTED',
  /** The registration or sign-in ceremony expired; start again. */
  'PASSKEY_EXPIRED',
  /** Re-authentication needs an authenticator code as well. */
  'CODE_REQUIRED',
] as const;

export type PasskeyErrorCode = (typeof PASSKEY_ERROR_CODES)[number];

/** One registered passkey, as the Security page lists it. */
export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string | null;
  /** 'platform' (this device's keychain) | 'cross-platform' (a security key) | null */
  attachment: string | null;
}

/** POST /auth/login/passkey/start */
export interface PasskeySignInChallenge {
  session: string;
  username: string;
  /** PublicKeyCredentialRequestOptions, JSON-serialized (base64url fields). */
  options: Record<string, unknown>;
}

export function passkeysEnabled(): boolean {
  return process.env.PASSKEYS_ENABLED === '1';
}
