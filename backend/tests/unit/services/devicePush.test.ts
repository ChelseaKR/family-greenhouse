/**
 * Native (APNs/FCM) push delivery — `notifier.sendDevicePush` through
 * `services/fcmNotifier.ts`.
 *
 * Exercised through `sendToUser` rather than against the private sender,
 * because the wiring is half of what is being claimed: the `browser` channel
 * has to cover BOTH push transports, and the reminder path has to be
 * bit-for-bit unchanged while the Firebase service account is absent — which
 * it is in every environment today.
 *
 * NOTHING HERE IS A REAL CREDENTIAL. The service-account key is an RSA
 * keypair generated in this process at load time, so the repository holds no
 * PEM and the assertion this signs verifies against nothing outside the test.
 */
import { generateKeyPairSync } from 'node:crypto';
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
  // `function`, not an arrow: the client is constructed with `new`.
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

import { logger } from '../../../src/utils/logger.js';
import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import { __resetFcmStateForTests } from '../../../src/services/fcmNotifier.js';
import { sendToUser } from '../../../src/services/notifier.js';

// One 2048-bit keypair for the whole file: `createSign` needs a real key, and
// generating one per test costs more than the tests do.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const TOKEN_URI = 'https://oauth2.test.invalid/token';
const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'greenhouse-test',
  client_email: 'push-fixture@greenhouse-test.iam.invalid',
  private_key: privateKey,
  token_uri: TOKEN_URI,
});

