/**
 * streamHandler auth: the chat streaming Lambda sits behind a Function URL
 * with NO API Gateway authorizer, so the handler must verify the JWT itself.
 * These tests pin the security contract:
 *   - missing / forged / unverifiable token → 401 {message} (and the chat
 *     turn never runs);
 *   - smuggled `requestContext.authorizer` claims are ignored (no fallback
 *     to unverified claims);
 *   - a token that passes signature verification still goes through the
 *     authoritative membership check (including the X-Household-Id override
 *     path) before any streaming happens.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn(function () {
      return { verify: mockVerify };
    }),
  },
}));
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/chat/index.js');

import {
  streamRequestToSse,
  handler,
  __resetChatStreamRateLimitForTests,
} from '../../../src/handlers/chat/streamHandler.js';
import { getMemberByUserId } from '../../../src/services/householdService.js';
import { streamChatTurn } from '../../../src/services/chat/index.js';

/** Capture stream standing in for awslambda's responseStream. */
function makeStream() {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: vi.fn(),
  };
}

/**
 * Install a mock of the runtime-only `awslambda.HttpResponseStream` global so
 * the HTTP metadata (status code, content type) the handler attaches is
 * observable. `streamifyResponse` is left undefined on purpose — the module
 * already chose the buffered `handler` export at import time, and these tests
 * drive `streamRequestToSse` directly.
 */
const metadataCalls: Array<{ statusCode?: number; headers?: Record<string, string> }> = [];
beforeAll(() => {
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_TestPool';
  process.env.COGNITO_CLIENT_ID = 'test-client-id';
  (globalThis as Record<string, unknown>).awslambda = {
    HttpResponseStream: {
      from: (stream: unknown, metadata: (typeof metadataCalls)[number]) => {
        metadataCalls.push(metadata);
        return stream;
      },
    },
  };
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>).awslambda;
});

beforeEach(() => {
  vi.clearAllMocks();
  metadataCalls.length = 0;
  // Rate-limit buckets are module-level and per-warm-container; reset them so
  // one test's requests don't count against the next.
  __resetChatStreamRateLimitForTests();
});

const validClaims = {
  sub: 'user-1',
  email: 'user@example.com',
  'custom:household_id': 'hh-claim',
};

const goodBody = JSON.stringify({ message: 'How do I water my monstera?' });

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    body: goodBody,
    headers: { authorization: 'Bearer some.jwt.token' },
    ...overrides,
  };
}

async function* fakeTurn() {
  yield { type: 'start', conversationId: 'conv-1' };
  yield { type: 'delta', text: 'Weekly.' };
  yield { type: 'done', conversationId: 'conv-1' };
}

