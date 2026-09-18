import { connect, constants as http2 } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { truncateToBytes } from './smsNotifier.js';
import type { DevicePushMessage, DevicePushOutcome } from './fcmNotifier.js';

/**
 * Apple Push Notification service transport for the iOS shell, spoken
 * directly: HTTP/2 to api.push.apple.com with a token-based (.p8) provider
 * JWT.
 *
 * ## Why direct, and not through FCM
 *
 * `@capacitor/push-notifications` hands the iOS shell a raw APNs device token
 * (the 32-byte token as 64 hex characters). FCM cannot deliver to that: FCM
 * sends to FCM registration tokens, and an iOS app only gets one by embedding
 * the Firebase iOS SDK, swizzling the AppDelegate and shipping a
 * GoogleService-Info.plist. So the earlier plan — "upload the APNs key to
 * Firebase and send everything through FCM" — would have posted APNs tokens
 * to FCM and had every iOS send rejected.
 *
 * Talking to APNs directly needs none of that: no Google SDK in the iOS
 * binary (and nothing extra for its privacy manifest to declare), no app-side
 * change, and one credential Apple issues. It is the same shape as the FCM
 * transport next door: `node:http2` and one ES256 signature from
 * `node:crypto`, no provider SDK in the Lambda bundle.
 *
 * ## Credential
 *
 * `APNS_AUTH_KEY_SECRET_ID` names a Secrets Manager secret holding
 * `{"keyId": "...", "teamId": "...", "privateKey": "-----BEGIN PRIVATE KEY-----..."}`
 * — the Key ID and the .p8 file from Apple Developer → Keys, and the Team ID.
 * Blank means unconfigured: no Secrets Manager call, no socket, one info line
 * per container, exactly like the FCM transport.
 *
 * `APNS_ENVIRONMENT` is `production` (TestFlight and App Store builds, whose
 * entitlement says `production`) or `sandbox` (builds run from Xcode). A
 * token from one environment is `BadDeviceToken` in the other, which is why
 * that reason does NOT prune — see {@link DEAD_REASONS}.
 */

/** The app's bundle identifier: the `apns-topic` every request names. */
export const APNS_TOPIC = 'net.familygreenhouse.app';

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

type ApnsEnvironment = keyof typeof HOSTS;

const credentialSchema = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/u, 'keyId is the 10-character Key ID'),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/u, 'teamId is the 10-character Team ID'),
  privateKey: z.string().includes('PRIVATE KEY'),
});

interface ApnsCredential {
  keyId: string;
  teamId: string;
  key: KeyObject;
}

type CredentialState =
  | { status: 'ready'; credential: ApnsCredential }
  | { status: 'unconfigured' }
  | { status: 'unavailable' };

/**
 * Reasons that mean this token will never work again. Only `Unregistered`
 * (HTTP 410: the app was removed, or the token was revoked).
 *
 * `BadDeviceToken` is deliberately NOT here, for the same reason FCM's
 * `INVALID_ARGUMENT` is not in fcmNotifier.ts: APNs returns it for a token
 * from the other environment too, so a Lambda configured `sandbox` against a
 * production installed base — or the reverse — would delete every iOS
 * registration in one reminder run. A token that lingers costs one failed
 * request per send; the other mistake is not recoverable from here.
 */
const DEAD_REASONS = new Set(['Unregistered']);

/** Provider tokens are valid for an hour and may not be refreshed more than every 20 minutes. */
const PROVIDER_TOKEN_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const CREDENTIAL_RETRY_MS = 15 * 60_000;
const MAX_COLLAPSE_ID_BYTES = 64;

let secretsClient: SecretsManagerClient | null = null;
let credentialCache: { state: CredentialState; until: number } | undefined;
let unconfiguredAnnounced = false;
let providerToken: { value: string; mintedAt: number; keyId: string } | undefined;

/** A response from APNs, as much of it as this module reads. */
export interface ApnsResponse {
  status: number;
  reason?: string;
}

