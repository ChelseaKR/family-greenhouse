import { afterEach, describe, expect, it } from 'vitest';
import {
  assertionToJson,
  base64urlToBuffer,
  bufferToBase64url,
  isCeremonyCancelled,
  passkeysUsableHere,
  registrationToJson,
  toCreationOptions,
  toRequestOptions,
} from '@/lib/webauthn';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const asArray = (buffer: ArrayBuffer | BufferSource) =>
  Array.from(new Uint8Array(buffer as ArrayBuffer));

type WindowWithShims = Window & { PublicKeyCredential?: unknown; Capacitor?: unknown };

/** jsdom has no WebAuthn; give it the two globals a real browser has. */
function installWebAuthn() {
  (window as WindowWithShims).PublicKeyCredential = function PublicKeyCredential() {};
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: () => Promise.resolve(null), get: () => Promise.resolve(null) },
  });
}

afterEach(() => {
  delete (window as WindowWithShims).PublicKeyCredential;
  delete (window as WindowWithShims).Capacitor;
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes, including the URL-unsafe ones', () => {
    const raw = bytes(0, 251, 255, 62, 63, 1, 2);
    const encoded = bufferToBase64url(raw);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(asArray(base64urlToBuffer(encoded))).toEqual(asArray(raw));
  });

  it('decodes unpadded input of every length', () => {
    for (const text of ['f', 'fo', 'foo', 'foob']) {
      const encoded = bufferToBase64url(new TextEncoder().encode(text).buffer);
      expect(new TextDecoder().decode(base64urlToBuffer(encoded))).toBe(text);
    }
  });
});

describe('Cognito JSON options → navigator.credentials options', () => {
  it('creation: challenge, user.id and excludeCredentials become bytes; the rest passes through', () => {
    const options = toCreationOptions({
      challenge: bufferToBase64url(bytes(1, 2, 3)),
      rp: { id: 'familygreenhouse.net', name: 'Family Greenhouse' },
      user: { id: bufferToBase64url(bytes(9, 9)), name: 'a@example.com', displayName: 'A' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ type: 'public-key', id: bufferToBase64url(bytes(7)) }],
      authenticatorSelection: { userVerification: 'required' },
    });
    expect(asArray(options.challenge)).toEqual([1, 2, 3]);
    expect(asArray(options.user.id)).toEqual([9, 9]);
    expect(asArray(options.excludeCredentials![0].id)).toEqual([7]);
    expect(options.rp).toEqual({ id: 'familygreenhouse.net', name: 'Family Greenhouse' });
    expect(options.authenticatorSelection).toEqual({ userVerification: 'required' });
  });

  it('request: challenge and allowCredentials become bytes', () => {
    const options = toRequestOptions({
      challenge: bufferToBase64url(bytes(4, 5)),
      rpId: 'familygreenhouse.net',
      allowCredentials: [
        { type: 'public-key', id: bufferToBase64url(bytes(8)), transports: ['internal'] },
      ],
    });
    expect(asArray(options.challenge)).toEqual([4, 5]);
    expect(options.rpId).toBe('familygreenhouse.net');
    expect(asArray(options.allowCredentials![0].id)).toEqual([8]);
    expect(options.allowCredentials![0].transports).toEqual(['internal']);
  });
});

describe('credential → WebAuthn Level 3 JSON', () => {
  it('registration', () => {
    const json = registrationToJson({
      id: 'abc',
      rawId: bytes(1),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes(2),
        attestationObject: bytes(3),
        getTransports: () => ['internal'],
      },
    } as unknown as PublicKeyCredential);
    expect(json).toEqual({
      id: 'abc',
      rawId: bufferToBase64url(bytes(1)),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: bufferToBase64url(bytes(2)),
        attestationObject: bufferToBase64url(bytes(3)),
        transports: ['internal'],
      },
    });
  });

  it('assertion, with and without a user handle', () => {
    const make = (userHandle: ArrayBuffer | null) =>
      assertionToJson({
        id: 'abc',
        rawId: bytes(1),
        type: 'public-key',
        authenticatorAttachment: null,
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: bytes(2),
          authenticatorData: bytes(3),
          signature: bytes(4),
          userHandle,
        },
      } as unknown as PublicKeyCredential);
    expect(make(bytes(5)).response).toEqual({
      clientDataJSON: bufferToBase64url(bytes(2)),
      authenticatorData: bufferToBase64url(bytes(3)),
      signature: bufferToBase64url(bytes(4)),
      userHandle: bufferToBase64url(bytes(5)),
    });
    expect((make(null).response as { userHandle?: string }).userHandle).toBeUndefined();
  });
});

describe('where passkeys can run', () => {
  it('not without WebAuthn (jsdom has none)', () => {
    expect(passkeysUsableHere()).toBe(false);
  });

  it('in a browser with WebAuthn', () => {
    installWebAuthn();
    expect(passkeysUsableHere()).toBe(true);
  });

  it('never inside the native shells, even where WebAuthn exists', () => {
    installWebAuthn();
    (window as WindowWithShims).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    expect(passkeysUsableHere()).toBe(false);
  });

  it('a closed or declined passkey sheet reads as cancelled; other errors do not', () => {
    expect(isCeremonyCancelled(new DOMException('x', 'NotAllowedError'))).toBe(true);
    expect(isCeremonyCancelled(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isCeremonyCancelled(new DOMException('x', 'SecurityError'))).toBe(false);
    expect(isCeremonyCancelled(new Error('NotAllowedError'))).toBe(false);
  });
});
