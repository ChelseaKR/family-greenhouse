/**
 * Streaming chat entry point — groundwork for a Lambda Function URL with
 * response streaming (`InvokeMode = RESPONSE_STREAM`). API Gateway HTTP APIs
 * cannot stream, so this handler is NOT routed through the normal router;
 * it's bundled as its own entry point and wired up only when the Function
 * URL exists.
 *
 * Runtime feature detection: `awslambda.streamifyResponse` is a GLOBAL that
 * only exists inside the Lambda streaming runtime — it has no SDK import and
 * no type package. We read it defensively off `globalThis`:
 *
 *   - Present (real streaming runtime): export a streamified handler that
 *     writes Server-Sent Events as the model produces them.
 *   - Absent (local dev, tests, non-streaming runtime): export a buffered
 *     fallback that runs the same turn synchronously and returns the full
 *     JSON result — so importing/bundling this module is always safe.
 *
 * AUTH: this handler sits behind a Lambda Function URL with
 * `authorization_type = "NONE"` — there is NO API Gateway JWT authorizer in
 * front of it, and on a Function URL `event.requestContext.authorizer` is
 * attacker-controlled (absent, or whatever the caller smuggles in). So the
 * handler verifies the `Authorization: Bearer <jwt>` Cognito ID token ITSELF
 * (utils/jwtVerify.ts, aws-jwt-verify against the user pool) and only then
 * applies the same household-membership authorization as middleware/auth.ts.
 * Any verification failure → 401 {message} JSON; no fallback to unverified
 * claims, ever.
 *
 * Event format: SSE, `data: <json>\n\n` per event, mirroring ChatStreamEvent
 * (`start` / `delta` / `tool_start` / `proposal` / `done`) plus an `error`
 * event for failures. The local Express mock (POST /chat/messages/stream)
 * speaks the same protocol so the frontend path is exercisable offline.
 */
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { verifyCognitoIdToken } from '../../utils/jwtVerify.js';
import { getMemberByUserId } from '../../services/householdService.js';
import { runChatTurn, streamChatTurn } from '../../services/chat/index.js';

const sendMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
});

/**
 * Minimal shape of the Function URL (payload v2) event we read. Deliberately
 * does NOT model `requestContext.authorizer`: on a Function URL with auth
 * NONE that field is caller-supplied, so nothing here may ever read it —
 * identity comes exclusively from the verified Authorization header.
 */
interface StreamRequestEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  /**
   * Connection metadata stamped by the Lambda Function URL service. We read
   * ONLY `requestContext.http.sourceIp` — that value is set by AWS and the
   * caller cannot forge it. This is deliberately NOT
   * `requestContext.authorizer`: on an auth-NONE Function URL that field IS
   * caller-controlled and is never trusted here for identity (see module doc).
   */
  requestContext?: { http?: { sourceIp?: string } };
}

/** Writable side of awslambda's responseStream (Node Writable subset). */
interface ResponseStreamLike {
  write(chunk: string): unknown;
  end(): unknown;
}

interface StreamifyCapableGlobal {
  awslambda?: {
    streamifyResponse?: (
      handler: (event: StreamRequestEvent, responseStream: ResponseStreamLike) => Promise<void>
    ) => unknown;
    /**
     * Runtime helper that prepends HTTP metadata (status/headers) to the
     * stream — the only way a streaming Function URL response can carry a
     * non-200 status. Like streamifyResponse it exists only inside the
     * Lambda streaming runtime; absent (tests, local), we write the bare
     * payload and the surrounding harness ignores status.
     */
    HttpResponseStream?: {
      from(
        stream: ResponseStreamLike,
        metadata: { statusCode?: number; headers?: Record<string, string> }
      ): ResponseStreamLike;
    };
  };
}

