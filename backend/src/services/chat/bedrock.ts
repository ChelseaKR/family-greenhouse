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

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface BedrockChatResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface InvokeChatModelArgs {
  system: string;
  messages: BedrockMessage[];
  tools: ToolDefinition[];
  /** Hard token cap on the model's response (defense against runaway output). */
  maxOutputTokens?: number;
}

function buildPayload(args: InvokeChatModelArgs): Record<string, unknown> {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: args.maxOutputTokens ?? 1024,
    system: args.system,
    messages: args.messages,
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

  const result = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(result.body)) as {
    content?: ContentBlock[];
    stop_reason?: BedrockChatResponse['stopReason'];
    usage?: { input_tokens: number; output_tokens: number };
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

  const inputTokens = decoded.usage.input_tokens;
  const outputTokens = decoded.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK;

  logger.info(
    {
      modelId: MODEL_ID,
      inputTokens,
      outputTokens,
      stopReason: decoded.stop_reason,
      costUsd,
    },
    'bedrock_invoke'
  );

  return {
    content: decoded.content,
    stopReason: decoded.stop_reason ?? 'end_turn',
    inputTokens,
    outputTokens,
    costUsd,
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
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type: 'text'; text?: string } | { type: 'tool_use'; id: string; name: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: BedrockChatResponse['stopReason'];
  };
  usage?: { output_tokens?: number };
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

  const result = await client.send(command);
  if (!result.body) {
    throw new Error('Bedrock returned no response stream');
  }

  const content: ContentBlock[] = [];
  // tool_use inputs stream as JSON fragments keyed by block index.
  const partialJson = new Map<number, string>();
  let stopReason: BedrockChatResponse['stopReason'] = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

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
        inputTokens = event.message?.usage?.input_tokens ?? 0;
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
        if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
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

  const costUsd =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK;

  logger.info(
    { modelId: MODEL_ID, inputTokens, outputTokens, stopReason, costUsd, streamed: true },
    'bedrock_invoke_stream'
  );

  return {
    content: content.filter((b): b is ContentBlock => Boolean(b)),
    stopReason,
    inputTokens,
    outputTokens,
    costUsd,
  };
}
