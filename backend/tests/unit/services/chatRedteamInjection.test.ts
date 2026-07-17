/**
 * Red-team injection corpus (AI-EVALUATION-STANDARD §2, offline slice) for the
 * plant-care chat tool layer.
 *
 * Roadmap 2026-07-06 §3.1 gate 5 calls for "a committed injection corpus test
 * (prompt-injection strings inside plant names/notes — user-controlled fields
 * that flow into tool results and RAG context; assert tools stay
 * household-scoped and system-prompt rules hold)."
 *
 * WHAT THIS TEST COVERS (deterministic, no live model): every payload in
 * `evals/redteam/injection-corpus.json` is fed through the REAL tool executors
 * and the REAL model-boundary sanitizer, and the three MECHANICAL invariants
 * are asserted to hold regardless of the injected text:
 *   - household-scope: a read tool scopes DynamoDB access by ctx.householdId,
 *     never by a value in the tool input (a forged householdId is ignored)
 *   - pii-redaction: sanitizeToolResultForModel strips forbidden keys even when
 *     sibling values carry injection payloads
 *   - write-gate: propose_reminder_task rejects cross-household/hallucinated
 *     plantIds and non-member assignees, and enforces schema bounds
 *
 * WHAT IT DOES NOT COVER (honesty boundary — see docs/audits/red-team-2026-07-17.md):
 * whether the live model actually REFUSES or declines to fabricate when it sees
 * the injected text in a tool result is NOT tested here — nothing in this file
 * calls Bedrock. That is the live generation-layer eval (⛔USER-triggered,
 * budget-capped), which is not built. Do not read a green run here as "the
 * model is injection-proof"; read it as "a stored injection payload cannot make
 * the tool layer leak PII or cross household boundaries."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');

import {
  findTool,
  sanitizeToolResultForModel,
  type ProposeReminderResult,
} from '../../../src/services/chat/tools.js';
import * as plantService from '../../../src/services/plantService.js';
import * as householdService from '../../../src/services/householdService.js';
import type { Plant, HouseholdMember } from '../../../src/models/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

interface InjectionPayload {
  id: string;
  owasp: string;
  vector: string;
  payload: string;
  probes: 'household-scope' | 'pii-redaction' | 'write-gate';
  note: string;
}
interface InjectionCorpus {
  generatedAt: string;
  invariants: Record<string, string>;
  payloads: InjectionPayload[];
}

const CORPUS: InjectionCorpus = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'evals/redteam/injection-corpus.json'), 'utf8')
) as InjectionCorpus;

const VICTIM_HH = 'hh-victim';

function plantWithInjectedField(field: 'name' | 'notes' | 'location', payload: string): Plant {
  return {
    id: 'p-victim-1',
    householdId: VICTIM_HH,
    name: field === 'name' ? payload : 'Bertha',
    species: 'Monstera',
    location: field === 'location' ? payload : 'living room',
    imageUrl: null,
    notes: field === 'notes' ? payload : null,
    status: 'active',
    tags: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    createdBy: 'u-owner',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Every FORBIDDEN key normalizes to one of these forms; the corpus assertions
// below check the sanitized output carries none of them.
const PII_KEYS = [
  'email',
  'actorEmail',
  'phone',
  'phoneNumber',
  'cognitoSub',
  'sub',
  'userId',
  'memberId',
  'memberName',
  'householdId',
  'createdBy',
  'assignedTo',
  'assigneeName',
];

function assertNoPiiKeys(value: unknown): void {
  const seen: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, nested] of Object.entries(v as Record<string, unknown>)) {
      const norm = k.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (PII_KEYS.some((p) => p.toLowerCase() === norm)) seen.push(k);
      walk(nested);
    }
  };
  walk(value);
  expect(seen, `PII-bearing keys leaked to the model boundary: ${seen.join(', ')}`).toHaveLength(0);
}

describe('red-team: prompt-injection corpus over the chat tool layer (AIEV §2 offline)', () => {
  it('the corpus is well-formed (unique ids, known probe classes, OWASP tags)', () => {
    const ids = CORPUS.payloads.map((p) => p.id);
    expect(new Set(ids).size, 'duplicate payload ids').toBe(ids.length);
    const knownProbes = new Set(Object.keys(CORPUS.invariants));
    for (const p of CORPUS.payloads) {
      expect(knownProbes, `payload ${p.id} names unknown probe "${p.probes}"`).toContain(p.probes);
      expect(p.owasp, `payload ${p.id} missing OWASP tag`).toMatch(/^LLM\d{2}$/);
      expect(p.payload.length, `payload ${p.id} is empty`).toBeGreaterThan(0);
    }
    // Coverage floor: keep at least one payload per invariant class so the
    // corpus can't silently lose a whole category.
    for (const probe of knownProbes) {
      expect(
        CORPUS.payloads.some((p) => p.probes === probe),
        `no payload exercises invariant "${probe}"`
      ).toBe(true);
    }
  });

  describe('household-scope: forged scope in tool input never widens the query', () => {
    const scopePayloads = CORPUS.payloads.filter((p) => p.probes === 'household-scope');

    it.each(scopePayloads.map((p) => [p.id, p] as const))(
      'list_household_plants(%s) queries only the caller household',
      async (_id, p) => {
        vi.mocked(plantService.getPlants).mockResolvedValueOnce([
          plantWithInjectedField('location', p.payload),
        ]);
        const tool = findTool('list_household_plants')!;
        // Forge extra/adversarial keys onto the tool input — the schema has no
        // properties, so these are exactly the "smuggled argument" case.
        const out = await tool.execute(
          { householdId: 'hh-ATTACKER', location: p.payload } as never,
          { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1 }
        );
        // Scoped to the AUTHENTICATED household, never to the injected value.
        expect(plantService.getPlants).toHaveBeenCalledWith(VICTIM_HH);
        expect(plantService.getPlants).not.toHaveBeenCalledWith('hh-ATTACKER');
        assertNoPiiKeys(sanitizeToolResultForModel(out));
      }
    );
  });

  describe('pii-redaction: injected values cannot smuggle PII to the model', () => {
    const piiPayloads = CORPUS.payloads.filter(
      (p) => p.probes === 'pii-redaction' && p.vector.startsWith('plant.')
    );

    it.each(piiPayloads.map((p) => [p.id, p] as const))(
      'list_household_plants output is PII-clean even with injection in a plant field (%s)',
      async (_id, p) => {
        const field = p.vector.split('.')[1] as 'name' | 'notes' | 'location';
        vi.mocked(plantService.getPlants).mockResolvedValueOnce([
          plantWithInjectedField(field, p.payload),
        ]);
        const tool = findTool('list_household_plants')!;
        const out = await tool.execute(
          {},
          { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1 }
        );
        const sanitized = sanitizeToolResultForModel(out);
        assertNoPiiKeys(sanitized);
        // The injected string is DATA: it may pass through in the value, but the
        // owner's identity fields must be gone. Confirm the projection dropped
        // createdBy/householdId (present on the DB record, absent in tool output).
        const serialized = JSON.stringify(sanitized);
        expect(serialized).not.toContain('u-owner');
        expect(serialized).not.toContain(VICTIM_HH);
      }
    );

    it('a forbidden KEY is stripped even when a sibling VALUE carries injection text (inj-pii-smuggle-01)', () => {
      const smuggle = CORPUS.payloads.find((p) => p.id === 'inj-pii-smuggle-01')!;
      const sanitized = sanitizeToolResultForModel({
        nickname: 'Bertha',
        rationale: smuggle.payload, // allowed value key — passes through verbatim
        email: 'keyed-owner@example.test', // forbidden key — must be stripped
        member: { memberName: 'Owner', cognitoSub: 'sub-123' },
      });
      assertNoPiiKeys(sanitized);
      const serialized = JSON.stringify(sanitized);
      // The email under the forbidden `email` KEY is gone, as is the cognito
      // sub under a forbidden key. The email-shaped text inside the allowed
      // `rationale` VALUE stays verbatim — the sanitizer is key-based by design
      // (it does not scan or mangle values), which the corpus note documents.
      expect(serialized).not.toContain('keyed-owner@example.test');
      expect(serialized).not.toContain('sub-123');
      expect(serialized).toContain('Bertha');
      expect(serialized).toContain(smuggle.payload);
    });
  });

  describe('write-gate: propose_reminder_task rejects coerced writes', () => {
    it('rejects a cross-household / hallucinated plantId (inj-plantid-01)', async () => {
      const p = CORPUS.payloads.find((x) => x.id === 'inj-plantid-01')!;
      // getPlant is scoped to ctx.householdId; a plant not in this household
      // reads as null.
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
      const tool = findTool('propose_reminder_task')!;
      const out = (await tool.execute(
        { plantId: p.payload, type: 'water', frequencyDays: 7 } as never,
        { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1, proposalsThisTurn: 0 }
      )) as ProposeReminderResult;
      expect(plantService.getPlant).toHaveBeenCalledWith(VICTIM_HH, p.payload);
      expect(out.status).toBe('invalid');
    });

    it('rejects an assignee who is not a member of the caller household (inj-assignee-01)', async () => {
      const p = CORPUS.payloads.find((x) => x.id === 'inj-assignee-01')!;
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(
        plantWithInjectedField('name', 'Bertha')
      );
      const members: HouseholdMember[] = [
        {
          householdId: VICTIM_HH,
          userId: 'u-owner',
          name: 'Owner',
          email: 'owner@example.test',
          role: 'admin',
          joinedAt: '2025-01-01T00:00:00.000Z',
        },
      ];
      vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce(members);
      const tool = findTool('propose_reminder_task')!;
      const out = (await tool.execute(
        { plantId: 'p-victim-1', type: 'water', frequencyDays: 7, assignedTo: p.payload } as never,
        { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1, proposalsThisTurn: 0 }
      )) as ProposeReminderResult;
      expect(householdService.getHouseholdMembers).toHaveBeenCalledWith(VICTIM_HH);
      expect(out.status).toBe('invalid');
    });

    it('does not bypass schema bounds when injection text rides in customType (inj-customtype-01)', async () => {
      const p = CORPUS.payloads.find((x) => x.id === 'inj-customtype-01')!;
      vi.mocked(plantService.getPlant).mockResolvedValue(plantWithInjectedField('name', 'Bertha'));
      const tool = findTool('propose_reminder_task')!;
      // A >50-char custom label (the injection payload) must be rejected by the
      // re-validated length bound, mirroring what POST /tasks would reject.
      const longPayload = `${p.payload} ${'x'.repeat(60)}`;
      const out = (await tool.execute(
        {
          plantId: 'p-victim-1',
          type: 'custom',
          customType: longPayload,
          frequencyDays: 7,
        } as never,
        { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1, proposalsThisTurn: 0 }
      )) as ProposeReminderResult;
      expect(out.status).toBe('invalid');
    });

    it('a WELL-FORMED proposal built from an injection-named plant still redacts PII on the card path', async () => {
      // Sanity anti-test: the write gate accepting a legitimate proposal for a
      // plant whose NAME is an injection string must not, in doing so, echo any
      // household PII back to the model.
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(
        plantWithInjectedField('name', CORPUS.payloads[0].payload)
      );
      const tool = findTool('propose_reminder_task')!;
      const out = (await tool.execute(
        { plantId: 'p-victim-1', type: 'water', frequencyDays: 7 } as never,
        { userId: 'u-caller', householdId: VICTIM_HH, toolCallNumber: 1, proposalsThisTurn: 0 }
      )) as ProposeReminderResult;
      expect(out.status).toBe('proposed');
      assertNoPiiKeys(sanitizeToolResultForModel(out));
    });
  });
});
