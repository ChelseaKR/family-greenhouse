/**
 * The one function that sends bytes to a household's chat webhook (#674).
 *
 * `node:https` rather than `fetch`, for two properties `fetch` cannot give us:
 *
 *   1. **The socket's own DNS answer is checked.** `lookup: guardedLookup`
 *      means the address we connect to is the address the SSRF guard approved
 *      (`channelSsrfGuard.ts` explains why a separate pre-flight lookup would
 *      not be).
 *   2. **Redirects are not followed, ever.** `https.request` has no redirect
 *      machinery at all. A 3xx is reported as `redirect`, which counts against
 *      the channel like any other refusal — a webhook that redirects is either
 *      misconfigured or trying to walk us somewhere else.
 *
 * Nothing about the address or the response body is logged or returned. The
 * outcome carries a status code and a category, which is all the admin needs
 * and all the failure policy reads.
 */
import https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { guardedLookup, BlockedAddressError } from './channelSsrfGuard.js';
import { parseWebhookUrl, type ChannelPlatform } from '../models/householdChannel.js';

/** Socket-idle limit and the whole-request ceiling. A chat webhook answers in
 *  well under a second; anything slower is treated as a failed attempt and
 *  retried on the next hourly run, never within this one. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
const WEBHOOK_TOTAL_DEADLINE_MS = 8_000;
/** We read at most this much of a response, then drop the connection. */
const RESPONSE_BYTES_CAP = 4_096;

export type DeliveryOutcome =
  | { ok: true; httpStatus: number }
  | {
      ok: false;
      kind: 'client' | 'redirect' | 'rate_limited' | 'server' | 'network' | 'blocked';
      httpStatus: number | null;
      retryAfterSeconds: number | null;
    };

export type RequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest;

export interface TransportDeps {
  request: RequestFn;
  lookup: RequestOptions['lookup'];
}

const DEFAULT_DEPS: TransportDeps = {
  request: https.request,
  lookup: guardedLookup as unknown as RequestOptions['lookup'],
};

function parseRetryAfter(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return null;
}

/** Categorise an HTTP status. Exported for the tests' table. */
export function classifyStatus(
  status: number,
  retryAfterSeconds: number | null = null
): DeliveryOutcome {
  if (status >= 200 && status < 300) return { ok: true, httpStatus: status };
  if (status >= 300 && status < 400) {
    return { ok: false, kind: 'redirect', httpStatus: status, retryAfterSeconds: null };
  }
  if (status === 429) {
    return { ok: false, kind: 'rate_limited', httpStatus: status, retryAfterSeconds };
  }
  if (status >= 400 && status < 500) {
    return { ok: false, kind: 'client', httpStatus: status, retryAfterSeconds: null };
  }
  return { ok: false, kind: 'server', httpStatus: status, retryAfterSeconds: null };
}

/**
 * POST one JSON body to one webhook. Never throws; every failure is an
 * outcome. The address is re-validated here as well as at save time, so a
 * row edited out of band (or a validator bug fixed later) cannot reach the
 * network with an address the allow-list would now refuse.
 */
export async function postWebhook(
  platform: ChannelPlatform,
  rawUrl: string,
  body: unknown,
  deps: TransportDeps = DEFAULT_DEPS
): Promise<DeliveryOutcome> {
  const parsed = parseWebhookUrl(platform, rawUrl);
  if (!parsed.ok) {
    return { ok: false, kind: 'blocked', httpStatus: null, retryAfterSeconds: null };
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    // The whole-request ceiling. `timeout` below is only socket idle time; a
    // server that trickles a byte every few seconds would never trip it.
    const deadline = setTimeout(() => {
      req?.destroy(new Error('webhook deadline exceeded'));
    }, WEBHOOK_TOTAL_DEADLINE_MS);
    const settle = (outcome: DeliveryOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };

    try {
      req = deps.request(
        parsed.url,
        {
          method: 'POST',
          lookup: deps.lookup,
          timeout: WEBHOOK_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'user-agent': 'FamilyGreenhouse-ChannelNotifier/1.0',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const retryAfter = parseRetryAfter(res.headers['retry-after']);
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            // Nothing in the body is used; stop reading a runaway response.
            if (seen > RESPONSE_BYTES_CAP) res.destroy();
          });
          res.on('error', () => settle(classifyStatus(status, retryAfter)));
          res.on('close', () => settle(classifyStatus(status, retryAfter)));
          res.on('end', () => settle(classifyStatus(status, retryAfter)));
        }
      );
    } catch {
      settle({ ok: false, kind: 'network', httpStatus: null, retryAfterSeconds: null });
      return;
    }

    const request = req;
    request.on('timeout', () => request.destroy(new Error('webhook socket timeout')));
    request.on('error', (err) => {
      settle({
        ok: false,
        kind: err instanceof BlockedAddressError ? 'blocked' : 'network',
        httpStatus: null,
        retryAfterSeconds: null,
      });
    });
    request.end(payload);
  });
}