/**
 * How one request reaches APNs. The default opens an HTTP/2 session per
 * batch; tests replace it so no socket is ever opened.
 */
export type ApnsTransport = (
  host: string,
  requests: ReadonlyArray<{ path: string; headers: Record<string, string>; body: string }>
) => Promise<Array<ApnsResponse | Error>>;

let transport: ApnsTransport = http2Transport;

/** Test seam — module-level caches would otherwise leak between cases. */
export function __resetApnsStateForTests(nextTransport?: ApnsTransport): void {
  secretsClient = null;
  credentialCache = undefined;
  unconfiguredAnnounced = false;
  providerToken = undefined;
  transport = nextTransport ?? http2Transport;
}

function secrets(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return secretsClient;
}

/** Whether an APNs credential is named at all. Reads no secret. */
export function apnsConfigured(): boolean {
  return Boolean(process.env.APNS_AUTH_KEY_SECRET_ID?.trim());
}

function apnsEnvironment(): ApnsEnvironment {
  return process.env.APNS_ENVIRONMENT?.trim() === 'sandbox' ? 'sandbox' : 'production';
}

async function resolveCredential(): Promise<CredentialState> {
  if (credentialCache && Date.now() < credentialCache.until) return credentialCache.state;

  const secretId = process.env.APNS_AUTH_KEY_SECRET_ID?.trim();
  if (!secretId) {
    if (!unconfiguredAnnounced) {
      unconfiguredAnnounced = true;
      logger.info({ msg: 'apns_unconfigured' }, 'apns_unconfigured');
    }
    credentialCache = { state: { status: 'unconfigured' }, until: Number.POSITIVE_INFINITY };
    return credentialCache.state;
  }

  try {
    const result = await secrets().send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = result.SecretString?.trim();
    if (!raw) throw new Error('secret has no string value');
    const parsed = credentialSchema.parse(JSON.parse(raw));
    credentialCache = {
      state: {
        status: 'ready',
        credential: {
          keyId: parsed.keyId,
          teamId: parsed.teamId,
          key: createPrivateKey(parsed.privateKey),
        },
      },
      until: Number.POSITIVE_INFINITY,
    };
    return credentialCache.state;
  } catch (err) {
    logger.warn(
      { err, retryAfterMs: CREDENTIAL_RETRY_MS, msg: 'apns_credentials_unavailable' },
      'apns_credentials_unavailable'
    );
    credentialCache = { state: { status: 'unavailable' }, until: Date.now() + CREDENTIAL_RETRY_MS };
    return credentialCache.state;
  }
}

/** The provider authentication token: an ES256 JWT, `kid` = Key ID, `iss` = Team ID. */
export function signProviderToken(credential: ApnsCredential, now: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: credential.keyId })).toString(
    'base64url'
  );
  const claims = Buffer.from(
    JSON.stringify({ iss: credential.teamId, iat: Math.floor(now / 1000) })
  ).toString('base64url');
  // JOSE wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: credential.key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

function currentProviderToken(credential: ApnsCredential): string {
  const now = Date.now();
  if (
    providerToken &&
    providerToken.keyId === credential.keyId &&
    now - providerToken.mintedAt < PROVIDER_TOKEN_TTL_MS
  ) {
    return providerToken.value;
  }
  providerToken = {
    value: signProviderToken(credential, now),
    mintedAt: now,
    keyId: credential.keyId,
  };
  return providerToken.value;
}

/** The APNs payload for one notification. Custom keys sit beside `aps`. */
export function apnsPayload(message: DevicePushMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      // Only a message that knows the count sets it; anything else leaves the
      // icon's badge as it was rather than zeroing it.
      ...(typeof message.badge === 'number' ? { badge: Math.max(0, message.badge) } : {}),
      ...(message.tag ? { 'thread-id': message.tag } : {}),
    },
    ...(message.url ? { url: message.url } : {}),
  };
}

