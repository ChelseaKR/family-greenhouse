import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/chat/index.js', () => ({
  runChatTurn: vi.fn(),
  getConversationHistory: vi.fn(),
  BUDGET_CONFIG: { maxInputTokensPerMonth: 100, maxOutputTokensPerMonth: 100 },
}));
vi.mock('../../../src/services/chat/persistence.js', () => ({ getBudget: vi.fn() }));
vi.mock('../../../src/services/chatReports.js', () => ({ saveChatReport: vi.fn() }));

function event(body: unknown): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/chat/messages',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'member',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const context = {} as Context;

describe('chat response reports', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    __resetMembershipCacheForTests();
    __resetRateLimitForTests();
    setCachedMembership('user-1', 'hh-1', 'member');
  });

  it('stores a report without invoking Bedrock', async () => {
    const { saveChatReport } = await import('../../../src/services/chatReports.js');
    const { getConversationHistory, runChatTurn } =
      await import('../../../src/services/chat/index.js');
    const { sendMessage } = await import('../../../src/handlers/chat/handler.js');
    vi.mocked(saveChatReport).mockResolvedValueOnce('report-1');
    vi.mocked(getConversationHistory).mockResolvedValueOnce([
      {
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: '2026-07-12T00:00:00.000Z',
        role: 'assistant',
        content: [{ type: 'text', text: 'Unsafe answer' }],
      },
    ]);

    const result = (await sendMessage(
      event({
        action: 'report',
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        responseText: 'Unsafe answer',
        reason: 'unsafe',
        details: 'Suggested a dangerous dose',
      }),
      context,
      () => {}
    )) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ accepted: true, reportId: 'report-1' });
    expect(saveChatReport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', householdId: 'hh-1', reason: 'unsafe' })
    );
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it('rejects a fabricated response that is not in the household conversation', async () => {
    const { getConversationHistory } = await import('../../../src/services/chat/index.js');
    const { saveChatReport } = await import('../../../src/services/chatReports.js');
    const { sendMessage } = await import('../../../src/handlers/chat/handler.js');
    vi.mocked(getConversationHistory).mockResolvedValueOnce([]);

    const result = (await sendMessage(
      event({
        action: 'report',
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        responseText: 'Fabricated answer',
        reason: 'offensive',
      }),
      context,
      () => {}
    )) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(404);
    expect(saveChatReport).not.toHaveBeenCalled();
  });

  it('rejects malformed report payloads', async () => {
    const { saveChatReport } = await import('../../../src/services/chatReports.js');
    const { sendMessage } = await import('../../../src/handlers/chat/handler.js');
    const result = (await sendMessage(
      event({ action: 'report', conversationId: 'not-a-uuid', responseText: '', reason: 'unsafe' }),
      context,
      () => {}
    )) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    expect(saveChatReport).not.toHaveBeenCalled();
  });
});
