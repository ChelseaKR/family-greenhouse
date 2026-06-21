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
import {
  invokeChatModel,
  invokeChatModelStream,
  type BedrockChatResponse,
  type BedrockMessage,
} from './bedrock.js';
import {
  findTool,
  MAX_PROPOSALS_PER_TURN,
  TOOL_REGISTRY,
  type ProposeReminderResult,
  type ReminderProposal,
} from './tools.js';
import {
  appendMessage,
  appendMessagePair,
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
7. When the user asks for a reminder or care schedule, offer it via the
   propose_reminder_task tool (look the plant up first to get its real id).
   A proposal is only a SUGGESTION: the user sees a card with a "Create
   task" button and the task exists only after they press it. Always tell
   the user to confirm via the card, and NEVER say the reminder/task was
   created or scheduled — it wasn't. Propose at most ${MAX_PROPOSALS_PER_TURN}
   reminders in a single reply.

Output: plain text. No markdown headers. Lightweight bullet points are okay.`;

// Exported for tests (the prompt's proposal rules are part of the safe-write
// contract: the model must route writes through the confirm card).
export { SYSTEM_PROMPT };

export interface RunChatTurnInput {
  userId: string;
  householdId: string;
  conversationId?: string;
  /** User-supplied text for this turn. */
  message: string;
}

/**
 * The validated proposal shape produced by the propose_reminder_task tool
 * (see tools.ts). Re-exported under the name the handler/frontend have
 * always used.
 */
export type ProposedReminderTask = ReminderProposal;

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

/**
 * Trim history to the model's window without orphaning tool blocks.
 *
 * A naive `slice(-N)` can cut between an assistant tool_use message and the
 * user tool_result message that answers it — Bedrock rejects either half on
 * its own. Instead, advance the window's start to the next plain user text
 * message: every assistant tool_use we keep then has its tool_result kept
 * too (we only ever cut from the front), and the window starts with a user
 * turn as the API requires. The current turn's user message is always last
 * in history, so this terminates and never returns an empty window.
 *
 * Exported for tests.
 */
export function trimHistory(history: ChatMessageRecord[]): ChatMessageRecord[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  let start = history.length - MAX_HISTORY_MESSAGES;
  while (
    start < history.length &&
    (history[start].role !== 'user' || history[start].content.some((b) => b.type === 'tool_result'))
  ) {
    start += 1;
  }
  return history.slice(start);
}

function extractAssistantText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Events yielded by the streaming turn generator. Deltas and tool events are
 * TRANSPORT-ONLY — persistence always happens on completed messages, so a
 * dropped stream never corrupts the conversation. The terminal `done` event
 * carries the same RunChatTurnResult the sync endpoint returns.
 */
export type ChatStreamEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'proposal'; proposal: ProposedReminderTask }
  | { type: 'done'; result: RunChatTurnResult };

/**
 * Run a single chat turn: append user message, loop until end_turn or the
 * tool-call cap, persist assistant message, update budget.
 *
 * Sync default — drains the shared generator without streaming Bedrock.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
  const gen = turnEvents(input, { streaming: false });
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

/**
 * Streaming variant: same budget gate, tool loop, and persistence semantics
 * as runChatTurn, but Bedrock responses arrive via
 * InvokeModelWithResponseStream and text deltas are yielded as they land.
 * Consume with manual `next()` (or `for await` if you only want events —
 * the final result is also delivered as the `done` event).
 */
export function streamChatTurn(
  input: RunChatTurnInput
): AsyncGenerator<ChatStreamEvent, RunChatTurnResult> {
  return turnEvents(input, { streaming: true });
}

/**
 * The single source of truth for a chat turn. Both entry points share this
 * generator so the sync and streaming paths can never drift on persistence,
 * budgeting, or tool semantics — the only difference is which Bedrock
 * operation each model call uses and whether deltas get forwarded.
 */
async function* turnEvents(
  input: RunChatTurnInput,
  opts: { streaming: boolean }
): AsyncGenerator<ChatStreamEvent, RunChatTurnResult> {
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

  yield { type: 'start', conversationId };

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

  try {
    for (let iter = 0; iter < MAX_TOOL_CALLS_PER_TURN + 1; iter++) {
      const modelArgs = {
        system: SYSTEM_PROMPT,
        messages: messagesForModel,
        tools: TOOL_REGISTRY,
        maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
      };

      let response: BedrockChatResponse;
      if (opts.streaming) {
        // Manual iteration: `for await` would discard the generator's return
        // value (the assembled response). Forward each text delta as it lands.
        const stream = invokeChatModelStream(modelArgs);
        let sawText = false;
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            response = next.value;
            break;
          }
          sawText = true;
          yield { type: 'delta', text: next.value.text };
        }
        // A tool-use turn often opens with text ("Let me check your
        // plants…"). Separate it from the next iteration's text so the
        // streamed transcript stays readable. Transport-only.
        if (sawText && response.stopReason === 'tool_use') {
          yield { type: 'delta', text: '\n\n' };
        }
      } else {
        response = await invokeChatModel(modelArgs);
      }

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      totalCost += response.costUsd;

      // Build this assistant turn (which may include tool_use blocks). A
      // tool_use turn is persisted TOGETHER with its tool_result turn below
      // (appendMessagePair) so the two can never be half-written; a final turn
      // has no partner and is persisted on its own.
      const assistantRecord: ChatMessageRecord = {
        conversationId,
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: response.content,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
      };

      if (response.stopReason !== 'tool_use') {
        await appendMessage(householdId, assistantRecord);
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
        yield { type: 'tool_start', name: use.name };
        try {
          // Deliberate `as never` dispatch cast — Claude's JSON-schema validation
          // is the source of truth for each tool's input shape (see tools.ts).
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          const out = await tool.execute(use.input as never, {
            userId,
            householdId,
            toolCallNumber: toolCallCount,
            // Lets propose_reminder_task enforce its own per-turn cap.
            proposalsThisTurn: proposals.length,
          });
          // For propose_reminder_task: the executor returns
          // { status: 'proposed', proposal: {...} } when the proposal passed
          // validation. Pull the proposal out of the loop and into the API
          // response so the UI can render a confirm card. Note we use the
          // validated server-side proposal (with plantName/assigneeName
          // looked up and a server-assigned proposalId), not the raw tool
          // input, so a hallucinated plantId/assignee is rejected here.
          if (use.name === 'propose_reminder_task') {
            const result = out as ProposeReminderResult;
            if (result.status === 'proposed' && result.proposal) {
              proposals.push(result.proposal);
              yield { type: 'proposal', proposal: result.proposal };
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

      // Persist the assistant tool_use turn and its tool_result turn ATOMICALLY.
      // The next user turn rebuilds history from DDB; replaying an assistant
      // tool_use with no matching tool_result is a Bedrock ValidationException,
      // which would hard-fail every conversation right after a tool turn. Writing
      // both in one transaction means a partial failure leaves neither (the turn
      // is simply retried) instead of a permanently-broken orphan. Content blocks
      // are stored as-is (DocumentClient marshals the nested maps/lists), so
      // getConversation round-trips them verbatim.
      const toolResultRecord: ChatMessageRecord = {
        conversationId,
        timestamp: new Date().toISOString(),
        role: 'user',
        content: resultsContent,
      };
      await appendMessagePair(householdId, assistantRecord, toolResultRecord);

      // Append the assistant turn + tool_result turn to the next iteration's
      // message list. Don't re-fetch DDB; we already have authoritative state
      // in memory.
      messagesForModel = [
        ...messagesForModel,
        { role: 'assistant', content: response.content },
        { role: 'user', content: resultsContent },
      ];
    }
  } finally {
    // Commit token usage even if a mid-turn Bedrock call threw: partial usage
    // (e.g. a 2nd tool-loop call that fails after the 1st already cost tokens)
    // must still be billed, or the failed turn is effectively free and the
    // monthly budget never converges. Skip a zero write — the over-budget gate
    // can throw before any Bedrock call, and a turn can fail on its first call.
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      await incrementBudget(householdId, {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCost,
      });
    }
  }

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

  const result: RunChatTurnResult = {
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

  yield { type: 'done', result };
  return result;
}

export async function getConversationHistory(
  householdId: string,
  conversationId: string
): Promise<ChatMessageRecord[]> {
  return getConversation(householdId, conversationId);
}

export { BUDGET_CONFIG };
