/**
 * Shared types for the chat subsystem.
 *
 * Kept in their own module so the tool definitions, the Bedrock client
 * wrapper, and the persistence layer can all import without circular deps.
 */

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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
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
