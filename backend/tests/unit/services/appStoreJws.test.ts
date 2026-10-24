/**
 * Apple JWS verification (ADR 0041). The chain is a throwaway one built by
 * openssl for this run (tests/support/appleJwsFixture.ts), trusted only by
 * passing its root explicitly; the default trust is Apple Root CA - G3 alone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import {
  APPLE_ROOT_CA_G3_PEM,
  AppStoreVerificationError,
  oidToDer,
  verifyAppleJws,
} from '../../../src/services/appStoreJws.js';
import { makeChain, signJws, type ChainFixture } from '../../support/appleJwsFixture.js';

// Now, so the freshly made chain is valid at the signing time.
const NOW = Date.now();

let chain: ChainFixture;
let other: ChainFixture;
beforeAll(() => {
  chain = makeChain();
  other = makeChain();
}, 30_000);

const trust = () => ({ trustedRootsPem: [chain.rootPem] });

describe('verifyAppleJws', () => {
  it('pins Apple Root CA - G3 by its published SHA-256 fingerprint', () => {
    const der = new X509Certificate(APPLE_ROOT_CA_G3_PEM).raw;
    expect(createHash('sha256').update(der).digest('hex').toUpperCase()).toBe(
      '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179'
    );
  });

  it('encodes Apple marker OIDs as DER', () => {
    expect(oidToDer('1.2.840.113635.100.6.11.1').toString('hex')).toBe('060a2a864886f76364060b01');
  });

  it('returns the payload of a JWS signed through a trusted chain', () => {
    const jws = signJws(chain, { productId: 'x', signedDate: NOW });
    expect(verifyAppleJws(jws, trust())).toEqual({ productId: 'x', signedDate: NOW });
  });

  it('refuses a chain that is not Apple’s by default', () => {
    const jws = signJws(chain, { signedDate: NOW });
    expect(() => verifyAppleJws(jws)).toThrow(/trusted root/);
  });

  it('refuses a chain ending at a different root than the trusted one', () => {
    const jws = signJws(other, { signedDate: NOW });
    expect(() => verifyAppleJws(jws, trust())).toThrow(AppStoreVerificationError);
  });

  it('refuses a payload changed after signing', () => {
    const jws = signJws(chain, { productId: 'garden', signedDate: NOW });
    const [h, , s] = jws.split('.');
    const forged = Buffer.from(
      JSON.stringify({ productId: 'greenhouse', signedDate: NOW })
    ).toString('base64url');
    expect(() => verifyAppleJws(`${h}.${forged}.${s}`, trust())).toThrow(/signature/);
  });

  it('refuses a leaf from another chain presented with the trusted root', () => {
    const mixed = {
      ...other,
      x5c: [other.x5c[0], chain.x5c[1], chain.x5c[2]] as [string, string, string],
    };
    const jws = signJws(mixed, { signedDate: NOW });
    expect(() => verifyAppleJws(jws, trust())).toThrow(/leaf/);
  });

  it('refuses alg none and a missing chain', () => {
    const body = Buffer.from('{}').toString('base64url');
    const none = Buffer.from(JSON.stringify({ alg: 'none', x5c: chain.x5c })).toString('base64url');
    expect(() => verifyAppleJws(`${none}.${body}.sig`, trust())).toThrow(/ES256/);
    const bare = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    expect(() => verifyAppleJws(`${bare}.${body}.sig`, trust())).toThrow(/x5c/);
    expect(() => verifyAppleJws('not-a-jws', trust())).toThrow(/three segments/);
  });

  it('refuses a leaf without Apple’s receipt-signing marker', () => {
    const noMarker = makeChain({ leafMarker: false });
    const jws = signJws(noMarker, { signedDate: NOW });
    expect(() => verifyAppleJws(jws, { trustedRootsPem: [noMarker.rootPem] })).toThrow(
      /leaf lacks/
    );
  }, 30_000);

  it('refuses an intermediate without Apple’s WWDR marker', () => {
    const noMarker = makeChain({ intermediateMarker: false });
    const jws = signJws(noMarker, { signedDate: NOW });
    expect(() => verifyAppleJws(jws, { trustedRootsPem: [noMarker.rootPem] })).toThrow(
      /intermediate lacks/
    );
  }, 30_000);

  it('refuses a payload signed when the chain was not valid', () => {
    const jws = signJws(chain, { signedDate: Date.UTC(2001, 0, 1) });
    expect(() => verifyAppleJws(jws, trust())).toThrow(/not valid at signedDate/);
  });
});
