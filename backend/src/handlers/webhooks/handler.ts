/**
 * REST API handlers for outbound webhook subscriptions.
 *
 * Routes:
 *   GET    /households/:id/webhooks           - List webhooks
 *   POST   /households/:id/webhooks           - Create webhook
 *   GET    /households/:id/webhooks/:webhookId - Get webhook
 *   PUT    /households/:id/webhooks/:webhookId - Update webhook
 *   DELETE /households/:id/webhooks/:webhookId - Delete webhook
 *   POST   /households/:id/webhooks/:webhookId/test - Test webhook
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
import {
  type WebhookEvent,
  generateWebhookSecret,
  parseWebhookUrl,
} from '../../models/webhookSubscription.js';
import {
  createWebhook,
  getWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
} from '../../services/webhookStore.js';
import { deliverWebhook, type WebhookPayload } from '../../services/webhookDispatcher.js';
import { successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';
import { z } from 'zod';

const VALID_EVENTS: WebhookEvent[] = [
  'task.completed',
  'task.snoozed',
  'task.claimed',
  'task.unclaimed',
  'plant.created',
  'plant.updated',
  'plant.archived',
];

// --- Schemas ---

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(VALID_EVENTS as [string, ...string[]])).min(1),
});

const updateWebhookSchema = z.object({
  events: z.array(z.enum(VALID_EVENTS as [string, ...string[]])).min(1),
});

// --- Helpers ---

function requireHouseholdMatch(user: AuthenticatedEvent['user'], householdId: string | undefined) {
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

// --- Handlers ---

// GET /households/{id}/webhooks
export const listWebhooksHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);

    const webhooks = await listWebhooks(householdId);

    // Mask secrets in response
    const masked = webhooks.map((w) => ({
      ...w,
      secret: w.secret.slice(0, 8) + '...',
    }));

    return successResponse({ webhooks: masked });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// POST /households/{id}/webhooks
export const createWebhookHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<z.infer<typeof createWebhookSchema>>;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);

    const { url, events } = validatedBody;

    // Validate URL
    const parsed = parseWebhookUrl(url);
    if (!parsed.ok) {
      throw createHttpError(400, `Invalid URL: ${parsed.problem}`);
    }

    // Check for duplicate URL
    const existing = await listWebhooks(householdId);
    if (existing.some((w) => w.host === parsed.host && w.url === url)) {
      throw createHttpError(409, 'A webhook with this URL already exists');
    }

    const secret = generateWebhookSecret();
    const webhook = await createWebhook({
      id: crypto.randomUUID(),
      householdId,
      url,
      host: parsed.host,
      last4: parsed.last4,
      events: events as WebhookEvent[],
      secret,
      status: 'active',
      disabledReason: null,
    });

    logger.info({ householdId, webhookId: webhook.id, host: parsed.host }, 'webhook.created');

    return successResponse(
      {
        webhook: {
          ...webhook,
          secret, // Return full secret only on creation
        },
      },
      201
    );
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(createWebhookSchema));

// GET /households/{id}/webhooks/{webhookId}
export const getWebhookHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const webhookId = event.pathParameters?.webhookId;

    if (!webhookId) {
      throw createHttpError(400, 'Missing webhook ID');
    }

    const webhook = await getWebhook(householdId, webhookId);
    if (!webhook) {
      throw createHttpError(404, 'Webhook not found');
    }

    return successResponse({
      webhook: {
        ...webhook,
        secret: webhook.secret.slice(0, 8) + '...',
      },
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// PUT /households/{id}/webhooks/{webhookId}
export const updateWebhookHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<z.infer<typeof updateWebhookSchema>>;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const webhookId = event.pathParameters?.webhookId;

    if (!webhookId) {
      throw createHttpError(400, 'Missing webhook ID');
    }

    const existing = await getWebhook(householdId, webhookId);
    if (!existing) {
      throw createHttpError(404, 'Webhook not found');
    }

    const { events } = validatedBody;
    await updateWebhook({
      ...existing,
      events: events as WebhookEvent[],
    });

    const updated = await getWebhook(householdId, webhookId);

    logger.info({ householdId, webhookId }, 'webhook.updated');

    return successResponse({
      webhook: {
        ...(updated || existing),
        secret: (updated || existing).secret.slice(0, 8) + '...',
      },
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(updateWebhookSchema));

// DELETE /households/{id}/webhooks/{webhookId}
export const deleteWebhookHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const webhookId = event.pathParameters?.webhookId;

    if (!webhookId) {
      throw createHttpError(400, 'Missing webhook ID');
    }

    const existing = await getWebhook(householdId, webhookId);
    if (!existing) {
      throw createHttpError(404, 'Webhook not found');
    }

    await deleteWebhook(householdId, webhookId);

    logger.info({ householdId, webhookId }, 'webhook.deleted');

    return successResponse({ deleted: true });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// POST /households/{id}/webhooks/{webhookId}/test
export const testWebhookHandler = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const webhookId = event.pathParameters?.webhookId;

    if (!webhookId) {
      throw createHttpError(400, 'Missing webhook ID');
    }

    const webhook = await getWebhook(householdId, webhookId);
    if (!webhook) {
      throw createHttpError(404, 'Webhook not found');
    }

    if (webhook.status !== 'active') {
      throw createHttpError(400, 'Webhook is disabled');
    }

    const testPayload: WebhookPayload = {
      event: 'task.completed',
      timestamp: new Date().toISOString(),
      householdId,
      data: {
        test: true,
        message: 'This is a test webhook delivery',
        taskId: 'test-task-id',
        taskName: 'Water the plants',
        completedBy: 'Test user',
      },
    };

    const result = await deliverWebhook(webhook, testPayload);

    logger.info({ householdId, webhookId, success: result.ok }, 'webhook.tested');

    return successResponse({
      delivered: result.ok,
      httpStatus: result.httpStatus,
      error: result.error,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());
