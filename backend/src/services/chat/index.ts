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
import * as billing from '../billing.js';
import { askSprout, isSproutIntegrationEnabled, type SproutCitation } from '../sprout.js';
import { getPlan } from '../../models/plans.js';
import {
  invokeChatModel,
  invokeChatModelStream,
  type BedrockChatResponse,
  type BedrockMessage,
} from './bedrock.js';
import {
  findTool,
  MAX_PROPOSALS_PER_TURN,
  PET_TOXICITY_TOOL_NAME,
  sanitizeToolResultForModel,
  TOOL_REGISTRY,
  type PetToxicityToolResult,
  type ProposeReminderResult,
  type ReminderProposal,
} from './tools.js';
import {
  checkGrounding,
  checkSafetyClaims,
  isBlockingVerdict,
  mentionsPetSafety,
  normalizeEvidenceName,
  type PetSafetyEvidence,
  type RetrievedSpan,
} from './groundingGuard.js';
import { PET_TOXICITY } from '../../models/petToxicity.js';
import {
  appendMessage,
  appendMessagePair,
  appendTurnUserMessage,
  claimTurn,
  finalizeTurn,
  getBudget,
  getConversation,
  incrementBudget,
  newConversationId,
  markTurnRetryable,
  reconcileTurnBudget,
  releaseTurn,
  reserveBudget,
  type TurnBudgetReconciliation,
} from './persistence.js';
import type {
  BudgetState,
  ChatMessageRecord,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from './types.js';
import { BUDGET_CONFIG, budgetConfigForPlan } from './budget.js';

const MAX_TOOL_CALLS_PER_TURN = 5;
const MAX_OUTPUT_TOKENS_PER_CALL = 1024;
const MAX_HISTORY_MESSAGES = 24;

export const GROUNDING_BLOCK_MESSAGE =
  "I couldn't verify every quantitative detail in that answer against the care knowledge I retrieved. Please rephrase the question or check a trusted horticultural source before acting.";

/**
 * Replaces an answer that asserted a plant is safe for pets without a
 * non-toxic verdict from the curated table behind it (ADR 0011). A
 * refusal-with-pointer rather than a bare refusal: the verified checker is
 * one click away, and the acute case needs a phone number, not a chat.
 */
export const PET_SAFETY_BLOCK_MESSAGE =
  "I can't confirm that plant is safe for pets: this answer didn't come from our verified pet-toxicity table, so I've held it back. Please use the pet-safety checker at /pet-safe (grounded in the ASPCA toxic and non-toxic plant list) or ask your vet. If an animal has already eaten or chewed a plant, or is showing symptoms, contact your vet or the ASPCA Animal Poison Control Center (888-426-4435) right away.";

// Tokens reserved up front by the atomic budget gate (reserveBudget), then
// reconciled to actual usage when the turn finishes. A modest representative
// turn — enough that two concurrent turns can't both slip past the cap, not so
// large it 429s users who still have real budget. NOT the absolute worst case
// (6 Bedrock calls): a rare big turn may still overshoot slightly, bounded and
// self-correcting on the next turn.
export const RESERVE_INPUT_TOKENS = 8000;
export const RESERVE_OUTPUT_TOKENS = 2048;

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
8. Pet safety. For ANY question about whether a plant is safe, toxic,
   poisonous or pet-friendly for a cat, dog or other pet — including routine
   "is X ok around my cat?" lookups — call ${PET_TOXICITY_TOOL_NAME} first and
   answer ONLY from its result: give the cats/dogs verdict and the note. Never
   state or imply that a plant is safe, non-toxic or fine for pets from
   memory. If the result says the plant is not in our checker, say exactly
   that, do not guess a verdict, and point the user to the ASPCA toxic and
   non-toxic plant list or their vet. If an animal has ALREADY eaten or
   chewed a plant, or is showing symptoms, do not assess or reassure: tell
   the user to contact their vet or the ASPCA Animal Poison Control Center
   (888-426-4435) right away.

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
  /**
   * Client-generated idempotency key, stable across a stream attempt AND its
   * sync fallback for the SAME user message. Lets the backend replay a
   * completed turn's result instead of running (and charging) it twice when a
   * stream finishes server-side but the client falls back. Optional — turns
   * without one just aren't deduped.
   */
  turnId?: string;
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
  /** Present when the feature-flagged first-party Sprout path answered. */
  citations?: SproutCitation[];
  provider?: 'sprout' | 'bedrock';
}

