/**
 * Native push delivery to iOS devices — `notifier.sendDevicePush` through
 * `services/apnsNotifier.ts`, straight to APNs.
 *
 * Exercised through `sendToUser`, like devicePush.test.ts, because the
 * routing is half of the claim: an iOS row must go to APNs and never to FCM
 * (FCM cannot deliver to the raw APNs token the Capacitor plugin registers).
 * The HTTP/2 transport is replaced through the module's test seam, so no
 * socket is opened.
 *
 * NOTHING HERE IS A REAL CREDENTIAL. The .p8 stand-in is a P-256 key pair
 * generated in this process, and the provider token is verified against its
 * public half.
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dynamoSend, secretsSend } = vi.hoisted(() => ({
  dynamoSend: vi.fn(),
  secretsSend: vi.fn(),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: dynamoSend },
  TABLE_NAME: 'test-table',
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: secretsSend };
  }),
  GetSecretValueCommand: vi.fn(function (input) {
    return { input, kind: 'GetSecretValue' };
  }),
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmailAccepted: vi.fn().mockResolvedValue({ accepted: false, reason: 'dry_run' }),
}));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return { ...actual, getPreferences: vi.fn() };
});

import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import {
  APNS_TOPIC,
  __resetApnsStateForTests,
  apnsPayload,
  type ApnsResponse,
  type ApnsTransport,
} from '../../../src/services/apnsNotifier.js';
import { __resetFcmStateForTests } from '../../../src/services/fcmNotifier.js';
import { devicePushAvailability, sendToUser } from '../../../src/services/notifier.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIAL = JSON.stringify({ keyId: 'ABC123DEFG', teamId: '6X5YH93QNM', privateKey });
const IOS_TOKEN = 'A1'.repeat(32);

const RECIPIENT = { userId: 'u-1', email: 'a@example.com' };
const PAYLOAD = {
  title: 'Time to water',
  body: 'Your monstera is due.',
  tag: 'reminder-h-1-2026-09-18',
  url: 'https://familygreenhouse.net/tasks?filter=due',
  badge: 2,
};

function prefs(): notificationPrefs.NotificationPreferences {
  return {
    userId: 'u-1',
    browser: true,
    email: false,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '',
  } as notificationPrefs.NotificationPreferences;
}

function withDevices(rows: Array<{ token: string; platform: 'ios' | 'android' }>): void {
  dynamoSend.mockImplementation((command: { kind: string; input: Record<string, never> }) => {
    if (command.kind !== 'Query') return Promise.resolve({});
    const values = command.input.ExpressionAttributeValues as unknown as Record<string, string>;
    if (values[':sk'] !== 'DEVICE#') return Promise.resolve({ Items: [] });
    return Promise.resolve({
      Items: rows.map((row) => ({
        userId: 'u-1',
        householdId: 'h-1',
        platform: row.platform,
        token: row.token,
        createdAt: '2026-09-01T00:00:00Z',
      })),
    });
  });
}

type SentRequest = { host: string; path: string; headers: Record<string, string>; body: string };

/** Records every request and answers each from `reply(token)`. */
function withApns(reply: (token: string) => ApnsResponse | Error = () => ({ status: 200 })) {
  const sent: SentRequest[] = [];
  const transport: ApnsTransport = async (host, requests) =>
    requests.map((request) => {
      sent.push({ host, ...request });
      return reply(decodeURIComponent(request.path.replace('/3/device/', '')));
    });
  __resetApnsStateForTests(transport);
  return sent;
}

function deletedSortKeys(): string[] {
  return dynamoSend.mock.calls
    .map((call) => call[0] as { kind: string; input: { Key?: { SK?: string } } })
    .filter((command) => command.kind === 'Delete')
    .map((command) => command.input.Key?.SK ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetFcmStateForTests();
  __resetApnsStateForTests();
  vi.mocked(notificationPrefs.getPreferences).mockResolvedValue(prefs());
  secretsSend.mockResolvedValue({ SecretString: CREDENTIAL });
  process.env.NATIVE_PUSH_ENABLED = 'true';
  process.env.APNS_AUTH_KEY_SECRET_ID = 'family-greenhouse/production/apns-auth-key';
  delete process.env.APNS_ENVIRONMENT;
  delete process.env.FCM_SERVICE_ACCOUNT_SECRET_ID;
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NATIVE_PUSH_ENABLED;
  delete process.env.APNS_AUTH_KEY_SECRET_ID;
  delete process.env.APNS_ENVIRONMENT;
  __resetApnsStateForTests();
});

