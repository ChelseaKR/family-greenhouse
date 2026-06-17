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
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Help my fern' }] }],
      tools: [
        {
          name: 'list_plants',
          description: 'List the household plants',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
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