function requestFor(bearer: string, message: DevicePushMessage) {
  const collapseId = message.tag ? truncateToBytes(message.tag, MAX_COLLAPSE_ID_BYTES) : undefined;
  return {
    path: `/3/device/${encodeURIComponent(message.token)}`,
    headers: {
      authorization: `bearer ${bearer}`,
      'apns-topic': APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
    },
    body: JSON.stringify(apnsPayload(message)),
  };
}

/** One HTTP/2 session for the batch, one stream per notification. Exported for its test. */
export async function http2Transport(
  host: string,
  requests: ReadonlyArray<{ path: string; headers: Record<string, string>; body: string }>
): Promise<Array<ApnsResponse | Error>> {
  const session = connect(host);
  session.on('error', () => undefined); // surfaced per stream below
  try {
    return await Promise.all(
      requests.map(
        (request) =>
          new Promise<ApnsResponse | Error>((resolve) => {
            let settled = false;
            const done = (value: ApnsResponse | Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(value);
            };
            const timer = setTimeout(() => {
              stream.close(http2.NGHTTP2_CANCEL);
              done(new Error('APNs request timed out'));
            }, REQUEST_TIMEOUT_MS);
            const stream = session.request({
              [http2.HTTP2_HEADER_METHOD]: 'POST',
              [http2.HTTP2_HEADER_PATH]: request.path,
              'content-type': 'application/json',
              ...request.headers,
            });
            let status = 0;
            let body = '';
            stream.setEncoding('utf8');
            stream.on('response', (headers) => {
              status = Number(headers[http2.HTTP2_HEADER_STATUS]);
            });
            stream.on('data', (chunk: string) => {
              body += chunk;
            });
            stream.on('end', () => {
              let reason: string | undefined;
              try {
                reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
              } catch {
                reason = undefined;
              }
              done({ status, reason });
            });
            stream.on('error', (err) => done(err));
            stream.end(request.body);
          })
      )
    );
  } finally {
    session.close();
  }
}

/**
 * Send one notification to each iOS device in `messages`, returning an
 * outcome per message in the same order. `unconfigured` for all of them —
 * without a network call — while no APNs credential is named.
 */
export async function sendApnsMessages(
  messages: readonly DevicePushMessage[]
): Promise<DevicePushOutcome[]> {
  if (messages.length === 0) return [];
  const credentials = await resolveCredential();
  if (credentials.status !== 'ready') return messages.map(() => 'unconfigured');

  let bearer: string;
  try {
    bearer = currentProviderToken(credentials.credential);
  } catch (err) {
    logger.warn({ err, msg: 'apns_auth_failed' }, 'apns_auth_failed');
    return messages.map(() => 'failed');
  }

  let responses: Array<ApnsResponse | Error>;
  try {
    responses = await transport(
      HOSTS[apnsEnvironment()],
      messages.map((message) => requestFor(bearer, message))
    );
  } catch (err) {
    logger.warn({ err, msg: 'apns_connection_failed' }, 'apns_connection_failed');
    return messages.map(() => 'failed');
  }

  return responses.map((response) => {
    if (response instanceof Error) {
      logger.warn({ err: response, msg: 'apns_send_failed' }, 'apns_send_failed');
      return 'failed';
    }
    if (response.status === 200) return 'delivered';
    if (response.status === 410 || (response.reason && DEAD_REASONS.has(response.reason))) {
      return 'token_dead';
    }
    if (response.reason === 'ExpiredProviderToken' || response.reason === 'InvalidProviderToken') {
      // Mint a fresh one next time rather than reusing a rejected token for
      // the rest of its hour.
      providerToken = undefined;
    }
    // Never the token itself: the status and Apple's reason are what a human
    // debugging this needs.
    logger.warn(
      { status: response.status, reason: response.reason, msg: 'apns_send_failed' },
      'apns_send_failed'
    );
    return 'failed';
  });
}
