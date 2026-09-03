import { describe, expect, it } from 'vitest';
import {
  FROST_TENDER_MIN_ZONE,
  MOVE_TASK_LABEL_MAX,
  assignRoundRobin,
  isFrostTender,
  isMoveDayApplicable,
  moveTaskLabel,
  planMoves,
  seasonalHome,
} from '../../../src/services/moveDayPlan.js';

const patio = { id: 'patio', name: 'Patio', environment: 'outside' as const };
const living = { id: 'living', name: 'Living room', environment: 'inside' as const };
const kitchen = { id: 'kitchen', name: 'Kitchen', environment: 'inside' as const };
const spaces = [patio, living, kitchen];

function plant(over: {
  id: string;
  name: string;
  spaceId?: string | null;
  summerSpaceId?: string | null;
  winterSpaceId?: string | null;
}) {
  return {
    spaceId: null,
    summerSpaceId: null,
    winterSpaceId: null,
    ...over,
  };
}

describe('seasonalHome', () => {
  it('returns the winter or summer home, and null when none is set', () => {
    const p = plant({ id: 'a', name: 'A', summerSpaceId: 'patio', winterSpaceId: 'living' });
    expect(seasonalHome(p, 'winter')).toBe('living');
    expect(seasonalHome(p, 'summer')).toBe('patio');
    expect(seasonalHome(plant({ id: 'b', name: 'B' }), 'winter')).toBeNull();
  });
});

describe('isMoveDayApplicable', () => {
  it('is silent for a household with no outdoor space', () => {
    const p = plant({ id: 'a', name: 'A', winterSpaceId: 'living' });
    expect(isMoveDayApplicable([p], [living, kitchen])).toBe(false);
  });

  it('is silent when no plant has a seasonal home', () => {
    expect(isMoveDayApplicable([plant({ id: 'a', name: 'A', spaceId: 'patio' })], spaces)).toBe(
      false
    );
  });

  it('ignores seasonal homes that point at a deleted space', () => {
    const p = plant({ id: 'a', name: 'A', winterSpaceId: 'gone' });
    expect(isMoveDayApplicable([p], spaces)).toBe(false);
  });

  it('applies when there is an outdoor space and a live seasonal home', () => {
    const p = plant({ id: 'a', name: 'A', summerSpaceId: 'patio' });
    expect(isMoveDayApplicable([p], spaces)).toBe(true);
  });
});

describe('planMoves', () => {
  const monstera = plant({
    id: 'm',
    name: 'Monstera',
    spaceId: 'patio',
    summerSpaceId: 'patio',
    winterSpaceId: 'living',
  });
  const fern = plant({ id: 'f', name: 'Fern', spaceId: 'living', winterSpaceId: 'living' });
  const basil = plant({ id: 'b', name: 'Basil', spaceId: 'patio', winterSpaceId: 'kitchen' });
  const cactus = plant({ id: 'c', name: 'Cactus', spaceId: 'patio' });
  const orphan = plant({ id: 'o', name: 'Orphan', spaceId: 'patio', winterSpaceId: 'gone' });
  const homeless = plant({ id: 'h', name: 'Homeless', spaceId: null, winterSpaceId: 'living' });

  it('lists plants whose current space is not their winter home, sorted by name', () => {
    const items = planMoves([monstera, fern, basil, cactus, orphan], spaces, 'winter');
    expect(items.map((i) => i.plantName)).toEqual(['Basil', 'Monstera']);
    expect(items[1]).toMatchObject({
      plantId: 'm',
      fromSpaceId: 'patio',
      fromSpaceName: 'Patio',
      toSpaceId: 'living',
      toSpaceName: 'Living room',
      assigneeId: null,
      assigneeName: null,
      taskId: null,
    });
  });

  it('skips plants already in place, without a home, or whose home was deleted', () => {
    expect(planMoves([fern, cactus, orphan], spaces, 'winter')).toEqual([]);
  });

  it('includes a plant with no current space, with a null origin', () => {
    const [item] = planMoves([homeless], spaces, 'winter');
    expect(item).toMatchObject({ fromSpaceId: null, fromSpaceName: null, toSpaceId: 'living' });
  });

  it('plans the reverse trip for summer', () => {
    const inside = plant({ ...monstera, spaceId: 'living' });
    expect(planMoves([inside, basil], spaces, 'summer')).toMatchObject([
      { plantId: 'm', fromSpaceId: 'living', toSpaceId: 'patio' },
    ]);
  });
});

describe('assignRoundRobin', () => {
  it('splits moves across members in order, wrapping around', () => {
    const items = planMoves(
      [
        plant({ id: '1', name: 'A', spaceId: 'patio', winterSpaceId: 'living' }),
        plant({ id: '2', name: 'B', spaceId: 'patio', winterSpaceId: 'living' }),
        plant({ id: '3', name: 'C', spaceId: 'patio', winterSpaceId: 'living' }),
      ],
      spaces,
      'winter'
    );
    assignRoundRobin(items, [
      { userId: 'u-a', name: 'Ada' },
      { userId: 'u-b', name: 'Ben' },
    ]);
    expect(items.map((i) => [i.assigneeId, i.assigneeName])).toEqual([
      ['u-a', 'Ada'],
      ['u-b', 'Ben'],
      ['u-a', 'Ada'],
    ]);
  });

  it('leaves everything up for grabs when nobody is available', () => {
    const items = planMoves(
      [plant({ id: '1', name: 'A', spaceId: 'patio', winterSpaceId: 'living' })],
      spaces,
      'winter'
    );
    assignRoundRobin(items, []);
    expect(items[0]).toMatchObject({ assigneeId: null, assigneeName: null });
  });
});

describe('moveTaskLabel', () => {
  it('is the destination behind an arrow — no English verb to translate', () => {
    expect(moveTaskLabel('Living room')).toBe('→ Living room');
    expect(moveTaskLabel('  Patio ')).toBe('→ Patio');
  });

  it('never exceeds the customType schema cap', () => {
    const label = moveTaskLabel('x'.repeat(80));
    expect(label).toHaveLength(MOVE_TASK_LABEL_MAX);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('isFrostTender', () => {
  it(`flags a species whose range starts at zone ${FROST_TENDER_MIN_ZONE} or above`, () => {
    expect(isFrostTender('10-12')).toBe(true);
    expect(isFrostTender('11-13')).toBe(true);
    expect(isFrostTender('10')).toBe(true);
  });

  it('does not flag a species that tolerates a light frost', () => {
    expect(isFrostTender('9-11')).toBe(false);
    expect(isFrostTender('4-8')).toBe(false);
  });

  it('treats missing or unparseable data as not-known, never as at-risk', () => {
    expect(isFrostTender(null)).toBe(false);
    expect(isFrostTender(undefined)).toBe(false);
    expect(isFrostTender('')).toBe(false);
    expect(isFrostTender('zone ten')).toBe(false);
  });
});
