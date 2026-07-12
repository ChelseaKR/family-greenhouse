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
    });
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).not.toContain('private-household');
    expect(serialized).not.toContain('private-user');
  });

  it('redacts plant nicknames and common contact identifiers from questions', () => {
    const result = redactSproutQuestion(
      'Is Bertha okay? Email me@example.com or call +1 (530) 555-0100.',
      [{ name: 'Bertha', species: 'Monstera deliciosa' }]
    );
    expect(result).toContain('Monstera deliciosa');
    expect(result).toContain('[email redacted]');
    expect(result).toContain('[phone redacted]');
    expect(result).not.toContain('Bertha');
    expect(result).not.toContain('me@example.com');
    expect(result).not.toContain('555-0100');
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

  it('produces a stable SHA-256 HMAC', () => {
    expect(signSproutBody('secret', '123', '{}')).toMatch(/^[a-f0-9]{64}$/);
  });
});
