import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import https from 'node:https';
import {
  BlockedAddressError,
  checkHostResolvesPublic,
  createGuardedLookup,
  isBlockedAddress,
} from '../../../src/services/channelSsrfGuard.js';

/**
 * The SSRF guard for the household chat channel (#674). Every blocked range is
 * paired with a public address the guard must let through — a guard that
 * blocked everything would pass the blocked half of this file on its own.
 */

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback, top of range'],
    ['10.1.2.3', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918'],
    ['172.31.255.255', 'RFC 1918, top'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'EC2 / Lambda metadata service'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.10', 'documentation'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00:ec2::254', 'IPv6 metadata service (ULA)'],
    ['fc00::1', 'ULA'],
    ['::ffff:127.0.0.1', 'v4-mapped loopback'],
    ['::ffff:a9fe:a9fe', 'v4-mapped metadata service, hex form'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of the metadata service'],
    ['2002:a9fe:a9fe::1', '6to4 embedding the metadata service'],
    ['2001:db8::1', 'documentation'],
    ['ff02::1', 'multicast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['162.159.135.232', 'a Discord edge address'],
    ['34.206.52.1', 'an AWS public address (Slack is hosted there)'],
    ['8.8.8.8', 'ordinary public v4'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['100.128.0.1', 'just outside CGNAT'],
    ['169.253.255.255', 'just below link-local'],
    ['2606:4700::6810:84e5', 'ordinary public v6'],
    ['2001:4860:4860::8888', 'public v6 inside 2001::/16 but outside 2001::/23'],
  ])('allows %s (%s) — the negative control', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('fails closed on anything that is not an IP at all', () => {
    expect(isBlockedAddress('discord.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

type ResolveFn = Parameters<typeof createGuardedLookup>[0];

function resolverFor(answers: LookupAddress[] | Error): NonNullable<ResolveFn> {
  return (_hostname, _options, callback) => {
    if (answers instanceof Error) callback(answers as NodeJS.ErrnoException, []);
    else callback(null, answers);
  };
}

const PUBLIC: LookupAddress = { address: '162.159.135.232', family: 4 };
const METADATA: LookupAddress = { address: '169.254.169.254', family: 4 };

describe('createGuardedLookup', () => {
  it('passes a public answer through in the single-address form', () => {
    const cb = vi.fn();
    createGuardedLookup(resolverFor([PUBLIC]))('discord.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, PUBLIC.address, 4);
  });

  it('passes every answer through when Node asks for all of them', () => {
    const v6: LookupAddress = { address: '2606:4700::6810:84e5', family: 6 };
    const cb = vi.fn();
    createGuardedLookup(resolverFor([PUBLIC, v6]))('discord.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [PUBLIC, v6]);
  });

  it('refuses a name that resolves to the metadata service', () => {
    const cb = vi.fn();
    createGuardedLookup(resolverFor([METADATA]))('rebind.example.org', {}, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(BlockedAddressError);
  });

  it('refuses the WHOLE name when any one answer is private', () => {
    const cb = vi.fn();
    createGuardedLookup(resolverFor([PUBLIC, { address: '10.0.0.5', family: 4 }]))(
      'split.example.org',
      { all: true },
      cb
    );
    expect(cb.mock.calls[0][0]).toBeInstanceOf(BlockedAddressError);
  });

  it('refuses an empty answer set rather than connecting to nothing', () => {
    const cb = vi.fn();
    createGuardedLookup(resolverFor([]))('empty.example.org', {}, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(BlockedAddressError);
  });

  it('passes a DNS failure through as itself, not as "blocked"', () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const cb = vi.fn();
    createGuardedLookup(resolverFor(notFound))('nope.example.org', {}, cb);
    expect(cb.mock.calls[0][0]).toBe(notFound);
  });

  it('accepts the (hostname, callback) call shape too', () => {
    const cb = vi.fn();
    createGuardedLookup(resolverFor([PUBLIC]))('discord.com', cb as never);
    expect(cb).toHaveBeenCalledWith(null, PUBLIC.address, 4);
  });
});

describe('checkHostResolvesPublic', () => {
  it('names the three outcomes separately', async () => {
    await expect(checkHostResolvesPublic('a.example.org', resolverFor([PUBLIC]))).resolves.toBe(
      'public'
    );
    await expect(checkHostResolvesPublic('b.example.org', resolverFor([METADATA]))).resolves.toBe(
      'blocked'
    );
    await expect(
      checkHostResolvesPublic('c.example.org', resolverFor(new Error('ENOTFOUND')))
    ).resolves.toBe('unresolvable');
  });
});

describe('wired into a real https.request', () => {
  // The guard only protects anything if Node actually consults it and turns
  // its refusal into a request error BEFORE a socket opens. Uses the real
  // `https.request`; the resolver answers with the metadata address, so there
  // is no network access either way.
  it('a blocked answer surfaces as the request error, with no connection made', async () => {
    const resolver = vi.fn(resolverFor([METADATA]));
    const lookup = createGuardedLookup(resolver);
    const error = await new Promise<Error>((resolve) => {
      const req = https.request(
        new URL('https://rebind.example.org/webhook/abcdefgh'),
        { method: 'POST', lookup: lookup as never },
        () => resolve(new Error('unexpected response'))
      );
      req.on('error', resolve);
      req.on('socket', (socket) => {
        socket.on('connect', () => resolve(new Error('socket connected')));
      });
      req.end('{}');
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(BlockedAddressError);
  });
});
