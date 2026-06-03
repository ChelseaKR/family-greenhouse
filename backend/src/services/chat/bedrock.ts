/**
 * Thin Bedrock client wrapper that speaks Anthropic's Messages API over the
 * `InvokeModel` operation. Same shape as the Anthropic SDK; isolating it
 * behind a single function makes the rest of the chat code testable without
 * mocking AWS SDK internals.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
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

export async function invokeChatModel(args: {
  system: string;
  messages: BedrockMessage[];
  tools: ToolDefinition[];
  /** Hard token cap on the model's response (defense against runaway output). */
  maxOutputTokens?: number;
}): Promise<BedrockChatResponse> {
  const payload = {
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