class HttpishError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Per-source-IP request rate limit for the streaming chat Function URL.
 *
 * The Function URL has no API Gateway in front of it (auth NONE — see the
 * module header), so it also inherits none of API Gateway's stage throttling.
 * The Bedrock turn behind it is the most expensive path in the app, and the
 * function caps at 15 reserved concurrent executions; without a brake a single
 * source can rapid-fire requests, monopolise those 15 slots, and force a JWT
 * verification + DynamoDB membership read on every one. This in-memory token
 * bucket is that brake, checked before any of that work.
 *
 * Same per-warm-container caveat as middleware/rateLimit.ts: the effective
 * ceiling multiplies with Lambda concurrency, so treat it as a brake on a
 * single hot source, not a hard global cap — the 15 reserved-concurrency
 * ceiling is the hard global limit. The per-household monthly token budget
 * (services/chat) bounds total spend; this bounds burst rate.
 *
 * 60/min/IP is generous for an interactive chat shared behind a household NAT
 * (a message every second sustained) but turns a reconnect flood from
 * unbounded into bounded.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_SWEEP_THRESHOLD = 5_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function enforceRateLimit(event: StreamRequestEvent): void {
  // sourceIp is AWS-stamped connection metadata (unforgeable); fall back to a
  // single shared bucket when absent (local/tests) rather than failing open
  // per-request.
  const key = event.requestContext?.http?.sourceIp ?? 'unknown';
  const now = Date.now();
  // Opportunistic sweep so the map can't grow unbounded over a warm
  // container's life (one entry per distinct source IP).
  if (rateBuckets.size > RATE_LIMIT_SWEEP_THRESHOLD) {
    for (const [k, b] of rateBuckets) {
      if (b.resetAt <= now) rateBuckets.delete(k);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    throw new HttpishError(429, 'Too many requests. Please slow down and try again.');
  }
  bucket.count += 1;
}

/** Test hook — drops every in-memory rate-limit bucket so tests can run many
 *  sequential requests from the same (absent) source IP without tripping. */
export function __resetChatStreamRateLimitForTests(): void {
  rateBuckets.clear();
}

/**
 * Authenticate + authorize the caller, mirroring middleware/auth.ts — except
 * the JWT is verified IN-HANDLER (signature, issuer, audience, expiry, and
 * token_use via aws-jwt-verify) because no API Gateway authorizer fronts the
 * Function URL. Claims are only read from the verified payload, never from
 * the event. After verification, the same authorization semantics as the
 * middleware apply: the household context — whether from the X-Household-Id
 * override header or the `custom:household_id` claim — is validated against
 * the membership table, which stays authoritative; a stale or tampered claim
 * can't grant access. Missing/invalid token → 401; no household / not a
 * member → 403.
 */
async function resolveUser(
  event: StreamRequestEvent
): Promise<{ userId: string; householdId: string }> {
  // Rate-limit BEFORE any expensive work (JWT verify, membership read, Bedrock)
  // so a flood is shed as cheaply as possible. Throws 429 when the per-IP
  // bucket is exhausted.
  enforceRateLimit(event);
  const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';
  if (!token) {
    throw new HttpishError(401, 'Unauthorized');
  }
  let claims;
  try {
    claims = await verifyCognitoIdToken(token);
  } catch (err) {
    // Any verification failure (forged/expired/wrong-pool/malformed) → 401.
    // Log the reason; never echo it to the caller.
    logger.warn({ err: (err as Error).message }, 'chat_stream_jwt_rejected');
    throw new HttpishError(401, 'Unauthorized');
  }
  const headerOverride = event.headers?.['x-household-id'] ?? event.headers?.['X-Household-Id'];
  const claimHouseholdId =
    typeof claims['custom:household_id'] === 'string' ? claims['custom:household_id'] : null;
  const householdId =
    (typeof headerOverride === 'string' && headerOverride.length > 0
      ? headerOverride
      : claimHouseholdId) || null;
  if (!householdId) {
    throw new HttpishError(403, 'User must belong to a household');
  }
  const member = await getMemberByUserId(householdId, claims.sub);
  if (!member) {
    throw new HttpishError(403, 'Not a member of the requested household');
  }
  return { userId: claims.sub, householdId };
}

function parseBody(event: StreamRequestEvent): { message: string; conversationId?: string } {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HttpishError(400, 'Request body must be JSON');
  }
  const parsed = sendMessageSchema.safeParse(json);
  if (!parsed.success) {
    throw new HttpishError(400, parsed.error.issues[0]?.message ?? 'Invalid request body');
  }
  return parsed.data;
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Core streaming implementation, exported for tests.
 *
 * Two failure regimes, split at "first byte streamed":
 *   - BEFORE streaming (auth, body validation): a real HTTP error response —
 *     status code + `{message}` JSON via `HttpResponseStream.from` (the only
 *     way a streaming Function URL can carry a non-200 status). 401 on any
 *     JWT failure, per the security contract.
 *   - AFTER the SSE stream has started (status already committed as 200):
 *     a terminal SSE `error` event ({message} mirroring the JSON error
 *     contract) rather than a broken pipe, so the client can fall back to
 *     the sync endpoint cleanly.
 * Outside the streaming runtime (tests, local) `HttpResponseStream` is
 * absent and the raw payload is written without metadata.
 */
export async function streamRequestToSse(
  event: StreamRequestEvent,
  responseStream: ResponseStreamLike
): Promise<void> {
  const httpResponseStream = (globalThis as StreamifyCapableGlobal).awslambda?.HttpResponseStream;
  let user: { userId: string; householdId: string };
  let body: { message: string; conversationId?: string };
  try {
    user = await resolveUser(event);
    body = parseBody(event);
  } catch (err) {
    const statusCode =
      err instanceof HttpishError
        ? err.statusCode
        : ((err as { statusCode?: number }).statusCode ?? 500);
    logger.error({ err }, 'chat_stream_rejected');
    const out = httpResponseStream
      ? httpResponseStream.from(responseStream, {
          statusCode,
          headers: { 'Content-Type': 'application/json' },
        })
      : responseStream;
    out.write(JSON.stringify({ message: (err as Error).message || 'Chat request failed' }));
    out.end();
    return;
  }

  const out = httpResponseStream
    ? httpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      })
    : responseStream;
  try {
    const gen = streamChatTurn({
      userId: user.userId,
      householdId: user.householdId,
      conversationId: body.conversationId,
      message: body.message,
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      out.write(sseEvent(next.value));
    }
  } catch (err) {
    // http-errors thrown by the service layer (e.g. the 429 budget gate)
    // carry statusCode too; surface it for the client's fallback logic.
    const svcStatus = (err as { statusCode?: number }).statusCode;
    logger.error({ err }, 'chat_stream_error');
    out.write(
      sseEvent({
        type: 'error',
        statusCode: svcStatus ?? 500,
        message: (err as Error).message || 'Chat stream failed',
      })
    );
  } finally {
    out.end();
  }
}

const streamify = (globalThis as StreamifyCapableGlobal).awslambda?.streamifyResponse;

/**
 * Buffered fallback for environments without the streaming runtime: same
 * auth + validation, sync turn, whole JSON result. Keeps the module loadable
 * (and the bundler/typecheck happy) everywhere.
 */
async function bufferedHandler(
  event: StreamRequestEvent
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  try {
    const { userId, householdId } = await resolveUser(event);
    const { message, conversationId } = parseBody(event);
    const result = await runChatTurn({ userId, householdId, conversationId, message });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    const statusCode =
      err instanceof HttpishError
        ? err.statusCode
        : ((err as { statusCode?: number }).statusCode ?? 500);
    return {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: (err as Error).message || 'Chat request failed' }),
    };
  }
}

export const handler = streamify
  ? streamify(async (event: StreamRequestEvent, responseStream: ResponseStreamLike) => {
      await streamRequestToSse(event, responseStream);
    })
  : bufferedHandler;
