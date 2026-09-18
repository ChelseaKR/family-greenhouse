import { describe, expect, it } from 'vitest';
import {
  isReplyToken,
  newReplyToken,
  replyAddress,
  replyConfig,
  replyDomain,
  tokenFromRecipient,
} from '../../../../src/services/email/replyAddress.js';
import { hashCapabilityToken } from '../../../../src/utils/tokenHash.js';

const DOMAIN = 'familygreenhouse.net';
const TOKEN = 'a'.repeat(40);

describe('reply tokens', () => {
  it('are 160 random bits as 40 lowercase hex characters', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newReplyToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fit inside the 64-octet local-part limit with the care+ prefix', () => {
    const local = replyAddress(newReplyToken(), DOMAIN).split('@')[0];
    expect(local.length).toBeLessThanOrEqual(64);
  });

  it('refuses to build an address around something that is not a token', () => {
    expect(() => replyAddress('not-a-token', DOMAIN)).toThrow();
    expect(() => replyAddress(`${TOKEN}\r\nBcc: x@evil.test`, DOMAIN)).toThrow();
  });
});

describe('tokenFromRecipient', () => {
  it('round-trips the address it built', () => {
    const token = newReplyToken();
    expect(tokenFromRecipient(replyAddress(token, DOMAIN), DOMAIN)).toBe(token);
  });

  it('survives a mail system upper-casing the address (hex is case-free)', () => {
    expect(tokenFromRecipient(`CARE+${TOKEN.toUpperCase()}@FamilyGreenhouse.NET`, DOMAIN)).toBe(
      TOKEN
    );
  });

  it.each([
    ['another mailbox', `support+${TOKEN}@${DOMAIN}`],
    ['no label', `care@${DOMAIN}`],
    ['a second label', `care+x+${TOKEN}@${DOMAIN}`],
    ['39 characters', `care+${TOKEN.slice(1)}@${DOMAIN}`],
    ['41 characters', `care+${TOKEN}a@${DOMAIN}`],
    ['non-hex', `care+${'g'.repeat(40)}@${DOMAIN}`],
    ['a look-alike domain', `care+${TOKEN}@${DOMAIN}.evil.test`],
    ['a subdomain', `care+${TOKEN}@mail.${DOMAIN}`],
    ['no domain', `care+${TOKEN}`],
  ])('rejects %s', (_label, address) => {
    expect(tokenFromRecipient(address, DOMAIN)).toBeNull();
  });

  it('rejects a stored digest presented as a token', () => {
    // A digest is 64 hex characters: exactly what a table export would yield.
    const digest = hashCapabilityToken('emailReply', TOKEN);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(isReplyToken(digest)).toBe(false);
    expect(tokenFromRecipient(`care+${digest}@${DOMAIN}`, DOMAIN)).toBeNull();
  });
});

describe('replyConfig', () => {
  it('is off by default — no environment, no reply addresses', () => {
    expect(replyConfig({})).toEqual({ enabled: false });
  });

  it('is off with the flag but no domain, and with a domain but no flag', () => {
    expect(replyConfig({ EMAIL_REPLY_ACTIONS_ENABLED: 'true' })).toEqual({ enabled: false });
    expect(replyConfig({ EMAIL_REPLY_DOMAIN: DOMAIN })).toEqual({ enabled: false });
    expect(
      replyConfig({ EMAIL_REPLY_ACTIONS_ENABLED: 'false', EMAIL_REPLY_DOMAIN: DOMAIN })
    ).toEqual({ enabled: false });
  });

  it('is off for a domain that is not a hostname', () => {
    expect(
      replyConfig({ EMAIL_REPLY_ACTIONS_ENABLED: 'true', EMAIL_REPLY_DOMAIN: 'x@y.z' })
    ).toEqual({ enabled: false });
  });

  it('is on only with both', () => {
    expect(
      replyConfig({
        EMAIL_REPLY_ACTIONS_ENABLED: 'true',
        EMAIL_REPLY_DOMAIN: 'FamilyGreenhouse.net',
      })
    ).toEqual({ enabled: true, domain: DOMAIN });
  });

  it('keeps the receiving domain available while minting is off', () => {
    expect(replyDomain({ EMAIL_REPLY_DOMAIN: DOMAIN })).toBe(DOMAIN);
    expect(replyDomain({})).toBeNull();
  });
});
