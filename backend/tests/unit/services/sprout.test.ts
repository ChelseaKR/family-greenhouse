import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');

import * as plantService from '../../../src/services/plantService.js';
import * as taskService from '../../../src/services/taskService.js';
import {
  __resetSproutSecretForTests,
  askSprout,
  buildSproutContext,
  redactSproutQuestion,
  signSproutBody,
  validatedSproutBaseUrl,
} from '../../../src/services/sprout.js';

describe('Sprout integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetSproutSecretForTests();
    process.env.SPROUT_API_URL = 'https://api.sprout.example';
    process.env.SPROUT_INTEGRATION_SECRET = 'test-secret';
    delete process.env.SPROUT_INTEGRATION_SECRET_ID;
  });

  it('sends only coarse species and relative task data', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      {
        id: 'p1',
        householdId: 'private-household',
        name: 'SENTINEL NICKNAME',
        species: 'Monstera deliciosa',
        canonicalSpecies: 'Monstera deliciosa',
        location: 'SENTINEL ADDRESS',
        imageUrl: 'https://private/photo.jpg',
        notes: 'SENTINEL NOTES',
        status: 'active',
        tags: [],
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'private-user',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    vi.mocked(taskService.getTasks).mockResolvedValueOnce([
      {
        id: 't1',
        householdId: 'private-household',
        plantId: 'p1',
        plantName: 'SENTINEL NICKNAME',
        type: 'water',
        customType: null,
        frequency: 7,
        lastCompleted: '2026-06-28T00:00:00Z',
        nextDue: '2026-07-10T00:00:00Z',
        assignedTo: 'private-user',
        assignedToName: 'SENTINEL PERSON',
        notes: 'SENTINEL TASK NOTES',
        createdBy: 'private-user',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ] as never);

    const context = await buildSproutContext('private-household', new Date('2026-07-12T00:00:00Z'));
    const serialized = JSON.stringify(context);
    expect(context).toEqual({
      sanitizedQuestion: undefined,
      plants: [{ species: 'Monstera deliciosa', light_profile: 'unknown' }],
      tasks: [
        {
          plant_species: 'Monstera deliciosa',
          task_type: 'water',
          due_in_days: -2,
          last_completed_days_ago: 14,
        },
      ],
      // #549: the payload now says how much of the household it is. Here the
      // household is fully represented, which is the only state in which a
      // bare count over this set is a true statement about the household.
      coverage: {
        plants: { total: 1, included: 1, unmatched: 0, truncated: 0, cap: 100, complete: true },
        tasks: { total: 1, included: 1, unmatched: 0, truncated: 0, cap: 100, complete: true },
        partial: false,
      },
    });
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).not.toContain('private-household');
    expect(serialized).not.toContain('private-user');
  });

  it('redacts plant nicknames and common contact identifiers from questions', () => {
    const result = redactSproutQuestion(
      'Is Bertha okay? Email me@example.com or call +1 (530) 555-0100.',
      [{ name: 'Bertha', canonicalSpecies: 'Monstera deliciosa' }]
    );
    expect(result).toContain('Monstera deliciosa');
    expect(result).toContain('[email redacted]');
    expect(result).toContain('[phone redacted]');
    expect(result).not.toContain('Bertha');
    expect(result).not.toContain('me@example.com');
    expect(result).not.toContain('555-0100');
  });

  it('never forwards user-controlled species text, even when it contains plausible PII', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      {
        id: 'p-private',
        name: 'Bertha',
        species: 'Chelsea R, 123 Private Street, +1 530 555 0100',
        canonicalSpecies: null,
      },
    ] as never);
    vi.mocked(taskService.getTasks).mockResolvedValueOnce([
      {
        id: 't-private',
        plantId: 'p-private',
        type: 'water',
        nextDue: '2026-07-12T00:00:00Z',
      },
    ] as never);

    const context = await buildSproutContext(
      'private-household',
      new Date('2026-07-12T00:00:00Z'),
      'Does Bertha need water?'
    );
    const serialized = JSON.stringify(context);
    expect(context.plants).toEqual([]);
    expect(context.tasks).toEqual([]);
    // #549: this is the case the issue is about. The household HAS a plant and
    // a task; both were dropped by the canonical-species privacy filter. An
    // empty array alone is indistinguishable from a household with no plants,
    // so the drop has to be reported as a fact rather than inferred from a
    // length. Counts only — the strings are still, correctly, not sent.
    expect(context.coverage.plants).toEqual({
      total: 1,
      included: 0,
      unmatched: 1,
      truncated: 0,
      cap: 100,
      complete: false,
    });
    expect(context.coverage.tasks).toEqual({
      total: 1,
      included: 0,
      unmatched: 1,
      truncated: 0,
      cap: 100,
      complete: false,
    });
    expect(context.coverage.partial).toBe(true);
    expect(context.sanitizedQuestion).toBe('Does this plant need water?');
    expect(serialized).not.toContain('Chelsea');
    expect(serialized).not.toContain('Private Street');
    expect(serialized).not.toContain('555');
  });

  it('allows only the approved HTTPS Sprout origin', () => {
    expect(validatedSproutBaseUrl('https://api.sprout.example/')).toBe(
      'https://api.sprout.example'
    );
    for (const value of [
      'http://api.sprout.chelseakr.com',
      'https://169.254.169.254/latest/meta-data',
      'https://api.sprout.chelseakr.com.attacker.example',
      'https://user:secret@api.sprout.chelseakr.com',
    ]) {
      expect(() => validatedSproutBaseUrl(value)).toThrow(/approved|HTTPS/);
    }
  });

  it('signs the request and rejects a response without the provenance contract', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([]);
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: {
            display_text: 'Grounded.',
            citations: [],
            disclosure: '',
            provenance: 'corpus',
          },
          household_observations: [],
          context_policy: 'household-data-selects-corpus-facts',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const result = await askSprout({ householdId: 'hh', question: 'pothos care' });
    expect(result.text).toBe('Grounded.');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Sprout-Signature']).toMatch(
      /^[a-f0-9]{64}$/
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ answer: { provenance: 'household' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(askSprout({ householdId: 'hh', question: 'pothos care' })).rejects.toThrow(
      'invalid provenance'
    );
  });

  it('rejects malformed answers and non-HTTPS citation links at the integration boundary', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([]);
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: {
            display_text: 'Click this.',
            citations: [
              {
                title: 'Unsafe source',
                url: 'javascript:alert(document.domain)',
                source: 'unsafe.md',
                fetch_date: '2026-07-25',
              },
            ],
            disclosure: '',
            provenance: 'corpus',
          },
          household_observations: [],
          context_policy: 'household-data-selects-corpus-facts',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(askSprout({ householdId: 'hh', question: 'pothos care' })).rejects.toThrow(
      'invalid provenance or response contract'
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: {
            citations: [],
            disclosure: '',
            provenance: 'corpus',
          },
          household_observations: [],
          context_policy: 'household-data-selects-corpus-facts',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(askSprout({ householdId: 'hh', question: 'pothos care' })).rejects.toThrow(
      'invalid provenance or response contract'
    );
  });

  /**
   * #549: `buildSproutContext` reduces the household twice — a privacy FILTER
   * (only a server-resolved canonical species may cross) and then a CAP — and
   * used to say so nowhere. Sprout answers over that payload and its reply
   * carries numbers about the user's own collection stamped
   * `provenance: 'household'`, so a subset was being rendered as a total, in
   * prose, by a language model. These tests pin the facts that make the
   * reduction visible. What Sprout should DO with them (hedge, state a
   * denominator, decline) is a product decision and is not settled here.
   */
  describe('household coverage is reported, not inferred (#549)', () => {
    function plant(id: string, canonicalSpecies: string | null) {
      return { id, name: `plant-${id}`, species: 'typed by the user', canonicalSpecies };
    }
    function task(id: string, plantId: string) {
      return { id, plantId, type: 'water', nextDue: '2026-07-12T00:00:00Z', lastCompleted: null };
    }

    it('reports the cap as truncation instead of applying it silently', async () => {
      // 150 matched plants and 150 matched tasks against a cap of 100.
      const plants = Array.from({ length: 150 }, (_, i) => plant(`p${i}`, 'Monstera deliciosa'));
      vi.mocked(plantService.getPlants).mockResolvedValueOnce(plants as never);
      vi.mocked(taskService.getTasks).mockResolvedValueOnce(
        plants.map((p, i) => task(`t${i}`, p.id)) as never
      );

      const context = await buildSproutContext('hh', new Date('2026-07-12T00:00:00Z'));

      expect(context.plants).toHaveLength(100);
      expect(context.tasks).toHaveLength(100);
      // The 50 that did not cross are reported as a number, not left to be
      // guessed from an array length that happens to equal the cap.
      expect(context.coverage.plants).toEqual({
        total: 150,
        included: 100,
        unmatched: 0,
        truncated: 50,
        cap: 100,
        complete: false,
      });
      expect(context.coverage.tasks.truncated).toBe(50);
      expect(context.coverage.partial).toBe(true);
    });

    it('counts the filter and the cap separately (they drop rows for different reasons)', async () => {
      // 120 matched + 30 unmatched. The cap then removes 20 of the matched.
      const matched = Array.from({ length: 120 }, (_, i) => plant(`m${i}`, 'Monstera deliciosa'));
      const unmatched = Array.from({ length: 30 }, (_, i) => plant(`u${i}`, null));
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([...matched, ...unmatched] as never);
      // One task per plant, so the same split lands on tasks.
      vi.mocked(taskService.getTasks).mockResolvedValueOnce(
        [...matched, ...unmatched].map((p, i) => task(`t${i}`, p.id)) as never
      );

      const context = await buildSproutContext('hh', new Date('2026-07-12T00:00:00Z'));

      expect(context.coverage.plants).toEqual({
        total: 150,
        included: 100,
        unmatched: 30,
        truncated: 20,
        cap: 100,
        complete: false,
      });
      expect(context.coverage.tasks).toEqual({
        total: 150,
        included: 100,
        unmatched: 30,
        truncated: 20,
        cap: 100,
        complete: false,
      });
      // `unmatched + truncated` is exactly what did not cross. Collapsing the
      // two into one "dropped" number would hide that one is a privacy control
      // and the other is a size limit.
      expect(context.coverage.plants.total - context.coverage.plants.included).toBe(50);
    });

    it('carries only integers across the boundary — no strings about what was dropped', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([
        plant('p1', null),
        plant('p2', 'Monstera deliciosa'),
      ] as never);
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([] as never);

      const context = await buildSproutContext('hh', new Date('2026-07-12T00:00:00Z'));

      // The boundary contract is unchanged: coverage says HOW MANY plants did
      // not cross, never anything about them.
      for (const value of Object.values(context.coverage.plants)) {
        expect(['number', 'boolean']).toContain(typeof value);
      }
      expect(JSON.stringify(context.coverage)).not.toContain('typed by the user');
      expect(JSON.stringify(context.coverage)).not.toContain('plant-');
    });

    it('sends the coverage counts to Sprout with the payload they describe', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValue([
        plant('p1', null),
        plant('p2', 'Monstera deliciosa'),
      ] as never);
      vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            answer: {
              display_text: 'Grounded.',
              citations: [],
              disclosure: '',
              provenance: 'corpus',
            },
            household_observations: [],
            context_policy: 'household-data-selects-corpus-facts',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await askSprout({ householdId: 'hh', question: 'anything toxic to my cat?' });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const sent = JSON.parse(init.body as string);
      // The answer is written on the far side, so the facts have to arrive
      // with the question rather than be attached to the reply afterwards.
      expect(sent.coverage.plants.total).toBe(2);
      expect(sent.coverage.plants.included).toBe(1);
      expect(sent.coverage.plants.unmatched).toBe(1);
      expect(sent.coverage.plants.complete).toBe(false);
      expect(sent.coverage.partial).toBe(true);
      expect(sent.plants).toHaveLength(1);
    });

    it('stamps each household observation with the coverage of the set it came from', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValue([
        plant('p1', null),
        plant('p2', null),
        plant('p3', 'Monstera deliciosa'),
      ] as never);
      vi.mocked(taskService.getTasks).mockResolvedValue([task('t1', 'p3')] as never);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            answer: {
              display_text: 'You have 1 plant toxic to cats.',
              citations: [],
              disclosure: '',
              provenance: 'corpus',
            },
            household_observations: [
              { kind: 'collection', value: { toxic_to_cats: 1 }, provenance: 'household' },
              { kind: 'tasks', value: { overdue: 1 }, provenance: 'household' },
            ],
            context_policy: 'household-data-selects-corpus-facts',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await askSprout({ householdId: 'hh', question: 'anything toxic to my cat?' });

      // "1 plant toxic to cats" is a claim about a set of ONE, out of three.
      // The number is still passed through — what changes is that a consumer
      // can no longer read it as a household total without being told.
      const collection = result.observations.find((o) => o.kind === 'collection');
      expect(collection?.provenance).toBe('household');
      expect(collection?.coverage).toEqual({
        total: 3,
        included: 1,
        unmatched: 2,
        truncated: 0,
        cap: 100,
        complete: false,
      });
      // 'tasks' observations are qualified by the tasks set, not the plants one.
      const tasks = result.observations.find((o) => o.kind === 'tasks');
      expect(tasks?.coverage.total).toBe(1);
      expect(tasks?.coverage.complete).toBe(true);
      // And the result as a whole carries it, because the PROSE is derived
      // from the same reduced set even when no observation is returned.
      expect(result.coverage.partial).toBe(true);
    });

    it('takes coverage from our own count, never from Sprout\u2019s reply', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValue([
        plant('p1', null),
        plant('p2', 'Monstera deliciosa'),
      ] as never);
      vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            answer: {
              display_text: 'All of your plants are fine.',
              citations: [],
              disclosure: '',
              provenance: 'corpus',
            },
            household_observations: [
              {
                kind: 'collection',
                value: { toxic_to_cats: 0 },
                provenance: 'household',
                // Sprout claiming full coverage must not become full coverage.
                coverage: {
                  total: 2,
                  included: 2,
                  unmatched: 0,
                  truncated: 0,
                  cap: 100,
                  complete: true,
                },
              },
            ],
            context_policy: 'household-data-selects-corpus-facts',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await askSprout({ householdId: 'hh', question: 'anything toxic to my cat?' });

      expect(result.observations[0].coverage.complete).toBe(false);
      expect(result.observations[0].coverage.included).toBe(1);
      expect(result.observations[0].coverage.unmatched).toBe(1);
    });

    it('reports a household with nothing in it as complete, not as partial', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([] as never);
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([] as never);

      const context = await buildSproutContext('hh', new Date('2026-07-12T00:00:00Z'));

      // "you have no plants" IS a true statement about an empty household, and
      // must stay distinguishable from "every plant you have was filtered out".
      expect(context.coverage.plants.complete).toBe(true);
      expect(context.coverage.partial).toBe(false);
    });
  });

  it('produces a stable SHA-256 HMAC', () => {
    expect(signSproutBody('secret', '123', '{}')).toMatch(/^[a-f0-9]{64}$/);
  });
});
