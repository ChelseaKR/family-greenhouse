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
  buildArchiveManifest,
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

/**
 * A VERSION 1 archive: what every app released before manifests wrote. Most of
 * this file reads through the version 1 path on purpose — it is the path that
 * must never break. The version 2 manifest has its own block below.
 */
function archive(households: unknown[], extra: Record<string, unknown> = {}) {
  return {
    format: 'family-greenhouse-export',
    version: 1,
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

describe('readArchive — the version 2 manifest', () => {
  const fern = { id: 'p1', name: 'Fern', notes: 'PRIVATE-NOTE-TEXT', createdAt };
  const ivy = { id: 'p2', name: 'Ivy', createdAt };
  const water = {
    id: 't1',
    plantId: 'p1',
    type: 'water',
    frequency: 7,
    nextDue: createdAt,
    createdAt,
  };
  const feed = { ...water, id: 't2', plantId: 'p2', type: 'fertilize', frequency: 30 };

  /** A version 2 archive: the same sections, each with the manifest exportMe writes. */
  function v2(plants: unknown[] = [fern, ivy], tasks: unknown[] = [water, feed]) {
    // Cloned: the tests below edit the rows in place, and must not edit these.
    const rows = structuredClone({ plants, tasks });
    return archive(
      [
        {
          ...household('h', rows.plants, rows.tasks),
          manifest: buildArchiveManifest(plants, tasks),
        },
      ],
      { version: 2 }
    );
  }
  /** Same file, after someone edited the rows but left the manifest as it was. */
  function edited(change: (section: Record<string, unknown[]>) => void) {
    const doc = v2();
    const section = (doc.households as Array<Record<string, unknown[]>>)[0];
    change(section);
    return doc;
  }

  it('reads a whole version 2 file and says its manifest was checked', () => {
    const read = readArchive(v2());
    expect(read.version).toBe(2);
    expect(read.manifest).toBe('verified');
    expect(read.household.plants.map((p) => p.name)).toEqual(['Fern', 'Ivy']);
    expect(read.household.tasks).toHaveLength(2);
  });

  it('still reads a version 1 file, with no manifest to check and saying so', () => {
    const read = readArchive(archive([household('h', [fern, ivy], [water, feed])]));
    expect(read.version).toBe(1);
    expect(read.manifest).toBe('absent');
    expect(read.household.plants).toHaveLength(2);
    // A manifest a version 1 file happens to carry is not a promise version 1 made.
    const stray = readArchive(
      archive([{ ...household('h', [fern]), manifest: { counts: { plants: 99, tasks: 0 } } }])
    );
    expect(stray.manifest).toBe('absent');
  });

  it('does not depend on the order the rows were read in', () => {
    const doc = v2();
    const section = (doc.households as Array<Record<string, unknown[]>>)[0];
    section.plants.reverse();
    section.tasks.reverse();
    expect(readArchive(doc).manifest).toBe('verified');
  });

  it('refuses a file with a row cut out, saying how far off it is in counts only', () => {
    const cut = rejection(() => readArchive(edited((section) => section.plants.splice(1, 1))));
    expect(cut.code).toBe('manifest_mismatch');
    expect(cut.details).toEqual({
      plants: { manifest: 2, file: 1, missing: 1, unexpected: 0 },
      tasks: { manifest: 2, file: 2, missing: 0, unexpected: 0 },
    });
    const short = rejection(() => readArchive(edited((section) => section.tasks.pop())));
    expect(short.code).toBe('manifest_mismatch');
    expect(short.details.tasks).toMatchObject({ manifest: 2, file: 1, missing: 1 });
    // Nothing from the file rides along in the refusal.
    expect(JSON.stringify(cut)).not.toContain('Fern');
    expect(JSON.stringify(cut.details)).not.toContain('PRIVATE-NOTE-TEXT');
  });

  it('refuses two edits that balance out, which a count alone would wave through', () => {
    const swapped = rejection(() =>
      readArchive(
        edited((section) => {
          section.plants.pop();
          section.plants.push({ id: 'p9', name: 'Somebody else’s plant', createdAt });
        })
      )
    );
    expect(swapped.code).toBe('manifest_mismatch');
    expect(swapped.details.plants).toEqual({ manifest: 2, file: 2, missing: 1, unexpected: 1 });
  });

  it('refuses a row whose content changed, a field at a time', () => {
    const rename = edited((section) => {
      (section.plants[0] as Record<string, unknown>).name = 'Fern 2';
    });
    expect(rejection(() => readArchive(rename)).code).toBe('manifest_mismatch');
    const note = edited((section) => {
      (section.plants[0] as Record<string, unknown>).notes = 'a different note';
    });
    expect(rejection(() => readArchive(note)).code).toBe('manifest_mismatch');
    const cadence = edited((section) => {
      (section.tasks[0] as Record<string, unknown>).frequency = 14;
    });
    expect(rejection(() => readArchive(cadence)).code).toBe('manifest_mismatch');
    // Negative control: the untouched file passes.
    expect(readArchive(v2()).manifest).toBe('verified');
  });

  it('refuses a manifest that was edited to say something else', () => {
    const doc = v2();
    const section = (doc.households as Array<{ manifest: { counts: { plants: number } } }>)[0];
    section.manifest.counts.plants = 3;
    expect(rejection(() => readArchive(doc)).code).toBe('manifest_mismatch');
    const digest = v2();
    const digests = (digest.households as Array<{ manifest: { plantDigests: string[] } }>)[0]
      .manifest.plantDigests;
    digests[0] = 'f'.repeat(64);
    expect(rejection(() => readArchive(digest)).code).toBe('manifest_mismatch');
  });

  it('refuses a version 2 file that has no manifest, or a damaged one', () => {
    const missing = v2();
    delete (missing.households as Array<Record<string, unknown>>)[0].manifest;
    const noManifest = rejection(() => readArchive(missing));
    expect(noManifest.code).toBe('invalid_content');
    expect(noManifest.details.path).toBe('households.0.manifest');
    const damaged = v2();
    (
      damaged.households as Array<{ manifest: { plantDigests: string[] } }>
    )[0].manifest.plantDigests = ['not-a-digest'];
    expect(rejection(() => readArchive(damaged)).code).toBe('invalid_content');
  });

  it('is not moved by a field the import ignores, only by what it restores', () => {
    const doc = v2();
    const section = (doc.households as Array<Record<string, unknown[]>>)[0];
    (section.plants[0] as Record<string, unknown>).smuggled = 'a-token-that-is-never-read';
    expect(readArchive(doc).manifest).toBe('verified');
  });

  it('names a version newer than this build reads, and still reads every earlier one', () => {
    const newer = rejection(() => readArchive({ ...v2(), version: ARCHIVE_VERSION + 1 }));
    expect(newer.code).toBe('unsupported_version');
    expect(newer.message).toContain(`format version ${ARCHIVE_VERSION + 1}`);
    expect(newer.details).toEqual({ version: ARCHIVE_VERSION + 1, supported: ARCHIVE_VERSION });
    expect(ARCHIVE_VERSION).toBe(2);
  });

  describe('buildArchiveManifest', () => {
    it('holds counts and digests only — none of the rows content', () => {
      const manifest = buildArchiveManifest([fern, ivy], [water]);
      expect(manifest.counts).toEqual({ plants: 2, tasks: 1 });
      expect(manifest.plantDigests).toHaveLength(2);
      expect(manifest.taskDigests).toHaveLength(1);
      for (const digest of [...manifest.plantDigests, ...manifest.taskDigests]) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
      const text = JSON.stringify(manifest);
      for (const secret of ['Fern', 'Ivy', 'PRIVATE-NOTE-TEXT', createdAt]) {
        expect(text).not.toContain(secret);
      }
      // Sorted, so the manifest does not depend on read order.
      expect(manifest.plantDigests).toEqual([...manifest.plantDigests].sort());
    });

    it('never blocks an export on a row the import schema would refuse', () => {
      const manifest = buildArchiveManifest([{ id: 'p', name: '' }, 'not even an object'], []);
      expect(manifest.counts.plants).toBe(2);
      expect(manifest.plantDigests).toHaveLength(2);
    });

    it('gives a plant and a task with the same content different digests', () => {
      const same = { id: 'x' };
      expect(buildArchiveManifest([same], []).plantDigests[0]).not.toBe(
        buildArchiveManifest([], [same]).taskDigests[0]
      );
    });

    it('pins the digest recipe, so a change that would strand every saved export fails here', () => {
      // If this changes, every version 2 file already downloaded stops
      // verifying. Bump the format version instead of editing the recipe.
      expect(buildArchiveManifest([ivy], [water])).toEqual({
        counts: { plants: 1, tasks: 1 },
        plantDigests: ['c4a352375023721de26742533651e06e73ed02225a232520e6e9efa53e06a76e'],
        taskDigests: ['dcbc852ef356d56c769aa2836367876691d70e309f16f626548bf9ae9f3f6068'],
      });
    });
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
