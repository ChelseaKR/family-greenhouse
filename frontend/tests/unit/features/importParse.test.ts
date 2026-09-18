import { describe, it, expect } from 'vitest';
import {
  parseImportFile,
  parseJsonImport,
  extractCandidatesFromJson,
  readCsvTable,
  suggestMapping,
  applyMapping,
  unmatchedColumns,
  sampleValue,
  parseIntervalDays,
  emptyMapping,
  ImportParseError,
} from '../../../src/features/plants/importParse';

describe('parseImportFile — JSON shapes', () => {
  it('accepts a bare array of plant objects', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify([
        { name: 'Pothos', species: 'Epipremnum aureum', tags: ['trailing', 'easy'] },
        { name: 'Fern' },
      ])
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      species: 'Epipremnum aureum',
      tags: ['trailing', 'easy'],
    });
    expect(rows[1].data).toEqual({ name: 'Fern' });
  });

  it('accepts the request-body shape {plants: [...]} with tasks', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify({
        plants: [{ name: 'Monstera', tasks: [{ type: 'water', frequency: 7 }] }],
      })
    );
    expect(rows[0].data?.tasks).toEqual([{ type: 'water', frequency: 7 }]);
  });

  it("accepts the app's own JSON export, flattening households and re-attaching tasks", () => {
    const exportDoc = {
      format: 'family-greenhouse-export',
      version: 1,
      exportedAt: '2026-06-11T00:00:00.000Z',
      user: { id: 'u1', email: 'a@b.com', name: 'A' },
      households: [
        {
          id: 'hh-1',
          name: 'Home',
          plants: [
            {
              id: 'p1',
              householdId: 'hh-1',
              name: 'Pothos',
              species: 'Epipremnum',
              location: 'Kitchen',
              imageUrl: null,
              notes: null,
              status: 'active',
              tags: ['easy'],
              perenualSpeciesId: 42,
              createdAt: '2025-01-01T00:00:00.000Z',
              createdBy: 'u1',
              updatedAt: '2025-01-01T00:00:00.000Z',
            },
          ],
          tasks: [
            {
              id: 't1',
              plantId: 'p1',
              plantName: 'Pothos',
              type: 'water',
              frequency: 7,
              nextDue: '2026-06-12T00:00:00.000Z',
              lastCompleted: null,
              assignedTo: null,
              notes: 'from the top',
            },
            { id: 't2', plantId: 'OTHER', type: 'prune', frequency: 30 },
          ],
        },
      ],
    };
    const rows = parseImportFile('json', JSON.stringify(exportDoc));
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      species: 'Epipremnum',
      location: 'Kitchen',
      tags: ['easy'],
      perenualSpeciesId: 42,
      acquiredAt: '2025-01-01T00:00:00.000Z',
      tasks: [{ type: 'water', frequency: 7, notes: 'from the top' }],
    });
  });

  it('drops an absent or malformed perenualSpeciesId instead of forwarding garbage', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify([
        { name: 'No link' },
        { name: 'Null link', perenualSpeciesId: null },
        { name: 'String id', perenualSpeciesId: '42' },
        { name: 'Negative id', perenualSpeciesId: -5 },
        { name: 'Decimal id', perenualSpeciesId: 1.5 },
        { name: 'Zero id', perenualSpeciesId: 0 },
        { name: 'Valid id', perenualSpeciesId: 7 },
      ])
    );
    expect(rows[0].data).toEqual({ name: 'No link' });
    expect(rows[1].data).toEqual({ name: 'Null link' });
    expect(rows[2].data).toEqual({ name: 'String id' });
    expect(rows[3].data).toEqual({ name: 'Negative id' });
    expect(rows[4].data).toEqual({ name: 'Decimal id' });
    expect(rows[5].data).toEqual({ name: 'Zero id' });
    expect(rows[6].data).toEqual({ name: 'Valid id', perenualSpeciesId: 7 });
  });

  it('throws a typed error for unparseable JSON', () => {
    expect(() => parseImportFile('json', '{nope')).toThrowError(ImportParseError);
    try {
      parseImportFile('json', '{nope');
    } catch (err) {
      expect((err as ImportParseError).reason).toBe('invalidJson');
    }
  });

  it('throws a typed error for an unrecognized JSON shape', () => {
    try {
      extractCandidatesFromJson(JSON.stringify({ hello: 'world' }));
      expect.unreachable();
    } catch (err) {
      expect((err as ImportParseError).reason).toBe('unrecognizedJson');
    }
  });
});

