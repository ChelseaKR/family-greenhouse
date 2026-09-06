/**
 * Shared types for the chat subsystem.
 *
 * Kept in their own module so the tool definitions, the Bedrock client
 * wrapper, and the persistence layer can all import without circular deps.
 */
import type { SproutCoverage } from '../sprout.js';

/** One turn in a conversation, persisted in DDB. */
export interface ChatMessageRecord {
  conversationId: string;
  /** ISO-8601 (millisecond precision) — used as SK suffix and sort order. */
  timestamp: string;
  role: 'user' | 'assistant';
  /**
   * Structured content blocks (mirrors Anthropic's content-block model).
   * Tool calls + tool results show up as their own blocks alongside text.
   */
  content: ContentBlock[];
  /** Token + cost accounting for the budget gate. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type ContentBlock =
  TextBlock | ToolUseBlock | ToolResultBlock | CitationBlock | DisclosureBlock | CoverageBlock;

/**
 * Block types that are Family Greenhouse DISPLAY metadata rather than
 * Anthropic content blocks: they are persisted with a turn and rendered, and
 * they must never be replayed into a model payload.
 *
 * A set rather than an inline `!== 'citation'` test at the one call site,
 * because the list has now grown twice. `toBedrockMessages` reads this, so a
 * display-only block type added to the union without being added here is a
 * block that silently starts crossing the model boundary.
 */
const DISPLAY_ONLY_BLOCK_TYPES = new Set<ContentBlock['type']>([
  'citation',
  'disclosure',
  'coverage',
]);

export function isDisplayOnlyBlock(block: ContentBlock): boolean {
  return DISPLAY_ONLY_BLOCK_TYPES.has(block.type);
}

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Family Greenhouse display metadata. Never forwarded to Bedrock. */
export interface CitationBlock {
  type: 'citation';
  title: string;
  url: string;
  source: string;
  fetch_date: string;
}

/**
 * Sprout's own per-answer disclosure, persisted with the answer it belongs to.
 *
 * `disclosure` is a REQUIRED field of the Sprout answer contract
 * (`services/sprout.ts`), it is named for the person reading the reply, and
 * every word in it is written by Sprout — Family Greenhouse authors none of
 * it. It used to be dropped in `runChatTurn` (#579), so an AI answer was shown
 * with the statement the contract attaches to it removed. Persisted as a block
 * rather than a record field so it survives a reload down the same path the
 * citations already take (`getConversation` round-trips `content` verbatim).
 *
 * Absent when Sprout sent an empty string: the schema allows one, and no block
 * is a truer record of "no disclosure arrived" than an empty one.
 */
export interface DisclosureBlock {
  type: 'disclosure';
  text: string;
}

/**
 * How much of the household the answer above was actually computed over
 * (#549, wired up in #579).
 *
 * Aggregate integers only — the same values `buildSproutContext` counted, and
 * the same reason they exist: a bare number over a silently reduced set reads
 * as a household total. Persisting it is what lets a stored answer still be
 * qualified later ("computed over 40 of your 112 plants"); before this the
 * facts lived only for the lifetime of the function call.
 *
 * It carries no plant name, no user-typed species and no id, so persisting and
 * returning it widens nothing at the privacy boundary documented on
 * `buildSproutContext`.
 */
export interface CoverageBlock extends SproutCoverage {
  type: 'coverage';
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  // Snake_case keys: they ride directly into the Anthropic Messages API
  // payload via Bedrock. Anthropic's spec requires `tool_use_id` and
  // `is_error` exactly (camelCase variants get rejected with
  // ValidationException). Same shape persisted in DDB for simplicity.
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Tool definition the model sees, schema-validated at the edge. */
export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  /**
   * JSON Schema-ish describing the tool's input. Bedrock + Anthropic's
   * tool-use API both accept this shape verbatim.
   */
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * Server-side handler. Receives the validated input, the authenticated
   * user (so it can scope by household), and returns either a JSON-able
   * payload or an error string.
   */
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolExecutionContext {
  userId: string;
  householdId: string;
  /**
   * Per-turn tool-call counter, incremented before invoking each tool. Used
   * to enforce the per-turn cap without piping it through every signature.
   */
  toolCallNumber: number;
  /**
   * How many reminder proposals have already been ACCEPTED this turn.
   * Maintained by the orchestrator; lets propose_reminder_task enforce its
   * own per-turn cap (the model can't spam confirm cards). Optional so
   * read-only tools (and their tests) never have to care.
   */
  proposalsThisTurn?: number;
}

/** Per-household monthly token budget — gates Bedrock calls. */
export interface BudgetState {
  householdId: string;
  /** YYYY-MM, e.g. "2026-05". */
  yearMonth: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface BudgetConfig {
  maxInputTokensPerMonth: number;
  maxOutputTokensPerMonth: number;
}
