/**
 * Exercises the InvokeModelWithResponseStream wrapper: Anthropic streaming
 * events (mocked at the SDK event-stream level) must come back as ordered
 * text deltas, and the generator's RETURN value must be a BedrockChatResponse
 * structurally identical to what the sync wrapper would have produced —
 * including tool_use inputs reassembled from input_json_delta fragments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bedrockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(function () {
    return { send: bedrockSend };
  }),
  InvokeModelCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
  InvokeModelWithResponseStreamCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: (client: unknown) => client },
}));

import {
  invokeChatModelStream,
  type BedrockChatResponse,
  type BedrockStreamDelta,
} from '../../../src/services/chat/bedrock.js';

function chunk(event: Record<string, unknown>) {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
}

async function* iterate(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

/** Drain the generator, capturing both yielded deltas and the return value. */
async function drain(
  gen: AsyncGenerator<BedrockStreamDelta, BedrockChatResponse>
): Promise<{ deltas: string[]; response: BedrockChatResponse }> {
  const deltas: string[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { deltas, response: next.value };
    deltas.push(next.value.text);
  }
}

const args = {
  system: 'system prompt',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [],
};

beforeEach(() => {
  bedrockSend.mockReset();
});

describe('invokeChatModelStream', () => {
  it('yields text deltas in order and returns the assembled response (text + streamed tool_use input)', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([
        chunk({ type: 'message_start', message: { usage: { input_tokens: 120 } } }),
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Let me ' },
        }),
        chunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'check.' },
        }),
        chunk({ type: 'content_block_stop', index: 0 }),
        chunk({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu-1', name: 'propose_reminder_task' },
        }),
        chunk({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"plantId":"p1",' },
        }),
        chunk({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"type":"water","frequencyDays":7}' },
        }),
        chunk({ type: 'content_block_stop', index: 1 }),
        chunk({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 60 },
        }),
        chunk({ type: 'message_stop' }),
      ]),
    });

    const { deltas, response } = await drain(invokeChatModelStream(args));

    expect(deltas).toEqual(['Let me ', 'check.']);
    expect(response.stopReason).toBe('tool_use');
    expect(response.inputTokens).toBe(120);
    expect(response.outputTokens).toBe(60);
    expect(response.costUsd).toBeGreaterThan(0);
    // Content blocks are byte-compatible with the sync wrapper's shape:
    // accumulated text + tool_use with the input JSON reassembled.
    expect(response.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'tu-1',
        name: 'propose_reminder_task',
        input: { plantId: 'p1', type: 'water', frequencyDays: 7 },
      },
    ]);
  });

  // #460. Same accounting contract as the sync wrapper: cached tokens are
  // metered as consumption (the per-household cap counts them) and priced as
  // the discount they are.
  it('carries the cache accounting off message_start', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([
        chunk({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 100_000,
              cache_read_input_tokens: 800_000,
              cache_creation_input_tokens: 100_000,
            },
          },
        }),
        chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }),
        chunk({ type: 'message_stop' }),
      ]),
    });

    const { response } = await drain(invokeChatModelStream(args));

    expect(response.inputTokens).toBe(1_000_000);
    expect(response.cacheReadTokens).toBe(800_000);
    expect(response.cacheWriteTokens).toBe(100_000);
    expect(response.costUsd).toBeCloseTo(0.1 + 0.125 + 0.08, 10);
  });

  it('sends a cache breakpoint on the last message, and an abort signal', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([chunk({ type: 'message_stop' })]),
    });
    await drain(invokeChatModelStream(args));

    const command = bedrockSend.mock.calls[0][0] as { input: { body: string } };
    const body = JSON.parse(command.input.body) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    // A hung stream must not hold the 90-second Lambda either.
    expect(bedrockSend.mock.calls[0][1]).toHaveProperty('abortSignal');
  });

  it('surfaces a hung stream as a timeout rather than holding the Lambda', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    bedrockSend.mockRejectedValueOnce(abortErr);

    await expect(drain(invokeChatModelStream(args))).rejects.toThrow(/stream timed out after/);
  });

  // The streaming path takes the turn deadline for the same reason the sync
  // path does: it is one of the six calls that together have to fit inside the
  // Lambda, and it is the one that can sit open the longest.
  it('refuses to open a stream the turn has no time left for', async () => {
    await expect(
      drain(invokeChatModelStream({ ...args, deadlineAt: Date.now() - 1 }))
    ).rejects.toThrow('Chat turn deadline passed before this Bedrock call');
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('skips unknown event types instead of crashing', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([
        chunk({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
        chunk({ type: 'ping' }),
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi.' },
        }),
        chunk({ type: 'content_block_stop', index: 0 }),
        chunk({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 },
        }),
        chunk({ type: 'message_stop' }),
      ]),
    });

    const { deltas, response } = await drain(invokeChatModelStream(args));
    expect(deltas).toEqual(['Hi.']);
    expect(response.content).toEqual([{ type: 'text', text: 'Hi.' }]);
    expect(response.stopReason).toBe('end_turn');
  });

  it('surfaces non-chunk stream members (throttling etc.) as errors', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([{ throttlingException: { message: 'Too many requests' } }]),
    });
    await expect(drain(invokeChatModelStream(args))).rejects.toThrow(/throttlingException/);
  });

  it('surfaces in-band error events (guardrail trips) as errors', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: iterate([
        chunk({ type: 'error', error: { type: 'overloaded', message: 'Overloaded' } }),
      ]),
    });
    await expect(drain(invokeChatModelStream(args))).rejects.toThrow('Overloaded');
  });
});