describe('parseImportFile — CSV', () => {
  it("parses the app's own export headers, splitting tags on |", () => {
    const csv =
      '"id","name","species","location","notes","tags","createdAt","updatedAt"\n' +
      '"p1","Pothos","Epipremnum","Kitchen","water weekly","easy|trailing","2025-01-01T00:00:00.000Z","2025-02-01T00:00:00.000Z"\n';
    const rows = parseImportFile('csv', csv);
    // No `acquiredAt`: the server never persisted it (the import date is
    // used), so `createdAt` is reported as not imported instead of being
    // sent to be dropped.
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      species: 'Epipremnum',
      location: 'Kitchen',
      notes: 'water weekly',
      tags: ['easy', 'trailing'],
    });
    const table = readCsvTable(csv);
    const unmatched = unmatchedColumns(table, suggestMapping(table.headers));
    expect(unmatched.map((i) => table.headers[i])).toEqual(['id', 'createdAt', 'updatedAt']);
  });

  it('handles quoted commas and embedded newlines in cells', () => {
    const csv = 'name,notes\n"Pothos, the brave","line1\nline2"\n';
    const rows = parseImportFile('csv', csv);
    expect(rows[0].data).toEqual({ name: 'Pothos, the brave', notes: 'line1\nline2' });
  });

  it('tolerates extra columns it does not know about', () => {
    const csv = 'name,favoriteSong,species\nFern,Hyph,Nephrolepis\n';
    const rows = parseImportFile('csv', csv);
    expect(rows[0].data).toEqual({ name: 'Fern', species: 'Nephrolepis' });
  });

  it('strips the formula-injection guard our export adds', () => {
    const csv = 'name,notes\n"\'=HYPERLINK(""http://x"")","\'-likes shade"\n';
    const rows = parseImportFile('csv', csv);
    expect(rows[0].data).toEqual({ name: '=HYPERLINK("http://x")', notes: '-likes shade' });
  });

  it('rejects a CSV without a name column', () => {
    try {
      parseImportFile('csv', 'species,location\nFern,Bathroom\n');
      expect.unreachable();
    } catch (err) {
      expect((err as ImportParseError).reason).toBe('missingNameColumn');
    }
  });

  it('rejects an empty file', () => {
    try {
      parseImportFile('csv', 'name,species\n');
      expect.unreachable();
    } catch (err) {
      expect((err as ImportParseError).reason).toBe('emptyFile');
    }
  });
});

describe('per-row validation states', () => {
  it('flags invalid rows with dotted field paths but keeps valid siblings', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify([
        { name: 'Good plant' },
        { name: '' },
        { name: 'Task trouble', tasks: [{ type: 'levitate', frequency: 7 }] },
        { name: 'Too frequent', tasks: [{ type: 'water', frequency: 0 }] },
      ])
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data).toBeDefined();

    expect(rows[1].data).toBeUndefined();
    expect(rows[1].errors.map((e) => e.field)).toContain('name');
    expect(rows[1].displayName).toBe('#2');

    expect(rows[2].data).toBeUndefined();
    expect(rows[2].errors.map((e) => e.field)).toContain('tasks.0.type');

    expect(rows[3].data).toBeUndefined();
    expect(rows[3].errors.map((e) => e.field)).toContain('tasks.0.frequency');
  });

  it('coerces CSV-ish values: trims strings, drops empties, numbers task frequency', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify([
        {
          name: '  Pothos  ',
          species: '   ',
          tags: 'easy|  trailing |',
          tasks: [{ type: 'water', frequency: '7' }],
        },
      ])
    );
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      tags: ['easy', 'trailing'],
      tasks: [{ type: 'water', frequency: 7 }],
    });
  });

  it('enforces the 10-tasks-per-plant cap client-side', () => {
    const rows = parseImportFile(
      'json',
      JSON.stringify([
        {
          name: 'Busy',
          tasks: Array.from({ length: 11 }, () => ({ type: 'water', frequency: 7 })),
        },
      ])
    );
    expect(rows[0].data).toBeUndefined();
    expect(rows[0].errors.map((e) => e.field)).toContain('tasks');
  });
});

// SYNTHETIC FIXTURE — a hand-made household spreadsheet, NOT any app's
// export. #668 found no verifiable export format for Planta, Greg or Vera
// (see the "Column matching" note in importParse.ts), so no test here
// pretends to be one. The headers are deliberately unlike ours.
const SYNTHETIC_SPREADSHEET =
  'Plant,Botanical name,Water every (days),Room,Remarks,Purchased\n' +
  'Monty,Monstera deliciosa,7,Living room,Wipe leaves monthly,2024-03-01\n' +
  'Fern,Nephrolepis exaltata,,Bathroom,,\n';

