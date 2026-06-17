/**
 * Lambda-event test adapter for the real-handler integration suite.
 *
 * Builds a synthetic `APIGatewayProxyEvent` and invokes a REAL exported
 * handler — either a single per-route middy handler (e.g.
 * `tasksHandler.createTask`) or a group router (`tasksHandler.handler`, built
 * by `createRouter`). The request is driven through the ENTIRE production
 * middy chain (securityHeaders → bodySizeGuard → JSON body parser → CORS →
 * logging → jsonErrorHandler, plus the route's own auth / validation /
 * rate-limit middleware). That is the whole point: unlike the hand-maintained
 * `local-server.ts` clone, this exercises the actual middleware and the actual
 * error-shaping, so clone-vs-real drift in those layers is caught.
 *
 * AUTH
 * ----
 * `authMiddleware` reads the Cognito claims API Gateway forwards at
 * `event.requestContext.authorizer.claims`, then validates household
 * membership against the membership row in DynamoDB. So a caller "presents an
 * identity" simply by passing `{ sub, email }` (and optionally a household
 * via the `custom:household_id` claim or the `X-Household-Id` header) — the
 * SAME seam the unit tests use. The membership row is authoritative; seed it
 * (or omit it) to make a caller a member / non-member of a household.
 *
 * AWS
 * ---
 * DynamoDB is faked at the SDK level (../support/inMemoryDynamo.ts) by the test
 * file via `vi.mock('../../src/utils/dynamodb.js')`, so the real services run
 * their real queries against an in-memory single table. No network, no real AWS.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

/**
 * Cognito identity to forward as the API Gateway authorizer claims. `userId`
 * is the Cognito `sub` — the auth middleware projects `claims.sub` onto
 * `event.user.userId`, so the field is named to match what the rest of the
 * codebase (and the seed helpers) call a user id.
 */
export interface TestIdentity {
  userId: string;
  email: string;
  /** Default household claim. Resolved/validated against the membership row. */
  householdId?: string;
  householdRole?: 'admin' | 'member';
}

export interface InvokeOptions {
  method: string;
  /** API Gateway route key, e.g. `'POST /tasks/{id}/complete'`. */
  routeKey: string;
  /** The concrete request path (informational; handlers read pathParameters). */
  path?: string;
  pathParameters?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  /** Extra headers. `content-type: application/json` is added when a body is given. */
  headers?: Record<string, string>;
  /** Request body — an object is JSON-stringified; pass `undefined` for none. */
  body?: unknown;
  /**
   * Caller identity. Omit for an UNAUTHENTICATED request (no authorizer
   * claims) — the real auth middleware then 401s, which is itself worth
   * asserting.
   */
  identity?: TestIdentity;
  /** Override the X-Household-Id header (multi-household switch path). */
  householdIdHeader?: string;
}

export interface InvokeResult {
  statusCode: number;
  /** Parsed JSON body (or the raw string when it isn't JSON / is empty). */
  body: unknown;
  headers: Record<string, string>;
}

/** A middy-wrapped handler or a createRouter dispatcher. */
type InvokableHandler = (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<APIGatewayProxyResult>;

const fakeContext = {
  awsRequestId: 'test-request-id',
  functionName: 'test',
} as unknown as Context;

function buildEvent(opts: InvokeOptions): APIGatewayProxyEvent {
  const hasBody = opts.body !== undefined;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.householdIdHeader !== undefined) {
    headers['x-household-id'] = opts.householdIdHeader;
  }

  // API Gateway forwards the Cognito-verified claims here. Mirror the REST/
  // HTTP-v1 authorizer shape (authorizer.claims) the auth middleware reads.
  const authorizer = opts.identity
    ? {
        claims: {
          sub: opts.identity.userId,
          email: opts.identity.email,
          ...(opts.identity.householdId
            ? { 'custom:household_id': opts.identity.householdId }
            : {}),
          ...(opts.identity.householdRole
            ? { 'custom:household_role': opts.identity.householdRole }
            : {}),
        },
      }
    : undefined;

  return {
    httpMethod: opts.method,
    // createRouter keys on routeKey (v2) or httpMethod+resource (v1). We set
    // both so the dispatcher resolves regardless, and `resource` mirrors the
    // route template for the v1 fallback.
    resource: opts.routeKey.split(' ').slice(1).join(' '),
    path: opts.path ?? opts.routeKey.split(' ').slice(1).join(' '),
    pathParameters: opts.pathParameters ?? null,
    queryStringParameters: opts.queryStringParameters ?? null,
    headers,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    body: hasBody
      ? typeof opts.body === 'string'
        ? (opts.body as string)
        : JSON.stringify(opts.body)
      : null,
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      ...(authorizer ? { authorizer } : {}),
      // Used by the IP-scoped rate limiter; a stable value keeps tests
      // deterministic.
      identity: { sourceIp: '127.0.0.1' },
      requestId: 'test-request-id',
      routeKey: opts.routeKey,
    } as unknown as APIGatewayProxyEvent['requestContext'],
    // The v2 dispatcher reads event.routeKey directly.
    routeKey: opts.routeKey,
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Invoke a real handler through the full middleware chain and return the
 * parsed `{ statusCode, body, headers }`.
 */
export async function invokeHandler(
  handler: InvokableHandler,
  opts: InvokeOptions
): Promise<InvokeResult> {
  const event = buildEvent(opts);
  const result = await handler(event, fakeContext);

  let body: unknown = result.body;
  if (typeof result.body === 'string' && result.body.length > 0) {
    try {
      body = JSON.parse(result.body);
    } catch {
      body = result.body;
    }
  }

  return {
    statusCode: result.statusCode,
    body,
    headers: (result.headers ?? {}) as Record<string, string>,
  };
}
