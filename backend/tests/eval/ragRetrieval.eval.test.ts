/**
 * Starter AI-evaluation harness (AIEV-01/02/26) for the plant-care RAG path.
 *
 * This is the "baseline eval set" committed as part of the 2026-07-05
 * conformance remediation — see docs/RESPONSIBLE-TECH-AUDITS.md for the
 * dated waiver covering what this does NOT yet cover (live faithfulness /
 * hallucination / refusal scoring against real Bedrock output, red-team,
 * judge calibration).
 *
 * What this DOES cover, honestly: `evals/benchmark.jsonl` pairs a natural
 * question with the exact corpus chunk that answers it (by source +
 * sectionTitle). Rather than calling live Bedrock/Titan to embed each
 * question (this repo's remediation pass is prohibited from calling real
 * AWS/Bedrock infrastructure, and a from-scratch CI job shouldn't depend on
 * network + cost anyway), each benchmark item's own anchor chunk's
 * PRE-COMPUTED embedding stands in for "a well-embedded query about this
 * topic" — a real semantic query embedding for "how often should I water a
 * monstera?" should land close to the watering-basics chunk in the same
 * 1024-dim space Titan produced. This validates:
 *   - the deterministic retrieval algorithm (cosine ranking, top-K sort)
 *   - corpus coverage (a chunk with the expected source/section still exists)
 *   - a regression gate against a committed baseline (AIEV-26)
 *
 * It does NOT validate live Titan query-embedding quality end-to-end — see
 * evals/README.md "Limitations" for the honest boundary and what a real
 * end-to-end eval would additionally require.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { searchCorpusWithEmbedding } from '../../src/services/chat/corpus.js';
import corpusJson from '../../src/data/plant-care-corpus-embeddings.json' with { type: 'json' };

interface CorpusChunk {
  source: string;
  articleTitle: string;
  sectionTitle: string;
  text: string;
  embedding: number[];
}
const CORPUS = corpusJson as unknown as { chunks: CorpusChunk[] };

interface BenchmarkItem {
  id: string;
  query: string;
  source: string;
  sectionTitle: string;
  expectedFacts: string[];
}

interface EvalBaseline {
  generatedAt: string;
  questionCount: number;
  recallAt3: number;
  ownChunkTop1Rate: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function loadBenchmark(): BenchmarkItem[] {
  const raw = readFileSync(resolve(REPO_ROOT, 'evals/benchmark.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchmarkItem);
}

function loadBaseline(): EvalBaseline {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'evals/eval-baseline.json'), 'utf8')
  ) as EvalBaseline;
}

describe('RAG retrieval regression — starter eval (AIEV-02/26)', () => {
  const benchmark = loadBenchmark();
  const baseline = loadBaseline();

  it('every benchmark item still anchors to a chunk that exists in the corpus', () => {
    for (const item of benchmark) {
      const anchor = CORPUS.chunks.find(
        (c) => c.source === item.source && c.sectionTitle === item.sectionTitle
      );
      expect(
        anchor,
        `benchmark item ${item.id} references source="${item.source}" sectionTitle="${item.sectionTitle}", which no longer exists in the corpus — the corpus changed and evals/benchmark.jsonl needs updating (or this is exactly the drift AIEV-26 exists to catch)`
      ).toBeDefined();
    }
  });

  it('every corpus source article has at least one benchmark question (coverage floor)', () => {
    const sources = new Set(CORPUS.chunks.map((c) => c.source));
    const covered = new Set(benchmark.map((b) => b.source));
    const uncovered = [...sources].filter((s) => !covered.has(s));
    expect(
      uncovered,
      `corpus articles with zero benchmark coverage: ${uncovered.join(', ')}`
    ).toHaveLength(0);
  });

  it('recall@3 and top-1 rate do not regress below the committed baseline', () => {
    let recallHits = 0;
    let top1Hits = 0;
    const misses: string[] = [];

    for (const item of benchmark) {
      const anchor = CORPUS.chunks.find(
        (c) => c.source === item.source && c.sectionTitle === item.sectionTitle
      );
      if (!anchor) continue; // surfaced by the drift test above

      const results = searchCorpusWithEmbedding(anchor.embedding, 3);
      if (results.some((r) => r.source === item.source)) {
        recallHits++;
      } else {
        misses.push(item.id);
      }
      if (results[0]?.source === item.source) top1Hits++;
    }

    const recallAt3 = recallHits / benchmark.length;
    const ownChunkTop1Rate = top1Hits / benchmark.length;

    expect(
      recallAt3,
      `recall@3 (${recallAt3.toFixed(3)}) regressed below the committed baseline (${baseline.recallAt3}). Misses: ${misses.join(', ') || 'none — check baseline math'}`
    ).toBeGreaterThanOrEqual(baseline.recallAt3);
    expect(ownChunkTop1Rate).toBeGreaterThanOrEqual(baseline.ownChunkTop1Rate);
    expect(benchmark.length).toBeGreaterThanOrEqual(baseline.questionCount);
  });
});