const RECIPIENT = { userId: 'u-1', email: 'a@example.com' };
const PAYLOAD = {
  title: 'Time to water',
  body: 'Your monstera is due.',
  tag: 'reminder-2026-09-05',
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

interface DeviceRow {
  token: string;
  platform: 'ios' | 'android';
  createdAt: string;
}

/** DynamoDB stand-in: device rows on the DEVICE# query, nothing else. */
function withDevices(rows: DeviceRow[]): void {
  dynamoSend.mockImplementation((command: { kind: string; input: Record<string, never> }) => {
    if (command.kind !== 'Query') return Promise.resolve({});
    const values = command.input.ExpressionAttributeValues as unknown as Record<string, string>;
    if (values[':sk'] !== 'DEVICE#') return Promise.resolve({ Items: [] });
    return Promise.resolve({
      Items: rows.map((row) => ({
        PK: 'USER#u-1',
        SK: `DEVICE#${row.token}`,
        userId: 'u-1',
        householdId: 'h-1',
        platform: row.platform,
        token: row.token,
        createdAt: row.createdAt,
      })),
    });
  });
}

interface FcmReply {
  status: number;
  body?: unknown;
}

/**
 * `fetch` stand-in covering both hops of FCM v1: the OAuth2 token exchange
 * and the per-device send. `replies` is keyed by device token.
 */
function withFcm(
  replies: Record<string, FcmReply>,
  tokenReply?: FcmReply
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
    if (url === TOKEN_URI) {
      const reply = tokenReply ?? {
        status: 200,
        body: { access_token: 'fixture-access-token', expires_in: 3600 },
      };
      return Promise.resolve({
        ok: reply.status < 400,
        status: reply.status,
        json: () => Promise.resolve(reply.body ?? {}),
      });
    }
    const sent = JSON.parse(init?.body ?? '{}') as { message: { token: string } };
    const reply = replies[sent.message.token] ?? { status: 200, body: {} };
    return Promise.resolve({
      ok: reply.status < 400,
      status: reply.status,
      json: () => Promise.resolve(reply.body ?? {}),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The `token` values the fan-out deleted from DynamoDB. */
function deletedSortKeys(): string[] {
  return dynamoSend.mock.calls
    .map((call) => call[0] as { kind: string; input: { Key?: { SK?: string } } })
    .filter((command) => command.kind === 'Delete')
    .map((command) => command.input.Key?.SK ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetFcmStateForTests();
  vi.mocked(notificationPrefs.getPreferences).mockResolvedValue(prefs());
  secretsSend.mockResolvedValue({ SecretString: SERVICE_ACCOUNT });
  process.env.FCM_SERVICE_ACCOUNT_SECRET_ID = 'family-greenhouse/fcm';
  // Web push stays unconfigured throughout: this suite is about the native
  // transport, and the VAPID leg contributing a delivery would hide it.
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FCM_SERVICE_ACCOUNT_SECRET_ID;
});

describe('device push — delivery', () => {
  it('sends one FCM v1 message per device and reports the channel delivered', async () => {
    withDevices([
      { token: 'tok-android', platform: 'android', createdAt: '2026-09-01T00:00:00Z' },
      { token: 'tok-ios', platform: 'ios', createdAt: '2026-09-02T00:00:00Z' },
    ]);
    const fetchMock = withFcm({});

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.delivered).toBe(true);
    expect(result.channels.browser).toBe('delivered');

    const sends = fetchMock.mock.calls.filter(([url]) => url !== TOKEN_URI);
    expect(sends).toHaveLength(2);
    // One access token for the whole fan-out, not one per device.
    expect(fetchMock.mock.calls.filter(([url]) => url === TOKEN_URI)).toHaveLength(1);

    const [url, init] = sends[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/greenhouse-test/messages:send');
    expect(init.headers.Authorization).toBe('Bearer fixture-access-token');
    const body = JSON.parse(init.body) as {
      message: { token: string; notification: { title: string; body: string }; android: unknown };
    };
    expect(body.message.notification).toEqual({
      title: 'Time to water',
      body: 'Your monstera is due.',
    });
    expect(body.message.android).toEqual({
      collapse_key: 'reminder-2026-09-05',
      notification: { tag: 'reminder-2026-09-05' },
    });
    expect(deletedSortKeys()).toEqual([]);
  });

  it('reuses the access token across a second fan-out', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    const fetchMock = withFcm({});

    await sendToUser(RECIPIENT, PAYLOAD);
    await sendToUser(RECIPIENT, PAYLOAD);

    expect(fetchMock.mock.calls.filter(([url]) => url === TOKEN_URI)).toHaveLength(1);
    // And the service account is read once per container, not once per run.
    expect(secretsSend).toHaveBeenCalledTimes(1);
  });
});

describe('device push — dead-token cleanup', () => {
  it('prunes a token FCM reports as UNREGISTERED and keeps the healthy one', async () => {
    withDevices([
      { token: 'tok-dead', platform: 'android', createdAt: '2026-09-01T00:00:00Z' },
      { token: 'tok-live', platform: 'ios', createdAt: '2026-09-02T00:00:00Z' },
    ]);
    withFcm({
      'tok-dead': {
        status: 404,
        body: {
          error: {
            status: 'NOT_FOUND',
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        },
      },
    });

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    // The live device still got it, so the day's slot is legitimately claimed.
    expect(result.channels.browser).toBe('delivered');
    expect(deletedSortKeys()).toHaveLength(1);
    const { createHash } = await import('node:crypto');
    const deadKey = createHash('sha256').update('tok-dead').digest('hex').slice(0, 16);
    expect(deletedSortKeys()[0]).toBe(`DEVICE#${deadKey}`);
  });

  it('reports the channel failed when every token is dead', async () => {
    withDevices([{ token: 'tok-dead', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    withFcm({ 'tok-dead': { status: 404, body: { error: { status: 'NOT_FOUND' } } } });

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.delivered).toBe(false);
    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toHaveLength(1);
  });

  it('a failed cleanup does not fail the send that succeeded alongside it', async () => {
    withDevices([
      { token: 'tok-dead', platform: 'android', createdAt: '2026-09-01T00:00:00Z' },
      { token: 'tok-live', platform: 'ios', createdAt: '2026-09-02T00:00:00Z' },
    ]);
    const routed = dynamoSend.getMockImplementation();
    dynamoSend.mockImplementation((command: { kind: string }) =>
      command.kind === 'Delete'
        ? Promise.reject(new Error('DynamoDB delete failed'))
        : routed!(command)
    );
    withFcm({ 'tok-dead': { status: 404, body: { error: { status: 'NOT_FOUND' } } } });

    await expect(sendToUser(RECIPIENT, PAYLOAD)).resolves.toMatchObject({
      delivered: true,
      channels: { browser: 'delivered' },
    });
  });
});

describe('device push — transient failures never prune', () => {
  it.each([
    ['a 500 from FCM', { status: 500, body: { error: { status: 'INTERNAL' } } }],
    ['a 429 quota rejection', { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }],
    [
      // The omission that matters: FCM answers INVALID_ARGUMENT both for a
      // token it cannot parse AND for a message body it cannot parse, so
      // pruning on it would let one bad payload delete every registration in
      // the installed base in a single reminder run.
      'a 400 INVALID_ARGUMENT, which may be OUR payload rather than their token',
      {
        status: 400,
        body: {
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ errorCode: 'INVALID_ARGUMENT' }],
          },
        },
      },
    ],
  ])('keeps the token after %s', async (_name, reply) => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    withFcm({ 'tok-a': reply as FcmReply });

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
  });

  it('keeps every token when the send throws (network error / abort)', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === TOKEN_URI
          ? Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ access_token: 't', expires_in: 3600 }),
            })
          : Promise.reject(new Error('socket hang up'))
      )
    );

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
  });

  it('keeps every token when the access-token exchange fails', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    const fetchMock = withFcm({}, { status: 401, body: { error: 'invalid_grant' } });

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(deletedSortKeys()).toEqual([]);
    // Nothing was attempted against FCM itself.
    expect(fetchMock.mock.calls.filter(([url]) => url !== TOKEN_URI)).toHaveLength(0);
  });
});

