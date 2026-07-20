/**
 * Starter AI-evaluation harness (AIEV-01/02/26) for the plant-care RAG path.
 *
 * This is the "baseline eval set" committed as part of the 2026-07-05
 * conformance remediation and expanded 2026-07-17 (22 → 134 items across four
 * behavior classes) — see docs/RESPONSIBLE-TECH-AUDITS.md for the dated
 * waiver covering what this does NOT yet cover (live faithfulness /
 * hallucination / refusal scoring against real Bedrock output, red-team,
 * judge calibration).
 *
 * What this DOES cover, honestly:
 *
 * `evals/benchmark.jsonl` items carry a `category` + `expectedBehavior`:
 *   - `corpus` / `answer` — a real-user-phrased question paired with the
 *     exact corpus chunk that answers it (by source + sectionTitle). Rather
 *     than calling live Bedrock/Titan to embed each question (a from-scratch
 *     CI job shouldn't depend on network + cost), each item's own anchor
 *     chunk's PRE-COMPUTED embedding stands in for "a well-embedded query
 *     about this topic". This validates the deterministic retrieval algorithm
 *     (cosine ranking, top-K sort), corpus coverage/drift, and a regression
 *     gate against a committed baseline (AIEV-26).
 *   - `should-refuse` / `refuse` — pesticide-dosing, medical/vet-adjacent,
 *     and plant-ID-from-text questions the system prompt (rules 4/6) commits
 *     the model to refusing.
 *   - `out-of-corpus` / `abstain` — questions the 11-article corpus cannot
 *     answer; correct behavior is honest abstention, never fabrication.
 *   - `household-data` / `answer` — questions answerable only via household
 *     tools; `expectedTools` names the registry tools whose data supports
 *     the answer.
 *
 * IMPORTANT honesty boundary: the three adversarial classes are SCHEMA-
 * VALIDATED AND STRUCTURALLY GATED here (labels well-formed, tool names real,
 * class counts can't silently shrink) but their expected behaviors are NOT
 * yet graded against live model output — that is the roadmap's
 * generation-layer scoring gate (a manually-dispatched, budget-capped job
 * against real Bedrock), which does not exist yet. Nothing in this file
 * calls a model. See evals/README.md "Limitations".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { searchCorpusWithEmbedding } from '../../src/services/chat/corpus.js';
import { TOOL_REGISTRY } from '../../src/services/chat/tools.js';
import corpusJson from '../../src/data/plant-care-corpus-embeddings.json' with { type: 'json' };

interface CorpusChunk {
  source: string;
  articleTitle: string;
  sectionTitle: string;
  text: string;
  embedding: number[];
}
const CORPUS = corpusJson as unknown as { chunks: CorpusChunk[] };

type BenchmarkCategory = 'corpus' | 'should-refuse' | 'out-of-corpus' | 'household-data';
type ExpectedBehavior = 'answer' | 'refuse' | 'abstain';

interface BenchmarkItem {
  id: string;
  query: string;
  category: BenchmarkCategory;
  expectedBehavior: ExpectedBehavior;
  /** corpus items only: the chunk that answers the question. */
  source?: string;
  sectionTitle?: string;
  expectedFacts?: string[];
  /** household-data items only: registry tools whose data supports the answer. */
  expectedTools?: string[];
  /** adversarial items: what correct behavior looks like, for the future grader + human reviewers. */
  notes?: string;
}

interface EvalBaseline {
  generatedAt: string;
  questionCount: number;
  classCounts: Record<BenchmarkCategory, number>;
  perArticleFloor: number;
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
  const corpusItems = benchmark.filter((b) => b.category === 'corpus');

