/**
 * The browser half of passkeys (#671): turn the JSON options Cognito issues
 * into the ArrayBuffer-shaped options `navigator.credentials` takes, and the
 * resulting credential back into the WebAuthn Level 3 JSON Cognito verifies.
 *
 * Done by hand rather than with `PublicKeyCredential.parseCreationOptionsFromJSON`
 * / `toJSON()`, which are recent (Chrome 129, Safari 18, Firefox 119): the
 * conversion is a handful of base64url fields, and doing it here keeps older
 * browsers that DO support WebAuthn working. No cryptography happens in this
 * file — the authenticator signs, Cognito verifies.
 *
 * Where passkeys cannot run, `passkeysUsableHere()` is false and callers
 * render no passkey control at all (absent, not broken):
 *   - browsers without WebAuthn;
 *   - the Capacitor iOS/Android shells. Their web content is served from
 *     capacitor://localhost (iOS) / https://localhost (Android), not from the
 *     relying party's domain, so a WebAuthn ceremony for familygreenhouse.net
 *     cannot run inside the WebView. Native passkeys need the owner steps in
 *     docs/security.md (webcredentials AASA entry, Associated Domains
 *     entitlement, a native passkey bridge) before this gate can lift.
 */
import { isNativeApp } from './platform';

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/** WebAuthn in a browser on the relying party's own origin. */
export function passkeysUsableHere(): boolean {
  return !isNativeApp() && isWebAuthnSupported();
}

export function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;

interface CredentialDescriptorJson {
  id: string;
  type: string;
  transports?: string[];
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as CredentialDescriptorJson[]).map((d) => ({
    type: 'public-key',
    id: base64urlToBuffer(d.id),
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  }));
}

/** Cognito's CredentialCreationOptions (JSON) → what credentials.create takes. */
export function toCreationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as { id: string; name: string; displayName: string };
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64urlToBuffer(json.challenge as string),
    user: { ...user, id: base64urlToBuffer(user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** Cognito's CREDENTIAL_REQUEST_OPTIONS (JSON) → what credentials.get takes. */
export function toRequestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64urlToBuffer(json.challenge as string),
    allowCredentials: descriptors(json.allowCredentials),
  };
}

/** A new credential → RegistrationResponseJSON. */
export function registrationToJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports:
        typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    },
  };
}

/** An assertion → AuthenticationResponseJSON. */
export function assertionToJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
    },
  };
}

/** Run the registration ceremony. Rejects with the browser's DOMException. */
export async function createPasskey(options: Json): Promise<Json> {
  const credential = (await navigator.credentials.create({
    publicKey: toCreationOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('No credential was created', 'NotAllowedError');
  return registrationToJson(credential);
}

/** Run the sign-in ceremony. Rejects with the browser's DOMException. */
export async function getPasskeyAssertion(options: Json): Promise<Json> {
  const credential = (await navigator.credentials.get({
    publicKey: toRequestOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('No passkey was chosen', 'NotAllowedError');
  return assertionToJson(credential);
}

/** The person closed or declined the browser's passkey sheet. */
export function isCeremonyCanceled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}