describe('device push — unconfigured is a silent no-op', () => {
  beforeEach(() => {
    delete process.env.FCM_SERVICE_ACCOUNT_SECRET_ID;
  });

  it('makes no Secrets Manager or network call, and leaves the channel exactly as before', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    const fetchMock = withFcm({});

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(secretsSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletedSortKeys()).toEqual([]);
    // Identical to the pre-device-push behaviour: browser push had nothing to
    // deliver, so the channel failed and the day's slot stays unclaimed.
    expect(result.delivered).toBe(false);
    expect(result.channels.browser).toBe('failed');
  });

  it('says so once per container, not once per reminder run', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    withFcm({});
    const info = vi.spyOn(logger, 'info');

    await sendToUser(RECIPIENT, PAYLOAD);
    await sendToUser(RECIPIENT, PAYLOAD);
    await sendToUser(RECIPIENT, PAYLOAD);

    const unconfigured = info.mock.calls.filter(
      ([fields]) => (fields as { msg?: string }).msg === 'device_push_unconfigured'
    );
    expect(unconfigured).toHaveLength(1);
    info.mockRestore();
  });

  it('does not read the secret at all when the user has no registered devices', async () => {
    process.env.FCM_SERVICE_ACCOUNT_SECRET_ID = 'family-greenhouse/fcm';
    withDevices([]);
    const fetchMock = withFcm({});

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(secretsSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.channels.browser).toBe('failed');
  });
});

describe('device push — an unreadable secret is not the same as an absent one', () => {
  it('warns, sends nothing, prunes nothing, and backs off instead of retrying every run', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    secretsSend.mockRejectedValue(new Error('AccessDeniedException'));
    const fetchMock = withFcm({});
    const warn = vi.spyOn(logger, 'warn');

    const first = await sendToUser(RECIPIENT, PAYLOAD);
    const second = await sendToUser(RECIPIENT, PAYLOAD);

    expect(first.channels.browser).toBe('failed');
    expect(second.channels.browser).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletedSortKeys()).toEqual([]);
    // One read, one warning — the second run rides the cooldown.
    expect(secretsSend).toHaveBeenCalledTimes(1);
    expect(
      warn.mock.calls.filter(
        ([fields]) => (fields as { msg?: string }).msg === 'device_push_credentials_unavailable'
      )
    ).toHaveLength(1);
    warn.mockRestore();
  });

  it('treats a secret that is not a service-account JSON the same way', async () => {
    withDevices([{ token: 'tok-a', platform: 'ios', createdAt: '2026-09-01T00:00:00Z' }]);
    secretsSend.mockResolvedValue({ SecretString: '{"project_id":"only-this"}' });
    const fetchMock = withFcm({});

    const result = await sendToUser(RECIPIENT, PAYLOAD);

    expect(result.channels.browser).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletedSortKeys()).toEqual([]);
  });
});

describe('device push — storage read', () => {
  it('follows DynamoDB pagination and de-duplicates a token registered twice', async () => {
    dynamoSend.mockImplementation((command: { kind: string; input: Record<string, never> }) => {
      if (command.kind !== 'Query') return Promise.resolve({});
      const values = command.input.ExpressionAttributeValues as unknown as Record<string, string>;
      if (values[':sk'] !== 'DEVICE#') return Promise.resolve({ Items: [] });
      if (!command.input.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [
            {
              userId: 'u-1',
              householdId: 'h-1',
              platform: 'ios',
              token: 'tok-a',
              createdAt: '2026-09-01T00:00:00Z',
            },
          ],
          LastEvaluatedKey: { PK: 'USER#u-1', SK: 'DEVICE#1' },
        });
      }
      return Promise.resolve({
        Items: [
          {
            userId: 'u-1',
            householdId: 'h-1',
            platform: 'ios',
            token: 'tok-a',
            createdAt: '2026-09-03T00:00:00Z',
          },
          {
            userId: 'u-1',
            householdId: 'h-1',
            platform: 'android',
            token: 'tok-b',
            createdAt: '2026-09-02T00:00:00Z',
          },
        ],
      });
    });
    const fetchMock = withFcm({});

    await sendToUser(RECIPIENT, PAYLOAD);

    const sent = fetchMock.mock.calls
      .filter(([url]) => url !== TOKEN_URI)
      .map(
        ([, init]) =>
          (JSON.parse((init as { body: string }).body) as { message: { token: string } }).message
            .token
      );
    // The second page is reached, and the duplicate row is one send, not two.
    expect(sent.sort()).toEqual(['tok-a', 'tok-b']);
  });
});
