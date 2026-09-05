/**
 * Thin Bedrock client wrapper that speaks Anthropic's Messages API over the
 * `InvokeModel` operation. Same shape as the Anthropic SDK; isolating it
 * behind a single function makes the rest of the chat code testable without
 * mocking AWS SDK internals.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import AWSXRay from 'aws-xray-sdk-core';
import { logger } from '../../utils/logger.js';
import type { ContentBlock, ToolDefinition } from './types.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Newer Claude families on Bedrock are only callable via an inference
// profile, not via the bare foundation-model ID — direct invocation of
// e.g. `anthropic.claude-haiku-4-5-...` returns ValidationException. The
// `us.` prefix scopes routing to US AWS regions for data residency. If
// you need a non-US deployment, set BEDROCK_CHAT_MODEL_ID to the matching
// regional profile (`eu.anthropic...`, `apac.anthropic...`). Default is
// Haiku 4.5 — fast, ~3x cheaper than Sonnet, sufficient for tool-use Q&A.
// `||` (not `??`) so an explicitly-empty Terraform string still falls
// through to the default. The Terraform variable for this env var defaults
// to "" to signal "use code default", which `??` would NOT bypass.
const MODEL_ID = process.env.BEDROCK_CHAT_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Wrap the SDK client with X-Ray so each InvokeModel call shows up as its
// own subsegment in the trace. Without this, the whole Bedrock round-trip
// just looks like opaque Lambda time. AWSXRay.captureAWSv3Client mutates
// the client in place to instrument all outbound HTTP calls.
const client = AWSXRay.captureAWSv3Client(new BedrockRuntimeClient({ region: REGION }));

/**
 * Cost-per-million-tokens for the configured model. Used by the budget gate
 * to convert (input, output) tokens into a dollar cost. Defaults match
 * Haiku 4.5 list price as of 2025-Q4 ($1 in / $5 out); override via env
 * when swapping models (Sonnet 4.6: $3 / $15; Opus 4.5+: $15 / $75).
 */
const INPUT_USD_PER_MTOK = Number(process.env.BEDROCK_INPUT_USD_PER_MTOK || '1');
const OUTPUT_USD_PER_MTOK = Number(process.env.BEDROCK_OUTPUT_USD_PER_MTOK || '5');

/**
 * Prompt-cache multipliers on the input rate. Writing a cache entry costs a
 * premium over an ordinary input token; reading one is a tenth of the price.
 * Kept as named constants rather than folded into the arithmetic so the cost
 * line below reads as the price list it is.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * How long one Bedrock round-trip may take before it is abandoned.
 *
 * Without this, a hung connection held the 90-second chat Lambda for its full
 * timeout: the user saw a request that never returned, and the account paid
 * for 90 seconds of a 512 MB function. `leafHealth.ts` has had the same
 * AbortController for one call at 5s; this path is up to six calls of up to
 * 1024 output tokens each, so 5s would abort healthy turns. 25s is roughly
 * four times the slow end of a normal Haiku round-trip.
 *
 * Note what this does NOT do: six calls of 25s can still exceed the Lambda's
 * 90 seconds, so this bounds a HUNG call, not the turn. A cumulative
 * per-turn budget is the fix for that, and it changes user-visible behaviour
 * (a turn would end with fewer tool calls than it wanted) — a product
 * decision, not a mechanical one.
 */
const BEDROCK_TIMEOUT_MS = Number(process.env.BEDROCK_CHAT_TIMEOUT_MS || '25000');

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface BedrockChatResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  /**
   * EVERY input token the model read this call, cached ones included.
   *
   * This is the number the per-household monthly cap in `chat/budget.ts`
   * counts, and it must stay a measure of consumption rather than of cost.
   * Once a prompt-cache breakpoint is in play, Bedrock reports the cached
   * portion under `cache_read_input_tokens` and `input_tokens` drops to the
   * uncached remainder — so reading only `input_tokens` would have silently
   * handed every household several times the 250k/month allowance the plan
   * sells. The saving belongs in `costUsd`, not in the meter.
   */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache, at a tenth of the input price. */
  cacheReadTokens: number;
  /** Tokens written into the prompt cache, at a premium over the input price. */
  cacheWriteTokens: number;
  costUsd: number;
}

