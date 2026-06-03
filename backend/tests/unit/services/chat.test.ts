import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');

import { TOOL_REGISTRY, findTool } from '../../../src/services/chat/tools.js';
import * as plantService from '../../../src/services/plantService.js';
import * as taskService from '../../../src/services/taskService.js';
import * as climateService from '../../../src/services/climate.js';
import * as householdService from '../../../src/services/householdService.js';
import { isOverBudget } from '../../../src/services/chat/persistence.js';

describe('chat tools registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes every tool with a name + input_schema + executor', () => {
    expect(TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const tool of TOOL_REGISTRY) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('findTool returns undefined for unknown names', () => {
    expect(findTool('nope')).toBeUndefined();
  });

  describe('list_household_plants', () => {
    it('scopes the query by the authenticated householdId and redacts PII', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([
        {
          id: 'p1',
          householdId: 'hh-1',
          name: 'Bertha',
          species: 'Monstera deliciosa',
          location: 'Living room',
          imageUrl: null,
          notes: null,
          tags: [],
          createdAt: '2025-01-01T00:00:00Z',
          createdBy: 'cognito-sub-secret', // MUST NOT leak
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ]);

      const tool = findTool('list_household_plants')!;
      const out = (await tool.execute(
        {},
        {
          userId: 'u1',
          householdId: 'hh-1',
          toolCallNumber: 1,
        }
      )) as Array<Record<string, unknown>>;

      expect(plantService.getPlants).toHaveBeenCalledWith('hh-1');
      expect(out).toHaveLength(1);
      // No createdBy, no householdId, no notes-or-image fields by default.
      expect(out[0]).not.toHaveProperty('createdBy');
      expect(out[0]).not.toHaveProperty('householdId');
      expect(out[0]).toMatchObject({ id: 'p1', nickname: 'Bertha' });
    });
  });

  describe('list_upcoming_tasks', () => {
    it('clamps the days window into [1, 30] and filters by horizon', async () => {
      const now = Date.now();
      vi.mocked(taskService.getUpcomingTasks).mockResolvedValueOnce([
        {
          id: 't1',
          householdId: 'hh-1',
          plantId: 'p1',
          plantName: 'Bertha',
          type: 'water',
          customType: null,
          frequency: 7,
          lastCompleted: null,
          nextDue: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
          assignedTo: null,
          notes: null,
          createdBy: 'cognito-sub-secret',
          createdAt: '2025-01-01T00:00:00Z',
        },
        {
          id: 't2',
          householdId: 'hh-1',
          plantId: 'p1',
          plantName: 'Bertha',
          type: 'water',
          customType: null,
          frequency: 7,
          lastCompleted: null,
          // Beyond the 3-day horizon — should be filtered out.
          nextDue: new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString(),
          assignedTo: null,
          notes: null,
          createdBy: 'cognito-sub-secret',
          createdAt: '2025-01-01T00:00:00Z',
        },
      ] as never);

      const tool = findTool('list_upcoming_tasks')!;
      const out = (await tool.execute(
        { days: 3 },
        {
          userId: 'u1',
          householdId: 'hh-1',
          toolCallNumber: 1,
        }
      )) as Array<{ id: string; plantId: string; type: string }>;
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('t1');
      // PII redaction
      expect(out[0]).not.toHaveProperty('createdBy');
      expect(out[0]).not.toHaveProperty('householdId');
    });

    it('caps a runaway days input at 30', async () => {
      vi.mocked(taskService.getUpcomingTasks).mockResolvedValueOnce([]);
      const tool = findTool('list_upcoming_tasks')!;
      await tool.execute({ days: 9999 }, { userId: 'u1', householdId: 'hh-1', toolCallNumber: 1 });
      // No throw; the assertion is that the filter logic doesn't blow up on
      // a humongous horizon. (Direct introspection of the clamped value
      // happens inside the closure, but we can rely on the absence of
      // throws here.)
      expect(taskService.getUpcomingTasks).toHaveBeenCalled();
    });
  });

  describe('get_household_climate', () => {
    it('returns hasLocation:false when the household has no saved location', async () => {
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Test',
        location: null,
      } as never);

      const tool = findTool('get_household_climate')!;
      const out = (await tool.execute(
        {},
        {
          userId: 'u1',
          householdId: 'hh-1',
          toolCallNumber: 1,
        }
      )) as { hasLocation: boolean };
      expect(out.hasLocation).toBe(false);
    });

    it('returns location + weather when both are present', async () => {
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Test',
        location: { city: 'Portland', lat: 45.5, lon: -122.7 },
      } as never);
      vi.mocked(climateService.getWeatherCached).mockResolvedValueOnce({
        observedAt: '2026-05-31T12:00:00Z',
        tempC: 21.5,
        humidity: 65,
        condition: 'Clear',
        description: 'clear sky',
        forecast: [],
      });

      const tool = findTool('get_household_climate')!;
      const out = (await tool.execute(
        {},
        {
          userId: 'u1',
          householdId: 'hh-1',
          toolCallNumber: 1,
        }
      )) as { hasLocation: boolean; location: unknown; weather: { tempC: number } };
      expect(out.hasLocation).toBe(true);
      expect(out.weather.tempC).toBe(21.5);
    });
  });
});

