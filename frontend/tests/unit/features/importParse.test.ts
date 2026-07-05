import { describe, it, expect } from 'vitest';
import {
  parseImportFile,
  extractCandidatesFromJson,
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
    expect(rows[0].data).toEqual({
      name: 'Pothos',
      species: 'Epipremnum',
      location: 'Kitchen',
      notes: 'water weekly',
      tags: ['easy', 'trailing'],
      acquiredAt: '2025-01-01T00:00:00.000Z',
    });
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
