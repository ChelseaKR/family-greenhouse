/**
 * Away Kit return recap: link selection, window bounding, folding of
 * sitter-attributed events, and the paged partition read that never turns a
 * failed or truncated scan into "nothing happened".
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ActivityEvent } from '../../../src/services/activity.js';
import type { SitterLink } from '../../../src/services/sitterService.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const NOW = new Date('2026-09-03T12:00:00.000Z');

function link(overrides: Partial<SitterLink> = {}): SitterLink {
  return {
    id: 'link-1',
    token: 'a'.repeat(64),
    householdId: 'hh-1',
    createdBy: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    startsAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    status: 'active',
    label: 'Our plants',
    ...overrides,
  };
}

function completed(
  overrides: Partial<ActivityEvent> & { payload?: Record<string, unknown> } = {}
): ActivityEvent {
  return {
    id: overrides.id ?? 'e1',
    type: 'task.completed',
    householdId: 'hh-1',
    actorId: 'sitter:link-1',
    actorName: 'a plant sitter',
    occurredAt: overrides.occurredAt ?? '2026-08-12T09:00:00.000Z',
    payload: {
      taskId: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      taskType: 'water',
      viaSitter: true,
      ...(overrides.payload ?? {}),
    },
  } as ActivityEvent;
}

describe('pickRecapLink', () => {
  it('returns the explicitly requested link in any state, or null when it is not there', async () => {
    const { pickRecapLink } = await import('../../../src/services/awayRecapService.js');
    const live = link({ id: 'live', expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(pickRecapLink([live], 'live', NOW)).toBe(live);
    expect(pickRecapLink([live], 'other', NOW)).toBeNull();
  });

  it('defaults to the most recently ENDED link and ignores windows still open', async () => {
    const { pickRecapLink } = await import('../../../src/services/awayRecapService.js');
    const older = link({ id: 'older', expiresAt: '2026-07-01T00:00:00.000Z' });
    const newer = link({ id: 'newer', expiresAt: '2026-08-24T00:00:00.000Z' });
    const live = link({ id: 'live', expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(pickRecapLink([older, live, newer], undefined, NOW)?.id).toBe('newer');
    // Nothing ended yet → null, so the handler can answer an explicit 404.
    expect(pickRecapLink([live], undefined, NOW)).toBeNull();
    expect(pickRecapLink([], undefined, NOW)).toBeNull();
  });

  it('counts a revoked link as ended now (not at its future expiry)', async () => {
    const { pickRecapLink } = await import('../../../src/services/awayRecapService.js');
    const revoked = link({
      id: 'revoked',
      status: 'revoked',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    const expired = link({ id: 'expired', expiresAt: '2026-08-24T00:00:00.000Z' });
    expect(pickRecapLink([expired, revoked], undefined, NOW)?.id).toBe('revoked');
  });
});

describe('recapWindow / linkHasEnded', () => {
  it('bounds the window at now for a link that is still open', async () => {
    const { recapWindow, linkHasEnded } = await import('../../../src/services/awayRecapService.js');
    const live = link({ expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(recapWindow(live, NOW)).toEqual({
      from: '2026-08-10T00:00:00.000Z',
      to: NOW.toISOString(),
    });
    expect(linkHasEnded(live, NOW)).toBe(false);
    expect(recapWindow(link(), NOW).to).toBe('2026-08-24T00:00:00.000Z');
    expect(linkHasEnded(link(), NOW)).toBe(true);
    expect(linkHasEnded(live, NOW)).toBe(false);
    expect(linkHasEnded({ ...live, status: 'revoked' }, NOW)).toBe(true);
  });
});

describe('dedupeCompletions', () => {
  it('keeps the typed viaSitter event and drops its folded TaskCompletion twin', async () => {
    const { dedupeCompletions } = await import('../../../src/services/awayRecapService.js');
    const typed = completed({ id: 'typed', occurredAt: '2026-08-12T09:00:00.500Z' });
    const twin = completed({
      id: 'twin',
      occurredAt: '2026-08-12T09:00:00.000Z',
      payload: { viaSitter: undefined, notes: null },
    });
    // A completion with no typed twin (event write lost) survives.
    const orphan = completed({
      id: 'orphan',
      occurredAt: '2026-08-13T09:00:00.000Z',
      payload: { taskId: 't2', viaSitter: undefined },
    });
    const kept = dedupeCompletions([twin, typed, orphan]).map((e) => e.id);
    expect(kept).toEqual(['typed', 'orphan']);
  });
});

describe('buildAwayRecap', () => {
  it('folds sitter events into tasks, photos and notes, oldest first, with counts', async () => {
    const { buildAwayRecap } = await import('../../../src/services/awayRecapService.js');
    const photo: ActivityEvent = {
      id: 'ph',
      type: 'photo.uploaded',
      householdId: 'hh-1',
      actorId: 'sitter:link-1',
      actorName: 'a plant sitter',
      occurredAt: '2026-08-11T08:00:00.000Z',
      payload: {
        plantId: 'p1',
        photoId: 'photo-1',
        plantName: 'Monstera',
        imageUrl: 'https://assets.example/plants/hh-1/p1/x.jpg',
        caption: '  Leaves perked up  ',
        viaSitter: true,
        sitterLinkId: 'link-1',
      },
    };
    const withNote = completed({
      id: 'n',
      occurredAt: '2026-08-14T09:00:00.000Z',
      payload: { taskId: 't3', notes: 'Soil was bone dry' },
    });
    const recap = buildAwayRecap(link(), [withNote, completed(), photo], false, NOW);

    expect(recap.link).toEqual({
      id: 'link-1',
      label: 'Our plants',
      startsAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-24T00:00:00.000Z',
      status: 'active',
      ended: true,
    });
    expect(recap.window).toEqual({
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-24T00:00:00.000Z',
    });
    expect(recap.tasksCompleted.map((t) => t.taskId)).toEqual(['t1', 't3']);
    expect(recap.tasksCompleted[0]).toMatchObject({
      plantName: 'Monstera',
      taskType: 'water',
      actorName: 'a plant sitter',
      notes: null,
    });
    expect(recap.photos).toEqual([
      {
        photoId: 'photo-1',
        plantId: 'p1',
        plantName: 'Monstera',
        imageUrl: 'https://assets.example/plants/hh-1/p1/x.jpg',
        caption: 'Leaves perked up',
        occurredAt: '2026-08-11T08:00:00.000Z',
      },
    ]);
    expect(recap.notes.map((n) => [n.source, n.text])).toEqual([
      ['photo', 'Leaves perked up'],
      ['task', 'Soil was bone dry'],
    ]);
    expect(recap.counts).toEqual({ tasks: 2, photos: 1, notes: 2 });
    expect(recap.truncated).toBe(false);
    expect(recap.generatedAt).toBe(NOW.toISOString());
  });

  it('carries the truncated flag through and tolerates legacy photo rows without a URL', async () => {
    const { buildAwayRecap } = await import('../../../src/services/awayRecapService.js');
    const legacyPhoto: ActivityEvent = {
      id: 'ph',
      type: 'photo.uploaded',
      householdId: 'hh-1',
      actorId: 'sitter:link-1',
      actorName: 'a plant sitter',
      occurredAt: '2026-08-11T08:00:00.000Z',
      payload: { plantId: 'p1', photoId: 'photo-1' },
    };
    const recap = buildAwayRecap(link(), [legacyPhoto], true, NOW);
    expect(recap.truncated).toBe(true);
    expect(recap.photos[0]).toMatchObject({ imageUrl: null, plantName: null, caption: null });
    expect(recap.notes).toEqual([]);
  });
});

describe('listSitterWindowActivity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries the window with BETWEEN, pages to the end, and keeps only the link’s actor', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { listSitterWindowActivity } = await import('../../../src/services/awayRecapService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          {
            entityType: 'ActivityEvent',
            id: 'e1',
            type: 'task.completed',
            householdId: 'hh-1',
            actorId: 'sitter:link-1',
            actorName: 'a plant sitter',
            occurredAt: '2026-08-12T09:00:00.000Z',
            payload: { taskId: 't1', plantId: 'p1', taskType: 'water', viaSitter: true },
          },
          {
            // A member's own completion inside the window is NOT the sitter's.
            entityType: 'TaskCompletion',
            id: 'c9',
            householdId: 'hh-1',
            completedBy: 'user-2',
            completedByName: 'Bob',
            completedAt: '2026-08-12T10:00:00.000Z',
            taskId: 't9',
            plantId: 'p9',
            taskType: 'water',
          },
        ],
        LastEvaluatedKey: { PK: 'x' },
      } as never)
      .mockResolvedValueOnce({
        Items: [
          {
            entityType: 'TaskCompletion',
            id: 'c2',
            householdId: 'hh-1',
            completedBy: 'sitter:link-1',
            completedByName: 'a plant sitter',
            completedAt: '2026-08-13T09:00:00.000Z',
            taskId: 't2',
            plantId: 'p2',
            taskType: 'fertilize',
          },
        ],
      } as never);

    const { events, truncated } = await listSitterWindowActivity('hh-1', link(), NOW);

    expect(truncated).toBe(false);
    expect(events.map((e) => e.id)).toEqual(['e1', 'c2']);
    expect(events[1]).toMatchObject({ type: 'task.completed', actorId: 'sitter:link-1' });
    expect(dynamodb.send).toHaveBeenCalledTimes(2);
    const first = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: Record<string, unknown>;
    };
    expect(first.input.KeyConditionExpression).toBe(
      'GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to'
    );
    expect(first.input.ExpressionAttributeValues).toEqual({
      ':pk': 'HOUSEHOLD#hh-1#ACTIVITY',
      ':from': '2026-08-10T00:00:00.000Z',
      ':to': '2026-08-24T00:00:00.000Z',
    });
    const second = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: Record<string, unknown>;
    };
    expect(second.input.ExclusiveStartKey).toEqual({ PK: 'x' });
  });

  it('stops at the scan cap and says so instead of silently ending the story', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { listSitterWindowActivity, AWAY_RECAP_MAX_SCANNED } =
      await import('../../../src/services/awayRecapService.js');
    const page = Array.from({ length: 200 }, (_, i) => ({
      entityType: 'ActivityEvent',
      id: `e${i}`,
      type: 'plant.created',
      householdId: 'hh-1',
      actorId: 'user-1',
      actorName: 'Alice',
      occurredAt: '2026-08-12T09:00:00.000Z',
      payload: { plantId: 'p', plantName: 'x' },
    }));
    vi.mocked(dynamodb.send).mockResolvedValue({
      Items: page,
      LastEvaluatedKey: { PK: 'k' },
    } as never);

    const { events, truncated } = await listSitterWindowActivity('hh-1', link(), NOW);

    expect(truncated).toBe(true);
    expect(events).toEqual([]);
    expect(dynamodb.send).toHaveBeenCalledTimes(AWAY_RECAP_MAX_SCANNED / 200);
  });

  it('propagates a read failure — a failed read is never an empty recap', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { listSitterWindowActivity } = await import('../../../src/services/awayRecapService.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    await expect(listSitterWindowActivity('hh-1', link(), NOW)).rejects.toThrow(
      'ProvisionedThroughputExceeded'
    );
  });
});