/**
 * Reduces a list of ChatMessageRecords into the Anthropic-shaped messages
 * array Bedrock expects. Tool results are paired with the assistant turn
 * that requested them, preserving the original ordering.
 */
function sanitizeToolResultBlock(block: ContentBlock): ContentBlock {
  if (block.type !== 'tool_result') return block;
  try {
    return {
      ...block,
      content: JSON.stringify(sanitizeToolResultForModel(JSON.parse(block.content) as unknown)),
    };
  } catch {
    // Tool definitions return JSON. A non-JSON historical result may be a
    // legacy raw exception string, so fail closed instead of replaying it to
    // the model where it could contain contact data or an upstream payload.
    return {
      ...block,
      content: 'Tool result unavailable. Continue with the remaining context.',
      is_error: true,
    };
  }
}

function toBedrockMessages(history: ChatMessageRecord[]): BedrockMessage[] {
  return history.map((m) => ({
    role: m.role,
    // Citation blocks are Family Greenhouse display metadata, not Anthropic
    // content blocks. Strip them before replaying a Sprout-authored turn into
    // a later Bedrock fallback. Persisted tool results may contain fields used
    // by the authenticated UI; redact them again at this model boundary.
    content: m.content.filter((block) => block.type !== 'citation').map(sanitizeToolResultBlock),
  }));
}

function spansFromToolResult(value: unknown): RetrievedSpan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return typeof record.source === 'string' && typeof record.content === 'string'
      ? [{ source: record.source, text: record.content }]
      : [];
  });
}

/**
 * Extract only authoritative quantitative facts from a structured tool result.
 * String values are deliberately ignored: UUIDs and ISO timestamps contain
 * incidental digits that must not "ground" an unrelated plant count or care
 * threshold. Arrays contribute their explicit collection length; finite JSON
 * numbers contribute their keyed value.
 */
function quantitativeSpanFromToolResult(toolName: string, value: unknown): RetrievedSpan | null {
  const facts: string[] = [];
  const collect = (nested: unknown, topLevel: boolean): void => {
    if (typeof nested === 'number' && Number.isFinite(nested)) {
      facts.push(`numeric value: ${nested}`);
      return;
    }
    if (Array.isArray(nested)) {
      // Only the tool's top-level list is an authoritative collection count.
      // Nested arrays (for example each plant's empty tags or a weather
      // forecast) are traversed for numeric leaves but do not contribute
      // unrelated lengths; paths/indices are omitted so they cannot themselves
      // satisfy a claim for 0, 1, 2, … items.
      if (topLevel) facts.push(`collection count: ${nested.length}`);
      nested.forEach((entry) => collect(entry, false));
      return;
    }
    if (!nested || typeof nested !== 'object') return;
    for (const entry of Object.values(nested as Record<string, unknown>)) {
      collect(entry, false);
    }
  };
  collect(sanitizeToolResultForModel(value), true);
  return facts.length > 0 ? { source: `tool:${toolName}`, text: facts.join('\n') } : null;
}

/**
 * The structured evidence a `check_pet_toxicity` result contributes (ADR
 * 0011). Names come from the curated table by slug so aliases ("devil's ivy")
 * match too; a match whose slug the table no longer knows falls back to the
 * names on the result itself. A `not_in_checker` or `invalid` result yields a
 * span with EMPTY evidence: it keeps the guard active (and the stream held)
 * without grounding anything, which is exactly the "model must not fill the
 * gap with its own belief" contract. The span text carries no digits, so it
 * cannot accidentally ground an unrelated numeric claim.
 */