describe('APNs — delivery', () => {
  it('sends an iOS device to APNs production, never to FCM, with the badge and link', async () => {
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('delivered');
    expect(fetchMock).not.toHaveBeenCalled(); // no FCM, no OAuth exchange
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request.host).toBe('https://api.push.apple.com');
    expect(request.path).toBe(`/3/device/${IOS_TOKEN}`);
    expect(request.headers['apns-topic']).toBe(APNS_TOPIC);
    expect(request.headers['apns-push-type']).toBe('alert');
    expect(request.headers['apns-collapse-id']).toBe(PAYLOAD.tag);
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        alert: { title: PAYLOAD.title, body: PAYLOAD.body },
        sound: 'default',
        badge: 2,
        'thread-id': PAYLOAD.tag,
      },
      url: PAYLOAD.url,
    });
  });

  it('signs a provider token Apple can verify: ES256, kid = Key ID, iss = Team ID', async () => {
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();

    await sendToUser(RECIPIENT, PAYLOAD);

    const jwt = sent[0].headers.authorization.replace(/^bearer /, '');
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'ABC123DEFG',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: '6X5YH93QNM',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
  });

  it('uses the sandbox gateway when APNS_ENVIRONMENT says so', async () => {
    process.env.APNS_ENVIRONMENT = 'sandbox';
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();

    await sendToUser(RECIPIENT, PAYLOAD);

    expect(sent[0].host).toBe('https://api.sandbox.push.apple.com');
  });

  it('leaves the badge alone when the message carries no count', () => {
    const payload = apnsPayload({ token: IOS_TOKEN, title: 't', body: 'b' });
    expect(payload.aps).not.toHaveProperty('badge');
  });

  it('reuses one provider token and one secret read across sends', async () => {
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();

    await sendToUser(RECIPIENT, PAYLOAD);
    await sendToUser(RECIPIENT, PAYLOAD);

    expect(secretsSend).toHaveBeenCalledTimes(1);
    expect(sent[0].headers.authorization).toBe(sent[1].headers.authorization);
  });
});

describe('APNs — which answers prune a token', () => {
  it('prunes on 410 Unregistered and keeps the healthy device', async () => {
    const dead = 'DE'.repeat(32);
    withDevices([
      { token: dead, platform: 'ios' },
      { token: IOS_TOKEN, platform: 'ios' },
    ]);
    withApns((token) =>
      token === dead ? { status: 410, reason: 'Unregistered' } : { status: 200 }
    );

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('delivered');
    expect(deletedSortKeys()).toHaveLength(1);
  });

  it.each([
    // The omission that matters: a token from the other environment is
    // BadDeviceToken too, so pruning on it would delete every iOS device the
    // day APNS_ENVIRONMENT is set wrong.
    ['400 BadDeviceToken', { status: 400, reason: 'BadDeviceToken' }],
    ['400 DeviceTokenNotForTopic', { status: 400, reason: 'DeviceTokenNotForTopic' }],
    ['403 InvalidProviderToken', { status: 403, reason: 'InvalidProviderToken' }],
    ['429 TooManyRequests', { status: 429, reason: 'TooManyRequests' }],
    ['500 InternalServerError', { status: 500, reason: 'InternalServerError' }],
  ])('keeps the token after %s', async (_name, reply) => {
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    withApns(() => reply);

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
  });

  it('keeps the token when the request errors or times out', async () => {
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    withApns(() => new Error('APNs request timed out'));

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
  });
});

describe('APNs — unconfigured and unreadable', () => {
  it('makes no Secrets Manager call and opens no connection while no key is named', async () => {
    delete process.env.APNS_AUTH_KEY_SECRET_ID;
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(secretsSend).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(result.channels.browser).toBe('failed');
  });

  it('sends nothing and prunes nothing when the secret is not an APNs key', async () => {
    secretsSend.mockResolvedValue({ SecretString: '{"keyId":"short"}' });
    withDevices([{ token: IOS_TOKEN, platform: 'ios' }]);
    const sent = withApns();

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(sent).toHaveLength(0);
    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
  });
});

describe('what the apps are told they may offer', () => {
  it('is nothing while the switch is off, whatever is configured', () => {
    process.env.NATIVE_PUSH_ENABLED = 'false';
    process.env.FCM_SERVICE_ACCOUNT_SECRET_ID = 'family-greenhouse/production/fcm';
    expect(devicePushAvailability()).toEqual({ ios: false, android: false });
    delete process.env.FCM_SERVICE_ACCOUNT_SECRET_ID;
  });

  it('is each platform whose credential is named, once the switch is on', () => {
    expect(devicePushAvailability()).toEqual({ ios: true, android: false });
    process.env.FCM_SERVICE_ACCOUNT_SECRET_ID = 'family-greenhouse/production/fcm';
    expect(devicePushAvailability()).toEqual({ ios: true, android: true });
    delete process.env.FCM_SERVICE_ACCOUNT_SECRET_ID;
  });
});

describe('APNs — the HTTP/2 transport itself', () => {
  it('sends each request on one session and reads back status and reason', async () => {
    const { createServer } = await import('node:http2');
    const { http2Transport } = await import('../../../src/services/apnsNotifier.js');
    const seen: Array<{ path: string; topic: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        seen.push({
          path: String(request.headers[':path']),
          topic: String(request.headers['apns-topic']),
          body,
        });
        if (String(request.headers[':path']).includes('dead')) {
          response.writeHead(410, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ reason: 'Unregistered' }));
        } else {
          response.writeHead(200);
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const responses = await http2Transport(`http://127.0.0.1:${port}`, [
        { path: '/3/device/live', headers: { 'apns-topic': APNS_TOPIC }, body: '{"aps":{}}' },
        { path: '/3/device/dead', headers: { 'apns-topic': APNS_TOPIC }, body: '{"aps":{}}' },
      ]);
      expect(responses).toEqual([
        { status: 200, reason: undefined },
        { status: 410, reason: 'Unregistered' },
      ]);
      expect(seen.map((entry) => entry.topic)).toEqual([APNS_TOPIC, APNS_TOPIC]);
      expect(seen.map((entry) => entry.body)).toEqual(['{"aps":{}}', '{"aps":{}}']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
