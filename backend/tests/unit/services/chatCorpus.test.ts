import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Bedrock + X-Ray BEFORE importing corpus.ts (it instantiates the
// client at module scope).
const bedrockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: bedrockSend })),
  InvokeModelCommand: vi.fn((input: unknown) => ({ input })),
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: (client: unknown) => client },
}));

import { searchCorpus, searchCorpusWithEmbedding } from '../../../src/services/chat/corpus.js';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import corpusJson from '../../../src/data/plant-care-corpus-embeddings.json';

interface CorpusChunk {
  source: string;
  articleTitle: string;
  sectionTitle: string;
  text: string;
  embedding: number[];
}
const CORPUS = corpusJson as unknown as {
  dimensions: number;
  chunks: CorpusChunk[];
};

function embedResponse(embedding: number[]) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embedding })),
  };
}

describe('searchCorpusWithEmbedding (retrieval core, no Bedrock)', () => {
  it("a chunk's own embedding retrieves that chunk first with score ~1", () => {
    const target = CORPUS.chunks[0];
    const results = searchCorpusWithEmbedding(target.embedding, 3);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      articleTitle: target.articleTitle,
      sectionTitle: target.sectionTitle,
      source: target.source,
      text: target.text,
    });
    expect(results[0].score).toBeCloseTo(1, 3);
  });

  it('returns results in descending score order with the documented shape', () => {
    const results = searchCorpusWithEmbedding(CORPUS.chunks[1].embedding, 5);
    expect(results).toHaveLength(5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
    for (const r of results) {
      expect(typeof r.articleTitle).toBe('string');
      expect(typeof r.sectionTitle).toBe('string');
      expect(typeof r.source).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
      expect(typeof r.score).toBe('number');
    }
  });

  it('normalizes the supplied vector, so scale does not change the ranking', () => {
    const target = CORPUS.chunks[2];
    const scaled = target.embedding.map((x) => x * 5);
    const results = searchCorpusWithEmbedding(scaled, 1);
    expect(results[0].text).toBe(target.text);
    expect(results[0].score).toBeCloseTo(1, 3);
  });

  it('respects topK', () => {
    expect(searchCorpusWithEmbedding(CORPUS.chunks[0].embedding, 1)).toHaveLength(1);
  });
});

describe('searchCorpus (Titan embed via Bedrock, mocked)', () => {
  beforeEach(() => {
    bedrockSend.mockReset();
    vi.mocked(InvokeModelCommand).mockClear();
  });

  it('embeds the query with the corpus dimensions and retrieves relevant chunks', async () => {
    const target = CORPUS.chunks[0];
    bedrockSend.mockResolvedValueOnce(embedResponse(target.embedding));

    const results = await searchCorpus('how often should I water a monstera?', 3);
    expect(results).toHaveLength(3);
    expect(results[0].text).toBe(target.text);

    // Request construction: Titan embed payload with matching dimensions.
    const cmdInput = vi.mocked(InvokeModelCommand).mock.calls[0][0] as {
      modelId: string;
      contentType: string;
      accept: string;
      body: string;
    };
    expect(cmdInput.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(cmdInput.contentType).toBe('application/json');
    expect(cmdInput.accept).toBe('application/json');
    expect(JSON.parse(cmdInput.body)).toEqual({
      inputText: 'how often should I water a monstera?',
      dimensions: CORPUS.dimensions,
      normalize: true,
    });
  });

  it('throws when the embed response is missing an embedding', async () => {
    bedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({})),
    });
    await expect(searchCorpus('q')).rejects.toThrow(/missing or wrong-dimension/);
  });

  it('throws when the embedding has the wrong dimensionality', async () => {
    bedrockSend.mockResolvedValueOnce(embedResponse([0.1, 0.2, 0.3]));
    await expect(searchCorpus('q')).rejects.toThrow(/missing or wrong-dimension/);
  });

  it('propagates Bedrock invocation failures (caller handles degradation)', async () => {
    bedrockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
    await expect(searchCorpus('q')).rejects.toThrow('ThrottlingException');
  });
});