function spanFromPetToxicityResult(value: unknown): RetrievedSpan {
  const result = (value ?? {}) as Partial<PetToxicityToolResult>;
  if (result.status === 'found' && Array.isArray(result.matches)) {
    const petSafety: PetSafetyEvidence[] = result.matches.map((match) => {
      const entry = PET_TOXICITY.find((e) => e.slug === match.slug);
      const names = entry
        ? [entry.commonName, entry.scientificName, ...entry.aliases]
        : [match.commonName, match.scientificName];
      return {
        names: names.map(normalizeEvidenceName).filter(Boolean),
        cats: match.cats,
        dogs: match.dogs,
      };
    });
    return {
      source: `tool:${PET_TOXICITY_TOOL_NAME}`,
      text: result.matches
        .map(
          (m) => `${m.commonName} (${m.scientificName}): cats ${m.cats}; dogs ${m.dogs}. ${m.note}`
        )
        .join('\n'),
      petSafety,
    };
  }
  const label =
    result.status === 'not_in_checker'
      ? `No pet-toxicity verdict for "${String(result.query ?? '')}": not in our checker.`
      : 'Pet-toxicity lookup returned no verdict.';
  return { source: `tool:${PET_TOXICITY_TOOL_NAME}`, text: label, petSafety: [] };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Collect RAG context — and pet-toxicity verdicts — already present in the
 * trimmed model history. Both keep the guard active on a follow-up turn
 * ("and is it ok for dogs too?") so an answer drawn from an earlier tool
 * result is checked against that result rather than waved through.
 */
function collectHistoryRagSpans(history: ChatMessageRecord[]): RetrievedSpan[] {
  const ragToolUseIds = new Set<string>();
  const toxicityToolUseIds = new Set<string>();
  const spans: RetrievedSpan[] = [];
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'search_care_knowledge') {
        ragToolUseIds.add(block.id);
      }
      if (block.type === 'tool_use' && block.name === PET_TOXICITY_TOOL_NAME) {
        toxicityToolUseIds.add(block.id);
      }
      if (block.type === 'tool_result' && ragToolUseIds.has(block.tool_use_id)) {
        try {
          spans.push(...spansFromToolResult(JSON.parse(block.content) as unknown));
        } catch {
          // A malformed historical tool result cannot provide grounding.
        }
      }
      if (block.type === 'tool_result' && toxicityToolUseIds.has(block.tool_use_id)) {
        try {
          spans.push(spanFromPetToxicityResult(JSON.parse(block.content) as unknown));
        } catch {
          // Likewise: no parse, no evidence — and no all-clear.
        }
      }
    }
  }
  return spans;
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
 * A failed attempt must never strand a client-supplied turn id in
 * `in_progress`. Releasing is cleanup, so preserve the original result/error
 * when DynamoDB itself is unavailable and make the failure observable.
 */
async function releaseTurnBestEffort(householdId: string, turnId: string): Promise<void> {
  try {
    await releaseTurn(householdId, turnId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, turnId }, 'chat_turn_release_failed');
  }
}

async function markTurnRetryableBestEffort(
  householdId: string,
  turnId: string,
  attemptId: string,
  budgetReconciliation?: TurnBudgetReconciliation
): Promise<void> {
  try {
    await markTurnRetryable(householdId, turnId, attemptId, budgetReconciliation);
  } catch (err) {
    logger.warn({ err: (err as Error).message, turnId }, 'chat_turn_retryable_mark_failed');
  }
}

/**
 * Reconciliation is cleanup, never part of delivering a completed answer.
 * Return whether it settled so a retryable (not completed) attempt can avoid
 * reserving and invoking the model again while its prior reservation is still
 * unresolved.
 */