  it('benchmark schema holds: unique ids, valid category/behavior pairings, class-appropriate fields', () => {
    const ids = benchmark.map((b) => b.id);
    expect(new Set(ids).size, 'duplicate benchmark ids').toBe(ids.length);

    const behaviorFor: Record<BenchmarkCategory, ExpectedBehavior> = {
      corpus: 'answer',
      'should-refuse': 'refuse',
      'out-of-corpus': 'abstain',
      'household-data': 'answer',
    };

    for (const item of benchmark) {
      expect(
        Object.keys(behaviorFor),
        `item ${item.id} has unknown category "${item.category}"`
      ).toContain(item.category);
      expect(
        item.expectedBehavior,
        `item ${item.id}: category "${item.category}" must pair with expectedBehavior "${behaviorFor[item.category]}"`
      ).toBe(behaviorFor[item.category]);
      expect(item.query.trim().length, `item ${item.id} has an empty query`).toBeGreaterThan(0);

      if (item.category === 'corpus') {
        expect(item.source, `corpus item ${item.id} is missing source`).toBeTruthy();
        expect(item.sectionTitle, `corpus item ${item.id} is missing sectionTitle`).toBeTruthy();
        expect(
          item.expectedFacts?.length ?? 0,
          `corpus item ${item.id} needs at least one expectedFact`
        ).toBeGreaterThan(0);
      } else {
        expect(
          item.source,
          `${item.category} item ${item.id} must not claim a corpus anchor`
        ).toBeUndefined();
      }

      if (item.category === 'household-data') {
        expect(
          item.expectedTools?.length ?? 0,
          `household-data item ${item.id} needs expectedTools`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('household-data expectedTools all exist in TOOL_REGISTRY (catches tool renames/removals)', () => {
    const registryNames = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const item of benchmark) {
      for (const tool of item.expectedTools ?? []) {
        expect(
          registryNames,
          `item ${item.id} expects tool "${tool}", which is not in TOOL_REGISTRY — the tool was renamed or removed and the benchmark needs updating`
        ).toContain(tool);
      }
    }
  });

  it('every corpus-class benchmark item still anchors to a chunk that exists in the corpus', () => {
    for (const item of corpusItems) {
      const anchor = CORPUS.chunks.find(
        (c) => c.source === item.source && c.sectionTitle === item.sectionTitle
      );
      expect(
        anchor,
        `benchmark item ${item.id} references source="${item.source}" sectionTitle="${item.sectionTitle}", which no longer exists in the corpus — the corpus changed and evals/benchmark.jsonl needs updating (or this is exactly the drift AIEV-26 exists to catch)`
      ).toBeDefined();
    }
  });

  it('every corpus source article meets the per-article question floor', () => {
    const sources = new Set(CORPUS.chunks.map((c) => c.source));
    const countBySource = new Map<string, number>();
    for (const item of corpusItems) {
      if (!item.source) continue;
      countBySource.set(item.source, (countBySource.get(item.source) ?? 0) + 1);
    }
    const below = [...sources].filter(
      (s) => (countBySource.get(s) ?? 0) < baseline.perArticleFloor
    );
    expect(
      below,
      `corpus articles below the ${baseline.perArticleFloor}-question floor: ${below
        .map((s) => `${s} (${countBySource.get(s) ?? 0})`)
        .join(', ')}`
    ).toHaveLength(0);
  });

  it('per-class counts do not shrink below the committed baseline', () => {
    const counts: Record<string, number> = {};
    for (const item of benchmark) {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    for (const [category, floor] of Object.entries(baseline.classCounts)) {
      expect(
        counts[category] ?? 0,
        `class "${category}" shrank to ${counts[category] ?? 0} items (baseline ${floor}) — adversarial coverage must not silently erode`
      ).toBeGreaterThanOrEqual(floor);
    }
    expect(benchmark.length).toBeGreaterThanOrEqual(baseline.questionCount);
  });

  it('recall@3 and top-1 rate over corpus-class items do not regress below the committed baseline', () => {
    let recallHits = 0;
    let top1Hits = 0;
    const misses: string[] = [];

    for (const item of corpusItems) {
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

    const recallAt3 = recallHits / corpusItems.length;
    const ownChunkTop1Rate = top1Hits / corpusItems.length;

    expect(
      recallAt3,
      `recall@3 (${recallAt3.toFixed(3)}) regressed below the committed baseline (${baseline.recallAt3}). Misses: ${misses.join(', ') || 'none — check baseline math'}`
    ).toBeGreaterThanOrEqual(baseline.recallAt3);
    expect(ownChunkTop1Rate).toBeGreaterThanOrEqual(baseline.ownChunkTop1Rate);
  });
});