describe('column matching (#668)', () => {
  it('matches nothing automatically in a spreadsheet that is not our export', () => {
    const table = readCsvTable(SYNTHETIC_SPREADSHEET);
    expect(table.headers).toEqual([
      'Plant',
      'Botanical name',
      'Water every (days)',
      'Room',
      'Remarks',
      'Purchased',
    ]);
    // "Plant" is not guessed to be the name: only our own headers are
    // matched, because a guessed mapping is how the wrong column ends up in
    // `species` unnoticed.
    expect(suggestMapping(table.headers)).toEqual(emptyMapping());
  });

  it('matches only our own export headers, case-insensitively', () => {
    expect(suggestMapping(['Name', 'SPECIES', 'Nickname', 'notes'])).toEqual({
      ...emptyMapping(),
      name: 0,
      species: 1,
      notes: 3,
    });
  });

  it('builds drafts through a person-chosen mapping, with the interval as a water task', () => {
    const table = readCsvTable(SYNTHETIC_SPREADSHEET);
    const mapping = {
      ...emptyMapping(),
      name: 0,
      species: 1,
      wateringIntervalDays: 2,
      location: 3,
      notes: 4,
    };
    const rows = applyMapping(table, mapping);
    expect(rows[0].data).toEqual({
      name: 'Monty',
      species: 'Monstera deliciosa',
      location: 'Living room',
      notes: 'Wipe leaves monthly',
      tasks: [{ type: 'water', frequency: 7 }],
    });
    // An empty interval cell means no schedule, not an error.
    expect(rows[1].data).toEqual({
      name: 'Fern',
      species: 'Nephrolepis exaltata',
      location: 'Bathroom',
    });
    // The purchase date has nowhere to go and is listed, not dropped unseen.
    expect(unmatchedColumns(table, mapping).map((i) => table.headers[i])).toEqual(['Purchased']);
  });

  it('never writes imported text to the house rule, the one field token surfaces show', () => {
    // Even a column literally called careRule has no target: it is listed
    // as not imported, and notes only ever land in the private `notes`.
    const table = readCsvTable('name,careRule,notes\nPothos,Bottom-water only,Private thought\n');
    const mapping = suggestMapping(table.headers);
    const [row] = applyMapping(table, mapping);
    expect(row.data).toEqual({ name: 'Pothos', notes: 'Private thought' });
    expect(row.data).not.toHaveProperty('careRule');
    expect(unmatchedColumns(table, mapping).map((i) => table.headers[i])).toEqual(['careRule']);
  });

  it('refuses to guess an interval that is not a whole number of days', () => {
    expect(parseIntervalDays('7')).toBe(7);
    expect(parseIntervalDays(' 14 ')).toBe(14);
    for (const bad of ['7 days', 'weekly', '0', '366', '2.5', '-3']) {
      expect(parseIntervalDays(bad)).toBeNull();
    }
    const table = readCsvTable('name,every\nPothos,weekly\n');
    const [row] = applyMapping(table, { ...emptyMapping(), name: 0, wateringIntervalDays: 1 });
    // The whole row is held back: importing the plant without the schedule
    // the file asked for would be a silent partial import.
    expect(row.data).toBeUndefined();
    expect(row.errors).toEqual([
      { field: 'wateringIntervalDays', message: 'weekly', code: 'invalidInterval' },
    ]);
  });

  it('lists only unmatched columns that actually hold data', () => {
    const table = readCsvTable('name,empty,filled\nPothos,,x\nFern,,\n');
    const mapping = suggestMapping(table.headers);
    expect(unmatchedColumns(table, mapping).map((i) => table.headers[i])).toEqual(['filled']);
  });

  it('strips a spreadsheet BOM so the first header still matches', () => {
    const table = readCsvTable('\uFEFFname,species\nPothos,Epipremnum\n');
    expect(table.headers[0]).toBe('name');
    expect(suggestMapping(table.headers).name).toBe(0);
  });

  it('shows the first non-empty value of a column as a sample', () => {
    const table = readCsvTable('name,species\nA,\nB,Epipremnum\n');
    expect(sampleValue(table, 1)).toBe('Epipremnum');
    expect(sampleValue(table, 5)).toBeUndefined();
  });

  it('treats a header row with no data rows as an empty file', () => {
    expect(() => readCsvTable('Plant,Room\n')).toThrowError(ImportParseError);
  });
});

describe('JSON fields that will not be imported (#668)', () => {
  it('lists every field holding data the import does not keep, including the house rule', () => {
    const { rows, notImported } = parseJsonImport(
      JSON.stringify([
        {
          name: 'Pothos',
          notes: 'private',
          careRule: 'Bottom-water only',
          imageUrl: 'https://example.invalid/p.jpg',
          createdAt: '2025-01-01T00:00:00.000Z',
          status: null,
          tasks: [{ type: 'water', frequency: 7, nextDue: '2026-01-01T00:00:00.000Z' }],
        },
      ])
    );
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      notes: 'private',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      tasks: [{ type: 'water', frequency: 7 }],
    });
    expect(rows[0].data).not.toHaveProperty('careRule');
    // `status: null` carries nothing, so it is not listed.
    expect(notImported).toEqual(['careRule', 'imageUrl', 'createdAt', 'tasks.nextDue']);
  });
});
