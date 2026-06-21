/**
 * Chat handler group. Three routes:
 *
 *   POST /chat/messages                        — send a turn (text in, text out + proposals)
 *   GET  /chat/conversations/{id}/messages     — replay a conversation's history
 *   GET  /chat/budget                          — current month's chat budget usage
 *
 * All routes require a household. Conversation persistence is keyed by
 * household, so two users in the same household share a chat thread when
 * they hold the same `conversationId`. The frontend defaults to a fresh
 * conversation per session — explicit threading is opt-in.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { successResponse } from '../../utils/response.js';
import { getConversationHistory, runChatTurn, BUDGET_CONFIG } from '../../services/chat/index.js';
import { getBudget } from '../../services/chat/persistence.js';

const sendMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  // Idempotency key (#3): stable across a stream attempt and its sync fallback
  // so the same user message can't be charged/persisted twice.
  turnId: z.string().uuid().optional(),
});
type SendMessageInput = z.infer<typeof sendMessageSchema>;

// POST /chat/messages
export const sendMessage = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SendMessageInput>;
    if (!user.householdId) throw createHttpError(403, 'User must belong to a household');

    const result = await runChatTurn({
      userId: user.userId,
      householdId: user.householdId,
      conversationId: validatedBody.conversationId,
      message: validatedBody.message,
      turnId: validatedBody.turnId,
    });

    return successResponse(result);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  // Tighter than the default userRateLimit because each chat turn may run
  // up to 5 Bedrock calls. 20 turns/min is generous for a human typing,
  // brutal for a runaway client.
  .use(userRateLimit({ perWindowMs: 60_000, max: 20 }))
  .use(validateBody(sendMessageSchema));

// GET /chat/conversations/{id}/messages
export const getMessages = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (!user.householdId) throw createHttpError(403, 'User must belong to a household');
    const conversationId = event.pathParameters?.id;
    if (!conversationId) throw createHttpError(400, 'Conversation id is required');

    const history = await getConversationHistory(user.householdId, conversationId);
    // Strip token/cost metadata before returning to the client — it's
    // useful server-side but noise for the UI.
    return successResponse(
      history.map((m) => ({
        timestamp: m.timestamp,
        role: m.role,
        content: m.content,
      }))
    );
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /chat/budget — current month usage + remaining
export const getChatBudget = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (!user.householdId) throw createHttpError(403, 'User must belong to a household');
    const state = await getBudget(user.householdId);
    return successResponse({
      yearMonth: state.yearMonth,
      inputTokensUsed: state.inputTokens,
      outputTokensUsed: state.outputTokens,
      inputTokensCap: BUDGET_CONFIG.maxInputTokensPerMonth,
      outputTokensCap: BUDGET_CONFIG.maxOutputTokensPerMonth,
      costUsd: Math.round(state.costUsd * 10000) / 10000,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  // POST /chat/messages
  'POST /chat/messages': sendMessage,
  // GET /chat/conversations/{id}/messages
  'GET /chat/conversations/{id}/messages': getMessages,
  // GET /chat/budget
  'GET /chat/budget': getChatBudget,
});
