import { describe, expect, it } from 'vitest';
import { computeCoverage } from '../../../src/services/coverageMath.js';
import type { CoverageInput } from '../../../src/services/coverageMath.js';

/**
 * Coverage is the bus-factor view — deliberately NOT a leaderboard. These
 * tests pin both halves of that: the arithmetic (who has ever cared for what,
 * what an absence leaves uncovered) and the shape rule (no per-member totals,
 * no ranking, nothing ordered by contribution).
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

const priya = { userId: 'u-priya', name: 'Priya' };
const sam = { userId: 'u-sam', name: 'Sam' };
const lee = { userId: 'u-lee', name: 'Lee' };

function input(overrides: Partial<CoverageInput> = {}): CoverageInput {
  return {
    members: [priya, sam],
    plants: [
      { id: 'p-monstera', name: 'Monstera' },
      { id: 'p-fern', name: 'Fern' },
      { id: 'p-aloe', name: 'Aloe' },
    ],
    completions: [],
    windows: [],
    now: NOW,
    ...overrides,
  };
}

describe('computeCoverage — caregiver sets', () => {
  it('records, per plant, the SET of current members who have ever cared for it', () => {
    const report = computeCoverage(
      input({
        completions: [
          // Priya has watered the Monstera nine times; Sam once. A set is a
          // set: both appear, and nothing records the nine.
          ...Array.from({ length: 9 }, () => ({ plantId: 'p-monstera', completedBy: 'u-priya' })),
          { plantId: 'p-monstera', completedBy: 'u-sam' },
          { plantId: 'p-fern', completedBy: 'u-priya' },
        ],
      })
    );

    const monstera = report.plants.find((p) => p.plantId === 'p-monstera')!;
    expect(monstera.caregivers).toEqual([priya, sam]);
    expect(monstera.caregiverCount).toBe(2);
    expect(monstera.soleCaregiver).toBeNull();

    const fern = report.plants.find((p) => p.plantId === 'p-fern')!;
    expect(fern.caregivers).toEqual([priya]);
    expect(fern.caregiverCount).toBe(1);
    expect(fern.soleCaregiver).toEqual(priya);

    const aloe = report.plants.find((p) => p.plantId === 'p-aloe')!;
    expect(aloe.caregivers).toEqual([]);
    expect(aloe.soleCaregiver).toBeNull();
  });

  it('lists the plants resting on one person, and counts the ones nobody has cared for', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: 'p-monstera', completedBy: 'u-priya' },
          { plantId: 'p-fern', completedBy: 'u-sam' },
        ],
      })
    );
    expect(report.soleCaregiverPlants.map((p) => p.plantId)).toEqual(['p-fern', 'p-monstera']);
    expect(report.uncaredPlantCount).toBe(1);
    expect(report.plantCount).toBe(3);
    expect(report.memberCount).toBe(2);
  });

  it('does not count a sitter or a former member as cover — they cannot step in', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: 'p-monstera', completedBy: 'u-priya' },
          { plantId: 'p-monstera', completedBy: 'sitter:link-1' },
          // u-lee is not a current member (left the household). The
          // completedBy snapshot survives, but Lee is not a backup.
          { plantId: 'p-monstera', completedBy: 'u-lee' },
        ],
      })
    );
    const monstera = report.plants.find((p) => p.plantId === 'p-monstera')!;
    expect(monstera.caregivers).toEqual([priya]);
    expect(monstera.soleCaregiver).toEqual(priya);
  });

  it('ignores completions on plants that are no longer active', () => {
    const report = computeCoverage(
      input({
        completions: [{ plantId: 'p-retired', completedBy: 'u-priya' }],
      })
    );
    expect(report.plants.map((p) => p.plantId)).not.toContain('p-retired');
    expect(report.soleCaregiverPlants).toEqual([]);
  });

  it('skips malformed completions rather than inventing a caregiver', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: '', completedBy: 'u-priya' },
          { plantId: 'p-monstera', completedBy: '' },
        ],
      })
    );
    expect(report.plants.every((p) => p.caregiverCount === 0)).toBe(true);
  });
});

describe('computeCoverage — away risks', () => {
  const window = {
    userId: 'u-priya',
    coveredBy: 'u-sam',
    coveredByName: 'Sam',
    startDate: '2026-09-10T00:00:00.000Z',
    endDate: '2026-09-17T23:59:59.999Z',
  };

  it('names the plants that would have nobody who knows them while a member is away', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: 'p-monstera', completedBy: 'u-priya' },
          { plantId: 'p-fern', completedBy: 'u-priya' },
          { plantId: 'p-fern', completedBy: 'u-sam' },
          { plantId: 'p-aloe', completedBy: 'u-priya' },
        ],
        windows: [window],
      })
    );
    expect(report.awayRisks).toHaveLength(1);
    const risk = report.awayRisks[0];
    expect(risk).toMatchObject({
      userId: 'u-priya',
      name: 'Priya',
      coveredBy: 'u-sam',
      coveredByName: 'Sam',
      active: false,
      uncoveredPlantCount: 2,
    });
    // By plant name — the Fern is covered (Sam has cared for it).
    expect(risk.uncoveredPlants).toEqual([
      { plantId: 'p-aloe', plantName: 'Aloe' },
      { plantId: 'p-monstera', plantName: 'Monstera' },
    ]);
  });

  it('reports a genuine zero when everything the away member knows is also known by someone else', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: 'p-monstera', completedBy: 'u-priya' },
          { plantId: 'p-monstera', completedBy: 'u-sam' },
        ],
        windows: [window],
      })
    );
    expect(report.awayRisks[0].uncoveredPlantCount).toBe(0);
    expect(report.awayRisks[0].uncoveredPlants).toEqual([]);
  });

  it('marks a window that is active right now, and drops one that has already ended', () => {
    const report = computeCoverage(
      input({
        windows: [
          { ...window, startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-05T00:00:00.000Z' },
          { ...window, userId: 'u-sam', coveredBy: 'u-priya', coveredByName: 'Priya' },
          {
            ...window,
            startDate: '2026-08-01T00:00:00.000Z',
            endDate: '2026-08-05T00:00:00.000Z',
          },
        ],
      })
    );
    expect(report.awayRisks.map((r) => [r.userId, r.active])).toEqual([
      ['u-priya', true],
      ['u-sam', false],
    ]);
  });

  it('falls back to the roster name when the window carries no cover name', () => {
    const report = computeCoverage(input({ windows: [{ ...window, coveredByName: null }] }));
    expect(report.awayRisks[0].coveredByName).toBe('Sam');
  });

  it('ignores a window for someone who is no longer a member', () => {
    const report = computeCoverage(input({ windows: [{ ...window, userId: 'u-lee' }] }));
    expect(report.awayRisks).toEqual([]);
  });
});

describe('computeCoverage — the not-a-leaderboard rule', () => {
  it('orders plants and caregivers by name, never by how much anyone has done', () => {
    const report = computeCoverage(
      input({
        members: [sam, priya, lee],
        completions: [
          // Sam did the most on every plant; Priya the least. Name order wins.
          ...Array.from({ length: 5 }, () => ({ plantId: 'p-aloe', completedBy: 'u-sam' })),
          { plantId: 'p-aloe', completedBy: 'u-priya' },
          { plantId: 'p-aloe', completedBy: 'u-lee' },
          ...Array.from({ length: 20 }, () => ({ plantId: 'p-monstera', completedBy: 'u-sam' })),
          { plantId: 'p-fern', completedBy: 'u-priya' },
        ],
      })
    );
    expect(report.members.map((m) => m.name)).toEqual(['Lee', 'Priya', 'Sam']);
    expect(report.plants.map((p) => p.plantName)).toEqual(['Aloe', 'Fern', 'Monstera']);
    expect(report.plants[0].caregivers.map((m) => m.name)).toEqual(['Lee', 'Priya', 'Sam']);
    expect(report.soleCaregiverPlants.map((p) => p.plantName)).toEqual(['Fern', 'Monstera']);
  });

  it('orders away risks by start date, never by how many plants are at risk', () => {
    const report = computeCoverage(
      input({
        completions: [
          { plantId: 'p-monstera', completedBy: 'u-priya' },
          { plantId: 'p-fern', completedBy: 'u-priya' },
          { plantId: 'p-aloe', completedBy: 'u-sam' },
        ],
        windows: [
          {
            userId: 'u-priya',
            coveredBy: 'u-sam',
            coveredByName: 'Sam',
            startDate: '2026-09-20T00:00:00.000Z',
            endDate: '2026-09-25T00:00:00.000Z',
          },
          {
            userId: 'u-sam',
            coveredBy: 'u-priya',
            coveredByName: 'Priya',
            startDate: '2026-09-10T00:00:00.000Z',
            endDate: '2026-09-12T00:00:00.000Z',
          },
        ],
      })
    );
    // Sam's window is sooner but smaller (1 plant vs Priya's 2) — sooner wins.
    expect(report.awayRisks.map((r) => [r.name, r.uncoveredPlantCount])).toEqual([
      ['Sam', 1],
      ['Priya', 2],
    ]);
  });

  it('carries no per-member totals anywhere in the report', () => {
    const report = computeCoverage(
      input({
        completions: Array.from({ length: 30 }, (_, i) => ({
          plantId: i % 2 ? 'p-monstera' : 'p-fern',
          completedBy: i % 3 ? 'u-priya' : 'u-sam',
        })),
      })
    );
    // A member is only ever {userId, name}: there is no field on which a
    // "who did more" number could ride.
    const members = [
      ...report.members,
      ...report.plants.flatMap((p) => p.caregivers),
      ...report.soleCaregiverPlants.flatMap((p) => (p.soleCaregiver ? [p.soleCaregiver] : [])),
    ];
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(Object.keys(m).sort()).toEqual(['name', 'userId']);
    }
    // And the only counts in the report count plants.
    expect(report.plantCount).toBe(3);
    expect(report.soleCaregiverPlants).toEqual([]);
    expect(report.uncaredPlantCount).toBe(1);
  });

  it('works for a household of one — every plant rests on them, by construction', () => {
    const report = computeCoverage(
      input({
        members: [priya],
        completions: [{ plantId: 'p-monstera', completedBy: 'u-priya' }],
      })
    );
    expect(report.memberCount).toBe(1);
    expect(report.soleCaregiverPlants.map((p) => p.plantId)).toEqual(['p-monstera']);
  });
});
