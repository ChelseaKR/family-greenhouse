/**
 * Household chat channel management (#674): connect a Discord, Slack or
 * Matrix incoming webhook, read its masked status, send a test post, and
 * disconnect it. The posts themselves are the hourly pass in
 * `services/householdChannelRun.ts`.
 *
 * Admin-only, all four routes, and the same equality guard every household
 * credential route carries: `requireAdmin()` proves the caller administers
 * THEIR household, and `requireHouseholdMatch` proves it is this one.
 *
 * Not plan-gated. Neither the issue nor ADR 0014's tier table puts it on a
 * paid plan, and it costs us one HTTPS request per household per day.
 *
 * The webhook address goes in once and never comes back out: no response
 * here carries it, the audit line carries only the platform, and the summary
 * is the host plus the last four characters (`toChannelSummary`).
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import {
  saveHouseholdChannelSchema,
  toChannelSummary,
  WEBHOOK_URL_PROBLEM_MESSAGES,
  type SaveHouseholdChannelInput,
} from '../../models/householdChannel.js';
import * as householdChannel from '../../services/householdChannel.js';
import * as channelStore from '../../services/householdChannelStore.js';
import { channelSealingConfigured } from '../../services/channelSecret.js';
import { successResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';

function requireHouseholdMatch(user: AuthenticatedEvent['user'], householdId: string | undefined) {
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

const EXTRA_URL_MESSAGES = {
  url_required: 'Paste the webhook address to connect this channel.',
  unresolvable: 'We could not find that server. Check the address and try again.',
} as const;

// GET /households/{id}/channel
//
// `{ available, channel }`. `channel: null` means "we looked and there is
// none"; a failed read is a 5xx so the settings card can say it could not
// check, never "not connected" (ADR 0010). `available: false` means this
// environment has no sealing key, and the card says so instead of offering a
// form that would 503.
export const getHouseholdChannel = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const record = await channelStore.getChannel(householdId);
    return successResponse({
      available: channelSealingConfigured(),
      channel: record ? toChannelSummary(record) : null,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// PUT /households/{id}/channel
//
// Connect, replace the address, or change the settings. The address is
// optional on a settings-only change and required otherwise.
export const saveHouseholdChannel = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SaveHouseholdChannelInput>;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    if (!channelSealingConfigured()) {
      throw createHttpError(503, 'Chat channel notifications are not available yet.');
    }
    const result = await householdChannel.saveChannel(householdId, user.userId, validatedBody);
    switch (result.status) {
      case 'invalid_timezone':
        throw createHttpError(400, 'Choose a valid time zone.');
      case 'invalid_url': {
        const message =
          result.problem in EXTRA_URL_MESSAGES
            ? EXTRA_URL_MESSAGES[result.problem as keyof typeof EXTRA_URL_MESSAGES]
            : WEBHOOK_URL_PROBLEM_MESSAGES[
                result.problem as keyof typeof WEBHOOK_URL_PROBLEM_MESSAGES
              ];
        // `details.code` lets the settings card show its own localized
        // sentence; the message is the English fallback. Neither echoes the
        // address back.
        throw createHttpError(400, message, { details: { code: result.problem } });
      }
      case 'conflict':
        throw createHttpError(
          409,
          'The channel changed while you were saving. Reload and try again.'
        );
      case 'saved':
        break;
    }
    audit('household.settings_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      // The platform only. Never the address, its host or its last four.
      metadata: {
        setting: 'chatChannel',
        platform: result.record.platform,
        addressChanged: Boolean(validatedBody.url),
      },
    });
    return successResponse({ available: true, channel: toChannelSummary(result.record) });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(saveHouseholdChannelSchema))
  // Each save with an address costs a DNS lookup and a KMS call.
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 20 }));

// POST /households/{id}/channel/test
//
// Post a short test message now. Ignores quiet hours; honours a per-household
// cooldown. A test that lands re-enables a disconnected channel.
export const testHouseholdChannel = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    if (!channelSealingConfigured()) {
      throw createHttpError(503, 'Chat channel notifications are not available yet.');
    }
    const result = await householdChannel.sendTestPost(householdId);
    switch (result.status) {
      case 'none':
        throw createHttpError(404, 'No chat channel is connected.');
      case 'cooldown':
        throw createHttpError(
          429,
          `A test message was just sent. Try again in ${result.retryAfterSeconds} seconds.`
        );
      case 'sent':
        return successResponse({
          outcome: 'delivered',
          channel: toChannelSummary(result.record),
        });
      case 'failed':
        return successResponse({
          outcome: 'failed',
          failure: { kind: result.kind, httpStatus: result.httpStatus },
          channel: toChannelSummary(result.record),
        });
    }
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 10 }));

// DELETE /households/{id}/channel
//
// Disconnect. The sealed address is deleted with the row; the next hourly
// pass lists channels afresh, so nothing more is posted after this run.
// Never gated on anything but being an admin: turning a channel off must
// always be possible.
export const deleteHouseholdChannel = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const existed = await channelStore.deleteChannel(householdId);
    if (!existed) {
      throw createHttpError(404, 'No chat channel is connected.');
    }
    audit('household.settings_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { setting: 'chatChannel', removed: true },
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());