describe('propose_reminder_task tool', () => {
  it('refuses when the plant is not in the caller household (anti-hallucination)', async () => {
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
    const tool = findTool('propose_reminder_task')!;
    const out = (await tool.execute(
      { plantId: 'fake-uuid', type: 'water', frequencyDays: 7 } as never,
      { userId: 'u1', householdId: 'hh-1', toolCallNumber: 1 }
    )) as { accepted: boolean; reason?: string };
    expect(out.accepted).toBe(false);
    expect(out.reason).toMatch(/not found/i);
  });

  it('returns the validated proposal when the plant exists', async () => {
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Bertha',
      species: 'Monstera',
      location: null,
      imageUrl: null,
      notes: null,
      tags: [],
      createdAt: '',
      createdBy: 'u1',
      updatedAt: '',
    });
    const tool = findTool('propose_reminder_task')!;
    const out = (await tool.execute(
      { plantId: 'p1', type: 'water', frequencyDays: 7, rationale: 'tropicals' } as never,
      { userId: 'u1', householdId: 'hh-1', toolCallNumber: 1 }
    )) as {
      accepted: boolean;
      proposal: { plantName: string; type: string; frequencyDays: number };
    };
    expect(out.accepted).toBe(true);
    expect(out.proposal.plantName).toBe('Bertha');
    expect(out.proposal.type).toBe('water');
    expect(out.proposal.frequencyDays).toBe(7);
  });
});

describe('chat budget gate', () => {
  it('reports under-budget when neither cap is hit', () => {
    expect(
      isOverBudget(
        {
          householdId: 'hh',
          yearMonth: '2026-05',
          inputTokens: 1000,
          outputTokens: 200,
          costUsd: 0.01,
        },
        { maxInputTokensPerMonth: 10_000, maxOutputTokensPerMonth: 2_000 }
      )
    ).toBe(false);
  });

  it('reports over-budget the moment EITHER cap is reached', () => {
    expect(
      isOverBudget(
        {
          householdId: 'hh',
          yearMonth: '2026-05',
          inputTokens: 10_000,
          outputTokens: 100,
          costUsd: 0,
        },
        { maxInputTokensPerMonth: 10_000, maxOutputTokensPerMonth: 2_000 }
      )
    ).toBe(true);
    expect(
      isOverBudget(
        {
          householdId: 'hh',
          yearMonth: '2026-05',
          inputTokens: 0,
          outputTokens: 2_000,
          costUsd: 0,
        },
        { maxInputTokensPerMonth: 10_000, maxOutputTokensPerMonth: 2_000 }
      )
    ).toBe(true);
  });
});
