import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the AWS SDK + X-Ray BEFORE the module under test loads — leafHealth.ts
// constructs and wraps the client at module scope (same pattern as
// chatBedrock.test.ts). Hoisted singletons survive vi.resetModules().
const bedrockSend = vi.hoisted(() => vi.fn());
const invokeModelCommandMock = vi.hoisted(() => vi.fn((input: unknown) => ({ input })));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: bedrockSend })),
  InvokeModelCommand: invokeModelCommandMock,
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: (client: unknown) => client },
}));

const ORIGINAL = process.env;

const VALID_ASSESSMENT = {
  overall: 'monitor',
  observations: [
    { sign: 'yellowing', confidence: 'high', note: 'Lower leaf edges are turning yellow.' },
  ],
  suggestion: 'Check soil moisture before the next watering.',
  disclaimer: 'This is a cosmetic visual check from a single photo, not a diagnosis.',
};

function modelResponse(text: string) {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1500, output_tokens: 200 },
      })
    ),
  };
}

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

async function subject() {
  return await import('../../../src/services/leafHealth.js');
}

describe('assessLeafHealth (Bedrock vision wrapper)', () => {
  beforeEach(() => {
    vi.resetModules();
    bedrockSend.mockReset();
    invokeModelCommandMock.mockClear();
    process.env = { ...ORIGINAL };
    delete process.env.BEDROCK_CHAT_MODEL_ID;
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('builds an Anthropic Messages payload with an image content block (data URL → media_type)', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse(JSON.stringify(VALID_ASSESSMENT)));
    const { assessLeafHealth } = await subject();

    await assessLeafHealth(`data:image/webp;base64,${'A'.repeat(100)}`);

    const input = lastCommandInput();
    expect(input.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(input.contentType).toBe('application/json');
    const payload = JSON.parse(input.body);
    expect(payload.anthropic_version).toBe('bedrock-2023-05-31');
    expect(payload.max_tokens).toBeLessThanOrEqual(1024);
    // Tightly-scoped prompt: visible leaf condition only, strict JSON out.
    expect(payload.system).toMatch(/ONLY what is visible/);
    expect(payload.system).toMatch(/"overall": "healthy" \| "monitor" \| "concern"/);
    // One user turn: image block (data-URL prefix stripped) + instruction.
    expect(payload.messages).toHaveLength(1);
    const [imageBlock, textBlock] = payload.messages[0].content;
    expect(imageBlock).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'A'.repeat(100) },
    });
    expect(textBlock.type).toBe('text');
  });

  it('defaults bare base64 input to image/jpeg', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse(JSON.stringify(VALID_ASSESSMENT)));
    const { assessLeafHealth } = await subject();

    await assessLeafHealth('B'.repeat(100));

    const payload = JSON.parse(lastCommandInput().body);
    expect(payload.messages[0].content[0].source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'B'.repeat(100),
    });
  });

  it('respects BEDROCK_CHAT_MODEL_ID when set', async () => {
    process.env.BEDROCK_CHAT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6-v1:0';
    bedrockSend.mockResolvedValueOnce(modelResponse(JSON.stringify(VALID_ASSESSMENT)));
    const { assessLeafHealth } = await subject();

    await assessLeafHealth('C'.repeat(100));

    expect(lastCommandInput().modelId).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
  });

  it('returns the parsed assessment on a strict-JSON reply', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse(JSON.stringify(VALID_ASSESSMENT)));
    const { assessLeafHealth } = await subject();

    const result = await assessLeafHealth('D'.repeat(100));

    expect(result).toEqual(VALID_ASSESSMENT);
    expect(result.demo).toBeUndefined();
  });

  it('extracts the JSON object when the model wraps it in prose', async () => {
    bedrockSend.mockResolvedValueOnce(
      modelResponse(`Here is my assessment:\n${JSON.stringify(VALID_ASSESSMENT)}\nHope it helps!`)
    );
    const { assessLeafHealth } = await subject();

    const result = await assessLeafHealth('E'.repeat(100));

    expect(result.overall).toBe('monitor');
    expect(result.observations).toHaveLength(1);
  });

  it('throws LeafHealthParseError when the reply has no parseable JSON', async () => {
    bedrockSend.mockResolvedValueOnce(modelResponse('The leaf looks a bit yellow to me.'));
    const { assessLeafHealth } = await subject();

    await expect(assessLeafHealth('F'.repeat(100))).rejects.toMatchObject({
      name: 'LeafHealthParseError',
    });
  });

  it('throws LeafHealthParseError when the JSON does not match the strict schema', async () => {
    bedrockSend.mockResolvedValueOnce(
      modelResponse(JSON.stringify({ ...VALID_ASSESSMENT, overall: 'dying' }))
    );
    const { assessLeafHealth } = await subject();

    await expect(assessLeafHealth('G'.repeat(100))).rejects.toMatchObject({
      name: 'LeafHealthParseError',
    });
  });

  it('falls back to the canned demo assessment when Bedrock access is unavailable', async () => {
    const denied = new Error('not authorized to perform: bedrock:InvokeModel');
    denied.name = 'AccessDeniedException';
    bedrockSend.mockRejectedValueOnce(denied);
    const { assessLeafHealth } = await subject();

    const result = await assessLeafHealth('H'.repeat(100));

    expect(result.demo).toBe(true);
    expect(result.overall).toBe('monitor');
    expect(result.disclaimer).toMatch(/not a plant-health diagnosis/);
  });

  it('rethrows non-access transport errors (throttling) for the 502 path', async () => {
    const throttled = new Error('Too many requests');
    throttled.name = 'ThrottlingException';
    bedrockSend.mockRejectedValueOnce(throttled);
    const { assessLeafHealth } = await subject();

    await expect(assessLeafHealth('I'.repeat(100))).rejects.toThrow('Too many requests');
  });

  it('surfaces a clear timeout error when the call is aborted', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    bedrockSend.mockRejectedValueOnce(aborted);
    const { assessLeafHealth } = await subject();

    await expect(assessLeafHealth('J'.repeat(100))).rejects.toThrow(/timed out after 5000ms/);
  });

  it('parseImageInput allowlists media types (unknown types default to jpeg)', async () => {
    const { parseImageInput } = await subject();
    expect(parseImageInput('data:image/png;base64,xyz')).toEqual({
      mediaType: 'image/png',
      data: 'xyz',
    });
    // image/tiff is not an Anthropic-supported type — keep the data, fall
    // back to jpeg rather than sending an invalid media_type.
    expect(parseImageInput('data:image/tiff;base64,xyz')).toEqual({
      mediaType: 'image/jpeg',
      data: 'xyz',
    });
  });
});
