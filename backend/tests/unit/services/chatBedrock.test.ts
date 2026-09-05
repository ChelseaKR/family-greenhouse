import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from '../../../src/services/chat/types.js';

// Mock the AWS SDK + X-Ray BEFORE the module under test loads — bedrock.ts
// constructs and wraps the client at module scope. We never call real Bedrock.
// Both mocks are hoisted SINGLETONS: this file uses vi.resetModules() to
// re-read env at module load, which re-runs mock factories — a non-hoisted
// vi.fn would give each re-import a fresh instance and lose mock.calls.
const bedrockSend = vi.hoisted(() => vi.fn());
const invokeModelCommandMock = vi.hoisted(() =>
  vi.fn(function (input: unknown) {
    return { input };
  })
);
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(function () {
    return { send: bedrockSend };
  }),
  InvokeModelCommand: invokeModelCommandMock,
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: (client: unknown) => client },
}));

const ORIGINAL = process.env;

function modelResponse(overrides: Record<string, unknown> = {}) {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({
        content: [{ type: 'text', text: 'Water it weekly.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
        ...overrides,
      })
    ),
  };
}

const tools: ToolDefinition[] = [
  {
    name: 'list_plants',
    description: 'List the household plants',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

interface CommandInput {
  modelId: string;
  contentType: string;
  accept: string;
  body: string;
}

function lastCommandInput(): CommandInput {
  const calls = invokeModelCommandMock.mock.calls;
  return calls[calls.length - 1][0] as CommandInput;
}

describe('invokeChatModel (Bedrock wrapper)', () => {
  beforeEach(() => {
    vi.resetModules();
    bedrockSend.mockReset();
    invokeModelCommandMock.mockClear();
    process.env = { ...ORIGINAL };
    delete process.env.BEDROCK_CHAT_MODEL_ID;
    delete process.env.BEDROCK_INPUT_USD_PER_MTOK;
    delete process.env.BEDROCK_OUTPUT_USD_PER_MTOK;
    delete process.env.BEDROCK_CHAT_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  async function subject() {
    return (await import('../../../src/services/chat/bedrock.js')).invokeChatModel;
  }

  it('builds an Anthropic Messages payload against the default inference profile', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    await invokeChatModel({
      system: 'You are a plant-care assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Help my fern' }] }],
      tools,
    });

    const cmd = lastCommandInput();
    expect(cmd.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(cmd.contentType).toBe('application/json');
    expect(cmd.accept).toBe('application/json');
    expect(JSON.parse(cmd.body)).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024, // default cap
      system: 'You are a plant-care assistant.',
      messages: [
        {
          role: 'user',
          // #460: the prompt-cache breakpoint sits on the LAST content block of
          // the LAST message, not after system + tools. See the note in
          // bedrock.ts — the static prefix is ~2,050 tokens and Haiku 4.5's
          // minimum cacheable prefix is 4,096, so a breakpoint there would
          // silently never cache. Here it covers tools + system + the whole
          // conversation, which is what the tool loop re-sends.
          content: [{ type: 'text', text: 'Help my fern', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [
        {
          name: 'list_plants',
          description: 'List the household plants',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
  });

  // #460. The tool loop makes up to 6 InvokeModel calls per turn and each one
  // re-sends everything the last one sent. One breakpoint on the last content
  // block turns iterations 2-6 into cache reads.
  it('marks the last content block of the last message as the cache breakpoint', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    await invokeChatModel({
      system: 's',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 'tu1', name: 'list_plants', input: {} },
          ],
        },
      ],
      tools,
    });

    const body = JSON.parse(lastCommandInput().body) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    // Only one breakpoint, and it is on the very last block: everything before
    // it — tools, system and the whole conversation — is the cached prefix.
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not put a breakpoint after system and tools, where it would never cache', async () => {
    // The static prefix is ~2,050 tokens (2,540 bytes of system prompt plus
    // 5,061 of tool schemas) and Haiku 4.5's minimum cacheable prefix is 4,096.
    // A breakpoint there is not an error — it silently never creates an entry —
    // so this asserts we did not "fix" it that way.
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    await invokeChatModel({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools,
    });

    const body = JSON.parse(lastCommandInput().body) as {
      system: unknown;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.system).toBe('s');
    expect(body.tools.every((t) => t.cache_control === undefined)).toBe(true);
  });

  it('sends no breakpoint at all when there are no messages to hang it on', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();
    await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(JSON.parse(lastCommandInput().body).messages).toEqual([]);
  });

  // The per-household monthly cap counts `inputTokens`. Once caching is on,
  // Bedrock reports the cached portion separately and `input_tokens` drops to
  // the uncached remainder — so counting only that would silently hand every
  // household several times the allowance the plan sells.
  it('meters cached tokens as consumption while pricing them as the discount they are', async () => {
    bedrockSend.mockResolvedValueOnce(
      modelResponse({
        usage: {
          input_tokens: 100_000,
          output_tokens: 0,
          cache_read_input_tokens: 800_000,
          cache_creation_input_tokens: 100_000,
        },
      })
    );
    const invokeChatModel = await subject();

    const res = await invokeChatModel({ system: 's', messages: [], tools: [] });

    // The meter: every token the model read.
    expect(res.inputTokens).toBe(1_000_000);
    expect(res.cacheReadTokens).toBe(800_000);
    expect(res.cacheWriteTokens).toBe(100_000);
    // The bill, at $1/MTok input: 0.1 uncached + 0.1x1.25 written + 0.8x0.1 read.
    expect(res.costUsd).toBeCloseTo(0.1 + 0.125 + 0.08, 10);
    // A full-price million would have been $1.00 — the same meter reading.
  });

  it('reports zero cache tokens for a response that carries no cache fields', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();
    const res = await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(res.cacheReadTokens).toBe(0);
    expect(res.cacheWriteTokens).toBe(0);
    expect(res.inputTokens).toBe(1_000_000);
    expect(res.costUsd).toBeCloseTo(1 + 2.5, 10);
  });

  // #460. A hung Bedrock connection used to hold the 90-second chat Lambda for
  // its whole timeout: the user saw a request that never returned and the
  // account paid for 90 seconds of a 512 MB function.
  it('abandons a hung call instead of holding the Lambda to its timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    bedrockSend.mockRejectedValueOnce(abortErr);
    const invokeChatModel = await subject();

    await expect(invokeChatModel({ system: 's', messages: [], tools: [] })).rejects.toThrow(
      /timed out after 25000ms/
    );

    // The signal has to reach the SDK call, not merely be constructed.
    expect(bedrockSend.mock.calls[0][1]).toHaveProperty('abortSignal');
  });

  // #460, the other half. The per-call bound above is 25s and the loop makes up
  // to six calls, so bounding a call does not bound a turn: 6 x 25s outlasts
  // the 90-second chat Lambda, and a killed function never runs the `finally`
  // that reconciles the 8,000-token budget reservation or resolves the turn
  // claim. The household would be billed for a turn that produced nothing.
  it('refuses to start a call the turn has no time left for', async () => {
    // Primed with a WORKING response: if the deadline is not honoured this
    // fails on "did not throw", which is the finding, rather than on a
    // TypeError from an unprimed mock.
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    await expect(
      invokeChatModel({ system: 's', messages: [], tools: [], deadlineAt: Date.now() - 1 })
    ).rejects.toThrow('Chat turn deadline passed before this Bedrock call');
    // Refused before the request, not after it: the point is not to spend the
    // time, so a call that cannot finish is never made.
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('clips the per-call timeout to what is left of the turn deadline', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    bedrockSend.mockRejectedValueOnce(abortErr);
    const invokeChatModel = await subject();

    // 5s left of the turn, against a 25s per-call bound: the call gets the 5s.
    await expect(
      invokeChatModel({ system: 's', messages: [], tools: [], deadlineAt: Date.now() + 5_000 })
    ).rejects.toThrow(/timed out after (4\d{3}|5000)ms/);
  });

  it('leaves a call with no deadline on the per-call bound alone', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    bedrockSend.mockRejectedValueOnce(abortErr);
    const invokeChatModel = await subject();

    await expect(invokeChatModel({ system: 's', messages: [], tools: [] })).rejects.toThrow(
      /timed out after 25000ms/
    );
  });

  it('honors maxOutputTokens and the BEDROCK_CHAT_MODEL_ID override', async () => {
    process.env.BEDROCK_CHAT_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    await invokeChatModel({ system: 's', messages: [], tools: [], maxOutputTokens: 256 });

    const cmd = lastCommandInput();
    expect(cmd.modelId).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(JSON.parse(cmd.body).max_tokens).toBe(256);
  });

  it('an explicitly-empty model env var falls through to the code default (|| not ??)', async () => {
    process.env.BEDROCK_CHAT_MODEL_ID = '';
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();
    await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(lastCommandInput().modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('parses content/stop_reason/usage and computes cost at Haiku list price', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    const res = await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(res.content).toEqual([{ type: 'text', text: 'Water it weekly.' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.inputTokens).toBe(1_000_000);
    expect(res.outputTokens).toBe(500_000);
    // 1M in @ $1/MTok + 0.5M out @ $5/MTok
    expect(res.costUsd).toBeCloseTo(1 + 2.5, 10);
  });

  it('uses env-overridden per-MTok prices in the cost calculation', async () => {
    process.env.BEDROCK_INPUT_USD_PER_MTOK = '3';
    process.env.BEDROCK_OUTPUT_USD_PER_MTOK = '15';
    bedrockSend.mockResolvedValueOnce(modelResponse());
    const invokeChatModel = await subject();

    const res = await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(res.costUsd).toBeCloseTo(3 + 7.5, 10);
  });

  it('defaults a missing stop_reason to end_turn', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse({ stop_reason: undefined }));
    const invokeChatModel = await subject();
    const res = await invokeChatModel({ system: 's', messages: [], tools: [] });
    expect(res.stopReason).toBe('end_turn');
  });

  it('surfaces a Bedrock HTTP-200 error envelope as a thrown Error with its message', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({
          type: 'error',
          error: { type: 'guardrail_intervened', message: 'Content blocked by guardrail' },
        })
      ),
    });
    const invokeChatModel = await subject();
    await expect(invokeChatModel({ system: 's', messages: [], tools: [] })).rejects.toThrow(
      'Content blocked by guardrail'
    );
  });

  it('throws a descriptive error when usage/content are simply absent', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'x' }] })),
    });
    const invokeChatModel = await subject();
    await expect(invokeChatModel({ system: 's', messages: [], tools: [] })).rejects.toThrow(
      'Bedrock returned no content or usage'
    );
  });
});
