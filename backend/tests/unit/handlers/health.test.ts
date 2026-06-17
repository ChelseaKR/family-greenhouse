import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

function buildEvent(): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/health',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/health',
    stageVariables: null,
  };
}

const ctx = {} as Context;

describe('GET /health', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns ok with all components healthy when DDB is reachable', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    const { health } = await import('../../../src/handlers/api/handler.js');
    const res = (await health(buildEvent(), ctx)) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.components.database.status).toBe('ok');
    expect(body.checkedAt).toBeTypeOf('string');
  });

  it('reports degraded when the DDB probe fails', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    const { health } = await import('../../../src/handlers/api/handler.js');
    const res = (await health(buildEvent(), ctx)) as APIGatewayProxyResult;
    // The endpoint itself still answers 200 (it's reachable); the payload
    // carries the degraded signal a monitor parses.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.components.database.status).toBe('error');
  });
});