describe('streamHandler auth (in-handler JWT verification)', () => {
  it('401s when no Authorization header is present, without verifying or streaming', async () => {
    const stream = makeStream();
    await streamRequestToSse(makeEvent({ headers: {} }), stream);

    expect(metadataCalls).toEqual([
      { statusCode: 401, headers: { 'Content-Type': 'application/json' } },
    ]);
    expect(JSON.parse(stream.chunks.join(''))).toEqual({ message: 'Unauthorized' });
    expect(mockVerify).not.toHaveBeenCalled();
    expect(getMemberByUserId).not.toHaveBeenCalled();
    expect(streamChatTurn).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });

  it('401s on a forged/unsigned token (verification throws) and never reaches the chat turn', async () => {
    mockVerify.mockRejectedValue(new Error('Invalid signature'));
    const stream = makeStream();
    await streamRequestToSse(makeEvent(), stream);

    expect(mockVerify).toHaveBeenCalledWith('some.jwt.token');
    expect(metadataCalls[0]?.statusCode).toBe(401);
    expect(JSON.parse(stream.chunks.join(''))).toEqual({ message: 'Unauthorized' });
    expect(getMemberByUserId).not.toHaveBeenCalled();
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  it('ignores smuggled requestContext.authorizer claims — only the verified token counts', async () => {
    mockVerify.mockRejectedValue(new Error('Invalid signature'));
    const stream = makeStream();
    await streamRequestToSse(
      makeEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: 'attacker', email: 'x@x' } } } },
      }),
      stream
    );

    expect(metadataCalls[0]?.statusCode).toBe(401);
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  it('proceeds to the membership check after valid verification; non-member → 403', async () => {
    mockVerify.mockResolvedValue(validClaims);
    vi.mocked(getMemberByUserId).mockResolvedValue(null);
    const stream = makeStream();
    await streamRequestToSse(makeEvent(), stream);

    expect(getMemberByUserId).toHaveBeenCalledWith('hh-claim', 'user-1');
    expect(metadataCalls[0]?.statusCode).toBe(403);
    expect(JSON.parse(stream.chunks.join(''))).toEqual({
      message: 'Not a member of the requested household',
    });
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  it('validates the X-Household-Id override against membership, not the claim household', async () => {
    mockVerify.mockResolvedValue(validClaims);
    vi.mocked(getMemberByUserId).mockResolvedValue(null);
    const stream = makeStream();
    await streamRequestToSse(
      makeEvent({
        headers: { authorization: 'Bearer some.jwt.token', 'x-household-id': 'hh-other' },
      }),
      stream
    );

    expect(getMemberByUserId).toHaveBeenCalledWith('hh-other', 'user-1');
    expect(metadataCalls[0]?.statusCode).toBe(403);
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  it('streams SSE events for a verified member (status 200, text/event-stream)', async () => {
    mockVerify.mockResolvedValue(validClaims);
    vi.mocked(getMemberByUserId).mockResolvedValue({
      userId: 'user-1',
      role: 'member',
    } as Awaited<ReturnType<typeof getMemberByUserId>>);
    vi.mocked(streamChatTurn).mockImplementation(fakeTurn as unknown as typeof streamChatTurn);
    const stream = makeStream();
    await streamRequestToSse(makeEvent(), stream);

    expect(metadataCalls[0]?.statusCode).toBe(200);
    expect(metadataCalls[0]?.headers?.['Content-Type']).toBe('text/event-stream');
    expect(streamChatTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      householdId: 'hh-claim',
      conversationId: undefined,
      message: 'How do I water my monstera?',
    });
    const events = stream.chunks.map((c) => {
      expect(c).toMatch(/^data: .*\n\n$/s);
      return JSON.parse(c.slice('data: '.length));
    });
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'done']);
    expect(stream.end).toHaveBeenCalled();
  });

  it('429s once the per-IP rate limit is exceeded, before verifying or streaming', async () => {
    mockVerify.mockResolvedValue(validClaims);
    vi.mocked(getMemberByUserId).mockResolvedValue({
      userId: 'user-1',
      role: 'member',
    } as Awaited<ReturnType<typeof getMemberByUserId>>);
    vi.mocked(streamChatTurn).mockImplementation(fakeTurn as unknown as typeof streamChatTurn);

    const event = makeEvent({ requestContext: { http: { sourceIp: '203.0.113.7' } } });

    // 60 requests/min/IP is the cap; the 61st from the same IP trips the limit.
    for (let i = 0; i < 60; i++) {
      const stream = makeStream();
      await streamRequestToSse(event, stream);
    }
    const verifyCallsBefore = mockVerify.mock.calls.length;

    const stream = makeStream();
    await streamRequestToSse(event, stream);

    expect(metadataCalls.at(-1)?.statusCode).toBe(429);
    expect(JSON.parse(stream.chunks.join(''))).toEqual({
      message: 'Too many requests. Please slow down and try again.',
    });
    // The rejected request short-circuits before JWT verification runs again.
    expect(mockVerify.mock.calls.length).toBe(verifyCallsBefore);
  });

  it('buffered fallback handler also 401s with JSON {message} on a forged token', async () => {
    mockVerify.mockRejectedValue(new Error('Token expired'));
    const result = (await (handler as (e: unknown) => Promise<unknown>)(makeEvent())) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ message: 'Unauthorized' });
  });
});
