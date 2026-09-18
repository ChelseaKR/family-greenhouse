/**
 * SSRF guard for the household chat channel (#674).
 *
 * The Matrix option lets an admin name any host, and the server then makes a
 * POST to it from inside our AWS account, every morning, forever. Without a
 * guard that is a request forgery primitive aimed at whatever the Lambda can
 * reach: the instance metadata service (169.254.169.254, fd00:ec2::254), a
 * VPC-internal service, or loopback.
 *
 * The check runs on the address the SOCKET uses, not on a lookup made
 * beforehand. `guardedLookup` is handed to `https.request` as its `lookup`
 * option, so the name is resolved exactly once, by us, and connected to only
 * if every answer is public. A pre-flight `dns.lookup` followed by a normal
 * request would resolve twice, and a rebinding DNS server answers the second
 * one differently — the classic time-of-check/time-of-use hole.
 *
 * If ANY answer is private, the whole name is refused. Picking the public
 * answers out of a mixed set would let a name that is half-internal on
 * purpose pass.
 *
 * Discord and Slack go through the same guard. Their hosts are pinned by
 * `models/householdChannel.parseWebhookUrl`, but "the vendor's DNS will never
 * answer with a private address" is not something this code needs to trust.
 */
import * as dns from 'node:dns';
import net from 'node:net';

// Two lists, each consulted only for its own family. `net.BlockList` treats a
// v4 address as inside the v4-mapped `::ffff:0:0/96` subnet, so one shared
// list holding that subnet would block every IPv4 address on the internet —
// which is exactly what the negative controls in the tests caught.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();

/**
 * Every range that is not ordinary public unicast. IPv4 per the IANA special-
 * purpose registry; the list is deliberately wider than "RFC 1918" because the
 * dangerous destinations are elsewhere too (link-local metadata, CGNAT, the
 * benchmarking net some VPC appliances sit on).
 */
const V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes the EC2/Lambda metadata service
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112 direct delegation
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];

const V6_RANGES: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback and the deprecated v4-compatible block
  ['::ffff:0:0', 96], // v4-mapped: an answer in this form is a v4 address in disguise
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — embeds an arbitrary v4 address
  ['fc00::', 7], // unique local — includes fd00:ec2::254, the IPv6 metadata endpoint
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routable inside some networks)
  ['ff00::', 8], // multicast
];

for (const [address, prefix] of V4_RANGES) BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of V6_RANGES) BLOCKED_V6.addSubnet(address, prefix, 'ipv6');

/**
 * True when a webhook may NOT be delivered to this address. Anything that is
 * not a parseable IP is blocked: the guard fails closed.
 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(address, 'ipv6');
  return true;
}

/** Raised through the lookup callback, so `https.request` emits it as the
 *  request's own `error` and never opens a socket. */
export class BlockedAddressError extends Error {
  constructor(message = 'webhook host resolves to a non-public address') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number
) => void;

type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

/**
 * Build a `lookup` for `https.request` that refuses non-public answers.
 * `resolve` is injectable for tests; production uses `dns.lookup`.
 *
 * Node calls `lookup` with `{ all: true }` when it wants every address (the
 * happy-eyeballs path) and without it otherwise; both are honoured, and both
 * are checked against the FULL answer set.
 */
export function createGuardedLookup(resolve: LookupAll = dns.lookup) {
  return function guardedLookup(
    hostname: string,
    options: dns.LookupOptions | LookupCallback,
    callback?: LookupCallback
  ): void {
    const opts: dns.LookupOptions = typeof options === 'function' ? {} : (options ?? {});
    const done = (typeof options === 'function' ? options : callback) as LookupCallback;
    resolve(hostname, { family: opts.family ?? 0, all: true }, (err, addresses) => {
      if (err) {
        done(err);
        return;
      }
      const answers = Array.isArray(addresses) ? addresses : [];
      if (answers.length === 0 || answers.some((answer) => isBlockedAddress(answer.address))) {
        done(new BlockedAddressError());
        return;
      }
      if (opts.all) {
        done(null, answers);
        return;
      }
      done(null, answers[0].address, answers[0].family);
    });
  };
}

export const guardedLookup = createGuardedLookup();

export type HostCheck = 'public' | 'blocked' | 'unresolvable';

/**
 * Save-time check: does this name resolve, and only to public addresses?
 *
 * An early answer for the admin, NOT the security boundary — the boundary is
 * `guardedLookup` on every delivery, because DNS can change after this runs.
 * `unresolvable` is its own state, not `blocked`: a homeserver that is down
 * for a minute is not a private address, and saying so would be a lie.
 */
export async function checkHostResolvesPublic(
  hostname: string,
  resolve: LookupAll = dns.lookup
): Promise<HostCheck> {
  return new Promise((settle) => {
    createGuardedLookup(resolve)(hostname, { all: true }, (err) => {
      if (!err) settle('public');
      else if (err instanceof BlockedAddressError) settle('blocked');
      else settle('unresolvable');
    });
  });
}