interface BedrockUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Split one call's usage into the meter (`inputTokens`) and the bill. */
function accountFor(usage: BedrockUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
} {
  const uncached = usage.input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const costUsd =
    (uncached / 1_000_000) * INPUT_USD_PER_MTOK +
    (cacheWriteTokens / 1_000_000) * INPUT_USD_PER_MTOK * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) * INPUT_USD_PER_MTOK * CACHE_READ_MULTIPLIER +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK;
  return {
    inputTokens: uncached + cacheReadTokens + cacheWriteTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

export interface InvokeChatModelArgs {
  system: string;
  messages: BedrockMessage[];
  tools: ToolDefinition[];
  /** Hard token cap on the model's response (defense against runaway output). */
  maxOutputTokens?: number;
}

/**
 * Where the prompt-cache breakpoint goes, and why it is not where you would
 * first put it.
 *
 * The tool loop runs up to `MAX_TOOL_CALLS_PER_TURN + 1` = 6 InvokeModel calls
 * per turn (`chat/index.ts`), and what iteration N sends is a byte-identical
 * PREFIX of what iteration N+1 sends: the same system prompt, the same tool
 * schemas, the same history, plus one more assistant/tool-result pair. So one
 * breakpoint turns iterations 2-6 into cache reads.
 *
 * The obvious placement — a breakpoint after `system` and `tools`, caching the
 * static prefix — **does not work on this model**, and fails silently. The
 * minimum cacheable prefix for Claude Haiku 4.5 is 4,096 tokens; a shorter
 * prefix is not an error, it simply never creates an entry. Measured on this
 * repo's actual prompt: the system prompt is 2,540 bytes and the six tool
 * schemas serialize to 5,061, together roughly 2,050 tokens — barely half the
 * minimum. A breakpoint there would have looked like a fix, changed nothing,
 * and reported nothing.
 *
 * So the breakpoint goes on the LAST content block of the LAST message. The
 * cached prefix is then tools + system + the whole conversation so far, which
 * is both large enough to qualify once a turn has any history in it and the
 * more valuable thing to cache: the history and the retrieved corpus spans are
 * most of what gets re-sent, not the 2k static header.
 *
 * If it ever stops working, `usage.cache_read_input_tokens` — surfaced as
 * `cacheReadTokens` and logged on every call — is what says so.
 */
function withCacheBreakpoint(messages: BedrockMessage[]): unknown[] {
  if (messages.length === 0) return messages;
  return messages.map((message, messageIndex) => {
    if (messageIndex !== messages.length - 1) return message;
    return {
      ...message,
      content: message.content.map((block, blockIndex) =>
        blockIndex === message.content.length - 1
          ? { ...block, cache_control: { type: 'ephemeral' } }
          : block
      ),
    };
  });
}

function buildPayload(args: InvokeChatModelArgs): Record<string, unknown> {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: args.maxOutputTokens ?? 1024,
    system: args.system,
    messages: withCacheBreakpoint(args.messages),
    tools: args.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
  };
}