async function reconcileTurnBudgetBestEffort(
  householdId: string,
  turnId: string,
  reconciliation: TurnBudgetReconciliation
): Promise<boolean> {
  try {
    await reconcileTurnBudget(householdId, turnId, reconciliation);
    return true;
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        turnId,
        reconciliationId: reconciliation.reconciliationId,
      },
      'chat_budget_reconcile_failed'
    );
    return false;
  }
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
  const { userId, householdId, message, turnId } = input;
  let conversationId = input.conversationId ?? newConversationId();
  let turnUserMessagePersisted = false;
  let turnAttemptId: string | undefined;

  // Deploy-time incident kill switch. Keep history/reporting routes readable,
  // but stop every new sync/stream model turn before plan, budget, persistence,
  // Sprout, or Bedrock work. Missing/"1" means enabled so local development
  // and existing environments remain backward compatible.
  if (process.env.CHAT_ENABLED === '0') {
    throw createHttpError(503, 'The care assistant is temporarily unavailable. Please try later.');
  }

  // "Garden plan and up" — the care assistant is a paid feature (marketed as
  // such on the landing page), but nothing previously enforced that: the free
  // Seedling tier had full, unmetered access. Gated here, the one choke point
  // both the sync (runChatTurn) and streaming (streamChatTurn) entry points
  // share, before any idempotency/budget/Bedrock work — no future caller of
  // either entry point can accidentally skip it.
  const plan = getPlan((await billing.getHouseholdSubscription(householdId)).planId);
  if (plan.id === 'seedling') {
    throw createHttpError(
      402,
      'The care assistant is included with the Garden plan and up. Upgrade to start chatting.'
    );
  }

  // The token budget this household's tier is enforced against (./budget.ts).
  // Derived from the plan already in hand, so tiering adds no read to the
  // turn; until a per-tier value is configured this is the flat BUDGET_CONFIG
  // object itself.
  const budgetConfig = budgetConfigForPlan(plan.id);

  // Idempotency (#3): replay an already-completed turn instead of running it
  // again. Closes the stream→sync fallback double-charge — a stream that
  // finishes server-side but whose client falls back to the sync endpoint with
  // the SAME turnId gets the stored result, not a second Bedrock turn.
  if (turnId) {
    const claim = await claimTurn(householdId, turnId, conversationId);
    if (claim.status === 'done' && claim.result) {
      const stored = claim.result as unknown as RunChatTurnResult;
      if (claim.budgetReconciliation?.status === 'pending') {
        // The answer is already durable and must be replayed even if this
        // cleanup retry also encounters a transient DynamoDB failure.
        await reconcileTurnBudgetBestEffort(householdId, turnId, claim.budgetReconciliation);
      }
      yield { type: 'start', conversationId: stored.conversationId };
      yield { type: 'done', result: stored };
      return stored;
    }
    if (claim.status === 'in_progress') {
      // A prior attempt with this turnId is still running — don't run a second.
      throw createHttpError(409, 'This message is already being processed — hang tight.');
    }
    conversationId = claim.conversationId ?? conversationId;
    turnUserMessagePersisted = Boolean(claim.userMessagePersisted);
    turnAttemptId = claim.attemptId;
    if (!turnAttemptId) {
      throw new Error('Claimed chat turn is missing its attempt id');
    }
    if (
      claim.budgetReconciliation?.status === 'pending' &&
      !(await reconcileTurnBudgetBestEffort(householdId, turnId, claim.budgetReconciliation))
    ) {
      // Do not stack a second reservation/model call on top of an unresolved
      // failed attempt. Keep the claim retryable with the prior pending delta.
      await markTurnRetryableBestEffort(householdId, turnId, turnAttemptId);
      throw createHttpError(
        503,
        'The care assistant is finishing your previous attempt. Please try again shortly.'
      );
    }
    // 'claimed' → we own this turn; run it (and finalize/release below).
  }

  // Phase A of the Sprout integration is intentionally read-only. It returns
  // corpus-grounded prose and citations using only a minimized selector
  // context. If the feature is enabled but unavailable, fall back to the
  // existing assistant during rollout; no household payload has been persisted
  // and the idempotency claim remains owned by this turn.
  if (isSproutIntegrationEnabled()) {
    let sprout: Awaited<ReturnType<typeof askSprout>> | undefined;
    try {
      sprout = await askSprout({ householdId, question: message });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'sprout_integration_fallback');
    }
    if (sprout) {
      const userRecord: ChatMessageRecord = {
        conversationId,
        timestamp: new Date().toISOString(),
        role: 'user',
        content: [{ type: 'text', text: message }],
      };
      const assistantRecord: ChatMessageRecord = {
        conversationId,
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: [
          { type: 'text', text: sprout.text },
          ...sprout.citations.map((citation) => ({ type: 'citation' as const, ...citation })),
        ],
      };
      try {
        // A Sprout answer is one logical turn. Persist it atomically so a DDB
        // failure cannot leave a user message with no answer (or vice versa).
        if (turnId && turnUserMessagePersisted) {
          await appendMessage(householdId, assistantRecord);
        } else {
          await appendMessagePair(householdId, userRecord, assistantRecord);
        }
      } catch (err) {
        if (turnId) {
          if (turnUserMessagePersisted && turnAttemptId) {
            await markTurnRetryableBestEffort(householdId, turnId, turnAttemptId);
          } else {
            await releaseTurnBestEffort(householdId, turnId);
          }
        }
        throw err;
      }

      let budget: BudgetState;
      try {
        budget = await getBudget(householdId);
      } catch (err) {
        // Sprout does not consume the Bedrock budget. A transient read failure
        // must not turn an already-persisted answer into a retryable 5xx.
        logger.warn({ err: (err as Error).message }, 'chat_budget_read_failed');
        budget = {
          householdId,
          yearMonth: new Date().toISOString().slice(0, 7),
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }
      const result: RunChatTurnResult = {
        conversationId,
        assistantText: sprout.text,
        proposals: [],
        citations: sprout.citations,
        provider: 'sprout',
        budgetRemaining: {
          inputTokens: Math.max(0, budgetConfig.maxInputTokensPerMonth - budget.inputTokens),
          outputTokens: Math.max(0, budgetConfig.maxOutputTokensPerMonth - budget.outputTokens),
        },
      };
      if (turnId && turnAttemptId) {
        try {
          await finalizeTurn(
            householdId,
            turnId,
            turnAttemptId,
            result as unknown as Record<string, unknown>
          );
        } catch (err) {
          logger.warn({ err: (err as Error).message, turnId }, 'chat_turn_finalize_failed');
          // Messages and the answer are already persisted. Reopening this turn
          // would append duplicates and charge the provider again.
        }
      }
      audit('chat.message_sent', {
        actorId: userId,
        householdId,
        metadata: { conversationId, provider: 'sprout', citationCount: sprout.citations.length },
      });
      yield { type: 'start', conversationId };
      yield { type: 'done', result };
      return result;
    }
  }

  // Atomic budget gate (#4): reserve a representative turn up front. The
  // conditional reservation serializes concurrent turns so two can't both slip
  // past the cap (the old read-then-check-then-increment left that window
  // open); it's reconciled to ACTUAL usage in the finally below.
  let budgetBefore: BudgetState;
  try {
    const reserved = await reserveBudget(
      householdId,
      { inputTokens: RESERVE_INPUT_TOKENS, outputTokens: RESERVE_OUTPUT_TOKENS },
      budgetConfig
    );
    // Committed-before = post-reservation totals minus our own reservation.
    budgetBefore = {
      householdId,
      yearMonth: reserved.yearMonth,
      inputTokens: reserved.inputTokens - RESERVE_INPUT_TOKENS,
      outputTokens: reserved.outputTokens - RESERVE_OUTPUT_TOKENS,
      costUsd: reserved.costUsd,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'ChatBudgetExceededError') {
      // Release the idempotency claim so a retry (e.g. next month) can re-run.
      if (turnId) {
        if (turnUserMessagePersisted && turnAttemptId) {
          await markTurnRetryableBestEffort(householdId, turnId, turnAttemptId);
        } else {
          await releaseTurnBestEffort(householdId, turnId);
        }
      }
      throw createHttpError(
        429,
        "You've used this month's chat allowance. The budget resets on the 1st of next month."
      );
    }
    // Reservation infrastructure failed after we claimed the turn. Let the
    // client's retry own a fresh claim instead of returning 409 for minutes.
    if (turnId) {
      if (turnUserMessagePersisted && turnAttemptId) {
        await markTurnRetryableBestEffort(householdId, turnId, turnAttemptId);
      } else {
        await releaseTurnBestEffort(householdId, turnId);
      }
    }
    throw err;
  }

  let messagesForModel: BedrockMessage[];
  const retrievedSpans: RetrievedSpan[] = [];
  // A pet-safety question holds streamed text until the completed answer
  // passes the guard, for the same reason RAG answers are held: a from-memory
  // "that one's fine" that has already streamed cannot be retracted, and the
  // client keeps streamed text over the final result (ADR 0011).
  const petSafetyTurn = mentionsPetSafety(message);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let toolCallCount = 0;
  let finalAssistantBlocks: ContentBlock[] = [];
  // Collected across all iterations — a single turn may include multiple
  // propose_reminder_task calls (e.g. "set up watering + fertilizing").
  const proposals: ProposedReminderTask[] = [];
  // A looping model may repeat a byte-for-byte-equivalent read/proposal call.
  // Reuse the validated result instead of repeating DB/network work or adding
  // duplicate confirm cards. Repeats still consume the global call cap.
  const successfulToolResults = new Map<string, string>();

  // Distinguishes a clean loop exit from a thrown one inside the finally, which
  // owns both the budget reconcile and the turn-claim resolution.
  let failed = true;
  let budgetReconciliation: TurnBudgetReconciliation | undefined;
  try {
    yield { type: 'start', conversationId };

    const now = new Date();
    const userMessageRecord: ChatMessageRecord = {
      conversationId,
      timestamp: now.toISOString(),
      role: 'user',
      content: [{ type: 'text', text: message }],
    };
    if (!turnUserMessagePersisted) {
      if (turnId) {
        await appendTurnUserMessage(householdId, turnId, userMessageRecord);
        turnUserMessagePersisted = true;
      } else {
        await appendMessage(householdId, userMessageRecord);
      }
    }

    // Replay history + the just-appended user message. This setup is inside
    // the reservation try/finally: DDB failures here previously leaked both
    // the reservation and the idempotency claim.
    const history = trimHistory([...(await getConversation(householdId, conversationId))]);
    messagesForModel = toBedrockMessages(history);
    retrievedSpans.push(...collectHistoryRagSpans(history));

    for (let iter = 0; iter < MAX_TOOL_CALLS_PER_TURN + 1; iter++) {
      const modelArgs = {
        system: SYSTEM_PROMPT,
        messages: messagesForModel,
        tools: TOOL_REGISTRY,
        maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
      };

      let response: BedrockChatResponse;
      let heldStreamForGrounding = false;
      if (opts.streaming) {
        // Manual iteration: `for await` would discard the generator's return
        // value (the assembled response). Once RAG context is present, hold
        // response text until the completed answer passes the grounding guard;
        // otherwise an unsupported claim could be visible before we retract it.
        const stream = invokeChatModelStream(modelArgs);
        let sawText = false;
        heldStreamForGrounding = retrievedSpans.length > 0 || petSafetyTurn;
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            response = next.value;
            break;
          }
          sawText = true;
          if (!heldStreamForGrounding) {
            yield { type: 'delta', text: next.value.text };
          }
        }
        // A tool-use turn often opens with text ("Let me check your
        // plants…"). Separate it from the next iteration's text so the
        // streamed transcript stays readable. Transport-only.
        if (!heldStreamForGrounding && sawText && response.stopReason === 'tool_use') {
          yield { type: 'delta', text: '\n\n' };
        }
      } else {
        response = await invokeChatModel(modelArgs);
      }

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      totalCost += response.costUsd;

      if (response.stopReason !== 'tool_use' && retrievedSpans.length > 0) {
        const grounding = checkGrounding(extractAssistantText(response.content), retrievedSpans);
        const sourceCount = new Set(retrievedSpans.map((span) => span.source)).size;
        if (isBlockingVerdict(grounding)) {
          const blockedOnSafety = grounding.ungroundedSafetyClaims.length > 0;
          // Never log the claim text: chat content can itself contain PII.
          logger.warn(
            {
              conversationId,
              claimsChecked: grounding.claimsChecked.length,
              ungroundedClaimCount: grounding.ungroundedClaims.length,
              safetyClaimsChecked: grounding.safetyClaimsChecked.length,
              ungroundedSafetyClaimCount: grounding.ungroundedSafetyClaims.length,
              blockedOn: blockedOnSafety ? 'safety' : 'quantitative',
              sourceCount,
            },
            'chat_grounding_blocked'
          );
          // A pet-safety block takes precedence: its message carries the
          // pointer to the verified checker and the poison-control line.
          response = {
            ...response,
            content: [
              {
                type: 'text',
                text: blockedOnSafety ? PET_SAFETY_BLOCK_MESSAGE : GROUNDING_BLOCK_MESSAGE,
              },
            ],
          };
        } else if (grounding.verdict === 'verified') {
          // Counts only: never log answer or source text, which can contain
          // user-provided/PII-bearing content.
          logger.info(
            {
              conversationId,
              claimsChecked: grounding.claimsChecked.length,
              safetyClaimsChecked: grounding.safetyClaimsChecked.length,
              sourceCount,
            },
            'chat_grounding_checked'
          );
        } else {
          // Delivered, but the guard vouches for nothing here. This gets its
          // own event name so a query for "answers the guard verified" can
          // never sweep up answers it merely didn't recognize (#307).
          logger.info(
            {
              conversationId,
              claimsChecked: grounding.claimsChecked.length,
              safetyClaimsChecked: grounding.safetyClaimsChecked.length,
              unclassifiedNumericCount: grounding.unclassifiedNumericSentences.length,
              sourceCount,
            },
            'chat_grounding_unverified'
          );
        }
      } else if (response.stopReason !== 'tool_use') {
        // No retrieved context at all. The quantitative guard stays inactive
        // here by design (ADR 0009), but a categorical pet-safety claim with
        // nothing behind it is the primary failure mode this turn can have —
        // the model answered from memory instead of calling the tool — so the
        // safety dimension is checked regardless (ADR 0011).
        const safety = checkSafetyClaims(extractAssistantText(response.content), []);
        if (safety.ungroundedSafetyClaims.length > 0) {
          logger.warn(
            {
              conversationId,
              claimsChecked: 0,
              ungroundedClaimCount: 0,
              safetyClaimsChecked: safety.safetyClaimsChecked.length,
              ungroundedSafetyClaimCount: safety.ungroundedSafetyClaims.length,
              blockedOn: 'safety',
              sourceCount: 0,
            },
            'chat_grounding_blocked'
          );
          response = {
            ...response,
            content: [{ type: 'text', text: PET_SAFETY_BLOCK_MESSAGE }],
          };
        }
      }

      // Held final RAG text is emitted only after the guard has approved or
      // replaced the completed response. Do not emit text attached to an
      // intermediate tool-use turn: it has not passed the final-answer guard
      // and could itself contain a transient unsupported claim.
      if (opts.streaming && heldStreamForGrounding) {
        if (response.stopReason !== 'tool_use') {
          const safeText = extractAssistantText(response.content);
          if (safeText) yield { type: 'delta', text: safeText };
        }
      }

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
        const cacheKey = `${use.name}:${canonicalJson(use.input)}`;
        const cachedContent = successfulToolResults.get(cacheKey);
        if (cachedContent !== undefined) {
          resultsContent.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: cachedContent,
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
          if (use.name === 'search_care_knowledge') {
            retrievedSpans.push(...spansFromToolResult(out));
          }
          if (use.name === PET_TOXICITY_TOOL_NAME) {
            // Structured verdicts, not derived numbers: a safety claim is
            // grounded by a non-toxic verdict for the plant and species it
            // names, and by nothing else (ADR 0011).
            retrievedSpans.push(spanFromPetToxicityResult(out));
          }
          const serialized = JSON.stringify(out);
          if (use.name !== 'search_care_knowledge' && use.name !== PET_TOXICITY_TOOL_NAME) {
            // Historical RAG context keeps the quantitative guard active on a
            // follow-up turn. Add the current turn's authoritative tool result
            // to the same evidence set so a real plant count, temperature, or
            // reminder frequency is accepted without letting a fabricated
            // number through. Use derived numeric facts (including array
            // length), not raw JSON whose UUIDs/dates contain incidental
            // digits that could create a false match.
            const quantitativeSpan = quantitativeSpanFromToolResult(use.name, out);
            if (quantitativeSpan) retrievedSpans.push(quantitativeSpan);
          }
          successfulToolResults.set(cacheKey, serialized);
          resultsContent.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: serialized,
          });
        } catch (err) {
          logger.warn(
            { errorName: err instanceof Error ? err.name : 'unknown', toolName: use.name },
            'chat_tool_error'
          );
          resultsContent.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Tool ${use.name} failed. Try another approach or answer with the available context.`,
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
        { role: 'user', content: resultsContent.map(sanitizeToolResultBlock) },
      ];
    }
    failed = false;
  } finally {
    // Reconcile the up-front reservation to ACTUAL usage. We already reserved
    // RESERVE_* at the gate, so adding (actual - reserve) lands the committed
    // total on the true usage — even if a mid-turn Bedrock call threw (the
    // deltas can be negative; DynamoDB's ADD handles that). This always runs,
    // so a failed turn still bills what it spent and frees the rest.
    const budgetDelta = {
      inputTokens: totalInputTokens - RESERVE_INPUT_TOKENS,
      outputTokens: totalOutputTokens - RESERVE_OUTPUT_TOKENS,
      costUsd: totalCost,
    };
    if (turnId && turnAttemptId) {
      budgetReconciliation = {
        reconciliationId: turnAttemptId,
        yearMonth: budgetBefore.yearMonth,
        ...budgetDelta,
        status: 'pending',
      };
      if (failed) {
        // Persist the unresolved delta before cleanup. A same-turn retry first
        // settles it, and the reconciliation ledger makes concurrent/repeated
        // cleanup exactly once.
        await markTurnRetryableBestEffort(householdId, turnId, turnAttemptId, budgetReconciliation);
        await reconcileTurnBudgetBestEffort(householdId, turnId, budgetReconciliation);
      }
    } else {
      try {
        // Turns without a client idempotency key have no durable replay slot,
        // so retain the legacy one-shot adjustment.
        await incrementBudget(householdId, budgetDelta);
      } catch (err) {
        // Metering cleanup must not mask the original Bedrock/DDB error or turn
        // a fully persisted answer into a 5xx that invites a duplicate retry.
        logger.warn({ err: (err as Error).message }, 'chat_budget_reconcile_failed');
      }
    }
    // A claimed turn that failed before an attempt id was established cannot
    // carry durable reconciliation state; retain the legacy cleanup fallback.
    if (turnId && failed && !turnAttemptId) {
      if (turnUserMessagePersisted) {
        // This can only occur for a legacy/malformed claim.
        logger.warn({ turnId }, 'chat_turn_attempt_id_missing');
      } else {
        await releaseTurnBestEffort(householdId, turnId);
      }
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
    provider: 'bedrock',
    budgetRemaining: {
      inputTokens: Math.max(
        0,
        budgetConfig.maxInputTokensPerMonth - (budgetBefore.inputTokens + totalInputTokens)
      ),
      outputTokens: Math.max(
        0,
        budgetConfig.maxOutputTokensPerMonth - (budgetBefore.outputTokens + totalOutputTokens)
      ),
    },
  };

  // Record the completed result so a same-turnId retry replays it instead of
  // re-running. Best-effort: if this write fails the worst case is a retry
  // re-runs the turn (the pre-idempotency behavior), so never fail the turn.
  if (turnId && turnAttemptId && budgetReconciliation) {
    try {
      // Cache the answer AND pending adjustment first. Even if reconciliation
      // fails, a same-turn retry can repair metering while replaying this
      // result without another model invocation.
      await finalizeTurn(
        householdId,
        turnId,
        turnAttemptId,
        result as unknown as Record<string, unknown>,
        budgetReconciliation
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, turnId }, 'chat_turn_finalize_failed');
      // The answer and messages are already persisted. Keep the claim closed
      // so a retry cannot append duplicate history or charge the model again.
    }
    await reconcileTurnBudgetBestEffort(householdId, turnId, budgetReconciliation);
  }

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
