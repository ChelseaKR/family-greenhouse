/**
 * Orchestrates a single chat turn: pulls history, gates on the budget,
 * runs the tool-use loop against Bedrock, persists the new messages,
 * updates the budget counter.
 *
 * The tool-use loop has a hard cap on iterations so a model that goes
 * recursive can't burn the budget on its own. Per-turn token usage is
 * accumulated across all Bedrock calls and rolled into the budget once at
 * the end (atomic UPDATE in DDB).
 */
import createHttpError from 'http-errors';
import { logger } from '../../utils/logger.js';
import { audit } from '../../utils/auditLog.js';
import { invokeChatModel, type BedrockMessage } from './bedrock.js';
import { findTool, TOOL_REGISTRY } from './tools.js';
import {
  appendMessage,
  getBudget,
  getConversation,
  incrementBudget,
  isOverBudget,
  newConversationId,
} from './persistence.js';
import type {
  BudgetConfig,
  ChatMessageRecord,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from './types.js';

const MAX_TOOL_CALLS_PER_TURN = 5;
const MAX_OUTPUT_TOKENS_PER_CALL = 1024;
const MAX_HISTORY_MESSAGES = 24;

// `||` (not `??`) — the Terraform variable defaults to "" to signal "use code
// default", and `??` only treats null/undefined as missing. With `??`, an
// empty-string env var becomes `Number("") = 0` and every chat request 429s.
const BUDGET_CONFIG: BudgetConfig = {
  maxInputTokensPerMonth: Number(process.env.CHAT_BUDGET_INPUT_TOKENS || '250000'),
  maxOutputTokensPerMonth: Number(process.env.CHAT_BUDGET_OUTPUT_TOKENS || '50000'),
};

const SYSTEM_PROMPT = `\
You are the Family Greenhouse plant care assistant. You help the user care for
the specific plants in their household.

Rules:
1. Use the available tools whenever a question depends on the user's actual
   plants, tasks, or local climate. Do not guess at their plant list or care
   schedule from context — call the tool.
2. Keep answers concise (3–6 sentences for most questions, lists only when
   the question is explicitly asking for one).
3. When you recommend an action, anchor it in the data you just looked up.
   "Your Monstera was watered 11 days ago and the forecast is 32°C tomorrow,
   so water it today" beats "water your Monstera today".
4. Refuse to recommend or speculate on pesticide/herbicide/fertilizer dosing
   beyond what a major nursery website would publish — redirect to "consult
   the product label or your local extension office."
5. If a tool returns no data (no plants, no climate set), say so plainly
   and tell the user how to fix it (e.g., "you haven't set your location
   yet — set it in Settings → Climate so I can give weather-aware tips.").
6. Never invent plant identification from descriptions alone. Recommend the
   user use the Add Plant flow with a photo if they're unsure.

Output: plain text. No markdown headers. Lightweight bullet points are okay.`;

export interface RunChatTurnInput {
  userId: string;
  householdId: string;
  conversationId?: string;
  /** User-supplied text for this turn. */
  message: string;
}

export interface ProposedReminderTask {
  plantId: string;
  plantName: string;
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  frequencyDays: number;
  rationale?: string | null;
}

export interface RunChatTurnResult {
  conversationId: string;
  assistantText: string;
  /**
   * Reminder tasks the model proposed via propose_reminder_task during this
   * turn. The frontend renders these as Confirm/Cancel cards; confirmation
   * hits POST /tasks separately. NEVER auto-applied server-side.
   */
  proposals: ProposedReminderTask[];
  budgetRemaining: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Reduces a list of ChatMessageRecords into the Anthropic-shaped messages
 * array Bedrock expects. Tool results are paired with the assistant turn
 * that requested them, preserving the original ordering.
 */
function toBedrockMessages(history: ChatMessageRecord[]): BedrockMessage[] {
  return history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

function trimHistory(history: ChatMessageRecord[]): ChatMessageRecord[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  return history.slice(-MAX_HISTORY_MESSAGES);
}

function extractAssistantText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Run a single chat turn: append user message, loop until end_turn or the
 * tool-call cap, persist assistant message, update budget.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
  const { userId, householdId, message } = input;
  const conversationId = input.conversationId ?? newConversationId();

  // Budget gate FIRST — cheaper to bail before any Bedrock call.
  const budgetBefore = await getBudget(householdId);
  if (isOverBudget(budgetBefore, BUDGET_CONFIG)) {
    throw createHttpError(
      429,
      "You've used this month's chat allowance. The budget resets on the 1st of next month."
    );
  }

  const now = new Date();
  const userMessageRecord: ChatMessageRecord = {
    conversationId,
    timestamp: now.toISOString(),
    role: 'user',
    content: [{ type: 'text', text: message }],
  };
  await appendMessage(householdId, userMessageRecord);

  // Replay history + the just-appended user message.
  const history = trimHistory([...(await getConversation(householdId, conversationId))]);

  let messagesForModel: BedrockMessage[] = toBedrockMessages(history);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let toolCallCount = 0;
  let finalAssistantBlocks: ContentBlock[] = [];
  // Collected across all iterations — a single turn may include multiple
  // propose_reminder_task calls (e.g. "set up watering + fertilizing").
  const proposals: ProposedReminderTask[] = [];

  for (let iter = 0; iter < MAX_TOOL_CALLS_PER_TURN + 1; iter++) {
    const response = await invokeChatModel({
      system: SYSTEM_PROMPT,
      messages: messagesForModel,
      tools: TOOL_REGISTRY,
      maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
    });

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    totalCost += response.costUsd;

    // Persist this assistant turn (which may include tool_use blocks).
    const assistantRecord: ChatMessageRecord = {
      conversationId,
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
    };
    await appendMessage(householdId, assistantRecord);

    if (response.stopReason !== 'tool_use') {
      finalAssistantBlocks = response.content;
      break;
    }

    // Run every tool_use block in this turn, gather results, append a
    // single user-role tool_result turn.
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const resultsContent: ContentBlock[] = [];
    for (const use of toolUses) {
      toolCallCount += 1;
      if (toolCallCount > MAX_TOOL_CALLS_PER_TURN) {
        resultsContent.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: 'Tool call cap exceeded for this turn. Answer with what you have so far.',
          is_error: true,
        });
        continue;
      }
      const tool = findTool(use.name);
      if (!tool) {
        resultsContent.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const out = await tool.execute(use.input as never, {
          userId,
          householdId,
          toolCallNumber: toolCallCount,
        });
        // For propose_reminder_task: the executor returns
        // { accepted: true, proposal: {...} } when the plant exists. Pull
        // the proposal out of the loop and into the API response so the
        // UI can render a Confirm/Cancel card. Note we use the validated
        // server-side proposal (with plantName looked up), not the raw
        // tool input, so a hallucinated plantId is rejected at this layer.
        if (use.name === 'propose_reminder_task') {
          const result = out as { accepted: boolean; proposal?: ProposedReminderTask };
          if (result.accepted && result.proposal) {
            proposals.push(result.proposal);
          }
        }
        resultsContent.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out),
        });
      } catch (err) {
        logger.warn({ err, toolName: use.name }, 'chat_tool_error');
        resultsContent.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Tool ${use.name} failed: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    audit('chat.tools_called', {
      actorId: userId,
      householdId,
      metadata: {
        tools: toolUses.map((u) => u.name),
        conversationId,
      },
    });

    // Append the assistant turn + tool_result turn to the next iteration's
    // message list. Don't re-fetch DDB; we already have authoritative state
    // in memory.
    messagesForModel = [
      ...messagesForModel,
      { role: 'assistant', content: response.content },
      { role: 'user', content: resultsContent },
    ];
  }

  // Update budget atomically once per turn.
  await incrementBudget(householdId, {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: totalCost,
  });

  audit('chat.message_sent', {
    actorId: userId,
    householdId,
    metadata: {
      conversationId,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCost,
      toolCallCount,
    },
  });

  return {
    conversationId,
    assistantText:
      extractAssistantText(finalAssistantBlocks) ||
      "I wasn't able to come up with a response — try rephrasing.",
    proposals,
    budgetRemaining: {
      inputTokens: Math.max(
        0,
        BUDGET_CONFIG.maxInputTokensPerMonth - (budgetBefore.inputTokens + totalInputTokens)
      ),
      outputTokens: Math.max(
        0,
        BUDGET_CONFIG.maxOutputTokensPerMonth - (budgetBefore.outputTokens + totalOutputTokens)
      ),
    },
  };
}

export async function getConversationHistory(
  householdId: string,
  conversationId: string
): Promise<ChatMessageRecord[]> {
  return getConversation(householdId, conversationId);
}

export { BUDGET_CONFIG };