export async function invokeChatModel(args: InvokeChatModelArgs): Promise<BedrockChatResponse> {
  const payload = buildPayload(args);

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  // Bound the round-trip so a hung Bedrock connection can't hold the chat
  // Lambda for its full 90 seconds — same AbortController pattern as
  // leafHealth.ts / plantIdentification.ts / weather.ts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BEDROCK_TIMEOUT_MS);
  let result;
  try {
    result = await client.send(command, { abortSignal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Bedrock timed out after ${BEDROCK_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const decoded = JSON.parse(new TextDecoder().decode(result.body)) as {
    content?: ContentBlock[];
    stop_reason?: BedrockChatResponse['stopReason'];
    usage?: BedrockUsage;
    type?: string;
    error?: { type?: string; message?: string };
  };

  // Bedrock sometimes returns a JSON error envelope with HTTP 200 (typically
  // when a guardrail or content filter trips), and the SDK passes it through
  // unchanged. Surface it explicitly instead of crashing on `usage`.
  if (!decoded.usage || !decoded.content) {
    logger.error({ decoded, modelId: MODEL_ID }, 'bedrock_invoke_unexpected_shape');
    const msg =
      decoded.error?.message ??
      (decoded.type === 'error'
        ? `Bedrock error: ${decoded.error?.type ?? 'unknown'}`
        : 'Bedrock returned no content or usage');
    throw new Error(msg);
  }

  const accounting = accountFor(decoded.usage);

  logger.info(
    {
      modelId: MODEL_ID,
      ...accounting,
      stopReason: decoded.stop_reason,
    },
    'bedrock_invoke'
  );

  return {
    content: decoded.content,
    stopReason: decoded.stop_reason ?? 'end_turn',
    ...accounting,
  };
}

/** Transport-only delta emitted while a streamed model response is in flight. */
export type BedrockStreamDelta = { type: 'text_delta'; text: string };

/**
 * The Anthropic Messages streaming events we consume off the Bedrock event
 * stream. Each `chunk.bytes` decodes to exactly one of these. We type the
 * union loosely (optional fields) and switch on `type` — unknown event types
 * are skipped so an SDK/model upgrade can't crash mid-stream.
 */
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { usage?: BedrockUsage };
  content_block?: { type: 'text'; text?: string } | { type: 'tool_use'; id: string; name: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: BedrockChatResponse['stopReason'];
  };
  usage?: BedrockUsage;
  error?: { type?: string; message?: string };
}

/**
 * Streaming twin of `invokeChatModel`, built on InvokeModelWithResponseStream.
 *
 * Yields text deltas as they arrive (transport-only — nothing is persisted
 * from a delta) and RETURNS the fully-assembled BedrockChatResponse, byte-
 * compatible with the sync wrapper, once the stream closes. Callers consume
 * it with manual `gen.next()` iteration so they can capture the return value
 * (`for await` discards it).
 *
 * tool_use inputs arrive as `input_json_delta` fragments; they're buffered
 * per content-block index and parsed at `content_block_stop`, so the
 * returned content blocks are structurally identical to the sync path's.
 */
export async function* invokeChatModelStream(
  args: InvokeChatModelArgs
): AsyncGenerator<BedrockStreamDelta, BedrockChatResponse> {
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(buildPayload(args)),
  });

  // Same bound as the sync path. The signal covers the whole stream, not just
  // the handshake: a stream that stops producing events mid-turn is exactly the
  // hang this exists for.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BEDROCK_TIMEOUT_MS);
  try {
    const result = await client.send(command, { abortSignal: ctrl.signal });
    if (!result.body) {
      throw new Error('Bedrock returned no response stream');
    }

    const content: ContentBlock[] = [];
    // tool_use inputs stream as JSON fragments keyed by block index.
    const partialJson = new Map<number, string>();
    let stopReason: BedrockChatResponse['stopReason'] = 'end_turn';
    let usage: BedrockUsage = {};

    for await (const item of result.body) {
      // Non-chunk members of the event-stream union are terminal errors
      // (throttling, model timeout, validation, ...). Surface them.
      if (!item.chunk) {
        const errName = Object.keys(item).find((k) => k !== 'chunk');
        const err = errName
          ? (item as unknown as Record<string, { message?: string }>)[errName]
          : undefined;
        throw new Error(
          `Bedrock stream error${errName ? ` (${errName})` : ''}: ${err?.message ?? 'unknown'}`
        );
      }
      if (!item.chunk.bytes) continue;
      const event = JSON.parse(new TextDecoder().decode(item.chunk.bytes)) as AnthropicStreamEvent;

      switch (event.type) {
        case 'message_start':
          // Carries the whole input accounting, cache fields included.
          usage = { ...usage, ...(event.message?.usage ?? {}) };
          break;
        case 'content_block_start': {
          const idx = event.index ?? content.length;
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            content[idx] = { type: 'tool_use', id: block.id, name: block.name, input: {} };
            partialJson.set(idx, '');
          } else {
            content[idx] = { type: 'text', text: block?.type === 'text' ? (block.text ?? '') : '' };
          }
          break;
        }
        case 'content_block_delta': {
          const idx = event.index ?? content.length - 1;
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            const block = content[idx];
            if (block?.type === 'text') block.text += event.delta.text;
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta?.type === 'input_json_delta') {
            partialJson.set(idx, (partialJson.get(idx) ?? '') + (event.delta.partial_json ?? ''));
          }
          break;
        }
        case 'content_block_stop': {
          const idx = event.index ?? -1;
          const buffered = partialJson.get(idx);
          const block = content[idx];
          if (buffered !== undefined && block?.type === 'tool_use') {
            block.input = buffered.trim() ? (JSON.parse(buffered) as Record<string, unknown>) : {};
            partialJson.delete(idx);
          }
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, output_tokens: event.usage.output_tokens };
          }
          break;
        case 'message_stop':
          break;
        case 'error':
          throw new Error(
            event.error?.message ?? `Bedrock stream error: ${event.error?.type ?? 'unknown'}`
          );
        default:
          // Unknown event type (ping, future additions) — ignore.
          break;
      }
    }

    const accounting = accountFor(usage);

    logger.info(
      { modelId: MODEL_ID, ...accounting, stopReason, streamed: true },
      'bedrock_invoke_stream'
    );

    return {
      content: content.filter((b): b is ContentBlock => Boolean(b)),
      stopReason,
      ...accounting,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Bedrock stream timed out after ${BEDROCK_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
