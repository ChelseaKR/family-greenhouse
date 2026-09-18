/**
 * The pure half of restoring a household from its own export (#669):
 * validation, household selection, the digest, and the restore plan. The
 * round trip through the real handlers lives in
 * tests/integration/archive-import.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_VERSION,
  ArchiveRejectedError,
  assertSafeJson,
  importTargetState,
  perenualIdsIn,
  planArchiveImport,
  readArchive,
  restoredId,
  type ArchiveImportContext,
} from '../../../src/models/householdArchive.js';

const createdAt = '2026-01-01T00:00:00.000Z';

function household(id: string, plants: unknown[] = [], tasks: unknown[] = []) {
  return { id, name: `Home ${id}`, role: 'admin', joinedAt: createdAt, plants, tasks };
}

function archive(households: unknown[], extra: Record<string, unknown> = {}) {
  return {
    format: 'family-greenhouse-export',
    version: ARCHIVE_VERSION,
    exportedAt: '2026-09-01T00:00:00.000Z',
    user: { id: 'u', email: 'someone@example.invalid', name: 'Someone' },
    notificationPreferences: {},
    households,
    ...extra,
  };
}

function rejection(fn: () => unknown): ArchiveRejectedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ArchiveRejectedError) return err;
    throw err;
  }
  throw new Error('expected an ArchiveRejectedError');
}

const ctx = (overrides: Partial<ArchiveImportContext> = {}): ArchiveImportContext => ({
  targetHouseholdId: 'target',
  importerUserId: 'importer',
  members: new Map([['importer', 'Ada']]),
  canonicalSpecies: new Map(),
  ...overrides,
});

describe('readArchive', () => {
  it('refuses anything that is not an export object', () => {
    expect(rejection(() => readArchive(null)).code).toBe('not_an_archive');
    expect(rejection(() => readArchive([archive([household('h')])])).code).toBe('not_an_archive');
    expect(rejection(() => readArchive('{"format":"family-greenhouse-export"}')).code).toBe(
      'not_an_archive'
    );
  });

  it('names an older version it cannot read, and a missing one', () => {
    const older = rejection(() => readArchive({ ...archive([household('h')]), version: 0 }));
    expect(older.code).toBe('unsupported_version');
    const missing = rejection(() => {
      const doc: Record<string, unknown> = archive([household('h')]);
      delete doc.version;
      return readArchive(doc);
    });
    expect(missing.code).toBe('unsupported_version');
    expect(missing.details).toEqual({ version: null, supported: ARCHIVE_VERSION });
    const fractional = rejection(() => readArchive({ ...archive([household('h')]), version: 1.5 }));
    expect(fractional.code).toBe('unsupported_version');
  });

  it('asks which household when the export holds several, and finds the one named', () => {
    const doc = archive([household('a'), household('b')]);
    const ask = rejection(() => readArchive(doc));
    expect(ask.code).toBe('household_required');
    expect(ask.details).toEqual({ households: 2 });
    expect(readArchive(doc, 'b').household.id).toBe('b');
    expect(rejection(() => readArchive(doc, 'c')).code).toBe('household_not_found');
  });

  it('points at the first invalid field', () => {
    const bad = rejection(() =>
      readArchive(archive([household('h', [{ id: 'p', name: '', createdAt }])]))
    );
    expect(bad.code).toBe('invalid_content');
    expect(bad.details.path).toBe('households.0.plants.0.name');
    const task = rejection(() =>
      readArchive(
        archive([
          household(
            'h',
            [{ id: 'p', name: 'Fern', createdAt }],
            [{ id: 't', plantId: 'p', type: 'water', frequency: 0, nextDue: createdAt, createdAt }]
          ),
        ])
      )
    );
    expect(task.details.path).toBe('households.0.tasks.0.frequency');
    expect(rejection(() => readArchive(archive([]))).code).toBe('invalid_content');
    expect(rejection(() => readArchive(archive([{ id: '../etc', name: 'x' }]))).code).toBe(
      'invalid_content'
    );
  });

  it('refuses an id listed twice', () => {
    const plant = { id: 'p', name: 'Fern', createdAt };
    expect(rejection(() => readArchive(archive([household('h', [plant, plant])]))).code).toBe(
      'duplicate_id'
    );
    const task = {
      id: 't',
      plantId: 'p',
      type: 'water',
      frequency: 7,
      nextDue: createdAt,
      createdAt,
    };
    expect(
      rejection(() => readArchive(archive([household('h', [plant], [task, task])]))).code
    ).toBe('duplicate_id');
  });

  it('digests only what it restores: the profile and other households do not move it', () => {
    const plant = { id: 'p', name: 'Fern', createdAt };
    const a = readArchive(archive([household('h', [plant]), household('x')]), 'h');
    const b = readArchive(
      archive([household('h', [{ ...plant, smuggled: 'token' }])], {
        user: { id: 'other', email: 'other@example.invalid', name: 'Other' },
      })
    );
    expect(b.digest).toBe(a.digest);
    const c = readArchive(archive([household('h', [{ ...plant, name: 'Fern 2' }])]));
    expect(c.digest).not.toBe(a.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('assertSafeJson', () => {
  it('refuses nesting deeper than any export', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = [deep];
    expect(rejection(() => assertSafeJson(deep)).code).toBe('unsafe_content');
    // Negative control: the export's own depth passes.
    expect(() => assertSafeJson(archive([household('h')]))).not.toThrow();
  });

  it('refuses constructor and prototype keys as well as __proto__', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const value = JSON.parse(`{"a":{"${key}":{"x":1}}}`) as unknown;
      expect(rejection(() => assertSafeJson(value)).code).toBe('unsafe_content');
    }
  });
});

describe('planArchiveImport', () => {
  it('derives stable, target-scoped ids', () => {
    const one = restoredId('target', 'd'.repeat(64), 'plant', 'p');
    expect(restoredId('target', 'd'.repeat(64), 'plant', 'p')).toBe(one);
    expect(restoredId('other', 'd'.repeat(64), 'plant', 'p')).not.toBe(one);
    expect(restoredId('target', 'd'.repeat(64), 'task', 'p')).not.toBe(one);
  });

  it('keeps an assignment only for a current member and lists the rest to re-invite', () => {
    const doc = readArchive(
      archive([
        household(
          'h',
          [{ id: 'p', name: 'Fern', createdAt }],
          [
            ['importer', 'Ada'],
            ['gone', 'Sam'],
            ['gone', 'Sam'],
            ['nameless', null],
          ].map(([assignedTo, assignedToName], i) => ({
            id: `t${i}`,
            plantId: 'p',
            type: 'water',
            frequency: 7,
            nextDue: createdAt,
            createdAt,
            assignedTo,
            assignedToName,
            assignmentSource: 'space_default',
          }))
        ),
      ])
    );
    const plan = planArchiveImport(doc, ctx());
    expect(plan.tasks[0]).toMatchObject({
      assignedTo: 'importer',
      assignedToName: 'Ada',
      assignmentSource: 'space_default',
    });
    expect(plan.tasks[1]).toMatchObject({
      assignedTo: null,
      assignedToName: null,
      assignmentSource: null,
    });
    expect(plan.notRestored.unassignedTasks).toBe(3);
    expect(plan.notRestored.reinvite).toEqual([
      { name: 'Sam', tasks: 2 },
      { name: null, tasks: 1 },
    ]);
  });

  it('takes the canonical name from the server cache, never the file', () => {
    const doc = readArchive(
      archive([
        household('h', [
          {
            id: 'p',
            name: 'Fern',
            species: 'Nephrolepis',
            perenualSpeciesId: 7,
            speciesSource: 'catalog',
            canonicalSpecies: 'From the file',
            createdAt,
          },
          { id: 'q', name: 'Blank', species: '  ', speciesSource: 'identified', createdAt },
        ]),
      ])
    );
    expect(perenualIdsIn(doc)).toEqual([7]);
    const plan = planArchiveImport(
      doc,
      ctx({ canonicalSpecies: new Map([[7, 'Nephrolepis exaltata']]) })
    );
    expect(plan.plants[0].canonicalSpecies).toBe('Nephrolepis exaltata');
    expect(plan.plants[0].speciesSource).toBe('catalog');
    // No species name, no provenance — the server's own rule.
    expect(plan.plants[1].species).toBeNull();
    expect(plan.plants[1].speciesSource).toBeNull();
    expect(plan.notRestored.unverifiedSpeciesNames).toBe(0);
  });

  it('breaks a lineage loop once and keeps the rest of the chain', () => {
    const doc = readArchive(
      archive([
        household('h', [
          { id: 'a', name: 'A', parentPlantId: 'c', createdAt },
          { id: 'b', name: 'B', parentPlantId: 'a', createdAt },
          { id: 'c', name: 'C', parentPlantId: 'b', createdAt },
          { id: 'd', name: 'D', parentPlantId: 'a', createdAt },
          { id: 'e', name: 'E', parentPlantId: 'e', createdAt },
        ]),
      ])
    );
    const plan = planArchiveImport(doc, ctx());
    expect(plan.notRestored.brokenLineage).toBe(2);
    expect(plan.counts.lineageLinks).toBe(3);
    const parents = plan.plants.map((p) => p.parentPlantId);
    expect(parents.filter((p) => p === null)).toHaveLength(2);
  });
});

describe('importTargetState', () => {
  const digest = 'a'.repeat(64);
  it('distinguishes every state a commit must treat differently', () => {
    expect(importTargetState(null, false, digest)).toBe('empty');
    expect(importTargetState(null, true, digest)).toBe('not_empty');
    expect(importTargetState({ digest, status: 'in_progress' }, true, digest)).toBe('resumable');
    expect(importTargetState({ digest, status: 'complete' }, true, digest)).toBe(
      'already_imported'
    );
    expect(importTargetState({ digest: 'b'.repeat(64), status: 'complete' }, true, digest)).toBe(
      'other_archive'
    );
  });
});
